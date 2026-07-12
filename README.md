# mesh-kindle

A minimal Meshtastic client designed for Amazon Kindle e-ink browsers.

## Why?

The official Meshtastic web client is a React/TypeScript monorepo — too heavy for Kindle's constrained Chromium browser. This is a lightweight proxy + vanilla JS frontend that works within Kindle's limits:

- ES2019 only (no `?.`, `??`, or `||=`)
- No animations, transitions, or gradients (e-ink ghosting)
- High contrast black-on-white (or dark mode)
- System fonts only (no web fonts)
- 48px touch targets
- No emojis (use ASCII)
- HTTP transport only (no Web Bluetooth or Web Serial on Kindle)

## Architecture

```
Kindle Browser → Python Proxy (JSON API) → Meshtastic Device (Protobuf HTTP API)
     ↑                    ↑                           ↑
  vanilla JS         server.py                 /api/v1/fromradio
  no frameworks      protobuf encode/decode    /api/v1/toradio
                     polling loop
```

The Kindle browser only deals with JSON — all protobuf binary encoding/decoding happens server-side in Python.

## Features

- **Messages** — view and send text messages on the mesh
- **Nodes** — see discovered nodes with telemetry (battery, voltage, temp, humidity)
- **Positions** — view node coordinates
- **PWA** — installable, offline-capable via service worker
- **Dark mode** — triple-tap the title to toggle
- **Tunnel** — Cloudflare tunnel for remote Kindle access

## Setup

### 1. Configure Environment

```bash
export MESHTASTIC_URL="http://meshtastic.local"  # Your device URL
export MESHTASTIC_CHANNEL=0                       # Channel index
export POLL_INTERVAL=2.0                          # Seconds between polls
```

### 2. Install Requirements

```bash
pip install requests
```

### 3. Run

```bash
# Local only
./serve.sh --no-tunnel

# With Cloudflare tunnel (for Kindle access)
./serve.sh --install

# Custom port
./serve.sh --port 8645
```

The script prints a `trycloudflare.com` URL — open it in your Kindle's browser.

### 4. Kindle Access

- Open the tunnel URL in Kindle browser
- Go to Settings to configure device URL, channel, and poll interval
- Triple-tap "mesh-kindle" title to toggle dark mode

## Meshtastic HTTP API

This client uses the [Meshtastic HTTP API](https://meshtastic.org/docs/development/device/http-api):

- `GET /api/v1/fromradio?all=true` — fetch all pending protobufs
- `PUT /api/v1/toradio` — send a protobuf to the radio

No authentication required — the device trusts the local network.

## Kindle Constraints

Built following the Kindle Web Development skill:

- Chromium ~75 (firmware 5.16.4+)
- JIT-disabled V8 (5-10x slower)
- 16-level grayscale e-ink display
- 64MB total browser cache limit
- No `alert()`, `confirm()`, or `prompt()`
- No flexbox `gap` (use margins on siblings)

## License

MIT
