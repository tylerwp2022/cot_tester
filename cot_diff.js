// =============================================================================
// cot_diff.js — CoT Message Diff
// =============================================================================
//
// PURPOSE:
//   Compares two CoT XML messages and produces a structured, highlighted
//   diff across three sections:
//     1. Event envelope attributes (uid, type, how, time, start, stale, etc.)
//     2. <point> attributes (lat, lon, hae, ce, le)
//     3. <detail> child elements (flattened to tag.attribute = value entries)
//
// DIFF CATEGORIES:
//   changed  — field exists in both messages but values differ   (orange)
//   removed  — field only in Message A                           (red)
//   added    — field only in Message B                           (green)
//   same     — identical in both messages                        (dimmed)
//
// DEPENDENCIES (must be loaded before this file):
//   index.html inline — escHtml(), showToast()
//
// EXPORTS (globals used by index.html):
//   runDiff()               — parse both inputs and render diff tables
//   diffClear()             — clear both inputs and results
//   diffClearResults()      — clear results only (called on textarea input)
//   diffLoadFromAnalyzer(slot) — copy rawCotInput into diffInputA or diffInputB
//
// USAGE IN HTML:
//   <textarea id="diffInputA"> / <textarea id="diffInputB">
//   <button onclick="runDiff()">Compare</button>
//   <button onclick="diffLoadFromAnalyzer('A')">← From Analyzer</button>
//
// EXAMPLE: comparing two SA beacons for the same entity received 1 minute apart
//   Paste first message → diffInputA
//   Paste second message → diffInputB
//   Click Compare → see which coords changed, stale updated, etc.
//
// =============================================================================

// =============================================================================
// SECTION: XML PARSING HELPERS
// =============================================================================

/**
 * Pull all attributes of a DOM element into a plain {name: value} object.
 * Returns empty object if el is null (e.g. missing <point> in one message).
 *
 * @param {Element|null} el
 * @returns {Object.<string, string>}
 */
function diffAttrsToMap(el) {
  if (!el) return {};
  const out = {};
  for (const attr of el.attributes) out[attr.name] = attr.value;
  return out;
}

/**
 * Flatten <detail> children into a map of descriptive keys → value strings.
 *
 * WHY FLATTEN: The detail block contains heterogeneous child elements
 * (contact, __group, takv, emergency, archive, etc.) each with their own
 * attribute names. Flattening to "tag.attr = value" lets the generic diffMaps()
 * function compare them without needing per-tag special handling.
 *
 * Key formats:
 *   "archive"              — presence-only tag (no attrs, no text)
 *   "remarks"              — tag with text content only
 *   "contact.callsign"     — tag with attributes → one key per attribute
 *   "emergency.(text)"     — tag with both attributes AND text content
 *
 * @param {Element|null} detailEl
 * @returns {Object.<string, string>}
 */
function diffFlattenDetail(detailEl) {
  const out = {};
  if (!detailEl) return out;

  for (const child of detailEl.children) {
    const tag = child.tagName;

    // Presence-only tags (e.g. <archive/>, <remarks/> with no content)
    if (child.attributes.length === 0 && child.textContent.trim() === '') {
      out[tag] = '(present)';
      continue;
    }

    // Tags with text content only (e.g. <remarks>some note</remarks>)
    if (child.attributes.length === 0) {
      out[tag] = child.textContent.trim() || '(present)';
      continue;
    }

    // Tags with attributes — emit one entry per attribute
    for (const attr of child.attributes) {
      out[`${tag}.${attr.name}`] = attr.value;
    }

    // Also capture text content if present alongside attributes
    // e.g. <emergency type="In Contact">PRAETOR 6</emergency>
    const text = child.textContent.trim();
    if (text) out[`${tag}.(text)`] = text;
  }

  return out;
}

// =============================================================================
// SECTION: DIFF LOGIC
// =============================================================================

/**
 * Compute the diff between two {key: value} maps.
 * Returns an array of row objects sorted alphabetically by key.
 *
 * Row shape: { key, a, b, state }
 *   key   — the field name
 *   a     — value from Map A (null if not present)
 *   b     — value from Map B (null if not present)
 *   state — 'added' | 'removed' | 'changed' | 'same'
 *
 * @param {Object.<string,string>} mapA
 * @param {Object.<string,string>} mapB
 * @returns {Array}
 */
function diffMaps(mapA, mapB) {
  const allKeys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  const rows = [];

  for (const key of [...allKeys].sort()) {
    const a = mapA[key];
    const b = mapB[key];

    if      (a === undefined) rows.push({ key, a: null, b,      state: 'added'   });
    else if (b === undefined) rows.push({ key, a,       b: null, state: 'removed' });
    else if (a !== b)         rows.push({ key, a,       b,       state: 'changed' });
    else                      rows.push({ key, a,       b,       state: 'same'    });
  }
  return rows;
}

// =============================================================================
// SECTION: RENDER
// =============================================================================

/**
 * Render a diff row array into the specified tbody element.
 * Builds colored HTML rows and injects them via innerHTML.
 * Returns the count of non-same (changed/added/removed) rows.
 *
 * WHY innerHTML: The table can have hundreds of rows (large detail blocks).
 * Building one string and setting innerHTML once is significantly faster than
 * appending individual DOM nodes in a loop.
 *
 * @param {Array}  rows     — from diffMaps()
 * @param {string} tbodyId  — ID of the <tbody> element to populate
 * @returns {number} count of differences (state !== 'same')
 */
function diffRenderRows(rows, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return 0;

  // Per-state visual styles
  const rowStyles = {
    added:   { bg: '#0d2318',     aColor: '#6e7681', bColor: '#85e89d' },
    removed: { bg: '#2d1b1b',     aColor: '#f97583', bColor: '#6e7681' },
    changed: { bg: '#2d2218',     aColor: '#f97583', bColor: '#85e89d' },
    same:    { bg: 'transparent', aColor: '#6e7681', bColor: '#6e7681' },
  };

  const badgeColors = {
    added:   '#85e89d',
    removed: '#f97583',
    changed: '#f0883e',
  };

  tbody.innerHTML = rows.map(r => {
    const s = rowStyles[r.state] || rowStyles.same;

    const keyCol = r.state !== 'same'
      ? `<strong style="color:#c9d1d9;">${escHtml(r.key)}</strong>`
      : `<span style="color:#6e7681;">${escHtml(r.key)}</span>`;

    const aVal = r.a !== null ? escHtml(r.a) : '<span style="color:#444;">—</span>';
    const bVal = r.b !== null ? escHtml(r.b) : '<span style="color:#444;">—</span>';

    const badge = r.state !== 'same'
      ? `<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;margin-left:6px;
                      font-weight:700;background:${s.bg === 'transparent' ? '#21262d' : s.bg};
                      color:${badgeColors[r.state]};">
           ${r.state.toUpperCase()}</span>`
      : '';

    return `<tr style="border-bottom:1px solid #21262d;background:${s.bg};">
      <td style="padding:5px 10px;font-family:monospace;font-size:0.68rem;vertical-align:top;">
        ${keyCol}${badge}
      </td>
      <td style="padding:5px 10px;font-family:monospace;font-size:0.68rem;
                 color:${s.aColor};vertical-align:top;word-break:break-all;">${aVal}</td>
      <td style="padding:5px 10px;font-family:monospace;font-size:0.68rem;
                 color:${s.bColor};vertical-align:top;word-break:break-all;">${bVal}</td>
    </tr>`;
  }).join('');

  return rows.filter(r => r.state !== 'same').length;
}

// =============================================================================
// SECTION: PUBLIC API — called by index.html onclick handlers
// =============================================================================

/**
 * Main entry point. Reads both textarea inputs, parses them as XML,
 * and populates the three diff tables (attributes, point, detail).
 */
function runDiff() {
  const rawA = (document.getElementById('diffInputA')?.value || '').trim();
  const rawB = (document.getElementById('diffInputB')?.value || '').trim();

  if (!rawA || !rawB) {
    alert('Paste a CoT message into both fields before comparing.');
    return;
  }

  const parser = new DOMParser();
  let docA, docB;
  try {
    docA = parser.parseFromString(rawA, 'text/xml');
    docB = parser.parseFromString(rawB, 'text/xml');
  } catch (e) {
    alert(`XML parse error: ${e.message}`);
    return;
  }

  // DOMParser doesn't throw on malformed XML — it embeds a <parsererror> element
  const errA = docA.querySelector('parsererror');
  const errB = docB.querySelector('parsererror');
  if (errA) { alert('Message A is not valid XML:\n' + errA.textContent); return; }
  if (errB) { alert('Message B is not valid XML:\n' + errB.textContent); return; }

  const evtA = docA.querySelector('event');
  const evtB = docB.querySelector('event');
  if (!evtA) { alert('Message A does not contain an <event> element.'); return; }
  if (!evtB) { alert('Message B does not contain an <event> element.'); return; }

  let totalDiffs = 0;

  // ── 1. Event envelope attributes ─────────────────────────────────────────
  const attrRows  = diffMaps(diffAttrsToMap(evtA), diffAttrsToMap(evtB));
  const attrDiffs = diffRenderRows(attrRows, 'diffAttrBody');
  totalDiffs += attrDiffs;
  const attrSection = document.getElementById('diffAttrSection');
  attrSection.style.display = '';
  attrSection.querySelector('.section-label').style.color = attrDiffs > 0 ? '#c9d1d9' : '#6e7681';

  // ── 2. <point> attributes ────────────────────────────────────────────────
  const ptA       = evtA.querySelector('point');
  const ptB       = evtB.querySelector('point');
  const pointRows = diffMaps(diffAttrsToMap(ptA), diffAttrsToMap(ptB));
  const ptDiffs   = diffRenderRows(pointRows, 'diffPointBody');
  totalDiffs += ptDiffs;
  const ptSection = document.getElementById('diffPointSection');
  ptSection.style.display = '';
  ptSection.querySelector('.section-label').style.color = ptDiffs > 0 ? '#c9d1d9' : '#6e7681';

  // ── 3. <detail> children ─────────────────────────────────────────────────
  const dtA        = evtA.querySelector('detail');
  const dtB        = evtB.querySelector('detail');
  const detailRows = diffMaps(diffFlattenDetail(dtA), diffFlattenDetail(dtB));
  const dtDiffs    = diffRenderRows(detailRows, 'diffDetailBody');
  totalDiffs += dtDiffs;
  const dtSection  = document.getElementById('diffDetailSection');
  dtSection.style.display = '';
  dtSection.querySelector('.section-label').style.color = dtDiffs > 0 ? '#c9d1d9' : '#6e7681';

  // ── Summary badge ─────────────────────────────────────────────────────────
  const badge     = document.getElementById('diffSummaryBadge');
  const identical = document.getElementById('diffIdenticalNotice');

  if (totalDiffs === 0) {
    badge.style.display = 'none';
    identical.style.display = '';
  } else {
    badge.style.display = '';
    badge.textContent = `${totalDiffs} difference${totalDiffs !== 1 ? 's' : ''} found`;
    badge.style.color = '#f0883e';
    identical.style.display = 'none';
  }

  document.getElementById('diffResults').style.display = '';
}

/** Hide the results pane. Called automatically when either textarea is edited. */
function diffClearResults() {
  document.getElementById('diffResults').style.display = 'none';
  document.getElementById('diffSummaryBadge').style.display = 'none';
}

/** Clear both input fields and results. */
function diffClear() {
  document.getElementById('diffInputA').value = '';
  document.getElementById('diffInputB').value = '';
  diffClearResults();
}

/**
 * Copy whatever is currently in the Raw CoT Analyzer (rawCotInput) into
 * diff field A or B. Useful when you've just received a message in the
 * listener and want to compare it against a previous capture.
 *
 * @param {'A'|'B'} slot
 */
function diffLoadFromAnalyzer(slot) {
  const xml = document.getElementById('rawCotInput')?.value?.trim();
  if (!xml) {
    showToast('Raw CoT Analyzer is empty — paste something there first');
    return;
  }
  document.getElementById(`diffInput${slot}`).value = xml;
  diffClearResults();
}
