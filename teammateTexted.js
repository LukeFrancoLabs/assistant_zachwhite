'use strict';

/**
 * teammateTexted — "go through the Teammate texted list and send": the pros on the dashboard's 🤝 Teammate texted tab, because a TEAMMATE texted them
 * and the follow-up bot HELD them (it never texts over a teammate).
 *
 * `email --teammate-texted` (also `--teammate-list`) is the Shark follow-up with a different list and one different thread rule:
 *   - WHO: the pros whose newest thread read of the last 3 days was held because a teammate texted (threadReader.recentHolds, kind 'teammate'), plus the pros the
 *     report's "Last Outgoing SMS DateTime" says a teammate texted in the last 48h (textLog.teammateList). The tab lists two more kinds, left out and counted:
 *     a pro who REPLIED (a person answers them: email --holds) and a thread that could not be read.
 *   - THE THREAD RULE at send time (threadReader mode 'nudge'): the teammate's text no longer holds the send, that is why the pro is on the list; a reply from the
 *     pro after our last text, or an opt-out anywhere in the thread, still does.
 *   - Everything else is --followup as it is: the Salesforce review, the banlist, the closed-won list, opt-out notes, each pro's own hours, the contact ledger,
 *     never the same text twice, the once-a-day guard (a pro we texted in the last 24h is left out of the list and waits for the next run) and the confirm.
 *   - ITS OWN Chrome (port 9332): a --followup may be running on 9325 and a --same-day on 9331, and starting this one must never close either.
 *
 * Nothing in here touches the browser or sends anything: cohort() and due() are pure reads, so --inspect and the tests use them as they are.
 */

const textLog = require('./textLog');
const threadReader = require('./threadReader');
const holdInbox = require('./holdInbox');
const sender = require('./sender');      // who this copy texts as (sender.json)

const MODE = 'teammate-texted';                                       // the `mode` its log rows carry (a live --followup counts only its own 'followup' rows)
const SOURCE = { kind: 'Shark', name: 'Shark teammate-texted text' };  // still the Shark list, so the pros stay on the dashboard's Shark tab
/** The text Luke gave on 2026-10-27, character for character (the space after "connect?" is his). --template N / --message "…" send something else. */
const TEXT = {
  name: 'Teammate Texted: Still Want To Partner',
  text: 'We still want to partner with you and help you grow the business and run a less stressful operation.\n\nAre you free for 10 minutes sometime this week to connect? \n\n- Luke Franco @ Housecall Pro: 970-338-3120\ntinyurl.com/housecallprodemo',
};
TEXT.text = sender.apply(TEXT.text);      // the wording is Luke Franco's; his name, number and link become the sender's (sender.json)
const HOLD_DAYS = 3;                                                  // how far back the dashboard tab shows thread holds

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** When something happened, in this computer's time: "9:10 AM" today, "yesterday 9:10 AM", else "Mon 9:10 AM". */
function stamp(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '?';
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const ago = Math.round((dayStart(now) - dayStart(d)) / 864e5);
  return ago <= 0 ? t : ago === 1 ? `yesterday ${t}` : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`;
}

/**
 * The pros a teammate texted, as the 🤝 tab lists them. `holds` / `report` / `now` are for the tests; by default the real thread reads and snapshots are read.
 * → { ids: Set<15-char id>, pros: Map<15-char id, { id, name, via: 'thread'|'report'|'both', heldAt, why, sms }>,
 *     stats: { tab, pros, thread, report, both, replied, unreadable, other } }
 * `ids` is what followupDue gets as its cohort. A pro who replied is never in it, even when the report column also shows a teammate's text.
 */
function cohort({ now = new Date(), holds = null, report = null } = {}) {
  const reads = holds || threadReader.recentHolds(HOLD_DAYS);
  const rows = report || textLog.teammateList({ now });
  const pros = new Map(), replied = new Set();
  let thread = 0, unreadable = 0, other = 0;
  for (const r of reads) {
    const k = k15(r.accountId);
    if (!k) continue;
    if (r.kind === 'replied') replied.add(k);
    else if (r.kind === 'unreadable') unreadable++;
    else if (r.kind !== 'teammate') other++;                          // 'no-teammate', 'opted-out'…: held for some other reason
    else { pros.set(k, { id: r.accountId, name: r.accountName || '(unnamed account)', via: 'thread', heldAt: r.at, why: r.reason || '', sms: null }); thread++; }
  }
  let report_ = 0, both = 0;
  for (const r of rows) {
    const k = k15(r.id);
    if (!k || replied.has(k)) continue;
    const p = pros.get(k);
    if (p) { p.via = 'both'; p.sms = r.sms; both++; }
    else pros.set(k, { id: r.id, name: r.name || '(unnamed account)', via: 'report', heldAt: null, why: '', sms: r.sms });
    report_++;
  }
  return { ids: new Set(pros.keys()), pros, stats: { tab: reads.length + rows.length, pros: pros.size, thread, report: report_, both, replied: replied.size, unreadable, other } };
}

/** The lines --inspect prints about the list before the follow-up filters take over. → { head, notes: [[n, why]] } */
function describe(info) {
  const { stats: s } = info;
  const src = [s.thread && `${s.thread.toLocaleString()} from thread reads of the last ${HOLD_DAYS} days`, s.report && `${s.report.toLocaleString()} from the report's SMS column (last 48h)`].filter(Boolean).join(', ');
  return {
    head: `On the 🤝 Teammate texted tab: ${s.tab.toLocaleString()} row(s) → ${s.pros.toLocaleString()} pro(s) a teammate texted${src ? ` (${src}${s.both ? `; ${s.both.toLocaleString()} on both` : ''})` : ''}`,
    notes: [[s.replied, 'are on the tab because the PRO REPLIED: a person answers them (email --holds), so this run leaves them alone'],
            [s.unreadable, 'are on the tab because their thread could not be read: not texted'],
            [s.other, 'were held by a thread read for another reason (an opt-out, no teammate text left in the thread): not texted']],
  };
}

/** "Jonathan Trejos texted 6h ago (thread read yesterday 2:07 PM) · 4 day(s) since our touch" — who texted the pro, for the lists ("6h ago" is as of that thread read). */
function sinceLabel(lead, info) {
  const p = info && info.pros.get(k15(lead.accountId));
  const what = !p ? 'a teammate texted' : p.via === 'report' ? `a teammate texted ${p.sms}` : `${String(p.why || 'a teammate texted').split(': "')[0]} (thread read ${stamp(p.heldAt)})`;
  return `${what} · ${lead.sinceDays} day(s) since our touch`;
}

/**
 * The last line of defence: every lead must be on the tab. followupDue honours its `cohort`, but a textLog.js from before that option (another session copying an
 * old file over it) would ignore it and offer the WHOLE Shark tab. Better an error than a text to all of them.
 */
function assertInCohort(leads, ids) {
  const stray = leads.filter((l) => !ids.has(k15(l.accountId)));
  if (stray.length) throw new Error(`--teammate-texted: ${stray.length} account(s) are not on the Teammate texted tab (first: ${stray[0].name}). Nothing was sent: textLog.js ignored the cohort, so it is out of date.`);
  return leads;
}

/**
 * Who a run would text: followupDue over the cohort, with both of its teammate passes. followupDue HOLDS a pro whose report column shows a teammate's text
 * (teammateOnly false) and texts ONLY those (teammateOnly true); this list is neither, so the two passes are joined. Then the pros the sender's once-a-day guard
 * would stop (a text from us in the last 24h) are left out too, so the list a run shows is the list it texts. `deps` is for the tests.
 * → { leads, stats } like followupDue, with stats.textedToday added
 */
function due(opts, { followupDue = textLog.followupDue, textedWithinHours = textLog.textedWithinHours } = {}) {
  const a = followupDue({ ...opts, teammateOnly: false });
  const b = followupDue({ ...opts, teammateOnly: true, recordSkips: false });      // (the cap skips are recorded once, by the first pass)
  const seen = new Set(), joined = [];
  for (const l of [...a.leads, ...b.leads]) { const k = k15(l.accountId); if (!seen.has(k)) { seen.add(k); joined.push(l); } }
  let textedToday = 0;
  const leads = joined.filter((l) => { if (textedWithinHours(l.accountId, 24)) { textedToday++; return false; } return true; });
  leads.sort((x, y) => Date.parse(x.lastAt) - Date.parse(y.lastAt));              // longest-waiting first, as followupDue sorts
  return { leads, stats: { ...a.stats, teammate: 0, notTeammate: 0, textedToday, eligible: leads.length, knownZone: leads.filter((l) => l.zones).length } };
}

/**
 * A text went out to this pro: close its open thread hold, so `email --holds` does not draft a SECOND text for the same pro. Only a teammate hold is closed:
 * an open "the pro replied" hold stays for you. → the closed row | null
 */
function closeHold(accountId, { inbox = holdInbox } = {}) {
  const row = inbox.readAll().get(k15(accountId));
  if (!row || row.kind !== 'teammate' || row.status === 'sent' || row.status === 'skipped' || row.status === 'cleared') return null;
  return inbox.markSent(row);
}

module.exports = { MODE, SOURCE, TEXT, HOLD_DAYS, cohort, describe, sinceLabel, assertInCohort, due, closeHold };
