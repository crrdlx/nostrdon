#!/bin/bash

# Auto-restart script for nostr-mastodon-bridge.cjs
# This script runs the bridge and restarts it every 6 hours

# Configuration
SCRIPT_NAME="nostr-mastodon-bridge.cjs"
RESTART_INTERVAL=21600  # 6 hours (4 times daily)
LOG_FILE="/tmp/nostrdon-auto-restart.log"
BRIDGE_LOG_FILE="/tmp/nostr-mastodon-bridge.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Start the bridge process
start_bridge() {
    log "${BLUE}Starting $SCRIPT_NAME...${NC}"
    
    # Check prerequisites
    if [ ! -f "$SCRIPT_DIR/$SCRIPT_NAME" ]; then
        log "${RED}Error: Bridge script not found at $SCRIPT_DIR/$SCRIPT_NAME${NC}"
        return 1
    fi
    
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        log "${RED}Error: .env file not found. Please create it with your credentials${NC}"
        return 1
    fi
    
    if ! command -v node &> /dev/null; then
        log "${RED}Error: Node.js not found. Please install Node.js${NC}"
        return 1
    fi
    
    # Start the script
    cd "$SCRIPT_DIR"
    node "$SCRIPT_NAME" &
    local pid=$!
    
    # Wait a moment to see if it starts successfully
    sleep 5
    
    if kill -0 "$pid" 2>/dev/null; then
        log "${GREEN}Bridge started with PID: $pid${NC}"
        echo "$pid" > "/tmp/nostrdon-bridge.pid"
        return 0
    else
        log "${RED}Failed to start bridge${NC}"
        return 1
    fi
}

# Stop the bridge process
stop_bridge() {
    log "${YELLOW}Stopping bridge process...${NC}"
    
    if [ -f "/tmp/nostrdon-bridge.pid" ]; then
        local pid=$(cat "/tmp/nostrdon-bridge.pid" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null
            sleep 5
            if kill -0 "$pid" 2>/dev/null; then
                log "${YELLOW}Process didn't stop gracefully, forcing kill...${NC}"
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
        rm -f "/tmp/nostrdon-bridge.pid"
    fi
    
    # Also try to kill any remaining node processes running the script
    pkill -f "$SCRIPT_NAME" 2>/dev/null || true
    
    log "${GREEN}Bridge process stopped${NC}"
}

# Restart the bridge process
restart_bridge() {
    log "${BLUE}Restarting bridge process...${NC}"
    stop_bridge
    sleep 2
    start_bridge
}

# Check if bridge is running
is_bridge_running() {
    if [ -f "/tmp/nostrdon-bridge.pid" ]; then
        local pid=$(cat "/tmp/nostrdon-bridge.pid" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Show bridge status
show_status() {
    if is_bridge_running; then
        local pid=$(cat "/tmp/nostrdon-bridge.pid" 2>/dev/null)
        log "${GREEN}Bridge is running with PID: $pid${NC}"
    else
        log "${RED}Bridge is not running${NC}"
    fi
}

# Test bridge startup
test_bridge() {
    log "${BLUE}Testing bridge startup...${NC}"
    
    # Check prerequisites
    if [ ! -f "$SCRIPT_DIR/$SCRIPT_NAME" ]; then
        log "${RED}Error: Bridge script not found at $SCRIPT_DIR/$SCRIPT_NAME${NC}"
        return 1
    fi
    
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        log "${RED}Error: .env file not found. Please create it with your credentials${NC}"
        return 1
    fi
    
    if ! command -v node &> /dev/null; then
        log "${RED}Error: Node.js not found. Please install Node.js${NC}"
        return 1
    fi
    
    # Test if we can run the bridge script directly
    log "${BLUE}Testing bridge script directly...${NC}"
    cd "$SCRIPT_DIR"
    
    # Try to run the script for a few seconds to see if it starts properly
    timeout 10s node "$SCRIPT_NAME" 2>&1 | head -20 | while read line; do
        log "  $line"
    done
    
    log "${GREEN}Bridge script test completed${NC}"
    return 0
}

# Main monitoring loop
monitor_bridge() {
    log "${GREEN}Starting bridge monitor (restart every 6 hours)${NC}"
    
    local last_restart=$(date +%s)
    local restart_interval_seconds=21600  # 6 hours in seconds
    
    while true; do
        local current_time=$(date +%s)
        local time_since_restart=$((current_time - last_restart))
        
        # Check if it's time for a scheduled restart
        if [ $time_since_restart -ge $restart_interval_seconds ]; then
            log "${BLUE}Scheduled restart triggered (${time_since_restart}s since last restart)${NC}"
            restart_bridge
            last_restart=$current_time
        # Check if bridge is running
        elif ! is_bridge_running; then
            log "${RED}Bridge is not running, starting...${NC}"
            start_bridge
            last_restart=$current_time
        else
            log "${GREEN}Bridge is running normally${NC}"
        fi
        
        # Wait before next check
        sleep 300  # 5 minutes
    done
}

# Handle signals
cleanup() {
    log "${YELLOW}Received shutdown signal, stopping monitor...${NC}"
    stop_bridge
    exit 0
}

trap cleanup SIGINT SIGTERM

# Main execution
case "${1:-monitor}" in
    "start")
        start_bridge
        ;;
    "stop")
        stop_bridge
        ;;
    "restart")
        restart_bridge
        ;;
    "status")
        show_status
        ;;
    "test")
        test_bridge
        ;;
    "monitor")
        monitor_bridge
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|test|monitor}"
        echo "  start   - Start the bridge process"
        echo "  stop    - Stop the bridge process"
        echo "  restart - Restart the bridge process"
        echo "  status  - Check if bridge is running"
        echo "  test    - Test bridge script directly"
        echo "  monitor - Start monitoring loop (default)"
        exit 1
        ;;
esac