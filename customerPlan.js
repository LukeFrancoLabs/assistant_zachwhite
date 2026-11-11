'use strict';

/**
 * customerPlan — is an "Enrolled" account a REAL customer, or only on the free Invoicing and Payments plan?
 *
 * Salesforce's "Customer Status (beta)" starts with "Enrolled" for every account that signed up for anything, and the FREE Invoicing and Payments sign-up
 * counts: those pros pay nothing and are still ours to sell. Luke's rule (2026-10-27), read off the account's Closed Won opportunities:
 *
 *   a Closed Won opportunity that is NOT Invoicing and Payments              → a real customer: held back, never emailed     (verdict 'customer')
 *   every Closed Won opportunity is Invoicing and Payments (usually the only one) → free plan: NOT a customer, outreach as usual (verdict 'free-plan')
 *   no Closed Won opportunity at all, or a page that could not be read       → nothing shows it is free: stays held         (verdict 'unknown')
 *   an account Luke released by hand (customerRelease.js, "that one is a cancellation") → 'free-plan' with `released: true`, nothing read from the page
 *
 * It fails closed. An opportunity counts as Invoicing and Payments only when the page SAYS so: the opportunity's name (or a "-" part of it), a field value, a
 * product or a list cell that is that phrase and nothing else. A sentence in a note or the activity timeline ("the demo covered invoicing and payments") never counts.
 * Whatever was read is kept with the verdict (`closedWon[].fields`) and shown on the dashboard's 🤝 tab, so a layout this does not read yet shows up in one run.
 *
 * READ-ONLY: it opens the account's Opportunities list and each Closed Won opportunity's page and reads; nothing is clicked, typed or saved in Salesforce.
 * The opportunity pages replace the account page: the caller (emailAccount.js) puts the account page back.
 *
 * checkAccount(page, { accountId }) → {
 *   verdict,    // 'customer' | 'free-plan' | 'unknown'
 *   why,        // one line for the log and the dashboard
 *   retry,      // true: something could not be read, so the next run should look again
 *   closedWon,  // the Closed Won opportunities looked at, newest first: { id, name, closeDate, owner, ip, via, read, fields:['Label: value'] }
 *   subs, legacy, // the account card's "Active Subscription(s)" / "Core SaaS Subscription (Legacy)" (evidence only; never decides)
 *   record,     // what to save in current-customers.jsonl next to the status (no `verdict` when `retry`: that account is looked at again next time)
 *   released,   // true only for a hand release (customerRelease.js)
 * }
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));    // eslint-disable-line no-unused-vars
const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const MAX_OPPS = 5;       // Closed Won opportunities read per account, newest first. With more than that "all of them are Invoicing and Payments" cannot be shown: stays held.

/** "Invoicing and Payments" and nothing else: tolerates "&" / "+" / "/", plural, a leading "Free" or "Housecall Pro", a trailing "(free)" / "plan". */
const IP_RE = /^(?:housecall pro )?(?:free )?invoic\w* (?:and )?payments?(?: (?:free|plan|only|product|subscription|legacy|account))*$/;
function isInvoicingAndPayments(value) {
  const s = norm(value);
  if (!s || s.length > 80) return false;                              // a field value, never a paragraph
  return s.split(/\s*(?:;|\n|·|•|\|)\s*/).some((seg) => IP_RE.test(seg.toLowerCase().replace(/[&+/]/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()));
}
/** An opportunity NAME is that phrase, or has it as one "-" / ":" / "|" separated part ("Acme Plumbing - Invoicing and Payments"). */
function nameIsInvoicingAndPayments(name) {
  return norm(name).split(/\s*[-–—:|]\s*/).some(isInvoicingAndPayments);
}

/**
 * Runs in the page: the short visible texts of the open record (field values, product names, list cells), through shadow roots, WITHOUT anything inside the
 * activity timeline, notes, feed or rich text (free text, where a rep writes sentences). Leaf elements only, at most 80 characters each.
 */
function pageTexts(page) {
  return page.evaluate(() => {
    const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    const FREE_TEXT = /timeline|rich-?text|chatter|feed|note|ql-editor|cke_|comment/i;
    const out = []; const seen = new Set();
    const inFreeText = (el) => {
      for (let p = el; p;) {
        const cls = typeof p.className === 'string' ? p.className : ((p.getAttribute && p.getAttribute('class')) || '');
        if (FREE_TEXT.test(`${p.tagName || ''} ${cls}`)) return true;
        const up = p.parentNode; p = up && up.nodeType === 11 ? up.host : up;
      }
      return false;
    };
    (function walk(root) {
      root.querySelectorAll('*').forEach((e) => {
        if (e.shadowRoot) walk(e.shadowRoot);
        if (e.children.length || /^(SCRIPT|STYLE|BUTTON|OPTION|SVG|PATH|TITLE)$/i.test(e.tagName)) return;
        const t = norm(e.textContent);
        if (!t || t.length > 80 || seen.has(t) || inFreeText(e)) return;
        seen.add(t); out.push(t);
      });
    })(document);
    return out.slice(0, 1500);
  }).catch(() => []);
}

/** One Closed Won opportunity: is it Invoicing and Payments? Opens its page unless the name already says so. → { id, name, closeDate, owner, ip, via, read, fields } */
async function inspectOpp(page, o, { sfReview, scan = pageTexts }) {
  const ev = { id: o.id || null, name: norm(o.name), closeDate: norm(o.closeDate), owner: norm(o.owner), ip: false, coaching: false, via: null, read: false, fields: [] };
  if (nameIsInvoicingAndPayments(o.name)) { ev.ip = true; ev.via = 'opportunity name'; ev.read = true; return ev; }
  if (nameIsCoaching(o.name)) { ev.coaching = true; ev.via = 'opportunity name (business coaching)'; ev.read = true; return ev; }
  if (!o.id) return ev;                                              // nothing to open: cannot tell
  let det = null;
  try { det = await sfReview.readOppDetail(page, o.id); } catch (_) { det = null; }
  const fields = (det && det.fields) || {};
  const labels = Object.keys(fields);
  // What decides a plan (product, amount, record type, campaign) goes first, so the 14 kept for the dashboard always include it.
  const KEY = /product|amount|record type|campaign|package|plan/i;
  const ordered = [...labels.filter((l) => KEY.test(l)), ...labels.filter((l) => !KEY.test(l))];
  ev.fields = ordered.slice(0, 14).map((l) => `${norm(l).slice(0, 40)}: ${norm(fields[l]).slice(0, 60)}`);
  ev.read = labels.length > 0;
  if (!ev.owner && det && det.owner) ev.owner = norm(det.owner);
  for (const l of labels) if (isInvoicingAndPayments(fields[l])) { ev.ip = true; ev.via = `field "${norm(l).slice(0, 40)}"`; break; }
  if (!ev.ip) for (const l of labels) if (isInvoicingAndPayments(l) && /^(true|yes|y|checked|✓)$/i.test(norm(fields[l]))) { ev.ip = true; ev.via = `checkbox "${norm(l).slice(0, 40)}"`; break; }
  if (!ev.ip) for (const l of labels) if (valueIsCoaching(fields[l], l)) { ev.coaching = true; ev.via = `field "${norm(l).slice(0, 40)}" (business coaching)`; break; }
  if (!ev.ip && !ev.coaching) for (const l of labels) if (familyIsCoaching(l, fields[l])) { ev.coaching = true; ev.via = `field "${norm(l).slice(0, 40)}" (business coaching: ${norm(fields[l]).slice(0, 40)})`; break; }
  if (!ev.ip && !ev.coaching) {
    const texts = await scan(page);
    if (texts.length) ev.read = true;
    const hit = texts.find(isInvoicingAndPayments);
    if (hit) { ev.ip = true; ev.via = `opportunity page: "${hit}"`; }
    else { const ch = texts.find((t) => valueIsCoaching(t)); if (ch) { ev.coaching = true; ev.via = `opportunity page: "${ch}" (business coaching)`; } }
  }
  return ev;
}

/**
 * BUSINESS COACHING (Luke, 2026-10-28): a Closed Won opportunity for one of our coaching products — Foundation, Group, Solo, Solo Plus, Growth Workshop (usually an
 * upsell, so its name starts with "UPS"). Same fail-closed reading as Invoicing and Payments, with one extra guard (those words are common): a bare product word counts only
 * on the opportunity NAME after a "UPS" prefix, in a product / package / plan field, or in a short text that also says "coaching" or starts with "UPS".
 * 2026-10-29 evening: Luke wants those accounts MARKED (verdict 'coaching', the 🎓 mark) but HELD as true current customers until he says otherwise (coachingPolicy.js): they are
 * found here exactly as before, and every outreach path keeps them out. The products as Salesforce lists them also include "Foundations (weekly)" and "Group Plus", and the
 * Product Families of all of them read "Conquer": both count.
 */
const COACH_PRODUCTS = new Set(['foundation', 'group', 'group plus', 'solo', 'solo plus', 'growth workshop']);
function coachingProduct(value) {
  const s = norm(value);
  if (!s || s.length > 80) return null;
  for (const seg of s.split(/\s*(?:;|\n|·|•|\|)\s*/)) {
    let t = seg.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const ups = /^ups\b/.test(t); t = t.replace(/^ups\s+/, '');
    const coach = /\bcoaching\b/.test(t); t = t.replace(/^(?:hcp |housecall pro )?(?:business |pro )?coaching\s+/, '').replace(/(?: (?:coaching|program|package|plan|product|subscription|workshop(?= ))+)+$/, (m) => (/workshop/.test(m) ? m : '')).trim();
    t = t.replace(/ (?:weekly|biweekly|monthly|quarterly|annual|annually|yearly)$/, '').replace(/^foundations$/, 'foundation');      // "Foundations (weekly)" is the Foundation product
    if (COACH_PRODUCTS.has(t)) return { product: t, ups, coach };
  }
  return null;
}
/** The opportunity NAME: "UPS - Acme Plumbing - Solo Plus" / "Acme - Business Coaching Group": a product part after a UPS prefix, or one that says coaching. */
function nameIsCoaching(name) {
  const n = norm(name); const ups = /^\s*ups\b/i.test(n);
  return n.split(/\s*[-–—:|]\s*/).some((part) => { const c = coachingProduct(part); return !!c && (ups || c.ups || c.coach); });
}
/** A value read off the opportunity page: bare product word only when the label says product/package/plan; otherwise it must say coaching or start with UPS. */
function valueIsCoaching(value, label = '') {
  const c = coachingProduct(value);
  return !!c && (c.ups || c.coach || /product|package|plan|offering|subscription|solution/i.test(label));
}
/** The Salesforce field "Product Families on this Opp" of the coaching products reads "Conquer" (every Foundations / Group Plus upsell read so far carries it). */
function familyIsCoaching(label, value) {
  return /famil/i.test(norm(label)) && norm(value).split(/\s*[;,|]\s*/).some((v) => /^conquer$/i.test(v));
}
/**
 * A SAVED evidence entry (current-customers.jsonl `closedWon[]`: { name, coaching, fields: ["Label: value"] }) → is it a business coaching opportunity? It marks accounts the plan check
 * read before it knew every coaching product ("Foundations (weekly)", "Group Plus", the Conquer family), without opening Salesforce again. Pure.
 */
function entryIsCoaching(e) {
  if (!e) return false;
  if (e.coaching === true || nameIsCoaching(e.name)) return true;
  return (Array.isArray(e.fields) ? e.fields : []).some((f) => {
    const m = String(f).match(/^([^:]{1,60}):\s*(.*)$/);
    return !!m && (valueIsCoaching(m[2], m[1]) || familyIsCoaching(m[1], m[2]));
  });
}

const dayOf = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
const label = (e) => `"${e.name || '(unnamed)'}"${e.owner || e.closeDate ? ` (${[e.owner, e.closeDate].filter(Boolean).join(', ')})` : ''}`;

/** The verdict for an account whose Customer Status already says "Enrolled", from its Closed Won opportunities. `deps` is for tests: { sfReview, readOverview, scan }. */
async function checkAccount(page, { accountId }, deps = {}) {
  const sfReview = deps.sfReview || require('./salesforceReview');
  const CLOSED_WON_RE = sfReview.CLOSED_WON_RE || /closed[\s_/-]*won/i;
  const res = { at: new Date().toISOString(), verdict: 'unknown', why: '', retry: false, closedWon: [], subs: null, legacy: null, record: {} };
  const finish = (verdict, why, retry = false) => {
    Object.assign(res, { verdict, why, retry });
    res.record = {
      verdict: verdict === 'unknown' ? (retry ? undefined : 'customer') : verdict,       // unread → no verdict: it is looked at again; "no Closed Won opportunity" is a stable hold
      why, checkedAt: res.at, subs: res.subs, legacy: res.legacy,
      closedWon: res.closedWon.map((e) => ({ id: e.id, name: e.name, closeDate: e.closeDate, owner: e.owner, ip: e.ip, coaching: !!e.coaching, via: e.via, read: e.read, fields: e.fields })),
    };
    return res;
  };

  // A hand release (customerRelease.js: "that one is a cancellation"): Salesforce still says Enrolled with a real Closed Won, so every look would hold the account again. A listed account is 'free-plan' (the verdict every
  // path already treats as "not a customer, outreach as usual") and `released: true` says why; nothing is read from the page.
  try {
    const rel = (deps.released || ((id) => require('./customerRelease').find(id)))(accountId);
    if (rel) { const r = finish('free-plan', `released by hand (${rel.by || 'someone'},${String(rel.at || '').slice(0, 10)}): ${rel.why || 'not a current customer'}`); r.released = true; return r; }
  } catch (_) {}

  // The account card (already on screen; evidence only — "Active Subscription(s)" showed Core SaaS on an expired trial, so it never decides).
  try {
    const ov = await (deps.readOverview || require('./accountOverview').readOverview)(page, { tries: 1 });
    const g = (re) => { const v = ov.get(re); return v ? norm(v).slice(0, 80) : null; };
    res.subs = g(/^active subscription/); res.legacy = g(/^core saas subscription/);
  } catch (_) {}

  let read;
  try { read = await sfReview.readOpportunities(page, accountId); } catch (e) { read = { ok: false, opps: [], note: e.message }; }
  if (!read || !read.ok) return finish('unknown', `the opportunities could not be read (${(read && read.note) || 'no list'}), so the hold stands`, true);

  const wonAll = (read.opps || []).filter((o) => CLOSED_WON_RE.test(o.stage || '')).sort((a, b) => (Date.parse(b.closeDate) || 0) - (Date.parse(a.closeDate) || 0));
  if (!wonAll.length) return finish('unknown', 'Customer Status says Enrolled but the account has no Closed Won opportunity, so nothing shows it is free');

  for (const o of wonAll.slice(0, MAX_OPPS)) {
    const ev = await inspectOpp(page, o, { sfReview, scan: deps.scan });
    res.closedWon.push(ev);
    if (!ev.ip && !ev.coaching) break;                               // one Closed Won opportunity that is neither Invoicing and Payments nor business coaching settles it
  }
  const last = res.closedWon[res.closedWon.length - 1];
  if (!last.ip && !last.coaching) {
    if (!last.read) return finish('unknown', `the Closed Won opportunity ${label(last)} could not be read, so the hold stands`, true);
    return finish('customer', `Closed Won and not Invoicing and Payments or business coaching: ${label(last)}`);
  }
  if (wonAll.length > res.closedWon.length) return finish('unknown', `${wonAll.length} Closed Won opportunities (only the newest ${MAX_OPPS} were read), so the hold stands`);
  const n = res.closedWon.length;
  if (res.closedWon.some((e) => e.coaching)) return finish('coaching', n === 1
    ? `its only Closed Won opportunity ${label(last)} is a business coaching product (${last.via})`
    : `all ${n} of its Closed Won opportunities are Invoicing and Payments or business coaching (${res.closedWon.map((e) => (e.coaching ? 'coaching ' : '') + (dayOf(e.closeDate) || '?')).join(', ')})`);
  return finish('free-plan', n === 1
    ? `its only Closed Won opportunity ${label(last)} is Invoicing and Payments (${last.via})`
    : `all ${n} of its Closed Won opportunities are Invoicing and Payments (${res.closedWon.map((e) => dayOf(e.closeDate) || '?').join(', ')})`);
}

module.exports = { coachingProduct, nameIsCoaching, valueIsCoaching, familyIsCoaching, entryIsCoaching, checkAccount, isInvoicingAndPayments, nameIsInvoicingAndPayments, inspectOpp, pageTexts, MAX_OPPS };
