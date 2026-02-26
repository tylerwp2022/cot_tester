# TAK CoT Toolkit

A browser-based CoT message builder and local proxy for testing TAK server integrations. Designed for operators and developers who need to inspect, compose, and inject Cursor-on-Target messages without standing up a full ATAK instance.

---

## Files

| File | Purpose |
|------|---------|
| `cot_template_builder.html` | Browser UI — SA form, GeoChat composer, raw CoT analyzer, preset library |
| `tak_cot_proxy.py` | Local CORS proxy — bridges the browser to your TAK server over TCP, SSL, or HTTP |

---

## Quick Start

### 1. Start the proxy

```bash
# Plain TCP (TAK Server port 8088 — most common)
python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8088

# SSL/TCP
python3 tak_cot_proxy.py --tak-url tcps://10.10.10.3:8089

# HTTPS Marti REST API with self-signed cert
python3 tak_cot_proxy.py --tak-url https://10.10.10.3:8443 --tak-path /Marti/api/cot --no-verify-tls

# Custom proxy port + verbose output
python3 tak_cot_proxy.py --tak-url tcp://10.10.10.3:8088 --proxy-port 9000 --debug
```

### 2. Open the builder

Open `cot_template_builder.html` directly in any browser — no web server needed.

### 3. Configure the server connection

In the **TAK Server** section at the top:

```
Server URL:  http://localhost:8089
API Path:    /send
```

Adjust the port to match `--proxy-port` if you changed it (default: `8089`).

### 4. Verify connectivity

Click **▶ Test Connection** or `GET http://localhost:8089/health` — the proxy will report its current config and TAK server reachability.

---

## TAK Server Ports Reference

| Port | Protocol | Notes |
|------|----------|-------|
| 8087 | TCP (CoT stream) | TAK Server default TCP |
| 8088 | TCP (CoT + HTTP) | Confirmed working for CoT injection |
| 8089 | SSL/TCP | TAK Server encrypted TCP |
| 8443 | HTTPS | Marti REST API (`/Marti/api/cot`) |
| 19023 | TCP / HTTP | FreeTAK Server |

---

## CoT Template Builder

### Situational Awareness Form

Builds standard `a-f-*` position report CoT events. Fill in callsign, UID, coordinates, symbol code, and stale time, then **Send SA** or **Copy XML**.

**Symbol code quick reference (MIL-STD-2525C):**

| Code | Type |
|------|------|
| `a-f-G-U-C` | Friendly Ground Unit (Combat) |
| `a-f-G-E-V` | Friendly Ground Equipment / Vehicle |
| `a-f-A-C-F` | Friendly Fixed-Wing Aircraft |
| `a-f-A-M-F-Q` | Friendly UAV |
| `a-h-G-U-C` | Hostile Ground Unit |
| `a-n-G` | Neutral Ground |
| `a-u-G` | Unknown Ground |

### GeoChat Message Composer

Builds `b-t-f` GeoChat messages. Select a **mode** using the radio buttons, fill in the fields, and click **▶ Send Chat** or **⎘ Copy XML**. The XML preview updates live as you type.

#### Message Modes

| Mode | `parent` | `id` field | Use case |
|------|----------|-----------|---------|
| **Direct Message** | `RootContactGroup` | Recipient device UID | 1-to-1 message to a specific device |
| **Group Message** | `UserGroups` | Group UUID | User-created named group with explicit roster |
| **Team Color** | `TeamGroups` | Color name | All devices with matching `__group` color |
| **Role Broadcast** | `RootContactGroup` | Role name (e.g. `HQ`) | All devices with a specific role |
| **🔴 All Chat Rooms** | `RootContactGroup` | `"All Chat Rooms"` | Every connected device — no roster needed |
| **🟠 All Groups** | `RootContactGroup` | `"UserGroups"` | All members of all user-created groups |
| **🟢 All Teams** | `RootContactGroup` | `"TeamGroups"` | All members of all team color groups |

**Sender / recipient UIDs:**
- ATAK devices: `ANDROID-<hex>` (find in ATAK → Settings → About)
- Warthog robots: `warthog1`, `warthog2`, etc. (same value for both chatroom and UID)
- Lat/lon are borrowed from the SA form fields if filled; otherwise default to `0.0, 0.0`

#### Group Message notes
- **Group UUID** — generate once with ⚄ Gen and reuse it across messages to maintain group continuity in ATAK's chat history
- **Sender is automatically uid0** — add all other members with **+ Add Member**
- `<hierarchy>` roster is generated automatically from the member list

#### Team Color dropdown
Cyan, Blue, Red, Green, Yellow, White, Purple, Maroon — matching the standard ATAK team colors.

#### Role Broadcast notes
- Built-in roles: HQ, Team Lead, Team Member, Sniper, Medic, Forward Observer, RTO, K9
- **Custom…** option accepts any free-text role name
- Recipients must be listed explicitly (unlike Team Color which uses implicit `__group` matching)

### Preset Library

Pre-built templates for common message types. Click a preset to see its description, then:
- **↑ Load into Form** — populates the SA form or Chat Composer fields for editing
- **⎘ Copy XML** — copies the raw CoT XML to clipboard
- **▶ Send Preset** — sends directly to the TAK server

Included presets: Friendly Ground Unit, Friendly UGV, Friendly UAV, Hostile Ground Unit, TAK Ping (t-x-c-t), GeoChat Direct Message.

### Raw CoT Analyzer

Paste any CoT XML into the analyzer to get a human-readable breakdown of every field. Recognizes all message types:

| Type | Description |
|------|-------------|
| `a-f-*` | SA beacon / position report |
| `b-t-f` | GeoChat message (all subtypes — see table above) |
| `b-t-f-d` | Delivery receipt (auto-generated by receiving device) |
| `b-t-f-r` | Read receipt (auto-generated when user opens message) |
| `b-f-t-r` | File transfer request (peer-to-peer file negotiation) |
| `t-x-d-d` | Delete/drop entity from COP |
| `t-x-c-t` | TAK ping / keepalive |

For GeoChat messages the analyzer extracts: message text, sender/recipient callsigns and UIDs, message UUID, group membership (for UserGroups messages), team color, role, server destination, and delivery/read receipt linkage back to the original message.

---

## tak_cot_proxy.py

### Why it's needed

Browsers block cross-origin requests (CORS policy) and cannot open raw TCP sockets. The proxy runs on localhost, accepts HTTP POSTs from the builder, and forwards CoT XML to the TAK server using whichever protocol it actually speaks.

```
Browser → POST http://localhost:8089/send → Proxy → TAK Server (TCP/SSL/HTTP)
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/send` | POST | Forward CoT XML body to TAK server |
| `/health` | GET | JSON status — current config + connectivity |
| `/test` | GET | Send a minimal `t-x-c-t` ping and report result |

### Protocol support

| URL scheme | Transport | Example |
|-----------|-----------|---------|
| `tcp://` | Raw TCP socket | `tcp://10.10.10.3:8088` |
| `tcps://` | SSL/TLS over TCP | `tcps://10.10.10.3:8089` |
| `http://` | HTTP POST | `http://10.10.10.3:8088` |
| `https://` | HTTPS POST | `https://10.10.10.3:8443` |

**Note:** `__serverdestination` in CoT XML always says `tcp` regardless of whether the connection is SSL-wrapped — SSL is a transport-layer concern and does not affect the CoT payload structure.

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--tak-url` | `tcp://10.10.10.3:8088` | TAK server URL |
| `--tak-path` | `/` | API path (HTTP/HTTPS only) |
| `--proxy-port` | `8089` | Local port to listen on |
| `--no-verify-tls` | (off) | Skip TLS cert verification (self-signed certs) |
| `--debug` | (off) | Verbose logging |

### Requirements

Python 3.7+ standard library only — no pip installs needed.

---

## Known CoT Patterns

### Null position signature

```xml
<point lat="0.0" lon="0.0" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
```

Seen on TAK server-relayed messages from devices with no GPS fix. `hae="9999999.0"` is the sentinel value for unknown altitude.

### SSL vs TCP

The CoT XML payload is identical whether the connection uses plain TCP or SSL. The `tcp` token in `__serverdestination` refers to the logical delivery protocol (stream vs UDP multicast), not encryption status.

### Incoming message filter for robots

When a robot (`warthog1`) is registered on a TAK server, it may receive broadcast messages it should ignore as commands. Safe skip conditions:

```
id = "All Chat Rooms"   → global broadcast
id = "UserGroups"       → all groups broadcast
id = "TeamGroups"       → all teams broadcast
id ∈ {team colors}      → team color broadcast (Cyan, Blue, Red, ...)
parent = "UserGroups"   → user-created group message
```

Process as a command only when: `type = b-t-f` AND `parent = RootContactGroup` AND `id = warthog1` (direct message).
