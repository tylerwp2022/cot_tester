#!/usr/bin/env python3
"""
==============================================================================
tak_cot_proxy.py — Local CORS Proxy for CoT Message Builder
==============================================================================

PURPOSE:
  Browsers cannot make cross-origin requests to TAK servers (CORS policy),
  and cannot open raw TCP sockets (required for CoT-over-TCP). This proxy
  runs on localhost, accepts HTTP POSTs from the browser, and forwards CoT
  XML to the TAK server via whichever protocol it actually speaks.

  Browser → POST http://localhost:{proxy_port}/send → This proxy → TAK server
             (CORS OK, same machine)                   (TCP or HTTP, no CORS)

SUPPORTED TAK SERVER PROTOCOLS:
  tcp://host:port    Raw TCP stream (most common — TAK Server port 8087)
  tcps://host:port   SSL/TCP stream (TAK Server port 8089)
  http://host:port   HTTP POST (TAK Server port 8088, FreeTAK, etc.)
  https://host:port  HTTPS POST (TAK Server port 8443/Marti API)

COMMON TAK SERVER PORTS:
  8088  — CoT over TCP (plain) + streaming feed (confirmed working)
  8089  — CoT over SSL/TCP
  8443  — HTTPS Marti REST API  (/Marti/api/cot)
  19023 — FreeTAK Server TCP
  19023 — FreeTAK REST API (HTTP)

USAGE:
  # TCP on port 8088 (confirmed working):
  python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8088

  # SSL/TCP:
  python3 tak_cot_proxy.py --tak-url tcps://10.10.10.3:8089

  # HTTPS with self-signed cert:
  python3 tak_cot_proxy.py --tak-url https://10.10.10.3:8443 --tak-path /Marti/api/cot --no-verify-tls

  # Custom proxy port:
  python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8087 --proxy-port 9000

  # Debug mode (verbose output):
  python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8087 --debug

IN THE CoT BUILDER:
  Server URL -> http://localhost:{proxy_port}
  API Path   -> /send

ENDPOINTS:
  POST /send    Forward CoT XML body to TAK server
  GET  /health  JSON status + config
  GET  /test    Send a minimal test CoT ping and report result

==============================================================================
"""

import argparse
import json
import socket
import ssl
import sys
import time
import urllib.request
import urllib.error
from http.server     import HTTPServer, BaseHTTPRequestHandler
from urllib.parse    import urlparse


# ==============================================================================
# Runtime configuration (populated in main())
# ==============================================================================

cfg = {
    "proxy_port": 8089,
    "tak_url":    "tcp://10.10.10.3:8088",
    "tak_path":   "/",
    "verify_tls": True,
    "debug":      False,
    "protocol":   "tcp",   # "tcp" | "tcps" | "http" | "https"
    "tak_host":   "",
    "tak_port":   8088,
}

# Minimal test CoT — sent by GET /test to verify connectivity
TEST_COT = """<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="cot-proxy-test-ping-001" type="t-x-c-t"
       how="m-g" time="{time}" start="{time}" stale="{stale}" access="Undefined">
  <point lat="0.0" lon="0.0" hae="0" ce="9999999.0" le="9999999.0"/>
  <detail><remarks>TAK CoT Proxy connectivity test</remarks></detail>
</event>"""


# ==============================================================================
# Protocol implementations
# ==============================================================================

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def stale_iso(mins=1):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + mins * 60))


def send_via_tcp(xml_bytes: bytes):
    """
    Send CoT XML over a raw TCP socket connection.

    TAK Server listens on port 8087 (plain) or 8089 (SSL) for streaming CoT.
    Each message should be terminated with a newline. A fresh connection is
    opened per message (stateless) — TAK Server handles this fine.

    Returns: (success: bool, detail_message: str)
    """
    host = cfg["tak_host"]
    port = cfg["tak_port"]

    try:
        dbg(f"TCP connect -> {host}:{port}")
        with socket.create_connection((host, port), timeout=10) as sock:

            # Wrap in SSL if protocol is tcps (SSL/TCP, port 8089)
            if cfg["protocol"] == "tcps":
                ctx = ssl.create_default_context()
                if not cfg["verify_tls"]:
                    ctx.check_hostname = False
                    ctx.verify_mode    = ssl.CERT_NONE
                    dbg("SSL verification disabled (self-signed cert mode)")
                sock = ctx.wrap_socket(sock, server_hostname=host)
                dbg("SSL handshake complete")

            # Ensure message ends with newline — TAK Server uses newline as delimiter
            payload = xml_bytes if xml_bytes.endswith(b"\n") else xml_bytes + b"\n"

            dbg(f"Sending {len(payload)} bytes over TCP")
            sock.sendall(payload)

            # TAK Server does NOT send an HTTP response for TCP CoT input.
            # We do a brief non-blocking read to catch any immediate rejection,
            # but a timeout here is NORMAL and means the message was accepted.
            sock.settimeout(1.0)
            try:
                response = sock.recv(4096)
                if response:
                    resp_str = response.decode(errors="replace").strip()
                    dbg(f"TAK server replied: {resp_str[:200]}")
                    if "<error" in resp_str.lower() or "exception" in resp_str.lower():
                        return False, f"TAK server returned error response:\n{resp_str[:400]}"
            except socket.timeout:
                # Expected — no response on TCP CoT input means accepted
                dbg("No response from TAK server (expected for TCP — means accepted)")

        return True, f"Delivered {len(payload)} bytes via TCP to {host}:{port}"

    except ConnectionRefusedError:
        return False, (
            f"Connection refused on {host}:{port}.\n"
            f"  - Is the TAK server running?\n"
            f"  - Is TCP CoT input enabled on port {port}?\n"
            f"  - Try: nc -zv {host} {port}  to test connectivity"
        )
    except socket.timeout:
        return False, (
            f"Connection timed out to {host}:{port}.\n"
            f"  - Is the host reachable? Try: ping {host}\n"
            f"  - Check firewall rules on the TAK server machine"
        )
    except OSError as e:
        return False, f"TCP socket error: {e}"


def send_via_http(xml_bytes: bytes):
    """
    Send CoT XML via HTTP/HTTPS POST.

    TAK Server HTTP CoT input (port 8088) accepts POST to '/'.
    Marti REST API (port 8443) accepts POST to '/Marti/api/cot'.

    IMPORTANT: The proxy always sends to its configured tak_url + tak_path,
    NOT to the path the browser used (/send). The browser path is irrelevant
    to the downstream TAK server.

    Returns: (success: bool, detail_message: str, http_status: int)
    """
    target_url = f"{cfg['tak_url'].rstrip('/')}{cfg['tak_path']}"
    dbg(f"HTTP POST -> {target_url}")

    try:
        req = urllib.request.Request(
            url     = target_url,
            data    = xml_bytes,
            method  = "POST",
            headers = {"Content-Type": "application/xml"},
        )

        ssl_ctx = None
        if cfg["protocol"] == "https" and not cfg["verify_tls"]:
            ssl_ctx = ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode    = ssl.CERT_NONE
            dbg("HTTPS TLS verification disabled")

        with urllib.request.urlopen(req, context=ssl_ctx, timeout=10) as resp:
            body   = resp.read().decode(errors="replace")
            status = resp.status
            dbg(f"HTTP {status} response: {body[:200]}")
            return True, f"HTTP {status} OK{(' — ' + body[:100]) if body.strip() else ''}", status

    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        dbg(f"HTTP error {e.code}: {body[:400]}")
        hints = {
            400: "Bad Request — TAK server rejected the XML. Check CoT format.",
            401: "Unauthorized — check authentication settings.",
            403: "Forbidden — server refused. Check firewall or auth config.",
            404: f"Not Found — wrong API path '{cfg['tak_path']}'. Try '/' or '/Marti/api/cot'.",
            500: "TAK server internal error.",
        }
        hint  = hints.get(e.code, "")
        msg   = f"HTTP {e.code} {e.reason}"
        if hint:
            msg += f"\n  {hint}"
        if body.strip():
            # Show a truncated version of the server's error response
            preview = body.strip()[:300]
            msg += f"\n  Server response: {preview}"
        return False, msg, e.code

    except urllib.error.URLError as e:
        reason = str(e.reason)
        if "refused" in reason.lower():
            detail = (
                f"Connection refused to {target_url}.\n"
                f"  - Is the TAK server running on port {cfg['tak_port']}?\n"
                f"  - Is HTTP CoT input enabled?"
            )
        elif "timed out" in reason.lower():
            detail = f"Connection timed out to {target_url}. Check host/port."
        elif "certificate" in reason.lower() or "ssl" in reason.lower():
            detail = f"TLS/SSL error: {reason}\n  Use --no-verify-tls for self-signed certs."
        else:
            detail = f"Could not reach {target_url}:\n  {reason}"
        dbg(f"URLError: {reason}")
        return False, detail, 0


def forward_cot(xml_bytes: bytes):
    """
    Dispatch CoT to the correct protocol handler.
    Returns: (success: bool, message: str, http_status: int)
    """
    protocol = cfg["protocol"]

    if protocol in ("tcp", "tcps"):
        ok, msg = send_via_tcp(xml_bytes)
        return ok, msg, (200 if ok else 502)

    elif protocol in ("http", "https"):
        return send_via_http(xml_bytes)

    else:
        return False, f"Unknown protocol '{protocol}'", 500


# ==============================================================================
# Logging helpers
# ==============================================================================

def dbg(msg: str):
    """Print only when --debug is active."""
    if cfg["debug"]:
        ts = time.strftime("%H:%M:%S")
        print(f"  [{ts}][DEBUG] {msg}")

def log(msg: str):
    """Always print."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


# ==============================================================================
# HTTP Request Handler (browser -> proxy)
# ==============================================================================

class ProxyHandler(BaseHTTPRequestHandler):
    """
    Handles requests from the CoT Builder browser tool.

    The browser always POSTs to /send regardless of the downstream protocol.
    This handler reads the CoT XML body and dispatches to the correct sender.

    KEY POINT: The incoming path (/send) is ONLY used for routing within this
    proxy. It is never forwarded to the TAK server. The TAK server receives
    only the CoT XML body, sent to cfg["tak_url"] + cfg["tak_path"].
    """

    def _cors(self):
        """CORS headers on every response — required for browser requests."""
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        """CORS preflight — browser sends this automatically before POST."""
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            body = json.dumps({
                "status":   "ok",
                "proxy":    f"http://localhost:{cfg['proxy_port']}",
                "protocol": cfg["protocol"],
                "target":   f"{cfg['tak_url']}{cfg['tak_path']}",
                "tls":      cfg["verify_tls"],
                "debug":    cfg["debug"],
            }, indent=2).encode()
            self._respond(200, body, "application/json")

        elif path == "/test":
            xml   = TEST_COT.format(time=now_iso(), stale=stale_iso(1)).encode()
            log(f"TEST PING -> {cfg['tak_url']}")
            ok, msg, status = forward_cot(xml)
            result = {"success": ok, "message": msg, "protocol": cfg["protocol"]}
            body = json.dumps(result, indent=2).encode()
            self._respond(200 if ok else 502, body, "application/json")
            log(f"TEST {'OK' if ok else 'FAILED'}: {msg}")

        else:
            self._respond(404, b"Not found. Use POST /send or GET /health")

    def do_POST(self):
        path = urlparse(self.path).path

        if path != "/send":
            self._respond(404, b"Unknown endpoint. Use POST /send")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._respond(400, b"Empty body - no CoT XML received.")
            return

        xml_bytes = self.rfile.read(length)
        dbg(f"Received {length} bytes from browser")
        dbg(f"CoT preview: {xml_bytes[:150].decode(errors='replace')}")

        proto = cfg["protocol"].upper()
        target = f"{cfg['tak_url']}{cfg['tak_path']}"
        log(f"-> [{proto}] {target} ({length} bytes)")

        ok, msg, status = forward_cot(xml_bytes)

        if ok:
            log(f"   OK: {msg}")
            self._respond(200, msg.encode())
        else:
            log(f"   FAILED: {msg}")
            self._respond(502, f"Forward failed:\n{msg}".encode())

    def _respond(self, code: int, body: bytes, content_type: str = "text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # Suppress default Apache-style log — we use our own


# ==============================================================================
# Entry point
# ==============================================================================

def parse_tak_url(raw: str):
    """
    Parse --tak-url into (protocol, base_url, host, port).

    Accepts:
      tcp://host:port       -> protocol=tcp
      tcps://host:port      -> protocol=tcps  (SSL/TCP)
      http://host:port      -> protocol=http
      https://host:port     -> protocol=https
      host:port             -> defaults to tcp://
    """
    if "://" not in raw:
        raw = f"tcp://{raw}"

    parsed = urlparse(raw)
    protocol = parsed.scheme.lower()

    if protocol not in ("tcp", "tcps", "http", "https"):
        print(f"ERROR: Unknown protocol '{protocol}'. Use tcp://, tcps://, http://, or https://")
        sys.exit(1)

    host = parsed.hostname
    port = parsed.port

    if not host or not port:
        print(f"ERROR: Could not parse host/port from '{raw}'")
        sys.exit(1)

    base_url = f"{protocol}://{host}:{port}"
    return protocol, base_url, host, port


def main():
    parser = argparse.ArgumentParser(
        description="Local CORS proxy — forwards CoT XML from browser to TAK server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Protocol examples:
  tcp://10.10.10.3:8088          TAK Server TCP CoT input (confirmed working)
  tcps://10.10.10.3:8089         TAK Server SSL/TCP CoT input
  https://10.10.10.3:8443        TAK Server HTTPS Marti API

Full examples:
  python3 tak_cot_proxy.py
  python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8088
  python3 tak_cot_proxy.py --tak-url https://10.10.10.3:8443 --tak-path /Marti/api/cot --no-verify-tls
  python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8088 --proxy-port 9000 --debug
        """
    )
    parser.add_argument("--tak-url",       default="tcp://10.10.10.3:8088",
                        help="TAK server URL with protocol (default: tcp://10.10.10.3:8088)")
    parser.add_argument("--tak-path",      default="/",
                        help="HTTP(S) path on TAK server (default: /) — ignored for TCP")
    parser.add_argument("--proxy-port",    type=int, default=8089,
                        help="Port for this proxy to listen on (default: 8089)")
    parser.add_argument("--no-verify-tls", action="store_true",
                        help="Disable TLS cert verification (for self-signed certs)")
    parser.add_argument("--debug",         action="store_true",
                        help="Verbose debug output (show CoT preview, socket details)")

    args = parser.parse_args()

    protocol, base_url, tak_host, tak_port = parse_tak_url(args.tak_url)

    cfg["proxy_port"] = args.proxy_port
    cfg["tak_url"]    = base_url
    cfg["tak_path"]   = args.tak_path if args.tak_path.startswith("/") else f"/{args.tak_path}"
    cfg["verify_tls"] = not args.no_verify_tls
    cfg["debug"]      = args.debug
    cfg["protocol"]   = protocol
    cfg["tak_host"]   = tak_host
    cfg["tak_port"]   = tak_port

    proto_label = {
        "tcp":   "Raw TCP (CoT streaming, plain)",
        "tcps":  "SSL/TCP (CoT streaming, encrypted)",
        "http":  "HTTP POST",
        "https": "HTTPS POST",
    }[protocol]

    target_display = (
        f"{base_url}{cfg['tak_path']}"
        if protocol in ("http", "https")
        else base_url
    )

    print("=" * 60)
    print("  TAK CoT CORS Proxy")
    print("=" * 60)
    print(f"  Proxy port : http://localhost:{cfg['proxy_port']}")
    print(f"  Protocol   : {proto_label}")
    print(f"  Target     : {target_display}")
    if protocol in ("https", "tcps"):
        print(f"  TLS verify : {'yes' if cfg['verify_tls'] else 'NO (self-signed mode)'}")
    print(f"  Debug mode : {'ON' if cfg['debug'] else 'off  (use --debug for verbose output)'}")
    print()
    print("  In the CoT Builder, set:")
    print(f"    Server URL -> http://localhost:{cfg['proxy_port']}")
    print(f"    API Path   -> /send")
    print()
    print(f"  Quick connectivity test:")
    print(f"    curl http://localhost:{cfg['proxy_port']}/test")
    print("  Ctrl+C to stop.")
    print("=" * 60)

    try:
        server = HTTPServer(("localhost", cfg["proxy_port"]), ProxyHandler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Proxy stopped.")
        sys.exit(0)
    except OSError as e:
        print(f"\n  ERROR: Could not bind to port {cfg['proxy_port']}: {e}")
        print(f"  Try:  python3 tak_cot_proxy.py --proxy-port 9000")
        sys.exit(1)


if __name__ == "__main__":
    main()
