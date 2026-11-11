'use strict';

/**
 * holdInbox — what to do with a lead whose text was HELD because of its thread (the pro replied, or a teammate texted).
 *
 *  1. add()      is called by the sender the moment a thread read holds a send. It saves the conversation to hold-inbox.jsonl and pops a
 *                macOS notification, so the hold is not buried in a log.
 *  2. draft()    reads that saved conversation and writes ONE subtle check-in text in Luke's voice, e.g.
 *                "Just checking in, are you free for a 10 min call to gameplan how we can help? -Luke at HCP".
 *                It never drafts for an opt-out, and it hands anything that needs a real answer (a question, "yes", "call me") back to Luke.
 *  3. email --holds   shows the drafts, asks for a yes, and sends them (texting hours, banlist and the once-a-day guard still apply).
 *
 * Storage: hold-inbox.jsonl, append-only, one line per state of an item; the newest line per id wins.
 *   { id, at, accountId, accountName, accountUrl, kind, reason, messages:[{dir,sender,at,body}], status, action, draft, why, draftedAt, sentAt }
 *   status: 'new' (held, nothing drafted) | 'drafted' (text ready to approve) | 'review' (needs Luke himself) | 'skipped' (opt-out / do not text) | 'sent'
 *           | 'cleared' (closed by holdClear.js: the thread guard no longer holds it; prevStatus, clearedAt and clearedWhy say what it was and why)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const INBOX_FILE = process.env.ASSISTANT_HOLD_INBOX_FILE || path.join(__dirname, 'hold-inbox.jsonl');
const sender = require('./sender');      // who this copy texts as (sender.json): the wording below was written by Luke Franco, sender.apply swaps his name for the sender's
const SIGNATURE = sender.apply('-Luke at HCP');
const FIRST = sender.apply('Luke');      // the sender's first name (or its [SET sender.json: …] marker, which typeMessage refuses to send)
const SIG_END = new RegExp(`-\\s*${sender.esc(FIRST)} at HCP\\s*$`, 'i'), NAME_END = new RegExp(`[-–—\\s]*${sender.esc(FIRST)}( at HCP)?\\.?$`, 'i');
/** The wording Luke chose. The model may adapt it lightly to the conversation; this is also the fallback. */
const BASE_TEXT = `Just checking in, are you free for a 10 min call to gameplan how we can help? ${SIGNATURE}`;
const OPT_OUT = /\b(stop|dnc|do not|don'?t (text|contact|call)|unsub\w*|opt.?out|remove|not interested|no thanks|leave me alone|wrong number|lawsuit|tcpa|harass\w*)\b/i;
const AUTO_OPT_OUT = /opted out of text/i;      // the automated "You've opted out of text communication" reply that follows a STOP (an OUTGOING message, so OPT_OUT, which reads the pro's words, never sees it)
const HOLD_KINDS = new Set(['replied', 'teammate']);       // 'unreadable' holds have no conversation to answer
const CLOSED = new Set(['sent', 'skipped', 'cleared']);     // nothing is left to do on these; a new hold for the same account opens it again
const idOf = (accountId) => String(accountId || '').toLowerCase().slice(0, 15);

function readAll() {
  const out = new Map();
  try {
    if (!fs.existsSync(INBOX_FILE)) return out;
    for (const l of fs.readFileSync(INBOX_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.id) out.set(r.id, r);
    }
  } catch (_) {}
  return out;
}
function write(row) { try { fs.appendFileSync(INBOX_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {} return row; }
/** Items that still need something from us, oldest first. */
function open() { return [...readAll().values()].filter((r) => !CLOSED.has(r.status)).sort((a, b) => (a.at < b.at ? -1 : 1)); }

/** Pop a macOS notification (silently does nothing elsewhere, or when HOLD_NOTIFY=0). */
function notify(title, message) {
  if (process.env.ASSISTANT_HOLD_NOTIFY === '0' || process.platform !== 'darwin') return false;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
  try { execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], () => {}); return true; } catch (_) { return false; }
}

/**
 * A thread read held this account. Save the conversation and notify. One open item per account: a second hold for the same account just
 * refreshes the conversation (no second notification) unless the first was already sent / dismissed.
 */
function add({ accountId, accountName, accountUrl, verdict, messages }) {
  if (!accountId || !verdict || !verdict.hold || !HOLD_KINDS.has(verdict.kind)) return null;
  const id = idOf(accountId), prev = readAll().get(id);
  const msgs = (messages || []).slice(-14).map((m) => ({ dir: m.dir, sender: m.sender || null, at: m.at ? new Date(m.at).toISOString() : null, body: String(m.body || '').slice(0, 400) }));
  const reopen = !prev || CLOSED.has(prev.status);
  const row = write({ id, at: new Date().toISOString(), accountId, accountName: accountName || null, accountUrl: accountUrl || null, kind: verdict.kind, reason: verdict.reason, messages: msgs,
    status: reopen ? 'new' : prev.status, action: reopen ? null : prev.action, draft: reopen ? null : prev.draft, why: reopen ? null : prev.why, draftedAt: reopen ? null : prev.draftedAt, sentAt: null });
  let stopped = null;       // Luke 2026-11-02 ("Yes, automatically"): a Stop / "I am not interested" in the saved conversation puts the account on the do-not-contact list by itself (stopBan.js; it never throws)
  try { stopped = require('./stopBan').banFromHold(row); } catch (_) {}
  if (reopen && stopped && stopped.banned) notify('🚫 Said stop: put on the do-not-contact list', `${accountName || 'An account'}: "${stopped.said}". Nothing more will be sent to it.`);
  else if (reopen) notify(verdict.kind === 'replied' ? '💬 A pro replied' : '🤝 Teammate already texted', `${accountName || 'An account'}: ${verdict.reason}. Run: email --holds`);
  return row;
}

const SYSTEM = sender.apply(`You write one short follow-up text for Luke Franco, a sales rep at Housecall Pro, to a home-service pro (plumber, HVAC, cleaner...) whose text thread was paused.
You are given the real conversation. Decide what Luke should do, and reply with ONE JSON object and nothing else:
{"action":"text"|"review"|"skip","text":"...","why":"one short sentence for Luke"}

action "skip": the pro said stop, not interested, wrong number, asked not to be contacted, or is upset. No text.
action "review": the pro asked a real question (price, how it works, what we do), said yes / interested / call me, shared a problem, or the right reply needs Luke himself. No text; Luke answers personally.
action "text": nothing needs a direct answer, so a light, low-pressure nudge is right.

When action is "text", the text must be subtle and sound like a person, in this exact style:
"Just checking in, are you free for a 10 min call to gameplan how we can help? -Luke at HCP"
Rules: keep that wording as the base and change at most a few words to fit the conversation (a first name if the pro gave one, "again" if Luke already checked in). One question only. Under 200 characters. End with "-Luke at HCP". No prices, discounts, gift cards, deadlines, links, emojis or promises. Never claim anything the conversation does not show. Do not repeat a line Luke already sent.`);

function transcript(row) {
  return row.messages.map((m) => `${m.dir === 'in' ? 'PRO' : (m.sender || 'US').toUpperCase()}${m.at ? ' [' + m.at.slice(0, 16).replace('T', ' ') + ']' : ''}: ${m.body}`).join('\n');
}

/** The checks that never need the model. → { action, why } when decided, else null. */
function ruleCheck(row, now = Date.now()) {
  const msgs = row.messages || [];
  if (!msgs.length) return { action: 'review', why: 'no conversation was saved, so nothing to base a text on' };
  let lastOut = -1; msgs.forEach((m, i) => { if (m.dir === 'out') lastOut = i; });
  const inbound = msgs.filter((m) => m.dir === 'in');
  const sinceMine = msgs.filter((m, i) => m.dir === 'in' && i > lastOut);
  if (inbound.some((m) => OPT_OUT.test(m.body))) return { action: 'skip', why: `the pro's replies include an opt-out or "not interested": "${(inbound.find((m) => OPT_OUT.test(m.body)) || {}).body}"`.slice(0, 200) };
  const auto = msgs.find((m) => m.dir === 'out' && AUTO_OPT_OUT.test(m.body));      // a STOP the words above did not catch (the thread guard holds on it too)
  if (auto) return { action: 'skip', why: `the thread has the automated opt-out reply: "${String(auto.body).slice(0, 90)}"` };
  const last = msgs[msgs.length - 1], lastAt = last && last.at ? Date.parse(last.at) : NaN;
  if (row.kind === 'teammate' && !Number.isNaN(lastAt) && now - lastAt < 24 * 3600 * 1000) return { action: 'review', why: `${last.sender || 'A teammate'} texted less than 24 hours ago; a second text now would pile on` };
  if (row.kind === 'teammate' && Number.isNaN(lastAt)) return { action: 'review', why: 'a teammate texted and the time is unknown' };
  if (row.kind === 'replied' && !sinceMine.length) return { action: 'review', why: 'the reply could not be matched to the thread' };
  return null;
}

/** Make sure a model's text is safe to send: the signature, a length cap, and nothing with prices, links or numbers. Falls back to Luke's line. */
function cleanText(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 220 || /\$|https?:|www\.|\d{3}[-.\s]\d{3,4}|gift|amazon|%|free month|discount/i.test(s)) return BASE_TEXT;
  if (!SIG_END.test(s)) s = s.replace(NAME_END, '').trim() + ' ' + SIGNATURE;
  return s;
}

/** Read the conversation and decide. → { action, text, why }. `complete` is the model call (swapped in tests). */
async function draft(row, { complete = null, now = Date.now() } = {}) {
  const rule = ruleCheck(row, now);
  if (rule) return { action: rule.action, text: null, why: rule.why };
  const call = complete || defaultComplete;
  let obj;
  try { obj = extractJson(await call({ system: SYSTEM, prompt: `Account: ${row.accountName || 'unknown'}\nWhy the thread was paused: ${row.reason}\n\nConversation (oldest first):\n${transcript(row)}\n\nToday is ${new Date(now).toDateString()}.` })); }
  catch (e) { return { action: 'review', text: null, why: `could not draft (${e.message.slice(0, 120)})` }; }
  const action = ['text', 'review', 'skip'].includes(obj.action) ? obj.action : 'review';
  return { action, text: action === 'text' ? cleanText(obj.text) : null, why: String(obj.why || '').slice(0, 240) };
}

function extractJson(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in the model reply');
  return JSON.parse(t.slice(a, b + 1));
}
async function defaultComplete({ system, prompt }) {
  const plan = require('./autoPlan');
  const provider = plan.chooseProvider();
  if (provider === 'mock') return JSON.stringify({ action: 'text', text: BASE_TEXT, why: 'mock' });
  return plan.complete({ system, prompt, provider });
}

/** Save a draft decision on an item. */
function setDraft(row, d) {
  const status = d.action === 'text' ? 'drafted' : d.action === 'skip' ? 'skipped' : 'review';
  return write({ ...row, status, action: d.action, draft: d.text, why: d.why, draftedAt: new Date().toISOString() });
}
function markSent(row) { return write({ ...row, status: 'sent', sentAt: new Date().toISOString() }); }
/** Close an item that needs nothing from us any more (holdClear.js). The conversation stays on the row, and reopenCleared() puts it back as it was. */
function markCleared(row, why) { return write({ ...row, status: 'cleared', prevStatus: row.status, clearedAt: new Date().toISOString(), clearedWhy: String(why || '').slice(0, 240) }); }
function reopenCleared(row) { const { prevStatus, clearedAt, clearedWhy, ...rest } = row; return write({ ...rest, status: prevStatus && !CLOSED.has(prevStatus) ? prevStatus : 'new' }); }

module.exports = { add, open, readAll, notify, draft, setDraft, markSent, markCleared, reopenCleared, CLOSED, ruleCheck, cleanText, extractJson, INBOX_FILE, BASE_TEXT, SIGNATURE, OPT_OUT, AUTO_OPT_OUT, HOLD_KINDS };
