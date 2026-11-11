'use strict';

/**
 * contentPicker — choose Sales Content Finder assets for an account by TRADE, never across trades, and build the
 * email with hyperlinked text (HTML) plus a plain-text twin.
 *
 * Source: content-library/library.json (pulled from the Sales Content Finder). Links get the same tracking tag the finder adds:
 * utm_campaign=SCF26 + CN (one-pagers/reports) | SP (case studies/testimonials) | PR (press).
 *
 * Rules:
 *   - trade-specific assets are used ONLY when the industry guess maps to that trade (HVAC → HVAC, plumbing → Plumbing, ...).
 *     Mechanical one-pagers also fit HVAC / Plumbing / Electrical. An asset tagged for another trade is never picked.
 *   - an unknown or weak industry guess gets generic ("All" trade) assets only.
 *   - a case study / testimonial with a business-size tag is used only when the size is given and matches.
 *   - press is never used here (it is not a nurture one-pager).
 *
 *   node contentPicker.js "Account Name" [--size 0-1|2-5|6-10|11+] [--postdemo]   → preview, nothing sent, no browser
 */

const fs = require('fs');
const path = require('path');
const industry = require('./industry');
const personalize = require('./emailPersonalize');

const LIBRARY = JSON.parse(fs.readFileSync(path.join(__dirname, 'content-library', 'library.json'), 'utf8'));
const byId = (id) => LIBRARY.find((d) => d.id === id);

// industry.js label → library trade(s). Anything not listed is "no trade match" and gets generic content only.
const TRADE_OF = {
  'HVAC': ['HVAC', 'Mechanical'],
  'Plumbing': ['Plumbing', 'Mechanical'],
  'Electrical': ['Electrical', 'Mechanical'],
  'Landscaping & lawn': ['Landscaping'],
  'Pest control': ['Pest Control'],
  'Painting': ['Painting'],
  'Cleaning': ['Home Cleaning'],
  'Carpet & upholstery cleaning': ['Carpet Cleaning'],
  'Garage doors': ['Garage Door'],
  'Chimney & fireplace': ['Fireplace & Chimney'],
  'Appliance repair': ['Appliance Repair'],
  'Concrete & masonry': ['Concrete & Asphalt'],
  'Pressure washing': ['Exterior Cleaning'],
  'Window cleaning': ['Exterior Cleaning'],
  'Exterior cleaning': ['Exterior Cleaning'],
  'Handyman & repair': ['Handyman'],
};

const SIZE_ONEPAGER = { '0-1': 'onepager_size_owner', '2-5': 'onepager_size_2_5', '6-10': 'onepager_size_6_10', '11+': 'onepager_size_11plus' };
const GENERIC_ONEPAGER = 'onepager_save_time';
const TRACK_TOKEN = 'SCF26';
const CTA = {
  demo: 'Want to see it in action? Book a demo or start a free trial.',
  postdemo: "Reach out and I'll get you set up.",
};

function trackBucket(a) { const t = (a.type || '').toLowerCase(); if (t === 'press') return 'PR'; if (t === 'case study' || t === 'testimonial') return 'SP'; return 'CN'; }
function assetUrl(a, stage) { return (stage === 'postdemo' && a.urlNoRep) ? a.urlNoRep : a.url; }
function taggedUrl(a, stage) { const u = assetUrl(a, stage); return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'utm_campaign=' + TRACK_TOKEN + trackBucket(a); }

/** Does a segment tag ("2-5 / 6-10", "11+ / franchise", "All", "") fit this size? Empty/All fits anyone. */
function segmentFits(seg, size) {
  if (!seg || seg === 'All') return true;
  if (!size) return false;
  return seg.split('/').map((s) => s.trim()).includes(size);
}

/** Link text for an asset, taken from the library's own wording where it has some. */
function linkText(a) {
  if (a.type === 'One-pager' || a.type === 'Report') {
    const m = /Here's (what [^\n]*?)(?::|\.)?\s*\n\[link\]/.exec(a.email || '');
    if (m) return m[1];
    return a.title.replace(/ one-pager$/i, '');
  }
  if (a.type === 'Case study') return `Read the ${a.title.replace(/ case study$/i, '')} story`;
  if (a.type === 'Testimonial') return `Hear from ${a.title.split(' — ')[0]}`;
  return a.title;
}

/**
 * → { label, trades, assets:[asset], notes:[why] } for an account name.
 * opts: { size, stage }  (stage 'demo' = pre-demo CTA/links, 'postdemo')
 */
function pick(accountName, opts = {}) {
  const size = opts.size || '';
  // The account's own Salesforce Industry (when read) beats a guess from the business name.
  // "Exterior cleaning" and friends must not fall into industry.js's generic Cleaning rule (that is the HOME-cleaning trade).
  const EXTERIOR = /\bexterior\b.*\bclean|\bclean\w*\b.*\bexterior|\bhouse ?wash|\bgutter clean/i;
  const g = EXTERIOR.test(opts.industryText || '') ? { industry: 'Exterior cleaning', why: 'exterior', weak: false }
    : (opts.industryText && industry.guess(opts.industryText)) || (EXTERIOR.test(accountName || '') ? { industry: 'Exterior cleaning', why: 'exterior', weak: false } : industry.guess(accountName || ''));
  const label = g && !g.weak ? g.industry : '';
  const trades = (label && TRADE_OF[label]) || [];
  const notes = [];
  const assets = [];
  const add = (id, why) => { const a = byId(id); if (a && !assets.includes(a)) { assets.push(a); notes.push(`${id}: ${why}`); } };

  if (trades.length) {
    const tradeOnePager = LIBRARY.find((d) => d.type === 'One-pager' && [].concat(d.need).includes('proof') && d.trade === trades[0] && /^onepager_/.test(d.id));
    const mech = LIBRARY.find((d) => d.id === 'onepager_mechanical' && trades.includes('Mechanical'));
    if (tradeOnePager) add(tradeOnePager.id, `${trades[0]} one-pager (industry: ${label})`);
    else if (mech) add(mech.id, `Mechanical one-pager (industry: ${label})`);
    if (size && SIZE_ONEPAGER[size]) add(SIZE_ONEPAGER[size], `size ${size} one-pager`);
    // One trade proof piece: a case study/testimonial for THIS trade whose size tag fits (no tag = fits anyone). Region tags are ignored (sizes matter more).
    const proof = LIBRARY.find((d) => (d.type === 'Case study' || d.type === 'Testimonial')
      && trades.includes(d.trade) && segmentFits(d.segment, size) && !d.regionLock);
    if (proof) add(proof.id, `${proof.trade} ${proof.type.toLowerCase()} (size fits)`);
    else notes.push(`no ${trades[0]} case study/testimonial fits${size ? ' size ' + size : ' (size unknown)'}; one-pager only`);
  } else {
    notes.push(label ? `industry "${label}" has no matching library trade → generic content only` : 'industry unknown or weak guess → generic content only');
    if (size && SIZE_ONEPAGER[size]) add(SIZE_ONEPAGER[size], `size ${size} one-pager (generic)`);
    add(GENERIC_ONEPAGER, 'generic one-pager (all trades)');
  }

  // Hard guard: never let another trade's asset through.
  for (const a of assets) {
    if (a.trade !== 'All' && !trades.includes(a.trade)) throw new Error(`contentPicker: ${a.id} is a ${a.trade} asset but this account is "${label || 'unknown'}"`);
  }
  return { label, trades, assets, notes, guess: g };
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build { subject, bodyText, bodyHtml, picked } for an account. */
function buildEmail(accountName, opts = {}) {
  const stage = opts.stage === 'postdemo' ? 'postdemo' : 'demo';
  const picked = pick(accountName, opts);
  const profile = personalize.profileFor(accountName);
  const [first, ...rest] = picked.assets;
  const story = first.type === 'Case study' || first.type === 'Testimonial';
  const lead = story ? "Here's a story from a pro in your trade:" : "Over 200,000 Pros use Housecall Pro. Here's";
  const seg1 = [{ t: `${lead} ` }, { t: linkText(first), href: taggedUrl(first, stage) }, { t: '.' }];
  const paras = [[{ t: profile.greeting }], seg1];
  if (rest.length) {
    const r = rest[0];
    const intro = r.type === 'Case study' || r.type === 'Testimonial' ? "And here's a story from your trade: " : 'And one more: ';
    paras.push([{ t: intro }, { t: linkText(r), href: taggedUrl(r, stage) }, { t: '.' }]);
  }
  paras.push([{ t: `${CTA[stage]}` }]);
  paras.push([{ t: 'Best,' }, { br: true }, { t: '[Your name]' }]);
  const toText = (p) => p.map((s) => (s.br ? '\n' : s.href ? `${s.t} (${s.href})` : s.t)).join('');
  const toHtml = (p) => '<p>' + p.map((s) => (s.br ? '<br>' : s.href ? `<a href="${escHtml(s.href)}">${escHtml(s.t)}</a>` : escHtml(s.t))).join('') + '</p>';
  return {
    subject: picked.trades.length ? `Housecall Pro for ${picked.label} pros` : 'Housecall Pro: what other Pros say',
    bodyText: paras.map(toText).join('\n\n'),
    bodyHtml: paras.map(toHtml).join(''),
    picked,
    stage,
  };
}

module.exports = { pick, buildEmail, taggedUrl, linkText, TRADE_OF };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
  const name = args.find((a) => !a.startsWith('--') && a !== flag('--size'));
  if (!name) { console.error('usage: node contentPicker.js "Account Name" [--size 0-1|2-5|6-10|11+] [--postdemo]'); process.exit(1); }
  const e = buildEmail(name, { size: flag('--size'), stage: args.includes('--postdemo') ? 'postdemo' : 'demo' });
  console.log(`industry: ${e.picked.label || '(unknown)'}${e.picked.guess ? ` (matched "${e.picked.guess.why}")` : ''}`);
  console.log(e.picked.notes.map((n) => '  - ' + n).join('\n'));
  console.log('\nSubject:', e.subject, '\n\n' + e.bodyText);
}
