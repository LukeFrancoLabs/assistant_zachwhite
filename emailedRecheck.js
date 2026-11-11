#!/usr/bin/env node
'use strict';

/**
 * emailedRecheck — look again at the accounts we EMAILED and read their Customer Status, READ-ONLY.
 *
 * The email run reads Customer Status (beta) off each account page before it emails, and refuses an "Enrolled" account (a current customer). A page that does
 * not show the field cannot be verified, and the run emails it anyway, saying "could not verify" on screen only. This opens every account we emailed, reads the
 * field with the SAME reader the run uses (emailAccount.js readCustomerStatus), looks a second time when it is missing, and saves what it finds in status-checks.jsonl:
 *
 *   ✅ verified      the field is there and the status is not "Enrolled" (blank, Canceled, Terminated…): nothing to do
 *   🆓              Enrolled, but only the free Invoicing and Payments plan: sellable, emailing it was right
 *   🤝 customer      Enrolled with a real Closed Won opportunity: WE EMAILED A CUSTOMER. It is held from now on (current-customers.jsonl, the 🤝 tab). A business coaching account counts here too (kept out of outreach since 2026-10-29, coachingPolicy.js) and is listed on the 🎓 tab instead
 *   ❓ no Closed Won  Enrolled with no Closed Won opportunity: held, the same rule as customerRecheck.js
 *   ⚠️  unverified    the field is still not on the page: this is the "could not verify" list
 *   (a page that did not open or could not be read is not saved: it is looked at again next time)
 *
 * It opens no composer, emails nothing and changes nothing in Salesforce: it only reads, and appends to status-checks.jsonl and current-customers.jsonl.
 * It uses the same own Chrome as customerRecheck.js (CDP 9334, profile .browser-profile-customers), so it never touches a text, email or Shark run, but
 * never run the two at once (one window); log into Salesforce once in it (this waits for you).
 *
 *   node emailedRecheck.js --inspect                                       who would be looked at (no browser, nothing read)
 *   node emailedRecheck.js --template curiosity --source LDS --limit 3     the first 3 only (try it first)
 *   node emailedRecheck.js --template curiosity --source LDS               every Curiosity email to an LDS lead since midnight
 *
 *   --since when    emails sent since: today (default), 24h, 3d, 2026-10-29 or 2026-10-29T13:07 (this Mac's time)
 *   --template t    only emails whose template name contains t (case does not matter)
 *   --source s      only leads from that list: LDS, Shark…
 *   --limit N       the first N only
 *   --again         look again at accounts already re-read since their email (a rerun otherwise carries on where it stopped)
 *   node statusChecks.js                                                   the tally, and who is still unverified
 */

const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 'https://housecallpro.lightning.force.com';
const ACCOUNT_LOAD_MS = 5000;
const SECOND_LOOK_MS = 8000;
const DEFAULT_PORT = 9334;
const { ENROLLED, ensureBrowser } = require('./customerRecheck');
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);

/** "today" (this Mac's midnight), "24h" / "3d" ago, or a date or date-time in this Mac's time → epoch ms; null when it is none of those. */
function parseSince(v, now = Date.now()) {
  const s = String(v == null ? 'today' : v).trim().toLowerCase();
  if (s === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  let m = s.match(/^(\d+(?:\.\d+)?)\s*([hd])$/);
  if (m) return now - parseFloat(m[1]) * (m[2] === 'h' ? 36e5 : 864e5);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [Y, M, D, h, mi, sec] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
  const d = new Date(Y, M - 1, D, h, mi, sec);
  return d.getMonth() === M - 1 && d.getDate() === D ? d.getTime() : null;             // 2026-13-45 is not a date
}

/** The accounts we emailed since `since`: one row per account (its newest email in the window), in the order they were emailed. */
function emailedRows(textLog, { since = 0, template = '', source = '' } = {}) {
  const tpl = String(template || '').trim().toLowerCase(), src = String(source || '').trim().toLowerCase();
  const by = new Map();
  for (const r of textLog.readAll()) {
    if (!r || r.channel !== 'email' || !r.accountId) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < since) continue;
    if (tpl && !String(r.templateName || '').toLowerCase().includes(tpl)) continue;
    if (src && String((r.source && r.source.kind) || '').toLowerCase() !== src) continue;
    by.set(k15(r.accountId), r);
  }
  return [...by.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Leave out the accounts already re-read AFTER their email, so a rerun carries on where it stopped (`again` keeps them). `checks` = statusChecks.latest(). */
function notYetChecked(rows, checks, { again = false } = {}) {
  if (again) return rows;
  return rows.filter((r) => { const c = checks.get(k15(r.accountId)); return !(c && c.via === 'recheck' && Date.parse(c.at) >= Date.parse(r.at)); });
}

/**
 * One emailed account → { outcome, status, why }. outcome: 'verified' | 'free-plan' | 'coaching' | 'customer' | 'noopp' | 'unverified' | 'unread'.
 * `deps` = { sleep, readStatus, checkAccount, record, note } (tests pass fakes): readStatus is the email run's own reader → { found, value };
 * record saves a customer (current-customers.jsonl), note saves the read (status-checks.jsonl). Nothing is saved for 'unread'.
 */
async function checkOne(page, row, deps) {
  const url = row.accountUrl || `${ORIGIN}/lightning/r/Account/${row.accountId}/view`;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { return { outcome: 'unread', why: `the account page did not open (${String(e.message).split('\n')[0]})` }; }
  await deps.sleep(ACCOUNT_LOAD_MS);
  let st = null, err = null;
  for (let look = 0; look < 2; look++) {                                              // the run's reader gives up after about ten seconds: look once more before calling a page unverifiable
    if (look) await deps.sleep(SECOND_LOOK_MS);
    try { st = await deps.readStatus(page); err = null; } catch (e) { st = null; err = e; }
    if (st && st.found) break;
  }
  if (!st && err) return { outcome: 'unread', why: `the page could not be read (${String(err.message).split('\n')[0]})` };
  const base = { accountId: row.accountId, accountName: row.accountName, accountUrl: row.accountUrl || url, source: row.source || null };
  if (!st || !st.found) {
    deps.note({ via: 'recheck', ...base, found: false, outcome: 'unverified', why: 'Customer Status (beta) is not on the page' });
    return { outcome: 'unverified', why: 'Customer Status (beta) is not on the page, even on a second look' };
  }
  const status = st.value || '';
  if (!ENROLLED.test(status)) {
    deps.note({ via: 'recheck', ...base, found: true, value: status, outcome: 'verified' });
    return { outcome: 'verified', status: status || '(blank)', why: `Customer Status is ${status ? `"${status}"` : 'blank'}` };
  }
  const plan = await deps.checkAccount(page, { accountId: row.accountId });
  if (plan.retry) return { outcome: 'unread', status, why: plan.why };
  deps.record({ ...base, status, ...(plan.record || {}) });                           // a customer we emailed is held from now on
  const outcome = plan.verdict === 'free-plan' ? 'free-plan' : plan.verdict === 'coaching' && !require('./coachingPolicy').held() ? 'coaching' : (plan.closedWon && plan.closedWon.length ? 'customer' : 'noopp');   // business coaching is kept out of outreach: an emailed coaching account is reported with the "customers we emailed" (it is listed on the 🎓 tab, not as a customer)
  deps.note({ via: 'recheck', ...base, found: true, value: status, outcome, why: plan.why });
  return { outcome, status, why: plan.why };
}

const ICON = { verified: '✅', 'free-plan': '🆓', coaching: '🎓', customer: '🤝', noopp: '❓', unverified: '⚠️ ', unread: '⏳' };
/** Every row in turn; stops after `maxUnread` unreadable accounts in a row (Salesforce logged out, window closed). → { counts, found: { customer, noopp, unverified } (names), stopped } */
async function checkAll(page, rows, deps, { delayMs = 2000, maxUnread = 5, log = console.log } = {}) {
  const counts = { verified: 0, 'free-plan': 0, coaching: 0, customer: 0, noopp: 0, unverified: 0, unread: 0 };
  const found = { customer: [], noopp: [], unverified: [] };
  let streak = 0, stopped = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let r;
    try { r = await checkOne(page, row, deps); } catch (e) { r = { outcome: 'unread', why: `failed: ${String(e.message).split('\n')[0]}` }; }
    counts[r.outcome]++;
    if (found[r.outcome]) found[r.outcome].push(row.accountName || row.accountId);
    log(`  ${String(i + 1).padStart(3)}/${rows.length}  ${ICON[r.outcome]} ${(row.accountName || row.accountId).slice(0, 38).padEnd(38)} ${r.outcome === 'unread' ? 'not read — ' : ''}${r.why || ''}`);
    streak = r.outcome === 'unread' ? streak + 1 : 0;
    if (streak >= maxUnread) { stopped = `${maxUnread} accounts in a row could not be read (logged out of Salesforce, or the window was closed?). Everything before them is saved.`; break; }
    if (i < rows.length - 1) await deps.sleep(delayMs);
  }
  return { counts, found, stopped };
}

/** Our own Chrome, logged into Salesforce (the same steps as customerRecheck.js). → the page. */
async function openSalesforcePage(port, log = console.log) {
  const fresh = await ensureBrowser(port);
  log(`\n  🟢 Chrome ${fresh ? 'started' : 'already up'} on port ${port}.`);
  const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`${ORIGIN}/lightning/page/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  let warned = false;
  for (let i = 0; i < 200; i++) {                                                     // up to ~10 minutes to log in
    const u = page.url() || '';
    if (/lightning\.force\.com\/lightning\//.test(u) && !/login/i.test(u)) return { page, browser };
    if (!warned) { log('  🔐 Log into Salesforce in the Chrome window that is open (this carries on by itself once you are in)…'); warned = true; }
    await sleep(3000);
  }
  await browser.close();
  throw new Error('not logged into Salesforce after 10 minutes; nothing was read');
}

/** The comment block at the top of this file, as the --help text. */
const helpText = () => require('fs').readFileSync(__filename, 'utf8').match(/\/\*\*\n([\s\S]*?)\n \*\//)[1].split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n');

const parse = (argv) => {
  const a = { inspect: false, again: false, limit: null, since: 'today', template: '', source: '' };
  const value = (i, flag) => { if (argv[i] === undefined || /^--/.test(argv[i])) { console.error(`${flag} needs a value  (try --help)`); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--inspect') a.inspect = true;
    else if (f === '--again') a.again = true;
    else if (f === '--limit') { const n = Number(value(++i, f)); if (!Number.isInteger(n) || n < 1) { console.error('--limit needs a whole number of 1 or more'); process.exit(2); } a.limit = n; }
    else if (f === '--since') a.since = value(++i, f);
    else if (f === '--template') a.template = value(++i, f);
    else if (f === '--source') a.source = value(++i, f);
    else if (f === '--help' || f === '-h') a.help = true;
    else { console.error(`unknown option ${f}  (try --help)`); process.exit(2); }
  }
  if (parseSince(a.since) === null) { console.error(`--since ${a.since}: write today, 24h, 3d, 2026-10-29 or 2026-10-29T13:07`); process.exit(2); }
  return a;
};

module.exports = { parseSince, emailedRows, notYetChecked, checkOne, checkAll, parse, ICON };

if (require.main === module) {
  (async () => {
    const args = parse(process.argv.slice(2));
    if (args.help) { console.log(helpText()); return; }
    const textLog = require('./textLog'), statusChecks = require('./statusChecks');
    const since = parseSince(args.since);
    const emailed = emailedRows(textLog, { since, template: args.template, source: args.source });
    const checks = statusChecks.latest();
    const pending = notYetChecked(emailed, checks), todo = notYetChecked(emailed, checks, { again: args.again }).slice(0, args.limit || Infinity);
    const filters = `${args.template ? ` · template "${args.template}"` : ''}${args.source ? ` · ${args.source} leads` : ''}`;
    console.log(`\n📧 Emailed since ${new Date(since).toLocaleString()}${filters}: ${emailed.length} account${emailed.length === 1 ? '' : 's'}  (${emailed.length - pending.length} already re-read since their email, ${pending.length} not yet)`);
    console.log(`   This run would look at ${todo.length}${args.again ? ' (--again)' : ''}${args.limit ? ` (--limit ${args.limit})` : ''}:\n`);
    todo.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${(r.accountName || r.accountId).slice(0, 40).padEnd(40)} ${new Date(r.at).toLocaleTimeString().padEnd(12)} ${String((r.source && r.source.kind) || '').padEnd(6)} ${String(r.templateName || '').slice(0, 30)}`));
    if (todo.length > 15) console.log(`       … and ${todo.length - 15} more`);
    if (args.inspect || !todo.length) { console.log(`\n  ${args.inspect ? '--inspect: no browser was opened, nothing was read.' : 'Nothing to look at.'}${todo.length ? `  About ${Math.ceil(todo.length * 10 / 60)} minutes for these.  Next:  node emailedRecheck.js${args.template ? ` --template ${args.template}` : ''}${args.source ? ` --source ${args.source}` : ''}${args.since !== 'today' ? ` --since ${args.since}` : ''} --limit 3` : ''}\n`); return; }

    const { page, browser } = await openSalesforcePage(parseInt(process.env.RECHECK_CDP_PORT, 10) || DEFAULT_PORT);
    console.log(`  🔎 Looking at ${todo.length} account${todo.length === 1 ? '' : 's'} (read-only: no composer, nothing sent)\n`);
    const deps = { sleep, readStatus: (p) => require('./emailAccount').readCustomerStatus(p), checkAccount: require('./customerPlan').checkAccount, record: (r) => textLog.recordCurrentCustomer(r), note: (r) => statusChecks.record(r) };
    const { counts, found, stopped } = await checkAll(page, todo, deps);
    console.log(`\n  Done: ${counts.verified} ✅ verified · ${counts['free-plan'] + counts.coaching} 🆓 free plan / coaching · ${counts.customer} 🤝 customer${counts.customer === 1 ? '' : 's'} we emailed · ${counts.noopp} ❓ Enrolled with no Closed Won · ${counts.unverified} ⚠️  could not verify${counts.unread ? ` · ${counts.unread} ⏳ not read (looked at again next time)` : ''}`);
    if (found.customer.length) console.log(`  🤝 Customers we emailed, now held: ${found.customer.join(', ')}`);
    if (found.noopp.length) console.log(`  ❓ Enrolled with no Closed Won, now held: ${found.noopp.join(', ')}`);
    if (found.unverified.length) console.log(`  ⚠️  Could not verify: ${found.unverified.join(', ')}`);
    if (stopped) console.log(`  ⛔ Stopped early: ${stopped}`);
    console.log('  Saved in status-checks.jsonl.  The tally any time:  node statusChecks.js');
    try { console.log(`  📊 Dashboard refreshed: ${textLog.generateDashboard()}  (the 🤝 Current customers tab has the evidence for each customer)`); } catch (_) {}
    console.log('');
    await browser.close();                                                            // disconnects; the Chrome stays up (and logged in) for the next time
  })().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
}
