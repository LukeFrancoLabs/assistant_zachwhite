'use strict';

/**
 * outreachDashboard — LIVE local page of everyone the bot texts or emails, plus editable templates and an analytics / replies board.
 *
 * WHAT: run.sh opens http://127.0.0.1:9340/ (ASSISTANT_DASHBOARD_PORT). Tabs: Sends · Templates · Analytics.
 *   Sends     — every bot send, newest first; refreshes a few seconds after each send.
 *   Templates — every text (Settings > T / text-templates.json) and email (email-templates.json); edit in the browser; used on the next launch.
 *   Scoreboard — total sends: today, this week, this month, all time.
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
const SERVE_LOG = path.join(DIR, 'server.log');   // why --serve failed (launch swallows console; this file keeps a trail)
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
  const accountId = str(r.accountId) || (() => {
    try {
      const m = String(r.accountUrl || '').match(/\/Account\/([A-Za-z0-9]{15,18})\b/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  })();
  return {
    at: r.at,
    channel,
    accountId,
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

/** Active DNC list for the dashboard (banned and not greened). */
function dncPayload() {
  const textLog = require('./textLog');
  const sfId = require('./sfId');
  const bans = textLog.readBans();
  const green = textLog.readGreen();
  const rows = [];
  const seen = new Set();
  for (const [, b] of bans) {
    if (!b || !b.accountId) continue;
    const stem = String(b.accountId).toLowerCase().slice(0, 15);
    if (seen.has(stem)) continue;
    if (!textLog.isBanned(b.accountId, bans, green)) continue; // greened / not active
    let best = b;
    for (const [, other] of bans) {
      if (!other || !other.accountId) continue;
      if (String(other.accountId).toLowerCase().slice(0, 15) !== stem) continue;
      if (String(other.accountId).length === 18) best = other;
    }
    seen.add(stem);
    const id = sfId.fix(best.accountId) || best.accountId;
    const url = sfId.fixUrl('https://housecallpro.lightning.force.com/lightning/r/Account/' + id + '/view');
    rows.push({
      accountId: id,
      name: best.accountName || '(unnamed)',
      reason: best.reason || null,
      source: best.source || null,
      at: best.at || null,
      url: safeUrl(url),
    });
  }
  rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return { rows, count: rows.length, generatedAt: new Date().toISOString() };
}

/** Parse a Salesforce account id or Account URL. → fixed id or null. */
function parseAccountRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const sfId = require('./sfId');
  try {
    const m = s.match(/\/Account\/([A-Za-z0-9]{15,18})\b/);
    if (m) return sfId.fix(m[1]) || m[1];
  } catch (_) { /* fall through */ }
  if (/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(s)) {
    try { return sfId.fix(s) || s; } catch (_) { return s; }
  }
  return null;
}

/** Put on DNC (banlist). Bans both 18- and 15-char forms. */
function dncAdd({ accountId, accountName, reason }) {
  const id = parseAccountRef(accountId);
  if (!id) return { ok: false, error: 'Need a Salesforce account link or id.' };
  const textLog = require('./textLog');
  if (textLog.isBanned(id)) return { ok: true, already: true, accountId: id };
  const sfId = require('./sfId');
  const fixed = sfId.fix(id) || id;
  const ids = String(fixed).length === 18 ? [fixed, fixed.slice(0, 15)] : [String(id).slice(0, 15)];
  const why = String(reason || 'added from outreach dashboard').trim() || 'added from outreach dashboard';
  let wrote = 0;
  for (const one of ids) {
    if (textLog.recordBan({ accountId: one, accountName: accountName || null, reason: why, source: 'dashboard' })) wrote++;
  }
  return { ok: true, accountId: fixed, wrote };
}

/** Take off DNC (green banlist override). */
function dncClear({ accountId, accountName, reason }) {
  const id = parseAccountRef(accountId);
  if (!id) return { ok: false, error: 'Need a Salesforce account link or id.' };
  const textLog = require('./textLog');
  if (!textLog.isBanned(id)) return { ok: true, already: true, accountId: id, note: 'Not on the DNC list (or already cleared).' };
  const sfId = require('./sfId');
  const fixed = sfId.fix(id) || id;
  const bans = textLog.readBans();
  const name = accountName
    || (bans.get(String(fixed).toLowerCase()) || bans.get(String(fixed).toLowerCase().slice(0, 15)) || {}).accountName
    || null;
  const ids = String(fixed).length === 18 ? [fixed, fixed.slice(0, 15)] : [String(id).slice(0, 15)];
  const why = String(reason || 'cleared from outreach dashboard').trim() || 'cleared from outreach dashboard';
  for (const one of ids) textLog.recordGreen({ accountId: one, accountName: name, reason: why });
  return { ok: true, accountId: fixed };
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

function industryDripTexts(values, setup) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(path.join(__dirname, 'industry-drip-texts.json'), 'utf8')) || {}; } catch (_) { return []; }
  return Object.keys(all).filter((k) => !k.startsWith('_') && all[k] && typeof all[k] === 'object').map((id) => {
    const t = all[id];
    const text = String(t.text || '');
    return {
      id,
      name: t.name || id,
      text,
      kind: 'industry',
      channel: 'text',
      preview: setup ? setup.expandTokens(text, values || {}) : text,
    };
  });
}

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
  })).concat(industryDripTexts(values, setup));
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

/** Sends scoreboard: daily / weekly / monthly / all-time (texts + emails). */
function analyticsPayload() {
  const all = readRows().filter((r) => r && r.mode !== 'manual' && Number.isFinite(Date.parse(r.at)));
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const week = new Date(startOfDay); week.setDate(week.getDate() - 6); // last 7 calendar days including today
  const month = new Date(startOfDay); month.setDate(1); // calendar month to date
  const tDay = startOfDay.getTime(), tWeek = week.getTime(), tMonth = month.getTime();
  const bucket = () => ({ sends: 0, texts: 0, emails: 0 });
  const daily = bucket(), weekly = bucket(), monthly = bucket(), allTime = bucket();
  const add = (b, ch) => { b.sends++; if (ch === 'email') b.emails++; else b.texts++; };
  for (const r of all) {
    const t = Date.parse(r.at);
    const ch = r.channel === 'email' ? 'email' : 'text';
    add(allTime, ch);
    if (t >= tMonth) add(monthly, ch);
    if (t >= tWeek) add(weekly, ch);
    if (t >= tDay) add(daily, ch);
  }
  return { daily, weekly, monthly, allTime, generatedAt: new Date().toISOString() };
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

/** Modular boards (post-demo, cold drip, …) — stages, day offsets, templates. */
function boardPayload() {
  const boards = require('./boards');
  const cadence = require('./cadence');
  const active = boards.loadActive();
  const basePack = boards.loadPackFile(active.id) || active;
  const defById = Object.fromEntries((basePack.stages || []).map((s) => [s.id, s]));
  const over = active.overrides || {};
  const tpl = templatesPayload();
  const textMap = {};
  for (const t of tpl.texts || []) textMap[String(t.id)] = { name: t.name, text: t.text };
  const textOptions = (tpl.texts || []).map((t) => ({ id: String(t.id), name: t.name || ('Text ' + t.id), preview: clip(t.text, 140) }));
  const emailOptions = (tpl.emails || []).map((t) => ({
    id: t.key,
    name: t.name || t.key,
    preview: clip((t.subject || '') + (t.body ? ' — ' + (Array.isArray(t.body) ? t.body.join(' ') : t.body) : ''), 140),
  }));
  const tip = boards.suggestNextStepsDay();
  const stages = active.stages.map((s) => {
    const d = defById[s.id] || {};
    const o = over[s.id] && typeof over[s.id] === 'object' ? over[s.id] : {};
    const copy = cadence.copyOf(s, textMap);
    const customized = o.template !== undefined || o.emailTemplate !== undefined || o.message !== undefined || o.day !== undefined || o.afterMin !== undefined;
    return {
      id: s.id,
      outreach: s.outreach != null ? s.outreach : null,
      label: s.label,
      day: s.day,
      defaultDay: d.day,
      afterMin: s.afterMin || 0,
      ch: s.ch,
      n: s.n,
      byHand: !!s.byHand,
      manual: !!s.manual,
      template: s.template != null ? String(s.template) : null,
      emailTemplate: s.emailTemplate || null,
      defaultTemplate: d.template != null ? String(d.template) : null,
      defaultEmailTemplate: d.emailTemplate || null,
      preferWeekdays: s.preferWeekdays || null,
      customized: !!customized,
      copyName: copy ? copy.name : null,
      preview: copy ? clip(copy.text || copy.subject || '', 220) : null,
      hint: s.hint || null,
      note: s.byHand ? 'By hand — board skips sending this stage' : (s.manual ? 'Marked manual (board can still send)' : null),
    };
  });
  return {
    activeBoard: active.id,
    boardName: active.name,
    boardDescription: active.description || '',
    packs: boards.listPacks(),
    stages,
    textOptions,
    emailOptions,
    nextStepsTip: tip,
    generatedAt: new Date().toISOString(),
  };
}

/** Save day / template for one stage on the active (or named) board pack. */
function saveBoardStage(id, payload) {
  const boards = require('./boards');
  const packId = (payload && payload.board) || boards.activeBoardId();
  const pack = boards.loadPackFile(packId);
  if (!pack) return { ok: false, error: 'Unknown board "' + packId + '".' };
  const stage = pack.stages.find((s) => s.id === id);
  if (!stage) return { ok: false, error: 'Unknown stage "' + id + '".' };

  if (payload && payload.reset) {
    const r = boards.saveStage(packId, id, { reset: true });
    if (!r.ok) return r;
    return { ok: true, board: boardPayload() };
  }

  const body = {};
  if (payload && payload.day !== undefined) body.day = payload.day;
  if (payload && payload.afterMin !== undefined) body.afterMin = payload.afterMin;

  if (stage.ch === 'text') {
    if (payload && payload.template != null && String(payload.template).trim()) {
      const tid = String(payload.template).trim();
      const texts = templatesPayload().texts || [];
      if (!texts.some((t) => String(t.id) === tid)) return { ok: false, error: 'No text template "' + tid + '".' };
      body.template = tid;
    } else if (payload && payload.day === undefined && payload.afterMin === undefined) {
      return { ok: false, error: 'Pick a text template (or change the day).' };
    }
  } else if (payload && payload.emailTemplate != null && String(payload.emailTemplate).trim()) {
    const key = String(payload.emailTemplate).trim();
    const emails = templatesPayload().emails || [];
    if (!emails.some((t) => t.key === key)) return { ok: false, error: 'No email template "' + key + '".' };
    body.emailTemplate = key;
  } else if (payload && payload.day === undefined && payload.afterMin === undefined) {
    return { ok: false, error: 'Pick an email template (or change the day).' };
  }

  const r = boards.saveStage(packId, id, body);
  if (!r.ok) return r;
  return { ok: true, board: boardPayload() };
}

function deskAfter(result) {
  if (!result || !result.ok) return result;
  try { result.desk = require('./dayDesk').build(); } catch (_) { /* the page can reload the desk */ }
  return result;
}

/** Put a lead on the personal board. Writes the same records as textLog.js --add-lead. Nothing is sent. */
function addHandLead(body) {
  const manual = require('./manualShark');
  const r = manual.addLead({
    ref: body && (body.ref || body.accountId || body.url),
    name: body && body.name ? body.name : null,
    tags: body && body.tags,
    did: body && body.did,
    note: body && body.note ? body.note : null,
    on: body && body.on ? body.on : null,
  });
  if (!r.ok) return { ok: false, error: r.reason };
  return deskAfter({
    ok: true,
    account: r.account,
    tags: r.tags,
    did: r.did,
    warnings: r.warnings || [],
  });
}

/** Take a hand-added lead back off the board. */
function removeHandLead(body) {
  const manual = require('./manualShark');
  const r = manual.removeLead({ ref: body && (body.ref || body.accountId) });
  if (!r.ok) return { ok: false, error: r.reason };
  return deskAfter({ ok: true, removed: (r.removed || []).length });
}

function setActiveBoard(id) {
  const r = require('./boards').setActiveBoard(id);
  if (!r.ok) return r;
  return { ok: true, board: boardPayload() };
}

async function handleApi(req, res, url) {
  const setup = require('./senderSetup');
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });
  if (req.method === 'GET' && url.pathname === '/api/daydesk') {
    try { return sendJson(res, 200, require('./dayDesk').build()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/board') {
    try { return sendJson(res, 200, boardPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/content') {
    try {
      const q = {
        trade: url.searchParams.get('trade') || '',
        need: url.searchParams.get('need') || '',
        competitor: url.searchParams.get('competitor') || '',
        segment: url.searchParams.get('segment') || '',
        region: url.searchParams.get('region') || '',
        stage: url.searchParams.get('stage') || 'demo',
        q: url.searchParams.get('q') || '',
        type: url.searchParams.get('type') || '',
        limit: url.searchParams.get('limit') || '80',
      };
      return sendJson(res, 200, require('./contentLibrary').payload(q));
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/board/active') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, setActiveBoard(j.id || j.board));
  }
  const boardStage = url.pathname.match(/^\/api\/board\/stages\/([^/]+)$/);
  if (boardStage && req.method === 'PUT') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, saveBoardStage(decodeURIComponent(boardStage[1]), j));
  }
  if (boardStage && req.method === 'POST') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, saveBoardStage(decodeURIComponent(boardStage[1]), j));
  }
  if (req.method === 'GET' && url.pathname === '/api/templates') {
    try { return sendJson(res, 200, templatesPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/analytics') {
    try { return sendJson(res, 200, analyticsPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/dnc') {
    try { return sendJson(res, 200, dncPayload()); } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/leads') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, addHandLead(j));
  }
  if (req.method === 'POST' && url.pathname === '/api/leads/remove') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, removeHandLead(j));
  }
  if (req.method === 'POST' && url.pathname === '/api/dnc') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, dncAdd(j));
  }
  if (req.method === 'POST' && url.pathname === '/api/dnc/clear') {
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'Invalid JSON' }); }
    return sendJson(res, 200, dncClear(j));
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

function serveLog(line) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(SERVE_LOG, new Date().toISOString() + ' ' + String(line || '') + '\n');
  } catch (_) { /* never block a launch */ }
}

/** Keep a detached --serve process running so Pipeline Assistant (Templates / Morning / …) stays up after launch exits. Default on every zw. */
async function ensureServing() {
  if (await healthOk()) return true;
  serveLog('starting --serve on port ' + PORT);
  try {
    const out = fs.openSync(SERVE_LOG, 'a');
    const child = spawn(process.execPath, [__filename, '--serve'], {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: __dirname,
      env: process.env,
    });
    child.unref();
    try { fs.closeSync(out); } catch (_) {}
    try { writeAtomic(PID_FILE, String(child.pid) + '\n'); } catch (_) { /* optional */ }
    serveLog('spawned pid ' + child.pid);
  } catch (e) {
    serveLog('spawn failed: ' + (e && e.message));
    return false;
  }
  // Wait up to ~5s — Mac cold start + antivirus can be slow; never open the browser until health passes.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthOk()) { serveLog('healthy'); return true; }
  }
  serveLog('health check failed after spawn');
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
 * Pipeline Assistant always tries to serve on 127.0.0.1 by default (ASSISTANT_NO_DASHBOARD=1 to opt out).
 * → the dashboard URL, a file path (server could not start), 'skipped', or 'failed'.
 */
async function launch(flags = []) {
  if (off() || flags.some((f) => SKIP_OPEN.has(f))) return 'skipped';
  const file = build('launch', flags);
  if (!file) return 'failed';
  let live = await ensureServing();
  if (!live) live = await ensureServing(); // one retry — first spawn sometimes races on a busy Mac
  if (live) {
    openPage(dashUrl());
    try { console.log('Pipeline Assistant: ' + dashUrl()); } catch (_) {}
    return dashUrl();
  }
  // Last resort: open the static file (Sends only). Prefer telling the user how to start the live server.
  try {
    console.error('Pipeline Assistant server did not start on port ' + PORT + '. Run: node outreachDashboard.js --serve');
    console.error('(details: ' + SERVE_LOG + ')');
  } catch (_) {}
  openPage(file);
  return file;
}


module.exports = { touch, build, launch, openPage, buildData, ensureServing, dashUrl, runServe, templatesPayload, analyticsPayload, dncPayload, dncAdd, dncClear, boardPayload, saveBoardStage, setActiveBoard, PAGE, DATA, DIR, PORT, HOST };

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
