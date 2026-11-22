'use strict';

/**
 * cadence — THE FOLLOW-UP BOARD'S THIRTEEN STAGES (a 60-day drip): who has had what, and who is due what next, read from OUR OWN LOG (texted-log.jsonl), never from the Shark report.
 * (The Shark report drops a pro the moment anybody texts or emails them, so it cannot say who we already reached. The log can.)
 *
 *   Day 1 · Text 1     the first text                       (default copy: template 10)
 *   Day 1 · Text 2     BY HAND since 2026-11-03: the board never sends it (Luke sends it himself with `email --same-day`); a lead counts as having had it once it has had Text 1 (texts from before 2026-11-04 keep the numbering they had)
 *   Day 1 · Email 1    the first email of the email sequence (emailSequence.js, touch 1)
 *   Day 2 · Text 3     the day after Day 1                   (template 16, "Drip: Time Saved": Luke's own "slammed yesterday ... 8.5 hours a week" text, ADDED 2026-11-04: see `addedSince`)
 *   Day 3 · Text 4     the day after Day 2                   (template 8, "Follow-Up 1")
 *   Day 3 · Email 2    the same day: email touch 2
 *   Day 5 · Text 5     two days after Day 3                  (template 12, online booking + instant alert)
 *   Day 9 · Email 3    four days later                       (email-templates.json `csr-ai`: CSR AI answers when you can't)
 *   Day 14 · Text 6    five days later                       (template 13, Pipeline follow-up)
 *   Day 21 · Email 4   a week later                          (email-templates.json `past-customers`: Campaigns + automated reviews)
 *   Day 28 · Text 7    a week later                          (template 14, get paid on the spot + financing)
 *   Day 42 · Email 5   two weeks later                       (email-templates.json `why-now`: the short version + the offer)
 *   Day 60 · Text 8    18 days later                         (template 5, "Respectful Follow-Up": the close)
 *
 * HOW A LEAD MOVES: a stage is DONE when the lead has had that many texts (or emails): the Nth text of ANY kind is "Text N", the Nth email is "Email N" (except a `--same-day` text and a `--blast` email: the board never counts them). The NEXT stage is the first one
 * not done. It is READY once the gap since our last touch has passed: the stages of one day wait a few minutes or hours after each other (text 2: 3 h, email: 30 min), and a later day
 * waits for its calendar day in the lead's OWN time zone (Day 2 = the next local day after a Day 1 touch, Day 3 the next one after that). It is SENT only inside that lead's own texting hours (tcpa.js: 8:00-20:00 their
 * time, Mon-Sat; an unknown zone waits for the all-US window, 12:00-20:00 Eastern). A lead whose Day 1 was done BY HAND (the ➕ box) has both Day 1 texts counted as done (Email 1 only if he emailed it).
 * A lead that asked us to stop (a STOP in its saved text thread, the hold inbox) is PAUSED for good. A lead that only REPLIED is NOT paused: it stays in the cadence (Luke, 2026-11-03: a lot of pros answer "why?" and go quiet, so we still reach out
 * to them; the interested ones are on the dashboard's 🎯 Top hit list, topHit.js). Only a "not interested" takes a lead out, and a clear one is banned by optOut.js, so that lead is not on the board at all;
 * a banned / closed-won / customer / opted-out lead is not on the board at all; a lead tagged only with a label of his own (#referral) is on the board but held. An EMAIL stage for a lead the email sender found no address for
 * (textLog.noRecipientAccounts) is skipped, not waited for: the stage order is strict, so without this the lead would sit at Email 1 forever and never get its Day 3 / Day 5 texts. A text stage whose exact text the lead already got is DONE
 * by that earlier send (the sender refuses a repeat), so the lead is never stranded in front of it.
 *
 * The state lives in the log, so there is no queue file to lose: restart the run and it picks up exactly where the log says. Everything here takes the time it should use and the
 * data it should read as arguments, so a test can run a whole week in milliseconds.
 *
 *   node cadence.js            the stage table + who was texted today (no browser, nothing sent)
 */

const fs = require('fs');
const path = require('path');
const tcpa = require('./tcpa');

const DIR = process.env.ASSISTANT_CADENCE_DIR || __dirname;
const FILE = path.join(DIR, 'follow-up-cadence.json');
const ZONE = 'America/New_York';            // the clock the report, the log and "today" use for an unknown zone
const MANUAL_MODE = 'manual';               // textLog.MANUAL_MODE: a touch Luke did by hand (the ➕ box)
const SAME_DAY_MODE = 'same-day';           // sameDay.MODE: the manual extra text of `email --same-day`. NOT a stage: evaluate() leaves it out of every count, so it never moves a lead (Luke, 2026-11-02)
const BLAST_MODE = 'blast';                 // emailBlast.MODE: the manual `email --email --blast` email. NOT a stage either: evaluate() leaves it out of every count, so a blast never moves a lead (Luke, 2026-11-03: "use blast as a manual, one-off tool")

/**
 * The thirteen stages, in the order they run. `template` = a TEMPLATES id in Assistant.js (texts); `message` replaces it with literal text. An email stage sends touch `n` of emailSequence.js, or, with `emailTemplate`, the named email of that key in email-templates.json (plain text).
 * `afterMin`: how long after the previous touch of the SAME day this one waits. `sameDay`: it is a second text inside 24 hours on purpose (waives the once-a-day guard, nothing else).
 * `byHand`: the board NEVER sends this text stage, Luke does it himself (Day 1 · Text 2 is his own `email --same-day` text at 2 PM; Luke, 2026-11-03: "take off day one text from the board since we'll be doing it manually"). A lead counts as having had it
 * once it has had the texts before it (evaluate() puts a text that was never sent in its place), so it moves on and its later texts keep counting from the stage after it. `byHandSince`: texts sent BEFORE that instant keep the numbering the board
 * had (a lead that already had two texts then keeps its second one as this stage), so nobody already in flight changes; only a lead with fewer texts then, and every new lead, skips the stage. follow-up-cadence.json can bring the stage back
 * ({ "stages": { "d1t2": { "byHand": false } } }).
 * `manual`: a LABEL only (Luke, 2026-11-04: "mark on the board that day 1 outreach is all manual"; asked what it should change, he said "Only label it"): Luke does this stage by hand, so the board marks it ✋ BY HAND (stage table, stage list, dashboard column),
 * and nothing about who is due or what gets sent changes: the board still sends it when a run picks it. Day 1 · Text 1 and Day 1 · Email 1 carry it (Day 1 · Text 2 is `byHand`, which also stops the board sending it).
 * follow-up-cadence.json can take the label off ({ "stages": { "d1t1": { "manual": false } } }).
 * `addedSince`: this stage was ADDED to the plan when leads were already in flight (Day 2 · Text 3, Luke, 2026-11-04: "i want to add in day 2, text 3"). A lead that already had that many texts BEFORE that instant has passed the place where the stage now sits, so it counts as having had it
 * (evaluate() puts a text that was never sent in its place, like a `byHand` stage): its texts keep the numbers they had (what it had as its third text is still the Day 3 text) and nobody gets the new text out of order or days late.
 * A lead with fewer texts then, and every new lead, gets the stage in its order. follow-up-cadence.json can move the instant ({ "stages": { "d2t3": { "addedSince": "…" } } }): the earlier it is, the fewer leads skip the stage.
 */
const DEFAULT_STAGES = [
  { id: 'd1t1', day: 1, ch: 'text',  n: 1, label: 'Day 1 · Text 1',  template: '10', afterMin: 0, manual: true },
  { id: 'd1t2', day: 1, ch: 'text',  n: 2, label: 'Day 1 · Text 2',  template: '9',  afterMin: 180, sameDay: true, byHand: true, byHandSince: '2026-11-04T05:00:00Z' },
  { id: 'd1e1', day: 1, ch: 'email', n: 1, label: 'Day 1 · Email 1', afterMin: 30, manual: true },
  { id: 'd2t3', day: 2, ch: 'text',  n: 3, label: 'Day 2 · Text 3',  template: '16', afterMin: 0, addedSince: '2026-11-04T19:43:00.955Z' },
  { id: 'd3t3', day: 3, ch: 'text',  n: 4, label: 'Day 3 · Text 4',  template: '8',  afterMin: 0 },
  { id: 'd3e2', day: 3, ch: 'email', n: 2, label: 'Day 3 · Email 2', afterMin: 30 },
  { id: 'd5t4', day: 5, ch: 'text',  n: 5, label: 'Day 5 · Text 5',  template: '12', afterMin: 0 },
  { id: 'd9e3',  day: 9,  ch: 'email', n: 3, label: 'Day 9 · Email 3',  afterMin: 30, emailTemplate: 'csr-ai' },
  { id: 'd14t5', day: 14, ch: 'text',  n: 6, label: 'Day 14 · Text 6', template: '13', afterMin: 0 },
  { id: 'd21e4', day: 21, ch: 'email', n: 4, label: 'Day 21 · Email 4', afterMin: 30, emailTemplate: 'past-customers' },
  { id: 'd28t6', day: 28, ch: 'text',  n: 7, label: 'Day 28 · Text 7', template: '14', afterMin: 0 },
  { id: 'd42e5', day: 42, ch: 'email', n: 5, label: 'Day 42 · Email 5', afterMin: 30, emailTemplate: 'why-now' },
  { id: 'd60t7', day: 60, ch: 'text',  n: 8, label: 'Day 60 · Text 8', template: '5',  afterMin: 0 },
];

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
const sender = require('./sender');      // who this copy emails as (sender.json): the named emails were written by Luke Franco, sender.apply swaps his name / numbers / link for the sender's
const readNamedEmails = (f) => {
  const all = readJson(f, {}) || {};
  for (const t of Object.values(all)) if (t && typeof t === 'object') { t.subject = sender.apply(t.subject); t.body = Array.isArray(t.body) ? t.body.map((l) => sender.apply(l)) : sender.apply(t.body); }
  return all;
};
/** The named email `key` of email-templates.json ({ name, subject, body }), or null when it is missing or has no subject / body (a stage with no email written is held, like a text with no copy). */
const namedEmail = (key) => {      // (re-read only when the file changed: the board asks once per lead on every look)
  const f = path.join(__dirname, 'email-templates.json');
  let sig; try { const st = fs.statSync(f); sig = `${st.mtimeMs}:${st.size}`; } catch (_) { return null; }
  if (!namedEmail.cache || namedEmail.cache.sig !== sig) namedEmail.cache = { sig, data: readNamedEmails(f) };
  const t = namedEmail.cache.data[key]; return t && t.subject && t.body ? t : null;
};
const BOARD_ACTIVE_DAYS = 30;      // a lead the board itself last texted or emailed longer ago than this is "older" again (the drip never waits longer than 18 days between touches)
/** A named email's subject as a pattern: each {{token}} may be any text, the rest must match exactly (the log keeps the PERSONALIZED subject of every email sent). */
const subjectRe = (() => {
  const cache = new Map(), esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (subject) => { const k = String(subject || ''); if (!cache.has(k)) cache.set(k, k ? new RegExp('^' + k.split(/\{\{[^}]*\}\}/).map(esc).join('.{1,60}') + '$', 'i') : null); return cache.get(k); };
})();
/** → { at } when the lead has ALREADY been sent this stage's named email (a one-off from the menu, a --blast: any email row whose subject is that email's), else null. The sender refuses an email the lead already got, so such a stage is done by that earlier send, as a text stage is (evaluate). */
function gotNamedEmail(lead, stage) {
  const nt = stage.emailTemplate ? namedEmail(stage.emailTemplate) : null, re = nt ? subjectRe(nt.subject) : null;
  if (!re) return null;
  let hit = null;
  for (const t of lead.touches || []) if (t && t.ch === 'email' && re.test(String(t.title || '').trim()) && (!hit || String(t.at) > String(hit.at))) hit = t;
  return hit ? { at: hit.at } : null;
}
/** The reply poller writes a reply up to ~40 minutes after the pro sent it (68 replies measured), so a reply up to this long BEFORE our last touch may be one that touch never saw: it still pauses the lead. */
const REPLY_LAG_MS = 45 * 60000;      // (no longer used: since 2026-11-03 a reply does not pause a lead)

// ============================================================================
// Clock helpers (a zone's own calendar day, DST-safe)
// ============================================================================
const dayNum = (day) => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const addDays = (day, n) => new Date((dayNum(day) + n) * 864e5).toISOString().slice(0, 10);
const dayOf = (date, tz = ZONE) => tcpa.localDay(new Date(date), tz);
const offsetMs = (date, tz) => {                    // how far `tz` is ahead of UTC at that instant
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date)
    .reduce((o, x) => { if (x.type !== 'literal') o[x.type] = parseInt(x.value, 10); return o; }, {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};
/** The instant a zone's wall clock reads `hh:mm` on `day` (YYYY-MM-DD). */
function instantAt(day, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number); const [y, mo, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);            // a second pass settles a daylight-saving edge
  return new Date(t);
}

// ============================================================================
// Config: the thirteen stages, with the copy each one sends
// ============================================================================
/**
 * → { stages, file, autoDays }: the defaults above, with whatever follow-up-cadence.json says on top ({ "stages": { "d5t4": { "message": "…" }, "d1t1": { "template": "6" } }, "autoDays": 7 }).
 * `autoDays`: the automatic run only works leads whose cadence STARTED within that many days (its first touch, or the day it was harvested / added to the board if it has had none),
 * so switching it on never replays the cadence for a lead first reached weeks ago. Older leads stay on the board, held; `--older` (autoDays: Infinity) includes them. A lead the board texted or emailed, or that replied (not a gift-card complaint), in the last 30 days is never older (see board()).
 */
function loadConfig(file = FILE) {
  const user = readJson(file, {}) || {};
  const over = (user && typeof user.stages === 'object' && user.stages) || {};
  const stages = DEFAULT_STAGES.map((s) => {
    const o = over[s.id] && typeof over[s.id] === 'object' ? over[s.id] : {};
    const out = { ...s };
    for (const k of ['template', 'message', 'afterMin', 'label', 'emailTemplate', 'day', 'byHand', 'byHandSince', 'manual', 'addedSince']) if (o[k] !== undefined) out[k] = o[k];
    if (o.day !== undefined) { const d = Number(o.day); if (Number.isFinite(d) && d >= 0) out.day = d; }      // modular: Board tab can move a stage (e.g. outreach 3 from day 1 → day 5)
    if (o.message) out.template = null;             // a literal message wins over a template id
    return out;
  });
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  return { stages, file, autoDays: num(user.autoDays, 7) };
}

/**
 * What a stage sends: { name, text } for a text, { name, email: true, touch } for an email, or null when no copy is written yet.
 * `templates` = Assistant.js's TEMPLATES ({ id: { name, text } }).
 */
function copyOf(stage, templates = {}, emailSteps = null) {
  if (stage.ch === 'email') {
    if (stage.emailTemplate) {      // this stage sends a named email of email-templates.json (boardRun.js hands the key to the sender as `wantTemplate`); null = it is not written, so the stage is held like a text with no copy
      const nt = namedEmail(stage.emailTemplate);
      return nt ? { name: nt.name || String(stage.emailTemplate), email: true, touch: stage.n, subject: nt.subject, template: String(stage.emailTemplate) } : null;
    }
    const e = emailSteps ? emailSteps[stage.n - 1] : null;
    return { name: e ? e.name : `Email touch ${stage.n}`, email: true, touch: stage.n, subject: e ? e.subject : null };
  }
  if (stage.message) return { name: `${stage.label}`, text: String(stage.message) };
  const t = stage.template != null ? templates[String(stage.template)] : null;
  return t && t.text ? { name: t.name, text: t.text } : null;
}

// ============================================================================
// One lead: where it stands and when its next stage can go out
// ============================================================================
/**
 * lead = { key, name, url, zones, touches: [{ ch: 'text'|'email', at, mode? }], repliedAt?, teammateAt?, optedOut?, excluded?, noEmail? }.
 * (`noEmail`: the email sender already found no address for this lead: its email stages are SKIPPED, listed in `noMail`, so it is never stuck at Email 1 and the texts after it still go out.)
 * env = { copyFor(stage) → has this stage any copy?, gotCopy(lead, stage) → { at } | null: did the lead already get this stage's exact text (so it is done, not sendable) }.
 * → { state: 'finished' | 'paused' | 'held' | 'blocked' | 'due' | 'waiting', done: [stage ids], doneAt: { id: iso }, next: stage | null, nextIdx (0 .. stages.length, the last = finished),
 *     lastAt, lastStage, readyAt (when the gap has passed; null = right now), opensAt (when it can actually go: gap passed AND their window open), dueNow, hold, sentToday: [stage ids] }.
 */
function evaluate(lead, cfg, now = new Date(), env = {}) {
  const stages = cfg.stages;
  const tz = (lead.zones && lead.zones[0]) || ZONE;
  const today = dayOf(now, ZONE);
  // A `--same-day` text (mode 'same-day') is not part of the cadence (Luke: "keep it in the same stage it's at"): it is left out of the counts, of "our last touch" and of "sent today", so the lead stays exactly where it was. The same goes for a `--blast` email (mode 'blast'): a manual one-off the board never counts.
  const real = (lead.touches || []).filter((t) => t && t.at && Number.isFinite(Date.parse(t.at)) && t.mode !== SAME_DAY_MODE && t.mode !== BLAST_MODE).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const hand = real.filter((t) => t.mode === MANUAL_MODE);
  const handAt = hand.length ? hand[0].at : null;

  // The Nth text / email of the lead, in time order. A lead whose Day 1 was done BY HAND has the day's two TEXTS counted whatever he did (the older bot texts and the ones he did by hand count toward them;
  // the missing ones are filled in at that moment). The EMAIL is never filled in: a Day 3 email is touch 2 and needs a touch 1 that was really sent, so a hand lead he did not email still gets Email 1.
  const seq = { text: real.filter((t) => t.ch === 'text').map((t) => ({ at: t.at, virtual: false })), email: real.filter((t) => t.ch === 'email').map((t) => ({ at: t.at, virtual: false })) };
  if (handAt) {
    const handLast = hand[hand.length - 1].at, lastMs = Date.parse(handLast);
    const have = seq.text.filter((e) => Date.parse(e.at) <= lastMs).length;
    for (let i = have; i < 2; i++) seq.text.push({ at: handLast, virtual: true });
    seq.text.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  // A text stage the board does not send (`byHand`: Luke sends it himself; Day 1 · Text 2 is his own `--same-day` text at 2 PM, 2026-11-03) never waits for a text the board will not send: once the lead has had the texts before it, the stage is done, and a
  // text that was never sent (virtual, like a hand-added lead's) is put right after the lead's last text before it, so the lead's later texts count from the stage after it and keep their numbers as they come (the choice does not depend on when they are sent).
  // EXCEPT a lead that had that many texts BEFORE `byHandSince` (the board sent its own Text 2 then): its n-th text IS the stage, as it always was, so a lead that is already in flight keeps the numbering it had. A hand-added lead is left as it is.
  // The same splice serves a stage ADDED later (`addedSince`: Day 2 · Text 3, 2026-11-04), the other way round: a lead that had that many texts BEFORE that instant (the by-hand Text 2 counts as one, and so do the Day 1 texts filled in for a hand-added lead) is past the place where
  // the stage now sits, so a text that was never sent is put in its place and the lead's own texts keep the numbers they had (its third text, the Day 3 text, is still the Day 3 text); a lead with fewer texts then, and every new lead, gets the stage in its order.
  for (const s of stages) {
    if (s.ch !== 'text' || !(s.byHand || s.addedSince) || s.n < 2 || (handAt && !s.addedSince)) continue;
    const k = s.n - 1;
    if (seq.text.length < k) continue;                                                                // the texts before it are not sent yet: those stages come first
    const since = Date.parse(s.byHand ? s.byHandSince : s.addedSince), old = Number.isFinite(since) && seq.text.filter((e) => (s.byHand ? !e.virtual : true) && Date.parse(e.at) < since).length >= s.n;      // old: the lead had that many texts BEFORE the cutover (a byHand stage counts only texts really sent; an added stage also counts the texts a byHand stage before it stands in for, so a lead whose 2nd real text was its Day 3 text keeps that numbering)
    if (s.byHand ? old : !old) continue;      // byHand: those texts keep the numbering they had; added: a lead with fewer texts than this before the stage existed has not passed it, so it gets the stage
    seq.text.splice(k, 0, { at: seq.text[k - 1].at, virtual: true });
  }
  const count = { text: seq.text.length, email: seq.email.length };

  // A stage is done when the lead has had that many texts (emails). One more way: a TEXT stage the lead has not reached by count, whose exact text it already got earlier (the sender would refuse it: never
  // the same text twice), is done by that earlier send: it is not sent, the lead is not stranded in front of it, and its later texts count one stage lower.
  const done = [], doneAt = {}, virtual = new Set(), byCopy = new Set(), noMail = new Set();
  let skipped = 0, skippedMail = 0;
  for (const s of stages) {
    const e = s.ch === 'text' ? seq.text[s.n - 1 - skipped] : seq.email[s.n - 1 - skippedMail];
    if (e) { done.push(s.id); doneAt[s.id] = e.at; if (e.virtual) virtual.add(s.id); continue; }
    if (s.ch === 'email' && lead.noEmail) { done.push(s.id); doneAt[s.id] = null; noMail.add(s.id); continue; }      // nobody to email (the sender found no address): the stage is skipped, never waited for, so the texts after it still go out
    if (s.ch === 'text' && s.byHand) { done.push(s.id); doneAt[s.id] = null; virtual.add(s.id); continue; }      // (byHand) the board never sends it, so it is never "next": a lead with no text yet waits at Text 1 first (the order is strict)
    const g = s.ch === 'text' && env.gotCopy ? env.gotCopy(lead, s) : null;
    if (g) { done.push(s.id); doneAt[s.id] = g.at || null; byCopy.add(s.id); skipped++; continue; }
    const gm = s.ch === 'email' && s.emailTemplate ? gotNamedEmail(lead, s) : null;      // an email stage with its own email that the lead ALREADY got (a one-off, a --blast): the sender would refuse it for ever, so it is done by that earlier send, as a text stage is
    if (gm) { done.push(s.id); doneAt[s.id] = gm.at || null; byCopy.add(s.id); skippedMail++; }
  }
  const nextIdx = stages.findIndex((s) => !done.includes(s.id));
  const next = nextIdx >= 0 ? stages[nextIdx] : null;
  const sentToday = stages.filter((s) => doneAt[s.id] && !virtual.has(s.id) && !byCopy.has(s.id) && dayOf(doneAt[s.id], ZONE) === today).map((s) => s.id);

  // Our last touch, and which stage it was (so the next stage knows how many days apart it must be).
  const lastReal = real.length ? real[real.length - 1] : null;
  const lastAt = lastReal ? lastReal.at : handAt;
  let lastStage = null;
  if (lastReal) {
    const lastMs = Date.parse(lastReal.at), own = stages.filter((s) => s.ch === lastReal.ch && !byCopy.has(s.id));
    const n = seq[lastReal.ch].filter((e) => Date.parse(e.at) <= lastMs).length;      // which text / email of the lead it was
    lastStage = (lastReal.ch === 'email' && stages.find((s) => s.emailTemplate && gotNamedEmail({ touches: [lastReal] }, s))) || own[n - 1] || own[own.length - 1] || null;      /* an email that IS a stage's own named email counts as that stage whatever its place in the lead's count, so the gap to the next stage is the plan's */                            // more touches than stages: the last stage of that kind
  }

  const out = { lead, done, doneAt, viaCopy: [...byCopy], noMail: [...noMail], next, nextIdx: nextIdx >= 0 ? nextIdx : stages.length, lastAt, lastStage: lastStage ? lastStage.id : null, sentToday, count, readyAt: null, opensAt: null, dueNow: false, hold: null, state: 'waiting' };
  if (!next) { out.state = 'finished'; return out; }

  // Held for a reason a person should know about: the stage has no copy yet, or the lead asked us to stop. (A reply and a teammate's text hold nothing: see below.)
  const copy = env.copyFor ? env.copyFor(next) : true;
  if (!copy) { out.state = 'blocked'; out.hold = `no ${next.ch} is written for ${next.label} yet`; }
  const repMs = lead.repliedAt ? Date.parse(lead.repliedAt) : NaN;
  out.repliedAt = Number.isFinite(repMs) ? lead.repliedAt : null;      // (information for the plan and the dashboard: a reply no longer pauses anything)
  if (lead.optedOut) { out.state = 'paused'; out.hold = `asked us to stop (${String(lead.optedOut).slice(0, 60)}): never texted or emailed again on its own`; }
  // A REPLY DOES NOT PAUSE A LEAD (Luke, 2026-11-03: "Do not move pros out of the board cadence unless the reply is that they are not interested ... a lot of people will reply why and then they go ghost so we still need to reach out to them").
  // What takes a lead out is a not-interested reply: optOut.js bans a clear one (the lead is then not on the board at all) and `optedOut` above covers a STOP found in a saved thread. `repliedAt` stays as information (out.repliedAt).
  // A TEAMMATE'S TEXT DOES NOT PAUSE A LEAD EITHER (Luke, 2026-11-04: "for teammate texted, we do not need to pause those from our outreach cadence"). A text stage used to be held right here for 48 hours after a teammate texted the pro
  // (lead.teammateAt: the Shark report's last-SMS stamp, or a saved thread read). It is information now: it still feeds the 🤝 Teammate texted tab and --teammate-texted, and nothing in the cadence reads it. (The sender's report check is off for the board too: boardRun.textOptions.)

  // When the gap since our last touch has passed.
  if (!lastAt) out.readyAt = null;
  else {
    const gapDays = Math.max(0, next.day - (lastStage ? lastStage.day : next.day));
    if (gapDays === 0) out.readyAt = new Date(Date.parse(lastAt) + (next.afterMin || 0) * 60000).toISOString();
    else out.readyAt = instantAt(addDays(dayOf(lastAt, tz), gapDays), '00:00', tz).toISOString();
  }
  const readyMs = out.readyAt ? Date.parse(out.readyAt) : -Infinity;
  const from = new Date(Math.max(readyMs, now.getTime()));
  const openNow = tcpa.checkZones(lead.zones, from).ok;
  const opens = openNow ? from : tcpa.openingFor(lead.zones, from);
  out.opensAt = opens ? opens.toISOString() : null;
  out.dueNow = out.state === 'waiting' && readyMs <= now.getTime() && tcpa.checkZones(lead.zones, now).ok;
  if (out.state === 'waiting' && readyMs <= now.getTime()) out.state = 'due';
  return out;
}

// ============================================================================
// The board's members, read from the log
// ============================================================================
/**
 * Everyone on the follow-up board, each with their touches (from the log), saved time zones, reply and teammate facts. The same people the dashboard board lists: every lead on a list (Shark, LDS, and the 'Email report' / 'Free plan' lists the email runs
 * record: Luke chose to keep those on the board, 2026-10-29) plus the ones added by hand, minus the banned, the closed-won, the current customers and anyone who opted out. A lead nobody has ever contacted and that is on no Shark list
 * (an LDS lead) is on the board but NOT started on its own (`startNewLds`: true starts them too). Each lead carries its industry (`ind`), read once here so the dashboard's picker and the run's `--trade` filter agree.
 * `textLog` = the textLog module (a test passes a fake).
 */
function members({ textLog, now = new Date(), startNewLds = false, holds } = {}) {
  const tl = textLog || require('./textLog');
  const accounts = tl.aggregate();
  const snaps = tl.snapshotMap();
  const have = new Set(accounts.map((a) => k15(a.accountId || '')));
  const synth = [...snaps.values()].filter((sn) => !have.has(k15(sn.id))).map((sn) => ({ accountId: sn.id, accountName: sn.name, accountUrl: sn.url, texts: 0, emails: 0, lastAt: null, touches: [], key: sn.id }));
  // The log can hold ONE account under several spellings of its id (lowercase, mixed case, the 15- and the 18-character form) and aggregate() keeps those apart: merged here, exactly as
  // followupDue does, or an account whose text sits under one spelling and whose email under another would look untouched and be texted AGAIN.
  const merged = new Map(), all = [];
  for (const a of accounts.concat(synth)) {
    const k = k15(a.accountId || '');
    if (!k) { all.push({ ...a, alt: [] }); continue; }
    const m = merged.get(k);
    if (!m) { const first = { ...a, touches: [...(a.touches || [])], alt: [] }; merged.set(k, first); all.push(first); continue; }
    m.touches.push(...(a.touches || [])); m.alt.push(a.key);
    if (String(a.lastAt) > String(m.lastAt)) m.lastAt = a.lastAt;
    if (a.sources) { m.sources = m.sources || {}; for (const [kind, v] of Object.entries(a.sources)) if (!m.sources[kind] || m.sources[kind].at <= v.at) m.sources[kind] = v; }
    if (a.accountId && a.accountId !== String(a.accountId).toLowerCase() && m.accountId === String(m.accountId).toLowerCase()) { m.accountId = a.accountId; m.accountUrl = a.accountUrl || m.accountUrl; }      // keep the properly-cased id
    if (!m.accountName && a.accountName) m.accountName = a.accountName;
  }
  for (const m of merged.values()) m.touches.sort((x, y) => new Date(y.at) - new Date(x.at));
  const bans = tl.readBans(), green = tl.readGreen(), won = tl.readClosedWon(), cust = tl.readCurrentCustomers(), zones = tl.readZones();
  // The industry of a lead, as the dashboard shows it (textLog.indFields): the Salesforce Industry once `email --industry` has read it, else a guess from the business name, else nothing. A test's fake textLog has none.
  const sfInd = typeof tl.readSfIndustry === 'function' ? tl.readSfIndustry() : null;
  const indOf = (nm, id) => { const f = typeof tl.indFields === 'function' ? tl.indFields(nm, id, sfInd) : null; return f && f.ind ? { name: f.ind, src: f.indSrc, weak: !!f.indWeak } : null; };
  // Accounts the email sender already found no address for (email-debug/<id>.json says "no recipient"; a report that gave an address since takes them off): their email stages are skipped (evaluate), or the lead would wait at Email 1 forever and never get its texts after it. A test's fake textLog has none.
  const noMail = typeof tl.noRecipientAccounts === 'function' ? tl.noRecipientAccounts() : new Set();
  // Leads the BOARD ITSELF has already worked: a text it sent (mode 'board') or an email it sent (template 'Follow-up board'). The 7-day window never parks these (while the board touched them in the last 30 days): without that no lead could get past Day 7 of the 60-day drip. A test's fake textLog has no rows.
  const boardLast = new Map();      // account (first 15 characters) → when the board last texted or emailed it
  try { if (typeof tl.readAll === 'function') for (const r of tl.readAll()) if (r && (r.mode === 'board' || r.templateName === 'Follow-up board')) { const k = k15(r.accountId), at = Date.parse(r.at); if (Number.isFinite(at) && at > (boardLast.get(k) || 0)) boardLast.set(k, at); } } catch (_) {}
  const lostKeys = new Set(tl.lostDemoAccounts(accounts).map((l) => String(l.key).toLowerCase()));
  const listsFor = tl.makeListsFor({ members: tl.readListMembership(), plans: tl.readPlans(), lostKeys });
  const notes = tl.readReengageNotes(), reviews = tl.readReviews();
  // The saved reviews and opt-out notes are filed under whatever spelling of the id the run that wrote them used (lowercase, mixed case, 15 or 18 characters): looked up by the first 15, newest first.
  const newest = (rows, idOf) => { const m = new Map(); for (const r of rows) { const k = k15(idOf(r)); if (!k.startsWith('001')) continue; const c = m.get(k); if (!c || Date.parse(r.at) >= Date.parse(c.at)) m.set(k, r); } return m; };
  const reviewK = newest([...reviews.values()], (r) => r.accountId), noteK = newest([...notes.values()], (r) => r.key);
  // The hold inbox: a thread read held a text because the pro replied or a teammate texted (Assistant.js, threadGuard). That is a person's to take, and it is known at once, not when the reply poller catches up.
  let holdRows = holds, holdOptOut = null, me = String(sender.fullName || '').toLowerCase() || '\u0000unset';
  try { const hi = require('./holdInbox'); if (!holdRows) holdRows = hi.readAll(); holdOptOut = hi.OPT_OUT; } catch (_) { holdRows = holdRows || new Map(); }
  try { me = require('./threadReader').ME || me; } catch (_) {}
  const isMe = (sender) => !!sender && String(sender).toLowerCase().includes(me);
  const manual = new Map();
  for (const a of tl.readManualRecords().adds) {
    const k = k15(a.accountId), cur = manual.get(k), one = { id: a.id, at: a.at, on: a.on, did: a.did || [] };
    if (!cur) manual.set(k, { ...one, tags: [...tl.manualTags(a)] });
    else { for (const t of tl.manualTags(a)) if (!cur.tags.includes(t)) cur.tags.push(t); if (String(a.on) >= String(cur.on)) Object.assign(cur, one); }
  }
  // Replies: by account id; the ones the poller could not link to an account (no id: the contact's own name came with the SMS) by exact name or email, when they match a lead on the board.
  const lastReply = new Map(), unlinked = new Map(), giftAsk = new Map();
  for (const r of tl.readReplyRows()) {
    const t = Date.parse(r.at); if (!Number.isFinite(t)) continue;
    if (r.manual && /^\s*\[Top hit list\]/i.test(String(r.reply || ''))) continue;      // Luke's own hit-list notes are not a reply a pro sent
    const k = k15(r.accountId);
    if (k) { if (!lastReply.has(k) || t > lastReply.get(k)) { lastReply.set(k, t); giftAsk.set(k, !!r.gift && !r.interested); } continue; }      // giftAsk: the newest reply is about the gift card and is not interested ("you still owe me that gift card"): a complaint, not a lead answering
    const nm = norm(r.accountName); if (nm.length >= 4 && (!unlinked.has(nm) || t > unlinked.get(nm))) unlinked.set(nm, t);
  }
  const byId = (map, id) => map.get(String(id || '').toLowerCase()) || map.get(k15(id));
  const out = [];
  for (const a of all) {
    const id = a.accountId || a.key;
    if (!id || !k15(id)) continue;
    if (tl.isBanned(id, bans, green) || byId(won, id) || byId(cust, id)) continue;
    const n = notes.get(id) || notes.get(a.key) || noteK.get(k15(id)); if (n && tl.OPT_OUT_RE.test(`${n.stage || ''} ${n.note || ''}`)) continue;
    const rv = reviews.get(id) || reviewK.get(k15(id)); if (rv && rv.verdict === 'skip' && !rv.moot && now.getTime() - Date.parse(rv.at) < 14 * 864e5) continue;
    const kinds = [...new Set([a.key, ...(a.alt || [])].flatMap((k) => listsFor(k, a)).map((l) => l.kind))];
    const m = manual.get(k15(id)) || null;
    const own = m ? m.tags.filter((t) => !tl.MANUAL_TAG_KINDS[t]) : [];
    if (!kinds.length && !own.length) continue;
    const touches = (a.touches || []).map((t) => ({ ch: t.ch, at: t.at, mode: t.mode || null, title: t.title || null }));
    const ownTouches = touches.filter((t) => t.mode !== BLAST_MODE);      // what the board counts: a --blast email is a manual one-off, it neither starts a lead nor says when its cadence began
    const sn = snaps.get(k15(id));
    const name = a.accountName || (sn && sn.name) || '(unnamed account)';
    let tmAt = tl.teammateTexted((sn || {}).sms, (a.touches || []).filter((t) => t.ch !== 'email'), now);
    tmAt = tmAt ? (typeof tmAt === 'string' ? tmAt : 'in the last 48 h') : null;
    // the hold inbox's newest line for this account (anything but 'sent': a check-in that went out is a touch of ours, and the log has it; or 'cleared': holdClear.js, the thread guard no longer holds it)
    const hr = holdRows.get(k15(id)); let holdAt = null, optedOut = null;
    if (hr && hr.status !== 'sent' && hr.status !== 'cleared') {
      const msgs = Array.isArray(hr.messages) ? hr.messages : [], inbound = msgs.filter((x) => x && x.dir === 'in');
      const said = hr.status === 'skipped' ? ((inbound[inbound.length - 1] || {}).body || 'skipped in the hold inbox') : (inbound.find((x) => holdOptOut && holdOptOut.test(x.body || '')) || {}).body;
      if (said) optedOut = String(said).replace(/\s+/g, ' ').trim();
      if (hr.kind === 'replied') holdAt = Date.parse(hr.at);
      else if (hr.kind === 'teammate' && !tmAt) {
        const mate = msgs.filter((x) => x && x.dir === 'out' && x.sender && !isMe(x.sender)).map((x) => Date.parse(x.at)).filter(Number.isFinite).sort((p, q) => q - p)[0];
        if (mate !== undefined && now.getTime() - mate <= 48 * 3600000) tmAt = `at ${new Date(mate).toISOString().slice(0, 16).replace('T', ' ')}Z (read from the thread)`;
      }
    }
    const email = norm(a.email);
    const lr = Math.max(...[lastReply.get(k15(id)), unlinked.get(norm(name)), email.length >= 6 ? unlinked.get(email) : undefined, holdAt].filter(Number.isFinite), -Infinity);
    out.push({
      key: a.key, accountId: id, name, url: a.accountUrl || (sn && sn.url) || null,
      zones: tl.zonesFor(id, zones) || null, kinds, own, hand: m, touches, lastOutgoingSms: sn ? sn.sms || null : null, noEmail: noMail.has(k15(id)), ind: indOf(name, id),      // ind: { name, src: 'sf' | 'guess', weak } or null: what the dashboard's 🏭 picker and `--board --trade` filter on
      enrolledAt: m ? m.at : (ownTouches.length ? ownTouches.map((t) => t.at).sort()[0] : (sn ? sn.firstAt || sn.lastAt || null : null)),      // when its cadence started: put on the board by hand, else its first touch, else the day it was harvested
      repliedAt: Number.isFinite(lr) ? new Date(lr).toISOString() : null, teammateAt: tmAt, optedOut,
      repliedRecent: Number.isFinite(lr) && now.getTime() - lr <= BOARD_ACTIVE_DAYS * 864e5 && !giftAsk.get(k15(id)),      // the lead replied in the last 30 days (a real reply, not a hand note, and not a gift-card complaint): like boardWorked it is never parked as "older", so a pro who answered "why?" and went quiet is still reached (Luke, 2026-11-03: "Yes, include them")
      boardWorked: boardLast.has(k15(id)) && now.getTime() - boardLast.get(k15(id)) <= BOARD_ACTIVE_DAYS * 864e5,      // the board texted or emailed this lead in the last 30 days: it is mid-drip and keeps going past the 7-day window (see board())
      labelOnly: !kinds.length,       // tagged only with a label of his own (#referral): on the board, but not on a list, so nothing goes out on its own
      startable: !!(ownTouches.length || kinds.includes('Shark') || m || startNewLds),
    });
  }
  return out;
}

/**
 * Evaluate every member → [{ ...evaluate(), lead, old }]. Two kinds of lead are shown on the board but never run on their own: one nobody may start (an LDS lead nobody has contacted),
 * and one whose cadence started more than `cfg.autoDays` days ago and that the board itself has never texted or emailed (`old: true`; a reply still shows as 'paused'). A lead the board texted or emailed in the last 30 days, or that replied in the last 30 days (`repliedRecent`; a reply no longer pauses a lead, and a pro who answered "why?" and went quiet is still reached), keeps going whatever its age: the drip runs 60 days.
 */
function board(leads, cfg, now = new Date(), env = {}) {
  const autoDays = cfg.autoDays == null ? 7 : cfg.autoDays;
  return leads.map((l) => {
    const e = evaluate(l, cfg, now, env);
    const open = e.state === 'due' || e.state === 'waiting' || e.state === 'blocked';
    if (!l.startable && open && !e.lastAt) { e.state = 'held'; e.hold = 'an LDS lead nobody has contacted yet: not started on its own'; e.dueNow = false; }
    if (l.labelOnly && open && e.state !== 'held') { e.state = 'held'; e.dueNow = false; e.hold = `only tagged ${(l.own || []).map((t) => '#' + t).join(' ')}: a label, not a list. Nothing goes out on its own (add #shark or #lds to start the cadence)`; }
    const since = l.enrolledAt ? Date.parse(l.enrolledAt) : NaN;
    e.old = Number.isFinite(since) && Number.isFinite(autoDays) && now.getTime() - since > autoDays * 864e5 && !l.boardWorked && !l.repliedRecent;      // (a lead the board has already worked, or that replied in the last 30 days, is never "older": it is mid-drip / engaged)
    if (e.old && open && e.state !== 'held') {
      e.state = 'held'; e.dueNow = false;
      e.hold = `started ${Math.round((now.getTime() - since) / 864e5)} days ago: outside the ${autoDays}-day automatic window`;
    }
    return e;
  });
}

module.exports = { DEFAULT_STAGES, FILE, ZONE, SAME_DAY_MODE, BLAST_MODE, loadConfig, copyOf, evaluate, members, board, instantAt, dayOf, addDays, dayNum, k15 };

if (require.main === module) {
  const cfg = loadConfig();
  console.log(`\n  🗂 THE FOLLOW-UP BOARD — ${cfg.stages.length} stages\n`);
  cfg.stages.forEach((s, i) => console.log(`   ${i + 1}. ${s.label.padEnd(18)} ${s.ch === 'email' ? (s.emailTemplate ? `email "${s.emailTemplate}"` : `email touch ${s.n}`) : (s.message ? 'its own message' : s.template ? `template ${s.template}` : 'NOT WRITTEN YET')}${s.afterMin ? `   (${s.afterMin} min after the touch before)` : ''}${s.byHand ? '   (BY HAND: the board skips it)' : ''}`));
  console.log('\n  Run it with:  email --board --inspect\n');
}
