'use strict';

/**
 * coachingPolicy — what happens to BUSINESS COACHING accounts: kept out of outreach on their own page, or treated like the free Invoicing and Payments plan (sellable)?
 *
 *   Luke, 2026-10-28: a Closed Won that is only a coaching product (Foundation, Group, Solo, Solo Plus, Growth Workshop …) is not a customer: emailed like any lead.
 *   Luke, 2026-10-29 evening: "mark people as business coaching and i will manually check them for now but we should not outreach to them".
 *   Luke, 2026-10-29 night: "business coaching is a completely different department so those are odd ones, dont mark them as current customers, just put on a seperate
 *   page called business coaching".
 *
 * So today they are KEPT OUT of outreach (the "held" list that every text and email path reads: textLog.readCurrentCustomers, the email run's plan check, the Salesforce review)
 * but are NOT shown or counted as current customers: the dashboard lists them only on the 🎓 Business Coaching tab, for Luke to check by hand.
 * ONE switch, read each time it is asked (no restart): coaching-policy.json { "held": true }. A missing or unreadable file means held (a doubt keeps them out of outreach).
 * To release them again (the 2026-10-28 rule) set "held" to false, or tell Claude.
 */

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'coaching-policy.json');

/** true = business coaching accounts are kept out of outreach (and off the Current customers tab); false = released, treated like the free Invoicing and Payments plan. */
function held() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).held !== false; } catch (_) { return true; }
}

module.exports = { held, FILE };
