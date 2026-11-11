'use strict';

/**
 * clickGuard — the text sender never clicks blind.
 *
 * The compose step used to click wherever a landmark search said the message box was, and type. When that spot was really the console's utility bar along the bottom (Phone, Call Details,
 * History, myTasks, Notes, Macros, Get More) the click opened History or Macros, the cursor never reached the message box, and the typed text (spaces and Enter activate a focused button)
 * kept opening and closing those panels. So every click now goes through here first:
 *   - clickAt(x, y)       asks the page what is on top at that point (through shadow roots) and refuses a click on the utility bar, on a pop-up, or on anything that is not the thing the click is for;
 *   - focusComposer()     finds the message box, WAITS while the composer is still loading (the page's spinner is on top of it: up to 30 s, nothing clicked meanwhile), scrolls IT into the free
 *                         area above the bar, checks it is the topmost thing at its centre, clicks it and then checks the cursor is really in it
 *                         (nothing is typed otherwise: the caller throws "Compose box not found", which runReportCampaign retries once on a fresh load);
 *   - clickSend()         the same for the Send button, found next to the message box. While lockSend() is on (--dry-run / --test) it does everything but the click and answers { ok: true, dry: true }.
 *   - pinViewport(page)   keeps the page laid out at 1920x1080 for the whole run. A Playwright screenshot (the compose-failure snapshot, the email debug picture) otherwise makes Chrome drop that
 *                         size and re-lay the page out at the real window size (a narrow window gives Salesforce its cramped layout in the middle of a run).
 * Nothing here clicks or types on its own account except through the functions above. `page` is a Playwright page; log / pause / moveCursor are passed in so a test can fake them.
 */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORT = { width: 1920, height: 1080 };

/**
 * Runs INSIDE the page (Playwright sends its source), so it may use nothing from this file.
 *   { op: 'hit', x, y, expect }   → { ok, why, desc, text, inBar, popup }       what is on top at (x, y); `expect` = 'any' | 'texts' | 'editable' | 'send'
 *   { op: 'locate', kind: 'compose' | 'send', reveal }  → { found, ok, why, x, y, w, h, scrolled, hit, popup, barTop, vh }   the element, scrolled clear of the utility bar when `reveal`
 *   { op: 'focus', force }        → { ok, active, isCompose, editable, hadBox }  is the cursor in the message box now (`force` focuses it first)
 */
function pageProbe(arg) {
  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clsOf = (e) => lower(e && e.className && e.className.baseVal !== undefined ? e.className.baseVal : (e && e.className) || '');
  const upOf = (n) => { if (!n) return null; if (n.parentElement) return n.parentElement; const r = n.getRootNode && n.getRootNode(); return (r && r.host) || null; };      // up, through shadow roots
  const BAR = ['slds-utility-bar', 'utilitybar', 'utility-bar', 'slds-utility-panel', 'utilitypanel', 'oneutilitybaritem', 'force-pop-out'];
  const SKIP = BAR.concat(['macro', 'forcesearchinput', 'uiinputtextforautocomplete']);
  const SMS = ['smagicinteract'];
  const SPIN = ['spinner'];                              // slds-spinner, slds-spinner_container, lightning-spinner: the page's own "loading" cover
  const matches = (e, list) => {
    const c = clsOf(e), t = lower(e.tagName), d = lower(e.getAttribute && e.getAttribute('data-component-id'));
    return list.some((k) => c.includes(k) || t.includes(k)) || (list === SKIP && d.includes('macro'));
  };
  const caches = new Map();
  const within = (el, list) => {                         // the element itself or any ancestor (through shadow roots) matches
    if (!caches.has(list)) caches.set(list, new WeakMap());
    const cache = caches.get(list), trail = [];
    let p = el, res = null, n = 0;
    while (p && n++ < 150) {
      if (cache.has(p)) { res = cache.get(p); break; }
      trail.push(p);
      if (matches(p, list)) { res = true; break; }
      p = upOf(p);
    }
    if (res === null) res = false;
    trail.forEach((q) => cache.set(q, res));
    return res;
  };
  const visible = (e) => (e.offsetParent !== null || e.getClientRects().length > 0) && (() => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
  const queryDeep = (selector, root, out) => {
    out = out || []; root = root || document;
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) queryDeep(selector, e.shadowRoot, out); });
    return out;
  };
  const deepAt = (px, py) => {
    let el = document.elementFromPoint(px, py), guard = 0;
    while (el && el.shadowRoot && guard++ < 30) { const inner = el.shadowRoot.elementFromPoint(px, py); if (!inner || inner === el) break; el = inner; }
    return el;
  };
  const describe = (e) => { if (!e) return null; const c = clsOf(e).split(/\s+/).filter(Boolean).slice(0, 2).join('.'); return `${lower(e.tagName)}${e.id ? '#' + e.id : ''}${c ? '.' + c : ''}`; };
  const textOf = (e) => norm(String((e && (e.value || e.textContent)) || '').slice(0, 200)).slice(0, 40);
  const shortText = (e) => { const t = e && (e.value || e.textContent); return t && String(t).length <= 60 ? lower(norm(t)) : null; };      // null for a container: never read a big subtree's text
  let barMemo;
  const barTop = () => {                                  // the top edge of the utility bar along the bottom of the window (null: there is none)
    if (barMemo !== undefined) return barMemo;
    let best = null;
    queryDeep('.slds-utility-bar, [class*="utilityBar"], [class*="utility-bar"], one-utility-bar').forEach((e) => {
      if (!visible(e)) return;
      const r = e.getBoundingClientRect();
      if (r.height < 140 && r.top > innerHeight * 0.5 && (best === null || r.top < best)) best = r.top;
    });
    return (barMemo = best);
  };
  const limit = () => { const b = barTop(); return b === null ? innerHeight : b; };
  // A pop-up that is IN THE WAY: a real modal (aria-modal / slds-modal / modal-container / lightning-modal: it blocks the whole page, and the backdrop that is on top at the spot is not part of it) or a
  // dialog that the thing on top at the spot belongs to (`top`). A non-modal dialog somewhere else on the page is NOT in the way: Salesforce's task-reminder toasts ("Incoming SMS 11/2/2026 Task Reminder
  // Notification", section.slds-notification role=dialog, top right) were on every page the morning of 2026-11-03, and made the guard call a composer that was only still loading "covered by a pop-up" and give up at once.
  const MODAL_SEL = '.slds-modal, .modal-container, lightning-modal, [aria-modal="true"]';
  const holds = (root, el) => { for (let p = el, n = 0; p && n++ < 150; p = upOf(p)) if (p === root) return true; return false; };
  const popupText = (top) => {
    const found = queryDeep('[role="dialog"], [role="alertdialog"], .slds-modal, .modal-container, lightning-modal').find((e) => {
      if (!visible(e) || within(e, BAR)) return false;      // (an open utility panel is a role=dialog too, but it is not a pop-up over the page)
      const r = e.getBoundingClientRect();
      if (!(r.width > 120 && r.height > 60)) return false;
      let modal = false; try { modal = e.matches(MODAL_SEL); } catch (_) {}
      return modal || (!!top && holds(e, top));
    });
    return found ? (norm(String(found.innerText || found.textContent || '').slice(0, 300)).slice(0, 40) || describe(found)) : null;
  };
  const isEditableEl = (e) => {
    if (!e || !e.tagName) return false;
    const t = e.tagName;
    if (t === 'TEXTAREA') return !e.disabled && !e.readOnly;
    if (t === 'INPUT') return !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(e.type || 'text') && !e.disabled;
    return e.isContentEditable === true || e.getAttribute('contenteditable') === 'true' || e.getAttribute('role') === 'textbox';
  };
  const upTo = (el, n, test) => { for (let p = el, i = 0; p && i < n; p = upOf(p), i++) if (test(p)) return p; return null; };
  const expectOk = (el, expect) => {
    if (!expect || expect === 'any') return true;
    if (expect === 'texts') return !!upTo(el, 8, (p) => shortText(p) === 'texts');
    if (expect === 'editable') return !!upTo(el, 6, isEditableEl);
    if (expect === 'send') return !!upTo(el, 6, (p) => shortText(p) === 'send');
    return true;
  };
  const hitInfo = (px, py, expect) => {
    // loading / disabled: what is on top is the page's loading spinner (or the message box itself is disabled) — the composer is not ready YET, which is a reason to wait, not to give up
    if (!(px >= 0 && py >= 0 && px <= innerWidth && py <= innerHeight)) return { ok: false, why: `the point (${px}, ${py}) is outside the window (${innerWidth}x${innerHeight})`, desc: null, text: '', inBar: false, popup: null, loading: false, disabled: false };
    const el = deepAt(px, py);
    if (!el) return { ok: false, why: 'nothing is at that point', desc: null, text: '', inBar: false, popup: null, loading: false, disabled: false };
    const inBar = within(el, BAR);
    const base = { desc: describe(el), text: textOf(el), inBar, popup: null, loading: false, disabled: false };
    if (inBar) {
      const item = upTo(el, 6, (p) => { const t = textOf(p); return t && t.length <= 20; }) || el;
      return { ...base, ok: false, why: `that point is on the utility bar ("${textOf(item)}")` };
    }
    if (!expectOk(el, expect)) {
      const popup = popupText(el);
      const loading = !popup && !!upTo(el, 6, (p) => matches(p, SPIN));
      const disabled = !popup && !loading && !!upTo(el, 4, (p) => (p.tagName === 'TEXTAREA' || p.tagName === 'INPUT') && (p.disabled || p.readOnly || (p.getAttribute && p.getAttribute('aria-disabled') === 'true')));
      return { ...base, popup, loading, disabled, ok: false,
        why: popup ? `a pop-up is open on the page ("${popup}") and covers it`
          : loading ? `the composer is still loading (a spinner is on top: ${base.desc})`
          : disabled ? 'the message box is disabled (the composer is still loading)'
          : `something else is on top there (${base.desc}${base.text ? ` "${base.text}"` : ''})` };
    }
    return { ...base, ok: true, why: null };
  };
  const scrollParents = (el) => {
    const out = [];
    for (let p = upOf(el); p; p = upOf(p)) {
      let st; try { st = getComputedStyle(p); } catch (_) { continue; }
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) out.push(p);
    }
    return out;
  };

  const composeBox = () => {
    const all = queryDeep('textarea, [contenteditable="true"], [role="textbox"]').filter((e) => {
      const ph = lower(e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || e.getAttribute('aria-label'));
      return (ph.includes('type a message') || ph.includes('message or select')) && visible(e) && !within(e, SKIP);
    });
    return all.find((e) => e.tagName === 'TEXTAREA' && within(e, SMS)) || all.find((e) => e.tagName === 'TEXTAREA') || all.find((e) => within(e, SMS)) || all[0] || null;
  };
  const sendButton = (compose) => {
    const want = (e) => shortText(e) === 'send';
    const pool = [];
    for (let p = compose ? upOf(compose) : null, i = 0; p && i < 14 && !pool.length; p = upOf(p), i++) {      // the nearest ancestor of the message box that holds a Send
      (p.querySelectorAll ? Array.from(p.querySelectorAll('*')) : []).forEach((e) => { if (e.childElementCount <= 3 && want(e) && visible(e) && !within(e, SKIP)) pool.push(e); });
    }
    if (!pool.length) queryDeep('button, [role="button"], a, lightning-button, input[type="button"], input[type="submit"]').forEach((e) => { if (want(e) && visible(e) && !within(e, SKIP)) pool.push(e); });
    if (!pool.length) return null;
    if (!compose) return pool[0];
    const c = compose.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    const dist = (e) => { const r = e.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); };
    return pool.slice().sort((a, b) => dist(a) - dist(b))[0];
  };
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; };

  /** Scroll `el` into the free area above the utility bar until its centre is topmost and clear. → { ok, scrolled, hit, x, y, w, h, barTop, why } */
  const reveal = (el, expect) => {
    const state = () => {
      const c = centre(el), lim = limit();
      return { c, lim, clear: c.h > 0 && c.x >= 2 && c.x <= innerWidth - 2 && c.y >= 4 && c.y <= lim - 6 };
    };
    const tries = [
      () => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      () => el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }),
      () => el.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' }),
      () => { const s = state(); const want = Math.max(40, s.lim / 2); for (const p of scrollParents(el)) { p.scrollTop += s.c.y - want; if (Math.abs(centre(el).y - want) < 40) break; } },
    ];
    let last = null;
    for (let i = 0; i < tries.length; i++) {
      try { tries[i](); } catch (_) {}
      const s = state();
      last = hitInfo(s.c.x, s.c.y, expect);
      if (s.clear && last.ok) return { ok: true, scrolled: i, hit: last, ...s.c, barTop: s.lim };
      // In the free area, but a loading spinner is on top (or the box is disabled): more scrolling changes nothing, waiting does — stay where it is
      if (s.clear && (last.loading || last.disabled)) return { ok: false, scrolled: i, hit: last, ...s.c, barTop: s.lim, why: last.why };
    }
    const s = state();
    return { ok: false, scrolled: tries.length, hit: last, ...s.c, barTop: s.lim, why: !s.clear ? `it could not be scrolled clear of the utility bar (its centre is at y=${s.c.y}, the bar starts at y=${Math.round(s.lim)})` : (last && last.why) || 'it is not clickable' };
  };

  const deepActive = () => {
    let a = document.activeElement, guard = 0;
    while (a && guard++ < 30) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME') { try { const d = a.contentDocument && a.contentDocument.activeElement; if (d && d !== a.contentDocument.body) { a = d; continue; } } catch (_) {} }
      break;
    }
    return a;
  };

  const { op } = arg;
  if (op === 'hit') return hitInfo(arg.x, arg.y, arg.expect);
  if (op === 'locate') {
    const compose = composeBox();
    const el = arg.kind === 'compose' ? compose : sendButton(compose);
    if (!el) return { found: false, ok: false, why: arg.kind === 'compose' ? 'no message box on the page' : 'no Send button on the page', popup: popupText(), barTop: barTop(), vh: innerHeight };
    const expect = arg.kind === 'compose' ? 'editable' : 'send';
    if (!arg.reveal) { const c = centre(el); const h = hitInfo(c.x, c.y, expect); return { found: true, ok: h.ok, why: h.why, hit: h, popup: h.popup, ...c, barTop: barTop(), vh: innerHeight }; }
    const r = reveal(el, expect);
    return { found: true, ok: r.ok, why: r.ok ? null : r.why, x: r.x, y: r.y, w: r.w, h: r.h, scrolled: r.scrolled, hit: r.hit, popup: r.ok ? null : ((r.hit && r.hit.popup) || popupText()), barTop: r.barTop, vh: innerHeight };
  }
  if (op === 'focus') {
    const box = composeBox();
    if (arg.force && box) { try { box.focus({ preventScroll: true }); } catch (_) {} }
    const a = deepActive();
    const editable = !!(a && isEditableEl(a));
    const wrap = box ? upTo(box, 10, (p) => /compos/.test(clsOf(p))) : null;      // the composer's own wrapper: an editable thing inside it counts too (some editors move the focus to an inner element)
    const isCompose = !!(box && a && (a === box || box.contains(a) || (wrap && wrap.contains(a) && isEditableEl(a))));
    // No message box we can identify (the older layout): any editable thing that is not the global search or a utility panel counts.
    const ok = box ? isCompose : (editable && !within(a, SKIP));
    return { ok, active: a ? `${describe(a)}${textOf(a) ? ` "${textOf(a)}"` : ''}` : 'nothing', isCompose, editable, hadBox: !!box };
  }
  if (op === 'boxText') {                                  // what is in the message box right now (known false: no box we can identify, e.g. inside an iframe)
    const box = composeBox();
    if (!box) return { known: false, len: 0, head: '' };
    const v = box.tagName === 'TEXTAREA' || box.tagName === 'INPUT' ? box.value : (box.innerText || box.textContent || '');
    return { known: true, len: String(v).length, head: norm(v).slice(0, 40) };
  }
  if (op === 'diagnose') {                                 // for compose-failures/: what the page looks like around a composer that never became ready
    const rectOf = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    const chain = (e, n) => { const out = []; for (let p = e, i = 0; p && i < n; p = upOf(p), i++) out.push(describe(p)); return out; };
    const spinners = queryDeep('[class*="spinner"], lightning-spinner').filter(visible).slice(0, 10).map((e) => ({ el: describe(e), text: textOf(e), rect: rectOf(e), chain: chain(e, 9) }));
    const box = composeBox();
    let boxInfo = null;
    if (box) { let opacity = null; try { opacity = getComputedStyle(box).opacity; } catch (_) {} boxInfo = { el: describe(box), rect: rectOf(box), disabled: !!box.disabled, readOnly: !!box.readOnly, ariaDisabled: box.getAttribute('aria-disabled'), opacity, chain: chain(box, 12) }; }
    const c = box ? centre(box) : null;
    return {
      spinners, box: boxInfo, hasFocus: document.hasFocus(), visibility: document.visibilityState, inner: [innerWidth, innerHeight], barTop: barTop(),
      onTopOfBox: c ? (() => { const h = hitInfo(c.x, c.y, 'editable'); return { at: [c.x, c.y], desc: h.desc, why: h.why, loading: h.loading, disabled: h.disabled }; })() : null,
      scroll: box ? scrollParents(box).slice(0, 4).map((p) => ({ el: describe(p), top: Math.round(p.scrollTop), height: p.scrollHeight, client: p.clientHeight })) : [],
    };
  }
  return { ok: false, why: `unknown op ${op}` };
}

const probe = (page, arg) => page.evaluate(pageProbe, arg);

/** What is on top at (x, y)? → { ok, why, desc, text, inBar, popup } — never throws (a page that cannot be asked is "not ok"). */
async function hitAt(page, x, y, expect = 'any') {
  try { return await probe(page, { op: 'hit', x, y, expect }); }
  catch (e) { return { ok: false, why: `the page could not be asked what is at (${x}, ${y}): ${e.message}`, desc: null, text: '', inBar: false, popup: null }; }
}

/** Click (x, y) only if what is there is what `expect` says ('any' = anything but the utility bar / a covering pop-up). → { clicked, why, hit } */
async function clickAt(page, x, y, { expect = 'any', what = 'the spot', log = () => {} } = {}) {
  const hit = await hitAt(page, x, y, expect);
  if (!hit.ok) { log('🛡️', 'Click guard', `${what}: NOT clicked at (${x}, ${y}) — ${hit.why}`); return { clicked: false, why: hit.why, hit }; }      // (hit.loading / hit.disabled: it is covered by a loading spinner)
  await page.mouse.click(x, y);
  return { clicked: true, why: null, hit };
}

/** Is the cursor in the message box right now? → { ok, active, isCompose, editable, hadBox } (`force` focuses the box through the DOM first). Never throws. */
async function focusState(page, { force = false } = {}) {
  try { return await probe(page, { op: 'focus', force }); }
  catch (e) { return { ok: false, active: `(could not look: ${e.message})`, isCompose: false, editable: false, hadBox: false }; }
}

async function locate(page, kind, { reveal = true } = {}) {
  try { return await probe(page, { op: 'locate', kind, reveal }); }
  catch (e) { return { found: false, ok: false, why: `the page could not be searched: ${e.message}` }; }
}

/** What is in the message box right now? → { known, len, head } (known false: no box we can identify, e.g. inside an iframe). Never throws. */
async function boxText(page) {
  try { return await probe(page, { op: 'boxText' }); }
  catch (e) { return { known: false, len: 0, head: '', error: e.message }; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A composer that is still LOADING. On the board's Chrome (2026-10-30) the Texts tab was open, the message box was in the page and greyed out under the page's own loading spinner
// (div.slds-spinner): nothing can be typed there yet, and a click on it only hits the spinner. The guard used to give up at once; now it waits for the spinner to go, without clicking or
// scrolling meanwhile, and only then goes on. If it never goes, compose-failures/ gets what the page was doing (the spinner, what is on top of the box, the requests still waiting).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const LOAD_WAIT_MS = Number(process.env.ASSISTANT_COMPOSER_WAIT_MS) || 30000;      // a spinner on top of the box / a disabled box: how long to wait for the composer to finish loading (env: ASSISTANT_COMPOSER_WAIT_MS)
const COVER_WAIT_MS = 8000;      // anything else on top of the box that is neither the utility bar nor a pop-up (a tooltip, a hover card): it may go away by itself

const trackers = new WeakMap();
/**
 * Keep a short list of the page's requests that have not finished (and the ones that failed), so a composer that never loads can say what it was waiting for: the host and path only (no query
 * string, no body) plus, for a Salesforce /aura call, the Apex actions named in it. Once per page; never throws. → true when installed.
 */
function trackRequests(page) {
  if (!page || typeof page.on !== 'function' || trackers.has(page)) return false;
  const pending = new Map(), failed = [];
  const brief = (r) => { try { const u = new URL(r.url()); return `${u.host}${u.pathname}`.slice(0, 110); } catch (_) { return String(r.url()).slice(0, 100); } };
  const actions = (r) => {      // the body of an /aura call is form-encoded JSON (slashes may be escaped): decode it, then pick out the action names
    try {
      if (r.method() !== 'POST' || !String(r.url()).includes('/aura')) return [];
      let d = String(r.postData() || ''); try { d = decodeURIComponent(d.replace(/\+/g, ' ')); } catch (_) {}
      const m = d.replace(/\\\//g, '/').match(/(?:apex|serviceComponent):\/\/[\w.]+\/ACTION\$\w+/g);
      return m ? [...new Set(m)].slice(0, 3) : [];
    } catch (_) { return []; }
  };
  page.on('request', (r) => { try { if (pending.size > 600) { const old = Date.now() - 10 * 60000; for (const [k, v] of pending) if (v.at < old) pending.delete(k); } pending.set(r, { at: Date.now(), method: r.method(), url: brief(r), actions: actions(r) }); } catch (_) {} });
  page.on('requestfinished', (r) => { pending.delete(r); });
  page.on('requestfailed', (r) => { try { const p = pending.get(r); pending.delete(r); failed.push({ url: p ? p.url : brief(r), error: (r.failure() || {}).errorText || '?', actions: p ? p.actions : [] }); if (failed.length > 40) failed.shift(); } catch (_) {} });
  trackers.set(page, { pending, failed });
  return true;
}

/** The requests that have been waiting for over `olderThanMs`, and the ones that failed lately (null: this page is not tracked). */
function requestReport(page, { olderThanMs = 1500 } = {}) {
  const t = trackers.get(page);
  if (!t) return null;
  const now = Date.now();
  const stuck = [...t.pending.values()].filter((v) => now - v.at >= olderThanMs).sort((a, b) => a.at - b.at).slice(0, 15).map((v) => ({ waitingS: Math.round((now - v.at) / 100) / 10, method: v.method, url: v.url, actions: v.actions }));
  return { pendingNow: t.pending.size, stuck, failedRecently: t.failed.slice(-12) };
}

/** What the page looks like around the message box, for compose-failures/. Never throws. */
async function diagnose(page, waited) {
  let seen; try { seen = await probe(page, { op: 'diagnose' }); } catch (e) { seen = { error: e.message }; }
  let requests = null; try { requests = requestReport(page); } catch (_) {}
  return { waitedMs: waited ? waited.waitedMs : 0, samples: waited ? waited.samples : [], page: seen, requests };
}

const notReady = (l) => !!(l && l.hit && (l.hit.loading || l.hit.disabled));

/**
 * The message box is there but something is on top of it (`loc` = the locate() that said so). If that is the loading spinner (or the box is disabled) wait for it to go; any other cover that can
 * go away by itself (a tooltip) gets a shorter wait. The utility bar (the scroll fixes that) and a pop-up (it stays until somebody closes it) are NOT waited for. Polls without scrolling or clicking;
 * when it stops, looks again with the scroll (the layout may have moved while the page filled in). → { loc, waitedMs, samples }
 */
async function waitForBox(page, loc, o = {}) {
  const log = o.log || (() => {}), sleep = o.sleep || sleepMs, pollMs = o.pollMs || 400;
  const loadWaitMs = o.loadWaitMs != null ? o.loadWaitMs : LOAD_WAIT_MS, coverWaitMs = o.coverWaitMs != null ? o.coverWaitMs : COVER_WAIT_MS;
  const first = loc && loc.hit;
  if (!first || loc.popup || first.popup || first.inBar) return { loc, waitedMs: 0, samples: [] };
  const t0 = Date.now(), samples = [];
  let sawLoading = notReady(loc), lastLog = t0;
  const budget = () => (sawLoading ? loadWaitMs : coverWaitMs);
  const note = (l) => { const what = (l && l.hit && l.hit.desc) || String((l && l.why) || '').slice(0, 60); const prev = samples[samples.length - 1]; if (!prev || prev.what !== what) samples.push({ atMs: Date.now() - t0, what }); };
  note(loc);
  log('🛡️', 'Click guard', `${sawLoading ? 'the composer is still loading (a spinner is on top of the message box)' : `something is on top of the message box (${first.desc})`} — waiting up to ${Math.round(budget() / 1000)} s for it; nothing is clicked or typed meanwhile`);
  while (Date.now() - t0 < budget()) {
    await sleep(pollMs);
    const cur = await locate(page, 'compose', { reveal: false });
    note(cur);
    if (cur.popup || (cur.hit && cur.hit.popup)) break;                  // a pop-up opened meanwhile: waiting does not close it
    if (cur.found && cur.hit && cur.hit.inBar) break;                    // under the utility bar: the scroll below deals with that
    if (cur.found && cur.ok) break;
    if (notReady(cur)) sawLoading = true;
    if (Date.now() - lastLog >= 8000) { lastLog = Date.now(); log('🛡️', 'Click guard', `…still waiting (${Math.round((Date.now() - t0) / 1000)} s): ${cur.why}`); }
  }
  const waitedMs = Date.now() - t0;
  const now = await locate(page, 'compose', { reveal: true });           // it may have moved while the page filled in: look again, scrolled clear of the bar
  if (now.found && now.ok) log('🛡️', 'Click guard', `the message box is ready (waited ${(waitedMs / 1000).toFixed(1)} s)`);
  return { loc: now, waitedMs, samples };
}

/**
 * Put the cursor in the message box. Finds the box itself (the page's own text box whose placeholder reads "Type a message or select a template"), scrolls it clear of the utility bar,
 * moves the pointer there, looks once more at what is on top, clicks and checks the cursor really is in the box (focusing it through the DOM if the click did not).
 * `fallbackPoint` {x, y} is the old layout estimate, used only when the page has no message box we can find (it is still never clicked on the utility bar).
 * → { ok, via: 'click' | 'focus' | 'estimate', why }.  ok false = NOTHING was typed or should be: the caller throws "Compose box not found" (runReportCampaign retries that once on a fresh load).
 */
async function focusComposer(page, o = {}) {
  const log = o.log || (() => {}), pause = o.pause || sleepMs, cursor = o.moveCursor || (async () => {});
  const waitOpts = { log, sleep: o.sleep, pollMs: o.pollMs, loadWaitMs: o.loadWaitMs, coverWaitMs: o.coverWaitMs };
  let loc = await locate(page, 'compose', { reveal: true });
  let waited = null;
  if (loc.found && !loc.ok) { waited = await waitForBox(page, loc, waitOpts); loc = waited.loc; }      // the loading spinner is on top: wait for it to go
  let x, y, via = 'click';
  if (loc.found && loc.ok) {
    ({ x, y } = loc);
    if (loc.scrolled) log('🛡️', 'Click guard', `the message box was not clear of the utility bar / the edge of the window — scrolled it into the free area first`);
  } else if (loc.found) {
    const why = waited && waited.waitedMs >= 1000 ? `${loc.why} — still so after ${Math.round(waited.waitedMs / 1000)} s` : loc.why;
    log('🛡️', 'Click guard', `the message box cannot be clicked — ${why}`);
    return { ok: false, why, loading: notReady(loc), diag: await diagnose(page, waited) };
  } else if (o.fallbackPoint) {
    ({ x, y } = o.fallbackPoint); via = 'estimate';
    log('🛡️', 'Click guard', `no message box found by its placeholder (${loc.why}) — using the estimated spot (${x}, ${y})`);
  } else return { ok: false, why: loc.why || 'no message box on the page' };

  await cursor(x, y);
  await page.mouse.move(x, y);
  await pause(500);
  let spot = await hitAt(page, x, y, via === 'estimate' ? 'any' : 'editable');
  if (!spot.ok && via === 'click') {                         // the page moved (or started loading again) under the pointer: wait if it is loading, look for the box again once
    let again = await locate(page, 'compose', { reveal: true });
    if (again.found && !again.ok) { waited = await waitForBox(page, again, waitOpts); again = waited.loc; }
    if (again.found && again.ok) { ({ x, y } = again); await cursor(x, y); await page.mouse.move(x, y); spot = await hitAt(page, x, y, 'editable'); }
  }
  if (!spot.ok) { log('🛡️', 'Click guard', `message box: NOT clicked at (${x}, ${y}) — ${spot.why}`); return { ok: false, why: spot.why, loading: !!(spot.loading || spot.disabled), diag: await diagnose(page, waited) }; }
  await page.mouse.click(x, y);
  await pause(500);
  if (o.inFrame) return { ok: true, via: 'frame' };           // the box is inside an iframe: its focus cannot be read from here, only the utility bar was ruled out
  let f = await focusState(page);
  if (f.ok) return { ok: true, via };
  log('🛡️', 'Click guard', `the click did not put the cursor in the message box (it is in ${f.active}) — focusing the box directly`);
  f = await focusState(page, { force: true });
  if (f.ok) return { ok: true, via: 'focus' };
  return { ok: false, why: `the cursor is not in the message box (it is in ${f.active})` };
}

let sendLocked = false;
/**
 * --dry-run / --test: while the lock is on, clickSend does everything EXCEPT the click on Send (finds the button, scrolls it clear of the utility bar, moves the pointer there, checks it is the topmost thing)
 * and answers { ok: true, dry: true }. It holds for every caller, whatever options they pass: Assistant.js switches it on in main() when the run is a dry run. It is a one-way latch: lockSend(false) does
 * nothing, so no code path can reopen it by accident (unlockSendForTests is for the tests only). It covers the TEXT Send button; the email composer's Send is emailAccount.js, behind its own dryRun.
 */
function lockSend(on = true) { if (on) sendLocked = true; }
const isSendLocked = () => sendLocked;
const unlockSendForTests = () => { sendLocked = false; };

/**
 * Click the Send button next to the message box. Looked up again NOW (typing makes the box grow, which moves Send), scrolled clear of the utility bar and checked to be topmost.
 * `fallbackPoint` {x, y} is the old estimate, used only when no Send button can be found on the page. → { ok, why }, or { ok: true, dry: true, x, y, byLabel } on a dry run (lockSend, or o.dryRun): everything was checked and nothing was clicked (byLabel: the button was found by its label, not just estimated).
 */
async function clickSend(page, o = {}) {
  const log = o.log || (() => {}), pause = o.pause || sleepMs, cursor = o.moveCursor || (async () => {});
  const loc = await locate(page, 'send', { reveal: true });
  let x, y;
  if (loc.found && loc.ok) ({ x, y } = loc);
  else if (loc.found) { log('🛡️', 'Click guard', `Send: NOT clicked — ${loc.why}`); return { ok: false, why: loc.why }; }
  else if (o.fallbackPoint) { ({ x, y } = o.fallbackPoint); log('🛡️', 'Click guard', `no Send button found by its label (${loc.why}) — using the estimated spot (${x}, ${y})`); }
  else return { ok: false, why: loc.why || 'no Send button on the page' };
  await cursor(x, y);
  await page.mouse.move(x, y);
  await pause(300);
  const spot = await hitAt(page, x, y, loc.found ? 'send' : 'any');
  if (!spot.ok) { log('🛡️', 'Click guard', `Send: NOT clicked at (${x}, ${y}) — ${spot.why}`); return { ok: false, why: spot.why }; }
  if (o.dryRun || sendLocked) { log('🧪', 'Click guard', loc.found ? `dry run: the Send button is there and ready at (${x}, ${y}) — NOT clicked` : `dry run: no Send button was found by its label; the estimated spot (${x}, ${y}) is clear — NOT clicked`); return { ok: true, dry: true, x, y, byLabel: !!loc.found }; }      // --dry-run / --test (lockSend): everything above was checked; the click is the one thing left out
  await page.mouse.click(x, y);
  return { ok: true };
}

const guarded = new WeakSet();
/**
 * A safety net under EVERY coordinate click on this page (texts, emails, probes): a page.mouse.click that would land on the console's utility bar (Phone, Call Details, History, myTasks, Notes,
 * Macros, Get More) throws instead of clicking, because nothing the bot does ever means to click there. If the page cannot be asked (it is navigating) the click goes through as before.
 * Once per page; never throws. → true when it was installed.
 */
function installBarGuard(page) {
  if (!page || !page.mouse || typeof page.mouse.click !== 'function' || guarded.has(page)) return false;
  const real = page.mouse.click.bind(page.mouse);
  page.mouse.click = async (x, y, opts) => {
    const hit = await hitAt(page, x, y, 'any');
    if (hit && hit.inBar) throw new Error(`Blocked a click on the console's utility bar at (${x}, ${y}) — ${hit.why}; nothing the bot does is meant to click there`);
    return real(x, y, opts);
  };
  guarded.add(page);
  return true;
}

const pinned = new WeakSet();
/**
 * Get a page ready for driving: the utility-bar safety net (installBarGuard) and a fixed 1920x1080 layout (what start-browser.js gives the first tab). Without Playwright knowing that size,
 * its next page.screenshot() makes Chrome drop it and re-lay the page out at the real window size. Once per page; never throws. → true when the size was applied.
 */
async function pinViewport(page, size = VIEWPORT) {
  if (!page) return false;
  try { installBarGuard(page); } catch (_) {}
  try { trackRequests(page); } catch (_) {}
  if (pinned.has(page)) return false;
  try { await page.setViewportSize(size); pinned.add(page); return true; } catch (_) { return false; }
}

module.exports = { pageProbe, hitAt, clickAt, focusState, locate, boxText, focusComposer, clickSend, lockSend, isSendLocked, unlockSendForTests, installBarGuard, pinViewport, trackRequests, requestReport, waitForBox, diagnose, LOAD_WAIT_MS, COVER_WAIT_MS, VIEWPORT };
