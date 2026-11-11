'use strict';

/**
 * emailSequence — a 6-touch email campaign for EARLY-STAGE shops (mostly under 5 people) that need growth tools and systems to
 * scale. Each touch leads with ONE Housecall Pro feature and backs it with a DIFFERENT story or Pro-quotes one-pager, so a contact
 * who hasn't replied sees something new every few days instead of the same pitch.
 *
 *   1  Intro            run the day in one place: scheduling, estimates & invoicing, paid on the spot  (+ the $26 / $100 offer) — Grow & Scale Pro quotes
 *   2  Get organized    mobile app, scheduling, invoicing — off paper, nights and weekends back
 *   3  Never lose a lead   Pipeline + automated follow-up
 *   4  Fill the calendar   Campaigns (email/postcards), reviews, growth
 *   5  Never miss a call   CSR AI answers when you can't
 *   6  Why now          cost of waiting + the offer again (last touch)
 *
 * Stories: the account's OWN trade first (a story for another trade is never used), then an all-trades Pro-quotes / product
 * one-pager, so every touch always has content. Size: unknown sizes are treated as 2-5 (the target), so case studies tagged for
 * 11+ are left out — except those listed in BEGINNER_OK, whose story is about starting small. No asset that names a competitor.
 * Copy is written here from the library's approved proof lines; the library's own emails assume a prior conversation, so they aren't used.
 *
 * Where an account stands is read from the outreach log (email rows; a legacy email with no `step` counts as touch 1; a manual --blast email, mode 'blast', is not a touch). An account is
 * HELD when it replied since our last email, is banned, was emailed < minDays ago, or already got all six touches.
 *
 *   node emailSequence.js "Account Name" [accountId]   → every touch's asset + a preview of the next one (no browser, nothing sent)
 */

const contentPicker = require('./contentPicker');
const personalize = require('./emailPersonalize');
const textLog = require('./textLog');
const fs = require('fs');
const path = require('path');
const sender = require('./sender');      // who this copy emails as (sender.json): the copy below was written by Luke Franco, sender.apply swaps his name / numbers / link for the sender's

const LIBRARY = JSON.parse(fs.readFileSync(path.join(__dirname, 'content-library', 'library.json'), 'utf8'));
const byId = (id) => LIBRARY.find((d) => d.id === id);

const DEFAULT_SIZE = '2-5';                         // the target audience when an account's size isn't known
const BEGINNER_OK = new Set(['delong_sons_hvac']);  // tagged 11+, but the story is a weekend side hustle that grew — fine for a beginner
const OFFER = "$26 for your first month with no contracts, plus a $100 Amazon gift card after your 2nd onboarding session with us";

// What we say about each asset: one sentence taken from its approved `proof`, and the link text. Keyed by library id.
const STORY = {
  onepager_grow_scale: { blurb: "Over 200,000 Pros use Housecall Pro. Here's what four of them say about growing and scaling a business:", label: 'See their stories' },
  first_time_owner: { blurb: 'JaxPowerPro went from $700K in year one to $2M+ on pace, with no added office staff.', label: 'Read the JaxPowerPro story' },
  pro_image_painting: { blurb: 'Pro Image Painting went from a team of 4 on scattered tools to 15+ people running 4-5 projects at once, all on Housecall Pro.', label: 'Read the Pro Image Painting story' },
  landscaping_kopa_start: { blurb: "Tim Allen of Kopa Home Services wishes he'd started on Housecall Pro before his first customer.", label: 'Hear from Kopa Home Services' },
  pest_verikill_ease: { blurb: 'Richard Vail of Verikill Pest Control on how Housecall Pro makes running a small business easier.', label: 'Hear from Verikill Pest Control' },
  onepager_save_time: { blurb: "Here's what four Pros say about getting their nights and weekends back:", label: 'See their stories' },
  delong_sons_hvac: { blurb: 'DeLong and Sons HVAC grew from weekend jobs to $1M+ and a team of 12, with Pipeline handling follow-up and 400+ reviews built on autopilot.', label: 'Read the DeLong and Sons story' },
  beyond_software: { blurb: 'R&J Brothers Electric grew from $500K to $1.2M+ on Housecall Pro.', label: 'Read the R&J Brothers story' },
  customer_bundle_followup: { blurb: 'Plunkett Home Services uses automated follow-up to close jobs he would otherwise miss.', label: 'See how Pipeline works' },
  landscaping_reliable_growth: { blurb: 'Joseph Brown grew Reliable Lawn Services to $450,000 in his second year, crediting most of that growth to Housecall Pro.', label: 'Hear from Reliable Lawn Services' },
  customer_bundle_leads: { blurb: 'Chimney Monkey says the jobs booked through Campaigns paid for a year of it.', label: 'See how Campaigns works' },
  contact_bundle_missedcalls: { blurb: 'Nobility Door put it this way: "somebody\'s getting all the calls I don\'t want to take on a Sunday."', label: 'See how CSR AI works' },
  ai_csr_onepager: { blurb: 'CSR AI books 26% of its jobs after hours.', label: 'See how CSR AI works' },
  cost_of_waiting: { blurb: 'In the 2026 homeowner survey, 72% would pay more for a fix within 24 hours and 62% were more likely to book when financing was offered.', label: 'Read the State of Home Service Spending report' },
};

// `feature` is the touch's message; `ids` are candidates in order (trade stories first, an all-trades fallback last). Every touch carries one hyperlinked asset.
const STEPS = [
  { step: 1, name: 'Intro', subject: 'Is Housecall Pro still on your radar for {{business|your business}}?', ids: ['onepager_grow_scale'],
    lead: "Luke here with Housecall Pro. I wanted to reach back out and see if the timing's any better now.",
    feature: "Housecall Pro puts the day-to-day in one place: scheduling and dispatch, estimates and invoicing, and getting paid on the spot by card, ACH, or financing, all from your phone. Less paperwork, more time on jobs.",
    offer: true, ask: 'Worth a quick look? Reply here, or grab a time that works using the link below.' },
  { step: 2, name: 'Get organized', subject: 'Get your nights and weekends back', ids: ['first_time_owner', 'pro_image_painting', 'landscaping_kopa_start', 'pest_verikill_ease', 'onepager_save_time'],
    feature: "If you're still juggling paper, texts, and a calendar, here's what changes: your schedule, estimates, invoices, and customer messages live in one app on your phone, so nothing falls through the cracks while you're in the field.",
    ask: "Worth a look? Reply here and I'll show you how it would fit your business." },
  { step: 3, name: 'Never lose a lead', subject: 'Stop losing jobs to slow follow-up', ids: ['delong_sons_hvac', 'beyond_software', 'customer_bundle_followup'],
    feature: 'Most small shops lose work not to a competitor, but to a quote that never got a follow-up. Pipeline keeps every inquiry and estimate in one view, and automated follow-ups go out for you.',
    ask: 'Want me to show you how it works on your own estimates?' },
  { step: 4, name: 'Fill the calendar', subject: 'Bring past customers back', ids: ['landscaping_reliable_growth', 'customer_bundle_leads'],
    feature: 'Growing means a steady flow of new and repeat work. Campaigns sends email and postcards to past customers, and automated review requests build the Google reviews that win new ones, without you lifting a finger.',
    ask: 'Happy to set up a first campaign with you. Just reply.' },
  { step: 5, name: 'Never miss a call', subject: 'Who answers when you are on a job?', ids: ['contact_bundle_missedcalls', 'ai_csr_onepager'],
    feature: "When you're under a sink or on a roof, the next customer calls someone else. CSR AI picks up when you can't, answers questions, and books the job so the lead doesn't walk.",
    ask: 'Want to hear how it sounds? Reply and I will set it up.' },
  { step: 6, name: 'Why now', subject: 'Before the next rush', ids: ['cost_of_waiting'], offer: true,
    feature: 'Last one from me. Homeowners are spending, and the shops that are set up before the busy season catch the most of it.',
    ask: 'If the timing is right, reply here or grab a time with the link below, and I will get you started.' },
];
for (const s of STEPS) for (const k of Object.keys(s)) if (typeof s[k] === 'string') s[k] = sender.apply(s[k]);
const DEFAULT_MIN_DAYS = 3;

const usable = (a) => a && a.status === 'Approved' && /^https?:\/\//.test(a.url || '') && !a.linkPending && !a.proofPending;
const key15 = (id) => String(id || '').toLowerCase().slice(0, 15);

/** Where an account stands → { sent: n, lastAt, lastStep, repliedSince }. */
function standing(accountId, { rows = textLog.readAll(), replies = textLog.readReplyRows() } = {}) {
  const mine = rows.filter((r) => r.channel === 'email' && accountId && key15(r.accountId) === key15(accountId)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = mine[mine.length - 1] || null;      // the newest email of ANY kind: it sets the spacing (minDays) and what a reply answers
  const lastStep = mine.filter((r) => r.mode !== 'blast').reduce((m, r) => Math.max(m, r.step || 1), 0);      // a manual --blast email (mode 'blast') is not a touch of the sequence: it never moves a lead on to its next touch
  const repliedSince = !!last && replies.some((r) => r.accountId && key15(r.accountId) === key15(accountId) && String(r.at) > String(last.at));
  return { sent: mine.length, lastAt: last ? last.at : null, lastStep, repliedSince };
}

/** → { step, def } for the next touch, or { hold: 'why' }. `opts.ignoreReplies`: do not hold an account for having replied (the follow-up board: only a not-interested reply takes a lead out, and that is the ban list). */
function nextTouch(accountId, opts = {}) {
  const minDays = opts.minDays != null ? opts.minDays : DEFAULT_MIN_DAYS;
  const maxStep = Math.min(opts.maxStep || STEPS.length, STEPS.length);
  const s = standing(accountId, opts);
  if (s.repliedSince && !opts.ignoreReplies) return { hold: 'replied since our last email — a person should take it from here' };
  const next = s.lastStep + 1;
  if (next > maxStep) return { hold: s.lastStep >= STEPS.length ? 'already got every touch in the sequence' : `already at touch ${s.lastStep}` };
  if (s.lastAt) {
    const days = (Date.now() - new Date(s.lastAt).getTime()) / 864e5;
    if (days < minDays) return { hold: `last email was ${days.toFixed(1)} days ago (waits ${minDays})` };
  }
  return { step: next, def: STEPS[next - 1] };
}

const NAMES_COMPETITOR = (a) => /servicetitan|jobber/i.test(a.competitor || '');   // we never bring a competitor up unprompted
const segmentOk = (seg, size) => !seg || seg === 'All' || (!!size && seg.split('/').map((x) => x.trim()).includes(size));

/** The asset for a touch: the first candidate that is approved + linked, fits the account's trade, fits a small shop, and names no competitor. null for touch 1. */
function assetFor(def, accountName, opts = {}) {
  if (!def.ids) return null;
  const trades = contentPicker.pick(accountName, { size: opts.size, industryText: opts.industryText }).trades;
  const size = opts.size || DEFAULT_SIZE;
  const fits = (a) => usable(a) && !NAMES_COMPETITOR(a) && !a.regionLock && STORY[a.id]
    && (a.trade === 'All' || trades.includes(a.trade))                    // never another trade's story
    && (BEGINNER_OK.has(a.id) || segmentOk(a.segment, size));
  return def.ids.map(byId).find((a) => a && fits(a)) || null;
}

/** → { subject, bodyText, bodyHtml, step, asset, name } for touch `step` (1-6). Signature placeholder is "[Your name]". */
function buildTouch(accountName, step, opts = {}) {
  const def = STEPS[step - 1];
  if (!def) throw new Error(`there is no touch ${step} (the sequence has ${STEPS.length})`);
  const asset = assetFor(def, accountName, opts);
  if (def.ids && !asset) throw new Error(`no usable library asset for touch ${step} (${def.name})`);
  const stage = opts.stage === 'postdemo' ? 'postdemo' : 'demo';
  const profile = personalize.profileFor(accountName);
  const link = asset ? { t: STORY[asset.id].label, href: contentPicker.taggedUrl(asset, stage) } : null;
  const paras = [[{ t: profile.greeting }]];
  if (def.lead) paras.push([{ t: def.lead }]);
  paras.push([{ t: def.feature }]);
  if (asset) paras.push([{ t: STORY[asset.id].blurb + ' ' }, link]);
  if (def.offer) paras.push([{ t: `To make it easy to start, we have our get-started offer: ${OFFER}.` }]);
  paras.push([{ t: def.ask }]);
  paras.push([{ t: 'Best,' }, { br: true }, { t: '[Your name]' }]);
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toText = (q) => q.map((x) => (x.br ? '\n' : x.href ? `\n${x.t}: ${x.href}` : x.t)).join('').replace(/[ \t]+\n/g, '\n');   // plain text: the link goes on its own line after a label, not inside the sentence
  const toHtml = (q) => '<p>' + q.map((x) => (x.br ? '<br>' : x.href ? `<a href="${esc(x.href)}">${esc(x.t)}</a>` : esc(x.t))).join('') + '</p>';
  const subject = personalize.fill(def.subject, profile).replace(/\s+/g, ' ').trim();
  return { subject, bodyText: paras.map(toText).join('\n\n'), bodyHtml: paras.map(toHtml).join(''), step, asset, name: def.name };
}

/** Where every lead stands: { atStep:{0..6:n}, due:{step:n}, held:{why:n}, total } — "atStep" = the highest touch already emailed (0 = never). */
function status(leads, opts = {}) {
  const rows = textLog.readAll(), replies = textLog.readReplyRows();
  const out = { total: leads.length, atStep: {}, due: {}, held: {}, dueIds: {} };
  for (const l of leads) {
    const s = standing(l.accountId, { rows, replies });
    out.atStep[s.lastStep] = (out.atStep[s.lastStep] || 0) + 1;
    const t = nextTouch(l.accountId, { ...opts, rows, replies });
    if (t.hold) { const why = t.hold.replace(/[\d.]+ days ago/, 'N days ago'); out.held[why] = (out.held[why] || 0) + 1; }
    else { out.due[t.step] = (out.due[t.step] || 0) + 1; (out.dueIds[t.step] = out.dueIds[t.step] || []).push(l); }
  }
  return out;
}

module.exports = { status, STEPS, DEFAULT_MIN_DAYS, standing, nextTouch, buildTouch, assetFor };

if (require.main === module) {
  const [name, id] = process.argv.slice(2);
  if (!name) { console.error('usage: node emailSequence.js "Account Name" [accountId]'); process.exit(1); }
  STEPS.forEach((d) => { const a = assetFor(d, name); console.log(`touch ${d.step}  ${d.name.padEnd(18)} ${d.ids ? (a ? a.id : '(NO ASSET)') : '(no link)'}`); });
  const t = id ? nextTouch(id) : { step: 1, def: STEPS[0] };
  console.log(t.hold ? `\nHOLD: ${t.hold}` : `\nnext touch: ${t.step} (${t.def.name})`);
  if (t.step) { const e = buildTouch(name, t.step); console.log('\nSubject:', e.subject, '\n\n' + e.bodyText); }
}
