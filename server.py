#!/usr/bin/env python3
"""
Meshtastic Kindle Client - Proxy Server v2

Uses MeshMonitor REST API for data (nodes, messages, channels, telemetry)
with pagination and historical message caching. Falls back to TCP StreamAPI
for send/admin actions that require a direct device connection.
"""

import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlparse

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8645
MESHMONITOR_URL = os.environ.get("MESHMONITOR_URL", "https://meshmonitor.gwyn.tel")
MESHMONITOR_TOKEN = os.environ.get("MESHMONITOR_TOKEN", "")
DEVICE_URL = os.environ.get("MESHTASTIC_URL", "http://meshmonitor.gwyn.tel:4404")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "10.0"))
DEFAULT_CHANNEL = int(os.environ.get("MESHTASTIC_CHANNEL", "0"))
MAX_MESSAGES = int(os.environ.get("MAX_MESSAGES", "500"))

# --- STATE ---
state = {
    'nodes': [],
    'messages': [],
    'channels': [],
    'device_info': {},
    'net_stats': {},
    'connected': False,
    'error': None,
    'last_poll': 0,
    'last_message_ts': 0,  # Track newest message timestamp for incremental fetch
}
state_lock = threading.Lock()

# TCP interface for send/admin (lazy-initialized)
_iface = None
_iface_lock = threading.Lock()

# HW model lookup
HW_MODELS = {
    0: 'UNSET', 1: 'TLORA_V2', 2: 'TLORA_V1', 3: 'TLORA_V2_1_1P6',
    4: 'TBEAM', 5: 'HELTEC_V2_0', 6: 'TBEAM_V0P7', 7: 'T_ECHO',
    8: 'LILYGO_TBEAM_S3_CORE', 9: 'RAK4631', 10: 'HELTEC_V3', 11: 'HELTEC_V1',
    12: 'LILYGO_TLORA_V2_1_1P6', 13: 'HELTEC_V2_1', 14: 'HELTEC_WIRELESS_TRACKER',
    15: 'LILYGO_TBEAM_V1P1', 16: 'STATION_G1', 17: 'RAK11200', 18: 'PORTDUINO',
    19: 'LILYGO_TLORA_V1_3', 20: 'PRIVACY_KEYBOARD', 21: 'HELTEC_WIRELESS_PAPER',
    22: 'HELTEC_WIRELESS_PAPER_V1', 23: 'T_DECK', 24: 'T_WATCH', 25: 'PICOMPUTER_S3',
    26: 'HELTEC_V3', 27: 'HELTEC_WSL_V3', 28: 'HELTEC_BRIEF', 29: 'LILYGO_TLORA_T3_S3',
    30: 'RAK3172', 31: 'WIPHONE', 32: 'HELTEC_HT62', 33: 'SEEED_XIAO_S3',
    34: 'SEEED_SOLAR_NODE', 35: 'TRACKER_T1000_E', 36: 'RAK3172', 37: 'MESHAB',
    38: 'DELTA5', 39: 'HELTEC_MESH_NODE_T114', 40: 'CROWPANEL', 41: 'WISMESH_TAB',
    42: 'WISMESH_TAG', 43: 'RAK4631', 44: 'RAK4631', 45: 'RAK4631',
    46: 'RAK4631', 47: 'RAK4631', 48: 'RAK4631', 49: 'M5STACK_CORE2',
    50: 'RAK14001', 51: 'WISMESH_S3', 81: 'WISMESH_TAB', 254: 'PRIVATE_HW',
}

ROLE_NAMES = {
    0: 'DISABLED', 1: 'PRIMARY', 2: 'SECONDARY',
}

NODE_ROLES = {
    0: 'CLIENT', 1: 'CLIENT_MUTE', 2: 'ROUTER', 3: 'ROUTER_LATE',
    4: 'ROUTER_CLIENT', 5: 'REPEATER', 6: 'TRACKER',
    7: 'SENSOR', 8: 'TAK', 9: 'CLIENT_HIDDEN', 10: 'LOST_AND_FOUND',
    11: 'TAK_TRACKER', 12: 'ROUTER_LATE',
}


def mm_api(path, params=None):
    """Fetch from MeshMonitor REST API."""
    url = MESHMONITOR_URL + '/api/v1/' + path
    if params:
        query = urllib.parse.urlencode(params)
        url += '?' + query
    req = urllib.request.Request(url)
    req.add_header('Authorization', 'Bearer ' + MESHMONITOR_TOKEN)
    req.add_header('Accept', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"[!] MM API error ({path}): {e}", file=sys.stderr)
        return None


def fetch_nodes():
    """Fetch all nodes from MeshMonitor (API returns all in one call)."""
    data = mm_api('nodes', {'limit': 500, 'offset': 0})
    if not data or not data.get('success'):
        return []
    nodes = []
    for n in data.get('data', []):
        node = {
            'id': n.get('nodeId', ''),
            'long_name': n.get('longName', ''),
            'short_name': n.get('shortName', ''),
            'hw_model': HW_MODELS.get(n.get('hwModel'), str(n.get('hwModel', ''))),
            'role': NODE_ROLES.get(n.get('role'), str(n.get('role', ''))),
            'last_heard': n.get('lastHeard', 0) or 0,
            'snr': n.get('snr'),
            'hops_away': n.get('hopsAway'),
            'via_mqtt': n.get('viaMqtt', False),
            'is_favorite': n.get('isFavorite', False),
            'firmware': n.get('firmwareVersion', ''),
        }
        lat = n.get('latitude')
        lon = n.get('longitude')
        if lat is not None and lon is not None:
            node['position'] = {'lat': lat, 'lon': lon, 'alt': n.get('altitude')}
        telem = {}
        if n.get('batteryLevel') is not None:
            telem['battery'] = n['batteryLevel']
        if n.get('voltage') is not None:
            telem['voltage'] = n['voltage']
        if n.get('channelUtilization') is not None:
            telem['channel_util'] = n['channelUtilization']
        if n.get('airUtilTx') is not None:
            telem['air_util'] = n['airUtilTx']
        if telem:
            node['telemetry'] = telem
        nodes.append(node)
    return nodes


def fetch_messages(since_ts=0):
    """Fetch messages from MeshMonitor.
    If since_ts > 0: incremental fetch (only new messages).
    If since_ts == 0: initial fetch (last 500 messages).
    """
    all_messages = []
    limit = 200
    
    if since_ts > 0:
        # Incremental — just get messages since last timestamp
        params = {'limit': 500, 'since': since_ts}
        data = mm_api('messages', params)
        if data and data.get('success'):
            for m in data.get('data', []):
                all_messages.append(_parse_message(m))
    else:
        # Initial — get last 500 messages (one fetch, API returns most recent first)
        params = {'limit': 500}
        data = mm_api('messages', params)
        if data and data.get('success'):
            for m in data.get('data', []):
                all_messages.append(_parse_message(m))
    
    all_messages.sort(key=lambda m: m.get('timestamp', 0))
    return all_messages


def _parse_message(m):
    """Parse a MeshMonitor message into our format."""
    msg = {
        'id': m.get('id', ''),
        'from': m.get('fromNodeId', ''),
        'to': m.get('toNodeId', ''),
        'channel': m.get('channel', 0),
        'text': m.get('text', ''),
        'timestamp': (m.get('timestamp') or 0) // 1000 if m.get('timestamp') else 0,
        'via_mqtt': m.get('viaMqtt', False),
        'hops_taken': None,
        'snr': m.get('rxSnr'),
        'is_own': False,
        'relay_node': m.get('relayNode'),
        'hop_start': m.get('hopStart'),
        'hop_limit': m.get('hopLimit'),
    }
    if msg['hop_start'] is not None and msg['hop_limit'] is not None:
        msg['hops_taken'] = msg['hop_start'] - msg['hop_limit']
    return msg


def fetch_channels():
    """Fetch channels from MeshMonitor."""
    data = mm_api('channels', {'limit': 50})
    if not data or not data.get('success'):
        return []
    channels = []
    for ch in data.get('data', []):
        channels.append({
            'index': ch.get('id', 0),
            'name': ch.get('name', ch.get('displayName', '')),
            'role': ROLE_NAMES.get(ch.get('role'), ch.get('roleName', 'UNKNOWN')),
            'uplink_enabled': ch.get('uplinkEnabled', False),
            'downlink_enabled': ch.get('downlinkEnabled', False),
        })
    return channels


def fetch_status():
    """Fetch connection status from MeshMonitor."""
    data = mm_api('status')
    if not data or not data.get('success'):
        return False, {}
    d = data.get('data', {})
    return d.get('connected', False), d


def poll_loop():
    """Background polling loop — fetches data from MeshMonitor REST API."""
    while True:
        try:
            connected, status_data = fetch_status()
            
            if connected:
                nodes = fetch_nodes()
                channels = fetch_channels()
                
                with state_lock:
                    since = state['last_message_ts']
                new_messages = fetch_messages(since_ts=since) if since > 0 else fetch_messages(since_ts=0)
                
                with state_lock:
                    state['connected'] = True
                    state['error'] = None
                    state['last_poll'] = time.time()
                    state['nodes'] = nodes
                    state['channels'] = channels
                    
                    if new_messages:
                        if since > 0:
                            # Incremental — append new messages
                            state['messages'].extend(new_messages)
                        else:
                            # Full fetch — replace
                            state['messages'] = new_messages
                        
                        # Trim to max
                        if len(state['messages']) > MAX_MESSAGES:
                            state['messages'] = state['messages'][-MAX_MESSAGES:]
                        
                        # Update last message timestamp
                        for m in state['messages']:
                            ts = m.get('timestamp', 0)
                            if ts > state['last_message_ts']:
                                state['last_message_ts'] = ts
                        
                        # Mark own messages
                        local_node_id = state.get('device_info', {}).get('node_id', '')
                        if local_node_id:
                            for m in state['messages']:
                                if m.get('from') == local_node_id:
                                    m['is_own'] = True
                    
                    state['net_stats'] = status_data.get('statistics', {})
            else:
                with state_lock:
                    state['connected'] = False
                    state['error'] = 'MeshMonitor reports disconnected'
                    state['last_poll'] = time.time()
                    
        except Exception as e:
            print(f"[!] Poll error: {e}", file=sys.stderr)
            with state_lock:
                state['connected'] = False
                state['error'] = str(e)
                state['last_poll'] = time.time()
        
        time.sleep(POLL_INTERVAL)


# --- TCP INTERFACE (for send/admin only) ---
def get_tcp_iface():
    """Lazy-initialize TCP interface for send/admin actions."""
    global _iface
    with _iface_lock:
        if _iface is not None:
            try:
                _iface.sendHeartbeat()
                return _iface
            except:
                try:
                    _iface.close()
                except:
                    pass
                _iface = None
    # Need to connect
    try:
        from meshtastic.tcp_interface import TCPInterface
        from pubsub import pub
    except ImportError:
        return None
    
    url = DEVICE_URL
    if url.startswith('http://'):
        url = url[7:]
    elif url.startswith('https://'):
        url = url[8:]
    if ':' in url:
        host, port_str = url.rsplit(':', 1)
        port = int(port_str)
    else:
        host, port = url, 4403
    
    try:
        with _iface_lock:
            _iface = TCPInterface(hostname=host, portNumber=port, connectNow=True, timeout=30)
            _iface.waitForConfig()
            return _iface
    except Exception as e:
        print(f"[!] TCP connect error: {e}", file=sys.stderr)
        with _iface_lock:
            _iface = None
        return None


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
        elif parsed.path == '/NotoEmoji.ttf':
            self.serve_file('NotoEmoji.ttf', 'application/x-font-ttf')
        elif parsed.path.startswith('/emoji/'):
            emoji_name = parsed.path.split('/')[-1]
            if emoji_name.endswith('.png') and all(c.isalnum() or c == '.' for c in emoji_name):
                emoji_path = Path(__file__).parent / 'emoji' / emoji_name
                if emoji_path.exists():
                    self.serve_file('emoji/' + emoji_name, 'image/png')
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        elif parsed.path.startswith('/api/'):
            self.handle_api(parsed)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/send':
            self.handle_send()
        elif parsed.path == '/api/favorite':
            self.handle_favorite()
        elif parsed.path.startswith('/api/admin/'):
            action = parsed.path.split('/')[-1]
            self.handle_admin(action)
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
        qs = urllib.parse.parse_qs(parsed.query)
        
        if parsed.path == '/api/status':
            with state_lock:
                self.send_json({
                    'connected': state['connected'],
                    'device_url': DEVICE_URL,
                    'meshmonitor_url': MESHMONITOR_URL,
                    'device_info': state['device_info'],
                    'net_stats': state.get('net_stats', {}),
                    'last_poll': state['last_poll'],
                    'error': state['error'],
                    'node_count': len(state['nodes']),
                    'message_count': len(state['messages']),
                    'channel_count': len(state['channels']),
                })
        elif parsed.path == '/api/nodes':
            with state_lock:
                nodes = list(state['nodes'])
            # Sort: known names first, then by last heard
            nodes.sort(key=lambda n: (
                n.get('long_name', '') == '',
                -(n.get('last_heard', 0) or 0)
            ))
            # Pagination
            limit = int(qs.get('limit', [0])[0])
            offset = int(qs.get('offset', [0])[0])
            if limit > 0:
                total = len(nodes)
                nodes = nodes[offset:offset + limit]
                self.send_json({'nodes': nodes, 'total': total, 'offset': offset, 'limit': limit})
            else:
                self.send_json({'nodes': nodes, 'total': len(nodes)})
        elif parsed.path == '/api/messages':
            with state_lock:
                messages = list(state['messages'])
            # Filter by channel if requested
            channel = qs.get('channel', [None])[0]
            if channel is not None:
                try:
                    ch = int(channel)
                    messages = [m for m in messages if m.get('channel') == ch]
                except ValueError:
                    pass
            # Filter by since (timestamp)
            since = qs.get('since', [0])[0]
            if since:
                try:
                    since_ts = int(since)
                    messages = [m for m in messages if m.get('timestamp', 0) >= since_ts]
                except ValueError:
                    pass
            # Pagination
            limit = int(qs.get('limit', [0])[0])
            offset = int(qs.get('offset', [0])[0])
            if limit > 0:
                total = len(messages)
                messages = messages[offset:offset + limit]
                self.send_json({'messages': messages, 'total': total, 'offset': offset, 'limit': limit})
            else:
                self.send_json({'messages': messages, 'total': len(messages)})
        elif parsed.path == '/api/channels':
            with state_lock:
                channels = list(state['channels'])
            # Filter out disabled
            channels = [c for c in channels if c.get('role') != 'DISABLED']
            self.send_json({'channels': channels})
        elif parsed.path == '/api/telemetry':
            with state_lock:
                telemetry = {}
                for node in state['nodes']:
                    if 'telemetry' in node:
                        telemetry[node['id']] = node['telemetry']
            self.send_json({'telemetry': telemetry})
        elif parsed.path == '/api/positions':
            with state_lock:
                positions = {}
                for node in state['nodes']:
                    if 'position' in node:
                        positions[node['id']] = node['position']
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
            
            iface = get_tcp_iface()
            if iface is None:
                self.send_json({'ok': False, 'error': 'Could not connect to device for send'}, 503)
                return
            
            try:
                dest_int = None
                if dest and dest.startswith('!'):
                    try:
                        dest_int = int(dest[1:], 16)
                    except ValueError:
                        pass
                
                if dest_int:
                    iface.sendText(text, destinationId=dest_int, channelIndex=channel)
                else:
                    iface.sendText(text, channelIndex=channel)
                
                self.send_json({'ok': True})
            except Exception as e:
                self.send_json({'ok': False, 'error': str(e)}, 500)
        except json.JSONDecodeError:
            self.send_json({'ok': False, 'error': 'Invalid JSON'}, 400)

    def handle_favorite(self):
        self.send_json({'ok': False, 'error': 'Favorite toggle requires TCP interface — not available via MeshMonitor API'}, 503)

    def handle_admin(self, action):
        iface = get_tcp_iface()
        if iface is None or iface.localNode is None:
            self.send_json({'ok': False, 'error': 'Not connected'}, 503)
            return
        try:
            if action == 'reboot':
                iface.localNode.reboot()
                self.send_json({'ok': True, 'message': 'reboot sent'})
            elif action == 'shutdown':
                iface.localNode.shutdown()
                self.send_json({'ok': True, 'message': 'shutdown sent'})
            elif action == 'reset-nodedb':
                iface.localNode.resetNodeDb()
                self.send_json({'ok': True, 'message': 'nodedb reset sent'})
            elif action == 'factory-reset':
                iface.localNode.factoryReset(full=False)
                self.send_json({'ok': True, 'message': 'factory reset sent'})
            elif action == 'enter-dfu':
                iface.localNode.enterDFUMode()
                self.send_json({'ok': True, 'message': 'DFU mode sent'})
            else:
                self.send_json({'ok': False, 'error': 'Unknown action: ' + action}, 400)
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)}, 500)


def main():
    if not MESHMONITOR_TOKEN:
        print("[!] MESHMONITOR_TOKEN not set. Set it with: export MESHMONITOR_TOKEN=your_token")
        sys.exit(1)
    
    poller = threading.Thread(target=poll_loop, daemon=True)
    poller.start()
    print(f"[*] Meshtastic Kindle Client v2 on port {PORT}")
    print(f"[*] MeshMonitor: {MESHMONITOR_URL}")
    print(f"[*] Device (TCP): {DEVICE_URL}")
    print(f"[*] Poll interval: {POLL_INTERVAL}s")
    print(f"[*] Max messages cached: {MAX_MESSAGES}")
    
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), MeshtasticProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
