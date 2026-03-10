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

    # TLS with mutual TLS client certificate (.p12 from TAK Server admin console)
    python3 tak_listener.py --host 10.10.10.3 --port 8089 --tls \\
                             --cert-file /path/to/user.p12 --cert-password mypassword

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
import os
import socket
import ssl
import sys
import tempfile
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

# Stores the most recent beacon_sent payload so late-connecting browser clients
# receive the identity immediately on WebSocket connect rather than waiting for
# the next beacon interval (which could be up to 30 seconds away).
# Only mutated from the TCP reader thread; only read from the asyncio ws_handler.
# Reads of a dict reference are atomic in CPython so no lock is needed.
_bridge_identity: Optional[dict] = None


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

    WHY WE RESEND _bridge_identity HERE:
    beacon_sent is broadcast once when tak_listener.py first connects to the
    TAK server TCP socket. If the browser WebSocket connects after that moment
    (the common case — user starts the listener, then opens the browser tab),
    it misses the beacon_sent message and the "Use Bridge Identity" button
    appears to do nothing. Replaying the stored identity to each new client
    on connect fixes this regardless of connection order.
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

    # If the TAK TCP connection is already up and has sent a beacon, replay
    # the identity immediately so the browser doesn't have to wait up to
    # beacon_interval seconds for the next one.
    if _bridge_identity is not None:
        await websocket.send(json.dumps(_bridge_identity))

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
# TLS / SSL CONTEXT BUILDER
#
# TAK Server port 8089 uses mutual TLS (mTLS) — the server authenticates
# itself to us AND we authenticate ourselves to the server via a client cert.
#
# TAK Server issues client certs as .p12 (PKCS#12) bundles from the admin
# console (User Certs → Export). Python's ssl module only speaks PEM, so we
# do an in-memory .p12→PEM conversion via the `cryptography` library, write
# briefly to named temp files (required by ssl.SSLContext.load_cert_chain),
# and delete them immediately after loading.
#
# Two operating modes:
#   No cert:   plain TLS encryption, no client identity presented.
#              Works if the TAK Server is configured for anonymous clients.
#   With cert: full mTLS — TAK Server sees us as a named user, required on
#              most production TAK deployments.
#
# Server-side verification:
#   verify=False (default): skip verifying the TAK server's cert chain.
#              Almost always correct for self-signed TAK server certs.
#   verify=True:            enforce chain validation. Requires your CA cert
#              to be in the system trust store or passed via ca_cert_file.
#              Switchable via --verify-cert CLI flag.
# =============================================================================

def _load_p12_into_context(ctx: ssl.SSLContext, p12_path: str, password: str) -> None:
    """
    Load a PKCS#12 (.p12) client certificate into an existing SSLContext.

    Python ssl only accepts PEM files. This function:
      1. Reads the .p12 bytes from disk
      2. Decrypts them with the password using the `cryptography` library
      3. Serializes the private key and certificate to PEM in memory
      4. Writes each to a NamedTemporaryFile (required by load_cert_chain)
      5. Calls ctx.load_cert_chain() to register the identity
      6. Immediately unlinks the temp files — minimises disk exposure time

    Args:
        ctx:       ssl.SSLContext to load the identity into (mutated in place)
        p12_path:  Filesystem path to the .p12 file
        password:  Plaintext password string (or "" for no password)

    Raises:
        RuntimeError: if `cryptography` is not installed, if the password is
                      wrong, or if the .p12 is malformed.

    WHY NOT in-memory only? ssl.SSLContext.load_cert_chain() only accepts
    file paths (as of Python 3.12). The temp-file approach is the standard
    workaround; files are deleted synchronously before this function returns.
    """
    try:
        from cryptography.hazmat.primitives.serialization import pkcs12
        from cryptography.hazmat.primitives.serialization import (
            Encoding, PrivateFormat, NoEncryption
        )
    except ImportError:
        raise RuntimeError(
            "The 'cryptography' package is required for .p12 certificate support.\n"
            "Install it with:  pip install cryptography"
        )

    try:
        with open(p12_path, "rb") as f:
            p12_data = f.read()

        pw_bytes = password.encode("utf-8") if password else None
        private_key, certificate, _chain = pkcs12.load_key_and_certificates(
            p12_data, pw_bytes
        )

        if private_key is None or certificate is None:
            raise RuntimeError(
                f"No private key or certificate found in {p12_path}. "
                "Is this a valid PKCS#12 file?"
            )

        # Serialize to PEM — write to temp files, load, then delete immediately
        cert_pem = certificate.public_bytes(Encoding.PEM)
        key_pem  = private_key.private_bytes(
            Encoding.PEM,
            PrivateFormat.TraditionalOpenSSL,
            NoEncryption()               # no passphrase on temp file — it's short-lived
        )

        cert_tmp = key_tmp = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".pem", delete=False) as cf:
                cf.write(cert_pem)
                cert_tmp = cf.name
            with tempfile.NamedTemporaryFile(suffix=".pem", delete=False) as kf:
                kf.write(key_pem)
                key_tmp = kf.name

            ctx.load_cert_chain(cert_tmp, key_tmp)
            print(f"[TLS] Client certificate loaded: {certificate.subject}")

        finally:
            # Always delete temp PEM files, even if load_cert_chain raised
            for path in (cert_tmp, key_tmp):
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except OSError:
                        pass

    except (ValueError, TypeError) as e:
        raise RuntimeError(
            f"Failed to decrypt .p12 certificate: {e}\n"
            "  → Check password and verify this is a valid PKCS#12 file."
        )


def build_ssl_context(verify_cert: bool,
                      cert_file: Optional[str] = None,
                      cert_password: str = "") -> ssl.SSLContext:
    """
    Build an ssl.SSLContext for connecting to TAK Server on port 8089.

    Args:
        verify_cert:    If True, enforce server certificate chain validation.
                        Set False (default) for self-signed TAK Server certs.
                        To switch to True, pass --verify-cert on the CLI.
                        To add full CA validation in future: load your TAK
                        Server's CA cert with ctx.load_verify_locations().
        cert_file:      Path to .p12 client cert file (optional).
                        Required if TAK Server enforces mutual TLS.
                        Leave None for anonymous TLS (server-only auth).
        cert_password:  Password for the .p12 file (empty string if none).

    Returns:
        ssl.SSLContext ready to pass to ctx.wrap_socket()

    Raises:
        RuntimeError: if cert loading fails (bad password, missing package, etc.)
    """
    ctx = ssl.create_default_context()

    # ── Server cert verification ──────────────────────────────────────────────
    # WHY disabled by default: TAK Server ships with self-signed certs that are
    # not in any public CA bundle. Enabling verification without also providing
    # the TAK CA cert would cause every connection to fail with a cert error.
    # When you're ready to enforce verification, enable --verify-cert AND add:
    #   ctx.load_verify_locations("/path/to/tak-server-ca.pem")
    if not verify_cert:
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE

    # ── Client certificate (mutual TLS) ───────────────────────────────────────
    if cert_file and os.path.isfile(cert_file):
        print(f"[TLS] Loading client certificate: {cert_file}")
        _load_p12_into_context(ctx, cert_file, cert_password)
    elif cert_file:
        print(f"[TLS] WARNING: cert file not found: {cert_file} — continuing without client cert")

    return ctx


# =============================================================================
# TAK TCP CLIENT
# Runs in a daemon thread. Connects to the TAK server, sends the SA beacon,
# reads the incoming stream, and forwards each complete CoT event to the
# WebSocket broadcast queue.
# =============================================================================

def tak_tcp_reader(host: str, port: int, uid: str, callsign: str,
                   lat: float, lon: float, beacon_interval: int,
                   use_tls: bool, verify_cert: bool,
                   cert_file: Optional[str], cert_password: str,
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
        cert_file:          Path to .p12 client certificate (or None)
        cert_password:      Password for the .p12 file (or "")
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
                # build_ssl_context handles both anonymous TLS and mTLS (.p12 cert).
                # Errors here (wrong password, missing cryptography lib) are caught
                # by the outer except block and trigger a reconnection with an error
                # message broadcast to the browser.
                ctx  = build_ssl_context(verify_cert, cert_file, cert_password)
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

            # Cache so late-connecting browser clients receive it immediately
            # on WebSocket connect (see ws_handler).
            global _bridge_identity
            _bridge_identity = {
                "type": "beacon_sent",
                "callsign": callsign,
                "uid": uid,
                "lat": lat,
                "lon": lon
            }

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

    # Client certificate for mutual TLS (mTLS)
    # TAK Server port 8089 typically requires a client cert issued from the
    # TAK Server admin console (User Certs → Export → .p12).
    p.add_argument("--cert-file",     default=None,
                   help="Path to .p12 client certificate file for mutual TLS. "
                        "Get this from TAK Server admin → User Certs → Export.")
    p.add_argument("--cert-password", default="",
                   help="Password for the .p12 file (default: empty string). "
                        "NOTE: visible in 'ps aux' on this machine — acceptable for localhost lab use.")

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
    if args.tls:
        print(f"  TLS verify:    {'yes' if args.verify_cert else 'no (self-signed mode)'}")
        print(f"  Client cert:   {args.cert_file or '(none — anonymous TLS)'}")
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
            args.cert_file, args.cert_password,
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
