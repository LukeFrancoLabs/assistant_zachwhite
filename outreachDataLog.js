#!/usr/bin/env node
'use strict';
/**
 * outreachDataLog: this rep's OWN data log of everything this copy of the tool has sent, kept on THIS computer only. It only exists in the copy of the folder that is handed to someone:
 * share/build-package.js adds it to the zip, and the folder the zip is built from has no such file and works as it always did.
 *
 * WHAT: outreach-data-log.jsonl, in this folder next to the other logs. One JSON line for every text or email the tool ACTUALLY sent, written at the moment it is sent and stamped with WHO
 * sent it (the rep's name, from sender.json) and from WHICH COMPUTER (its name, plus a random id made once, the first time this log is written, so two computers with the same name can
 * be told apart). The first line says what the file is. The tool only ever adds lines: it never changes or removes one.
 *
 *   { "type": "log-start", "v": 1, "installId", "startedAt", "rep", "computer", "platform", "arch", "note" }                  the first line
 *   { "type": "send", "v": 1, "at", "rep", "computer", "installId", "channel": "text" | "email", "accountId", "accountName", "accountUrl",
 *     "email", "templateName", "message" (a text), "subject" and "body" (an email), "mode", "source", "step" }                one line per send
 *
 * WHERE IT IS CALLED FROM: share/build-package.js adds one line to the copy's textLog.js, in recordOutreach(), the one place every text and email the tool sends is logged. A practice
 * run (--test, --dry-run) never gets there, so it logs nothing; touches added by hand (mode 'manual', or '... (seeded)') were not sent by the tool and are left out here too.
 * The outreach page (outreach-dashboard/) shows this log's name and how many sends it holds, from summary().
 *
 * PRIVACY: this only appends to one local file. No network, no upload. It reads only sender.json (for the name) and this log, and nothing in the tool reads the log to decide anything.
 * The file is created readable by its owner only. Delete it to start a fresh one: the next send makes a new one, with a new id.
 *
 * SAFETY: record() never throws and takes a millisecond or two. If the log cannot be written, ONE warning line is printed for that run and the send carries on.
 *
 *   ASSISTANT_DATA_LOG=/path/to/file.jsonl   writes there instead (tests only)
 *   node outreachDataLog.js                says where the log is and how many sends it holds
 *   node outreachDataLog.js --selfcheck    (writes only a temporary file) proves the stamps and the counts; the packager runs it
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FILE = process.env.ASSISTANT_DATA_LOG || path.join(__dirname, 'outreach-data-log.jsonl');
const NAME = path.basename(FILE);
const V = 1;
const NOTE = 'The data log of every text and email this copy of the tool sent, kept only on this computer: one line each, with the rep and the computer that sent it. Nothing uploads it.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEND_PREFIX = '{"type":"send"';
const MAX_COUNT_BYTES = 512 * 1024 * 1024;      // a log bigger than this is not counted (the page leaves the number out)

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* no waiting: carry on */ } };
const clean = (v, n = 120) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
const orNull = (v) => (v === undefined ? null : v);
function repName() { try { return clean(require('./sender').fullName); } catch (_) { return null; } }
function computerName() { try { return clean(os.hostname()); } catch (_) { return null; } }

// ---------------------------------------------------------------- the first line: what the file is, and this computer's id
function header() {
  const id = crypto.randomUUID();
  const since = new Date().toISOString();
  const line = `${JSON.stringify({ type: 'log-start', v: V, installId: id, startedAt: since, rep: repName(), computer: computerName(), platform: os.platform(), arch: os.arch(), note: NOTE })}\n`;
  return { id, since, line };
}

/** The log's first line: { id, since } when it is a header of ours, { id: null, since: null } when the file starts with something else, null when there is no complete first line (yet). */
function readHead() {
  let fd = null;
  try {
    fd = fs.openSync(FILE, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(10);
    if (nl < 0 || nl >= n) return n < buf.length ? null : { id: null, since: null };      // no line end yet: still being written (or one huge line, which is not ours)
    let j = null;
    try { j = JSON.parse(buf.toString('utf8', 0, nl)); } catch (_) { /* not ours */ }
    if (j && j.type === 'log-start' && UUID_RE.test(String(j.installId))) return { id: j.installId, since: typeof j.startedAt === 'string' ? j.startedAt : null };
    return { id: null, since: null };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* closed */ } } }
}

let ident = null;      // { id, since } once known (id is null for a file that was not started by this tool: its lines then carry installId null)
/** This log's id: read from its first line, or made now (the log is created with that line). Another process starting the log at the same moment is handled: only one can create it. */
function identity() {
  if (ident) return ident;
  for (let attempt = 0; attempt < 4; attempt++) {
    let exists = true;
    try { fs.statSync(FILE); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
    if (!exists) {
      const h = header();
      try { fs.writeFileSync(FILE, h.line, { flag: 'wx', mode: 0o600 }); ident = { id: h.id, since: h.since }; return ident; } catch (e) { if (e.code !== 'EEXIST') throw e; }      // somebody made it a moment ago: read theirs
    }
    const head = readHead();
    if (head) { ident = head; return ident; }
    if (attempt < 3) { sleep(20); continue; }      // being created right now: give it a moment
    const h = header();      // it stayed empty: start it properly
    fs.appendFileSync(FILE, h.line, { mode: 0o600 });
    ident = { id: h.id, since: h.since };
    return ident;
  }
  throw new Error('could not read or start the log');
}

// ---------------------------------------------------------------- writing
let warned = false;
let lastError = null;
function fail(e) {
  lastError = `Could not save to ${NAME}: ${e && e.message ? e.message : e}`;
  if (!warned) { warned = true; try { process.stderr.write(`\n⚠️  ${lastError}. The send itself went through.\n`); } catch (_) { /* nowhere to say it */ } }
  return false;
}

/** Add one send to the data log. → true when written. Never throws. A touch added by hand is not a send of this tool and is not written. */
function record(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const mode = String(row.mode || '');
    if (mode === 'manual' || /\(seeded\)/.test(mode)) return false;
    if (ident && !fs.existsSync(FILE)) ident = null;      // the file was deleted while this run was going: start a new one (with a new id) at this send
    const who = identity();
    const line = `${JSON.stringify({
      type: 'send',
      v: V,
      at: typeof row.at === 'string' && row.at ? row.at : new Date().toISOString(),
      rep: repName(),
      computer: computerName(),
      installId: who.id,
      channel: row.channel === 'email' ? 'email' : 'text',
      accountId: orNull(row.accountId),
      accountName: orNull(row.accountName),
      accountUrl: orNull(row.accountUrl),
      email: orNull(row.email),
      templateName: orNull(row.templateName),
      message: orNull(row.message),
      subject: orNull(row.subject),
      body: orNull(row.body),
      mode: orNull(row.mode),
      source: orNull(row.source),
      step: orNull(row.step),
    })}\n`;
    fs.appendFileSync(FILE, line, { mode: 0o600 });
    return true;
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------- reading it back, for the outreach page
let counted = { offset: 0, n: 0 };      // complete lines up to `offset` bytes hold `n` sends (so a bigger log is only read from where it was last read)
function countSends() {
  const st = fs.statSync(FILE);
  if (st.size < counted.offset) counted = { offset: 0, n: 0 };      // the file got shorter (started again, or edited by hand): count from the start
  if (st.size > counted.offset) {
    const len = st.size - counted.offset;
    if (len > MAX_COUNT_BYTES) return null;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(FILE, 'r');
    let got = 0;
    try { got = fs.readSync(fd, buf, 0, len, counted.offset); } finally { fs.closeSync(fd); }
    let i = 0;
    let last = -1;
    let n = 0;
    for (;;) {
      const nl = buf.indexOf(10, i);
      if (nl < 0 || nl >= got) break;
      if (nl - i >= SEND_PREFIX.length && buf.toString('latin1', i, i + SEND_PREFIX.length) === SEND_PREFIX) n++;
      last = nl;
      i = nl + 1;
    }
    counted = { offset: counted.offset + last + 1, n: counted.n + n };      // a line that is still being written is left for the next look
  }
  return counted.n;
}

/** What the outreach page shows about the log: { file, rep, computer, count, since, error }. Never throws. */
function summary() {
  const out = { file: NAME, rep: repName(), computer: computerName(), count: 0, since: null, error: lastError };
  try {
    let st = null;
    try { st = fs.statSync(FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) return out;
    out.count = countSends();
    out.since = (ident && ident.since) || (readHead() || {}).since || null;
  } catch (e) { out.error = out.error || `Could not read ${NAME}: ${e && e.message ? e.message : e}`; }
  return out;
}

// ---------------------------------------------------------------- the self-check (the packager runs it)
function selfcheck() {
  if (!process.env.ASSISTANT_DATA_LOG) {      // run again with the log and the sender file pointing at temporary files, so that nothing real is touched
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-datalog-check-'));
    try {
      fs.writeFileSync(path.join(dir, 'sender.json'), JSON.stringify({ fullName: 'Jane Smith', firstName: 'Jane', callNumber: '555-234-5678', textNumber: '555-345-6789', bookingLink: 'https://tinyurl.com/jane-demo' }));
      const r = spawnSync(process.execPath, [__filename, '--selfcheck'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ASSISTANT_DATA_LOG: path.join(dir, 'log.jsonl'), ASSISTANT_SENDER_FILE: path.join(dir, 'sender.json') } });
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.status === 0 ? 0 : 1;
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp folder */ } }
  }
  try {
    const bad = [];
    const text = { at: '2026-01-02T03:04:05.678Z', channel: 'text', accountId: '001A', accountName: 'Acme Roofing', accountUrl: 'https://example.invalid/a', email: null, templateName: 'T1', message: 'Hi there', subject: null, body: null, mode: 'list', source: null, step: null };
    const mail = { ...text, channel: 'email', message: null, subject: 'Hello', body: 'The body', email: 'a@b.co', mode: 'email' };
    if (!record(text) || !record(mail)) bad.push('record() did not write');
    if (record({ ...text, mode: 'manual' }) !== false || record({ ...text, mode: 'text (seeded)' }) !== false) bad.push('a touch added by hand was logged');
    const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (rows.length !== 3) bad.push(`expected 3 lines, found ${rows.length}`);
    const head = rows[0] || {};
    if (head.type !== 'log-start' || !UUID_RE.test(String(head.installId))) bad.push('the first line is not a header with an id');
    if (head.rep !== 'Jane Smith' || head.computer !== clean(os.hostname())) bad.push('the header does not say who and which computer');
    for (const [i, want] of [[1, text], [2, mail]]) {
      const r = rows[i] || {};
      if (r.type !== 'send' || r.channel !== want.channel || r.at !== want.at || r.accountName !== want.accountName || r.message !== want.message || r.subject !== want.subject || r.body !== want.body || r.email !== want.email) bad.push(`line ${i + 1} does not hold the send`);
      if (r.rep !== 'Jane Smith' || r.computer !== clean(os.hostname()) || r.installId !== head.installId) bad.push(`line ${i + 1} is not stamped with this rep and computer`);
    }
    const s = summary();
    if (s.count !== 2 || s.rep !== 'Jane Smith' || s.since !== head.startedAt || s.file !== NAME || s.error) bad.push(`summary() says ${JSON.stringify(s)}`);
    if (bad.length) { console.error(`outreachDataLog self-check FAILED: ${bad.join('; ')}`); return 1; }
    console.log('outreachDataLog self-check OK');
    return 0;
  } catch (e) {
    console.error(`outreachDataLog self-check FAILED: ${e && e.message}`);
    return 1;
  }
}

module.exports = { record, summary, identity, selfcheck, FILE, NAME };

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) process.exit(selfcheck());
  const s = summary();
  console.log(`\n  Your data log: ${FILE}\n  ${s.count} send${s.count === 1 ? '' : 's'} saved${s.since ? ` since ${String(s.since).slice(0, 10)}` : ''}, for ${s.rep || '(no name saved yet)'} on ${s.computer || 'this computer'}. It stays on this computer; nothing uploads it.\n`);
}
