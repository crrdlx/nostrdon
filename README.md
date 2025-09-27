# nostrodon = nostr-to-mastodon bridge

**Nostrdon bridges Nostr notes over to Mastodon.** Post on Nostr, it auto cross-posts over to Mastondon. It's working, but consider this beta and experimental. Images are not loading inline on Mastodon, but clickable links to the images are working. Maybe someone can help with this. :)

The instructions here assume you are using an Ubuntu VPS, but the bridge can also run on a desktop, laptop, or Raspberry Pi (as long as Node.js is available).

### How to set up the nostrdon bridge:

### 1. Prerequisites

-  **Node.js** (v16 or newer recommended)

-  **npm** (Node package manager)

-  **git** (to clone the repository)

-  **tmux** (optional, to keep the bridge running in the background)

-  **bash** (for the auto-restart script)

  

### 2. Clone the repository

```bash

git  clone  https://github.com/crrdlx/nostrdon  nostrdon

cd  nostrdon

```

  

### 3. Install dependencies

```bash

npm  install

```

  

### 4. Set up your environment variables

- Copy the example environment file or create a new `.env` file:

```bash

cp .env.example .env

# Nostr credentials. use hex format, not npub or nsec. A simple tool to swap npub to hex: https://nak.nostr.com/

NOSTR_PUBLIC_KEY=hex-pub-key...

NOSTR_PRIVATE_KEY=hex-priv-key...

  

# Mastodon credentials. Generate access token in Mastodon. The api URL example here is mastodon.social, but you will need to change it to whatever instance you, like mas.to/api/v1/

MASTODON_ACCESS_TOKEN=<insert_your_token_here>

MASTODON_API_URL=https://mastodon.social/api/v1/

  

# Optional: Logging

LOG_FILE=/tmp/nostr-mastodon-bridge.log

nano .env

```

- Fill in your Nostr and Mastodon credentials:

-  `NOSTR_PUBLIC_KEY` (hex, not npub)

-  `NOSTR_PRIVATE_KEY` (hex, not nsec)

-  `MASTODON_ACCESS_TOKEN` (from your Mastodon account)

-  `MASTODON_API_URL` (e.g. `https://mas.to/api/v1/``- this depends on your mastodon instance)

- Optionally set `LOG_FILE` to control where logs are written.

  

### 5. (Optional) Install tmux

`tmux` allows you to keep the bridge running after you disconnect from SSH.

```bash

sudo  apt  update

sudo  apt  install  tmux

```

  

### 6. Start the bridge

You have several options for running the bridge:

#### Option A: Auto-restart script (Recommended)

The auto-restart script automatically manages the bridge process, restarting it every 6 hours and monitoring for crashes:

```bash

# Make the script executable (first time only)

chmod +x auto-restart.sh

# Start monitoring mode (runs indefinitely with auto-restart)

./auto-restart.sh monitor

# Or use individual commands:

./auto-restart.sh start     # Start the bridge

./auto-restart.sh stop      # Stop the bridge

./auto-restart.sh restart   # Restart the bridge

./auto-restart.sh status    # Check if bridge is running

./auto-restart.sh test      # Test bridge startup

```

**Auto-restart features:**
- Automatically restarts the bridge every 6 hours to prevent memory leaks
- Monitors the bridge process and restarts if it crashes
- Provides colored logging for easy monitoring
- Saves process ID for proper cleanup
- Includes error checking and validation

#### Option B: With tmux

```bash

tmux new -s nostrdon-bridge

node nostr-mastodon-bridge.cjs

# To detach: press Ctrl+b, then  d

# To reattach later: tmux attach -t nostrdon-bridge

```

#### Option C: Direct execution

```bash

node nostr-mastodon-bridge.cjs

# (The  bridge  will  stop  if  you  close  your  terminal)

```

  

### 7. Troubleshooting

- Check the log file (default: `/tmp/nostr-mastodon-bridge.log`) for errors.

- If using the auto-restart script, also check `/tmp/nostrdon-auto-restart.log` for restart script logs.

- Make sure your `.env` file is correct and in the project directory.

- If you see connection errors, check your internet and relay status.

- If you want to stop the bridge:
  - **Auto-restart script**: `./auto-restart.sh stop`
  - **tmux**: `tmux kill-session -t nostrdon-bridge`
  - **Direct execution**: `Ctrl+C`

- To check if the auto-restart script is working properly:
  ```bash
  ./auto-restart.sh status
  ./auto-restart.sh test
  ```

  

### 8. Running on other devices

- The bridge should work on any device that supports Node.js, including desktops, laptops, and Raspberry Pi (Raspberry Pi OS or Ubuntu recommended).

- For Raspberry Pi, use Node.js LTS and follow the same steps above.

  

### 9. Updating the bridge

- To update, pull the latest code and reinstall dependencies if needed:

```bash

git pull

npm install

```

- Restart the bridge after updating:
  - **Auto-restart script**: `./auto-restart.sh restart`
  - **tmux**: `tmux kill-session -t nostrdon-bridge` then start again
  - **Direct execution**: Stop with `Ctrl+C` and restart

  

### 10. Additional tips

- Keep your `.env` file secure; it contains your private keys and tokens.

- You can monitor the bridge in real time by watching the log file:

```bash

tail -f /tmp/nostr-mastodon-bridge.log

```

- If using the auto-restart script, you can also monitor the restart script logs:

```bash

tail -f /tmp/nostrdon-auto-restart.log

```

- The auto-restart script is ideal for production environments as it provides:
  - Automatic recovery from crashes
  - Scheduled restarts to prevent memory issues
  - Process management and monitoring
  - Proper cleanup on shutdown

- If you want to run multiple bridges (for different accounts), use separate directories and `.env` files.

  

---

  

For more help, open an issue or ask your question in the project discussion area.