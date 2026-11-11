'use strict';

/**
 * accountIndustry — read the account SUMMARY off a Salesforce Account page: its "Industry" (so the dashboard can show the
 * real industry instead of a guess from the business name) and its "Timezone" (so a pro can be texted inside THEIR hours),
 * both from the same page visit. READ-ONLY: it opens the account's record page and reads; it sends nothing and changes
 * nothing. The only thing it ever clicks is the page's own "Details" tab, and only when the Industry field is not already on screen.
 *
 * We don't control that page's markup (Lightning layout items, shadow DOM, a custom "Summary" card), so the label
 * is found by its TEXT and the value is whatever sits right after it in the same group. Every answer says how it
 * was found (`via`), and `email --industry --dry-run` prints what the page offered, so a layout we don't read
 * yet shows up in one run.
 *
 * readIndustry(page, accountId) → {
 *   ok,                // false: the page could not be read (not saved; the account is retried on the next run)
 *   industry,          // the value, or null
 *   blank,             // true: the field is on the page and Salesforce has nothing in it
 *   miss,              // true: the page rendered but has no Industry field at all (not saved as an answer; two misses stop the retries)
 *   unavailable,       // true: the account page is gone (deleted / merged / no access)
 *   timezone,          // the account's "Timezone" as the page words it ("Mountain", "Eastern" …), or null when the page has none
 *   via, note, labels, industryLabels, html, tab, ms
 * }
 */

const sfId = require('./sfId');
const sfReview = require('./salesforceReview');
const SF_HOST = 'housecallpro.lightning.force.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs INSIDE the page (so it must not use anything from this file). Looks, through every shadow root, for texts that say "Industry" /
 * "Timezone" (`spec` = { key: { label, inline } } as regex sources) and reads what follows each.
 * → { byKey:{ industry:[match], timezone:[match] }, matches (= byKey.industry), labels:[…], summarySeen, bodyLen, unavailable, loggedOut }
 *   match = { kind:'value'|'blank'|'ambiguous', value?, how, html }
 */
function scanForLabels(spec) {
  spec = spec || { industry: { label: '^industry\\s*:?$', inline: '^industry\\s*[:：]\\s*(\\S.*)$' }, timezone: { label: '^time\\s*-?\\s*zone\\s*:?$', inline: '^time\\s*-?\\s*zone\\s*[:：]\\s*(\\S.*)$' } };
  const targets = Object.keys(spec).map((key) => ({ key, label: new RegExp(spec[key].label, 'i'), inline: new RegExp(spec[key].inline, 'i') }));
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const SUMMARY = /^(account admin login email|org id|org\/billing|primary poc|time\s*-?\s*zone|industry)\s*:?$/i;   // labels of the account's summary panel
  const NOT_VALUE = /^(edit( industry| time ?zone)?|change|preview|--\s*none\s*--|none|n\/a|—|–|-|--|\.\.\.)$/i;
  // another field's label: a blank field must not pick up the NEXT field
  const OTHER_LABEL = /^(account (name|owner|number|site|source|type|status|id|record type)|account admin login email|admin login email|primary poc|primary contact|org id|org\/billing|industry|time\s*-?\s*zone|type|rating|phone|fax|website|employees|annual revenue|billing( address| city| state| street| zip| postal code| country)?|shipping( address| city| state| street| zip| postal code| country)?|description|parent account|owner|created by|last modified by|ownership|ticker symbol|sic( code)?|naics( code)?|customer priority|sla|upsell opportunity|number of locations)$/i;
  const SKIP_EL = /^(BUTTON|OPTION|SELECT|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|THEAD|LIGHTNING-BUTTON|LIGHTNING-BUTTON-ICON|LIGHTNING-DATATABLE|LIGHTNING-COMBOBOX|LIGHTNING-BUTTON-MENU)$/;
  const CHROME_EL = /^(BUTTON|SVG|IMG|I|BR|HR|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LIGHTNING-HELPTEXT|LIGHTNING-ICON|LIGHTNING-BUTTON-ICON|LIGHTNING-BUTTON|LIGHTNING-PRIMITIVE-ICON)$/;
  const SKIP_ROLE = /^(columnheader|button|option|menuitem|tab|listbox|combobox|menu)$/i;
  const up = (n) => { const p = n.parentNode; return !p ? null : (p.nodeType === 11 && p.host ? p.host : p); };
  const cls = (e) => (e.className && e.className.baseVal === undefined ? String(e.className) : '');

  // the visible text pieces inside a node — through shadow roots and <slot>s (innerText stops at a shadow boundary), without buttons and assistive text
  const pieces = (n, out = []) => {
    if (n.nodeType === 3) { const t = norm(n.nodeValue); if (t) out.push(t); return out; }
    if (n.nodeType !== 1) return out;
    const tag = String(n.tagName).toUpperCase();
    if (CHROME_EL.test(tag) || /assistive/.test(cls(n))) return out;
    if (tag === 'SLOT') { const a = n.assignedNodes ? n.assignedNodes({ flatten: true }) : []; (a.length ? a : Array.from(n.childNodes)).forEach((c) => pieces(c, out)); return out; }
    if (n.shadowRoot) { Array.from(n.shadowRoot.childNodes).forEach((c) => pieces(c, out)); return out; }
    Array.from(n.childNodes).forEach((c) => pieces(c, out));
    return out;
  };

  // every shadow root on the page (Lightning's synthetic shadow exposes its roots too)
  const roots = [document];
  (function collect(r) { r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) { roots.push(e.shadowRoot); collect(e.shadowRoot); } }); })(document);

  const blocked = (n) => {   // a column header, a button, a dropdown option… (not a field label)
    let a = up(n);
    for (let i = 0; a && a.nodeType === 1 && i < 14; a = up(a), i++) {
      if (SKIP_EL.test(a.tagName) || SKIP_ROLE.test(a.getAttribute('role') || '') || a.getAttribute('aria-hidden') === 'true') return true;
      if (a.tagName === 'TH' && /^col/i.test(a.getAttribute('scope') || '')) return true;
    }
    return false;
  };
  const shown = (n) => {
    const p = n.parentNode; const el = p && p.nodeType === 1 ? p : (p && p.host) || null;
    if (!el) return false;
    try { const b = el.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (_) { return true; }
  };
  // What follows the label: the first thing after it in its own group; a label with no neighbour looks at the neighbour of its wrapper (up to 5 levels).
  // A neighbour that is another field's group (a known label first, or several pieces further up) is never taken as the value.
  const valueAfter = (start) => {
    let cur = start;
    for (let level = 0; cur && level < 5; level++) {
      let slot = false;
      for (let s = cur.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType !== 3 && s.nodeType !== 1) continue;
        if (s.nodeType === 1 && (CHROME_EL.test(String(s.tagName).toUpperCase()) || /assistive|slds-icon/.test(cls(s)))) continue;
        const ps = pieces(s);
        if (s.nodeType === 3 && !ps.length) continue;       // whitespace
        slot = true;                                        // there IS a value slot after the label: decide here, never climb into the NEXT field
        const keep = ps.filter((p) => !NOT_VALUE.test(p));
        if (!keep.length) continue;
        if (OTHER_LABEL.test(keep[0])) return { kind: 'blank', how: 'the next field starts right after the label' };
        if (keep.length === 1) return { kind: 'value', value: keep[0], how: level > 1 ? 'next to the label group' : 'next to the label' };
        const joined = keep.join(' ');
        if (level <= 1 && joined.length <= 100) return { kind: 'value', value: joined, how: 'next to the label' };
        return { kind: 'ambiguous', how: 'several pieces of text follow the label group' };
      }
      if (slot) return { kind: 'blank', how: 'empty value' };
      cur = up(cur);
      if (!cur || cur.nodeType !== 1 || cur === document.body) break;
    }
    return { kind: 'ambiguous', how: 'nothing follows the label' };
  };
  const htmlOf = (n) => {
    const p = n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : (n.parentNode && n.parentNode.host) || null;
    const g = p && (up(p) && up(p).nodeType === 1 ? up(p) : p);
    return g && g.outerHTML ? g.outerHTML.replace(/\s+/g, ' ').slice(0, 600) : '';
  };

  const byKey = {}; targets.forEach((t) => { byKey[t.key] = []; });
  const labels = []; let summaryHits = 0;
  const LABEL_SEL = '.slds-form-element__label, .test-id__field-label, .slds-text-title, dt, th[scope="row"], label, .lbl, .k';
  for (const root of roots) {
    const tw = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const t = norm(n.nodeValue); if (!t || t.length > 140) continue;
      const hit = targets.map((g) => ({ g, lab: g.label.test(t), inl: g.label.test(t) ? null : g.inline.exec(t) })).find((x) => x.lab || x.inl);
      const isSummary = SUMMARY.test(t);
      if (!hit && !isSummary) continue;
      if (blocked(n) || !shown(n)) continue;
      if (isSummary) summaryHits++;
      if (!hit) continue;
      byKey[hit.g.key].push(hit.lab ? { ...valueAfter(n), html: htmlOf(n) } : { kind: 'value', value: norm(hit.inl[1]), how: 'written as "Label: value"', html: htmlOf(n) });
    }
    try { root.querySelectorAll(LABEL_SEL).forEach((e) => { if (labels.length < 40) { const t = pieces(e).join(' '); if (t && t.length <= 40 && !labels.includes(t)) labels.push(t); } }); } catch (_) {}
  }
  const body = document.body ? pieces(document.body).join(' ') : '';
  return {
    byKey, matches: byKey.industry || [], labels, summarySeen: summaryHits > 0,
    bodyLen: body.length,
    unavailable: /(page|record) (you were looking for )?(isn.t|is not|wasn.t|was not) (available|found)|url no longer exists|insufficient privileges|you (do not|don.t) have access|record (was )?deleted|no longer exists|doesn.t exist|does not exist/i.test(body.slice(0, 6000)),
    loggedOut: /okta|\/login|secur\/frontdoor|saml/i.test(location.href) && !/lightning\.force\.com\/lightning\//.test(location.href),
  };
}
const scanForIndustry = scanForLabels;      // the name this module's tests and callers used before it also read the Timezone

/** Lightning puts button text next to values ("Plumbing Edit Industry"); strip it. '' when the value is only a placeholder. */
function cleanValue(v) {
  let x = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = x; x = x.replace(/\s*Edit\s+Industry\s*$/i, '').replace(/\s*(Preview|Change Owner)\s*$/i, '').trim(); } while (x !== prev);
  if (/^(--\s*none\s*--|none|n\/a|—|–|-|--)$/i.test(x)) return '';
  return x.slice(0, 100);
}

/** The Timezone as the page words it ("Mountain", "Eastern Time (US & Canada)"): button text stripped; '' for a placeholder. */
function cleanTimezone(v) {
  let x = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = x; x = x.replace(/\s*Edit\s+Time\s*-?\s*zone\s*$/i, '').replace(/\s*(Preview|Change Owner)\s*$/i, '').trim(); } while (x !== prev);
  if (/^(--\s*none\s*--|none|n\/a|—|–|-|--)$/i.test(x)) return '';
  return x.slice(0, 60);
}

/** The most useful of several labels of one kind on the page: the first with a value, else a blank one, else an unclear one. */
function pickMatch(matches) {
  const ms = matches || [];
  return ms.find((m) => m.kind === 'value' && cleanValue(m.value)) || ms.find((m) => m.kind === 'blank' || (m.kind === 'value' && !cleanValue(m.value))) || ms.find((m) => m.kind === 'ambiguous') || null;
}

/** scanForLabels in the page AND in every iframe on it (a summary card can live in a Visualforce frame). The login / not-available verdicts come from the page itself. */
async function scanAllFrames(page, spec) {
  const out = [];
  for (const f of page.frames()) {
    const r = await f.evaluate(scanForLabels, spec).catch(() => null);
    if (r) out.push({ r, main: f === page.mainFrame() });
  }
  if (!out.length) return null;
  const main = (out.find((x) => x.main) || out[0]).r;
  const byKey = {};
  for (const k of Object.keys(main.byKey)) byKey[k] = out.flatMap((x) => x.r.byKey[k] || []);
  return { ...main, byKey, matches: byKey.industry || [], labels: [...new Set(out.flatMap((x) => x.r.labels))].slice(0, 40), bodyLen: Math.max(...out.map((x) => x.r.bodyLen)), summarySeen: out.some((x) => x.r.summarySeen) };
}

/** Open the page's own "Details" tab (the full field list). A tab click only: nothing is edited. */
async function openDetailsTab(page) {
  try {
    const tab = page.locator('[role="tab"]').filter({ hasText: /^\s*Details\s*$/ }).first();
    if (await tab.count()) { await tab.click({ timeout: 2500 }); return true; }
  } catch (_) {}
  return false;
}

async function readIndustry(page, accountId, opts = {}) {
  const t0 = Date.now();
  const id = sfId.fix(accountId);
  const waitMs = opts.waitMs || 16000, pollMs = opts.pollMs || 700, blankMs = opts.blankMs || 1600;
  const detailsAfterMs = opts.detailsAfterMs || 2500;      // how long a rendered page is searched before its Details tab is opened
  const afterTabMs = opts.afterTabMs || 3000;              // …and how long after that before "no Industry field" is the answer
  const graceMs = opts.graceMs || 800;                     // once the Industry is known, how long to keep looking for the Timezone
  try { await page.goto(`https://${opts.host || SF_HOST}/lightning/r/Account/${id}/view`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (e) { return { ok: false, note: `nav failed: ${e.message}`, ms: Date.now() - t0 }; }
  let tab = false, tabAt = 0, renderedAt = 0, blankAt = 0, graceAt = 0, fields = {}, scan = null, final = null, tz = '', tzHow = '';
  const more = () => { const ls = [...new Set([...Object.keys(fields), ...((scan && scan.labels) || [])])].slice(0, 40); return { labels: ls, industryLabels: ls.filter((k) => /industry/i.test(k)), tab, ms: Date.now() - t0, timezone: tz || null, tzVia: tz ? tzHow : null }; };
  const finish = (f) => ({ ok: true, industry: null, ...f, ...more() });
  while (Date.now() - t0 < waitMs) {
    scan = await scanAllFrames(page);
    if (scan && scan.loggedOut) return { ok: false, note: 'the page asked for a login: Salesforce is not logged in in this Chrome window', ...more() };
    const pick = scan && pickMatch(scan.matches);
    const tzPick = scan && pickMatch(scan.byKey.timezone);
    if (tzPick && tzPick.kind === 'value' && cleanTimezone(tzPick.value)) { tz = cleanTimezone(tzPick.value); tzHow = tzPick.how; }
    if (scan && !renderedAt && (scan.bodyLen > 600 || (scan.labels || []).length >= 3 || scan.summarySeen)) renderedAt = Date.now();
    if (!final) {
      if (pick && pick.kind === 'value' && cleanValue(pick.value)) final = { industry: cleanValue(pick.value), via: pick.how, html: pick.html || '' };
      else {
        // not found by its text: the page's own field reader (labels kept in attributes, custom layouts it already knows)
        fields = (await sfReview.grabFields(page)).fields || {};
        const key = Object.keys(fields).find((k) => /^industry$/i.test(k));
        const fv = key ? cleanValue(fields[key]) : '';
        if (fv) final = { industry: fv, via: 'details field', html: pick ? pick.html : '' };
        else if (scan && scan.unavailable && !Object.keys(fields).length && !(scan.labels || []).length) return { ok: true, industry: null, unavailable: true, via: 'unavailable', note: 'the account page is not available (deleted, merged, or no access)', ...more() };
        else if (pick && (pick.kind === 'blank' || pick.kind === 'value')) {      // the label is there and nothing is in it: make sure it is not just still loading
          if (!blankAt) blankAt = Date.now();
          else if (Date.now() - blankAt >= blankMs) final = { industry: null, blank: true, via: 'blank', note: 'the Industry field is empty in Salesforce', html: pick.html };
        } else blankAt = 0;
      }
    }
    if (final) {
      // the Industry is known; the summary's Timezone renders with it, so give it a moment
      if (!graceAt) graceAt = Date.now();
      if (tz || Date.now() - graceAt >= graceMs) return finish(final);
    } else {
      // not on screen: once the page has rendered something, open its Details tab (once); when that has had its time too, there is no Industry field
      if (!tabAt && renderedAt && Date.now() - renderedAt > detailsAfterMs) { tab = await openDetailsTab(page); tabAt = Date.now() - (tab ? 0 : afterTabMs - 800); }
      if (tabAt && Date.now() - tabAt > afterTabMs) break;
    }
    await sleep(pollMs);
  }
  if (final) return finish(final);
  const pick = scan && pickMatch(scan.matches);
  if (pick && pick.kind === 'ambiguous') return { ok: false, ambiguous: true, via: 'ambiguous', note: `the Industry label is on the page but its value could not be told (${pick.how})`, html: pick.html, ...more() };
  if (Object.keys(fields).length || (scan && (scan.bodyLen > 800 || (scan.labels || []).length >= 3 || scan.summarySeen))) return { ok: true, industry: null, miss: true, via: 'no-label', note: `no Industry field on the account page${tab ? ' (not on its Details tab either)' : ''}`, ...more() };
  return { ok: false, note: 'the account page did not render any fields', ...more() };
}

module.exports = { readIndustry, scanForLabels, scanForIndustry, scanAllFrames, cleanValue, cleanTimezone, pickMatch, openDetailsTab };
