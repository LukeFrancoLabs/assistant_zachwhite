#!/usr/bin/env node
'use strict';

/**
 * customerRecheck — look again at every account held as a current customer, READ-ONLY.
 *
 * Before the free-plan check existed, an email run held EVERY account whose Customer Status (beta) starts with "Enrolled", and the free Invoicing and Payments
 * sign-up is "Enrolled" too. Those accounts sit in current-customers.jsonl with no verdict (the dashboard's 🤝 tab marks them ⏳) and an ordinary email run only
 * reaches them when its report happens to list them again. This opens each one now, reads the page and saves the verdict:
 *
 *   Customer Status no longer starts with "Enrolled"                     → saved as that status: no longer held
 *   every Closed Won opportunity is Invoicing and Payments               → 🆓 free plan: released, outreach treats it like any other lead
 *   every Closed Won is Invoicing and Payments or business coaching      → 🎓 business coaching: kept out of outreach, NOT shown as a customer (the Business Coaching tab, coachingPolicy.js)
 *   a Closed Won opportunity that is not Invoicing and Payments          → 🤝 real customer: stays held, with what was read (customerPlan.js has the rule)
 *   Enrolled with no Closed Won opportunity at all                       → stays held, saved with that reason
 *   a page or list that could not be read                                → nothing saved, it stays ⏳ and is looked at again next time
 *
 * It opens no composer, texts nothing, emails nothing and changes nothing in Salesforce: it only reads, and appends to current-customers.jsonl.
 * It has its OWN Chrome (CDP 9334, profile .browser-profile-customers), so it never touches a text, email or Shark run; log into Salesforce once in that
 * window (it waits for you) and the profile remembers it.
 *
 *   node customerRecheck.js --inspect          who would be looked at (no browser, nothing read)
 *   node customerRecheck.js --limit 3          the first 3 only (try it first)
 *   node customerRecheck.js                    every held account that has no verdict yet
 *   node customerRecheck.js --all              every held account, even one already checked (a changed opportunity, a changed rule)
 */

const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 'https://housecallpro.lightning.force.com';
const ACCOUNT_LOAD_MS = 5000;
const DEFAULT_PORT = 9334;
const PROFILE = '.browser-profile-customers';
const RESERVED = { 9222: 'pipeliner', 9323: 'email text', 9324: 'email --email', 9325: 'email re-engage', 9326: 'email --shark', 9327: '--industry', 9328: '--zones', 9329: '--holds', 9330: '--evening', 9331: '--same-day', 9332: '--teammate-texted', 9333: 'the overnight run', 9335: 'xref browser', 9336: '--board', 9333: 'sf-email-bot' };
const ENROLLED = /^\s*enrolled\b/i;

/** The held accounts to look at: the newest Enrolled row of each account, those with no verdict yet (all of them with `all`). A `recentWin` row (held for a Closed Won, not for Customer Status) is left alone: this look only reads Customer Status, and would release it. */
function heldRows(textLog, { all = false } = {}) {
  const rows = [...new Set(textLog.readCustomerRows().values())].filter((r) => !r.recentWin && (all || !r.verdict));
  return rows.sort((a, b) => String(a.accountName || '').localeCompare(String(b.accountName || '')));
}
const srcName = (s) => (s && typeof s === 'object' ? (s.name || s.kind || '') : (s || ''));

/**
 * One account → { outcome, status, why }. outcome: 'released' | 'customer' | 'noopp' | 'not-enrolled' | 'unread'.
 * `deps` = { readOverview, checkAccount, record } (tests pass fakes). Saves the verdict through deps.record, except for 'unread'.
 */
async function recheckOne(page, row, deps) {
  const url = row.accountUrl || `${ORIGIN}/lightning/r/Account/${row.accountId}/view`;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { return { outcome: 'unread', why: `the account page did not open (${String(e.message).split('\n')[0]})` }; }
  await deps.sleep(ACCOUNT_LOAD_MS);
  let ov;
  try { ov = await deps.readOverview(page); } catch (e) { return { outcome: 'unread', why: `the page could not be read (${String(e.message).split('\n')[0]})` }; }
  const status = ov && ov.found ? ov.get(/^customer status/) : null;
  if (status === null || status === undefined) return { outcome: 'unread', why: 'Customer Status (beta) was not on the page' };
  const base = { accountId: row.accountId, accountName: row.accountName, accountUrl: row.accountUrl || url, source: row.source };
  if (!ENROLLED.test(status)) {
    deps.record({ ...base, status: status || '(blank)' });                  // no longer a customer: this newest row stops the hold
    return { outcome: 'not-enrolled', status: status || '(blank)', why: `Customer Status is now "${status || '(blank)'}"` };
  }
  const plan = await deps.checkAccount(page, { accountId: row.accountId });
  if (plan.retry) return { outcome: 'unread', status, why: plan.why };
  deps.record({ ...base, status, ...(plan.record || {}) });
  if (plan.verdict === 'free-plan') return { outcome: 'released', status, why: plan.why };
  if (plan.verdict === 'coaching') return { outcome: 'coaching', status, why: plan.why };
  return { outcome: plan.closedWon && plan.closedWon.length ? 'customer' : 'noopp', status, why: plan.why };
}

const ICON = { released: '🆓', coaching: '🎓', customer: '🤝', noopp: '❓', 'not-enrolled': '✅', unread: '⚠️ ' };
/** Every row in turn; stops after `maxUnread` unreadable accounts in a row (Salesforce logged out, window closed). → { counts, stopped } */
async function recheckAll(page, rows, deps, { delayMs = 2000, maxUnread = 5, log = console.log } = {}) {
  const counts = { released: 0, coaching: 0, customer: 0, noopp: 0, 'not-enrolled': 0, unread: 0 };
  let streak = 0, stopped = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let r;
    try { r = await recheckOne(page, row, deps); } catch (e) { r = { outcome: 'unread', why: `failed: ${String(e.message).split('\n')[0]}` }; }
    counts[r.outcome]++;
    log(`  ${String(i + 1).padStart(3)}/${rows.length}  ${ICON[r.outcome]} ${(row.accountName || row.accountId).slice(0, 38).padEnd(38)} ${r.outcome === 'unread' ? 'not read — ' : ''}${r.why || ''}`);
    streak = r.outcome === 'unread' ? streak + 1 : 0;
    if (streak >= maxUnread) { stopped = `${maxUnread} accounts in a row could not be read (logged out of Salesforce, or the window was closed?). Everything before them is saved.`; break; }
    if (i < rows.length - 1) await deps.sleep(delayMs);
  }
  return { counts, stopped };
}

const up = (port) => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (m) => { m.resume(); res(true); });
  r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
});

/** Our own Chrome: reused when it is already up, otherwise started the way run.sh starts the others (start-browser.js, own port + profile). */
async function ensureBrowser(port) {
  if (RESERVED[port]) throw new Error(`port ${port} belongs to ${RESERVED[port]}; refusing to touch it`);
  if (await up(port)) return false;
  const { spawn } = require('child_process');
  spawn(process.execPath, [path.join(__dirname, 'start-browser.js')], { cwd: __dirname, env: { ...process.env, CDP_PORT: String(port), PROFILE_DIR: PROFILE }, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40 && !(await up(port)); i++) await sleep(1000);
  if (!(await up(port))) throw new Error(`the browser did not start on port ${port}`);
  await sleep(2000);
  return true;
}

const parse = (argv) => {
  const a = { inspect: false, all: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inspect') a.inspect = true;
    else if (argv[i] === '--all') a.all = true;
    else if (argv[i] === '--limit') a.limit = Math.max(1, parseInt(argv[++i], 10) || 0) || null;
    else if (argv[i] === '--help' || argv[i] === '-h') a.help = true;
    else { console.error(`unknown option ${argv[i]}  (try --help)`); process.exit(2); }
  }
  return a;
};

module.exports = { heldRows, recheckOne, recheckAll, ensureBrowser, ENROLLED };

if (require.main === module) {
  (async () => {
    const args = parse(process.argv.slice(2));
    if (args.help) { console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 33).map((l) => l.replace(/^ \* ?/, '')).join('\n')); return; }
    const textLog = require('./textLog');
    const all = heldRows(textLog, { all: true }), todo = heldRows(textLog, { all: args.all }).slice(0, args.limit || Infinity);
    const verified = all.filter((r) => r.verdict).length;
    console.log(`\n🤝 Held as current customers: ${all.length}  (${all.length - verified} with no verdict yet, ${verified} already checked${all.filter((r) => r.verdict === 'free-plan').length ? `, ${all.filter((r) => r.verdict === 'free-plan').length} released as free plan` : ''})`);
    console.log(`   This run would look at ${todo.length}${args.all ? ' (--all)' : ''}${args.limit ? ` (--limit ${args.limit})` : ''}:\n`);
    todo.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${(r.accountName || r.accountId).slice(0, 40).padEnd(40)} ${String(r.status || '').padEnd(30)} ${srcName(r.source)}`));
    if (todo.length > 15) console.log(`       … and ${todo.length - 15} more`);
    if (args.inspect || !todo.length) { console.log(`\n  ${args.inspect ? '--inspect: no browser was opened, nothing was read.' : 'Nothing to look at.'}  Next:  node customerRecheck.js --limit 3\n`); return; }

    const port = parseInt(process.env.RECHECK_CDP_PORT, 10) || DEFAULT_PORT;
    const fresh = await ensureBrowser(port);
    console.log(`\n  🟢 Chrome ${fresh ? 'started' : 'already up'} on port ${port} (profile ${PROFILE}).`);
    const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${ORIGIN}/lightning/page/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    let warned = false;
    for (let i = 0; i < 200; i++) {                                                       // up to ~10 minutes to log in
      const u = page.url() || '';
      if (/lightning\.force\.com\/lightning\//.test(u) && !/login/i.test(u)) break;
      if (!warned) { console.log('  🔐 Log into Salesforce in the Chrome window that is open (this carries on by itself once you are in)…'); warned = true; }
      await sleep(3000);
      if (i === 199) { console.log('  ⛔ Not logged in after 10 minutes. Nothing was read.'); await browser.close(); process.exit(1); }
    }
    console.log(`  🔎 Looking at ${todo.length} account${todo.length === 1 ? '' : 's'} (read-only: no composer, nothing sent)\n`);
    const { readOverview } = require('./accountOverview'), { checkAccount } = require('./customerPlan');
    const deps = { sleep, readOverview: (p) => readOverview(p), checkAccount, record: (r) => textLog.recordCurrentCustomer(r) };
    const { counts, stopped } = await recheckAll(page, todo, deps);
    console.log(`\n  Done: ${counts.released} 🆓 free plan released · ${counts.coaching} 🎓 business coaching (${require('./coachingPolicy').held() ? 'kept out, on the Business Coaching tab' : 'released'}) · ${counts.customer} 🤝 real customer${counts.customer === 1 ? '' : 's'} · ${counts.noopp} ❓ Enrolled with no Closed Won opportunity · ${counts['not-enrolled']} ✅ no longer Enrolled · ${counts.unread} ⚠️  not read (still ⏳)`);
    if (stopped) console.log(`  ⛔ Stopped early: ${stopped}`);
    try { console.log(`  📊 Dashboard refreshed: ${textLog.generateDashboard()}  (the 🤝 Current customers tab has the evidence for each one)`); } catch (_) {}
    console.log('');
    await browser.close();                                                                // disconnects; the Chrome stays up (and logged in) for the next time
  })().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
}
