'use strict';

/**
 * planRelease — a stored Salesforce text review that said "skip" ONLY because of the account's Closed Won opportunity, when the plan check (customerPlan.js) has since read
 * that opportunity and found it is the free Invoicing and Payments sign-up: not a customer (Luke, 2026-10-27 / 10-29), so the skip is moot and the account stays in the regular
 * outreach cadence (the follow-up texts, the follow-up board) like any other lead. Business coaching is NOT released here: Luke keeps it out of outreach (a different
 * department, 2026-10-29, coachingPolicy.js), so a coaching skip stands and a coaching Closed Won stays a close; only if the policy releases coaching does it count like the free plan again.
 *
 * The old "current customer: a Closed Won among the 3 most recent opportunities" review rule wrote exactly those skips (13 free-plan accounts on 2026-10-29, each held for 14 days).
 * A review's rules for a Closed Won opportunity inside the Closed Won window (closedWonWindow.js: 30 days), or one that came after our first touch, are not changed here.
 *
 * A skip is moot only when ALL of these hold (each is a way the skip can still be right):
 *   · the account's newest current-customers.jsonl row is verdict 'free-plan' (or 'coaching' once the policy releases it): the plan check read every Closed Won opportunity page of the account;
 *   · every reason of the review is about a Closed Won opportunity (a do-not-contact / not-interested note, or "all opportunities closed out", stands);
 *   · every Closed Won opportunity the review saw is one the plan check read and found to be Invoicing and Payments / coaching, matched by opportunity id (a newer, real one stands).
 *
 * mootReview(rv, rows) → true | false.   `rows` = textLog.readCustomerRows() (a Map by lower-case id and by its 15-character form). Never throws: a doubt is "not moot".
 */

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const WON = /closed[\s_/-]*won/i;
// The reasons salesforceReview.decide() writes for a Closed Won opportunity: 'Closed Won "x" (date) on/after our first touch …', '⚠️ FLAG closed-won 30d: …' (reviews saved before 2026-10-30 say 60d: the pattern below ignores the number), and the retired
// 'current customer — Closed Won "x" … is among the 3 most recent opps'.
const CLOSED_WON_REASON = /^\W*(?:FLAG closed-won\b|Closed Won\b|current customer\b[^"]*Closed Won\b)/i;

function mootReview(rv, rows) {
  try {
    if (!rv || rv.verdict !== 'skip' || rv.hardStop || !rows) return false;
    const row = rows.get(String(rv.accountId || '').toLowerCase()) || rows.get(k15(rv.accountId));
    // business coaching is kept out of outreach (a different department, Luke, 2026-10-29, coachingPolicy.js): its skips stand, unless the policy releases it
    if (!row || (row.verdict !== 'free-plan' && !(row.verdict === 'coaching' && !require('./coachingPolicy').held()))) return false;
    const reasons = Array.isArray(rv.reasons) ? rv.reasons : [];
    if (!reasons.length || !reasons.every((r) => CLOSED_WON_REASON.test(String(r)))) return false;
    const read = new Set((row.closedWon || []).filter((e) => e && e.id && (e.ip || e.coaching)).map((e) => k15(e.id)));
    const won = (Array.isArray(rv.opps) ? rv.opps : []).filter((o) => o && WON.test(o.stage || ''));
    return won.length > 0 && won.every((o) => o.id && read.has(k15(o.id)));
  } catch (_) { return false; }
}

const MAX_WINS = 5;       // recent Closed Won opportunities opened per account, newest first: one more than that stays counted (fail closed)

/**
 * A FRESH review: which of the account's Closed Won opportunities of the last `days` days are the free Invoicing and Payments sign-up (or business coaching, only once coachingPolicy.js
 * releases it)? Those are not a close (Luke, 2026-10-29: such a pro is not a customer), so salesforceReview.decide() leaves them out: they neither stop the account nor put it on the closed-won list.
 * Each recent Closed Won opportunity is read exactly the way the plan check reads it (customerPlan.inspectOpp: its name, else its page: field values, never a sentence), READ-ONLY.
 * Fails closed: an opportunity that cannot be read, that is not clearly Invoicing and Payments / coaching, or that is beyond the newest MAX_WINS, stays a Closed Won.
 *
 * → Set of 15-character opportunity ids (empty on any doubt).  `o` = { now, days, sfReview: { readOppDetail }, inspect } (`inspect` is for tests: (page, opp, { sfReview }) → { ip, coaching })
 */
async function freePlanWins(page, opps, o = {}) {
  const out = new Set();
  try {
    const now = o.now == null ? Date.now() : o.now, days = o.days == null ? require('./closedWonWindow').WON_FLAG_DAYS : o.days;
    const when = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? -Infinity : t; };
    const recent = (Array.isArray(opps) ? opps : []).filter((x) => x && x.id && WON.test(x.stage || '') && when(x.closeDate) >= now - days * 864e5)
      .sort((a, b) => when(b.closeDate) - when(a.closeDate)).slice(0, MAX_WINS);
    if (!recent.length) return out;
    const inspect = o.inspect || require('./customerPlan').inspectOpp;
    const coachReleased = !require('./coachingPolicy').held();      // a coaching Closed Won stays a close (the account is a held customer) unless the policy releases coaching
    for (const x of recent) {
      let ev = null;
      try { ev = await inspect(page, x, { sfReview: o.sfReview }); } catch (_) { ev = null; }
      if (ev && (ev.ip === true || (ev.coaching === true && coachReleased))) out.add(k15(x.id));
    }
  } catch (_) { out.clear(); }
  return out;
}

module.exports = { mootReview, freePlanWins, CLOSED_WON_REASON, MAX_WINS };
