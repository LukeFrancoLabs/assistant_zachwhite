'use strict';

/**
 * textLog — a DURABLE, channel-aware record of every Pro we TEXT or EMAIL, with the
 * exact content sent, plus a combined per-person dashboard.
 *
 * WHY: the shared contact-history ledger prunes everything after 48h, so it can't
 * answer "everyone we've ever reached, on which channel, with what, and when?". This
 * log is append-only and never pruned. One JSON line per successful send:
 *   { at, channel, accountId, accountName, accountUrl, email,
 *     templateName, message, subject, body, mode }
 *   - channel : 'text' | 'email'   (rows with no channel are treated as 'text' — legacy)
 *   - message : the text body        (channel 'text')
 *   - subject/body : the email sent   (channel 'email')
 *
 * The dashboard (texted-dashboard.html) is a static file regenerated from this log —
 * no server, no port. Open it with file:// or `email --sent`.
 */

const fs = require('fs');
const path = require('path');
const { WON_FLAG_DAYS } = require('./closedWonWindow');   // how many days a Closed Won keeps an account out (Luke, 2026-10-30: 30): one switch for the review, the follow-up filter and these labels
const industry = require('./industry');       // a guess at the pro's trade from the business name

const LOG_FILE = path.join(__dirname, 'texted-log.jsonl');
const DASH_FILE = path.join(__dirname, 'texted-dashboard.html');
const REENGAGE_FILE = path.join(__dirname, 'reengage-notes.jsonl');
const REVIEW_FILE = path.join(__dirname, 'reengage-review.jsonl');
const BAN_FILE = path.join(__dirname, 'banlist.jsonl');
const REPLY_FILE = path.join(__dirname, 'replies.jsonl');   // texts pros sent back (optOut.js), flagged gift-card request / interested
const ZONE_FILE = path.join(__dirname, 'contact-zones.jsonl');
const HARVEST_FILE = path.join(__dirname, 'account-notes.jsonl');
const PLAN_FILE = path.join(__dirname, 'auto-plans.jsonl');
const LIST_FILE = path.join(__dirname, 'list-membership.jsonl');
const SNAP_FILE = path.join(__dirname, 'shark-snapshots.jsonl');
const GREEN_FILE = path.join(__dirname, 'green_banlist.jsonl');
const CW_FILE = path.join(__dirname, 'closed-won.jsonl');
const CUST_FILE = path.join(__dirname, 'current-customers.jsonl');   // accounts whose Customer Status (beta) shows a value — never emailed (emailAccount.js)
const IND_FILE = path.join(__dirname, 'account-industry.jsonl');
const EML_FILE = path.join(__dirname, 'account-emails.jsonl');
const SF_ORIGIN = 'https://housecallpro.lightning.force.com';
/** This copy (assistant_zachwhite) is pipeline-list only: hide the LDS dashboard tab and #lds tagging. */
const PIPELINE_ONLY = true;

/** Append one outreach event (text or email) to the durable log. */
function recordOutreach({ channel, accountId, accountName, accountUrl, email, templateName, message, subject, body, mode, source, step }) {
  const row = {
    at: new Date().toISOString(),
    channel: channel === 'email' ? 'email' : 'text',
    accountId: accountId || null,
    accountName: accountName || null,
    accountUrl: accountUrl || (accountId ? `${SF_ORIGIN}/lightning/r/Account/${accountId}/view` : null),
    email: email || null,
    templateName: templateName || null,
    message: message != null ? String(message) : null,
    subject: subject != null ? String(subject) : null,
    body: body != null ? String(body) : null,
    mode: mode || null,
    source: source && source.kind ? { kind: source.kind, name: source.name || null } : null,   // the report it was reached from (LDS / Shark)
    step: step ? Number(step) : null,                                                          // which --followup sequence step this text was (1, 2, …)
  };
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  try { require('./outreachDataLog').record(row); } catch (_) {}      // this rep's own data log (outreach-data-log.jsonl): who sent it, from which computer; it can never stop a send
  try { require('./outreachDashboard').touch(); } catch (_) {}      // the live outreach page (outreach-dashboard/): rewritten after every send; it can never stop one
  return row;
}

/** Convenience: record a text. */
function recordText(o) { return recordOutreach({ ...o, channel: 'text' }); }
/** Convenience: record an email. */
function recordEmail(o) { return recordOutreach({ ...o, channel: 'email' }); }

/** The channel of a row, defaulting legacy rows (no channel) to 'text'. */
function rowChannel(r) { return r && r.channel === 'email' ? 'email' : 'text'; }

/** Read the whole log (oldest → newest). */
function readAll() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const rows = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
    const gone = readManualRecords().removed;      // a touch added by hand and then taken back (--remove-shark) never happened
    return gone.size ? rows.filter((r) => !(r.manualId && gone.has(r.manualId))) : rows;
  } catch (_) { return []; }
}

// ---- LEADS ADDED BY HAND, #TAGGED WITH THEIR KIND (manualShark.js: `node textLog.js --add-lead <link> --tag shark`; the dashboard's Tools > Follow-up board has the form) ----------
// Luke does stage 1 (the email, the text and the call) himself and wants the lead tracked for stage 2, tagged with the kind of lead it is. manual-shark.jsonl is append-only:
//   { type:'add', id, at, on, accountId, accountName, accountUrl, did:['email','text','call'], note, tags:['shark','referral'] }   { type:'tags', id, at, tags } (the newest wins)   { type:'remove', id, at }
// An add ALSO writes real rows to texted-log.jsonl (mode 'manual', manualId = the add's id), so every guard that reads the log sees the touch at once, even in a bot that is already
// running. A remove voids those rows here (readAll skips them); the log itself is never rewritten. The rows carry no list of their own: the TAGS decide the lists. #shark and #lds are
// real lists (aggregate() adds them to the account's sources, so the Shark / LDS tabs, the Shark follow-up and the LDS email cadence treat the lead as theirs); any other tag is a label.
const MANUAL_FILE = path.join(__dirname, 'manual-shark.jsonl');
const MANUAL_MODE = 'manual';
const MANUAL_LIST_NAME = 'Added by hand';
const MANUAL_TAG_KINDS = PIPELINE_ONLY ? { shark: 'Shark' } : { shark: 'Shark', lds: 'LDS' };      // the tags that are real lists (LDS off in this pipeline-only copy)
let _manualRec = null;
/** The tags of an add: its own, or #shark for one added before tags existed. */
const manualTags = (a) => (a && Array.isArray(a.tags) && a.tags.length ? a.tags : ['shark']);
/** → { adds: [every add not taken back, each with its newest tags], removed: Set of add ids } (re-read only when the file changes) */
function readManualRecords() {
  let sig; try { const st = fs.statSync(MANUAL_FILE); sig = `${st.size}:${st.mtimeMs}`; } catch (_) { return { adds: [], removed: new Set() }; }
  if (_manualRec && _manualRec.sig === sig) return _manualRec.val;
  const adds = [], removed = new Set(), retag = new Map(), reboard = new Map();
  for (const r of readRows(MANUAL_FILE)) {
    if (!r || !r.id) continue;
    if (r.type === 'remove') removed.add(r.id);
    else if (r.type === 'add') adds.push(r);
    else if (r.type === 'tags' && Array.isArray(r.tags)) retag.set(r.id, r.tags);
    else if (r.type === 'board') {
      reboard.set(r.id, {
        board: r.board || null,
        boardAt: r.at || null,
        boardExpiresAt: r.expiresAt || r.boardExpiresAt || null,
        graduatedFrom: r.graduatedFrom || null,
      });
    }
  }
  _manualRec = {
    sig,
    val: {
      adds: adds.filter((a) => !removed.has(a.id)).map((a) => {
        const tags = manualTags(retag.has(a.id) ? { tags: retag.get(a.id) } : a);
        const b = reboard.get(a.id);
        return {
          ...a,
          tags,
          board: b ? b.board : (a.board || null),
          boardAt: b ? b.boardAt : (a.boardAt || null),
          boardExpiresAt: b ? b.boardExpiresAt : (a.boardExpiresAt || a.expiresAt || null),
          graduatedFrom: b ? b.graduatedFrom : (a.graduatedFrom || null),
        };
      }),
      removed,
    },
  };
  return _manualRec.val;
}

/**
 * Durable once-per-day guard source: the most recent TEXT to this account within the
 * last `hours` (default 24), or null. Email sends never block texts, so this looks at
 * the text channel only. Because the log is never pruned, it reliably answers "did we
 * already text this lead today?" across separate runs (report + queue).
 */
function textedWithinHours(accountId, hours = 24) {
  return lastOutreachWithinHours(accountId, 'text', hours);
}

/** Same as textedWithinHours but for the EMAIL channel (powers the once-a-day email guard). */
function emailedWithinHours(accountId, hours = 24) {
  return lastOutreachWithinHours(accountId, 'email', hours);
}

/** Most recent send to this account on `channel` within the last `hours`, or null. */
function lastOutreachWithinHours(accountId, channel, hours = 24) {
  if (!accountId) return null;
  const cutoff = Date.now() - hours * 3600000;
  const hits = readAll()
    .filter((r) => r.accountId === accountId && rowChannel(r) === channel && new Date(r.at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  return hits[0] || null;
}

// ---- "Never the same thing twice" ---------------------------------------------------------------------------------------------
// The contact ledger (contact-history) only remembers ~48 hours, so on its own it would let the same text or email reach the same account again a few days later.
// texted-log.jsonl is never pruned, so this index answers "did THIS account ever get THIS message?" for every send path (rebuilt only when the log changes).
const msgNorm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const GENERIC_TEMPLATES = new Set(['', 'custom message', 'email first-touch', '(text)', '(email)']);   // names that do not identify a message: only its wording does
let _sentIdx = null;
function sentIndex() {
  let sig; try { const st = fs.statSync(LOG_FILE); sig = `${st.size}:${st.mtimeMs}`; } catch (_) { return new Map(); }
  if (_sentIdx && _sentIdx.sig === sig) return _sentIdx.map;
  const map = new Map();
  for (const r of readAll()) {
    const k = String(r.accountId || '').toLowerCase().slice(0, 15); if (!k) continue;
    const ch = rowChannel(r);
    const rec = map.get(k) || { text: [], email: [] }; map.set(k, rec);
    rec[ch].push({ at: r.at, name: String(r.templateName || '').trim().toLowerCase(), templateName: r.templateName || null, step: r.step ? Number(r.step) : null, fp: ch === 'email' ? msgNorm(`${r.subject || ''}\n${r.body || ''}`) : msgNorm(r.message != null ? r.message : r.body) });
  }
  _sentIdx = { sig, map };
  return map;
}
/**
 * Has this account EVER been sent this same message on this channel? → { at, templateName, count } (the latest earlier send and how many there were) or null.
 * "Same" = the same wording (case and spacing ignored), or the same named template (a text; an email only with the same --sequence step). Pass templateName: null for
 * a message written per account (--auto, a thread-hold check-in): its template name is the same for every account, only its wording says whether it is the same.
 */
function sentSameMessage(accountId, channel, { templateName, message, subject, body, step } = {}) {
  const k = String(accountId || '').toLowerCase().slice(0, 15); if (!k) return null;
  const rec = sentIndex().get(k); if (!rec) return null;
  const ch = channel === 'email' ? 'email' : 'text';
  const fp = ch === 'email' ? msgNorm(`${subject || ''}\n${body || ''}`) : msgNorm(message);
  const name = String(templateName || '').trim().toLowerCase();
  const named = !!name && !GENERIC_TEMPLATES.has(name);
  const hits = (rec[ch] || []).filter((r) => (fp && r.fp === fp) || (named && r.name === name && (ch === 'text' || (step && r.step === Number(step)))));
  if (!hits.length) return null;
  const last = hits.reduce((a, b) => (b.at > a.at ? b : a));
  return { at: last.at, templateName: last.templateName, count: hits.length };
}

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp — the same day the dashboard shows. */
function localDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const XREF_FILE = path.join(__dirname, 'xref-today.json');
/** Salesforce 18-char ids differ from 15-char ones only by a checksum suffix; compare on 15. */
function id15(s) { s = String(s || '').toLowerCase(); return s.startsWith('001') ? s.slice(0, 15) : null; }
/** The latest report cross-reference ({date, generatedAt, accounts:[{id,name,url,address,sentText,sentEmail}]}), or null. */
function readXref() { try { return JSON.parse(fs.readFileSync(XREF_FILE, 'utf8')); } catch (_) { return null; } }

/** Stable per-account key shared by aggregate(), the dashboard and reengage-notes.jsonl. */
function accountKey(r) { return r.accountId || r.accountName || r.accountUrl || null; }

/**
 * Re-engage notes: append-only, one line per save, newest wins per account.
 *   { at, key, accountName, stage, note }
 * Kept OUT of texted-log.jsonl (that file is send events only). Returns Map key → row.
 */
function readReengageNotes() {
  const out = new Map();
  try {
    if (!fs.existsSync(REENGAGE_FILE)) return out;
    for (const l of fs.readFileSync(REENGAGE_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.key) continue;
      const prev = out.get(r.key);
      if (!prev || new Date(r.at) >= new Date(prev.at)) out.set(r.key, r);
    }
  } catch (_) {}
  return out;
}

/** Append one re-engage note (empty stage = cleared). */
function recordReengage({ key, accountName, stage, note, at }) {
  if (!key) return null;
  const row = { at: at || new Date().toISOString(), key, accountName: accountName || null, stage: String(stage || ''), note: note ? String(note) : null };
  try { fs.appendFileSync(REENGAGE_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}

/** Collapse the raw log into one entry per account, each with a full touch timeline. */
function aggregate() {
  const byKey = new Map();
  for (const r of readAll()) {
    const key = accountKey(r);
    if (!key) continue;
    let a = byKey.get(key);
    if (!a) { a = { accountId: r.accountId, accountName: r.accountName, accountUrl: r.accountUrl, email: null, texts: 0, emails: 0, lastAt: r.at, touches: [], days: {} }; byKey.set(key, a); }
    const ch = rowChannel(r);
    if (ch === 'email') a.emails++; else a.texts++;
    const day = localDay(r.at);
    if (day) { const d = a.days[day] || (a.days[day] = { text: 0, email: 0 }); d[ch]++; }
    if (r.email) a.email = r.email;                   // keep most recent non-null email
    if (r.accountName) a.accountName = r.accountName;
    if (r.accountUrl) a.accountUrl = r.accountUrl;
    if (new Date(r.at) >= new Date(a.lastAt)) a.lastAt = r.at;
    if (r.source && r.source.kind) { a.sources = a.sources || {}; if (!a.sources[r.source.kind] || a.sources[r.source.kind].at <= r.at) a.sources[r.source.kind] = { name: r.source.name, at: r.at }; }
    a.touches.push({
      ch,
      at: r.at,
      // Uniform display: a title line + a body. Text → template name + message;
      // email → subject + body.
      title: ch === 'email' ? (r.subject || r.templateName || '(email)') : (r.templateName || '(text)'),
      body: ch === 'email' ? (r.body || '') : (r.message || ''),
      mode: r.mode || null,
      step: r.step || null,
    });
  }
  // ✋ A lead added by hand carries its list tags (#shark, #lds) in the add record, not in its log rows: they become the account's sources here, so everything built on aggregate()
  // (the Shark and LDS tabs, the Shark follow-up, the LDS email cadence) treats it as a lead of that list. A real source of the same list (a report it was reached from) wins.
  const hand = readManualRecords().adds;
  if (hand.length) {
    const by15 = new Map();
    for (const a of byKey.values()) { const k = k15(a.accountId); if (k) { const l = by15.get(k); if (l) l.push(a); else by15.set(k, [a]); } }
    for (const h of hand) for (const tag of manualTags(h)) {
      const kind = MANUAL_TAG_KINDS[tag]; if (!kind) continue;
      for (const a of by15.get(k15(h.accountId)) || []) { a.sources = a.sources || {}; if (!a.sources[kind]) a.sources[kind] = { name: MANUAL_LIST_NAME, at: h.on }; }
    }
  }
  const out = [...byKey.values()];
  for (const [key, a] of byKey) {
    a.key = key;
    // Per-day channel coverage; `bothDay` = most recent day with BOTH a text and an email.
    const both = Object.keys(a.days).filter((d) => a.days[d].text && a.days[d].email).sort();
    a.bothDay = both.length ? both[both.length - 1] : null;
  }
  out.forEach((a) => a.touches.sort((x, y) => new Date(y.at) - new Date(x.at))); // newest touch first
  return out.sort((x, y) => new Date(y.lastAt) - new Date(x.lastAt));
}

/**
 * Salesforce pre-send review verdicts (see salesforceReview.js): append-only, one line per
 * review { at, accountId, accountName, verdict, reasons, warnings, opps, notesRead }.
 * Kept out of texted-log.jsonl. Returns Map accountId → most recent review.
 */
function recordReview(r) {
  const row = { at: new Date().toISOString(), ...r };
  try { fs.appendFileSync(REVIEW_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/**
 * SKIP LOG — skipped-leads.jsonl: leads the bot passed over for a reason that is not a Salesforce review (e.g. the text cap). One line per
 * { at, accountId, accountName, accountUrl, kind, reason, source }; recorded once per account + kind per day. Shown on the dashboard's 🛑 Skipped tab.
 */
const SKIP_FILE = path.join(__dirname, 'skipped-leads.jsonl');
const _skipSeen = new Set();
function recordSkip({ accountId, accountName, accountUrl, kind, reason, source }) {
  if (!accountId || !kind) return null;
  const day = new Date().toISOString().slice(0, 10), key = `${String(accountId).toLowerCase().slice(0, 15)}|${kind}|${day}`;
  if (_skipSeen.has(key)) return null;
  _skipSeen.add(key);
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, accountUrl: accountUrl || null, kind, reason: reason || null, source: source || null };
  try { fs.appendFileSync(SKIP_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/** Newest skip per account + kind. → array */
function readSkips() {
  const out = new Map();
  try {
    if (!fs.existsSync(SKIP_FILE)) return [];
    for (const l of fs.readFileSync(SKIP_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId && r.kind) out.set(`${String(r.accountId).toLowerCase().slice(0, 15)}|${r.kind}`, r);
    }
  } catch (_) {}
  return [...out.values()];
}
function readReviews() {
  const out = new Map();
  try {
    if (!fs.existsSync(REVIEW_FILE)) return out;
    for (const l of fs.readFileSync(REVIEW_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId) out.set(r.accountId, r);
    }
  } catch (_) {}
  // A skip that rests only on a Closed Won opportunity the plan check found to be the free Invoicing and Payments sign-up is moot (planRelease.js): the account is not a customer, so it stays in the regular cadence. Every reader that holds an account for a skip also checks `moot`.
  try { const rows = readCustomerRows(), mootReview = require('./planRelease').mootReview; for (const r of out.values()) if (r.verdict === 'skip' && mootReview(r, rows)) r.moot = 'its only Closed Won opportunity is Invoicing and Payments (the free plan), not a customer'; } catch (_) {}
  return out;
}

/**
 * Contact time zones for TCPA hours: append-only contact-zones.jsonl, one line per read
 * { at, accountId, accountName, state, zones[], source, address, phone }. `zones` are IANA names
 * from tcpa.zonesForState(state) (split states list every zone). Latest RESOLVED read wins;
 * an unresolved read never overwrites a resolved one. Returns Map idKey → record.
 */
function readZones() {
  const out = new Map();
  try {
    if (!fs.existsSync(ZONE_FILE)) return out;
    for (const l of fs.readFileSync(ZONE_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.accountId) continue;
      const k = String(r.accountId).toLowerCase(); const prev = out.get(k);
      const has = (x) => !!(x && x.zones && x.zones.length);
      const rank = (x) => (/report/i.test((x && x.source) || '') ? 2 : 1);     // a Time Zone column read off the report beats one guessed from the address
      if (!prev || (has(r) && (!has(prev) || rank(r) >= rank(prev))) || (!has(r) && !has(prev))) { out.set(k, r); if (k.length > 15) out.set(k.slice(0, 15), r); }
    }
  } catch (_) {}
  return out;
}
function recordZone({ accountId, accountName, state, zones, source, address, phone }) {
  if (!accountId) return null;
  const tcpa = require('./tcpa');
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, state: state || null, zones: (Array.isArray(zones) && zones.length ? zones : (state && tcpa.zonesForState(state)) || []), source: source || null, address: address ? String(address).slice(0, 160) : null, phone: phone || null };
  try { fs.appendFileSync(ZONE_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/**
 * The Shark / LDS reports have a "Time Zone" column (the pro's own time zone). Read it off every harvested row and
 * record it as the account's zone — no need to open the account page. → { header, recorded, unparsed:[…] }
 */
function zonesFromReport(leads, { save = true } = {}) {
  const tcpa = require('./tcpa'); const cur = readZones();
  let header = null, recorded = 0, total = 0; const unparsed = new Set();
  for (const l of leads || []) {
    const cols = l.cols || {}; const key = Object.keys(cols).find((k) => /time\s*-?\s*zone|timezone|^tz\b/i.test(k));
    if (!key || !l.accountId) continue;
    header = key; total++;
    const tz = tcpa.parseZone(cols[key]);
    if (!tz) { if (cols[key]) unparsed.add(cols[key]); continue; }
    const old = cur.get(String(l.accountId).toLowerCase());
    if (old && old.zones && old.zones.length === 1 && old.zones[0] === tz && /report/i.test(old.source || '')) continue;   // unchanged
    if (save) recordZone({ accountId: l.accountId, accountName: l.name, zones: [tz], source: `report column "${key}"` });
    recorded++;
  }
  return { header, recorded, total, unparsed: [...unparsed].slice(0, 8) };
}
/** Did we already try to read this account's time zone off its page, recently, and find nothing? (the empty row is kept in contact-zones.jsonl) */
function zoneTried(accountId, days = 14, now = Date.now(), zones = readZones()) {
  const r = zones.get(String(accountId || '').toLowerCase());
  // only a row that SAYS a lookup found nothing counts (older empty rows come from reads that never really looked: bad ids, a page that did not load)
  return !!(r && !(r.zones && r.zones.length) && /nothing found/.test(r.source || '') && now - Date.parse(r.at) < days * 864e5);
}
/** Zones (IANA[]) for an account, or null if unknown. */
function zonesFor(accountId, zones = readZones()) { const k = String(accountId || '').toLowerCase(); const r = zones.get(k) || zones.get(k.slice(0, 15)); return r && r.zones && r.zones.length ? r.zones : null; }

/**
 * Salesforce account harvest (`email --harvest --deep`): per account, the opportunities (name/stage/
 * close date) and the Notes list rows (titles, type, date; Activity History is no longer read). Append-only
 * account-notes.jsonl; latest record per account wins. Read-only copy of what Salesforce shows.
 */
function recordHarvest({ accountId, accountName, opps, notes, ok, demo }) {
  if (!accountId) return null;
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, ok: !!ok, opps: opps || [], notes: notes || [], demo: demo || null };
  try { fs.appendFileSync(HARVEST_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
function readHarvest() {
  const out = new Map();
  try {
    if (!fs.existsSync(HARVEST_FILE)) return out;
    for (const l of fs.readFileSync(HARVEST_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId) out.set(String(r.accountId).toLowerCase(), r);
    }
  } catch (_) {}
  return out;
}

/**
 * The Industry field as Salesforce has it (`email --industry`): append-only account-industry.jsonl, one line per read
 *   { at, accountId, accountName, industry|null, via, blank?, miss?, unavailable?, note? }
 * An ANSWER is a row with a value, an empty field (blank) or a page that is gone (unavailable); the newest answer wins.
 * A `miss` (the page rendered but has no Industry field) is not an answer: it is counted, and never erases one.
 * → Map k15 → { industry:'' | 'Plumbing', at, via, blank, unavailable, misses, accountName }   (`at` is missing while there is no answer)
 */
function recordSfIndustry({ accountId, accountName, industry, via, blank, miss, unavailable, note }) {
  if (!accountId) return null;
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, industry: industry || null, via: via || null };
  if (blank) row.blank = true; if (miss) row.miss = true; if (unavailable) row.unavailable = true; if (note) row.note = String(note).slice(0, 200);
  try { fs.appendFileSync(IND_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
function readSfIndustry() {
  const out = new Map();
  for (const r of readRows(IND_FILE)) {
    if (!r || !r.accountId) continue;
    const k = k15(r.accountId); if (!k) continue;
    const cur = out.get(k);
    if (r.miss) { if (cur) cur.misses++; else out.set(k, { industry: '', blank: false, unavailable: false, misses: 1, accountName: r.accountName || null }); continue; }
    out.set(k, { industry: r.industry || '', at: r.at, via: r.via || null, blank: !!r.blank, unavailable: !!r.unavailable, misses: 0, accountName: r.accountName || (cur && cur.accountName) || null });
  }
  return out;
}
const sfAnswered = (d) => !!(d && d.at && (d.industry || d.blank || d.unavailable));

/**
 * The Shark / LDS reports can carry the Account's "Industry" as a column. Read it off every harvested row and save it as that account's
 * Industry: no account page needed, so a NEW lead arrives with its industry the first time a report is scanned or backed up.
 * Only a value is saved (an empty cell is left for `email --industry` to confirm on the account page); an unchanged value is not saved again.
 * → { header, recorded, total }   (header: the report's column name, null when the report has no Industry column)
 */
const INDUSTRY_COLUMN = /^(account\s*[:.\-–]?\s*)?industry(\s*\([^)]*\))?$/i;
function industryFromReport(leads, { save = true } = {}) {
  const cur = readSfIndustry(); let header = null, recorded = 0, total = 0;
  for (const l of leads || []) {
    const cols = l.cols || {}; const key = Object.keys(cols).find((k) => INDUSTRY_COLUMN.test(String(k).trim()));
    if (!key || !l.accountId) continue;
    header = key; total++;
    const v = String(cols[key] == null ? '' : cols[key]).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!v || /^(--\s*none\s*--|none|n\/a|—|–|-|--)$/i.test(v)) continue;
    const old = cur.get(k15(l.accountId));
    if (old && old.industry === v) continue;                                   // unchanged
    if (save) recordSfIndustry({ accountId: l.accountId, accountName: l.name, industry: v, via: `report column "${key}"` });
    recorded++;
  }
  return { header, recorded, total };
}

/**
 * The pro's email address as a report shows it (an "Email" column on the Shark / LDS report; `email --harvest` and every report scan save it):
 * append-only account-emails.jsonl, one line { at, accountId, accountName, email, source }; the newest per account wins. The dashboard's Email column
 * shows it for an account that has no email in the outreach log yet (a lead nobody has texted or emailed).
 * → Map k15 → { email, at, source }
 */
function readReportEmails() {
  const out = new Map();
  for (const r of readRows(EML_FILE)) if (r && r.accountId && r.email) out.set(k15(r.accountId), { email: r.email, at: r.at, source: r.source || null });
  return out;
}
/**
 * Accounts whose last email attempt ended "no recipient": the account page offered no address to click and none was typed in (emailAccount.js saves email-debug/<id>.json for it, one file per
 * account, and nothing deletes it). Nothing is sent or logged for such an account, so a never-emailed list would put it first again on every run, and the follow-up board would wait at Email 1 for it
 * forever (cadence.js skips the email stages of these accounts). Luke's rule is no address, no email. A "no recipient" can also be an account whose page DID show an address the composer did not take
 * (17 of 134 on 2026-10-29): it is skipped just the same. → Set of 15-character ids, minus any account a report has given an address since (that one is worth another try).
 * (Assistant.js's `--never-emailed` list uses the same set.)
 */
function noRecipientAccounts() {
  const out = new Set(); const dir = path.join(__dirname, 'email-debug');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return out; }
  const reports = readReportEmails();
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    const at = j ? Date.parse(j.at) : NaN;
    if (!j || !/no recipient/i.test(String(j.why || '')) || !Number.isFinite(at)) continue;
    const id = (String(j.url || '').match(/\/Account\/([A-Za-z0-9]{15,18})/) || [])[1] || f.replace(/\.json$/, '');
    const k = id.toLowerCase().slice(0, 15);
    const saved = reports.get(k);
    if (saved && Date.parse(saved.at) > at) continue;      // a report gave us its address after that try
    out.add(k);
  }
  return out;
}
const EMAIL_COLUMN = /^(?:(?:account|contact|primary contact|main contact)\s*[:.\-–]?\s*)?e-?mail(?:\s*address)?(?:\s*\([^)]*\))?$/i;
/**
 * Read the report's Email column off every harvested row and save each address (no account page needed). An unchanged address is not saved again.
 * { save: false } only counts what would be saved (a --harvest --dry-run).
 * → { header, recorded, total }   (header: the report's column name, null when the report has none; total: rows with a valid address)
 */
/** The report row's own e-mail address (its "Contact: Email" column), or null when the report has no such column / the cell is blank. */
function emailOfLead(l) {
  const cols = (l && l.cols) || {}; const key = Object.keys(cols).find((k) => EMAIL_COLUMN.test(String(k).trim()));
  const v = key ? String(cols[key] == null ? '' : cols[key]).replace(/\s+/g, ' ').trim() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}
function emailsFromReport(leads, { save = true } = {}) {
  const cur = readReportEmails(); let header = null, recorded = 0, total = 0;
  for (const l of leads || []) {
    const cols = l.cols || {}; const key = Object.keys(cols).find((k) => EMAIL_COLUMN.test(String(k).trim()));
    if (!key || !l.accountId) continue;
    header = key;
    const v = String(cols[key] == null ? '' : cols[key]).replace(/\s+/g, ' ').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) continue;
    total++;
    const old = cur.get(k15(l.accountId));
    if (old && old.email.toLowerCase() === v.toLowerCase()) continue;
    if (save) { try { fs.appendFileSync(EML_FILE, JSON.stringify({ at: new Date().toISOString(), accountId: l.accountId, accountName: l.name || null, email: v, source: `report column "${key}"` }) + '\n', 'utf8'); } catch (_) {} }
    recorded++;
  }
  return { header, recorded, total };
}

/**
 * ACCOUNTS FOR `email --industry`: every account on the dashboard that has a Salesforce id, minus the ones whose Industry was
 * already read, in the order the bot works them: the Shark tab first (the accounts the follow-up bot texts), then LDS, then the rest;
 * accounts nobody has contacted yet first inside a group, then the longest-untouched (the follow-ups that come due first). An account with no Industry field on its page
 * is retried once, then left alone (until --refresh).
 *   refresh  read everything again      kind  only accounts on that list (Shark | LDS)      only  "id[,id…]": exactly those accounts
 * → { todo:[{ accountId, name, group, lastAt }], stats:{ total, withValue, blank, unavailable, gaveUp, noId, todo } }
 */
function industryTodo({ refresh = false, kind = null, only = null } = {}) {
  const sfId = require('./sfId');
  const accounts = aggregate(), snaps = snapshotMap(), done = readSfIndustry();
  const st = { total: 0, withValue: 0, blank: 0, unavailable: 0, gaveUp: 0, noId: 0, todo: 0 };
  const have = new Set(), rows = [];
  const add = (id, name, lastAt, agg) => {
    const k = k15(id); if (!k) { st.noId++; return; }
    if (have.has(k)) return; have.add(k);
    rows.push({ accountId: sfId.fix(id), name: name || '(unnamed)', lastAt: lastAt || null, k, agg: agg || null });
  };
  for (const a of accounts) add(a.accountId, a.accountName, a.lastAt, a);
  for (const sn of snaps.values()) add(sn.id, sn.name, null, null);
  const xref = readXref();
  if (xref && Array.isArray(xref.accounts)) for (const x of xref.accounts) {          // the report check keeps a 15-char lowercase id; the right-case id is in its URL
    const m = String(x.url || '').match(/\/lightning\/r\/(?:Account\/)?(001[A-Za-z0-9]{12,15})(?=[/?]|$)/);
    if (m) add(m[1], x.name, null, null);
  }
  for (const w of new Set(readClosedWon().values())) add(w.accountId, w.accountName, null, null);
  const members = readListMembership(), plans = readPlans();
  const lostKeys = new Set(lostDemoAccounts(accounts).map((l) => String(l.key).toLowerCase()));
  const listsFor = makeListsFor({ members, plans, lostKeys });
  const want = only ? new Set(String(only).split(',').map((x) => k15(x.trim())).filter(Boolean)) : null;
  const kindRe = kind ? String(kind).toLowerCase() : null;
  if (want) for (const typed of String(only).split(',').map((x) => x.trim()).filter(Boolean)) if (!have.has(k15(typed))) { have.add(k15(typed)); rows.push({ accountId: sfId.fix(typed), name: typed, lastAt: null, k: k15(typed), agg: null }); }   // an account that is not on the dashboard yet
  const todo = [];
  for (const r of rows) {
    const kinds = listsFor(r.agg ? r.agg.key : r.accountId, r.agg).map((l) => l.kind);
    if (want ? !want.has(r.k) : (kindRe && !kinds.some((x) => String(x).toLowerCase() === kindRe))) continue;
    st.total++;
    const d = done.get(r.k);
    if (sfAnswered(d)) { if (d.industry) st.withValue++; else if (d.blank) st.blank++; else st.unavailable++; }
    if (!refresh && !want) {
      if (sfAnswered(d)) continue;
      if (d && d.misses >= 2) { st.gaveUp++; continue; }
    }
    todo.push({ accountId: r.accountId, name: r.name, lastAt: r.lastAt, group: kinds.includes('Shark') ? 0 : kinds.includes('LDS') ? 1 : 2 });
  }
  todo.sort((a, b) => a.group - b.group || (a.lastAt ? 1 : 0) - (b.lastAt ? 1 : 0) || (Date.parse(a.lastAt || 0) - Date.parse(b.lastAt || 0)));      // never-contacted first, then the longest-untouched (their follow-ups come due first)
  st.todo = todo.length;
  return { todo, stats: st };
}

/**
 * Game plans written by `email --auto`: append-only auto-plans.jsonl, one line per plan
 * { at, accountId, accountName, status, flags[], reasons[], problems[], rep, demo, email{subject,body},
 *   text, callScript, confidence, repNotes, evidenceUsed[], provider }.
 * status: ready | needs-review | flagged | skipped | error | sent. Latest per account wins.
 */
function recordPlan(p) {
  const row = { at: new Date().toISOString(), ...p };
  try { fs.appendFileSync(PLAN_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
function readPlans() {
  const out = new Map();
  try {
    if (!fs.existsSync(PLAN_FILE)) return out;
    for (const l of fs.readFileSync(PLAN_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId) out.set(String(r.accountId).toLowerCase(), r);
    }
  } catch (_) {}
  return out;
}

/**
 * WHICH LIST AN ACCOUNT CAME FROM — "LDS" (Lost Demo Stage lists, e.g. Inbound KA LDS) vs "Shark" (the T14 Shark List).
 * Sources of truth, newest wins per kind:
 *   1. list-membership.jsonl  — every time a Salesforce report is read (any send/review/--lists run) its account rows are
 *      recorded here, tagged by the report. One line per scan: { at, kind, name, reportId, accounts:[{id,name}] }.
 *   2. a `source` on outreach rows / --auto plans — the report the account was reached from.
 *   3. implied: an account with a Lost Demo Stage opportunity is on the LDS side by definition.
 */
function classifyList(name) {
  const n = String(name || '');
  if (/\bshark\b|^\s*t14\b/i.test(n)) return 'Shark';
  if (/\blds\b|lost[\s_-]*demo/i.test(n)) return 'LDS';
  return null;
}
function recordListScan({ kind, name, reportId, accounts, assumed }) {
  if (!kind || !Array.isArray(accounts) || !accounts.length) return null;
  const row = { at: new Date().toISOString(), kind, name: name || null, reportId: reportId || null, assumed: !!assumed, accounts: accounts.filter((a) => a && a.id).map((a) => (a.email ? { id: a.id, name: a.name || null, email: a.email } : { id: a.id, name: a.name || null })) };
  try { fs.appendFileSync(LIST_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/** Map idLower → { LDS?:{name,at}, Shark?:{name,at} } over every scan on file. */
function readListMembership() {
  const out = new Map();
  try {
    if (!fs.existsSync(LIST_FILE)) return out;
    for (const l of fs.readFileSync(LIST_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.kind) continue;
      for (const a of r.accounts || []) {
        const k = String(a.id).toLowerCase(); const m = out.get(k) || {};
        const cur = m[r.kind];
        // a real scan always beats an assumption; otherwise the newest wins
        if (!cur || (cur.assumed && !r.assumed) || (!!cur.assumed === !!r.assumed && cur.at <= r.at)) m[r.kind] = { name: r.name, at: r.at, assumed: !!r.assumed };
        out.set(k, m);
      }
    }
  } catch (_) {}
  return out;
}

/** Reports that hold KEY ACCOUNTS (more developed businesses). For now they count as LDS (Luke, 2026-10-23); a key accounts tab will split them out later. */
const KEY_ACCOUNT_LIST = /\bka\b|key[\s_-]*accounts?/i;

/**
 * The LDS leads in our system: every account on a scanned LDS report plus every account with a Lost Demo Stage opportunity (the
 * same set as the dashboard's LDS tab), MINUS banned accounts, closed-won accounts and current customers. Accounts from the inbound
 * key-account (KA) LDS report ARE included for now. → [{ accountId, name, url, lists:[report names], ka }].
 * Options: `excludeKeyAccounts: true` drops them; `onlyKeyAccounts: true` returns only them (for the future key accounts tab);
 * `accounts` is an aggregate() the caller already has (followupDue), so the log is not read twice.
 */
function ldsLeads({ excludeKeyAccounts = false, onlyKeyAccounts = false, accounts = null } = {}) {
  const sfId = require('./sfId');
  const byKey = new Map();                       // key15 → { accountId, name, lists:Set, ka:boolean }
  const slot = (id, name) => { const k = k15(id); if (!k) return null; let e = byKey.get(k); if (!e) { e = { accountId: sfId.fix(id), name: name || null, lists: new Set(), ka: false, lds: false }; byKey.set(k, e); } if (name && !e.name) e.name = name; return e; };
  try {
    if (fs.existsSync(LIST_FILE)) for (const l of fs.readFileSync(LIST_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || r.kind !== 'LDS') continue;
      const ka = KEY_ACCOUNT_LIST.test(r.name || '');
      for (const a of r.accounts || []) { const e = slot(a.id, a.name); if (!e) continue; e.lds = true; if (r.name) e.lists.add(r.name); if (ka) e.ka = true; }
    }
  } catch (_) {}
  for (const l of lostDemoAccounts(accounts || aggregate())) { const e = slot(l.key, l.name); if (e) e.lds = true; }
  const bans = readBans(), green = readGreen(), won = readClosedWon(), cust = readCurrentCustomers();
  const out = [];
  for (const [k, e] of byKey) {
    if (!e.lds || (excludeKeyAccounts && e.ka) || (onlyKeyAccounts && !e.ka)) continue;
    if (isBanned(e.accountId, bans, green) || won.has(k) || (cust.has(k) && !cust.get(k).unverified)) continue;   // (an unverified hold goes on: the email run re-checks it)
    out.push({ accountId: e.accountId, name: e.name || e.accountId, url: `${SF_ORIGIN}/lightning/r/Account/${e.accountId}/view`, lists: [...e.lists], ka: e.ka });
  }
  return out;
}

/** Accounts that are Enrolled but only on the free Invoicing and Payments plan (and business coaching, only while coachingPolicy.js releases it: held since 2026-10-29): ours to sell. Newest check per account; banned left out. */
function freePlanLeads() {
  const sfId = require('./sfId'), coachReleased = !require('./coachingPolicy').held();
  const bans = readBans(), green = readGreen(), out = [];
  for (const r of new Set(readCustomerRows().values())) {
    if (!r || (r.verdict !== 'free-plan' && !(r.verdict === 'coaching' && coachReleased))) continue;
    if (isBanned(r.accountId, bans, green)) continue;
    out.push({ accountId: sfId.fix(r.accountId), name: r.accountName || r.accountId, url: `${SF_ORIGIN}/lightning/r/Account/${sfId.fix(r.accountId)}/view`, coaching: r.verdict === 'coaching' });
  }
  return out;
}

/** Where an account stands in the 6-step email cadence, from its touches: { step: highest touch emailed (an email with no step = 1), at, count }. */
function emailCadenceOf(touches) {
  let step = 0, at = null, count = 0;
  for (const t of touches || []) { if (t.ch !== 'email') continue; count++; const s = t.step || 1; if (s > step) step = s; if (!at || t.at > at) at = t.at; }
  return count ? { step, at, count } : null;
}

/**
 * SHARK LIST SNAPSHOTS (`email --shark`) — a morning backup of every account on the report, so nobody is lost when
 * reps work them and they drop off. One line per snapshot (append-only):
 *   { at, kind, name, reportId, reportUrl, count, accounts:[{ id, name, url, sms, cols:{<report column>:<value>} }] }
 * The dashboard shows every snapshot account (even before it is contacted) and fills in the texts/emails as they happen.
 */
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
function recordSnapshot({ kind, name, reportId, reportUrl, accounts }) {
  const list = (accounts || []).filter((a) => a && a.id).map((a) => ({ id: a.id, name: a.name || null, url: a.url || null, sms: a.sms || null, cols: a.cols || {} }));
  if (!list.length) return null;
  const row = { at: new Date().toISOString(), kind: kind || 'Shark', name: name || null, reportId: reportId || null, reportUrl: reportUrl || null, count: list.length, accounts: list };
  try { fs.appendFileSync(SNAP_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
function readSnapshots() {
  const out = [];
  try {
    if (!fs.existsSync(SNAP_FILE)) return out;
    for (const l of fs.readFileSync(SNAP_FILE, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) {} }
  } catch (_) {}
  return out;
}
/** key15 → { id, name, url, sms, cols, listName, firstAt, lastAt, snaps } over every snapshot (latest data wins). */
function snapshotMap(snaps = readSnapshots()) {
  const m = new Map();
  for (const sn of snaps) for (const a of sn.accounts || []) {
    const k = k15(a.id); const cur = m.get(k);
    m.set(k, { id: a.id, name: a.name, url: a.url, sms: a.sms, cols: a.cols || {}, listName: sn.name, kind: sn.kind, reportId: sn.reportId || null, reportUrl: sn.reportUrl, firstAt: cur ? cur.firstAt : sn.at, lastAt: sn.at, snaps: (cur ? cur.snaps : 0) + 1 });
  }
  return m;
}
/** Two scans / snapshots are of the same Salesforce report: same report id (first 15 chars) when both have one, else the same name. */
function sameReport(a, b) {
  const id = (x) => String((x && x.reportId) || '').toLowerCase().slice(0, 15), nm = (x) => String((x && x.name) || '').trim().toLowerCase();
  if (id(a) && id(b)) return id(a) === id(b);
  return !!nm(a) && nm(a) === nm(b);
}
/**
 * The newest real (not assumed) Shark scan: { at, name, ids:Set(key15) } — to see who dropped off the report since a snapshot.
 * Pass `ref` ({ reportId, name }) to look only at scans of THAT report: the time-zone sub-reports ("T14 Shark List All - Eastern")
 * hold only some of the accounts, so reading one of them must not make everyone else look like they left the list.
 */
function newestSharkScan(ref) {
  let best = null;
  try {
    for (const l of fs.readFileSync(LIST_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r.kind !== 'Shark' || r.assumed || (ref && !sameReport(r, ref))) continue;
      if (!best || r.at > best.at) best = r;
    }
  } catch (_) {}
  return best ? { at: best.at, name: best.name || null, ids: new Set((best.accounts || []).map((a) => k15(a.id))) } : null;
}

/**
 * BANLIST — accounts we must never contact again. Append-only banlist.jsonl, one line per
 * { at, accountId, accountName, reason, source }. Accounts are added AUTOMATICALLY when a
 * Salesforce review finds a Do-Not-Call / do-not-contact entry (see salesforceReview.js).
 * Every send path skips banned accounts and --force does NOT bypass it.
 *
 * GREEN BANLIST — green_banlist.jsonl: accounts explicitly cleared to be contacted despite a
 * ban. Entries are added ONLY on the operator's say-so (`node textLog.js --green <id> [why]`);
 * nothing writes to it automatically. A green entry overrides the ban.
 */
const idKey = (id) => String(id || '').toLowerCase();
function readIdSet(file) {
  const out = new Map();
  try {
    if (!fs.existsSync(file)) return out;
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId) out.set(idKey(r.accountId), r);
    }
  } catch (_) {}
  return out;
}
function readBans() { return readIdSet(BAN_FILE); }
/**
 * A reply's `at` as one real moment. replies.jsonl holds whatever "date" the poller had for the email: ISO ("2026-10-09T19:46:08Z"), an email header
 * ("Fri, 23 Oct 2026 16:29:24 +0000") or SMS-Magic's own stamp ("Fri, Oct 23, 2026 08:55 AM"). The first two name their zone; the stamp does not — it is Pacific in
 * every case in the log (each is exactly 7 h behind the Gmail clock of its message), so it is read as Pacific, not as this computer's zone: that is Eastern, like the
 * report columns parseSmsTime reads, and read that way the stamp came out 3 h early. → Date | null
 */
const REPLY_STAMP_ZONE = process.env.SMS_MAGIC_ZONE || 'America/Los_Angeles';
const MONTH_NUM = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** The moment the wall clock y-m-d H:M:S (month 0-11) shows in an IANA zone, daylight saving included. → Date | null */
function wallClockIn(zone, y, mo, d, H, M, S) {
  const asUtc = Date.UTC(y, mo, d, H, M, S);
  const offsetAt = (t) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t))) p[x.type] = +x.value;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  const t = asUtc - offsetAt(asUtc - offsetAt(asUtc));   // the zone's offset at the answer, found in two steps so a clock change in between is caught
  return Number.isFinite(t) ? new Date(t) : null;
}
function replyTime(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([AaPp])\.?[Mm]\.?)?$/);   // "Fri, Oct 23, 2026 08:55 AM"
  const mo = m ? MONTH_NUM[m[1].slice(0, 3).toLowerCase()] : undefined;
  if (mo !== undefined) {
    let H = +m[4]; if (m[7]) { const pm = /p/i.test(m[7]); if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
    return wallClockIn(REPLY_STAMP_ZONE, +m[3], mo, +m[2], H, +m[5], m[6] != null ? +m[6] : 0);
  }
  const ms = Date.parse(t);   // ISO and email-header dates name their own zone
  return Number.isFinite(ms) ? new Date(ms) : null;
}
/** The reply row with its `at` as one canonical ISO moment (a time that can't be read is left as it was). */
const replyRow = (r) => { const w = replyTime(r.at); return w ? { ...r, at: w.toISOString() } : r; };
/**
 * Replies pros texted back (replies.jsonl, written by optOut.js from the SMS-Magic emails): one line per
 * { at, messageId, accountId, accountName, reply, gift, interested }. → Map key15 → { gift, interested } where each is
 * the NEWEST reply { at, text } carrying that flag, or null.
 */
function readReplyRows() {
  const out = [];
  try {
    if (!fs.existsSync(REPLY_FILE)) return out;
    for (const l of fs.readFileSync(REPLY_FILE, 'utf8').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.at) out.push(replyRow(r)); } catch (_) {} }
  } catch (_) {}
  return out;
}
function readReplies() {
  const out = new Map();
  try {
    if (!fs.existsSync(REPLY_FILE)) return out;
    for (const l of fs.readFileSync(REPLY_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.accountId) continue;
      const k = String(r.accountId).toLowerCase().slice(0, 15);
      const e = out.get(k) || { gift: null, interested: null };
      const at = replyRow(r).at;   // one comparable moment, whatever shape the file holds
      for (const f of ['gift', 'interested']) if (r[f] && (!e[f] || (Date.parse(at) || 0) >= (Date.parse(e[f].at) || 0))) e[f] = { at, text: r.reply };
      out.set(k, e);
    }
  } catch (_) {}
  return out;
}
function readGreen() { return readIdSet(GREEN_FILE); }
/**
 * A Salesforce account id is written two ways, 15 characters and 18 (the same 15 plus a 3-character checksum), and our logs, report links and lookups carry either one.
 * True when `map` (an id map as readIdSet keys it, lower-cased) holds the account under EITHER spelling: a ban or a green entry recorded under one holds for both.
 * An id that is not shaped like a Salesforce id is matched as written.
 */
const SF_ID = /^[a-z0-9]{15}(?:[a-z0-9]{3})?$/;
function holdsAccount(map, k) {
  if (map.has(k)) return true;
  if (!SF_ID.test(k)) return false;
  const stem = k.slice(0, 15);
  if (k.length === 18) return map.has(stem);                         // an 18-character id: is its 15-character spelling in the map?
  if (typeof map.keys !== 'function') return false;
  for (const key of map.keys()) if (key.length === 18 && key.startsWith(stem)) return true;      // a 15-character id: is an 18-character spelling of it in the map?
  return false;
}
/** True when the account is banned and has not been put on the green banlist (either spelling of its id counts, for the ban and for the green entry alike). */
function isBanned(accountId, bans = readBans(), green = readGreen()) {
  const k = idKey(accountId);
  return !!k && holdsAccount(bans, k) && !holdsAccount(green, k);
}
function recordBan({ accountId, accountName, reason, source }) {
  if (!accountId || readBans().has(idKey(accountId))) return null; // already banned — keep the first record
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, reason: reason || null, source: source || null };
  try { fs.appendFileSync(BAN_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
function recordGreen({ accountId, accountName, reason }) {
  if (!accountId) return null;
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, reason: reason || null };
  try { fs.appendFileSync(GREEN_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}

/**
 * Accounts with a "Lost Demo" opportunity, from the Salesforce reviews we have read
 * (reengage-review.jsonl + lds-review.json from `--review-report`). Newest review per
 * account wins. Joined to the outreach log (our text/email counts + last touch) by accountId.
 */
const LOST_DEMO_RE = /lost[\s_-]*demo/i;
function lostDemoAccounts(accounts) {
  const sfId = require('./sfId');
  const cand = new Map(); // lower-case id → { id, name, url, opps:{at,list}, review }
  const slot = (id) => { const k = String(id).toLowerCase(); if (!cand.has(k)) cand.set(k, { id, name: null, url: null, opps: null, review: null }); const c = cand.get(k); if (id && id !== id.toLowerCase()) c.id = id; return c; };
  const addOpps = (id, name, at, list, url) => {
    if (!id || !Array.isArray(list) || !list.length) return; // a read that found no opportunities (failed read) must not erase earlier data
    const c = slot(id);
    if (!c.opps || new Date(at || 0) >= new Date(c.opps.at || 0)) c.opps = { at, list };
    if (name && !c.name) c.name = name; if (url && !c.url) c.url = url;
  };
  const addReview = (r, at) => { if (!r || !r.accountId) return; const c = slot(r.accountId); if (!c.review || new Date(at || 0) >= new Date(c.review.at || 0)) c.review = { ...r, at }; addOpps(r.accountId, r.accountName, at, r.opps, r.url); };
  for (const r of readReviews().values()) addReview(r, r.at);
  try {
    const f = path.join(__dirname, 'lds-review.json');
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const a of j.accounts || []) addReview(a, j.at); }
  } catch (_) {}
  // `email --harvest --deep` reads every account's opportunities too — those count as well.
  for (const h of readHarvest().values()) if (h.ok) addOpps(h.accountId, h.accountName, h.at, h.opps);
  const log = new Map(accounts.map((a) => [String(a.accountId || '').toLowerCase(), a]));
  const out = [];
  for (const c of cand.values()) {
    if (!c.opps) continue;
    const lost = c.opps.list.filter((o) => LOST_DEMO_RE.test(o.stage));
    if (!lost.length) continue;
    const r = c.review || {};
    const t = log.get(String(c.id).toLowerCase());
    const dates = lost.map((o) => Date.parse(o.closeDate)).filter((x) => !Number.isNaN(x));
    out.push({
      key: sfId.fix(c.id),
      name: c.name || (t && t.accountName) || '(unnamed)',
      url: c.url || (t && t.accountUrl) || `${SF_ORIGIN}/lightning/r/Account/${sfId.fix(c.id)}/view`,
      lostDemos: lost.map((o) => ({ name: o.name, closeDate: o.closeDate })),
      lostDate: dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : '',
      opps: c.opps.list.length,
      stages: [...new Set(c.opps.list.map((o) => o.stage))],
      verdict: r.verdict || '',
      reasons: r.reasons || [],
      warnings: r.warnings || [],
      notes: (r.notes || []).slice(0, 5).map((n) => n.text),
      reviewedAt: r.at || (c.opps && c.opps.at) || null,
      texts: t ? t.texts : 0,
      emails: t ? t.emails : 0,
      last: t ? t.lastAt : null,
    });
  }
  // Accounts we texted/emailed FROM the LDS report belong on the LDS tab even before their opportunities have been read.
  const have = new Set(out.map((o) => String(o.key).toLowerCase()));
  for (const a of accounts) {
    if (!a.sources || !a.sources.LDS || !a.accountId) continue;
    const k = String(a.accountId).toLowerCase(); if (have.has(k)) continue; have.add(k);
    out.push({ key: sfId.fix(a.accountId), name: a.accountName || '(unnamed)', url: a.accountUrl || `${SF_ORIGIN}/lightning/r/Account/${sfId.fix(a.accountId)}/view`, lostDemos: [], lostDate: '', opps: 0, stages: [], verdict: '', reasons: [], warnings: [], notes: [], reviewedAt: null, texts: a.texts, emails: a.emails, last: a.lastAt });
  }
  return out.sort((x, y) => (y.lostDate || '').localeCompare(x.lostDate || ''));
}

/** Template names that mark a send as the 48h re-engage touch (see email --reengage). */
const REENGAGE_PREFIX = '48h Re-engage';
/** Template names of --auto custom sends; they count as the follow-up, so the generic 48h re-engage skips them. */
const AUTO_PREFIX = 'Auto custom';
/** A stage/note matching this on the dashboard means "leave this account alone". */
const REVIEW_SKIP_DAYS = 14;
const OPT_OUT_RE = /\b(stop|dnc|do not|don'?t contact|unsub|opt.?out|remove|not interested)\b/i;

/**
 * Accounts due for the 48h re-engage on `channel` ('text' | 'email'):
 *   - last NON-re-engage touch (either channel) is >= minHours ago and <= maxDays ago
 *     (maxDays keeps stale accounts from getting a "48h follow-up" weeks late)
 *   - no re-engage send on this channel yet (once per account per channel)
 *   - has an accountId, and no opt-out stage in reengage-notes.jsonl
 * Using non-re-engage touches means the text pass finishing first doesn't make the
 * account "not due" for the email pass. Oldest-touched first.
 * Never a current customer (the held list, a hold nobody has verified yet included) or a closed-won account, any more than a banned one: the rule of the queue day and the overnight run
 * (tomorrowSend.defaultScreen; Luke, 2026-10-29). It used to offer held customers. `includeHeld: true` is for the zone / industry harvests, which read EVERY account we touched.
 */
function reengageDue(channel, { minHours = 48, maxDays = 7, now = Date.now(), includeHeld = false } = {}) {
  const notes = readReengageNotes();
  const reviews = readReviews();
  const by = new Map();
  for (const r of readAll()) {
    if (!r.accountId) continue;
    if (r.mode === MANUAL_MODE) continue;      // a lead worked by hand: its stage 2 is the Shark follow-up (3+ days), not this 48h re-engage
    let a = by.get(r.accountId);
    if (!a) { a = { accountId: r.accountId, name: r.accountName, url: r.accountUrl, lastAt: 0, firstAt: Infinity, done: false }; by.set(r.accountId, a); }
    if (r.accountName) a.name = r.accountName;
    if (r.accountUrl) a.url = r.accountUrl;
    // A --auto custom send replaces the generic re-engage on BOTH channels; a generic re-engage send
    // only closes out its own channel.
    if (String(r.templateName || '').startsWith(AUTO_PREFIX)) { a.done = true; continue; }
    if (String(r.templateName || '').startsWith(REENGAGE_PREFIX)) { if (rowChannel(r) === channel) a.done = true; continue; }
    const t = new Date(r.at).getTime();
    if (t > a.lastAt) a.lastAt = t;
    if (t < a.firstAt) a.firstAt = t;
  }
  // A Salesforce review that said "skip" (customer / closed out / do-not-contact) keeps the
  // account out for REVIEW_SKIP_DAYS so it isn't re-reviewed every batch.
  const bans = readBans(); const green = readGreen();
  const cust = includeHeld ? null : readCurrentCustomers(), cw = includeHeld ? null : readClosedWon();
  const heldOut = (id) => { if (includeHeld) return false; const f = String(id || '').toLowerCase(), k = f.slice(0, 15); return cust.has(f) || cust.has(k) || cw.has(f) || cw.has(k); };
  const reviewedSkip = (id) => { const v = reviews.get(id); return v && v.verdict === 'skip' && !v.moot && now - new Date(v.at).getTime() < REVIEW_SKIP_DAYS * 86400000; };
  return [...by.values()]
    .filter((a) => !a.done && a.lastAt && !reviewedSkip(a.accountId) && !isBanned(a.accountId, bans, green) && !heldOut(a.accountId)
      && now - a.lastAt >= minHours * 3600000 && now - a.lastAt <= maxDays * 86400000
      && !(notes.get(a.accountId) && OPT_OUT_RE.test(notes.get(a.accountId).stage + ' ' + (notes.get(a.accountId).note || ''))))
    .sort((x, y) => x.lastAt - y.lastAt)
    .map((a) => ({ name: a.name || '(unnamed account)', accountId: a.accountId, url: require('./sfId').fixUrl(a.url), lastAt: new Date(a.lastAt).toISOString(), firstAt: new Date(a.firstAt).toISOString() }));
}

/**
 * One-time best-effort seed from the shared contact-history ledger so the dashboard
 * isn't empty on day one (captures sends made before this log existed, within the
 * ledger's 48h window) — both text and email. Only adds (account, channel, sentAt)
 * triples not already present. Returns the number of rows seeded.
 */
function seedFromContactHistory() {
  const existing = new Set(readAll().map((r) => `${r.accountId || r.accountName}|${rowChannel(r)}|${r.at}`));
  const chFile = path.join(__dirname, 'contact-history.jsonl');      // this folder's own ledger (contactHistory.js lives here too)
  let seeded = 0;
  try {
    if (!fs.existsSync(chFile)) return 0;
    for (const line of fs.readFileSync(chFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (e.type !== 'delivery') continue;
      const channel = e.channel === 'email' ? 'email' : 'text';
      const id = (e.contactKey || '').startsWith('salesforce-account:') ? e.contactKey.split(':')[1] : null;
      const key = id || e.contactLabel;
      const at = e.sentAt || new Date().toISOString();
      if (!key || existing.has(`${id || e.contactLabel}|${channel}|${at}`)) continue;
      existing.add(`${id || e.contactLabel}|${channel}|${at}`);
      // contact-history stores the sent text under `content`; for email we stored
      // "subject\nbody", so split the first line back out.
      const content = e.content || '';
      let subject = null, body = null, message = null;
      if (channel === 'email') { const nl = content.indexOf('\n'); subject = nl >= 0 ? content.slice(0, nl) : content; body = nl >= 0 ? content.slice(nl + 1) : ''; }
      else message = content || null;
      const row = {
        at,
        channel,
        accountId: id,
        accountName: e.contactLabel || null,
        accountUrl: id ? `${SF_ORIGIN}/lightning/r/Account/${id}/view` : null,
        email: null,
        templateName: e.templateName || null,
        message, subject, body,
        mode: `${channel} (seeded)`,
      };
      fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n', 'utf8');
      seeded++;
    }
  } catch (_) {}
  return seeded;
}

/**
 * THE FOLLOW-UP SEQUENCE — step N is the text an account gets the Nth time it goes through `email --followup`.
 * Where an account stands is read from the log: a text sent with that step recorded, or under one of the step's names
 * (older sends carry only the template name). `names[0]` is the template name a new send is logged under.
 */
const FOLLOWUP_STEPS = [
  { step: 1, label: 'Follow-up 1', names: ['Follow-Up 1', 'Friendly Check-In'] },
  { step: 2, label: 'Follow-up 2 (success story)', names: ['Follow-Up 2 (success story)'] },
];
const followupStepOfName = (name) => { const f = FOLLOWUP_STEPS.find((x) => x.names.includes(name)); return f ? f.step : null; };
/** → { max: highest follow-up step already sent (0 = none yet), at: when that step went out } from an account's touches. */
function followupStepsSent(touches) {
  let max = 0, at = null;
  for (const t of touches || []) {
    if (t.ch === 'email') continue;
    const st = t.step || followupStepOfName(t.title);
    if (!st) continue;
    if (st > max || (st === max && String(t.at) > String(at))) { max = st; at = t.at; }
  }
  return { max, at };
}

/**
 * THE CLOSED-WON LIST — accounts whose Salesforce review found a Closed Won opportunity from the last 30 days (any rep). They are never
 * texted by the follow-up bot, and the dashboard's 🏆 Closed Won tab lists them with the OPPORTUNITY OWNER.
 * Append-only closed-won.jsonl, one line per find: { at, accountId, accountName, accountUrl, opp, stage, closeDate, owner, oppId, source }.
 * Newest find per account wins.
 */
function recordClosedWon({ accountId, accountName, accountUrl, name, opp, stage, closeDate, owner, oppId, source }) {
  if (!accountId) return null;
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, accountUrl: accountUrl || null, opp: opp || name || null, stage: stage || 'Closed Won', closeDate: closeDate || null, owner: owner || null, oppId: oppId || null, source: source || null };
  try { fs.appendFileSync(CW_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/** Map lower-case id (full and 15-char) → the newest closed-won row for that account. */
function readClosedWon() {
  const out = new Map();
  try {
    if (!fs.existsSync(CW_FILE)) return out;
    for (const l of fs.readFileSync(CW_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.accountId) continue;
      const k = String(r.accountId).toLowerCase(); const prev = out.get(k);
      if (!prev || r.at >= prev.at) { out.set(k, r); out.set(k.slice(0, 15), r); }
    }
  } catch (_) {}
  return out;
}
/**
 * CURRENT CUSTOMERS — accounts whose "Customer Status (beta)" starts with "Enrolled" (Enrolled: Current Customer, Cancel Requested, Under Review …); Canceled / Terminated stay emailable.
 * "Enrolled" also covers the FREE Invoicing and Payments sign-up, so the email run reads the account's Closed Won opportunities too (customerPlan.js) and saves what it found with the status:
 *   verdict 'customer'   a Closed Won opportunity that is not Invoicing and Payments (or none at all): held, never emailed
 *   verdict 'free-plan'  every Closed Won opportunity is Invoicing and Payments: NOT a customer, released — all outreach treats it like any other lead
 *   verdict 'coaching'   every Closed Won opportunity is Invoicing and Payments or business coaching, at least one of them coaching: kept out of outreach but listed only on the 🎓 Business Coaching tab, NOT as a current customer, while coaching-policy.json says held (Luke, 2026-10-29; released = like free-plan)
 *   no verdict           held before that check existed, or the opportunities could not be read: still held (`unverified`), and the email run looks at it again
 *   recentWin: true      (2026-11-03, Luke) NOT an Enrolled account: the follow-up board's text check (enrollCheck.js) found a Closed Won opportunity from the last 30 days that is not Invoicing and Payments, so it is held like a customer and listed on the
 *                        🤝 tab with that opportunity, whatever Customer Status says (`status` reads "Closed Won in the last 30 days (Customer Status: …)", `verdict` 'customer', `closedWon` = the opportunity)
 * Append-only current-customers.jsonl, one line per find: { at, accountId, accountName, accountUrl, status, source, verdict?, why?, closedWon?, subs?, legacy?, checkedAt?, recentWin? }. Newest per account wins.
 */
function recordCurrentCustomer({ accountId, accountName, accountUrl, status, source, verdict, why, closedWon, subs, legacy, checkedAt, recentWin }) {
  if (!accountId) return null;
  const row = { at: new Date().toISOString(), accountId, accountName: accountName || null, accountUrl: accountUrl || null, status: status || null, source: source || null };
  if (verdict) row.verdict = verdict;
  if (why) row.why = String(why).slice(0, 400);
  if (Array.isArray(closedWon)) row.closedWon = closedWon.slice(0, 8);
  if (subs) row.subs = subs;
  if (legacy) row.legacy = legacy;
  if (checkedAt) row.checkedAt = checkedAt;
  if (recentWin) row.recentWin = true;
  try { fs.appendFileSync(CUST_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}
/** The newest current-customers.jsonl row of every account whose latest Customer Status starts with "Enrolled" (or whose row is marked `recentWin`: a Closed Won in the last 30 days, see recordCurrentCustomer), whatever its verdict. → Map by lower-case id and its 15-character form (one row object per account) */
function readCustomerRows() {
  const newest = new Map();
  try {
    if (fs.existsSync(CUST_FILE)) for (const l of fs.readFileSync(CUST_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.accountId) continue;
      const k = String(r.accountId).toLowerCase().slice(0, 15); const prev = newest.get(k);
      if (!prev || r.at >= prev.at) newest.set(k, r);
    }
  } catch (_) {}
  const out = new Map();
  for (const r of newest.values()) {
    if (!/^\s*enrolled\b/i.test(r.status || '') && !r.recentWin) continue;   // Canceled / Terminated (or a blank status read later) are not current customers; a `recentWin` row is held for its Closed Won, whatever Customer Status says
    const k = String(r.accountId).toLowerCase(); out.set(k, r); out.set(k.slice(0, 15), r);
  }
  return out;
}
/** Accounts to hold back from outreach: Enrolled and not released as a free plan. A row with no verdict is `unverified` (held before the plan check existed): still held, and the email run re-checks it. */
function readCurrentCustomers() {
  const out = new Map(), coachReleased = !require('./coachingPolicy').held();      // business coaching stays on this held list = kept out of outreach (Luke, 2026-10-29) until coachingPolicy.js releases it; the dashboard does not show it as a customer
  for (const r of new Set(readCustomerRows().values())) {
    if (r.verdict === 'free-plan' || (r.verdict === 'coaching' && coachReleased)) continue;
    const row = r.verdict ? r : { ...r, unverified: true }, k = String(r.accountId).toLowerCase();
    out.set(k, row); out.set(k.slice(0, 15), row);
  }
  return out;
}
/** Closed within `days` days of `now`? (a close date we can't read counts as yes — never text on a doubt) */
function closedWithin(closeDate, days = WON_FLAG_DAYS, now = Date.now()) { const t = Date.parse(closeDate); return Number.isNaN(t) ? true : t >= now - days * 864e5; }
/** How many texts + emails we have sent this account (every row in the log, either channel). */
function touchpointCount(accountId) { const k = String(accountId || '').toLowerCase(); return k ? readAll().filter((r) => String(r.accountId || '').toLowerCase() === k).length : 0; }
/** Set the dashboard's "Re-engage at stage" for an account to "Touchpoint N" (N = our texts + emails so far, counting the one just sent). */
function recordTouchpointStage({ accountId, accountName, note }) {
  const n = touchpointCount(accountId);
  if (!accountId || !n) return null;
  return recordReengage({ key: accountId, accountName, stage: `Touchpoint ${n}`, note: note || null });
}

/**
 * "Which list is this account on?" — the one lookup behind the dashboard's #shark / #lds tags and the Shark / LDS tabs, shared with
 * the follow-up bot so the bot works exactly the accounts the Shark tab shows.
 * → (key, aggregatedAccount?) => [{ kind:'Shark'|'LDS', name, at, assumed?, via }]
 */
function makeListsFor({ members, plans, lostKeys }) {
  return (key, agg) => {
    const k = String(key).toLowerCase(); const out = {};
    const m = members.get(k); if (m) for (const [kind, v] of Object.entries(m)) out[kind] = { name: v.name, at: v.at, assumed: !!v.assumed, via: v.assumed ? 'assumed — everything on the dashboard before list tracking' : 'seen on this report' };
    // we texted/emailed it FROM that report: a real observation, so it beats the "assumed" seed (but not a real scan)
    if (agg && agg.sources) for (const [kind, v] of Object.entries(agg.sources)) if (!out[kind] || out[kind].assumed) out[kind] = v.name === MANUAL_LIST_NAME ? { name: v.name, at: v.at, via: 'added by hand', manual: true } : { name: v.name, at: v.at, via: 'reached from this report' };
    const p = plans.get(k); if (p && p.source && p.source.kind && !out[p.source.kind]) out[p.source.kind] = { name: p.source.name, at: p.at, via: 'auto run' };
    if (!out.LDS && lostKeys.has(k)) out.LDS = { name: 'Lost Demo Stage opportunity', at: null, via: 'has a Lost Demo stage' };
    return Object.entries(out).map(([kind, v]) => ({ kind, ...v }));
  };
}

/** The report's "Last Outgoing SMS DateTime" cell ("10/6/2026 4:56 PM") → Date | null. */
function parseSmsTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  if (m) {
    let H = m[4] != null ? +m[4] : 0;
    if (m[7]) { const pm = /p/i.test(m[7]); if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
    const d = new Date(+m[3], +m[1] - 1, +m[2], H, m[5] != null ? +m[5] : 0, m[6] != null ? +m[6] : 0);
    return isNaN(d) ? null : d;
  }
  const t = Date.parse(String(s || '')); return isNaN(t) ? null : new Date(t);
}
/**
 * Every account whose report "Last Outgoing SMS DateTime" is inside the last `hours` and later than our own last text — i.e. a TEAMMATE reached them.
 * Read from the saved Shark / LDS snapshots (as fresh as the last scan). → [{ id, name, url, sms, smsAt, ourAt, kind, listName, banned }] newest teammate text first
 */
function teammateList({ hours = 48, now = new Date() } = {}) {
  const sfId = require('./sfId');
  const ours = new Map();
  for (const a of aggregate()) { const k = k15(a.accountId || ''); if (k) ours.set(k, (a.touches || []).filter((t) => t.ch !== 'email')); }
  const bans = readBans(), green = readGreen(), out = [];
  for (const [k, sn] of snapshotMap()) {
    const texts = ours.get(k) || [];
    if (!teammateTexted(sn.sms, texts, now, { hours })) continue;
    const mine = texts.map((t) => Date.parse(t.at)).filter(Number.isFinite);
    out.push({ id: sfId.fix(sn.id), name: sn.name || '(unnamed account)', url: sfId.fixUrl(sn.url) || `${SF_ORIGIN}/lightning/r/Account/${sfId.fix(sn.id)}/view`, sms: sn.sms, smsAt: parseSmsTime(sn.sms).toISOString(), ourAt: mine.length ? new Date(Math.max(...mine)).toISOString() : null, kind: sn.kind || null, listName: sn.listName || null, banned: isBanned(sn.id, bans, green) });
  }
  return out.sort((x, y) => (x.smsAt < y.smsAt ? 1 : -1));
}

/**
 * Did a TEAMMATE text this account in the last `hours`? The report column is the last outgoing SMS from ANY sender, so it is a teammate's only when
 * it is later than our own last text by more than `slackMin` minutes (the clocks of the report and the log are not the same). No text of ours → any SMS counts.
 */
function teammateTexted(smsAt, ourTexts, now = new Date(), { hours = 48, slackMin = 30 } = {}) {
  const when = parseSmsTime(smsAt);
  if (!when || now.getTime() - when.getTime() > hours * 3600000 || when.getTime() > now.getTime() + 3600000) return false;
  const ours = (ourTexts || []).map((t) => Date.parse(t.at)).filter(Number.isFinite);
  return !ours.length || when.getTime() > Math.max(...ours) + slackMin * 60000;
}

/**
 * SHARK FOLLOW-UP (`email --followup`): the accounts on the dashboard's Shark tab that are due ANOTHER text — no touch from us
 * (a text or an email) for `minDays` or more whole calendar days. "Days since touch" is the number the dashboard shows: the day of
 * our newest log entry, or of a send the Salesforce report check saw (xref-today.json), whichever is later.
 * Everything that must never get a text is filtered out here (and counted, so `--inspect` can show where the list shrank):
 *   banned · a current customer on the held list (readCurrentCustomers: Enrolled and not a free plan; a hold nobody has verified yet counts too) ·
 *   opted out / "not interested" note · a Salesforce review that said skip (14 days) · already got THIS text ·
 *   texted `maxTexts`+ times already · a known time zone that is outside texting hours right now.
 * (The held list is `--followup`'s customer check: it no longer runs the Salesforce review that used to catch customers, Luke 2026-10-29.)
 * Never-contacted accounts are not follow-ups: they need a first text (`--queue` / `--report`).
 * `cohort` (a Set of 15-character ids) limits everything above to those accounts, and the stats to them: `--same-day` passes the pros texted earlier today (sameDay.js).
 * `includeLds: true` (`--followup`; Luke, 2026-10-28) also takes the LDS leads that are NOT on the Shark tab (ldsLeads(): the dashboard's LDS tab minus banned, closed-won and
 * current customers): the same filters, the same sequence, listed AFTER every Shark account (`list: 'LDS'`). An LDS lead that also has a Shark tag is a Shark account, as it always was.
 * → { leads:[{ name, accountId, url, lastAt, sinceDays, texts, emails, zones, lastOutgoingSms, list? }] the Shark accounts first, then the LDS leads, each oldest touch first, stats }
 */
function followupDue({ minDays = 3, scannedOnly = false, message = null, templateName = null, maxTexts = null, only = null, unknownZone = 'strict', sequence = null, onlyStep = null, teammateOnly = false, zoneOnly = null, cohort = null, recordSkips = false, includeLds = false, now = new Date() } = {}) {
  const tcpa = require('./tcpa'); const sfId = require('./sfId');
  const accounts = aggregate();
  const ldsKeys = includeLds ? new Set(ldsLeads({ accounts }).map((l) => k15(l.accountId))) : null;      // the LDS leads, when the caller wants more than the accounts that carry a Shark tag
  const members = readListMembership(), plans = readPlans();
  const lostKeys = new Set(lostDemoAccounts(accounts).map((l) => String(l.key).toLowerCase()));
  const listsFor = makeListsFor({ members, plans, lostKeys });
  const bans = readBans(), green = readGreen(), zones = readZones(), notes = readReengageNotes(), reviews = readReviews(), snaps = snapshotMap(), won = readClosedWon();
  const held = readCurrentCustomers();      // real customers, and holds nobody has verified yet (`unverified`): never texted. Nothing re-checks them on the way (no Salesforce review in --followup), so a doubt stays a hold
  const xref = readXref(), xrefDay = new Map();      // sends the Salesforce report check saw count as touches too (same as the dashboard)
  if (xref && xref.date && Array.isArray(xref.accounts)) for (const x of xref.accounts) if ((x.sentText || x.sentEmail) && x.id) xrefDay.set(String(x.id).toLowerCase().slice(0, 15), xref.date);
  const dayNum = (day) => { const [y, m, d] = String(day).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
  const today = localDay(now.toISOString());
  const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const st = { onShark: 0, onLds: 0, ldsUntouched: 0, noId: 0, neverTouched: 0, tooRecent: 0, banned: 0, closedWon: 0, customer: 0, optedOut: 0, reviewSkipped: 0, alreadySent: 0, overCap: 0, closedNow: 0, noZone: 0, unknownZoneClosed: 0, otherZone: 0, teammate: 0, notTeammate: 0, eligible: 0, knownZone: 0, sequenceDone: 0, waitingForText: {}, byStep: {} };
  const strictOpen = tcpa.check(now).ok;      // the all-US hours (12:00–8:00 PM Eastern, Mon–Sat): all that applies to an account with no known zone (unknownZone 'strict', the default)
  const have = new Set(), out = [];
  // One account through every filter. `c` = { key, agg?, accountId, name, url, lastAt, texts, emails, touches[] }
  const consider = (c) => {
    const shark = [c.key, ...(c.alt || [])].flatMap((k) => listsFor(k, c.agg)).filter((t) => t.kind === 'Shark');
    const onShark = shark.length > 0 && !(scannedOnly && !shark.some((t) => !t.assumed));
    const lds = !onShark && !!ldsKeys && ldsKeys.has(k15(c.accountId));      // includeLds: an LDS lead that is not on the Shark tab: the same filters below, listed after the Shark accounts
    if (!onShark && !lds) return;
    if (only && String(c.accountId || '').toLowerCase() !== String(only).toLowerCase()) return;
    if (cohort && !cohort.has(k15(c.accountId))) return;      // --same-day: ONLY these pros (a Set of 15-character ids: the Shark pros texted earlier today), whatever else is due
    if (lds) st.onLds++; else st.onShark++;
    if (!c.accountId) { st.noId++; return; }
    let day = c.lastAt ? localDay(c.lastAt) : null; const xd = xrefDay.get(k15(c.accountId)); if (xd && (!day || xd > day)) day = xd;
    const days = day ? Math.max(0, dayNum(today) - dayNum(day)) : null;
    if (days === null) { st.neverTouched++; return; }
    if (days < minDays) { st.tooRecent++; return; }
    if (isBanned(c.accountId, bans, green)) { st.banned++; return; }
    const cw = won.get(String(c.accountId).toLowerCase()); if (cw && closedWithin(cw.closeDate, WON_FLAG_DAYS, now.getTime())) { st.closedWon++; return; }
    if (held.has(String(c.accountId).toLowerCase()) || held.has(k15(c.accountId))) { st.customer++; return; }      // a current customer (Customer Status "Enrolled", not a free Invoicing and Payments plan): never texted
    const n = notes.get(c.accountId) || notes.get(c.key); if (n && OPT_OUT_RE.test(`${n.stage || ''} ${n.note || ''}`)) { st.optedOut++; return; }
    const rv = reviews.get(c.accountId); if (rv && rv.verdict === 'skip' && !rv.moot && now.getTime() - Date.parse(rv.at) < REVIEW_SKIP_DAYS * 864e5) { st.reviewSkipped++; return; }
    const texts = (c.touches || []).filter((t) => t.ch !== 'email');
    if (!sequence && ((message && texts.some((t) => norm(t.body) === norm(message))) || (templateName && templateName !== 'Custom message' && texts.some((t) => t.title === templateName)))) { st.alreadySent++; return; }   // (one chosen text: never the same one twice; in sequence mode the step decides)
    if (maxTexts && c.texts >= maxTexts) { st.overCap++; if (recordSkips) recordSkip({ accountId: c.accountId, accountName: c.name, accountUrl: c.url, kind: 'cap', reason: `already texted ${c.texts} times (cap is ${maxTexts})`, source: 'Shark follow-up' }); return; }
    const z = zonesFor(c.accountId, zones);
    if (zoneOnly && !(z && z.includes(zoneOnly))) { st.otherZone++; return; }      // --zone-only: ONLY pros whose saved zone is that one (a pro with no known zone is never in it)
    if (z && !tcpa.checkZones(z, now).ok) { st.closedNow++; return; }
    // No zone yet: the bot looks for one while it reviews the account (the opportunity's Time Zone field, then the account page). One we already
    // looked for lately and could not find is not worth another review: it is never texted without a zone.
    if (!z) {
      if (unknownZone === 'hold') { st.noZone++; return; }                                                          // --unknown-zone hold: never texted without a known zone
      else if (!strictOpen) { st.unknownZoneClosed++; return; }                                                       // default: texted only inside the all-US hours, which are closed now — no review wasted on it
    }
    // A teammate texted this account in the last 48h (the report's "Last Outgoing SMS DateTime", later than our own last text): HOLD it — no text from us,
    // and it takes no batch slot, so the queue keeps moving. The dashboard's 🤝 Teammate tab lists these accounts.
    // teammateOnly (--followup --teammate): the opposite — ONLY these accounts are due, and they get the text chosen for them.
    const tmText = teammateTexted((snaps.get(k15(c.accountId)) || {}).sms, texts, now);
    if (teammateOnly ? !tmText : tmText) { if (tmText) st.teammate++; else st.notTeammate++; return; }
    // Sequence mode (no single text chosen): the account's step decides which text it gets next.
    let seq = null;
    if (sequence) {
      const nextStep = followupStepsSent(c.touches).max + 1;
      if (nextStep > sequence.length) { st.sequenceDone++; return; }                             // went through every step already
      seq = sequence.find((q) => q.step === nextStep);
      if (!seq || !seq.text) { st.waitingForText[nextStep] = (st.waitingForText[nextStep] || 0) + 1; return; }   // that step's text is not written yet
      if (onlyStep && nextStep !== Number(onlyStep)) return;
      st.byStep[nextStep] = (st.byStep[nextStep] || 0) + 1;
    }
    if (z) st.knownZone++;
    out.push({ step: seq ? seq.step : null, stepName: seq ? seq.name : null, stepText: seq ? seq.text : null, name: c.name || '(unnamed account)', accountId: c.accountId, url: sfId.fixUrl(c.url) || `${SF_ORIGIN}/lightning/r/Account/${sfId.fix(c.accountId)}/view`, lastAt: c.lastAt || `${day}T12:00:00`, sinceDays: days, texts: c.texts, emails: c.emails, zones: z || null, lastOutgoingSms: (snaps.get(k15(c.accountId)) || {}).sms || null, ...(lds ? { list: 'LDS' } : {}) });
  };
  // The log can hold ONE account under several ids (a lowercase row, a mixed-case row, a 15- and an 18-character form), and aggregate() keeps those apart:
  // an account whose follow-up text sits under a different spelling than its email would look as if it never got the text and be texted AGAIN. Merge them here.
  const merged = new Map(), loose = [];
  for (const a of accounts) {
    const k = k15(a.accountId || '');
    if (!k) { loose.push({ ...a, alt: [] }); continue; }
    const m = merged.get(k);
    if (!m) { merged.set(k, { ...a, touches: [...a.touches], alt: [] }); continue; }
    m.touches.push(...a.touches); m.texts += a.texts; m.emails += a.emails; m.alt.push(a.key);
    if (String(a.lastAt) > String(m.lastAt)) m.lastAt = a.lastAt;
    if (a.sources) { m.sources = m.sources || {}; for (const [kind, v] of Object.entries(a.sources)) if (!m.sources[kind] || m.sources[kind].at <= v.at) m.sources[kind] = v; }
    if (a.accountId && a.accountId !== String(a.accountId).toLowerCase() && m.accountId === String(m.accountId).toLowerCase()) { m.accountId = a.accountId; m.accountUrl = a.accountUrl || m.accountUrl; }   // keep the properly-cased id
    if (!m.accountName && a.accountName) m.accountName = a.accountName;
  }
  for (const m of merged.values()) m.touches.sort((x, y) => new Date(y.at) - new Date(x.at));
  for (const a of [...merged.values(), ...loose]) { have.add(k15(a.accountId || '')); consider({ key: a.key, alt: a.alt, agg: a, accountId: a.accountId, name: a.accountName, url: a.accountUrl, lastAt: a.lastAt, texts: a.texts, emails: a.emails, touches: a.touches }); }
  // Accounts texted only OUTSIDE Assistant (the Salesforce report check knows them, our log doesn't) are on the Shark tab too.
  // The report check keeps only a 15-char lowercase id; the right-case id comes from its URL.
  if (xref && Array.isArray(xref.accounts)) for (const x of xref.accounts) {
    const k = String(x.id || '').toLowerCase().slice(0, 15);
    if (!k || have.has(k) || !(x.sentText || x.sentEmail)) continue;
    have.add(k);
    const m = String(x.url || '').match(/\/lightning\/r\/(?:Account\/)?(001[A-Za-z0-9]{12,15})(?=[/?]|$)/);
    consider({ key: k, agg: null, accountId: m ? m[1] : null, name: x.name, url: x.url, lastAt: null, texts: 0, emails: 0, touches: [] });
  }
  // Shark-tab rows nobody has contacted yet (the morning backup): on the tab, but a follow-up needs a first text first.
  for (const [k, sn] of snaps) if (!have.has(k) && sn.kind === 'Shark' && !only && !cohort) { st.onShark++; st.neverTouched++; }
  // LDS leads nobody has contacted at all are not follow-ups either (their first touch is the email cadence: email --email --core --scan lds): counted, so --inspect can say so.
  if (ldsKeys && !only && !cohort) for (const k of ldsKeys) if (!have.has(k)) st.ldsUntouched++;
  out.sort((x, y) => ((x.list === 'LDS') - (y.list === 'LDS')) || (Date.parse(x.lastAt) - Date.parse(y.lastAt)));      // the Shark accounts first, the LDS leads after them; longest-waiting first within each
  st.eligible = out.length;
  return { leads: out, stats: st };
}

/** Every parseable line of an append-only JSONL file (oldest first). */
function readRows(file) {
  const out = [];
  try {
    if (!fs.existsSync(file)) return out;
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) {} }
  } catch (_) {}
  return out;
}

// (T13 and T14 are ONE lead type, Shark, on the dashboard: every harvest of any Shark report counts as a Shark harvest, and each lead keeps its harvest time. Luke, 2026-10-27)

/**
 * DAILY HARVEST — everything the bot has READ from Salesforce, for the dashboard's "Daily harvest" tab (no outreach history).
 *   scan     a report's rows were read (list-membership.jsonl): the Shark / LDS lists, from any send / review / --lists run
 *   backup   a `--shark` / `--snapshot` morning backup (shark-snapshots.jsonl)
 *   read     per-account reads from `--harvest --deep` (account-notes.jsonl). Rows ≤15 min apart are one run; failed reads are only counted
 *   zones    time zones read off the account address (`--zones` / `--zone`);  zonecol = off a report's Time Zone column (a count only)
 *   industry the Industry field read off the account pages (`--industry`; rows ≤15 min apart are one run; answers only)
 * → { origin, events:[{ at, t, kind, name, ids:[key15…], failed?, n?, zids? }], accts:{ key15: [name, id, zones[], banned, industry, why, weak, src, at, sfBlank, guess] } }   (zids = the accounts whose time zone was saved off that scan's Time Zone column)
 * (the browser groups the events by the viewer's own calendar day)
 */
function harvestData({ days = 120 } = {}) {
  const sfId = require('./sfId');
  const cutoff = Date.now() - days * 864e5, GAP = 15 * 60 * 1000;
  const zones = readZones(), bans = readBans(), green = readGreen(), sfInd = readSfIndustry();
  const accts = {}, events = [];
  const inRange = (at) => { const t = Date.parse(at); return Number.isFinite(t) && t >= cutoff; };
  const byAt = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const reg = (id, name) => {
    const k = k15(id); if (!k) return null;
    const indArr = (nm) => { const f = indFields(nm, id, sfInd); return [f.ind, f.indWhy, f.indWeak, f.indSrc, f.indAt || null, f.sfBlank || 0, f.indGuess || null]; };
    if (!accts[k]) accts[k] = [name || null, sfId.fix(id), zonesFor(id, zones) || [], isBanned(id, bans, green) ? 1 : 0, ...indArr(name)];
    else if (!accts[k][0] && name) { accts[k][0] = name; accts[k].splice(4, 7, ...indArr(name)); }
    return k;
  };
  for (const r of readRows(LIST_FILE)) {                              // report scans (the seeded "assumed" row is not a harvest)
    if (!r || r.assumed || !r.kind || !inRange(r.at)) continue;
    const emails = {}; for (const a of r.accounts || []) if (a && a.email) { const k = reg(a.id, a.name); if (k) emails[k] = a.email; }
    events.push({ at: r.at, t: 'scan', kind: r.kind, name: r.name || null, ids: [...new Set((r.accounts || []).map((a) => reg(a.id, a.name)).filter(Boolean))], ...(Object.keys(emails).length ? { emails } : {}) });
  }
  for (const sn of readSnapshots()) {                                 // --shark backups
    if (!sn || !inRange(sn.at)) continue;
    const ids = [...new Set((sn.accounts || []).map((a) => reg(a.id, a.name)).filter(Boolean))];
    const dup = events.findIndex((e) => e.t === 'scan' && e.kind === (sn.kind || 'Shark') && e.ids.length === ids.length && Math.abs(Date.parse(e.at) - Date.parse(sn.at)) <= 5 * 60 * 1000);
    if (dup >= 0) events.splice(dup, 1);                              // the scan that fed this backup is the same harvest
    events.push({ at: sn.at, t: 'backup', kind: sn.kind || 'Shark', name: sn.name || null, ids });
  }
  let run = null, lastT = 0;
  for (const r of readRows(HARVEST_FILE).filter((x) => x && x.accountId && inRange(x.at)).sort(byAt)) {   // --harvest --deep reads
    const t = Date.parse(r.at);
    if (!run || t - lastT > GAP) { run = { at: r.at, t: 'read', kind: null, name: null, ids: [], failed: 0 }; events.push(run); }
    lastT = t;
    if (r.ok) { const k = reg(r.accountId, r.accountName); if (k && !run.ids.includes(k)) run.ids.push(k); } else run.failed++;
  }
  let ia = null, lastI = 0;
  for (const r of readRows(IND_FILE).filter((x) => x && x.accountId && !x.miss && !/^report column/i.test(x.via || '') && inRange(x.at)).sort(byAt)) {   // --industry reads of account pages (a report's Industry column belongs to that report's scan)
    const t = Date.parse(r.at);
    if (!ia || t - lastI > GAP) { ia = { at: r.at, t: 'industry', kind: null, name: null, ids: [], withValue: 0 }; events.push(ia); }
    lastI = t;
    const k = reg(r.accountId, r.accountName); if (k && !ia.ids.includes(k)) { ia.ids.push(k); if (r.industry) ia.withValue++; }
  }
  let za = null, zc = null, lastA = 0, lastC = 0;
  const scans = events.filter((e) => e.t === 'scan' || e.t === 'backup');
  for (const r of readRows(ZONE_FILE).filter((x) => x && x.accountId && x.zones && x.zones.length && inRange(x.at)).sort(byAt)) {   // resolved time zones only
    const t = Date.parse(r.at);
    if (/report/i.test(r.source || '')) {
      // read off a report's Time Zone column right after that report was scanned: count it on that scan (zn); otherwise a line of its own
      let near = null, best = 120 * 1000;
      for (const e of scans) { const d = Math.abs(Date.parse(e.at) - t); if (d <= best) { best = d; near = e; } }
      if (near) { const k = reg(r.accountId, r.accountName); if (!near.zids) near.zids = []; if (k && !near.zids.includes(k)) near.zids.push(k); continue; }
      if (!zc || t - lastC > GAP) { zc = { at: r.at, t: 'zonecol', kind: null, name: null, ids: [], n: 0 }; events.push(zc); }
      zc.n++; lastC = t;
    } else {
      if (!za || t - lastA > GAP) { za = { at: r.at, t: 'zones', kind: null, name: null, ids: [] }; events.push(za); }
      const k = reg(r.accountId, r.accountName); if (k && !za.ids.includes(k)) za.ids.push(k);
      lastA = t;
    }
  }
  events.sort(byAt);
  return { origin: SF_ORIGIN, events, accts };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The Industry of an account for the dashboard: what Salesforce says (account-industry.jsonl, `email --industry`) when it has been read,
 * else a guess from the business name (industry.js).
 * → { ind, indSrc:'sf'|'guess'|null, indAt, indWhy, indWeak, sfBlank }   (sfBlank: Salesforce was read and has nothing in the field; 2 = its account page is not available)
 */
function indFields(name, id, sf) {
  const d = sf && id ? sf.get(k15(id)) : null;
  const g = industry.guess(name);
  if (d && d.industry) return { ind: d.industry, indSrc: 'sf', indAt: d.at, indWhy: null, indWeak: 0, ...(g && g.industry.toLowerCase() !== d.industry.toLowerCase() ? { indGuess: g.industry } : {}) };   // indGuess: what the name alone would have said (shown in the tooltip)
  const out = g ? { ind: g.industry, indSrc: 'guess', indWhy: g.why, indWeak: g.weak ? 1 : 0 } : { ind: null, indSrc: null, indWhy: null, indWeak: 0 };
  if (sfAnswered(d)) { out.sfBlank = d.unavailable ? 2 : 1; out.indAt = d.at; }   // 1 = Salesforce was read and the field is empty, 2 = its account page is not available
  return out;
}

/** The 🚫 "Put an email on the do-not-contact list" box on the Skipped tab (dncByEmail.js). A missing or broken module leaves the box out: it never stops the dashboard from being written. */
const dncBox = (what) => { try { return require('./dncByEmail')[what](); } catch (_) { return ''; } };

/** Write texted-dashboard.html (combined text + email) from the current log. */
function generateDashboard() {
  // Names of the 6 email-cadence touches (emailSequence.js) for the column + filter. Required here, not at the top: emailSequence requires this file.
  let CAD_STEPS; try { CAD_STEPS = require('./emailSequence').STEPS.map((x) => x.name); } catch (_) { CAD_STEPS = ['Intro', 'Get organized', 'Never lose a lead', 'Fill the calendar', 'Never miss a call', 'Why now']; }
  const accounts = aggregate();
  // Shark snapshot accounts that nobody has contacted yet get a row of their own; contacted ones merge into their log row.
  const _snapMap = snapshotMap();
  const _have15 = new Set(accounts.map((a) => k15(a.accountId || '')));
  const _synth = [..._snapMap.values()].filter((sn) => !_have15.has(k15(sn.id))).map((sn) => ({ accountId: sn.id, accountName: sn.name, accountUrl: sn.url, email: null, texts: 0, emails: 0, lastAt: null, touches: [], days: {}, key: sn.id, bothDay: null }));
  const accountsAll = accounts.concat(_synth);
  const all = readAll();
  const totalTexts = all.filter((r) => rowChannel(r) === 'text').length;
  const totalEmails = all.filter((r) => rowChannel(r) === 'email').length;
  const notes = readReengageNotes();
  const _sfInd = readSfIndustry(); const indOf = (name, id) => indFields(name, id, _sfInd);
  const _repEml = readReportEmails();      // an Email column from a report scan, for accounts nobody has contacted yet
  // 🎓 business coaching: marked on every account whose read Closed Won opportunities include one (customerPlan.entryIsCoaching also knows the products older reads missed). A different department (Luke, 2026-10-29): kept out of outreach while coachingPolicy.js says so, and listed on its own tab, not as a customer
  const _coachHeld = require('./coachingPolicy').held(), _plan = require('./customerPlan');
  const entryCoach = (e) => !!e && (!!e.coaching || (typeof _plan.entryIsCoaching === 'function' && _plan.entryIsCoaching(e)));
  const coachMarked = (c) => !!c && (c.verdict === 'coaching' || (Array.isArray(c.closedWon) && c.closedWon.some(entryCoach)));
  const _cust = readCurrentCustomers(); const custFor = (key) => { const w = _cust.get(String(key || '').toLowerCase()) || _cust.get(k15(key)); return w ? { status: w.status, at: w.at, unverified: !!w.unverified, verified: w.verdict === 'customer' && Array.isArray(w.closedWon) && w.closedWon.length > 0, coaching: _coachHeld && coachMarked(w) } : null; };      // `coaching`: business coaching is a different department (Luke, 2026-10-29): not shown as a customer, just not contacted
  const _custAll = readCustomerRows(); const freeFor = (key) => { const w = _custAll.get(String(key || '').toLowerCase()) || _custAll.get(k15(key)); return w && (w.verdict === 'free-plan' || (w.verdict === 'coaching' && !_coachHeld)) ? { status: w.status, at: w.at, why: w.why || null, coaching: w.verdict === 'coaching' } : null; };   // Enrolled, but only on the free Invoicing and Payments plan: released (business coaching only when coachingPolicy.js releases it)
  const _cw = readClosedWon(); const cwFor = (key) => { const w = _cw.get(String(key || '').toLowerCase()) || _cw.get(k15(key)); return w ? { opp: w.opp, closeDate: w.closeDate, owner: w.owner, at: w.at } : null; };
  const _replies = readReplies(); const repFor = (key) => _replies.get(String(key || '').toLowerCase().slice(0, 15)) || {};
  const _bans = readBans(); const _green = readGreen(); const _zones = readZones(); const _harv = readHarvest(); const _plans = readPlans(); const _revs = readReviews(); const _members = readListMembership();
  const _manual = new Map();      // ✋ added by hand: the newest add per account (its stage 1), carrying the tags of all its adds
  for (const a of readManualRecords().adds) {
    const k = k15(a.accountId), cur = _manual.get(k), one = { id: a.id, at: a.at, on: a.on, did: a.did || [], note: a.note || null };
    if (!cur) _manual.set(k, { ...one, tags: [...manualTags(a)] });
    else { for (const t of manualTags(a)) if (!cur.tags.includes(t)) cur.tags.push(t); if (String(a.on) >= String(cur.on)) Object.assign(cur, one); }
  }
  const _customTags = [...new Set([..._manual.values()].flatMap((m) => m.tags).filter((t) => !MANUAL_TAG_KINDS[t]))].sort();      // the tags of his own in use (not #shark / #lds)
  const customTagsJson = JSON.stringify(_customTags);
  // Which list(s) the account came from: report scans, the report it was reached from, and Lost Demo stage (→ LDS).
  const _lostRaw = lostDemoAccounts(accounts);
  const _lostKeys = new Set(_lostRaw.map((l) => String(l.key).toLowerCase()));
  const listsFor = makeListsFor({ members: _members, plans: _plans, lostKeys: _lostKeys });
  // Original sales rep + date of the original demo: from the latest --auto plan, else from the --harvest --deep read.
  const odFor = (key) => { const k = String(key).toLowerCase(); const p = _plans.get(k); if (p && p.originalDemo) return p.originalDemo; const h = _harv.get(k); return h && h.demo ? h.demo : null; };
  const planFor = (key) => { const p = _plans.get(String(key).toLowerCase()); return p ? { at: p.at, status: p.status, flags: p.flags || [], reasons: p.reasons || [], problems: p.problems || [], rep: p.rep || null, demo: p.demo || null, email: p.email || null, text: p.text || null, callScript: p.callScript || null, confidence: p.confidence || null, repNotes: p.repNotes || null, evidenceUsed: p.evidenceUsed || [], notes: (p.notes || []).slice(0, 3), sent: p.sent || null, read: p.read || null, digest: p.digest || [] } : null; };
  const flagsFor = (key) => { const r = _revs.get(key); const p = _plans.get(String(key).toLowerCase()); return [...new Set([...(r && r.flags || []), ...(p && p.flags || [])])]; };
  const lostDemo = _lostRaw.map((l) => ({ ...l, ...indOf(l.name, l.key), plan: planFor(l.key), lists: listsFor(l.key, null), originalDemo: odFor(l.key), flags: flagsFor(l.key), sf: (() => { const h = readHarvest().get(String(l.key).toLowerCase()); return h && h.ok ? { at: h.at, opps: h.opps.slice(0, 20), notes: h.notes.slice(0, 15) } : null; })(), banned: isBanned(l.key, _bans, _green), closedWon: cwFor(l.key), customer: custFor(l.key), freePlan: freeFor(l.key), state: (_zones.get(String(l.key).toLowerCase()) || {}).state || null, zones: zonesFor(l.key, _zones), note: notes.has(l.key) ? { stage: notes.get(l.key).stage, at: notes.get(l.key).at } : null }));
  const generatedAt = new Date().toLocaleString('en-US');
  // The Instructions tab: written by hand in instructions.html (flags, the Shark backup steps, ports) and embedded as-is.
  let instrHtml = '';
  try { instrHtml = fs.readFileSync(path.join(__dirname, 'instructions.html'), 'utf8'); } catch (_) {}
  if (!instrHtml.trim()) instrHtml = '<div class="empty">No instructions yet. Add an <code>instructions.html</code> next to <code>textLog.js</code>, then run <code>node textLog.js</code> again.</div>';
  const rows = accountsAll.map((a) => ({
    name: a.accountName || '(unnamed)',
    ...indOf(a.accountName, a.key),
    url: a.accountUrl || '',
    email: a.email || (_repEml.get(k15(a.key)) || {}).email || '',
    texts: a.texts,
    emails: a.emails,
    last: a.lastAt,
    key: a.key,
    banned: isBanned(a.key, _bans, _green),
    gift: repFor(a.key).gift || null,
    interested: repFor(a.key).interested || null,
    closedWon: cwFor(a.key),
    customer: custFor(a.key),
    freePlan: freeFor(a.key),
    fu: (() => { const f = followupStepsSent(a.touches); return f.max ? { step: f.max, at: f.at } : null; })(),
    cad: emailCadenceOf(a.touches),
    state: (_zones.get(String(a.key).toLowerCase()) || {}).state || null,
    zones: zonesFor(a.key, _zones),
    zoneSource: (_zones.get(String(a.key).toLowerCase()) || {}).source || null,
    plan: planFor(a.key),
    lists: listsFor(a.key, a),
    manual: _manual.get(k15(a.key)) || null,
    originalDemo: odFor(a.key),
    flags: flagsFor(a.key),
    sf: (() => { const h = _harv.get(String(a.key).toLowerCase()); return h && h.ok ? { at: h.at, opps: h.opps.slice(0, 20), notes: h.notes.slice(0, 15) } : null; })(),
    days: a.days,
    bothDay: a.bothDay,
    note: notes.has(a.key) ? { stage: notes.get(a.key).stage, at: notes.get(a.key).at } : null,
    touches: a.touches.map((t) => ({ ch: t.ch, at: t.at, title: t.title, body: t.body })),
  }));

  // Overlay the Salesforce-report cross-reference (xref.js → xref-today.json): what the
  // text/email REPORTS say was sent today, including sends made outside Assistant that
  // the local log never saw. Accounts only the reports know about get a row of their own.
  const xref = readXref();
  if (xref && Array.isArray(xref.accounts)) {
    const byId = new Map();
    rows.forEach((r) => { const id = id15(r.key); if (id) byId.set(id, r); });
    for (const x of xref.accounts) {
      let r = byId.get(x.id);
      if (!r) {
        r = { name: x.name || '(unnamed)', ...indOf(x.name, x.id), url: x.url || '', email: x.address || '', texts: 0, emails: 0, last: xref.generatedAt, key: x.id, closedWon: cwFor(x.id), customer: custFor(x.id), freePlan: freeFor(x.id), days: {}, bothDay: null, note: notes.has(x.id) ? { stage: notes.get(x.id).stage, at: notes.get(x.id).at } : null, touches: [] };
        rows.push(r); byId.set(x.id, r);
      }
      r.xref = { date: xref.date, text: !!x.sentText, email: !!x.sentEmail };
      if (!r.lists) r.lists = listsFor(x.id, null);
      if (x.sentText && x.sentEmail && (!r.bothDay || r.bothDay < xref.date)) r.bothDay = xref.date;
    }
  }
  // Snapshot facts on every row that was backed up: when, from which report, the report's own columns, still on it or not.
  const _scans = new Map();   // newest scan of the same report as a snapshot
  const scanFor = (sn) => { const key = `${sn.reportId || ''}|${sn.listName || ''}`; if (!_scans.has(key)) _scans.set(key, newestSharkScan({ reportId: sn.reportId, name: sn.listName })); return _scans.get(key); };
  for (const r of rows) {
    const sn = _snapMap.get(k15(r.key)); if (!sn) continue;
    const _scan = scanFor(sn);
    const later = !!(_scan && _scan.at > sn.lastAt);
    r.snapshot = { at: sn.lastAt, firstAt: sn.firstAt, snaps: sn.snaps, list: sn.listName, sms: sn.sms, cols: Object.fromEntries(Object.entries(sn.cols || {}).slice(0, 14)), onReport: later ? _scan.ids.has(k15(r.key)) : null, checkedAt: later ? _scan.at : null };
  }
  // WHEN each account was harvested (the dashboard's Harvested column): one entry per kind of list (Shark / LDS; T13 and T14 are both Shark), newest first. Every harvest of any
  // Shark report counts, whichever report it was: { kind, at (latest), first, n (how many harvests), name (the report it was last read from) }.
  const harvAll = harvestData();
  const _hv = new Map();
  for (const e of harvAll.events) {
    if ((e.t !== 'scan' && e.t !== 'backup') || !e.kind) continue;
    for (const k of e.ids) {
      const m = _hv.get(k) || new Map(); _hv.set(k, m);
      const c = m.get(e.kind);
      if (!c) m.set(e.kind, { kind: e.kind, at: e.at, first: e.at, n: 1, name: e.name || null });
      else { c.n++; if (e.at > c.at) { c.at = e.at; c.name = e.name || c.name; } if (e.at < c.first) c.first = e.at; }
    }
  }
  for (const r of rows) { const m = _hv.get(k15(r.key)); if (m) r.hv = [...m.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); }
  // WHAT we sent each lead: the same message more than once (the same wording on the same channel) is flagged, so a repeat can never go unnoticed. (The send loops now refuse it: sentSameMessage.)
  for (const r of rows) {
    const groups = new Map();
    for (const t of r.touches || []) {
      const k = `${t.ch}|${msgNorm(t.ch === 'email' ? `${t.title}\n${t.body}` : (t.body || t.title))}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const d = [...groups.values()].filter((g) => g.length > 1);
    if (d.length) r.dup = d.map((g) => ({ ch: g[0].ch, title: g[0].title, n: g.length, at: g.map((t) => t.at) }));
  }
  const data = JSON.stringify(rows);
  const lostJson = JSON.stringify(lostDemo);
  // 🏆 the closed-won list: one row per account, newest close first (the browser sorts)
  // 🤝 Teammate texted tab: a VERIFIED current customer (a real plan Closed Won, with the evidence on its Current customers row; teammateCustomers.js moves the pros who closed in the last 30 days) is not a lead any more: it is on the Current customers tab, not here
  const notCustomer = (id) => { const c = custFor(id); return !(c && c.verified); };
  const holdJson = JSON.stringify(require('./threadReader').recentHolds(3).filter((h) => notCustomer(h.accountId))).replace(/</g, '\\u003c');
  const tmJson = JSON.stringify(teammateList().filter((t) => notCustomer(t.id))).replace(/</g, '\\u003c');
  // 🛑 Skipped tab: every account the pre-send Salesforce review stopped (skip / could not be read) plus the do-not-contact banlist, with the reasons.
  const skipRows = new Map();
  for (const r of _revs.values()) {
    if (r.verdict !== 'skip' && r.verdict !== 'unknown') continue;
    const banned = isBanned(r.accountId, _bans, _green);
    skipRows.set(idKey(r.accountId), { id: r.accountId, name: r.accountName || '(unnamed)', ...indOf(r.accountName, r.accountId), url: `${SF_ORIGIN}/lightning/r/Account/${require('./sfId').fix(r.accountId)}/view`, verdict: r.verdict, reasons: r.reasons || [], warnings: r.warnings || [], flags: r.flags || [], cw: !!r.closedWon, banned, at: r.at });
  }
  for (const b of _bans.values()) {
    if (skipRows.has(idKey(b.accountId)) || isBanned(b.accountId, _bans, _green) === false) continue;
    skipRows.set(idKey(b.accountId), { id: b.accountId, name: b.accountName || '(unnamed)', ...indOf(b.accountName, b.accountId), url: `${SF_ORIGIN}/lightning/r/Account/${require('./sfId').fix(b.accountId)}/view`, verdict: 'ban', reasons: [b.reason || 'on the do-not-contact list'], warnings: [], flags: [], cw: false, banned: true, at: b.at, source: b.source });
  }
  const _tcpa = require('./tcpa'), _sfid = require('./sfId');
  for (const r of readSkips()) {
    const key = idKey(r.accountId);
    if (skipRows.has(key + '|' + r.kind)) continue;
    skipRows.set(key + '|' + r.kind, { id: r.accountId, name: r.accountName || '(unnamed)', ...indOf(r.accountName, r.accountId), url: _sfid.fixUrl(r.accountUrl) || `${SF_ORIGIN}/lightning/r/Account/${_sfid.fix(r.accountId)}/view`, verdict: r.kind, reasons: [r.reason || r.kind], warnings: [], flags: [], cw: false, banned: false, at: r.at, source: r.source });
  }
  for (const h of require('./threadReader').recentHolds(30)) {
    const key = idKey(h.accountId) + '|hold';
    skipRows.set(key, { id: h.accountId, name: h.accountName || '(unnamed)', ...indOf(h.accountName, h.accountId), url: _sfid.fixUrl(h.accountUrl) || `${SF_ORIGIN}/lightning/r/Account/${_sfid.fix(h.accountId)}/view`, verdict: 'hold', reasons: [h.reason || 'held by a thread read'], warnings: [], flags: [], cw: false, banned: false, at: h.at, source: h.kind });
  }
  // ⏳ Send queue: exactly what `email --board` will send (sendQueue.js): the board run's own list (boardRun.look), in the order the run reaches it, each with an approximate time. The board is
  // evaluated once, here, and the 🗂 Follow-up board tab below reuses it, so the two tabs cannot disagree. (Luke, 2026-11-02, "match the board": it used to be the saved --queue list plus the old
  // --followup due list, about 2,100 rows the board does not work on its own.)
  const queueRows = [];
  let queueHtml = '', _boardEv = null;
  try {
    const nowT = new Date(), sq = require('./sendQueue'), cad = require('./cadence'), br = require('./boardRun'), cfg = cad.loadConfig();
    let TPL = {}; try { TPL = require('./Assistant').TEMPLATES || {}; } catch (_) {}
    let EST = null; try { EST = require('./emailSequence').STEPS; } catch (_) {}
    const copyOf = (s) => cad.copyOf(s, TPL, EST);
    const looked = br.look({ cfg, copyFor: (s) => !!copyOf(s), gotCopy: br.gotCopyFor(copyOf, (id, c) => sentSameMessage(id, 'text', { templateName: c.name, message: c.text })), flags: br.parseFlags([]), tried: null }, nowT, cad.members({ now: nowT }));
    _boardEv = looked.all;
    for (const { e, eta } of sq.schedule(looked.auto, nowT)) {
      const l = e.lead, zn = l.zones && l.zones.length ? l.zones : null, kinds = (l.kinds || []).filter(Boolean);
      queueRows.push({ id: l.accountId, name: l.name || '(unnamed)', ...indOf(l.name, l.accountId), url: _sfid.fixUrl(l.url) || `${SF_ORIGIN}/lightning/r/Account/${_sfid.fix(l.accountId)}/view`, src: (e.next.ch === 'email' ? '✉️ ' : '📱 ') + e.next.label + (kinds.length ? ' · ' + kinds.join(' / ') : ''), zone: zn ? zn.map((z) => _tcpa.ZONE_SHORT[z] || z).join('/') : null, eta });
    }
    let saved = 0; try { saved = require('./textQueue').pendingLeads().length; } catch (_) {}
    const D = br.DEFAULTS;
    queueHtml = sq.introHtml({ autoDays: cfg.autoDays, textSec: D.textSec + D.checkSec, emailSec: D.emailSec }) + sq.noteHtml(sq.counts(looked.all, looked.auto, br.endOfRunDay(nowT).getTime()), { autoDays: cfg.autoDays, saved });
  } catch (e) { queueRows.length = 0; queueHtml = `<div class="sub" style="margin-bottom:10px">⚠️ The send queue could not be built (${String((e && e.message) || e).replace(/[<>&]/g, '')}). <code>email --board --inspect</code> prints the same list in the Terminal.</div>`; }
  const queueJson = JSON.stringify(queueRows).replace(/</g, '\\u003c');
  // 🗂 Follow-up board: every lead on a list (Shark, LDS, and the email runs' 'Email report' / 'Free plan' lists) by the stage of the thirteen-stage cadence it is waiting for (cadence.js). Read from OUR OWN LOG, never from the Shark report (which drops a pro the moment anybody reaches them).
  let boardJson = '[]', boardTpl = '{}';
  try {
    const cad = require('./cadence'), cadCfg = cad.loadConfig(), nowB = new Date(), ZS = require('./tcpa').ZONE_SHORT || {};
    let TPL = {}; try { TPL = require('./Assistant').TEMPLATES || {}; } catch (_) {}
    let EST = null; try { EST = require('./emailSequence').STEPS; } catch (_) {}
    const stageIdx = new Map(cadCfg.stages.map((s, i) => [s.id, i]));
    const ev = _boardEv || cad.board(cad.members({ now: nowB }), cadCfg, nowB, { copyFor: (s) => !!cad.copyOf(s, TPL, EST), gotCopy: (l, s) => { const c = cad.copyOf(s, TPL, EST); return c && c.text ? sentSameMessage(l.accountId, 'text', { templateName: c.name, message: c.text }) : null; } });      // (gotCopy: a stage whose exact text the lead already got is done, as boardRun sees it)
    const boardInd = (l) => l.ind ? { i: l.ind.name, ...(l.ind.src === 'sf' ? { is: 1 } : l.ind.weak ? { iw: 1 } : {}) } : {};      // the industry picker: i = the industry (Salesforce's once --industry has read it, else the guess from the name; cadence.members decides, so the run's --trade filter agrees), is = read from Salesforce, iw = a weak guess; none = unknown
    const board = ev.map((e) => ({ n: e.lead.name, u: e.lead.url || '', k: e.lead.kinds, z: (e.lead.zones || []).map((x) => ZS[x] || x).join('/') || null, s: e.nextIdx, st: e.state, ra: e.readyAt, op: e.opensAt, h: e.hold, o: e.old ? 1 : 0, la: e.lastAt, td: e.sentToday.map((id) => stageIdx.get(id)), ...boardInd(e.lead), ...(e.lead.hand ? { hd: 1, tg: e.lead.own } : {}) }));
    const stg = cadCfg.stages.map((s) => {      // what each stage says (an email shows a neutral account: the greeting is generic and the story is the all-trades one; a trade-specific story replaces it per account)
      const c = cad.copyOf(s, TPL, EST);
      if (s.ch === 'email' && s.emailTemplate) {      // a stage with its own named email (email-templates.json): shown with a neutral account, like the library emails
        let nt = null; try { nt = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-templates.json'), 'utf8'))[s.emailTemplate] || null; } catch (_) {}
        const neutral = (x) => String(Array.isArray(x) ? x.join('\n') : (x || '')).replace(/\{\{\s*greeting\s*\}\}/g, 'Hi [business name],').replace(/\{\{\s*business\s*(?:\|[^}]*)?\}\}/g, '[business name]').replace(/\{\{[^}]*\}\}/g, '');
        return { id: s.id, label: s.label, ch: 'email', name: c ? c.name : '', subject: nt ? neutral(nt.subject) : '', body: nt ? neutral(nt.body) : '', missing: !c };
      }
      if (s.ch === 'email') { try { const t = require('./emailSequence').buildTouch('', s.n, {}); return { id: s.id, label: s.label, ch: 'email', name: t.name, subject: t.subject, body: t.bodyText.replace(/^Hi,/, 'Hi [business name],') }; } catch (_) { return { id: s.id, label: s.label, ch: 'email', name: c ? c.name : '', subject: '', body: '' }; } }
      return { id: s.id, label: s.label, ch: 'text', name: c ? c.name : '', body: c ? c.text : '', missing: !c };
    });
    cadCfg.stages.forEach((s, i) => { if (stg[i]) { if (s.byHand) stg[i].hand = 'skip'; else if (s.manual) stg[i].hand = 'manual'; } });      // ✋ done by hand: 'skip' = the board never sends the stage, 'manual' = a label only (the board still sends it if a run picks it)
    boardTpl = JSON.stringify({ stages: stg, autoDays: cadCfg.autoDays }).replace(/</g, '\\u003c');
    boardJson = JSON.stringify(board).replace(/</g, '\\u003c');
  } catch (e) { boardJson = '[]'; boardTpl = '{"stages":[],"autoDays":7}'; }
  // 🎯 Top hit list (Leads): pros who answered with interest + the accounts on Luke's own hit list (topHit.js). They all stay on the follow-up board; each row says where it stands there (the same evaluation as the board tab).
  let topHitJson = '[]';
  try {
    const th = require('./topHit'), cadTH = require('./cadence'), nowTH = new Date();
    const evTH = _boardEv || cadTH.board(cadTH.members({ now: nowTH }), cadTH.loadConfig(), nowTH, { copyFor: () => true, gotCopy: null });
    const evBy = new Map(evTH.map((e) => [String(e.lead.accountId || '').toLowerCase().slice(0, 15), e]));
    topHitJson = JSON.stringify(th.list({ leads: evTH.map((e) => e.lead) }).rows.map((r) => { const e = evBy.get(String(r.id || '').toLowerCase().slice(0, 15)); return { id: r.id, name: r.name, url: r.url, at: r.at, kind: r.kind, text: r.text, note: r.note, noteAt: r.noteAt, reply: r.reply, replyAt: r.replyAt, n: r.n, ...(e ? { s: e.nextIdx, st: e.state, ra: e.readyAt, h: e.hold, la: e.lastAt } : {}) }; })).replace(/</g, '\\u003c');
  } catch (e) { topHitJson = '[]'; }
  const skipJson = JSON.stringify([...skipRows.values()]).replace(/</g, '\\u003c');
  const custJson = JSON.stringify([...new Set(_custAll.values())].map((c) => ({ id: c.accountId, name: c.accountName || '(unnamed)', ...indOf(c.accountName, c.accountId), url: require('./sfId').fixUrl(c.accountUrl) || `${SF_ORIGIN}/lightning/r/Account/${require('./sfId').fix(c.accountId)}/view`, status: c.status, at: c.at, source: c.source, verdict: c.verdict || null, coach: coachMarked(c), why: c.why || null, subs: c.subs || null, legacy: c.legacy || null, closedWon: (c.closedWon || []).map((e) => ({ id: e.id || null, name: e.name || null, closeDate: e.closeDate || null, owner: e.owner || null, ip: !!e.ip, coaching: entryCoach(e), via: e.via || null, fields: (e.fields || []).slice(0, 10) })) }))).replace(/</g, '\\u003c');
  const wonJson = JSON.stringify([...new Set(_cw.values())].map((w) => ({ id: w.accountId, name: w.accountName || '(unnamed)', ...indOf(w.accountName, w.accountId), url: require('./sfId').fixUrl(w.accountUrl) || `${SF_ORIGIN}/lightning/r/Account/${require('./sfId').fix(w.accountId)}/view`, opp: w.opp, closeDate: w.closeDate, owner: w.owner, at: w.at, source: w.source }))).replace(/</g, '\\u003c');
  // newest first by real time (readReplyRows gives every `at` as one ISO moment; one it can't read sorts last)
  const perfJson = JSON.stringify(require('./perfAnalytics').build({ rows: all, replies: readReplyRows(), won: [...new Set(_cw.values())], indOf, zonesFor: ((z) => (id) => zonesFor(id, z))(readZones()), isBanned: ((b, g) => (id) => isBanned(id, b, g))(readBans(), readGreen()), sfUrl: (id) => require('./sfId').fixUrl(`${SF_ORIGIN}/lightning/r/Account/${id}/view`) })).replace(/</g, '\\u003c');
  const repliesJson = JSON.stringify(readReplyRows().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).map((r) => {
    const f = r.accountId ? indOf(r.accountName, r.accountId) : {};
    return { at: r.at, name: r.accountName || '(unnamed)', key: r.accountId || null, url: r.accountId ? require('./sfId').fixUrl(`${SF_ORIGIN}/lightning/r/Account/${r.accountId}/view`) : null, reply: r.reply || '', gift: !!r.gift, interested: !!r.interested, optout: !!r.optout, ind: f.ind || null, ch: r.channel === 'email' ? 'email' : 'text' };
  })).replace(/</g, '\\u003c');
  const outDailyJson = JSON.stringify((() => { const m = {}; for (const r of all) { const d = localDay(r.at); if (!d) continue; const o = m[d] || (m[d] = { t: 0, e: 0 }); if (rowChannel(r) === 'email') o.e++; else o.t++; } return m; })());
  const harvJson = JSON.stringify(harvAll).replace(/</g, '\\u003c');   // names can't close the <script>

  const tcpaJson = JSON.stringify({ start: require('./tcpa').WINDOW.startHour, knownStart: require('./tcpa').WINDOW.knownStartHour, end: require('./tcpa').WINDOW.endHour, sunday: !!require('./tcpa').WINDOW.allowSunday });
  const tcpaWin = { start: require('./tcpa').WINDOW.startHour, knownStart: require('./tcpa').WINDOW.knownStartHour, end: require('./tcpa').WINDOW.endHour };
  // 🔀 Graph tab: pipeline-diagram.html (the workflow map) and today's numbers for it (workflowSnapshot.js, read-only), both as of this build. Either one missing leaves the tab saying so, never the page broken.
  let graphJson = 'null', wfSnapJson = 'null';
  try { graphJson = JSON.stringify({ html: fs.readFileSync(path.join(__dirname, 'pipeline-diagram.html'), 'utf8'), built: new Date().toISOString() }).replace(/</g, '\\u003c'); } catch (e) { graphJson = 'null'; }
  try { wfSnapJson = JSON.stringify(require('./workflowSnapshot').snapshot()).replace(/</g, '\\u003c'); } catch (e) { wfSnapJson = 'null'; }
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline Assistant — Outreach Log</title>
<style>
  :root{ --bg:#0f1420; --card:#161d2e; --line:#273047; --fg:#e8edf7; --mut:#93a0bd; --accent:#4f8cff; --text:#22c55e; --email:#f59e0b; --chip:#1f2940; }
  @media (prefers-color-scheme: light){ :root:not([data-theme="dark"]){ --bg:#f5f7fb; --card:#fff; --line:#e4e8f0; --fg:#141a28; --mut:#5a6782; --accent:#2563eb; --text:#16a34a; --email:#d97706; --chip:#eef2f9; } }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
  h1{font-size:20px;margin:0 0 2px}
  .sub{color:var(--mut);font-size:13px;margin-bottom:18px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:110px}
  .stat b{display:block;font-size:22px}
  .stat span{color:var(--mut);font-size:12px}
  .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .bar select{max-width:100%}
  #flt{max-width:300px}
  #addf{max-width:300px}
  .addrange{display:inline-flex;gap:6px;align-items:center;color:var(--mut);font-size:13px}
  .addrange[hidden]{display:none}
  .addrange input[type=date]{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:8px 10px;font-size:13px}
  .addnote{font-size:13px;color:var(--mut);margin:-4px 0 12px}
  .addnote b{color:var(--fg)}
  input[type=search]{flex:1;min-width:200px;background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 12px;font-size:14px}
  button{background:var(--chip);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 14px;font-size:13px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;user-select:none;white-space:nowrap}
  th.asc:after{content:" ▲"} th.desc:after{content:" ▼"}
  tr:last-child td{border-bottom:none}
  td a{color:var(--accent);text-decoration:none} td a:hover{text-decoration:underline}
  .acct{cursor:pointer}
  .acct .caret{color:var(--mut);display:inline-block;width:14px}
  .pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid var(--line)}
  .pill.t{color:var(--text)} .pill.e{color:var(--email)}
  .muted{color:var(--mut)}
  .timeline{background:transparent}
  tr.grp td{background:var(--card,#f3f4f6);font-weight:600;cursor:pointer;border-top:2px solid rgba(128,128,128,.35)}
  tr.grp .gs{font-weight:400;opacity:.75;margin-left:10px}
  tr.gcol{display:none}
  .timeline td{padding-top:0}
  .touch{border-left:3px solid var(--line);padding:6px 0 6px 12px;margin:6px 0}
  .touch.t{border-color:var(--text)} .touch.e{border-color:var(--email)}
  .touch .meta{font-size:12px;color:var(--mut);margin-bottom:3px}
  .touch .title{font-weight:600}
  .touch .body{white-space:pre-wrap;color:var(--fg);opacity:.92;margin-top:2px;font-size:13px}
  .empty{padding:40px;text-align:center;color:var(--mut)}
  .kb{display:flex;gap:10px;overflow-x:auto;align-items:flex-start;padding-bottom:12px}
  .kcol{flex:0 0 220px;background:var(--chip);border:1px solid var(--line);border-radius:12px;padding:10px}
  .kcol h4{margin:0 0 2px;font-size:13px} .kcol .ks{font-size:12px;color:var(--mut);margin-bottom:6px}
  .kcol code{display:block;font-size:11px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin:6px 0;white-space:normal;word-break:break-all;user-select:all}
  .kcard{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:6px 8px;margin-top:6px;font-size:12px}
  .kcard.due{border-left-color:var(--text)} .kcard.rep{border-left-color:#ef4444} .kcard a{color:var(--fg);text-decoration:none;font-weight:600}
  .kcard .m{color:var(--mut);font-size:11px}
  .kcard.held{border-left-color:var(--mut);opacity:.8}
  .ktpl{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:10px;font-size:12px}
  .ktpl .kh{color:var(--email);font-size:11px;font-weight:600;margin-bottom:3px}
  .ktpl .kb2{white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:4px;color:var(--fg);opacity:.9}
  .right{margin-left:auto}
  .pill.both{color:#fff;background:var(--text);border-color:var(--text)}
  .pill.miss{color:var(--email);border-color:var(--email)}
  select,input.stage{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:9px 10px;font-size:13px}
  input.stage{width:140px;padding:5px 8px;border-radius:8px}
  input.stage.unsaved{border-color:var(--email)}
  .nm{cursor:pointer;color:var(--accent)} .nm:hover{text-decoration:underline} .sfl{color:var(--mut);text-decoration:none;font-size:12px}
  .tabs{display:flex;gap:6px;margin:0 0 14px;border-bottom:1px solid var(--line);overflow-x:auto}
  .tab{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--mut);padding:9px 14px;font-size:14px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
  .tab:hover{color:var(--fg);border-color:transparent}
  .tab.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
  .groups{margin-bottom:10px}
  .groups .tab{padding:10px 20px;font-size:15px}
  .subtabs{border-bottom:0;padding:2px 0 4px;margin-bottom:12px;scrollbar-width:thin}
  .subtabs[hidden]{display:none}
  .subtabs .tab{border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:13px}
  .subtabs .tab:hover{border-color:var(--accent)}
  .subtabs .tab.on{border-color:var(--accent);background:var(--chip);color:var(--fg)}
  .pill.ok{color:var(--text)} .pill.skip{color:#ef4444;border-color:#ef4444} .pill.unk{color:var(--email)}
  .pill.snap{color:#0891b2;border-color:#0891b2}
  .pill.free{color:#16a34a;border-color:#16a34a}
  .pill.hand{color:#0e7490;border-color:#0e7490}
  .pill.auto{color:var(--mut)}
  .wrap.graphwide{max-width:none}
  #graphbox{height:calc(100vh - 250px);min-height:520px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
  #graphbox iframe{display:block;width:100%;height:100%;border:0}
  .addbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 12px}
  .addbox>summary{cursor:pointer;font-weight:600}
  .addbox .abg{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:10px 0}
  .addbox label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--mut)}
  .addbox input[type=text],.addbox input[type=date],.addbox textarea,.addbox select{background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px}
  .addbox .abd{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
  .addbox .abd label{flex-direction:row;align-items:center;gap:5px;color:var(--fg);font-size:13px}
  .addbox .abc{display:flex;gap:8px;align-items:flex-start;margin-top:10px}
  .addbox .abc code{flex:1;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;user-select:all}
  .addbox .abh{font-size:12px;color:var(--mut);margin-top:6px}
  .addbox .abo{flex-direction:row;align-items:center;gap:6px;color:var(--fg);font-size:13px}
  .addbox .abo input{width:210px}
  .addbox .abchip{background:var(--chip);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:2px 9px;font-size:12px;cursor:pointer}
  .addbox .abchip.on{border-color:#d97706;color:#d97706}
  .tag.custom{color:#d97706}
  .tag{font-size:12px;font-weight:600;margin-left:6px;white-space:nowrap} .tag.shark{color:#0891b2} .tag.lds{color:#8b5cf6} .tag.assumed{opacity:.8;font-style:italic}
  .indpick{position:relative}
  .indpick>summary{list-style:none;cursor:pointer;user-select:none;white-space:nowrap;background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:9px 12px;font-size:13px}
  .indpick>summary::-webkit-details-marker{display:none}
  .indpick>summary:hover,.indpick[open]>summary,.indpick.on>summary{border-color:var(--accent)}
  .indpick .indbox{position:absolute;z-index:6;left:0;top:100%;margin-top:4px;width:300px;max-width:calc(100vw - 32px);max-height:380px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;box-shadow:0 10px 28px rgba(0,0,0,.28)}
  .indpick .indnote{font-size:11px;color:var(--mut);margin:0 4px 6px}
  .indpick .indbox label{display:flex;align-items:center;gap:8px;padding:4px;border-radius:6px;font-size:13px;cursor:pointer}
  .indpick .indbox label:hover{background:var(--chip)}
  .indpick .indbox .c{margin-left:auto;color:var(--mut);font-size:12px}
  .indpick .indbox button{padding:5px 10px;font-size:12px;margin-top:6px}
  .kcard .ind{white-space:nowrap}
  .indrun{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:0 0 12px;color:var(--mut);font-size:13px}
  .indrun[hidden]{display:none}
  .indrun code{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--fg);word-break:break-all;user-select:all}
  .indrun button{padding:6px 12px;font-size:12px}
  .pill{white-space:nowrap}
  .hv{font-size:12px;white-space:nowrap}
  .scroll{overflow-x:auto;border-radius:12px}
  #tbl th,#tbl td{padding:11px 10px}
  #tbl td:nth-child(3){max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #tbl td:nth-child(2),#ltbl td:nth-child(2),#wtbl td:nth-child(2),#htbl td:nth-child(2),#holdtbl td:nth-child(2){min-width:150px}
  .lnote{font-size:12px;color:var(--mut);margin-top:3px;max-width:520px}
  .runs{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}
  .run{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px}
  .run.pick{cursor:pointer} .run.pick:hover{border-color:var(--accent)}
  .run.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
  .run .when{color:var(--mut);min-width:64px;font-variant-numeric:tabular-nums}
  .run .what{font-weight:600} .run .meta2{color:var(--mut)}
  .pill.new{color:#fff;background:#0891b2;border-color:#0891b2}
  .pill.add{color:#fff;background:var(--accent);border-color:var(--accent)}
  .pill.fu{color:#8b5cf6;border-color:#8b5cf6}
  .pill.cad{color:#0891b2;border-color:#0891b2}
  .instr h2{font-size:16px;margin:24px 0 8px}
  .instr ol,.instr ul{margin:6px 0 10px;padding-left:22px}
  .instr li{margin:6px 0}
  .instr code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:1px 6px;word-break:break-word}
  .instr .alias{margin:0 0 12px;color:var(--mut);font-size:13px}
  .instr .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
  .instr .gcard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--bg)}
  .instr .gcard h3{margin:0 0 4px;font-size:15px}
  .instr .gcard p{margin:4px 0;color:var(--mut);font-size:13px}
  .instr .gcard dl{margin:6px 0 0;font-size:13px}
  .instr .gcard dt{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;margin-top:5px}
  .instr .gcard dd{margin:0;color:var(--mut)}
  .instr .ports{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
  .instr .ports th,.instr .ports td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);cursor:default}
  .instr .ports th{text-transform:none;letter-spacing:0;font-size:12px}
  .instr .ports tr:last-child td{border-bottom:none}
  .instr .gnote{color:var(--mut);font-size:12px;margin-top:10px}
  .eng{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--oth:#7a86a3}
  @media (prefers-color-scheme: light){ :root:not([data-theme="dark"]) .eng{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--oth:#8a94ab} }
  :root[data-theme="light"] .eng{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--oth:#8a94ab}
  .eng-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-top:6px}
  .eng-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 14px 10px;min-width:0}
  .eng-h{font-size:15px;margin:22px 0 6px;font-weight:600}
  .eng-card h3{font-size:13px;margin:0 0 2px;font-weight:600}
  .eng-card .eng-sub{color:var(--mut);font-size:12px;margin-bottom:8px}
  .eng-card svg{display:block;overflow:visible}
  .lg{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin:0 0 6px}
  .lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .eng-tiles{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
  .hb{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px}
  .hb .hl{flex:0 0 38%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
  .hb .ht{flex:1;min-width:0}
  .hb .hf{height:16px;border-radius:0 4px 4px 0;min-width:2px}
  .hb .hv{flex:0 0 auto;font-weight:600;min-width:22px}
  #engtip{position:fixed;z-index:60;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:240px}
  #engtip .tt-h{color:var(--mut);margin-bottom:4px}
  #engtip .tt-row{display:flex;align-items:center;gap:8px;margin:2px 0}
  #engtip .tt-row i{display:inline-block;width:12px;height:2px;border-radius:1px}
  #engtip .tt-row b{font-size:13px}
  #engtip .tt-row span{color:var(--mut)}
  .pill.cat{border-width:2px}
  .pill.cat-interested{border-color:var(--s3)} .pill.cat-gift{border-color:var(--s4)} .pill.cat-notint{border-color:var(--s5)} .pill.cat-other{border-color:var(--oth)}
  .rep-text{white-space:pre-wrap;max-width:520px}
  .eng-note{color:var(--mut);font-size:12px;margin:10px 0 0}
  .eng details{margin-top:12px} .eng summary{cursor:pointer;color:var(--mut);font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <h1>📇 Outreach Log</h1>
  <div class="sub">Durable record of everyone Pipeline Assistant has texted or emailed — with the exact message and when. Generated ${esc(generatedAt)}.</div>
  <div class="stats">
    <div class="stat"><b id="s-accounts">0</b><span>people contacted</span></div>
    <div class="stat" id="st-snap" hidden><b id="s-snap">0</b><span>📌 saved from the Shark list</span></div>
    <div class="stat" id="st-snapnew" hidden><b id="s-snapnew">0</b><span>… not contacted yet</span></div>
    <div class="stat"><b>${totalTexts}</b><span>📱 texts sent</span></div>
    <div class="stat"><b>${totalEmails}</b><span>✉️ emails sent</span></div>
    <div class="stat"><b id="s-emails">0</b><span>email on file</span></div>
  </div>
  <div class="tabs groups">
    <button class="tab on" data-group="leads" type="button" title="The accounts: everyone contacted, the lists, and the leads held back">Leads</button>
    <button class="tab" data-group="tools" type="button" title="Running the bot: follow-up board, send queue, daily harvest and the instructions">Tools</button>
    <button class="tab" data-group="analytics" type="button" title="How the outreach is landing: text and email engagement, replies and performance">Analytics</button>
  </div>
  <div class="tabs subtabs" data-group="leads">
    <button class="tab on" id="tab-shark" type="button">🦈 Shark (<span id="shark-n">0</span>)</button>
    <button class="tab" id="tab-tophit" type="button" title="Pros who answered with interest, and the accounts on your own hit list. They all stay on the follow-up board: only a not-interested reply takes a lead out of it">🎯 Top hit list (<span id="tophit-n">0</span>)</button>
    ${PIPELINE_ONLY ? '' : '<button class="tab" id="tab-lost" type="button">LDS (<span id="lost-n">0</span>)</button>'}
    <button class="tab" id="tab-cust" type="button">🤝 Current customers (<span id="cust-n">0</span>)</button>
    <button class="tab" id="tab-free" type="button" title="Enrolled, but every Closed Won opportunity is Invoicing and Payments (the free plan): not a customer, emailed like any lead">🆓 Invoicing &amp; Payments (<span id="free-n">0</span>)</button>
    <button class="tab" id="tab-coach" type="button" title="${_coachHeld ? 'Business coaching is a different department: these accounts are listed here, not as current customers, and are not contacted until you say otherwise' : 'Enrolled, but Closed Won only for business coaching (Foundation, Group, Solo, Solo Plus, Growth Workshop): not a customer, emailed like any lead'}">🎓 Business Coaching${_coachHeld ? '' : ' Leads'} (<span id="coach-n">0</span>)</button>
    <button class="tab" id="tab-team" type="button">🤝 Teammate texted (<span id="team-n">0</span>)</button>
    <button class="tab" id="tab-won" type="button">🏆 Closed Won (<span id="won-n">0</span>)</button>
    <button class="tab" id="tab-skip" type="button">🛑 Skipped (<span id="skip-n">0</span>)</button>
  </div>
  <div class="tabs subtabs" data-group="tools" hidden>
    <button class="tab" id="tab-board" type="button">🗂 Follow-up board</button>
    <button class="tab" id="tab-queue" type="button">⏳ Send queue (<span id="queue-n">0</span>)</button>
    <button class="tab" id="tab-harvest" type="button">🌾 Daily harvest</button>
    <button class="tab" id="tab-graph" type="button" title="The whole pipeline as a map: the lists, the scrub, the protections, the thirteen stages (✋ by hand, 🤖 by itself), the log and what happens to a reply">🔀 Graph</button>
    <button class="tab" id="tab-instr" type="button">📘 Instructions</button>
  </div>
  <div class="tabs subtabs" data-group="analytics" hidden>
    <button class="tab" id="tab-eng" type="button">📈 Text engagement</button>
    <button class="tab" id="tab-replies" type="button">💬 Text replies</button>
    <button class="tab" id="tab-email" type="button">✉️ Email</button>
    <button class="tab" id="tab-perf" type="button">📊 Performance</button>
  </div>
  <div id="pane-all">
  <div class="sub" id="viewnote" style="margin-bottom:10px" hidden></div>
  <div class="bar">
    <input id="q" type="search" placeholder="Search name, industry, email…" title="Searches the business name, industry, email address and the text of every message">
    <select id="indf" title="Industry: from the Salesforce account once it has been read (email --industry), else a guess from the business name"><option value="">All industries</option></select>
    <select id="grp" title="Group the table: by industry (from the Salesforce account once read, else a guess from the business name)"><option value="">No grouping</option><option value="ind">Group by industry</option></select>
    <select id="flt" title="Same-day touchpoint filter">
      <option value="">All accounts</option>
      <option value="missing">Missing a channel today</option>
      <option value="both">Both touched today</option>
      <option value="canText">Can text now (TCPA)</option>
      <option value="since3">⏳ 3+ days since touch (follow-up due)</option>
      <option value="fuNone">Follow-up: not started</option>
      <option value="cadNone">Email cadence: not started</option>
${CAD_STEPS.map((q, i) => `      <option value="cad${i + 1}">Email cadence: touch ${i + 1} sent${CAD_STEPS[i + 1] ? ', next is ' + (i + 2) : ' (last touch)'} — ${q}</option>`).join('\n')}
      <option value="gift">🎁 Asked for the gift card</option>
      <option value="interested">👍 Replied interested</option>
${FOLLOWUP_STEPS.map((q) => `      <option value="fu${q.step}">Follow-up: step ${q.step} sent${FOLLOWUP_STEPS.find((n) => n.step === q.step + 1) ? ', next is step ' + (q.step + 1) : ' (last step)'}</option>`).join('\n')}
      <option value="lds">On an LDS list</option>
      <option value="shark">On a Shark list</option>
      <option value="sharkscan">🦈 Shark — seen on a report scan or backup (not assumed)</option>
      <option value="manual">✋ Added by hand (any tag)</option>
      <option value="manualdue">✋ Added by hand — stage 2 due (3+ days since the last touch)</option>
${_customTags.map((t) => `      <option value="tag:${t}">✋ #${t} (your own tag)</option>`).join('\n')}
      <option value="nolist">No list known</option>
      <option value="snapnew">📌 Shark snapshot — not contacted yet</option>
      <option value="snapgone">🏃 Shark snapshot — off the report</option>
      <option value="noText">Never texted</option>
      <option value="noEmail">Never emailed</option>
      <option value="dupmsg">⚠ The same message was sent more than once</option>
      <option value="noZone">Time zone unknown</option>
    </select>
    <select id="addf" title="Show only the leads ADDED to the Shark list in a time window. A lead's added day is the first time the bot read it off a Shark report (or the day you added it by hand). A lead that was never read off a report (the original list) uses the day we first contacted it, shown with a ~."><option value="">📅 Added: any time</option></select>
    <span class="addrange" id="addrange" hidden><input type="date" id="addfrom" title="First day added (leave empty for no start)" aria-label="Added from"> to <input type="date" id="addto" title="Last day added (leave empty for no end)" aria-label="Added to"></span>
    <button id="notes-export" title="Download unsaved re-engage notes as JSONL to append to reengage-notes.jsonl">Export notes</button>
    <button class="right" id="csv">Export CSV</button>
  </div>
  <div class="addnote" id="addnote" hidden></div>
  <div class="scroll"><table id="tbl">
    <thead><tr>
      <th data-sort="name">Account</th>
      <th data-sort="ind" title="The Industry field from the Salesforce account (email --industry reads it). A ~ means a guess from the business name, until it has been read.">Industry</th>
      <th data-sort="email">Email</th>
      <th data-sort="added" title="When this lead was added to the Shark list: the first time the bot read it off a Shark report (or the day you added it by hand). A ~ means it was never read off a report (the original list), so the day we first contacted it stands in. The 📅 filter above uses this day. Click to sort.">Added</th>
      <th data-sort="harv" title="When the bot last read this account off a Shark or LDS report (a harvest). Click to sort by harvest time.">Harvested</th>
      <th data-sort="texts" title="Texts sent to this lead: how many, and when the last one went out">📱</th>
      <th data-sort="emails" title="Emails sent to this lead: how many, and when the last one went out">✉️</th>
      <th data-sort="last">Last contacted</th>
      <th data-sort="since" title="Days since we last texted or emailed (blank = never contacted)">Days since touch</th>
      <th data-sort="fu" title="Which step of the follow-up text sequence this pro has been sent (step 1 = the Follow-Up 1 text, which the board's Day 3 · Text 4 sends too; blank = none yet)">Follow-up</th>
      <th data-sort="cad" title="Which touch of the 6-step email cadence (--email --core) this pro has been sent (blank = none yet)">Email cadence</th>
      <th data-sort="gift" title="This pro texted back asking about the Amazon / gift card they were promised (read from the reply emails by optOut.js)">🎁 Gift card</th>
      <th data-sort="interested" title="This pro texted back something positive: yes, call me, send info, still considering (read from the reply emails by optOut.js)">👍 Interested</th>
      <th data-sort="today">Today</th>
      <th>Time zone</th>
      <th data-sort="stage">Re-engage at stage</th>
    </tr></thead>
    <tbody></tbody>
  </table></div>
  <div id="empty" class="empty" hidden>Nothing logged yet. Send some texts/emails, then reopen this page.</div>
  </div>
  <div id="pane-lost" hidden>
    <div class="sub" style="margin-bottom:10px">These are the accounts <code>email --auto</code> works through, one by one. Click a name to see its game plan and exactly what the bot read.</div>
    <div class="bar">
      <input id="lq" type="search" placeholder="Search LDS accounts or industry…">
      <select id="lflt"><option value="">All LDS</option><option value="proceed">Review OK</option><option value="skip">Review: skip</option><option value="touched">Already re-touched by us</option><option value="untouched">Not touched by us yet</option></select>
    </div>
    <div class="scroll"><table id="ltbl">
      <thead><tr><th>Account</th><th title="The Industry field from the Salesforce account; a ~ is a guess from the business name until it has been read">Industry</th><th>LDS opportunity</th><th>Original rep</th><th>Demo date</th><th>Opps</th><th>Review</th><th>📱</th><th>✉️</th><th>Last contacted</th><th title="Days since we last texted or emailed (blank = never contacted)">Days since touch</th><th>Re-engage at stage</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="lempty" class="empty" hidden>No LDS accounts yet. Run <code>email --harvest --deep</code> or <code>email --lds</code>; accounts whose opportunities include a Lost Demo stage (LDS) show up here.</div>
  </div>
  <div id="pane-team" hidden>
    <div class="sub" style="margin-bottom:10px">Accounts a <b>teammate texted in the last 48 hours</b> (the report's <b>Last Outgoing SMS DateTime</b>, later than our own last text). <code>email --board</code> no longer holds them: a teammate's text does not pause a lead (2026-11-04), so they stay in the cadence. <code>email --teammate-texted</code> sends them your own extra text. As fresh as the last Shark / LDS scan or <code>--shark</code> backup.</div>
    <div class="bar"><input id="tq" type="search" placeholder="Search account or list…"></div>
    <div class="scroll"><table id="ttbl">
      <thead><tr><th>Account</th><th>List</th><th>Teammate texted</th><th>Our last text</th><th></th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div class="sub" style="margin:16px 0 6px"><b>🧵 Held when the thread was read just before sending</b> (last 3 days) — a reply from the pro, or a teammate's text, seen in the Texts tab at send time. Nothing was sent to these accounts.</div>
    <div class="scroll"><table id="holdtbl">
      <thead><tr><th>Account</th><th>Why held</th><th>Read</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="holdempty" class="empty" hidden>No account has been held by a thread read in the last 3 days.</div>
    <div id="tempty" class="empty" hidden>No account has a teammate text from the last 48 hours in the saved scans.</div>
  </div>
  <div id="pane-cust" hidden>
    <div class="sub" style="margin-bottom:10px">Leads we meant to contact but <b>held back because they are real customers</b>: Salesforce's "Customer Status (beta)" starts with "Enrolled" (Current Customer, Cancel Requested, Under Review…) and the account has a Closed Won opportunity that is <b>not</b> Invoicing and Payments (✅). Nothing on this tab is texted or emailed. <b>The free Invoicing and Payments sign-ups are not on it:</b> "Enrolled" covers them too, so the email run (<code>email --email</code>) also reads the account's <b>Closed Won opportunities</b>, and when Invoicing and Payments is the only one the account is <b>not a customer</b>: it stays in the regular outreach cadence like any other lead. They are on <a href="#" id="cust-go-free">🆓 Invoicing &amp; Payments (<span id="cust-free-n">0</span>)</a>.${_coachHeld ? ' <b>Business coaching is a different department</b>, so those accounts are <b>not listed here as customers</b>: they are on <a href="#" id="cust-go-coach">🎓 Business Coaching (<span id="cust-coach-n">0</span>)</a> and are never contacted (until you say otherwise).' : ' Business coaching accounts are not customers either: <a href="#" id="cust-go-coach">🎓 Business Coaching Leads (<span id="cust-coach-n">0</span>)</a>.'} Accounts marked ⏳ were held before that check existed: the next <code>--email</code> run that reaches them looks again (<code>--dry-run</code> does it without sending anything), or look at all of them now with <code>node customerRecheck.js</code> (read-only: no composer, nothing sent; <code>--inspect</code> lists them first). Canceled, Terminated, an empty field or "-" are not customers and are emailed.</div>
    <div class="bar"><input id="cq" type="search" placeholder="Search account, industry, status or opportunity…">
      <select id="cflt" title="What the plan check found"><option value="">All</option><option value="customer">✅ Verified current customer</option><option value="noopp">🤝 Enrolled, no Closed Won opportunity</option><option value="unverified">⏳ Not re-checked yet</option></select></div>
    <div class="scroll"><table id="ctbl">
      <thead><tr><th>Account</th><th>Industry</th><th>Customer Status (beta)</th><th title="What the Closed Won opportunities say: Invoicing and Payments only = free plan">Plan check</th><th>Closed Won opportunities</th><th>Checked</th><th>Found by</th><th>📱</th><th>✉️</th><th>Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="cempty" class="empty" hidden>No account has been held back as a current customer yet. When an email run opens an account whose Customer Status (beta) starts with "Enrolled" and its Closed Won opportunities are not only Invoicing and Payments, it lands here and is not emailed.</div>
  </div>
  <div id="pane-free" hidden>
    <div class="sub" style="margin-bottom:10px">Accounts Salesforce calls "Enrolled" whose <b>only Closed Won opportunity is Invoicing and Payments</b> (the free plan). They are <b>not customers</b>: outreach treats them like any other lead (nothing holds them back from the follow-up texts, the follow-up board or the email cadence; <code>email --email --from-free-plan</code> just starts the email cadence with these accounts). They come from the plan check in <code>email --email</code> and <code>node customerRecheck.js</code> (read-only re-check of every account held as a current customer). An account with any other Closed Won opportunity stays on the 🤝 Current customers tab.</div>
    <div class="bar"><input id="fq" type="search" placeholder="Search account, industry or opportunity…"></div>
    <div class="scroll"><table id="ftbl">
      <thead><tr><th>Account</th><th>Industry</th><th>Customer Status (beta)</th><th>Closed Won opportunities</th><th>Checked</th><th>Found by</th><th>📱</th><th>✉️</th><th>Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="fempty" class="empty" hidden>No account is marked as Invoicing and Payments only yet. Run <code>node customerRecheck.js</code> (read-only) to check the accounts held as current customers; the free-plan ones land here.</div>
  </div>
  <div id="pane-coach" hidden>
    <div class="sub" style="margin-bottom:10px">${_coachHeld ? `<b>Business Coaching</b>: accounts with a Closed Won opportunity for one of our <b>business coaching products</b> (Foundation or Foundations, Group, Group Plus, Solo, Solo Plus, Growth Workshop; Salesforce product family Conquer; usually an upsell whose name starts with "UPS"). <b>Business coaching is a different department</b>, so these accounts are <b>not listed as current customers</b>, and <b>nothing is texted or emailed to them until you say otherwise</b> (<code>coaching-policy.json</code>). This page is for you to check them by hand. The list comes from the opportunities the plan check read in Salesforce (<code>email --email</code>, <code>node customerRecheck.js</code>), so tell Claude about a coaching account that is not listed.` : `<b>Business Coaching Leads</b>: accounts Salesforce calls "Enrolled" whose Closed Won opportunities are <b>only our business coaching products</b> (Foundation, Group, Solo, Solo Plus, Growth Workshop — usually an upsell whose name starts with "UPS"), alone or with Invoicing and Payments. They are <b>not customers for outreach</b>: emailed like any other lead. Found by the plan check in <code>email --email</code> and <code>customercheck</code>. Any other Closed Won opportunity keeps the account on ✅ Verified current customer.`}</div>
    <div class="bar"><input id="coq" type="search" placeholder="Search account, industry or opportunity…"></div>
    <div class="scroll"><table id="cotbl">
      <thead><tr><th>Account</th><th>Industry</th><th>Customer Status (beta)</th><th>Closed Won opportunities</th><th>Checked</th><th>Found by</th><th>📱</th><th>✉️</th><th>Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="coempty" class="empty" hidden>No account is marked as business coaching yet. The plan check (<code>email --email</code>, <code>node customerRecheck.js</code>) marks an account when a Closed Won opportunity it reads is a coaching product; it lands here${_coachHeld ? ', not listed as a customer and never contacted' : ' and is emailed like any lead'}.</div>
  </div>
  <div id="pane-won" hidden>
    <div class="sub" style="margin-bottom:10px">Accounts where a Salesforce review found a <b>Closed Won opportunity from the last 30 days</b> (any rep). They are <b>not texted</b>. The bot adds them as it checks accounts (<code>email --board</code> before each text, the 48h <code>--reengage</code>, <code>--auto</code>); the <b>opportunity owner</b> is the rep who closed it. A Closed Won that is only the free <b>Invoicing and Payments</b> sign-up does not count: that pro is not a customer, so the review reads the opportunity, ignores it and the account is not added here. A business coaching win does count (those accounts are kept out of outreach).</div>
    <div class="bar"><input id="wq" type="search" placeholder="Search account, industry, owner or opportunity…"></div>
    <div class="scroll"><table id="wtbl">
      <thead><tr><th>Account</th><th title="The Industry field from the Salesforce account; a ~ is a guess from the business name until it has been read">Industry</th><th>Opportunity owner</th><th>Closed-won opportunity</th><th>Close date</th><th>Closed</th><th>Found by the bot</th><th>📱</th><th>✉️</th><th title="Days since we last texted or emailed (blank = never contacted)">Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="wempty" class="empty" hidden>No closed-won accounts yet. When the bot checks an account in Salesforce and finds a Closed Won opportunity from the last 30 days, the account lands here with the opportunity owner, and is not texted.</div>
  </div>
  <div id="pane-board" hidden>
    <details id="addbox" class="addbox">
      <summary>➕ Add a lead I worked by hand: I did stage 1 myself, #tag its kind, track it for stage 2</summary>
      <div class="sub" style="margin:8px 0 0">For a lead you email, text and call yourself. Your stage 1 counts as ALL of Day 1 (text 1, text 2 and email 1): the bot leaves those alone (the once-a-day guards and the text queue see your touch) and the lead lands in the "Next: Day 2 · Text 3" column below, turning green the next day, in its own time zone.</div>
      <div class="sub" style="margin:6px 0 0"><b>#Tag the kind of lead it is.</b> <b>#shark</b> puts it on the 🦈 Shark tab${PIPELINE_ONLY ? '' : '; <b>#lds</b> on the LDS tab'}; a tag of your own (say <b>#referral</b>) is a label you can filter by. Whatever its tags, every lead on this board follows the same thirteen stages over 60 days, by itself, inside its own texting hours. Tick several if it is several kinds.</div>
      <div class="sub" style="margin:6px 0 0"><b>Texts and emails go out together</b> from one run: <code>email --board</code> (add <code>--inspect</code> to look first, no browser). Email 1 is Day 1, Email 2 is Day 3.</div>
      <div class="sub" style="margin:6px 0 0">This page cannot save anything by itself: fill it in, run the command it builds in Terminal, then refresh the page.</div>
      <div class="abg">
        <label>Salesforce account link or id (several: one per line)<textarea id="ab-ref" rows="2" placeholder="https://housecallpro.lightning.force.com/lightning/r/Account/001…/view"></textarea></label>
        <label>Business name (only if the dashboard doesn't know it yet)<input type="text" id="ab-name" placeholder="e.g. Smith Plumbing"></label>
        <label>When did you do stage 1?<select id="ab-on"><option value="">Just now</option><option value="yesterday">Yesterday</option><option value="date">Pick a day…</option></select><input type="date" id="ab-date" hidden></label>
        <label>Note (optional)<input type="text" id="ab-note" placeholder="e.g. left a voicemail, call back Thursday"></label>
      </div>
      <div class="abd"><b>Stage 1 by you:</b>
        <label><input type="checkbox" id="ab-email" checked> ✉️ emailed</label>
        <label><input type="checkbox" id="ab-text" checked> 📱 texted</label>
        <label><input type="checkbox" id="ab-call" checked> 📞 called</label></div>
      <div class="abd" style="margin-top:8px"><b>Kind of lead:</b>
        <label><input type="checkbox" id="ab-t-shark" checked> #shark</label>
        ${PIPELINE_ONLY ? '' : '<label><input type="checkbox" id="ab-t-lds"> #lds</label>'}
        <label class="abo">your own tags<input type="text" id="ab-tags" placeholder="#referral #trade-show"></label>
        <span id="ab-chips"></span></div>
      <div class="abh" id="ab-tagnote"></div>
      <div class="abh" id="ab-hint"></div>
      <div class="abc"><code id="ab-cmd">Paste the account's Salesforce link above</code><button type="button" id="ab-copy">Copy command</button></div>
    </details>
    <div class="sub" style="margin-bottom:10px">Everyone on a list (or #tagged by you): banned, closed-won and current customers are left out. <b>✋ Cards are leads you added by hand</b>; filter by tag with the list on the right, and by <b>🏭 industry</b> (one or more) with the picker next to it.</div>
    <div class="bar"><input id="bq" type="search" placeholder="Search account…"><select id="blist" title="Which leads: all of them, one list, the ones you added by hand, or one of your own #tags"><option value="">All leads</option><option value="Shark">#shark</option>${PIPELINE_ONLY ? '' : '<option value="LDS">#lds</option>'}<option value="@hand">✋ Added by hand</option>${_customTags.map((t) => `<option value="tag:${t}">#${t}</option>`).join('')}</select><details id="bind" class="indpick"><summary id="bind-sum" title="Pick one or more industries to see only those leads. The industry is the Salesforce Industry once email --industry has read it, else a guess from the business name (marked ~)">🏭 All industries</summary><div class="indbox"><div class="indnote" id="bind-note"></div><div id="bind-list"></div><button type="button" id="bind-clear">Show all industries</button></div></details><select id="bshow" title="Everyone, only the leads ready for their next stage, only the ones reached today (who we already texted or emailed), or the paused / held ones"><option value="">Everyone</option><option value="ready">⏰ Ready for their next stage</option><option value="today">✅ Reached today</option><option value="stuck">⏸ Paused or held</option></select></div>
    <div class="indrun" id="bind-run" hidden>🏭 Work only these industries: <code id="bind-cmd"></code><button type="button" id="bind-copy">Copy command</button><span>Run it in Terminal; add <code>--inspect</code> to look first (no browser, nothing sent).</span></div>
    <div class="sub">Every lead follows thirteen stages over 60 days, by itself, in its own time zone: <b>Day 1</b> text 1, text 2, email 1 (<b>✋ all by hand</b>: you do Day 1 yourself. Text 2 is your own 2 PM text and the board never sends it; text 1 and email 1 are only marked, and the board still sends them if you run them) · <b>Day 2</b> text 3 · <b>Day 3</b> text 4, email 2 · <b>Day 5</b> text 5 · <b>Day 9</b> email 3 · <b>Day 14</b> text 6 · <b>Day 21</b> email 4 · <b>Day 28</b> text 7 · <b>Day 42</b> email 5 · <b>Day 60</b> text 8. A lead sits in the column of the stage it is waiting for; green = ready. <b>✋</b> = a stage you do by hand, <b>🤖</b> = a stage the board does by itself. Read from our own log, not from the Shark report. Look: <code>email --board --inspect</code> · run: <code>email --board</code> · only some industries: tick them in the 🏭 picker and the page builds the command (<code>--trade</code>)</div>
    <div id="bsum" class="sub"></div>
    <div id="bboard" class="kb"></div>
  </div>
  <div id="pane-queue" hidden>
    ${queueHtml}
    <div class="bar"><input id="qq" type="search" placeholder="Search account or industry…"></div>
    <div class="scroll"><table id="qtbl">
      <thead><tr><th>#</th><th>Account</th><th>Industry</th><th>Next stage</th><th>Their time zone</th><th>Approx. send time</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="qempty" class="empty" hidden>Nothing is waiting in a send queue.</div>
  </div>
  <div id="pane-tophit" hidden>
    <div class="sub" style="margin-bottom:10px">🎯 Pros who <b>answered with interest</b> (a reply the reply reader flagged 👍) and the accounts on <b>your own hit list</b> (your <code>[Top hit list]</code> notes). <b>They all stay on the follow-up board</b>: only a "not interested" reply takes a lead out of the cadence, because a lot of pros answer "why?" and then go quiet. Add one by hand: <code style="user-select:all">node topHit.js --add &lt;account link&gt; --note "what happened"</code>.</div>
    <div class="bar"><input id="thq" type="search" placeholder="Search account, reply or note…">
      <select id="thflt" title="Why it is on the list"><option value="">Everyone on the list</option><option value="reply">👍 Replied interested</option><option value="note">📝 Your notes</option></select></div>
    <div class="scroll"><table id="thtbl">
      <thead><tr><th>Account</th><th>Why it is on the list</th><th>Next on the board</th><th>📱</th><th>✉️</th><th>Days since touch</th><th>Take it off</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="thempty" class="empty" hidden>Nobody is on the top hit list yet.</div>
  </div>
  <div id="pane-skip" hidden>
    <div class="sub" style="margin-bottom:10px">Every lead the bot <b>did not contact</b>, and why: the Salesforce review before a send (closed won in the last ${WON_FLAG_DAYS} days, except a free Invoicing and Payments sign-up; all opportunities closed out, do-not-contact notes, could not be read) the do-not-contact list, accounts at the text cap, and accounts held because someone replied or a teammate texted (last 30 days). Newest entry per account and reason.</div>
    ${dncBox('boxHtml')}
    <div class="bar"><input id="sq" type="search" placeholder="Search account, industry or reason…">
      <select id="sflt" title="Why it was skipped"><option value="">All reasons</option><option value="won">Closed won (${WON_FLAG_DAYS} days)</option><option value="closed">All opps closed out</option><option value="cust">Older closed won (past rule)</option><option value="dnc">Do-not-contact / banned</option><option value="cap">Text cap reached</option><option value="hold">Held by thread read (reply / teammate)</option><option value="unread">Could not be read</option><option value="other">Other</option></select></div>
    <div class="scroll"><table id="stbl">
      <thead><tr><th>Account</th><th>Industry</th><th>Why skipped</th><th>Reviewed</th><th>📱</th><th>✉️</th><th>Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="sempty" class="empty" hidden>No skipped leads yet.</div>
  </div>
  <div id="pane-harvest" hidden>
    <div class="sub" style="margin-bottom:10px">Only what the bot has <b>read from Salesforce</b>, one day at a time: report scans (Shark / LDS lists, including <code>email --harvest</code>), the Shark backups (<code>email --shark</code> and <code>email --shark13</code>: every Shark list is one Shark lead list), per-account reads (<code>email --harvest --deep</code>), industry reads and time zones. Pick a day, click a run to see just its accounts, click an account for the details. To see only the leads we added to the system that day, choose <b>➕ Added to the system</b> in the second list.</div>
    <div class="bar">
      <select id="hday" title="Harvest day"></select>
      <select id="htype" title="Kind of harvest">
        <option value="">All harvests</option>
        <option value="added">➕ Added to the system that day (first time we've seen the account)</option>
        <option value="shark">🦈 Shark list (scans + backups)</option>
        <option value="lds">🗂️ LDS list (scans + backups)</option>
        <option value="backup">📌 Shark backups (--shark)</option>
        <option value="read">📥 Account reads (--harvest --deep)</option>
        <option value="zones">🕐 Time zones</option>
        <option value="industry">🏭 Industry (--industry)</option>
        <option value="new">🆕 New accounts (first harvested that day)</option>
      </select>
      <input id="hq" type="search" placeholder="Search harvested accounts, industry or email…">
      <button id="hcsv" title="Download the accounts shown for this day and filter, with their emails">Export this day</button>
      <button id="hcsvall" title="Download every harvest on record, one line per account per run, with the day, so you can filter by date">Export all days</button>
    </div>
    <div id="hruns" class="runs"></div>
    <div id="hcount" class="muted" style="margin:0 0 8px"></div>
    <div class="scroll"><table id="htbl">
      <thead><tr><th>Account</th><th title="The Industry field from the Salesforce account; a ~ is a guess from the business name until it has been read">Industry</th><th title="The address in the report's Contact: Email column when that run scanned it, else the one on file">Email</th><th>Time zone</th><th>Last harvested</th><th>Harvested from</th><th>📱</th><th>✉️</th><th title="Days since we last texted or emailed (blank = never contacted)">Days since touch</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="hempty" class="empty" hidden>No harvest records yet. Run <code>email --shark</code> in the morning (it backs up the Shark list) or <code>email --harvest</code> (it scans the report you have open); every report the bot reads is logged here, by day.</div>
  </div>
  <div id="pane-eng" class="eng" hidden>
    <div class="sub" style="margin-bottom:10px">How the outreach is landing. Replies are read from the SMS-Magic emails (the opt-out poller saves each one); outreach counts come from the send log. Text replies only — email replies have their own ✉️ Email tab. Each reply is counted once: <b>not interested</b>, else <b>interested</b>, else <b>gift card request</b>, else <b>other</b>.</div>
    <div class="bar">
      <select id="erange" title="Date range for every number and chart below">
        <option value="0">Since replies were first tracked</option>
        <option value="7">Last 7 days</option>
        <option value="14">Last 14 days</option>
        <option value="30">Last 30 days</option>
      </select>
    </div>
    <div class="eng-tiles" id="etiles"></div>
    <div class="eng-grid">
      <div class="eng-card"><h3>Outreach sent per day</h3><div class="eng-sub">Texts and emails logged each day</div><div class="lg"><span><i style="background:var(--s1)"></i>Texts</span><span><i style="background:var(--s2)"></i>Emails</span></div><div id="ch-out"></div></div>
      <div class="eng-card"><h3>Replies per day</h3><div class="eng-sub">What pros texted back, by outcome (text replies only)</div><div class="lg"><span><i style="background:var(--s3)"></i>Interested</span><span><i style="background:var(--s4)"></i>Gift card request</span><span><i style="background:var(--s5)"></i>Not interested</span><span><i style="background:var(--oth)"></i>Other</span></div><div id="ch-rep"></div></div>
      <div class="eng-card"><h3>Replies per 100 texts</h3><div class="eng-sub">Replies that day ÷ texts sent that day (replies often land the next day)</div><div id="ch-rate"></div></div>
      <div class="eng-card"><h3>What replies say</h3><div class="eng-sub">Share of replies by outcome</div><div id="ch-mix"></div></div>
      <div class="eng-card"><h3>When pros reply</h3><div class="eng-sub">Replies by hour of day (your local time)</div><div id="ch-hour"></div></div>
      <div class="eng-card"><h3>Replies by industry</h3><div class="eng-sub">Top industries among replies we could match to an account</div><div id="ch-ind"></div></div>
    </div>
    <details><summary>Show the numbers as a table</summary><div class="scroll"><table id="etbl"><thead><tr><th>Day</th><th>Texts</th><th>Emails</th><th title="Every text and every email we sent counts 1: Texts + Emails">Touchpoints</th><th>Replies</th><th>Interested</th><th>Gift card</th><th>Not interested</th><th>Other</th></tr></thead><tbody></tbody></table></div></details>
    <div class="eng-note" id="enote"></div>
  </div>
${require('./perfAnalytics').PANE_HTML}  <div id="pane-email" class="eng" hidden>
    <div class="sub" style="margin-bottom:10px">How the outreach <b>email</b> is landing: emails sent, and the replies pros wrote back to "Re: Is Housecall Pro…" (saved by the poller from Gmail). Each reply is counted once: <b>not interested</b>, else <b>interested</b>, else <b>gift card request</b>, else <b>other</b>.</div>
    <div class="bar">
      <select id="mrange" title="Date range for every number and chart below">
        <option value="0">All time</option>
        <option value="7">Last 7 days</option>
        <option value="14">Last 14 days</option>
        <option value="30">Last 30 days</option>
      </select>
      <input id="mq" type="search" placeholder="Search business, reply or industry…">
    </div>
    <div class="eng-tiles" id="mtiles"></div>
    <div class="eng-grid">
      <div class="eng-card"><h3>Emails sent per day</h3><div class="eng-sub">Outreach emails logged each day</div><div id="ch-esent"></div></div>
      <div class="eng-card"><h3>Email replies per day</h3><div class="eng-sub">By outcome</div><div class="lg"><span><i style="background:var(--s3)"></i>Interested</span><span><i style="background:var(--s4)"></i>Gift card request</span><span><i style="background:var(--s5)"></i>Not interested</span><span><i style="background:var(--oth)"></i>Other</span></div><div id="ch-erep"></div></div>
      <div class="eng-card"><h3>Replies per 100 emails</h3><div class="eng-sub">Email replies that day ÷ emails sent that day (replies often land the next day)</div><div id="ch-erate"></div></div>
      <div class="eng-card"><h3>What email replies say</h3><div class="eng-sub">Share of email replies by outcome</div><div id="ch-emix"></div></div>
      <div class="eng-card"><h3>When pros reply</h3><div class="eng-sub">Email replies by hour of day (your local time)</div><div id="ch-ehour"></div></div>
      <div class="eng-card"><h3>Email replies by industry</h3><div class="eng-sub">Top industries among replies we could match to an account</div><div id="ch-eind"></div></div>
    </div>
    <h3 class="eng-h">Email replies</h3>
    <div id="mcount" class="muted" style="margin:0 0 8px"></div>
    <div class="scroll"><table id="mtbl">
      <thead><tr><th>Received</th><th>Business</th><th>Outcome</th><th>Reply</th><th>Industry</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="mempty" class="empty" hidden>No email replies in this range yet. They appear once the poller has read replies to the outreach email.</div>
  </div>
  <div id="pane-replies" class="eng" hidden>
    <div class="sub" style="margin-bottom:10px">Every reply a pro has texted back, newest first, with the business and when it arrived. Filter by what they said.</div>
    <div class="bar">
      <input id="rq" type="search" placeholder="Search business, reply or industry…">
      <select id="rflt" title="What the reply says">
        <option value="">All replies</option>
        <option value="interested">👍 Interested</option>
        <option value="notint">🚫 Not interested</option>
        <option value="gift">🎁 Gift card request</option>
        <option value="other">Other</option>
      </select>
      <select id="rrange" title="When it arrived"><option value="0">All time</option><option value="1">Today</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>
    </div>
    <div id="rcount" class="muted" style="margin:0 0 8px"></div>
    <div class="scroll"><table id="rtbl">
      <thead><tr><th>Received</th><th>Business</th><th>Outcome</th><th>Reply</th><th>Industry</th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div id="rempty" class="empty" hidden>No replies match. They appear here once the opt-out poller has read the SMS-Magic emails. Email replies are on the ✉️ Email tab.</div>
  </div>
  <div id="engtip" hidden></div>
  <div id="pane-graph" hidden>
    <div class="sub" style="margin-bottom:10px">🔀 The whole outreach pipeline as a map: the three lists, the scrub, the protections, the thirteen stages and what happens to a reply. <b>✋</b> = a stage you do by hand, <b>🤖</b> = a stage the board does by itself. Drag to move, scroll or pinch to zoom, click a node for details, and <b>Follow a lead</b> walks one lead through it. Its numbers refresh every morning (the 7:51 AM update writes them into this page's own database too); until a morning update has reached this page they are as of the last time the page was built (<span id="graphnote">just now</span>). The same map is also on <a href="https://claude.ai/artifact/2nSNG8MidvB11c4UAqtWEG" target="_blank" rel="noopener">its own page</a>.</div>
    <div id="graphbox"></div>
  </div>
  <div id="pane-instr" hidden>
${instrHtml}
  </div>
</div>
<script>
const ROWS = ${data};
const FUSTEPS = ${JSON.stringify(FOLLOWUP_STEPS.map((q) => ({ step: q.step, label: q.label })))};
const CADSTEPS = ${JSON.stringify(CAD_STEPS)};
const keyOf15 = (r)=>String(r.key||'').toLowerCase().slice(0,15);
const HBY = new Map(); ROWS.forEach(r=>{ const k=keyOf15(r); if(k) HBY.set(k,r); });     // key15 → the account's outreach row
const tbody = document.querySelector('#tbl tbody');
const q = document.getElementById('q');
const flt = document.getElementById('flt');
const grpSel = document.getElementById('grp'); const collapsedG = new Set();
const pad = (n)=>String(n).padStart(2,'0');
const dayOf = (d)=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const TODAY = dayOf(new Date());
const shortDay = (s)=>{ const [y,m,d]=s.split('-'); return (+m)+'/'+(+d); };
// Same-day coverage: 'both' | 'text' | 'email' | '' (nothing today)
function todayState(r){
  // Union of the local log and the Salesforce-report check (when it is for today).
  const d=(r.days||{})[TODAY]||{}; const x=(r.xref&&r.xref.date===TODAY)?r.xref:{};
  const t=!!(d.text||x.text), e=!!(d.email||x.email);
  return t&&e?'both':t?'text':e?'email':'';
}
// ---- DAYS SINCE OUR LAST TOUCH (a text or an email we sent): whole calendar days on the viewer's own clock. 0 = today, null = never contacted.
// A row here is an outreach row (ROWS); the LDS and Daily harvest tables pass the account's outreach row from HBY.
const dayNum = (day)=>{ const p = String(day).split('-'); return Math.round(Date.UTC(+p[0], +p[1]-1, +p[2]) / 864e5); };
function lastTouchDay(r){
  let d = r.last ? dayOf(new Date(r.last)) : null;
  if(r.xref && (r.xref.text||r.xref.email) && r.xref.date && (!d || r.xref.date>d)) d = r.xref.date;     // a send the Salesforce report check saw
  return d;
}
function sinceDays(r){ const d = lastTouchDay(r||{}); return d ? Math.max(0, dayNum(TODAY)-dayNum(d)) : null; }
function replyCell(x, label){
  if(!x) return '<span class="muted">—</span>';
  return '<span class="pill fu" title="'+escapeHtml('Replied '+fmt(x.at)+': '+(x.text||''))+'">'+label+' · '+escapeHtml(shortDay(dayOf(new Date(x.at))))+'</span>';
}
function cadCell(r){
  if(!r.cad) return '<span class="muted" title="Not through the email cadence yet">—</span>';
  const nm = CADSTEPS[r.cad.step-1] || '';
  return '<span class="pill cad" title="'+escapeHtml('Touch '+r.cad.step+(nm?' ('+nm+')':'')+' of '+CADSTEPS.length+' sent '+fmt(r.cad.at)+' · '+r.cad.count+' email(s) in all')+'">Touch '+r.cad.step+'/'+CADSTEPS.length+' · '+escapeHtml(shortDay(dayOf(new Date(r.cad.at))))+'</span>';
}
function fuCell(r){
  if(!r.fu) return '<span class="muted" title="Not through the follow-up text sequence yet">—</span>';
  const q = FUSTEPS.find(x=>x.step===r.fu.step);
  return '<span class="pill fu" title="'+escapeHtml((q?q.label:'Follow-up '+r.fu.step)+' sent '+fmt(r.fu.at))+'">Step '+r.fu.step+' · '+escapeHtml(shortDay(dayOf(new Date(r.fu.at))))+'</span>';
}
function sinceCell(r){
  r = r||{}; const n = sinceDays(r);
  if(n===null) return '<span class="muted" title="Never texted or emailed by us">—</span>';
  const lt = (r.touches||[])[0];      // newest first
  const tip = (lt && dayOf(new Date(lt.at))===lastTouchDay(r)) ? 'Last touch: '+(lt.ch==='email'?'emailed ':'texted ')+fmt(lt.at) : (r.xref&&r.xref.date===lastTouchDay(r) ? 'The Salesforce report check shows a send on '+r.xref.date : 'Last touch: '+fmt(r.last));
  return '<span title="'+escapeHtml(tip)+'">'+(n===0?'today':n===1?'1 day':n+' days')+'</span>';
}
// Re-engage notes: committed ones come from reengage-notes.jsonl; edits made here wait in
// localStorage until exported + appended (a static page can't write files).
const LS = 'assistant-reengage-pending';
let pending = {};
try { pending = JSON.parse(localStorage.getItem(LS)||'{}')||{}; } catch(_) {}
function savePending(){ try { localStorage.setItem(LS, JSON.stringify(pending)); } catch(_) {} }
const stageOf = (r)=> pending[r.key] ? pending[r.key].stage : (r.note ? r.note.stage : '');
let sortKey = 'last', sortDir = -1;
let VIEW = 'shark';        // the main table: 'shark' = only accounts tagged #shark (the Shark tab, where the page opens) · 'all' = every account (only the value while another tab is up: no tab shows it since All outreach was removed, the follow-up board covers it)
const fmt = (iso) => { if(!iso) return ''; const d=new Date(iso); return isNaN(d)?'':d.toLocaleString('en-US',{month:'numeric',day:'numeric',year:'2-digit',hour:'2-digit',minute:'2-digit'}); };
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
document.getElementById('s-accounts').textContent = ROWS.filter(r=>(r.texts||0)+(r.emails||0)>0 || (r.xref&&(r.xref.text||r.xref.email))).length;
{ const sn = ROWS.filter(r=>r.snapshot); if(sn.length){ document.getElementById('st-snap').hidden=false; document.getElementById('s-snap').textContent=sn.length; document.getElementById('st-snapnew').hidden=false; document.getElementById('s-snapnew').textContent=sn.filter(r=>!(r.texts||r.emails)&&!r.xref).length; } }
document.getElementById('s-emails').textContent = ROWS.filter(r=>r.email).length;

// Industry: the Industry field of the Salesforce account once email --industry has read it; until then a GUESS from the business name (industry.js),
// shown muted with a "~" (and a "?" when the guess comes from a generic word such as repair).
const indDay = (iso)=>{ try { return new Date(iso).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'2-digit'}); } catch(_){ return ''; } };
function indCell(r){
  const sfNote = (r)=> r.sfBlank===2 ? 'The Salesforce account page is not available (read '+indDay(r.indAt)+')' : 'Salesforce has no Industry on this account (read '+indDay(r.indAt)+')';
  if(!r || !r.ind) return '<span class="muted" title="'+escapeHtml((r && r.sfBlank ? sfNote(r) : 'Not read from Salesforce yet (email --industry)')+', and nothing in the business name says what they do')+'">—</span>';
  if(r.indSrc==='sf') return '<span title="'+escapeHtml('From the Industry field on the Salesforce account (read '+indDay(r.indAt)+')'+(r.indGuess?'. The business name alone would say: '+r.indGuess:''))+'">'+escapeHtml(r.ind)+'</span>';
  return '<span class="muted" title="'+escapeHtml('Guessed from the name: \\u201c'+(r.indWhy||'')+'\\u201d'+(r.indWeak?' (a generic word, less sure)':'')+(r.sfBlank?'. '+sfNote(r):'. Not read from Salesforce yet (email --industry)'))+'">~ '+escapeHtml(r.ind)+(r.indWeak?' ?':'')+'</span>';
}
const indf = document.getElementById('indf');
function fillIndustry(){            // the dropdown lists the industries in the current view (All or Shark) with their counts
  const keep = indf.value, c = {}; let unk = 0, nSf = 0, nGuess = 0;
  ROWS.filter(r=>VIEW!=='shark' || sharkTab(r)).forEach(r=>{ if(r.ind){ c[r.ind]=(c[r.ind]||0)+1; if(r.indSrc==='sf') nSf++; else nGuess++; } else unk++; });
  indf.innerHTML = '<option value="">All industries</option>'+Object.keys(c).sort((a,b)=>c[b]-c[a]||a.localeCompare(b)).map(k=>'<option value="'+escapeHtml(k)+'">'+escapeHtml(k)+' ('+c[k].toLocaleString()+')</option>').join('')
    +'<option value="__none">Unknown ('+unk.toLocaleString()+')</option><option value="__sf">Read from Salesforce ('+nSf.toLocaleString()+')</option><option value="__guess">Guessed from the name only ('+nGuess.toLocaleString()+')</option>';
  indf.value = keep; if(indf.value!==keep) indf.value = '';
}
function matches(r, term){
  if(!term) return true;
  if((r.name+' '+r.email+' '+tagText(r)+' '+(r.ind||'')).toLowerCase().includes(term)) return true;
  return (r.touches||[]).some(t => ((t.title||'')+' '+(t.body||'')).toLowerCase().includes(term));
}
// ---- TCPA time zones: mirrors tcpa.js (a known zone: ${tcpaWin.knownStart}:00–${tcpaWin.end}:00 in its own time, no Sundays) ----
const TCPA = ${tcpaJson};
const ZSHORT = {'America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Los_Angeles':'PT','America/Phoenix':'MST (AZ)','America/Anchorage':'AKT','Pacific/Honolulu':'HST'};
function localClockJS(tz){ const p = new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',minute:'numeric',hour12:false,weekday:'short'}).formatToParts(new Date()).reduce((o,x)=>{o[x.type]=x.value;return o;},{}); return {m:(parseInt(p.hour,10)%24)*60+parseInt(p.minute,10), wd:p.weekday}; }
// → true (open) | false (closed) | null (zone unknown)
function canTextNow(r){
  const zs = r.zones; if(!zs||!zs.length) return null;
  const start = TCPA.knownStart;
  return zs.every(z=>{ const c = localClockJS(z); if(c.wd==='Sun' && !TCPA.sunday) return false; return c.m>=start*60 && c.m<TCPA.end*60; });
}
// Which list the account came from, shown as #shark / #lds right after the account name, then the tags of his own it was added with (✋ leads) and the ✋ mark
function listTags(r){
  const L = r.lists||[];
  return L.map(l=>'<span class="tag '+(l.kind==='LDS'?'lds':'shark')+(l.assumed?' assumed':'')+'" title="'+escapeHtml((l.name||'')+' · '+(l.via||'')+(l.at?' · '+fmt(l.at):''))+'">#'+(l.kind==='LDS'?'lds':'shark')+'</span>').join('')+handTags(r).map(t=>'<span class="tag custom" title="A tag of your own">#'+escapeHtml(t)+'</span>').join('')+manualPill(r);
}
// ✋ the tags of his own a lead was added with (everything but #shark and #lds, which are the lists)
const handTags = (r)=>((r.manual&&r.manual.tags)||[]).filter(t=>t!=='shark'&&t!=='lds');
const tagText = (r)=>(r.lists||[]).map(l=>'#'+(l.kind==='LDS'?'lds':'shark')).concat(handTags(r).map(t=>'#'+t)).join(' ');
const isShark = (r)=>(r.lists||[]).some(l=>l.kind==='Shark');
const isSharkScan = (r)=>(r.lists||[]).some(l=>l.kind==='Shark'&&!l.assumed&&!l.manual);
// 🚫 The Shark tab leaves out leads on the do-not-contact list: the Skipped tab keeps them
const sharkTab = (r)=>isShark(r) && !r.banned;
// ✋ Added by hand (Tools > Follow-up board, or node textLog.js --add-lead): stage 1 was done by the rep and the lead is #tagged with its kind; the bot tracks it for stage 2 (3+ days after the last touch)
const HAND_WHAT = {email:'emailed', text:'texted', call:'called'};
const handWhat = (m)=>(m.did||[]).map(d=>HAND_WHAT[d]||d).join(' + ');
function handStage2(r){ const d = lastTouchDay(r); if(!d) return null; const x = new Date(d+'T12:00:00'); if(isNaN(x)) return null; x.setDate(x.getDate()+3); return x; }   // 3 days after the LAST touch, whoever made it
function manualPill(r){
  const m = r.manual; if(!m) return '';
  const s2 = handStage2(r), n = sinceDays(r);
  return ' <span class="pill hand" title="'+escapeHtml('Added by hand '+fmt(m.at)+' · '+(m.tags||[]).map(t=>'#'+t).join(' ')+'. Stage 1 done by you ('+handWhat(m)+') '+fmt(m.on)+(m.note?' · '+m.note:'')+(s2 ? ' · stage 2 '+(n!==null&&n>=3?'is due now':'starts '+fmtDay(dayOf(s2))) : ''))+'">✋ by hand</span>';
}
function manualBlock(r){
  const m = r.manual; if(!m) return '';
  const s2 = handStage2(r), n = sinceDays(r), due = n!==null && n>=3, tg = m.tags||[], own = handTags(r);
  const L = ['Tags: '+tg.map(t=>'#'+t).join(' '), 'Stage 1, done by you: '+handWhat(m)+' · '+fmt(m.on)];
  if(m.note) L.push('Note: '+m.note);
  L.push('Stage 2: 3 days after the last touch, whoever made it'+(s2 ? ' → '+(due ? 'due now' : 'from '+fmtDay(dayOf(s2))) : ''));
  if(tg.includes('shark')) L.push('#shark: the follow-up board texts it (email --board'+(due ? ' --inspect shows who is due' : '')+')');
  if(tg.includes('lds')) L.push('#lds: the follow-up board texts it too (email --board takes LDS leads)');
  if(own.length) L.push(own.map(t=>'#'+t).join(' ')+': your own tag, a label only (no text goes out for it)');
  { const nx = Math.min(6,((r.cad&&r.cad.step)||0)+1); L.push('Email, whatever the tags: touch '+nx+' of the cadence goes out with email --email --core --from-hand --step '+nx+(due ? ' (due now)' : '')); }
  L.push('Added '+fmt(m.at)+'. Change its tags: node textLog.js --tag-lead '+(r.key||'')+' --tag '+tg.join(',')+'   ·   Undo: node textLog.js --remove-lead '+(r.key||''));
  return '<div class="touch" style="border-color:#0e7490"><div class="meta">✋ Added by hand</div><div class="body">'+escapeHtml(L.join('\\n'))+'</div></div>';
}
// WHEN an account was harvested (r.hv, newest first, one entry per kind of list: { kind:'Shark'|'LDS', at, first, n, name }) and WHAT we sent it (r.touches, newest first; r.dup = the same message sent more than once).
const hvOf = (r)=>r.hv||[];
const harvAt = (r)=>{ const h = hvOf(r)[0]; return h ? new Date(h.at).getTime() : 0; };
function whenShort(iso){
  const d = new Date(iso); if(isNaN(d)) return '';
  const y = new Date(); y.setDate(y.getDate()-1);
  const day = dayOf(d);
  return (day===TODAY ? 'Today' : day===dayOf(y) ? 'Yesterday' : d.toLocaleDateString('en-US',{weekday:'short',month:'numeric',day:'numeric'}))+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}
const harvTip = (h)=>(h.name||h.kind)+' · harvested '+fmt(h.at)+(h.n>1 ? ' · '+h.n+' harvests, first '+fmt(h.first) : '');
function harvCell(r){
  const L = hvOf(r); if(!L.length) return '<span class="muted">—</span>';
  return L.slice(0,2).map(h=>'<div class="hv" title="'+escapeHtml(harvTip(h))+'">'+(h.kind==='LDS'?'🗂️':'🦈')+' '+escapeHtml(whenShort(h.at))+'</div>').join('');
}
// 📅 WHEN a lead was ADDED to the Shark list (the Added column and the 📅 filter). Real: the first time the bot read it off a Shark report (r.hv 'first') or the day it was added by hand, whichever came first.
// A lead that was never read off a report (the original list, or reached by a follow-up run before reports were tracked) has no recorded add day, so the day we FIRST CONTACTED it stands in, marked ~ (approx).
// → { t (ms), at (ISO), day (YYYY-MM-DD, the viewer's own calendar), approx, tip } | null (never read off a report and never contacted)
const _added = new Map();
function addedOf(r){
  if(_added.has(r)) return _added.get(r);
  const ms = (iso)=>{ const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
  const cand = [], h = hvOf(r).find(x=>x.kind==='Shark');
  if(h && ms(h.first)!==null) cand.push({ t:ms(h.first), at:h.first, approx:false, tip:'First read off '+(h.n>1 ? 'a Shark report' : (h.name||'a Shark report'))+' '+fmt(h.first)+(h.n>1 ? ' · '+h.n+' harvests in all' : '') });
  if(r.manual && ms(r.manual.at)!==null) cand.push({ t:ms(r.manual.at), at:r.manual.at, approx:false, tip:'Added by hand '+fmt(r.manual.at) });
  let a = cand.sort((x,y)=>x.t-y.t)[0] || null;
  if(!a){
    let f = null; (r.touches||[]).forEach(t=>{ const m = ms(t.at); if(m!==null && (!f || m<f.t)) f = { t:m, at:t.at }; });
    if(f) a = { t:f.t, at:f.at, approx:true, tip:'Approximate: this lead was never read off a Shark report on record (the original list), so the day we first contacted it stands in ('+fmt(f.at)+')' };
  }
  if(a) a.day = dayOf(new Date(a.at));
  _added.set(r, a); return a;
}
function addedCell(r){
  const a = addedOf(r);
  if(!a) return '<span class="muted" title="No add day on record: never read off a Shark report and never contacted">—</span>';
  if(a.approx) return '<div class="hv muted" title="'+escapeHtml(a.tip)+'">~ '+escapeHtml(new Date(a.at).toLocaleDateString('en-US',{weekday:'short',month:'numeric',day:'numeric'}))+'</div>';
  return '<div class="hv" title="'+escapeHtml(a.tip)+'">'+escapeHtml(whenShort(a.at))+'</div>';
}
// the 📅 filter: days are the viewer's own calendar days and "last 3 days" counts today as the first of them (Nov 2, 3 and 4 on Nov 4); "Last week" is the Monday-to-Sunday week before this one
const shiftDay = (day, n)=>{ const d = new Date(day+'T12:00:00'); d.setDate(d.getDate()+n); return dayOf(d); };
const dayLong = (day)=>new Date(day+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
const ADD_PRESETS = [['today','Added today'],['yesterday','Added yesterday'],['d3','Added in the last 3 days'],['d7','Added in the last 7 days'],['lastweek','Added last week (Mon–Sun)'],['d14','Added in the last 14 days'],['d30','Added in the last 30 days']];
const addf = document.getElementById('addf'), addrange = document.getElementById('addrange'), addfrom = document.getElementById('addfrom'), addto = document.getElementById('addto');
function addWindow(v){        // → { from, to, label } (YYYY-MM-DD, null = open ended) | null (any time)
  if(!v) return null;
  if(v==='range'){ const f = addfrom.value||null, t = addto.value||null; return (f||t) ? { from:f, to:t, label:'' } : null; }
  const mon = shiftDay(TODAY, -((new Date(TODAY+'T12:00:00').getDay()+6)%7));      // this week's Monday
  return v==='today' ? { from:TODAY, to:TODAY, label:'today' }
    : v==='yesterday' ? { from:shiftDay(TODAY,-1), to:shiftDay(TODAY,-1), label:'yesterday' }
    : v==='d3' ? { from:shiftDay(TODAY,-2), to:TODAY, label:'last 3 days' }
    : v==='d7' ? { from:shiftDay(TODAY,-6), to:TODAY, label:'last 7 days' }
    : v==='lastweek' ? { from:shiftDay(mon,-7), to:shiftDay(mon,-1), label:'last week, Monday to Sunday' }
    : v==='d14' ? { from:shiftDay(TODAY,-13), to:TODAY, label:'last 14 days' }
    : v==='d30' ? { from:shiftDay(TODAY,-29), to:TODAY, label:'last 30 days' } : null;
}
const addedIn = (r, w)=>{ if(!w) return true; const a = addedOf(r); return !!a && (!w.from || a.day>=w.from) && (!w.to || a.day<=w.to); };
function fillAdded(){          // the dropdown shows how many Shark-tab leads each window holds (like the industry list)
  const keep = addf.value, tab = ROWS.filter(sharkTab);
  addf.innerHTML = '<option value="">📅 Added: any time ('+tab.length.toLocaleString()+')</option>'
    + ADD_PRESETS.map(p=>{ const w = addWindow(p[0]); return '<option value="'+p[0]+'">📅 '+p[1]+' ('+tab.filter(r=>addedIn(r,w)).length.toLocaleString()+')</option>'; }).join('')
    + '<option value="range">📅 Added: pick dates…</option>';
  addf.value = keep; if(addf.value!==keep) addf.value = '';
  addrange.hidden = addf.value!=='range';
}
const lastTouch = (r, ch)=>(r.touches||[]).find(t=>(t.ch==='email')===(ch==='email'));
function sentCell(r, ch){
  const n = ch==='email' ? r.emails : r.texts; if(!n) return '<span class="muted">—</span>';
  const lt = lastTouch(r, ch);
  return '<span class="pill '+(ch==='email'?'e':'t')+'">'+n+'</span>'+(lt ? '<div class="hv muted" title="Last '+(ch==='email'?'emailed':'texted')+' '+escapeHtml(fmt(lt.at))+'">'+escapeHtml(whenShort(lt.at))+'</div>' : '');
}
const dupPill = (r)=>r.dup ? ' <span class="pill skip" title="'+escapeHtml('The same message went out more than once: '+r.dup.map(d=>(d.ch==='email'?'email':'text')+' "'+String(d.title||'').slice(0,40)+'" ×'+d.n+' ('+d.at.map(a=>fmt(a)).join(', ')+')').join('; '))+'">⚠ same message ×'+Math.max.apply(null, r.dup.map(d=>d.n))+'</span>' : '';
function sentBlock(r){
  const t = r.touches||[]; if(!t.length) return '';
  const by = {}; t.forEach(x=>{ const k = (x.ch==='email'?'✉️ ':'📱 ')+(x.title||''); (by[k]||(by[k]=[])).push(x); });
  const L = Object.keys(by).map(k=>k+' — '+by[k].length+'× · '+by[k].map(x=>fmt(x.at)).reverse().join(', '));
  return '<div class="touch" style="border-color:var(--accent)"><div class="meta">📊 Sent to this lead: '+(r.texts||0)+' text'+(r.texts===1?'':'s')+' · '+(r.emails||0)+' email'+(r.emails===1?'':'s')+(r.dup?'  ·  ⚠ the same message went out more than once':'')+'</div><div class="body">'+escapeHtml(L.join('\\n'))+'</div></div>';
}
document.getElementById('shark-n').textContent = ROWS.filter(sharkTab).length.toLocaleString();
function zlabel(z){
  if(ZSHORT[z]) return ZSHORT[z];
  try{ const n=new Intl.DateTimeFormat('en-US',{timeZone:z,timeZoneName:'long'}).format(new Date()); const m=n.match(/(Eastern|Central|Mountain|Pacific|Alaska|Hawaii)/); if(m) return {Eastern:'ET',Central:'CT',Mountain:'MT',Pacific:'PT',Alaska:'AKT',Hawaii:'HST'}[m[1]]; }catch(_){}
  return z;
}
function tzCell(r){
  if(r.banned) return '<span class="pill skip">🚫 banned</span>';
  const zs = r.zones;
  if(!zs||!zs.length) return '<span class="muted" title="Run: email --zones">unknown</span>';
  const label = (r.state?r.state+' · ':'')+zs.map(zlabel).join('/');
  const ok = canTextNow(r);
  return '<span class="pill '+(ok?'ok':'miss')+'" title="'+(ok?'Inside TCPA texting hours now':'Outside TCPA texting hours now')+(r.zoneSource?' · time zone from '+escapeHtml(r.zoneSource):'')+'">'+(ok?'🟢 ':'🔒 ')+escapeHtml(label)+'</span>';
}
function fmtDay(iso){ if(!iso) return ''; const d=new Date(iso+'T12:00:00'); return isNaN(d)?iso:d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function demoBlock(r){
  const o = r.originalDemo; if(!o || (!o.repName && !o.date)) return '';
  const L = [];
  L.push('Original Sales Rep on Demo:  '+(o.repName ? o.repName+'   ('+(o.repSource||'')+')' : 'not found'));
  L.push('Date of Original Demo:       '+(o.date ? fmtDay(o.date)+'   ('+(o.dateSource||'')+')' : 'not confirmed'+(o.oppCloseDate?'   (opportunity close date '+o.oppCloseDate+' is shown but not used as a demo date)':'')));
  if(o.dateEvidence) L.push('   evidence: '+o.dateEvidence);
  if((o.others||[]).length) L.push('Also named on the notes:    '+o.others.join(', '));
  const wy = Object.entries(o.why||{});
  if(o.oppStage) L.push('Opportunity:                '+o.oppStage+(o.oppCloseDate?'  ·  close date '+o.oppCloseDate:''));
  if(wy.length) L.push("Why it didn't close:        "+wy.map(([k,v])=>k.replace(/^Demo Objection/,'Objection')+': '+v).join('  ·  '));
  return '<div class="touch" style="border-color:var(--accent)"><div class="meta">🎯 Original demo</div><div class="body">'+escapeHtml(L.join('\\n'))+'</div></div>';
}
function readBlock(p){
  const rd = p.read; if(!rd) return '';
  const L = [];
  L.push('Original rep: '+(p.rep?p.rep.name+' (found via '+(rd.repSource||'?')+')':'none found')+'   ·   Demo: '+(p.demo?p.demo.month+' '+p.demo.year+' (via '+(rd.demoSource||'?')+')':'none confirmed'));
  L.push('');
  L.push('3 most recent opportunities (of '+(rd.oppCount||0)+'):');
  (rd.opps||[]).forEach(o=>L.push('  '+(o.closeDate||'no date')+'  ·  '+(o.stage||'')+'  ·  '+(o.name||'')+(o.owner?'  ·  owner '+o.owner:'')));
  const ofs = Object.entries(rd.oppFields||{});
  if(ofs.length){ L.push(''); L.push('Opportunity page fields'+(rd.oppOwner?' (owner '+rd.oppOwner+')':'')+':'); ofs.forEach(([k,v])=>L.push('  '+k+': '+v)); }
  L.push('');
  const ns = p.notes||[];
  L.push('The last '+(rd.notesOpened||ns.length)+' notes it opened and read ('+ns.length+' readable) — of '+(rd.notesTotal!=null?rd.notesTotal:'?')+' notes on the account:');
  if(ns.length) ns.forEach((n,i)=>L.push('  '+(i+1)+') '+(n.date||'undated')+(n.by?' ['+n.by+']':'')+'  '+(n.subject||'Untitled')+(n.how?'   (read via '+n.how+')':'')+'\\n'+(n.body||'').split('\\n').map(l=>'       '+l).join('\\n')));
  else { L.push('  none readable.'); (rd.noteDebug||[]).forEach(d=>L.push('  ↳ "'+d.title+'" '+(d.date||'')+': '+((d.tried||[]).join(' → ')||'—'))); }
  const nl = rd.notesList||[];
  if(nl.length){ L.push(''); L.push('Notes on the account (newest first):'); nl.forEach(n=>L.push('  '+(n.date||'undated')+'  ·  '+(n.title||'')+(n.by?'  ·  '+n.by:''))); }
  if(rd.safety) { L.push(''); L.push('Safety check: scanned '+(rd.safety.activityTitlesScanned?rd.safety.activityTitlesScanned+' activity titles + ':'')+rd.safety.notesListed+' note titles for Do-Not-Call.'); }
  return '<details open style="margin-top:8px"><summary class="muted" style="cursor:pointer">🔬 What the bot read from Salesforce (verify this)</summary><div class="body">'+escapeHtml(L.join('\\n'))+'</div></details>';
}
function planBlock(r){
  const p = r.plan; if(!p) return '';
  const st = {ready:'✅ ready',sent:'📨 sent','needs-review':'🟡 needs review',flagged:'🚩 flagged',skipped:'🛑 skipped',error:'❌ error'}[p.status] || p.status;
  const head = '<div class="meta">🤖 Game plan — '+st+' · '+fmt(p.at)+(p.rep?' · original rep '+escapeHtml(p.rep.name)+(p.demo?' ('+escapeHtml(p.demo.month+' '+p.demo.year)+')':''):'')+(p.confidence?' · confidence '+escapeHtml(p.confidence):'')+'</div>';
  const why = (p.reasons||[]).length ? '<div class="body">'+escapeHtml(p.reasons.join('\\n'))+'</div>' : '';
  const prob = (p.problems||[]).length ? '<div class="body" style="color:var(--email)">⚠️ '+escapeHtml(p.problems.join('\\n⚠️ '))+'</div>' : '';
  const dig = (p.digest||[]).length ? '<div class="title" style="margin-top:8px">🧠 What the notes say</div><div class="body">'+escapeHtml(p.digest.map(d=>'• '+(d.date||'undated')+(d.by?' ['+d.by+']':'')+': '+d.gist).join('\\n'))+'</div>' : '';
  let drafts = '';
  if(p.email||p.text){
    drafts = (p.email?'<div class="title">✉️ Email — '+escapeHtml(p.email.subject||'')+'</div><div class="body">'+escapeHtml(p.email.body||'')+'</div>':'')
      + (p.text?'<div class="title" style="margin-top:8px">📱 Text</div><div class="body">'+escapeHtml(p.text)+'</div>':'')
      + (p.callScript?'<div class="title" style="margin-top:8px">📞 Phone script</div><div class="body">'+escapeHtml(p.callScript)+'</div>':'')
      + (p.repNotes?'<div class="muted" style="margin-top:6px">📝 '+escapeHtml(p.repNotes)+'</div>':'')
      + ((p.evidenceUsed||[]).length?'<div class="muted" style="margin-top:6px">Based on: '+escapeHtml(p.evidenceUsed.join(' · '))+'</div>':'');
  }
  return '<div class="touch" style="border-color:var(--text)">'+head+why+prob+dig+readBlock(p)+drafts+'</div>';
}
function flagPill(r){
  if(r.customer && r.customer.coaching) return ' <span class="pill" title="'+escapeHtml('Customer Status (beta): '+(r.customer.status||'')+' — business coaching is a different department: not a current customer here, never texted or emailed (see the 🎓 Business Coaching tab)')+'">🎓 Business coaching · not contacted</span>';
  if(r.customer) return ' <span class="pill skip" title="'+escapeHtml('Customer Status (beta): '+(r.customer.status||'')+' — current customer, not emailed'+(r.customer.unverified?' (held before the free-plan check: the next email run that reaches it re-checks it)':''))+'">'+(r.customer.verified?'✅ Verified current customer':'🤝 customer')+' · '+escapeHtml(r.customer.status||'')+(r.customer.unverified?' ⏳':'')+'</span>';
  if(r.closedWon) return ' <span class="pill skip" title="'+escapeHtml('On the closed-won list: "'+(r.closedWon.opp||'')+'" closed '+(r.closedWon.closeDate||'?')+(r.closedWon.owner?' · opportunity owner '+r.closedWon.owner:'')+' — not texted')+'">🏆 closed won'+(r.closedWon.owner?' · '+escapeHtml(r.closedWon.owner):'')+'</span>';
  if(r.freePlan) return ' <span class="pill free" title="'+escapeHtml('Customer Status (beta): '+(r.freePlan.status||'')+' — but '+(r.freePlan.why||'its only Closed Won opportunity is Invoicing and Payments')+'. Not a customer: outreach as usual')+'">'+(r.freePlan.coaching?'🎓 Business Coaching Lead':'🆓 free plan')+'</span>';
  return (r.flags&&r.flags.includes('closed_won_30d')) ? ' <span class="pill skip" title="Closed Won within the last 30 days — another rep may have closed this account">🚩 closed-won ≤30d</span>' : '';
}
function sfBlock(r){
  return r.sf ? '<div class="touch" style="border-color:var(--accent)"><div class="meta">🗂️ Salesforce (read '+fmt(r.sf.at)+')'+(r.state?' · '+escapeHtml(r.state):'')+'</div>'
      + (r.sf.opps.length ? '<div class="title">Opportunities</div><div class="body">'+r.sf.opps.map(o=>escapeHtml((o.closeDate||'no date')+'  ·  '+(o.stage||'(no stage)')+'  ·  '+(o.name||''))).join('\\n')+'</div>' : '<div class="muted">No opportunities read.</div>')
      + (r.sf.notes.length ? '<div class="title" style="margin-top:6px">Recent activity / notes ('+r.sf.notes.length+(r.sf.notes.length>=15?'+':'')+')</div><div class="body">'+r.sf.notes.map(n=>escapeHtml((n.date||'undated')+'  ·  '+n.source+'  ·  '+n.text)).join('\\n')+'</div>' : '')
      + '</div>' : '<div class="touch" style="border-color:var(--line)"><div class="meta">🗂️ Salesforce</div><div class="muted">No Salesforce notes harvested for this account yet. Run <code>email --harvest --deep</code>.</div></div>';
}
function snapBlock(r){
  const s = r.snapshot;
  if(!s) return hvOf(r).length ? '<div class="touch" style="border-color:#0891b2"><div class="meta">🌾 Harvested</div><div class="body">'+escapeHtml(hvOf(r).map(h=>(h.kind==='LDS'?'LDS':'Shark')+' · '+fmt(h.at)+(h.n>1?' ('+h.n+' harvests, first '+fmt(h.first)+')':'')).join('  ·  '))+'</div></div>' : '';
  const L = [];
  L.push('Backed up from '+(s.list||'the Shark list')+' on '+fmt(s.at)+(s.snaps>1?'   ('+s.snaps+' snapshots, first '+fmt(s.firstAt)+')':''));
  if(hvOf(r).length) L.push('Harvested: '+hvOf(r).map(h=>(h.kind==='LDS'?'LDS':'Shark')+' '+fmt(h.at)+(h.n>1?' ('+h.n+' harvests, first '+fmt(h.first)+')':'')).join('  ·  '));
  const t = r.touches||[]; const lt = t.find(x=>x.ch!=='email'); const le = t.find(x=>x.ch==='email');
  L.push('Status: '+((r.texts||r.emails)?'contacted — '+(lt?'texted '+fmt(lt.at):'')+(lt&&le?'  ·  ':'')+(le?'emailed '+fmt(le.at):''):'not contacted yet'));
  if(s.onReport===true) L.push('Still on the report as of '+fmt(s.checkedAt));
  else if(s.onReport===false) L.push('🏃 No longer on the report as of '+fmt(s.checkedAt)+' — a rep probably got to it first'+((r.texts||r.emails)?'':'. You still have it here.'));
  else L.push('Not re-checked against the report since the snapshot (run email '+(/T13/.test(s.list||'') ? '--shark13' : '--shark')+' again to see who dropped off).');
  const cols = Object.entries(s.cols||{}); if(s.sms && !cols.some(([k])=>/outgoing sms/i.test(k))) cols.push(['Last Outgoing SMS', s.sms]);
  if(cols.length) L.push('Report row: '+cols.map(([k,v])=>k+': '+v).join('  ·  '));
  return '<div class="touch" style="border-color:#0891b2"><div class="meta">📌 Shark list snapshot</div><div class="body">'+escapeHtml(L.join('\\n'))+'</div></div>';
}
function todayBadge(r){
  if(r.snapshot && !(r.texts||r.emails) && !r.xref) return r.snapshot.onReport===false ? '<span class="pill snap" title="Backed up '+escapeHtml(fmt(r.snapshot.at))+' — no longer on the report">🏃 off report</span>' : '<span class="pill snap" title="Backed up '+escapeHtml(fmt(r.snapshot.at))+' — not contacted yet">📌 saved '+escapeHtml(shortDay(dayOf(new Date(r.snapshot.at))))+'</span>';
  const st = todayState(r);
  if(st==='both') return '<span class="pill both">✅ Both touched '+shortDay(TODAY)+'</span>';
  const parts = [];
  if(st) parts.push('<span class="pill miss">'+(st==='text'?'📱 text only — no email':'✉️ email only — no text')+'</span>');
  if(r.bothDay && r.bothDay!==TODAY) parts.push('<span class="pill both">✅ Both '+shortDay(r.bothDay)+'</span>');
  return parts.join(' ') || '<span class="muted">—</span>';
}
function render(){
  const term = q.value.trim().toLowerCase();
  const f = flt.value;
  const vn = document.getElementById('viewnote');
  if(VIEW==='shark'){
    const sh = ROWS.filter(sharkTab), hand = sh.filter(r=>r.manual&&!isSharkScan(r)).length, real = sh.filter(isSharkScan).length, fresh = sh.filter(r=>!(r.texts||r.emails)&&!r.xref).length;
    vn.hidden = false;
    vn.textContent = 'Only accounts tagged #shark: '+sh.length.toLocaleString()+'. '+real.toLocaleString()+' were seen on a Shark report scan or backup; '+(sh.length-real-hand).toLocaleString()+' are assumed (everything that was on the dashboard before list tracking). '+fresh.toLocaleString()+' not contacted yet.'+(()=>{
      const tx = sh.filter(r=>r.texts).length, em = sh.filter(r=>r.emails).length, tt = sh.reduce((a,r)=>a+(r.texts||0),0), te = sh.reduce((a,r)=>a+(r.emails||0),0), dp = sh.filter(r=>r.dup).length;
      let last = null; HARV.events.forEach(e=>{ if(e.kind==='Shark' && (e.t==='scan'||e.t==='backup') && (!last || e.at>last.at)) last = e; });
      return ' Sent so far: '+tt.toLocaleString()+' texts to '+tx.toLocaleString()+' leads · '+te.toLocaleString()+' emails to '+em.toLocaleString()+' leads'+(dp ? ' · ⚠ '+dp.toLocaleString()+' got the same message more than once' : '')+'.'+(last ? ' Last harvest: '+whenShort(last.at)+' ('+last.ids.length.toLocaleString()+' accounts, '+(last.name||'Shark list')+').' : '');
    })();
  } else vn.hidden = true;
  { if(VIEW==='shark'){ const nm = ROWS.filter(r=>r.manual&&sharkTab(r)).length, nd = ROWS.filter(r=>isShark(r)&&r.banned).length; if(nm) vn.textContent += ' ✋ '+nm.toLocaleString()+' added by hand and tagged #shark (stage 1 done by you, tracked for stage 2: Tools > Follow-up board adds more).'; if(nd) vn.textContent += ' 🚫 '+nd.toLocaleString()+' on the do-not-contact list '+(nd===1?'is':'are')+' left out of this tab (the Skipped tab keeps them).'; } }
  const indv = indf.value, aw = addWindow(addf.value);
  let rows = ROWS.filter(r => (VIEW!=='shark' || sharkTab(r)) && (!indv || (indv==='__none' ? !r.ind : indv==='__sf' ? r.indSrc==='sf' : indv==='__guess' ? r.indSrc==='guess' : r.ind===indv)) && matches(r, term) && addedIn(r, aw) && (!f || (f==='canText' ? canTextNow(r)===true && !r.banned : f==='since3' ? (sinceDays(r)!==null && sinceDays(r)>=3 && !r.banned && !r.closedWon) : f==='cadNone' ? !r.cad : /^cad[0-9]+$/.test(f) ? !!(r.cad && r.cad.step===parseInt(f.slice(3),10)) : f==='fuNone' ? !r.fu : f==='gift' ? !!r.gift : f==='interested' ? !!r.interested : /^fu[0-9]+$/.test(f) ? !!(r.fu && r.fu.step===parseInt(f.slice(2),10)) : f==='snapnew' ? (r.snapshot && !(r.texts||r.emails) && !r.xref) : f==='snapgone' ? (r.snapshot && r.snapshot.onReport===false) : f==='noText' ? !r.texts : f==='noEmail' ? !r.emails : f==='dupmsg' ? !!r.dup : f==='lds' ? (r.lists||[]).some(l=>l.kind==='LDS') : f==='shark' ? isShark(r) : f==='sharkscan' ? isSharkScan(r) : f==='manual' ? !!r.manual : f==='manualdue' ? (!!r.manual && sinceDays(r)!==null && sinceDays(r)>=3 && !r.banned && !r.closedWon) : f.slice(0,4)==='tag:' ? handTags(r).includes(f.slice(4)) : f==='nolist' ? !(r.lists||[]).length : f==='noZone' ? canTextNow(r)===null : f==='both' ? todayState(r)==='both' : (todayState(r)==='text'||todayState(r)==='email'))));
  rows.sort((a,b)=>{
    if(sortKey==='ind'){ if(!a.ind||!b.ind) return !a.ind&&!b.ind ? 0 : (a.ind ? -1 : 1); return a.ind.localeCompare(b.ind)*sortDir; }   // unknown always last
    if(sortKey==='gift'||sortKey==='interested'){ const ga=a[sortKey]?new Date(a[sortKey].at).getTime():0, gb=b[sortKey]?new Date(b[sortKey].at).getTime():0; return (ga-gb)*sortDir; }
    if(sortKey==='cad'){ const ca=a.cad?a.cad.step:0, cb=b.cad?b.cad.step:0; return (ca-cb)*sortDir; }
    if(sortKey==='fu'){ const fa=a.fu?a.fu.step:0, fb=b.fu?b.fu.step:0; return (fa-fb)*sortDir; }
    if(sortKey==='harv'){ const ha=harvAt(a), hb=harvAt(b); if(!ha||!hb) return !ha&&!hb ? 0 : (ha ? -1 : 1); return (ha-hb)*sortDir; }   // never harvested always last
    if(sortKey==='added'){ const da=addedOf(a), db=addedOf(b); if(!da||!db) return !da&&!db ? 0 : (da ? -1 : 1); return (da.t-db.t)*sortDir; }   // no add day always last
    if(sortKey==='since'){ const nx=sinceDays(a), ny=sinceDays(b); if(nx===null||ny===null) return nx===ny ? 0 : (nx===null ? 1 : -1); return (nx-ny)*sortDir; }   // never contacted always last
    let x=a[sortKey], y=b[sortKey];
    if(sortKey==='last'){ x=new Date(a.last||0); y=new Date(b.last||0); }
    if(sortKey==='texts'||sortKey==='emails'){ x=a[sortKey]; y=b[sortKey]; }
    if(sortKey==='today'){ x=todayState(a); y=todayState(b); }
    if(sortKey==='stage'){ x=stageOf(a); y=stageOf(b); }
    if(typeof x==='string'){ x=x.toLowerCase(); y=(y||'').toLowerCase(); }
    return (x<y?-1:x>y?1:0)*sortDir;
  });
  { const an = document.getElementById('addnote');       // the 📅 filter says which days it covers and how many leads that is (before and after the other filters)
    if(aw){
      const tabRows = ROWS.filter(sharkTab), inWin = tabRows.filter(r=>addedIn(r, aw)), nApprox = inWin.filter(r=>{ const a = addedOf(r); return a && a.approx; }).length;
      const span = aw.from && aw.to ? (aw.from===aw.to ? dayLong(aw.from) : dayLong(aw.from)+' – '+dayLong(aw.to)) : aw.from ? 'from '+dayLong(aw.from)+' on' : 'up to '+dayLong(aw.to);
      an.hidden = false;
      an.innerHTML = '📅 Added <b>'+escapeHtml(span)+'</b>'+(aw.label ? ' ('+escapeHtml(aw.label)+')' : '')+': <b>'+inWin.length.toLocaleString()+'</b> of '+tabRows.length.toLocaleString()+' leads on this tab'+(rows.length!==inWin.length ? ' · <b>'+rows.length.toLocaleString()+'</b> shown with your other filters' : '')+(nApprox ? ' · '+nApprox.toLocaleString()+' with an approximate day (~)' : '')+'.';
    } else an.hidden = true; }
  document.getElementById('empty').hidden = ROWS.length>0;
  tbody.innerHTML = '';
  const grouping = grpSel.value==='ind';
  let gnames = [];
  if(grouping){
    const gm = new Map();
    rows.forEach(r=>{ const k = r.ind || 'Unknown industry'; if(!gm.has(k)) gm.set(k, []); gm.get(k).push(r); });
    gnames = [...gm.keys()].sort((a,b)=> a==='Unknown industry' ? 1 : b==='Unknown industry' ? -1 : gm.get(b).length-gm.get(a).length || a.localeCompare(b));
    rows = gnames.flatMap(k=>gm.get(k));      // each group keeps the current sort inside it
    window.__gm = gm;
  }
  let curG = null;
  rows.forEach((r, idx)=>{
    const gk = grouping ? (r.ind || 'Unknown industry') : null;
    if(grouping && gk!==curG){
      curG = gk; const g = window.__gm.get(gk);
      const nT = g.filter(x=>x.texts>0).length, nE = g.filter(x=>x.emails>0).length, nI = g.filter(x=>x.interested).length, nG = g.filter(x=>x.gift).length, nB = g.filter(x=>x.banned).length;
      const gr = document.createElement('tr'); gr.className='grp';
      const open = !collapsedG.has(gk);
      gr.innerHTML = '<td colspan="16"><span class="caret">'+(open?'▾':'▸')+'</span> '+escapeHtml(gk)+' <span class="gs">'+g.length.toLocaleString()+' accounts · '+nT.toLocaleString()+' texted · '+nE.toLocaleString()+' emailed · '+nI.toLocaleString()+' 👍 interested · '+nG.toLocaleString()+' 🎁 gift card'+(nB?' · '+nB.toLocaleString()+' banned':'')+'</span></td>';
      gr.addEventListener('click', ()=>{ if(collapsedG.has(gk)) collapsedG.delete(gk); else collapsedG.add(gk); render(); });
      tbody.appendChild(gr);
    }
    const tr = document.createElement('tr');
    tr.className='acct'+(grouping && collapsedG.has(gk) ? ' gcol' : '');
    const name = '<span class="nm" title="Click to show / hide the Salesforce notes">'+escapeHtml(r.name)+'</span>'+(r.url?' <a class="sfl" href="'+r.url+'" target="_blank" rel="noopener" title="Open in Salesforce" onclick="event.stopPropagation()">↗</a>':'');
    const email = r.email ? '<a href="mailto:'+escapeHtml(r.email)+'" onclick="event.stopPropagation()">'+escapeHtml(r.email)+'</a>' : '<span class="muted">—</span>';
    tr.innerHTML = '<td><span class="caret">▸</span> '+name+(r.banned?' <span class="pill skip" title="On the banlist: never contacted">🚫 banned</span>':'')+flagPill(r)+listTags(r)+dupPill(r)+'</td>'
      + '<td>'+indCell(r)+'</td>'
      + '<td>'+email+'</td>'
      + '<td>'+addedCell(r)+'</td>'
      + '<td>'+harvCell(r)+'</td>'
      + '<td>'+sentCell(r,'text')+'</td>'
      + '<td>'+sentCell(r,'email')+'</td>'
      + '<td>'+fmt(r.last)+'</td>'
      + '<td>'+sinceCell(r)+'</td>'
      + '<td>'+fuCell(r)+'</td>'
      + '<td>'+cadCell(r)+'</td>'
      + '<td>'+replyCell(r.gift,'🎁 requested')+'</td>'
      + '<td>'+replyCell(r.interested,'👍 interested')+'</td>'
      + '<td>'+todayBadge(r)+'</td>'
      + '<td>'+tzCell(r)+'</td>'
      + '<td></td>';
    const inp = document.createElement('input');
    inp.className='stage'+(pending[r.key]?' unsaved':''); inp.placeholder='e.g. Stage 3'; inp.value=stageOf(r);
    inp.addEventListener('click',e=>e.stopPropagation());
    inp.addEventListener('change',()=>{ pending[r.key]={key:r.key,accountName:r.name,stage:inp.value.trim(),at:new Date().toISOString()}; savePending(); inp.classList.add('unsaved'); });
    tr.lastChild.appendChild(inp);
    const detail = document.createElement('tr');
    detail.className='timeline'+(grouping && collapsedG.has(gk) ? ' gcol' : ''); detail.hidden=true;
    const td = document.createElement('td'); td.colSpan=15;
    const sfHtml = manualBlock(r) + sentBlock(r) + snapBlock(r) + demoBlock(r) + planBlock(r) + sfBlock(r);
    td.innerHTML = sfHtml + (r.touches||[]).map(t =>
      '<div class="touch '+(t.ch==='email'?'e':'t')+'">'
      + '<div class="meta">'+(t.ch==='email'?'✉️ Email':'📱 Text')+' · '+fmt(t.at)+'</div>'
      + '<div class="title">'+escapeHtml(t.title||'')+'</div>'
      + (t.body?'<div class="body">'+escapeHtml(t.body)+'</div>':'')
      + '</div>').join('') || '<div class="muted">No message content recorded.</div>';
    detail.appendChild(td);
    tr.addEventListener('click', ()=>{ detail.hidden=!detail.hidden; tr.querySelector('.caret').textContent = detail.hidden?'▸':'▾'; });
    tbody.appendChild(tr); tbody.appendChild(detail);
  });
}
// ✋ The "Add a lead" box on the Follow-up board (Tools): it only builds the node textLog.js --add-lead command (a static page cannot write files).
const APPDIR = ${JSON.stringify(__dirname)}, OWN_TAGS = ${customTagsJson};
{
  const E = (id)=>document.getElementById(id);
  const DQ = String.fromCharCode(34), SQ = String.fromCharCode(39);
  const shq = (s)=>SQ+String(s).split(SQ).join(SQ+DQ+SQ+DQ+SQ)+SQ;
  const IDRE = /001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/g, TAGRE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
  const LISTTAG = (t)=>t==='shark'||t==='lds';
  function abIds(){ const seen = new Set(), out = []; (String(E('ab-ref').value).match(IDRE)||[]).forEach(x=>{ const k = x.toLowerCase().slice(0,15); if(!seen.has(k)){ seen.add(k); out.push(x); } }); return out; }
  // the tags: the list boxes (#shark${PIPELINE_ONLY ? '' : ', #lds'}) plus whatever is typed under "your own tags" → { tags, typed, bad }
  function abTags(){
    const typed = [], bad = [], tags = [];
    String(E('ab-tags').value).split(/[ ,;]+/).forEach(x=>{ const t = x.replace(/^#+/,'').toLowerCase(); if(!t) return; if(!TAGRE.test(t)) bad.push(x); else if(!typed.includes(t)) typed.push(t); });
    if(E('ab-t-shark') && E('ab-t-shark').checked) tags.push('shark');
    if(E('ab-t-lds') && E('ab-t-lds').checked) tags.push('lds');
    typed.forEach(t=>{ if(!tags.includes(t)) tags.push(t); });
    return { tags, typed, bad };
  }
  function abTagNote(tags){
    if(!tags.length) return '⚠️ Pick at least one tag: #shark${PIPELINE_ONLY ? '' : ', #lds'} or one of your own.';
    const own = tags.filter(t=>!LISTTAG(t)), L = [];
    if(tags.includes('shark')) L.push('#shark: on the 🦈 Shark tab; the follow-up board texts it on its stage days (email --board)');
    if(tags.includes('lds')) L.push('#lds: on the LDS tab; the follow-up board texts it too (email --board takes LDS leads)');
    if(own.length) L.push(own.map(t=>'#'+t).join(' ')+': '+(own.length===1?'a label':'labels')+' you can filter by; no text goes out for '+(own.length===1?'it':'them'));
    L.push('email, any tag: the next cadence touch goes out with email --email --core --from-hand');
    return L.join('  ·  ');
  }
  function abUpdate(){
    const ids = abIds(), did = ['email','text','call'].filter(d=>E('ab-'+d).checked), on = E('ab-on').value, T = abTags();
    E('ab-date').hidden = on!=='date';
    const nm = E('ab-name').value.trim(), note = E('ab-note').value.trim(), day = E('ab-date').value;
    const hint = [];
    ids.forEach(id=>{ const row = HBY.get(id.toLowerCase().slice(0,15)); hint.push(row ? (row.banned?'🚫 ':'✓ ')+row.name+': '+(row.banned?'on the do-not-contact list, so it will not be added':row.manual?'already added by hand ('+(row.manual.tags||[]).map(t=>'#'+t).join(' ')+'): adding it again counts a second stage 1':tagText(row)?'already on the dashboard as '+tagText(row):'on the dashboard, on no list yet')+' · '+(row.texts||0)+' text(s), '+(row.emails||0)+' email(s)'+(row.last?', last touch '+fmt(row.last):'') : '• '+id+': not on the dashboard yet'+(nm||ids.length>1?'':' (type the business name so it shows with a name)')); });
    if(!E('ab-ref').value.trim()) hint.push('Paste the account link from Salesforce (open the account, copy the address bar).');
    else if(!ids.length) hint.push('⚠️ No Salesforce account id found: an account link looks like …/lightning/r/Account/001…/view');
    if(!did.includes('email') && !did.includes('text')) hint.push('⚠️ Tick the email or the text: a call alone leaves no touch to count the 3 days from.');
    if(on==='date' && !day) hint.push('⚠️ Pick the day.');
    if(ids.length>1 && nm) hint.push('The name is only used when one lead is added at a time.');
    if(T.bad.length) hint.push('⚠️ Not usable as a tag (letters, numbers, - and _ only, up to 24 characters): '+T.bad.join(' '));
    if(T.tags.length>6) hint.push('⚠️ At most 6 tags per lead.');
    E('ab-tagnote').textContent = abTagNote(T.tags);
    E('ab-hint').textContent = hint.join('  ·  ');
    E('ab-chips').innerHTML = OWN_TAGS.map(t=>'<button type="button" class="abchip'+(T.typed.includes(t)?' on':'')+'" data-t="'+t+'" title="Add or remove #'+t+'">#'+t+'</button>').join(' ');
    let cmd = 'cd '+shq(APPDIR)+' && node textLog.js --add-lead '+ids.join(' ')+' --tag '+T.tags.join(',');
    if(did.length!==3) cmd += ' --did '+did.join(',');
    if(on==='yesterday') cmd += ' --on yesterday'; else if(on==='date' && day) cmd += ' --on '+day;
    if(nm && ids.length===1) cmd += ' --name '+shq(nm);
    if(note) cmd += ' --note '+shq(note);
    const ok = ids.length>0 && (did.includes('email')||did.includes('text')) && !(on==='date' && !day) && T.tags.length>0 && T.tags.length<=6 && !T.bad.length;
    E('ab-cmd').textContent = ok ? cmd : ids.length ? 'Fix the warning above to get the command' : 'Paste the account link above';
    E('ab-copy').dataset.cmd = ok ? cmd : '';
  }
  E('ab-chips').addEventListener('click', ev=>{ const b = ev.target.closest('.abchip'); if(!b) return; const t = b.dataset.t, cur = abTags().typed; E('ab-tags').value = (cur.includes(t) ? cur.filter(x=>x!==t) : cur.concat([t])).map(x=>'#'+x).join(' '); abUpdate(); });
  E('ab-copy').addEventListener('click', ()=>{
    const cmd = E('ab-copy').dataset.cmd; if(!cmd){ E('ab-hint').textContent = 'Fill in the account link and a tag first.'; return; }
    const done = ()=>{ const b = E('ab-copy'), t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(()=>{ b.textContent = t; }, 1800); };
    const fallback = ()=>{ const ta = document.createElement('textarea'); ta.value = cmd; document.body.appendChild(ta); ta.select(); let ok = false; try{ ok = document.execCommand('copy'); }catch(_){} ta.remove(); if(ok) done(); else E('ab-hint').textContent = 'Copy was blocked: select the command above and copy it by hand.'; };
    try{ navigator.clipboard.writeText(cmd).then(done, fallback); }catch(_){ fallback(); }
  });
  ['ab-ref','ab-name','ab-note','ab-date','ab-tags'].forEach(id=>E(id).addEventListener('input', abUpdate));
  ['ab-on','ab-email','ab-text','ab-call','ab-t-shark','ab-t-lds'].forEach(id=>{ const el=E(id); if(el) el.addEventListener('change', abUpdate); });
  abUpdate();
}
document.querySelectorAll('th[data-sort]').forEach(th=>{
  th.addEventListener('click',()=>{
    const k=th.dataset.sort;
    if(sortKey===k){ sortDir*=-1; } else { sortKey=k; sortDir = (k==='last'||k==='texts'||k==='emails'||k==='since'||k==='fu'||k==='cad'||k==='gift'||k==='interested'||k==='harv'||k==='added') ? -1 : 1; }
    document.querySelectorAll('th').forEach(t=>t.classList.remove('asc','desc'));
    th.classList.add(sortDir>0?'asc':'desc');
    render();
  });
});
q.addEventListener('input', render);
flt.addEventListener('change', render);
indf.addEventListener('change', render);
addf.addEventListener('change', ()=>{ addrange.hidden = addf.value!=='range'; render(); });
addfrom.addEventListener('change', render); addto.addEventListener('change', render);
grpSel.addEventListener('change', ()=>{ collapsedG.clear(); render(); });
document.getElementById('notes-export').addEventListener('click',()=>{
  const lines = Object.values(pending).map(n=>JSON.stringify(n));
  if(!lines.length){ alert('No unsaved re-engage notes.'); return; }
  const blob=new Blob([lines.join('\\n')+'\\n'],{type:'application/x-ndjson'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='reengage-notes-pending.jsonl'; a.click();
});
document.getElementById('csv').addEventListener('click',()=>{
  const hdr=['Account','Salesforce URL','Email','Channel','When','Title','Message'];
  const lines=[hdr.join(',')];
  ROWS.forEach(r=>(r.touches||[]).forEach(t=>{
    lines.push([r.name,r.url,r.email,t.ch,t.at,t.title,t.body].map(v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"').join(','));
  }));
  const blob=new Blob([lines.join('\\n')],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='outreach-log.csv'; a.click();
});
const LOST = ${lostJson};
const _lostN = document.getElementById('lost-n'); if (_lostN) _lostN.textContent = LOST.length;
const lq = document.getElementById('lq'), lflt = document.getElementById('lflt');
const lstage = (r)=> pending[r.key] ? pending[r.key].stage : (r.note ? r.note.stage : '');
function renderLost(){
  const term = lq.value.trim().toLowerCase(), f = lflt.value;
  const rows = LOST.filter(r => {
    if(term && !(r.name+' '+(r.ind||'')+' '+tagText(r)+' '+(r.notes||[]).join(' ')+' '+(r.lostDemos||[]).map(d=>d.name).join(' ')).toLowerCase().includes(term)) return false;
    if(f==='proceed'||f==='skip') return r.verdict===f;
    if(f==='touched') return (r.texts||0)+(r.emails||0)>0;
    if(f==='untouched') return (r.texts||0)+(r.emails||0)===0;
    return true;
  });
  document.getElementById('lempty').hidden = LOST.length>0;
  const body = document.querySelector('#ltbl tbody'); body.innerHTML='';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    const name = '<span class="caret">▸</span> <span class="nm" title="Click to show / hide the Salesforce notes">'+escapeHtml(r.name)+'</span> <a class="sfl" href="'+escapeHtml(r.url)+'" target="_blank" rel="noopener" title="Open in Salesforce" onclick="event.stopPropagation()">↗</a>';
    const lost = (r.lostDemos||[]).map(d=>escapeHtml(d.name||'')+(d.closeDate?' <span class="muted">('+escapeHtml(d.closeDate)+')</span>':'')).join('<br>');
    const why = (r.reasons||[]).concat(r.warnings||[]).join(' • ');
    const pill = r.verdict==='proceed' ? '<span class="pill ok">✅ OK</span>' : r.verdict==='skip' ? '<span class="pill skip">🛑 Skip</span>' : '<span class="pill unk">❓ '+escapeHtml(r.verdict||'unreviewed')+'</span>';
    tr.innerHTML = '<td>'+name+(r.banned?' <span class="pill skip" title="On the banlist: never contacted">🚫 banned</span>':'')+flagPill(r)+listTags(r)+(r.notes&&r.notes.length?'<div class="lnote">'+escapeHtml(r.notes.slice(0,2).join(' · '))+'</div>':'')+'</td>'
      + '<td>'+indCell(r)+'</td>'
      + '<td>'+lost+'</td>'
      + '<td>'+(r.originalDemo&&r.originalDemo.repName?escapeHtml(r.originalDemo.repName):'<span class="muted">—</span>')+'</td>'
      + '<td>'+(r.originalDemo&&r.originalDemo.date?escapeHtml(fmtDay(r.originalDemo.date))+'<div class="lnote">'+escapeHtml(r.originalDemo.dateSource||'')+'</div>':'<span class="muted">not confirmed</span>')+'</td>'
      + '<td>'+(r.opps||0)+'<div class="lnote">'+escapeHtml((r.stages||[]).join(', '))+'</div></td>'
      + '<td>'+pill+(why?'<div class="lnote">'+escapeHtml(why)+'</div>':'')+'</td>'
      + '<td>'+(r.texts?'<span class="pill t">'+r.texts+'</span>':'<span class="muted">—</span>')+'</td>'
      + '<td>'+(r.emails?'<span class="pill e">'+r.emails+'</span>':'<span class="muted">—</span>')+'</td>'
      + '<td>'+fmt(r.last)+'</td><td>'+sinceCell(HBY.get(keyOf15(r))||r)+'</td><td></td>';
    const inp = document.createElement('input');
    inp.className='stage'+(pending[r.key]?' unsaved':''); inp.placeholder='e.g. Stage 3'; inp.value=lstage(r);
    inp.addEventListener('change',()=>{ pending[r.key]={key:r.key,accountName:r.name,stage:inp.value.trim(),at:new Date().toISOString()}; savePending(); inp.classList.add('unsaved'); });
    tr.lastChild.appendChild(inp);
    inp.addEventListener('click',e=>e.stopPropagation());
    tr.className='acct';
    const det = document.createElement('tr'); det.className='timeline'; det.hidden=true;
    const dtd = document.createElement('td'); dtd.colSpan=12;
    dtd.innerHTML = demoBlock(r) + planBlock(r) + sfBlock(r) + ((r.reasons&&r.reasons.length)?'<div class="touch"><div class="meta">Review</div><div class="body">'+escapeHtml((r.reasons||[]).concat(r.warnings||[]).join('\\n'))+'</div></div>':'');
    det.appendChild(dtd);
    tr.addEventListener('click',()=>{ det.hidden=!det.hidden; const c=tr.querySelector('.caret'); if(c) c.textContent=det.hidden?'▸':'▾'; });
    body.appendChild(tr); body.appendChild(det);
  });
}
// ---------------------------------------------------------------------------------------------------------------------
// Daily harvest tab: only what the bot READ from Salesforce, one calendar day (the viewer's own) at a time.
const HARV = ${harvJson};
const HEV = HARV.events.map((e,i)=>Object.assign({i:i, day:dayOf(new Date(e.at))}, e));
const HKEY = (e)=>e.kind || e.t;
const HFIRST = {}, HBASE = {};
HEV.forEach(e=>{ const key = HKEY(e); if(!(key in HBASE) || e.day<HBASE[key]) HBASE[key] = e.day; const m = HFIRST[key] || (HFIRST[key] = {}); e.ids.forEach(k=>{ if(!m[k] || e.day<m[k]) m[k] = e.day; }); });
// "new" = the first time this account shows up in that kind of harvest, and an earlier day exists to compare with (the very first day has nothing to compare to)
const isNewOn = (k, day, e)=>{ const key = HKEY(e); return !!HFIRST[key] && HFIRST[key][k]===day && HBASE[key]<day; };
// "Added to the system" = the first day we know of an account: its first report scan / backup / deep read, or the first text or email we sent it, whichever is earlier
// (time zone and industry reads only fill in accounts we already had, so they don't count).
const HADDED = {};
const canAdd = (e)=>e.t==='scan'||e.t==='backup'||e.t==='read';
HEV.forEach(e=>{ if(canAdd(e)) e.ids.forEach(k=>{ if(!HADDED[k] || e.day<HADDED[k]) HADDED[k] = e.day; }); });
ROWS.forEach(r=>{ const k = keyOf15(r); if(k) (r.touches||[]).forEach(t=>{ const d = dayOf(new Date(t.at)); if(!HADDED[k] || d<HADDED[k]) HADDED[k] = d; }); });
const HDAYS = Array.from(new Set(HEV.map(e=>e.day))).sort().reverse();
const hday = document.getElementById('hday'), htype = document.getElementById('htype'), hq = document.getElementById('hq');
let hrun = null;     // a run picked in the list above the table (null = the whole day)
const timeOf = (iso)=>new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
function dayLabel(day){
  const d = new Date(day+'T12:00:00'), y = new Date(); y.setDate(y.getDate()-1);
  const base = isNaN(d) ? day : d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  return (day===TODAY ? 'Today · ' : day===dayOf(y) ? 'Yesterday · ' : '')+base;
}
function runTitle(e){
  if(e.t==='backup') return '📌 '+(e.kind==='LDS'?'LDS':'Shark')+' backup'+(e.name?' — '+e.name:'');
  if(e.t==='scan') return (e.kind==='LDS'?'🗂️':'🦈')+' Report scan'+(e.name?' — '+e.name:'');
  if(e.t==='read') return '📥 Account reads';
  if(e.t==='zones') return '🕐 Time zones read from the account pages';
  if(e.t==='industry') return '🏭 Industry read from the account pages';
  return "🕐 Time zones read off the report's Time Zone column";
}
const nz = (e)=>e.zids ? e.zids.length : 0;
function runCount(e, f){
  if(e.t==='zonecol') return e.n.toLocaleString()+' time zone'+(e.n===1?'':'s');
  if(e.t==='industry') return e.ids.length.toLocaleString()+' read · '+(e.withValue||0).toLocaleString()+' with an industry';
  if(e.t==='read') return e.ids.length.toLocaleString()+' read'+(e.failed?' · '+e.failed.toLocaleString()+' failed (not shown)':'');
  if(f==='zones' && nz(e)) return nz(e).toLocaleString()+' time zone'+(nz(e)===1?'':'s')+' saved off the report';
  return e.ids.length.toLocaleString()+' account'+(e.ids.length===1?'':'s')+(nz(e)?' · '+nz(e).toLocaleString()+' time zone'+(nz(e)===1?'':'s')+' saved':'');
}
// the accounts a run contributes under the current filter (for "Time zones": only those whose zone was saved)
const idsOf = (e, f)=>(f==='zones' && nz(e)) ? e.zids : e.ids;
function typeOk(e, f){
  if(f==='shark') return e.kind==='Shark' && (e.t==='scan'||e.t==='backup');
  if(f==='lds') return e.kind==='LDS' && (e.t==='scan'||e.t==='backup');
  if(f==='backup') return e.t==='backup';
  if(f==='read') return e.t==='read';
  if(f==='zones') return e.t==='zones'||e.t==='zonecol'||nz(e)>0;
  if(f==='industry') return e.t==='industry';
  if(f==='added') return canAdd(e);
  return true;
}
function harvestDetail(x, day){
  const firsts = x.es.map(e=>(HFIRST[HKEY(e)]||{})[x.k]).filter(Boolean).sort(), first = firsts[0];
  let h = '<div class="touch" style="border-color:var(--accent)"><div class="meta">🌾 Harvested '+escapeHtml(dayLabel(day))+(first&&first!==day ? ' · first harvested '+escapeHtml(fmtDay(first)) : ' · first time harvested')+'</div>'
    + '<div class="body">'+escapeHtml(x.es.map(e=>timeOf(e.at)+'  ·  '+runTitle(e)+'  ·  '+runCount(e)).join('\\n'))+'</div></div>';
  if(x.row) h += snapBlock(x.row) + demoBlock(x.row) + sfBlock(x.row);
  else h += '<div class="muted">Not contacted yet: no outreach history for this account.</div>';
  return h;
}
let HLAST = null;
function downloadCsv(name, lines){ const blob=new Blob([lines.join('\\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); }
const csvLine = (a)=>a.map(v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"').join(',');
document.getElementById('hcsv').addEventListener('click',()=>{
  if(!HLAST) return;
  const lines=[csvLine(['Day','Account','Email','Industry','Salesforce URL','Harvested from'])];
  HLAST.rows.forEach(r=>{ const x=r.x; lines.push(csvLine([HLAST.day, HLAST.nameOf(x), r.email, x.a[4]||'', x.row&&x.row.url ? x.row.url : HARV.origin+'/lightning/r/Account/'+x.a[1]+'/view', x.es.map(e=>runTitle(e)).join(' | ')])); });
  downloadCsv('harvest-'+HLAST.day+'.csv', lines);
});
document.getElementById('hcsvall').addEventListener('click',()=>{
  const lines=[csvLine(['Day','Time','Run','Account','Email','Industry','Salesforce URL'])];
  HEV.slice().sort((a,b)=>a.at<b.at?-1:1).forEach(e=>e.ids.forEach(k=>{ const a=HARV.accts[k]||[null,k]; const row=HBY.get(k); lines.push(csvLine([e.day, timeOf(e.at), runTitle(e), a[0]||(row&&row.name)||'', (e.emails&&e.emails[k])||(row&&row.email)||'', a[4]||'', row&&row.url ? row.url : HARV.origin+'/lightning/r/Account/'+a[1]+'/view'])); }));
  downloadCsv('harvest-all-days.csv', lines);
});
function renderHarvest(){
  document.getElementById('hempty').hidden = HDAYS.length>0;
  if(!hday.options.length) HDAYS.forEach(d=>{
    const evs = HEV.filter(e=>e.day===d), ids = new Set(); evs.forEach(e=>e.ids.forEach(k=>ids.add(k)));
    const runs = evs.filter(e=>e.t!=='zonecol').length, addIds = new Set(); evs.filter(canAdd).forEach(e=>e.ids.forEach(k=>addIds.add(k)));
    const added = Array.from(addIds).filter(k=>HADDED[k]===d).length;
    const o = document.createElement('option'); o.value = d;
    o.textContent = dayLabel(d)+'  —  '+ids.size.toLocaleString()+' account'+(ids.size===1?'':'s')+(added ? ' · '+added.toLocaleString()+' added' : '')+' · '+runs+' run'+(runs===1?'':'s');
    hday.appendChild(o);
  });
  const day = hday.value || HDAYS[0] || '', f = htype.value, term = hq.value.trim().toLowerCase();
  const evs = HEV.filter(e=>e.day===day && typeOk(e,f));
  if(hrun!==null && !evs.some(e=>e.i===hrun)) hrun = null;
  const runsEl = document.getElementById('hruns'); runsEl.innerHTML = '';
  evs.forEach(e=>{
    const eid = idsOf(e,f);
    const d = document.createElement('div'); d.className = 'run'+(eid.length?' pick':'')+(hrun===e.i?' on':'');
    const nw = f==='added' ? (k=>HADDED[k]===day) : (k=>isNewOn(k,day,e));
    d.innerHTML = '<span class="when">'+timeOf(e.at)+'</span><span class="what">'+escapeHtml(runTitle(e))+'</span><span class="meta2">'+escapeHtml(runCount(e,f)+(eid.some(nw) ? ' · '+eid.filter(nw).length.toLocaleString()+(f==='added' ? ' added' : ' new') : ''))+'</span>';
    if(eid.length){ d.title = 'Click to show only this run'; d.addEventListener('click',()=>{ hrun = hrun===e.i ? null : e.i; renderHarvest(); }); }
    runsEl.appendChild(d);
  });
  const per = new Map();
  evs.forEach(e=>{ if(hrun!==null && e.i!==hrun) return; idsOf(e,f).forEach(k=>{ if(!per.has(k)) per.set(k,[]); per.get(k).push(e); }); });
  let list = Array.from(per.entries()).map(en=>({k:en[0], es:en[1], a:HARV.accts[en[0]]||[null,en[0],[],0], row:HBY.get(en[0])||null}));
  if(f==='new') list = list.filter(x=>x.es.some(e=>isNewOn(x.k,day,e)));
  if(f==='added') list = list.filter(x=>HADDED[x.k]===day);
  const nameOf = (x)=>x.a[0] || (x.row&&x.row.name) || '(unnamed)';
  const emailOf = (x)=>{ for(const e of x.es){ if(e.emails && e.emails[x.k]) return e.emails[x.k]; } return (x.row&&x.row.email)||''; };
  if(term) list = list.filter(x=>(nameOf(x)+' '+(x.a[4]||'')+' '+emailOf(x)).toLowerCase().includes(term));
  list.sort((x,y)=>{ const a=x.es[x.es.length-1].at, b=y.es[y.es.length-1].at; return a<b?1:a>b?-1:nameOf(x).localeCompare(nameOf(y)); });
  document.getElementById('hcount').textContent = HDAYS.length ? list.length.toLocaleString()+' account'+(list.length===1?'':'s')+(f==='added' ? ' added to the system ' : ' harvested ')+(day===TODAY?'today':'on '+dayLabel(day).replace('Yesterday · ',''))+(hrun!==null?' (one run)':'') : '';
  HLAST = { day:day, rows:list.map(x=>({ x:x, email:emailOf(x) })), nameOf:nameOf };
  const body = document.querySelector('#htbl tbody'); body.innerHTML = '';
  list.forEach(x=>{
    const url = x.row && x.row.url ? x.row.url : HARV.origin+'/lightning/r/Account/'+x.a[1]+'/view';
    const kinds = {}; x.es.forEach(e=>{ if(e.kind) kinds[e.kind]=1; });
    const tags = Object.keys(kinds).map(k=>'<span class="tag '+(k==='LDS'?'lds':'shark')+'">#'+(k==='LDS'?'lds':'shark')+'</span>').join('');
    const tr = document.createElement('tr'); tr.className = 'acct';
    tr.innerHTML = '<td><span class="caret">▸</span> <span class="nm" title="Click to show / hide the harvest details">'+escapeHtml(nameOf(x))+'</span> <a class="sfl" href="'+escapeHtml(url)+'" target="_blank" rel="noopener" title="Open in Salesforce" onclick="event.stopPropagation()">↗</a>'
      + (x.a[3]||(x.row&&x.row.banned) ? ' <span class="pill skip" title="On the banlist: never contacted">🚫 banned</span>' : '') + tags
      + (HADDED[x.k]===day ? ' <span class="pill add" title="Added to the system this day: the first time we saw this account in a report, a read or a message we sent">➕ added</span>' : '')
      + (x.es.some(e=>isNewOn(x.k,day,e)) ? ' <span class="pill new" title="First time this account shows up in this kind of harvest">🆕 new</span>' : '') + '</td>'
      + '<td>'+indCell({ind:x.a[4], indWhy:x.a[5], indWeak:x.a[6], indSrc:x.a[7], indAt:x.a[8], sfBlank:x.a[9], indGuess:x.a[10]})+'</td>'
      + '<td>'+(emailOf(x)?'<a href="mailto:'+escapeHtml(emailOf(x))+'" onclick="event.stopPropagation()">'+escapeHtml(emailOf(x))+'</a>':'<span class="muted">—</span>')+'</td>'
      + '<td>'+tzCell(x.row || {zones:x.a[2], banned:!!x.a[3]})+'</td>'
      + '<td>'+timeOf(x.es[x.es.length-1].at)+'</td>'
      + '<td>'+x.es.map(e=>'<div>'+escapeHtml(runTitle(e))+' <span class="muted">· '+timeOf(e.at)+'</span></div>').join('')+'</td>'
      + '<td>'+(x.row&&x.row.texts?'<span class="pill t">'+x.row.texts+'</span>':'<span class="muted">—</span>')+'</td>'
      + '<td>'+(x.row&&x.row.emails?'<span class="pill e">'+x.row.emails+'</span>':'<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(x.row)+'</td>';
    tr.addEventListener('click',()=>{
      let det = tr.nextElementSibling; if(det && !det.classList.contains('timeline')) det = null;
      if(!det){ det = document.createElement('tr'); det.className = 'timeline'; const td = document.createElement('td'); td.colSpan = 9; td.innerHTML = harvestDetail(x, day); det.appendChild(td); tr.after(det); tr.querySelector('.caret').textContent = '▾'; return; }
      det.hidden = !det.hidden; tr.querySelector('.caret').textContent = det.hidden ? '▸' : '▾';
    });
    body.appendChild(tr);
  });
}
hday.addEventListener('change',()=>{ hrun=null; renderHarvest(); });
htype.addEventListener('change',()=>{ hrun=null; renderHarvest(); });
hq.addEventListener('input', renderHarvest);

// ---------------------------------------------------------------------------------------------------------------------
// 🤝 Teammate texted tab: accounts a teammate texted in the last 48h — held by --followup.
const TEAM = ${tmJson};
const HOLDS = ${holdJson};
document.getElementById('team-n').textContent = TEAM.length + HOLDS.length;
if (TEAM.length || HOLDS.length) document.getElementById('tab-team').style.fontWeight = '700';
const tq = document.getElementById('tq');
function agoText(iso){ const h = (Date.now()-Date.parse(iso))/3600000; return isNaN(h) ? '' : h < 1 ? 'under an hour ago' : h < 48 ? Math.round(h)+'h ago' : Math.round(h/24)+' days ago'; }
function renderTeam(){
  const term = tq.value.trim().toLowerCase();
  const rows = TEAM.filter(t=>!term || (t.name+' '+(t.listName||'')).toLowerCase().includes(term));
  document.getElementById('tempty').hidden = TEAM.length>0;
  const body = document.querySelector('#ttbl tbody'); body.innerHTML = '';
  rows.forEach(t=>{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(t.name)+'</span> <a class="sfl" href="'+escapeHtml(t.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a></td>'
      + '<td>'+escapeHtml((t.kind||'')+(t.listName ? ' · '+t.listName : ''))+'</td>'
      + '<td><b>'+escapeHtml(t.sms||'')+'</b> <span class="muted">('+agoText(t.smsAt)+')</span></td>'
      + '<td>'+(t.ourAt ? escapeHtml(new Date(t.ourAt).toLocaleString())+' <span class="muted">('+agoText(t.ourAt)+')</span>' : '<span class="muted">never texted by us</span>')+'</td>'
      + '<td>'+(t.banned ? '🚫 banned' : '')+'</td>';
    body.appendChild(tr);
  });
}
function renderHolds(){
  document.getElementById('holdempty').hidden = HOLDS.length>0;
  const body = document.querySelector('#holdtbl tbody'); body.innerHTML = '';
  HOLDS.forEach(h=>{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(h.accountName||'(unnamed)')+'</span>'+(h.accountUrl ? ' <a class="sfl" href="'+escapeHtml(h.accountUrl)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>' : '')+'</td>'
      + '<td>'+escapeHtml(h.reason||'')+'</td><td class="muted">'+escapeHtml(new Date(h.at).toLocaleString())+'</td>';
    body.appendChild(tr);
  });
}
tq.addEventListener('input', renderTeam);

// ---------------------------------------------------------------------------------------------------------------------
// 🏆 Closed Won tab: accounts the bot found with a Closed Won opportunity from the last 30 days, with the opportunity owner.
const CUST = ${custJson};
const COACH_HELD = ${JSON.stringify(_coachHeld)};      // business coaching is a different department (Luke, 2026-10-29): kept out of outreach (coaching-policy.json) and listed only on its own tab, NOT as a current customer
const cq = document.getElementById('cq'), cflt = document.getElementById('cflt');
// What the plan check found: free = only Closed Won is Invoicing and Payments (released) · customer = a Closed Won that is not · noopp = Enrolled with no Closed Won opportunity at all · unverified = held before the check (or could not be read)
function custState(c){ if(c.verdict==='free-plan') return 'free'; if(c.verdict==='coaching') return 'coach'; if(c.verdict==='customer') return (c.closedWon&&c.closedWon.length)?'customer':'noopp'; return 'unverified'; }
const CUST_PILL = {customer:'<span class="pill skip" title="A Closed Won opportunity that is not Invoicing and Payments was found on the account: a real customer, never emailed">✅ Verified current customer</span>', noopp:'<span class="pill skip" title="Enrolled, but the account has no Closed Won opportunity, so nothing shows it is on the free plan">🤝 no Closed Won opp</span>', free:'<span class="pill free">🆓 free plan</span>', coach: COACH_HELD ? '<span class="pill" title="Business coaching is a different department: not a current customer here, and never texted or emailed (coaching-policy.json). Check it by hand">🎓 Business coaching · not contacted</span>' : '<span class="pill free" title="Closed Won only for business coaching (Foundation, Group, Solo, Solo Plus, Growth Workshop) and/or Invoicing and Payments: still ours to sell">🎓 Business Coaching Lead</span>', unverified:'<span class="pill unk" title="Held before the free-plan check existed, or its opportunities could not be read: the next email run that reaches it looks again">⏳ not re-checked</span>'};
const custCount = {customer:0,noopp:0,free:0,coach:0,unverified:0}; CUST.forEach(c=>{ custCount[custState(c)]++; });
const COACH_TAG = '<span class="pill" title="One of the Closed Won opportunities read is a business coaching product: check it by hand">🎓 business coaching</span>';
// this tab lists only the accounts held back as customers. Business coaching is a different department (Luke, 2026-10-29): while it is held (coaching-policy.json) those accounts are NOT listed here, only on their own tab. An Invoicing and Payments account is not a customer either: it has its own tab and every outreach path treats it like any other lead
const heldState = (s) => s==='customer' || s==='noopp' || s==='unverified';
const CUSTHELD = CUST.filter(c=>heldState(custState(c)) && !(COACH_HELD && c.coach));
const heldCount = {customer:0,noopp:0,unverified:0}; CUSTHELD.forEach(c=>{ heldCount[custState(c)]++; });
const custHeld = CUSTHELD.length;
document.getElementById('cust-n').textContent = custHeld;
const COACHALL = CUST.filter(c=>c.coach);      // every account marked as business coaching: coaching only, or a customer whose read opportunities include a coaching product
[['', 'All ('+custHeld+')'],['customer','✅ Verified current customer ('+heldCount.customer+')'],['noopp','🤝 Enrolled, no Closed Won opportunity ('+heldCount.noopp+')'],['unverified','⏳ Not re-checked yet ('+heldCount.unverified+')']].forEach((o,i)=>{ cflt.options[i].textContent = o[1]; });
document.getElementById('cust-free-n').textContent = custCount.free; document.getElementById('cust-coach-n').textContent = COACHALL.length;
document.getElementById('cust-go-free').addEventListener('click',e=>{ e.preventDefault(); showTab('free'); });
document.getElementById('cust-go-coach').addEventListener('click',e=>{ e.preventDefault(); showTab('coach'); });
function custSrc(c){ const s = c.source; return s && typeof s==='object' ? (s.name||s.kind||'') : (s||''); }   // the report the account came from ({ name, kind, id }) or a plain label
function custEvidence(c){
  const origin = String(c.url||'').split('/lightning/')[0];
  const parts = (c.closedWon||[]).map(e=>'<div title="'+escapeHtml((e.fields||[]).join(' | '))+'">'+(e.coaching?'🎓':e.ip?'🆓':'🤝')+' <b>'+escapeHtml(e.name||'(unnamed)')+'</b> <span class="muted">'+escapeHtml([e.owner,e.closeDate].filter(Boolean).join(' · '))+'</span> '+(e.coaching?'<span class="pill'+(COACH_HELD?'':' free')+'">Business coaching</span>':e.ip?'<span class="pill free">Invoicing and Payments</span>':'<span class="pill skip">'+(COACH_HELD?'not Invoicing and Payments':'not Invoicing and Payments / coaching')+'</span>')+(e.id&&origin?' <a class="sfl" href="'+escapeHtml(origin+'/lightning/r/Opportunity/'+e.id+'/view')+'" target="_blank" rel="noopener" title="Open the opportunity in Salesforce">↗</a>':'')+(e.via?'<div class="muted">found as '+escapeHtml(e.via)+'</div>':'')+'</div>');
  if(c.why && !(c.closedWon||[]).length) parts.push('<div class="muted">'+escapeHtml(c.why)+'</div>');   // (with opportunities listed above, the reason is already on screen)
  if(c.subs||c.legacy) parts.push('<div class="muted">Active subscription(s): '+escapeHtml(c.subs||'—')+' · Core SaaS (legacy): '+escapeHtml(c.legacy||'—')+'</div>');
  return parts.length ? parts.join('') : '<span class="muted">not checked yet</span>';
}
function renderCust(){
  const term = cq.value.trim().toLowerCase(), f = cflt.value;
  const rows = CUSTHELD.filter(c=>{ const st = custState(c); return (!f || st===f) && (!term || (c.name+' '+(c.ind||'')+' '+(c.status||'')+' '+(c.why||'')+' '+(c.closedWon||[]).map(e=>(e.name||'')+' '+(e.owner||'')).join(' ')).toLowerCase().includes(term)); });
  rows.sort((a,b)=>a.at<b.at?1:-1);
  document.getElementById('cempty').hidden = CUSTHELD.length>0;
  const body = document.querySelector('#ctbl tbody'); body.innerHTML = '';
  rows.forEach(c=>{
    const rr = HBY.get(String(c.id||'').toLowerCase().slice(0,15)) || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(c.name)+'</span> <a class="sfl" href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>'+listTags(rr)+'</td>'
      + '<td>'+indCell(c)+'</td>'
      + '<td><span class="pill skip">'+escapeHtml(c.status||'')+'</span></td>'
      + '<td>'+CUST_PILL[custState(c)]+(c.coach ? ' '+COACH_TAG : '')+'</td>'
      + '<td>'+custEvidence(c)+'</td>'
      + '<td>'+fmt(c.at)+'</td>'
      + '<td>'+(custSrc(c) ? escapeHtml(custSrc(c)) : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>';
    body.appendChild(tr);
  });
}
cq.addEventListener('input', renderCust); cflt.addEventListener('change', renderCust);

// 🆓 Invoicing & Payments tab: Enrolled accounts whose only Closed Won opportunity is Invoicing and Payments (released, emailed like any lead).
const FREE = CUST.filter(c=>custState(c)==='free');
document.getElementById('free-n').textContent = FREE.length;
const fq = document.getElementById('fq');
function renderFree(){
  const term = fq.value.trim().toLowerCase();
  const rows = FREE.filter(c=>!term || (c.name+' '+(c.ind||'')+' '+(c.status||'')+' '+(c.closedWon||[]).map(e=>(e.name||'')+' '+(e.owner||'')).join(' ')).toLowerCase().includes(term));
  rows.sort((a,b)=>a.at<b.at?1:-1);
  document.getElementById('fempty').hidden = FREE.length>0;
  const body = document.querySelector('#ftbl tbody'); body.innerHTML = '';
  rows.forEach(c=>{
    const rr = HBY.get(String(c.id||'').toLowerCase().slice(0,15)) || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(c.name)+'</span> <a class="sfl" href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>'+listTags(rr)+' <span class="pill free">🆓 Invoicing and Payments</span></td>'
      + '<td>'+indCell(c)+'</td>'
      + '<td><span class="pill ok">'+escapeHtml(c.status||'')+'</span></td>'
      + '<td>'+custEvidence(c)+'</td>'
      + '<td>'+fmt(c.at)+'</td>'
      + '<td>'+(custSrc(c) ? escapeHtml(custSrc(c)) : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>';
    body.appendChild(tr);
  });
}
fq.addEventListener('input', renderFree);

// 🎓 Business Coaching tab: every account with a business coaching opportunity: a different department (Luke, 2026-10-29), listed here and not as a current customer, not contacted while coaching-policy.json says held
const COACH = COACHALL;
document.getElementById('coach-n').textContent = COACH.length;
const coq = document.getElementById('coq');
function renderCoach(){
  const term = coq.value.trim().toLowerCase();
  const rows = COACH.filter(c=>!term || (c.name+' '+(c.ind||'')+' '+(c.status||'')+' '+(c.closedWon||[]).map(e=>(e.name||'')+' '+(e.owner||'')).join(' ')).toLowerCase().includes(term));
  rows.sort((a,b)=>a.at<b.at?1:-1);
  document.getElementById('coempty').hidden = COACH.length>0;
  const body = document.querySelector('#cotbl tbody'); body.innerHTML = '';
  rows.forEach(c=>{
    const rr = HBY.get(String(c.id||'').toLowerCase().slice(0,15)) || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(c.name)+'</span> <a class="sfl" href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>'+listTags(rr)+' '+((COACH_HELD || custState(c)==='coach') ? CUST_PILL.coach : CUST_PILL[custState(c)]+' '+COACH_TAG)+'</td>'
      + '<td>'+indCell(c)+'</td>'
      + '<td><span class="pill'+(COACH_HELD?'':' ok')+'">'+escapeHtml(c.status||'')+'</span></td>'
      + '<td>'+custEvidence(c)+'</td>'
      + '<td>'+fmt(c.at)+'</td>'
      + '<td>'+(custSrc(c) ? escapeHtml(custSrc(c)) : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>';
    body.appendChild(tr);
  });
}
coq.addEventListener('input', renderCoach);

const WON = ${wonJson};
document.getElementById('won-n').textContent = WON.length;
const wq = document.getElementById('wq');
function renderWon(){
  const term = wq.value.trim().toLowerCase();
  const rows = WON.filter(w=>!term || (w.name+' '+(w.ind||'')+' '+(w.owner||'')+' '+(w.opp||'')).toLowerCase().includes(term));
  rows.sort((a,b)=>(Date.parse(b.closeDate)||0)-(Date.parse(a.closeDate)||0) || (a.at<b.at?1:-1));
  document.getElementById('wempty').hidden = WON.length>0;
  const body = document.querySelector('#wtbl tbody'); body.innerHTML = '';
  rows.forEach(w=>{
    const rr = HBY.get(String(w.id||'').toLowerCase().slice(0,15)) || {};
    const closed = Date.parse(w.closeDate);
    const ago = isNaN(closed) ? null : Math.max(0, dayNum(TODAY)-dayNum(dayOf(new Date(closed))));
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(w.name)+'</span> <a class="sfl" href="'+escapeHtml(w.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>'+listTags(rr)+'</td>'
      + '<td>'+indCell(w)+'</td>'
      + '<td>'+(w.owner ? '<b>'+escapeHtml(w.owner)+'</b>' : '<span class="muted" title="The opportunity list had no owner column and the opportunity page showed none">owner not found</span>')+'</td>'
      + '<td>'+escapeHtml(w.opp||'')+'</td>'
      + '<td>'+escapeHtml(w.closeDate||'—')+'</td>'
      + '<td>'+(ago===null ? '<span class="muted">—</span>' : ago===0 ? 'today' : ago===1 ? '1 day ago' : ago+' days ago')+'</td>'
      + '<td>'+fmt(w.at)+(w.source ? '<div class="lnote">'+escapeHtml(w.source)+'</div>' : '')+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>';
    body.appendChild(tr);
  });
}
wq.addEventListener('input', renderWon);

// ---- 💬 Replies + 📈 Engagement (replies.jsonl from the opt-out poller; outreach per day from the send log)
const REPLIES = ${repliesJson};
const PERF = ${perfJson};
const OUTD = ${outDailyJson};
const outcomeOf = (r)=> r.optout ? 'notint' : r.interested ? 'interested' : r.gift ? 'gift' : 'other';
const OUT_LABEL = {interested:'Interested', gift:'Gift card request', notint:'Not interested', other:'Other'};
const OUT_COLOR = {interested:'var(--s3)', gift:'var(--s4)', notint:'var(--s5)', other:'var(--oth)'};
const OUT_ORDER = ['interested','gift','notint','other'];
const flagsOf = (r)=>{ const f=[]; if(r.interested) f.push('interested'); if(r.optout) f.push('notint'); if(r.gift) f.push('gift'); if(!f.length) f.push('other'); return f; };
const CAT_ICON = {interested:'👍 Interested', notint:'🚫 Not interested', gift:'🎁 Gift card request', other:'Other'};
function sinceMs(n){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-(n-1)); return d.getTime(); }
const rq = document.getElementById('rq'), rflt = document.getElementById('rflt'), rrange = document.getElementById('rrange');
function renderReplies(){
  const f = rflt.value, term = rq.value.trim().toLowerCase(), n = parseInt(rrange.value,10)||0;
  const list = REPLIES.filter(r=>r.ch!=='email' && (!n || new Date(r.at).getTime()>=sinceMs(n)) && (!f || flagsOf(r).indexOf(f)>=0) && (!term || (r.name+' '+r.reply+' '+(r.ind||'')).toLowerCase().indexOf(term)>=0));
  document.getElementById('rcount').textContent = list.length.toLocaleString()+' repl'+(list.length===1?'y':'ies');
  document.getElementById('rempty').hidden = list.length>0;
  const body = document.querySelector('#rtbl tbody'); body.innerHTML = '';
  list.forEach(r=>{
    const tr = document.createElement('tr');
    const name = '<span class="nm">'+escapeHtml(r.name)+'</span>'+(r.url?' <a class="sfl" href="'+escapeHtml(r.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>':'');
    const pills = flagsOf(r).map(k=>'<span class="pill cat cat-'+k+'">'+CAT_ICON[k]+'</span>').join(' ');
    tr.innerHTML = '<td style="white-space:nowrap">'+escapeHtml(fmt(r.at))+'</td><td>'+name+'</td><td>'+pills+'</td><td><div class="rep-text">'+escapeHtml(r.reply)+'</div></td><td>'+(r.ind?escapeHtml(r.ind):'<span class="muted">—</span>')+'</td>';
    body.appendChild(tr);
  });
}
rq.addEventListener('input', renderReplies); rflt.addEventListener('change', renderReplies); rrange.addEventListener('change', renderReplies);

// ---- chart helpers (hand-built SVG: thin marks, 2px surface gaps, hover tooltips; colors come from the .eng tokens)
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent){ const e=document.createElementNS(SVGNS, tag); for(const k in attrs) e.setAttribute(k, attrs[k]); if(parent) parent.appendChild(e); return e; }
const engTip = document.getElementById('engtip');
function showTip(ev, title, rows){
  engTip.textContent = '';
  const h = document.createElement('div'); h.className='tt-h'; h.textContent = title; engTip.appendChild(h);
  rows.forEach(r=>{ const d=document.createElement('div'); d.className='tt-row'; const k=document.createElement('i'); k.style.background=r.color; const v=document.createElement('b'); v.textContent=r.value; const s=document.createElement('span'); s.textContent=r.name; d.appendChild(k); d.appendChild(v); d.appendChild(s); engTip.appendChild(d); });
  engTip.hidden = false;
  const w = engTip.offsetWidth; let x = ev.clientX+14; if(x+w > window.innerWidth-8) x = ev.clientX-w-14;
  engTip.style.left = x+'px'; engTip.style.top = (ev.clientY+14)+'px';
}
function hideTip(){ engTip.hidden = true; }
function niceMax(v){ if(v<=4) return 4; const p=Math.pow(10, Math.floor(Math.log(v)/Math.LN10)), m=v/p; return (m<=1?1:m<=2?2:m<=4?4:m<=5?5:10)*p; }
const fmtK = (v)=> v>=1000 ? (Math.round(v/100)/10)+'K' : (Math.round(v*10)/10)+'';
function barPath(x,y,w,h,r,round){
  if(h<=0) return '';
  r = Math.min(r, w/2, h);
  if(!round) return 'M'+x+' '+y+'h'+w+'v'+h+'h'+(-w)+'z';
  return 'M'+x+' '+(y+h)+'v'+(-(h-r))+'a'+r+' '+r+' 0 0 1 '+r+' '+(-r)+'h'+(w-2*r)+'a'+r+' '+r+' 0 0 1 '+r+' '+r+'v'+(h-r)+'z';
}
function chartFrame(host, labels, max, o){
  host.textContent = '';
  const W=640, H=o.h||220, L=34, R=8, T=10, B=26, iw=W-L-R, ih=H-T-B;
  const svg = svgEl('svg', {viewBox:'0 0 '+W+' '+H, width:'100%', role:'img', 'aria-label':o.label||''}, host);
  for(let t=0;t<=4;t++){
    const y = T+ih-ih*t/4;
    svgEl('line', {x1:L, x2:W-R, y1:y, y2:y, style:'stroke:var(--line);stroke-width:1'}, svg);
    const tx = svgEl('text', {x:L-6, y:y+4, 'text-anchor':'end', style:'fill:var(--mut);font-size:10px'}, svg); tx.textContent = fmtK(max*t/4);
  }
  const slot = iw/labels.length, every = Math.max(1, Math.ceil(labels.length/(o.maxLabels||10)));
  labels.forEach((lb,i)=>{ if(i%every) return; const tx=svgEl('text', {x:L+slot*i+slot/2, y:H-8, 'text-anchor':'middle', style:'fill:var(--mut);font-size:10px'}, svg); tx.textContent = lb.short; });
  return {svg:svg, L:L, T:T, ih:ih, iw:iw, slot:slot, H:H};
}
// stacked (or single) columns: labels [{short,full}], series [{name,color,vals}]
function colChart(host, labels, series, o){
  const totals = labels.map((_,i)=>series.reduce((s,x)=>s+x.vals[i],0));
  const max = niceMax(Math.max.apply(null, totals.concat([1])));
  const f = chartFrame(host, labels, max, o);
  const bw = Math.min(24, f.slot*0.7);
  labels.forEach((lb,i)=>{
    const cx = f.L+f.slot*i+f.slot/2, act = series.filter(s=>s.vals[i]>0);
    let acc = 0;
    act.forEach((s,j)=>{
      const h = f.ih*s.vals[i]/max, y = f.T+f.ih-f.ih*(acc+s.vals[i])/max;
      const hh = j>0 ? Math.max(1, h-2) : h;      // 2px surface gap between stacked segments
      svgEl('path', {d:barPath(cx-bw/2, y, bw, hh, 4, j===act.length-1), style:'fill:'+s.color}, f.svg);
      acc += s.vals[i];
    });
    const hit = svgEl('rect', {x:f.L+f.slot*i, y:f.T, width:f.slot, height:f.ih, style:'fill:transparent', tabindex:'0'}, f.svg);
    const rows = series.filter(s=>s.vals[i]>0 || series.length===1).map(s=>({color:s.color, value:String(s.vals[i]), name:s.name}));
    if(series.length>1) rows.push({color:'transparent', value:String(totals[i]), name:'total'});
    const on = (ev)=>showTip(ev, lb.full, rows.length?rows:[{color:'transparent', value:'0', name:'none'}]);
    hit.addEventListener('pointermove', on); hit.addEventListener('pointerleave', hideTip);
    hit.addEventListener('focus', ()=>{ const b=hit.getBoundingClientRect(); on({clientX:b.left+b.width/2, clientY:b.top}); }); hit.addEventListener('blur', hideTip);
  });
}
function lineChart(host, labels, vals, o){
  const max = niceMax(Math.max.apply(null, vals.concat([1])));
  const f = chartFrame(host, labels, max, o);
  const pt = (i)=>[f.L+f.slot*i+f.slot/2, f.T+f.ih-f.ih*vals[i]/max];
  svgEl('path', {d:vals.map((v,i)=>(i?'L':'M')+pt(i)[0]+' '+pt(i)[1]).join(''), style:'fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round'}, f.svg);
  const cross = svgEl('line', {y1:f.T, y2:f.T+f.ih, style:'stroke:var(--mut);stroke-width:1;opacity:0'}, f.svg);
  const dot = svgEl('circle', {r:5, style:'fill:var(--s1);stroke:var(--card);stroke-width:2;opacity:0'}, f.svg);
  labels.forEach((lb,i)=>{
    const hit = svgEl('rect', {x:f.L+f.slot*i, y:f.T, width:f.slot, height:f.ih, style:'fill:transparent', tabindex:'0'}, f.svg);
    const on = (ev)=>{ const p=pt(i); cross.setAttribute('x1',p[0]); cross.setAttribute('x2',p[0]); cross.style.opacity=1; dot.setAttribute('cx',p[0]); dot.setAttribute('cy',p[1]); dot.style.opacity=1; showTip(ev, lb.full, [{color:'var(--s1)', value:(Math.round(vals[i]*10)/10)+'', name:o.unit||''}]); };
    const off = ()=>{ cross.style.opacity=0; dot.style.opacity=0; hideTip(); };
    hit.addEventListener('pointermove', on); hit.addEventListener('pointerleave', off);
    hit.addEventListener('focus', ()=>{ const b=hit.getBoundingClientRect(); on({clientX:b.left+b.width/2, clientY:b.top}); }); hit.addEventListener('blur', off);
  });
  const last = vals.length-1; if(last>=0){ const p=pt(last); svgEl('circle', {cx:p[0], cy:p[1], r:4, style:'fill:var(--s1);stroke:var(--card);stroke-width:2'}, f.svg); }
}
function hbars(host, rows){
  host.textContent = '';
  const max = Math.max.apply(null, rows.map(r=>r.value).concat([1]));
  if(!rows.length){ const m=document.createElement('div'); m.className='muted'; m.textContent='Nothing in this range yet.'; host.appendChild(m); return; }
  rows.forEach(r=>{
    const d=document.createElement('div'); d.className='hb';
    const l=document.createElement('div'); l.className='hl'; l.textContent=r.label; l.title=r.label;
    const t=document.createElement('div'); t.className='ht'; const b=document.createElement('div'); b.className='hf'; b.style.width=(100*r.value/max)+'%'; b.style.background=r.color; t.appendChild(b);
    const v=document.createElement('div'); v.className='hv'; v.textContent=r.text||String(r.value);
    d.appendChild(l); d.appendChild(t); d.appendChild(v); host.appendChild(d);
  });
}
const erange = document.getElementById('erange');
function renderEng(){
  const n = parseInt(erange.value,10)||0;
  const firstReply = REPLIES.length ? dayOf(new Date(REPLIES[REPLIES.length-1].at)) : TODAY;
  const days = [];
  const start = n ? new Date(sinceMs(n)) : new Date(firstReply+'T12:00:00');
  start.setHours(12,0,0,0);
  for(let d=new Date(start); dayOf(d)<=TODAY && days.length<400; d.setDate(d.getDate()+1)) days.push(dayOf(d));
  const labels = days.map(d=>{ const x=new Date(d+'T12:00:00'); return {short:(x.getMonth()+1)+'/'+x.getDate(), full:x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}; });
  const inDays = {}; days.forEach(d=>inDays[d]=true);
  const inRange = REPLIES.filter(r=>inDays[dayOf(new Date(r.at))]);
  const reps = inRange.filter(r=>r.ch!=='email');
  const per = {}; days.forEach(d=>per[d]={interested:0,gift:0,notint:0,other:0});
  reps.forEach(r=>{ per[dayOf(new Date(r.at))][outcomeOf(r)]++; });
  const texts = days.map(d=>(OUTD[d]||{t:0}).t), emails = days.map(d=>(OUTD[d]||{e:0}).e);
  const cnt = {interested:0,gift:0,notint:0,other:0}; reps.forEach(r=>cnt[outcomeOf(r)]++);
  const totalTexts = texts.reduce((a,b)=>a+b,0);
  const accts = {}; reps.forEach(r=>{ accts[r.key || r.name] = 1; });
  const tiles = [[reps.length,'replies'],[Object.keys(accts).length,'pros replied'],[totalTexts?(Math.round(1000*reps.length/totalTexts)/10)+'%':'—','replies per text sent'],[cnt.interested,'👍 interested'],[cnt.notint,'🚫 not interested'],[cnt.gift,'🎁 gift card requests']];
  document.getElementById('etiles').innerHTML = tiles.map(t=>'<div class="stat"><b>'+t[0]+'</b><span>'+t[1]+'</span></div>').join('');
  colChart(document.getElementById('ch-out'), labels, [{name:'Texts', color:'var(--s1)', vals:texts},{name:'Emails', color:'var(--s2)', vals:emails}], {label:'Outreach sent per day'});
  colChart(document.getElementById('ch-rep'), labels, OUT_ORDER.map(k=>({name:OUT_LABEL[k], color:OUT_COLOR[k], vals:days.map(d=>per[d][k])})), {label:'Replies per day by outcome'});
  lineChart(document.getElementById('ch-rate'), labels, days.map((d,i)=>texts[i] ? 100*OUT_ORDER.reduce((s,k)=>s+per[d][k],0)/texts[i] : 0), {label:'Replies per 100 texts', unit:'replies per 100 texts'});
  hbars(document.getElementById('ch-mix'), OUT_ORDER.filter(k=>cnt[k]>0).map(k=>({label:OUT_LABEL[k], value:cnt[k], color:OUT_COLOR[k], text:cnt[k]+' · '+Math.round(100*cnt[k]/Math.max(1,reps.length))+'%'})));
  const hours = []; for(let h=0;h<24;h++) hours.push(0);
  reps.forEach(r=>{ hours[new Date(r.at).getHours()]++; });
  const hl = hours.map((_,h)=>({short:(h%12||12)+(h<12?'a':'p'), full:(h%12||12)+(h<12?' AM':' PM')}));
  colChart(document.getElementById('ch-hour'), hl, [{name:'Replies', color:'var(--s1)', vals:hours}], {label:'Replies by hour', maxLabels:8});
  const byInd = {}; reps.forEach(r=>{ if(r.ind) byInd[r.ind]=(byInd[r.ind]||0)+1; });
  hbars(document.getElementById('ch-ind'), Object.keys(byInd).sort((a,b)=>byInd[b]-byInd[a]).slice(0,8).map(k=>({label:k, value:byInd[k], color:'var(--s1)'})));
  const tb = document.querySelector('#etbl tbody'); tb.innerHTML='';
  const sumT = texts.reduce((a,b)=>a+b,0), sumE = emails.reduce((a,b)=>a+b,0);   // touchpoints = every text + every email sent, 1 each (the same per-send counts as the two columns before it)
  tb.insertAdjacentHTML('beforeend', '<tr><td><b>Total</b></td><td><b>'+sumT+'</b></td><td><b>'+sumE+'</b></td><td><b>'+(sumT+sumE)+'</b></td><td><b>'+reps.length+'</b></td><td><b>'+cnt.interested+'</b></td><td><b>'+cnt.gift+'</b></td><td><b>'+cnt.notint+'</b></td><td><b>'+cnt.other+'</b></td></tr>');
  days.slice().reverse().forEach(d=>{ const i=days.indexOf(d), p=per[d], tr=document.createElement('tr'); const tot=p.interested+p.gift+p.notint+p.other; tr.innerHTML='<td>'+escapeHtml(labels[i].full)+'</td><td>'+texts[i]+'</td><td>'+emails[i]+'</td><td>'+(texts[i]+emails[i])+'</td><td>'+tot+'</td><td>'+p.interested+'</td><td>'+p.gift+'</td><td>'+p.notint+'</td><td>'+p.other+'</td>'; tb.appendChild(tr); });
  document.getElementById('enote').textContent = REPLIES.length ? 'Replies are tracked from '+fmtDay(firstReply)+' (when the reply emails were first read). Outreach counts cover every text and email in the log.' : 'No replies recorded yet.';
}
erange.addEventListener('change', renderEng);

${require('./perfAnalytics').CLIENT_JS}
const mrange = document.getElementById('mrange'), mq = document.getElementById('mq');
function renderEmail(){
  const n = parseInt(mrange.value,10)||0, term = mq.value.trim().toLowerCase();
  const all = REPLIES.filter(r=>r.ch==='email');
  const firstDay = all.length ? dayOf(new Date(all[all.length-1].at)) : TODAY;
  let firstSend = TODAY; Object.keys(OUTD).forEach(d=>{ if(OUTD[d].e && d<firstSend) firstSend = d; });
  const days = [];
  const start = n ? new Date(sinceMs(n)) : new Date((firstSend<firstDay?firstSend:firstDay)+'T12:00:00');
  start.setHours(12,0,0,0);
  for(let d=new Date(start); dayOf(d)<=TODAY && days.length<400; d.setDate(d.getDate()+1)) days.push(dayOf(d));
  const labels = days.map(d=>{ const x=new Date(d+'T12:00:00'); return {short:(x.getMonth()+1)+'/'+x.getDate(), full:x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}; });
  const inDays = {}; days.forEach(d=>inDays[d]=true);
  const reps = all.filter(r=>inDays[dayOf(new Date(r.at))]);
  const per = {}; days.forEach(d=>per[d]={interested:0,gift:0,notint:0,other:0});
  reps.forEach(r=>{ per[dayOf(new Date(r.at))][outcomeOf(r)]++; });
  const sent = days.map(d=>(OUTD[d]||{e:0}).e), totalSent = sent.reduce((a,b)=>a+b,0);
  const cnt = {interested:0,gift:0,notint:0,other:0}; reps.forEach(r=>cnt[outcomeOf(r)]++);
  const accts = {}; reps.forEach(r=>{ accts[r.key || r.name] = 1; });
  const tiles = [[totalSent,'✉️ emails sent'],[reps.length,'replies'],[Object.keys(accts).length,'pros replied'],[totalSent?(Math.round(1000*reps.length/totalSent)/10)+'%':'—','replies per email sent'],[cnt.interested,'👍 interested'],[cnt.notint,'🚫 not interested'],[cnt.gift,'🎁 gift card requests']];
  document.getElementById('mtiles').innerHTML = tiles.map(t=>'<div class="stat"><b>'+t[0]+'</b><span>'+t[1]+'</span></div>').join('');
  colChart(document.getElementById('ch-esent'), labels, [{name:'Emails', color:'var(--s2)', vals:sent}], {label:'Emails sent per day'});
  colChart(document.getElementById('ch-erep'), labels, OUT_ORDER.map(k=>({name:OUT_LABEL[k], color:OUT_COLOR[k], vals:days.map(d=>per[d][k])})), {label:'Email replies per day by outcome'});
  lineChart(document.getElementById('ch-erate'), labels, days.map((d,i)=>sent[i] ? 100*OUT_ORDER.reduce((s,k)=>s+per[d][k],0)/sent[i] : 0), {label:'Replies per 100 emails', unit:'replies per 100 emails'});
  hbars(document.getElementById('ch-emix'), OUT_ORDER.filter(k=>cnt[k]>0).map(k=>({label:OUT_LABEL[k], value:cnt[k], color:OUT_COLOR[k], text:cnt[k]+' · '+Math.round(100*cnt[k]/Math.max(1,reps.length))+'%'})));
  const hours = []; for(let h=0;h<24;h++) hours.push(0);
  reps.forEach(r=>{ hours[new Date(r.at).getHours()]++; });
  const hl = hours.map((_,h)=>({short:(h%12||12)+(h<12?'a':'p'), full:(h%12||12)+(h<12?' AM':' PM')}));
  colChart(document.getElementById('ch-ehour'), hl, [{name:'Replies', color:'var(--s1)', vals:hours}], {label:'Email replies by hour', maxLabels:8});
  const byInd = {}; reps.forEach(r=>{ if(r.ind) byInd[r.ind]=(byInd[r.ind]||0)+1; });
  hbars(document.getElementById('ch-eind'), Object.keys(byInd).sort((a,b)=>byInd[b]-byInd[a]).slice(0,8).map(k=>({label:k, value:byInd[k], color:'var(--s1)'})));
  const list = reps.filter(r=>!term || (r.name+' '+r.reply+' '+(r.ind||'')).toLowerCase().indexOf(term)>=0);
  document.getElementById('mcount').textContent = list.length.toLocaleString()+' email repl'+(list.length===1?'y':'ies');
  document.getElementById('mempty').hidden = list.length>0;
  const body = document.querySelector('#mtbl tbody'); body.innerHTML = '';
  list.forEach(r=>{
    const tr = document.createElement('tr');
    const name = '<span class="nm">'+escapeHtml(r.name)+'</span>'+(r.url?' <a class="sfl" href="'+escapeHtml(r.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>':'');
    const pills = flagsOf(r).map(k=>'<span class="pill cat cat-'+k+'">'+CAT_ICON[k]+'</span>').join(' ');
    tr.innerHTML = '<td style="white-space:nowrap">'+escapeHtml(fmt(r.at))+'</td><td>'+name+'</td><td>'+pills+'</td><td><div class="rep-text">'+escapeHtml(r.reply)+'</div></td><td>'+(r.ind?escapeHtml(r.ind):'<span class="muted">—</span>')+'</td>';
    body.appendChild(tr);
  });
}
mrange.addEventListener('change', renderEmail); mq.addEventListener('input', renderEmail);

// ---------------------------------------------------------------------------------------------------------------------
// 🗂 Follow-up board: leads by the stage of the thirteen-stage cadence they are waiting for (cadence.js), green = ready now. ✋ cards are leads added by hand (#tagged with their kind).
const BOARD = ${boardJson}, BTPL = ${boardTpl};
const GRAPHDOC = ${graphJson};
const WFSNAP = ${wfSnapJson};
const bq = document.getElementById('bq'), blist = document.getElementById('blist'), bshow = document.getElementById('bshow');
// 🏭 Industry picker: one or more industries (the Salesforce Industry once --industry has read it, else a guess from the business name, marked ~); a lead nothing is known about is "Unknown".
const bind = document.getElementById('bind'), bindSum = document.getElementById('bind-sum'), BIND = new Set(), BNONE = '__none';
const bindOf = b => b.i || BNONE;
function fillBoardIndustry(){            // the checklist: every industry on the board with its lead count, biggest first, Unknown last
  const c = {}; let nSf = 0, nGuess = 0;
  BOARD.forEach(b => { const k = bindOf(b); c[k] = (c[k]||0)+1; if(b.i){ if(b.is) nSf++; else nGuess++; } });
  const names = Object.keys(c).filter(k => k!==BNONE).sort((a,b) => c[b]-c[a] || a.localeCompare(b)); if(c[BNONE]) names.push(BNONE);
  document.getElementById('bind-list').innerHTML = names.map(k => '<label><input type="checkbox" value="'+escapeHtml(k)+'"> '+(k===BNONE ? 'Unknown' : escapeHtml(k))+'<span class="c">'+c[k].toLocaleString()+'</span></label>').join('');
  document.getElementById('bind-note').textContent = nSf.toLocaleString()+' read from Salesforce · '+nGuess.toLocaleString()+' guessed from the business name · '+(c[BNONE]||0).toLocaleString()+' unknown';
}
fillBoardIndustry();
function bindLabel(){            // the closed picker says what is picked; the row under the filters holds the command that works only those industries (boardRun.js --trade: the same names the picker lists)
  const names = [...BIND].map(k => k===BNONE ? 'Unknown' : k);
  bind.classList.toggle('on', names.length>0);
  bindSum.textContent = '🏭 '+(!names.length ? 'All industries' : names.length<=2 ? names.join(', ') : names.length+' industries');
  document.getElementById('bind-run').hidden = !names.length;
  document.getElementById('bind-cmd').textContent = "email --board --trade '"+[...BIND].map(k => k===BNONE ? 'unknown' : k.split("'").join('')).sort().join(',')+"'";
}
document.getElementById('bind-copy').addEventListener('click', () => {
  const cmd = document.getElementById('bind-cmd').textContent, btn = document.getElementById('bind-copy');
  const done = () => { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 1800); };
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = cmd; document.body.appendChild(ta); ta.select(); let ok = false; try{ ok = document.execCommand('copy'); }catch(_){} ta.remove(); if(ok) done(); else btn.textContent = 'Select the command and copy it by hand'; };
  try{ navigator.clipboard.writeText(cmd).then(done, fallback); }catch(_){ fallback(); }
});
document.getElementById('bind-list').addEventListener('change', e => { const t = e.target; if(!t || t.type!=='checkbox') return; if(t.checked) BIND.add(t.value); else BIND.delete(t.value); renderBoard(); });
document.getElementById('bind-clear').addEventListener('click', () => { BIND.clear(); document.querySelectorAll('#bind-list input').forEach(x => { x.checked = false; }); renderBoard(); });
document.addEventListener('click', e => { if(bind.open && !bind.contains(e.target)) bind.open = false; });
bindSum.addEventListener('click', () => {            // measured while it is still closed: slide the panel left when it would run off the window (on a phone the picker sits mid-row)
  const box = bind.querySelector('.indbox'), vw = document.documentElement.clientWidth, w = Math.min(300, vw - 32);
  box.style.width = w + 'px'; box.style.left = -Math.max(0, bindSum.getBoundingClientRect().left + w - (vw - 16)) + 'px';
});
function renderBoard(){
  const q = bq.value.trim().toLowerCase(), kind = blist.value, show = bshow.value, nowMs = Date.now();
  const keep = b => !kind ? true : kind==='@hand' ? !!b.hd : kind.slice(0,4)==='tag:' ? (b.tg||[]).includes(kind.slice(4)) : b.k.includes(kind);
  const gap = b => b.st==='due' || (b.st==='waiting' && b.ra && Date.parse(b.ra) <= nowMs);          // the gap since our last touch has passed
  const ready = b => gap(b) && (!b.op || Date.parse(b.op) <= nowMs);                                   // ... and the lead's own texting window is open
  const stuck = b => b.st==='paused' || b.st==='held' || b.st==='blocked';
  bindLabel();
  const rows = BOARD.filter(b => keep(b) && (!BIND.size || BIND.has(bindOf(b))) && (!q || b.n.toLowerCase().includes(q)) && (show==='ready' ? ready(b) : show==='today' ? (b.td||[]).length>0 : show==='stuck' ? stuck(b) : true));
  const ST = BTPL.stages || [];
  const esc = x => String(x==null?'':x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const when = iso => new Date(iso).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const sentBy = ST.map((x,i) => rows.filter(b => (b.td||[]).includes(i)).length);
  const readyN = rows.filter(ready).length, todayN = rows.filter(b => (b.td||[]).length).length, stuckN = rows.filter(b => stuck(b) && !b.o).length, oldN = rows.filter(b => b.o && b.s<ST.length).length;
  document.getElementById('bsum').innerHTML = '<b>'+rows.length.toLocaleString()+'</b> leads · <b style="color:var(--text)">'+readyN.toLocaleString()+'</b> ready for their next stage · ✅ <b>'+todayN.toLocaleString()+'</b> reached today'+(stuckN ? ' · ⏸ <b>'+stuckN.toLocaleString()+'</b> paused or held' : '')+(oldN ? ' · 🕓 <b>'+oldN.toLocaleString()+'</b> older leads (started over '+(BTPL.autoDays||7)+' days ago, not worked by the board and no reply in the last 30 days: shown, not run automatically)' : '')+'<br>Sent today: '+ST.map((x,i)=>esc(x.label)+' <b>'+sentBy[i].toLocaleString()+'</b>').join(' · ');
  const cols = ST.map((x,i) => ({s:i, rows: rows.filter(b => b.s===i)})).concat([{s:ST.length, rows: rows.filter(b => b.s===ST.length)}]);
  document.getElementById('bboard').innerHTML = cols.map(c => {
    const stg = c.s<ST.length ? ST[c.s] : null;
    const cards = c.rows.slice().sort((a,b) => (b.hd?1:0)-(a.hd?1:0) || (ready(b)?1:0)-(ready(a)?1:0) || String(b.la||'').localeCompare(String(a.la||''))).slice(0,40).map(b => {
      const cls = ready(b) ? ' due' : b.st==='paused' ? ' rep' : stuck(b) ? ' held' : '';
      const m = ready(b) ? 'ready now' : gap(b) && b.op ? 'ready · their window opens '+when(b.op) : b.st==='waiting' ? 'ready '+when(b.ra) : esc(b.h||'');
      const hand = b.hd ? ' <span class="pill hand" title="Added by hand: your stage 1 counts as both Day 1 texts (and Email 1 if you emailed it)">✋</span>'+(b.k||[]).map(k=>'<span class="tag '+(k==='LDS'?'lds':'shark')+'">#'+(k==='LDS'?'lds':'shark')+'</span>').join('') : '';
      const own = (b.tg||[]).map(t=>'<span class="tag custom">#'+esc(t)+'</span>').join('');
      const today = (b.td||[]).length ? ' · ✅ '+(b.td||[]).map(i=>esc((ST[i]||{}).label)).join(', ')+' today' : (b.la ? ' · last touch '+String(b.la).slice(0,10) : ' · not touched yet');
      return '<div class="kcard'+cls+'"><a href="'+esc(b.u)+'" target="_blank" rel="noopener">'+esc(b.n)+'</a>'+hand+own+'<div class="m">'+m+today+(b.z?' · '+esc(b.z):'')+(b.i ? ' · <span class="ind"'+(b.is ? '' : ' title="Guessed from the business name"')+'>'+(b.is ? '' : '~ ')+esc(b.i)+(b.iw ? ' ?' : '')+'</span>' : '')+'</div></div>';
    }).join('');
    const more = c.rows.length>40 ? '<div class="m" style="margin-top:6px">+ '+(c.rows.length-40)+' more</div>' : '';
    const tpl = stg ? '<div class="ktpl"><div class="kh">'+(stg.ch==='email'?'✉️ ':'💬 ')+esc(stg.label)+' — '+esc(stg.name||'(not written yet)')+(stg.hand ? ' <span class="pill hand" title="'+(stg.hand==='skip' ? 'Done by hand: the board never sends this stage.' : 'Day 1 is done by hand. This is a label: the board still sends this stage if you run it.')+'">✋ by hand</span>' : ' <span class="pill auto" title="Automated: the board sends this stage by itself, inside the texting hours of each lead.">🤖 auto</span>')+'</div>'+(stg.subject?'<b>'+esc(stg.subject)+'</b>':'')+'<div class="kb2">'+(stg.missing?'No text is written for this stage yet: nothing is sent until it is.':esc(stg.body))+'</div></div>' : '';
    return '<div class="kcol">'+tpl+'<h4>'+(stg ? (stg.hand ? '✋ ' : '🤖 ')+'Next: '+esc(stg.label) : 'Finished (every stage)')+'</h4><div class="ks"><b>'+c.rows.length.toLocaleString()+'</b> leads'+(stg?' · <b style="color:var(--text)">'+c.rows.filter(ready).length.toLocaleString()+'</b> ready':'')+'</div>'+cards+more+'</div>';
  }).join('');
}
bq.addEventListener('input', renderBoard); blist.addEventListener('change', renderBoard); bshow.addEventListener('change', renderBoard);

// ---------------------------------------------------------------------------------------------------------------------
// ⏳ Send queue tab: who is waiting to be texted and roughly when.
const QUEUE = ${queueJson};
document.getElementById('queue-n').textContent = QUEUE.length;
const qq = document.getElementById('qq');
function fmtEta(iso){
  if(!iso) return '<span class="muted" title="No texting window found in the next 8 days">—</span>';
  const d = new Date(iso), now = new Date();
  const day = d.toDateString()===now.toDateString() ? 'Today' : d.toDateString()===new Date(now.getTime()+864e5).toDateString() ? 'Tomorrow' : d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  return '<b>'+day+'</b> ~'+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}
function renderQueue(){
  const term = qq.value.trim().toLowerCase();
  const rows = QUEUE.map((q,i)=>({...q,n:i+1})).filter(q=>!term || (q.name+' '+(q.ind||'')).toLowerCase().includes(term));
  document.getElementById('qempty').hidden = QUEUE.length>0;
  const body = document.querySelector('#qtbl tbody'); body.innerHTML = '';
  rows.forEach(q=>{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+q.n+'</td><td><span class="nm">'+escapeHtml(q.name)+'</span> <a class="sfl" href="'+escapeHtml(q.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a></td>'
      + '<td>'+indCell(q)+'</td><td>'+escapeHtml(q.src)+'</td>'
      + '<td>'+(q.zone ? escapeHtml(q.zone) : '<span class="muted" title="No zone read yet: texted only 12-8 PM Eastern">unknown</span>')+'</td>'
      + '<td>'+fmtEta(q.eta)+'</td>';
    body.appendChild(tr);
  });
}
qq.addEventListener('input', renderQueue);

// ---------------------------------------------------------------------------------------------------------------------
// 🛑 Skipped tab: leads the Salesforce review (or the banlist) kept us from contacting, with the reasons.
const SKIP = ${skipJson};
document.getElementById('skip-n').textContent = SKIP.length;
const sq = document.getElementById('sq'), sflt = document.getElementById('sflt');
function skipKind(x){
  if(x.verdict==='unknown') return 'unread';
  if(x.verdict==='cap') return 'cap';
  if(x.verdict==='hold') return 'hold';
  if(x.reasons.some(r=>/current customer/i.test(r)) && !x.cw && !x.flags.includes('closed_won_30d')) return 'cust';
  if(x.cw || x.flags.includes('closed_won_30d') || x.reasons.some(r=>/closed won/i.test(r))) return 'won';
  if(x.banned || x.verdict==='ban' || x.reasons.some(r=>/do-not-contact/i.test(r))) return 'dnc';
  if(x.reasons.some(r=>/closed out/i.test(r))) return 'closed';
  return 'other';
}
const SKIP_LABEL = {cap:'Text cap reached', hold:'Held by thread read', won:'Closed won ≤${WON_FLAG_DAYS}d', closed:'All opps closed out', cust:'Older closed won (past rule)', dnc:'Do-not-contact', unread:'Could not be read', other:'Other'};
function renderSkipped(){
  const term = sq.value.trim().toLowerCase(), f = sflt.value;
  const rows = SKIP.filter(x=>(!f || skipKind(x)===f) && (!term || (x.name+' '+(x.ind||'')+' '+x.reasons.join(' ')).toLowerCase().includes(term)));
  rows.sort((a,b)=>(a.at<b.at?1:-1));
  document.getElementById('sempty').hidden = rows.length>0;
  const body = document.querySelector('#stbl tbody'); body.innerHTML = '';
  rows.forEach(x=>{
    const rr = HBY.get(String(x.id||'').toLowerCase().slice(0,15)) || {};
    const k = skipKind(x);
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(x.name)+'</span> <a class="sfl" href="'+escapeHtml(x.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>'+listTags(rr)+'</td>'
      + '<td>'+indCell(x)+'</td>'
      + '<td><span class="pill skip">'+SKIP_LABEL[k]+'</span>'+x.reasons.map(r=>'<div class="lnote">'+escapeHtml(r)+'</div>').join('')+(x.source?'<div class="lnote">via '+escapeHtml(x.source)+'</div>':'')+'</td>'
      + '<td>'+fmt(x.at)+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>';
    body.appendChild(tr);
  });
}
sq.addEventListener('input', renderSkipped); sflt.addEventListener('change', renderSkipped);
// ---- 🎯 Top hit list (Leads): pros who answered with interest + the accounts on Luke's own hit list (topHit.js). They all stay on the follow-up board; each row says where it stands there.
const TOPHIT = ${topHitJson};
document.getElementById('tophit-n').textContent = TOPHIT.length;
const thq = document.getElementById('thq'), thflt = document.getElementById('thflt');
function renderTopHit(){
  const term = thq.value.trim().toLowerCase(), f = thflt.value;
  const rows = TOPHIT.filter(x=>(!f || (f==='reply' ? !!x.reply : x.note!=null)) && (!term || (x.name+' '+(x.note||'')+' '+(x.reply||'')).toLowerCase().includes(term)));
  document.getElementById('thempty').hidden = rows.length>0;
  const body = document.querySelector('#thtbl tbody'); body.innerHTML = '';
  const ST = BTPL.stages || [];
  rows.forEach(x=>{
    const rr = HBY.get(String(x.id||'').toLowerCase().slice(0,15)) || {};
    const replyLine = x.reply ? '<div><span class="pill ok">👍 replied</span> <span class="lnote">'+fmt(x.replyAt)+(x.n>1 ? ' · '+x.n+' interested replies' : '')+'</span><div>'+escapeHtml(x.reply)+'</div></div>' : '';
    const noteLine = x.note!=null ? '<div><span class="pill t">📝 your note</span>'+(x.noteAt ? ' <span class="lnote">'+fmt(x.noteAt)+'</span>' : '')+'<div>'+(x.note ? escapeHtml(x.note) : '<span class="muted">(no note text)</span>')+'</div></div>' : '';
    let nb = '<span class="muted">not on the board</span>';
    if(x.s!=null){
      nb = ST[x.s] ? '<b>'+escapeHtml(ST[x.s].label)+'</b>' : '<span class="muted">finished every step</span>';
      if(x.st==='paused') nb += '<div class="lnote">paused: asked us to stop</div>';
      else if(x.st==='held') nb += '<div class="lnote">'+escapeHtml(x.h || 'held')+'</div>';
      else if(x.st==='due') nb += '<div class="lnote">ready now</div>';
      else if(x.ra) nb += '<div class="lnote">from '+fmt(x.ra)+'</div>';
    }
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="nm">'+escapeHtml(x.name)+'</span>'+(x.url ? ' <a class="sfl" href="'+escapeHtml(x.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>' : '')+listTags(rr)+'</td>'
      + '<td>'+(x.kind==='note' ? noteLine+replyLine : replyLine+noteLine)+'</td>'
      + '<td>'+nb+'</td>'
      + '<td>'+(rr.texts ? '<span class="pill t">'+rr.texts+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+(rr.emails ? '<span class="pill e">'+rr.emails+'</span>' : '<span class="muted">—</span>')+'</td>'
      + '<td>'+sinceCell(rr)+'</td>'
      + '<td>'+(x.id ? '<code style="user-select:all">node topHit.js --remove '+escapeHtml(x.id)+'</code>' : '<span class="muted">(no account linked)</span>')+'</td>';
    body.appendChild(tr);
  });
}
thq.addEventListener('input', renderTopHit); thflt.addEventListener('change', renderTopHit);
${dncBox('boxScript')}

// ---- 🔀 Graph: the workflow map (pipeline-diagram.html) in a frame of its own, with the numbers as of this build (GRAPHDOC = the page, WFSNAP = workflowSnapshot.js). The frame is made when the tab is first opened: one made while hidden has no size to fit the map to.
window.__WFSNAP = WFSNAP; window.__WFLIVE = false;      // the frame reads its numbers from here (same origin): it has no database of its own (graphLive below swaps in a newer snapshot from this page's database)
let GRAPH_FRAME = null;
// The morning numbers: workflowSnapshot.js --post also writes each day's snapshot into THIS page's own database (collection "workflow", the 7:51 AM task), and the open map takes the newest one when it is newer than the numbers built into the page. Subscribed once, when the map is first opened; a view without the database (the local file, signed out) keeps the built-in numbers.
function graphLive(){
  try {
    const c = window.claude;
    if(!c || typeof c.use !== 'function') return;
    c.use('db').then(db=>{
      if(!db) return;
      db.collection('workflow').orderBy('asOf','desc').limit(1).onSnapshot(snap=>{
        try {
          if(!snap || snap.empty) return;
          const doc = snap.docs[0].data();
          if(!doc || doc.v!==1 || typeof doc.n!=='object') return;
          const built = WFSNAP ? Date.parse(WFSNAP.asOf) : NaN;
          if(Number.isFinite(built) && !(Date.parse(doc.asOf) > built)) return;      // the numbers built into this page are as new or newer
          window.__WFSNAP = doc; window.__WFLIVE = true;
          const w = GRAPH_FRAME && GRAPH_FRAME.contentWindow;
          if(w && typeof w.__applyWF==='function') w.__applyWF(doc, true);
        } catch(_){}
      }, ()=>{});
    }, ()=>{});
  } catch(_){}
}
function graphTheme(){ const t = document.documentElement.getAttribute('data-theme'); return t==='light' || t==='dark' ? t : null; }      // null = no forced theme: the frame then follows the same prefers-color-scheme as this page
function renderGraph(){
  const box = document.getElementById('graphbox');
  if(GRAPH_FRAME) return;
  if(!GRAPHDOC || !GRAPHDOC.html){ box.innerHTML = '<div class="empty">The map (pipeline-diagram.html) was not found when this page was built.</div>'; return; }
  const note = document.getElementById('graphnote');
  if(note && GRAPHDOC.built){ try { note.textContent = new Date(GRAPHDOC.built).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); } catch(_){} }
  const f = document.createElement('iframe');
  f.title = 'Pipeline Assistant workflow graph';
  f.srcdoc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+GRAPHDOC.html+'</body></html>';
  const sync = ()=>{ try{ const t = graphTheme(), root = f.contentDocument.documentElement; if(t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme'); }catch(_){} };
  f.addEventListener('load', sync);
  try { new MutationObserver(sync).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']}); } catch(_){}
  box.appendChild(f); GRAPH_FRAME = f;
  graphLive();
}

// ---- tabs: "Shark" is the main table, limited to #shark accounts
const TABS = {shark:'pane-all', tophit:'pane-tophit', lost:'pane-lost', team:'pane-team', cust:'pane-cust', free:'pane-free', coach:'pane-coach', won:'pane-won', board:'pane-board', queue:'pane-queue', skip:'pane-skip', harvest:'pane-harvest', eng:'pane-eng', replies:'pane-replies', email:'pane-email', perf:'pane-perf', graph:'pane-graph', instr:'pane-instr'};
// ---- tab groups (Leads / Tools / Analytics): a tab belongs to the .subtabs bar its button sits in, so a new tab needs its button in a bar and an entry in TABS
const GROUP_OF = {}, FIRST_IN = {}, LAST_IN = {};
document.querySelectorAll('.subtabs').forEach(bar=>bar.querySelectorAll('.tab').forEach(b=>{ const t = b.id.replace(/^tab-/,''), g = bar.dataset.group; GROUP_OF[t] = g; if(!FIRST_IN[g]) FIRST_IN[g] = t; }));
const HOME = FIRST_IN[document.querySelector('.groups .tab').dataset.group];   // where the page opens, and where a saved tab that no longer exists lands (the old "all" included): the first tab of the first group
function showTab(which){
  if(!TABS[which]) which = HOME;
  VIEW = which==='shark' ? 'shark' : 'all';
  Object.keys(TABS).forEach(t=>document.getElementById('tab-'+t).classList.toggle('on', t===which));
  const grp = GROUP_OF[which];
  if(grp){
    LAST_IN[grp] = which;
    document.querySelectorAll('.groups .tab').forEach(b=>b.classList.toggle('on', b.dataset.group===grp));
    document.querySelectorAll('.subtabs').forEach(bar=>{ bar.hidden = bar.dataset.group!==grp; });
  }
  Array.from(new Set(Object.keys(TABS).map(t=>TABS[t]))).forEach(id=>{ document.getElementById(id).hidden = id!==TABS[which]; });
  if(which==='shark'){ fillIndustry(); fillAdded(); render(); }
  if(which==='lost') renderLost();
  if(which==='team'){ renderTeam(); renderHolds(); }
  if(which==='cust') renderCust();
  if(which==='free') renderFree();
  if(which==='coach') renderCoach();
  if(which==='won') renderWon();
  if(which==='board') renderBoard();
  if(which==='queue') renderQueue();
  if(which==='tophit') renderTopHit();
  if(which==='skip') renderSkipped();
  if(which==='harvest') renderHarvest();
  if(which==='eng') renderEng();
  if(which==='replies') renderReplies();
  if(which==='email') renderEmail();
  if(which==='perf') renderPerf();
  document.querySelector('.wrap').classList.toggle('graphwide', which==='graph');      // the map gets the whole window width
  if(which==='graph') renderGraph();
  try { localStorage.setItem('assistant-tab', which); } catch(_) {}
}
Object.keys(TABS).forEach(t=>document.getElementById('tab-'+t).addEventListener('click',()=>showTab(t)));
document.querySelectorAll('.groups .tab').forEach(b=>b.addEventListener('click',()=>showTab(LAST_IN[b.dataset.group] || FIRST_IN[b.dataset.group])));
lq.addEventListener('input', renderLost); lflt.addEventListener('change', renderLost);
fillIndustry(); fillAdded(); render();
try { const t = localStorage.getItem('assistant-tab'); if(t && t!==HOME) showTab(t); } catch(_) {}
</script>
</body>
</html>`;

  try { fs.writeFileSync(DASH_FILE, html, 'utf8'); } catch (_) {}
  return DASH_FILE;
}

module.exports = { freePlanLeads, noRecipientAccounts, sentSameMessage, recordSkip, readSkips, SKIP_FILE, ldsLeads, emailCadenceOf, KEY_ACCOUNT_LIST, parseSmsTime, teammateTexted, teammateList, readReplyRows, replyTime, emailOfLead, readReplies, REPLY_FILE, emailsFromReport, readReportEmails, EML_FILE, industryFromReport, recordSfIndustry, readSfIndustry, industryTodo, indFields, IND_FILE, FOLLOWUP_STEPS, followupStepsSent, followupStepOfName, zoneTried, recordCurrentCustomer, readCurrentCustomers, readCustomerRows, closedWonList: () => [...new Set(readClosedWon().values())], recordClosedWon, readClosedWon, closedWithin, touchpointCount, recordTouchpointStage, followupDue, makeListsFor, harvestData, zonesFromReport, recordSnapshot, readSnapshots, snapshotMap, newestSharkScan, SNAP_FILE, classifyList, recordListScan, readListMembership, LIST_FILE, recordPlan, readPlans, PLAN_FILE, AUTO_PREFIX, recordHarvest, readHarvest, HARVEST_FILE, readZones, recordZone, zonesFor, ZONE_FILE, readBans, readGreen, isBanned, recordBan, recordGreen, BAN_FILE, GREEN_FILE, lostDemoAccounts, recordReview, readReviews, REVIEW_FILE, reengageDue, REENGAGE_PREFIX, OPT_OUT_RE, recordReengage, readReengageNotes, REENGAGE_FILE, recordOutreach, recordText, recordEmail, readAll, textedWithinHours, emailedWithinHours, lastOutreachWithinHours, aggregate, generateDashboard, seedFromContactHistory, LOG_FILE, DASH_FILE };

Object.assign(module.exports, { readManualRecords, manualTags, MANUAL_FILE, MANUAL_MODE, MANUAL_LIST_NAME, MANUAL_TAG_KINDS });   // leads added to the Shark tab by hand (manualShark.js)
// ---------------------------------------------------------------------------
if (require.main === module) {
  // node textLog.js --reengage "<accountId or name>" "<stage>" [note]   — append a note
  // node textLog.js --import-notes <file.jsonl>                          — append exported dashboard notes
  const argv = process.argv.slice(2);
  // node textLog.js --banlist                          list banned accounts (and green ones)
  // node textLog.js --ban <accountId> [reason]         ban an account manually
  // node textLog.js --dnc <email> […] [--why "reason"] ban every account that uses an email address (the Skipped tab's box builds this command)
  // node textLog.js --green <accountId> [reason]       clear a banned account (green banlist) — operator only
  // node textLog.js --plan <accountId | part of the name>   print the latest --auto game plan and EXACTLY what the bot read
  if (argv[0] === '--plan' && argv[1]) {
    const q = String(argv[1]).toLowerCase();
    const ps = [...readPlans().values()].filter((p) => String(p.accountId).toLowerCase() === q || String(p.accountName || '').toLowerCase().includes(q));
    if (!ps.length) console.log(`\nNo --auto plan matches "${argv[1]}". (${readPlans().size} plans saved)\n`);
    for (const p of ps) {
      const rd = p.read || {};
      console.log(`\n🤖 ${p.accountName}  (${p.accountId})  — ${p.status.toUpperCase()}  ${p.at}  confidence: ${p.confidence || '?'}`);
      const od = p.originalDemo || {};
      const fmtD = (iso) => { const d = new Date(iso + 'T12:00:00'); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
      console.log('\n   🎯 ORIGINAL DEMO');
      console.log(`      Original Sales Rep on Demo:  ${od.repName ? `${od.repName}   (${od.repSource})` : (p.rep ? p.rep.name : 'not found')}`);
      console.log(`      Date of Original Demo:       ${od.date ? `${fmtD(od.date)}   (${od.dateSource})` : (p.demo ? `${p.demo.month} ${p.demo.year}` : 'not confirmed')}`);
      if (od.dateEvidence) console.log(`         evidence: ${od.dateEvidence}`);
      if ((od.others || []).length) console.log(`      Also named on the notes:     ${od.others.join(', ')}`);
      const wy = Object.entries(od.why || {}); if (wy.length) console.log(`      Why it didn't close:         ${wy.map(([k, v]) => `${k}: ${v}`).join('  ·  ')}`);
      if ((p.reasons || []).length) console.log(`   Reasons: ${p.reasons.join(' ; ')}`);
      if ((p.problems || []).length) console.log(`   Problems: ${p.problems.join(' | ')}`);
      console.log(`\n   WHAT IT READ — opportunities (${(rd.opps || p.recentOpps || []).length} most recent of ${rd.oppCount || '?'}):`);
      (rd.opps || p.recentOpps || []).forEach((o) => console.log(`     ${(o.closeDate || 'no date').padEnd(12)} ${(o.stage || '').padEnd(20)} ${o.name}${o.owner ? '  — ' + o.owner : ''}`));
      const ofs = Object.entries(rd.oppFields || {});
      if (ofs.length) { console.log(`   Opportunity page fields${rd.oppOwner ? ' (owner ' + rd.oppOwner + ')' : ''}:`); ofs.forEach(([k, v]) => console.log(`     ${k}: ${v}`)); }
      console.log(`\n   The last ${rd.notesOpened || (p.notes || []).length} notes it opened (of ${rd.notesTotal != null ? rd.notesTotal : '?'} on the account) — readable: ${(p.notes || []).length}`);
      (p.notes || []).forEach((n, i) => console.log(`\n   ${i + 1}) ${n.date || 'undated'}${n.by ? ' [' + n.by + ']' : ''}  ${n.subject || 'Untitled'}${n.how ? '   (read via ' + n.how + ')' : ''}\n${String(n.body || '').split('\n').map((l) => '        ' + l).join('\n')}`));
      if (!(p.notes || []).length) (rd.noteDebug || []).forEach((d) => console.log(`     ↳ "${d.title}" ${d.date || ''}: ${(d.tried || []).join(' → ') || '—'}`));
      if ((rd.notesList || []).length) { console.log('\n   Notes on the account (newest first):'); rd.notesList.forEach((n) => console.log(`     ${(n.date || 'undated').padEnd(11)} ${n.title}${n.by ? '  — ' + n.by : ''}`)); }
      if (rd.safety) console.log(`   Safety check: scanned ${rd.safety.activityTitlesScanned ? rd.safety.activityTitlesScanned + ' activity titles + ' : ''}${rd.safety.notesListed} note titles for Do-Not-Call.`);
      if ((p.digest || []).length) { console.log('\n   🧠 WHAT THE NOTES SAY'); p.digest.forEach((d) => console.log(`     • ${d.date || 'undated'}${d.by ? ' [' + d.by + ']' : ''}: ${d.gist}`)); }
      if (p.email) console.log(`\n   ✉️  EMAIL — ${p.email.subject}\n${String(p.email.body).split('\n').map((l) => '      ' + l).join('\n')}`);
      if (p.text) console.log(`\n   📱 TEXT (${p.text.length} chars)\n      ${p.text}`);
      if (p.callScript) console.log(`\n   📞 PHONE SCRIPT\n${String(p.callScript).split('\n').map((l) => '      ' + l).join('\n')}`);
      if ((p.evidenceUsed || []).length) console.log(`\n   Based on: ${p.evidenceUsed.join(' · ')}`);
    }
    console.log('');
    process.exit(0);
  }
  // node textLog.js --notes <accountId | part of the name>   print the harvested opportunities + notes
  if (argv[0] === '--notes' && argv[1]) {
    const q = String(argv[1]).toLowerCase();
    const hv = [...readHarvest().values()].filter((h) => h.ok && (String(h.accountId).toLowerCase() === q || String(h.accountName || '').toLowerCase().includes(q)));
    if (!hv.length) console.log(`\nNo harvested data matches "${argv[1]}". (${[...readHarvest().values()].filter((h) => h.ok).length} accounts harvested so far)\n`);
    for (const h of hv) {
      console.log(`\n🗂️  ${h.accountName}  (${h.accountId})  — read ${h.at}`);
      console.log('  Opportunities:'); h.opps.forEach((o) => console.log(`    ${(o.closeDate || 'no date').padEnd(12)} ${(o.stage || '').padEnd(20)} ${o.name}`));
      console.log(`  Activity / notes (${h.notes.length}):`); h.notes.slice(0, 25).forEach((n) => console.log(`    ${(n.date || 'undated').padEnd(11)} ${n.source.padEnd(9)} ${n.text.slice(0, 120)}`));
      if (h.notes.length > 25) console.log(`    … ${h.notes.length - 25} more`);
    }
    console.log('');
    process.exit(0);
  }
  // node textLog.js --assume-shark [--force]   tag EVERY account currently on the dashboard as #shark (assumed). One-time snapshot:
  // accounts that appear later get their real list. Lost-Demo-only accounts (never contacted) are not touched.
  if (argv[0] === '--assume-shark') {
    const prior = (() => { try { return fs.readFileSync(LIST_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.assumed && r.kind === 'Shark'); } catch (_) { return []; } })();
    if (prior.length && !argv.includes('--force')) { console.log(`\nAlready done on ${prior[0].at.slice(0, 10)} (${prior[0].accounts.length} accounts). Pass --force to snapshot again.\n`); process.exit(0); }
    const ids = new Map();                      // keyed by the 15-char id, so an account the logs and the Salesforce reports both know is counted once
    const k15 = (id) => String(id).toLowerCase().slice(0, 15);
    for (const a of aggregate()) if (a.accountId) ids.set(k15(a.accountId), { id: a.accountId, name: a.accountName });
    const xr = readXref();                      // accounts only the Salesforce reports know about are on the dashboard too
    if (xr && Array.isArray(xr.accounts)) for (const x of xr.accounts) if (x.id && !ids.has(k15(x.id))) ids.set(k15(x.id), { id: x.id, name: x.name });
    const row = recordListScan({ kind: 'Shark', name: `Shark list (assumed for everything on the dashboard as of ${new Date().toLocaleDateString('en-US')})`, reportId: null, assumed: true, accounts: [...ids.values()] });
    console.log(`\n🦈 Tagged ${row ? row.accounts.length : 0} accounts #shark (assumed). Refresh the dashboard with:  node textLog.js\n`);
    process.exit(0);
  }
  // node textLog.js --shark-diff   who dropped off the Shark report between the last two reads (reps got to them first)
  // node textLog.js --closed-won     the closed-won list: account, opportunity owner, opportunity, close date
  if (argv[0] === '--closed-won') {
    const rows = [...new Set(readClosedWon().values())].sort((a, b) => (Date.parse(b.closeDate) || 0) - (Date.parse(a.closeDate) || 0));
    console.log(`\n🏆 Closed-won list — ${rows.length} account(s) with a Closed Won opportunity from the last 30 days when the bot looked (never texted)\n`);
    rows.forEach((w) => console.log(`  ${(w.closeDate || '?').padEnd(11)} ${(w.owner || 'owner not found').padEnd(24)} ${w.accountName || w.accountId}  — "${w.opp || ''}"  (found ${String(w.at).slice(0, 16)} via ${w.source || '?'})`));
    console.log('');
    process.exit(0);
  }
  // node textLog.js --industries     what the Salesforce Industry reads found so far (email --industry): how many, and the values
  if (argv[0] === '--industries' || argv[0] === '--industry') {
    const { stats: st } = industryTodo({ refresh: true });
    const m = readSfIndustry(); const c = {}; let withValue = 0, blank = 0, gone = 0, gaveUp = 0;
    for (const d of m.values()) { if (d.industry) { withValue++; c[d.industry] = (c[d.industry] || 0) + 1; } else if (d.blank) blank++; else if (d.unavailable) gone++; else if (d.misses >= 2) gaveUp++; }
    const read = withValue + blank + gone;
    console.log(`\n🏭 Industry from Salesforce — ${read.toLocaleString()} of ${st.total.toLocaleString()} dashboard accounts read (${(st.total - read).toLocaleString()} still to read: email --industry)`);
    console.log(`   ${withValue.toLocaleString()} with an industry · ${blank.toLocaleString()} empty in Salesforce · ${gone.toLocaleString()} page not available · ${gaveUp.toLocaleString()} no Industry field on the page (left alone)\n`);
    Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
    if (Object.keys(c).length > 40) console.log(`  … and ${Object.keys(c).length - 40} more values`);
    console.log('');
    process.exit(0);
  }
  if (argv[0] === '--shark-diff') {
    const allSnaps = readSnapshots().filter((x) => x.kind === 'Shark');
    if (!allSnaps.length) { console.log('\nNo Shark snapshot yet — run:  email --shark\n'); process.exit(0); }
    const newest = allSnaps[allSnaps.length - 1];
    const snaps = allSnaps.filter((x) => sameReport(x, newest));        // the same report only, oldest → newest
    const scan = newestSharkScan({ reportId: newest.reportId, name: newest.name });
    const base = snaps.length > 1 ? snaps[snaps.length - 2] : snaps[0];
    let nowIds, nowAt;
    if (snaps.length > 1) { const last = snaps[snaps.length - 1]; nowIds = new Set(last.accounts.map((a) => k15(a.id))); nowAt = last.at; }
    else if (scan && scan.at > base.at) { nowIds = scan.ids; nowAt = scan.at; }
    console.log(`\n🦈 Snapshot ${base.at.slice(0, 16)} — ${base.count} accounts from "${base.name || 'the Shark list'}"`);
    if (!nowIds) { console.log('   The report has not been read again since. Run  email --shark  later in the day to see who dropped off.\n'); process.exit(0); }
    const log = new Map(aggregate().map((a) => [k15(a.accountId || ''), a]));
    const gone = base.accounts.filter((a) => !nowIds.has(k15(a.id)));
    const ours = gone.filter((a) => { const l = log.get(k15(a.id)); return l && l.lastAt && l.lastAt >= base.at; });
    console.log(`   Read again ${nowAt.slice(0, 16)} — ${nowIds.size} accounts on the report now.`);
    console.log(`   ${gone.length} dropped off since (${ours.length} you contacted yourself; ${gone.length - ours.length} a rep probably got to first):`);
    gone.filter((a) => !ours.includes(a)).slice(0, 60).forEach((a) => console.log(`     🏃 ${a.name}  ${a.id}`));
    if (gone.length - ours.length > 60) console.log(`     … and ${gone.length - ours.length - 60} more`);
    console.log('   Every one of them is still on the dashboard (filter: "🏃 Shark snapshot — off the report").\n');
    process.exit(0);
  }
  // node textLog.js --lists   how many accounts are tagged LDS / Shark, and when each report was last read
  if (argv[0] === '--lists') {
    const mem = readListMembership(); const kinds = { LDS: 0, Shark: 0 }; const both = new Set();
    for (const [id, m] of mem) { for (const k of Object.keys(m)) kinds[k] = (kinds[k] || 0) + 1; if (m.LDS && m.Shark) both.add(id); }
    console.log(`\n📋 Lists — accounts seen on LDS reports: ${kinds.LDS}, on Shark reports: ${kinds.Shark}, on both: ${both.size}`);
    try { for (const l of fs.readFileSync(LIST_FILE, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).slice(-8)) console.log(`   ${l.at.slice(0, 16)}  ${String(l.kind).padEnd(5)} ${l.name || '(unnamed report)'}  — ${l.accounts.length} accounts`); } catch (_) { console.log('   (no report has been scanned yet — run: email --lists)'); }
    console.log('');
    process.exit(0);
  }
  // node textLog.js --add-lead <Salesforce account link or id> […] --tag shark,lds,referral   a lead you worked by hand (stage 1 done by you), #tagged with its kind, tracked for stage 2 (manualShark.js)
  // node textLog.js --tag-lead <link or id> --tag lds   change its tags  ·  --remove-lead <link or id>   take it back out  ·  --manual-leads   who was added, and when stage 2 starts
  // (--add-shark / --remove-shark / --manual-shark are the first names of the same three: --add-shark means --tag shark)
  if (['--add-lead', '--tag-lead', '--remove-lead', '--manual-leads', '--nurture-lead', '--set-board', '--graduate-nurture', '--add-shark', '--remove-shark', '--manual-shark'].includes(argv[0])) {
    const res = require('./manualShark').cli(argv);
    if (res.changed) console.log('dashboard written:', generateDashboard());
    process.exit(res.code);
  }
  // node textLog.js --dnc <email> […] [--why "reason"] [--dry-run]   put an email address on the do-not-contact list: every account that uses it, both id forms (dncByEmail.js)
  if (argv[0] === '--dnc') {
    const res = require('./dncByEmail').cli(argv.slice(1));
    if (res.changed) console.log('dashboard written:', generateDashboard());
    process.exit(res.code);
  }
  if (argv[0] === '--banlist') {
    const bans = readBans(); const green = readGreen();
    console.log(`\n🚫 Banlist — ${[...bans.keys()].filter((k) => !green.has(k)).length} active, ${green.size} on the green banlist\n`);
    for (const [k, b] of bans) console.log(`  ${green.has(k) ? '🟢 GREEN' : '🚫 BANNED'}  ${b.accountName || '(unnamed)'}  ${b.accountId}  — ${b.reason || ''}`);
    console.log('');
    process.exit(0);
  } else if (argv[0] === '--ban' && argv[1]) {
    const a = aggregate().find((x) => idKey(x.accountId) === idKey(argv[1]));
    console.log(recordBan({ accountId: argv[1], accountName: a && a.accountName, reason: argv[2] || 'manual ban', source: 'manual' }) ? 'banned' : 'already banned');
  } else if (argv[0] === '--green' && argv[1]) {
    const b = readBans().get(idKey(argv[1]));
    recordGreen({ accountId: argv[1], accountName: b && b.accountName, reason: argv[2] || 'cleared by operator' });
    console.log('added to green banlist');
  }
  if (argv[0] === '--reengage' && argv[1]) {
    recordReengage({ key: argv[1], accountName: (aggregate().find((a) => a.key === argv[1]) || {}).accountName, stage: argv[2] || '', note: argv[3] });
  } else if (argv[0] === '--import-notes' && argv[1]) {
    let n = 0;
    for (const l of fs.readFileSync(argv[1], 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (recordReengage(r)) n++; } catch (_) {}
    }
    console.log('imported notes:', n);
  }
  const p = generateDashboard();
  console.log('dashboard written:', p);
}
