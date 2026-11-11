'use strict';

/**
 * tcpa — "may we text right now?" guard. TCPA only allows texting a consumer between
 * 8am and 9pm in THEIR local time, and several states are tighter (Florida/Oklahoma/
 * Maryland 8pm close, Texas 9am open and Sundays noon+).
 *   - A contact whose time zone is KNOWN (from the Shark report's Timezone column or the account's summary) is texted
 *     Monday–Saturday from 8:00 to 20:00 in THEIR OWN zone: Eastern, Central, Mountain and Pacific alike (the owner's
 *     choice, 2026-10-21; note Texas opens at 9:00, so a Texas pro is inside the window an hour before the state allows it).
 *   - A contact whose zone we don't know is the conservative case: texting is allowed only when it is inside the window
 *     in EVERY contiguous-US zone at once (ET, CT, MT, PT), Monday–Saturday. With startHour 9 that works out to
 *     12:00–8:00pm Eastern. Email is not covered.
 *
 * Edit WINDOW below to change the hours. There is intentionally no CLI override.
 * (Alaska/Hawaii aren't covered — don't text those accounts outside 1pm–8pm ET.)
 */

const WINDOW = {
  startHour: 9,        // UNKNOWN zone: earliest local hour in the westmost zone (PT) — i.e. 12:00 Eastern
  knownStartHour: 8,   // KNOWN zone: earliest local hour in the contact's own zone, whichever zone that is
  endHour: 20,         // texting stops at this local hour (in the contact's own zone; in the eastmost zone for an unknown one)
  allowSunday: false,
  zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
};

const CLOCKS = new Map();      // one formatter per zone (building one per call made every check slow)
function localClock(date, tz) {
  if (!CLOCKS.has(tz)) CLOCKS.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' }));
  const parts = CLOCKS.get(tz).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { minutes: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10), weekday: parts.weekday };
}

// ---- Per-contact time zones ------------------------------------------------------------
// State → IANA zones the state spans (split states list every zone, so the gate requires the
// window to be open in all of them — conservative). Source: US state time-zone boundaries.
const ET = 'America/New_York', CT = 'America/Chicago', MT = 'America/Denver', PT = 'America/Los_Angeles', AZ = 'America/Phoenix', AK = 'America/Anchorage', HI = 'Pacific/Honolulu';
const STATE_ZONES = {
  AL: [CT], AK: [AK], AZ: [AZ], AR: [CT], CA: [PT], CO: [MT], CT: [ET], DE: [ET], DC: [ET], FL: [ET, CT], GA: [ET], HI: [HI], ID: [MT, PT], IL: [CT], IN: [ET, CT],
  IA: [CT], KS: [CT, MT], KY: [ET, CT], LA: [CT], ME: [ET], MD: [ET], MA: [ET], MI: [ET, CT], MN: [CT], MS: [CT], MO: [CT], MT: [MT], NE: [CT, MT], NV: [PT, MT], NH: [ET],
  NJ: [ET], NM: [MT], NY: [ET], NC: [ET], ND: [CT, MT], OH: [ET], OK: [CT], OR: [PT, MT], PA: [ET], RI: [ET], SC: [ET], SD: [CT, MT], TN: [ET, CT], TX: [CT, MT], UT: [MT],
  VT: [ET], VA: [ET], WA: [PT], WV: [ET], WI: [CT], WY: [MT],
};
const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
const ZONE_SHORT = { [ET]: 'ET', [CT]: 'CT', [MT]: 'MT', [PT]: 'PT', [AZ]: 'MST (AZ)', [AK]: 'AKT', [HI]: 'HST' };

/** 'FL' / 'Florida' / 'florida' → 'FL', or null. */
function normalizeState(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (STATE_ZONES[t.toUpperCase()]) return t.toUpperCase();
  return STATE_NAMES[t.toLowerCase()] || null;
}
/** Zones for a state (array of IANA names) or null if unknown. */
function zonesForState(s) { const st = normalizeState(s); return st ? STATE_ZONES[st].slice() : null; }

/**
 * May we text a contact in these `zones` right now? Same Sunday rule and closing hour as check(), but only
 * the contact's own zone(s), from WINDOW.knownStartHour (8:00) in that zone. A contact in a split state
 * (zones = several) needs the window open in ALL of them. Unknown zones (null/empty) fall back to the
 * all-US check() — still strict, never open early.
 */
function checkZones(zones, date = new Date()) {
  if (!zones || !zones.length) return check(date);
  const start = WINDOW.knownStartHour;
  for (const tz of zones) {
    const { minutes, weekday } = localClock(date, tz);
    if (weekday === 'Sun' && !WINDOW.allowSunday) return { ok: false, reason: `Sunday in ${ZONE_SHORT[tz] || tz}` };
    if (minutes < start * 60) return { ok: false, reason: `before ${start}:00 in ${ZONE_SHORT[tz] || tz}` };
    if (minutes >= WINDOW.endHour * 60) return { ok: false, reason: `after ${WINDOW.endHour}:00 in ${ZONE_SHORT[tz] || tz}` };
  }
  return { ok: true, reason: null };
}

/** Is `date` inside the texting window in every zone? → { ok, reason }. */
function check(date = new Date()) {
  for (const tz of WINDOW.zones) {
    const { minutes, weekday } = localClock(date, tz);
    if (weekday === 'Sun' && !WINDOW.allowSunday) return { ok: false, reason: `Sunday in ${tz} (no Sunday texting)` };
    if (minutes < WINDOW.startHour * 60) return { ok: false, reason: `before ${WINDOW.startHour}:00 in ${tz}` };
    if (minutes >= WINDOW.endHour * 60) return { ok: false, reason: `after ${WINDOW.endHour}:00 in ${tz}` };
  }
  return { ok: true, reason: null };
}

/** The first minute after `from` for which isOpen(date) is true (searched in 15-minute steps, then refined to the minute), or null within 8 days. */
function firstOpen(isOpen, from) {
  const base = Math.floor(from.getTime() / 60000) * 60000;          // whole minutes, so an opening comes back as 8:00, not 8:00:23
  for (let i = 1; i <= 8 * 24 * 4; i++) {
    const d = new Date(base + i * 15 * 60000);
    if (!isOpen(d)) continue;
    for (let k = 14; k > 0; k--) { const e = new Date(d.getTime() - k * 60000); if (isOpen(e)) return e; }   // the exact minute it opened, not the next 15-minute step
    return d;
  }
  return null;
}
const sayTime = (d) => (d ? d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: 'numeric', timeZoneName: 'short' }) : null);

/**
 * Next time texting opens, as a local string, for messages. By default that is when the all-US window
 * (unknown zones) opens; { any: true } is when the first zone anywhere opens (contacts with a known zone).
 */
function nextOpen(from = new Date(), { any = false } = {}) {
  return sayTime(firstOpen((d) => (any ? anyOpen(d) : check(d).ok), from));
}
/** Next time texting opens for a contact in these `zones` (null/empty = the all-US window). */
function nextOpenFor(zones, from = new Date()) {
  return sayTime(firstOpen((d) => checkZones(zones, d).ok, from));
}
/** The same as a Date: the minute a contact in these `zones` is next inside their window (null/empty = the all-US window), or null within 8 days. */
function openingFor(zones, from = new Date()) {
  return firstOpen((d) => checkZones(zones, d).ok, from);
}
/** The calendar day (YYYY-MM-DD) of `date` in time zone `tz`. */
function localDay(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** One-line human summary of the rule, for logs/help. */
function describe() {
  return `texting only Mon–Sat, ${WINDOW.knownStartHour}:00–${WINDOW.endHour}:00 in the contact's own time zone; unknown zone → every US zone must be open (${WINDOW.startHour}:00 PT = 12:00 ET to ${WINDOW.endHour}:00 ET)`;
}

// ---- Reading a "Time Zone" cell from a Salesforce report ------------------------------------------------
const CANON = {
  [ET]: ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indiana/Indianapolis', 'America/Indiana/Marengo', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indiana/Petersburg', 'America/Indianapolis', 'America/Fort_Wayne', 'America/Louisville', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello', 'US/Eastern', 'US/Michigan', 'EST5EDT', 'EST'],
  [CT]: ['America/Chicago', 'America/Winnipeg', 'America/Menominee', 'America/Indiana/Knox', 'America/Indiana/Tell_City', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah', 'US/Central', 'CST6CDT'],
  [MT]: ['America/Denver', 'America/Boise', 'America/Edmonton', 'America/Shiprock', 'US/Mountain', 'MST7MDT'],
  [AZ]: ['America/Phoenix', 'US/Arizona', 'MST'],
  [PT]: ['America/Los_Angeles', 'America/Vancouver', 'US/Pacific', 'PST8PDT'],
  [AK]: ['America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat', 'America/Metlakatla', 'US/Alaska'],
  [HI]: ['Pacific/Honolulu', 'US/Hawaii', 'US/Aleutian'],
};
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } };
/** Fold equivalent IANA ids (America/Detroit → America/New_York …) onto the zones the TCPA window knows. */
function canonicalZone(tz) {
  for (const [canon, list] of Object.entries(CANON)) if (list.includes(tz)) return canon;
  return validTz(tz) ? tz : null;
}
/**
 * "(GMT-05:00) Eastern Time (America/New_York)", "America/Chicago", "Central Standard Time", "PST", "Arizona", "Eastern" …
 * → one IANA zone (canonicalised), or null when the text doesn't say (or is just a GMT offset).
 */
function parseZone(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const iana = t.match(/\b(?:America|Pacific|US)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/);
  if (iana && canonicalZone(iana[0])) return canonicalZone(iana[0]);
  const s = t.toLowerCase();
  if (/\b(alaska\w*|akst|akdt|akt)\b/.test(s)) return AK;
  if (/\b(hawaii\w*|hst|honolulu|aleutian)\b/.test(s)) return HI;
  if (/\b(arizona|phoenix)\b/.test(s)) return AZ;
  if (/\b(eastern|est|edt|et)\b/.test(s)) return ET;
  if (/\b(central|cst|cdt|ct)\b/.test(s)) return CT;
  if (/\b(mountain|mst|mdt|mt)\b/.test(s)) return MT;
  if (/\b(pacific|pst|pdt|pt)\b/.test(s)) return PT;
  return null;
}

/** Could ANY US contact be texted right now? (false overnight / Sundays — skip the whole text pass.) */
const ZONE_SETS = [...new Set(Object.values(STATE_ZONES).map((zs) => zs.join('|')))].map((k) => k.split('|'));
function anyOpen(date = new Date()) {
  return ZONE_SETS.some((zs) => checkZones(zs, date).ok);
}

module.exports = { parseZone, canonicalZone, anyOpen, STATE_ZONES, ZONE_SHORT, normalizeState, zonesForState, checkZones, check, nextOpen, nextOpenFor, openingFor, localDay, describe, WINDOW };
