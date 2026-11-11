'use strict';

/**
 * statusChecks — the Customer Status (beta) reads that did not give an answer, and the re-reads that followed (status-checks.jsonl, append-only).
 *
 * The email run reads Customer Status off each account page before it writes the email. A page that does not show the field cannot be verified, and the run
 * emails it anyway (only an account already held as a customer is refused then), saying so on screen alone. This writes each of those accounts down:
 *
 *   via "send"     the email run could not read the status (emailed: false for a dry run)
 *   via "recheck"  emailedRecheck.js opened the account afterwards: outcome verified | free-plan | coaching | customer | noopp | unverified
 *
 * An account is UNVERIFIED while its newest row says found:false; a later read that does find the field takes it off the list.
 *
 *   node statusChecks.js            the tally, and who is still unverified
 *   node statusChecks.js --json     the same as JSON
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'status-checks.jsonl');
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);

/** Append one read. → the row (null without an account id). `file` is for tests. */
function record(o, file = FILE) {
  if (!o || !o.accountId) return null;
  const src = o.source && typeof o.source === 'object' ? { kind: o.source.kind || null, name: o.source.name || null } : null;
  const row = {
    at: new Date().toISOString(), via: o.via === 'recheck' ? 'recheck' : 'send',
    accountId: o.accountId, accountName: o.accountName || null, accountUrl: o.accountUrl || null, source: src,
    found: o.found === true, value: o.found === true && o.value != null ? String(o.value) : null,
  };
  if (o.outcome) row.outcome = o.outcome;
  if (o.emailed != null) row.emailed = !!o.emailed;
  if (o.why) row.why = String(o.why).slice(0, 300);
  try { fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8'); } catch (_) {}
  return row;
}

/** Every row, oldest first; a line that is not JSON is skipped. */
function readAll(file = FILE) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((r) => r && r.accountId);
}

/** The newest row of every account, by its 15-character id. */
function latest(rows = readAll()) {
  const m = new Map();
  for (const r of rows) m.set(k15(r.accountId), r);
  return m;
}

/** The accounts whose newest read found no Customer Status field. */
function unverified(rows = readAll()) {
  return [...latest(rows).values()].filter((r) => r.found === false);
}

/** The tally the CLI prints: what the run could not verify, and what the re-reads found since. */
function summary(rows = readAll()) {
  const sent = latest(rows.filter((r) => r.via === 'send'));
  const re = [...latest(rows.filter((r) => r.via === 'recheck')).values()];
  const n = (outcome) => re.filter((r) => r.outcome === outcome);
  return {
    runCouldNotVerify: sent.size, runEmailedAnyway: [...sent.values()].filter((r) => r.emailed).length,
    reread: re.length, verified: n('verified').length, freePlan: n('free-plan').length + n('coaching').length,
    customers: n('customer'), noOpp: n('noopp'), unverified: unverified(rows),
  };
}

module.exports = { FILE, record, readAll, latest, unverified, summary };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*\n([\s\S]*?)\n \*\//)[1].split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n')); process.exit(0); }
  const bad = args.filter((a) => a !== '--json');
  if (bad.length) { console.error(`unknown option ${bad[0]}  (try --help)`); process.exit(2); }
  const s = summary();
  if (args.includes('--json')) { console.log(JSON.stringify({ ...s, customers: s.customers.map((r) => r.accountName), noOpp: s.noOpp.map((r) => r.accountName), unverified: s.unverified.map((r) => ({ accountId: r.accountId, accountName: r.accountName, via: r.via, emailed: r.emailed ?? null, at: r.at })) }, null, 1)); process.exit(0); }
  const names = (rows, max = 25) => rows.slice(0, max).map((r) => `     · ${r.accountName || r.accountId}${r.via === 'send' ? (r.emailed === false ? '  (dry run)' : '  (the run emailed it)') : ''}`).join('\n') + (rows.length > max ? `\n     … and ${rows.length - max} more` : '');
  console.log('\nCustomer Status reads with no answer (status-checks.jsonl)');
  console.log(`  The email run could not verify : ${s.runCouldNotVerify} account${s.runCouldNotVerify === 1 ? '' : 's'}  (${s.runEmailedAnyway} emailed anyway)`);
  console.log(`  Re-read by emailedRecheck.js   : ${s.reread} account${s.reread === 1 ? '' : 's'}  → ${s.verified} verified · ${s.freePlan} free plan / coaching · ${s.customers.length} 🤝 customer${s.customers.length === 1 ? '' : 's'} we emailed · ${s.noOpp.length} Enrolled with no Closed Won · ${s.unverified.filter((r) => r.via === 'recheck').length} still unverified`);
  if (s.customers.length) console.log(`\n  🤝 Customers we emailed (${s.customers.length}):\n${names(s.customers)}`);
  console.log(`\n  ⚠️  Unverified now (${s.unverified.length}):${s.unverified.length ? `\n${names(s.unverified)}` : '  none'}`);
  if (!s.runCouldNotVerify && !s.reread) console.log('\n  Nothing recorded yet. Runs write here from now on; for emails already sent: node emailedRecheck.js --inspect\n');
  else console.log('');
}
