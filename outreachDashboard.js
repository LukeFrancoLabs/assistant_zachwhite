'use strict';

/**
 * outreachDashboard — LIVE local page of everyone the bot texts or emails, plus editable templates and an analytics / replies board.
 *
 * WHAT: run.sh opens http://127.0.0.1:9340/ (ASSISTANT_DASHBOARD_PORT). Tabs: Sends · Templates · Analytics.
 *   Sends     — every bot send, newest first; refreshes a few seconds after each send.
 *   Templates — every text (Settings > T / text-templates.json) and email (email-templates.json); edit in the browser; used on the next launch.
 *   Analytics — send + reply totals, template scorecard, recent replies (replies.jsonl).
 * A detached `node outreachDashboard.js --serve` keeps the APIs up so edits work after the launch script exits.
 * File fallback (outreach-dashboard/index.html) still works for Sends only; Templates/Analytics need localhost.
 *
 * WHERE THE DATA COMES FROM: texted-log.jsonl (sends), text-templates.json / email-templates.json (templates), replies.jsonl (replies).
 * Touches added by hand (mode 'manual') are left out of Sends. The bigger "Outreach Log" (`email --sent`) is separate.
 *
 * SAFETY: send-path entry points swallow errors. ASSISTANT_NO_DASHBOARD=1 turns the whole thing off. Names/messages are shown as text, never HTML.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, 'outreach-dashboard');
const PAGE = path.join(DIR, 'index.html');
const PAGE_SRC = path.join(__dirname, 'outreachDashboard.html'); // tracked source; copied into DIR on build
const DATA = path.join(DIR, 'data.js');
const RUN_FILE = path.join(DIR, 'run.json');         // { startedAt, pid } of the newest process that has sent something
const PID_FILE = path.join(DIR, 'server.pid');
const LOG_FILE = path.join(__dirname, 'texted-log.jsonl');
const EMAIL_TEMPLATES = path.join(__dirname, 'email-templates.json');
const FULL_DASH = path.join(__dirname, 'texted-dashboard.html');   // the bigger Outreach Log page (email --sent): linked from this one once it exists
const PORT = Math.max(1, Number(process.env.ASSISTANT_DASHBOARD_PORT) || 9340);
const HOST = '127.0.0.1';

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

/** The page itself is the tracked outreachDashboard.html; (re)write the copy under outreach-dashboard/ when missing or stale. */
function pageHtml() {
  return fs.readFileSync(PAGE_SRC, 'utf8');
}
function ensurePage() {
  const html = pageHtml();
  let cur = null;
  try { cur = fs.readFileSync(PAGE, 'utf8'); } catch (_) { /* not there yet */ }
  if (cur !== html) writeAtomic(PAGE, html);
}

function flush(kind, flags) {
  writeAtomic(DATA, 'window.OUTREACH_DATA = ' + JSON.stringify(buildData(kind, flags)) + ';\n');
}

// ---- Templates + analytics (localhost APIs) ----------------------------------------------------------------

function templatesPayload() {
  const setup = require('./senderSetup');
  let values = {};
  try { values = setup.load().values || {}; } catch (_) { /* preview without sender.json */ }
  const view = setup.textsView();
  const texts = view.items.map((item) => ({
    id: item.id,
    name: item.name,
    text: item.text,
    kind: item.kind,
    channel: 'text',
    preview: setup.expandTokens(item.text, values),
  }));
  let emails = [];
  try {
    const all = JSON.parse(fs.readFileSync(EMAIL_TEMPLATES, 'utf8')) || {};
    emails = Object.keys(all).filter((k) => !k.startsWith('_') && all[k] && typeof all[k] === 'object').map((key) => {
      const t = all[key];
      const body = Array.isArray(t.body) ? t.body.join('\n') : String(t.body || '');
      return { key, name: t.name || key, subject: t.subject || '', body, ps: t.ps || '', channel: 'email' };
    });
  } catch (_) { /* missing file */ }
  return { texts, emails, generatedAt: new Date().toISOString() };
}

function saveEmailTemplate(key, payload) {
  let all;
  try { all = JSON.parse(fs.readFileSync(EMAIL_TEMPLATES, 'utf8')); } catch (e) { return { ok: false, error: 'Could not read email-templates.json: ' + e.message }; }
  if (!all || typeof all !== 'object' || !all[key] || typeof all[key] !== 'object') return { ok: false, error: 'No email template "' + key + '".' };
  const name = String(payload.name == null ? all[key].name : payload.name).trim();
  const subject = String(payload.subject == null ? '' : payload.subject).trim();
  const bodyRaw = payload.body == null ? '' : payload.body;
  const body = Array.isArray(bodyRaw) ? bodyRaw.map(String) : String(bodyRaw).replace(/\r\n?/g, '\n').split('\n');
  if (!name) return { ok: false, error: 'Please give the email a name.' };
  if (!subject) return { ok: false, error: 'Please give the email a subject.' };
  if (!body.some((l) => String(l).trim())) return { ok: false, error: 'The body is empty.' };
  const next = { ...all[key], name, subject, body };
  const ps = payload.ps == null ? '' : String(payload.ps).trim();
  if (ps) next.ps = ps; else delete next.ps;
  all[key] = next;
  try { writeAtomic(EMAIL_TEMPLATES, JSON.stringify(all, null, 2) + '\n'); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
  return { ok: true };
}

function analyticsPayload() {
  const all = readRows().filter((r) => r && r.mode !== 'manual' && Number.isFinite(Date.parse(r.at)));
  let texts = 0, emails = 0;
  for (const r of all) { if (r.channel === 'email') emails++; else texts++; }
  let replies = [];
  try { replies = require('./textLog').readReplyRows(); } catch (_) { replies = []; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  let interested = 0, optout = 0, gift = 0, repliesToday = 0;
  const NOTE_RE = /^\s*\[Top hit list\]/i;
  const slim = [];
  for (const r of replies) {
    if (r.manual || NOTE_RE.test(r.reply || '')) continue;
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && t >= t0) repliesToday++;
    if (r.interested && !r.optout) interested++;
    if (r.optout) optout++;
    if (r.gift) gift++;
    slim.push({
      at: r.at,
      name: r.accountName || '(unknown)',
      ch: r.channel === 'email' ? 'email' : 'text',
      reply: clip(r.reply || ''),
      interested: !!r.interested,
      optout: !!r.optout,
      gift: !!r.gift,
      ind: r.ind || null,
      url: r.accountId ? (() => { try { return require('./sfId').fixUrl('https://housecallpro.lightning.force.com/lightning/r/Account/' + r.accountId + '/view'); } catch (_) { return null; } })() : null,
    });
  }
  slim.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  let templates = [];
  let note = '';
  try {
    const textLog = require('./textLog');
    const perf = require('./perfAnalytics').build({
      rows: all,
      replies,
      won: [...textLog.readClosedWon().values()],
      indOf: (name, id) => textLog.indFields(name, id),
      zonesFor: (id) => textLog.zonesFor(id),
      isBanned: (id) => textLog.isBanned(id),
      sfUrl: (id) => require('./sfId').fixUrl('https://housecallpro.lightning.force.com/lightning/r/Account/' + id + '/view'),
    });
    templates = (perf.templates || []).slice(0, 40);
    note = (perf.replyTotal || 0) + ' replies credited to a message; ' + (perf.unattributed || 0) + ' unmatched. ' + (perf.sendTotal || 0).toLocaleString() + ' messages in the log.';
  } catch (e) {
    note = 'Template scorecard unavailable (' + (e && e.message ? e.message : 'error') + '). Reply list still shows.';
  }
  return {
    sends: all.length, texts, emails,
    replyTotal: slim.length, repliesToday, interested, optout, gift,
    templates,
    replies: slim.slice(0, 300),
    note,
    generatedAt: new Date().toISOString(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 2e6) { reject(new Error('Body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, type, text) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function handleApi(req, res, url) {
  const setup = require('./senderSetup');
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });
  if (req.method === 'GET' && url.pathname === '/api/templates') {
    try { return sendJson(res, 200, templatesPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/analytics') {
    try { return sendJson(res, 200, analyticsPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/templates/text') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, setup.addTextEdit(j.name, j.text));
  }
  const textPut = url.pathname.match(/^\/api\/templates\/text\/([^/]+)$/);
  if (textPut && req.method === 'PUT') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, setup.saveTextEdit(decodeURIComponent(textPut[1]), j.text));
  }
  if (textPut && req.method === 'DELETE') return sendJson(res, 200, setup.removeTextEdit(decodeURIComponent(textPut[1])));
  const textReset = url.pathname.match(/^\/api\/templates\/text\/([^/]+)\/reset$/);
  if (textReset && req.method === 'POST') return sendJson(res, 200, setup.resetTextEdit(decodeURIComponent(textReset[1])));
  const emailPut = url.pathname.match(/^\/api\/templates\/email\/([^/]+)$/);
  if (emailPut && req.method === 'PUT') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, saveEmailTemplate(decodeURIComponent(emailPut[1]), j));
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        ensurePage();
        return sendText(res, 200, 'text/html; charset=utf-8', pageHtml());
      }
      if (url.pathname === '/data.js') {
        try { return sendText(res, 200, 'application/javascript; charset=utf-8', fs.readFileSync(DATA, 'utf8')); }
        catch (_) { return sendText(res, 200, 'application/javascript; charset=utf-8', 'window.OUTREACH_DATA = {"v":1,"rows":[],"totals":{"sends":0,"texts":0,"emails":0,"people":0},"run":{"startedAt":"' + new Date().toISOString() + '","dryRun":false},"generatedAt":"' + new Date().toISOString() + '"};\n'); }
      }
      if (url.pathname === '/full-log') {
        if (fs.existsSync(FULL_DASH)) {
          try { return sendText(res, 200, 'text/html; charset=utf-8', fs.readFileSync(FULL_DASH, 'utf8')); }
          catch (e) { return sendText(res, 500, 'text/plain; charset=utf-8', e.message); }
        }
        return sendText(res, 404, 'text/plain; charset=utf-8', 'Full outreach log not built yet. Run: email --sent');
      }
      sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (e) {
      try { sendJson(res, 500, { ok: false, error: e && e.message ? e.message : 'error' }); } catch (_) { res.end(); }
    }
  });
}

function healthOk() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/health', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
  });
}

/** Keep a detached --serve process running so Templates / Analytics stay editable after launch exits. */
async function ensureServing() {
  if (await healthOk()) return true;
  try {
    const child = spawn(process.execPath, [__filename, '--serve'], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
      env: process.env,
    });
    child.unref();
    try { writeAtomic(PID_FILE, String(child.pid) + '\n'); } catch (_) { /* optional */ }
  } catch (_) { return false; }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthOk()) return true;
  }
  return false;
}

function dashUrl() { return 'http://' + HOST + ':' + PORT + '/'; }

function runServe() {
  if (off()) { console.error('ASSISTANT_NO_DASHBOARD is set; not starting the dashboard server.'); process.exit(1); }
  try { ensurePage(); flush('view'); } catch (_) { /* page may still serve */ }
  const server = createServer();
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      // already up — treat as success for a second --serve
      healthOk().then((ok) => process.exit(ok ? 0 : 1));
      return;
    }
    console.error('Dashboard server failed: ' + (e && e.message));
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    try { writeAtomic(PID_FILE, String(process.pid) + '\n'); } catch (_) {}
    console.log('Outreach dashboard: ' + dashUrl());
  });
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

/** Open a URL or file in the default browser. Fire and forget. */
function openPage(target) {
  try {
    const cmd = process.platform === 'darwin' ? ['open', [target]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) { return false; }
}

/**
 * What run.sh calls once per launch: build the page, start (or reuse) the localhost server, open the browser.
 * → the dashboard URL, a file path (server could not start), 'skipped', or 'failed'.
 */
async function launch(flags = []) {
  if (off() || flags.some((f) => SKIP_OPEN.has(f))) return 'skipped';
  const file = build('launch', flags);
  if (!file) return 'failed';
  const live = await ensureServing();
  if (live) {
    openPage(dashUrl());
    return dashUrl();
  }
  openPage(file);
  return file;
}


module.exports = { touch, build, launch, openPage, buildData, ensureServing, dashUrl, runServe, templatesPayload, analyticsPayload, PAGE, DATA, DIR, PORT, HOST };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--serve') {
    runServe();
  } else if (cmd === '--launch') {
    launch(rest).then((r) => { process.exitCode = r === 'failed' ? 1 : 0; }).catch(() => { process.exitCode = 1; });
  } else if (cmd === '--help' || cmd === '-h') {
    console.log('outreachDashboard.js — live outreach page on http://127.0.0.1:' + PORT + '/\n' +
      '  node outreachDashboard.js            build, start localhost server, open browser\n' +
      '  node outreachDashboard.js --serve    keep the localhost server running (Templates + Analytics)\n' +
      '  node outreachDashboard.js --launch   what run.sh calls once per zw start\n' +
      '  node outreachDashboard.js --build    build outreach-dashboard/ only\n' +
      '  ASSISTANT_NO_DASHBOARD=1               switch it off\n' +
      '  ASSISTANT_DASHBOARD_PORT=9340         localhost port (default 9340)');
  } else if (cmd === '--build') {
    const f = build();
    console.log(f || 'The outreach dashboard could not be written (or ASSISTANT_NO_DASHBOARD is set).');
    process.exitCode = f ? 0 : 1;
  } else {
    const f = build();
    if (!f) { console.log('The outreach dashboard could not be written (or ASSISTANT_NO_DASHBOARD is set).'); process.exitCode = 1; }
    else {
      ensureServing().then((live) => {
        const target = live ? dashUrl() : f;
        console.log('\n  📬 Outreach dashboard: ' + target + (live ? '' : '\n     file://' + f) + '\n');
        openPage(live ? dashUrl() : f);
      });
    }
  }
}
