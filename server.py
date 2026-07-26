#!/usr/bin/env python3
"""
Meshtastic Kindle Client — Proxy Server v3

Persistent radio connection via meshtastic TCPInterface + pubsub.
Caches nodes, channels, and messages in SQLite for durability across restarts.
Exposes JSON API for the Kindle e-ink browser frontend.
"""

import http.server
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from pathlib import Path

try:
    from meshtastic.tcp_interface import TCPInterface
    from pubsub import pub
except ImportError:
    print("[!] Install: pip install meshtastic", file=sys.stderr)
    sys.exit(1)

# --- MONKEY-PATCH: Firmware 2.7+ compatibility for node_info "num"→"id" ---
# Newer Meshtastic firmware sends "id" ("!c1fc9198") in nodeInfo instead of "num" (int).
# This patches the protobuf→dict conversion so the meshtastic library always sees "num".
# Lives here (not in the library) so it survives `pip install --upgrade meshtastic`.
import google.protobuf.json_format as _pb_json
_real_msg_to_dict = _pb_json.MessageToDict

def _patched_msg_to_dict(message, **kwargs):
    d = _real_msg_to_dict(message, **kwargs)
    ni = d.get("nodeInfo")
    if ni and "num" not in ni:
        # Firmware 2.7+: "num" field removed from nodeInfo protobuf.
        # Reconstruct from user.id ("!c1fc9198" → 3254555032).
        userId = ni.get("user", {}).get("id", "")
        if userId and isinstance(userId, str) and userId.startswith("!"):
            try:
                ni["num"] = int(userId[1:], 16)
            except ValueError:
                pass
    return d

_pb_json.MessageToDict = _patched_msg_to_dict

# --- CONFIG ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8645
DEVICE_URL = os.environ.get("MESHTASTIC_URL", "http://meshtastic.local")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5.0"))
DB_PATH = os.environ.get("MESHTASTIC_DB", str(Path(__file__).parent / "mesh.db"))
MSG_RETENTION = int(os.environ.get("MSG_RETENTION", "500"))

ROLE_NAMES = {0: "DISABLED", 1: "PRIMARY", 2: "SECONDARY"}

HW_MODELS = {
    0: "UNSET", 1: "TLORA_V2", 2: "TLORA_V1", 3: "TLORA_V2_1_1P6",
    4: "TBEAM", 5: "HELTEC_V2_0", 6: "TBEAM_V0P7", 7: "T_ECHO",
    8: "LILYGO_TBEAM_S3_CORE", 9: "RAK4631", 10: "HELTEC_V3",
    11: "HELTEC_V1", 14: "HELTEC_WIRELESS_TRACKER",
    15: "LILYGO_TBEAM_V1P1", 16: "STATION_G1", 18: "PORTDUINO",
    21: "HELTEC_WIRELESS_PAPER", 23: "T_DECK", 24: "T_WATCH",
    25: "PICOMPUTER_S3", 28: "HELTEC_BRIEF",
    31: "WIPHONE", 32: "HELTEC_HT62", 33: "SEEED_XIAO_S3",
    35: "TRACKER_T1000_E", 39: "HELTEC_MESH_NODE_T114",
    40: "CROWPANEL", 49: "M5STACK_CORE2",
    254: "PRIVATE_HW",
}


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


# --- SQLITE ---
def init_db():
    db = sqlite3.connect(DB_PATH, check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_from TEXT NOT NULL,
            msg_to TEXT,
            channel INTEGER DEFAULT 0,
            text TEXT,
            timestamp REAL NOT NULL,
            via_mqtt INTEGER DEFAULT 0,
            hops_taken INTEGER,
            snr REAL,
            is_own INTEGER DEFAULT 0,
            relay_node TEXT,
            packet_id TEXT UNIQUE
        )
    """)
    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_msg_timestamp ON messages(timestamp)
    """)
    db.commit()
    return db


def save_message(db, msg):
    try:
        db.execute("""
            INSERT OR IGNORE INTO messages
            (msg_from, msg_to, channel, text, timestamp, via_mqtt,
             hops_taken, snr, is_own, relay_node, packet_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            msg["from"], msg.get("to"), msg.get("channel", 0),
            msg.get("text", ""), msg.get("timestamp", time.time()),
            1 if msg.get("via_mqtt") else 0,
            msg.get("hops_taken"), msg.get("snr"),
            1 if msg.get("is_own") else 0,
            msg.get("relay_node"),
            msg.get("packet_id"),
        ))
        db.commit()
    except Exception:
        pass


def get_messages_since(db, since_ts, limit=100):
    rows = db.execute("""
        SELECT msg_from, msg_to, channel, text, timestamp, via_mqtt,
               hops_taken, snr, is_own, relay_node, packet_id
        FROM messages
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT ?
    """, (since_ts, limit)).fetchall()

    messages = []
    for row in rows:
        messages.append({
            "from": row[0], "to": row[1], "channel": row[2],
            "text": row[3], "timestamp": row[4],
            "via_mqtt": bool(row[5]), "hops_taken": row[6],
            "snr": row[7], "is_own": bool(row[8]),
            "relay_node": row[9], "packet_id": row[10],
        })
    return messages


def get_messages_before(db, before_ts, limit=100):
    """Get messages OLDER than before_ts (backward pagination)."""
    rows = db.execute("""
        SELECT msg_from, msg_to, channel, text, timestamp, via_mqtt,
               hops_taken, snr, is_own, relay_node, packet_id
        FROM messages
        WHERE timestamp < ?
        ORDER BY timestamp DESC
        LIMIT ?
    """, (before_ts, limit)).fetchall()

    messages = []
    for row in rows:
        messages.append({
            "from": row[0], "to": row[1], "channel": row[2],
            "text": row[3], "timestamp": row[4],
            "via_mqtt": bool(row[5]), "hops_taken": row[6],
            "snr": row[7], "is_own": bool(row[8]),
            "relay_node": row[9], "packet_id": row[10],
        })
    # Return ascending so frontend appends in order
    messages.reverse()
    return messages


def cleanup_old_messages(db, retention):
    db.execute("""
        DELETE FROM messages WHERE id NOT IN (
            SELECT id FROM messages ORDER BY id DESC LIMIT ?
        )
    """, (retention,))
    db.commit()


# --- GLOBAL STATE ---
state = {"nodes": {}, "channels": {}, "device_info": {}, "net_stats": {},
         "channel_url": None, "last_poll": 0, "connected": False,
         "error": None}
state_lock = threading.Lock()
_iface = None
_iface_lock = threading.Lock()
_db = None


def on_receive(packet, interface=None):
    """pubsub callback for incoming radio packets."""
    try:
        decoded = packet.get("decoded", {})
        portnum = decoded.get("portnum", "")
        payload = decoded.get("payload", b"")
        from_id = packet.get("from")
        to_id = packet.get("to")
        channel = packet.get("channel", 0)
        rx_time = packet.get("rxTime", packet.get("rx_time", 0))
        via_mqtt = packet.get("viaMqtt", False)
        hop_limit = packet.get("hopLimit")
        hop_start = packet.get("hopStart")
        rx_snr = packet.get("rxSnr")
        relay_node = packet.get("relayNode")

        if not from_id:
            return

        from_hex = "!%08x" % from_id if isinstance(from_id, int) else str(from_id)
        hops_taken = None
        if hop_start is not None and hop_limit is not None:
            hops_taken = hop_start - hop_limit

        if portnum == "TEXT_MESSAGE_APP":
            text = ""
            if isinstance(payload, bytes):
                text = payload.decode("utf-8", errors="replace")
            elif isinstance(payload, str):
                text = payload

            device_node_num = None
            try:
                if _iface and hasattr(_iface, "getMyNodeInfo"):
                    device_node_num = _iface.getMyNodeInfo().get("num")
            except Exception:
                pass

            is_own = (from_id == device_node_num) if device_node_num and isinstance(from_id, int) else False
            pkt_id = packet.get("id")

            msg = {
                "from": from_hex,
                "to": "!%08x" % to_id if isinstance(to_id, int) else str(to_id),
                "channel": channel,
                "text": text,
                "timestamp": rx_time or int(time.time()),
                "via_mqtt": via_mqtt,
                "hops_taken": hops_taken,
                "snr": rx_snr,
                "is_own": is_own,
                "relay_node": relay_node,
                "packet_id": str(pkt_id) if pkt_id else None,
            }

            if _db:
                save_message(_db, msg)

        elif portnum == "TELEMETRY_APP":
            telemetry = decoded.get("telemetry", {})
            if telemetry:
                metrics = {}
                dm = telemetry.get("deviceMetrics", {})
                if dm:
                    if "batteryLevel" in dm:
                        metrics["battery"] = dm["batteryLevel"]
                    if "voltage" in dm:
                        metrics["voltage"] = dm["voltage"]
                    if "channelUtilization" in dm:
                        metrics["channel_util"] = dm["channelUtilization"]
                    if "airUtilTx" in dm:
                        metrics["air_util"] = dm["airUtilTx"]
                em = telemetry.get("environmentMetrics", {})
                if em:
                    if "temperature" in em:
                        metrics["temp"] = em["temperature"]
                    if "relativeHumidity" in em:
                        metrics["humidity"] = em["relativeHumidity"]
                if metrics:
                    with state_lock:
                        n = state["nodes"].get(from_hex, {})
                        n["telemetry"] = metrics
                        state["nodes"][from_hex] = n

        elif portnum == "POSITION_APP":
            pos_data = decoded.get("position", {})
            if pos_data:
                pos = {}
                if "latitude" in pos_data:
                    pos["lat"] = pos_data["latitude"]
                elif "latitudeI" in pos_data:
                    pos["lat"] = pos_data["latitudeI"] * 1e-7
                if "longitude" in pos_data:
                    pos["lon"] = pos_data["longitude"]
                elif "longitudeI" in pos_data:
                    pos["lon"] = pos_data["longitudeI"] * 1e-7
                if "altitude" in pos_data:
                    pos["alt"] = pos_data["altitude"]
                if pos:
                    with state_lock:
                        n = state["nodes"].get(from_hex, {})
                        n["position"] = pos
                        state["nodes"][from_hex] = n

    except Exception as e:
        print(f"[!] on_receive error: {e}", file=sys.stderr)


def sync_state_from_iface(iface):
    """Pull current state from the meshtastic interface."""
    nodes = {}
    if iface.nodes:
        for node_id, nodeinfo in iface.nodes.items():
            if not isinstance(nodeinfo, dict):
                continue
            user = nodeinfo.get("user", {}) if isinstance(nodeinfo, dict) else {}
            position = nodeinfo.get("position", {}) if isinstance(nodeinfo, dict) else {}
            metrics = nodeinfo.get("deviceMetrics", {}) if isinstance(nodeinfo, dict) else {}

            node = {
                "id": node_id,
                "long_name": user.get("longName", ""),
                "short_name": user.get("shortName", ""),
                "role": user.get("role", ""),
                "hw_model": user.get("hwModel", ""),
                "last_heard": nodeinfo.get("lastHeard", 0),
                "snr": nodeinfo.get("snr"),
                "hops_away": nodeinfo.get("hopsAway"),
                "via_mqtt": nodeinfo.get("viaMqtt", False),
                "is_favorite": nodeinfo.get("isFavorite", False),
            }

            if position:
                if "latitude" in position:
                    node["position"] = {"lat": position["latitude"],
                                        "lon": position["longitude"],
                                        "alt": position.get("altitude")}
                elif "latitudeI" in position:
                    node["position"] = {"lat": position["latitudeI"] * 1e-7,
                                        "lon": position["longitudeI"] * 1e-7,
                                        "alt": position.get("altitude")}

            telem = {}
            if metrics:
                for k in ("batteryLevel", "voltage", "channelUtilization", "airUtilTx"):
                    v = metrics.get(k)
                    if v is not None:
                        telem[k.replace("batteryLevel", "battery")
                                .replace("channelUtilization", "channel_util")
                                .replace("airUtilTx", "air_util")] = v

            env = nodeinfo.get("environmentMetrics", {}) if isinstance(nodeinfo, dict) else {}
            if env:
                if "temperature" in env:
                    telem["temp"] = env["temperature"]
                if "relativeHumidity" in env:
                    telem["humidity"] = env["relativeHumidity"]
                if "barometricPressure" in env:
                    telem["pressure"] = env["barometricPressure"]

            with state_lock:
                existing = state["nodes"].get(node_id, {})
                for ek in ("temp", "humidity", "pressure"):
                    if ek in existing.get("telemetry", {}) and ek not in telem:
                        telem[ek] = existing["telemetry"][ek]

            if telem:
                node["telemetry"] = telem

            if metrics and metrics.get("uptimeSeconds"):
                node["uptime"] = metrics["uptimeSeconds"]

            with state_lock:
                existing = state["nodes"].get(node_id, {})
                if "telemetry" not in node and "telemetry" in existing:
                    node["telemetry"] = existing["telemetry"]
                if "position" not in node and "position" in existing:
                    node["position"] = existing["position"]

            nodes[node_id] = node

    channels = {}
    if hasattr(iface, "_localChannels"):
        for ch in iface._localChannels:
            idx = ch.index
            name = ""
            role = ROLE_NAMES.get(ch.role, "UNKNOWN")
            uplink = downlink = False
            if ch.HasField("settings"):
                s = ch.settings
                name = s.name if s.name else f"ch{idx}"
                uplink = s.uplink_enabled
                downlink = s.downlink_enabled
            if not name:
                name = f"ch{idx}"
            channels[idx] = {"index": idx, "name": name, "role": role,
                             "uplink_enabled": uplink, "downlink_enabled": downlink}

    device_info = {}
    try:
        my_info = iface.getMyNodeInfo()
        if my_info:
            user = my_info.get("user", {})
            device_info = {
                "node_id": user.get("id", ""),
                "long_name": user.get("longName", ""),
                "short_name": user.get("shortName", ""),
                "hw_model": user.get("hwModel", ""),
                "role": user.get("role", ""),
                "node_num": my_info.get("num"),
            }
    except Exception:
        pass

    try:
        if hasattr(iface, "metadata") and iface.metadata:
            m = iface.metadata
            device_info["firmware"] = (m.firmware_version
                                       if hasattr(m, "firmware_version")
                                       else str(getattr(m, "firmwareVersion", "")))
    except Exception:
        pass

    net_stats = {}
    try:
        my_info = iface.getMyNodeInfo()
        if my_info:
            ls = my_info.get("localStats", {})
            if ls:
                net_stats = {
                    "num_online": ls.get("numOnlineNodes"),
                    "num_total": ls.get("numTotalNodes"),
                    "packets_tx": ls.get("numPacketsTx"),
                    "packets_rx": ls.get("numPacketsRx"),
                    "packets_rx_bad": ls.get("numPacketsRxBad"),
                    "noise_floor": ls.get("noiseFloor"),
                    "heap_free": ls.get("heapFreeBytes"),
                    "heap_total": ls.get("heapTotalBytes"),
                }
    except Exception:
        pass

    channel_url = None
    try:
        if hasattr(iface, "localNode") and iface.localNode:
            channel_url = iface.localNode.getURL(includeAll=False)
    except Exception:
        pass

    with state_lock:
        state["nodes"] = nodes
        state["channels"] = channels
        state["device_info"] = device_info
        state["net_stats"] = net_stats
        state["channel_url"] = channel_url


def connect_to_radio():
    """Connect to meshtastic device via TCPInterface."""
    global _iface
    host, port = _parse_device_url()
    try:
        iface = TCPInterface(hostname=host, portNumber=port,
                             connectNow=True, timeout=30)
        pub.subscribe(on_receive, "meshtastic.receive")
        iface.waitForConfig()
        _iface = iface
        return True
    except Exception as e:
        print(f"[!] Connection error: {e}", file=sys.stderr)
        _iface = None
        return False


def poll_loop():
    """Background polling: connect, sync, reconnect with backoff."""
    global _iface
    backoff = 1

    while True:
        try:
            if _iface is None:
                connected = connect_to_radio()
                with state_lock:
                    state["connected"] = connected
                    state["last_poll"] = time.time()
                    state["error"] = None if connected else "Could not connect"
                if connected:
                    backoff = 1
                else:
                    time.sleep(min(backoff, 30))
                    backoff = min(backoff * 2, 60)
                    continue

            sync_state_from_iface(_iface)
            _iface.sendHeartbeat()

            with state_lock:
                state["connected"] = True
                state["last_poll"] = time.time()
                state["error"] = None

            if _db:
                cleanup_old_messages(_db, MSG_RETENTION)

        except Exception as e:
            print(f"[!] Poll error: {e}", file=sys.stderr)
            with state_lock:
                state["connected"] = False
                state["error"] = str(e)
            try:
                if _iface:
                    _iface.close()
            except Exception:
                pass
            _iface = None
            backoff = min(backoff * 2, 60)

        time.sleep(POLL_INTERVAL)


# --- HTTP SERVER ---
class MeshtasticProxyHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        static_routes = {
            "/": ("index.html", "text/html"),
            "/manifest.json": ("manifest.json", "application/json"),
            "/sw.js": ("sw.js", "application/javascript"),
            "/style.css": ("style.css", "text/css"),
            "/app.js": ("app.js", "application/javascript"),
            "/NotoEmoji.ttf": ("NotoEmoji.ttf", "application/x-font-ttf"),
        }

        if parsed.path in static_routes:
            fname, ctype = static_routes[parsed.path]
            self._serve_file(fname, ctype)

        elif parsed.path.startswith("/emoji/"):
            fname = parsed.path.split("/")[-1]
            if fname.endswith(".png") and all(c.isalnum() or c == "." for c in fname):
                emoji_path = Path(__file__).parent / "emoji" / fname
                if emoji_path.exists():
                    self._serve_file("emoji/" + fname, "image/png")
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)

        elif parsed.path.startswith("/api/"):
            self._handle_api_get(parsed)

        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/send":
            self._handle_send()
        elif parsed.path == "/api/favorite":
            self._handle_favorite()
        elif parsed.path.startswith("/api/admin/"):
            action = parsed.path.split("/")[-1]
            self._handle_admin(action)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _serve_file(self, filename, content_type):
        filepath = Path(__file__).parent / filename
        if filepath.exists():
            content = filepath.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _handle_api_get(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/status":
            with state_lock:
                self._send_json({
                    "connected": state["connected"],
                    "device_info": state["device_info"],
                    "net_stats": state.get("net_stats", {}),
                    "channel_url": state.get("channel_url"),
                    "last_poll": state["last_poll"],
                    "error": state["error"],
                    "node_count": len(state["nodes"]),
                    "message_count": 0,
                    "channel_count": len(state["channels"]),
                    "server_time": time.time(),
                })

        elif parsed.path == "/api/nodes":
            with state_lock:
                all_nodes = list(state["nodes"].values())
            all_nodes.sort(key=lambda n: (
                n.get("long_name", "") == "",
                -(n.get("last_heard", 0) or 0),
            ))
            # Pagination params
            try:
                node_limit = min(max(int(qs.get("limit", [0])[0]), 0), 500)
            except (ValueError, IndexError):
                node_limit = 0
            try:
                node_offset = max(int(qs.get("offset", [0])[0]), 0)
            except (ValueError, IndexError):
                node_offset = 0

            if node_limit > 0:
                nodes = all_nodes[node_offset:node_offset + node_limit]
            else:
                nodes = all_nodes

            self._send_json({
                "nodes": nodes,
                "total": len(all_nodes),
                "offset": node_offset,
                "limit": node_limit or len(all_nodes),
            })

        elif parsed.path == "/api/messages":
            # Forward pagination: ?since=<ts>&limit=<n>
            # Backward pagination: ?before=<ts>&limit=<n>
            since = None
            before = None
            try:
                msg_limit = min(max(int(qs.get("limit", [200])[0]), 1), 500)
            except (ValueError, IndexError):
                msg_limit = 200
            if "since" in qs:
                try:
                    since = float(qs["since"][0])
                except (ValueError, IndexError):
                    pass
            if "before" in qs:
                try:
                    before = float(qs["before"][0])
                except (ValueError, IndexError):
                    pass

            if _db and before is not None:
                messages = get_messages_before(_db, before, limit=msg_limit)
            elif _db and since is not None:
                messages = get_messages_since(_db, since, limit=msg_limit)
            elif _db:
                messages = get_messages_since(_db, 0, limit=msg_limit)
            else:
                messages = []

            self._send_json({
                "messages": messages,
                "server_time": time.time(),
                "count": len(messages),
            })

        elif parsed.path == "/api/channels":
            with state_lock:
                channels = sorted(state["channels"].values(),
                                  key=lambda c: c.get("index", 0))
            self._send_json({"channels": channels})

        elif parsed.path == "/api/telemetry":
            with state_lock:
                telemetry = {nid: n["telemetry"]
                             for nid, n in state["nodes"].items()
                             if "telemetry" in n}
            self._send_json({"telemetry": telemetry})

        elif parsed.path == "/api/positions":
            with state_lock:
                positions = {nid: n["position"]
                             for nid, n in state["nodes"].items()
                             if "position" in n}
            self._send_json({"positions": positions})

        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _handle_send(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
            text = data.get("text", "").strip()
            channel = int(data.get("channel", 0))
            dest = data.get("dest_node")

            if not text:
                self._send_json({"ok": False, "error": "No text"}, 400)
                return
            if len(text) > 200:
                self._send_json({"ok": False, "error": "Max 200 chars"}, 400)
                return
            if _iface is None:
                self._send_json({"ok": False, "error": "Not connected"}, 503)
                return

            dest_int = None
            if dest and dest.startswith("!"):
                try:
                    dest_int = int(dest[1:], 16)
                except ValueError:
                    pass

            if dest_int:
                _iface.sendText(text, destinationId=dest_int, channelIndex=channel)
            else:
                _iface.sendText(text, channelIndex=channel)

            # Save outgoing message to DB immediately — don't wait for loopback
            device_node_num = None
            try:
                if _iface and hasattr(_iface, "getMyNodeInfo"):
                    device_node_num = _iface.getMyNodeInfo().get("num")
            except Exception:
                pass

            from_hex = "!%08x" % device_node_num if device_node_num else "!00000000"
            msg = {
                "from": from_hex,
                "to": "!%08x" % dest_int if dest_int else "!ffffffff",
                "channel": channel,
                "text": text,
                "timestamp": time.time(),
                "via_mqtt": False,
                "hops_taken": 0,
                "snr": None,
                "is_own": True,
                "relay_node": None,
                "packet_id": None,  # No packet_id for sent messages — prevents UNIQUE conflict
            }
            if _db:
                save_message(_db, msg)

            self._send_json({"ok": True})

        except json.JSONDecodeError:
            self._send_json({"ok": False, "error": "Invalid JSON"}, 400)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _handle_favorite(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
            node_id = data.get("node_id", "")
            if not node_id or not node_id.startswith("!"):
                self._send_json({"ok": False, "error": "Invalid node_id"}, 400)
                return
            if _iface is None or _iface.localNode is None:
                self._send_json({"ok": False, "error": "Not connected"}, 503)
                return
            node_num = int(node_id[1:], 16)
            nodes = _iface.nodes or {}
            is_fav = nodes.get(node_id, {}).get("isFavorite", False)
            if is_fav:
                _iface.localNode.removeFavorite(node_num)
            else:
                _iface.localNode.setFavorite(node_num)
            self._send_json({"ok": True, "favorite": not is_fav})
        except json.JSONDecodeError:
            self._send_json({"ok": False, "error": "Invalid JSON"}, 400)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def _handle_admin(self, action):
        if _iface is None or _iface.localNode is None:
            self._send_json({"ok": False, "error": "Not connected"}, 503)
            return
        try:
            actions = {
                "reboot": lambda: _iface.localNode.reboot(),
                "shutdown": lambda: _iface.localNode.shutdown(),
                "reset-nodedb": lambda: _iface.localNode.resetNodeDb(),
                "factory-reset": lambda: _iface.localNode.factoryReset(full=False),
                "enter-dfu": lambda: _iface.localNode.enterDFUMode(),
            }
            if action in actions:
                actions[action]()
                self._send_json({"ok": True, "message": f"{action} sent"})
            else:
                self._send_json({"ok": False, "error": f"Unknown: {action}"}, 400)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)


def main():
    global _db
    _db = init_db()
    print(f"[*] DB: {DB_PATH}")

    poller = threading.Thread(target=poll_loop, daemon=True)
    poller.start()

    print(f"[*] Meshtastic Kindle Proxy v3 on :{PORT}")
    print(f"[*] Device: {DEVICE_URL}  |  Poll: {POLL_INTERVAL}s  |  Retention: {MSG_RETENTION}")

    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), MeshtasticProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
