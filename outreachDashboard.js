'use strict';

/**
 * outreachDashboard — a small LIVE page of everyone the bot texts or emails.
 *
 * WHAT: outreach-dashboard/index.html is a plain local file (no server, no port, nothing to sign in to). It lists every send, newest first, with counters for this run,
 * today and all time, and it refreshes itself a few seconds after each send WITHOUT reloading (so a filter, a search or an open message stays as it is). Click a row for the
 * exact text or email that went out.
 *
 * WHERE THE DATA COMES FROM: texted-log.jsonl (textLog.js), the permanent record of every successful text and email. This file adds nothing to that log and sends nothing.
 * Touches added by hand (mode 'manual', "not sent by Pipeline Assistant") are left out: the page is about what the bot sent.
 * After every logged send, textLog.recordOutreach() calls touch(), which rewrites outreach-dashboard/data.js; the page re-reads that file every few seconds (a plain
 * <script> reload, the one way a page opened from a file can read another file).
 * The bigger "Outreach Log" page (texted-dashboard.html, `email --sent`) is a different thing and is not touched by any of this.
 *
 * WHEN IT OPENS: run.sh runs `node outreachDashboard.js --launch <the run's flags>` once per launch, before the browser starts. `node outreachDashboard.js` on its own
 * builds the page and opens it; `--build` only builds it.
 *
 * "THIS RUN" is counted from the start of the newest process that has SENT something (its first send writes run.json: pid + start time; the stamp only ever moves forward).
 * A launch that sends nothing (a read-only mode, a refused second start, a practice run) therefore never moves it. A fresh launch shows "since now" unless a sending run is
 * still alive (its pid is checked), in which case that run's start is kept.
 *
 * SAFETY: every entry point swallows its own errors, so a problem here can never stop a send (the rewrite itself takes a few milliseconds after each one). There are no timers,
 * no exit handlers and no signal handlers in the bot's process. ASSISTANT_NO_DASHBOARD=1 turns the whole thing off (nothing is opened and nothing is written). What reaches the
 * page from the log (business names, messages) is shown as text, never as HTML, and only http(s) links are made clickable.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, 'outreach-dashboard');
const PAGE = path.join(DIR, 'index.html');
const DATA = path.join(DIR, 'data.js');
const RUN_FILE = path.join(DIR, 'run.json');         // { startedAt, pid } of the newest process that has sent something
const LOG_FILE = path.join(__dirname, 'texted-log.jsonl');
const FULL_DASH = path.join(__dirname, 'texted-dashboard.html');   // the bigger Outreach Log page (email --sent): linked from this one once it exists

const MAX_ROWS = 1000;          // the page always holds at least the newest 1000 sends (All time counts the whole log) ...
const MAX_WINDOW_ROWS = 5000;   // ... and every send since the start of yesterday, up to this many: Today and This run are counted from the rows on the page, so they must all be there
const MAX_TEXT = 4000;          // characters of one message / email body kept for the page
const SKIP_OPEN = new Set(['--help', '-h', '--inspect', '--sent', '--texted', '--dashboard']);   // launches that send nothing and just print or open something else
const DRY_FLAGS = new Set(['--dry-run', '--dryrun', '--test']);
// When THIS process started. Captured once, from the clock (performance.timeOrigin), because process.uptime() stands still while the Mac sleeps.
const PROC_START = (typeof performance === 'object' && performance && performance.timeOrigin) ? Math.round(performance.timeOrigin) : Date.now() - Math.round(process.uptime() * 1000);

/** ASSISTANT_NO_DASHBOARD switches it off. Unset, empty, 0, false, no and off all mean "leave it on" (run.sh reads it the same way). */
const off = () => { const v = String(process.env.ASSISTANT_NO_DASHBOARD || '').trim().toLowerCase(); return !(v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off'); };
const str = (v) => (v == null ? null : (String(v).trim() || null));
const clip = (v) => { const s = v == null ? '' : String(v); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : (s || null); };
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const alive = (pid) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } };   // signal 0 only asks "is there such a process?"

/** Every row of the log, oldest → newest. textLog.readAll() is the one reader (it also drops touches added by hand and taken back); if that cannot load, read the file directly. */
function readRows() {
  try { return require('./textLog').readAll(); } catch (_) { /* fall through */ }
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** One log row, cut down to what the page shows. */
function slim(r) {
  const channel = r.channel === 'email' ? 'email' : 'text';       // rows with no channel are old texts (same rule as textLog.rowChannel)
  return {
    at: r.at,
    channel,
    name: str(r.accountName) || str(r.email) || '(no name)',
    url: safeUrl(r.accountUrl),
    email: str(r.email),
    template: str(r.templateName),
    subject: channel === 'email' ? str(r.subject) : null,
    text: clip(channel === 'email' ? r.body : r.message),
    mode: str(r.mode),
    step: r.step ? (Number(r.step) || null) : null,
  };
}

function readRun() {
  try { const j = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); const t = Date.parse(j.startedAt); return t > 0 ? { t, pid: Number(j.pid) || 0 } : null; } catch (_) { return null; }
}

/**
 * The page's "this run" start, and whether the launch carried a practice flag.
 *   'send'   : a rewrite after a logged send. The newest process that has sent anything stamps run.json once (its own start; the stamp never moves back). Never a practice run.
 *   'launch' : run.sh starting a run. "Since now", unless the process that stamped run.json is still alive: then its start is kept (a read-only mode or a refused second start
 *              must not reset a live run's count). Writes nothing.
 *   'view'   : `node outreachDashboard.js` / --build: whatever was stamped last (or now). Writes nothing.
 */
function runInfo(kind, flags) {
  const saved = readRun();
  if (kind === 'send') {
    let t = saved ? saved.t : 0;
    if (PROC_START > t) {
      t = PROC_START;
      try { writeAtomic(RUN_FILE, JSON.stringify({ startedAt: new Date(t).toISOString(), pid: process.pid }) + '\n'); } catch (_) { /* the page still counts from t */ }
    }
    return { startedAt: new Date(t).toISOString(), dryRun: false };
  }
  if (kind === 'launch') {
    const keep = saved && alive(saved.pid);
    return { startedAt: new Date(keep ? saved.t : Date.now()).toISOString(), dryRun: (flags || []).some((f) => DRY_FLAGS.has(f)) };
  }
  return { startedAt: new Date(saved ? saved.t : Date.now()).toISOString(), dryRun: false };
}

/** Everything the page needs. */
function buildData(kind, flags) {
  const all = readRows().filter((r) => r && r.mode !== 'manual' && Number.isFinite(Date.parse(r.at)));
  let texts = 0, emails = 0;
  const people = new Set();
  for (const r of all) {
    if (r.channel === 'email') emails++; else texts++;
    people.add(k15(r.accountId) || String(r.accountName || r.email || r.accountUrl || '?').toLowerCase());
  }
  const sorted = all.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const since = new Date().setHours(0, 0, 0, 0) - 24 * 3600 * 1000;      // the start of yesterday (an hour either way on a daylight-saving day does not matter)
  let keep = Math.min(MAX_ROWS, sorted.length);
  while (keep < sorted.length && keep < MAX_WINDOW_ROWS && Date.parse(sorted[keep].at) >= since) keep++;
  const rows = sorted.slice(0, keep).map(slim);
  return {
    v: 1,
    generatedAt: new Date().toISOString(),
    run: runInfo(kind, flags),
    totals: { sends: all.length, texts, emails, people: people.size },
    truncated: all.length > rows.length,
    fullLog: fs.existsSync(FULL_DASH),
    dataLog: (() => { try { return require('./outreachDataLog').summary(); } catch (_) { return null; } })(),      // this rep's own data log: its name, who and which computer, how many sends
    rows,
  };
}

/** Write a file so that a page reading it at that moment sees the old one or the new one, never half of it. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** The page itself is the same every time; (re)write it only when it is missing or an older version. */
function ensurePage() {
  let cur = null;
  try { cur = fs.readFileSync(PAGE, 'utf8'); } catch (_) { /* not there yet */ }
  if (cur !== PAGE_HTML) writeAtomic(PAGE, PAGE_HTML);
}

function flush(kind, flags) {
  writeAtomic(DATA, 'window.OUTREACH_DATA = ' + JSON.stringify(buildData(kind, flags)) + ';\n');
}

/**
 * Called by textLog.recordOutreach() after every logged send: rewrite data.js right away (a few milliseconds; ~50 ms for a log of 20,000 sends). Never throws; after three
 * failures in a row it gives up for this process. (No timer and no exit handler: nothing here can outlive or hold up the bot's process.)
 */
let fails = 0;
function touch() {
  if (off() || fails >= 3) return;
  try { ensurePage(); flush('send'); fails = 0; } catch (_) { fails++; }
}

/** Build the page + data. → the page's path, or null if it could not be written (or the dashboard is switched off). */
function build(kind = 'view', flags) {
  if (off()) return null;
  try { ensurePage(); flush(kind, flags); return PAGE; } catch (_) { return null; }
}

/** Open a file in the default browser. Fire and forget: a missing `open` never matters. */
function openPage(file) {
  try {
    const cmd = process.platform === 'darwin' ? ['open', [file]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]];
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) { return false; }
}

/** What run.sh calls once per launch: build the page for this run, then open it. → the page's path, 'skipped' (a launch that sends nothing, or switched off) or 'failed'. */
function launch(flags = []) {
  if (off() || flags.some((f) => SKIP_OPEN.has(f))) return 'skipped';
  const file = build('launch', flags);
  if (!file) return 'failed';
  openPage(file);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE PAGE. One self-contained file: no network, no libraries, no fonts to fetch. It must not contain a backtick or a dollar-brace (it is a template literal), and everything
// that comes from the log goes in with textContent, never innerHTML.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outreach</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%AC%3C/text%3E%3C/svg%3E">
<style>
:root{
  --bg:#f5f6fa;--surface:#ffffff;--text:#19202e;--muted:#5b6578;--line:#e2e6ef;
  --accent:#2457d6;--on-accent:#ffffff;--good:#178a4a;
  --text-fg:#0b6b60;--text-bg:#d5f5ee;--email-fg:#5b2bb8;--email-bg:#ece5fd;
  --warn-fg:#8a4b00;--warn-bg:#fff1d1;--fresh:#fff1b8;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e131b;--surface:#161c27;--text:#e7ebf2;--muted:#98a3b6;--line:#263044;
    --accent:#7ba3ff;--on-accent:#0b1220;--good:#4ade80;
    --text-fg:#5eead4;--text-bg:#0f3b36;--email-fg:#c4b1ff;--email-bg:#2b2150;
    --warn-fg:#ffcc80;--warn-bg:#3a2a0c;--fresh:#4a4210;
  }
}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:20px 16px 48px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:22px;letter-spacing:-.01em}
.sub{margin:4px 0 0;color:var(--muted);font-size:13px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:7px;vertical-align:1px}
.dot.live{background:var(--good)}
.link{color:var(--accent);font-size:13px;text-decoration:none;padding-top:6px}
.link:hover{text-decoration:underline}
.banner{margin:14px 0 0;padding:10px 14px;border-radius:10px;background:var(--warn-bg);color:var(--warn-fg);font-size:14px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.card .n{font-size:34px;font-weight:700;line-height:1.1;margin-top:4px;font-variant-numeric:tabular-nums}
.card .s{font-size:13px;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:18px 0 10px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.seg button{border:0;background:transparent;color:var(--muted);padding:8px 14px;font:inherit;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);font-weight:600}
select,input[type=search]{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
input[type=search]{flex:1;min-width:180px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tablewrap{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tr.day td{background:var(--bg);color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:6px 14px}
tr.row{cursor:pointer}
tr.row:hover td{background:rgba(127,127,127,.07)}
tr.fresh td{animation:flash 6s ease-out}
@keyframes flash{0%,35%{background:var(--fresh)}100%{background:transparent}}
.time{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
.ago{display:block;color:var(--muted);font-size:12px;white-space:nowrap}
.who a{color:var(--text);font-weight:600;text-decoration:none}
.who a:hover{text-decoration:underline}
.who .nm{font-weight:600}
.em{color:var(--muted);font-size:13px;word-break:break-all}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.text{background:var(--text-bg);color:var(--text-fg)}
.pill.email{background:var(--email-bg);color:var(--email-fg)}
.tpl{font-weight:600}
.prev{display:block;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}
tr.detail td{background:var(--bg);padding:12px 14px 16px}
.meta{color:var(--muted);font-size:12px;margin:0 0 8px}
pre.msg{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.empty{padding:34px 16px;text-align:center;color:var(--muted)}
.foot{margin:12px 2px 0;color:var(--muted);font-size:12px}
@media (max-width:680px){
  .wrap{padding:14px 12px 40px}
  .cards{gap:8px}
  .card{padding:10px 12px}
  .card .n{font-size:26px}
  .card .s{font-size:12px}
  thead{display:none}
  table,tbody,tr,td{display:block;width:100%}
  tr.row{padding:10px 12px;border-bottom:1px solid var(--line)}
  td{border:0;padding:2px 0}
  tr.day td{padding:6px 12px}
  td.t{display:flex;gap:8px;align-items:baseline}
  .ago{display:inline}
  .prev{max-width:100%;white-space:normal}
  tr.detail{padding:0 12px 12px;border-bottom:1px solid var(--line)}
  tr.detail td{padding:8px 0}
}
@media (prefers-reduced-motion:reduce){tr.fresh td{animation:none}}
</style>
</head>
<body>
<main class="wrap">
  <header class="top">
    <div>
      <h1>Outreach</h1>
      <p class="sub"><span class="dot" id="dot"></span><span id="status">Waiting for outreach-dashboard/data.js …</span></p>
    </div>
    <a class="link" id="fullLog" href="../texted-dashboard.html" hidden>Full outreach log &rarr;</a>
  </header>
  <div class="banner" id="banner" hidden>Practice flag in use (--test / --dry-run). This page lists only sends that actually went out, so it stays empty unless one does.</div>
  <section class="cards" aria-label="Totals">
    <div class="card"><div class="k" id="kRun">This run</div><div class="n" id="nRun">0</div><div class="s" id="sRun"></div></div>
    <div class="card"><div class="k">Today</div><div class="n" id="nToday">0</div><div class="s" id="sToday"></div></div>
    <div class="card"><div class="k">All time</div><div class="n" id="nAll">0</div><div class="s" id="sAll"></div></div>
  </section>
  <section class="controls" aria-label="Filters">
    <div class="seg" role="group" aria-label="Channel">
      <button type="button" data-ch="all" aria-pressed="true">All</button>
      <button type="button" data-ch="text" aria-pressed="false">Texts</button>
      <button type="button" data-ch="email" aria-pressed="false">Emails</button>
    </div>
    <select id="range" aria-label="Time range">
      <option value="run">This run</option>
      <option value="today">Today</option>
      <option value="week">Last 7 days</option>
      <option value="all">Everything</option>
    </select>
    <input id="q" type="search" placeholder="Search name, address, message …" aria-label="Search">
  </section>
  <div class="tablewrap">
    <table>
      <thead><tr><th>When</th><th>Who</th><th>How</th><th>What was sent</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden></div>
  </div>
  <p class="foot" id="foot"></p>
</main>
<script src="data.js"></script>
<script>
(function () {
  'use strict';
  var POLL_MS = 3000, MAX_DRAWN = 500, LS = 'outreach-dashboard:';
  var state = { channel: 'all', range: 'today', q: '', open: {}, fresh: {}, rows: [], d: null, gen: null, newest: 0 };

  function $(id) { return document.getElementById(id); }
  function make(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function lsGet(k) { try { return window.localStorage.getItem(LS + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(LS + k, v); } catch (e) {} }

  var c0 = lsGet('channel'); if (c0 === 'text' || c0 === 'email') state.channel = c0;
  var r0 = lsGet('range'); if (r0 === 'run' || r0 === 'today' || r0 === 'week' || r0 === 'all') state.range = r0;

  var fTime = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  var fTimeSec = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  var fDay = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });
  var fFull = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  var fNum = new Intl.NumberFormat();

  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dayLabel(t) {
    var today = startOfDay(Date.now()), s = startOfDay(t);
    if (s === today) return 'Today';
    if (s === startOfDay(today - 12 * 3600 * 1000)) return 'Yesterday';
    return fDay.format(new Date(t));
  }
  // a time of day, with the date in front when it is not today (so an old page never looks current)
  function stamp(t, withSeconds) {
    var d = new Date(t), tm = (withSeconds ? fTimeSec : fTime).format(d);
    return startOfDay(t) === startOfDay(Date.now()) ? tm : fDay.format(d) + ' ' + tm;
  }
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + ' s ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60) + ' min ago';
    var dd = Math.floor(h / 24);
    return dd + (dd === 1 ? ' day ago' : ' days ago');
  }
  function data() {
    var d = window.OUTREACH_DATA;
    return d && d.v === 1 && d.rows && typeof d.rows.length === 'number' ? d : null;
  }
  function href(u) { return typeof u === 'string' && /^https?:[/][/]/i.test(u) ? u : null; }

  // A new data.js arrived: keep the rows with their time parsed and a lower-case search string; remember which rows are new.
  function ingest(d) {
    var first = state.gen === null, prev = state.newest, now = Date.now(), i, r, e, newest = prev, rows = [];
    for (i = 0; i < d.rows.length; i++) {
      r = d.rows[i];
      e = { r: r, t: Date.parse(r.at), key: r.at + '|' + r.channel + '|' + r.name };
      e.hay = [r.name, r.email, r.template, r.subject, r.text, r.mode].join(' ').toLowerCase();
      if (!isFinite(e.t)) continue;
      if (e.t > newest) newest = e.t;
      if (!first && e.t > prev) state.fresh[e.key] = now + 6000;
      rows.push(e);
    }
    state.gen = d.generatedAt;
    state.rows = rows;
    state.newest = newest;
  }

  function inRange(t, d) {
    if (state.range === 'all') return true;
    if (state.range === 'run') { var s = Date.parse(d.run && d.run.startedAt); return isFinite(s) && t >= s; }
    var today = startOfDay(Date.now());
    if (state.range === 'today') return t >= today;
    var wk = new Date(); wk.setDate(wk.getDate() - 6); wk.setHours(0, 0, 0, 0);
    return t >= wk.getTime();
  }

  function tally(list) { var t = 0, m = 0, i; for (i = 0; i < list.length; i++) { if (list[i].r.channel === 'email') m++; else t++; } return { text: t, email: m, all: t + m }; }
  function split(c) { return 'texts ' + fNum.format(c.text) + ' · emails ' + fNum.format(c.email); }

  function renderCards(d) {
    var today = startOfDay(Date.now()), rs = Date.parse(d.run && d.run.startedAt), a = [], b = [], i, e;
    for (i = 0; i < state.rows.length; i++) {
      e = state.rows[i];
      if (e.t >= today) a.push(e);
      if (isFinite(rs) && e.t >= rs) b.push(e);
    }
    var run = tally(b), tod = tally(a);
    $('nRun').textContent = fNum.format(run.all); $('sRun').textContent = split(run);
    $('nToday').textContent = fNum.format(tod.all); $('sToday').textContent = split(tod);
    var t = d.totals || {};
    $('nAll').textContent = fNum.format(t.sends || 0);
    $('sAll').textContent = split({ text: t.texts || 0, email: t.emails || 0 }) + ' · people ' + fNum.format(t.people || 0);
    $('kRun').textContent = 'This run' + (isFinite(rs) ? ' · since ' + stamp(rs, false) : '');
    document.title = 'Outreach · ' + fNum.format(tod.all) + ' today';
  }

  function whatNodes(r) {
    var box = document.createElement('div');
    if (r.channel === 'email') {
      box.appendChild(make('div', 'tpl', r.subject || r.template || 'Email'));
      if (r.template && r.subject) box.appendChild(make('span', 'prev', r.template));
    } else {
      box.appendChild(make('div', 'tpl', r.template || 'Text'));
      if (r.text) box.appendChild(make('span', 'prev', r.text));
    }
    return box;
  }

  function rowNodes(e) {
    var r = e.r, tr = make('tr', 'row' + (state.fresh[e.key] > Date.now() ? ' fresh' : '')), det = make('tr', 'detail'), td, link, pill;
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('aria-expanded', state.open[e.key] ? 'true' : 'false');
    td = make('td', 't');
    td.appendChild(make('span', 'time', fTime.format(new Date(e.t))));
    var ag = make('span', 'ago', ago(e.t)); ag.setAttribute('data-t', String(e.t)); td.appendChild(ag);
    tr.appendChild(td);
    td = make('td', 'who');
    var h = href(r.url);
    if (h) { link = make('a', null, r.name); link.href = h; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = 'Open the account in Salesforce'; link.addEventListener('click', function (ev) { ev.stopPropagation(); }); td.appendChild(link); }
    else td.appendChild(make('span', 'nm', r.name));
    if (r.email) td.appendChild(make('div', 'em', r.email));
    tr.appendChild(td);
    td = make('td', 'how'); pill = make('span', 'pill ' + (r.channel === 'email' ? 'email' : 'text'), r.channel === 'email' ? 'Email' : 'Text'); td.appendChild(pill); tr.appendChild(td);
    td = make('td', 'what'); td.appendChild(whatNodes(r)); tr.appendChild(td);

    td = make('td'); td.colSpan = 4;
    var bits = [fFull.format(new Date(e.t))];
    if (r.template) bits.push(r.template);
    if (r.mode) bits.push('mode: ' + r.mode);
    if (r.step) bits.push('step ' + r.step);
    td.appendChild(make('p', 'meta', bits.join(' · ')));
    if (r.channel === 'email' && r.subject) td.appendChild(make('p', 'meta', 'Subject: ' + r.subject));
    td.appendChild(make('pre', 'msg', r.text || '(no message was recorded)'));
    det.appendChild(td);
    det.hidden = !state.open[e.key];

    function toggle() { var o = !state.open[e.key]; state.open[e.key] = o; det.hidden = !o; tr.setAttribute('aria-expanded', o ? 'true' : 'false'); }
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    return [tr, det];
  }

  function renderTable(d) {
    var body = $('rows'), q = state.q.toLowerCase(), list = [], i, e;
    for (i = 0; i < state.rows.length; i++) {
      e = state.rows[i];
      if (state.channel !== 'all' && e.r.channel !== state.channel) continue;
      if (!inRange(e.t, d)) continue;
      if (q && e.hay.indexOf(q) < 0) continue;
      list.push(e);
    }
    var frag = document.createDocumentFragment(), lastDay = null, n = Math.min(list.length, MAX_DRAWN), lab, dr, dtd, nodes;
    for (i = 0; i < n; i++) {
      lab = dayLabel(list[i].t);
      if (lab !== lastDay) { lastDay = lab; dr = make('tr', 'day'); dtd = make('td', null, lab); dtd.colSpan = 4; dr.appendChild(dtd); frag.appendChild(dr); }
      nodes = rowNodes(list[i]); frag.appendChild(nodes[0]); frag.appendChild(nodes[1]);
    }
    body.textContent = '';
    body.appendChild(frag);
    var em = $('empty');
    if (!list.length) {
      em.hidden = false;
      em.textContent = !d.totals || !d.totals.sends ? 'Nothing has been sent yet. Everyone this script texts or emails will show up here, a few seconds after the send.' : 'No sends match these filters.';
    } else em.hidden = true;
    $('foot').textContent = (list.length > n ? 'Showing the newest ' + fNum.format(n) + ' of ' + fNum.format(list.length) + ' matching sends. ' : '') +
      (d.truncated ? 'This page holds the newest ' + fNum.format(d.rows.length) + ' of ' + fNum.format(d.totals.sends) + ' sends: Today and This run are counted from those, All time counts the whole log. ' : '') +
      'Source: texted-log.jsonl. Times are in this computer’s time zone.' + (d.dataLog && d.dataLog.file ? ' Your own data log, kept only on this computer: ' + d.dataLog.file + ' (' + [d.dataLog.rep, d.dataLog.computer, typeof d.dataLog.count === 'number' ? fNum.format(d.dataLog.count) + ' sends saved' + (isFinite(Date.parse(d.dataLog.since)) ? ' since ' + fDay.format(new Date(d.dataLog.since)) : '') : null].filter(Boolean).join(' · ') + ').' + (d.dataLog.error ? ' ⚠️ ' + d.dataLog.error : '') : '');
  }

  var curDay = startOfDay(Date.now());
  function renderStatus() {
    var d = state.d, s = $('status'), dot = $('dot'), els, i, day = startOfDay(Date.now());
    if (d && day !== curDay) { curDay = day; renderAll(); return; }      // midnight went by: "Today" and the day headings move on without waiting for the next send
    if (!d) { dot.className = 'dot'; s.textContent = 'Waiting for outreach-dashboard/data.js …'; return; }
    dot.className = 'dot live';
    s.textContent = 'Updated ' + stamp(Date.parse(d.generatedAt), true) + ' · ' +
      (state.rows.length ? 'last send ' + ago(state.rows[0].t) : 'nothing sent yet') + ' · looks for new sends every ' + (POLL_MS / 1000) + ' s';
    els = document.querySelectorAll('[data-t]');
    for (i = 0; i < els.length; i++) els[i].textContent = ago(Number(els[i].getAttribute('data-t')));
  }

  function renderAll() {
    var d = state.d;
    if (!d) { $('rows').textContent = ''; $('empty').hidden = false; $('empty').textContent = 'Waiting for the first data …'; renderStatus(); return; }
    $('banner').hidden = !(d.run && d.run.dryRun);
    $('fullLog').hidden = !d.fullLog;
    renderCards(d); renderTable(d); renderStatus();
  }

  // A data.js arrived. Only a NEWER one is taken (ISO times compare as text), so a slow older load can never put the page back in time.
  function onData() {
    var d = data();
    if (d && (state.d === null || d.generatedAt > state.d.generatedAt)) { ingest(d); state.d = d; renderAll(); }
    else if (!state.d) renderAll();
    else renderStatus();
  }

  function syncControls() {
    var b = document.querySelectorAll('.seg button'), i;
    for (i = 0; i < b.length; i++) b[i].setAttribute('aria-pressed', b[i].getAttribute('data-ch') === state.channel ? 'true' : 'false');
    $('range').value = state.range;
  }
  (function wire() {
    var b = document.querySelectorAll('.seg button'), i, timer = null;
    for (i = 0; i < b.length; i++) b[i].addEventListener('click', function () { state.channel = this.getAttribute('data-ch'); lsSet('channel', state.channel); syncControls(); if (state.d) renderTable(state.d); });
    $('range').addEventListener('change', function () { state.range = this.value; lsSet('range', state.range); if (state.d) renderTable(state.d); });
    $('q').addEventListener('input', function () { var v = this.value; clearTimeout(timer); timer = setTimeout(function () { state.q = v.trim(); if (state.d) renderTable(state.d); }, 120); });
  })();

  // Re-read data.js every few seconds. A page opened from a file cannot fetch another file, but it can load a script: a new <script> with a changing address always re-reads it.
  // Whatever goes wrong while showing one data.js, the next poll is always scheduled.
  var seq = 0;
  function load(then) {
    var s = document.createElement('script');
    function done() {
      try { if (s.parentNode) s.parentNode.removeChild(s); onData(); }
      catch (e) { try { $('status').textContent = 'Could not show the latest data (' + (e && e.message ? e.message : 'unknown error') + ') · trying again'; } catch (e2) {} }
      finally { if (then) then(); }
    }
    s.onload = done; s.onerror = done;
    s.src = 'data.js?_=' + Date.now() + '-' + (seq++);
    document.head.appendChild(s);
  }
  function poll() {
    if (document.hidden) { setTimeout(poll, POLL_MS); return; }      // nobody is looking: do nothing until the tab is shown again
    load(function () { setTimeout(poll, POLL_MS); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });      // back on this tab: catch up at once

  syncControls();
  try { onData(); } catch (e) {}
  setTimeout(poll, POLL_MS);
  setInterval(function () { try { renderStatus(); } catch (e) {} }, 1000);
})();
</script>
</body>
</html>
`;

module.exports = { touch, build, launch, openPage, buildData, PAGE, DATA, DIR };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--launch') {
    let r = 'failed';
    try { r = launch(rest); } catch (_) { /* reported below */ }
    process.exitCode = r === 'failed' ? 1 : 0;      // run.sh prints one warning line on a failure; a skipped launch is not one
  } else if (cmd === '--help' || cmd === '-h') {
    console.log('outreachDashboard.js — the live outreach page (outreach-dashboard/index.html)\n  node outreachDashboard.js            build it and open it in your browser\n  node outreachDashboard.js --build    build it only (print its path)\n  ASSISTANT_NO_DASHBOARD=1               switch it off (run.sh opens nothing, no send writes it)');
  } else if (cmd === '--build') {
    const f = build();
    console.log(f || 'The outreach dashboard could not be written (or ASSISTANT_NO_DASHBOARD is set).');
    process.exitCode = f ? 0 : 1;
  } else {
    const f = build();
    if (!f) { console.log('The outreach dashboard could not be written (or ASSISTANT_NO_DASHBOARD is set).'); process.exitCode = 1; }
    else { console.log(`\n  📬 Outreach dashboard: ${f}\n     file://${f}\n`); openPage(f); }
  }
}
