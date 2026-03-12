// =============================================================================
// cot_types.js — CoT Type System, Utility Functions, and Generators
//
// PURPOSE:
//   Pure-data and pure-function module. No DOM interaction, no network calls.
//   Everything here is either a constant lookup table or a stateless function
//   that can run without any other module being loaded first.
//
//   This is the "header file" of the CoT Message Builder — all other modules
//   depend on it, so it must be loaded first via <script src="cot_types.js">.
//
// EXPORTS (global functions/variables used by other modules):
//   genUuid()            — generate a random RFC-4122 v4 UUID
//   nowISO()             — current time as a Z-suffix ISO 8601 string
//   staleISO(mins)       — now + N minutes as Z-suffix ISO 8601 string
//   describeType(type)   — human-readable breakdown of a CoT type string
//   describeHow(how)     — human-readable description of a CoT how code
//   timeUntil(isoStr)    — seconds remaining until an ISO timestamp expires
//   updateTypeHelper()   — updates the live type breakdown widget in the UI
//   applyTypePreset()    — applies a selected type from the dropdown
//   applyPlatformPreset()— fills platform fields from the preset dropdown
//   generateUID()        — generates a random UUID into the UID field
//   generateCallsign()   — generates a random NATO callsign into the callsign field
//   toggleSection(id, cb)— shows/hides a collapsible section based on checkbox state
//
// USAGE:
//   Load before all other JS modules:
//   <script src="cot_types.js"></script>
//   <script src="cot_sender.js"></script>
//   ...etc
// =============================================================================


// =============================================================================
// SECTION: UUID / TIME UTILITIES
// These are used throughout all modules — defined here so they're available
// as soon as cot_types.js loads (which is first).
// =============================================================================

/**
 * Generate a random RFC-4122 version 4 UUID.
 *
 * WHY HERE: genUuid() is needed in cot_presets.js (drawing_circle generates
 * fresh UIDs at render time), cot_composer.js (chat message UUID, group UUID),
 * and cot_types.js (generateUID button). Putting it here ensures it's always
 * available regardless of load order.
 *
 * @returns {string} UUID in the form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    // For 'y' positions, set the two most-significant bits to 10 (RFC 4122 variant)
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Return the current UTC time as an ISO 8601 string without milliseconds.
 * TAK uses the compact format: "2026-03-03T14:22:00Z" (not "...000Z").
 *
 * WHY NO MILLISECONDS: The TAK protocol and CoT spec use second-precision
 * timestamps. Milliseconds cause formatting inconsistencies across TAK
 * clients and some older versions reject messages with sub-second precision.
 *
 * @returns {string} e.g. "2026-03-03T14:22:00Z"
 */
function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Return a future UTC time as an ISO 8601 string without milliseconds.
 * Used to compute the stale= attribute for CoT events.
 *
 * @param {number} mins - minutes from now (default: 5)
 * @returns {string} e.g. "2026-03-03T14:27:00Z"
 */
function staleISO(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + (parseInt(mins) || 5));
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Return a human-readable string describing how long until an ISO timestamp
 * expires, or how long ago it expired if already stale.
 *
 * Used by the parser to annotate the stale= field in analysis results.
 *
 * @param {string} isoStr - ISO 8601 timestamp string
 * @returns {string|null} e.g. "4m 32s", "⚠️ already stale (12s ago)", or null if empty
 */
function timeUntil(isoStr) {
  if (!isoStr) return null;
  const diff = Math.round((new Date(isoStr) - new Date()) / 1000);
  if (diff < 0)  return `⚠️ already stale (${Math.abs(diff)}s ago)`;
  if (diff < 60) return `${diff}s`;
  return `${Math.floor(diff / 60)}m ${diff % 60}s`;
}


// =============================================================================
// SECTION: CoT TYPE DESCRIPTIONS
// These lookup tables decode the hierarchical CoT type string into its
// component parts for the live type breakdown widget and the raw CoT parser.
//
// CoT type format: atom-affiliation-dimension-category-subcategory-...
// Example: "a-f-G-U-C-V-U-R"
//           a = Atom (real entity)
//           f = Friendly
//           G = Ground dimension
//           U = Unit (human)
//           C = Combat Arms
//           V = Vehicle
//           U = Unmanned
//           R = Rotary Wing
// =============================================================================

/**
 * Decode a CoT type string into a human-readable description.
 *
 * Handles two cases:
 *   1. Special/reserved types (b-t-f, u-d-f, b-m-p-s-m, etc.) — looked up
 *      directly in the specialTypes table because they don't parse through
 *      the MIL-STD-2525C hierarchy.
 *   2. Standard atom types (a-f-G-U-C-...) — decoded position-by-position
 *      through the lookup tables and joined with " → ".
 *
 * @param {string} type - CoT type string, e.g. "a-f-G-U-C-V-U-R"
 * @returns {string} Human-readable description
 */
function describeType(type) {
  if (!type) return '';
  const parts = type.split('-');

  // ── Per-position lookup tables ────────────────────────────────────────────
  // Each entry maps a single type token to its human-readable meaning at that
  // position in the hierarchy. Tokens not found in the table are passed through.
  const lookup = [
    // 0 — Atom: top-level category of the CoT event
    { 'a': 'Atom (real entity)', 'b': 'Bit (data)', 't': 'Task', 'r': 'Reply' },
    // 1 — Affiliation: friend/foe/neutral/unknown
    { 'f': '🟦 Friendly', 'h': '🟥 Hostile', 'n': '⬜ Neutral', 'u': '❓ Unknown',
      's': '🟡 Suspect', 'j': 'Joker', 'k': 'Faker' },
    // 2 — Battle Dimension: physical domain
    { 'G': '🚶 Ground', 'A': '✈️ Air', 'S': '🚢 Sea Surface',
      'U': '🤿 Subsurface', 'F': '🎖️ SOF', 'X': 'Other' },
    // 3 — Category: type of entity within the dimension
    { 'U': 'Unit (human)', 'E': 'Equipment', 'I': 'Installation', 'M': 'Machine', 'G': 'Group' },
    // 4 — Subcategory: functional role/branch
    // WHY 'U': 'Combat Support' here: confirmed from Skydio GCS CoT (a-f-G-U-U-M-A).
    // 2525C uses U=Combat Support at this position, distinct from U=Unit at position 3.
    { 'C': 'Combat Arms', 'V': 'Vehicle', 'F': 'Unmanned/Fixed-Wing',
      'R': 'Rotary Wing', 'S': 'Support', 'H': 'Helicopter/Rotary',
      'Q': 'Robot/Drone', 'U': 'Combat Support' },
    // 5 — Sub-subcategory
    // 'M': 'Military Intelligence' confirmed from Skydio GCS (a-f-G-U-U-M-A).
    { 'U': 'Unmanned', 'I': 'Individual', 'F': 'Leader', 'A': 'Aviation',
      'Q': 'Robot/UGV', 'V': 'Vehicle/UAV family', 'M': 'Military Intelligence' },
    // 6 — Modifier 1
    // 'A': 'Aerial Exploitation' confirmed from Skydio GCS (a-f-G-U-U-M-A).
    { 'U': 'Unmanned Aerial Vehicle', 'F': 'Fixed Wing', 'R': 'Rotary Wing',
      'Q': 'Drone (RPV)', 'A': 'Aerial Exploitation' },
    // 7 — Modifier 2
    { 'R': 'Rotary Wing', 'F': 'Fixed Wing', 'Q': 'Drone' },
  ];

  // ── Special type table ────────────────────────────────────────────────────
  // Types that don't follow the atom hierarchy — data messages, drawn shapes,
  // TAK system messages, etc. Checked before the position-by-position decode.
  const specialTypes = {
    'b-t-f':             'GeoChat direct message',
    'b-t-f-d':           'GeoChat delivery receipt — message arrived at device (auto-generated)',
    'b-t-f-r':           'GeoChat read receipt — message opened by user (auto-generated)',
    'b-f-t-r':           'File Transfer Request — peer-to-peer file/data package transfer',
    'b-m-p-s-m':         'Spot Map marker — persistent map pin dropped by operator',
    'b-m-p-s-p-i':       'Spot Map marker — indeterminate/unknown',
    'b-m-p-w-GOTO':      'Mission Waypoint — GOTO (green flag, 5-min stale)',
    'b-m-p-w-HOLD':      'Mission Waypoint — HOLD position',
    'b-m-p-w-JTAC':      'Mission Waypoint — JTAC (Joint Terminal Attack Controller)',
    'b-m-p-w-SAR':       'Mission Waypoint — Search and Rescue',
    'b-m-p-w-c-c':       'Waypoint / CoT coordinate (map click)',
    'b-m-r':             'Route / navigation path',
    'b-m-p-c':           'Casevac / 9-line report marker',
    'u-d-f':             'User-drawn line / polyline / polygon (phase line, NAI, boundary)',
    'u-d-r':             'User-drawn rectangle',
    'u-d-c-c':           'User-drawn circle / ellipse',
    'u-d-arrow':         'User-drawn arrow',
    't-x-c-t':           'TAK ping / heartbeat',
    't-x-d-d':           'Delete/Drop — remove entity from common operating picture',
    't-k':               'TAK keepalive',
    // Emergency alerts
    'b-a-o-opn':         '🚨 Emergency — In Contact (active alert)',
    'b-a-o-tbl':         '🚨 Emergency — Troops in Contact (active alert)',
    'b-a-o-pan':         '🆘 Emergency — Panic / 911 (active alert)',
    'b-a-o-can':         '✅ Emergency Cancel — clears active alert on all devices',
    'b-a-o':             '🚨 Emergency alert (generic)',
    // Suspect/Joker/Faker — pending classification
    'a-s-G':             '🟡 Suspect Ground — pending classification (placed marker)',
    'a-j-G':             'Joker Ground — exercise/simulation hostile',
    'a-k-G':             'Faker Ground — exercise/simulation friendly acting hostile',
  };

  if (specialTypes[type]) return specialTypes[type];

  // ── Position-by-position decode for atom types ────────────────────────────
  const parts_desc = parts.map((p, i) => {
    if (!p) return null;
    return (lookup[i] && lookup[i][p]) || p;
  }).filter(Boolean);

  return parts_desc.join(' → ');
}

/**
 * Decode a CoT "how" code into a human-readable description.
 *
 * The "how" attribute describes how the entity's position was determined.
 * This matters for TAK clients — "m-g" (machine GPS) indicates an autonomous
 * system while "h-g-i-g-o" indicates a human long-pressed the map.
 *
 * @param {string} how - CoT how code, e.g. "m-g"
 * @returns {string} Human-readable description, or the original code if unknown
 */
function describeHow(how) {
  const map = {
    'h-e':       'Human entered (typed coordinates)',
    'h-g-i-g-o': 'Human tapped map (long-press drop pin)',
    'h-c':       'Human calculated',
    'm-g':       'Machine GPS (autonomous/robot)',
    'm-i':       'Machine inferred',
  };
  return map[how] || how;
}


// =============================================================================
// SECTION: UI — TYPE HELPER WIDGET
// The live type breakdown that appears below the type input field.
// Updates on every keystroke to show what each component of the type means.
// =============================================================================

/**
 * Update the type breakdown helper widget below the type input.
 * Called oninput by the type text field.
 *
 * WHY DUPLICATE TABLES: The helper uses emoji-enriched labels for readability
 * in the small inline widget, while describeType() uses shorter text suitable
 * for the parser analysis table. They intentionally differ.
 */
function updateTypeHelper() {
  const val    = document.getElementById('type').value.trim();
  const helper = document.getElementById('typeHelper');
  if (!val) {
    helper.innerHTML = '<div class="type-tree">Type a CoT type string above to see breakdown</div>';
    return;
  }

  const parts = val.split('-');
  const descs = [
    { part: parts[0], meanings: { 'a': 'Atom (real entity)', 'b': 'Bit (data)', 't': 'Task', 'r': 'Reply' } },
    { part: parts[1], meanings: { 'f': '🟦 Friendly', 'h': '🟥 Hostile', 'n': '⬜ Neutral', 'u': '❓ Unknown', 's': '🟡 Suspect' } },
    { part: parts[2], meanings: { 'G': '🚶 Ground', 'A': '✈️ Air', 'S': '🚢 Sea Surface', 'U': '🤿 Subsurface', 'F': '🎖️ SOF' } },
    { part: parts[3], meanings: { 'U': 'Unit (human)', 'E': 'Equipment', 'I': 'Installation', 'M': 'Machine', 'G': 'Group' } },
    { part: parts[4], meanings: { 'C': 'Combat Arms', 'V': 'Vehicle', 'F': 'Unmanned/Fixed-Wing', 'R': 'Rotary Wing', 'S': 'Support', 'H': 'Helicopter/Rotary', 'Q': 'Robot/Drone', 'U': 'Combat Support' } },
    { part: parts[5], meanings: { 'U': 'Unmanned', 'I': 'Individual', 'F': 'Leader', 'A': 'Aviation', 'Q': 'Robot/UGV', 'V': 'Vehicle/UAV family', 'M': 'Military Intelligence' } },
    { part: parts[6], meanings: { 'U': 'Unmanned Aerial Vehicle', 'F': 'Fixed Wing', 'R': 'Rotary Wing', 'Q': 'Drone (RPV)', 'A': 'Aerial Exploitation' } },
    { part: parts[7], meanings: { 'R': 'Rotary Wing', 'F': 'Fixed Wing', 'Q': 'Drone' } },
  ];

  const labels = ['Atom', 'Affiliation', 'Dimension', 'Category', 'Sub-Cat', 'Sub-Sub-Cat', 'Modifier 1', 'Modifier 2'];

  let html = '<div class="type-tree">';
  descs.forEach((d, i) => {
    if (!d.part) return;
    const meaning = d.meanings[d.part] || d.part;
    html += `<span style="color:#6e7681">${labels[i]}: </span><span>${d.part}</span>`
          + `<span style="color:#8b949e"> = ${meaning}</span><br/>`;
  });
  html += '</div>';
  helper.innerHTML = html;
}

/** Apply the selected type preset and clear the dropdown back to placeholder. */
function applyTypePreset() {
  const val = document.getElementById('typePreset').value;
  if (!val) return;
  document.getElementById('type').value          = val;
  document.getElementById('typePreset').value    = '';
  updateTypeHelper();
}

/**
 * Apply the selected platform preset to the takv fields.
 *
 * WHY PRESETS: The takv element carries four fields that are always consistent
 * per platform type. A preset prevents typos and ensures ATAK-verified strings
 * are used (e.g. "Pytak-Client" not "PyTAK" — case matters for some TAK filters).
 */
function applyPlatformPreset() {
  const presets = {
    'atak_android': { device: 'SAMSUNG SM-G736U1',  platform: 'ATAK',         os: '36',           version: '5.6.0.12'  },
    'wintak':       { device: 'Windows Laptop',     platform: 'WinTAK',       os: 'Windows 11',   version: '4.10.0.0'  },
    'pytak_robot':  { device: 'RRC Robot',          platform: 'Pytak-Client', os: 'Ubuntu 24.04', version: '5.3.0.155' },
    'pytak_drone':  { device: 'Parrot Anafi',       platform: 'Pytak-Client', os: 'Ubuntu 24.04', version: '5.3.0.155' },
  };
  const p = presets[document.getElementById('platformPreset').value];
  if (!p) return;
  document.getElementById('takvDevice').value     = p.device;
  document.getElementById('takvPlatform').value   = p.platform;
  document.getElementById('takvOs').value         = p.os;
  document.getElementById('takvVersion').value    = p.version;
  document.getElementById('platformPreset').value = '';
}


// =============================================================================
// SECTION: GENERATORS — UID & CALLSIGN
// Convenience buttons that fill in random-but-realistic values.
// =============================================================================

/**
 * Generate a random UUID into the uid field and regenerate the XML preview.
 * Triggered by the "⚄ Gen UUID" button next to the uid input.
 */
function generateUID() {
  document.getElementById('uid').value = genUuid();
  // generateXML() is defined in cot_composer.js — safe to call because
  // cot_types.js is loaded first but generateUID is only ever called from
  // a button click (after all scripts are loaded).
  generateXML();
}

/**
 * Generate a random NATO phonetic alphabet callsign into the callsign field.
 *
 * WHY THESE PATTERNS: Common TAK callsign conventions are:
 *   WORD-NUMBER    (e.g. FOXTROT-6, ALPHA-2)
 *   WORD-ROLE      (e.g. TANGO-ACTUAL, BRAVO-BASE)
 * Both patterns are represented in the suffix list.
 */
function generateCallsign() {
  const words = [
    'ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL',
    'INDIA','JULIET','KILO','LIMA','MIKE','NOVEMBER','OSCAR','PAPA',
    'QUEBEC','ROMEO','SIERRA','TANGO','UNIFORM','VICTOR','WHISKEY',
    'XRAY','YANKEE','ZULU',
  ];
  const suffixes = ['1','2','3','4','6','7','ACTUAL','BASE','LEAD','MIKE','NINER'];
  const word     = words[Math.floor(Math.random() * words.length)];
  const suffix   = suffixes[Math.floor(Math.random() * suffixes.length)];
  document.getElementById('callsign').value = `${word}-${suffix}`;
  generateXML();
}


// =============================================================================
// SECTION: UI UTILITIES
// =============================================================================

/**
 * Show or hide a collapsible section element based on checkbox state.
 * Used for optional detail sections (precision location, archive, milsym, etc.)
 *
 * @param {string} id       - Element ID of the collapsible div
 * @param {HTMLInputElement} checkbox - The checkbox that controls visibility
 */
function toggleSection(id, checkbox) {
  const el = document.getElementById(id);
  el.classList.toggle('active', checkbox.checked);
}
