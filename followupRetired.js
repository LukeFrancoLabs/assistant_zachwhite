'use strict';

/**
 * followupRetired — plain `email --followup` is RETIRED, for now (Luke, 2026-11-02: "lets retire follow up for now since the board replaces it").
 *
 * WHY: the follow-up board (cadence.js, `email --board`) does its job on a schedule, per lead, in the lead's own time zone. The only text --followup ever sent (1,886 of them, 2026-10-20 to
 * 10-29, all step 1) is "Follow-Up 1", word for word the board's Day 3 · Text 4. Its step 2, the success story, was never written; the board's Day 5 · Text 5 is where that text goes when it is.
 *
 * WHAT IS RETIRED: every PLAIN follow-up run, whatever flags it carries (--inspect, --template, --message, --days, --step, --zone-only, --check ...): problem() returns the pointer below, Assistant.js
 * prints it and stops before any browser or log is touched, and run.sh starts and kills no Chrome for it. WHAT IS NOT: --teammate-texted (also
 * --teammate-list) and --followup --teammate. The board does not do what they do, and they run on the same engine (Assistant.js runFollowup), which is why none of the code was deleted.
 *
 * FOR NOW: nothing was removed. RETIRED = false below brings plain --followup back exactly as it was (run.sh asks this file too: `node followupRetired.js` exits 0 while it is retired, 1 once it is not).
 */

const RETIRED = true;

const MESSAGE = '\n⚠️  --followup is retired (for now): the follow-up board replaces it. Its one text, "Follow-Up 1", is the board\'s Day 3 · Text 4, which  email --board  sends to each lead on its own day, inside its own hours.\n' +
  '    What is due:  email --board --inspect      Send it:  email --board\n' +
  '    Still there: --teammate-texted and --followup --teammate. Nothing was started.\n';

/** Is this a plain follow-up run? --same-day and --teammate-texted set args.followup too (Assistant.js parseArgs), and --followup --teammate is its own run, so none of those count. */
const isPlain = (args) => !!(args && args.followup && !args.sameDay && !args.teammateTexted && !args.teammate);

/** → the pointer to print when `args` is a plain follow-up run and plain --followup is retired, else null. Reads exports.RETIRED, so a test can switch it. */
function problem(args) { return module.exports.RETIRED && isPlain(args) ? MESSAGE : null; }

module.exports = { RETIRED, MESSAGE, isPlain, problem };

if (require.main === module) {
  console.log(RETIRED ? 'plain --followup is retired (see followupRetired.js)' : 'plain --followup is active again');
  process.exit(RETIRED ? 0 : 1);
}
