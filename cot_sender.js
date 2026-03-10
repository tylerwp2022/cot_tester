// =============================================================================
// cot_sender.js — TAK Server Network Layer
//
// PURPOSE:
//   All network communication with the TAK server lives here. This module
//   handles connection configuration, authentication headers, fetch() calls,
//   repeat-send scheduling, and the status/log UI.
//
//   Keeping network concerns isolated here means the composer and parser
//   modules never make fetch() calls directly — they call sendRawXml() or
//   doSend() from this module.
//
// DEPENDS ON:
//   cot_types.js  — for nowISO(), staleISO() (used by doSend → generateXML)
//   cot_composer.js — generateXML() is called inside doSend() to refresh timestamps
//
// EXPORTS (global functions used by other modules and HTML onclick handlers):
//   doSend()                — regenerate XML then POST to TAK server (main form)
//   sendCoT()               — entry point for Send CoT button (handles repeat mode)
//   stopRepeat()            — cancel the repeat interval timer
//   sendRawXml(xml, label)  — POST arbitrary XML to the configured endpoint
//   buildHeaders()          — build Authorization headers from auth type/fields
//   setStatus(state, msg, code) — update the status indicator bar
//   appendLog(msg, level)   — add a timestamped entry to the activity log
//   clearLog()              — clear the activity log
//   applyProxyShortcut()    — fill URL/path fields from the proxy port shortcut
//   updateEndpointPreview() — refresh the full endpoint preview label
//   updateAuthFields()      — show/hide auth sub-fields based on auth type
//   updateRepeatUI()        — show/hide the interval field based on repeat mode
//   sendChatMessage()       — send the currently built chat XML
//   sendSpotMarker()        — send the currently built spot map marker XML
//
// USAGE IN HTML (button onclick examples):
//   <button onclick="sendCoT()">▶ Send CoT</button>
//   <button onclick="stopRepeat()">■ Stop</button>
// =============================================================================


// =============================================================================
// SECTION: REPEAT MODE STATE
// These module-level variables track the active repeat timer and count.
// They must be module-level (not function-local) so stopRepeat() can cancel
// a timer that was started inside sendCoT().
// =============================================================================

/** @type {number|null} setInterval handle for repeat mode, null when not repeating */
let repeatTimer = null;

/** @type {number} count of successful sends in the current repeat session */
let repeatCount = 0;


// =============================================================================
// SECTION: CONNECTION CONFIGURATION UI
// Functions that respond to changes in the TAK Server connection section.
// =============================================================================

/**
 * Apply the local proxy port shortcut to the URL and path fields.
 *
 * WHY A SHORTCUT: When running a local reverse proxy (e.g. for CORS bypass or
 * TLS termination), the URL is always http://localhost:{port} and the path is
 * /send. This shortcut fills both fields in one action so users don't have to
 * manually clear the default /Marti/api/cot path each time.
 */
function applyProxyShortcut() {
  const port = document.getElementById('proxyPort').value.trim();
  if (!port) return;
  document.getElementById('takServerUrl').value = `http://localhost:${port}`;
  document.getElementById('takApiPath').value   = '/send';
  updateEndpointPreview();
}

/**
 * Refresh the full endpoint preview label below the URL/path fields.
 * Called oninput on both the URL and path inputs.
 */
function updateEndpointPreview() {
  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();
  document.getElementById('endpointPreview').textContent = (base && path) ? `${base}${path}` : '—';
}

/**
 * Show/hide the auth sub-fields (basic username/password or bearer token)
 * based on the selected auth type.
 *
 * WHY NOT ALWAYS SHOWN: Showing all auth fields at once is confusing and
 * suggests all fields are required. Conditional display makes it clear
 * that only one auth method is needed.
 */
function updateAuthFields() {
  const t = document.getElementById('takAuthType').value;
  document.getElementById('authBasicFields').style.display = (t === 'basic')  ? 'block' : 'none';
  document.getElementById('authTokenField').style.display  = (t === 'apikey') ? 'block' : 'none';
}

/**
 * Show/hide the repeat interval field based on the send mode selector.
 * Called onchange on the repeat mode dropdown.
 */
function updateRepeatUI() {
  const repeat = document.getElementById('takRepeatMode').value === 'repeat';
  document.getElementById('takIntervalField').style.display = repeat ? 'block' : 'none';
}


// =============================================================================
// SECTION: STATUS & LOG UI
// The status indicator and activity log give the user live feedback on
// send attempts. These are the only output mechanisms in this module —
// network results are always surfaced here, never silently discarded.
// =============================================================================

/**
 * Update the status indicator bar with a state, message, and optional HTTP code.
 *
 * @param {'sending'|'ok'|'error'|'warn'} state - Visual state (drives color/icon)
 * @param {string} message  - Human-readable status description
 * @param {number} [code]   - HTTP response code to display (optional)
 */
function setStatus(state, message, code) {
  const colors = { sending: '#58a6ff', ok: '#3fb950', error: '#f85149', warn: '#d29922' };
  const icons  = { sending: '◌',       ok: '●',       error: '●',       warn: '▲'      };

  const box    = document.getElementById('takStatusBox');
  const bar    = document.getElementById('takStatusBar');
  const icon   = document.getElementById('takStatusIcon');
  const text   = document.getElementById('takStatusText');
  const codeEl = document.getElementById('takStatusCode');

  box.style.display    = 'block';
  bar.style.borderLeft = `3px solid ${colors[state]}`;
  icon.style.color     = colors[state];
  icon.textContent     = icons[state];
  text.textContent     = message;
  codeEl.textContent   = code ? `HTTP ${code}` : '';
}

/**
 * Append a timestamped entry to the activity log panel.
 *
 * Level controls the text color:
 *   info  — gray  (routine activity)
 *   ok    — green (successful send)
 *   error — red   (failure requiring attention)
 *   warn  — amber (advisory, non-fatal)
 *
 * Auto-scrolls to the bottom so the most recent entry is always visible.
 * Removes the initial placeholder span on the first real log entry.
 *
 * @param {string} message
 * @param {'info'|'ok'|'error'|'warn'} level
 */
function appendLog(message, level) {
  const levelColors = { info: '#6e7681', ok: '#3fb950', error: '#f85149', warn: '#d29922' };
  const log = document.getElementById('takLog');
  const ts  = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm

  // Remove the "Waiting for first send..." placeholder on first real entry
  if (log.querySelector('span')) log.innerHTML = '';

  const div = document.createElement('div');
  div.style.color = levelColors[level] || '#6e7681';
  div.textContent = `[${ts}] ${message}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

/** Clear the activity log and reset to cleared state placeholder. */
function clearLog() {
  document.getElementById('takLog').innerHTML = '<span style="color:#444;">Log cleared.</span>';
}


// =============================================================================
// SECTION: AUTHENTICATION HEADERS
// =============================================================================

/**
 * Build HTTP Authorization headers based on the selected auth type.
 *
 * WHY THREE MODES:
 *   none   — TAK server on a trusted VPN or behind a local proxy (most common
 *            in field deployment — network-level auth rather than HTTP auth)
 *   basic  — Some TAK server configurations and FreeTAK Server use Basic Auth
 *   apikey — Bearer token auth for cloud TAK Server instances or custom APIs
 *
 * @returns {Object} Headers object — always includes Content-Type, may add Authorization
 */
function buildHeaders() {
  const headers  = { 'Content-Type': 'application/xml' };
  const authType = document.getElementById('takAuthType').value;

  if (authType === 'basic') {
    const user = document.getElementById('takUser').value;
    const pass = document.getElementById('takPass').value;
    headers['Authorization'] = 'Basic ' + btoa(`${user}:${pass}`);
  } else if (authType === 'apikey') {
    const token = document.getElementById('takToken').value.trim();
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}


// =============================================================================
// SECTION: CORE SEND FUNCTIONS
// =============================================================================

/**
 * Regenerate the SA form XML with fresh timestamps, then POST it to the
 * configured TAK endpoint.
 *
 * WHY REGENERATE BEFORE SEND: If the user has had the form open for several
 * minutes and clicks Send, the timestamps in the preview are stale. Calling
 * generateXML() here ensures time/start/stale are always current at the
 * moment of actual transmission.
 *
 * @returns {Promise<boolean>} true if the server returned 2xx, false otherwise
 */
async function doSend() {
  // Refresh timestamps immediately before sending
  generateXML();
  const xml = document.getElementById('output').textContent;

  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();

  if (!base) {
    setStatus('error', 'No server URL entered.');
    appendLog('ERROR: Server URL is empty.', 'error');
    return false;
  }

  const url = `${base}${path}`;
  setStatus('sending', `Sending to ${url}…`);
  appendLog(`POST ${url}`, 'info');

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: buildHeaders(),
      body:    xml,
      // NOTE: browsers ignore 'rejectUnauthorized' — TLS certificate errors
      // must be handled by the user accepting the cert in their browser first,
      // then returning to this tool. There is no JS API to bypass TLS in a
      // browser context (by design — only a local proxy can handle this).
    });

    if (resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      setStatus('ok', 'Message delivered successfully.', resp.status);
      appendLog(
        `✓ ${resp.status} ${resp.statusText}${bodyText ? ' — ' + bodyText.substring(0, 80) : ''}`,
        'ok'
      );
      return true;
    } else {
      const bodyText = await resp.text().catch(() => '');
      setStatus('error', 'Server returned an error.', resp.status);
      appendLog(
        `✗ ${resp.status} ${resp.statusText}${bodyText ? ' — ' + bodyText.substring(0, 120) : ''}`,
        'error'
      );
      return false;
    }

  } catch (err) {
    // Network errors (CORS, connection refused, TLS failure) all land here.
    // The error message from fetch() is intentionally vague for security reasons,
    // but "Failed to fetch" / "NetworkError" reliably indicate CORS or TLS issues.
    const isCors = err.message && (
      err.message.includes('Failed to fetch') || err.message.includes('NetworkError')
    );
    if (isCors) {
      setStatus('error', 'Network error — likely CORS or TLS. See log.');
      appendLog(`✗ Network error: ${err.message}`, 'error');
      appendLog('  → If self-signed cert: open server URL in a browser tab and accept the warning, then retry.', 'warn');
      appendLog('  → If CORS blocked: TAK server needs Access-Control-Allow-Origin header, or use a local proxy.', 'warn');
    } else {
      setStatus('error', `Request failed: ${err.message}`);
      appendLog(`✗ Exception: ${err.message}`, 'error');
    }
    return false;
  }
}

/**
 * Entry point for the "▶ Send CoT" button.
 *
 * Handles both one-shot and repeat modes:
 *   once   — calls doSend() once and returns
 *   repeat — calls doSend() immediately, then sets an interval to call it
 *            repeatedly until the user clicks "■ Stop"
 *
 * WHY CALL stopRepeat() FIRST: If the user clicks Send while a repeat session
 * is already running, we want to replace it with a fresh session rather than
 * stacking two parallel timers.
 */
async function sendCoT() {
  const mode = document.getElementById('takRepeatMode').value;

  // Cancel any existing repeat session before starting a new one
  stopRepeat();

  if (mode === 'once') {
    await doSend();
  } else {
    // Repeat mode — send immediately then on interval
    const intervalSec = Math.max(1, parseInt(document.getElementById('takInterval').value) || 10);
    repeatCount = 0;

    // Update UI to show active repeat state
    document.getElementById('btnStop').style.display            = 'inline-block';
    document.getElementById('repeatCounterBadge').style.display = 'flex';
    document.getElementById('btnSend').textContent              = '▶ Sending…';
    document.getElementById('btnSend').disabled                 = true;

    appendLog(`▶ Repeat mode started — every ${intervalSec}s`, 'info');

    // First send happens immediately so the user gets feedback right away
    const ok = await doSend();
    if (ok) {
      repeatCount++;
      document.getElementById('repeatCounter').textContent = repeatCount;
    }

    // Subsequent sends on the interval
    repeatTimer = setInterval(async () => {
      const ok = await doSend();
      if (ok) {
        repeatCount++;
        document.getElementById('repeatCounter').textContent = repeatCount;
      }
    }, intervalSec * 1000);
  }
}

/**
 * Stop the active repeat timer and reset the UI back to the idle state.
 * Called by both the "■ Stop" button and automatically at the start of
 * sendCoT() to prevent stacked timers.
 */
function stopRepeat() {
  if (repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
    appendLog(`■ Repeat stopped. Total sent: ${repeatCount}`, 'info');
  }
  document.getElementById('btnStop').style.display            = 'none';
  document.getElementById('repeatCounterBadge').style.display = 'none';
  document.getElementById('btnSend').textContent              = '▶ Send CoT';
  document.getElementById('btnSend').disabled                 = false;
  repeatCount = 0;
}


// =============================================================================
// SECTION: SHARED RAW XML SEND HELPER
// Used by the parser (send-as-is / send-with-fresh-timestamps),
// presets (sendPreset), and spot map / chat composers.
// Centralizing this here avoids duplicating fetch() + error handling.
// =============================================================================

/**
 * POST arbitrary XML to the configured TAK endpoint.
 *
 * This is the lowest-level send primitive — it does NOT regenerate any XML,
 * it simply sends whatever string you pass in. All callers that need fresh
 * timestamps must generate them before calling this function.
 *
 * @param {string} xml   - Complete CoT XML string to send
 * @param {string} label - Short label for the log entry, e.g. "Raw CoT (as-is)"
 */
async function sendRawXml(xml, label) {
  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();

  if (!base) {
    appendLog('ERROR: No server URL set. Fill in the TAK Server section.', 'error');
    setStatus('error', 'No server URL — fill in the TAK Server section.');
    return false;
  }

  const url = `${base}${path}`;
  setStatus('sending', `Sending [${label}] to ${url}…`);
  appendLog(`[${label}] POST ${url}`, 'info');

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: buildHeaders(),
      body:    xml,
    });
    if (resp.ok) {
      setStatus('ok', 'Delivered.', resp.status);
      appendLog(`✓ ${resp.status} ${resp.statusText}`, 'ok');
      return true;
    } else {
      const body = await resp.text().catch(() => '');
      setStatus('error', 'Server error.', resp.status);
      appendLog(`✗ ${resp.status} — ${body.substring(0, 120)}`, 'error');
      return false;
    }
  } catch (err) {
    setStatus('error', `Network error — ${err.message}`);
    appendLog(`✗ ${err.message}`, 'error');
    appendLog('  → Is the proxy running?', 'warn');
    return false;
  }
}


// =============================================================================
// SECTION: COMPOSER-SPECIFIC SEND WRAPPERS
// These wrap sendRawXml() with composer-specific XML generation and logging.
// They live here (not in cot_composer.js) because they involve network I/O.
// =============================================================================

/**
 * Update the inline status badge next to the "▶ Send Chat" button.
 * Mirrors the pattern used by deleteSetStatus / emergencySetStatus.
 *
 * WHY INLINE BADGE: The main setStatus() bar is in the TAK Server panel,
 * which is visually distant from the chat composer. An inline badge gives
 * immediate feedback right at the button the user just clicked.
 *
 * @param {'sending'|'ok'|'error'} state
 * @param {string} message
 */
function chatSetStatus(state, message) {
  const wrap = document.getElementById('chatSendStatus');
  const icon = document.getElementById('chatSendIcon');
  const text = document.getElementById('chatSendText');
  if (!wrap) return;
  const styles = {
    sending: { color: '#f0883e', bg: '#2d2218', border: '#f0883e66', icon: '⏳' },
    ok:      { color: '#3fb950', bg: '#182d1d', border: '#3fb95066', icon: '✓'  },
    error:   { color: '#f85149', bg: '#2d1b1b', border: '#f8514966', icon: '✗'  },
  };
  const s = styles[state] || styles.error;
  wrap.style.display     = 'flex';
  wrap.style.background  = s.bg;
  wrap.style.borderColor = s.border;
  icon.style.color  = s.color;
  icon.textContent  = s.icon;
  text.style.color  = s.color;
  text.textContent  = message;
  // Auto-hide success badge after 4 seconds — errors stay visible
  if (state === 'ok') setTimeout(() => { wrap.style.display = 'none'; }, 4000);
}

/**
 * Send the currently composed chat message to the TAK server.
 * Validates that message text is present before sending.
 * Called by the "▶ Send Chat" button in the GeoChat composer.
 */
async function sendChatMessage() {
  const msg = document.getElementById('chatMessage').value.trim();
  if (!msg) {
    appendLog('Chat: no message text entered.', 'warn');
    return;
  }

  const xml  = buildChatXml();
  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();

  if (!base) {
    appendLog('ERROR: No server URL set.', 'error');
    setStatus('error', 'No server URL — fill in the TAK Server section.');
    return;
  }

  const url    = `${base}${path}`;
  const mode   = document.querySelector('input[name="chatMode"]:checked')?.value || 'direct';
  const sender = document.getElementById('chatSenderCallsign').value.trim() || 'SENDER';

  // Build a recipient label appropriate for the message mode
  const recipient = mode === 'group'     ? (document.getElementById('chatGroupName').value.trim() || 'GROUP')
    : mode === 'team'      ? (document.getElementById('chatTeamColor').value || 'team')
    : mode === 'role'      ? (() => {
        const s = document.getElementById('chatRoleName').value;
        return s === 'custom' ? (document.getElementById('chatRoleCustom').value.trim() || 'role') : s;
      })()
    : mode === 'all'       ? 'All Chat Rooms'
    : mode === 'allgroups' ? 'All Groups'
    : mode === 'allteams'  ? 'All Teams'
    : (document.getElementById('chatRecipient').value.trim() || 'warthog1');

  const modeLabel = { group: 'GROUP', team: 'TEAM', role: 'ROLE',
                      all: 'ALL', allgroups: 'ALL GROUPS', allteams: 'ALL TEAMS' }[mode] || '';

  setStatus('sending', `Sending${modeLabel ? ' ' + modeLabel : ''} chat from ${sender} to ${recipient}…`);
  chatSetStatus('sending', `Sending to ${recipient}…`);
  appendLog(
    `[CHAT${modeLabel ? ' ' + modeLabel : ''}] ${sender} → ${recipient}: "${msg}"`,
    'info'
  );
  appendLog(`POST ${url}`, 'info');

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: buildHeaders(),
      body:    xml,
    });
    if (resp.ok) {
      setStatus('ok', `Chat delivered to ${recipient}.`, resp.status);
      chatSetStatus('ok', `✓ Delivered to ${recipient}`);
      appendLog(`✓ ${resp.status} ${resp.statusText}`, 'ok');
    } else {
      const body = await resp.text().catch(() => '');
      setStatus('error', 'Server error.', resp.status);
      chatSetStatus('error', `${resp.status} ${resp.statusText}`);
      appendLog(`✗ ${resp.status} — ${body.substring(0, 120)}`, 'error');
    }
  } catch (err) {
    setStatus('error', `Network error — ${err.message}`);
    chatSetStatus('error', 'Network error — is the proxy running?');
    appendLog(`✗ ${err.message}`, 'error');
    appendLog('  → Is the proxy running?', 'warn');
  }
}

/**
 * Send the currently composed spot map marker to the TAK server.
 *
 * WHY PERSIST THE UID: If the spotUid field is empty, we generate and persist
 * a UUID back into the field. This ensures that clicking "Send Marker" twice
 * updates the same pin on the ATAK map (same UID = update) rather than
 * creating two separate pins (different UIDs = new pin each time).
 */
async function sendSpotMarker() {
  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();

  if (!base) {
    appendLog('ERROR: No server URL set.', 'error');
    setStatus('error', 'No server URL — fill in the TAK Server section.');
    return;
  }

  // Persist a generated UID so repeat sends update the same ATAK pin
  if (!document.getElementById('spotUid').value.trim()) {
    document.getElementById('spotUid').value = genUuid();
  }

  const xml      = buildSpotXml();
  const callsign = document.getElementById('spotCallsign').value.trim() || 'MARKER';
  const url      = `${base}${path}`;

  setStatus('sending', `Sending spot map marker "${callsign}" to ${url}…`);
  appendLog(`[SPOT MARKER] "${callsign}" → ${url}`, 'info');

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: buildHeaders(),
      body:    xml,
    });
    if (resp.ok) {
      setStatus('ok', `Spot marker "${callsign}" sent.`, resp.status);
      appendLog(`✓ ${resp.status} ${resp.statusText}`, 'ok');
    } else {
      const body = await resp.text().catch(() => '');
      setStatus('error', `Server returned ${resp.status}`, resp.status);
      appendLog(`✗ ${resp.status} ${resp.statusText}: ${body}`, 'error');
    }
  } catch (e) {
    setStatus('error', `Request failed: ${e.message}`);
    appendLog(`✗ ${e.message}`, 'error');
  }
}
