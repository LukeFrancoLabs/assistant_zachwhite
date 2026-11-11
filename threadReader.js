'use strict';

/**
 * threadReader — read an account's SMS-Magic text thread off the Texts tab, and decide whether it is safe to text.
 *
 * The thread (seen with `email --thread-probe`) is  div.listWrapper > div.messageBox.outGoing | .inComing  with  div.dateDevider  between days
 * (a divider hidden with slds-hide still carries the date of the day it belongs to). A message's text ends with its sender and time:
 *     outgoing   "<body> 08:33 AM( Rachel Buchanan18333370813 )"        sender = the rep who sent it (+ our number)
 *     incoming   "<body> ( Luke Franco15737952155 )09:51 AM"            name   = the rep the pro texted (+ the pro's number)
 * So an OUTGOING text names who sent it — that is how a teammate's text is told apart from ours.
 *
 * readThread(page) → { ok, messages:[{ dir:'in'|'out', sender, at: Date|null, body }] }   (oldest first; reads only what is on screen: the newest messages)
 * decide(messages, { mode, now, emptyOk }) → { hold, reason, kind }      mode 'normal': hold if an opt-out is anywhere in the thread, if the pro's message is the LAST one in it (nobody has answered it), or if a teammate texted in 48h
 *                                                                  (a reply that someone already answered more than 48h ago no longer holds: see decideNormal).
 *                                                                  No messages at all holds as 'unreadable' (it may not have loaded), unless emptyOk: the caller knows nobody ever texted this account
 *                                                                  mode 'teammate': send only if a teammate DID text in 48h (and the pro has not replied)
 *                                                                  mode 'nudge' (--teammate-texted): the strict rule — the pro replied after our last text, or an opt-out anywhere, holds
 */

const fs = require('fs');
const path = require('path');

const sender = require('./sender');
// our own rep name, as the thread prints it: sender.json fullName (ASSISTANT_SENDER overrides it). Until it is filled in this is a name nobody has, so no message in a thread reads as ours.
const ME = String(process.env.ASSISTANT_SENDER || sender.fullName || '\u0000unset').trim().toLowerCase();
const READS_FILE = path.join(__dirname, 'thread-reads.jsonl');

/** Runs in the page: the raw, in-order list of messages with the date divider each one sits under. */
function scrapeThread() {
  const all = [];
  const walk = (root) => { root.querySelectorAll('*').forEach((e) => { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); }); };
  walk(document);
  const boxes = all.filter((e) => e.classList && e.classList.contains('messageBox'));
  const lists = [...new Set(boxes.map((b) => b.parentElement).filter(Boolean))];
  const list = lists.sort((a, b) => b.children.length - a.children.length)[0];
  if (!list) return { found: false, items: [] };
  const items = [];
  let date = null;
  for (const k of Array.from(list.children)) {
    const cls = k.classList;
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    if (cls.contains('dateDevider')) { const d = clean(k.textContent); if (d) date = d; continue; }     // a hidden divider still names its day: textContent
    if (!cls.contains('messageBox')) continue;
    // A message box also holds a hidden "Details" popup (mobile number, lookups…) and icons: drop those before reading the text.
    const c = k.cloneNode(true);
    c.querySelectorAll('.hover-btns, .popover, [role="dialog"], .slds-popover, .slds-hide, [hidden], [style*="display: none"], [style*="display:none"], lightning-icon, svg, style, script').forEach((n) => n.remove());
    c.querySelectorAll('br, p, div, li').forEach((n) => n.append(' '));        // keep line breaks as spaces ("Deanna!\nSent" → "Deanna! Sent")
    const txt = clean(c.textContent);
    items.push({ dir: cls.contains('inComing') ? 'in' : cls.contains('outGoing') ? 'out' : '?', date, raw: txt });
  }
  return { found: true, items };
}

/** One scraped item → { dir, sender, at, body }. The time and the sender are the LAST of each pattern in the text (a body may mention "3:30pm"). */
function parseItem(it) {
  const raw = it.raw;
  const times = [...raw.matchAll(/(\d{1,2}:\d{2})\s*([AaPp][Mm])\b/g)];
  const who = [...raw.matchAll(/\(\s*([^()]*?)\s*\d{7,}\s*\)/g)];
  const t = times[times.length - 1], w = who[who.length - 1];
  let at = null;
  if (t && it.date) { const d = new Date(`${String(it.date).replace(/\s+/g, ' ').trim()} ${t[1]} ${t[2].toUpperCase()}`); if (!isNaN(d)) at = d; }
  const cut = Math.min(...[t, w].filter(Boolean).map((m) => m.index), raw.length);
  return { dir: it.dir, sender: w ? w[1].trim() : null, at, body: raw.slice(0, cut).trim() };
}

async function readThread(page) {
  let r;
  try { r = await page.evaluate(scrapeThread); } catch (e) { return { ok: false, messages: [], error: e.message }; }
  if (!r || !r.found) return { ok: false, messages: [], error: 'no message list on the page' };
  return { ok: true, messages: r.items.map(parseItem) };
}

const isMe = (m) => !!m.sender && m.sender.toLowerCase().includes(ME);
const ago = (d, now) => (d ? Math.max(0, Math.round((now - d.getTime()) / 3600000)) + 'h ago' : 'time unknown');
const since = (d, now) => { if (!d) return 'time unknown'; const h = Math.max(0, Math.round((now - d.getTime()) / 3600000)); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };      // "1082h ago" reads as "45d ago"
const snip = (s) => `"${String(s || '').replace(/\s+/g, ' ').slice(0, 70)}"`;

/**
 * mode 'normal' (--followup, --same-day, the board's text 2 and later). Hold when
 *   1. an OPT-OUT is anywhere in the thread, at any age: a reply of the pro's that says stop / not interested (holdInbox.OPT_OUT), or the automated "opted out of text" reply;
 *   2. the pro's message is the LAST one in the thread: nobody has answered it yet;
 *   3. a teammate texted in the last `teammateHours`: a person is in that conversation now.
 * A reply that someone (us or a teammate) already answered, more than `teammateHours` ago, no longer holds. It used to, for good: "after our last text" starts at the TOP of a thread where we
 * never texted (a teammate did), so every reply the pro ever sent counted, answered or not, and the same pros were read and held on every run.
 * The kind of each hold is what it was, so the hold inbox, the board and the 🤝 tab read them as before: 'replied' = the pro replied and it is still live (an opt-out, an unanswered reply, or a
 * teammate answering within the window), 'teammate' = a teammate texted and the pro has not replied. `repliedAfterMine` is the old test (a pro message after OUR last text); it only picks that kind.
 */
function decideNormal(messages, t, teammateHours, repliedAfterMine) {
  const { OPT_OUT, AUTO_OPT_OUT } = require('./holdInbox');
  const real = messages.filter((m) => m.dir === 'in' || m.dir === 'out');
  const last = real[real.length - 1];
  const stop = [...real].reverse().find((m) => (m.dir === 'in' && OPT_OUT.test(m.body)) || (m.dir === 'out' && AUTO_OPT_OUT.test(m.body)));
  if (stop) return { hold: true, kind: 'replied', reason: `an opt-out is in the thread (${since(stop.at, t)}): ${snip(stop.body)}` };
  if (last && last.dir === 'in') return { hold: true, kind: 'replied', reason: `the pro's reply (${since(last.at, t)}) is the last message in the thread and nobody has answered it: ${snip(last.body)}` };
  const mates = messages.filter((m) => m.dir === 'out' && !isMe(m) && (!m.at || t - m.at.getTime() <= teammateHours * 3600000));
  if (mates.length) {
    const m = mates[mates.length - 1];
    return { hold: true, kind: repliedAfterMine ? 'replied' : 'teammate', reason: `${m.sender || 'a teammate'} texted ${ago(m.at, t)}${repliedAfterMine ? ' (the pro has replied before)' : ''}: ${snip(m.body)}` };
  }
  return { hold: false, kind: 'clear', reason: 'no opt-out, no unanswered reply and no teammate text in the last ' + teammateHours + 'h in the thread' };
}

function decide(messages, { mode = 'normal', now = new Date(), teammateHours = 48, emptyOk = false } = {}) {
  if (!messages || !messages.length) {
    // No messages is also what a thread that did not load looks like, so it holds, unless the caller has its OWN reason to expect an empty one (emptyOk: nobody has ever texted this account).
    if (!emptyOk) return { hold: true, kind: 'unreadable', reason: 'could not read any messages in the thread' };
    if (mode === 'teammate') return { hold: true, kind: 'no-teammate', reason: `no teammate text in the last ${teammateHours}h in the thread (the report said there was one)` };
    return { hold: false, kind: 'empty', reason: 'the thread is empty: nobody has texted this account yet' };
  }
  const t = now.getTime();
  const lastMine = (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].dir === 'out' && isMe(messages[i])) return i; return -1; })();
  const replied = messages.slice(lastMine + 1).filter((m) => m.dir === 'in');
  if (mode !== 'nudge' && mode !== 'teammate') return decideNormal(messages, t, teammateHours, replied.length > 0);
  if (replied.length) { const r = replied[replied.length - 1]; return { hold: true, kind: 'replied', reason: `the pro replied ${ago(r.at, t)} after our last text: ${snip(r.body)}` }; }      // (nudge / teammate: the strict rule, unchanged)
  const mates = messages.filter((m) => m.dir === 'out' && !isMe(m) && (!m.at || t - m.at.getTime() <= teammateHours * 3600000));
  if (mode === 'nudge') {         // --teammate-texted: the teammate's text is WHY the pro is on the list, so it does not hold; an opt-out anywhere in the thread still does
    const { OPT_OUT, AUTO_OPT_OUT } = require('./holdInbox');
    const stop = messages.find((m) => (m.dir === 'in' && OPT_OUT.test(m.body)) || (m.dir === 'out' && AUTO_OPT_OUT.test(m.body)));      // (the 2nd: the automated "You've opted out of text communication" reply)
    if (stop) return { hold: true, kind: 'opted-out', reason: `an opt-out is in the thread: ${snip(stop.body)}` };
    const m = mates[mates.length - 1];
    return { hold: false, kind: m ? 'teammate' : 'clear', reason: m ? `${m.sender || 'a teammate'} texted ${ago(m.at, t)}; the pro has not replied` : 'no reply in the thread' };
  }
  // mode 'teammate': the pro has not replied; send only if a teammate DID text in the window
  if (!mates.length) return { hold: true, kind: 'no-teammate', reason: `no teammate text in the last ${teammateHours}h in the thread (the report said there was one)` };
  return { hold: false, kind: 'teammate', reason: `${mates[mates.length - 1].sender || 'a teammate'} texted ${ago(mates[mates.length - 1].at, t)}` };
}

/** Append one read to thread-reads.jsonl (the dashboard's 🤝 tab lists the holds). */
function record({ accountId, accountName, accountUrl, verdict, mode, messages, note }) {
  const last = (messages || [])[(messages || []).length - 1] || null;
  const row = { at: new Date().toISOString(), accountId: accountId || null, accountName: accountName || null, accountUrl: accountUrl || null, hold: verdict.hold, kind: verdict.kind, reason: verdict.reason, mode, n: (messages || []).length, last: last ? { dir: last.dir, sender: last.sender, at: last.at ? last.at.toISOString() : null, body: String(last.body || '').slice(0, 200) } : null, ...(note ? { note: String(note).slice(0, 160) } : {}) };      // note: why nothing could be read ("no message list on the page")
  try { fs.appendFileSync(READS_FILE, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}

/** The newest read per account that was a HOLD in the last `days` days (for the dashboard). */
function recentHolds(days = 3) {
  const out = new Map();
  try {
    for (const l of fs.readFileSync(READS_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.accountId) out.set(String(r.accountId).toLowerCase().slice(0, 15), r);
    }
  } catch (_) {}
  const cutoff = Date.now() - days * 864e5;
  return [...out.values()].filter((r) => r.hold && Date.parse(r.at) >= cutoff).sort((a, b) => (a.at < b.at ? 1 : -1));
}

module.exports = { readThread, decide, record, recentHolds, parseItem, scrapeThread, READS_FILE, ME };
