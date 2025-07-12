// nostrdon v0.0.2
// Load environment variables
require('dotenv').config();

const fs = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const WebSocket = require('ws');
const { SimplePool } = require('nostr-tools');
const Mastodon = require('mastodon-api');
const axios = require('axios'); // Make sure this is at the top of your file

// Logging setup
const LOG_FILE = process.env.LOG_FILE || '/tmp/nostr-mastodon-bridge.log';
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const originalConsoleLog = console.log;
console.log = (...args) => {
  const message = `${new Date().toISOString()} ${args.join(' ')}`;
  logStream.write(message + '\n');
  originalConsoleLog(message);
};
console.log('Starting nostr-mastodon-bridge v0.0.2');

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

function extractImageUrls(text) {
  // Simple regex for image URLs
  return [...text.matchAll(/https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)/gi)].map(m => m[0]);
}

async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data, 'binary');
}

// --- Main Bridge Logic ---
async function main() {
  console.log('Using NOSTR_PUBLIC_KEY:', NOSTR_PUBLIC_KEY);
  console.log('Bridge initialized. Listening for Nostr kind 1 notes...');
  console.log('Subscribing to Nostr relays for kind 1 notes from your pubkey...');

  for (const relayUrl of relays) {
    try {
      const relay = await pool.ensureRelay(relayUrl);
      await relay.connect();
      console.log(`[${relayUrl}] Connected!`);
      // Remove the since filter to match 0.0.1-bridge.cjs
      const sub = relay.subscribe(
        [{ kinds: [1], authors: [NOSTR_PUBLIC_KEY] }],
        {
          onevent: async event => {
            if (processedNostrEvents.has(event.id) || inProgressEvents.has(event.id)) {
              if (!global.lastSkippedEventId || global.lastSkippedEventId !== event.id) {
                global.lastSkippedEventId = event.id;
                const preview = event.content.replace(/\n/g, ' ').substring(0, 40);
                console.log(`[${relayUrl}] Skipping already bridged event: ${event.id} "${preview}${event.content.length > 40 ? '...' : ''}"`);
              }
              return;
            }
            if (event.created_at < EVENT_AGE_THRESHOLD) {
              if (!global.lastSkippedOldEventId || global.lastSkippedOldEventId !== event.id) {
                global.lastSkippedOldEventId = event.id;
                const preview = event.content.replace(/\n/g, ' ').substring(0, 40);
                console.log(`[${relayUrl}] Skipping event older than 4 hours: ${event.id} "${preview}${event.content.length > 40 ? '...' : ''}"`);
              }
              return;
            }
            if (event.tags && event.tags.some(tag => tag[0] === 'e' || tag[0] === 'p')) {
              console.log(`[${relayUrl}] Skipping kind 1 comment:`, event.id);
              return;
            }
            inProgressEvents.add(event.id);

            console.log(`[${relayUrl}] New Nostr event:`, event.id, event.content);

            // Extract image URLs
            const imageUrls = extractImageUrls(event.content);
            let mediaIds = [];
            let content = event.content;
            // Remove image URLs from content if they will be attached as media
            if (imageUrls.length > 0) {
              for (const imageUrl of imageUrls) {
                try {
                  const imageBuffer = await downloadImage(imageUrl);
                  const mediaResp = await M.post('media', { file: imageBuffer, description: 'Image from Nostr note' });
                  if (mediaResp.data && mediaResp.data.id) {
                    mediaIds.push(mediaResp.data.id);
                  }
                } catch (err) {
                  console.error(`[${relayUrl}] Error uploading image to Mastodon:`, err);
                }
                // Remove this image URL from the content
                content = content.replace(imageUrl, '').trim();
              }
            }
            // Truncate content if needed
            if (content.length > 500) {
              content = content.substring(0, 497) + '...';
            }
            try {
              console.log(`[${relayUrl}] Attempting to post to Mastodon:`, content);
              const response = await M.post('statuses', { status: content, media_ids: mediaIds });
              console.log(`[${relayUrl}] Posted to Mastodon:`, response.data && response.data.url ? response.data.url : response.data);
              processedNostrEvents.add(event.id);
              writeJsonFileSync(PROCESSED_EVENTS_FILE, [...processedNostrEvents]);
            } catch (err) {
              console.error(`[${relayUrl}] Error posting to Mastodon:`, err);
            } finally {
              inProgressEvents.delete(event.id);
            }
          },
          oneose: () => {
            console.log(`[${relayUrl}] Nostr relay sent all stored events. Now listening for new notes...`);
          }
        }
      );
    } catch (err) {
      console.error(`[${relayUrl}] Error connecting or subscribing:`, err);
    }
  }

  // Keep the process alive
  process.stdin.resume();
}

// Periodic status log (every X number of minutes...see X * 60 * 1000)
console.log(`[Status] Still listening for new Nostr events... (${new Date().toISOString()})`);
setInterval(() => {
  console.log(`[Status] Still listening for new Nostr events... (${new Date().toISOString()})`);
}, 5 * 60 * 1000);

main().catch(err => {
  console.error('Fatal error in bridge:', err);
  process.exit(1);
});

// v0.0.2 - adding images - not picking up events