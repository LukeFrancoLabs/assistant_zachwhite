'use strict';

/**
 * stopBan — a pro who texts STOP, or says "I am not interested", goes on the do-not-contact list BY ITSELF.
 *
 * WHY (2026-11-02): the conversation check (threadReader.decide) HOLDS a pro whose saved SMS thread has a Stop and saves the conversation in hold-inbox.jsonl, but nothing put that pro on the
 * banlist, the list every text and email run checks. 23 had piled up (most were Stops to a TEAMMATE's older text; the log showed 15 texts and 17 emails sent to them after the Stop).
 * Luke: "Yes, automatically".
 *
 * THE RULE (Luke, 2026-10-29: "we should only treat, stop as not interested or if the person says 'I am not interested'"): the pro's LAST message in the saved conversation is a Stop (the word:
 * "STOP", "Stop texting me", "please stop calling") or says "not interested". That is narrower than the hold list (holdInbox.OPT_OUT: remove, unsubscribe, no thanks, do not contact, wrong number,
 * lawsuit…), which still only HOLDS: `node stopBan.js` lists those for him to decide and never bans them. Not banned either: a Stop the pro later wrote past (a reply, a START: the LAST message
 * decides), a business's own auto-reply ("Reply STOP to opt out…"), "stop by" / "can't stop", and a message over 200 characters.
 *
 *   holdInbox.add() calls banFromHold(row) the moment it saves a hold, so a Stop is on the list before anything else can send. A bot that was already running keeps its old code,
 *   so `node stopBan.js` is the catch-up:
 *   node stopBan.js            what it would do (writes nothing): the Stops that are not on the list, and the other opt-out wording it leaves for you
 *   node stopBan.js --apply    put those accounts on the list (18- and 15-character id, source 'thread read stop reply') and rebuild the local dashboard file
 *
 * Nothing in here sends anything or opens a browser.
 */

const SOURCE = 'thread read stop reply';
const MAX_LEN = 200;
// the word "stop", not as part of "non-stop", and not "don't stop" / "can't stop" / "never stop", not "stop by" / "stop in" / "stop over" / "stop off"
const STOP_WORD = /(?<![\w-])(?<!(?:don'?t|dont|can'?t|cant|cannot|won'?t|wont|never)\s+)stop(?![\w-])(?!\s+(?:by|in|over|off)\b)/i;
const NOT_INTERESTED = /\bnot\s+interested\b/i;
// a business telling US how to opt out of ITS auto-replies ("Reply STOP to opt out of all future messages"), which is not a pro asking us to stop
const INSTRUCTION = /\b(?:reply|text|respond|send|type|say|msg|message)\s+(?:with\s+|the word\s+)?["'“‘]?\s*(?:stop|end|cancel|quit|unsubscribe)\b|\bstop\s+to\s+(?:opt|unsub|cancel|end)|\b(?:msg|message)\s*(?:&|and)\s*data\s+rates\b/i;

/** 'stop' | 'not interested' | null for what a pro wrote. */
function classify(body) {
  const t = String(body == null ? '' : body).replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_LEN || INSTRUCTION.test(t)) return null;
  if (STOP_WORD.test(t)) return 'stop';
  if (NOT_INTERESTED.test(t)) return 'not interested';
  return null;
}

/** The saved conversation → { ban, what, said, at, sender } or { ban:false, why }. Only the pro's LAST message counts. */
function judge(messages) {
  const ins = (Array.isArray(messages) ? messages : []).filter((m) => m && m.dir === 'in');
  const last = ins[ins.length - 1];
  if (!last) return { ban: false, why: 'the pro has not written anything in the saved conversation' };
  const what = classify(last.body);
  if (!what) return { ban: false, why: "the pro's last message is not a stop", last };
  return { ban: true, what, said: String(last.body).replace(/\s+/g, ' ').trim().slice(0, 80), at: last.at || null, sender: last.sender || null };
}

/** What the sweep leaves for Luke, from a conversation that is NOT a ban: 'C' a Stop the pro wrote past, 'B' the platform's opt-out confirmation with no stop words saved, 'D' other opt-out wording the guard holds on. */
function flagOf(messages) {
  const { OPT_OUT, AUTO_OPT_OUT } = require('./holdInbox');
  const msgs = Array.isArray(messages) ? messages : [], ins = msgs.filter((m) => m && m.dir === 'in');
  if (ins.some((m) => classify(m.body))) return 'C';
  if (msgs.some((m) => m && m.dir === 'out' && AUTO_OPT_OUT.test(String(m.body || '')))) return 'B';
  if (ins.some((m) => OPT_OUT.test(String(m.body || '')))) return 'D';
  return null;
}

function defaultDeps() {
  const textLog = require('./textLog');
  return { recordBan: textLog.recordBan, isBanned: textLog.isBanned, sfId: require('./sfId') };
}

/** The ids to write: the 18-character id with its case restored and its 15-character form (a 15-character id alone when that is all there is). */
function idsFor(accountId, sfId) {
  const fixed = sfId.fix(String(accountId));
  return String(fixed).length === 18 ? [fixed, fixed.slice(0, 15)] : [String(accountId).slice(0, 15)];
}

/** A hold was just saved (holdInbox.add): put the account on the list when its conversation ends in a Stop. → { banned, already?, ids?, said?, what?, reason?, why? } */
function banFromHold(row, deps = defaultDeps()) {
  if (!row || !row.accountId) return { banned: false, why: 'no account id' };
  const j = judge(row.messages);
  if (!j.ban) return { banned: false, why: j.why };
  if (deps.isBanned(row.accountId)) return { banned: false, already: true, said: j.said, what: j.what };
  const ids = idsFor(row.accountId, deps.sfId), date = String(j.at || row.at || '').slice(0, 10);
  const reason = `texted back opt-out in the saved SMS conversation: "${j.said}" (${date}); put on the list by the conversation check (Luke's rule: Stop / I am not interested)`;
  let wrote = 0;
  for (const accountId of ids) if (deps.recordBan({ accountId, accountName: row.accountName || null, reason, source: SOURCE })) wrote++;
  return { banned: wrote > 0, ids, said: j.said, what: j.what, reason };
}

/** Every open hold (newest row per account; cleared and sent ones are closed). → { ban:[{ row, judge }], flagged:{ B:[], C:[], D:[] }, already, closed, none } */
function sweep({ rows = null, deps = defaultDeps() } = {}) {
  const all = rows || [...require('./holdInbox').readAll().values()];
  const out = { ban: [], flagged: { B: [], C: [], D: [] }, already: 0, closed: 0, none: 0 };
  for (const row of all) {
    if (!row || !row.accountId) continue;
    if (row.status === 'cleared' || row.status === 'sent') { out.closed++; continue; }
    if (deps.isBanned(row.accountId)) { out.already++; continue; }
    const j = judge(row.messages);
    if (j.ban) { out.ban.push({ row, judge: j }); continue; }
    const f = flagOf(row.messages);
    if (f) { const ins = (row.messages || []).filter((m) => m.dir === 'in'); out.flagged[f].push({ row, said: String((ins[ins.length - 1] || {}).body || '').replace(/\s+/g, ' ').slice(0, 70) }); } else out.none++;
  }
  return out;
}

/** The command. Returns the exit code. (`deps` and `rows` are for tests: fake ban functions, a rebuild stand-in, fixture hold rows.) */
function cli(argv, out = console.log, deps, rows = null) {
  const apply = argv.includes('--apply'), unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) { out(`\n❌ Unknown option ${unknown[0]}\n\nUsage:  node stopBan.js [--apply]\n`); return 1; }
  const d = deps || defaultDeps(), r = sweep({ rows, deps: d });
  out(`\n🚫 Stop / "I am not interested" replies in the saved conversations that are not on the do-not-contact list: ${r.ban.length}${apply ? '' : '  (nothing is written without --apply)'}`);
  for (const { row, judge: j } of r.ban) out(`   • ${row.accountName || row.accountId}: "${j.said}" (${String(j.at || row.at || '').slice(0, 10)}${j.sender ? ', in ' + j.sender + "'s thread" : ''})`);
  let wrote = 0;
  if (apply) for (const { row } of r.ban) { const b = banFromHold(row, d); if (b.banned) wrote++; }
  const flagged = [['D', 'other opt-out wording the guard holds on (remove, no thanks, do not contact…): not banned, your call'], ['B', 'the platform confirmed an opt-out but no stop words were saved: not banned, your call'], ['C', 'a Stop the pro wrote past (they replied again after it): not banned, your call']];
  for (const [k, label] of flagged) if (r.flagged[k].length) { out(`\n⚠️  ${r.flagged[k].length} with ${label}`); for (const f of r.flagged[k].slice(0, 25)) out(`   • ${f.row.accountName || f.row.accountId}: "${f.said}"`); }
  out(`\n${apply ? `Put on the list: ${wrote}. ` : ''}Already on the list: ${r.already} · closed holds: ${r.closed} · no opt-out signal: ${r.none}\n`);
  if (apply && wrote) { try { (d.rebuild || (() => require('./textLog').generateDashboard()))(); out('The local dashboard file was rebuilt; the published copy shows them after the next republish.\n'); } catch (e) { out('(the dashboard rebuild failed: ' + e.message + ')\n'); } }
  return 0;
}

module.exports = { classify, judge, flagOf, banFromHold, sweep, cli, idsFor, SOURCE, MAX_LEN };

if (require.main === module) process.exit(cli(process.argv.slice(2)));
