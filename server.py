#!/usr/bin/env python3
"""
Meshtastic Kindle Client - Proxy Server

Uses the official meshtastic Python library for device communication.
Exposes a simple JSON API for the Kindle e-ink browser frontend.
"""

import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlparse

try:
    from meshtastic.tcp_interface import TCPInterface
    from meshtastic.mesh_interface import MeshInterface
    from pubsub import pub
except ImportError:
    print("[!] meshtastic library not installed. Install with: pip install meshtastic")
    sys.exit(1)

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8645
DEVICE_URL = os.environ.get("MESHTASTIC_URL", "http://meshtastic.local")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5.0"))
DEFAULT_CHANNEL = int(os.environ.get("MESHTASTIC_CHANNEL", "0"))

# Parse hostname and port from DEVICE_URL
# Accepts: http://host:port, host:port, or host
def _parse_device_url():
    url = DEVICE_URL
    if url.startswith("http://"):
        url = url[7:]
    elif url.startswith("https://"):
        url = url[8:]
    if ":" in url:
        host, port_str = url.rsplit(":", 1)
        return host, int(port_str)
    return url, 4403


# --- STATE ---
state = {
    'nodes': {},
    'messages': [],
    'channels': {},
    'device_info': {},
    'last_poll': 0,
    'connected': False,
    'error': None,
}
state_lock = threading.Lock()

# --- MESHTASTIC INTERFACE ---
_iface = None
_iface_lock = threading.Lock()

# Role name lookup
ROLE_NAMES = {
    0: 'DISABLED',
    1: 'PRIMARY',
    2: 'SECONDARY',
}

# HW model lookup (common ones)
HW_MODELS = {
    0: 'UNSET',
    1: 'TLORA_V2',
    2: 'TLORA_V1',
    3: 'TLORA_V2_1_1P6',
    4: 'TBEAM',
    5: 'HELTEC_V2_0',
    6: 'TBEAM_V0P7',
    7: 'T_ECHO',
    8: 'LILYGO_TBEAM_S3_CORE',
    9: 'RAK4631',
    10: 'HELTEC_V3',
    11: 'HELTEC_V1',
    12: 'LILYGO_TLORA_V2_1_1P6',
    13: 'HELTEC_V2_1',
    14: 'HELTEC_WIRELESS_TRACKER',
    15: 'LILYGO_TBEAM_V1P1',
    16: 'STATION_G1',
    17: 'RAK11200',
    18: 'PORTDUINO',
    19: 'LILYGO_TLORA_V1_3',
    20: 'PRIVACY_KEYBOARD',
    21: 'HELTEC_WIRELESS_PAPER',
    22: 'HELTEC_WIRELESS_PAPER_V1',
    23: 'T_DECK',
    24: 'T_WATCH',
    25: 'PICOMPUTER_S3',
    26: 'HELTEC_V3',
    27: 'HELTEC_WSL_V3',
    28: 'HELTEC_BRIEF',
    29: 'LILYGO_TLORA_T3_S3',
    30: 'RAK3172',
    31: 'WIPHONE',
    32: 'HELTEC_HT62',
    33: 'SEEED_XIAO_S3',
    34: 'SEEED_SOLAR_NODE',
    35: 'TRACKER_T1000_E',
    36: 'RAK3172',
    37: 'MESHAB',
    38: 'DELTA5',
    39: 'HELTEC_MESH_NODE_T114',
    40: 'CROWPANEL',
    41: 'WISMESH_TAB',
    42: 'WISMESH_TAG',
    43: 'RAK4631',
    44: 'RAK4631',
    45: 'RAK4631',
    46: 'RAK4631',
    47: 'RAK4631',
    48: 'RAK4631',
    49: 'M5STACK_CORE2',
    50: 'RAK14001',
    51: 'WISMESH_S3',
    254: 'PRIVATE_HW',
}


def get_hw_model_name(hw_model):
    """Get human-readable hardware model name."""
    if hw_model is None:
        return ''
    # It might be an enum value or string
    if isinstance(hw_model, str):
        return hw_model
    return HW_MODELS.get(hw_model, str(hw_model))


def on_receive(packet, interface=None):
    """Callback for received packets from the radio (via pubsub)."""
    try:
        decoded = packet.get('decoded', {})
        portnum = decoded.get('portnum', '')
        payload = decoded.get('payload', b'')
        from_id = packet.get('from')
        to_id = packet.get('to')
        channel = packet.get('channel', 0)
        rx_time = packet.get('rxTime', packet.get('rx_time', 0))

        if not from_id:
            return

        from_hex = '!%08x' % from_id if isinstance(from_id, int) else str(from_id)

        if portnum == 'TEXT_MESSAGE_APP':
            text = ''
            if isinstance(payload, bytes):
                text = payload.decode('utf-8', errors='replace')
            elif isinstance(payload, str):
                text = payload

            msg = {
                'from': from_hex,
                'from_num': from_id,
                'to': '!%08x' % to_id if isinstance(to_id, int) else str(to_id),
                'channel': channel,
                'text': text,
                'timestamp': rx_time or int(time.time()),
            }
            with state_lock:
                state['messages'].append(msg)
                if len(state['messages']) > 100:
                    state['messages'] = state['messages'][-100:]

        elif portnum == 'NODEINFO_APP':
            # Node info updates come through automatically via iface.nodes
            pass

        elif portnum == 'TELEMETRY_APP':
            # Telemetry is embedded in the packet
            telemetry = decoded.get('telemetry', {})
            if telemetry:
                metrics = {}
                if 'deviceMetrics' in telemetry:
                    dm = telemetry['deviceMetrics']
                    metrics['battery'] = dm.get('batteryLevel')
                    metrics['voltage'] = dm.get('voltage')
                    metrics['channel_util'] = dm.get('channelUtilization')
                    metrics['air_util'] = dm.get('airUtilTx')
                if 'environmentMetrics' in telemetry:
                    em = telemetry['environmentMetrics']
                    metrics['temp'] = em.get('temperature')
                    metrics['humidity'] = em.get('relativeHumidity')
                if metrics and from_hex:
                    with state_lock:
                        existing = state['nodes'].get(from_hex, {})
                        existing['telemetry'] = metrics
                        state['nodes'][from_hex] = existing

        elif portnum == 'POSITION_APP':
            position = decoded.get('position', {})
            if position:
                pos = {}
                if 'latitude' in position:
                    pos['lat'] = position['latitude']
                elif 'latitudeI' in position:
                    pos['lat'] = position['latitudeI'] * 1e-7
                if 'longitude' in position:
                    pos['lon'] = position['longitude']
                elif 'longitudeI' in position:
                    pos['lon'] = position['longitudeI'] * 1e-7
                if 'altitude' in position:
                    pos['alt'] = position['altitude']
                if pos and from_hex:
                    with state_lock:
                        existing = state['nodes'].get(from_hex, {})
                        existing['position'] = pos
                        state['nodes'][from_hex] = existing

    except Exception as e:
        print(f"[!] Error in on_receive: {e}", file=sys.stderr)


def sync_state_from_iface(iface):
    """Pull current state from the meshtastic interface into our state dict."""
    # Nodes
    nodes = {}
    if iface.nodes:
        for node_id, nodeinfo in iface.nodes.items():
            if not isinstance(nodeinfo, dict):
                continue
            user = nodeinfo.get('user', {}) if isinstance(nodeinfo, dict) else {}
            position = nodeinfo.get('position', {}) if isinstance(nodeinfo, dict) else {}
            metrics = nodeinfo.get('deviceMetrics', {}) if isinstance(nodeinfo, dict) else {}

            node = {
                'id': node_id,
                'long_name': user.get('longName', ''),
                'short_name': user.get('shortName', ''),
                'role': user.get('role', ''),
                'hw_model': user.get('hwModel', ''),
                'last_heard': nodeinfo.get('lastHeard', 0),
                'snr': nodeinfo.get('snr'),
                'hops_away': nodeinfo.get('hopsAway'),
                'via_mqtt': nodeinfo.get('viaMqtt', False),
                'is_favorite': nodeinfo.get('isFavorite', False),
            }

            # Position
            if position:
                if 'latitude' in position:
                    node['position'] = {
                        'lat': position.get('latitude'),
                        'lon': position.get('longitude'),
                        'alt': position.get('altitude'),
                    }
                elif 'latitudeI' in position:
                    node['position'] = {
                        'lat': position.get('latitudeI', 0) * 1e-7,
                        'lon': position.get('longitudeI', 0) * 1e-7,
                        'alt': position.get('altitude'),
                    }

            # Telemetry / device metrics
            if metrics:
                node['telemetry'] = {
                    'battery': metrics.get('batteryLevel'),
                    'voltage': metrics.get('voltage'),
                    'channel_util': metrics.get('channelUtilization'),
                    'air_util': metrics.get('airUtilTx'),
                }

            # Preserve any previously collected telemetry
            with state_lock:
                existing = state['nodes'].get(node_id, {})
                if 'telemetry' not in node and 'telemetry' in existing:
                    node['telemetry'] = existing['telemetry']
                if 'position' not in node and 'position' in existing:
                    node['position'] = existing['position']

            nodes[node_id] = node

    # Channels
    channels = {}
    if hasattr(iface, '_localChannels'):
        for ch in iface._localChannels:
            idx = ch.index
            name = ''
            role = ROLE_NAMES.get(ch.role, 'UNKNOWN')
            uplink = False
            downlink = False
            if ch.HasField('settings'):
                s = ch.settings
                name = s.name if s.name else 'ch' + str(idx)
                uplink = s.uplink_enabled
                downlink = s.downlink_enabled
            if not name:
                name = 'ch' + str(idx)
            channels[idx] = {
                'index': idx,
                'name': name,
                'role': role,
                'uplink_enabled': uplink,
                'downlink_enabled': downlink,
            }

    # Device info
    device_info = {}
    try:
        my_info = iface.getMyNodeInfo()
        if my_info:
            user = my_info.get('user', {})
            device_info['node_id'] = user.get('id', '')
            device_info['long_name'] = user.get('longName', '')
            device_info['short_name'] = user.get('shortName', '')
            device_info['hw_model'] = user.get('hwModel', '')
            device_info['role'] = user.get('role', '')
            device_info['node_num'] = my_info.get('num')
    except:
        pass

    # Metadata
    try:
        if hasattr(iface, 'metadata') and iface.metadata:
            m = iface.metadata
            device_info['firmware'] = m.firmware_version if hasattr(m, 'firmware_version') else str(getattr(m, 'firmwareVersion', ''))
            device_info['hw_model'] = device_info.get('hw_model', '')
    except:
        pass

    with state_lock:
        state['nodes'] = nodes
        state['channels'] = channels
        state['device_info'] = device_info


def connect_to_radio():
    """Connect to the meshtastic device using the official library."""
    global _iface
    host, port = _parse_device_url()
    try:
        iface = TCPInterface(
            hostname=host,
            portNumber=port,
            connectNow=True,
            timeout=30,
        )
        # Register receive callback via pubsub
        pub.subscribe(on_receive, 'meshtastic.receive')
        # Wait for config to be populated
        iface.waitForConfig()
        _iface = iface
        return True
    except Exception as e:
        print(f"[!] Connection error: {e}", file=sys.stderr)
        _iface = None
        return False


def poll_loop():
    """Background polling loop."""
    global _iface
    while True:
        try:
            if _iface is None:
                connected = connect_to_radio()
                with state_lock:
                    state['connected'] = connected
                    state['last_poll'] = time.time()
                    if connected:
                        state['error'] = None
                    else:
                        state['error'] = 'Could not connect to device'
            else:
                # Sync state from interface
                try:
                    sync_state_from_iface(_iface)
                    # Send heartbeat to keep connection alive
                    _iface.sendHeartbeat()
                    with state_lock:
                        state['connected'] = True
                        state['last_poll'] = time.time()
                        state['error'] = None
                except Exception as e:
                    print(f"[!] Poll error: {e}", file=sys.stderr)
                    with state_lock:
                        state['connected'] = False
                        state['error'] = str(e)
                    try:
                        _iface.close()
                    except:
                        pass
                    _iface = None
        except Exception as e:
            print(f"[!] Loop error: {e}", file=sys.stderr)
            with state_lock:
                state['error'] = str(e)
                state['connected'] = False
            _iface = None

        time.sleep(POLL_INTERVAL)


# --- HTTP SERVER ---
class MeshtasticProxyHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/':
            self.serve_file('index.html', 'text/html')
        elif parsed.path == '/manifest.json':
            self.serve_file('manifest.json', 'application/json')
        elif parsed.path == '/sw.js':
            self.serve_file('sw.js', 'application/javascript')
        elif parsed.path == '/style.css':
            self.serve_file('style.css', 'text/css')
        elif parsed.path == '/app.js':
            self.serve_file('app.js', 'application/javascript')
        elif parsed.path.startswith('/api/'):
            self.handle_api(parsed)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/send':
            self.handle_send()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def serve_file(self, filename, content_type):
        filepath = Path(__file__).parent / filename
        if filepath.exists():
            content = filepath.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def handle_api(self, parsed):
        if parsed.path == '/api/status':
            with state_lock:
                self.send_json({
                    'connected': state['connected'],
                    'device_url': DEVICE_URL,
                    'device_info': state['device_info'],
                    'last_poll': state['last_poll'],
                    'error': state['error'],
                    'node_count': len(state['nodes']),
                    'message_count': len(state['messages']),
                    'channel_count': len(state['channels']),
                })
        elif parsed.path == '/api/nodes':
            with state_lock:
                nodes = list(state['nodes'].values())
            # Sort: known names first, then by last heard
            nodes.sort(key=lambda n: (
                n.get('long_name', '') == '',
                -(n.get('last_heard', 0) or 0)
            ))
            self.send_json({'nodes': nodes})
        elif parsed.path == '/api/messages':
            with state_lock:
                messages = list(state['messages'])
            self.send_json({
                'messages': messages,
                'device_url': DEVICE_URL,
            })
        elif parsed.path == '/api/channels':
            with state_lock:
                channels = sorted(state['channels'].values(), key=lambda c: c.get('index', 0))
            self.send_json({'channels': channels})
        elif parsed.path == '/api/telemetry':
            with state_lock:
                telemetry = {}
                for nid, node in state['nodes'].items():
                    if 'telemetry' in node:
                        telemetry[nid] = node['telemetry']
            self.send_json({'telemetry': telemetry})
        elif parsed.path == '/api/positions':
            with state_lock:
                positions = {}
                for nid, node in state['nodes'].items():
                    if 'position' in node:
                        positions[nid] = node['position']
            self.send_json({'positions': positions})
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def handle_send(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        try:
            data = json.loads(body)
            text = data.get('text', '').strip()
            channel = int(data.get('channel', DEFAULT_CHANNEL))
            dest = data.get('dest_node')

            if not text:
                self.send_json({'ok': False, 'error': 'No text provided'}, 400)
                return

            if len(text) > 200:
                self.send_json({'ok': False, 'error': 'Message too long (max 200 chars)'}, 400)
                return

            if _iface is None:
                self.send_json({'ok': False, 'error': 'Not connected to device'}, 503)
                return

            # Use the official library to send
            try:
                dest_int = None
                if dest and dest.startswith('!'):
                    try:
                        dest_int = int(dest[1:], 16)
                    except ValueError:
                        pass

                if dest_int:
                    _iface.sendText(text, destinationId=dest_int, channelIndex=channel)
                else:
                    _iface.sendText(text, channelIndex=channel)

                self.send_json({'ok': True})
            except Exception as e:
                self.send_json({'ok': False, 'error': str(e)}, 500)

        except json.JSONDecodeError:
            self.send_json({'ok': False, 'error': 'Invalid JSON'}, 400)


def main():
    # Start polling thread
    poller = threading.Thread(target=poll_loop, daemon=True)
    poller.start()
    print(f"[*] Meshtastic Kindle Client server on port {PORT}")
    print(f"[*] Device URL: {DEVICE_URL}")
    print(f"[*] Poll interval: {POLL_INTERVAL}s")

    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), MeshtasticProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
