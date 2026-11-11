'use strict';

/**
 * enrollCheck — the follow-up board's per-account check, run right before EACH text (runReportCampaign's `precheck` hook): "has this lead enrolled, or been closed by another rep, since we last looked?"
 * It applies the rule the email run applies on every email (emailAccount.js): open the account, read "Customer Status (beta)". "Enrolled…" is a current customer (Current Customer,
 * Cancel Requested, Under Review…) unless its Closed Won opportunities are only the free Invoicing and Payments plan (customerPlan.js); business coaching stays out while coachingPolicy.js
 * says so. A customer is NOT texted and is saved as one (current-customers.jsonl), so it leaves the board; Canceled / Terminated / blank / "-" are still leads. A page that does not show
 * the field is "could not verify": the text still goes, as the email run does, and the account is written down in status-checks.jsonl. Anything else that goes wrong (the page will not
 * load, the status cannot be read) skips THIS text only: nothing is sent, and the board tries the lead again later.
 *
 * A lead by Customer Status (not enrolled, or the field is not on the page) then has its OPPORTUNITIES read, off the account page it is already on (the "Opportunities (n)" card, accountOpportunities.js: no trip to
 * the Opportunities tab), with the review `--followup --check` uses (salesforceReview.reviewAccount, opportunities only). A Closed Won in the last 30 days (closedWonWindow.js), any rep (the free Invoicing and Payments sign-up
 * excepted), means another rep may have closed the account: it is NOT texted, goes on the Current customers tab with that opportunity's name (a held current-customers.jsonl row marked `recentWin`, whatever Customer Status says: Luke, 2026-11-03) and on
 * the closed-won list (so it leaves the board), and the review is saved. Opportunities that cannot be read skip THIS text only, like
 * the other failures. An enrolled account is not read twice: the plan check above has already looked at its Closed Won opportunities (one Luke released by hand, customerRelease.js, is the exception: that check read nothing, so it is checked like any other lead).
 *
 * Off with `email --board --nocheck`. Everything it touches is passed in, so a test runs it on a fake page.
 * `opportunities: false` (the --auto pipeline, autoDraft.js) stops the check at Customer Status and the plan check of an Enrolled account: that pipeline reads the opportunities itself
 * (salesforceReview.buildEvidence). The answer then also says `customer: true` for a current customer, and `status` (what Customer Status said) where it was read.
 * Also with it: `assumeOpen: true` = the caller has just loaded this account on getPage() (textAccount: the text's own page load is the look), so it is read as it is, with no second load; a known customer
 * on the held list whose status cannot be read now stays held (`held(accountId)`, default textLog.readCurrentCustomers, as the email run does); `moved: true` in the answer = the plan check left the page on an
 * opportunity, so a caller that goes on with this account loads it again.
 */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const { WON_FLAG_DAYS } = require('./closedWonWindow');      // the Closed Won window (30 days): one switch, shared with the review
const ACCOUNT_ID = /\/Account\/([A-Za-z0-9]{15,18})/;
/** Is `page` on this account's own page (not its Opportunities tab, an opportunity, or anywhere else)? */
function onAccount(page, accountId) {
  try {
    const u = String(page.url()), id = (u.match(ACCOUNT_ID) || [])[1];
    return !!id && !!accountId && id.slice(0, 15).toLowerCase() === String(accountId).slice(0, 15).toLowerCase() && !/\/related\//.test(u);
  } catch (_) { return false; }
}

/**
 * deps = { getPage() → the board's current page, accountLoadMs, startUrl, log(icon, action, detail), sleep(ms),
 *          readStatus(page) → { found, value }, checkPlan(page, accountId) → { verdict, why, record, … }, saveCustomer(row), saveUnverified(row), coachingHeld(),
 *          readOpportunities(page, accountId) → { ok, opps } (default: accountOpportunities.makeReader), review(page, { accountId, name, firstAt }) → salesforceReview.reviewAccount's record, saveReview(record), saveClosedWon(row) }
 * → async (lead) => { ok: true, unverified?, released?, opened } | { ok: false, reason }      lead = { name, accountId, url, source }
 *   opened = { page, url, at } when the check left `page` freshly loaded on the account (null if that load did not finish): the text that follows uses that page as it is (Assistant.js textAccount, first try only)
 *   instead of loading the same account a second time.
 */
function makeCheck(deps = {}) {
  const log = deps.log || (() => {}), sleep = deps.sleep || sleepMs;
  const readStatus = deps.readStatus || ((page) => require('./emailAccount').readCustomerStatus(page));
  const checkPlan = deps.checkPlan || ((page, accountId) => require('./customerPlan').checkAccount(page, { accountId }));
  const saveCustomer = deps.saveCustomer || ((row) => require('./textLog').recordCurrentCustomer(row));
  const saveUnverified = deps.saveUnverified || ((row) => require('./statusChecks').record(row));
  const coachingHeld = deps.coachingHeld || (() => require('./coachingPolicy').held());
  const readOpportunities = deps.readOpportunities || require('./accountOpportunities').makeReader({ log });      // one per check = one per run: it proves itself on the first accounts it reads
  const review = deps.review || ((page, lead) => require('./salesforceReview').reviewAccount(page, lead, { allClosedOut: false, notes: false }, { readOpportunities }));      // the review `--followup --check` runs: the opportunities only
  const saveReview = deps.saveReview || ((v) => require('./textLog').recordReview(v));
  const saveClosedWon = deps.saveClosedWon || ((row) => require('./textLog').recordClosedWon(row));
  const loadMs = Number.isFinite(deps.accountLoadMs) ? deps.accountLoadMs : 4000;
  const statusOnly = deps.opportunities === false;      // see the header: no look at the opportunities, and no trip back to the account page afterwards
  const assumeOpen = statusOnly && deps.assumeOpen === true;      // see the header: no fresh load, the caller has just loaded the account
  const heldRow = deps.held || ((id) => { try { const m = require('./textLog').readCurrentCustomers(); const k = String(id || '').toLowerCase(); return m.get(k) || m.get(k.slice(0, 15)) || null; } catch (_) { return null; } });      // the held list: a known customer

  const stagesOf = (opps) => { const n = new Map(); for (const o of opps || []) n.set(o.stage || '?', (n.get(o.stage || '?') || 0) + 1); const all = [...n].map(([s, k]) => (k > 1 ? `${s} ×${k}` : s)); return all.length > 4 ? `${all.slice(0, 4).join(', ')} …` : all.join(', '); };

  // What Customer Status said when the page was read, for the row below ("-" / "Canceled" / blank, or the field was not on the page).
  const statusText = (st) => (st && st.found ? String(st.value || '').trim() || 'blank' : 'not on the page');
  // The row that puts a lead with a recent Closed Won on the Current customers tab: held like a customer (`verdict: 'customer'`), with the opportunity as the evidence the tab shows (its name, owner, close date and a link to it).
  // `recentWin` is what makes the row count while Customer Status is not "Enrolled…" (textLog.readCustomerRows).
  const recentWinRow = (lead, url, cw, st) => ({
    accountId: lead.accountId, accountName: lead.name, accountUrl: url, source: lead.source || null, verdict: 'customer', recentWin: true,
    status: `Closed Won in the last ${WON_FLAG_DAYS} days (Customer Status: ${statusText(st)})`,
    why: `Closed Won in the last ${WON_FLAG_DAYS} days and not Invoicing and Payments: "${cw.name}"${cw.owner || cw.closeDate ? ` (${[cw.owner, cw.closeDate].filter(Boolean).join(', ')})` : ''}`,
    closedWon: [{ id: cw.oppId || null, name: cw.name || null, closeDate: cw.closeDate || null, owner: cw.owner || null, ip: false, via: 'board text check',
      fields: [`Opportunity Name: ${cw.name || ''}`, `Stage: ${cw.stage || 'Closed Won'}`, cw.closeDate ? `Close Date: ${cw.closeDate}` : null, cw.owner ? `Opportunity Owner: ${cw.owner}` : null].filter(Boolean) }],
    checkedAt: new Date().toISOString(),
  });

  // The opportunities of a lead by Customer Status, read right before its text (see the header). `st` = the Customer Status read. → { ok: true } | { ok: false, reason }
  async function checkOpportunities(page, lead, name, accountId, url, st) {
    let rev;
    try { rev = (await review(page, { accountId, name: lead.name, firstAt: lead.firstAt || null })) || { verdict: 'unknown', reasons: ['the opportunity review returned nothing'] }; }
    catch (e) { return { ok: false, reason: `the opportunities could not be checked: ${e.message} (this text is skipped for now)` }; }
    try { saveReview(rev); } catch (_) {}
    (rev.warnings || []).forEach((w) => log('⚠️', 'Review note', `${name} — ${w}`));
    if (rev.verdict === 'skip') {
      const cw = rev.closedWon;
      if (cw) { try { saveClosedWon({ accountId: lead.accountId, accountName: lead.name, accountUrl: url, ...cw, source: 'board text check' }); } catch (_) {} }
      if (cw) { try { saveCustomer(recentWinRow(lead, url, cw, st)); } catch (_) {} }      // and on the Current customers tab, with the opportunity's name (Luke, 2026-11-03)
      log('🏆', 'Closed won', `${name} — ${cw ? `"${cw.name}" closed ${cw.closeDate || '(no date)'}${cw.owner ? ` · owner ${cw.owner}` : ''}` : (rev.reasons || []).join('; ')}: another rep may have closed it, so it is NOT texted${cw ? ', goes on the Current customers tab with that opportunity (and the closed-won list)' : ''} and leaves the follow-up board`);
      return { ok: false, reason: `Closed Won in the last ${WON_FLAG_DAYS} days${cw ? ` ("${cw.name}", ${cw.closeDate || 'no date'})` : ''}` };
    }
    if (rev.verdict !== 'proceed') return { ok: false, reason: `${(rev.reasons || [])[0] || 'the opportunities could not be read'} (this text is skipped for now)` };
    const n = (rev.opps || []).length;
    log('🔎', 'Opportunities', `${name} — ${n ? `${n} on the account (${stagesOf(rev.opps)})` : 'none on the account'}, no Closed Won in the last ${WON_FLAG_DAYS} days`);
    return { ok: true };
  }

  return async function check(lead) {
    const name = lead.name || lead.accountId || '(unnamed account)';
    const url = lead.url || (lead.accountId && deps.startUrl ? `${String(deps.startUrl).replace(/\/$/, '')}/lightning/r/Account/${lead.accountId}/view` : null);
    if (!url) return { ok: false, reason: 'no account link to check enrollment on' };
    const accountId = (String(url).match(ACCOUNT_ID) || [])[1] || lead.accountId;
    try {
      const page = deps.getPage();
      let openedAt = null;                                                             // when the account page last finished loading (null = not loaded, or the load did not finish)
      const open = async () => { openedAt = null; let loaded = true; await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { loaded = false; }); await sleep(loadMs); if (loaded) openedAt = Date.now(); };
      // Handed to the text (runReportCampaign → textAccount): this page was loaded on the account a moment ago, so the text does not load the account a second time (it used to: every text opened its account twice).
      const opened = () => (openedAt ? { page, url, at: openedAt } : null);
      // A lead by Customer Status: its opportunities next. The read leaves the page on the account, unless it had to go elsewhere (the Opportunities tab when the card is not usable, a recent Closed Won opened to see
      // whether it is the free plan): then back to the account for the text.
      const lookAtOpportunities = async (extra = {}) => {
        if (statusOnly) return { ok: true, ...extra };
        const v = await checkOpportunities(page, lead, name, accountId, url, st);
        if (!v.ok) return { ok: false, reason: v.reason };
        if (!onAccount(page, accountId)) await open();
        return { ok: true, ...extra, opened: opened() };
      };
      if (assumeOpen) openedAt = Date.now(); else await open();                                                                    // always a fresh load: this is a LIVE look (unless the caller has just loaded the account itself: assumeOpen)
      let st = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { st = await readStatus(page); break; }
        catch (_) { await page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(2000); }      // Salesforce can re-navigate right after the load: transient
      }
      if (!st) return { ok: false, reason: 'could not read the account page to check enrollment (this text is skipped for now)' };
      if (!st.found) {
        if (statusOnly) { const h = heldRow(lead.accountId || accountId); if (h) return { ok: false, customer: true, status: h.status || 'Enrolled', reason: `held as a current customer (Customer Status: ${h.status || 'Enrolled'}) and the field is not on the page now, so the hold stands` }; }      // a known customer whose status cannot be read now stays held (the email run's rule)
        log('⚠️', 'Enrollment', `${name} — "Customer Status (beta)" field not found on the page; could not verify, checking its opportunities and texting if they are clear (written down in status-checks.jsonl)`);
        try { saveUnverified({ via: 'send', accountId: lead.accountId, accountName: lead.name, accountUrl: url, source: lead.source || null, found: false, why: 'board text check: the field is not on the page; its opportunities were checked instead and the text goes unless they show a recent Closed Won' }); } catch (_) {}
        return lookAtOpportunities({ unverified: true });
      }
      if (!/^\s*enrolled\b/i.test(st.value || '')) return lookAtOpportunities({ status: st.value || '' });      // Canceled / Terminated / empty / "-" = still a lead: its opportunities next
      const plan = (await checkPlan(page, accountId)) || { verdict: 'unknown', why: 'the plan check returned nothing', record: {} };
      try { saveCustomer({ accountId: lead.accountId, accountName: lead.name, accountUrl: url, status: st.value, source: lead.source || null, ...(plan.record || {}) }); } catch (_) {}      // saved the moment it is known, as the email run does
      if (plan.verdict === 'free-plan' && plan.released) {      // released by hand (customerRelease.js): a lead like any other, so its opportunities are still checked
        log('🆓', 'Released by hand', `${name} — Customer Status (beta) is ${st.value}, but ${plan.why}; not held as a customer, checking its opportunities next`);
        return lookAtOpportunities({ released: plan.verdict, status: st.value, why: plan.why });
      }
      if (plan.verdict === 'free-plan') {
        log('🆓', 'Free plan', `${name} — Customer Status (beta) is ${st.value}, but ${plan.why}; not a current customer, texting it`);
      } else if (plan.verdict === 'coaching' && !coachingHeld()) {
        log('🎓', 'Business coaching', `${name} — Customer Status (beta) is ${st.value}, and ${plan.why}; a Business Coaching Lead, texting it`);
      } else {
        log('🤝', 'Current customer', `${name} — Customer Status (beta) is "${st.value}"${plan.why ? ` (${plan.why})` : ''}: enrolled since we last looked, so NOT texted, and taken off the follow-up board`);
        return { ok: false, customer: true, status: st.value, reason: `current customer (Customer Status: ${st.value})` };
      }
      if (statusOnly) return { ok: true, released: plan.verdict, status: st.value, why: plan.why, moved: true };      // moved: the plan check left the page on an opportunity
      await open();                                                                    // the plan check left the page on an opportunity: back to the account for the text
      return { ok: true, released: plan.verdict, opened: opened() };
    } catch (e) {
      return { ok: false, reason: `the enrollment check failed: ${e.message} (this text is skipped for now)` };
    }
  };
}

module.exports = { makeCheck, onAccount };
