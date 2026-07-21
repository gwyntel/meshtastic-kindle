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
import socket
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
PORTNUM_POSITION = 3
PORTNUM_TELEMETRY = 67  # TELEMETRY_APP, not 10
PORTNUM_ADMIN = 100

# MeshPacket field numbers (from mesh.proto)
PKT_FIELD_FROM = 1  # node id (uint32)
PKT_FIELD_TO = 2    # node id (uint32)
PKT_FIELD_CHANNEL = 3  # channel index (uint32)
PKT_FIELD_DECODED = 4  # bytes (Data sub-message, was "decrypted")
PKT_FIELD_ID = 5    # packet id (uint32)
PKT_FIELD_RX_TIME = 9  # rx time (uint32)
PKT_FIELD_HOP_LIMIT = 10  # hop limit (uint32)
PKT_FIELD_PRIORITY = 11  # priority (uint32)

# Data sub-message field numbers (from mesh.proto, inside MeshPacket.decoded)
DATA_FIELD_PORTNUM = 1  # enum (was incorrectly 6)
DATA_FIELD_PAYLOAD = 2  # bytes (was incorrectly 7)

# FromRadio field numbers (from mesh.proto)
# NOTE: These are DIFFERENT from what was originally coded!
FROMRADIO_FIELD_ID = 1                # uint32 (FIFO tracking)
FROMRADIO_FIELD_PACKET = 2            # MeshPacket (was 1)
FROMRADIO_FIELD_MY_INFO = 3           # MyNodeInfo (was 2)
FROMRADIO_FIELD_NODE_INFO = 4         # NodeInfo (was 3)
FROMRADIO_FIELD_CONFIG = 5           # Config (was 5, was labeled telemetry)
FROMRADIO_FIELD_LOG_RECORD = 6        # LogRecord (was 6, was labeled position)
FROMRADIO_FIELD_CONFIG_COMPLETE_ID = 7  # uint32 (was 7, was labeled metadata)
FROMRADIO_FIELD_REBOOTED = 8          # bool
FROMRADIO_FIELD_MODULE_CONFIG = 9     # ModuleConfig
FROMRADIO_FIELD_CHANNEL = 10          # Channel
FROMRADIO_FIELD_METADATA = 13         # DeviceMetadata (was missing)

# ToRadio field numbers
TORADIO_FIELD_PACKET = 1             # MeshPacket
TORADIO_FIELD_WANT_CONFIG = 2        # uint32 — triggers config dump

# Service info field numbers (NodeInfo / User)
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


def _parse_device_url():
    """Parse DEVICE_URL into (host, port)."""
    from urllib.parse import urlparse
    parsed = urlparse(DEVICE_URL)
    host = parsed.hostname or 'meshtastic.local'
    port = parsed.port or 80
    return host, port


# Meshtastic StreamAPI TCP framing:
# Byte 0-1: magic 0x94 0xC3
# Byte 2-3: payload length (big-endian / network byte order)
# Byte 4+: protobuf payload
TCP_MAGIC = b'\x94\xc3'


# Persistent TCP connection to the radio
_tcp_socket = None
_tcp_lock = threading.Lock()


def _get_tcp_connection():
    """Get or create a persistent TCP connection to the Meshtastic device."""
    global _tcp_socket
    if _tcp_socket is not None:
        try:
            _tcp_socket.getpeername()
            return _tcp_socket
        except:
            _tcp_socket = None

    host, port = _parse_device_url()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect((host, port))
    _tcp_socket = s
    return s


def _read_tcp_frames(sock, timeout=5):
    """Read StreamAPI-framed Meshtastic data from a persistent connection.
    Each frame: magic(2) + big-endian-length(2) + protobuf payload.
    Returns list of payload_bytes."""
    frames = []
    sock.settimeout(timeout)

    try:
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            # Parse all frames from buffer
            buf = chunk
            pos = 0
            while pos < len(buf) - 3:
                if buf[pos:pos+2] == TCP_MAGIC:
                    # 2-byte big-endian length at pos+2
                    length = struct.unpack('>H', buf[pos+2:pos+4])[0]
                    payload_start = pos + 4
                    if payload_start + length <= len(buf):
                        payload = buf[payload_start:payload_start+length]
                        frames.append(payload)
                        pos = payload_start + length
                    else:
                        break
                else:
                    pos += 1
            # Check for non-framed data (HTTP response or raw protobuf)
            if not frames and buf:
                if buf[:4] == b'HTTP':
                    hdr_end = buf.find(b'\r\n\r\n')
                    if hdr_end != -1:
                        frames.append(buf[hdr_end+4:])
                else:
                    frames.append(buf)
            break
    except socket.timeout:
        pass

    return frames


def _raw_tcp_request(path, method='GET', body=None, timeout=5):
    """Legacy fallback — connect, send HTTP request, read one TCP frame.
    Most devices should use the persistent connection via _get_tcp_connection."""
    import socket
    host, port = _parse_device_url()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        # Send HTTP-style request line — the device uses it as a trigger
        req = f'{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n'
        if body is not None:
            req_bytes = req.encode('utf-8') + body
        else:
            req_bytes = req.encode('utf-8')
        s.sendall(req_bytes)

        # Read all available data
        data = b''
        while True:
            try:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
            except socket.timeout:
                break
        s.close()

        if not data:
            return 200, b''

        # Check for TCP framing magic (0x94 0xc3)
        if data[:2] == TCP_MAGIC:
            # Strip framing: magic(2) + big-endian-length(2) + payload
            length = struct.unpack('>H', data[2:4])[0]
            payload = data[4:4+length]
            return 200, payload

        # Check for HTTP response
        if data[:4] == b'HTTP':
            header_end = data.find(b'\r\n\r\n')
            if header_end != -1:
                status_line = data[:data.find(b'\r\n')].decode('ascii', errors='replace')
                status_code = int(status_line.split(' ')[1]) if ' ' in status_line else 200
                return status_code, data[header_end+4:]
            return 200, data

        # Raw protobuf (no framing)
        return 200, data
    except socket.error:
        try:
            s.close()
        except:
            pass
        raise


def poll_from_radio():
    """Poll the Meshtastic device for new data.
    Tries HTTP API first, then falls back to TCP stream protocol.
    For TCP devices, maintains a persistent connection and sends want_config
    to request full device state."""
    global _tcp_socket
    # Try standard HTTP first (ESP32 HTTP API)
    url = f"{DEVICE_URL}/api/v1/fromradio?all=true"
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.content
            if data and len(data) > 0:
                parse_from_radio_data(data)
            return True
        return False
    except (requests.exceptions.RequestException, Exception):
        pass

    # Fallback: TCP stream protocol (meshtasticd)
    try:
        with _tcp_lock:
            sock = _get_tcp_connection()
            # Send want_config to request full state
            # ToRadio field 2 (want_config_response) = varint 1
            want_config = encode_varint((TORADIO_FIELD_WANT_CONFIG << 3) | 0) + encode_varint(1)
            # StreamAPI frame: magic(2) + big-endian-length(2) + payload
            frame = TCP_MAGIC + struct.pack('>H', len(want_config)) + want_config
            try:
                sock.sendall(frame)
            except (socket.error, BrokenPipeError):
                # Reconnect
                _tcp_socket = None
                sock = _get_tcp_connection()
                sock.sendall(frame)

            # Read response frames
            frames = _read_tcp_frames(sock, timeout=5)
            for payload in frames:
                if payload:
                    parse_from_radio_data(payload)
            return len(frames) > 0
    except Exception as e:
        state['error'] = str(e)
        _tcp_socket = None
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

            # field 1 = id (uint32, FIFO tracking — skip)
            # field 2 = packet (MeshPacket) — THIS is where packets live
            if field_number == FROMRADIO_FIELD_PACKET:
                parse_mesh_packet(msg_data)
            # field 3 = my_info (MyNodeInfo)
            elif field_number == FROMRADIO_FIELD_MY_INFO:
                parse_my_info(msg_data)
            # field 4 = node_info (NodeInfo)
            elif field_number == FROMRADIO_FIELD_NODE_INFO:
                parse_node_info(msg_data)
            # field 5 = config
            elif field_number == FROMRADIO_FIELD_CONFIG:
                pass
            # field 7 = config_complete_id (uint32)
            elif field_number == FROMRADIO_FIELD_CONFIG_COMPLETE_ID:
                pass
            # field 13 = metadata (DeviceMetadata)
            elif field_number == FROMRADIO_FIELD_METADATA:
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
            'rx_time': get_field_value(fields, PKT_FIELD_RX_TIME),
            'hop_limit': get_field_value(fields, PKT_FIELD_HOP_LIMIT),
            'timestamp': time.time(),
        }

        # Decoded payload (field 4 = Data sub-message)
        decoded = get_field_value(fields, PKT_FIELD_DECODED)
        portnum = None
        payload_bytes = None

        if isinstance(decoded, bytes):
            sub_fields = parse_protobuf_fields(decoded)
            portnum = get_field_value(sub_fields, DATA_FIELD_PORTNUM)
            payload_bytes = get_field_value(sub_fields, DATA_FIELD_PAYLOAD)

        if portnum == PORTNUM_TEXT_MESSAGE and payload_bytes:
            text = safe_str(payload_bytes)
            packet['text'] = text
            packet['type'] = 'text'
            state['messages'].append(packet)
            # Keep only last 200 messages
            if len(state['messages']) > 200:
                state['messages'] = state['messages'][-200:]

        elif portnum == PORTNUM_TELEMETRY and payload_bytes:
            parse_telemetry(payload_bytes)

        elif portnum == PORTNUM_POSITION and payload_bytes:
            parse_position_msg(payload_bytes)

        elif portnum == PORTNUM_NODEINFO and payload_bytes:
            parse_node_info(payload_bytes)


def parse_my_info(data):
    """Parse a MyNodeInfo protobuf message (device self-info)."""
    fields = parse_protobuf_fields(data)
    with state_lock:
        node_num = get_field_value(fields, 1)
        if node_num is not None:
            # Field 1 in MyNodeInfo is my_node_num (uint32, but might be 32-bit fixed)
            if isinstance(node_num, float):
                node_num = int(node_num)
            state['device_info']['node_num'] = node_num
            state['device_info']['node_id'] = '!%08x' % node_num if isinstance(node_num, int) else None
        # Field 4 = channel_settings (count or list)
        # Field 9 = hw_model (enum)
        hw_model = get_field_value(fields, 9)
        if hw_model is not None:
            state['device_info']['hw_model'] = int(hw_model) if not isinstance(hw_model, int) else hw_model
        # Field 11 = firmware_version
        fw = get_field_value(fields, 11)
        if isinstance(fw, bytes):
            state['device_info']['firmware'] = safe_str(fw)


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
    data_bytes += encode_varint((DATA_FIELD_PORTNUM << 3) | 0)  # Data field 1 (portnum)
    data_bytes += encode_varint(PORTNUM_TEXT_MESSAGE)

    # Payload (Data field 2, length-delimited)
    payload = text.encode('utf-8')
    data_bytes += encode_varint((DATA_FIELD_PAYLOAD << 3) | 2)
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

    # Decoded Data payload (field 4, length-delimited)
    packet += encode_varint((PKT_FIELD_DECODED << 3) | 2)
    packet += encode_varint(len(data_bytes))
    packet += data_bytes

    # Build ToRadio message (field 1 = packet)
    to_radio = bytearray()
    to_radio += encode_varint((TORADIO_FIELD_PACKET << 3) | 2)  # field 1, length-delimited
    to_radio += encode_varint(len(packet))
    to_radio += packet

    # Try standard HTTP first
    url = f"{DEVICE_URL}/api/v1/toradio"
    try:
        resp = requests.put(url, data=bytes(to_radio),
                           headers={'Content-Type': 'application/x-protobuf'},
                           timeout=5)
        if resp.status_code == 200:
            return True
    except (requests.exceptions.RequestException, Exception):
        pass
    # Fallback: TCP stream protocol (meshtasticd)
    global _tcp_socket
    try:
        with _tcp_lock:
            sock = _get_tcp_connection()
            # StreamAPI frame: magic(2) + big-endian-length(2) + payload
            frame = TCP_MAGIC + struct.pack('>H', len(to_radio)) + bytes(to_radio)
            try:
                sock.sendall(frame)
            except (socket.error, BrokenPipeError):
                _tcp_socket = None
                sock = _get_tcp_connection()
                sock.sendall(frame)
            return True
    except Exception as e:
        state['error'] = str(e)
        _tcp_socket = None
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
