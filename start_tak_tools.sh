#!/usr/bin/env bash
# ==============================================================================
# start_tak_tools.sh — One-click startup for CoT Message Builder TAK tools
# ==============================================================================
#
# WHAT THIS DOES:
#   1. Finds and activates your Python virtualenv
#   2. Starts tak_launcher.py in the background (which manages tak_listener.py
#      and tak_cot_proxy.py on demand from the browser)
#   3. Waits until the launcher HTTP API is responsive
#   4. Opens index.html in your default browser
#
# SETUP (one time):
#   1. Edit VENV_PATH below to point at your virtualenv
#   2. chmod +x start_tak_tools.sh
#   3. Double-click in your file manager, or run ./start_tak_tools.sh
#
# TO STOP:
#   Run ./stop_tak_tools.sh   (also generated in this directory)
#   Or kill the launcher:     pkill -f tak_launcher.py
#
# ==============================================================================

# ── CONFIGURATION — edit these ───────────────────────────────────────────────

# Path to your Python virtualenv (the directory containing bin/activate).
# Tries common locations automatically if left blank.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="${VENV_PATH:-$SCRIPT_DIR/venv}"

# Port tak_launcher.py listens on (must match --port if you customized it)
LAUNCHER_PORT=8766

# Path to index.html — defaults to same directory as this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEX_HTML="${SCRIPT_DIR}/index.html"
LAUNCHER_SCRIPT="${SCRIPT_DIR}/tak_launcher.py"

# How long to wait for the launcher to become ready (seconds)
STARTUP_TIMEOUT=15

# ── COLOR OUTPUT ─────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}[TAK]${NC} $1"; }
success() { echo -e "${GREEN}[TAK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[TAK]${NC} $1"; }
error()   { echo -e "${RED}[TAK]${NC} $1"; }

# ── STEP 1: FIND VIRTUALENV ──────────────────────────────────────────────────

find_venv() {
    # If user specified one, use it
    if [ -n "$VENV_PATH" ]; then
        if [ -f "${VENV_PATH}/bin/activate" ]; then
            echo "$VENV_PATH"
            return 0
        else
            error "Specified VENV_PATH '${VENV_PATH}' not found or missing bin/activate"
            return 1
        fi
    fi

    # Auto-detect: check common locations relative to the script directory
    local candidates=(
        "${SCRIPT_DIR}/venv"
        "${SCRIPT_DIR}/.venv"
        "${SCRIPT_DIR}/../venv"
        "${SCRIPT_DIR}/../.venv"
        "${HOME}/venv"
        "${HOME}/.venv"
    )

    for candidate in "${candidates[@]}"; do
        if [ -f "${candidate}/bin/activate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    return 1
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CoT Message Builder — TAK Tools Startup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check launcher script exists
if [ ! -f "$LAUNCHER_SCRIPT" ]; then
    error "tak_launcher.py not found at: $LAUNCHER_SCRIPT"
    error "Make sure all files are in the same directory as this script."
    read -p "Press Enter to exit..."
    exit 1
fi

# Find venv
RESOLVED_VENV=$(find_venv)
if [ $? -ne 0 ] || [ -z "$RESOLVED_VENV" ]; then
    warn "No virtualenv found. Trying system Python..."
    PYTHON_BIN="python3"
else
    info "Using virtualenv: $RESOLVED_VENV"
    # shellcheck source=/dev/null
    source "${RESOLVED_VENV}/bin/activate"
    PYTHON_BIN="${RESOLVED_VENV}/bin/python3"
fi

# Verify Python is available
if ! command -v "$PYTHON_BIN" &>/dev/null; then
    PYTHON_BIN=$(command -v python3 || command -v python)
    if [ -z "$PYTHON_BIN" ]; then
        error "Python not found. Install Python 3 or check your venv path."
        read -p "Press Enter to exit..."
        exit 1
    fi
fi

PYTHON_VERSION=$("$PYTHON_BIN" --version 2>&1)
info "Python: $PYTHON_VERSION ($PYTHON_BIN)"

# Check websockets is installed (required by tak_listener.py)
if ! "$PYTHON_BIN" -c "import websockets" 2>/dev/null; then
    warn "websockets not installed — installing now..."
    "$PYTHON_BIN" -m pip install websockets -q
    if [ $? -ne 0 ]; then
        error "Failed to install websockets. Run: pip install websockets"
        read -p "Press Enter to exit..."
        exit 1
    fi
    success "websockets installed."
fi

# ── STEP 2: CHECK IF LAUNCHER ALREADY RUNNING ────────────────────────────────

if curl -s --max-time 1 "http://localhost:${LAUNCHER_PORT}/health" >/dev/null 2>&1; then
    success "tak_launcher.py already running on port ${LAUNCHER_PORT}"
else
    # ── STEP 3: START LAUNCHER ────────────────────────────────────────────────

    info "Starting tak_launcher.py (port ${LAUNCHER_PORT})..."
    LOG_FILE="${SCRIPT_DIR}/tak_launcher.log"

    # Start in background, redirect output to log file
    "$PYTHON_BIN" "$LAUNCHER_SCRIPT" --port "$LAUNCHER_PORT" \
        > "$LOG_FILE" 2>&1 &
    LAUNCHER_PID=$!

    # Save PID for stop script
    echo "$LAUNCHER_PID" > "${SCRIPT_DIR}/.tak_launcher.pid"
    info "Launcher PID: $LAUNCHER_PID  (log: $LOG_FILE)"

    # ── STEP 4: WAIT FOR LAUNCHER TO BE READY ────────────────────────────────

    info "Waiting for launcher to be ready..."
    elapsed=0
    while ! curl -s --max-time 1 "http://localhost:${LAUNCHER_PORT}/health" >/dev/null 2>&1; do
        sleep 0.5
        elapsed=$((elapsed + 1))
        if [ $elapsed -ge $((STARTUP_TIMEOUT * 2)) ]; then
            error "Launcher did not start within ${STARTUP_TIMEOUT}s."
            error "Check log: $LOG_FILE"
            # Print last 10 lines of log for immediate diagnosis
            echo ""
            tail -10 "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
                echo "  │ $line"
            done
            read -p "Press Enter to exit..."
            exit 1
        fi
        printf "."
    done
    echo ""
    success "tak_launcher.py is ready!"
fi

# ── STEP 5: OPEN BROWSER ─────────────────────────────────────────────────────

if [ ! -f "$INDEX_HTML" ]; then
    warn "index.html not found at: $INDEX_HTML"
    warn "Launcher is running — open index.html manually."
else
    info "Opening index.html in browser..."
    # WHY setsid: bare `&` leaves the browser in the terminal's process group.
    # Ctrl+C would propagate SIGINT to Firefox and close all its windows.
    # setsid starts it in a new session, fully detached from this terminal.
    # WHY --new-window: opens a dedicated window for the CoT builder rather
    # than a tab inside an existing Firefox window.
    if command -v firefox &>/dev/null; then
        setsid firefox --new-window "file://${INDEX_HTML}" >/dev/null 2>&1 &
    elif command -v xdg-open &>/dev/null; then
        setsid xdg-open "file://${INDEX_HTML}" >/dev/null 2>&1 &
    elif command -v gnome-open &>/dev/null; then
        setsid gnome-open "file://${INDEX_HTML}" >/dev/null 2>&1 &
    elif command -v google-chrome &>/dev/null; then
        setsid google-chrome --new-window "file://${INDEX_HTML}" >/dev/null 2>&1 &
    elif command -v chromium-browser &>/dev/null; then
        setsid chromium-browser --new-window "file://${INDEX_HTML}" >/dev/null 2>&1 &
    else
        warn "Could not detect browser opener. Open manually:"
        warn "  file://${INDEX_HTML}"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success "TAK tools ready."
echo ""
echo "  Launcher API:  http://localhost:${LAUNCHER_PORT}"
echo "  UI:            file://${INDEX_HTML}"
echo ""
echo "  In the browser: click ⚡ Connect to Launcher, then"
echo "  use the 🚀 Launcher panel to start tak_listener / tak_cot_proxy."
echo ""
echo "  To stop everything: ./stop_tak_tools.sh"
echo "  (Closing this terminal leaves tak_launcher.py running in the background)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Keep the terminal open so the user can see the output.
# WHY trap+sleep instead of bare `wait`:
#   `wait` re-raises the signal that interrupted it, propagating SIGINT into
#   the process group on Ctrl+C. The trap below intercepts it cleanly and
#   exits with 0 — tak_launcher.py keeps running, Firefox is untouched.
trap 'echo ""; info "Terminal closed. tak_launcher.py is still running."; info "Run ./stop_tak_tools.sh to shut everything down."; exit 0' INT TERM
while true; do sleep 1; done
