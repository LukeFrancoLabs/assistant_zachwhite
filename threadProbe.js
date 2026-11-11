'use strict';

/**
 * threadProbe — READ-ONLY look at an account's text thread (the Texts tab / SMS-Magic composer screen).
 *
 *   email --thread-probe 001XXXXXXXXXXXXXXX[,id2]
 *
 * It opens the account, clicks the Texts tab and reads what is on screen. It types nothing and clicks nothing but the tab.
 * Because the thread's markup has never been seen, this DISCOVERS it: in every frame (the composer may live in a cross-origin iframe)
 * it finds the compose box and the scrollable containers, and dumps the tail of each — tag, classes, text and the raw HTML of the
 * last few children. Output: the console, thread-probe-<id>.json and thread-probe-<id>.png (both next to this file).
 * The real "hold if a reply came in / a teammate texted" rule is built from this output.
 */

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs inside ONE frame. → { composeFound, composeParents[], containers[] } */
function inspectFrame() {
  const deepAll = (root, sel) => {
    const out = [];
    const walk = (node) => {
      try { node.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (_) {}
      node.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    };
    walk(root);
    return out;
  };
  const visible = (e) => e.offsetParent !== null || e.getClientRects().length > 0;
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 4).join('.') : ''}`;

  const compose = deepAll(document, 'textarea, [contenteditable="true"], [role="textbox"]')
    .find((e) => visible(e) && /message|template|type/i.test(`${e.getAttribute('placeholder') || ''} ${e.getAttribute('data-placeholder') || ''} ${e.getAttribute('aria-label') || ''}`));
  const composeParents = [];
  if (compose) { let p = compose; for (let i = 0; i < 8 && p; i++) { p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null; if (p) composeParents.push(desc(p)); } }

  // Scrollable containers with text, biggest text first.
  const scrollers = deepAll(document, '*').filter((e) => {
    if (!visible(e)) return false;
    let st; try { st = getComputedStyle(e); } catch (_) { return false; }
    return /(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 4 && (e.innerText || '').trim().length > 20;
  }).sort((a, b) => (b.innerText || '').length - (a.innerText || '').length).slice(0, 4);

  const containers = scrollers.map((c) => {
    const kids = Array.from(c.children);
    const tail = kids.slice(-25).map((k) => ({ el: desc(k), text: clip(k.innerText || k.textContent, 220) }));
    const html = kids.slice(-3).map((k) => String(k.outerHTML || '').replace(/\s+/g, ' ').slice(0, 1800));
    return { el: desc(c), scrollTop: Math.round(c.scrollTop), scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, children: kids.length, tailText: clip((c.innerText || '').slice(-1200), 1200), tail, lastChildrenHtml: html };
  });
  return { composeFound: !!compose, composePlaceholder: compose ? (compose.getAttribute('placeholder') || '') : null, composeParents, containers, bodyTail: clip((document.body && document.body.innerText || '').slice(-800), 800) };
}

/** Does the account page's "Texts" tab read as selected right now? (aria-selected on the tab, or the active class on it or on its list item) */
function textsTabSelected(page) {
  return page.evaluate(() => {
    let sel = false;
    const walk = (node) => node.querySelectorAll('[role="tab"], .slds-tabs_default__item, .slds-tabs-default__item, li.slds-is-active, a[data-label]').forEach((e) => {
      const t = (e.innerText || e.textContent || '').trim();
      if (t === 'Texts' && (e.getAttribute('aria-selected') === 'true' || /slds-is-active/.test(e.className || '') || (e.parentElement && /slds-is-active/.test(e.parentElement.className || '')))) sel = true;
    });
    const deep = (node) => { walk(node); node.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) deep(e.shadowRoot); }); };
    deep(document.body);
    return sel;
  });
}

/**
 * Opens the account page's "Texts" tab. Every visible element whose whole text is "Texts" is a candidate; real tabs (role=tab / a tab link /
 * inside a tab list) go first. Each is scrolled into view and clicked until the tab reads as selected (aria-selected / a selected class).
 * → { clicked, selected, candidates:[{ desc, role, x, y, selectedAfter }] }
 */
async function openTextsTab(page) {
  const find = () => page.evaluate(() => {
    const out = [];
    const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
    const walk = (node) => node.querySelectorAll('*').forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (t === 'Texts' && (el.offsetParent !== null || el.getClientRects().length > 0)) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const tabish = el.getAttribute('role') === 'tab' || !!(el.closest && el.closest('[role="tab"], [role="tablist"], .slds-tabs_default, .slds-tabs-default, lightning-tab-bar, one-record-home-flexipage2, .tabHeader'));
        out.push({ desc: desc(el), role: el.getAttribute('role'), tabish, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    });
    walk(document.body);
    return out;
  });
  const isSelected = () => textsTabSelected(page);
  const cands = await find();
  cands.sort((a, b) => (b.role === 'tab' ? 1 : 0) - (a.role === 'tab' ? 1 : 0) || (b.tabish ? 1 : 0) - (a.tabish ? 1 : 0) || (a.w * a.h) - (b.w * b.h));
  let clicked = false, selected = false;
  for (const c of cands.slice(0, 4)) {
    const fresh = (await find()).find((x) => x.desc === c.desc && x.tabish === c.tabish) || c;     // scrollIntoView moved it; use the position now
    // Only click if the Texts tab is what is on top at that spot: never the utility bar (History, Macros ...), a pop-up, or something else covering it (clickGuard.js)
    const g = await require('./clickGuard').clickAt(page, fresh.x, fresh.y, { expect: 'texts', what: 'the Texts tab' });
    if (!g.clicked) { c.refused = g.why; continue; }
    clicked = true;
    await sleep(2500);
    c.selectedAfter = await isSelected();
    if (c.selectedAfter) { selected = true; break; }
  }
  return { clicked, selected, candidates: cands };
}

/** Probe one account. → the dump object (also written to disk). */
async function probeAccount(page, accountUrl, id, { loadMs = 6000 } = {}) {
  await page.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(loadMs);
  const failed = [];
  page.on('requestfailed', (r) => failed.push({ url: String(r.url()).slice(0, 200), why: (r.failure() || {}).errorText }));
  const tab = await openTextsTab(page);
  await sleep(loadMs);
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  await sleep(1500);
  const frames = [];
  for (const f of page.frames()) {
    let r; try { r = await f.evaluate(inspectFrame); } catch (e) { r = { error: e.message }; }
    frames.push({ url: String(f.url()).slice(0, 160), ...r });
  }
  const dump = { at: new Date().toISOString(), accountId: id, accountUrl, textsTabClicked: tab.clicked, textsTabSelected: tab.selected, tabCandidates: tab.candidates, failedRequests: failed.slice(0, 20), frames };
  const base = path.join(__dirname, `thread-probe-${id}`);
  try { fs.writeFileSync(base + '.json', JSON.stringify(dump, null, 2)); } catch (_) {}
  try { await page.screenshot({ path: base + '.png' }); } catch (_) {}
  return dump;
}

function print(d) {
  console.log(`\n  🔎 ${d.accountId} — Texts tab ${d.textsTabClicked ? (d.textsTabSelected ? 'opened' : 'clicked but NOT selected') : 'NOT found'}  (${(d.tabCandidates || []).map((c) => `${c.desc}${c.tabish ? ' [tab]' : ''}${c.selectedAfter ? ' ✔' : ''}`).join(' | ') || 'no candidates'})`);
  (d.failedRequests || []).slice(0, 6).forEach((f) => console.log(`   ⚠️ failed request: ${f.url}  ${f.why}`));
  d.frames.forEach((f, i) => {
    if (f.error) return console.log(`   frame ${i} ${f.url}: ${f.error}`);
    if (!f.composeFound && !f.containers.length) return;
    console.log(`   frame ${i}  ${f.url}\n     compose box: ${f.composeFound ? `yes ("${f.composePlaceholder}")  inside ${f.composeParents.slice(0, 4).join(' < ')}` : 'no'}`);
    f.containers.forEach((c, j) => {
      console.log(`     scroll area ${j}: ${c.el}  ${c.children} children  scroll ${c.scrollTop}/${c.scrollHeight - c.clientHeight}`);
      c.tail.slice(-8).forEach((k) => console.log(`        ${k.el}  "${k.text.slice(0, 120)}"`));
    });
  });
  console.log(`\n   full dump: thread-probe-${d.accountId}.json  •  screenshot: thread-probe-${d.accountId}.png\n`);
}

/**
 * The page as it is when the SMS panel will not show its compose box, so the next failure explains itself:
 *   compose-failures/<accountId>-<time>.png   what is on screen
 *   compose-failures/<accountId>-<time>.json  what the page says: visible alerts, which tab is selected, whether this window is in the foreground, and every frame's compose box and text tail
 * Keeps the newest 80 files. Never throws. → the base path (without the extension)
 */
async function snapshotFailure(page, { id, name, why, extra } = {}) {
  const dir = path.join(__dirname, 'compose-failures');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const base = path.join(dir, `${String(id || 'unknown')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const info = await page.evaluate(() => {
    const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const visible = (e) => e.offsetParent !== null || e.getClientRects().length > 0;
    const alerts = [], tabs = [];
    const walk = (node) => {
      node.querySelectorAll('[role="alert"], .slds-notify, .slds-theme_error, .slds-has-error, [class*="errorMessage"]').forEach((e) => { if (visible(e)) { const t = clip(e.innerText || e.textContent, 200); if (t) alerts.push(t); } });
      node.querySelectorAll('[role="tab"]').forEach((e) => { if (visible(e)) tabs.push({ text: clip(e.innerText || e.textContent, 40), selected: e.getAttribute('aria-selected') === 'true' }); });
      node.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    };
    walk(document);
    return { url: location.href, title: document.title, visibility: document.visibilityState, focused: document.hasFocus(), inner: [innerWidth, innerHeight], alerts: [...new Set(alerts)].slice(0, 8), tabs: tabs.slice(0, 20) };
  }).catch((e) => ({ error: e.message }));
  const frames = [];
  let all = []; try { all = page.frames(); } catch (_) {}
  for (const f of all) { let r, u = ''; try { r = await f.evaluate(inspectFrame); } catch (e) { r = { error: e.message }; } try { u = String(f.url()).slice(0, 160); } catch (_) {} frames.push({ url: u, ...r }); }
  try { fs.writeFileSync(base + '.json', JSON.stringify({ at: new Date().toISOString(), accountId: id || null, accountName: name || null, why: why || null, page: info, guard: extra || null, frames }, null, 2)); } catch (_) {}
  try { await page.screenshot({ path: base + '.png', timeout: 8000 }); } catch (_) {}
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(json|png)$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const x of files.slice(0, Math.max(0, files.length - 80))) fs.unlinkSync(path.join(dir, x.f));
  } catch (_) {}
  return base;
}

module.exports = { probeAccount, print, inspectFrame, openTextsTab, textsTabSelected, snapshotFailure };
