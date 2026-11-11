'use strict';

/**
 * customerRelease — accounts Luke released BY HAND from the current-customer hold (2026-10-30: "that one is a cancellation").
 *
 * Salesforce can still show such an account as "Enrolled: Current Customer" with a real Closed Won opportunity, so the plan check (customerPlan.checkAccount) would hold it again at every look and nothing
 * would ever text it. A listed account comes back from that check as verdict 'free-plan' with `released: true` (nothing is read from the page): the verdict every path already treats as "not a customer, outreach
 * as usual". Releasing one ALSO writes its current-customers.jsonl row now ('free-plan', why "released by hand …"), so the held list lets it go at once and a later look cannot hold it again.
 * The board still runs its Closed Won scrub on a released lead (enrollCheck.js), like on any other. It is a decision about ONE account, not a rule: nothing else changes.
 * (A released account also shows on the dashboard's 🆓 tab, the list of Enrolled accounts that are ours to sell, with its reason.)
 *
 *   node customerRelease.js                                the list
 *   node customerRelease.js --add <accountId|link> [--why "…"] [--name "…"]     release one
 *   node customerRelease.js --remove <accountId|link>      hold it again
 * File: released-customers.json, [{ accountId, accountName, at, by, why }].
 */

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'released-customers.json');
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);

/** The list. A missing or unreadable file is an empty list. */
function readAll(file = FILE) {
  try { const list = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(list) ? list.filter((e) => e && e.accountId) : []; } catch (_) { return []; }
}
/** The entry for this account (either spelling of its id), or null. */
function find(accountId, file = FILE) {
  const k = k15(accountId);
  return k ? readAll(file).find((e) => k15(e.accountId) === k) || null : null;
}
const save = (list, file) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n'); fs.renameSync(tmp, file); };      // atomic: a reader never sees half a file

/**
 * Release one account. `rows()` → textLog.readCustomerRows() (the held rows), `record(row)` → textLog.recordCurrentCustomer: both are passed in by a test. Only an account that IS on the held list has a row to supersede.
 * → { entry, row }   (`row` = the 'free-plan' row written, or null when the account was not held)
 */
function add({ accountId, accountName, accountUrl, why, by = require('./sender').firstName || 'me', now = new Date() }, { file = FILE, rows, record } = {}) {
  if (!k15(accountId)) throw new Error('no account id');
  const day = now.toISOString().slice(0, 10);
  const entry = { accountId, accountName: accountName || null, at: now.toISOString(), by, why: String(why || 'not a current customer').trim() };
  save([...readAll(file).filter((e) => k15(e.accountId) !== k15(accountId)), entry], file);
  const held = (rows || (() => require('./textLog').readCustomerRows()))();
  const cur = held.get(String(accountId).toLowerCase()) || held.get(k15(accountId));
  const row = cur ? (record || ((r) => require('./textLog').recordCurrentCustomer(r)))({
    accountId: cur.accountId, accountName: cur.accountName || accountName, accountUrl: cur.accountUrl || accountUrl, status: cur.status,
    source: { kind: 'Hand release', name: 'customerRelease.js' }, verdict: 'free-plan', why: `released by hand (${by}, ${day}): ${entry.why}`, closedWon: cur.closedWon, subs: cur.subs, legacy: cur.legacy, checkedAt: now.toISOString(),
  }) : null;
  return { entry, row };
}

/** Hold it again: off the list, and its row goes back to 'customer' at once. → { removed, row } */
function remove(accountId, { file = FILE, rows, record, now = new Date() } = {}) {
  const list = readAll(file), keep = list.filter((e) => k15(e.accountId) !== k15(accountId));
  if (keep.length === list.length) return { removed: false, row: null };
  save(keep, file);
  const held = (rows || (() => require('./textLog').readCustomerRows()))();
  const cur = held.get(String(accountId).toLowerCase()) || held.get(k15(accountId));
  const row = cur ? (record || ((r) => require('./textLog').recordCurrentCustomer(r)))({
    accountId: cur.accountId, accountName: cur.accountName, accountUrl: cur.accountUrl, status: cur.status, source: { kind: 'Hand release', name: 'customerRelease.js' },
    verdict: 'customer', why: `hand release removed (${now.toISOString().slice(0, 10)}): held as a current customer again`, closedWon: cur.closedWon, subs: cur.subs, legacy: cur.legacy, checkedAt: now.toISOString(),
  }) : null;
  return { removed: true, row };
}

module.exports = { FILE, readAll, find, add, remove };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const idOf = (a) => (String(a || '').match(/\/Account\/([A-Za-z0-9]{15,18})/) || String(a || '').match(/^([A-Za-z0-9]{15,18})$/) || [])[1];
  const held = () => { try { return require('./textLog').readCustomerRows(); } catch (_) { return new Map(); } };
  const nameOf = (id) => { const r = held().get(String(id).toLowerCase()) || held().get(k15(id)); return r && r.accountName; };
  const act = argv.includes('--add') ? '--add' : argv.includes('--remove') ? '--remove' : null;
  if (act) {
    const id = idOf(opt(act));
    if (!id) { console.log(`\n  ${act} takes an account id or an account link, for example:  node customerRelease.js ${act} 001PD000005Hf5cYAC\n`); process.exit(2); }
    if (act === '--add') {
      const r = add({ accountId: id, accountName: opt('--name') || nameOf(id), why: opt('--why') });
      console.log(`\n  Released by hand: ${r.entry.accountName || id}\n     ${r.entry.why}\n     ${r.row ? 'Its current-customers row now says free-plan, so the held list lets it go at once.' : 'It was not on the held list; the list entry makes any later look release it too.'}\n     Every path now treats it as a lead (the board still checks its opportunities). Hold it again with:  node customerRelease.js --remove ${id}\n`);
    } else {
      const r = remove(id);
      console.log(r.removed ? `\n  Held again: ${nameOf(id) || id}${r.row ? ' (its current-customers row is back to customer)' : ''}\n` : `\n  ${id} was not on the released list.\n`);
    }
  } else {
    const list = readAll();
    console.log(`\n  Released by hand: ${list.length}\n`);
    list.forEach((e) => console.log(`   · ${e.accountName || '(no name)'}  ${e.accountId}  ${String(e.at).slice(0, 10)}  ${e.by}: ${e.why}`));
    console.log('\n  Release one:  node customerRelease.js --add <accountId|link> --why "a cancellation"\n');
  }
}
