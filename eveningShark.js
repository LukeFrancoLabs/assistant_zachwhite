'use strict';

/**
 * eveningShark — "text tomorrow's Shark list TONIGHT", so the pros never post and three reps never pile onto them.
 *
 * WHY. The Shark report (T14 Shark List All) is a one-night batch: at midnight it posts the pros whose "Last Communication DateTime" is
 * exactly 15 calendar days old (every row of every weekday morning snapshot we have is 15 days old), and then three reps text the same
 * pro at once. A text that reaches the pro's account BEFORE that midnight moves the last communication to today, so the pro never posts.
 *
 * WHAT. `email --evening` reads a COPY of the Shark report whose day filter is one day earlier, keeps the pros whose last
 * communication is 14 days old (tonight's batch) and texts each at 7:00 PM in THEIR OWN time zone (7:00 PM ET … 10:00 PM ET for Pacific;
 * TCPA closes at 8:00 PM local, and nothing is sent in the 45 minutes before the report's midnight). It is built to be left alone:
 *   - one confirm at the start, then no prompts;
 *   - its own Chrome (port 9330, own profile) that run.sh never restarts while it is healthy;
 *   - a watchdog: every few minutes it checks the port, the tab and the Salesforce login, relaunches Chrome / reopens a tab when it must,
 *     and keeps the Salesforce session warm between batches (a logged-out Salesforce cannot be fixed by the bot: it says so and keeps trying);
 *   - the list is saved (evening-queue.json): starting the same command again carries on, and the once-a-day guard + contact ledger in
 *     runReportCampaign make a second text to the same pro impossible;
 *   - evening-status.json is a heartbeat (`email --evening --inspect` reads it);
 *   - the next morning's --shark backup says how many of last night's pros posted anyway (noteMorning).
 * Same rules as every first-touch text: banlist, current customers and closed-won left out, each pro only inside their own hours (tcpa.js).
 *
 * Nothing here talks to the browser or to texts directly: Assistant.js hands in the pieces (scan, runBatch, ask …), so every part runs
 * against fakes (see the tests in the scratchpad) and nothing is ever sent from a test.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn, execFile } = require('child_process');
const tcpa = require('./tcpa');

const DIR = process.env.ASSISTANT_EVENING_DIR || __dirname;                 // tests point this at a scratch folder
const PORT = 9330;                                                // its own Chrome: no other mode maps to this port, so no other run can kill it
const PROFILE_DIR = '.browser-profile-evening';
const REPORT_ZONE = process.env.EVENING_REPORT_ZONE || 'America/New_York';   // the zone the report's dates and its midnight are in (report cells are Eastern)
const POST_AGE = 15;                                              // a pro posts at the midnight that makes its last communication this many calendar days old
const SOURCE = { kind: 'Shark', name: 'Evening shark' };
const FILES = {
  queue: path.join(DIR, 'evening-queue.json'),
  status: path.join(DIR, 'evening-status.json'),
  history: path.join(DIR, 'evening-history.jsonl'),
  config: path.join(DIR, 'evening-config.json'),
  lock: path.join(DIR, 'evening.lock'),
};
const DEFAULTS = {
  at: '19:00',                    // each pro's own clock
  marginMin: 45,                  // nothing is sent in the last 45 minutes before the report's midnight: the text must show on the account first
  perTextSec: 30,                 // measured: the median gap between our texts in report / queue runs is 30 s
  pollMs: 30 * 1000,
  healthEveryMs: 4 * 60 * 1000,
  keepAliveEveryMs: 8 * 60 * 1000,
  verifyAfterMin: 20,
  stallMs: 4 * 60 * 1000,         // a batch that has neither started nor finished a text in this long is frozen (a text takes ~30 s; a crashed tab never answers, and nothing times out inside textAccount)
  stopBeforeMs: 40 * 1000,        // a text that starts now lands 20-30 s later: nothing is started in the last 40 s of a pro's window
  passGapMs: 15 * 1000,           // wait before another pass over pros that were reached but not sent…
  passGapTroubledMs: 90 * 1000,   // …and before another pass after a batch that ended early (an error, the offline guard, a frozen tab)
  maxTries: 3,                    // passes a pro is REACHED on before it is given up
  errorsBeforeWarning: 6,         // batches in a row that fail before the Mac is told to get your attention (it keeps trying until the windows close)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const defaultLog = (icon, action, detail = '') => console.log(`  ${icon} ${String(action).toUpperCase().padEnd(20)}${detail}`.trimEnd());

// ============================================================================
// Clock helpers — every function takes the time it should use, so a test can run a whole evening in milliseconds
// ============================================================================
const WALL = new Map();
function wall(date, tz) {
  if (!WALL.has(tz)) WALL.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  return WALL.get(tz).formatToParts(date).reduce((o, p) => { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); return o; }, {});
}
const offsetMs = (date, tz) => { const w = wall(date, tz); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(date.getTime() / 1000) * 1000; };
/** The instant the clock in `tz` reads hh:mm on calendar day `day` (YYYY-MM-DD). */
function instantAt(day, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number); const [y, mo, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);                          // a second pass settles a daylight-saving edge
  return new Date(t);
}
const dayOf = (date, tz = REPORT_ZONE) => tcpa.localDay(date, tz);                // YYYY-MM-DD on that zone's calendar
const dayNum = (day) => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const addDays = (day, n) => new Date((dayNum(day) + n) * 864e5).toISOString().slice(0, 10);
const clock = (d) => (d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: REPORT_ZONE, timeZoneName: 'short' }) : '—');
const prettyAt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const span = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
/** "10/13/2026 3:12 PM" (a report cell) → "2026-10-13". Only the DATE matters here. */
function stampDay(s) { const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null; }

/** "7pm" / "7:30pm" / "19:00" / "19" → "19:00", or null when it is not a clock time. This is an EVENING mode, so a bare 1-11 ("--at 6") means PM. */
function parseClock(s) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m?)?\s*$/i.exec(String(s || ''));
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (m[3]) { const pm = /^p/i.test(m[3]); if (h < 1 || h > 12) return null; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  else if (h >= 1 && h <= 11) h += 12;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The flags this mode owns (the rest — --template, --yes, --dry-run, --until, --max-texts, --unknown-zone — are parsed by Assistant.js). */
function parseFlags(argv) {
  const f = { at: DEFAULTS.at, marginMin: DEFAULTS.marginMin, perTextSec: DEFAULTS.perTextSec, postAge: POST_AGE, verify: true, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--at') { const c = parseClock(argv[++i]); if (!c) f.error = `--at needs a clock time such as 7pm or 19:00 (got "${argv[i] || ''}")`; else f.at = c; }
    else if (a === '--margin') { const n = parseInt(argv[++i], 10); if (Number.isFinite(n) && n >= 0 && n <= 600) f.marginMin = n; else f.error = '--margin is minutes before the report posts (0-600)'; }
    else if (a === '--per-text') { const n = parseFloat(argv[++i]); if (n > 0) f.perTextSec = n; }
    else if (a === '--post-age') { const n = parseInt(argv[++i], 10); if (n >= 2 && n <= 60) f.postAge = n; else f.error = '--post-age is the number of days (2-60) a pro is old when the report posts it'; }
    else if (a === '--no-verify') f.verify = false;
  }
  const h = parseInt(f.at, 10);
  if (!f.error && (h < tcpa.WINDOW.knownStartHour || h >= tcpa.WINDOW.endHour)) f.error = `--at ${f.at} is outside the texting hours (${tcpa.WINDOW.knownStartHour}:00-${tcpa.WINDOW.endHour}:00 their time)`;
  return f;
}

// ============================================================================
// Tonight's batch and when each pro is texted
// ============================================================================
/**
 * Which rows of the report post at the NEXT midnight? A row's age is today's date minus the date of its "Last Communication DateTime"
 * (both on the report's calendar); the pros that post tonight are 14 days old now.
 * → { tonight:[lead], ages:{ '14': n, '15': n … }, noColumn, blank, today, batchDay }
 */
function tonightsBatch(leads, now = new Date(), { postAge = POST_AGE } = {}) {
  const today = dayOf(now);
  const ages = {}; const tonight = []; let noColumn = 0, blank = 0;
  for (const l of leads || []) {
    const key = Object.keys(l.cols || {}).find((k) => /last\s*communication/i.test(k));
    if (!key) { noColumn++; continue; }
    const d = stampDay(l.cols[key]);
    if (!d) { blank++; continue; }
    const age = dayNum(today) - dayNum(d);
    ages[age] = (ages[age] || 0) + 1;
    if (age === postAge - 1) tonight.push(l);
  }
  return { tonight, ages, noColumn, blank, today, batchDay: addDays(today, -(postAge - 1)) };
}

/** The zone(s) of a report row: its own Timezone cell first (the freshest), else what we saved earlier, else null (unknown). */
function zonesOf(lead, textLog) {
  const k = Object.keys(lead.cols || {}).find((x) => /time\s*-?\s*zone|timezone|^tz\b/i.test(x));
  const z = k ? tcpa.parseZone(lead.cols[k]) : null;
  if (z) return [z];
  const saved = textLog && textLog.zonesFor ? textLog.zonesFor(lead.accountId) : null;
  return saved && saved.length ? saved : null;
}
const zoneLabel = (zs) => (zs && zs.length ? zs.map((z) => tcpa.ZONE_SHORT[z] || z).join('/') : 'no zone');

/**
 * When a pro in `zones` is texted tonight (calendar day `day` on the report's calendar):
 *   at       = 7:00 PM their own time (a pro in several zones: the EASTERNMOST 7:00 PM, so every other zone is still open) — moved later if
 *              their texting hours open after it, never earlier
 *   deadline = the earlier of their 8:00 PM close and `marginMin` minutes before the report's midnight
 *   ok       = false when no minute between the two is inside their hours (a Sunday, or Hawaii, whose 7:00 PM is after the report posts)
 * An unknown zone is judged on the all-US window (12:00-8:00 PM Eastern), like every first-touch text.
 */
function slot(zones, day, { at = DEFAULTS.at, marginMin = DEFAULTS.marginMin } = {}) {
  const known = zones && zones.length ? zones : null;
  const tzs = known || [tcpa.WINDOW.zones[0]];
  const want = new Date(Math.min(...tzs.map((z) => instantAt(day, at, z).getTime())));
  const close = new Date(Math.min(...tzs.map((z) => instantAt(day, `${tcpa.WINDOW.endHour}:00`, z).getTime())));
  const rollover = instantAt(addDays(day, 1), '00:00', REPORT_ZONE);
  const deadline = new Date(Math.min(close.getTime(), rollover.getTime() - marginMin * 60000));
  const gate = known ? tcpa.checkZones(known, want) : tcpa.check(want);
  let start = want;
  if (!gate.ok) {                                                                 // closed at `want` (a Sunday, or an early --at): the first minute their hours open after it
    const open = tcpa.openingFor(known, new Date(want.getTime() - 60000));        // (searched in 15-minute steps, so it is only asked when `want` itself is closed)
    start = open && open.getTime() > want.getTime() ? open : null;
  }
  if (!start || start.getTime() >= deadline.getTime()) return { at: start || want, deadline, ok: false, reason: gate.ok ? 'no texting time left before the report posts' : gate.reason };
  return { at: start, deadline, ok: true, reason: null };
}

/** Pros the Shark text rules never touch: do-not-contact, closed-won, current customers; one row per account. → { kept, dropped } */
function screen(leads, textLog, { unknownZone = 'strict' } = {}) {
  const bans = textLog.readBans(), green = textLog.readGreen(), won = textLog.readClosedWon(), cust = textLog.readCurrentCustomers();
  const dropped = { noId: 0, dup: 0, banned: 0, won: 0, customers: 0, noZone: 0 };
  const seen = new Set(); const kept = [];
  for (const l of leads) {
    const k = k15(l.accountId);
    if (!k) { dropped.noId++; continue; }
    if (seen.has(k)) { dropped.dup++; continue; }
    seen.add(k);
    if (textLog.isBanned(l.accountId, bans, green)) { dropped.banned++; continue; }
    if (won.has(k) || won.has(String(l.accountId).toLowerCase())) { dropped.won++; continue; }
    if (cust.has(k) || cust.has(String(l.accountId).toLowerCase())) { dropped.customers++; continue; }
    if (unknownZone === 'hold' && !zonesOf(l, textLog)) { dropped.noZone++; continue; }
    kept.push(l);
  }
  return { kept, dropped };
}

/** Per-zone summary of entries for the plan: [{ label, at, deadline, n, estMin, fits }] earliest first. Only `pending` entries count. */
function groupsOf(entries, now, perTextSec = DEFAULTS.perTextSec) {
  const m = new Map();
  for (const e of entries) {
    if (e.status !== 'pending') continue;
    const key = `${e.zoneLabel}|${e.at}`;
    const g = m.get(key) || { label: e.zoneLabel, at: new Date(e.at), deadline: new Date(e.deadline), n: 0 };
    g.n++; m.set(key, g);
  }
  return [...m.values()].sort((a, b) => a.at - b.at).map((g) => {
    const from = Math.max(now.getTime(), g.at.getTime());
    return { ...g, estMin: Math.ceil((g.n * perTextSec) / 60), fits: Math.max(0, Math.floor((g.deadline.getTime() - from) / (perTextSec * 1000))) };
  });
}

function printPlan(entries, now, flags, extra = {}) {
  const groups = groupsOf(entries, now, flags.perTextSec);
  for (const g of groups) {
    const late = g.n > g.fits;
    console.log(`     ${g.label.padEnd(9)}${String(g.n).padStart(4)} pro(s)   ${clock(g.at).padEnd(13)}~${String(g.estMin).padStart(2)} min   stops ${clock(g.deadline)}${late ? `   ⚠️ only ~${g.fits} fit before then — start earlier (--at 6pm)` : ''}`);
  }
  const by = (st) => entries.filter((e) => e.status === st);
  const blocked = by('blocked'), missed = by('missed');
  if (blocked.length) console.log(`     can't be texted tonight: ${blocked.length} (${[...new Set(blocked.map((e) => e.reason))].join('; ')}) — they post at midnight and the morning run handles them`);
  if (missed.length) console.log(`     too late already: ${missed.length} (their window closed before this run started)`);
  const d = extra.dropped;
  if (d) {
    const parts = [['do-not-contact', d.banned], ['current customers', d.customers], ['closed-won', d.won], ['no time zone (--unknown-zone hold)', d.noZone], ['no account id', d.noId], ['duplicates', d.dup], ['over --max-texts', extra.overCap || 0]].filter(([, n]) => n);
    if (parts.length) console.log(`     left out: ${parts.map(([k, n]) => `${n} ${k}`).join(' · ')}`);
  }
  return groups;
}

// ============================================================================
// Saved state: the list, the heartbeat, the history, the lock
// ============================================================================
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJson(file, obj) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }   // a rename is atomic: a reader never sees half a file
function appendHistory(row) { try { fs.appendFileSync(FILES.history, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); } catch (_) {} }
function readHistory() { try { return fs.readFileSync(FILES.history, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }

function writeStatus(patch, now = new Date()) {
  const cur = readJson(FILES.status, {}) || {};
  try { writeJson(FILES.status, { ...cur, ...patch, pid: process.pid, updatedAt: now.toISOString() }); } catch (_) {}
}

/** One evening run at a time: a second start (or a --dry-run) while a live one is going would drive the same Chrome tab. */
let lockHooked = false;
function acquireLock(log = defaultLog) {
  const cur = readJson(FILES.lock, null);
  if (cur && cur.pid && cur.pid !== process.pid) {
    let alive = false; try { process.kill(cur.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    const since = Date.parse(cur.since);
    const beforeBoot = Number.isFinite(since) && Date.now() - since > os.uptime() * 1000 + 60000;       // written before the last restart of the Mac: that pid is some other program now
    if (alive && !beforeBoot) {
      const st = readJson(FILES.status, {}) || {};
      log('⛔', 'Already running', `an evening run is already going (pid ${cur.pid}, started ${cur.since || '?'}${st.updatedAt ? `, last heartbeat ${span(Date.now() - Date.parse(st.updatedAt))} ago` : ''}). Nothing was started. Ctrl-C that one first if you want to restart it.`);
      return false;
    }
  }
  try { writeJson(FILES.lock, { pid: process.pid, since: new Date().toISOString() }); } catch (_) {}
  if (!lockHooked) { lockHooked = true; process.once('exit', releaseLock); }                  // however the run ends (a crash, a second Ctrl-C) the lock goes with it
  return true;
}
function releaseLock() { try { const cur = readJson(FILES.lock, null); if (cur && cur.pid === process.pid) fs.unlinkSync(FILES.lock); } catch (_) {} }

function notifyMac(msg, title = 'Pipeline Assistant evening run') {
  try { process.stdout.write('\x07'); } catch (_) {}
  if (process.platform !== 'darwin') return;
  try { execFile('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title ${JSON.stringify(title)} sound name "Glass"`], () => {}); } catch (_) {}
}

// ============================================================================
// The watchdog: keep Chrome, its tab and the Salesforce login alive while nobody is at the Mac
// ============================================================================
function within(p, ms, what) {
  let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer in ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(t));   // a tab that crashed mid-call never settles: every browser await gets a timeout
}
function portAlive(port = PORT, ms = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: ms }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
/** Same test as waitForSalesforceLogin: a logged-in Lightning page, not Okta / a sign-in bounce. */
const isLoggedInUrl = (u) => /^https:\/\/[^/]*lightning\.force\.com\/(lightning|one\/one\.app)(\/|$|[?#])/.test(u || '') && !/okta|login|saml|secur\/frontdoor/i.test(u || '');
const isSignInUrl = (u) => /okta|login|saml|secur\/frontdoor|\/identity\/|sso\./i.test(u || '');

/** Kills the process LISTENING on `port` (the Chrome), never a client that merely has a connection to it. */
function killListenerDefault(port) {
  return new Promise((resolve) => execFile('/bin/sh', ['-c', `lsof -ti tcp:${Number(port)} -sTCP:LISTEN | xargs kill -9`], () => resolve()));
}

/** Starts the same Chrome run.sh starts (start-browser.js frees the port first and reuses the profile, so the Salesforce cookies stay). */
function spawnBrowserDefault({ port = PORT, profileDir = PROFILE_DIR } = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'start-browser.js')], { cwd: __dirname, detached: true, stdio: 'ignore', env: { ...process.env, CDP_PORT: String(port), PROFILE_DIR: profileDir } });
  child.unref();
  return child;
}

/**
 * The browser the run drives, with the checks and repairs around it.
 *   health()      → { ok } or { ok:false, kind: 'port' | 'connect' | 'tab' | 'away' | 'login', why }
 *   recover(kind) → the same shape after the repair: relaunch Chrome (port / connect), open a fresh tab (tab), go back to Salesforce (away),
 *                   try the home page again (login — an Okta that wants a person stays 'login')
 *   keepAlive()   → loads the Salesforce home page so the session does not idle out between batches
 *   close()       → lets go of the link to Chrome at the end of the run (Chrome keeps running)
 *   page()        → the tab to text in right now (it changes after a repair)
 * `connect(url)` and `spawnBrowser()` are swappable so a test can use a throwaway headless Chromium on a scratch port.
 */
function createSession(o) {
  const port = o.port || PORT;
  const startUrl = o.startUrl || 'https://housecallpro.lightning.force.com/';
  const wait = o.wait || sleep;
  const connect = o.connect || ((url) => require('playwright').chromium.connectOverCDP(url));
  const spawnBrowser = o.spawnBrowser || (() => spawnBrowserDefault({ port, profileDir: o.profileDir || PROFILE_DIR }));
  const killListener = o.killListener || killListenerDefault;
  const loggedIn = o.isLoggedInUrl || isLoggedInUrl;
  const signedOut = o.isSignInUrl || isSignInUrl;
  const portUp = o.portAlive || portAlive;
  let context = o.context || null;
  let page = o.page || null;
  let connected = !!context;
  const watch = (c) => { try { const b = c && c.browser && c.browser(); if (b && b.on) b.on('disconnected', () => { connected = false; }); } catch (_) {} };
  watch(context);

  const pickPage = () => {
    let pages = []; try { pages = context ? context.pages() : []; } catch (_) {}
    pages = pages.filter((p) => { try { return !p.isClosed(); } catch (_) { return false; } });
    return pages.find((p) => p === page) || pages.find((p) => /lightning\.force\.com/.test(p.url())) || pages[0] || null;
  };

  async function relaunch() {
    // start-browser.js frees the port with `lsof -ti :PORT | xargs kill -9`, which kills EVERY process with a socket on it — this run included, if Chrome is hung
    // rather than dead and our link to it is still open. So: let go of the link, kill only the process LISTENING on the port, then start the new one.
    try { const b = context && context.browser && context.browser(); if (b) await within(b.close(), 5000, 'the old connection'); } catch (_) {}
    context = null; connected = false; page = null;
    await killListener(port);
    await wait(1000);
    await spawnBrowser();
    for (let i = 0; i < 45 && !(await portUp(port)); i++) await wait(1500);
    if (!(await portUp(port))) throw new Error(`Chrome did not come back on port ${port}`);
    await wait(2000);
    const browser = await within(connect(`http://127.0.0.1:${port}`), 30000, 'Chrome (reconnect)');
    context = browser.contexts()[0] || await browser.newContext();
    connected = true; watch(context); page = null;
  }

  async function health() {
    if (!(await portUp(port))) return { ok: false, kind: 'port', why: `Chrome is not answering on port ${port}` };
    if (!context || !connected) return { ok: false, kind: 'connect', why: 'the bot lost its link to Chrome' };
    const p = pickPage();
    if (!p) return { ok: false, kind: 'tab', why: 'Chrome has no open tab (the window was closed)' };
    try { await within(require('./clickGuard').pinViewport(p), 6000, 'the page size'); } catch (_) {}      // once per tab: a screenshot would otherwise re-lay the page out at the real (maybe narrow) window size mid-run
    let url;
    try { url = await within(p.evaluate(() => location.href), 12000, 'the Salesforce tab'); }
    catch (e) { return { ok: false, kind: 'tab', why: `the tab is frozen or crashed (${e.message})` }; }
    if (loggedIn(url)) { page = p; return { ok: true }; }
    if (signedOut(url)) return { ok: false, kind: 'login', why: 'Salesforce is signed out (the tab is on the sign-in page)' };
    return { ok: false, kind: 'away', why: `the tab is not on Salesforce (${String(url).slice(0, 60)})` };
  }

  async function recover(kind) {
    let k = kind;
    try {
      if (kind === 'port' || kind === 'connect') { await relaunch(); k = 'away'; }   // a Chrome that is up again is NOT restarted a second time because Salesforce is unreachable
      let p = pickPage();
      const old = kind === 'tab' ? p : null;
      if (!p || kind === 'tab') p = await within(context.newPage(), 20000, 'a new tab');
      try { await within(require('./clickGuard').pinViewport(p), 6000, 'the page size'); } catch (_) {}      // a new tab has no fixed size (the real window's): give it the same 1920x1080 as the first one
      await within(p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }), 60000, 'Salesforce');
      await wait(5000);                                                          // let Lightning finish rendering before it is driven
      if (old && old !== p) { try { await within(old.close(), 8000, 'the old tab'); } catch (_) {} }
      page = p;
      return await health();
    } catch (e) { return { ok: false, kind: k, why: e.message }; }
  }

  /** Lets go of the link to Chrome (Chrome itself keeps running). A link opened by a relaunch is not the one Assistant.js closes, and it would keep this process alive. */
  async function close() {
    try { const b = context && context.browser && context.browser(); if (b) await within(b.close(), 5000, 'closing the link to Chrome'); } catch (_) {}
    context = null; connected = false; page = null;
  }

  async function keepAlive() {
    const p = pickPage(); if (!p) return;
    try { await within(p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }), 45000, 'Salesforce home'); } catch (_) {}
  }

  return { health, recover, keepAlive, close, page: () => page || pickPage(), context: () => context };
}

// ============================================================================
// The evening run
// ============================================================================
/**
 * o = { flags, args, message, textLog, scan, rescan, runBatch, session, ask, log, notify, now, wait, noSignals, noKeepAwake, rememberReport }
 *   scan()                 → { leads, reportUrl, source } | null          (reads the report; may prompt — Luke is at the Mac for this part)
 *   rescan()               → leads                                         (reads it again with no prompt, for the lag check)
 *   runBatch(page, opts)   → { sentCount, sentIds }                        (runReportCampaign)
 *   session                → createSession(...) or a fake
 *   message                → { message, templateName, templateKey } | null (null only for a --dry-run)
 * Everything after the confirm is hands-off.
 */
async function runEvening(o) {
  const { flags, args = {}, textLog, scan, rescan, runBatch, session, message } = o;
  const log = o.log || defaultLog;
  const now = o.now || (() => new Date());
  const wait = o.wait || sleep;
  const notify = o.notify || notifyMac;
  const ask = o.ask || (async () => 'y');
  const dry = !!args.dryRun;
  const unknownZone = args.unknownZone === 'hold' ? 'hold' : 'strict';
  const t0 = now();
  const day = dayOf(t0);
  const rollover = instantAt(addDays(day, 1), '00:00', REPORT_ZONE);
  const slotOpts = { at: flags.at, marginMin: flags.marginMin };
  const until = o.until || null;
  const stopBeforeMs = o.stopBeforeMs != null ? o.stopBeforeMs : DEFAULTS.stopBeforeMs;
  const stallMs = o.stallMs || Math.max(DEFAULTS.stallMs, 3 * (Number.isFinite(args.delayMs) ? args.delayMs : 0) + 120000);   // (a --delay that is not a number must not switch the watchdog off)
  const isPast = (e, t) => t.getTime() >= Date.parse(e.deadline) - stopBeforeMs;                    // nothing is started in the last seconds of a pro's window

  log('🌙', 'Evening run', `tonight is ${day}; the Shark report posts its next batch at ${clock(rollover)} (in ${span(rollover - t0)})${dry ? ' — --dry-run: nothing is sent and no list is saved' : ''}`);
  if (rollover.getTime() - flags.marginMin * 60000 <= t0.getTime()) { log('⏰', 'Too late', `the report posts at ${clock(rollover)} and texts stop ${flags.marginMin} min before it — nothing can be pre-empted tonight. Run it earlier tomorrow.`); return { tooLate: true }; }

  // ---- 1. read the report and pick out tonight's batch -----------------------------------------------------------------------------
  const scanned = await scan();
  if (!scanned) return { aborted: true };
  const { tonight, ages, noColumn, blank, batchDay } = tonightsBatch(scanned.leads, t0, { postAge: flags.postAge });
  const ageLine = Object.keys(ages).map(Number).sort((a, b) => a - b).map((a) => `${a} days: ${ages[a]}`).join(' · ');
  log('📊', 'Report ages', `${scanned.leads.length} row(s) read — by days since the last communication → ${ageLine || '(none readable)'}`);
  if (noColumn === scanned.leads.length && scanned.leads.length) { log('⚠️', 'No date column', 'this report has no "Last Communication DateTime" column, so tonight\'s batch cannot be picked out. Add that column to the copy of the Shark report (it is on the original).'); return { noColumn: true }; }
  if (!tonight.length) {
    const sameAsT14 = ages[flags.postAge] && !ages[flags.postAge - 1];
    log('ℹ️', 'Nothing for tonight', sameAsT14
      ? `every row is already ${flags.postAge} days old — this looks like the normal T14 report. Open the COPY whose day filter is one day earlier (rows 14 days old), then run it again.`
      : `no pro has a last communication on ${batchDay} (14 days ago), so nobody posts at midnight${scanned.leads.length ? '' : ' — the report came back empty, let it finish loading and try again'}.`);
    return { empty: true, ages };
  }
  if (scanned.reportUrl && o.rememberReport) o.rememberReport(scanned);

  const { kept, dropped } = screen(tonight, textLog, { unknownZone });
  const entriesNew = kept.map((l) => {
    const zones = zonesOf(l, textLog); const s = slot(zones, day, slotOpts);
    const key = Object.keys(l.cols || {}).find((k) => /last\s*communication/i.test(k));
    return { accountId: l.accountId, name: l.name, url: l.url, lastOutgoingSms: l.lastOutgoingSms || null, lastComm: key ? l.cols[key] : null, zones, zoneLabel: zoneLabel(zones), at: s.at.toISOString(), deadline: s.deadline.toISOString(), status: s.ok ? 'pending' : 'blocked', reason: s.ok ? null : s.reason, tries: 0, textedAt: null };
  });

  // ---- 2. merge with tonight's saved list (a restart keeps what was already texted) -------------------------------------------------
  const prev = dry ? null : readJson(FILES.queue, null);
  const same = prev && prev.day === day ? prev : null;
  const byId = new Map(((same && same.entries) || []).map((e) => [k15(e.accountId), e]));
  const entries = [];
  const used = new Set();
  for (const n of entriesNew) {
    const old = byId.get(k15(n.accountId)); used.add(k15(n.accountId));
    entries.push(old && old.status === 'texted' ? old : n);        // only a text that went out is final: everything else (not sent, over --max-texts, window missed) is worked out again
  }
  for (const [k, old] of byId) if (!used.has(k) && old.status === 'texted') entries.push(old);   // texted earlier and no longer on the report (it updated): keep the record. A pro that is no longer in tonight's batch and was NOT texted (someone else reached them) is dropped, never revived
  let overCap = 0;
  if (args.maxTexts) {
    let left = args.maxTexts - entries.filter((e) => e.status === 'texted').length;
    for (const e of entries) if (e.status === 'pending') { if (left > 0) left--; else { e.status = 'skipped'; e.reason = `over --max-texts ${args.maxTexts}`; overCap++; } }
  }
  const t1 = now();
  for (const e of entries) if (e.status === 'pending' && isPast(e, t1)) { e.status = 'missed'; e.reason = 'its texting window had already closed'; }

  const pending = entries.filter((e) => e.status === 'pending');
  log('🌙', 'Tonight', `${tonight.length} pro(s) post at midnight (their last communication was ${batchDay}) — ${pending.length} can be texted${entries.length - pending.length ? `, ${entries.length - pending.length} cannot` : ''}`);
  printPlan(entries, t1, flags, { dropped, overCap });
  if (!pending.length) { log('ℹ️', 'Nothing to text', 'nobody in tonight\'s batch can be texted (see above).'); return { texted: 0, entries: entries.length }; }

  if (dry) {
    console.log(`\n     first ${Math.min(12, pending.length)}:`);
    pending.slice(0, 12).forEach((e, i) => console.log(`       ${String(i + 1).padStart(2)}. ${e.name}  — ${e.zoneLabel} · last contact ${e.lastComm || '?'}`));
    if (message) console.log(`\n     text: "${message.message}"`);
    console.log(`\n  🧪 --dry-run: nothing was sent and no list was saved. To run it for real (start it BEFORE you leave):\n       email --evening --template N\n`);
    return { dry: true, pending: pending.length };
  }
  if (!message) { log('⚠️', 'No text', 'pick a template (--template N) — nothing sent.'); return { noMessage: true }; }

  const queueDoc = { day, scannedAt: t1.toISOString(), at: flags.at, report: { url: scanned.reportUrl || null, name: (scanned.source && scanned.source.name) || null }, template: message.templateName, entries };

  // ---- 3. one confirm, then hands-off -----------------------------------------------------------------------------------------------
  if (!args.yes) {
    const firstAt = pending.map((e) => e.at).sort()[0], lastAt = pending.map((e) => e.at).sort().pop();
    const ans = (await ask(`\n  ▶️  Text "${message.templateName}" to ${pending.length} pro(s) tonight, each at ${prettyAt(flags.at)} in THEIR OWN time zone (${clock(new Date(firstAt))}${firstAt === lastAt ? '' : ` … ${clock(new Date(lastAt))}`}), with nobody at the computer? (y/N) `)).toLowerCase();
    if (ans !== 'y' && ans !== 'yes') { log('🛑', 'Mission aborted', 'Nothing sent'); return { aborted: true }; }
  }
  writeJson(FILES.queue, queueDoc);
  log('🔒', 'Leave running', 'this Terminal tab and the Chrome window (it repairs itself if it crashes or a tab closes); the Mac stays awake. Ctrl-C stops after the text it is on.');
  if (!o.noKeepAwake && process.platform === 'darwin') { try { spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); log('☕', 'Keep awake', 'the Mac stays awake while this runs'); } catch (_) {} }

  let stop = false;
  const onInt = () => { if (stop) process.exit(130); stop = true; log('🛑', 'Stopping', 'after the text it is on (Ctrl-C again quits now)'); };
  if (!o.noSignals) process.on('SIGINT', onInt);

  let recoveries = 0, lastHealth = now().getTime(), lastKeep = now().getTime(), batchErrors = 0, lastSentAt = null, attention = null;   // attention: a problem only a person can fix, shown on the heartbeat
  const counts = () => { const c = { pending: 0, texted: 0, failed: 0, missed: 0, blocked: 0, skipped: 0 }; for (const e of entries) c[e.status] = (c[e.status] || 0) + 1; return c; };
  const save = (extra = {}) => { Object.assign(queueDoc, extra); try { writeJson(FILES.queue, queueDoc); } catch (_) {} };
  const beat = (state, note, extra = {}) => writeStatus({ state: attention ? 'needs-attention' : state, day, note: attention || note, counts: counts(), recoveries, ...extra }, now());
  const told = new Map();                                                       // the same problem is announced at most once an hour (it is a notification on the Mac, not a log line)
  const tell = (msg) => { const t = now().getTime(); if (!(told.has(msg) && t - told.get(msg) < 60 * 60000)) { told.set(msg, t); try { notify(msg); } catch (_) {} } };

  /** While waiting: the health check every few minutes, the Salesforce keep-alive on its own timer (a health check only reads the tab; it is not activity). */
  async function tick(why) {
    const tt = now().getTime();
    if (tt - lastHealth >= DEFAULTS.healthEveryMs) { lastHealth = tt; await ensureReady(why); }
    if (tt - lastKeep >= DEFAULTS.keepAliveEveryMs) { lastKeep = tt; try { await session.keepAlive(); } catch (_) {} }
  }

  /** Check Chrome / the tab / the login and repair what can be repaired. → true when texting can go ahead. */
  async function ensureReady(why) {
    let h;
    try { h = await session.health(); } catch (e) { h = { ok: false, kind: 'tab', why: e.message }; }
    if (h.ok) { attention = null; return true; }
    for (let attempt = 1; attempt <= 3 && !h.ok; attempt++) {
      recoveries++;
      log('🛠️', 'Repairing', `${h.why} (${why}) — attempt ${attempt}`);
      try { h = await session.recover(h.kind); } catch (e) { h = { ok: false, kind: h.kind, why: e.message }; }
      if (!h.ok && h.kind === 'login') break;                                    // only a person can sign in
    }
    if (h.ok) { attention = null; log('✅', 'Repaired', 'Chrome and Salesforce are back'); beat('waiting', 'repaired'); return true; }
    attention = h.kind === 'login' ? `Salesforce is signed out — sign in to the Chrome window on port ${PORT}. The run carries on by itself once you do.` : `could not repair: ${h.why}`;
    log('⛔', 'Needs you', attention);
    beat('needs-attention', attention); tell(`Evening run needs you: ${attention}`);
    return false;
  }

  const sentNow = new Set();
  let verifyLeads = null;
  try {
    beat('waiting', 'confirmed — waiting for the first pro\'s 7:00 PM', { startedAt: now().toISOString(), template: message.templateName });
    while (!stop) {
      const t = now();
      if (until && t >= until) { log('🛑', 'Until', `reached ${clock(until)} — stopping`); break; }
      for (const e of entries) if (e.status === 'pending' && isPast(e, t)) { e.status = 'missed'; e.reason = 'its texting window closed before it could be sent'; }
      const live = entries.filter((e) => e.status === 'pending');
      if (!live.length) break;
      const due = live.filter((e) => t >= new Date(e.at)).sort((a, b) => new Date(a.at) - new Date(b.at));

      if (due.length) {
        if (!(await ensureReady('before a batch'))) { await wait(Math.min(DEFAULTS.pollMs, 60000)); continue; }
        log('📤', 'Sending', `${due.length} pro(s) are due now (${[...new Set(due.map((e) => e.zoneLabel))].join(', ')})`);
        beat('sending', `texting ${due.length} pro(s)`, { lastBatchAt: t.toISOString() });
        const lastDeadline = Math.max(...due.map((e) => Date.parse(e.deadline)));
        const batchStop = lastDeadline - stopBeforeMs;
        const byKey = new Map(due.map((e) => [k15(e.accountId), e]));
        // runReportCampaign calls shouldStop() once at the start of every pro, in order, and onSent() after every text: both count as progress. Nothing inside a text
        // (textAccount) has a timeout, and a tab that crashed mid-call never answers, so a batch that makes no progress for stallMs is abandoned and the tab replaced.
        let reached = 0, abandoned = false, progressAt = Date.now(), ticks = 0;
        const touch = () => { progressAt = Date.now(); };
        const opts = {
          message: message.message, templateName: message.templateName, templateKey: message.templateKey, delayMs: args.delayMs,
          leads: due.map((e) => ({ name: e.name, accountId: e.accountId, url: e.url, lastOutgoingSms: e.lastOutgoingSms, source: SOURCE })),
          source: SOURCE, mode: 'evening', tcpa: true, tcpaUnknown: unknownZone, start: 1, end: null,
          shouldStop: () => { touch(); const s = stop || abandoned || now().getTime() >= batchStop; if (!s) reached++; return s; },
          onSent: (lead) => { touch(); const e = byKey.get(k15(lead.accountId)); if (e && e.status !== 'texted') { e.status = 'texted'; e.textedAt = now().toISOString(); lastSentAt = now(); sentNow.add(k15(lead.accountId)); save({ lastSentAt: lastSentAt.toISOString() }); beat('sending', `${counts().texted} texted`); } },
        };
        let timer; const frozen = new Promise((resolve) => {
          timer = setInterval(() => {
            if (Date.now() - progressAt > stallMs) { abandoned = true; resolve(true); }
            else if (++ticks % 3 === 0) beat('sending', `texting ${due.length} pro(s) — ${counts().texted} texted so far`);       // the heartbeat stays fresh through a long run of skipped pros
          }, Math.max(20, Math.min(5000, Math.floor(stallMs / 4))));
        });
        let outcome;
        try { outcome = await Promise.race([Promise.resolve().then(() => runBatch(session.page(), opts)).then((res) => ({ res })), frozen.then(() => ({ frozen: true }))]); }
        catch (e) { outcome = { error: e }; }
        finally { clearInterval(timer); }

        let troubled = false;
        const finished = 'res' in outcome;                                      // the sender came back (whatever it returned), as opposed to throwing or freezing
        if (finished) batchErrors = 0;
        else {
          batchErrors++; troubled = true;
          if (outcome.frozen) {
            log('⛔', 'Batch frozen', `no text started or finished for ${span(stallMs)} — the tab has probably crashed; opening a fresh one`);
            tell('Evening run: the Salesforce tab froze in the middle of a batch — replacing it and carrying on.');
            try { await session.recover('tab'); } catch (_) {}                      // closes the old tab too, which also ends whatever the frozen batch is still waiting on
          } else log('❌', 'Batch stopped', `${outcome.error.message} — checking the browser, then trying the rest again`);
          if (batchErrors >= DEFAULTS.errorsBeforeWarning) { attention = `texting keeps failing (${batchErrors} batches in a row): ${outcome.error ? outcome.error.message : 'the tab froze'}`; beat('needs-attention', attention); tell(`Evening run needs you: ${attention}`); }
          await ensureReady('after a failed batch');
        }
        const stopping = stop || now().getTime() >= batchStop;
        if (reached < due.length && !stopping) troubled = true;                  // it ended early on its own (10 failures in a row, the contact guard offline …)
        lastHealth = lastKeep = now().getTime();                                  // a batch loads dozens of Salesforce pages: that is activity
        // Who is charged a try (a pro is given up after maxTries): only pros the sender actually STARTED on, never the ones it did not reach. When the batch broke off
        // on its own (10 failures in a row, the contact guard offline) nobody is charged — that is the network or Salesforce, not those pros — and when it threw or froze,
        // only the pro it was on.
        const charged = !troubled ? due.slice(0, reached) : (finished ? [] : due.slice(Math.max(0, reached - 1), reached));
        for (const e of charged) {
          if (e.status !== 'pending') continue;
          e.tries = (e.tries || 0) + 1;
          if (e.tries >= DEFAULTS.maxTries) { e.status = 'failed'; e.reason = `not sent on ${DEFAULTS.maxTries} passes — a guard held it (already texted / contact guard / hours), the text failed, or it went out but could not be recorded; see the run log`; }
        }
        save();
        if (!stop && due.some((e) => e.status === 'pending')) await wait(troubled ? DEFAULTS.passGapTroubledMs : DEFAULTS.passGapMs);   // do not hammer a Salesforce that is struggling
        continue;                                                                  // more may have come due while that batch went out
      }

      const next = live.map((e) => new Date(e.at)).filter((a) => a > t).sort((a, b) => a - b)[0];
      if (!next) break;
      const nextGroup = live.filter((e) => new Date(e.at).getTime() === next.getTime());
      log('⏳', 'Waiting', `${nextGroup.length} pro(s) (${nextGroup[0].zoneLabel}) at ${clock(next)}, in ${span(next - t)} — ${live.length} still to go tonight`);
      beat('waiting', `next: ${nextGroup.length} ${nextGroup[0].zoneLabel} pro(s) at ${clock(next)}`, { nextAt: next.toISOString(), nextWho: nextGroup[0].zoneLabel });
      while (!stop && now() < next && !(until && now() >= until)) {
        await wait(Math.min(DEFAULTS.pollMs, Math.max(1000, next - now())));
        await tick('routine check');
        beat('waiting', `next: ${nextGroup.length} ${nextGroup[0].zoneLabel} pro(s) at ${clock(next)}`, { nextAt: next.toISOString() });
      }
    }

    // ---- 4. lag check: did the texts reach the accounts? --------------------------------------------------------------------------------
    const texted = entries.filter((e) => e.status === 'texted');
    let lag = null;
    if (!stop && !(until && now() >= until) && flags.verify && rescan && texted.length && lastSentAt) {
      const verifyAt = new Date(Math.min(lastSentAt.getTime() + DEFAULTS.verifyAfterMin * 60000, rollover.getTime() - 10 * 60000));
      while (!stop && now() < verifyAt) {
        log('⏳', 'Lag check', `reading the report again at ${clock(verifyAt)} to see which texts have reached the accounts`);
        await wait(Math.min(DEFAULTS.pollMs, Math.max(1000, verifyAt - now())));
        await tick('while waiting for the lag check');
        beat('waiting', `lag check at ${clock(verifyAt)}`);
      }
      if (!stop && await ensureReady('before the lag check')) {
        try {
          verifyLeads = await within(rescan(session.page()), 5 * 60000, 'the report');
          const still = new Set(tonightsBatch(verifyLeads, now(), { postAge: flags.postAge }).tonight.map((l) => k15(l.accountId)));
          const by = {};
          for (const e of texted) { const g = (by[e.zoneLabel] = by[e.zoneLabel] || { texted: 0, stillListed: 0 }); g.texted++; if (still.has(k15(e.accountId))) g.stillListed++; }
          const stillListed = texted.filter((e) => still.has(k15(e.accountId))).length;
          lag = { at: now().toISOString(), afterLastTextMin: Math.round((now() - lastSentAt) / 60000), texted: texted.length, stillListed, by };
          log('🔎', 'Lag check', `${texted.length - stillListed} of ${texted.length} texted pro(s) already show today's contact on the report; ${stillListed} still show 14 days${stillListed ? ' — they may post at midnight anyway (the morning backup will say)' : ' — none will post'}`);
          for (const [g, v] of Object.entries(by)) console.log(`        ${g.padEnd(9)}${v.texted - v.stillListed}/${v.texted} updated`);
          save({ lag });
        } catch (e) { log('⚠️', 'Lag check', `could not read the report again (${e.message}) — the morning --shark backup will still show who posted`); }
      }
    }

    // ---- 5. wrap up ---------------------------------------------------------------------------------------------------------------------
    const c = counts();
    save({ finishedAt: now().toISOString() });
    appendHistory({ type: 'run', day, template: message.templateName, at: flags.at, texted: c.texted, failed: c.failed, missed: c.missed, blocked: c.blocked, skipped: c.skipped, pending: c.pending, lag });
    beat(stop ? 'stopped' : 'done', `${c.texted} texted`, { finishedAt: now().toISOString() });
    console.log(`\n  🏁 Evening run ${stop ? 'stopped' : 'finished'}: ${c.texted} text(s) sent · ${c.failed} not sent · ${c.missed} missed (window closed) · ${c.blocked} not allowed tonight · ${c.skipped} skipped.`);
    if (c.failed) console.log(`     not sent: ${entries.filter((e) => e.status === 'failed').slice(0, 8).map((e) => e.name).join(', ')}${c.failed > 8 ? ' …' : ''} — they post at midnight like everyone else; the morning run picks them up.`);
    console.log('     Tomorrow morning:  email --shark   (it tells you how many of tonight\'s pros posted anyway)\n');
    try { notify(`Evening run ${stop ? 'stopped' : 'finished'}: ${c.texted} texted, ${c.failed} not sent.`); } catch (_) {}
    return { ...c, entries, lag };
  } finally {
    if (!o.noSignals) process.removeListener('SIGINT', onInt);
  }
}

// ============================================================================
// Did it work? (the morning after)
// ============================================================================
/** How many of the pros texted by the last evening run are on THIS Shark snapshot anyway? → { day, texted, leaked, names, byGroup } | null */
function leakCheck(queue, snap) {
  if (!queue || !queue.entries || !snap) return null;
  const texted = queue.entries.filter((e) => e.status === 'texted');
  if (!texted.length) return null;
  const after = Date.parse(queue.lastSentAt || queue.scannedAt) || 0, at = Date.parse(snap.at);
  if (!(at > after) || at - after > 40 * 3600e3) return null;                        // not the morning after that run
  const on = new Set((snap.accounts || []).map((a) => k15(a.id)));
  const byGroup = {}; let leaked = 0; const names = [];
  for (const e of texted) {
    const g = (byGroup[e.zoneLabel] = byGroup[e.zoneLabel] || { texted: 0, leaked: 0 }); g.texted++;
    if (on.has(k15(e.accountId))) { g.leaked++; leaked++; if (names.length < 8) names.push(e.name); }
  }
  return { day: queue.day, texted: texted.length, leaked, snapAt: snap.at, names, byGroup };
}

/** Called by the morning --shark backup with the snapshot it just saved. Prints one line and remembers it (once per evening). */
function noteMorning(snap, log = defaultLog) {
  const q = readJson(FILES.queue, null);
  const r = leakCheck(q, snap);
  if (!r) return null;
  const rate = Math.round((100 * r.leaked) / r.texted);
  log('🌙', 'Evening check', `last night's evening run texted ${r.texted} pro(s); ${r.leaked} of them are on this morning's Shark list anyway (${rate}%)${r.leaked ? ` — ${r.names.join(', ')}${r.leaked > r.names.length ? ' …' : ''}` : ' — none posted, the idea worked'}`);
  if (r.leaked) console.log(`     by zone: ${Object.entries(r.byGroup).map(([g, v]) => `${g} ${v.leaked}/${v.texted}`).join(' · ')}   (the morning run skips anyone texted in the last 24 h, so none of them is texted twice)`);
  if (!readHistory().some((h) => h.type === 'leak' && h.day === r.day)) appendHistory({ type: 'leak', day: r.day, texted: r.texted, leaked: r.leaked, snapAt: r.snapAt, byGroup: r.byGroup });
  return r;
}

// ============================================================================
// --evening --inspect: no browser, nothing sent
// ============================================================================
async function inspect(flags, args, deps = {}) {
  if (flags.error) { console.log(`\n  ${flags.error}\n`); return { error: flags.error }; }
  const textLog = deps.textLog; const now = (deps.now || (() => new Date()))();
  const day = dayOf(now);
  const cfg = readJson(FILES.config, {}) || {};
  const q = readJson(FILES.queue, null), st = readJson(FILES.status, null);
  const up = await portAlive(PORT, 1500);
  console.log('\n  🌙 EVENING RUN — text tomorrow\'s Shark list TONIGHT   (--inspect: no browser opened, nothing sent)\n');
  console.log('     The idea   the Shark report posts, at midnight, the pros whose last communication is 15 days old. A text on their account before');
  console.log('                midnight makes that date today, so they never post and the three of you never pile onto them.');
  console.log(`     Report     ${cfg.report && cfg.report.url ? `✅ "${cfg.report.name || 'evening report'}" is remembered — it opens by itself` : '❌ not set up yet. In Salesforce: open "T14 Shark List All" → Save As a copy (any name, e.g. "T13 Shark List All") → in the copy move the day filter ONE DAY EARLIER.\n                Then open the copy and run  email --evening --dry-run  — it remembers the report.'}`);
  console.log(`     Tonight    ${day} · the report posts at ${clock(instantAt(addDays(day, 1), '00:00', REPORT_ZONE))} (in ${span(instantAt(addDays(day, 1), '00:00', REPORT_ZONE) - now)}) · each pro is texted at ${prettyAt(flags.at)} their own time, never in the last ${flags.marginMin} min`);
  const zs = [['ET', ['America/New_York']], ['CT', ['America/Chicago']], ['MT', ['America/Denver']], ['AZ', ['America/Phoenix']], ['PT', ['America/Los_Angeles']]];
  const row = zs.map(([l, z]) => { const s = slot(z, day, { at: flags.at, marginMin: flags.marginMin }); return `${l} ${s.ok ? clock(s.at).replace(/:00 /, ' ') : `— (${s.reason})`}`; });
  console.log(`     Timetable  ${row.join(' · ')}`);
  console.log(`     Chrome     port ${PORT} is ${up ? 'UP — a run (or a leftover Chrome) is using it; a new start reuses it and keeps its Salesforce login' : 'down — it starts by itself'}`);
  if (st) {
    const age = st.updatedAt ? Date.now() - Date.parse(st.updatedAt) : null;
    const live = ['waiting', 'sending', 'needs-attention'].includes(st.state);
    console.log(`     Last run   ${st.day || '?'} · ${st.state}${st.note ? ` — ${st.note}` : ''}${st.counts ? ` · texted ${st.counts.texted} · pending ${st.counts.pending} · failed ${st.counts.failed} · missed ${st.counts.missed}` : ''}`);
    if (age != null) console.log(`     Heartbeat  ${span(age)} ago${live && age > 3 * 60000 ? '   ⚠️ NO RECENT HEARTBEAT — the run has probably stopped (check the Terminal tab)' : ''}`);
  } else console.log('     Last run   none yet');
  if (q && deps.snapshots) {
    const r = leakCheck(q, deps.snapshots.filter((s) => s.kind === 'Shark').sort((a, b) => a.at.localeCompare(b.at)).find((s) => Date.parse(s.at) > (Date.parse(q.lastSentAt || q.scannedAt) || 0)));
    if (r) console.log(`     Did it work  ${r.day}: texted ${r.texted}, ${r.leaked} posted anyway (${Math.round((100 * r.leaked) / r.texted)}%)`);
  }
  const hist = readHistory().filter((h) => h.type === 'leak').slice(-5);
  if (hist.length) console.log(`     History    ${hist.map((h) => `${h.day}: ${h.leaked}/${h.texted} posted anyway`).join(' · ')}`);
  console.log('\n     email --evening --dry-run                  look at tonight\'s batch (opens Chrome, sends nothing, saves no list)');
  console.log('     email --evening --template N               the real run — start it BEFORE you leave; it asks once, then runs by itself');
  console.log('     options: --at 6pm (earlier)  --max-texts 15 (a small first night)  --unknown-zone hold  --until 23:00  --yes  --no-verify\n');
  return { up };
}

/** Opens the report again and reads its rows with no prompt and nothing recorded (the lag check, long after Luke has left). → leads */
async function reportAgain(page, url, { harvestReportLeads, reportFrame }, loadWaitMs = 15000) {
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 40 && !reportFrame(page); i++) await sleep(1000);
    await sleep(loadWaitMs);
  }
  return harvestReportLeads(page, { kind: 'Shark', record: false });
}

// ============================================================================
// The entry point Assistant.js calls (with the pieces it owns)
// ============================================================================
async function runMode(context, initialPage, args, api) {
  const { commandLog: log, ask, openReportAndHarvest, harvestReportLeads, reportFrame, runReportCampaign, pickSendMessage, parseUntil, REPORT_MODES, CONFIG, textLog } = api;
  const flags = parseFlags(process.argv.slice(2));
  if (flags.error) { console.log(`\n  ${flags.error}\n`); return; }
  if (!acquireLock(log)) return;                                  // (Assistant.js already took it before touching the browser; this is the same process, so it is a no-op there)
  let session = null;
  try {
    const cfg = readJson(FILES.config, {}) || {};
    const haveReport = !!(cfg.report && /^https:\/\//.test(cfg.report.url || ''));
    if (haveReport) REPORT_MODES.evening = { name: cfg.report.name || 'Evening Shark report', url: cfg.report.url, kind: 'Shark' };   // in memory only: report-modes.json is never touched
    else log('ℹ️', 'Report', 'no evening report is saved yet: open the COPY of the Shark report (day filter one day earlier) in the Chrome window when asked');

    const scan = async () => {
      const r = await openReportAndHarvest(context, initialPage, { ...args, mode: haveReport ? 'evening' : null, kind: 'Shark', noRecord: !!args.dryRun });
      return r ? { leads: r.leads, reportUrl: r.reportUrl, source: r.source, page: r.page } : null;
    };
    const rescan = (page) => reportAgain(page, ((readJson(FILES.config, {}) || {}).report || {}).url || ((readJson(FILES.queue, {}) || {}).report || {}).url, { harvestReportLeads, reportFrame }, args.loadWaitMs);
    const rememberReport = (r) => {
      if (haveReport || !/\/lightning\/r\/Report\//.test(r.reportUrl || '')) return;
      try { writeJson(FILES.config, { ...cfg, report: { name: (r.source && r.source.name) || 'Evening Shark report', url: r.reportUrl.split('?')[0] } }); log('💾', 'Report saved', 'remembered as the evening report — next time it opens by itself'); } catch (_) {}
    };

    const message = args.dryRun && !(args.template || args.message) ? null : await pickSendMessage(args);
    if (!args.dryRun && !message) return;
    session = createSession({ context, page: null, startUrl: CONFIG.startUrl, port: PORT, profileDir: PROFILE_DIR });
    return await runEvening({ flags, args, textLog, message, scan, rescan, session, ask, log, rememberReport, until: args.until && parseUntil ? parseUntil(args.until) : null, runBatch: runReportCampaign });
  } finally {
    if (session) { try { await session.close(); } catch (_) {} }   // a Chrome relaunch opens a link of its own that Assistant.js does not close: left open it keeps this process (and `caffeinate -w`) alive for ever
    releaseLock();
    setTimeout(() => process.exit(0), 15000).unref();              // and if anything else still holds the process 15 s after the run ended (a frozen batch's prompt reader), let go of it anyway
  }
}

module.exports = {
  PORT, PROFILE_DIR, FILES, DEFAULTS, POST_AGE, SOURCE,
  runMode, runEvening, inspect, noteMorning, leakCheck,
  tonightsBatch, slot, screen, zonesOf, groupsOf, parseFlags, parseClock, stampDay,
  createSession, portAlive, within, isLoggedInUrl, acquireLock, releaseLock, reportAgain, printPlan,
  instantAt, dayOf, addDays, dayNum, clock,
};
