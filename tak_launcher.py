#!/usr/bin/env python3
"""
tak_launcher.py — Process Manager for TAK Tools
================================================

PURPOSE:
    Exposes a localhost HTTP API that index.html uses to start, stop, and
    monitor tak_listener.py and tak_cot_proxy.py — so the user never needs
    to open a terminal manually.

    Browser → POST http://localhost:8766/start/listener → spawns tak_listener.py
    Browser → POST http://localhost:8766/start/proxy    → spawns tak_cot_proxy.py
    Browser → GET  http://localhost:8766/status         → process states + PIDs
    Browser → GET  http://localhost:8766/logs/listener  → last N stdout lines
    Browser → GET  http://localhost:8766/logs/proxy     → last N stdout lines

KEY DESIGN DECISIONS:
    - Uses sys.executable to spawn subprocesses — guarantees the same Python
      interpreter and virtualenv as the launcher itself. No path guessing.
    - Script paths default to the same directory as this launcher. If your
      scripts are elsewhere, use --listener-path / --proxy-path.
    - stdout + stderr from each child are merged and stored in a ring buffer
      (last 500 lines). The browser polls /logs/{script} to display them.
    - Graceful shutdown: SIGTERM sent to children on Ctrl+C or /stop requests.

USAGE:
    # Start the launcher (run once, from your venv):
    python3 tak_launcher.py

    # Custom port (if 8766 is taken):
    python3 tak_launcher.py --port 9001

    # Scripts in a different directory:
    python3 tak_launcher.py --listener-path /opt/tak/tak_listener.py \
                             --proxy-path    /opt/tak/tak_cot_proxy.py

    Then open index.html in your browser — the Launcher panel connects to
    http://localhost:8766 automatically.

ENDPOINTS:
    POST /start/listener  body: JSON config object (see LISTENER_ARGS below)
    POST /start/proxy     body: JSON config object (see PROXY_ARGS below)
    POST /stop/listener   stop and wait for process to exit
    POST /stop/proxy
    GET  /status          JSON: {listener: {...}, proxy: {...}}
    GET  /logs/listener?n=100   last n log lines as JSON array of strings
    GET  /logs/proxy?n=100
    GET  /health          basic health check
"""

import argparse
import base64
import collections
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


# =============================================================================
# CONFIGURATION DEFAULTS
# =============================================================================

DEFAULT_PORT = 8766

# Field definitions for the two scripts.
# Each entry: (cli_flag, type, default)
# These are used to build the subprocess argv from the JSON body sent by the browser.
LISTENER_ARGS = {
    "host":             ("--host",            str,   "10.10.10.3"),
    "port":             ("--port",            int,   8088),
    "tls":              ("--tls",             bool,  False),
    "verify_cert":      ("--verify-cert",     bool,  False),
    "callsign":         ("--callsign",        str,   "CoT-Bridge"),
    "uid":              ("--uid",             str,   ""),
    "lat":              ("--lat",             float, 0.0),
    "lon":              ("--lon",             float, 0.0),
    "team_color":       ("--team-color",      str,   "Cyan"),
    "beacon_interval":  ("--beacon-interval", int,   30),
    "ws_host":          ("--ws-host",         str,   "localhost"),
    "ws_port":          ("--ws-port",         int,   8765),
    "filter_uid":       ("--filter-uid",      str,   ""),
    "reconnect_delay":  ("--reconnect-delay", int,   5),
}

PROXY_ARGS = {
    "tak_url":      ("--tak-url",       str,  "tcp://10.10.10.3:8088"),
    "tak_path":     ("--tak-path",      str,  "/"),
    "proxy_port":   ("--proxy-port",    int,  8089),
    "no_verify_tls":("--no-verify-tls", bool, False),
    "debug":        ("--debug",         bool, False),
}


# =============================================================================
# PROCESS STATE
# One entry per managed script.
# =============================================================================

class ManagedProcess:
    """
    Wraps a subprocess.Popen instance with:
    - A background reader thread that drains stdout+stderr into a ring buffer
    - Start/stop lifecycle management
    - Status reporting for the browser
    """

    def __init__(self, name: str, script_path: str):
        self.name        = name
        self.script_path = script_path
        self.proc:  subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self.log_buffer = collections.deque(maxlen=500)  # ring buffer, last 500 lines
        self._lock = threading.Lock()
        self.start_time: float | None = None
        self.stop_time:  float | None = None
        self.last_args:  dict = {}

    # ── Start ────────────────────────────────────────────────────────────────

    def start(self, argv: list[str]) -> tuple[bool, str]:
        """
        Spawn the script with the given argv.
        Returns (success, message).
        """
        with self._lock:
            if self.proc and self.proc.poll() is None:
                return False, f"{self.name} is already running (PID {self.proc.pid})"

            if not os.path.isfile(self.script_path):
                return False, f"Script not found: {self.script_path}"

            cmd = [sys.executable, self.script_path] + argv
            self._append_log(f"[LAUNCHER] Starting: {' '.join(cmd)}")

            try:
                self.proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # merge stderr into stdout
                    text=True,
                    bufsize=1,                 # line-buffered
                )
            except OSError as e:
                return False, f"Failed to start {self.name}: {e}"

            self.start_time = time.time()
            self.stop_time  = None

            # Drain stdout in a daemon thread so it never blocks
            self.thread = threading.Thread(
                target=self._read_output,
                daemon=True,
                name=f"{self.name}-reader"
            )
            self.thread.start()

            return True, f"{self.name} started (PID {self.proc.pid})"

    # ── Stop ─────────────────────────────────────────────────────────────────

    def stop(self) -> tuple[bool, str]:
        """
        Send SIGTERM to the child process and wait up to 5s for it to exit.
        Falls back to SIGKILL if it doesn't exit cleanly.
        """
        with self._lock:
            if not self.proc or self.proc.poll() is not None:
                return False, f"{self.name} is not running"

            pid = self.proc.pid
            self._append_log(f"[LAUNCHER] Stopping {self.name} (PID {pid})...")

            try:
                self.proc.terminate()  # SIGTERM
                try:
                    self.proc.wait(timeout=5)
                    self._append_log(f"[LAUNCHER] {self.name} exited cleanly.")
                except subprocess.TimeoutExpired:
                    self.proc.kill()   # SIGKILL fallback
                    self.proc.wait()
                    self._append_log(f"[LAUNCHER] {self.name} force-killed.")
            except ProcessLookupError:
                pass  # already gone

            self.stop_time = time.time()
            return True, f"{self.name} stopped (was PID {pid})"

    # ── Status ───────────────────────────────────────────────────────────────

    def status(self) -> dict:
        running = bool(self.proc and self.proc.poll() is None)
        return {
            "running":    running,
            "pid":        self.proc.pid if running else None,
            "start_time": self.start_time,
            "stop_time":  self.stop_time,
            "exit_code":  self.proc.returncode if (self.proc and not running) else None,
            "log_lines":  len(self.log_buffer),
        }

    # ── Log helpers ──────────────────────────────────────────────────────────

    def get_logs(self, n: int = 100) -> list[str]:
        return list(self.log_buffer)[-n:]

    def _append_log(self, line: str):
        ts = time.strftime("%H:%M:%S")
        self.log_buffer.append(f"[{ts}] {line.rstrip()}")

    def _read_output(self):
        """
        Background thread: continuously reads the child's stdout and
        appends each line to the ring buffer. Exits when the pipe closes.
        """
        if not self.proc or not self.proc.stdout:
            return
        try:
            for line in self.proc.stdout:
                self._append_log(line)
        except (ValueError, OSError):
            pass  # pipe closed — process exited
        self._append_log(f"[LAUNCHER] {self.name} process output ended.")


# =============================================================================
# GLOBAL PROCESS INSTANCES
# Populated in main() once script paths are resolved.
# =============================================================================

listener_proc: ManagedProcess | None = None
proxy_proc:    ManagedProcess | None = None


# =============================================================================
# CERTIFICATE STATE
#
# Tracks the current client certificate for mutual TLS (mTLS) connections to
# TAK Server on port 8089. The cert is uploaded as base64 JSON from the
# browser, written to a temp file, and passed to child processes as CLI args.
#
# Security notes:
#   - Password is held in memory only — never written to disk.
#   - Temp .p12 file is created in /tmp with a random name.
#   - If save_to_disk=True, a copy is saved as tak_client.p12 in the script
#     directory for convenience across restarts (still needs password entry).
#   - CLI args are visible in `ps aux` on this machine — acceptable for a
#     localhost lab tool on a trusted network.
# =============================================================================

cert_state = {
    "loaded":       False,   # True when a cert is staged and ready for use
    "temp_path":    None,    # Path to /tmp copy of the .p12 (in-memory lifespan)
    "disk_path":    None,    # Path to saved copy on disk (persistent, or None)
    "password":     None,    # Plaintext password (memory only — never written to disk)
    "filename":     "",      # Original filename for display (e.g. "tyler_tak.p12")
    "saved_to_disk": False,  # Whether a disk copy exists from this session
}

# Lock for cert_state — modified from HTTP handler threads
cert_lock = threading.Lock()


def _cert_saved_path(script_dir: str) -> str:
    """Return the conventional path for the on-disk cert in the script directory."""
    return os.path.join(script_dir, "tak_client.p12")


def cert_load_from_disk(script_dir: str) -> bool:
    """
    Check if a saved tak_client.p12 exists in the script directory.
    If so, copy it to a temp file and set cert_state["disk_path"] so the
    browser knows to prompt for the password.

    WHY: On repeated sessions the cert file is already on disk, saving the
    user from re-uploading it. They still need to enter the password because
    we never persist it.

    Returns True if a saved cert was found, False otherwise.
    """
    saved = _cert_saved_path(script_dir)
    if not os.path.isfile(saved):
        return False

    with cert_lock:
        cert_state["disk_path"] = saved
        # Don't set loaded=True here — password still needed
        # The browser will detect "disk_path set but not loaded" and prompt
        print(f"[CERT] Found saved cert on disk: {saved}")
    return True


def cert_clear() -> None:
    """
    Remove the in-memory cert state and delete the temp file.
    Does NOT delete the on-disk saved copy — that requires explicit user action.
    """
    with cert_lock:
        tmp = cert_state.get("temp_path")
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        cert_state["loaded"]      = False
        cert_state["temp_path"]   = None
        cert_state["password"]    = None
        cert_state["filename"]    = ""
        # Keep disk_path and saved_to_disk — those survive clears


def inject_cert_args(argv: list) -> list:
    """
    If a cert is loaded, append --cert-file and --cert-password to argv.
    Called by the start/listener and start/proxy handlers before spawning
    child processes so both scripts get the cert without the browser needing
    to know the temp file path.

    This is separate from build_argv() which only processes browser-supplied
    config fields — the cert path is internal to the launcher.
    """
    with cert_lock:
        if cert_state["loaded"] and cert_state["temp_path"]:
            argv = argv + ["--cert-file", cert_state["temp_path"]]
            if cert_state["password"]:
                argv = argv + ["--cert-password", cert_state["password"]]
    return argv


# =============================================================================
# ARGUMENT BUILDER
# Converts a JSON dict from the browser into a flat argv list for Popen.
# =============================================================================

def build_argv(config: dict, arg_defs: dict) -> list[str]:
    """
    Build a subprocess argv from a browser config dict and an arg definition map.

    For bool flags: include the flag if value is truthy (no-argument flags like --tls).
    For str/int/float: include --flag value, but skip if value is empty/zero sentinel.
    """
    argv = []
    for key, (flag, typ, default) in arg_defs.items():
        val = config.get(key, default)
        if typ == bool:
            if val:
                argv.append(flag)
        elif typ == str:
            if val and str(val).strip():
                argv += [flag, str(val)]
        elif typ in (int, float):
            # Only include if different from default (avoids cluttering the command)
            if val != default:
                argv += [flag, str(val)]
    return argv


# =============================================================================
# HTTP REQUEST HANDLER
# =============================================================================

class LauncherHandler(BaseHTTPRequestHandler):
    """
    Handles browser requests to the launcher API.
    All responses include CORS headers so the browser can call freely.
    """

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, data):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code: int, msg: str):
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)
        n      = int(qs.get("n", ["100"])[0])

        if path == "/health":
            self._json(200, {"status": "ok", "version": "1.0"})

        elif path == "/status":
            self._json(200, {
                "listener": listener_proc.status() if listener_proc else {},
                "proxy":    proxy_proc.status()    if proxy_proc    else {},
            })

        elif path == "/cert-status":
            with cert_lock:
                self._json(200, {
                    "loaded":        cert_state["loaded"],
                    "filename":      cert_state["filename"],
                    "saved_to_disk": cert_state["saved_to_disk"],
                    # Tells the browser "a saved cert exists — enter password to activate"
                    "disk_cert_available": cert_state["disk_path"] is not None
                                           and os.path.isfile(cert_state["disk_path"] or ""),
                })

        elif path == "/logs/listener":
            self._json(200, listener_proc.get_logs(n) if listener_proc else [])

        elif path == "/logs/proxy":
            self._json(200, proxy_proc.get_logs(n) if proxy_proc else [])

        else:
            self._text(404, f"Unknown endpoint: {path}")

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path

        # Read JSON body (if any) — sendBeacon sends no body, that's fine
        length  = int(self.headers.get("Content-Length", 0))
        body    = self.rfile.read(length) if length else b"{}"
        try:
            config = json.loads(body) if body.strip() else {}
        except json.JSONDecodeError:
            config = {}

        # ── /start/listener ───────────────────────────────────────────────
        if path == "/start/listener":
            argv = build_argv(config, LISTENER_ARGS)
            argv = inject_cert_args(argv)  # append --cert-file/--cert-password if loaded
            ok, msg = listener_proc.start(argv)
            print(f"[LAUNCHER] {msg}")
            self._json(200 if ok else 400, {"ok": ok, "message": msg})

        # ── /start/proxy ──────────────────────────────────────────────────
        elif path == "/start/proxy":
            argv = build_argv(config, PROXY_ARGS)
            argv = inject_cert_args(argv)  # append --cert-file/--cert-password if loaded
            ok, msg = proxy_proc.start(argv)
            print(f"[LAUNCHER] {msg}")
            self._json(200 if ok else 400, {"ok": ok, "message": msg})

        # ── /upload-cert ──────────────────────────────────────────────────
        # Accepts JSON: { "cert_b64": "<base64>", "filename": "user.p12",
        #                 "password": "secret", "save_to_disk": false }
        # Writes the cert to a temp file, optionally saves to disk.
        # Responds: { "ok": true/false, "message": "..." }
        elif path == "/upload-cert":
            filename    = config.get("filename", "cert.p12")
            password    = config.get("password", "")
            cert_b64    = config.get("cert_b64", "")
            save_to_disk = bool(config.get("save_to_disk", False))

            if not cert_b64:
                self._json(400, {"ok": False, "message": "No cert data received (cert_b64 empty)"})
                return

            try:
                cert_bytes = base64.b64decode(cert_b64)
            except Exception as e:
                self._json(400, {"ok": False, "message": f"Invalid base64 data: {e}"})
                return

            try:
                # Clear any previously loaded cert first
                cert_clear()

                # Write to a new temp file that will persist until cert_clear()
                fd, tmp_path = tempfile.mkstemp(suffix=".p12", prefix="tak_cert_")
                with os.fdopen(fd, "wb") as f:
                    f.write(cert_bytes)

                disk_path = None
                if save_to_disk:
                    here = os.path.dirname(os.path.abspath(__file__))
                    disk_path = _cert_saved_path(here)
                    with open(disk_path, "wb") as f:
                        f.write(cert_bytes)
                    print(f"[CERT] Saved cert to disk: {disk_path}")

                with cert_lock:
                    cert_state["loaded"]       = True
                    cert_state["temp_path"]    = tmp_path
                    cert_state["password"]     = password
                    cert_state["filename"]     = filename
                    cert_state["disk_path"]    = disk_path
                    cert_state["saved_to_disk"] = save_to_disk

                msg = (f"Certificate loaded: {filename} "
                       f"({'saved to disk' if save_to_disk else 'in-memory only'})")
                print(f"[CERT] {msg}")
                self._json(200, {"ok": True, "message": msg})

            except OSError as e:
                self._json(500, {"ok": False, "message": f"Failed to write cert file: {e}"})

        # ── /activate-saved-cert ──────────────────────────────────────────
        # Use the on-disk saved cert with a freshly entered password.
        # Body: { "password": "secret" }
        elif path == "/activate-saved-cert":
            password = config.get("password", "")
            with cert_lock:
                disk_path = cert_state.get("disk_path")

            if not disk_path or not os.path.isfile(disk_path):
                self._json(400, {"ok": False,
                                 "message": "No saved cert found on disk (upload one first)"})
                return

            try:
                cert_clear()

                # Copy disk cert to a fresh temp file
                with open(disk_path, "rb") as f:
                    cert_bytes = f.read()
                fd, tmp_path = tempfile.mkstemp(suffix=".p12", prefix="tak_cert_")
                with os.fdopen(fd, "wb") as f:
                    f.write(cert_bytes)

                with cert_lock:
                    cert_state["loaded"]       = True
                    cert_state["temp_path"]    = tmp_path
                    cert_state["password"]     = password
                    cert_state["disk_path"]    = disk_path
                    cert_state["saved_to_disk"] = True
                    cert_state["filename"]     = os.path.basename(disk_path)

                msg = f"Saved cert activated: {os.path.basename(disk_path)}"
                print(f"[CERT] {msg}")
                self._json(200, {"ok": True, "message": msg})

            except OSError as e:
                self._json(500, {"ok": False, "message": f"Failed to activate saved cert: {e}"})

        # ── /clear-cert ───────────────────────────────────────────────────
        elif path == "/clear-cert":
            cert_clear()
            print("[CERT] Certificate cleared from memory")
            self._json(200, {"ok": True, "message": "Certificate cleared"})

        # ── /delete-saved-cert ────────────────────────────────────────────
        elif path == "/delete-saved-cert":
            here = os.path.dirname(os.path.abspath(__file__))
            disk_path = _cert_saved_path(here)
            cert_clear()
            if os.path.isfile(disk_path):
                try:
                    os.unlink(disk_path)
                    with cert_lock:
                        cert_state["disk_path"]     = None
                        cert_state["saved_to_disk"] = False
                    print(f"[CERT] Deleted saved cert: {disk_path}")
                    self._json(200, {"ok": True, "message": "Saved cert deleted from disk"})
                except OSError as e:
                    self._json(500, {"ok": False, "message": f"Failed to delete: {e}"})
            else:
                with cert_lock:
                    cert_state["disk_path"]     = None
                    cert_state["saved_to_disk"] = False
                self._json(200, {"ok": True, "message": "No saved cert found to delete"})

        # ── /stop/all ─────────────────────────────────────────────────────
        elif path == "/stop/all":
            r1_ok, r1_msg = listener_proc.stop()
            r2_ok, r2_msg = proxy_proc.stop()
            print(f"[LAUNCHER] Stop all: {r1_msg} | {r2_msg}")
            self._json(200, {"ok": True, "listener": r1_msg, "proxy": r2_msg})

        # ── /stop/listener ────────────────────────────────────────────────
        elif path == "/stop/listener":
            ok, msg = listener_proc.stop()
            print(f"[LAUNCHER] {msg}")
            self._json(200, {"ok": ok, "message": msg})

        # ── /stop/proxy ───────────────────────────────────────────────────
        elif path == "/stop/proxy":
            ok, msg = proxy_proc.stop()
            print(f"[LAUNCHER] {msg}")
            self._json(200, {"ok": ok, "message": msg})

        else:
            self._text(404, f"Unknown endpoint: {path}")

    def log_message(self, fmt, *args):
        pass  # suppress default access log


# =============================================================================
# ENTRY POINT
# =============================================================================

def resolve_script(name: str, override: str | None) -> str:
    """
    Resolve a script path. If override is given, use it. Otherwise, look
    in the same directory as this launcher script.
    """
    if override:
        return os.path.abspath(override)
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, name)


def main():
    global listener_proc, proxy_proc

    parser = argparse.ArgumentParser(
        description="Process manager — lets index.html launch TAK tools without a terminal",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Just run this once from your venv and then use the Launcher panel in index.html:

  python3 tak_launcher.py

Custom paths (if scripts are not in the same directory):
  python3 tak_launcher.py --listener-path /opt/tak/tak_listener.py \\
                           --proxy-path    /opt/tak/tak_cot_proxy.py
        """
    )
    parser.add_argument("--port",          type=int, default=DEFAULT_PORT,
                        help=f"Port for this launcher HTTP server (default: {DEFAULT_PORT})")
    parser.add_argument("--listener-path", default=None,
                        help="Path to tak_listener.py (default: same dir as this script)")
    parser.add_argument("--proxy-path",    default=None,
                        help="Path to tak_cot_proxy.py (default: same dir as this script)")
    args = parser.parse_args()

    listener_path = resolve_script("tak_listener.py",  args.listener_path)
    proxy_path    = resolve_script("tak_cot_proxy.py", args.proxy_path)

    listener_proc = ManagedProcess("tak_listener", listener_path)
    proxy_proc    = ManagedProcess("tak_cot_proxy", proxy_path)

    # Check for a previously saved client certificate on disk.
    # Sets cert_state["disk_path"] if found so the browser can prompt
    # for the password to re-activate it without re-uploading.
    here = os.path.dirname(os.path.abspath(__file__))
    cert_load_from_disk(here)

    print("=" * 60)
    print("  TAK Tools Launcher")
    print("=" * 60)
    print(f"  API:           http://localhost:{args.port}")
    print(f"  Python:        {sys.executable}")
    print(f"  tak_listener:  {listener_path}")
    print(f"    exists:      {'✓' if os.path.isfile(listener_path) else '✗ NOT FOUND'}")
    print(f"  tak_cot_proxy: {proxy_path}")
    print(f"    exists:      {'✓' if os.path.isfile(proxy_path) else '✗ NOT FOUND'}")
    print()
    print("  Open index.html and use the 🚀 Launcher panel.")
    print("  Ctrl+C to stop (also stops any running child processes).")
    print("=" * 60)

    # Graceful shutdown: stop children on SIGINT/SIGTERM
    def shutdown(signum, frame):
        print("\n[LAUNCHER] Shutting down...")
        listener_proc.stop()
        proxy_proc.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server = HTTPServer(("localhost", args.port), LauncherHandler)
        server.serve_forever()
    except OSError as e:
        print(f"\n[LAUNCHER] ERROR: Could not bind to port {args.port}: {e}")
        print(f"  Try: python3 tak_launcher.py --port 9001")
        sys.exit(1)


if __name__ == "__main__":
    main()
