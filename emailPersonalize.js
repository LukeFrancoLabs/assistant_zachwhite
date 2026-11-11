'use strict';

/**
 * emailPersonalize — fill {{tokens}} in an email subject/body from the ACCOUNT NAME.
 *
 * Account names are messy (SEO-stuffed titles, bare Salesforce ids, personal names, "LLC" glued on),
 * so every token has a fallback and a name is only used when it looks like a real business name.
 *
 *   {{business}}            "Precision Roofing"   (legal suffix stripped; empty if the name is unusable)
 *   {{business|your company}}   fallback text after "|" when the name is unusable
 *   {{firstName}}           "Angel"               (only when the whole name looks like a person's: two plain words, no trade word)
 *   {{industry}}            "roofing & gutters"   (industry.js guess, lower-cased; empty if none)
 *   {{industryBlock}}       the per-industry paragraph/link from email-industry.json ('' if none) — strong industry guesses only
 *   {{greeting}}            "Hi Precision Roofing team," / "Hi Angel," / "Hi,"
 *
 * render() throws if a {{token}} is left unresolved, so a typo can never be emailed.
 * Templates with no tokens come back unchanged.
 */

const fs = require('fs');
const path = require('path');
const industry = require('./industry');

// Per-industry content (email-industry.json, see email-industry.example.json). Read fresh each run; missing file = no industry content.
let _content = null;
function industryContent(reload) {
  if (_content && !reload) return _content;
  try { _content = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-industry.json'), 'utf8')); } catch (_) { _content = {}; }
  return _content;
}

// ── Auto-picked content from the Sales Content Finder snapshot (email-content.json, refresh with `node syncEmailContent.js`) ──
// industry.js label → the finder's trade. Conservative on purpose: a label with no clear match gets the default block, not a guess.
const TRADE_FOR = {
  'HVAC': 'HVAC', 'Plumbing': 'Plumbing', 'Electrical': 'Electrical', 'Cleaning': 'Home Cleaning',
  'Carpet & upholstery cleaning': 'Carpet Cleaning', 'Pressure washing': 'Exterior Cleaning', 'Window cleaning': 'Exterior Cleaning',
  'Landscaping & lawn': 'Landscaping', 'Pest control': 'Pest Control', 'Garage doors': 'Garage Door', 'Handyman & repair': 'Handyman',
  'Painting': 'Painting', 'Concrete & masonry': 'Concrete & Asphalt', 'Chimney & fireplace': 'Fireplace & Chimney', 'Appliance repair': 'Appliance Repair',
};
const MECH = ['HVAC', 'Plumbing', 'Electrical'];
// Best first: a real customer story beats a testimonial beats a trade overview. Edit to taste.
const TYPE_ORDER = ['Case study', 'Testimonial', 'One-pager'];

let _assets = null;
function assets(reload) {
  if (_assets && !reload) return _assets;
  try { _assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-content.json'), 'utf8')).assets || []; } catch (_) { _assets = []; }
  return _assets;
}

/** The best approved, linkable asset for a trade — never one that names a competitor (we don't bring ServiceTitan/Jobber up unprompted). */
function pickAsset(trade) {
  const ok = assets().filter((a) =>
    a.status === 'Approved' && /^https?:\/\//.test(a.url || '') && !a.linkPending && !a.proofPending &&
    TYPE_ORDER.includes(a.type) && !/servicetitan|jobber/i.test(a.competitor || '') &&
    (a.trade === trade || (a.trade === 'Mechanical' && MECH.includes(trade))));
  const rank = (a) => TYPE_ORDER.indexOf(a.type) * 10 + (a.trade === trade ? 0 : 5) + ({ High: 0, Medium: 1 }[a.priority] ?? 2);
  return ok.sort((x, y) => rank(x) - rank(y))[0] || null;
}

/** The customer-facing part of an asset's email: drop "Hi [First name]," the sign-off, [[CTA]], and anything after the link (our template has its own ask). */
function blockFromAsset(a) {
  const paras = String(a.email || '').replace(/\r/g, '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const body = paras.filter((x) => !/^hi\b.*\[first name\]/i.test(x) && !/^best,?\s*\n?\[your name\]/i.test(x) && x !== '[[CTA]]');
  const at = body.findIndex((x) => x.includes('[link]'));
  if (at < 0) return '';
  const out = body.slice(0, at + 1).join('\n\n').replace('[link]', a.url);
  return /\[[^\]]+\]/.test(out) ? '' : out;   // any placeholder left over → refuse rather than email "[First name]"
}

/** { block, asset } for a guessed industry label ('' = unknown). A hand-written entry in email-industry.json beats the auto pick. */
function contentFor(label) {
  const c = industryContent();
  const manual = label && c[label] && String(c[label].block || '').trim();
  const pick = (b, asset) => {
    if (/^EXAMPLE/i.test(b)) throw new Error(`email-industry.json entry for "${label || 'default'}" is still the EXAMPLE placeholder`);
    return { block: b, asset };
  };
  if (manual) return pick(manual, null);
  const a = label && TRADE_FOR[label] ? pickAsset(TRADE_FOR[label]) : null;
  if (a) { const b = blockFromAsset(a); if (b) return { block: b, asset: a }; }
  return pick(String((c.default && c.default.block) || '').trim(), null);
}

/** Just the text (kept for callers/tests that only want the block). */
function blockFor(label) { return contentFor(label).block; }

const LEGAL = /[\s,]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|ltd\.?|l\.?l\.?p\.?|pllc|p\.?c\.?)$/i;
const MAX_NAME = 40;

/** Strip trailing legal suffixes ("Foo Plumbing, LLC" → "Foo Plumbing"), repeatedly. */
function stripLegal(name) {
  let n = String(name || '').trim().replace(/([a-z])(LLC|INC|Inc|Corp)$/, '$1 $2');   // "AirLLC" → "Air LLC"
  for (let i = 0; i < 3 && LEGAL.test(n); i++) n = n.replace(LEGAL, '').trim();
  return n.replace(/[,\s]+$/, '');
}

const SMALL = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'at', 'a', 'an', '&']);
// Well-known acronyms that stay capitalized inside a longer name ("Aps USA", "Smith HVAC") — but never when it
// would leave the whole name in caps, so a lone "HVAC" still becomes "Hvac".
const ACRONYMS = new Set(['usa', 'us', 'hvac', 'ac', 'ai', 'tv', 'rv', 'ev', 'led', 'atv', 'uv', 'diy', 'dfw', 'nyc', 'la', 'dc', 'pc', 'it']);
function titleCase(n) {
  const words = n.toLowerCase().split(/(\s+)/);
  const cap = (w) => w.replace(/(^|[-'])([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
  const out = words.map((w, i) => (i > 0 && SMALL.has(w) ? w : cap(w)));
  const keep = words.map((w, i) => (ACRONYMS.has(w) && words.length > 1 ? w.toUpperCase() : out[i]));
  const letters = keep.filter((w) => /[a-z]/i.test(w));
  return letters.every((w) => w === w.toUpperCase()) ? out.join('') : keep.join('');
}

/** The business name as it should read in a sentence, or '' if it should not be used. */
function businessName(raw) {
  const n = stripLegal(raw);
  if (!n || n.length < 3 || n.length > MAX_NAME) return '';
  if (/^[a-z0-9]{15,18}$/i.test(n)) return '';          // a bare Salesforce id
  if (/[|#@/\\<>{}]|https?:|www\./i.test(n)) return '';   // SEO titles, urls, handles
  if (/^\d/.test(n) && /\d{3,}/.test(n)) return '';       // "24/7"-style phone-ish or numeric junk
  if (/\b(llc|inc)\b/i.test(n.replace(/\s/g, ' ')) && n.split(/\s+/).length < 2) return '';
  if (n === n.toUpperCase() && /[A-Z]/.test(n)) return titleCase(n);   // never shout the whole name, even if it is all caps in Salesforce
  if (n === n.toLowerCase() && (n.length > 5 || n.includes(' '))) return titleCase(n);   // all-lower → tidy; a short lone word is left as typed
  return n;
}

/** First name, only when the whole account name looks like one person ("Angel Aponte"). */
function firstName(raw) {
  const n = stripLegal(raw);
  if (!/^[A-Z][a-z]{1,14} [A-Z][a-z]{1,18}$/.test(n)) return '';
  if (industry.guess(n)) return '';                       // "Apollo Piano" etc. have a trade word → a business, not a person
  return n.split(' ')[0];
}

/** Everything the tokens can say about an account name. */
function profileFor(accountName) {
  const first = firstName(accountName);                  // a person's name is a first name, never "<Name> team"
  const business = first ? '' : businessName(accountName);
  const g = industry.guess(accountName || '');
  const ind = g && !g.weak ? g.industry.toLowerCase() : '';
  let greeting = 'Hi,';
  if (business) greeting = `Hi ${business} team,`;
  else if (first) greeting = `Hi ${first},`;
  return { business, firstName: first, industry: ind, industryLabel: g && !g.weak ? g.industry : '', greeting };
}

/** Fill the tokens in one string. Throws on an unknown token name. */
function fill(text, profile) {
  return String(text == null ? '' : text).replace(/\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g, (m, key, fallback) => {
    if (!Object.prototype.hasOwnProperty.call(profile, key)) throw new Error(`unknown email token {{${key}}}`);
    const v = profile[key];
    return v || (fallback != null ? fallback.trim() : '');
  });
}

/** → { subject, body, profile } for this account. */
function render({ subject, body }, accountName) {
  const profile = profileFor(accountName);
  if (/\{\{\s*industryBlock\b/.test(`${subject}\n${body}`)) { const c = contentFor(profile.industryLabel); profile.industryBlock = ''; profile.industryBlock = fill(c.block, profile); profile.industryAsset = c.asset ? `${c.asset.type}: ${c.asset.title}` : ''; }
  const out = { subject: fill(subject, profile), body: fill(body, profile), profile };
  if (/\{\{|\}\}/.test(out.subject + out.body)) throw new Error('email has an unresolved {{token}} after personalizing');
  // A token that resolved to nothing can leave "Hi  ," or a doubled space; tidy without touching line breaks.
  out.subject = out.subject.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  out.body = out.body.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?])/g, '$1').replace(/\n{3,}/g, '\n\n');   // an empty block must not leave a gap
  return out;
}

/** True when the text uses any {{token}} (so callers can skip work / logging for plain templates). */
function hasTokens(text) { return /\{\{[^}]+\}\}/.test(String(text || '')); }

module.exports = { contentFor, pickAsset, TRADE_FOR, blockFor, industryContent, render, fill, profileFor, businessName, firstName, stripLegal, hasTokens };

// node emailPersonalize.js "Account Name" ["subject" "body"]   → preview, no browser, nothing sent
if (require.main === module) {
  const name = process.argv[2];
  if (!name) { console.error('usage: node emailPersonalize.js "Account Name" ["subject" "body"]'); process.exit(1); }
  const subject = process.argv[3] || 'Is Housecall Pro on your radar, {{business|your team}}?';
  const body = process.argv[4] || require('./sender').apply('{{greeting}}\n\nLuke here. Thought of you as a {{industry|home service}} pro.');
  const r = render({ subject, body }, name);
  console.log(JSON.stringify(r.profile));
  console.log('Subject:', r.subject, '\n\n' + r.body);
}
