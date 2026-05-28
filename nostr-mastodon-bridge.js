// nostrdon v0.0.6

// FIX: Force IPv4-first DNS resolution for ALL libraries in this process.
// Must be before any require() that might trigger a DNS lookup.
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// Load environment variables
require('dotenv').config();

const fs = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const WebSocket = require('ws');
const { SimplePool } = require('nostr-tools');
const Mastodon = require('mastodon-api');
const axios = require('axios');

// Connection management
let isShuttingDown = false;
const REQUEST_TIMEOUT = 30000; // 30 seconds

// Track failed operations to implement circuit breaker pattern
let failedOperations = new Map();
const MAX_FAILURES_BEFORE_SKIP = 5;
const FAILURE_RESET_TIME = 10 * 60 * 1000; // 10 minutes

// Track in-progress events with timestamps to clean up stale entries
let inProgressEventsWithTime = new Map();
const IN_PROGRESS_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Timeout wrapper for promises
function withTimeout(promise, timeoutMs, context = '') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms${context ? ` (${context})` : ''}`));
      }, timeoutMs);
    })
  ]);
}

// Circuit breaker pattern to skip operations that keep failing
function shouldSkipOperation(operationType) {
  const now = Date.now();
  const failures = failedOperations.get(operationType) || { count: 0, lastFailure: 0 };
  if (now - failures.lastFailure > FAILURE_RESET_TIME) {
    failures.count = 0;
  }
  return failures.count >= MAX_FAILURES_BEFORE_SKIP;
}

function recordOperationFailure(operationType) {
  const now = Date.now();
  const failures = failedOperations.get(operationType) || { count: 0, lastFailure: 0 };
  failures.count++;
  failures.lastFailure = now;
  failedOperations.set(operationType, failures);
  if (failures.count >= MAX_FAILURES_BEFORE_SKIP) {
    console.log(`[Circuit Breaker] ${operationType} has failed ${failures.count} times, skipping for ${FAILURE_RESET_TIME / 1000 / 60} minutes`);
  }
}

function recordOperationSuccess(operationType) {
  failedOperations.set(operationType, { count: 0, lastFailure: 0 });
}

// Clean up stale in-progress events
function cleanupStaleInProgressEvents() {
  const now = Date.now();
  for (const [eventId, timestamp] of inProgressEventsWithTime.entries()) {
    if (now - timestamp > IN_PROGRESS_TIMEOUT) {
      console.log(`[Cleanup] Removing stale in-progress event: ${eventId}`);
      inProgressEvents.delete(eventId);
      inProgressEventsWithTime.delete(eventId);
    }
  }
}

// Logging setup
const LOG_FILE = process.env.LOG_FILE || '/tmp/nostr-mastodon-bridge.log';
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const originalConsoleLog = console.log;
console.log = (...args) => {
  const message = `${new Date().toISOString()} ${args.join(' ')}`;
  logStream.write(message + '\n');
  originalConsoleLog(message);
};
console.log('Starting nostr-mastodon-bridge v0.0.6');

// Load credentials
const NOSTR_PUBLIC_KEY = process.env.NOSTR_PUBLIC_KEY;
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN;
const MASTODON_API_URL = process.env.MASTODON_API_URL || 'https://mastodon.social/api/v1/';

if (!NOSTR_PUBLIC_KEY || !NOSTR_PRIVATE_KEY || !MASTODON_ACCESS_TOKEN) {
  throw new Error('Missing required environment variables. Please check your .env file.');
}

if (!NOSTR_PUBLIC_KEY || NOSTR_PUBLIC_KEY.length !== 64 || !/^[0-9a-f]{64}$/.test(NOSTR_PUBLIC_KEY)) {
  throw new Error('NOSTR_PUBLIC_KEY is missing or not a valid 64-character lowercase hex string. Current value: ' + NOSTR_PUBLIC_KEY);
}

// Set global WebSocket for nostr-tools
global.WebSocket = WebSocket;

// Nostr relay setup. Choose relay(s) that you use.
const relays = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://offchain.pub',
  'wss://relay.primal.net',
  'wss://mostr.pub',
];

// FIX: Use a single SimplePool and subscribe via pool.subscribeMany() instead of
// calling relay.subscribe() on individual relay objects returned by ensureRelay().
// The relay.subscribe() method on relay objects was removed in nostr-tools v2.x.
// pool.subscribeMany() is the current supported API and handles connection
// management internally — no need to call ensureRelay() or relay.connect() first.
const pool = new SimplePool();

// Mastodon setup
const M = new Mastodon({
  access_token: MASTODON_ACCESS_TOKEN,
  api_url: MASTODON_API_URL,
});

// Persistence (for posted event IDs)
const PROCESSED_EVENTS_FILE = 'processed_nostr_events.json';
let processedNostrEvents = new Set(fs.existsSync(PROCESSED_EVENTS_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_EVENTS_FILE)) : []);
// Number of hours script goes back to read things at startup - will not re-bridge though
const SCRIPT_START_TIME = Math.floor(Date.now() / 1000);
const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const EVENT_AGE_THRESHOLD = Math.floor(Date.now() / 1000) - FOUR_HOURS_SECONDS;

const inProgressEvents = new Set();

function writeJsonFileSync(filePath, data) {
  const tempFile = join(tmpdir(), `temp-${Date.now()}-${Math.random().toString(36).substring(2)}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(data));
  fs.renameSync(tempFile, filePath);
}

// Connection management utilities
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNetworkError(error) {
  return error.code === 'ENETUNREACH' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.message?.includes('network') ||
    error.message?.includes('timeout');
}

async function retryWithBackoff(fn, context = '', maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isNetworkErr = isNetworkError(error);
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        console.error(`[${context}] Final attempt failed after ${maxRetries} tries:`, error.message || error);
        throw error;
      }

      if (!isNetworkErr) {
        console.error(`[${context}] Non-network error on attempt ${attempt}:`, error.message || error);
        throw error;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[${context}] Network error on attempt ${attempt}, retrying in ${delay}ms:`, error.message || error);
      await sleep(delay);
    }
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    try {
      if (pool && typeof pool.close === 'function') {
        pool.close(relays);
      }
      console.log('[Shutdown] All connections closed');
    } catch (error) {
      console.error('[Shutdown] Error during shutdown:', error);
    }
    process.exit(0);
  };

  process.on('uncaughtException', (error) => {
    console.error('[Fatal] Uncaught exception:', error.message || error);
    if (isNetworkError(error)) {
      console.log('[Fatal] Network error detected, continuing operation...');
      return;
    }
    if (!isShuttingDown) {
      shutdown('uncaughtException');
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Fatal] Unhandled rejection at:', promise, 'reason:', reason);
    if (isNetworkError(reason)) {
      console.log('[Fatal] Network error in promise rejection, continuing operation...');
      return;
    }
    if (!isShuttingDown) {
      shutdown('unhandledRejection');
    }
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function extractImageUrls(text) {
  return [...text.matchAll(/https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)/gi)].map(m => m[0]);
}

async function downloadImage(url) {
  return await retryWithBackoff(async () => {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT,
      maxContentLength: 10 * 1024 * 1024, // 10MB limit
      headers: {
        'User-Agent': 'nostr-mastodon-bridge/0.0.6'
      }
    });
    return Buffer.from(response.data, 'binary');
  }, `Image Download (${url})`);
}

// --- Event handler (shared by all relay subscriptions) ---
async function handleEvent(event, sourceLabel) {
  try {
    // Check if event is already processed or in progress
    if (processedNostrEvents.has(event.id)) {
      if (!global.lastSkippedEventId || global.lastSkippedEventId !== event.id) {
        global.lastSkippedEventId = event.id;
        const preview = event.content.replace(/\n/g, ' ').substring(0, 40);
        console.log(`[${sourceLabel}] Skipping already bridged event: ${event.id} "${preview}${event.content.length > 40 ? '...' : ''}"`);
      }
      return;
    }

    if (inProgressEvents.has(event.id)) {
      if (!global.lastSkippedInProgressEventId || global.lastSkippedInProgressEventId !== event.id) {
        global.lastSkippedInProgressEventId = event.id;
        const preview = event.content.replace(/\n/g, ' ').substring(0, 40);
        console.log(`[${sourceLabel}] Skipping event currently being processed: ${event.id} "${preview}${event.content.length > 40 ? '...' : ''}"`);
      }
      return;
    }

    if (event.created_at < EVENT_AGE_THRESHOLD) {
      if (!global.lastSkippedOldEventId || global.lastSkippedOldEventId !== event.id) {
        global.lastSkippedOldEventId = event.id;
        const preview = event.content.replace(/\n/g, ' ').substring(0, 40);
        console.log(`[${sourceLabel}] Skipping event older than 4 hours: ${event.id} "${preview}${event.content.length > 40 ? '...' : ''}"`);
      }
      return;
    }

    // Skip replies (has e or p tags)
    if (event.tags && event.tags.some(tag => tag[0] === 'e' || tag[0] === 'p')) {
      console.log(`[${sourceLabel}] Skipping kind 1 comment:`, event.id);
      return;
    }

    // Mark event as in progress with timestamp
    inProgressEvents.add(event.id);
    inProgressEventsWithTime.set(event.id, Date.now());

    console.log(`[${sourceLabel}] New Nostr event:`, event.id, event.content);

    // Extract image URLs
    const imageUrls = extractImageUrls(event.content);
    let mediaIds = [];
    let content = event.content;

    // Remove image URLs from content if they will be attached as media
    if (imageUrls.length > 0) {
      for (const imageUrl of imageUrls) {
        try {
          const imageBuffer = await downloadImage(imageUrl);

          const uploadMedia = async () => {
            try {
              return await M.post('media', { file: imageBuffer, description: 'Image from Nostr note' });
            } catch (error) {
              if (error.code === 'ENETUNREACH' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                throw new Error(`Network error: ${error.code} - ${error.message}`);
              }
              throw error;
            }
          };

          const mediaResp = await retryWithBackoff(
            () => withTimeout(uploadMedia(), REQUEST_TIMEOUT, `Media Upload`),
            `Media Upload`
          );
          if (mediaResp.data && mediaResp.data.id) {
            mediaIds.push(mediaResp.data.id);
          }
        } catch (err) {
          console.error(`[${sourceLabel}] Error uploading image to Mastodon:`, err.message || err);
          // Continue without this image rather than failing the entire post
        }
        // Remove this image URL from the content
        content = content.replace(imageUrl, '').trim();
      }
    }

    // Build the njump.me linkback footer.
    // Note: github.com URL intentionally has no https:// prefix to prevent
    // Mastodon clients from generating a large link preview card for it.
    const nostrEventId = event.id ? event.id.slice(0, 5) : 'none';
    const nostrLink = `https://njump.me/${event.id}`;
    const footer = `\n\nBridged via Nostrdon (github.com/crrdlx/nostrdon), view original on Nostr: ${nostrLink} id: ${nostrEventId}`;

    // Truncate content if needed, reserving space for the footer
    const MAX_CONTENT_LENGTH = 500 - footer.length;
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH - 3) + '...';
    }

    // Append the footer
    content = content + footer;

    try {
      if (shouldSkipOperation('mastodon-post')) {
        console.log(`[${sourceLabel}] Skipping Mastodon post due to repeated failures`);
        inProgressEvents.delete(event.id);
        inProgressEventsWithTime.delete(event.id);
        return;
      }

      console.log(`[${sourceLabel}] Attempting to post to Mastodon:`, content);

      const postToMastodon = async () => {
        try {
          return await M.post('statuses', { status: content, media_ids: mediaIds });
        } catch (error) {
          if (error.code === 'ENETUNREACH' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            throw new Error(`Network error: ${error.code} - ${error.message}`);
          }
          throw error;
        }
      };

      const response = await retryWithBackoff(
        () => withTimeout(postToMastodon(), REQUEST_TIMEOUT, `Mastodon Post`),
        `Mastodon Post`
      );
      console.log(`[${sourceLabel}] Posted to Mastodon:`, response.data && response.data.url ? response.data.url : response.data);
      processedNostrEvents.add(event.id);
      writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
      recordOperationSuccess('mastodon-post');
    } catch (err) {
      console.error(`[${sourceLabel}] Error posting to Mastodon:`, err.message || err);
      recordOperationFailure('mastodon-post');
      // Don't mark as processed if posting failed
    } finally {
      inProgressEvents.delete(event.id);
      inProgressEventsWithTime.delete(event.id);
    }
  } catch (error) {
    console.error(`[${sourceLabel}] Unexpected error processing event ${event.id}:`, error.message);
    inProgressEvents.delete(event.id);
    inProgressEventsWithTime.delete(event.id);
  }
}

// --- Main Bridge Logic ---
async function main() {
  setupGracefulShutdown();

  console.log('Using NOSTR_PUBLIC_KEY:', NOSTR_PUBLIC_KEY);
  console.log('Bridge initialized. Listening for Nostr kind 1 notes...');
  console.log('Subscribing to Nostr relays for kind 1 notes from your pubkey...');

  // FIX: Subscribe via pool.subscribeMany() with an array of relay URL strings.
  // The old code called pool.ensureRelay() per relay, then relay.subscribe() on
  // the returned relay object. That per-relay-object subscribe API was removed in
  // nostr-tools v2.x. pool.subscribeMany() is the correct current API — it handles
  // connecting to relays internally and deduplicates events across relays.
  const sub = pool.subscribeMany(
    relays,
    [{ kinds: [1], authors: [NOSTR_PUBLIC_KEY] }],
    {
      onevent: async (event) => {
        await handleEvent(event, 'pool');
      },
      oneose: () => {
        console.log('[pool] Nostr relay sent all stored events. Now listening for new notes...');
      },
    }
  );

  console.log(`Subscribed to ${relays.length} relay(s) via pool.subscribeMany. Bridge is running.`);

  // Keep the process alive
  process.stdin.resume();
}

// Periodic status log with connection health
function logStatus() {
  const processedCount = processedNostrEvents.size;
  const inProgressCount = inProgressEvents.size;
  console.log(`[Status] Bridge running - Relays: ${relays.length}, Processed events: ${processedCount}, In progress: ${inProgressCount} (${new Date().toISOString()})`);
}

// Periodic cleanup of stale in-progress events
function checkConnections() {
  cleanupStaleInProgressEvents();
}

console.log(`[Status] Bridge starting up... (${new Date().toISOString()})`);
setInterval(logStatus, 5 * 60 * 1000);       // Every 5 minutes
setInterval(checkConnections, 2 * 60 * 1000); // Check connections every 2 minutes

main().catch(err => {
  console.error('Fatal error in bridge:', err);
  process.exit(1);
});

// v0.0.6