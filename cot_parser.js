// =============================================================================
// cot_parser.js — Raw CoT XML Analyzer
//
// PURPOSE:
//   Accepts raw CoT XML (or stream-wrapped variants) and produces a structured
//   field breakdown table. Also provides "load into form" and "send raw"
//   functionality so captured CoT messages can be edited and re-transmitted.
//
// SUPPORTED INPUT FORMATS (auto-detected):
//   1. Plain CoT XML        — used as-is
//   2. TAK server stream    — "data: '<?xml...'" wrapper stripped
//   3. ROS2 topic echo      — "data: \"...\"" with escaped quotes/newlines
//
// DEPENDS ON:
//   cot_types.js  — describeType(), describeHow(), timeUntil(), nowISO()
//   cot_sender.js — sendRawXml(), appendLog(), setStatus()
//   cot_composer.js — generateXML(), buildChatXml(), buildSpotXml() (for load-into-form)
//
// EXPORTS (global functions used by HTML onclick handlers):
//   parseRawCoT()        — parse and display the analysis table
//   parseAndLoad()       — parse then populate all form fields
//   parseAndSend()       — parse and send the XML as-is (no timestamp refresh)
//   parseAndSendFresh()  — parse, inject fresh timestamps, then send
//   clearParseResults()  — clear the analysis panel
//
// INTERNAL STATE:
//   window._parsedCoT    — last parse result, used by parseAndLoad to avoid
//                          re-parsing when Load is clicked after Analyze
// =============================================================================


// =============================================================================
// SECTION: XML PARSING UTILITIES
// Small helpers that extract attributes and text from a parsed DOM document.
// These reduce boilerplate throughout parseRawCoT().
// =============================================================================

/**
 * Get the trimmed text content of the first matching element.
 * @param {Document} doc
 * @param {string} tag - CSS selector or tag name
 * @returns {string|null}
 */
function xmlText(doc, tag) {
  const el = doc.querySelector(tag);
  return el ? el.textContent.trim() : null;
}

/**
 * Get the value of a named attribute from the first matching element.
 * @param {Document} doc
 * @param {string} selector - CSS selector
 * @param {string} attr     - Attribute name
 * @returns {string|null}
 */
function xmlAttr(doc, selector, attr) {
  const el = doc.querySelector(selector);
  return el ? el.getAttribute(attr) : null;
}


// =============================================================================
// SECTION: INPUT PREPROCESSING
// Strip transport-layer wrappers before parsing the XML.
// =============================================================================

/**
 * Strip the wrapping added by the TAK server stream or ROS2 topic echo.
 *
 * TAK server stream adds:      data: '<?xml...'
 * ROS2 topic echo adds:        data: "<?xml version=\"1.0\"...\n<event..."
 *
 * WHY CHECK FOR \\": The presence of escaped double-quotes is a reliable
 * indicator of ROS2 string escaping. If we find \\", we unescape the whole
 * string rather than just stripping the outer quotes — order matters because
 * unescaping first would break the outer quote detection.
 *
 * @param {string} raw - Raw input from the textarea
 * @returns {string}   - Clean CoT XML string
 */
function stripStreamWrapper(raw) {
  let s = raw.trim();

  // ── ROS2 topic echo format ────────────────────────────────────────────────
  if (s.includes('\\"')) {
    // Strip outer data: "..." wrapper if present
    s = s.replace(/^data:\s*["']/, '').replace(/["']\s*$/, '');
    // Unescape all ROS2-style escape sequences
    s = s
      .replace(/\\"/g,  '"')   // \" → "
      .replace(/\\n/g,  '\n')  // \n → newline
      .replace(/\\t/g,  '\t')  // \t → tab
      .replace(/\\\\/g, '\\'); // \\ → backslash
    return s.trim();
  }

  // ── TAK server stream format ──────────────────────────────────────────────
  s = s.replace(/^data:\s*['"]/, '').replace(/['"]\s*$/, '');
  return s.trim();
}

/**
 * Replace time/start/stale attributes in a CoT XML string with fresh values.
 *
 * WHY REGEX NOT DOM: Parsing, modifying, and re-serializing through DOMParser
 * would strip XML comments, reformat whitespace, and potentially alter
 * attribute order. Regex replacement is safer for round-trip fidelity.
 *
 * @param {string} xml      - CoT XML string to modify
 * @param {number} staleMins - Stale window in minutes from now (default: 5)
 * @returns {string}         - XML with updated timestamps
 */
function injectFreshTimestamps(xml, staleMins) {
  const now   = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stale = new Date(Date.now() + (staleMins || 5) * 60000)
                  .toISOString().replace(/\.\d{3}Z$/, 'Z');
  return xml
    .replace(/\btime="[^"]*"/,  `time="${now}"`)
    .replace(/\bstart="[^"]*"/, `start="${now}"`)
    .replace(/\bstale="[^"]*"/, `stale="${stale}"`);
}

/** Clear the analysis panel and reset internal parse state. */
function clearParseResults() {
  document.getElementById('parseResults').style.display     = 'none';
  document.getElementById('parseResultLabel').style.display = 'none';
  window._parsedCoT = null;
}


// =============================================================================
// SECTION: MAIN PARSER — parseRawCoT()
// Extracts every significant field from a CoT event and renders an annotated
// breakdown table. Handles all known CoT subtypes:
//   - SA beacons (a-f-G-U-C etc.)
//   - GeoChat messages (b-t-f) including all 7 delivery modes
//   - Chat delivery/read receipts (b-t-f-d, b-t-f-r)
//   - File transfer requests (b-f-t-r)
//   - Spot map markers (b-m-p-s-m)
//   - Mission waypoints (b-m-p-w-*)
//   - Drawn shapes (u-d-f, u-d-c-c)
// =============================================================================

/**
 * Parse the raw CoT XML from the input textarea and display the analysis table.
 *
 * Stores the parsed field values in window._parsedCoT so parseAndLoad()
 * can populate form fields without re-parsing.
 */
function parseRawCoT() {
  const raw = document.getElementById('rawCotInput').value;
  if (!raw.trim()) return;

  const cleaned = stripStreamWrapper(raw);

  // Show results area, hide any previous error
  document.getElementById('parseResultLabel').style.display = 'block';
  document.getElementById('parseResults').style.display     = 'block';
  document.getElementById('parseError').style.display       = 'none';
  document.getElementById('parseTable').style.display       = 'none';

  // Parse with DOMParser — handles malformed XML gracefully by returning
  // a document with a <parsererror> element rather than throwing
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(cleaned, 'application/xml');
  const parseErr = doc.querySelector('parsererror');

  if (parseErr) {
    document.getElementById('parseError').style.display  = 'block';
    document.getElementById('parseError').textContent    =
      `XML parse error: ${parseErr.textContent.trim().substring(0, 200)}`;
    return;
  }

  const event = doc.querySelector('event');
  if (!event) {
    document.getElementById('parseError').style.display = 'block';
    document.getElementById('parseError').textContent   =
      'No <event> element found. Is this valid CoT XML?';
    return;
  }

  // ── Extract event envelope ────────────────────────────────────────────────
  const uid     = event.getAttribute('uid')     || '';
  const type    = event.getAttribute('type')    || '';
  const how     = event.getAttribute('how')     || '';
  const time    = event.getAttribute('time')    || '';
  const start   = event.getAttribute('start')   || '';
  const stale   = event.getAttribute('stale')   || '';
  const access  = event.getAttribute('access')  || '';
  const version = event.getAttribute('version') || '';

  // ── Extract <point> ───────────────────────────────────────────────────────
  const point = doc.querySelector('point');
  const lat   = point?.getAttribute('lat')  || '';
  const lon   = point?.getAttribute('lon')  || '';
  const hae   = point?.getAttribute('hae')  || '';
  const ce    = point?.getAttribute('ce')   || '';
  const le    = point?.getAttribute('le')   || '';

  // ── Extract <detail> fields ───────────────────────────────────────────────
  const callsign    = xmlAttr(doc, 'contact',            'callsign')    || xmlAttr(doc, 'uid', 'Droid') || '';
  const endpoint    = xmlAttr(doc, 'contact',            'endpoint')    || '';
  const group       = xmlAttr(doc, '__group',             'name')        || '';
  const role        = xmlAttr(doc, '__group',             'role')        || '';
  const battery     = xmlAttr(doc, 'status',              'battery')     || '';
  const readiness   = xmlAttr(doc, 'status',              'readiness')   || '';
  const speed       = xmlAttr(doc, 'track',               'speed')       || '';
  const course      = xmlAttr(doc, 'track',               'course')      || '';
  const milsym      = xmlAttr(doc, '__milsym',            'id')          || '';
  const milicon     = xmlAttr(doc, '__milicon',           'id')          || '';
  const usericon    = xmlAttr(doc, 'usericon',            'iconsetpath') || '';
  const device      = xmlAttr(doc, 'takv',                'device')      || '';
  const platform    = xmlAttr(doc, 'takv',                'platform')    || '';
  const os          = xmlAttr(doc, 'takv',                'os')          || '';
  const ver         = xmlAttr(doc, 'takv',                'version')     || '';
  const geopointsrc = xmlAttr(doc, 'precisionlocation',   'geopointsrc') || '';
  const altsrc      = xmlAttr(doc, 'precisionlocation',   'altsrc')      || '';
  const remarks     = xmlText(doc, 'remarks')                            || '';
  const linkUid     = xmlAttr(doc, 'link',                'uid')         || '';
  const linkCall    = xmlAttr(doc, 'link',                'parent_callsign') || '';
  const linkRel     = xmlAttr(doc, 'link',                'relation')    || '';
  const linkType    = xmlAttr(doc, 'link',                'type')        || '';
  const hasArchive     = !!doc.querySelector('archive');
  // Presence of <__forcedelete/> distinguishes force-delete from standard t-x-d-d.
  // The element carries no attributes — its presence alone signals the method.
  const hasForceDelete = !!doc.querySelector('__forcedelete');
  // Spot map markers use <color argb="">; drawn shapes use <color value="">
  const colorArgb   = xmlAttr(doc, 'color', 'argb')  || '';
  const colorValue  = xmlAttr(doc, 'color', 'value') || '';
  const creatorUid  = xmlAttr(doc, 'creator', 'uid')      || '';
  const creatorCall = xmlAttr(doc, 'creator', 'callsign') || '';
  const creatorTime = xmlAttr(doc, 'creator', 'time')     || '';
  const creatorType = xmlAttr(doc, 'creator', 'type')     || '';

  // ── Drone sensor/camera fields ────────────────────────────────────────────
  // <sensor> drives the camera footprint wedge overlay on the ATAK map.
  //   azimuth    — camera horizontal pointing direction (degrees, true north)
  //   elevation  — gimbal pitch below/above horizon (negative = below horizon)
  //   fov        — horizontal field of view (degrees)
  //   vfov       — vertical field of view (degrees)
  //   range      — footprint wedge depth (meters)
  //   roll       — gimbal roll (0 for gimbals with no roll axis, e.g. Anafi)
  //   displayMagneticReference — 0 = true north, 1 = magnetic north
  const sensorEl        = doc.querySelector('sensor');
  const sensorAzimuth   = sensorEl?.getAttribute('azimuth')                  || '';
  const sensorElevation = sensorEl?.getAttribute('elevation')                || '';
  const sensorFov       = sensorEl?.getAttribute('fov')                      || '';
  const sensorVfov      = sensorEl?.getAttribute('vfov')                     || '';
  const sensorRange     = sensorEl?.getAttribute('range')                    || '';
  const sensorRoll      = sensorEl?.getAttribute('roll')                     || '';
  const sensorMagRef    = sensorEl?.getAttribute('displayMagneticReference') || '';

  // <__video> carries the RTSP tap-to-view URL for drone camera live feed.
  // The double-underscore prefix is the CoT wire format for ATAK-proprietary
  // detail elements — it is NOT a JS naming convention; it appears verbatim in
  // the XML. Tapping the drone icon in ATAK opens this URL in its video panel.
  const videoEl  = doc.querySelector('__video');
  const videoUrl = videoEl?.getAttribute('url') || '';

  // ── Drawn shape fields (u-d-f, u-d-r, u-d-c-c) ───────────────────────────
  const strokeColor  = xmlAttr(doc, 'strokeColor',  'value') || '';
  const strokeWeight = xmlAttr(doc, 'strokeWeight', 'value') || '';
  const strokeStyle  = xmlAttr(doc, 'strokeStyle',  'value') || '';
  const fillColor    = xmlAttr(doc, 'fillColor',    'value') || '';
  const labelsOn     = xmlAttr(doc, 'labels_on',    'value') || '';
  // Vertex list for line/polygon — geometry lives in <link point="lat,lon,hae"> elements
  const vertexLinks  = [...doc.querySelectorAll('link[point]')].map(el => el.getAttribute('point'));
  // Circle/ellipse geometry lives in <shape><ellipse>
  const ellipseEls   = [...(doc.querySelector('shape')?.querySelectorAll('ellipse') || [])];
  const ellipseEl    = ellipseEls[0] || null;
  const ellipseMajor = ellipseEl?.getAttribute('major') || '';
  const ellipseMinor = ellipseEl?.getAttribute('minor') || '';
  const ellipseAngle = ellipseEl?.getAttribute('angle') || '';
  // KML style block embedded inside <shape><link type="b-x-KmlStyle"><Style>
  const kmlStyleEl   = doc.querySelector('shape > link[type="b-x-KmlStyle"] Style');
  const kmlLineColor = kmlStyleEl?.querySelector('LineStyle > color')?.textContent || '';
  const kmlLineWidth = kmlStyleEl?.querySelector('LineStyle > width')?.textContent || '';
  const kmlPolyColor = kmlStyleEl?.querySelector('PolyStyle > color')?.textContent || '';
  const extrudeMode  = xmlAttr(doc, 'extrudeMode', 'value') || '';
  const heightVal    = xmlAttr(doc, 'height',      'value') || '';

  // ── TAK server relay tag ──────────────────────────────────────────────────
  const flowTags  = doc.querySelector('_flow-tags_') || doc.querySelector('_flow_tags_');
  const takServer = flowTags
    ? [...flowTags.attributes].find(a => a.name.startsWith('TAK-Server-'))
    : null;

  // ── GeoChat fields (b-t-f) ────────────────────────────────────────────────
  const chatEl         = doc.querySelector('__chat');
  const chatroom       = chatEl?.getAttribute('chatroom')       || '';
  const chatId         = chatEl?.getAttribute('id')             || '';
  const senderCallsign = chatEl?.getAttribute('senderCallsign') || '';
  const messageId      = chatEl?.getAttribute('messageId')      || '';
  const chatParent     = chatEl?.getAttribute('parent')         || '';
  const groupOwner     = chatEl?.getAttribute('groupOwner')     || '';

  // Classify the chat delivery mode from parent/id combinations
  const isGroupChat    = chatParent === 'UserGroups';
  const isTeamChat     = chatParent === 'TeamGroups';
  const isAllChat      = chatId === 'All Chat Rooms';
  const isAllGroups    = chatId === 'UserGroups' && chatParent === 'RootContactGroup';
  const isAllTeams     = chatId === 'TeamGroups' && chatParent === 'RootContactGroup';

  const chatgrpEl  = doc.querySelector('chatgrp');
  const chatUid0   = chatgrpEl?.getAttribute('uid0') || '';
  const chatUid1   = chatgrpEl?.getAttribute('uid1') || '';
  // Collect all uid0/uid1/uid2/... from <chatgrp>
  const chatAllUids = chatgrpEl
    ? [...chatgrpEl.attributes]
        .filter(a => /^uid\d+$/.test(a.name))
        .sort((a, b) => parseInt(a.name.slice(3)) - parseInt(b.name.slice(3)))
        .map(a => a.value)
    : [];

  // Role broadcast: RootContactGroup parent, non-ANDROID id, multiple recipients
  const isRoleBroadcast = !isGroupChat && !isTeamChat && !isAllChat && !isAllGroups && !isAllTeams
    && chatId && !chatId.startsWith('ANDROID-') && chatAllUids.length > 2;

  // Group membership from <hierarchy>
  const hierarchyEl  = chatEl?.querySelector('hierarchy');
  const groupMembers = hierarchyEl
    ? [...hierarchyEl.querySelectorAll('contact')].map(el => ({
        uid:  el.getAttribute('uid')  || '',
        name: el.getAttribute('name') || '',
      }))
    : [];

  const serverDest    = xmlAttr(doc, '__serverdestination', 'destinations') || '';
  const remarksTo     = xmlAttr(doc, 'remarks', 'to')     || '';
  const remarksSource = xmlAttr(doc, 'remarks', 'source') || '';
  const remarksTime   = xmlAttr(doc, 'remarks', 'time')   || '';
  const messageText   = doc.querySelector('remarks')?.textContent?.trim() || '';

  // ── Chat attachments (<__chatlinks>) ──────────────────────────────────────
  const chatLinksEl   = doc.querySelector('__chatlinks');
  const chatLinkItems = chatLinksEl
    ? [...chatLinksEl.querySelectorAll('item')].map(el => ({
        uid:  el.getAttribute('uid')  || '',
        name: el.getAttribute('name') || '',
      }))
    : [];

  // ── Chat delivery receipt (<__chatreceipt>) ───────────────────────────────
  const receiptEl        = doc.querySelector('__chatreceipt');
  const receiptMessageId = receiptEl?.getAttribute('messageId')      || '';
  const receiptChatroom  = receiptEl?.getAttribute('chatroom')       || '';
  const receiptSender    = receiptEl?.getAttribute('senderCallsign') || '';
  const receiptId        = receiptEl?.getAttribute('id')             || '';

  // ── File transfer fields (<fileshare>) ────────────────────────────────────
  const fileshareEl      = doc.querySelector('fileshare');
  const fsFilename       = fileshareEl?.getAttribute('filename')       || '';
  const fsSenderUrl      = fileshareEl?.getAttribute('senderUrl')      || '';
  const fsSenderCallsign = fileshareEl?.getAttribute('senderCallsign') || '';
  const fsSenderUid      = fileshareEl?.getAttribute('senderUid')      || '';
  const fsSizeBytes      = fileshareEl?.getAttribute('sizeInBytes')    || '';
  const fsSha256         = fileshareEl?.getAttribute('sha256')         || '';
  const fsPeerHosted     = fileshareEl?.getAttribute('peerHosted')     || '';
  const fsName           = fileshareEl?.getAttribute('name')           || '';
  const ackEl            = doc.querySelector('ackrequest');
  const ackUid           = ackEl?.getAttribute('uid')          || '';
  const ackRequested     = ackEl?.getAttribute('ackrequested') || '';
  const ackTag           = ackEl?.getAttribute('tag')          || '';

  // ── Build the row array ───────────────────────────────────────────────────
  // Each row: { label, value, note, highlight, separator, unknown }
  const rows = [];

  // Helper — only adds row if value is non-empty
  const row = (label, value, note, highlight) => {
    if (value === null || value === undefined || String(value) === '') return;
    rows.push({ label, value: String(value), note: note || '', highlight: highlight || false });
  };

  // ── Event envelope ────────────────────────────────────────────────────────
  row('UID',      uid,     'Globally unique entity identifier');
  row('Type',     type,    describeType(type), true);
  row('How',      how,     describeHow(how));
  row('Time',     time,    '');
  row('Start',    start,   '');
  row('Stale',    stale,   timeUntil(stale), stale && new Date(stale) < new Date());
  row('Access',   access,  '');
  row('Version',  version, '');

  // ── Position ──────────────────────────────────────────────────────────────
  row('Latitude',  lat, '');
  row('Longitude', lon, '');
  row('HAE (m)',   hae, 'Height above WGS84 ellipsoid');
  row('CE (m)',    ce,  ce === '9999999.0' ? 'Unknown/unconstrained' : 'Circular error (horizontal accuracy)');
  row('LE (m)',    le,  le === '9999999.0' ? 'Unknown/unconstrained' : 'Linear error (vertical accuracy)');

  // ── Contact / detail ──────────────────────────────────────────────────────
  row('Callsign',    callsign,   '');
  row('Endpoint',    endpoint,   '');
  row('Group',       group,      '');
  row('Role',        role,       '');
  row('Battery %',   battery,    '');
  row('Readiness',   readiness,  '');
  row('Speed (m/s)', speed,      parseFloat(speed) > 0 ? 'Moving — orientation arrow visible in ATAK' : 'Stationary');
  row('Course (°)',  course,     course ? `${course}° true north` : '');
  row('Device',      device,     '');
  row('Platform',    platform,   '');
  row('OS',          os,         '');
  row('TAK Version', ver,        '');
  row('MilSym ID',   milsym,     'MIL-STD-2525C symbol code');
  row('MilIcon ID',  milicon,    '');
  row('User Icon',   usericon,   usericon.endsWith('/LABEL')
    ? 'Text label only — callsign rendered as map text, no dot icon'
    : 'ATAK icon set path');
  row('Geo Point Src', geopointsrc, '');
  row('Alt Source',    altsrc,      '');
  if (hasArchive) row('Archive', 'yes', 'Persistent — survives stale, saved to TAK server');

  // ── Mission waypoint annotation ───────────────────────────────────────────
  if (type && type.startsWith('b-m-p-w-')) {
    const wayptVariant = type.split('b-m-p-w-')[1];
    row('Waypoint Type', wayptVariant,
        'Mission symbol variant — drives icon/color in ATAK (GOTO=green flag). No <usericon> needed.');
    if (callsign && /^.+\.\d+\.\d{6}$/.test(callsign)) {
      row('Callsign Note', callsign,
          'Auto-generated by ATAK: {creatorCallsign}.{dayOfMonth}.{HHMMSS}');
    }
  }

  // ── Delete command analysis (t-x-d-d) ────────────────────────────────────
  // t-x-d-d is a fire-and-forget command, not a position entity. Two methods:
  //
  //   Force Delete  — event uid is a fresh command ID ("delete-cmd-{first8}"),
  //                   the TARGET uid lives in <link uid="...">, and
  //                   <__forcedelete/> is present. Works on <archive/> markers.
  //
  //   Null Island   — event uid IS the target uid. The entity is overwritten
  //                   in-place with lat=0/lon=0 and an already-expired stale,
  //                   moving it off the map. Fallback when force delete fails.
  //
  //   Standard      — plain t-x-d-d with <link>, no <__forcedelete/>.
  //                   Does NOT work on archived markers.
  if (type === 't-x-d-d') {
    rows.push({
      label: '── Delete Command ──',
      value: '',
      note: 'type t-x-d-d — removes an entity from the COP on all connected devices',
      separator: true,
    });

    if (hasForceDelete) {
      // Force delete: target is in <link uid>, not the event uid
      row('Delete Method', 'Force Delete',
          '<__forcedelete/> present — works on <archive/> markers. Recommended method.');
      row('Target UID', linkUid,
          'Entity to remove from the COP — from <link uid="...">. NOT the event uid (which is just a command ID).');
      if (linkRel) row('Link Relation', linkRel, 'Expected "none" on force delete commands');
      if (linkType) row('Link Type',    linkType, 'Expected "none" on force delete commands');
    } else {
      // Distinguish Null Island from standard t-x-d-d:
      // Null Island markers have lat≈0, lon≈0, and an already-expired stale.
      const isNullIsland = Math.abs(parseFloat(lat)) < 0.001
                        && Math.abs(parseFloat(lon)) < 0.001
                        && stale && new Date(stale) < new Date();

      if (isNullIsland) {
        row('Delete Method', 'Null Island Overwrite',
            'No <__forcedelete/> — overwrites entity to 0°N 0°E with expired stale. '
            + 'Moves marker off the map. Use when force delete fails.');
        row('Target UID', uid,
            'Event uid IS the target — Null Island overwrites the entity directly (same uid = update).');
        row('Overwrite Coords', `${lat}, ${lon}`, 'Null Island — 0°N 0°E, effectively off any tactical map');
        row('Stale', stale, '⚠️ Already expired — ATAK will remove the entity from the display');
      } else if (linkUid) {
        row('Delete Method', 'Standard t-x-d-d',
            'No <__forcedelete/> — may silently fail on markers with <archive/>. '
            + 'Use Force Delete for archived markers.');
        row('Target UID', linkUid,
            'Entity to remove — from <link uid="...">');
        if (linkRel) row('Link Relation', linkRel, '');
        if (linkType) row('Link Type',    linkType, '');
      } else {
        // Unusual t-x-d-d — no link, no forcedelete, not null island
        row('Delete Method', 'Unknown variant',
            'No <__forcedelete/> and no <link uid> found — structure may be non-standard.');
      }
    }
  }

  // ── Drawn shape analysis ──────────────────────────────────────────────────
  if (type && (type.startsWith('u-d-') || vertexLinks.length > 0 || ellipseEl)) {

    if (ellipseEl) {
      // Circle / ellipse (u-d-c-c) — center in <point>, radius in <shape><ellipse>
      const isCircle = Math.abs(parseFloat(ellipseMajor) - parseFloat(ellipseMinor)) < 0.001;
      rows.push({ label: '── Drawn Circle/Ellipse ──', value: '', note: `type ${type} — center in <point>; radius in <shape><ellipse>`, separator: true });
      row('Center',    `${lat}, ${lon}`, '<point> = actual circle center (unlike u-d-f where <point> is centroid only)');
      row('Ring Count', String(ellipseEls.length),
          ellipseEls.length > 1 ? `${ellipseEls.length} concentric rings` : 'Single ring');
      ellipseEls.forEach((el, i) => {
        const maj  = el.getAttribute('major') || '';
        const min  = el.getAttribute('minor') || '';
        const circ = Math.abs(parseFloat(maj) - parseFloat(min)) < 0.001;
        const lbl  = ellipseEls.length > 1 ? `Ring ${i + 1} Radius` : (isCircle ? 'Radius' : 'Major Axis');
        row(lbl, `${parseFloat(maj).toFixed(2)} m`,
            circ ? `Circular (major == minor == ${maj})` : `Ellipse: major=${maj} minor=${min}`);
      });
      row('Angle', ellipseAngle, '360 = full circle/ellipse (not an arc)');
      if (heightVal) {
        const hM = parseFloat(heightVal);
        row('Height (AGL)', `${hM} m (${(hM * 3.28084).toFixed(1)} ft)`,
            '<height value=""> — altitude above ground for 3D extrusion');
      }
      if (extrudeMode) {
        const extrudeDesc = { dome: 'Dome — hemisphere', extrude: 'Extrude — vertical walls', none: 'None — flat 2D' };
        row('Extrude Mode', extrudeMode, extrudeDesc[extrudeMode] || extrudeMode);
      }
      // KML colors use ARGB hex (ATAK extension — standard KML uses ABGR)
      if (kmlLineColor) row('KML Line Color', kmlLineColor, 'ARGB hex — mirrors strokeColor attribute');
      if (kmlLineWidth) row('KML Line Width', kmlLineWidth, 'Mirrors strokeWeight attribute');
      if (kmlPolyColor) {
        const pa = parseInt(kmlPolyColor, 16);
        const alpha = (pa >>> 24);
        row('KML Poly Color', kmlPolyColor,
            `ARGB hex — alpha=${alpha}/255 (~${Math.round(alpha/255*100)}% opacity)`);
      }
    } else {
      // Line / polygon (u-d-f) — <point> is centroid only, geometry in <link point>
      const isClosed   = vertexLinks.length > 2 && vertexLinks[0] === vertexLinks[vertexLinks.length - 1];
      const uniqueVerts = isClosed ? vertexLinks.slice(0, -1) : vertexLinks;
      const shapeDesc   = isClosed
        ? `Closed polygon (${uniqueVerts.length} unique vertices — first repeated at end to close)`
        : vertexLinks.length === 2
          ? 'Single line segment (2 endpoints)'
          : `Open polyline (${vertexLinks.length} vertices)`;

      rows.push({ label: '── Drawn Shape ──', value: '', note: `type ${type} — <point> is centroid only; geometry in <link point="...">`, separator: true });
      row('Centroid',  `${lat}, ${lon}`, '<point> anchor — not a vertex, used for map centering only');
      row('Geometry',  shapeDesc, '');
      uniqueVerts.forEach((pt, i) => {
        const [vlat, vlon, vhae] = pt.split(',');
        row(`Vertex ${i + 1}`, `${vlat}, ${vlon}`, `hae=${vhae} — <link point="${pt}"/>`);
      });
      if (isClosed) row('Closing Vertex', '(= Vertex 1)', 'First vertex repeated to close polygon — ATAK convention');
    }

    // Stroke / fill shared by both shape subtypes
    if (strokeColor) {
      const su  = parseInt(strokeColor) >>> 0;
      row('Stroke Color', `${strokeColor} → #${su.toString(16).padStart(8, '0').toUpperCase()}`,
          'Signed 32-bit ARGB — <strokeColor value="">');
    }
    if (fillColor !== '') {
      const fu    = parseInt(fillColor) >>> 0;
      const fhex  = '#' + fu.toString(16).padStart(8, '0').toUpperCase();
      const fAlpha = (fu >>> 24);
      const fillNote = fAlpha === 0
        ? 'Fully transparent fill (alpha=0) — outline only'
        : fAlpha === 255 ? 'Fully opaque fill'
        : `Semi-transparent fill (alpha=${fAlpha}/255, ~${Math.round(fAlpha/255*100)}% opacity)`;
      row('Fill Color', `${fillColor} → ${fhex}`, fillNote);
    }
    if (strokeWeight) row('Stroke Weight', strokeWeight, 'Line width in pixels');
    if (strokeStyle)  row('Stroke Style',  strokeStyle,  'solid | dashed | dotted');
    if (labelsOn)     row('Labels On',     labelsOn,     'Shape label visibility');
  }

  row('Remarks', remarks, '');

  // ── Drone sensor / camera footprint ───────────────────────────────────────
  // Show a sensor section only when a <sensor> or <__video> element is present.
  // Both are GARDx / drone-specific fields not seen in standard SA beacons.
  if (sensorEl || videoEl) {
    rows.push({
      label: '── Drone Camera ──',
      value: '',
      note: '<sensor> drives the camera footprint wedge on the ATAK map; <__video> is the tap-to-view RTSP link',
      separator: true,
    });

    if (videoUrl) {
      row('RTSP Stream', videoUrl,
          'Tap-to-view URL — operators tap the drone icon in ATAK to open this stream');
    }

    if (sensorAzimuth) {
      row('Camera Azimuth', `${sensorAzimuth}°`,
          'Horizontal pointing direction (true north). For Anafi: = drone body yaw (gimbal cannot pan independently)');
    }
    if (sensorElevation) {
      const elNum = parseFloat(sensorElevation);
      let elevNote = 'Gimbal pitch — negative = camera below horizon';
      if (elNum === -90)        elevNote = 'Nadir — camera pointing straight down';
      else if (elNum === 0)     elevNote = 'Horizontal — camera level with horizon';
      else if (elNum < 0)       elevNote = `Camera tilted ${Math.abs(elNum)}° below horizon`;
      else if (elNum > 0)       elevNote = `Camera tilted ${elNum}° above horizon`;
      row('Camera Elevation', `${sensorElevation}°`, elevNote);
    }
    if (sensorFov) {
      const fovLabel = sensorVfov
        ? `${parseFloat(sensorFov).toFixed(1)}° × ${parseFloat(sensorVfov).toFixed(1)}°`
        : `${parseFloat(sensorFov).toFixed(1)}°`;
      row('FOV (H × V)', fovLabel,
          sensorVfov
            ? 'Horizontal × Vertical field of view. Narrows as zoom increases.'
            : 'Horizontal field of view');
    }
    if (sensorRange) {
      row('Sensor Range', `${sensorRange} m`,
          'Wedge depth in meters — footprint projected on the map at this distance');
    }
    if (sensorRoll) {
      row('Gimbal Roll', `${sensorRoll}°`,
          sensorRoll === '0' ? 'No gimbal roll axis (standard for Anafi)' : 'Gimbal roll offset');
    }
    if (sensorMagRef !== '') {
      row('Mag Reference', sensorMagRef === '0' ? '0 (true north)' : `${sensorMagRef} (magnetic north)`,
          'displayMagneticReference — 0 = GPS true north headings');
    }
  }

  // ARGB color annotation
  const effectiveColor = colorArgb || colorValue;
  if (effectiveColor) {
    const unsigned = parseInt(effectiveColor) >>> 0;
    const hex = '#' + unsigned.toString(16).padStart(8, '0').toUpperCase();
    const COLOR_NAMES = {
      'FFFFFFFF': 'White',  'FF000000': 'Black',   'FFFF0000': 'Red',
      'FF00FF00': 'Green',  'FF0000FF': 'Blue',     'FFFFFF00': 'Yellow',
      'FF00FFFF': 'Cyan',   'FFFF7700': 'Orange',  'FF8B4513': 'Brown',
      'FFFF00FF': 'Magenta','FF800080': 'Purple',
    };
    const colorName = COLOR_NAMES[unsigned.toString(16).padStart(8,'0').toUpperCase()] || '';
    row('Color (ARGB)', `${effectiveColor} → ${hex}${colorName ? ' (' + colorName + ')' : ''}`,
        'Signed 32-bit ARGB integer. -1 = 0xFFFFFFFF = white.');
  }

  // Creator block
  if (creatorUid) {
    rows.push({ label: '── Creator ──', value: '', note: 'Device that originally placed this marker', separator: true });
    row('Creator Callsign', creatorCall, '');
    row('Creator UID',     creatorUid,  '');
    row('Creator Type',    creatorType, describeType(creatorType));
    row('Created At',      creatorTime, '');
  }

  // Link fields — shown generically for standard entity types.
  // For t-x-d-d, the link uid is the DELETE TARGET and is already shown in
  // the dedicated delete section above with full context. Suppress here to
  // avoid a redundant unlabeled "Link UID" row at the bottom of the table.
  if (type !== 't-x-d-d') {
    row('Link UID',      linkUid,  '');
    row('Link Callsign', linkCall, '');
    row('Link Relation', linkRel,  '');
    row('Link Type',     linkType, '');
  }

  if (takServer) {
    row('TAK Server Relay',
        takServer.name.replace('TAK-Server-', '').substring(0, 12) + '…',
        `Relayed at ${takServer.value}`);
  }

  // ── GeoChat analysis ──────────────────────────────────────────────────────
  if (chatEl) {
    const chatKind = isAllChat        ? 'GeoChat Global Broadcast (All Chat Rooms)'
                   : isAllGroups      ? 'GeoChat All Groups Broadcast'
                   : isAllTeams       ? 'GeoChat All Teams Broadcast'
                   : isTeamChat       ? 'GeoChat Team Color Broadcast'
                   : isGroupChat      ? 'GeoChat Group Message'
                   : isRoleBroadcast  ? 'GeoChat Role Broadcast'
                   :                    'GeoChat Direct Message';

    rows.push({ label: `── ${chatKind} ──`, value: '', note: `type b-t-f, parent=${chatParent}`, separator: true });
    row('Message',    messageText,    'The actual chat text', true);
    row('Sender',     senderCallsign, '');
    row('Sender UID', chatUid0,       'uid0 in <chatgrp>');

    if (isAllChat) {
      row('Broadcast',  'All Chat Rooms', 'Reserved literal — TAK server delivers to all connected devices');
      row('uid1',       chatUid1,         'Literal "All Chat Rooms" string, not a device UID');
      row('Remarks To', remarksTo,        'to="All Chat Rooms" present for global broadcast');
    } else if (isAllGroups) {
      row('Broadcast',  'All Groups', 'Reserved id="UserGroups" — delivers to all user-created group members');
      row('Chatroom',   chatroom,     'chatroom="Groups" — note this differs from id="UserGroups"');
      row('Recipients', chatAllUids.slice(1).join(', ') || '(none listed)', 'Explicit uid list');
    } else if (isAllTeams) {
      row('Broadcast',  'All Teams', 'Reserved id="TeamGroups" — delivers to all team color group members');
      row('Chatroom',   chatroom,    'chatroom="Teams" — note this differs from id="TeamGroups"');
      row('Recipients', chatAllUids.slice(1).join(', ') || '(none listed)', 'Explicit uid list');
    } else if (isTeamChat) {
      row('Team Color', chatroom, 'All devices with this __group color receive the message');
      row('Recipients', chatAllUids.slice(1).join(', ') || '(none listed)', 'uid1, uid2, ... from <chatgrp>');
    } else if (isGroupChat) {
      row('Group Name', chatroom,    'Display name of the group chatroom');
      row('Group UUID', chatId,      'Stable UUID for this group');
      row('Group Owner', groupOwner === 'true' ? 'yes (sender created group)' : 'no', '');
      if (groupMembers.length > 0) {
        groupMembers.forEach((m, i) => row(`Member ${i + 1}`, m.name, m.uid));
      } else {
        chatAllUids.slice(1).forEach((uid, i) => row(`Recipient ${i + 1}`, uid, ''));
      }
    } else if (isRoleBroadcast) {
      row('Role',       chatroom, 'All devices with this role receive the message');
      row('Recipients', chatAllUids.slice(1).join(', ') || '(none listed)', '');
    } else {
      row('Chatroom / To', chatroom, 'Direct message — chatroom = recipient callsign');
      row('Recipient UID', chatUid1,  'uid1 in <chatgrp>');
      row('Remarks To',    remarksTo, '');
    }

    row('Message ID',     messageId,     'UUID for this specific message');
    row('Chat Parent',    chatParent,    'RootContactGroup | UserGroups | TeamGroups');
    row('Remarks Source', remarksSource, '');
    row('Server Dest',    serverDest,    'Sender return address: ip:port:protocol:uid');

    if (chatLinkItems.length > 0) {
      rows.push({ label: '── Attachments ──', value: '', note: 'File transfer announcement', separator: true });
      chatLinkItems.forEach((item, i) => {
        row(`File ${i + 1}`, item.name, item.uid ? `Package UID: ${item.uid}` : 'No package UID', true);
      });
    }
  }

  // ── Chat receipt analysis ─────────────────────────────────────────────────
  if (receiptEl) {
    const receiptKind = type === 'b-t-f-r' ? 'Read Receipt (b-t-f-r)' : 'Delivery Receipt (b-t-f-d)';
    const receiptNote = type === 'b-t-f-r' ? 'User opened the message — auto-generated'
                                           : 'Message arrived at device — auto-generated';
    rows.push({ label: `── Chat ${receiptKind} ──`, value: '', note: receiptNote, separator: true });
    row('Acknowledged Msg', receiptMessageId, 'messageId of original b-t-f message', true);
    row('Recipient',        receiptSender,    'Callsign of device that received the message');
    row('Recipient UID',    receiptId,        '');
    row('Chatroom',         receiptChatroom,  '');
    row('Receiver Location', `${lat}, ${lon}`, "Receiver's GPS position at time of receipt");
  }

  // ── File transfer analysis ────────────────────────────────────────────────
  if (fileshareEl) {
    const staleMs   = stale ? new Date(stale) - new Date(time) : null;
    const staleNote = staleMs !== null
      ? `${(staleMs / 1000).toFixed(0)}s download window — fetch senderUrl before stale`
      : '';
    const isTransferZip = fsFilename === 'transfer.zip' || fsName === 'transfer';

    rows.push({ label: '── File Transfer ──', value: '', note: 'Fetch senderUrl within stale window, then unzip and parse each CoT file inside', separator: true });
    row('Filename',       fsFilename,   isTransferZip ? 'ATAK data package — ZIP contains CoT XML files' : '', true);
    row('Package Name',   fsName,       '');
    row('Size',           fsSizeBytes ? `${parseInt(fsSizeBytes).toLocaleString()} bytes` : '', '');
    row('Download URL',   fsSenderUrl,
        fsPeerHosted === 'true' ? 'Peer-hosted — direct device-to-device' : 'Server-hosted via Marti sync endpoint');
    row('SHA-256',        fsSha256,     'Verify integrity after download');
    row('From',           fsSenderCallsign, fsSenderUid);
    if (staleNote) row('Stale Window', stale, staleNote);
    if (ackEl)     row('Ack Requested', ackRequested, `Send b-f-t-r-ack with uid="${ackUid}" tag="${ackTag}"`);
    if (ce === 'NaN' || le === 'NaN') {
      row('CE / LE Note', 'NaN', 'b-f-t-r uses NaN for unknown precision (not 9999999.0 like SA beacons)');
    }
  }

  // ── Unrecognized detail fields ────────────────────────────────────────────
  // Walk <detail> children and flag anything not in the known-fields set.
  // These are passed through on raw send but lost if loading into the form.
  const knownDetailTags = new Set([
    'contact', '__group', 'uid', 'takv', 'track', 'status',
    'precisionlocation', 'archive', '__milicon', '__milsym',
    'usericon', 'link', 'creator', 'remarks', 'color',
    '_flow-tags_', '_flow_tags_',
    '__chat', 'chatgrp', '__serverdestination', '__chatlinks', '__chatreceipt',
    'hierarchy', 'group',
    'fileshare', 'ackrequest',
    '__shapeExtras', 'strokeColor', 'strokeWeight', 'strokeStyle', 'fillColor',
    'labels_on', 'shape', 'extrudeMode', 'height',
    // Drone / UAS fields
    'sensor',         // Camera footprint wedge overlay: azimuth, elevation, fov, vfov, range, roll
    '__video',        // Tap-to-view RTSP stream URL for drone live feed
    // Delete command fields
    '__forcedelete',  // Force delete marker — presence alone signals method; no attributes
  ]);

  const detailEl = doc.querySelector('detail');
  if (detailEl) {
    const unknownRows = [];
    for (const child of detailEl.children) {
      if (!knownDetailTags.has(child.tagName)) {
        const attrs   = [...child.attributes].map(a => `${a.name}="${a.value}"`).join('  ');
        const text    = child.textContent.trim();
        const display = attrs + (text ? (attrs ? '  ' : '') + `[text: ${text.substring(0, 80)}]` : '');
        unknownRows.push({ tag: child.tagName, display });
      }
    }
    if (unknownRows.length > 0) {
      rows.push({ label: '── Unrecognized ──', value: '', note: 'Fields not in known schema — preserved in raw send', separator: true });
      unknownRows.forEach(r => {
        rows.push({ label: `<${r.tag}>`, value: r.display || '(no attributes)', note: 'Unknown field — passed through on raw send, lost on Load into Form', unknown: true });
      });
    }
  }

  // ── Render the table ──────────────────────────────────────────────────────
  const tbody = document.getElementById('parseTableBody');
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');

    if (r.separator) {
      tr.style.cssText = 'background:#1a1400;';
      const td = document.createElement('td');
      td.colSpan = 2;
      td.style.cssText = 'padding:6px 8px;font-size:0.68rem;font-weight:700;color:#d29922;letter-spacing:0.06em;text-transform:uppercase;border-top:1px solid #d2992244;border-bottom:1px solid #d2992244;';
      td.textContent   = r.label;
      if (r.note) {
        const noteSpan = document.createElement('span');
        noteSpan.style.cssText = 'font-weight:400;font-size:0.65rem;color:#8b6914;margin-left:8px;text-transform:none;letter-spacing:0;';
        noteSpan.textContent   = r.note;
        td.appendChild(noteSpan);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    tr.style.borderBottom = '1px solid #21262d';
    if (r.highlight) tr.style.background = '#0d1a2e';
    if (r.unknown)   tr.style.background = '#1a1500';

    const tdLabel = document.createElement('td');
    tdLabel.style.cssText = 'padding:5px 8px;color:#8b949e;font-weight:500;vertical-align:top;white-space:nowrap;';
    if (r.unknown) tdLabel.style.color = '#d29922';
    tdLabel.textContent = r.label;

    const tdVal = document.createElement('td');
    tdVal.style.cssText = 'padding:5px 8px;vertical-align:top;';

    const valSpan = document.createElement('span');
    valSpan.style.cssText = 'font-family:"Courier New",monospace;font-size:0.7rem;word-break:break-all;';
    valSpan.style.color   = r.unknown ? '#e3b341' : '#79c0ff';
    valSpan.textContent   = r.value;
    tdVal.appendChild(valSpan);

    if (r.note) {
      const noteSpan = document.createElement('span');
      noteSpan.style.cssText = 'display:block;font-size:0.65rem;color:#6e7681;margin-top:2px;font-family:inherit;';
      if (r.unknown) noteSpan.style.color = '#8b6914';
      noteSpan.textContent = r.note;
      tdVal.appendChild(noteSpan);
    }

    tr.appendChild(tdLabel);
    tr.appendChild(tdVal);
    tbody.appendChild(tr);
  });

  document.getElementById('parseTable').style.display = 'block';

  // Store for parseAndLoad()
  window._parsedCoT = {
    cleaned, uid, type, how, time, start, stale,
    lat, lon, hae, ce, le,
    callsign, endpoint, group, role, battery, speed, course,
    device, platform, os, ver,
    milsym, usericon, geopointsrc, altsrc,
    hasArchive, remarks, linkUid, linkCall, linkRel, linkType,
    // Compute stale minutes from the difference — minimum 1 minute
    staleMins: Math.max(1, Math.round((new Date(stale) - new Date()) / 60000)) || 5,
  };
}


// =============================================================================
// SECTION: LOAD INTO FORM
// Populates the SA form fields from the last parse result.
// =============================================================================

/**
 * Parse the raw input then populate all SA form fields with the extracted values.
 * Also handles routing special types to their appropriate composer:
 *   b-m-p-s-m → Spot Map Composer
 *   b-t-f     → Chat Composer
 *   All others → SA Form
 */
function parseAndLoad() {
  parseRawCoT();
  const p = window._parsedCoT;
  if (!p) return;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  };

  // ── Route special types to the right composer ─────────────────────────────
  const parser = new DOMParser();
  const doc    = parser.parseFromString(p.cleaned, 'application/xml');
  const evType = doc.querySelector('event')?.getAttribute('type') || '';

  if (evType === 'b-m-p-s-m') {
    // Spot map marker → populate spot map composer
    set('spotUid',             doc.querySelector('event')?.getAttribute('uid') || '');
    set('spotCallsign',        doc.querySelector('contact')?.getAttribute('callsign') || '');
    set('spotLat',             doc.querySelector('point')?.getAttribute('lat') || '');
    set('spotLon',             doc.querySelector('point')?.getAttribute('lon') || '');
    set('spotHae',             doc.querySelector('point')?.getAttribute('hae') || '0.0');
    set('spotCe',              doc.querySelector('point')?.getAttribute('ce')  || '10.0');
    const creatorEl = doc.querySelector('creator');
    if (creatorEl) {
      set('spotCreatorCallsign', creatorEl.getAttribute('callsign') || '');
      set('spotCreatorUid',      creatorEl.getAttribute('uid')      || '');
      set('spotCreatorType',     creatorEl.getAttribute('type')     || 'a-f-G-U-C');
    }
    // Sync color selector
    const argb       = doc.querySelector('color')?.getAttribute('argb') || '-1';
    const colorSel   = document.getElementById('spotColor');
    const knownColors = [...colorSel.options].map(o => o.value);
    if (knownColors.includes(argb)) {
      colorSel.value = argb;
      document.getElementById('spotColorCustom').style.display = 'none';
    } else {
      colorSel.value = 'custom';
      document.getElementById('spotColorCustom').style.display = 'block';
      set('spotColorCustom', argb);
    }
    buildSpotXml();
    appendLog(`Loaded spot map preset into Spot Map Composer.`, 'info');
    document.getElementById('spotCallsign').closest('.panel').scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (evType === 'b-t-f') {
    // GeoChat → populate chat composer
    const chatEl    = doc.querySelector('__chat');
    const chatgrpEl = doc.querySelector('chatgrp');
    if (chatEl) {
      set('chatSenderCallsign', chatEl.getAttribute('senderCallsign') || '');
      set('chatRecipient',      chatEl.getAttribute('chatroom')       || '');
      set('chatRecipientUid',   chatEl.getAttribute('id')             || '');
    }
    if (chatgrpEl) {
      set('chatSenderUid', chatgrpEl.getAttribute('uid0') || '');
    }
    const serverDest = doc.querySelector('__serverdestination')?.getAttribute('destinations') || '';
    set('chatServerDest', serverDest);
    buildChatXml();
    appendLog('Loaded chat preset into Chat Composer — enter message and click Send Chat.', 'info');
    document.getElementById('chatSenderCallsign').closest('.panel').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('chatMessage').focus();
    return;
  }

  // ── Standard SA form population ───────────────────────────────────────────
  set('uid',      p.uid);
  set('callsign', p.callsign);
  set('type',     p.type);
  set('how',      p.how);
  set('lat',      p.lat);
  set('lon',      p.lon);
  set('hae',      p.hae);
  set('ce',       p.ce);
  set('le',       p.le);
  set('staleMins', p.staleMins);

  if (p.group) {
    const gc = document.getElementById('groupColor');
    if ([...gc.options].some(o => o.value === p.group)) gc.value = p.group;
  }
  if (p.role) {
    const gr = document.getElementById('groupRole');
    if ([...gr.options].some(o => o.value === p.role)) gr.value = p.role;
  }
  if (p.speed || p.course) {
    document.getElementById('enableTrack').checked = true;
    document.getElementById('trackSection').style.display = 'block';
    set('speed',  p.speed);
    set('course', p.course);
  }
  if (p.battery) {
    document.getElementById('enableBattery').checked = true;
    set('battery', p.battery);
  }
  set('takvDevice',   p.device);
  set('takvPlatform', p.platform);
  set('takvOs',       p.os);
  set('takvVersion',  p.ver);

  const milsymCb  = document.getElementById('enableMilsym');
  const milsymSec = document.getElementById('milsymSection');
  if (p.milsym) {
    milsymCb.checked = true;
    milsymSec.classList.add('active');
    set('milsymId', p.milsym);
  } else {
    milsymCb.checked = false;
    milsymSec.classList.remove('active');
  }
  if (p.geopointsrc || p.altsrc) {
    document.getElementById('enablePrecision').checked = true;
    document.getElementById('precisionSection').classList.add('active');
    const gps = document.getElementById('geopointsrc');
    if (p.geopointsrc && [...gps.options].some(o => o.value === p.geopointsrc)) gps.value = p.geopointsrc;
    const alt = document.getElementById('altsrc');
    if (p.altsrc && [...alt.options].some(o => o.value === p.altsrc)) alt.value = p.altsrc;
  }
  if (p.hasArchive) document.getElementById('enableArchive').checked = true;
  if (p.remarks) {
    document.getElementById('enableRemarks').checked = true;
    document.getElementById('remarksSection').classList.add('active');
    set('remarks', p.remarks);
  }
  if (p.linkUid) {
    document.getElementById('enableLink').checked = true;
    document.getElementById('linkSection').classList.add('active');
    set('linkUid',      p.linkUid);
    set('linkCallsign', p.linkCall);
    set('linkType',     p.linkType);
    const lr = document.getElementById('linkRelation');
    if ([...lr.options].some(o => o.value === p.linkRel)) lr.value = p.linkRel;
  }

  updateTypeHelper();
  generateXML();
  document.querySelector('.layout').scrollIntoView({ behavior: 'smooth' });
}


// =============================================================================
// SECTION: SEND RAW FROM PARSER
// =============================================================================

/**
 * Show a status result directly in the analyzer panel.
 * state: 'sending' | 'ok' | 'error'
 * Auto-clears the ok state after 4 seconds.
 */
function analyzerSetStatus(state, message) {
  const wrap = document.getElementById('analyzerSendStatus');
  const icon = document.getElementById('analyzerSendIcon');
  const text = document.getElementById('analyzerSendText');
  if (!wrap) return;

  const styles = {
    sending: { color: '#f0883e', bg: '#2d2218', border: '#f0883e66', icon: '⏳' },
    ok:      { color: '#3fb950', bg: '#182d1d', border: '#3fb95066', icon: '✓'  },
    error:   { color: '#f85149', bg: '#2d1b1b', border: '#f8514966', icon: '✗'  },
  };
  const s = styles[state] || styles.error;

  wrap.style.display  = 'flex';
  wrap.style.background  = s.bg;
  wrap.style.borderColor = s.border;
  icon.style.color    = s.color;
  icon.textContent    = s.icon;
  text.style.color    = s.color;
  text.textContent    = message;

  // Auto-clear success after 4s so it doesn't linger
  if (state === 'ok') {
    setTimeout(() => { wrap.style.display = 'none'; }, 4000);
  }
}

/** Send the pasted raw CoT exactly as-is, without modifying timestamps. */
async function parseAndSend() {
  const raw = document.getElementById('rawCotInput').value.trim();
  if (!raw) {
    analyzerSetStatus('error', 'No XML to send — paste CoT first.');
    return;
  }
  analyzerSetStatus('sending', 'Sending…');
  const ok = await sendRawXml(stripStreamWrapper(raw), 'Raw CoT (as-is)');
  if (ok) {
    analyzerSetStatus('ok', 'Delivered successfully');
  } else {
    analyzerSetStatus('error', 'Send failed — check TAK Server panel log below');
  }
}

/** Strip stream wrapper, inject fresh timestamps, then send. */
async function parseAndSendFresh() {
  const raw = document.getElementById('rawCotInput').value.trim();
  if (!raw) {
    analyzerSetStatus('error', 'No XML to send — paste CoT first.');
    return;
  }
  analyzerSetStatus('sending', 'Injecting fresh timestamps and sending…');
  const refreshed = injectFreshTimestamps(stripStreamWrapper(raw), 5);
  const ok = await sendRawXml(refreshed, 'Raw CoT (fresh timestamps)');
  if (ok) {
    analyzerSetStatus('ok', 'Delivered with fresh timestamps');
  } else {
    analyzerSetStatus('error', 'Send failed — check TAK Server panel log below');
  }
}
