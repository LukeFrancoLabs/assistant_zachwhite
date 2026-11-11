#!/usr/bin/env node
'use strict';

/**
 * topHit — the 🎯 TOP HIT LIST (dashboard, Leads): the pros who answered with interest, plus the accounts Luke keeps on his own hit list.
 * Being on it takes NOBODY out of the follow-up board: only a "not interested" does that (Luke, 2026-11-03: "Do not move pros out of the board cadence unless the reply is that they are not interested ...
 * a lot of people will reply why and then they go ghost so we still need to reach out to them"). The list is a view over what is already logged, nothing new is stored for it except a hand removal:
 *
 *   - a reply the reply reader (optOut.js) flagged `interested` in replies.jsonl: a text or an email reply, a clear opt-out never counts;
 *   - Luke's own notes, saved beside the replies as "[Top hit list] …" rows with manual: true (the same rows dailyReport.js and perfAnalytics.js already leave out of the reply counts);
 *   - an account added by hand with `--add`, which writes such a note row.
 * Taken off by hand with `--remove` (top-hit-removed.jsonl); a newer interested reply or note puts it back. Banned accounts, current customers and closed-won leave the list on their own.
 *
 *   node topHit.js                                                       the list (no browser, nothing sent)
 *   node topHit.js --json                                                the same as JSON
 *   node topHit.js --add <accountId | Salesforce link> --note "what happened" [--name "Business"]
 *   node topHit.js --remove <accountId | Salesforce link> [--why "…"]
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.ASSISTANT_TOPHIT_DIR || __dirname;
const REMOVED_FILE = path.join(DIR, 'top-hit-removed.jsonl');       // one line per hand removal: { at, accountId, accountName, why }
const NOTE_RE = /^\s*\[Top hit list\]\s*/i;                          // Luke's hit-list notes saved beside the replies (a note, not a text a pro sent)
const SF_ORIGIN = 'https://housecallpro.lightning.force.com';
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[_'’.,]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const when = (r) => { const t = Date.parse(r && r.at); return Number.isFinite(t) ? t : 0; };
const clean = (s) => String(s == null ? '' : s).replace(NOTE_RE, '').replace(/\s+/g, ' ').trim();

/**
 * The list from plain rows (a test passes its own). replies = replies.jsonl rows (at as an ISO moment), removed = top-hit-removed.jsonl rows,
 * exclude(accountId) → why an account may not be listed (banned, a customer, closed won) or null, link(name) → { accountId, accountName, url } | null for a reply the poller could not tie to an account.
 * → { rows: [{ key, id, name, url, kind: 'note' | 'reply', text, at, n, note, noteAt, reply, replyAt }], hidden: [{ name, why }] }, newest first.
 *   `text` = the newest of the note and the interested reply; `n` = how many interested replies the account sent; `kind` says which one `text` is.
 */
function build({ replies = [], removed = [], exclude = () => null, link = () => null } = {}) {
  const groups = new Map();
  // A business name → the one account the other rows give that name (null when two accounts share it): a reply the poller could not tie to an account joins the account its name belongs to, e.g. the one a note is saved for.
  const byName = new Map();
  for (const r of replies) {
    const nk = r && r.accountId ? norm(r.accountName) : '';
    if (!nk) continue;
    const cur = byName.get(nk);
    if (cur === undefined) byName.set(nk, { accountId: r.accountId, accountName: r.accountName }); else if (cur && k15(cur.accountId) !== k15(r.accountId)) byName.set(nk, null);
  }
  for (const r of replies) {
    if (!r) continue;
    const isNote = !!r.manual && NOTE_RE.test(String(r.reply || ''));
    const isInterest = !r.manual && r.interested === true && !r.optout;
    if (!isNote && !isInterest) continue;
    let id = r.accountId || null, name = r.accountName || '', url = r.accountUrl || null, key = k15(id);
    if (!key) { const l = link(name, r) || byName.get(norm(name)) || null; if (l && l.accountId) { id = l.accountId; name = l.accountName || name; url = l.url || null; key = k15(id); } else key = 'name:' + norm(name); }
    if (key === 'name:') continue;
    const g = groups.get(key) || { key, id, name, url, notes: [], replies: [] };
    if (id && !g.id) g.id = id;
    if (url && !g.url) g.url = url;
    (isNote ? g.notes : g.replies).push(r);
    groups.set(key, g);
  }
  const gone = new Map();      // key → when it was taken off by hand
  for (const x of removed) { const key = k15(x.accountId) || 'name:' + norm(x.accountName); if (key !== 'name:') gone.set(key, Math.max(gone.get(key) || 0, when(x))); }
  const rows = [], hidden = [];
  for (const g of groups.values()) {
    const lastNote = g.notes.slice().sort((a, b) => when(b) - when(a))[0] || null, lastReply = g.replies.slice().sort((a, b) => when(b) - when(a))[0] || null;
    const latest = Math.max(lastNote ? when(lastNote) : 0, lastReply ? when(lastReply) : 0);
    const label = g.name || (lastNote && lastNote.accountName) || (lastReply && lastReply.accountName) || '(unnamed account)';
    if (gone.has(g.key) && gone.get(g.key) >= latest) { hidden.push({ name: label, why: 'taken off the list by hand' }); continue; }
    const why = g.id ? exclude(g.id) : null;
    if (why) { hidden.push({ name: label, why }); continue; }
    const primary = lastNote && (!lastReply || when(lastNote) >= when(lastReply)) ? lastNote : lastReply;
    rows.push({
      key: g.key, id: g.id || null, name: label, url: g.url || (g.id ? `${SF_ORIGIN}/lightning/r/Account/${require('./sfId').fix(g.id)}/view` : null),
      kind: primary === lastNote ? 'note' : 'reply', text: clean(primary.reply), at: new Date(latest || Date.now()).toISOString(), n: g.replies.length,
      note: lastNote ? clean(lastNote.reply) : null, noteAt: lastNote ? lastNote.at : null, reply: lastReply ? clean(lastReply.reply) : null, replyAt: lastReply ? lastReply.at : null,
    });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows, hidden };
}

/**
 * The real list. opts.leads = the board's members (cadence.members) so an unlinked reply can be tied to a lead by its exact business name (only when one lead has that name).
 * Banned accounts, current customers and closed-won leave on their own (the same lists the board uses).
 */
function list(opts = {}) {
  const tl = require('./textLog');
  const safe = (fn, fb) => { try { return fn(); } catch (_) { return fb; } };
  const replies = safe(() => tl.readReplyRows(), []);
  const bans = safe(() => tl.readBans(), new Map()), green = safe(() => tl.readGreen(), new Map()), won = safe(() => tl.readClosedWon(), new Map()), cust = safe(() => tl.readCurrentCustomers(), new Map());
  const byId = (map, id) => map.get(String(id || '').toLowerCase()) || map.get(k15(id));
  const exclude = (id) => (tl.isBanned(id, bans, green) ? 'on the do-not-contact list' : byId(cust, id) ? 'a current customer' : byId(won, id) ? 'closed won' : null);
  const names = new Map();
  for (const l of opts.leads || []) { const k = norm(l.name); if (k) names.set(k, names.has(k) ? null : l); }
  const link = (name) => { const l = names.get(norm(name)); return l ? { accountId: l.accountId, accountName: l.name, url: l.url || null } : null; };
  return build({ replies, removed: readJsonl(REMOVED_FILE), exclude, link });
}

/** The 15-character ids on the list (for a count on the board plan). */
function ids(opts = {}) { return new Set(list(opts).rows.map((r) => k15(r.id)).filter(Boolean)); }

/** "001PD…" or a Lightning link → the account id, or null. */
function idOf(arg) {
  const s = String(arg || '').trim();
  const m = s.match(/\/Account\/([A-Za-z0-9]{15,18})/) || s.match(/^(001[A-Za-z0-9]{12,15})$/);
  return m ? m[1] : null;
}

/** Put an account on the list by hand: a "[Top hit list] …" note row beside the replies (what the first twelve were). → the row. */
function add({ id, name, note }) {
  const tl = require('./textLog'), sfId = require('./sfId');
  const fixed = sfId.fix(id);
  const known = tl.aggregate().find((a) => k15(a.accountId) === k15(fixed));
  const row = { at: new Date().toISOString(), messageId: `manual-top-hit-${k15(fixed)}-${Date.now().toString(36)}`, accountId: fixed, accountName: name || (known && known.accountName) || '(unnamed account)', reply: `[Top hit list] ${String(note || '').trim()}`.trim(), gift: false, interested: true, optout: false, manual: true };
  fs.appendFileSync(tl.REPLY_FILE, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/** Take an account off the list by hand (it comes back only with a newer interested reply or note). → the row. */
function remove({ id, name, why }) {
  const row = { at: new Date().toISOString(), accountId: require('./sfId').fix(id), accountName: name || null, why: why || null };
  fs.appendFileSync(REMOVED_FILE, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

module.exports = { build, list, ids, idOf, add, remove, NOTE_RE, REMOVED_FILE, k15 };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  if (argv.includes('--add') || argv.includes('--remove')) {
    const flag = argv.includes('--add') ? '--add' : '--remove', id = idOf(val(flag));
    if (!id) { console.log(`\n  ${flag} needs an account: a Salesforce account link (…/Account/001…/view) or its 001… id.\n`); process.exit(1); }
    if (flag === '--add') {
      if (!val('--note')) { console.log('\n  --add needs --note "what happened" (why it is a top hit).\n'); process.exit(1); }
      const row = add({ id, name: val('--name'), note: val('--note') });
      console.log(`\n  🎯 ${row.accountName} is on the top hit list: "${row.reply.replace(NOTE_RE, '')}"\n     It stays on the follow-up board. Take it off again: node topHit.js --remove ${row.accountId}\n`);
    } else {
      const row = remove({ id, name: val('--name'), why: val('--why') });
      console.log(`\n  ✅ ${row.accountId} is off the top hit list (a newer interested reply or note would put it back).\n`);
    }
  } else {
    let leads = []; try { const cad = require('./cadence'); leads = cad.members({ now: new Date() }); } catch (_) {}
    const { rows, hidden } = list({ leads });
    if (argv.includes('--json')) { console.log(JSON.stringify({ rows, hidden }, null, 2)); process.exit(0); }
    console.log(`\n  🎯 TOP HIT LIST — ${rows.length} account(s) (they all stay on the follow-up board; only a "not interested" reply takes a lead out)\n`);
    for (const r of rows) console.log(`   ${r.kind === 'note' ? '📝' : '👍'} ${r.name.slice(0, 44).padEnd(44)} ${String(r.at).slice(0, 10)}  ${r.text.slice(0, 90)}${r.n > 1 ? `  (+${r.n - 1} more interested)` : ''}`);
    if (hidden.length) console.log(`\n   left off: ${hidden.length} (${[...new Set(hidden.map((h) => h.why))].join(', ')})`);
    console.log('\n   Add one:  node topHit.js --add <account link> --note "what happened"     Take one off:  node topHit.js --remove <account link or id>\n');
  }
}
