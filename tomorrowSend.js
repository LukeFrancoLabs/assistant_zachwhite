'use strict';

/**
 * tomorrowSend — the OVERNIGHT hands-off run: `--tomorrow` with `--send` (`--shark13 --send` implies it).
 *
 *   email --shark13 --send --template 6     scan the T13 report (tomorrow's Shark list), then text each pro at their own NEXT 8:00 AM
 *   email --queue --send --tomorrow         the same for a queue you already have (also  --shark --send --tomorrow)
 *   email --queue --tomorrow --inspect      the timetable for the saved queue (no browser, nothing sent)
 *
 * Why it exists: `--send` texts whoever is inside their hours AT ONCE and only waits for windows that open later the SAME day, so started at 10 PM it would
 * text the Pacific pros that minute and then stop. Here nobody is texted before their own NEXT 8:00 AM, even a pro whose window happens to be open right now
 * (a pro with no known zone: 12:00 PM Eastern, the all-US window; never a Sunday). The pros on the T13 report are emailed the night before, which keeps them off
 * the T14 report, and the text goes out the next morning at 8:00 their time (an email does not block a text: the once-a-day guard counts texts only, the
 * report's SMS guard reads "Last Outgoing SMS", and the contact ledger's cooldown is waived for texts).
 *
 * Once confirmed it runs with nobody at the Mac: it keeps the Mac awake, checks Chrome, the tab and the Salesforce login every few minutes, relaunches a crashed
 * Chrome, reopens a closed tab, loads Salesforce every few minutes so the login does not idle out, abandons a batch that froze and tells you on the Mac when it
 * needs you. The browser watchdog is the evening run's (eveningShark.createSession). It lives in its OWN Chrome (CDP 9333), so a morning --shark / --queue / --evening
 * can never kill it while it waits.
 *
 * Restarting: the queue remembers who was texted, so nobody is texted twice. After a crash AT NIGHT start  email --queue --send --tomorrow  (it holds everyone for their
 * next 8:00 AM again); once their 8:00 AM has come start the plain  email --queue --send  (it texts whoever is inside their hours at once, then waits for the later zones).
 * Before each batch it re-checks what changed overnight: a pro who became a current customer or a closed-won account (the email pass flags them) is left out, a corrected
 * time zone moves the pro to the new window, and a pro whose window is about to close is not started.
 *
 * Nothing here talks to the browser or to texts directly: Assistant.js hands in the pieces (runReportCampaign, ask, the queue …), so every part runs against fakes
 * and nothing is ever sent from a test.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const tcpa = require('./tcpa');

const DIR = process.env.ASSISTANT_TOMORROW_DIR || __dirname;                // tests point this at a scratch folder
const FILES = { lock: path.join(DIR, 'tomorrow.lock') };
const ET = 'America/New_York';
const DEFAULTS = {
  pollMs: 30 * 1000,
  healthEveryMs: 4 * 60 * 1000,
  keepAliveEveryMs: 8 * 60 * 1000,
  stillWaitingEveryMs: 30 * 60 * 1000,   // one reassuring line in the log every half hour while it waits
  stallMs: 4 * 60 * 1000,                // a batch that has neither started nor finished a text in this long is frozen (a text takes ~30 s; a crashed tab never answers and nothing times out inside textAccount)
  stopBeforeMs: 40 * 1000,               // a text that starts now lands 20-30 s later: nothing is started in the last 40 s of a pro's window
  passGapMs: 15 * 1000,                  // wait before another pass over pros that were reached but not sent…
  passGapTroubledMs: 90 * 1000,          // …and before another pass after a batch that ended early (an error, the offline guard, a frozen tab)
  maxTries: 3,                           // passes a pro is REACHED on before it is given up
  errorsBeforeWarning: 6,                // batches in a row that fail before the Mac is told to get your attention (it keeps trying until the windows close)
  horizonDays: 1,                        // a pro whose next window is more than this many of THEIR calendar days away (a Sunday in between) is left in the queue for the next run
  perTextSec: 30,                        // measured: the median gap between our texts is 30 s
  loginRetryMs: 30 * 60 * 1000,          // a signed-out Salesforce is retried (the home page loaded again) at most this often: reloading the sign-in page under the person who is signing in stalls them
  emptyEndsBeforeCharge: 3,              // batches in a row that end early on their own with nothing sent before the pros they reached are charged a try
};
const PORT = 9333, PROFILE_DIR = '.browser-profile-tomorrow';       // the overnight run's own Chrome (Assistant.js CONFIG.tomorrowCdpPort / tomorrowUserDataDir)
/** Stands in for the text when --dry-run is used without --template / --message: nothing is sent, so none is needed. */
const NO_TEXT = { message: '(no text chosen: --dry-run)', templateId: null, templateName: '(no text chosen)', templateKey: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const defaultLog = (icon, label, msg) => console.log(`  ${icon} ${String(label).toUpperCase().padEnd(20)} ${msg}`);
const fmt = (d, tz = ET) => d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const clockOf = (d, tz) => d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const clock = (d) => d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });   // this Mac's clock
const span = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const short = (tz) => tcpa.ZONE_SHORT[tz] || tz;
const labelOf = (zs) => (zs && zs.length ? zs.map(short).join('/') : 'no zone');
const tzOf = (zs) => (zs && zs[0]) || ET;
const isOpen = (zones, d) => tcpa.checkZones(zones && zones.length ? zones : null, d).ok;

// ============================================================================
// When is a pro texted?
// ============================================================================
/**
 * The minute their texting window next OPENS (8:00 their own time, no Sundays; no known zone: 12:00 PM Eastern, the all-US window), counted from the end of the window
 * they may be inside right now: a pro whose window is open at `from` is NOT texted now, they wait for the next opening. null when there is none within 8 days.
 */
function nextStart(zones, from) {
  let t = new Date(Math.floor(from.getTime() / 60000) * 60000);
  for (let i = 0; i < 60 && isOpen(zones, t); i++) t = new Date(t.getTime() + 15 * 60000);   // leave the window we are inside (12 hours at most)
  return tcpa.openingFor(zones && zones.length ? zones : null, t);
}
/** The first minute at or after `at` when that pro's window is closed again (their 8:00 PM). */
function closeAfter(zones, at) {
  let t = new Date(at.getTime());
  for (let i = 0; i < 60 && isOpen(zones, t); i++) t = new Date(t.getTime() + 15 * 60000);
  for (let k = 14; k > 0; k--) { const e = new Date(t.getTime() - k * 60000); if (!isOpen(zones, e)) return e; }   // the exact minute, not the next 15-minute step
  return t;
}
const dayNum = (d, tz) => Date.parse(`${tcpa.localDay(d, tz)}T00:00:00Z`) / 86400000;

/**
 * Every queued pro → when they are texted. → { entries, left }
 *   entries  [{ lead, key, zones, label, at, closes, order, status:'pending', tries:0 }] earliest first
 *   left     what stays in the queue for another run: { banned, noZone, later:[{ lead, why }], noId, dup, capped }
 * `maxTexts` keeps the FIRST N pros in queue order (a small first night), not the earliest zones.
 */
function planFor(leads, now, { zonesFor, isBanned, alreadySent = null, screen = null, unknownZone = 'strict', horizonDays = DEFAULTS.horizonDays, maxTexts = null } = {}) {
  const left = { banned: [], repeat: [], screened: [], noZone: [], later: [], noId: 0, dup: 0, capped: 0 };
  let entries = [];
  const seen = new Set();
  leads.forEach((lead, order) => {
    const key = k15(lead.accountId);
    if (!key) { left.noId++; return; }
    if (seen.has(key)) { left.dup++; return; }
    seen.add(key);
    if (isBanned(lead.accountId)) { left.banned.push(lead); return; }
    const why = screen ? screen(lead) : null;
    if (why) { left.screened.push({ lead, why }); return; }                                    // a current customer / a closed-won account: never texted
    if (alreadySent && alreadySent(lead)) { left.repeat.push(lead); return; }                 // never the same text twice: this pro already got this exact text
    const found = zonesFor(lead.accountId);
    const zones = found && found.length ? found : null;
    if (!zones && unknownZone === 'hold') { left.noZone.push(lead); return; }
    const at = nextStart(zones, now);
    if (!at) { left.later.push({ lead, why: 'no texting window in the next 8 days' }); return; }
    const tz = tzOf(zones);
    if (dayNum(at, tz) - dayNum(now, tz) > horizonDays) { left.later.push({ lead, why: `its next window is ${fmt(at, tz)} ${short(tz)}` }); return; }
    entries.push({ lead, key, zones, label: labelOf(zones), at, closes: closeAfter(zones, at), order, status: 'pending', tries: 0 });
  });
  if (maxTexts && entries.length > maxTexts) {
    const keep = new Set([...entries].sort((a, b) => a.order - b.order).slice(0, maxTexts));
    left.capped = entries.length - keep.size;
    entries = entries.filter((e) => keep.has(e));
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  return { entries, left };
}

/** Per zone / opening time: [{ label, zones, at, closes, n, estMin }] earliest first. Only `pending` entries count. */
function groupsOf(entries, perTextSec = DEFAULTS.perTextSec) {
  const m = new Map();
  for (const e of entries) {
    if (e.status !== 'pending') continue;
    const k = `${e.label}|${e.at.getTime()}`;
    const g = m.get(k) || { label: e.label, zones: e.zones, at: e.at, closes: e.closes, n: 0 };
    g.n++; m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.at - b.at || a.label.localeCompare(b.label)).map((g) => ({ ...g, estMin: Math.ceil((g.n * perTextSec) / 60) }));
}

function printPlan(plan, now, { until = null, maxTexts = null } = {}) {
  const { entries, left } = plan;
  console.log(`\n  🌙 OVERNIGHT RUN — each pro is texted at their own NEXT 8:00 AM   (it is ${clock(now)} now)`);
  console.log('     Nobody is texted before that, even a pro whose window is open right now. Never a Sunday; a pro with no known zone waits for 12:00 PM Eastern.');
  for (const g of groupsOf(entries)) {
    const own = g.zones && g.zones.length && !(g.zones.length === 1 && g.zones[0] === ET) ? `   = ${clockOf(g.at, tzOf(g.zones))} ${g.label}` : '';
    const stops = dayNum(g.closes, ET) !== dayNum(g.at, ET) ? fmt(g.closes) : clockOf(g.closes, ET);      // (Hawaii's 8:00 PM is 2:00 AM Eastern, the next day)
    console.log(`     ${g.label.padEnd(10)}${String(g.n).padStart(4)} pro(s)   ${fmt(g.at)} ET${own}   ~${g.estMin} min   stops ${stops} ET`);
  }
  if (entries.length) console.log(`     ${entries.length} pro(s) in all · first text ${fmt(entries[0].at)} ET · last window opens ${fmt(entries[entries.length - 1].at)} ET${until ? ` · stops at ${clock(until)} (--until)` : ''}`);
  const rows = [];
  if (left.banned.length) rows.push(`${left.banned.length} on the do-not-contact list`);
  if (left.screened.length) rows.push(`${left.screened.length} current customers / closed-won accounts (never texted)`);
  if (left.repeat.length) rows.push(`${left.repeat.length} already got this exact text (never the same text twice)`);
  if (left.noZone.length) rows.push(`${left.noZone.length} with no known time zone (--unknown-zone hold)`);
  if (left.later.length) rows.push(`${left.later.length} whose next window is more than a day away (${[...new Set(left.later.map((x) => x.why))].slice(0, 2).join('; ')})`);
  if (left.capped) rows.push(`${left.capped} more than --max-texts ${maxTexts}`);
  if (left.noId) rows.push(`${left.noId} with no account id`);
  if (left.dup) rows.push(`${left.dup} duplicate(s)`);
  if (rows.length) console.log(`     left in the queue: ${rows.join(' · ')}`);
}

/**
 * Who must never be texted although they are queued: a current customer or a closed-won account (the Shark text rules; the email pass flags them while the queue waits).
 * → { refresh(), check(lead) → the reason, or null }. refresh() re-reads the two lists: call it before every batch, the flags change during the night.
 */
function defaultScreen(textLog) {
  let won = new Map(), cust = new Map();
  return {
    refresh() { try { won = textLog.readClosedWon(); } catch (_) {} try { cust = textLog.readCurrentCustomers(); } catch (_) {} },
    check(lead) {
      const id = String(lead.accountId || '').toLowerCase(), k = id.slice(0, 15);
      if (won.has(id) || won.has(k)) return 'on the closed-won list';
      if (cust.has(id) || cust.has(k)) return 'a current customer';
      return null;
    },
  };
}

/** `--queue --tomorrow --inspect`: the timetable for the saved queue. No browser, nothing sent. */
function preview(leads, { unknownZone = 'strict', textLog, until = null, parseUntil = null, maxTexts = null, now = new Date() } = {}) {
  const sc = textLog && textLog.readClosedWon && textLog.readCurrentCustomers ? defaultScreen(textLog) : null; if (sc) sc.refresh();
  const plan = planFor(leads, now, { zonesFor: (id) => textLog.zonesFor(id), isBanned: (id) => textLog.isBanned(id), screen: sc ? (l) => sc.check(l) : null, unknownZone, maxTexts });
  let u = until && parseUntil ? parseUntil(until, now) : null;
  if (until && !u) console.log(`\n  ⚠️  --until "${until}" is not a time like 12:00 (24-hour clock): ignored.`);
  if (u && u <= now) { u = new Date(u); u.setDate(u.getDate() + 1); }
  printPlan(plan, now, { until: u, maxTexts });
  if (!plan.entries.length) console.log('     Nobody in the queue can be texted tomorrow.');
  console.log('\n     (--inspect: no browser opened, nothing sent.)  The real run:  email --queue --send --tomorrow --template N\n');
  return plan;
}

// ============================================================================
// One overnight run at a time
// ============================================================================
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let lockHooked = false;
/** Taken in main() BEFORE the browser is touched. false = a live overnight run holds it (a lock older than the last boot is stale). */
function acquireLock(log = defaultLog) {
  const cur = readJson(FILES.lock, null);
  const bootedAt = Date.now() - os.uptime() * 1000;
  if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid) && !(Date.parse(cur.since) < bootedAt - 60000)) {
    log('⛔', 'Already running', `an overnight run is already going (pid ${cur.pid}, started ${cur.since || '?'}). A second one would load a page in the tab the first is texting from, so nothing was started. Stop the first with Ctrl-C in its Terminal tab. (If no overnight run is going, delete tomorrow.lock in the Pipeline Assistant folder and start again.)`);
    return false;
  }
  try { fs.writeFileSync(FILES.lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() })); } catch (_) {}
  if (!lockHooked) { lockHooked = true; process.once('exit', releaseLock); }       // however the run ends (a crash, a second Ctrl-C) the lock goes with it
  return true;
}
function releaseLock() { try { const cur = readJson(FILES.lock, null); if (cur && cur.pid === process.pid) fs.unlinkSync(FILES.lock); } catch (_) {} }

function notifyMac(msg, title = 'Pipeline Assistant overnight run') {
  try { process.stdout.write('\x07'); } catch (_) {}
  if (process.platform !== 'darwin') return;
  try { execFile('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title ${JSON.stringify(title)} sound name "Glass"`], () => {}); } catch (_) {}
}

// ============================================================================
// The run
// ============================================================================
/**
 * page = the logged-in Salesforce tab. o = { message, templateName, templateKey, delayMs, unknownZone, until, yes, dryRun, maxTexts }.
 * deps = { commandLog, ask, runReportCampaign, parseUntil, textLog, textQueue, startUrl, port, profileDir } — and for tests: now, wait, pending, mark, zonesFor, isBanned,
 * runBatch, session, notify, noKeepAwake, noSignals, noExitGuard, defaults.
 */
async function runTomorrow(page, o, deps = {}) {
  const now = deps.now || (() => new Date());
  const wait = deps.wait || sleep;
  const log = deps.commandLog || defaultLog;
  const notify = deps.notify || notifyMac;
  const { textLog, textQueue } = deps;
  const pendingLeads = deps.pending || (() => textQueue.pendingLeads());
  const mark = deps.mark || ((l) => textQueue.markTexted(l.accountId));
  const zonesFor = deps.zonesFor || ((id) => textLog.zonesFor(id));
  const isBanned = deps.isBanned || ((id) => textLog.isBanned(id));
  const runBatch = deps.runBatch || deps.runReportCampaign;
  const D = { ...DEFAULTS, ...(deps.defaults || {}) };
  const unknownZone = o.unknownZone === 'hold' ? 'hold' : 'strict';
  const t0 = now();

  const first = pendingLeads();
  if (!first.length) { console.log('\n  🗂️  The text queue is empty — nothing to send. Scan tomorrow\'s list first:  email --shark13 --send --template N\n'); return { sent: 0, empty: true }; }
  const alreadySent = deps.alreadySent || (textLog && textLog.sentSameMessage ? (lead) => !!textLog.sentSameMessage(lead.accountId, 'text', { templateName: o.templateName, message: o.message }) : null);
  const screen = deps.screen !== undefined ? deps.screen : (textLog && textLog.readClosedWon && textLog.readCurrentCustomers ? defaultScreen(textLog) : null);   // a current customer / a closed-won account is never texted
  if (screen && screen.refresh) screen.refresh();
  const plan = planFor(first, t0, { zonesFor, isBanned, alreadySent, screen: screen ? (l) => screen.check(l) : null, unknownZone, horizonDays: D.horizonDays, maxTexts: o.maxTexts });
  let until = o.until && deps.parseUntil ? deps.parseUntil(o.until, t0) : null;
  if (o.until && !until) console.log(`\n  ⚠️  --until "${o.until}" is not a time like 12:00 (24-hour clock): ignored, so the run goes on until everyone is texted.`);
  if (until && until <= t0) { until = new Date(until); until.setDate(until.getDate() + 1); }          // "--until 12:00" typed at night means tomorrow noon
  printPlan(plan, t0, { until, maxTexts: o.maxTexts });
  const entries = plan.entries;
  if (!entries.length) { console.log('\n  ⏰ Nobody in the queue can be texted tomorrow. Nothing sent.\n'); return { sent: 0, nothing: true, left: plan.left }; }
  if (o.dryRun) { console.log('\n  🧪 --dry-run: nothing was texted (a scan that ran just before was saved: the queue above is what a real run would use).\n'); return { sent: 0, dryRun: true, plan }; }

  if (!o.yes) {
    const a = entries[0].at, b = entries[entries.length - 1].at;
    const ans = ((await deps.ask(`\n  ▶️  Text "${o.templateName}" to ${entries.length} pro(s), each at their own NEXT 8:00 AM (${fmt(a)} ET${a.getTime() === b.getTime() ? '' : ` … ${fmt(b)} ET`}), with nobody at the computer? (y/N) `)) || '').toLowerCase();
    if (ans !== 'y' && ans !== 'yes') { log('🛑', 'Mission aborted', 'Nothing sent'); return { sent: 0, aborted: true }; }
  }
  log('🔒', 'Leave running', 'this Terminal tab and the Chrome window (it repairs itself if it crashes or a tab closes); the Mac stays awake. Ctrl-C stops after the text it is on.');
  if (!deps.noKeepAwake && process.platform === 'darwin') { try { spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); log('☕', 'Keep awake', 'the Mac stays awake while this runs'); } catch (_) {} }

  let stop = false;
  const onInt = () => { if (stop) process.exit(130); stop = true; log('🛑', 'Stopping', 'after the text it is on (Ctrl-C again quits now)'); };
  if (!deps.noSignals) process.on('SIGINT', onInt);

  let session = deps.session || null, ownSession = false;
  if (!session) {
    const { createSession } = require('./eveningShark');          // the evening run's watchdog: relaunch Chrome, reopen the tab, keep the login alive
    session = createSession({ context: page.context(), page, startUrl: deps.startUrl, port: deps.port || PORT, profileDir: deps.profileDir || PROFILE_DIR });   // (createSession's own default is the EVENING Chrome: never rely on it)
    ownSession = true;
  }

  const byKey = new Map(entries.map((e) => [e.key, e]));
  const stallMs = o.stallMs || Math.max(D.stallMs, 3 * (Number.isFinite(o.delayMs) ? o.delayMs : 0) + 120000);   // (a --delay that is not a number must not switch the watchdog off)
  const counts = () => { const c = { pending: 0, texted: 0, failed: 0, missed: 0, skipped: 0 }; for (const e of entries) c[e.status] = (c[e.status] || 0) + 1; return c; };
  let recoveries = 0, lastHealth = now().getTime(), lastKeep = lastHealth, lastSaid = lastHealth, batchErrors = 0, attention = null;
  let emptyEnds = 0, earlyEnds = 0, lastLoginTry = 0, loginDown = false;
  const attentionSaid = new Map();
  const told = new Map();                                         // the same problem is announced at most once an hour (a notification on the Mac, not a log line)
  const tell = (msg) => { const t = now().getTime(); if (!(told.has(msg) && t - told.get(msg) < 60 * 60000)) { told.set(msg, t); try { notify(msg); } catch (_) {} } };

  /** Check Chrome / the tab / the login and repair what can be repaired. → true when texting can go ahead. */
  async function ensureReady(why) {
    let h;
    try { h = await session.health(); } catch (e) { h = { ok: false, kind: 'tab', why: e.message }; }
    loginDown = !h.ok && h.kind === 'login';
    if (h.ok) { attention = null; return true; }
    for (let attempt = 1; attempt <= 3 && !h.ok; attempt++) {
      if (h.kind === 'login') {                                    // only a person can sign in, and reloading the sign-in page under them stalls the sign-in: try the home page again only now and then
        const tt = now().getTime();
        if (lastLoginTry && tt - lastLoginTry < D.loginRetryMs) break;
        lastLoginTry = tt;
      }
      recoveries++;
      log('🛠️', 'Repairing', `${h.why} (${why}) — attempt ${attempt}`);
      try { h = await session.recover(h.kind); } catch (e) { h = { ok: false, kind: h.kind, why: e.message }; }
      if (!h.ok && h.kind === 'login') break;
    }
    loginDown = !h.ok && h.kind === 'login';
    if (h.ok) { attention = null; log('✅', 'Repaired', 'Chrome and Salesforce are back'); return true; }
    attention = h.kind === 'login' ? `Salesforce is signed out — sign in to the Chrome window on port ${deps.port || PORT}. The run carries on by itself once you do.` : `could not repair: ${h.why}`;
    if (now().getTime() - (attentionSaid.get(attention) || 0) >= 30 * 60000) { attentionSaid.set(attention, now().getTime()); log('⛔', 'Needs you', attention); }   // (a check runs every few minutes: say it every half hour, not every time)
    tell(`Overnight run needs you: ${attention}`);
    return false;
  }
  /** While waiting: the health check every few minutes, the Salesforce keep-alive on its own timer (a health check only reads the tab; it is not activity). */
  async function tick(why) {
    const tt = now().getTime();
    if (tt - lastHealth >= D.healthEveryMs) { lastHealth = tt; await ensureReady(why); }
    if (tt - lastKeep >= D.keepAliveEveryMs) { lastKeep = tt; if (!loginDown) { try { await session.keepAlive(); } catch (_) {} } }   // (not while signed out: it would reload the sign-in page)
  }

  try {
    while (!stop) {
      const t = now();
      if (until && t >= until) { log('🛑', 'Until', `reached ${clock(until)} — stopping`); break; }
      const readQueued = () => new Set(pendingLeads().map((l) => k15(l.accountId)));
      let queued = readQueued();                                                    // texted meanwhile by another run? then it is not ours any more
      const missing = () => entries.filter((e) => e.status === 'pending' && !queued.has(e.key));
      if (missing().length) {                                                       // confirm before dropping anybody: an unreadable or half-written queue file reads as empty for a moment
        await wait(missing().length === entries.filter((e) => e.status === 'pending').length ? 5000 : 1000);   // (everybody missing at once is far more likely a bad read than a real change: wait longer)
        queued = readQueued();
      }
      for (const e of entries) {
        if (e.status !== 'pending') continue;
        if (!queued.has(e.key)) { e.status = 'skipped'; e.reason = 'no longer in the queue (texted by another run)'; continue; }
        if (t.getTime() >= e.closes.getTime() - D.stopBeforeMs) { e.status = 'missed'; e.reason = 'its texting window closed before it could be sent'; }
      }
      const live = entries.filter((e) => e.status === 'pending');
      if (!live.length) break;
      let due = live.filter((e) => t >= e.at);

      if (due.length) {
        // What changed since the plan was made (the email pass runs during the night): a pro who became a current customer / closed-won account is left out, and a corrected
        // time zone moves the pro to the new window.
        if (screen) {
          if (screen.refresh) screen.refresh();
          for (const e of due) { const why = screen.check(e.lead); if (why) { e.status = 'skipped'; e.reason = why; log('🛡️', 'Left out', `${e.lead.name} — ${why}`); } }
        }
        for (const e of due) {
          if (e.status !== 'pending') continue;
          const zl = zonesFor(e.lead.accountId), zs = zl && zl.length ? zl : null;
          if (labelOf(zs) === e.label) continue;
          const opening = isOpen(zs, t) ? t : tcpa.openingFor(zs, t);
          log('🕐', 'Time zone changed', `${e.lead.name}: ${e.label} → ${labelOf(zs)}${opening && opening > t ? ` — now ${fmt(opening)} ET` : ''}`);
          e.zones = zs; e.label = labelOf(zs);
          if (opening) { e.at = opening; e.closes = closeAfter(zs, opening); }
        }
        due = due.filter((e) => e.status === 'pending' && t >= e.at);
        if (!due.length) continue;                                                   // everybody due was left out or moved: back to the top (what is left waits or ends)
        due.sort((a, b) => (a.attempts || 0) - (b.attempts || 0) || a.at - b.at || a.order - b.order);   // pros not reached yet go first: a few bad accounts at the head must not block everyone behind them
        if (!(await ensureReady('before a batch'))) { await wait(Math.min(D.pollMs, 60000)); continue; }
        log('📤', 'Sending', `${due.length} pro(s) are due now (${[...new Set(due.map((e) => e.label))].join(', ')})`);
        const batchStop = Math.max(...due.map((e) => e.closes.getTime())) - D.stopBeforeMs;
        // runReportCampaign calls shouldStop() once at the start of every pro, in order, and onSent() after every text: both count as progress. Nothing inside a text
        // (textAccount) has a timeout, and a tab that crashed mid-call never answers, so a batch that makes no progress for stallMs is abandoned and the tab replaced.
        let reached = 0, sentInBatch = 0, abandoned = false, progressAt = Date.now(), ticks = 0;
        const touch = () => { progressAt = Date.now(); };
        const beyondUntil = () => !!(until && now() >= until);                       // --until also stops a batch that is running
        // A text that starts now lands 20-30 s later: a pro whose OWN window is about to close is not started (the sender's own hours check only looks when the pro's turn begins).
        const textOne = deps.textAccount ? async (pg, ident, link, msg, sel, o2) => {
          const e = byKey.get(k15(o2 && o2.accountId));
          if (e && now().getTime() >= e.closes.getTime() - D.stopBeforeMs) return { status: 'held', reason: 'its texting window is about to close' };
          return deps.textAccount(pg, ident, link, msg, sel, o2);
        } : null;
        const opts = {
          message: o.message, templateName: o.templateName, templateKey: o.templateKey, delayMs: o.delayMs,
          leads: due.map((e) => e.lead),
          onSent: (lead) => { touch(); sentInBatch++; try { mark(lead); } catch (_) {} const e = byKey.get(k15(lead.accountId)); if (e && e.status !== 'texted') { e.status = 'texted'; e.textedAt = now().toISOString(); } },
          tcpa: true, tcpaUnknown: unknownZone, start: 1, end: null,
          ...(textOne ? { textOne } : {}),
          shouldStop: () => { touch(); const s = stop || abandoned || now().getTime() >= batchStop || beyondUntil(); if (!s) reached++; return s; },
        };
        let timer; const frozen = new Promise((resolve) => {
          timer = setInterval(() => {
            if (Date.now() - progressAt > stallMs) { abandoned = true; resolve(true); }
            else if (++ticks % 12 === 0) log('📤', 'Sending', `${counts().texted} texted so far`);
          }, Math.max(20, Math.min(5000, Math.floor(stallMs / 4))));
        });
        let outcome;
        try { outcome = await Promise.race([Promise.resolve().then(() => runBatch(session.page(), opts)).then((res) => ({ res })), frozen.then(() => ({ frozen: true }))]); }
        catch (e) { outcome = { error: e }; }
        finally { clearInterval(timer); }

        let troubled = false;
        const finished = 'res' in outcome;                         // the sender came back (whatever it returned), as opposed to throwing or freezing
        if (finished) batchErrors = 0;
        else {
          batchErrors++; troubled = true;
          if (outcome.frozen) {
            log('⛔', 'Batch frozen', `no text started or finished for ${span(stallMs)} — the tab has probably crashed; opening a fresh one`);
            tell('Overnight run: the Salesforce tab froze in the middle of a batch — replacing it and carrying on.');
            try { await session.recover('tab'); } catch (_) {}      // closes the old tab too, which also ends whatever the frozen batch is still waiting on
          } else log('❌', 'Batch stopped', `${outcome.error.message} — checking the browser, then trying the rest again`);
          if (batchErrors >= D.errorsBeforeWarning) { attention = `texting keeps failing (${batchErrors} batches in a row): ${outcome.error ? outcome.error.message : 'the tab froze'}`; tell(`Overnight run needs you: ${attention}`); }
          await ensureReady('after a failed batch');
        }
        const stopping = stop || now().getTime() >= batchStop || beyondUntil();
        const endedEarly = finished && reached < due.length && !stopping;      // it ended early on its own (10 failures in a row, the contact guard offline …)
        if (endedEarly) troubled = true;
        lastHealth = lastKeep = now().getTime();                    // a batch loads dozens of Salesforce pages: that is activity
        for (const e of due.slice(0, reached)) e.attempts = (e.attempts || 0) + 1;   // the next pass starts with the pros that have been reached least (see the sort above)
        if (endedEarly) {
          earlyEnds++; emptyEnds = sentInBatch ? 0 : emptyEnds + 1;
          log('⚠️', 'Batch ended early', `${reached} of ${due.length} pro(s) were reached and ${sentInBatch} texted — the sender gave up (10 failures in a row, or the contact guard is offline)`);
          if (earlyEnds >= D.errorsBeforeWarning) { attention = `texting keeps ending early (${earlyEnds} batches in a row) — Salesforce may have changed or be struggling; see the run log`; tell(`Overnight run needs you: ${attention}`); }
        } else if (finished) { earlyEnds = 0; if (sentInBatch) emptyEnds = 0; }
        // Who is charged a try (a pro is given up after maxTries): only pros the sender actually STARTED on, never the ones it did not reach. When it threw or froze, only the
        // pro it was on. When a batch ended early on its own (10 failures in a row, the contact guard offline) that is usually the network or Salesforce, not those pros, so
        // nobody is charged at first — but after emptyEndsBeforeCharge such batches in a row with nothing sent the pros it reached are charged, or the same bad head would be retried all night.
        const charged = !troubled ? due.slice(0, reached) : (!finished ? due.slice(Math.max(0, reached - 1), reached) : (emptyEnds >= D.emptyEndsBeforeCharge ? due.slice(0, reached) : []));
        for (const e of charged) {
          if (e.status !== 'pending') continue;
          e.tries++;
          if (e.tries >= D.maxTries) { e.status = 'failed'; e.reason = `not sent on ${D.maxTries} passes — a guard held it (already texted / contact guard / hours), the text failed, or it went out but could not be recorded; see the run log`; }
        }
        if (!stop && due.some((e) => e.status === 'pending')) await wait(troubled ? D.passGapTroubledMs : D.passGapMs);   // do not hammer a Salesforce that is struggling
        continue;                                                   // more may have come due while that batch went out
      }

      const next = live.map((e) => e.at).filter((a) => a > t).sort((a, b) => a - b)[0];
      if (!next) break;
      const nextGroup = live.filter((e) => e.at.getTime() === next.getTime());
      log('⏳', 'Waiting', `${nextGroup.length} pro(s) (${nextGroup[0].label}) at ${fmt(next)} ET, in ${span(next - t)} — ${live.length} still to go; leave this window and the Mac as they are (Ctrl-C stops)`);
      while (!stop && now() < next && !(until && now() >= until)) {
        await wait(Math.min(D.pollMs, Math.max(1000, next - now())));
        await tick('routine check');
        if (now().getTime() - lastSaid >= D.stillWaitingEveryMs) { lastSaid = now().getTime(); log('⏳', 'Still waiting', `next: ${nextGroup.length} ${nextGroup[0].label} pro(s) at ${fmt(next)} ET, in ${span(next - now())} — Chrome and Salesforce are checked every ${Math.round(D.healthEveryMs / 60000)} min${attention ? ` (⚠️ ${attention})` : ''}`); }
      }
    }

    const c = counts();
    console.log(`\n  🏁 Overnight run ${stop ? 'stopped' : 'finished'}: ${c.texted} text(s) sent · ${c.failed} not sent · ${c.missed} missed (window closed) · ${c.skipped} left out (texted by another run, or now a customer / closed-won)${c.pending ? ` · ${c.pending} still waiting (stopped early)` : ''}${recoveries ? ` · ${recoveries} browser repair(s)` : ''}.`);
    if (c.failed) console.log(`     not sent: ${entries.filter((e) => e.status === 'failed').slice(0, 8).map((e) => e.lead.name).join(', ')}${c.failed > 8 ? ' …' : ''} — they stay in the queue. Try them again with  email --queue --send --template N  (once their 8:00 AM has come; at night add --tomorrow)`);
    if (c.missed) console.log(`     missed: ${entries.filter((e) => e.status === 'missed').slice(0, 8).map((e) => e.lead.name).join(', ')}${c.missed > 8 ? ' …' : ''} — they stay in the queue for the next run`);
    console.log('     Dashboard: email --sent\n');
    try { notify(`Overnight run ${stop ? 'stopped' : 'finished'}: ${c.texted} texted, ${c.failed} not sent, ${c.missed} missed.`); } catch (_) {}
    return { sent: c.texted, ...c, entries, left: plan.left };
  } finally {
    if (!deps.noSignals) process.removeListener('SIGINT', onInt);
    if (ownSession) { try { await session.close(); } catch (_) {} }   // a Chrome relaunch opens a link of its own that Assistant.js does not close: left open it keeps this process (and `caffeinate -w`) alive for ever
    if (!deps.noExitGuard) setTimeout(() => process.exit(0), 15000).unref();   // and if anything else still holds the process 15 s after the run ended, let go of it anyway
  }
}

module.exports = {
  FILES, DEFAULTS, NO_TEXT, PORT, PROFILE_DIR,
  nextStart, closeAfter, planFor, groupsOf, printPlan, preview, defaultScreen,
  acquireLock, releaseLock, notifyMac, labelOf,
  runTomorrow,
};
