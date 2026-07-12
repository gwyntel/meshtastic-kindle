#!/usr/bin/env python3
"""
Meshtastic Kindle Client - Proxy Server

Handles protobuf communication with Meshtastic devices over HTTP,
exposes a simple JSON API for the Kindle e-ink browser frontend.

The Kindle browser can't handle protobufs or complex JS — this proxy
does all the heavy lifting and returns clean JSON.
"""

import http.server
import json
import os
import struct
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from pathlib import Path

try:
    import requests
except ImportError:
    print("[!] requests not installed. Install with: pip install requests")
    sys.exit(1)

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8645
DEVICE_URL = os.environ.get("MESHTASTIC_URL", "http://meshtastic.local")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "2.0"))
DEFAULT_CHANNEL = int(os.environ.get("MESHTASTIC_CHANNEL", "0"))

# --- PROTOBUF HELPERS ---
# We use raw protobuf field encoding since we can't depend on generated code.
# Meshtastic uses protobuf3 with specific field numbers from their .proto files.

# Portnum values (from portnums.proto)
PORTNUM_TEXT_MESSAGE = 1
PORTNUM_NODEINFO = 4
PORTNUM_TELEMETRY = 10
PORTNUM_POSITION = 3
PORTNUM_ADMIN = 100

# Mesh packet field numbers (from mesh.proto)
PKT_FIELD_FROM = 1  # node id (uint32)
PKT_FIELD_TO = 2    # node id (uint32)
PKT_FIELD_CHANNEL = 3  # channel index (uint32)
PKT_FIELD_DECRYPTED = 4  # bytes
PKT_FIELD_ID = 5    # packet id (uint32)
PKT_FIELD_PORTNUM = 6  # variant (Data enum)
PKT_FIELD_PAYLOAD = 7  # bytes

# Service info field numbers
SI_FIELD_NODE_NUM = 1  # uint32
SI_FIELD_LONG_NAME = 2  # bytes
SI_FIELD_SHORT_NAME = 3  # bytes
SI_FIELD_ROLE = 4  # enum

# Telemetry field numbers (from telemetry.proto)
TELEM_FIELD_BATTERY = 1  # uint32 (battery level %)
TELEM_FIELD_VOLTAGE = 2  # float
TELEM_FIELD_CHANNEL_UTIL = 3  # float
TELEM_FIELD_AIR_UTIL = 4  # float
TELEM_FIELD_BARO = 5  # float
TELEM_FIELD_TEMP = 6  # float
TELEM_FIELD_HUMIDITY = 7  # float

# Position field numbers
POS_FIELD_LAT = 1  # sint32 (1e-7)
POS_FIELD_LON = 2  # sint32 (1e-7)
POS_FIELD_ALT = 3  # int32


def encode_varint(value):
    """Encode an unsigned integer as a protobuf varint."""
    result = bytearray()
    while value > 0x7F:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def decode_varint(data, offset=0):
    """Decode a protobuf varint. Returns (value, new_offset)."""
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        result |= (byte & 0x7F) << shift
        offset += 1
        if not (byte & 0x80):
            break
        shift += 7
    return result, offset


def encode_zigzag32(value):
    """Encode a signed int32 as zigzag."""
    return (value << 1) ^ (value >> 31) & 0xFFFFFFFF


def decode_zigzag32(value):
    """Decode a zigzag-encoded int32."""
    return (value >> 1) ^ -(value & 1)


def parse_protobuf_fields(data):
    """Parse raw protobuf fields from binary data.
    Returns a dict: {field_number: (wire_type, value_bytes)}
    For repeated fields, returns a list of values.
    """
    fields = {}
    offset = 0
    while offset < len(data):
        try:
            tag, offset = decode_varint(data, offset)
        except Exception:
            break
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:  # Varint
            value, offset = decode_varint(data, offset)
            key = field_number
            if key in fields and isinstance(fields[key], list):
                fields[key].append(value)
            elif key in fields:
                fields[key] = [fields[key], value]
            else:
                fields[key] = value
        elif wire_type == 1:  # 64-bit
            if offset + 8 <= len(data):
                value = struct.unpack('<d', data[offset:offset+8])[0]
                offset += 8
                fields[field_number] = value
            else:
                break
        elif wire_type == 2:  # Length-delimited (bytes/string/sub-message)
            length, offset = decode_varint(data, offset)
            if offset + length <= len(data):
                value = data[offset:offset+length]
                offset += length
                key = field_number
                if key in fields and isinstance(fields[key], list):
                    fields[key].append(value)
                elif key in fields:
                    fields[key] = [fields[key], value]
                else:
                    fields[key] = value
            else:
                break
        elif wire_type == 5:  # 32-bit
            if offset + 4 <= len(data):
                value = struct.unpack('<f', data[offset:offset+4])[0]
                offset += 4
                fields[field_number] = value
            else:
                break
        else:
            break  # Unknown wire type, stop

    return fields


def safe_str(data):
    """Safely decode bytes to string."""
    if isinstance(data, bytes):
        try:
            return data.decode('utf-8', errors='replace').rstrip('\x00')
        except Exception:
            return data.hex()
    return str(data) if data else ''


def get_field_value(fields, field_num, default=None):
    """Get a single value from a protobuf field dict (handles lists)."""
    val = fields.get(field_num, default)
    if isinstance(val, list):
        return val[0] if val else default
    return val


# --- STATE ---
state = {
    'nodes': {},        # node_num -> {long_name, short_name, role, last_heard}
    'messages': [],      # list of {id, from, to, channel, text, timestamp}
    'telemetry': {},     # node_num -> {battery, voltage, temp, ...}
    'positions': {},     # node_num -> {lat, lon, alt}
    'device_info': {},   # device metadata
    'last_poll': 0,
    'connected': False,
    'error': None,
}
state_lock = threading.Lock()


def poll_from_radio():
    """Poll the Meshtastic device for new data via HTTP API."""
    url = f"{DEVICE_URL}/api/v1/fromradio?all=true"
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.content
            if data and len(data) > 0:
                parse_from_radio_data(data)
            return True
        return False
    except requests.exceptions.RequestException as e:
        state['error'] = str(e)
        return False


def parse_from_radio_data(data):
    """Parse FromRadio protobuf data.
    FromRadio is a repeating stream of protobuf messages.
    Each message is a FromRadio with a single oneof field.
    """
    offset = 0
    while offset < len(data):
        try:
            tag, new_offset = decode_varint(data, offset)
            field_number = tag >> 3
            wire_type = tag & 0x07

            if wire_type != 2:
                break

            length, new_offset = decode_varint(data, new_offset)
            if new_offset + length > len(data):
                break

            msg_data = data[new_offset:new_offset+length]
            offset = new_offset + length

            # field_number 1 = packet
            if field_number == 1:
                parse_mesh_packet(msg_data)
            # field_number 3 = nodeinfo
            elif field_number == 3:
                parse_node_info(msg_data)
            # field_number 5 = telemetry
            elif field_number == 5:
                parse_telemetry(msg_data)
            # field_number = 6 = position
            elif field_number == 6:
                parse_position_msg(msg_data)
            # field_number = 7 = metadata
            elif field_number == 7:
                parse_metadata(msg_data)

        except Exception as e:
            break


def parse_mesh_packet(data):
    """Parse a MeshPacket protobuf."""
    fields = parse_protobuf_fields(data)
    with state_lock:
        packet = {
            'from': get_field_value(fields, PKT_FIELD_FROM),
            'to': get_field_value(fields, PKT_FIELD_TO),
            'channel': get_field_value(fields, PKT_FIELD_CHANNEL, 0),
            'id': get_field_value(fields, PKT_FIELD_ID),
            'timestamp': time.time(),
        }

        # Decoded payload
        decoded = get_field_value(fields, PKT_FIELD_DECRYPTED)
        portnum = None
        payload_bytes = None

        if isinstance(decoded, bytes):
            sub_fields = parse_protobuf_fields(decoded)
            portnum = get_field_value(sub_fields, PKT_FIELD_PORTNUM)
            payload_bytes = get_field_value(sub_fields, PKT_FIELD_PAYLOAD)

        if portnum == PORTNUM_TEXT_MESSAGE and payload_bytes:
            text = safe_str(payload_bytes)
            packet['text'] = text
            packet['type'] = 'text'
            state['messages'].append(packet)
            # Keep only last 200 messages
            if len(state['messages']) > 200:
                state['messages'] = state['messages'][-200:]

        elif portnum == PORTNUM_NODEINFO and payload_bytes:
            parse_node_info(payload_bytes)


def parse_node_info(data):
    """Parse a NodeInfo protobuf message."""
    fields = parse_protobuf_fields(data)
    node_num = get_field_value(fields, SI_FIELD_NODE_NUM)
    if node_num is None:
        return

    long_name = None
    short_name = None
    role = None

    # Long name is a sub-message (bytes containing string)
    ln = get_field_value(fields, SI_FIELD_LONG_NAME)
    if isinstance(ln, bytes):
        long_name = safe_str(ln)

    sn = get_field_value(fields, SI_FIELD_SHORT_NAME)
    if isinstance(sn, bytes):
        short_name = safe_str(sn)

    r = get_field_value(fields, SI_FIELD_ROLE)
    if r is not None:
        role = int(r) if not isinstance(r, int) else r

    with state_lock:
        node_id = '!%08x' % node_num
        existing = state['nodes'].get(node_id, {})
        existing['node_num'] = node_num
        if long_name:
            existing['long_name'] = long_name
        if short_name:
            existing['short_name'] = short_name
        if role is not None:
            existing['role'] = role
        existing['last_heard'] = time.time()
        state['nodes'][node_id] = existing


def parse_telemetry(data):
    """Parse a Telemetry protobuf message."""
    fields = parse_protobuf_fields(data)
    node_num = get_field_value(fields, 1)  # from node

    if node_num is None:
        return

    battery = get_field_value(fields, TELEM_FIELD_BATTERY)
    voltage = get_field_value(fields, TELEM_FIELD_VOLTAGE)
    channel_util = get_field_value(fields, TELEM_FIELD_CHANNEL_UTIL)
    air_util = get_field_value(fields, TELEM_FIELD_AIR_UTIL)
    baro = get_field_value(fields, TELEM_FIELD_BARO)
    temp = get_field_value(fields, TELEM_FIELD_TEMP)
    humidity = get_field_value(fields, TELEM_FIELD_HUMIDITY)

    with state_lock:
        node_id = '!%08x' % node_num
        telemetry = state['telemetry'].get(node_id, {})
        if battery is not None:
            telemetry['battery'] = int(battery)
        if voltage is not None:
            telemetry['voltage'] = round(float(voltage), 2)
        if channel_util is not None:
            telemetry['channel_util'] = round(float(channel_util), 2)
        if air_util is not None:
            telemetry['air_util'] = round(float(air_util), 2)
        if baro is not None:
            telemetry['baro'] = round(float(baro), 1)
        if temp is not None:
            telemetry['temp'] = round(float(temp), 1)
        if humidity is not None:
            telemetry['humidity'] = round(float(humidity), 1)
        telemetry['timestamp'] = time.time()
        state['telemetry'][node_id] = telemetry


def parse_position_msg(data):
    """Parse a Position protobuf message."""
    fields = parse_protobuf_fields(data)
    node_num = get_field_value(fields, 1)

    lat_raw = get_field_value(fields, POS_FIELD_LAT)
    lon_raw = get_field_value(fields, POS_FIELD_LON)
    alt = get_field_value(fields, POS_FIELD_ALT)

    with state_lock:
        node_id = '!%08x' % node_num if node_num else None
        if node_id:
            pos = state['positions'].get(node_id, {})
            if lat_raw is not None:
                pos['lat'] = round(decode_zigzag32(int(lat_raw)) * 1e-7, 6)
            if lon_raw is not None:
                pos['lon'] = round(decode_zigzag32(int(lon_raw)) * 1e-7, 6)
            if alt is not None:
                pos['alt'] = int(alt)
            pos['timestamp'] = time.time()
            state['positions'][node_id] = pos


def parse_metadata(data):
    """Parse device metadata."""
    fields = parse_protobuf_fields(data)
    with state_lock:
        fw_version = get_field_value(fields, 1)  # firmware_version
        if isinstance(fw_version, bytes):
            state['device_info']['firmware'] = safe_str(fw_version)
        hw_model = get_field_value(fields, 2)
        if hw_model is not None:
            state['device_info']['hw_model'] = int(hw_model) if not isinstance(hw_model, int) else hw_model


def send_text_message(text, channel=DEFAULT_CHANNEL, dest_node=None):
    """Send a text message to the Meshtastic device via HTTP API."""
    # Build the inner Data message (portnum + payload)
    data_bytes = bytearray()

    # Portnum (field 3, wire type 2 = length-delimited within Data submessage)
    # Actually Data.portnum is a variant (enum) field 3, wire type 0
    data_bytes += encode_varint((PKT_FIELD_PORTNUM << 3) | 0)  # field 6 in MeshPacket, but in Data it's field 3
    data_bytes += encode_varint(PORTNUM_TEXT_MESSAGE)

    # Payload (field 7 in MeshPacket, but in Data it's field 2)
    payload = text.encode('utf-8')
    data_bytes += encode_varint((2 << 3) | 2)  # field 2, length-delimited
    data_bytes += encode_varint(len(payload))
    data_bytes += payload

    # Build MeshPacket
    packet = bytearray()

    # From field (field 1, varint) - let device fill it
    # To field (field 2, varint)
    if dest_node:
        packet += encode_varint((PKT_FIELD_TO << 3) | 0)
        packet += encode_varint(dest_node)

    # Channel (field 3, varint)
    packet += encode_varint((PKT_FIELD_CHANNEL << 3) | 0)
    packet += encode_varint(channel)

    # Decrypted/decoded payload (field 4, length-delimited)
    packet += encode_varint((PKT_FIELD_DECRYPTED << 3) | 2)
    packet += encode_varint(len(data_bytes))
    packet += data_bytes

    # Build ToRadio message (field 1 = packet)
    to_radio = bytearray()
    to_radio += encode_varint((1 << 3) | 2)  # field 1, length-delimited
    to_radio += encode_varint(len(packet))
    to_radio += packet

    url = f"{DEVICE_URL}/api/v1/toradio"
    try:
        resp = requests.put(url, data=bytes(to_radio),
                           headers={'Content-Type': 'application/x-protobuf'},
                           timeout=10)
        return resp.status_code == 200
    except requests.exceptions.RequestException as e:
        state['error'] = str(e)
        return False


def poll_loop():
    """Background polling loop."""
    while True:
        try:
            result = poll_from_radio()
            with state_lock:
                state['connected'] = result
                state['last_poll'] = time.time()
                if result:
                    state['error'] = None
        except Exception as e:
            with state_lock:
                state['error'] = str(e)
                state['connected'] = False
        time.sleep(POLL_INTERVAL)


# --- HTTP SERVER ---
class MeshtasticProxyHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Silence logs

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

    def handle_api(self, parsed):
        if parsed.path == '/api/status':
            self.send_json({
                'connected': state['connected'],
                'device_url': DEVICE_URL,
                'device_info': state['device_info'],
                'last_poll': state['last_poll'],
                'error': state['error'],
                'node_count': len(state['nodes']),
                'message_count': len(state['messages']),
            })
        elif parsed.path == '/api/nodes':
            with state_lock:
                nodes = []
                for node_id, info in state['nodes'].items():
                    node = dict(info)
                    node['id'] = node_id
                    # Attach telemetry if available
                    if node_id in state['telemetry']:
                        node['telemetry'] = state['telemetry'][node_id]
                    if node_id in state['positions']:
                        node['position'] = state['positions'][node_id]
                    nodes.append(node)
                # Sort: known names first, then by last heard
                nodes.sort(key=lambda n: (
                    n.get('long_name', '') == '',
                    -(n.get('last_heard', 0))
                ))
            self.send_json({'nodes': nodes})
        elif parsed.path == '/api/messages':
            with state_lock:
                messages = list(state['messages'])
            self.send_json({
                'messages': messages,
                'device_url': DEVICE_URL,
            })
        elif parsed.path == '/api/telemetry':
            with state_lock:
                telemetry = dict(state['telemetry'])
            self.send_json({'telemetry': telemetry})
        elif parsed.path == '/api/positions':
            with state_lock:
                positions = dict(state['positions'])
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

            dest_int = None
            if dest and dest.startswith('!'):
                try:
                    dest_int = int(dest[1:], 16)
                except ValueError:
                    pass

            success = send_text_message(text, channel, dest_int)
            if success:
                self.send_json({'ok': True})
            else:
                self.send_json({'ok': False, 'error': state.get('error', 'Send failed')}, 500)
        except json.JSONDecodeError:
            self.send_json({'ok': False, 'error': 'Invalid JSON'}, 400)
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)}, 500)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)


def main():
    # Start polling thread
    poller = threading.Thread(target=poll_loop, daemon=True)
    poller.start()
    print(f"[*] Meshtastic Kindle Client server on port {PORT}")
    print(f"[*] Device URL: {DEVICE_URL}")
    print(f"[*] Poll interval: {POLL_INTERVAL}s")

    server = http.server.HTTPServer(('0.0.0.0', PORT), MeshtasticProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
