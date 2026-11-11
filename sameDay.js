'use strict';

/**
 * sameDay — "reach out to everyone I have already texted today from the Shark list": a SECOND text, the same day.
 *
 * `email --same-day` (also `--followup --same-day`, or `--today`) is the Shark follow-up with these differences:
 *   - WHO: only the Shark pros we texted earlier today (any mode: the first text of the morning, a follow-up, the evening run), not the pros who
 *     have been quiet for N days. A pro who replied today is left out too: a person answers them, not a bot.
 *   - NO DEFAULT TEXT (Luke, 2026-11-02): the wording is given every run, `--message "…"` (or `--template N`). It used to send template 9, "Book a demo", which is the follow-up board's own Day 1 · Text 2.
 *   - NOT A STAGE OF THE FOLLOW-UP BOARD (Luke, 2026-11-02: "let's not incorporate it to the board at all ... keep it in the same stage it's at"): the board ignores these texts (cadence.evaluate skips
 *     mode 'same-day'), so no lead moves, and no dashboard "Touchpoint N" label is set. A wording that IS one of the board's stage texts is refused (`boardClash`): the sender never repeats an exact
 *     text, so the board would otherwise count that stage as sent "by copy" and move the lead after all.
 *   - NO CHECK IN SALESFORCE, ever (`--check` is refused here): it just texts.
 *   - THE ONCE-A-DAY GUARD is waived for this mode only (runReportCampaign `sameDay`): texting a pro twice in a day is the point. Everything else stays on:
 *     banlist, the closed-won list and earlier review verdicts (this mode runs no NEW Salesforce review: it never opens an account to check opportunities), opt-out
 *     notes, a teammate's text, the pro's own texting hours, the contact ledger, and "never the same text twice".
 *   - NO THREAD READ (Luke, 2026-11-03: "We do not need to check the thread on same day"): a pro's SMS thread is not opened before its text (THREAD_READ below = true brings the old read back). A pro who replied is kept out by a
 *     reply the reply log already holds today (by account or by name, see cohort()), and a teammate's text by what the Shark report's SMS column shows (followupDue), not by reading the conversation.
 *   - ITS OWN Chrome (port 9331): it can run next to a live --followup (9325) without ever closing that run's browser.
 *
 * Nothing in here touches the browser or sends anything: `cohort()` is a pure read of the log, so --inspect and the tests use it as it is.
 */

const textLog = require('./textLog');

const MODE = 'same-day';                                         // the `mode` its log rows carry (a live --followup counts only its own 'followup' rows)
const THREAD_READ = false;      // false = --same-day does NOT open a pro's SMS thread before texting it (Luke, 2026-11-03: "We do not need to check the thread on same day"); true brings the old read back (threadGuard 'normal': a reply, or a teammate's text in 48 h, holds the pro in the hold inbox)
const SOURCE = { kind: 'Shark', name: 'Shark same-day text' };   // still the Shark list, so the pros stay on the dashboard's Shark tab
const MODE_LABEL = { queue: 'queue text', report: 'report text', followup: 'follow-up', evening: 'evening run', [MODE]: 'same-day text' };

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
/** This computer's calendar day (YYYY-MM-DD): the same day textLog.localDay and the dashboard use. */
function localDay(d) {
  const x = new Date(d);
  if (isNaN(x)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
const isShark = (r) => !!r && !!r.source && typeof r.source === 'object' && /shark/i.test(String(r.source.kind || ''));

/**
 * The Shark pros we texted today, minus the ones who replied today.
 * → { day, ids: Set<15-char id>, pros: Map<15-char id, { id, name, firstAt, lastAt, texts, mode }>, stats: { pros, texts, byMode, replied } }
 * `ids` is what followupDue gets as its cohort. `rows` / `replies` / `now` are for the tests; by default the real log is read.
 */
function cohort({ now = new Date(), rows = null, replies = null } = {}) {
  const day = localDay(now);
  const pros = new Map(), byMode = {};
  let texts = 0;
  for (const r of rows || textLog.readAll()) {
    if (!r || r.channel === 'email' || !isShark(r) || !r.accountId || localDay(r.at) !== day) continue;     // (a row with no channel is an old text)
    if (r.mode === 'manual') continue;       // a lead worked by hand (textLog --add-shark): the rep did its stage 1 himself today, a bot's second text on top of it is not wanted
    const k = k15(r.accountId);
    const p = pros.get(k) || { id: r.accountId, name: r.accountName || '(unnamed account)', firstAt: r.at, lastAt: r.at, texts: 0, mode: r.mode || null };
    p.texts++; texts++;
    if (String(r.at) < String(p.firstAt)) p.firstAt = r.at;
    if (String(r.at) >= String(p.lastAt)) { p.lastAt = r.at; p.mode = r.mode || p.mode; }
    pros.set(k, p);
    byMode[r.mode || 'other'] = (byMode[r.mode || 'other'] || 0) + 1;
  }
  // Replies today (replies.jsonl, written from the SMS-Magic emails): any reply keeps the pro out. A reply the bot could not match to an account has only a name.
  const todays = (replies || textLog.readReplyRows()).filter((x) => x && localDay(x.at) === day);
  const repliedIds = new Set(todays.map((x) => k15(x.accountId)).filter(Boolean));
  const repliedNames = new Set(todays.filter((x) => !x.accountId).map((x) => normName(x.accountName)).filter(Boolean));
  const ids = new Set();
  let replied = 0;
  for (const [k, p] of pros) { if (repliedIds.has(k) || repliedNames.has(normName(p.name))) replied++; else ids.add(k); }
  return { day, ids, pros, stats: { pros: pros.size, texts, byMode, replied } };
}

/** The lines --inspect prints about the pros before the follow-up filters take over. → { head, notes: [[n, why]] } */
function describe(info) {
  const { stats: s } = info;
  const modes = Object.entries(s.byMode).map(([m, n]) => `${n} ${MODE_LABEL[m] || m}`).join(', ');
  return {
    head: `Texted today from the Shark list: ${s.pros.toLocaleString()} pro(s), ${s.texts.toLocaleString()} text(s)${modes ? ` (${modes})` : ''}`,
    notes: [[s.replied, 'replied today: a person answers them, so this run leaves them alone']],
  };
}

/** "follow-up at 1:20 PM" — when and how the pro was last texted today (for the lists). */
function sinceLabel(lead, info) {
  const p = info && info.pros.get(k15(lead.accountId));
  if (!p) return 'texted today';
  return `${MODE_LABEL[p.mode] || p.mode || 'text'} at ${clock(p.lastAt)}${p.texts > 1 ? `, ${p.texts} texts today` : ''}`;
}

/**
 * The last line of defence: every lead must be one of today's pros. followupDue honours its `cohort`, but a textLog.js from before this feature
 * (another session copying an old file over it) would ignore it and offer the WHOLE Shark tab. Better an error than a text to all of them.
 */
function assertInCohort(leads, ids) {
  const stray = leads.filter((l) => !ids.has(k15(l.accountId)));
  if (stray.length) throw new Error(`--same-day: ${stray.length} account(s) are not among the pros texted today (first: ${stray[0].name}). Nothing was sent: textLog.js ignored the cohort, so it is out of date.`);
  return leads;
}

const wording = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();      // textLog.msgNorm: the same wording, case and spacing ignored
const GENERIC_NAMES = new Set(['', 'custom message', 'email first-touch', '(text)', '(email)']);   // textLog.GENERIC_TEMPLATES: names that do not identify a message, only its wording does

/**
 * The follow-up board's text stages whose copy is the SAME message as `msg` ({ name, text }): the same wording, or the same named template (what textLog.sentSameMessage calls "the same").
 * A same-day text that matched one would make the board count that stage as already sent for the pro (cadence.evaluate: a stage whose exact text the lead got is done "by copy", because the sender
 * refuses a repeat) and so move the lead on, which `--same-day` must never do. Assistant.js refuses such a wording before anything starts.
 * `templates` = Assistant.js's TEMPLATES; `cfg` = cadence.loadConfig() (the stages as the board runs them, follow-up-cadence.json on top). → [{ id, label, name }]; empty = no clash.
 */
function boardClash(msg, templates, cfg) {
  const cadence = require('./cadence');
  const c = cfg || cadence.loadConfig();
  const want = wording(msg && msg.text), name = wording(msg && msg.name), named = !GENERIC_NAMES.has(name);
  if (!want && !named) return [];
  const hits = [];
  for (const s of c.stages) {
    if (s.ch !== 'text' || s.byHand) continue;      // a stage the board never sends (byHand) cannot be counted as sent by a same-day text
    const copy = cadence.copyOf(s, templates);
    if (!copy || !copy.text) continue;
    if ((want && wording(copy.text) === want) || (named && wording(copy.name) === name)) hits.push({ id: s.id, label: s.label, name: copy.name });
  }
  return hits;
}

module.exports = { MODE, SOURCE, THREAD_READ, cohort, describe, sinceLabel, assertInCohort, boardClash, localDay };
