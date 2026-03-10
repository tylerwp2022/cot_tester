// =============================================================================
// cot_presets.js — Preset CoT Library
//
// PURPOSE:
//   A curated library of verified CoT XML templates covering all major
//   entity types. Each preset has:
//     - A human-readable label
//     - A staleMins value
//     - Optional formValues for "Load into Form"
//     - An xml() function that generates fresh XML with {{NOW}}/{{STALE}} replaced
//
// ALL PRESETS ARE VERIFIED:
//   Every preset in this file was confirmed against real ATAK traffic captures.
//   Comments note which fields were confirmed, and why certain values were chosen
//   over the "obvious" alternatives (e.g. why UGV uses a-f-G-U-C-R not a-f-G-E-V).
//
// DEPENDS ON:
//   cot_types.js  — genUuid()
//   cot_sender.js — sendRawXml(), buildHeaders(), appendLog(), setStatus()
//
// EXPORTS (global functions used by HTML onclick handlers):
//   selectPreset(key)      — highlight a preset card and show its preview
//   sendPreset()           — send the currently selected preset with fresh timestamps
//   copyPreset()           — copy the currently selected preset XML to clipboard
//   loadPresetIntoForm()   — populate the appropriate composer from the preset
//   renderPresetXml(key)   — generate fresh XML for a given preset key
//
// ADDING A NEW PRESET:
//   1. Add an entry to the PRESETS object with a unique key
//   2. Add a matching <div class="preset-card"> in index.html
//   3. The key must match between the PRESETS entry and the card id="card-{key}"
// =============================================================================


// =============================================================================
// SECTION: TIMESTAMP HELPERS FOR PRESETS
// Separate from the main nowISO()/staleISO() to avoid confusion — these are
// used only inside preset xml() functions.
// =============================================================================

/** @returns {string} Current time as Z-suffix ISO string */
function presetNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {number} mins - Minutes from now
 * @returns {string} Future time as Z-suffix ISO string
 */
function presetStale(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Generate fresh XML for the given preset key, with current timestamps.
 * @param {string} key - Key into the PRESETS object
 * @returns {string}   - Complete CoT XML string
 */
function renderPresetXml(key) {
  const p     = PRESETS[key];
  const now   = presetNow();
  const stale = presetStale(p.staleMins);
  return p.xml(now, stale);
}


// =============================================================================
// SECTION: PRESET LIBRARY
//
// KEY DESIGN DECISIONS per preset:
//
//   UGV (ugv_position) uses type a-f-G-U-C-R (Combat Reconnaissance) not a-f-G-E-V:
//     MIL-STD-2525C symbols represent battlefield ROLE/FUNCTION, not platform type.
//     ATAK has no unmanned ground vehicle symbol. Warthog's mission is mobile
//     camera recon — R (Rotary/Recon) under Combat Arms is the closest match.
//     This was confirmed by examining real ATAK streams from the Warthog.
//
//   UAV (uav_position) uses Ground dimension (a-f-G-U-C-V-U-R) not Air (a-f-A):
//     Small UAS Groups 1-2 are treated as ground unit organic equipment in doctrine.
//     They don't file flight plans or interact with ATC. Air dimension is correct
//     ONLY when operating in controlled airspace (see uav_air_rpv preset).
//
//   Drawn shapes (phase_line, nai_polygon) use how="h-e" not "h-g-i-g-o":
//     h-g-i-g-o is "human long-pressed map" (drop pin gesture). Drawn shapes
//     are placed by the drawing tool, not a single map tap — h-e is correct.
//
//   Spot map (spotmap_white) uses ce/le=10.0 not 9999999.0:
//     The operator places it on a GPS-known location. Real precision is known,
//     unlike SA beacons where position accuracy is truly unknown.
// =============================================================================

const PRESETS = {

  // ── Friendly Ground Marker ─────────────────────────────────────────────────
  // Manually placed friendly ground position marker.
  // Includes <archive/>, <link>, and <creator> as a real ATAK drop-pin does.
  friendly_ground_marker: {
    label: 'Friendly Ground Marker',
    staleMins: 5,
    formValues: {
      uid: 'a1b2c3d4-0001-4000-aaaa-example00001',
      callsign: 'BRAVO-ACTUAL', type: 'a-f-G', how: 'h-g-i-g-o',
      lat: '41.3913988', lon: '-73.9531347', hae: '-19.253',
      ce: '9999999.0', le: '9999999.0',
      groupColor: 'Cyan', groupRole: 'Team Lead', milsym: 'SFG*------*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="a1b2c3d4-0001-4000-aaaa-example00001"
       type="a-f-G"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3913988" lon="-73.9531347" hae="-19.253" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="BRAVO-ACTUAL"/>
    <status readiness="true"/>
    <archive/>
    <link uid="a1b2c3d4-0002-4000-aaaa-example00002"
          production_time="${now}"
          type="a-f-G-U-C"
          parent_callsign="BRAVO-ACTUAL"
          relation="p-p"/>
    <remarks/>
    <color argb="-1"/>
    <__milicon id="SFG*------*****"/>
    <__milsym id="SFG*------*****"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G"/>
    <precisionlocation altsrc="SRTM1"/>
    <creator uid="a1b2c3d4-0002-4000-aaaa-example00002"
             callsign="BRAVO-ACTUAL"
             time="${now}"
             type="a-f-G-U-C"/>
  </detail>
</event>`,
  },

  // ── SA Beacon (Human Infantry) ────────────────────────────────────────────
  sa_beacon: {
    label: 'SA Beacon (Infantry)',
    staleMins: 6,
    formValues: {
      uid: 'ANDROID-example0000000001', callsign: 'FOXTROT-6',
      type: 'a-f-G-U-C', how: 'h-e',
      lat: '41.3912267', lon: '-73.9527021', hae: '-32.2',
      ce: '9999999.0', le: '9999999.0',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '0.0', course: '180.0',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="ANDROID-example0000000001"
       type="a-f-G-U-C"
       how="h-e"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3912267" lon="-73.9527021" hae="-32.2" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="FOXTROT-6" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="FOXTROT-6"/>
    <takv device="SAMSUNG SM-G736U1" platform="ATAK" os="36" version="5.6.0.12"/>
    <track speed="0.0" course="180.0"/>
    <status battery="85"/>
    <precisionlocation geopointsrc="USER" altsrc="SRTM1"/>
  </detail>
</event>`,
  },

  // ── UGV Position Report ────────────────────────────────────────────────────
  // type a-f-G-U-C-R confirmed from ATAK stream.
  // Uses Combat Reconnaissance not Equipment because 2525C represents
  // ROLE (mobile camera recon) not platform type (ground robot).
  // speed=1.5 m/s: ATAK only renders orientation arrow at speed >= 1.4 m/s.
  ugv_position: {
    label: 'UGV Position Report (Combat Recon)',
    staleMins: 1,
    formValues: {
      uid: 'ugv-warthog-example-serial-001', callsign: 'WARTHOG-1',
      type: 'a-f-G-U-C-R', how: 'm-g',
      lat: '41.391145', lon: '-73.953182', hae: '0',
      ce: '10', le: '10',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '1.5', course: '90.0', milsym: 'SFG*UCR---*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="ugv-warthog-example-serial-001"
       type="a-f-G-U-C-R"
       how="m-g"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.391145" lon="-73.953182" hae="0" ce="10" le="10"/>
  <detail>
    <contact callsign="WARTHOG-1" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="WARTHOG-1"/>
    <takv device="RRC Robot" platform="Pytak-Client" os="Ubuntu 24.04" version="5.3.0.155"/>
    <track speed="1.5" course="90.0"/>
    <status battery="75"/>
    <!-- speed >= 1.4 m/s required for ATAK orientation arrow to render.
         Set to 0.0 if the robot is stationary. -->
    <__milicon id="SFG*UCR---*****"/>
    <__milsym id="SFG*UCR---*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G"/>
  </detail>
</event>`,
  },

  // ── UAV — Rotary Wing / Quadcopter (Ground classification) ────────────────
  // type a-f-G-U-C-V-U-R confirmed from ATAK "UAV > Rotary Wing".
  // Ground dimension because small UAS (Group 1-2) are ground unit organic assets.
  // Parrot Anafi is a quadcopter — rotary wing is the correct subtype.
  uav_position: {
    label: 'UAV — Rotary Wing (Anafi / Quadcopter)',
    staleMins: 1,
    formValues: {
      uid: 'uav-anafi-example-serial-001', callsign: 'EAGLE-1',
      type: 'a-f-G-U-C-V-U-R', how: 'm-g',
      lat: '41.3920000', lon: '-73.9520000', hae: '50.0',
      ce: '5', le: '5',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '5.0', course: '270.0', milsym: 'SFG*UCVUR-*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="uav-anafi-example-serial-001"
       type="a-f-G-U-C-V-U-R"
       how="m-g"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3920000" lon="-73.9520000" hae="50.0" ce="5" le="5"/>
  <detail>
    <contact callsign="EAGLE-1" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="EAGLE-1"/>
    <takv device="Parrot Anafi" platform="Pytak-Client" os="Ubuntu 24.04" version="5.3.0.155"/>
    <track speed="5.0" course="270.0"/>
    <status battery="60"/>
    <__milicon id="SFG*UCVUR-*****"/>
    <__milsym id="SFG*UCVUR-*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G-E-V"/>
  </detail>
</event>`,
  },

  // ── UAV — Generic ─────────────────────────────────────────────────────────
  uav_generic: {
    label: 'UAV — Generic Unmanned Aerial Vehicle',
    staleMins: 1,
    formValues: {
      uid: 'uav-generic-example-serial-001', callsign: 'UAV-1',
      type: 'a-f-G-U-C-V-U', how: 'm-g',
      lat: '41.3920000', lon: '-73.9520000', hae: '50.0',
      ce: '5', le: '5',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '5.0', course: '0.0', milsym: 'SFG*UCVU--*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="uav-generic-example-serial-001"
       type="a-f-G-U-C-V-U"
       how="m-g"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3920000" lon="-73.9520000" hae="50.0" ce="5" le="5"/>
  <detail>
    <contact callsign="UAV-1" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="UAV-1"/>
    <takv device="UAV" platform="Pytak-Client" os="Ubuntu 24.04" version="5.3.0.155"/>
    <track speed="5.0" course="0.0"/>
    <status battery="80"/>
    <__milicon id="SFG*UCVU--*****"/>
    <__milsym id="SFG*UCVU--*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G-E-V"/>
  </detail>
</event>`,
  },

  // ── UAV — Fixed Wing ─────────────────────────────────────────────────────
  uav_fixed_wing: {
    label: 'UAV — Fixed Wing',
    staleMins: 1,
    formValues: {
      uid: 'uav-fixedwing-example-serial-001', callsign: 'HAWK-1',
      type: 'a-f-G-U-C-V-U-F', how: 'm-g',
      lat: '41.3920000', lon: '-73.9520000', hae: '100.0',
      ce: '5', le: '5',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '15.0', course: '0.0', milsym: 'SFG*UCVUF-*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="uav-fixedwing-example-serial-001"
       type="a-f-G-U-C-V-U-F"
       how="m-g"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3920000" lon="-73.9520000" hae="100.0" ce="5" le="5"/>
  <detail>
    <contact callsign="HAWK-1" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="HAWK-1"/>
    <takv device="Fixed Wing UAV" platform="Pytak-Client" os="Ubuntu 24.04" version="5.3.0.155"/>
    <track speed="15.0" course="0.0"/>
    <status battery="80"/>
    <__milicon id="SFG*UCVUF-*****"/>
    <__milsym id="SFG*UCVUF-*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G-E-V"/>
  </detail>
</event>`,
  },

  // ── UAV — Rotary Wing Drone RPV (Air classification) ─────────────────────
  // Use Air dimension when operating around manned aviation / ATC environments.
  uav_air_rpv: {
    label: 'UAV — Rotary Drone RPV (Air classification)',
    staleMins: 1,
    formValues: {
      uid: 'uav-rpv-example-serial-001', callsign: 'RPV-1',
      type: 'a-f-A-M-H-Q', how: 'm-g',
      lat: '41.3920000', lon: '-73.9520000', hae: '50.0',
      ce: '5', le: '5',
      groupColor: 'Cyan', groupRole: 'Team Member',
      speed: '5.0', course: '0.0', milsym: 'SFA*MHQ---*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="uav-rpv-example-serial-001"
       type="a-f-A-M-H-Q"
       how="m-g"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3920000" lon="-73.9520000" hae="50.0" ce="5" le="5"/>
  <detail>
    <contact callsign="RPV-1" endpoint="*:-1:stcp"/>
    <__group name="Cyan" role="Team Member"/>
    <uid Droid="RPV-1"/>
    <takv device="Rotary UAV" platform="Pytak-Client" os="Ubuntu 24.04" version="5.3.0.155"/>
    <track speed="5.0" course="0.0"/>
    <status battery="80"/>
    <__milicon id="SFA*MHQ---*****"/>
    <__milsym id="SFA*MHQ---*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-f/a-f-G-E-V"/>
  </detail>
</event>`,
  },

  // ── Hostile Ground Vehicle ────────────────────────────────────────────────
  hostile_vehicle: {
    label: 'Hostile Vehicle',
    staleMins: 5,
    formValues: {
      uid: 'a1b2c3d4-0010-4000-aaaa-example00010', callsign: 'HOSTILE-VEH-1',
      type: 'a-h-G-E-V', how: 'h-g-i-g-o',
      lat: '41.3905000', lon: '-73.9540000', hae: '0',
      ce: '9999999.0', le: '9999999.0',
      groupColor: 'Red', groupRole: 'Team Member', milsym: 'SHG*EV----*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="a1b2c3d4-0010-4000-aaaa-example00010"
       type="a-h-G-E-V"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3905000" lon="-73.9540000" hae="0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="HOSTILE-VEH-1"/>
    <__group name="Red" role="Team Member"/>
    <uid Droid="HOSTILE-VEH-1"/>
    <track speed="0.0" course="0.0"/>
    <archive/>
    <__milicon id="SHG*EV----*****"/>
    <__milsym id="SHG*EV----*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-h/a-h-G"/>
    <remarks>Observed hostile vehicle - operator placed</remarks>
  </detail>
</event>`,
  },

  // ── Unknown Ground Contact ────────────────────────────────────────────────
  unknown_ground: {
    label: 'Unknown Ground Contact',
    staleMins: 5,
    formValues: {
      uid: 'a1b2c3d4-0020-4000-aaaa-example00020', callsign: 'UNK-CONTACT-1',
      type: 'a-u-G', how: 'h-g-i-g-o',
      lat: '41.3908000', lon: '-73.9515000', hae: '0',
      ce: '9999999.0', le: '9999999.0',
      groupColor: 'Yellow', groupRole: 'Team Member', milsym: 'SUG*------*****',
    },
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="a1b2c3d4-0020-4000-aaaa-example00020"
       type="a-u-G"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3908000" lon="-73.9515000" hae="0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="UNK-CONTACT-1"/>
    <__group name="Yellow" role="Team Member"/>
    <uid Droid="UNK-CONTACT-1"/>
    <track speed="0.0" course="0.0"/>
    <archive/>
    <__milicon id="SUG*------*****"/>
    <__milsym id="SUG*------*****"/>
    <color argb="-1"/>
    <usericon iconsetpath="COT_MAPPING_2525C/a-u/a-u-G"/>
    <remarks>Unidentified ground contact - pending classification</remarks>
  </detail>
</event>`,
  },

  // ── Spot Map Marker (White) ───────────────────────────────────────────────
  // Confirmed from real ATAK: TRILL3 dropped a white dot to warthog1.
  // stale=1 year, ce/le=10.0, <archive/>, <color argb="-1"/>, <creator>.
  // iconsetpath encodes the ARGB value: COT_MAPPING_SPOTMAP/b-m-p-s-m/-1
  spotmap_white: {
    label: 'Spot Map Marker (White)',
    staleMins: 525960, // ~1 year
    formValues: null,  // Spot map markers load into the spot map composer, not SA form
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="spot-example-0001-0000-000000000001"
       type="b-m-p-s-m"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="39.3526111" lon="-76.3452495" hae="0.0" ce="10.0" le="10.0"/>
  <detail>
    <contact callsign="W 1"/>
    <precisionlocation geopointsrc="GPS" altsrc="GPS"/>
    <status readiness="true"/>
    <archive/>
    <usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/-1"/>
    <creator uid="ANDROID-dfac01d76beec661" callsign="TRILL3" time="${now}" type="a-f-G-U-C"/>
    <color argb="-1"/>
    <link uid="ANDROID-dfac01d76beec661" production_time="${now}"
          type="a-f-G-U-C" parent_callsign="TRILL3" relation="p-p"/>
    <remarks/>
  </detail>
</event>`,
  },

  // ── Drawing Circle (Orange) ───────────────────────────────────────────────
  // type u-d-c-c — user-drawn circle/ellipse, confirmed from real ATAK traffic.
  // Geometry in <shape><ellipse>, KML style block embedded inside <shape>,
  // <point> is the actual center (not just centroid anchor like u-d-f).
  // KML colors are ARGB hex (ATAK extension — standard KML uses ABGR).
  drawing_circle: {
    label: 'Drawing Circle (Orange)',
    staleMins: 1440,
    formValues: null,
    xml: (now, stale) => {
      // Drawing shapes get fresh UIDs at render time — the operator draws a new
      // shape each time, there's no stable entity to update.
      const shapeUid = genUuid();
      const styleUid = genUuid();
      return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${shapeUid}"
       type="u-d-c-c"
       how="h-e"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="39.3500645" lon="-76.3447905" hae="-24.864" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="Drawing Circle 1"/>
    <shape>
      <ellipse major="13.839557463263446" minor="13.839557463263446" angle="360"/>
      <link uid="${styleUid}.Style" type="b-x-KmlStyle" relation="p-c">
        <Style>
          <LineStyle>
            <color>ffff7700</color>
            <width>1.7000000476837158</width>
          </LineStyle>
          <PolyStyle>
            <color>16ff7700</color>
          </PolyStyle>
        </Style>
      </link>
    </shape>
    <__shapeExtras cpvis="true" editable="true"/>
    <strokeColor value="-35072"/>
    <strokeWeight value="1.7000000476837158"/>
    <strokeStyle value="solid"/>
    <fillColor value="385840896"/>
    <archive/>
    <labels_on value="true"/>
    <creator uid="ANDROID-dfac01d76beec661" callsign="TRILL3" time="${now}" type="a-f-G-U-C"/>
    <precisionlocation altsrc="SRTM1"/>
    <remarks/>
  </detail>
</event>`;
    },
  },

  // ── NAI Polygon ───────────────────────────────────────────────────────────
  // type u-d-f — closed polygon. Confirmed from real ATAK traffic.
  // fillColor=0 (fully transparent — outline only).
  // First and last <link point> are identical — ATAK polygon-close convention.
  nai_polygon: {
    label: 'NAI Polygon',
    staleMins: 1440,
    formValues: null,
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${genUuid()}"
       type="u-d-f"
       how="h-e"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="39.3501311" lon="-76.3439944" hae="-23.235" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="Named Area of Interest (NAI) 1"/>
    <link point="39.3502086,-76.3439857,-23.33"/>
    <link point="39.3501125,-76.3440859,-23.577"/>
    <link point="39.3500643,-76.3439987,-23.143"/>
    <link point="39.3501389,-76.3439074,-22.842"/>
    <link point="39.3502086,-76.3439857,-23.33"/>
    <__shapeExtras cpvis="true" editable="true"/>
    <__milsym id="G*G*SAN---****X"/>
    <strokeColor value="-1"/>
    <strokeWeight value="1.7000000476837158"/>
    <strokeStyle value="solid"/>
    <fillColor value="0"/>
    <archive/>
    <labels_on value="false"/>
    <creator uid="ANDROID-dfac01d76beec661" callsign="TRILL" time="${now}" type="a-f-G-U-C"/>
    <color value="-1"/>
    <precisionlocation altsrc="SRTM1"/>
    <remarks/>
  </detail>
</event>`,
  },

  // ── Phase Line ────────────────────────────────────────────────────────────
  // type u-d-f — line/polyline. Confirmed from real ATAK traffic.
  // <point> is centroid only — actual endpoints in <link point="lat,lon,hae">.
  // <__milsym id="G*G*GLP---****X"> drives the "PL" endpoint labels.
  // how="h-e" not "h-g-i-g-o" — drawn with the line tool, not a map press.
  phase_line: {
    label: 'Phase Line',
    staleMins: 1440,
    formValues: null,
    xml: (now, stale) => `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${genUuid()}"
       type="u-d-f"
       how="h-e"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="39.3516968" lon="-76.344402" hae="-24.577" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="Phase Line 1"/>
    <link point="39.3518366,-76.3445229,-24.846"/>
    <link point="39.3515571,-76.3442812,-24.517"/>
    <__shapeExtras cpvis="true" editable="true"/>
    <__milsym id="G*G*GLP---****X"/>
    <strokeColor value="-1"/>
    <strokeWeight value="1.7000000476837158"/>
    <strokeStyle value="solid"/>
    <archive/>
    <labels_on value="false"/>
    <creator uid="ANDROID-dfac01d76beec661" callsign="TRILL" time="${now}" type="a-f-G-U-C"/>
    <color value="-1"/>
    <remarks/>
  </detail>
</event>`,
  },

  // ── Mission Waypoint (GOTO) ───────────────────────────────────────────────
  // type b-m-p-w-GOTO — green flag from the Mission symbol set.
  // No <usericon> — icon/color driven entirely by the GOTO type suffix.
  // Callsign auto-generated by ATAK: {creatorCallsign}.{dayOfMonth}.{HHMMSS}
  waypt_goto: {
    label: 'Mission Waypoint (GOTO)',
    staleMins: 5,
    formValues: null,
    xml: (now, stale) => {
      // Replicate ATAK's auto-generated callsign format
      const d   = new Date();
      const day = String(d.getUTCDate()).padStart(2, '0');
      const hms = String(d.getUTCHours()).padStart(2, '0')
                + String(d.getUTCMinutes()).padStart(2, '0')
                + String(d.getUTCSeconds()).padStart(2, '0');
      return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="${genUuid()}"
       type="b-m-p-w-GOTO"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="39.3523095" lon="-76.3450004" hae="-25.21" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="TRILL3.${day}.${hms}"/>
    <status readiness="true"/>
    <archive/>
    <creator uid="ANDROID-dfac01d76beec661" callsign="TRILL3" time="${now}" type="a-f-G-U-C"/>
    <color argb="-1"/>
    <precisionlocation altsrc="SRTM1"/>
    <link uid="ANDROID-dfac01d76beec661" production_time="${now}"
          type="a-f-G-U-C" parent_callsign="TRILL3" relation="p-p"/>
    <remarks/>
  </detail>
</event>`;
    },
  },

  // ── GeoChat Direct Message ────────────────────────────────────────────────
  // UID format: GeoChat.{senderUID}.{recipientUID}.{messageUUID}
  // messageId is also a UUID — TAK server uses it to deduplicate retransmits.
  // stale=24h: standard for TAK chat messages.
  chat_direct: {
    label: 'GeoChat Direct Message',
    staleMins: 1440,
    formValues: null, // Chat presets route to the Chat Composer, not the SA form
    xml: (now, stale) => {
      const msgUuid = genUuid();
      return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
       uid="GeoChat.ANDROID-example0000000001.warthog1.${msgUuid}"
       type="b-t-f"
       how="h-g-i-g-o"
       time="${now}" start="${now}" stale="${stale}" access="Undefined">
  <point lat="41.3912267" lon="-73.9527021" hae="-32.2" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup"
            groupOwner="false"
            messageId="${msgUuid}"
            chatroom="warthog1"
            id="warthog1"
            senderCallsign="FOXTROT-6">
      <chatgrp uid0="ANDROID-example0000000001" uid1="warthog1" id="warthog1"/>
    </__chat>
    <link uid="ANDROID-example0000000001" type="a-f-G-U-C" relation="p-p"/>
    <remarks source="BAO.F.ATAK.ANDROID-example0000000001"
             to="warthog1"
             time="${now}">Hello Warthog, begin recon pattern</remarks>
  </detail>
</event>`;
    },
  },

};  // end PRESETS


// =============================================================================
// SECTION: PRESET SELECTION & INTERACTION
// =============================================================================

/** @type {string|null} Key of the currently selected preset, or null */
let selectedPresetKey = null;

/**
 * Highlight a preset card and show its XML preview.
 * Deselects the previously selected card first.
 *
 * @param {string} key - Preset key, must exist in PRESETS
 */
function selectPreset(key) {
  // Deselect previous card
  if (selectedPresetKey) {
    const prev = document.getElementById(`card-${selectedPresetKey}`);
    if (prev) prev.classList.remove('selected');
  }
  selectedPresetKey = key;
  document.getElementById(`card-${key}`).classList.add('selected');

  // Render and show preview
  const xml = renderPresetXml(key);
  document.getElementById('presetPreviewXml').textContent    = xml;
  document.getElementById('presetPreviewLabel').textContent  = `Preview — ${PRESETS[key].label}`;
  document.getElementById('presetPreviewArea').style.display = 'block';
}

/**
 * Send the currently selected preset with freshly generated timestamps.
 *
 * WHY REGENERATE AT SEND TIME: The user may have clicked the card a few minutes
 * ago and the preview has stale timestamps. We always regenerate at the moment
 * of clicking Send so the transmitted CoT has current time/stale values. We
 * also update the preview so what the user sees matches what was actually sent.
 */
async function sendPreset() {
  if (!selectedPresetKey) return;

  // Regenerate with fresh timestamps and update preview to match what's sent
  const xml = renderPresetXml(selectedPresetKey);
  document.getElementById('presetPreviewXml').textContent = xml;

  const base = document.getElementById('takServerUrl').value.trim().replace(/\/$/, '');
  const path = document.getElementById('takApiPath').value.trim();

  if (!base) {
    appendLog('ERROR: No server URL set. Fill in the TAK Server section above.', 'error');
    setStatus('error', 'No server URL — fill in the TAK Server section.');
    presetSetStatus('error', 'No server URL configured');
    return;
  }

  const url   = `${base}${path}`;
  const label = PRESETS[selectedPresetKey].label;
  presetSetStatus('sending', 'Sending…');
  setStatus('sending', `Sending preset "${label}" to ${url}…`);
  appendLog(`[PRESET: ${label}] POST ${url}`, 'info');

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { ...buildHeaders(), 'Content-Type': 'application/xml' },
      body:    xml,
    });
    if (resp.ok) {
      setStatus('ok', 'Preset delivered.', resp.status);
      appendLog(`✓ ${resp.status} ${resp.statusText}`, 'ok');
      presetSetStatus('ok', `"${label}" delivered`);
    } else {
      const body = await resp.text().catch(() => '');
      setStatus('error', 'Server returned an error.', resp.status);
      appendLog(`✗ ${resp.status} ${resp.statusText} — ${body.substring(0, 120)}`, 'error');
      presetSetStatus('error', `Server error ${resp.status}`);
    }
  } catch (err) {
    setStatus('error', `Network error — ${err.message}`);
    appendLog(`✗ Network error: ${err.message}`, 'error');
    appendLog('  → Is the proxy running? Check the TAK Server section above.', 'warn');
    presetSetStatus('error', 'Network error — is proxy running?');
  }
}

/**
 * Copy the currently selected preset XML (with fresh timestamps) to clipboard.
 * Shows a toast notification on success.
 */
function copyPreset() {
  if (!selectedPresetKey) return;
  const xml = renderPresetXml(selectedPresetKey);
  navigator.clipboard.writeText(xml).then(() => {
    const t = document.getElementById('toast');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  });
}

/**
 * Load the currently selected preset into the appropriate form/composer.
 *
 * Routes by preset type:
 *   - Presets with formValues → SA form
 *   - formValues=null, type b-m-p-s-m → Spot Map Composer
 *   - formValues=null, type b-t-f     → Chat Composer
 *   - Other formValues=null            → parse the XML and route
 */
function loadPresetIntoForm() {
  if (!selectedPresetKey) return;
  const fv  = PRESETS[selectedPresetKey].formValues;
  const xml = renderPresetXml(selectedPresetKey);

  // For presets without formValues, determine type from the generated XML
  if (!fv) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xml, 'application/xml');
    const evType = doc.querySelector('event')?.getAttribute('type') || '';

    if (evType === 'b-m-p-s-m') {
      // Load into spot map composer by parsing and populating fields
      const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
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
      const argb      = doc.querySelector('color')?.getAttribute('argb') || '-1';
      const colorSel  = document.getElementById('spotColor');
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
      appendLog(`[${PRESETS[selectedPresetKey].label}] Loaded into Spot Map Composer.`, 'info');
      setStatus('ok', 'Spot map preset loaded into Spot Map Composer.');
      document.getElementById('spotCallsign').closest('.panel').scrollIntoView({ behavior: 'smooth' });
      return;
    }

    if (evType === 'b-t-f') {
      // Load into chat composer
      const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
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
      appendLog(`[${PRESETS[selectedPresetKey].label}] Loaded into Chat Composer — enter message and click Send Chat.`, 'info');
      setStatus('ok', 'Chat preset loaded into Chat Composer.');
      document.getElementById('chatSenderCallsign').closest('.panel').scrollIntoView({ behavior: 'smooth' });
      document.getElementById('chatMessage').focus();
      return;
    }

    // Unhandled type — no formValues and not a known composer type
    appendLog(`[${PRESETS[selectedPresetKey].label}] Cannot load into form — no form mapping for type ${evType}.`, 'warn');
    return;
  }

  // ── Populate SA form from formValues ──────────────────────────────────────
  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };

  set('uid',      fv.uid);
  set('callsign', fv.callsign);
  set('type',     fv.type);
  set('how',      fv.how);
  set('lat',      fv.lat);
  set('lon',      fv.lon);
  set('hae',      fv.hae);
  set('ce',       fv.ce);
  set('le',       fv.le);
  set('groupColor', fv.groupColor);
  set('groupRole',  fv.groupRole);

  if (fv.speed !== undefined || fv.course !== undefined) {
    document.getElementById('enableTrack').checked = true;
    document.getElementById('trackSection').style.display = 'block';
    set('speed',  fv.speed  ?? '0.0');
    set('course', fv.course ?? '0.0');
  }

  const milsymCb  = document.getElementById('enableMilsym');
  const milsymSec = document.getElementById('milsymSection');
  if (fv.milsym) {
    milsymCb.checked = true;
    milsymSec.classList.add('active');
    set('milsymId', fv.milsym);
  } else {
    milsymCb.checked = false;
    milsymSec.classList.remove('active');
    set('milsymId', '');
  }

  updateTypeHelper();
  generateXML();
  document.querySelector('.layout').scrollIntoView({ behavior: 'smooth' });
}
