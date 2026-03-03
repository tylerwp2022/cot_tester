#!/usr/bin/env python3
"""
tak_listener.py — TAK Server CoT Listener / WebSocket Bridge
=============================================================

PURPOSE:
    Connects to a TAK server's TCP streaming port, announces itself as a named
    contact (so other ATAK users can see it on the map and direct-message it),
    receives the live CoT stream, and re-broadcasts each message over a local
    WebSocket so a browser-based tool (index.html) can ingest and analyze them.

ARCHITECTURE:
    TAK Server TCP (8087/8089)
         │
         ▼
    tak_listener.py  ←── sends SA beacon every --beacon-interval seconds
         │
         ▼  (ws://localhost:8765)
    Browser (index.html Live Listener panel)

PROTOCOL NOTES:
    TAK server streams raw CoT XML over TCP. Messages are concatenated with no
    delimiter other than the end of each </event> tag. This script buffers the
    TCP stream and splits on </event> boundaries before forwarding to WebSocket
    clients.

    For TLS connections (port 8089 / --tls flag), the script uses ssl.create_
    default_context() with certificate verification disabled by default (common
    for self-signed TAK server certs on tactical networks). Pass --verify-cert
    to enforce certificate chain validation.

USAGE EXAMPLES:
    # Plain TCP, appear as "CoT-Bridge" on the TAK map
    python3 tak_listener.py --host 10.10.10.3 --port 8087 --callsign CoT-Bridge

    # TLS connection (TAK Server default secure port)
    python3 tak_listener.py --host 10.10.10.3 --port 8089 --tls --callsign CoT-Bridge

    # Custom WebSocket port (if 8765 is taken)
    python3 tak_listener.py --host 10.10.10.3 --port 8087 --ws-port 9000

    # Specify lat/lon so you appear at a real map location
    python3 tak_listener.py --host 10.10.10.3 --port 8087 --lat 38.8977 --lon -77.0365

    # Filter — only forward messages whose uid matches a prefix
    python3 tak_listener.py --host 10.10.10.3 --port 8087 --filter-uid warthog

DEPENDENCIES:
    pip install websockets

    Standard library only otherwise (socket, ssl, threading, asyncio, xml).

OUTPUT:
    Browser connects to ws://localhost:8765 (or --ws-port).
    Each received CoT is forwarded as a JSON object:
    {
      "type":        "cot",
      "xml":         "<event ...>...</event>",
      "received_at": "2026-01-12T16:59:14.000Z",
      "from_uid":    "ANDROID-xxxx",
      "cot_type":    "a-f-G-U-C"
    }
    Control messages:
    { "type": "status", "message": "Connected to 10.10.10.3:8087" }
    { "type": "error",  "message": "Connection lost: ..." }
    { "type": "beacon_sent", "callsign": "CoT-Bridge", "uid": "..." }
"""

import argparse
import asyncio
import json
import socket
import ssl
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from typing import Optional, Set

# =============================================================================
# OPTIONAL DEPENDENCY CHECK
# =============================================================================

try:
    import websockets
    import websockets.server
except ImportError:
    print("ERROR: 'websockets' package not found.")
    print("Install it with:  pip install websockets")
    sys.exit(1)


# =============================================================================
# GLOBAL STATE
# Thread safety note: websocket_clients is accessed from both the asyncio event
# loop (WebSocket server coroutines) and the TCP reader thread via
# asyncio.run_coroutine_threadsafe(). The set itself is only mutated inside
# the asyncio event loop, so no additional locking is needed beyond asyncio's
# single-threaded executor model.
# =============================================================================

websocket_clients: Set = set()          # connected browser WebSocket clients
ws_event_loop: Optional[asyncio.AbstractEventLoop] = None  # set at startup
args_global = None                      # parsed CLI args, set at startup


# =============================================================================
# TIMESTAMP HELPERS
# =============================================================================

def now_iso() -> str:
    """Return current UTC time in CoT ISO 8601 format: 2026-01-12T16:59:14.000Z"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def stale_iso(minutes: int = 5) -> str:
    """Return UTC time `minutes` from now in CoT ISO 8601 format."""
    dt = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


# =============================================================================
# SA BEACON BUILDER
# The beacon is sent immediately on connect and then every --beacon-interval
# seconds so this listener appears as a live contact on all ATAK maps.
# =============================================================================

def build_sa_beacon(callsign: str, uid: str, lat: float, lon: float,
                    team_color: str = "Cyan", role: str = "Team Member") -> str:
    """
    Build a Situational Awareness beacon CoT XML string.

    The beacon causes this listener to appear on the TAK map as a friendly
    ground infantry icon with the given callsign. Other ATAK users can then
    direct-message this contact and see it move if lat/lon updates are sent.

    Args:
        callsign:   Display name shown on the ATAK map
        uid:        Stable unique ID for this entity (generated once at startup)
        lat:        Latitude (0.0 if unknown — will appear at null island)
        lon:        Longitude
        team_color: ATAK team color (Cyan, Blue, Red, Green, Yellow, White, etc.)
        role:       ATAK role string

    Returns:
        CoT XML string ready to write to the TCP socket.
    """
    t = now_iso()
    s = stale_iso(5)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<event version="2.0" uid="{uid}" type="a-f-G-U-C" '
        f'time="{t}" start="{t}" stale="{s}" how="m-g" access="Undefined">'
        f'<point lat="{lat:.7f}" lon="{lon:.7f}" hae="0.0" ce="9999999.0" le="9999999.0"/>'
        f'<detail>'
        f'<takv device="tak-listener-bridge" platform="python-tak-listener" '
        f'os="Linux" version="1.0.0"/>'
        f'<contact callsign="{callsign}" endpoint="*:-1:stcp"/>'
        f'<__group name="{team_color}" role="{role}"/>'
        f'<uid Droid="{callsign}"/>'
        f'<status battery="100"/>'
        f'</detail>'
        f'</event>\n'
    )


# =============================================================================
# WEBSOCKET SERVER
# Runs in the asyncio event loop. Manages connected browser clients and
# provides a broadcast helper used by the TCP reader thread.
# =============================================================================

async def ws_handler(websocket):
    """
    Handle a new WebSocket connection from the browser.
    Registers the client, sends a welcome status message, and waits until
    the connection closes (the actual CoT forwarding happens via broadcast()).
    """
    global websocket_clients
    websocket_clients.add(websocket)
    client_addr = websocket.remote_address
    print(f"[WS] Browser connected: {client_addr}  (total: {len(websocket_clients)})")

    # Send initial status so the browser knows the WS is live
    await websocket.send(json.dumps({
        "type": "status",
        "message": f"WebSocket connected. Listening for CoT from TAK server..."
    }))

    try:
        # Keep connection open — we drive messages from the TAK TCP thread,
        # not from browser messages (browser is read-only in this direction)
        async for _ in websocket:
            pass  # ignore any incoming browser messages
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        websocket_clients.discard(websocket)
        print(f"[WS] Browser disconnected: {client_addr}  (total: {len(websocket_clients)})")


async def broadcast(payload: dict):
    """
    Send a JSON payload to all currently connected browser WebSocket clients.
    Silently drops clients that have disconnected since the set was last updated.
    Called from the TCP reader thread via asyncio.run_coroutine_threadsafe().
    """
    if not websocket_clients:
        return
    message = json.dumps(payload)
    # Snapshot the set to avoid mutation during iteration
    clients_snapshot = set(websocket_clients)
    await asyncio.gather(
        *(client.send(message) for client in clients_snapshot),
        return_exceptions=True   # don't let one dead client kill the broadcast
    )


def broadcast_from_thread(payload: dict):
    """
    Thread-safe wrapper: schedule broadcast() on the asyncio event loop from
    the TCP reader thread (which runs in a regular threading.Thread).
    """
    if ws_event_loop is None:
        return
    asyncio.run_coroutine_threadsafe(broadcast(payload), ws_event_loop)


async def run_ws_server(host: str, port: int):
    """Start the WebSocket server and run it until the process exits."""
    global ws_event_loop
    ws_event_loop = asyncio.get_event_loop()
    print(f"[WS] WebSocket server listening on ws://{host}:{port}")
    async with websockets.serve(ws_handler, host, port):
        await asyncio.Future()  # run forever


# =============================================================================
# COT XML STREAM PARSER
# TAK server sends raw concatenated CoT XML over TCP with no length-prefix or
# delimiter beyond the closing </event> tag. We buffer incoming bytes and split
# on that boundary.
# =============================================================================

def extract_events(buffer: str) -> tuple[list[str], str]:
    """
    Extract complete CoT <event>...</event> blocks from a string buffer.

    Returns:
        (events, remainder) where events is a list of complete XML strings
        and remainder is whatever partial data follows the last complete event.
    """
    events = []
    delimiter = "</event>"
    while delimiter in buffer:
        idx = buffer.index(delimiter) + len(delimiter)
        raw = buffer[:idx].strip()
        buffer = buffer[idx:]
        if raw:
            events.append(raw)
    return events, buffer


def parse_cot_envelope(xml_str: str) -> dict:
    """
    Extract key fields from a CoT XML string for the WebSocket payload header.
    Falls back gracefully if the XML is malformed or missing fields.

    Returns dict with: from_uid, cot_type, callsign (best-effort)
    """
    result = {"from_uid": "unknown", "cot_type": "unknown", "callsign": ""}
    try:
        root = ET.fromstring(xml_str)
        result["from_uid"] = root.get("uid", "unknown")
        result["cot_type"] = root.get("type", "unknown")
        # Try to find callsign in <detail><contact callsign="..."/>
        detail = root.find("detail")
        if detail is not None:
            contact = detail.find("contact")
            if contact is not None:
                result["callsign"] = contact.get("callsign", "")
            # Also check <uid Droid="..."> as fallback
            if not result["callsign"]:
                uid_el = detail.find("uid")
                if uid_el is not None:
                    result["callsign"] = uid_el.get("Droid", "")
    except ET.ParseError:
        pass  # malformed XML — forward it anyway so the browser can show the error
    return result


# =============================================================================
# TAK TCP CLIENT
# Runs in a daemon thread. Connects to the TAK server, sends the SA beacon,
# reads the incoming stream, and forwards each complete CoT event to the
# WebSocket broadcast queue.
# =============================================================================

def tak_tcp_reader(host: str, port: int, uid: str, callsign: str,
                   lat: float, lon: float, beacon_interval: int,
                   use_tls: bool, verify_cert: bool,
                   filter_uid_prefix: Optional[str],
                   reconnect_delay: int = 5):
    """
    Main TAK TCP reader loop. Handles connection, beacon sending, stream
    parsing, and automatic reconnection on disconnect.

    This function is designed to run in a daemon thread and loops forever,
    reconnecting after any connection failure.

    Args:
        host:               TAK server hostname or IP
        port:               TAK server TCP port (typically 8087 or 8089)
        uid:                Stable UID for this listener's SA beacon
        callsign:           Callsign shown on the ATAK map
        lat/lon:            Position for the SA beacon (0,0 = null island)
        beacon_interval:    Seconds between SA beacon re-sends (keep-alive)
        use_tls:            Wrap socket in TLS (for port 8089)
        verify_cert:        Enforce TLS certificate chain verification
        filter_uid_prefix:  If set, only forward events whose uid starts with this
        reconnect_delay:    Seconds to wait before reconnection attempt
    """
    while True:
        sock = None
        try:
            print(f"[TAK] Connecting to {host}:{port} ({'TLS' if use_tls else 'TCP'})...")
            broadcast_from_thread({
                "type": "status",
                "message": f"Connecting to {host}:{port}..."
            })

            # ── Create and optionally wrap the socket ──────────────────────────
            raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            raw_sock.settimeout(30)
            raw_sock.connect((host, port))

            if use_tls:
                ctx = ssl.create_default_context()
                if not verify_cert:
                    # Common on tactical networks with self-signed certs
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                sock = ctx.wrap_socket(raw_sock, server_hostname=host)
            else:
                sock = raw_sock

            print(f"[TAK] Connected to {host}:{port}")
            broadcast_from_thread({
                "type": "status",
                "message": f"Connected to {host}:{port} as '{callsign}' (uid: {uid})"
            })

            # ── Send initial SA beacon ─────────────────────────────────────────
            beacon = build_sa_beacon(callsign, uid, lat, lon)
            sock.sendall(beacon.encode("utf-8"))
            print(f"[TAK] SA beacon sent: callsign={callsign}, uid={uid}")
            broadcast_from_thread({
                "type": "beacon_sent",
                "callsign": callsign,
                "uid": uid,
                "lat": lat,
                "lon": lon
            })

            # ── Stream reader ──────────────────────────────────────────────────
            buffer = ""
            last_beacon_time = time.time()
            sock.settimeout(2.0)  # short timeout so beacon interval works

            while True:
                # Re-send beacon on interval (keep-alive + position update)
                if time.time() - last_beacon_time >= beacon_interval:
                    beacon = build_sa_beacon(callsign, uid, lat, lon)
                    sock.sendall(beacon.encode("utf-8"))
                    last_beacon_time = time.time()
                    print(f"[TAK] SA beacon refreshed")

                # Read available data
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    continue  # no data yet — loop back to check beacon timer
                except (ConnectionResetError, BrokenPipeError) as e:
                    raise ConnectionError(f"Connection reset: {e}")

                if not chunk:
                    raise ConnectionError("TAK server closed the connection")

                buffer += chunk.decode("utf-8", errors="replace")

                # Extract and forward complete CoT events
                events, buffer = extract_events(buffer)
                for xml_str in events:
                    envelope = parse_cot_envelope(xml_str)

                    # Apply UID prefix filter if specified
                    if filter_uid_prefix:
                        if not envelope["from_uid"].startswith(filter_uid_prefix):
                            continue

                    # Skip our own beacon echoes (TAK server echoes everything)
                    if envelope["from_uid"] == uid:
                        continue

                    print(f"[TAK] RX  type={envelope['cot_type']:30s}  "
                          f"uid={envelope['from_uid'][:40]}  "
                          f"cs={envelope['callsign']}")

                    broadcast_from_thread({
                        "type":        "cot",
                        "xml":         xml_str,
                        "received_at": now_iso(),
                        "from_uid":    envelope["from_uid"],
                        "cot_type":    envelope["cot_type"],
                        "callsign":    envelope["callsign"],
                    })

        except (ConnectionRefusedError, ConnectionError, socket.gaierror,
                OSError, ssl.SSLError) as e:
            msg = f"TAK connection error: {e}. Reconnecting in {reconnect_delay}s..."
            print(f"[TAK] {msg}")
            broadcast_from_thread({"type": "error", "message": msg})

        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

        time.sleep(reconnect_delay)


# =============================================================================
# ENTRY POINT
# =============================================================================

def parse_args():
    p = argparse.ArgumentParser(
        description="TAK Server CoT Listener → WebSocket Bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 tak_listener.py --host 10.10.10.3 --port 8087 --callsign CoT-Bridge
  python3 tak_listener.py --host 10.10.10.3 --port 8089 --tls --callsign CoT-Bridge
  python3 tak_listener.py --host 10.10.10.3 --port 8087 --lat 38.8977 --lon -77.0365
  python3 tak_listener.py --host 10.10.10.3 --port 8087 --filter-uid warthog
        """
    )

    # TAK server connection
    p.add_argument("--host",       required=True,  help="TAK server IP or hostname")
    p.add_argument("--port",       type=int, default=8088,
                   help="TAK server TCP port (default: 8088, TLS: 8089)")
    p.add_argument("--tls",        action="store_true",
                   help="Use TLS/SSL (required for port 8089)")
    p.add_argument("--verify-cert", action="store_true", default=False,
                   help="Enforce TLS certificate verification (default: disabled for self-signed certs)")

    # Identity / appearance on the TAK map
    p.add_argument("--callsign",   default="CoT-Bridge",
                   help="Callsign shown on the ATAK map (default: CoT-Bridge)")
    p.add_argument("--uid",        default=None,
                   help="Stable UID for this listener. Auto-generated UUID if not specified.")
    p.add_argument("--lat",        type=float, default=0.0,
                   help="Latitude for SA beacon position (default: 0.0 = null island)")
    p.add_argument("--lon",        type=float, default=0.0,
                   help="Longitude for SA beacon position (default: 0.0)")
    p.add_argument("--team-color", default="Cyan",
                   choices=["Cyan","Blue","Red","Green","Yellow","White","Purple","Maroon"],
                   help="ATAK team color for this contact (default: Cyan)")
    p.add_argument("--beacon-interval", type=int, default=30,
                   help="Seconds between SA beacon re-sends (default: 30)")

    # WebSocket server
    p.add_argument("--ws-host",    default="localhost",
                   help="WebSocket bind host (default: localhost)")
    p.add_argument("--ws-port",    type=int, default=8765,
                   help="WebSocket port the browser connects to (default: 8765)")

    # Filtering
    p.add_argument("--filter-uid", default=None,
                   help="Only forward events whose uid starts with this prefix (e.g. 'warthog')")

    # Reconnection
    p.add_argument("--reconnect-delay", type=int, default=5,
                   help="Seconds to wait before reconnection attempt (default: 5)")

    return p.parse_args()


def main():
    global args_global
    args = parse_args()
    args_global = args

    # Generate a stable UID if not provided
    listener_uid = args.uid or f"tak-listener-{uuid.uuid4()}"

    print("=" * 60)
    print("  TAK Server CoT Listener / WebSocket Bridge")
    print("=" * 60)
    print(f"  TAK server:    {args.host}:{args.port} ({'TLS' if args.tls else 'TCP'})")
    print(f"  Callsign:      {args.callsign}")
    print(f"  Listener UID:  {listener_uid}")
    print(f"  Position:      {args.lat}, {args.lon}")
    print(f"  Beacon every:  {args.beacon_interval}s")
    print(f"  WebSocket:     ws://{args.ws_host}:{args.ws_port}")
    if args.filter_uid:
        print(f"  UID filter:    uid.startswith('{args.filter_uid}')")
    print("=" * 60)
    print()
    print(f"  In index.html: connect to  ws://localhost:{args.ws_port}")
    print()

    # Start the TAK TCP reader in a daemon thread
    # (daemon=True means it dies automatically when main thread exits)
    tcp_thread = threading.Thread(
        target=tak_tcp_reader,
        args=(
            args.host, args.port,
            listener_uid, args.callsign,
            args.lat, args.lon,
            args.beacon_interval,
            args.tls, args.verify_cert,
            args.filter_uid,
            args.reconnect_delay,
        ),
        daemon=True,
        name="tak-tcp-reader"
    )
    tcp_thread.start()

    # Run the WebSocket server on the main thread's asyncio event loop
    # (blocks until Ctrl+C)
    try:
        asyncio.run(run_ws_server(args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        print("\n[INFO] Shutting down.")


if __name__ == "__main__":
    main()
