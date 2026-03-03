#!/usr/bin/env bash
# stop_tak_tools.sh — Stop tak_launcher.py and all managed child processes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.tak_launcher.pid"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[TAK]${NC} $1"; }
success() { echo -e "${GREEN}[TAK]${NC} $1"; }
error()   { echo -e "${RED}[TAK]${NC} $1"; }

# Try graceful stop via API first (launcher stops children cleanly)
if curl -s --max-time 2 "http://localhost:8766/stop/listener" -X POST >/dev/null 2>&1; then
    info "Stopped tak_listener.py"
fi
if curl -s --max-time 2 "http://localhost:8766/stop/proxy" -X POST >/dev/null 2>&1; then
    info "Stopped tak_cot_proxy.py"
fi

# Stop the launcher itself
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        sleep 0.5
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
        success "tak_launcher.py stopped (PID $PID)"
    else
        info "Launcher PID $PID was not running"
    fi
    rm -f "$PID_FILE"
else
    # Fallback: pkill by name
    if pkill -f "tak_launcher.py" 2>/dev/null; then
        success "tak_launcher.py stopped (via pkill)"
    else
        info "No tak_launcher.py process found"
    fi
fi

# Also catch any orphaned listener/proxy processes
pkill -f "tak_listener.py"  2>/dev/null && info "tak_listener.py stopped"
pkill -f "tak_cot_proxy.py" 2>/dev/null && info "tak_cot_proxy.py stopped"

success "Done."
