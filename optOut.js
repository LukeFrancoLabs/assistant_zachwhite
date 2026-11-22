'use strict';

/**
 * optOut — turn inbound Gmail (SMS-Magic text notifications + outreach email replies) into
 * replies.jsonl for the dashboard Analytics tab, and ban clear STOP opt-outs.
 *
 * WHERE THE MAIL COMES FROM: this script does NOT talk to Gmail itself. Something else fetches
 * messages and hands them in as JSON (see replyPoller.js for the rep-friendly ways to do that):
 *     [{ "id": "<gmail message id>", "subject": "...", "body": "...", "date": "...", "from"?: "..." }]
 *
 *   node optOut.js --ingest emails.json [--dry-run]              SMS-Magic "New Message received…"
 *   node optOut.js --ingest-email-replies emails.json [--dry-run] replies to our outreach emails
 *   node optOut.js --replies-only emails.json [--dry-run]        record SMS replies, no bans
 *   node optOut.js --review                                     list replies waiting for a human look
 *   node optOut.js --recategorize                               re-derive gift / interested / optout flags
 *
 * Email open tracking is NOT done here (Gmail and Salesforce Lightning do not expose opens to this tool).
 */

const fs = require('fs');
const path = require('path');
const textLog = require('./textLog');
const sfId = require('./sfId');

const DONE_FILE = path.join(__dirname, 'optout-processed.jsonl');   // one line per email handled (dedupe)
const REVIEW_FILE = path.join(__dirname, 'optout-review.jsonl');    // replies a human should read
const REPLY_FILE = textLog.REPLY_FILE;                              // every reply, flagged for the dashboard's Gift card / Interested columns

const SUBJECT_RE = /SMS-Magic:\s*New Message received from\s+(.+?)\s+via sms/i;

const PLACEHOLDER_RE = /new Visualforce Email Template/i;   // Gmail's plain-text part of these emails; the real text is only in the HTML part

/** The HTML part of an SMS-Magic email → the same line layout as the rendered text. */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(p|div|h\d|tr|table|br|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** Pull the pro's name, phone and the reply text out of one SMS-Magic notification. */
function parseEmail({ subject, body }) {
  const raw = String(body || '');
  const text = (/<(html|p|div|table)\b/i.test(raw) ? htmlToText(raw) : raw).replace(/\r/g, '');
  let name = ((String(subject || '').match(SUBJECT_RE)) || [])[1] || null;
  if (!name) name = ((text.match(/incoming from\s+(.+)/i)) || [])[1] || null;
  const phone = ((text.match(/Sender ID:\s*(\+?\d[\d\s().-]*)/i)) || [])[1] || null;
  // The reply sits between "SMS Text:" and the first date stamp ("Tue, Oct 20, 2026 04:43 PM");
  // everything after it is the message history, which includes OUR texts and must not be read.
  const section = (text.split(/SMS Text:/i)[1] || '');
  const dated = section.search(/\n\s*[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  let reply = (dated >= 0 ? section.slice(0, dated) : section.split(/Message History/i)[0]).trim();
  if (name && reply.toLowerCase().startsWith(name.toLowerCase())) reply = reply.slice(name.length).trim(); // the name line precedes the reply
  return { name: name && name.trim(), phone: phone && phone.replace(/\D/g, ''), reply };
}

// Only a STOP bans (Luke, 2026-11-05: "we only want to put people on the DNC if they say STOP or I tell you"). That is the word and what it plainly means (stop, unsubscribe,
// opt out, remove me, don't text or contact me, leave me alone, take me off) plus the legal and wrong-number words, where a missed one is worse than a needless ban (a ban can be
// undone with `node textLog.js --green <id>`). "No", "No thanks", "Not interested" and every other refusal are NOT a stop: they are "Other" on the dashboard, nobody is banned
// for them and the follow-up board keeps working the lead (until 2026-11-05 they were in this list). cadence.js reads this same list for what pauses a lead.
const STOP_RE = new RegExp([
  '\\bstop\\b', '\\bunsub\\w*', '\\bopt(ed)?[\\s-]*out\\b', '\\bremove\\b', '\\bquit\\b', '\\bdnc\\b',
  'do(n\'?t| not)\\s+(text|call|contact|email|message)', 'no\\s+more\\s+(text|call|message|email)', 'leave me alone',
  'take me off', 'delete my', 'wrong\\s+number', 'harass', 'spam', 'legal action', 'lawsuit', 'tcpa', 'lawyer', 'attorney', '\\bsue\\b', 'report you', 'cease',
].join('|'), 'i');

// Not a stop, so nothing to decide: only an SMS opt-out keyword the platform itself honors ("cancel") still goes to a person. Every other reply is "Other".
const MAYBE_RE = /\bcancel/i;

/** → 'ban' | 'review' | 'none' */
// iPhone "tapback" reactions arrive as texts ("Liked “…”", "Removed 👍 from “…”") and quote OUR message, so they carry no meaning of their own.
const TAPBACK_RE = /^\s*(?:(?:liked|loved|disliked|laughed at|emphasi[sz]ed|questioned)\b|removed .{1,14} from\b|\p{Extended_Pictographic}\S*\s+(?:to|from)\b)\s*[“"]/iu;
function classify(reply) {
  const t = String(reply || '').trim();
  if (TAPBACK_RE.test(t)) return 'none';
  if (!t) return 'review';
  if (STOP_RE.test(t)) return 'ban';
  if (MAYBE_RE.test(t)) return 'review';
  return 'none';
}

// Dashboard flags. Wording is judged on the reply alone; a clear opt-out is never "interested".
const GIFT_RE = /gift\s*-?card|amazon|amozon|thumbtack|\$\s?\d+\s*(card|gift)|\b\d+\s*\$|\bcard\b/i;
const INTEREST_RE = new RegExp([
  '^\\s*(y|yes|yeah|yep|yup|ok|okay|sure|definitely)\\b', '(?<!not )\\binterested\\b', 'call (me|you)', 'give me a call', "schedul(?:e|ing)(?!\\s*(?:is|are|was|has|'s|’s)\\b)", 'sounds (good|great|awesome)',
  'on my radar', 'still considering', 'consider', 'get started', 'love to', "let'?s (do|go|talk)", 'send me', 'tell me more', 'more info', 'what (is|are) the (monthly|price|cost)', 'how much', 'features',
].join('|'), 'i');
// A polite decline is not interest even when it starts with "yeah" or mentions the schedule (Luke, 2026-11-05: "Yeah too expensive" and "Our schedule is still full but thank you" are Other).
const MORE_NEG = /\btoo (expensive|much|pricey|costly)\b|\bcan'?t afford\b|\bnot (worth|in (the|our|my) budget)\b|\bnot (really |that |very |too |all that )?interested\b|\b(schedule|calendar|plate|books?|work ?load)\s+(is|are|'s)?\s*(still |already |totally |completely |pretty |really |fully |all )?(full|booked|packed)\b|\b(full|booked|packed)\s+(up|schedule|calendar)\b|\bnot looking\b|\b(don'?t|do not) (need|want)\b|\bno need\b|\balready (have|use|using|got|work(ing)? with)\b|\bnot (right now|at the moment|yet|now)\b/i;
function signals(reply) {
  const t = String(reply || '');
  if (TAPBACK_RE.test(t)) return { gift: false, interested: false };
  const verdict = classify(t);
  const negative = /^\s*(no|nope|not)\b|never\s*mind|not at this time|not (available|interested)|(when|if) (i'?m |you'?re )?interested|\bim good\b|i'?m good\b|\bno\b[\s\S]*\bso no\b/i.test(t) || MORE_NEG.test(t);
  return { gift: GIFT_RE.test(t), interested: verdict !== 'ban' && !negative && INTEREST_RE.test(t) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[_'’.,]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Accounts we have texted whose name matches. → [{ accountId, accountName }] (one entry per distinct 15-char id) */
function findAccounts(name, accounts) {
  const n = norm(name);
  if (!n) return [];
  const seen = new Map();
  for (const a of accounts) {
    if (norm(a.accountName) !== n) continue;
    const k = String(a.accountId || '').slice(0, 15).toLowerCase();
    if (k && !seen.has(k)) seen.set(k, { accountId: sfId.fix(a.accountId), accountName: a.accountName });
  }
  return [...seen.values()];
}

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
let _replyIds = null;
/** Record one reply (once per Gmail message id) for the dashboard. Replies from an unknown / ambiguous account name are kept without an accountId. */
function noteReply(e, p, hits, { dryRun = false } = {}) {
  if (_replyIds === null) _replyIds = new Set(readJsonl(REPLY_FILE).map((r) => r.messageId));
  const id = String(e.id || '');
  if (!id || _replyIds.has(id) || !p.reply) return false;
  const sig = signals(p.reply);
  if (!dryRun) { append(REPLY_FILE, { at: replyAt(e.date), messageId: id, accountId: hits.length === 1 ? hits[0].accountId : null, accountName: p.name, reply: p.reply, gift: sig.gift, interested: sig.interested, optout: classify(p.reply) === 'ban' }); _replyIds.add(id); }
  return true;
}
const append = (f, row) => fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf8');
/** The email's date as one ISO moment for replies.jsonl. The poller passes it in whatever shape it has (ISO, an email header, SMS-Magic's zone-less stamp); a missing or unreadable one becomes now. */
const replyAt = (date) => (textLog.replyTime(date) || new Date()).toISOString();

/**
 * Process a batch of emails. → [{ id, name, phone, reply, action, detail }]
 *   action: 'banned' | 'already-banned' | 'review' | 'no-optout' | 'not-sms-magic' | 'seen'
 */
function ingest(emails, { dryRun = false } = {}) {
  const handled = new Set(readJsonl(DONE_FILE).map((r) => r.id));
  const accounts = textLog.aggregate();
  const out = [];
  for (const e of emails) {
    const id = String(e.id || e.subject || '');
    if (handled.has(id)) { out.push({ id, action: 'seen' }); continue; }
    const p = parseEmail(e);
    const res = { id, name: p.name, phone: p.phone, reply: p.reply };
    const finish = (action, detail) => {
      Object.assign(res, { action, detail });
      if (!dryRun) {
        append(DONE_FILE, { at: new Date().toISOString(), id, name: p.name, action, detail });
        if (action === 'review') append(REVIEW_FILE, { at: new Date().toISOString(), id, name: p.name, phone: p.phone, reply: p.reply, why: detail, date: e.date || null });
      }
      out.push(res);
    };
    if (!p.name || !SUBJECT_RE.test(String(e.subject || '')) && !/incoming from/i.test(String(e.body || ''))) { finish('not-sms-magic', 'subject/body is not an SMS-Magic reply'); continue; }
    if (!p.reply && PLACEHOLDER_RE.test(String(e.body || ''))) { out.push({ ...res, action: 'unreadable', detail: 'only the empty plain-text part was given — pass the HTML body' }); continue; } // not recorded: retried next time
    const hits = findAccounts(p.name, accounts);
    noteReply(e, p, hits, { dryRun });
    const verdict = classify(p.reply);
    if (verdict === 'none') { finish('no-optout', 'reply is not an opt-out'); continue; }
    if (verdict === 'review') { finish('review', 'reply is ambiguous — read it'); continue; }
    if (hits.length !== 1) { finish('review', hits.length ? `opt-out, but ${hits.length} accounts are named "${p.name}"` : `opt-out, but no texted account is named "${p.name}"`); continue; }
    const acct = hits[0];
    const reason = `texted back opt-out: "${p.reply.replace(/\s+/g, ' ').slice(0, 140)}"`;
    if (textLog.isBanned(acct.accountId) && textLog.isBanned(String(acct.accountId).slice(0, 15))) { finish('already-banned', acct.accountId); continue; }
    if (!dryRun) {
      for (const aid of [acct.accountId, String(acct.accountId).slice(0, 15)]) textLog.recordBan({ accountId: aid, accountName: acct.accountName, reason, source: 'sms reply email' });
    }
    finish('banned', acct.accountId);
  }
  return out;
}

// ---- Email replies: a pro answering OUR outreach email
// Luke's subject line starts "Is Housecall Pro…"; other copies use whatever is in email-templates.json.
// Also accept any Re:/Fwd: from an address we have emailed (matched via the address book below).
const EMAIL_SUBJECT_RE = /^\s*(?:(?:re|fwd?|aw)\s*:\s*)+\s*Is Housecall Pro\b/i;
const REPLY_PREFIX_RE = /^\s*(?:(?:re|fwd?|aw)\s*:\s*)+/i;
const addrOf = (from) => ((String(from || '').match(/<([^>]+@[^>]+)>/) || String(from || '').match(/([^\s<>"']+@[^\s<>"']+)/) || [])[1] || '').trim().toLowerCase();
/** True when this Gmail looks like a reply to our outreach (by subject template or by From ∈ people we emailed). */
function isOutreachReply(e, book) {
  const subj = String(e.subject || '');
  const from = addrOf(e.from);
  if (/mailer-daemon|postmaster|no-?reply|donotreply/i.test(from)) return false;
  if (/^(automatic reply|auto-?reply|out of office|undeliverable|delivery status)/i.test(subj.replace(REPLY_PREFIX_RE, ''))) return false;
  if (EMAIL_SUBJECT_RE.test(subj)) return true;
  if (REPLY_PREFIX_RE.test(subj) && from && book.has(from)) return true;
  // Extra subjects from this copy's email-templates.json (e.g. "What if new jobs found…")
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-templates.json'), 'utf8')) || {};
    for (const t of Object.values(all)) {
      if (!t || typeof t !== 'object' || !t.subject) continue;
      const needle = String(t.subject).replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (needle.length >= 12 && REPLY_PREFIX_RE.test(subj) && subj.toLowerCase().includes(needle.toLowerCase().slice(0, 24))) return true;
    }
  } catch (_) { /* no templates file */ }
  return false;
}

/** The new text of an email reply: HTML → text, minus the quoted original, the "On … wrote:" line and the signature. */
function emailReplyText(body) {
  const raw = String(body || '');
  const text = (/<(html|p|div|table|br)\b/i.test(raw) ? htmlToText(raw.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')) : raw).replace(/\r/g, '');
  const cut = text.search(/\n\s*(On .{5,120}wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:|_{5,}|Sent from my )/i);
  const head = cut >= 0 ? text.slice(0, cut) : text;
  return head.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Accounts we emailed, by the address we sent to (outreach log) or the report's address. → Map address → { accountId, accountName } */
function emailAddressBook() {
  const m = new Map();
  for (const [k, v] of textLog.readReportEmails()) if (v.email) m.set(String(v.email).toLowerCase(), { key: k, accountName: null });
  for (const r of textLog.readAll()) if (r && r.email && r.accountId) m.set(String(r.email).toLowerCase(), { accountId: sfId.fix(r.accountId), accountName: r.accountName });
  for (const r of readJsonl(path.join(__dirname, 'account-emails.jsonl'))) if (r.email && r.accountId) m.set(String(r.email).toLowerCase(), { accountId: sfId.fix(r.accountId), accountName: r.accountName });
  return m;
}

/**
 * Process Gmail replies to our outreach email. emails: [{ id, subject, from, body, date }]
 * Recorded in replies.jsonl (channel 'email') for the dashboard; a clear opt-out bans the account, an ambiguous one goes to review.
 * → [{ id, from, name, reply, action, detail }]   action: 'banned'|'already-banned'|'review'|'no-optout'|'not-outreach-reply'|'seen'|'unmatched'
 */
function ingestEmailReplies(emails, { dryRun = false } = {}) {
  const handled = new Set(readJsonl(DONE_FILE).map((r) => r.id));
  const book = emailAddressBook(); const out = [];
  for (const e of emails) {
    const id = String(e.id || '');
    const from = addrOf(e.from);
    const res = { id, from };
    const finish = (action, detail) => {
      Object.assign(res, { action, detail });
      if (!dryRun) {
        append(DONE_FILE, { at: new Date().toISOString(), id, name: res.name || from, action, detail });
        if (action === 'review') append(REVIEW_FILE, { at: new Date().toISOString(), id, name: res.name || from, phone: null, reply: res.reply, why: detail, date: e.date || null, channel: 'email' });
      }
      out.push(res);
    };
    if (!id || handled.has(id)) { out.push({ ...res, action: 'seen' }); continue; }
    if (!isOutreachReply(e, book)) { finish('not-outreach-reply', 'subject/from is not a reply to our outreach email'); continue; }
    const reply = emailReplyText(e.body); res.reply = reply;
    const acct = book.get(from) || null;
    res.name = (acct && acct.accountName) || ((String(e.from || '').match(/^\s*"?([^"<]+?)"?\s*</) || [])[1]) || from;
    if (!reply) { finish('review', 'empty reply body'); continue; }
    const sig = signals(reply), verdict = classify(reply);
    if (!dryRun) {
      if (_replyIds === null) _replyIds = new Set(readJsonl(REPLY_FILE).map((r) => r.messageId));
      if (!_replyIds.has(id)) { append(REPLY_FILE, { at: replyAt(e.date), messageId: id, accountId: (acct && acct.accountId) || null, accountName: res.name, reply, gift: sig.gift, interested: sig.interested, optout: verdict === 'ban', channel: 'email', from }); _replyIds.add(id); }
    }
    if (verdict === 'none') { finish('no-optout', 'reply is not an opt-out'); continue; }
    if (verdict === 'review') { finish('review', 'reply is ambiguous — read it'); continue; }
    if (!acct || !acct.accountId) { finish('review', `opt-out, but no account has the address ${from}`); continue; }
    const reason = `emailed back opt-out: "${reply.replace(/\s+/g, ' ').slice(0, 140)}"`;
    if (textLog.isBanned(acct.accountId) && textLog.isBanned(String(acct.accountId).slice(0, 15))) { finish('already-banned', acct.accountId); continue; }
    if (!dryRun) for (const aid of [acct.accountId, String(acct.accountId).slice(0, 15)]) textLog.recordBan({ accountId: aid, accountName: acct.accountName, reason, source: 'email reply' });
    finish('banned', acct.accountId);
  }
  return out;
}

/** Re-derive the gift / interested / optout flags of every saved reply from its text (after the wording rules change). → number of rows changed */
function recategorize() {
  const rows = readJsonl(REPLY_FILE); let changed = 0;
  const out = rows.map((r) => {
    if (r.manual) return r;   // hand-added (interested list): its flags are the rep's call, not the wording's
    const sig = signals(r.reply), optout = classify(r.reply) === 'ban';
    if (r.gift !== sig.gift || r.interested !== sig.interested || r.optout !== optout) changed++;
    return { ...r, gift: sig.gift, interested: sig.interested, optout };
  });
  fs.writeFileSync(REPLY_FILE, out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''), 'utf8');
  return changed;
}

/** Backfill: record the replies in these emails for the dashboard (no bans, ignores the processed list). → { total, recorded } */
function recordRepliesOnly(emails, { dryRun = false } = {}) {
  const accounts = textLog.aggregate();
  let recorded = 0;
  for (const e of emails) { const p = parseEmail(e); if (p.name && p.reply && noteReply(e, p, findAccounts(p.name, accounts), { dryRun })) recorded++; }
  return { total: emails.length, recorded };
}

module.exports = { ingestEmailReplies, emailReplyText, recategorize, signals, recordRepliesOnly, parseEmail, classify, findAccounts, ingest, STOP_RE, DONE_FILE, REVIEW_FILE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--review') {
    const rows = readJsonl(REVIEW_FILE);
    console.log(`\n${rows.length} reply(ies) waiting for a look\n`);
    for (const r of rows) console.log(`  ${String(r.date || r.at).slice(0, 16)}  ${r.name}  (${r.phone || 'no phone'})\n     "${String(r.reply).replace(/\s+/g, ' ').slice(0, 160)}"\n     ${r.why}`);
    console.log('');
  } else if (argv[0] === '--recategorize') {
    console.log(`\n${recategorize()} reply(ies) re-flagged\n`);
  } else if (argv[0] === '--replies-only' && argv[1]) {
    const dryRun = argv.includes('--dry-run');
    const raw = argv[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(argv[1], 'utf8');
    const r = recordRepliesOnly(JSON.parse(raw), { dryRun });
    console.log(`\n${dryRun ? '(dry run) ' : ''}${r.recorded} of ${r.total} reply(ies) recorded for the dashboard\n`);
  } else if (argv[0] === '--ingest-email-replies' && argv[1]) {
    const dryRun = argv.includes('--dry-run');
    const raw = argv[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(argv[1], 'utf8');
    const res = ingestEmailReplies(JSON.parse(raw), { dryRun });
    console.log(`\n${dryRun ? '(dry run — nothing written) ' : ''}${res.length} email reply(ies)\n`);
    for (const r of res) console.log(`  ${r.action.padEnd(18)} ${r.name || r.from || ''}  ${r.reply ? '"' + r.reply.replace(/\s+/g, ' ').slice(0, 80) + '"' : ''} ${r.detail || ''}`);
    console.log('');
  } else if (argv[0] === '--ingest' && argv[1]) {
    const dryRun = argv.includes('--dry-run');
    const raw = argv[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(argv[1], 'utf8');
    const res = ingest(JSON.parse(raw), { dryRun });
    console.log(`\n${dryRun ? '(dry run — nothing written) ' : ''}${res.length} email(s)\n`);
    for (const r of res) console.log(`  ${r.action.padEnd(14)} ${r.name || ''}  ${r.reply ? '"' + r.reply.replace(/\s+/g, ' ').slice(0, 80) + '"' : ''} ${r.detail || ''}`);
    console.log('');
  } else {
    console.log('usage: node optOut.js --ingest <emails.json|-> | --ingest-email-replies <emails.json|-> [--dry-run]   |   node optOut.js --review');
  }
}
