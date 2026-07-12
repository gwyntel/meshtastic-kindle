#!/bin/bash
# mesh-kindle serve script
# Starts the Python proxy server and optionally a Cloudflare tunnel for Kindle access
# Usage: ./serve.sh [--port PORT] [--install] [--no-tunnel]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8645
INSTALL_DEPS=false
NO_TUNNEL=false
TUNNEL_URL=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      PORT="$2"
      shift 2
      ;;
    --install)
      INSTALL_DEPS=true
      shift
      ;;
    --no-tunnel)
      NO_TUNNEL=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./serve.sh [--port PORT] [--install] [--no-tunnel]"
      exit 1
      ;;
  esac
done

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "[!] python3 not found"
  exit 1
fi

# Check/install requests
if ! python3 -c "import requests" 2>/dev/null; then
  if [ "$INSTALL_DEPS" = true ]; then
    echo "[*] Installing requests..."
    pip3 install requests
  else
    echo "[!] requests module not found. Install with: pip3 install requests"
    echo "[*] Or run with --install flag"
    exit 1
  fi
fi

# Check/install cloudflared
if [ "$NO_TUNNEL" = false ]; then
  if ! command -v cloudflared &>/dev/null; then
    if [ "$INSTALL_DEPS" = true ]; then
      echo "[*] Installing cloudflared..."
      if command -v brew &>/dev/null; then
        brew install cloudflared
      elif command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y cloudflared
      else
        echo "[!] Could not auto-install cloudflared. Install manually or use --no-tunnel"
        NO_TUNNEL=true
      fi
    else
      echo "[!] cloudflared not found. Use --install or --no-tunnel"
      NO_TUNNEL=true
    fi
  fi
fi

echo "==================================="
echo "  mesh-kindle - Meshtastic Kindle"
echo "==================================="
echo "[*] Server port: $PORT"
echo "[*] Device URL: ${MESHTASTIC_URL:-http://meshtastic.local}"
echo ""

# Start tunnel in background if available
if [ "$NO_TUNNEL" = false ]; then
  echo "[*] Starting Cloudflare tunnel..."
  TUNNEL_LOG="/tmp/mesh-kindle-tunnel.log"
  cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "[*] Tunnel PID: $TUNNEL_PID"

  # Wait for tunnel URL
  echo "[*] Waiting for tunnel URL..."
  for i in $(seq 1 15); do
    sleep 1
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  done

  if [ -n "$TUNNEL_URL" ]; then
    echo ""
    echo "==================================="
    echo "  KINDLE URL: $TUNNEL_URL"
    echo "==================================="
    echo ""
  else
    echo "[!] Tunnel URL not found. Check $TUNNEL_LOG"
    echo "[*] Continuing without tunnel..."
  fi
fi

# Start Python server
echo "[*] Starting proxy server on port $PORT..."
echo "[*] Press Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR"
if [ -n "$TUNNEL_URL" ]; then
  python3 server.py "$PORT" &
  SERVER_PID=$!
  echo "[*] Server PID: $SERVER_PID"
  echo "[*] Tunnel PID: $TUNNEL_PID"
  wait $SERVER_PID
else
  python3 server.py "$PORT"
fi
