# TAK CoT Toolkit

A browser-based CoT message builder and local proxy for testing TAK server integrations. Designed for operators and developers who need to inspect, compose, and inject Cursor-on-Target messages without standing up a full ATAK instance.

---

## Files

| File | Purpose |
|------|---------|
| `cot_template_builder.html` | Browser UI — SA form, GeoChat composer, spot map composer, raw CoT analyzer, preset library |
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

### Spot Map Marker Composer

Builds `b-m-p-s-m` persistent map pin events. Key differences from SA beacons: stale is 1 year, `<archive/>` is always present, and color/icon are encoded differently.

**Fields:**
- **Marker Label** — `<contact callsign>`, the text shown on the map pin
- **Marker UID** — stable UID; resending with the same UID moves the existing pin instead of creating a new one (⚄ Gen for a fresh UUID)
- **Color** — signed 32-bit ARGB integer; see palette below
- **Icon Set Path** — auto-derived from ARGB for color dots (`COT_MAPPING_SPOTMAP/b-m-p-s-m/{argb}`); select **Text Label only** for a text-only pin with no dot icon
- **Creator** — callsign, UID, and SA type of the device placing the marker

**Spot map color palette (all 11 colors verified from real ATAK traffic):**

| Color | ARGB | Hex |
|-------|------|-----|
| White | `-1` | `0xFFFFFFFF` |
| Yellow | `-256` | `0xFFFFFF00` |
| Orange | `-35072` | `0xFFFF7700` |
| Red | `-65536` | `0xFFFF0000` |
| Magenta | `-65281` | `0xFFFF00FF` |
| Cyan | `-16711681` | `0xFF00FFFF` |
| Blue | `-16776961` | `0xFF0000FF` |
| Green | `-16711936` | `0xFF00FF00` |
| Brown | `-7650029` | `0xFF8B4513` |
| Gray | `-8947849` | `0xFF777777` |
| Black | `-16777216` | `0xFF000000` |

Note: "Magenta" appears pinkish-purple in ATAK but decodes to pure `RGB(255,0,255)`. All values are signed 32-bit; convert via `value >>> 0` for unsigned hex.

**Spot map icon variants:**

| Iconset path | Visual |
|---|---|
| `COT_MAPPING_SPOTMAP/b-m-p-s-m/{argb}` | Colored dot |
| `COT_MAPPING_SPOTMAP/b-m-p-s-m/LABEL` | Text only — callsign rendered as map text, no dot |
| `COT_MAPPING_2525C/b-m-p-s-m/b-m-p-s-m` | MIL-STD-2525C marker symbol |

**GPS-placed vs manually-placed markers:**
- GPS drop: `ce="10.0"`, `<precisionlocation geopointsrc="GPS" altsrc="GPS"/>`
- Manual long-press: `ce="9999999.0"`, `<precisionlocation altsrc="SRTM1"/>` (no `geopointsrc`)

### Preset Library

Pre-built templates for common message types. Click a preset to see its description, then:
- **↑ Load into Form** — populates the SA form, Chat Composer, or Spot Map Composer fields for editing
- **⎘ Copy XML** — copies the raw CoT XML to clipboard
- **▶ Send Preset** — sends directly to the TAK server

**Included presets:**

| Preset | Type | Notes |
|--------|------|-------|
| 🟦 Friendly Ground Marker | `a-f-G` | Long-press drop pin |
| 📍 SA Beacon (Infantry) | `a-f-G-U-C` | Standard human ATAK user |
| 🤖 UGV Position Report | `a-f-G-U-C-R` | Combat Reconnaissance classification |
| 🚁 Quadcopter UAV | `a-f-G-U-C-R-Q` | Parrot Anafi / rotary UAV |
| ✈️ Generic UAV | `a-f-A-M-F-Q` | Platform type unspecified |
| 🟥 Hostile Vehicle | `a-h-G-E-V` | Hostile ground vehicle |
| ❓ Unknown Ground Contact | `a-u-G` | Pending classification |
| 💬 GeoChat Direct Message | `b-t-f` | Loads into Chat Composer |
| ⬜ Spot Map Marker (White) | `b-m-p-s-m` | Loads into Spot Map Composer |
| 🚩 Mission Waypoint (GOTO) | `b-m-p-w-GOTO` | Green flag, 5-min stale, auto-generated callsign |
| 🟠 Drawing Circle | `u-d-c-c` | Orange circle with semi-transparent fill |
| 🔷 NAI Polygon | `u-d-f` | Named Area of Interest, transparent fill |
| 📏 Phase Line | `u-d-f` | MIL-STD-2525C `G*G*GLP`, "PL" endpoint labels |
| ☢️ TAK Ping | `t-x-c-t` | Connectivity test / keepalive |

### Raw CoT Analyzer

Paste any CoT XML into the analyzer to get a human-readable breakdown of every field. Recognizes all message types:

| Type | Description |
|------|-------------|
| `a-f-*` | SA beacon / position report |
| `b-t-f` | GeoChat message (all 7 subtypes — see table above) |
| `b-t-f-d` | Delivery receipt (auto-generated by receiving device) |
| `b-t-f-r` | Read receipt (auto-generated when user opens message) |
| `b-f-t-r` | File transfer request (peer-to-peer file negotiation) |
| `b-m-p-s-m` | Spot map marker — decodes ARGB color to hex + name, creator metadata, GPS vs manual placement |
| `b-m-p-w-GOTO` | Mission waypoint — decodes variant (GOTO/HOLD/JTAC/SAR), flags auto-generated callsign format |
| `u-d-f` | User-drawn line / polygon — vertex list, closed polygon detection, stroke + fill color |
| `u-d-c-c` | User-drawn circle / ellipse — radius per ring, height in m + ft, extrude mode |
| `t-x-d-d` | Delete/drop entity from COP |
| `t-x-c-t` | TAK ping / keepalive |

**Drawn shape details (`u-d-f` and `u-d-c-c`):**

These types have fundamentally different geometry encodings from point markers and from each other:

`u-d-f` (line/polygon): `<point>` is a centroid/anchor only; actual vertices are in `<link point="lat,lon,hae"/>` elements. The analyzer detects open polylines vs closed polygons (first vertex repeated at end). `<color value="">` uses `value=` not `argb=`. Phase lines use `<__milsym id="G*G*GLP---****X"/>` to drive "PL" endpoint labels; NAI polygons use `G*G*SAN---****X` for the center "NAI" label.

`u-d-c-c` (circle): `<point>` is the actual circle center. Radius is in `<shape><ellipse major minor angle/>`. Multiple `<ellipse>` elements inside `<shape>` = concentric rings (ATAK doubles the radius for each additional ring by default). Additional fields: `<height value="">` (meters, displayed as m + ft), `<extrudeMode value="dome|extrude|none">` (3D rendering mode). No `<color value="">` element.

**Color field variants across types:**
- SA beacons: no color field
- Spot map markers: `<color argb="-1"/>` — uses `argb=` attribute
- Drawn shapes (`u-d-f`): `<color value="-1"/>` — uses `value=` attribute (same signed ARGB integer)
- Circles (`u-d-c-c`): no `<color>` element; color only in `strokeColor`/`fillColor` + embedded KML style

**KML style blocks:** Circles embed a `<Style>` block inside `<shape><link type="b-x-KmlStyle">`. The `<color>` strings within use ARGB hex (not standard KML ABGR byte order — ATAK uses ARGB throughout). The analyzer flags this and cross-references the `strokeColor`/`fillColor` attributes.

**Fill color alpha:** `fillColor="385840896"` = `0x16FF7700` — alpha byte `0x16` = 22/255 ≈ 8% opacity (the default semi-transparent circle fill). `fillColor="0"` = fully transparent (NAI outline-only). The analyzer displays alpha as both a raw value and a percentage.

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

### Spot map marker — duplicate `<archive/>` tag

ATAK sometimes emits two `<archive/>` elements in the same marker. This is a client-side quirk with no functional effect — the TAK server and other ATAK devices treat it as a single archive flag.

### Mission waypoint callsign format

ATAK auto-generates waypoint callsigns as `{creatorCallsign}.{dayOfMonth}.{HHMMSS}` (e.g. `TRILL3.27.153419`). These are not operator-set labels. The green flag icon for `b-m-p-w-GOTO` is driven entirely by the type suffix — no `<usericon>` or meaningful `<color>` field is present.

### Drawn shape geometry encoding

`u-d-f` and `u-d-c-c` use `how="h-e"` (human entered), not the `how="h-g-i-g-o"` (map tap) seen on spot map markers and waypoints. The `<point>` tag plays different roles:

- `u-d-f`: centroid/anchor only — not a vertex
- `u-d-c-c`: actual circle center
- All point markers (`a-f-*`, `b-m-p-*`): actual position

Closed polygons (`u-d-f`) repeat the first `<link point>` vertex at the end to signal closure. The TAK server and ATAK clients both rely on this convention — do not omit the closing repeat.

### Concentric rings (`u-d-c-c`)

Multiple `<ellipse>` elements inside `<shape>` define concentric rings sharing the same center. ATAK's default behavior when adding a second ring is to double the first ring's radius. All rings share the same `strokeColor`, `fillColor`, and style attributes — there is no per-ring styling.

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

### File transfer (`b-f-t-r`) — lasso send to robot

When an ATAK user lasso-selects multiple map objects and sends them to a specific device, the recipient receives a single `b-f-t-r` event containing a download URL for a `transfer.zip`. The ZIP contains individual CoT XML files — one per selected object.

**Key fields:**

| Field | Example | Notes |
|-------|---------|-------|
| `senderUrl` | `https://10.10.10.3:8443/Marti/sync/content?hash=...` | Marti sync endpoint — HTTPS GET |
| `sha256` | 64-char hex | Verify after download |
| `sizeInBytes` | `3451` | ZIP size in bytes |
| `stale` | 10s after `time` | **Download window** — must fetch before stale |

**ce/le = NaN:** `b-f-t-r` events use `ce="NaN"` and `le="NaN"` for unknown precision — distinct from the `9999999.0` sentinel used everywhere else.

**Fetch workflow for warthog1:**

```
1. Receive b-f-t-r
2. GET senderUrl  ←── must happen before stale (~10s window)
      └─ HTTPS GET https://{server}:8443/Marti/sync/content?hash={sha256}
3. Verify sha256
4. Unzip transfer.zip
5. Parse each .cot / .xml file inside:
      ├─ u-d-f       → phase line
      ├─ b-m-p-s-m   → spot map marker (×N)
      ├─ u-d-c-c     → circle
      └─ ...
6. (Optional) send b-f-t-r-ack:
      ackrequest uid from original message, ackrequested="true"
```

**Note on the `<point>` position:** The lat/lon on the `b-f-t-r` event itself is the centroid of all lasso-selected objects — not the position of any individual object. Individual object positions are inside the ZIP.

### TAK server protocol handshake (`t-x-takp-v`)

Sent by the TAK server to every connecting client immediately on connection — before any SA or chat traffic. The client must respond with the same type to complete the negotiation and select a protocol version.

```xml
<TakControl>
  <TakProtocolSupport version="1"/>
  <TakServerVersionInfo serverVersion="5.2-DEV-47-HEAD" apiVersion="3"/>
</TakControl>
```

| Field | Value | Meaning |
|-------|-------|---------|
| `how` | `m-g` | Machine-generated — only server control messages use this value |
| `TakProtocolSupport version` | `1` | TAK streaming protocol v1 (protobuf framing, port 8089+) |
| `serverVersion` | `5.2-DEV-47-HEAD` | TAK Server software version |
| `apiVersion` | `3` | Marti REST API version — governs available `/Marti/` endpoints |
| `ce` / `le` | `999999` | 6-nines sentinel — server control messages, no geographic context |

**`ce="999999"` vs `ce="9999999.0"`:** Server control messages use 6 nines; SA beacons, drawn shapes, and most other types use 7 nines (`9999999.0`). Both mean "unknown/unconstrained" but are structurally distinct.

**Client response:** Send back a `t-x-takp-v` with `<TakProtocolSupport version="1"/>` to tell the server which protocol version the client has selected for the session. If warthog1 does not respond, some TAK server versions will close the connection or fall back to a legacy unframed mode.
