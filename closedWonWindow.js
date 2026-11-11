'use strict';

/**
 * closedWonWindow — ONE switch: how many days a Closed Won opportunity (any rep) keeps an account out of outreach.
 *
 * Luke, 2026-10-30: 30 days ("scrub for closed won oppys in the last 30 days"). Until then the Salesforce review (salesforceReview.decide) used 60 while the dashboard, the
 * instructions and the 🏆 Closed Won tab said 30. Everything that applies the window reads this file: the review (so `--followup --check`, `--reengage`, `--auto` and the
 * board's opportunities check), the free-plan release (planRelease), the follow-up filter and the queue label (textLog), the teammate audit, --auto's settings and the workflow
 * diagram's daily numbers. Change the number HERE and nowhere else.
 *
 * What it does NOT change: an account already on the closed-won list is still left out of the follow-up BOARD (cadence.members) and the 48-hour re-engage (reengageDue)
 * whatever its age; only the review, `--followup`'s filter and the labels use the window.
 */

const WON_FLAG_DAYS = 30;

module.exports = { WON_FLAG_DAYS };
