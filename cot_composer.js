// =============================================================================
// cot_composer.js — CoT XML Builders
//
// PURPOSE:
//   Everything that constructs CoT XML strings lives here. Three composers:
//     1. SA Form Composer  — builds standard entity SA beacons from form fields
//     2. Chat Composer     — builds GeoChat b-t-f messages in 7 delivery modes
//     3. Spot Map Composer — builds b-m-p-s-m persistent map markers
//
//   This module contains NO network I/O. Building XML and sending XML are
//   intentionally separated — see cot_sender.js for all fetch() calls.
//
// DEPENDS ON:
//   cot_types.js — nowISO(), staleISO(), genUuid(), toggleSection()
//
// EXPORTS (global functions used by HTML onclick/oninput handlers):
//   generateXML()        — build SA beacon XML from the main form and show in output
//   copyXML()            — copy the output panel XML to clipboard
//   downloadXML()        — download the output panel XML as a .xml file
//   buildChatXml()       — build GeoChat XML from the chat composer fields
//   buildSpotXml()       — build spot map marker XML from the spot composer fields
//   copyChatMessage()    — copy chat XML to clipboard
//   updateChatMode()     — show/hide chat sub-fields based on selected mode
//   addChatMember()      — add a member row to the group chat member list
//   addTeamMember()      — add a UID row to the team color recipient list
//   addRoleMember()      — add a UID row to the role broadcast recipient list
//   addAllGroupsMember() — add a UID row to the All Groups recipient list
//   addAllTeamsMember()  — add a UID row to the All Teams recipient list
//   onRoleSelectChange() — show/hide the custom role text input
//   onSpotColorChange()  — show/hide custom ARGB input and update icon path
//   onSpotIconsetChange()— show/hide custom iconset path input
// =============================================================================


// =============================================================================
// SECTION: SA FORM COMPOSER
// Builds a standard situational awareness CoT beacon from the main form fields.
// Called on every input change (event listeners in index.html) so the output
// panel always shows a live preview.
// =============================================================================

/**
 * Read all SA form fields, build a CoT XML string with fresh timestamps,
 * and update the output panel. Also called by doSend() just before sending
 * to ensure transmitted XML has current timestamps.
 */
function generateXML() {
  // ── Read all form values ──────────────────────────────────────────────────
  const uid        = document.getElementById('uid').value.trim()        || 'FILL-UID-HERE';
  const callsign   = document.getElementById('callsign').value.trim()   || 'CALLSIGN';
  const type       = document.getElementById('type').value.trim()       || 'a-f-G-U-C';
  const how        = document.getElementById('how').value;
  const staleMins  = document.getElementById('staleMins').value;
  const lat        = document.getElementById('lat').value               || '0.0';
  const lon        = document.getElementById('lon').value               || '0.0';
  const hae        = document.getElementById('hae').value               || '0';
  const ce         = document.getElementById('ce').value                || '9999999.0';
  const le         = document.getElementById('le').value                || '9999999.0';
  const groupColor = document.getElementById('groupColor').value;
  const groupRole  = document.getElementById('groupRole').value;
  const speed      = document.getElementById('speed').value             || '0.0';
  const course     = document.getElementById('course').value            || '0.0';
  const device     = document.getElementById('takvDevice').value.trim();
  const platform   = document.getElementById('takvPlatform').value.trim();
  const os         = document.getElementById('takvOs').value.trim();
  const version    = document.getElementById('takvVersion').value.trim();
  const battery    = document.getElementById('battery').value           || '100';
  const endpoint   = document.getElementById('endpoint').value.trim()   || '*:-1:stcp';

  // Optional section toggle states
  const includeTrack   = document.getElementById('enableTrack').checked;
  const includeBattery = document.getElementById('enableBattery').checked;

  const now   = nowISO();
  const stale = staleISO(staleMins);

  // ── Build <detail> block ──────────────────────────────────────────────────
  // Required elements first, then optional toggles.
  // WHY STRING CONCATENATION: Template literals and DOM methods both work here,
  // but concatenation makes the XML structure directly readable in the code.
  let detail = '';

  detail += `    <contact callsign="${callsign}" endpoint="${endpoint}"/>\n`;
  detail += `    <__group name="${groupColor}" role="${groupRole}"/>\n`;
  detail += `    <uid Droid="${callsign}"/>\n`;

  // Only include <takv> if at least one field is populated —
  // an empty <takv device="" platform="" os="" version=""/> is valid but noisy
  if (device || platform || os || version) {
    detail += `    <takv device="${device}" platform="${platform}" os="${os}" version="${version}"/>\n`;
  }

  if (includeTrack) {
    detail += `    <track speed="${speed}" course="${course}"/>\n`;
  }

  if (includeBattery) {
    detail += `    <status battery="${battery}"/>\n`;
  }

  if (document.getElementById('enablePrecision').checked) {
    const gps = document.getElementById('geopointsrc').value;
    const alt = document.getElementById('altsrc').value;
    detail += `    <precisionlocation geopointsrc="${gps}" altsrc="${alt}"/>\n`;
  }

  if (document.getElementById('enableArchive').checked) {
    // <archive/> makes the marker persistent on the TAK server — it survives
    // the stale window and device restarts. Use for intentional permanent markers.
    detail += `    <archive/>\n`;
  }

  if (document.getElementById('enableMilsym').checked) {
    const sym = document.getElementById('milsymId').value.trim();
    // Both __milicon and __milsym are included — older ATAK versions use one,
    // newer versions use the other. Including both ensures maximum compatibility.
    detail += `    <__milicon id="${sym}"/>\n`;
    detail += `    <__milsym id="${sym}"/>\n`;
  }

  if (document.getElementById('enableLink').checked) {
    const luid  = document.getElementById('linkUid').value.trim();
    const lcall = document.getElementById('linkCallsign').value.trim();
    const lrel  = document.getElementById('linkRelation').value;
    const ltype = document.getElementById('linkType').value.trim();
    detail += `    <link uid="${luid}" production_time="${now}" type="${ltype}" parent_callsign="${lcall}" relation="${lrel}"/>\n`;
    detail += `    <creator uid="${luid}" callsign="${lcall}" time="${now}" type="${ltype}"/>\n`;
  }

  if (document.getElementById('enableRemarks').checked) {
    const remarks = document.getElementById('remarks').value;
    detail += `    <remarks>${remarks}</remarks>\n`;
  }

  // ── Assemble full CoT event ───────────────────────────────────────────────
  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${uid}"
       type="${type}"
       how="${how}"
       time="${now}"
       start="${now}"
       stale="${stale}"
       access="Undefined">
  <point lat="${lat}"
         lon="${lon}"
         hae="${hae}"
         ce="${ce}"
         le="${le}"/>
  <detail>
${detail}  </detail>
</event>`;

  document.getElementById('output').textContent = xml;
}

/** Copy the output panel XML to the clipboard and show a toast notification. */
function copyXML() {
  const text = document.getElementById('output').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const t = document.getElementById('toast');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  });
}

/**
 * Download the output panel XML as a .xml file.
 * The filename is derived from the uid field for easy identification.
 */
function downloadXML() {
  const text = document.getElementById('output').textContent;
  const blob = new Blob([text], { type: 'application/xml' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  const uid  = document.getElementById('uid').value.trim() || 'cot_message';
  // Replace characters that are invalid in filenames with underscores
  a.download = `cot_${uid.replace(/[^a-zA-Z0-9_-]/g, '_')}.xml`;
  a.click();
}


// =============================================================================
// SECTION: CHAT COMPOSER
// Builds GeoChat b-t-f CoT messages in seven delivery modes.
//
// CHAT MODES AND THEIR __chat PARENT VALUES:
//   direct     — parent=RootContactGroup, id=recipientUID
//   group      — parent=UserGroups,       id=groupUUID,     includes <hierarchy>
//   team       — parent=TeamGroups,       id=teamColorName  (membership implicit)
//   role       — parent=RootContactGroup, id=roleName       (same as direct — role name is key)
//   all        — parent=RootContactGroup, id="All Chat Rooms"  (reserved literal)
//   allgroups  — parent=RootContactGroup, id="UserGroups",  chatroom="Groups"  (differ!)
//   allteams   — parent=RootContactGroup, id="TeamGroups",  chatroom="Teams"   (differ!)
//
// WHY chatroom AND id DIFFER for allgroups/allteams:
//   ATAK uses the reserved string "Groups"/"Teams" as the visible chatroom name
//   but routes the message internally using the reserved id "UserGroups"/"TeamGroups".
//   These two fields intentionally carry different values — this is confirmed from
//   real ATAK traffic captures.
// =============================================================================

/** Show/hide the chat sub-fields appropriate for the selected delivery mode. */
function updateChatMode() {
  const mode = document.querySelector('input[name="chatMode"]:checked')?.value || 'direct';
  document.getElementById('chatDirectFields').style.display    = mode === 'direct'    ? 'block' : 'none';
  document.getElementById('chatGroupFields').style.display     = mode === 'group'     ? 'block' : 'none';
  document.getElementById('chatTeamFields').style.display      = mode === 'team'      ? 'block' : 'none';
  document.getElementById('chatRoleFields').style.display      = mode === 'role'      ? 'block' : 'none';
  document.getElementById('chatAllFields').style.display       = mode === 'all'       ? 'block' : 'none';
  document.getElementById('chatAllGroupsFields').style.display = mode === 'allgroups' ? 'block' : 'none';
  document.getElementById('chatAllTeamsFields').style.display  = mode === 'allteams'  ? 'block' : 'none';
  buildChatXml();
}

// ── Member list helpers ───────────────────────────────────────────────────────
// Each "add" function creates a dynamic input row for a recipient UID.
// The row includes a remove button that deletes the row and rebuilds the XML.
// Counters ensure unique IDs even if rows are removed and re-added.

let memberCounter      = 0;  // group chat named members
let teamMemberCounter  = 0;  // team color recipient UIDs
let roleMemberCounter  = 0;  // role broadcast recipient UIDs
let allGroupsMemberCounter = 0;
let allTeamsMemberCounter  = 0;

/**
 * Add a callsign + UID row to the group chat member list.
 * @param {string} [callsign] - Pre-fill callsign (used by loadPresetIntoForm)
 * @param {string} [uid]      - Pre-fill UID
 */
function addChatMember(callsign, uid) {
  memberCounter++;
  const id  = `member-${memberCounter}`;
  const row = document.createElement('div');
  row.id    = id;
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <input type="text" placeholder="Callsign (e.g. TRILL)"
           value="${callsign || ''}"
           style="font-size:0.78rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <input type="text" placeholder="Device UID (e.g. ANDROID-xxxx)"
           value="${uid || ''}"
           style="font-family:'Courier New',monospace;font-size:0.72rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <button type="button"
            onclick="document.getElementById('${id}').remove(); buildChatXml();"
            style="padding:4px 8px;color:#f85149;border-color:#f85149;font-size:0.75rem;flex-shrink:0;">✕</button>`;
  document.getElementById('chatMemberList').appendChild(row);
  buildChatXml();
}

/** Read all group chat members from the dynamic list. */
function getChatMembers() {
  return [...document.getElementById('chatMemberList').children].map(row => {
    const inputs = row.querySelectorAll('input');
    return { callsign: inputs[0].value.trim(), uid: inputs[1].value.trim() };
  }).filter(m => m.uid);
}

function addTeamMember(uid) {
  teamMemberCounter++;
  const id  = `tmember-${teamMemberCounter}`;
  const row = document.createElement('div');
  row.id    = id;
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <input type="text" placeholder="Device UID (e.g. ANDROID-xxxx)"
           value="${uid || ''}"
           style="font-family:'Courier New',monospace;font-size:0.72rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <button type="button"
            onclick="document.getElementById('${id}').remove(); buildChatXml();"
            style="padding:4px 8px;color:#f85149;border-color:#f85149;font-size:0.75rem;">✕</button>`;
  document.getElementById('chatTeamMemberList').appendChild(row);
  buildChatXml();
}

function getTeamMembers() {
  return [...document.getElementById('chatTeamMemberList').children]
    .map(row => row.querySelector('input').value.trim())
    .filter(Boolean);
}

function addRoleMember(uid) {
  roleMemberCounter++;
  const id  = `rmember-${roleMemberCounter}`;
  const row = document.createElement('div');
  row.id    = id;
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <input type="text" placeholder="Device UID (e.g. ANDROID-xxxx)"
           value="${uid || ''}"
           style="font-family:'Courier New',monospace;font-size:0.72rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <button type="button"
            onclick="document.getElementById('${id}').remove(); buildChatXml();"
            style="padding:4px 8px;color:#f85149;border-color:#f85149;font-size:0.75rem;">✕</button>`;
  document.getElementById('chatRoleMemberList').appendChild(row);
  buildChatXml();
}

function getRoleMembers() {
  return [...document.getElementById('chatRoleMemberList').children]
    .map(row => row.querySelector('input').value.trim())
    .filter(Boolean);
}

function addAllGroupsMember(uid) {
  allGroupsMemberCounter++;
  const id  = `agmember-${allGroupsMemberCounter}`;
  const row = document.createElement('div');
  row.id    = id;
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <input type="text" placeholder="Device UID (e.g. ANDROID-xxxx)"
           value="${uid || ''}"
           style="font-family:'Courier New',monospace;font-size:0.72rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <button type="button"
            onclick="document.getElementById('${id}').remove(); buildChatXml();"
            style="padding:4px 8px;color:#f85149;border-color:#f85149;font-size:0.75rem;">✕</button>`;
  document.getElementById('chatAllGroupsMemberList').appendChild(row);
  buildChatXml();
}

function getAllGroupsMembers() {
  return [...document.getElementById('chatAllGroupsMemberList').children]
    .map(row => row.querySelector('input').value.trim())
    .filter(Boolean);
}

function addAllTeamsMember(uid) {
  allTeamsMemberCounter++;
  const id  = `atmember-${allTeamsMemberCounter}`;
  const row = document.createElement('div');
  row.id    = id;
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <input type="text" placeholder="Device UID (e.g. ANDROID-xxxx or warthog1)"
           value="${uid || ''}"
           style="font-family:'Courier New',monospace;font-size:0.72rem;"
           oninput="buildChatXml()" onchange="buildChatXml()"/>
    <button type="button"
            onclick="document.getElementById('${id}').remove(); buildChatXml();"
            style="padding:4px 8px;color:#f85149;border-color:#f85149;font-size:0.75rem;">✕</button>`;
  document.getElementById('chatAllTeamsMemberList').appendChild(row);
  buildChatXml();
}

function getAllTeamsMembers() {
  return [...document.getElementById('chatAllTeamsMemberList').children]
    .map(row => row.querySelector('input').value.trim())
    .filter(Boolean);
}

/** Show/hide the custom role text input when "Custom…" is selected. */
function onRoleSelectChange() {
  const sel    = document.getElementById('chatRoleName');
  const custom = document.getElementById('chatRoleCustom');
  custom.style.display = sel.value === 'custom' ? 'block' : 'none';
  buildChatXml();
}

/**
 * Build a GeoChat CoT XML string from the chat composer fields.
 * Updates the live preview panel and returns the XML string so callers
 * (sendChatMessage, copyChatMessage) can use it immediately.
 *
 * WHY A FRESH msgUuid ON EVERY CALL:
 *   Each call to buildChatXml() generates a new UUID for the message.
 *   This matches ATAK behavior — every send creates a distinct message.
 *   If we reused the same UUID, the TAK server would deduplicate repeated
 *   sends and the second one would not appear in ATAK's chat window.
 *
 * @returns {string} Complete CoT XML string
 */
function buildChatXml() {
  const mode           = document.querySelector('input[name="chatMode"]:checked')?.value || 'direct';
  const senderCallsign = document.getElementById('chatSenderCallsign').value.trim() || 'SENDER';
  const senderUid      = document.getElementById('chatSenderUid').value.trim()      || 'ANDROID-example0000000001';
  const serverDest     = document.getElementById('chatServerDest').value.trim()     || '';
  const messageText    = document.getElementById('chatMessage').value.trim()        || '';

  // Sender position taken from the main SA form fields (shared state)
  const lat  = document.getElementById('lat').value.trim() || '0.0';
  const lon  = document.getElementById('lon').value.trim() || '0.0';
  const hae  = document.getElementById('hae').value.trim() || '0';

  const msgUuid = genUuid();
  const now     = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // nowMs keeps milliseconds for the remarks time= attribute — ATAK expects
  // full precision there even though the event time= uses second precision
  const nowMs   = new Date().toISOString();
  const stale   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const serverDestLine = serverDest ? `<__serverdestination destinations="${serverDest}"/>` : '';

  let xml;

  if (mode === 'direct') {
    const chatroom     = document.getElementById('chatRecipient').value.trim()    || 'warthog1';
    const recipientUid = document.getElementById('chatRecipientUid').value.trim() || chatroom;
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.${recipientUid}.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="${chatroom}"
            id="${recipientUid}"
            senderCallsign="${senderCallsign}">
      <chatgrp uid0="${senderUid}" uid1="${recipientUid}" id="${recipientUid}"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" to="${recipientUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else if (mode === 'group') {
    const groupName = document.getElementById('chatGroupName').value.trim() || 'GROUP';
    let groupUuid   = document.getElementById('chatGroupUid').value.trim();
    if (!groupUuid) {
      // Auto-generate and persist the group UUID — must be stable across all
      // messages in the same group so ATAK threads them together
      groupUuid = genUuid();
      document.getElementById('chatGroupUid').value = groupUuid;
    }
    const members      = getChatMembers();
    const allUids      = [senderUid, ...members.map(m => m.uid)];
    const chatgrpUids  = allUids.map((u, i) => `uid${i}="${u}"`).join('\n               ');
    const allMembers   = [{ callsign: senderCallsign, uid: senderUid }, ...members];
    const contactLines = allMembers
      .map(m => `            <contact uid="${m.uid}" name="${m.callsign || m.uid}"/>`)
      .join('\n');

    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.${groupUuid}.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="UserGroups"
            groupOwner="true"
            messageId="${msgUuid}"
            chatroom="${groupName}"
            id="${groupUuid}"
            senderCallsign="${senderCallsign}">
      <chatgrp ${chatgrpUids} id="${groupUuid}"/>
      <hierarchy>
        <group uid="UserGroups" name="Groups">
          <group uid="${groupUuid}" name="${groupName}">
${contactLines}
          </group>
        </group>
      </hierarchy>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else if (mode === 'team') {
    const teamColor   = document.getElementById('chatTeamColor').value;
    const extraUids   = getTeamMembers();
    const allUids     = [senderUid, ...extraUids];
    const chatgrpUids = allUids.map((u, i) => `uid${i}="${u}"`).join('\n               ');

    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.${teamColor}.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="TeamGroups"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="${teamColor}"
            id="${teamColor}"
            senderCallsign="${senderCallsign}">
      <chatgrp ${chatgrpUids} id="${teamColor}"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else if (mode === 'role') {
    const roleSelect = document.getElementById('chatRoleName').value;
    const roleName   = roleSelect === 'custom'
      ? (document.getElementById('chatRoleCustom').value.trim() || 'HQ')
      : roleSelect;
    const roleUids    = getRoleMembers();
    const allRoleUids = [senderUid, ...roleUids];
    const roleChatgrp = allRoleUids.map((u, i) => `uid${i}="${u}"`).join('\n               ');

    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.${roleName}.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="${roleName}"
            id="${roleName}"
            senderCallsign="${senderCallsign}">
      <chatgrp ${roleChatgrp} id="${roleName}"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else if (mode === 'allgroups') {
    const agUids    = getAllGroupsMembers();
    const allAgUids = [senderUid, ...agUids];
    const agChatgrp = allAgUids.map((u, i) => `uid${i}="${u}"`).join('\n               ');

    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.UserGroups.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="Groups"
            id="UserGroups"
            senderCallsign="${senderCallsign}">
      <chatgrp ${agChatgrp} id="UserGroups"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else if (mode === 'allteams') {
    const atUids    = getAllTeamsMembers();
    const allAtUids = [senderUid, ...atUids];
    const atChatgrp = allAtUids.map((u, i) => `uid${i}="${u}"`).join('\n               ');

    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.TeamGroups.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="Teams"
            id="TeamGroups"
            senderCallsign="${senderCallsign}">
      <chatgrp ${atChatgrp} id="TeamGroups"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;

  } else {
    // mode === 'all' — global "All Chat Rooms" broadcast
    // uid1 is the literal string "All Chat Rooms" (not a device UID).
    // remarks includes to="All Chat Rooms" — this is present on global broadcasts
    // but absent on team/role broadcasts (confirmed from real ATAK traffic).
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.${senderUid}.All Chat Rooms.${msgUuid}"
       type="b-t-f" how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="All Chat Rooms"
            id="All Chat Rooms"
            senderCallsign="${senderCallsign}">
      <chatgrp uid0="${senderUid}" uid1="All Chat Rooms" id="All Chat Rooms"/>
    </__chat>
    <link uid="${senderUid}" type="a-f-G-U-C" relation="p-p"/>
    ${serverDestLine}
    <remarks source="BAO.F.ATAK.${senderUid}" to="All Chat Rooms" time="${nowMs}">${messageText}</remarks>
  </detail>
</event>`;
  }

  // Update the live preview panel
  const previewEl = document.getElementById('chatPreviewXml');
  previewEl.textContent    = xml;
  previewEl.style.color    = '#c9d1d9';
  previewEl.style.fontStyle = 'normal';

  return xml;
}

/** Copy the chat composer XML to the clipboard and show a toast. */
function copyChatMessage() {
  const xml = buildChatXml();
  navigator.clipboard.writeText(xml).then(() => {
    const t = document.getElementById('toast');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  });
}


// =============================================================================
// SECTION: SPOT MAP MARKER COMPOSER
// Builds b-m-p-s-m (Spot Map marker) CoT XML.
//
// KEY DIFFERENCES FROM SA BEACONS:
//   - stale is 1 year (persistent map annotation, not a live position report)
//   - <archive/> present — marker survives stale window and TAK server restarts
//   - ce/le = 10.0 (GPS-placed, actual precision) not 9999999.0
//   - <color argb=""> uses signed 32-bit ARGB (not CSS hex)
//   - <usericon iconsetpath="..."> drives the dot color — path encodes ARGB value
//   - No <takv> — this is a marker, not a device SA report
// =============================================================================

/** Show/hide the custom ARGB input when "Custom…" color is selected. */
function onSpotColorChange() {
  const sel = document.getElementById('spotColor');
  document.getElementById('spotColorCustom').style.display =
    sel.value === 'custom' ? 'block' : 'none';
  buildSpotXml();
}

/** Show/hide the custom iconset path input when "Custom…" is selected. */
function onSpotIconsetChange() {
  const sel = document.getElementById('spotIconset');
  document.getElementById('spotIconsetCustom').style.display =
    sel.value === 'custom' ? 'block' : 'none';
  buildSpotXml();
}

/**
 * Build a spot map marker CoT XML string and update the live preview.
 *
 * ICON PATH CONVENTION:
 *   Color dots: COT_MAPPING_SPOTMAP/b-m-p-s-m/{argb}
 *     The ARGB value is encoded directly in the path — it must match <color argb="">.
 *   Text label: COT_MAPPING_SPOTMAP/b-m-p-s-m/LABEL
 *     Renders only the callsign as map text, no colored dot.
 *   2525C symbol: COT_MAPPING_2525C/b-m-p-s-m/b-m-p-s-m
 *     Uses the MIL-STD-2525C waypoint symbol.
 *
 * @returns {string} Complete CoT XML string
 */
function buildSpotXml() {
  let uid = document.getElementById('spotUid').value.trim();
  // Generate a preview UUID but don't persist it — the send function persists
  // it so the same UID is used on subsequent sends (update vs. create new pin)
  if (!uid) uid = 'spot-' + genUuid();

  const callsign    = document.getElementById('spotCallsign').value.trim()       || 'MARKER';
  const lat         = document.getElementById('spotLat').value.trim()             || '0.0';
  const lon         = document.getElementById('spotLon').value.trim()             || '0.0';
  const hae         = document.getElementById('spotHae').value.trim()             || '0.0';
  const ce          = document.getElementById('spotCe').value.trim()              || '10.0';
  const creatorCall = document.getElementById('spotCreatorCallsign').value.trim() || '';
  const creatorUid  = document.getElementById('spotCreatorUid').value.trim()      || '';
  const creatorType = document.getElementById('spotCreatorType').value.trim()     || 'a-f-G-U-C';

  // Signed 32-bit ARGB integer — -1 = 0xFFFFFFFF = white
  const colorSel = document.getElementById('spotColor').value;
  const argb     = colorSel === 'custom'
    ? (document.getElementById('spotColorCustom').value.trim() || '-1')
    : colorSel;

  // Derive the icon path from the iconset selector
  const iconSel  = document.getElementById('spotIconset').value;
  const iconPath = iconSel === 'spotmap'
    ? `COT_MAPPING_SPOTMAP/b-m-p-s-m/${argb}`
    : iconSel === 'label'
      ? 'COT_MAPPING_SPOTMAP/b-m-p-s-m/LABEL'
      : iconSel === 'custom'
        ? (document.getElementById('spotIconsetCustom').value.trim() || `COT_MAPPING_SPOTMAP/b-m-p-s-m/${argb}`)
        : iconSel;

  const now   = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // 1 year stale — spot map markers are persistent annotations, not live tracks
  const stale = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
                  .toISOString().replace(/\.\d{3}Z$/, 'Z');

  const creatorLine = creatorUid
    ? `\n    <creator uid="${creatorUid}" callsign="${creatorCall}" time="${now}" type="${creatorType}"/>`
    : '';
  const linkLine = creatorUid
    ? `\n    <link uid="${creatorUid}" production_time="${now}" type="${creatorType}" parent_callsign="${creatorCall}" relation="p-p"/>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${uid}"
       type="b-m-p-s-m"
       how="h-g-i-g-o"
       time="${now}"
       start="${now}"
       stale="${stale}"
       access="Undefined">
  <point lat="${lat}" lon="${lon}" hae="${hae}" ce="${ce}" le="${ce}"/>
  <detail>
    <contact callsign="${callsign}"/>
    <precisionlocation geopointsrc="GPS" altsrc="GPS"/>
    <status readiness="true"/>
    <archive/>${creatorLine}
    <usericon iconsetpath="${iconPath}"/>
    <color argb="${argb}"/>${linkLine}
    <remarks/>
  </detail>
</event>`;

  const previewEl = document.getElementById('spotPreviewXml');
  previewEl.textContent    = xml;
  previewEl.style.color    = '#c9d1d9';
  previewEl.style.fontStyle = 'normal';

  return xml;
}
