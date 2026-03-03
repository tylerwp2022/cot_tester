# CoT Message Builder & TAK Live Listener

A browser-based tool for building, sending, analyzing, and monitoring Cursor on Target (CoT) messages to a TAK server (ATAK, WinTAK, TAK Server). Designed for testing, debugging, and tactical development workflows.

---

## File Structure

```
index.html          — Main UI (all panels)
cot_types.js        — CoT type/how decoder, type breakdown widget
cot_parser.js       — Raw XML parser, analyzer, timestamp injection
cot_composer.js     — Form-based XML builder, chat/spot/preset composers
cot_sender.js       — HTTP send logic, repeat mode, status/log
cot_presets.js      — Preset CoT library definitions

tak_listener.py     — WebSocket bridge: TAK TCP → browser
tak_launcher.py     — HTTP process manager (starts/stops listener & proxy)
start_tak_tools.sh  — One-click startup script (venv auto-detect, opens browser)
stop_tak_tools.sh   — Graceful shutdown script
tak_tools.desktop   — Linux desktop launcher (double-click to start)
README.md           — This file
```

---

## Quick Start

### One-time setup

```bash
chmod +x start_tak_tools.sh stop_tak_tools.sh
```

Edit `start_tak_tools.sh` and set your virtual environment path:
```bash
VENV_PATH="/home/warthog/CoT_Tester/venv"
```

Install the required Python dependency:
```bash
pip install websockets
```

### Every session

```bash
./start_tak_tools.sh
```

This will:
1. Activate the Python virtual environment
2. Start `tak_launcher.py` in the background (HTTP API on `localhost:8766`)
3. Open `index.html` in your default browser automatically

To stop everything:
```bash
./stop_tak_tools.sh
```

Or double-click `tak_tools.desktop` if you've placed it on your Linux desktop.

---

## Panel Overview

### 🚀 Process Launcher
Starts and stops `tak_listener.py` and `tak_cot_proxy.py` directly from the browser — no terminal needed. Configure host, port, callsign, and other options per-process. Live stdout logs are streamed to tabbed log display.

**Setup:** Click **⚡ Connect to Launcher** first, then use the Start buttons.

---

### 📻 Live TAK Listener
Receives CoT messages from your TAK server in real time via WebSocket bridge (`tak_listener.py`).

**Features:**
- Message queue with inline XML display (toggle with **Show full XML** checkbox)
- Multi-dimensional filtering:
  - **Type toggles:** 🚨 Emergency, 📍 SA, 💬 Chat, 📌 Spot, ✏️ Drawing, 🗑️ Delete, ❓ Other
  - **Affiliation toggles:** Friendly / Hostile / Unknown / Neutral / Non-SA
  - **Text search:** substring match on callsign, UID, or type
  - **UID blocklist:** comma-separated UIDs to always hide
  - **Type prefix blocklist:** hide entire type families (e.g. `t-x-c-t` to suppress SA pings)
- Click any message to select it and show the full XML in a detail pane
- **↑ Load into Analyzer** button sends selected message to the Raw CoT Analyzer
- **Auto-analyze** checkbox (off by default) — automatically feeds every incoming message into the analyzer
- Pause/resume when inspecting a specific message

---

### 🔍 Raw CoT Analyzer
Paste any CoT XML to parse and inspect it.

**Features:**
- Full field-by-field breakdown table (type, how, uid, timestamps, coordinates, detail block)
- Human-readable CoT type decoding (e.g. `a-f-G-U-C` → Friendly Ground Unit Combat Arms)
- **▶ Send As-Is** — sends the XML exactly as pasted (useful for replaying captured messages)
- **▶ Send with Fresh Timestamps** — injects current time/start, recalculates stale
- **↓ Load into Form** — populates the Event Envelope form fields
- Inline send status feedback (⏳ / ✓ / ✗) next to the buttons

---

### 🗑️ Delete Marker
Removes markers from all connected ATAK devices. Two methods:

**⚡ Force Delete (recommended)** — Sends `t-x-d-d` with `<__forcedelete/>`. Confirmed working on `<archive/>` markers that standard `t-x-d-d` cannot delete.

**🌊 Null Island Overwrite (fallback)** — Overwrites the marker's coordinates with `0°N 0°E` and an already-expired stale time, moving it off any tactical map.

**Usage:**
1. Paste the target CoT XML → click **↓ Parse** to auto-fill all fields
2. Select method
3. Choose repeat count (1× / 3× / 5× / 10×) — default 3× since ATAK sometimes needs multiple sends
4. Click **🗑️ Delete Marker**

> **Note:** Even Force Delete may not work on markers placed by another device with `<archive/>`. If both methods fail, the only guaranteed removal is long-press → Delete on the originating ATAK device.

#### CoT Delete Methods Reference

| Method | How | Works on `<archive/>`? |
|--------|-----|----------------------|
| `t-x-d-d` with `<link>` | Remote delete | ❌ No |
| `t-x-d-d` with `<__forcedelete/>` | Force delete | ✅ Yes |
| Null Island overwrite | Overwrite + expired stale | ✅ Yes (moves off map) |
| Long-press → Delete on device | Local delete | ✅ Always |

---

### Event Envelope + Detail Block
Form-based CoT builder for complete control over all CoT fields:
- UID, type, how, time/start/stale, coordinates, CE/LE
- Full detail block: contact, group, status, track, takv, precisionlocation, usericon, color, remarks
- Live XML preview updates as you type
- **▶ Send**, **⎘ Copy**, **↓ Download** buttons

---

### 📡 TAK Server — Send CoT
Connection configuration for all send operations:
- Server URL and API path (default: `http://localhost:8089/send` via `tak_cot_proxy.py`)
- Optional authentication headers
- Activity log with HTTP status codes and error details
- Repeat mode: send any message on a configurable interval

---

### 💬 GeoChat Message Composer
Builds `b-t-f` GeoChat messages:
- Direct message or broadcast to all
- Sender callsign and UID
- Message body
- Live XML preview

---

### 📍 Spot Map Marker Composer
Builds `b-m-p-s-m` spot map markers:
- Label, coordinates, color
- Persistent (1-year stale) or custom stale duration

---

### 🚨 Emergency Alert Composer
Builds `b-a-o-*` emergency alerts:

| Type | Meaning |
|------|---------|
| `b-a-o-opn` | In Contact — red flashing icon, audio alert |
| `b-a-o-tbl` | Troops in Contact — red flashing icon, audio alert |
| `b-a-o-pan` | Panic / 911 — urgent red alert, loudest audio |
| `b-a-o-can` | Cancel Emergency — clears alert on all devices |

Emergency UID convention: `{device_uid}-9-1-1`

Active alerts use a short stale (~16 seconds) and are re-broadcast by ATAK while active. Cancellations use `<emergency cancel="true">` with no type attribute.

---

### 📋 Preset CoT Examples
One-click presets for common CoT types. Click to preview, then send directly or copy XML. All timestamps are set to now at send time.

---

## Architecture

```
Browser (index.html)
├── cot_types.js      — type/how decoding
├── cot_parser.js     — XML parsing, analyzer, timestamp logic
├── cot_composer.js   — form builder, XML generation
├── cot_sender.js     — fetch() POST to proxy, repeat mode
└── cot_presets.js    — preset definitions

tak_launcher.py  ←→  HTTP API (localhost:8766)
├── /start/listener   start tak_listener.py subprocess
├── /start/proxy      start tak_cot_proxy.py subprocess
├── /stop/listener    stop listener
├── /stop/proxy       stop proxy
├── /stop/all         stop both (called on browser tab close)
├── /status           process status + PIDs
└── /logs/{script}    stdout ring buffer (last 500 lines)

tak_listener.py  ←→  WebSocket (localhost:8765)
└── Connects to TAK server TCP, bridges CoT XML to browser as JSON

tak_cot_proxy.py ←→  HTTP POST (localhost:8089/send)
└── Accepts XML from browser, forwards to TAK server TCP
```

---

## CoT Type Quick Reference

### Atom types (real entities)
```
a-f-G       Friendly Ground
a-f-G-U-C   Friendly Ground Unit Combat Arms
a-h-G       Hostile Ground
a-n-G       Neutral Ground
a-u-G       Unknown Ground
a-f-A       Friendly Air
```

### Bit types (data/events)
```
b-t-f         GeoChat direct message
b-m-p-s-m     Spot Map marker
b-m-p-w-GOTO  Mission waypoint (GOTO)
b-a-o-opn     Emergency — In Contact
b-a-o-tbl     Emergency — Troops in Contact
b-a-o-pan     Emergency — Panic/911
b-a-o-can     Emergency cancel
```

### Task/system types
```
t-x-d-d     Delete marker
t-x-c-t     TAK ping/heartbeat
t-k         TAK keepalive
```

### How codes
```
m-g         Machine GPS (autonomous/live position beacon)
h-g-i-g-o   Human tapped map (placed marker)
h-e         Human entered coordinates
```

---

## TAK Server Integration

### Using tak_cot_proxy.py (recommended)
Set the TAK Server panel to:
- **Server URL:** `http://localhost:8089`
- **API Path:** `/send`

Start the proxy via the Process Launcher panel before sending.

### Direct HTTP (advanced)
If your TAK server exposes an HTTP CoT endpoint with CORS headers, set the Server URL directly. This is uncommon on military/production TAK deployments.

### Self-signed TLS
If you get CORS/TLS errors when connecting directly: open the server URL in a new browser tab, accept the certificate warning, then retry.

---

## Known Limitations

- `t-x-d-d` without `<__forcedelete/>` does **not** delete `<archive/>` markers from remote senders
- Live SA beacons (`how="m-g"`) will reappear after deletion as long as the device keeps broadcasting
- `tak_launcher.py` is HTTP only (no authentication) — keep it on localhost
- Message queue is capped at 200 messages to keep DOM size manageable
