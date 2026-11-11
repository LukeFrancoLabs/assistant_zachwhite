'use strict';

/**
 * salesforceReview — READ-ONLY pre-send review of an Account for --reengage.
 * Sends nothing and changes nothing in Salesforce. For each account about to be
 * re-engaged it reads the Opportunities related list (name / stage / close date) and
 * the Notes related list (not Activity History: the dashboard cross-checks activity), then decides:
 *
 *   skip    — do NOT re-engage (reasons attached)
 *   proceed — nothing found that argues against it
 *   unknown — couldn't read the opportunities; treated as "do not send" (fail closed)
 *
 * Opportunity rules (stage text as shown in Salesforce):
 *   1. Closed Won with a Close Date on/after the day of OUR first touch  → someone closed
 *      them since we reached out (any rep).                               → skip
 *   2. Any Closed Won in the last 30 days (closedWonWindow.js; any rep: another rep may have closed it) → skip, and the account goes on the closed-won list
 *   3. Has opps, every one closed (Closed Lost / Lost Demo / …), none won
 *      → the Pro is not interested anymore.                               → skip
 *   An OLD Closed Won that is not recent is treated as churned (still contactable).
 *   A Closed Won that is only the free Invoicing and Payments sign-up is NOT a close (Luke, 2026-10-29: such a pro is not a customer, see customerPlan.js): rules 1 and 2
 *   leave it out, a warning notes it, and the account is not put on the closed-won list for it (planRelease.freePlanWins reads each recent Closed Won the way the plan check
 *   does, READ-ONLY, and a doubt keeps it a Closed Won). Business coaching is NOT excepted: Luke keeps it out of outreach (a different department, coachingPolicy.js,
 *   2026-10-29), so a coaching win stays a close. `{ freePlan: false }` turns the exception off.
 * Notes rules (titles/subjects from the related lists only — see LIMITS):
 *   - hard stops (DNC / do not contact / stop texting / unsubscribe)       → skip
 *   - soft stops (not interested / signed with / out of business) dated AFTER our first
 *     touch                                                                → skip
 *     (undated or older soft stops are only recorded as warnings)
 * LIMITS: related-list rows show a note's TITLE, not the full body.
 * Anything in a body that isn't in the title is not seen. `email --review <id>`
 * prints exactly what was read so the rules can be tuned.
 */

const sfId = require('./sfId');
const { WON_FLAG_DAYS } = require('./closedWonWindow');      // how many days a Closed Won keeps an account out: one switch (Luke, 2026-10-30: 30)
const SF_HOST = 'housecallpro.lightning.force.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLOSED_WON_RE = /closed[\s_/-]*won/i;
// A stage that means the opportunity is finished ("Closed Lost", "Lost", "Disqualified", …). "Lost Demo Stage" is
// NOT one of them: those are exactly the accounts --auto is meant to win back, so they must stay contactable.
const CLOSED_ANY_RE = /^\s*closed|^\s*lost\b(?![\s_-]*demo)|disqualif|\bdead\b|not interested/i;
const HARD_STOP_RE = /\b(dnc|do not (call|contact|text|email)|don'?t (call|contact|text|email)|stop (texting|calling|emailing|contact)|unsubscribe|remove (me|from)|cease)\b/i;
const SOFT_STOP_RE = /\b(not interested|no longer interested|signed (up )?with|went with|using (jobber|servicetitan|fieldedge|service ?m8|workiz|zuper|simpro)|switched to|already (a customer|signed|using)|out of business|closed (down|the business)|no longer in business|wrong number|passed away)\b/i;

/** Deep-walk every <table> (through shadow roots) and return {headers, rows:[cells[]], ids[]}. */
async function readTables(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const tables = [];
    (function walk(n) {
      n.querySelectorAll('table').forEach((t) => tables.push(t));
      n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document.body);
    const headerLabel = (th) => {
      const t = th.querySelector('[title]');
      return norm(th.getAttribute('aria-label') || (t && t.getAttribute('title')) || th.textContent);
    };
    // Cells in lightning-datatable hold their <a> inside nested shadow roots, which a plain
    // querySelector can't see — walk shadow roots to find the record link.
    const deepA = (root, sel) => {
      let hit = null;
      (function walk(n) {
        if (hit) return;
        const a = n.querySelector(sel);
        if (a) { hit = a; return; }
        n.querySelectorAll('*').forEach((e) => { if (!hit && e.shadowRoot) walk(e.shadowRoot); });
      })(root);
      return hit;
    };
    const cellText = (c) => { if (!c) return ''; const a = deepA(c, 'a[href*="/lightning/r/"]') || deepA(c, 'a'); return norm((a && (a.innerText || a.textContent)) || c.innerText || c.textContent); };
    const hrefOf = (row) => { const a = deepA(row, 'a[href*="/lightning/r/"]'); return a ? (a.getAttribute('href') || '') : ''; };
    const oppId = (row) => {
      const a = deepA(row, 'a[href*="/lightning/r/"]');
      const m = a && (a.getAttribute('href') || '').match(/\/lightning\/r\/(?:[A-Za-z]+\/)?([a-zA-Z0-9]{15,18})/);
      return m ? m[1] : '';
    };
    return tables.map((t) => {
      const ths = Array.from(t.querySelectorAll('thead th'));
      return {
        headers: ths.map(headerLabel),
        rows: Array.from(t.querySelectorAll('tbody tr')).map((tr) => ({ cells: Array.from(tr.querySelectorAll('th, td')).map(cellText), id: oppId(tr), href: hrefOf(tr) })),
      };
    }).filter((t) => t.headers.length);
  });
}

async function openRelated(page, accountId, rel) {
  accountId = sfId.fix(accountId); // lowercased IDs are rejected by Salesforce as malformed
  await page.goto(`https://${SF_HOST}/lightning/r/Account/${accountId}/related/${rel}/view`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3500);
}

/** Poll until the page yields at least one table with body rows (or give up). */
async function pollTables(page, want) {
  let tables = [];
  for (let i = 0; i < 10; i++) {
    tables = await readTables(page).catch(() => []);
    if (tables.some((t) => want(t) && t.rows.length)) break;
    await sleep(1200);
  }
  // Large lists lazy-load as you scroll.
  for (let s = 0; s < 3; s++) {
    await page.evaluate(() => {
      (function walk(n) {
        n.querySelectorAll('.slds-scrollable_y, .slds-scrollable, [role="grid"], .uiScroller').forEach((el) => { el.scrollTop = el.scrollHeight; });
        n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      })(document.body);
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(800);
  }
  return readTables(page).catch(() => tables);
}

async function readOpportunities(page, accountId) {
  try { await openRelated(page, accountId, 'Opportunities'); }
  catch (e) { return { ok: false, opps: [], note: `nav failed: ${e.message}` }; }
  const isOpp = (t) => t.headers.some((h) => /stage/i.test(h)) || t.headers.some((h) => /close/i.test(h) && /date/i.test(h));
  const tables = (await pollTables(page, isOpp)).filter(isOpp);
  const opps = []; const seen = new Set();
  for (const t of tables) {
    const lc = t.headers.map((h) => h.toLowerCase());
    const nameI = lc.findIndex((h) => h.includes('opportunity') && h.includes('name'));
    const stageI = lc.findIndex((h) => h === 'stage' || (h.includes('stage') && !h.includes('duration')));
    const closeI = lc.findIndex((h) => h.includes('close') && h.includes('date'));
    const ownerI = lc.findIndex((h) => /owner/.test(h));
    for (const r of t.rows) {
      const o = { name: nameI >= 0 ? r.cells[nameI] : r.cells[0], stage: stageI >= 0 ? r.cells[stageI] : '', closeDate: closeI >= 0 ? r.cells[closeI] : '', owner: ownerI >= 0 ? r.cells[ownerI] : '', id: r.id };
      if (!o.name && !o.stage) continue;
      const key = o.id || `${o.name}|${o.closeDate}`;
      if (seen.has(key)) continue;
      seen.add(key); opps.push(o);
    }
  }
  return { ok: tables.length > 0 && opps.length > 0, opps, note: opps.length ? '' : 'no opportunity rows read' };
}

const DATE_CELL = /^(\d{1,2}\/\d{1,2}\/\d{2,4})(,?\s+\d{1,2}:\d{2}(:\d{2})?\s*([AP]M)?)?$|^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}(,?\s+\d{1,2}:\d{2}\s*([AP]M)?)?$/i;
/** A list cell that is entirely a date/time → ms since epoch (or null). */
function cellWhen(c) { if (!c || !DATE_CELL.test(String(c).trim())) return null; const t = Date.parse(String(c).trim()); return Number.isNaN(t) ? null : t; }
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Related lists → rows.
 *  - Notes list ("AttachedContentNotes"): the Salesforce Notes on the account —
 *    { source:'note', title, preview, owner, date, when, href, text, subject, assignedTo }.
 *  - Activity History list: emails/calls/tasks. NOT read any more (the dashboard cross-checks our own activity, and it cost a page load per
 *    account); pass { activity:true } to read it anyway.
 * The Notes list is read LAST so the page left open is the Notes list.
 */
async function readNotes(page, accountId, { activity = false, notes = true } = {}) {
  const out = [];
  const lists = [];
  if (activity) lists.push(['ActivityHistories', 'activity']);
  if (notes) lists.push(['AttachedContentNotes', 'note']);
  for (const [rel, source] of lists) {
    try { await openRelated(page, accountId, rel); } catch (_) { continue; }
    const tables = await pollTables(page, () => true);
    for (const t of tables) {
      const lc = t.headers.map((h) => h.toLowerCase());
      const find = (re) => lc.findIndex((h) => re.test(h));
      const subjI = find(/subject|title|^name$/);
      const whoI = find(source === 'note' ? /owner|created by|author/ : /assigned|owner/);
      const prevI = find(/preview|body|content|text/);
      const modI = find(/last modified|modified|updated/);
      for (const r of t.rows) {
        const cells = r.cells;
        const text = cells.filter(Boolean).join(' | ');
        if (!text) continue;
        // Date: the "last modified" cell, else any cell that is entirely a date, else (activity rows) a date in the text.
        let when = modI >= 0 ? cellWhen(cells[modI]) : null;
        if (when == null) for (const c of cells) { const w = cellWhen(c); if (w != null) { when = w; break; } }
        if (when == null && source === 'activity') { const dm = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\b/); const w = dm ? Date.parse(dm[1]) : NaN; when = Number.isNaN(w) ? null : w; }
        const title = ((subjI >= 0 ? cells[subjI] : cells[0]) || '').trim();
        const row = {
          source, text: text.slice(0, 400), date: when == null ? null : isoDay(when), when,
          href: r.href || '', subject: title, assignedTo: whoI >= 0 ? (cells[whoI] || '') : (cells[2] || ''),
        };
        if (source === 'note') {
          row.title = title;
          row.owner = row.assignedTo;
          // The preview is the first characters of the note body (the cell right after the title when no header says so).
          const pv = prevI >= 0 && prevI !== subjI ? cells[prevI] : (cells[(subjI >= 0 ? subjI : 0) + 1] || '');
          row.preview = cellWhen(pv) != null ? '' : String(pv || '').trim();
        }
        out.push(row);
      }
    }
  }
  return out;
}

/** Read the labelled fields + the visible activity-timeline text of the record page that is open. */
function grabFields(page) {
  return page.evaluate(() => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    // querySelectorAll that also descends into every shadow root (Lightning hides labels/values there)
    const deepAll = (root, sel, out = []) => {
      root.querySelectorAll(sel).forEach((e) => out.push(e));
      root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) deepAll(e.shadowRoot, sel, out); });
      return out;
    };
    const deepIn = (el, sel) => { const r = []; if (el.shadowRoot) deepAll(el.shadowRoot, sel, r); deepAll(el, sel, r); return r[0] || null; };
    const fields = {};
    // Salesforce puts button text next to field values ("Carl Alarcon Preview Change Owner", "8/4/2026 Edit Close Date",
    // "False Onboard Pro Edit Onboard Pro"). Strip it so names/dates come out clean; empty "Edit <label>" fields vanish.
    const clean = (label, value) => {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let x = value;
      x = x.replace(new RegExp('\\s*Edit\\s+' + esc + '\\s*$', 'i'), '');
      let prev; do { prev = x; x = x.replace(/\s*(Preview|Change Owner|Change Record Type|Change Status)\s*$/i, ''); } while (x !== prev);
      x = x.replace(new RegExp('\\s+' + esc + '\\s*$', 'i'), '');
      return x.trim();
    };
    const items = deepAll(document.body, 'records-record-layout-item, lightning-output-field, force-record-layout-item, records-highlights-details-item, .slds-form-element');
    for (const it of items) {
      const lab = deepIn(it, '.test-id__field-label, .slds-form-element__label, label');
      const val = deepIn(it, '.test-id__field-value, .slds-form-element__static, lightning-formatted-text, lightning-formatted-rich-text, lightning-formatted-url, lightning-formatted-name, a, .slds-form-element__control');
      const l = norm(lab && (lab.innerText || lab.textContent)); const v = clean(l, norm(val && (val.innerText || val.textContent)));
      if (l && v && l !== v && !(l in fields)) fields[l] = v.slice(0, 1200);
    }
    // Activity timeline text (tasks, logged calls, notes), anywhere in the tree.
    const parts = [];
    deepAll(document.body, '*').forEach((e) => {
      const tag = e.tagName.toLowerCase(); const cls = (e.className && e.className.baseVal === undefined ? e.className : '') || '';
      if (/activity-timeline|timeline-item|activitytimeline/.test(tag + ' ' + cls)) { const t = norm(e.innerText || e.textContent); if (t) parts.push(t); }
    });
    return { fields, timeline: parts.sort((a, b) => b.length - a.length)[0] || '' };
  }).catch(() => ({ fields: {}, timeline: '' }));
}

/** Rich-text blocks (Salesforce Notes, long-text fields) in this frame, through shadow roots. */
function grabRichIn(frame) {
  return frame.evaluate(() => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const sel = 'lightning-formatted-rich-text, lightning-input-rich-text, .ql-editor, [contenteditable="true"], .slds-rich-text-editor__output, .slds-rich-text-editor__textarea, .note-body, .cke_editable, body.cke_editable';
    const out = [];
    (function walk(n) {
      n.querySelectorAll(sel).forEach((e) => { const t = norm(e.innerText || e.textContent); if (t.length >= 12 && !out.includes(t)) out.push(t.slice(0, 1500)); });
      n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document.documentElement);
    return out;
  }).catch(() => []);
}
async function grabRich(page) {
  const all = [];
  for (const f of page.frames()) for (const t of await grabRichIn(f)) if (!all.includes(t)) all.push(t);
  return all;
}

/** Navigate to a record URL/path and read its fields (retrying while Lightning renders). */
async function readRecord(page, hrefOrUrl) {
  const url = /^https?:/i.test(hrefOrUrl) ? hrefOrUrl : `https://${SF_HOST}${hrefOrUrl.startsWith('/') ? '' : '/'}${hrefOrUrl}`;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (e) { return { ok: false, fields: {}, timeline: '', note: `nav failed: ${e.message}` }; }
  await sleep(4000);
  let r = await grabFields(page);
  for (let i = 0; i < 4 && !Object.keys(r.fields).length; i++) { await sleep(1500); r = await grabFields(page); }
  const rich = await grabRich(page);
  return { ok: Object.keys(r.fields).length > 0 || rich.length > 0, fields: r.fields, rich, timeline: (r.timeline || '').slice(0, 3000) };
}

/**
 * Read one Opportunity record page: its Owner, the labelled fields (Next Step, Description,
 * loss reason, stage…), and the visible Activity timeline text (where reps log notes/calls).
 * Returns { oppId, owner, fields:{label:value}, timeline } — all best-effort/generic, since
 * field layouts vary; `email --review-report` saves it so drafts can be checked against it.
 */
async function readOppDetail(page, oppId) {
  const r = await readRecord(page, `/lightning/r/Opportunity/${oppId}/view`);
  const ownerKey = Object.keys(r.fields).find((k) => /^(opportunity )?owner$/i.test(k)) || Object.keys(r.fields).find((k) => /owner/i.test(k));
  return { oppId, owner: ownerKey ? r.fields[ownerKey] : null, fields: r.fields, timeline: r.timeline, note: r.note };
}

/** Rich-text / plain-text note bodies visible in the open page (all frames, through shadow roots). */
function grabNoteTextIn(frame) {
  return frame.evaluate(() => {
    const norm = (x) => (x || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const sel = '.ql-editor, [contenteditable="true"], [contenteditable=""], div[role="textbox"], lightning-formatted-rich-text, lightning-input-rich-text, .slds-rich-text-editor__output, .slds-rich-text-editor__textarea, .ProseMirror, .cke_editable, .note-body, .note-content, .notes-body, textarea';
    const out = [];
    (function walk(n) {
      n.querySelectorAll(sel).forEach((e) => {
        const raw = e.tagName === 'TEXTAREA' ? e.value : (e.innerText || e.textContent);
        const t = norm(raw);
        if (t.length >= 20 && !out.includes(t)) out.push(t.slice(0, 6000));
      });
      n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document.documentElement);
    return out;
  }).catch(() => []);
}
async function grabNoteText(page) {
  const all = [];
  for (const f of page.frames()) for (const t of await grabNoteTextIn(f)) if (!all.includes(t)) all.push(t);
  return all;
}

/**
 * The note's own text, fetched from INSIDE the logged-in page (same session, nothing is saved to disk),
 * as a fallback when the note page can't be read. → string ('' if unavailable)
 */
async function fetchNoteText(page, noteId) {
  try {
    return await page.evaluate(async (id) => {
      const r = await fetch(`/sfc/servlet.shepherd/document/download/${id}`, { credentials: 'include' });
      if (!r.ok) return '';
      const raw = await r.text();
      if (!/<\w+[^>]*>/.test(raw)) return raw.trim().slice(0, 8000);
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      doc.querySelectorAll('script,style').forEach((e) => e.remove());
      doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      doc.querySelectorAll('p,div,li,h1,h2,h3,h4,tr').forEach((e) => e.append('\n'));
      return (doc.body ? doc.body.textContent : '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
    }, noteId);
  } catch (_) { return ''; }
}

const idFromHref = (href) => { const m = String(href || '').match(/\/lightning\/r\/(?:[A-Za-z]+\/)?([a-zA-Z0-9]{15,18})/); return m ? m[1] : ''; };

/**
 * Open ONE note and read its full text. Tries, in order: the note page's rich text (every frame),
 * the note's text fetched in-page, then the preview from the list. → { body, how, debug }
 */
async function readNoteBody(page, row) {
  const debug = { title: (row.title || '').slice(0, 80), date: row.date, tried: [] };
  let body = ''; let how = null;
  if (row.href) {
    const rec = await readRecord(page, row.href);
    const texts = await grabNoteText(page);
    const rich = texts.filter((t) => t.length >= 20 && t.trim() !== (row.title || '').trim()).sort((a, b) => b.length - a.length)[0];
    debug.tried.push(`note page: ${rec.ok || texts.length ? 'opened' : 'not readable'}, ${texts.length} text block(s)${rich ? `, best ${rich.length} chars` : ''}`);
    if (rich) { body = rich; how = 'note page'; }
  } else debug.tried.push('no link on the list row');
  if (!body && idFromHref(row.href)) {
    const t = await fetchNoteText(page, idFromHref(row.href));
    debug.tried.push(`in-page text fetch: ${t ? t.length + ' chars' : 'nothing'}`);
    if (t && t.length >= 20) { body = t; how = 'note text (in-page fetch)'; }
  }
  if (!body && row.preview) { body = row.preview; how = 'list preview only'; debug.tried.push(`preview ${row.preview.length} chars`); }
  // If the page text merely repeats the title in front of the real body, drop the repeated title.
  if (body && row.title && body.startsWith(row.title)) body = body.slice(row.title.length).trim();
  debug.how = how; debug.chars = body.length;
  return { body, how, debug };
}

/**
 * Read the LAST `want` notes in full (newest first, by "last modified"). → { notes, opened, debug }
 *   notes: [{ date, subject, assignedTo, body, how, label }]
 */
async function readNoteBodies(page, noteRows, { want = 3 } = {}) {
  const newest = noteRows.filter((r) => r.source === 'note')
    .sort((a, b) => (b.when || 0) - (a.when || 0)).slice(0, want);
  const notes = []; const debug = [];
  let unreadable = 0;
  for (const r of newest) {
    // Note pages that can't be read twice in a row won't suddenly work: use the list previews for the rest (saves ~5s each).
    if (unreadable >= 2 && r.preview) { debug.push({ title: (r.title || '').slice(0, 80), date: r.date, tried: ['skipped opening (earlier note pages were unreadable)', `preview ${r.preview.length} chars`], how: 'list preview only', chars: r.preview.length }); notes.push({ date: r.date, subject: r.title, assignedTo: r.owner || '', body: r.preview, how: 'list preview only', label: 'list preview only' }); continue; }
    const res = await readNoteBody(page, r);
    if (res.how === 'list preview only' || !res.how) unreadable++;
    debug.push(res.debug);
    if (res.body && res.body.length >= 8) notes.push({ date: r.date, subject: r.title, assignedTo: r.owner || '', body: res.body.slice(0, 3000), how: res.how, label: res.how });
  }
  return { notes, opened: newest.length, debug };
}

const ts = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? -Infinity : t; };
const dayStart = (iso) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Pure decision from what was read. `firstAt` = ISO time of our first outreach. */
function decide({ oppRead, opps, notes, firstAt, recentN = 3, now = Date.now(), wonFlagDays = WON_FLAG_DAYS, allClosedOut = true, ignoreOppIds = null }) {
  const reasons = []; const warnings = []; const flags = []; let hardStop = null;
  if (!oppRead.ok) {
    return { verdict: 'unknown', reasons: [`could not read opportunities (${oppRead.note || 'no table found'}) — not sending`], warnings, flags };
  }
  const sorted = [...opps].sort((a, b) => ts(b.closeDate) - ts(a.closeDate));
  const since = firstAt ? dayStart(firstAt) : null;
  // `ignoreOppIds` = 15-character ids of Closed Won opportunities that are the free Invoicing and Payments sign-up (planRelease.freePlanWins read them; business coaching only if released): not a close,
  // so the two rules below leave them out. They still count as "something was won" further down, so an account whose only win is one of them is never "closed out".
  const free = (o) => !!(ignoreOppIds && o.id && ignoreOppIds.has(String(o.id).toLowerCase().slice(0, 15)));
  const wonSince = since != null ? sorted.find((o) => CLOSED_WON_RE.test(o.stage) && !free(o) && ts(o.closeDate) >= since && ts(o.closeDate) >= now - wonFlagDays * 86400000) : null;
  if (wonSince) reasons.push(`Closed Won "${wonSince.name}" (${wonSince.closeDate}) on/after our first touch (${String(firstAt).slice(0, 10)})`);
  // FLAG: any Closed Won within the last `wonFlagDays` days (any opp, any rep) — another rep may
  // already have closed this account, so it must not get a sales follow-up.
  const won30 = sorted.find((o) => CLOSED_WON_RE.test(o.stage) && !free(o) && ts(o.closeDate) >= now - wonFlagDays * 86400000);
  for (const o of sorted) if (CLOSED_WON_RE.test(o.stage) && free(o) && ts(o.closeDate) >= now - wonFlagDays * 86400000) warnings.push(`Closed Won "${o.name}" (${o.closeDate}) is not a customer plan (the free Invoicing and Payments sign-up, or business coaching if released): not counted as a close`);
  if (won30) { flags.push('closed_won_30d'); reasons.push(`⚠️ FLAG closed-won ${wonFlagDays}d: "${won30.name}" (${won30.closeDate})${won30.owner ? ' owned by ' + won30.owner : ''} — another rep may have closed this account`); }
  // Only a Closed Won inside the last `wonFlagDays` days stops an account; older wins (this year or not) are contactable.
  // (recentN is kept for callers but no longer triggers a "current customer" skip.)
  const anyWon = sorted.some((o) => CLOSED_WON_RE.test(o.stage));
  if (allClosedOut && opps.length && !anyWon && opps.every((o) => CLOSED_ANY_RE.test(o.stage))) {
    reasons.push(`all ${opps.length} opportunit${opps.length === 1 ? 'y is' : 'ies are'} closed out (${[...new Set(opps.map((o) => o.stage))].join(', ')}) — not interested anymore`);
  }
  for (const n of notes) {
    if (HARD_STOP_RE.test(n.text)) { if (!hardStop) hardStop = `${n.source}${n.date ? ' ' + n.date : ''}: ${n.text.slice(0, 90)}`; reasons.push(`${n.source}${n.date ? ' ' + n.date : ''}: "${n.text.slice(0, 90)}" (do-not-contact)`); }
    else if (SOFT_STOP_RE.test(n.text)) {
      const after = n.date && firstAt && ts(n.date) >= dayStart(firstAt);
      (after ? reasons : warnings).push(`${n.source}${n.date ? ' ' + n.date : ' (undated)'}: "${n.text.slice(0, 90)}"${after ? ' — after our first touch' : ' — not dated after our first touch, warning only'}`);
    }
  }
  return { verdict: reasons.length ? 'skip' : 'proceed', reasons, warnings, hardStop, flags, won30: won30 || null };
}

/** Review one account. `lead` = { accountId, name, firstAt }. Returns the full record. */
/**
 * The Closed Won opportunity from the last 30 days that decide() found (any rep), with its OWNER: from the related list's Opportunity Owner
 * column, else read off the opportunity page. → { name, stage, closeDate, owner, oppId } | null
 */
async function resolveClosedWon(page, won30) {
  if (!won30) return null;
  let owner = won30.owner || '';
  if (!owner && won30.id) { try { owner = (await readOppDetail(page, won30.id)).owner || ''; } catch (_) {} }
  return { name: won30.name, stage: won30.stage, closeDate: won30.closeDate, owner: owner || null, oppId: won30.id || null };
}

/**
 * The Closed Won opportunities of the last `wonFlagDays` days that are only the free Invoicing and Payments sign-up (planRelease.js; business coaching too once coachingPolicy.js releases it): decide() does not count them.
 * → Set of 15-character opportunity ids, or null (switched off with `freePlan: false`, opportunities not read, or any doubt: then every Closed Won counts, as it always did).
 * Read-only; `inspect` is for tests.
 */
async function freePlanWins(page, oppRead, { freePlan = true, now = Date.now(), wonFlagDays = WON_FLAG_DAYS, inspect } = {}) {
  if (!freePlan || !oppRead || !oppRead.ok) return null;
  try { return await require('./planRelease').freePlanWins(page, oppRead.opps, { now, days: wonFlagDays, inspect, sfReview: { readOppDetail } }); } catch (_) { return null; }
}

/** `deps` is for tests: { readOpportunities, readNotes, inspect, now }. */
async function reviewAccount(page, lead, { detail = false, allClosedOut = true, notes: readTheNotes = true, freePlan = true } = {}, deps = {}) {
  const oppRead = await (deps.readOpportunities || readOpportunities)(page, lead.accountId);
  // The Notes list is read for the do-not-contact / "not interested" check. { notes: false } skips it: the opportunities alone are read (one page).
  const notes = oppRead.ok && readTheNotes ? await (deps.readNotes || readNotes)(page, lead.accountId) : [];
  // A Closed Won that is only the free Invoicing and Payments sign-up is not a close (business coaching stays one: kept out of outreach). Read AFTER the notes, so the page the review leaves open is still the Notes list unless
  // one of those opportunities had to be opened (only an account with a Closed Won from the last 30 days: a small share of reviews).
  const ignoreOppIds = await freePlanWins(page, oppRead, { freePlan, inspect: deps.inspect, now: deps.now });
  const { won30, ...d } = decide({ oppRead, opps: oppRead.opps, notes, firstAt: lead.firstAt, allClosedOut, ignoreOppIds });
  // A Closed Won opportunity from the last 30 days (any rep): keep the opportunity itself and its OWNER, so the bot can put the account on the closed-won list.
  const closedWon = await resolveClosedWon(page, won30);
  // Optional deep read of the most recent Lost Demo opp (else the most recent opp): owner,
  // fields and rep notes — for drafting personalised follow-ups.
  let oppDetail = null;
  if (detail && oppRead.ok) {
    const byDate = [...oppRead.opps].sort((a, b) => ts(b.closeDate) - ts(a.closeDate));
    const target = byDate.find((o) => /lost[\s_-]*demo/i.test(o.stage) && o.id) || byDate.find((o) => o.id);
    if (target) oppDetail = { ...(await readOppDetail(page, target.id)), oppName: target.name, stage: target.stage, closeDate: target.closeDate };
  }
  return { accountId: lead.accountId, accountName: lead.name, firstAt: lead.firstAt || null, oppDetail, ...d, closedWon, opps: oppRead.opps.map(({ name, stage, closeDate, owner, id }) => ({ name, stage, closeDate, owner: owner || '', id: id || '' })), notesRead: notes.length, notes: notes.slice(0, 10) };
}


// ---- Evidence for --auto ---------------------------------------------------------------------
const SENDER = require('./sender');
const SELF_RE = SENDER.selfRe;      // this copy's own sender (sender.json fullName): never named as "the original rep"; matches nothing until it is filled in
const SYSTEM_NAME_RE = /^(automated|automation|integration|engineering|system|admin|process|api|bot|salesforce|marketing|insidesales|data\.com|unassigned|queue)\b/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const goodRep = (n) => {
  if (!n || n.trim().length <= 2 || SELF_RE.test(n) || SYSTEM_NAME_RE.test(n.trim())) return false;
  const tk = n.trim().toLowerCase().split(/\s+/);
  return !(tk.length > 1 && tk.every((t) => t === tk[0]));   // "Engineering Engineering" is a system user, not a person
};
const firstNameOf = (n) => { const w = String(n || '').trim().split(/\s+/)[0] || ''; return w ? w[0].toUpperCase() + w.slice(1) : ''; };
// "Interaction Summary (phone call) — Carl Alarcon"  /  "SMB Attended demo 5/22/26 - Andrew Wynkoop"  → the rep's name at the end of the title
const personAtEnd = (title) => {
  const m = String(title || '').match(/[—–-]\s*([A-Z][A-Za-z'.]+(?:\s+[A-Z][A-Za-z'.]+){1,2})\s*$/);
  return m && !/\d/.test(m[1]) ? m[1].trim() : null;
};

// ---- The original demo: who ran it and when ----------------------------------------------------
const DEMO_WORD = /\bdemo(?:nstrat\w*)?\b|\bwalk-?through\b/i;
// The demo actually HAPPENED (or was attempted) in this sentence…
const DEMO_HAPPENED = /\b(?:ran|run|running|gave|give|giving|did|conduct\w*|complet\w*|attempt\w*|start\w*|show\w*|present\w*|attended|screen[- ]?shar\w*)\b[^.;!?]{0,60}\b(?:demo(?:nstrat\w*)?|walk-?through)\b|\b(?:demo(?:nstrat\w*)?)\b[^.;!?]{0,40}\b(?:went|was (?:done|given|completed)|completed|finished|attended)\b|\b(?:after|following) (?:the|his|her|their|our) demo\b|\bpost[- ]demo\b/i;
// …and not merely offered/scheduled.
const DEMO_NOT_YET = /\b(?:invit\w*|schedul\w*|reschedul\w*|book(?:ed|ing)?|calendly|no[- ]?show|confirm\w*|set up|offer\w*|interested in (?:a )?demo|would you like|want (?:a )?demo)\b/i;
const PEOPLE_LABELS = /^(demo attendee|primary contact name)$/i;

/** First m/d/yy(yy) date written inside a note TITLE → 'YYYY-MM-DD' (the date the title says the demo was). */
function dateInTitle(title) {
  const m = String(title || '').match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (!m) return null;
  let y = parseInt(m[3], 10); if (y < 100) y += 2000;
  const d = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10), 12);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Earliest note (by date) whose text says a demo was actually given/attempted. → { note, sentence } | null */
function demoDoneNote(noteRows, noteBodies) {
  const texts = [];
  for (const r of noteRows) texts.push({ date: r.date, when: r.when || 0, title: r.title || '', text: `${r.preview || ''}` });
  // Opened notes add detail only when their page gave MORE than the list preview (otherwise the row above already covers them).
  for (const b of noteBodies || []) {
    if (b.how === 'list preview only') continue;
    const row = noteRows.find((r) => r.title === b.subject && r.date === b.date);
    texts.push({ date: b.date, when: (row && row.when) || Date.parse(b.date || '') || 0, title: b.subject || '', text: b.body || '' });
  }
  const hits = [];
  for (const t of texts) {
    for (const sent of String(t.text).split(/(?<=[.;!?])\s+|\n+/)) {
      if (DEMO_WORD.test(sent) && DEMO_HAPPENED.test(sent) && !DEMO_NOT_YET.test(sent)) { hits.push({ ...t, sentence: sent.trim().slice(0, 170) }); break; }
    }
  }
  hits.sort((a, b) => (a.when || 9e15) - (b.when || 9e15));
  return hits[0] || null;
}

/**
 * ORIGINAL DEMO — from the evidence only:
 *   rep  = the Opportunity Owner (opportunity page, then the list column); else the rep named on a "demo" note
 *          title, else on the call-summary notes (most frequent), else whoever wrote the notes. Luke and system
 *          users are never named. `others` = other reps who appear on the notes.
 *   date = an opportunity "demo date" field → a note titled "demo" (its title date, else its date) → the earliest
 *          note whose text says a demo was given/attempted → a Lost Demo opportunity's close date → none.
 *          (An opportunity's Close Date alone says nothing about when anyone met, so it is shown but NOT used.)
 *   why  = the opportunity's demo-outcome fields (Demo Objection, Specifics, Disqualified Reason, Competitor, …).
 * → { rep, demo, original }  where original = { repName, repFirstName, repSource, others, date, month, year, dateSource,
 *                                              dateEvidence, oppStage, oppCloseDate, why }
 */
function resolveRepAndDemo({ detail, target, noteRows, noteBodies }) {
  const notes = noteRows.filter((r) => r.source === 'note');
  const cands = [];
  if (detail && detail.owner) cands.push({ name: detail.owner, source: 'Opportunity Owner' });
  if (target && target.owner) cands.push({ name: target.owner, source: 'Opportunity Owner (list)' });
  const demoTitled = [...notes].filter((r) => /\bdemo\b/i.test(r.title || '') && !/(invit|schedul|no[- ]?show)/i.test(r.title || '')).sort((a, b) => (b.when || 0) - (a.when || 0))[0];
  if (demoTitled && personAtEnd(demoTitled.title)) cands.push({ name: personAtEnd(demoTitled.title), source: 'demo note title' });
  const tally = new Map();
  for (const r of notes.slice(0, 8)) { const n = personAtEnd(r.title); if (goodRep(n)) tally.set(n, (tally.get(n) || 0) + 1); }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) cands.push({ name: top[0], source: 'call-summary notes' });
  const authors = new Map();
  for (const r of notes.slice(0, 8)) if (goodRep(r.owner)) authors.set(r.owner, (authors.get(r.owner) || 0) + 1);
  for (const b of noteBodies || []) if (goodRep(b.assignedTo)) authors.set(b.assignedTo, (authors.get(b.assignedTo) || 0) + 1);
  const au = [...authors.entries()].sort((a, b) => b[1] - a[1])[0];
  if (au) cands.push({ name: au[0], source: 'who wrote the notes' });
  const pick = cands.find((c) => goodRep(c.name));
  const rep = pick ? { name: pick.name.trim(), firstName: firstNameOf(pick.name), source: pick.source } : null;

  // Other reps named on the notes (so Luke can reference them too)
  const others = [];
  for (const n of [...notes.slice(0, 8).map((r) => personAtEnd(r.title)), ...notes.slice(0, 8).map((r) => r.owner)]) {
    if (goodRep(n) && (!rep || n.trim().toLowerCase() !== rep.name.toLowerCase()) && !others.includes(n.trim())) others.push(n.trim());
  }

  // Date of the original demo
  let d = null;
  const dateField = detail && detail.fields ? Object.entries(detail.fields).find(([k, v]) => /demo/i.test(k) && /date|when|scheduled/i.test(k) && Number.isFinite(Date.parse(v))) : null;
  const doneNote = demoDoneNote(noteRows, noteBodies);
  const lostDemoTarget = target && /lost[\s_-]*demo/i.test(target.stage || '') && Number.isFinite(Date.parse(target.closeDate));
  if (dateField) d = { date: new Date(Date.parse(dateField[1])).toISOString().slice(0, 10), source: `opportunity field "${dateField[0]}"`, evidence: `${dateField[0]}: ${dateField[1]}` };
  else if (demoTitled && (dateInTitle(demoTitled.title) || demoTitled.date)) d = { date: dateInTitle(demoTitled.title) || demoTitled.date, source: 'demo note title', evidence: `note "${demoTitled.title}"` };
  else if (doneNote && doneNote.date) d = { date: doneNote.date, source: 'call-summary note (demo given)', evidence: `note "${doneNote.title}" (${doneNote.date}): ${doneNote.sentence}` };
  else if (lostDemoTarget) d = { date: new Date(Date.parse(target.closeDate)).toISOString().slice(0, 10), source: 'Lost Demo close date', evidence: `Lost Demo opportunity closed ${target.closeDate}` };
  let demo = null;
  if (d) { const dt = new Date(d.date + 'T12:00:00'); demo = { date: d.date, month: MONTHS[dt.getMonth()], year: dt.getFullYear(), source: d.source, evidence: d.evidence }; }

  // Why it didn't close: the opportunity's own demo-outcome fields
  const why = {};
  if (detail && detail.fields) for (const [k, v] of Object.entries(detail.fields)) {
    if (v && !PEOPLE_LABELS.test(k) && /demo objection|disqualified reason|dq |deal lost|commit holdup|competitor|follow up date|missing feature/i.test(k) && !/^(false|no)$/i.test(v)) why[k] = String(v).slice(0, 200);
  }
  const original = {
    repName: rep ? rep.name : null, repFirstName: rep ? rep.firstName : null, repSource: rep ? rep.source : null, others,
    date: demo ? demo.date : null, month: demo ? demo.month : null, year: demo ? demo.year : null,
    dateSource: demo ? demo.source : null, dateEvidence: demo ? demo.evidence : null,
    oppStage: target ? target.stage : null, oppCloseDate: target ? target.closeDate : null, why,
  };
  return { rep, demo, original };
}

// ---- OUR REP'S GRANOLA NOTE: checked FIRST ---------------------------------------------------------
// Granola keeps a rep's own meeting notes, and they reach Salesforce as a Note titled "Granola". When the rep this copy sends as (sender.json fullName) has one on the account, that
// rep already talked to this pro, and the note is the best material there is. buildEvidence reads it FIRST, before the opportunity page and the last notes, and it leads the evidence:
// the first of `noteBodies` (marked granola: true), then recent_notes[0] with our_own_granola_note in autoPlan.js. READ-ONLY, like everything in this file.
const GRANOLA_RE = /\bgranola\b/i;                 // "Granola", "granola", "Granola - Acme Roofing call"
const GRANOLA_MAX_CHARS = 6000;                    // an ordinary note keeps 3000 characters; this one is the main material
const GRANOLA_TEXT_LOOKS = 2;                      // at most this many Granola notes with no known author are opened only to look for the rep's name in their text
const looksLikePerson = (o) => /^\p{L}[\p{L}'.-]*(?:\s+\p{L}[\p{L}'.-]*){1,3}$/u.test(String(o || '').trim());

/**
 * Whose is a note titled Granola, as far as the Notes list can tell? (pure: reads nothing)
 *   ours    — our rep is the note's Owner / Created By (matchedOn 'owner') or is named in its title ('title')
 *   other   — the list names ANOTHER person as its author and the title does not name our rep: never ours (a "hand this to <rep>" line in someone else's note must not pass for
 *             our own meeting)
 *   unknown — the list names no author, or only a system / integration user (the call-summary notes are written by one): readGranolaNote looks at the note's text instead
 */
function granolaOwnership(row, { selfRe = SELF_RE } = {}) {
  if (selfRe.test(row.owner || '')) return { who: 'ours', matchedOn: 'owner' };
  if (selfRe.test(row.title || '')) return { who: 'ours', matchedOn: 'title' };
  return { who: looksLikePerson(row.owner) && goodRep(row.owner) ? 'other' : 'unknown', matchedOn: null };
}

/** The notes titled Granola among the Notes list rows, newest first, each with whose the list says it is. (pure) → [{ row, who, matchedOn }] */
function granolaNotes(noteRows, { selfRe = SELF_RE } = {}) {
  return noteRows.filter((r) => r.source === 'note' && GRANOLA_RE.test(r.title || ''))
    .sort((a, b) => (b.when || 0) - (a.when || 0))
    .map((row) => ({ row, ...granolaOwnership(row, { selfRe }) }));
}

/**
 * Find and read OUR REP'S GRANOLA NOTE. → { found, note, row, matchedOn, reason, titled, debug }
 *   note = { date, subject, assignedTo, body, how, label, granola: true, matchedOn }: the shape readNoteBodies gives, plus the two Granola fields. `body` is the note's full text
 *          (readNoteBody: the note page, then the in-page fetch, then the list preview), up to GRANOLA_MAX_CHARS.
 * Order: the newest note the list says is ours (up to 3 tries when a page will not read); only when there is none, the newest notes with no known author (at most GRANOLA_TEXT_LOOKS),
 * taken when their text names the rep. A note the list says another person wrote is never opened. No note titled Granola, or no fullName in sender.json: nothing is opened (no page load).
 * `reason` says why nothing was found. `readBody` is for tests.
 */
async function readGranolaNote(page, noteRows, { selfRe = SELF_RE, repName = SENDER.fullName, readBody = readNoteBody } = {}) {
  const out = { found: false, note: null, row: null, matchedOn: null, reason: '', titled: 0, debug: [] };
  if (!repName) { out.reason = 'sender.json has no fullName, so there is no rep name to look for'; return out; }
  const cands = granolaNotes(noteRows, { selfRe });
  out.titled = cands.length;
  if (!cands.length) {
    const n = noteRows.filter((r) => r.source === 'note').length;
    out.reason = `no note titled Granola on the account (${n} note${n === 1 ? '' : 's'} listed)`;
    return out;
  }
  const readable = (res) => !!(res && res.body && res.body.length >= 8);
  const take = (c, res, matchedOn) => {
    out.found = true; out.row = c.row; out.matchedOn = matchedOn;
    out.note = { date: c.row.date, subject: c.row.title, assignedTo: c.row.owner || '', body: res.body.slice(0, GRANOLA_MAX_CHARS), how: res.how, label: res.how, granola: true, matchedOn };
    return out;
  };
  const who = (w) => cands.filter((c) => c.who === w);
  let tries = 0;
  for (const c of who('ours')) {
    if (tries++ >= 3) break;
    const res = await readBody(page, c.row);
    out.debug.push({ ...((res && res.debug) || {}), granola: true });
    if (readable(res)) return take(c, res, c.matchedOn);
  }
  if (!who('ours').length) {
    for (const c of who('unknown').slice(0, GRANOLA_TEXT_LOOKS)) {
      const res = await readBody(page, c.row);
      out.debug.push({ ...((res && res.debug) || {}), granola: true });
      if (readable(res) && selfRe.test(res.body)) return take(c, res, 'text');
    }
  }
  const parts = [];
  if (who('ours').length) parts.push(`the Granola note by ${repName} could not be read (its page, the in-page fetch and the list preview were all empty)`);
  else if (who('unknown').length) parts.push(`${who('unknown').length} Granola note(s) with no author on the list do not name ${repName} in their text`);
  if (who('other').length) parts.push(`${who('other').length} Granola note(s) written by ${[...new Set(who('other').map((c) => c.row.owner))].join(', ')}, not ${repName}`);
  out.reason = parts.join('; ');
  return out;
}

/**
 * Everything the --auto planner needs for one account (READ-ONLY): the opportunities (3 most
 * recent in `recentOpps`), the flags/verdict (closed-won in 30 days, Do-Not-Call, all closed, …), the
 * Lost Demo opportunity's owner + fields, and the LAST 3 NOTES opened and read in full.
 * Activity History is read for ONE reason only — the Do-Not-Call safety scan of its titles — and is
 * not research material. Heavy reads happen only for accounts that pass the checks.
 * FIRST of those heavy reads: OUR REP'S GRANOLA NOTE (readGranolaNote), a note titled Granola that belongs to the rep this copy sends as. Found, its full text leads `noteBodies`
 * (marked granola: true) and the last notes follow without repeating it; `ev.granola` says what the check found, or why it found nothing. `deps` is for tests:
 * { readOpportunities, readNotes, readOppDetail, readNoteBody, readNoteBodies }.
 */
async function buildEvidence(page, lead, { now = Date.now(), recentOppN = 3, recentNoteN = 3 } = {}, deps = {}) {
  const oppRead = await (deps.readOpportunities || readOpportunities)(page, lead.accountId);
  const rows = oppRead.ok ? await (deps.readNotes || readNotes)(page, lead.accountId) : [];
  const noteRows = rows.filter((r) => r.source === 'note').sort((a, b) => (b.when || 0) - (a.when || 0));
  const activityRows = rows.filter((r) => r.source === 'activity');
  const ignoreOppIds = await freePlanWins(page, oppRead, { now });      // a Closed Won that is only Invoicing and Payments is not a close (see reviewAccount)
  let d = decide({ oppRead, opps: oppRead.opps, notes: rows, firstAt: lead.firstAt, now, ignoreOppIds });
  const sorted = [...oppRead.opps].sort((a, b) => ts(b.closeDate) - ts(a.closeDate));
  const ev = {
    ok: oppRead.ok, verdict: d.verdict, reasons: d.reasons, warnings: d.warnings, flags: d.flags || [], hardStop: d.hardStop || null,
    opps: sorted.map(({ name, stage, closeDate, owner, id }) => ({ name, stage, closeDate, owner: owner || '', id })),
    recentOpps: sorted.slice(0, recentOppN).map(({ name, stage, closeDate, owner }) => ({ name, stage, closeDate, owner: owner || '' })),
    noteRows, noteTitles: noteRows.slice(0, 12).map(({ date, title, owner, preview }) => ({ date, title, owner, preview: (preview || '').slice(0, 120) })),
    safety: { activityTitlesScanned: activityRows.length, notesListed: noteRows.length },
    oppDetail: null, noteBodies: [], noteBodiesOpened: 0, noteDebug: [], granola: null, rep: null, demo: null, original: null,
    closedWon: await resolveClosedWon(page, d.won30),
  };
  if (!oppRead.ok || d.verdict !== 'proceed') return ev;
  // FIRST of the heavy reads, before the opportunity page and the last notes: does the rep this copy sends as have a Granola note on this account? Never a reason to fail the
  // review: any trouble here just means "no Granola note", and everything after it runs as it always did.
  let g;
  try { g = await readGranolaNote(page, noteRows, { readBody: deps.readNoteBody }); }
  catch (e) { g = { found: false, note: null, row: null, matchedOn: null, reason: `the Granola check failed (${e.message})`, titled: 0, debug: [] }; }
  ev.granola = g.note
    ? { found: true, matchedOn: g.matchedOn, date: g.note.date, title: g.note.subject, owner: g.note.assignedTo, how: g.note.how, chars: g.note.body.length, titled: g.titled }
    : { found: false, reason: g.reason, titled: g.titled };
  const target = sorted.find((o) => /lost[\s_-]*demo/i.test(o.stage) && o.id) || sorted.find((o) => o.id) || null;
  if (target) {
    const det = await (deps.readOppDetail || readOppDetail)(page, target.id);
    ev.oppDetail = { oppName: target.name, stage: target.stage, closeDate: target.closeDate, owner: det.owner, fields: det.fields, timeline: det.timeline };
  }
  // The last notes follow. Our Granola note, when there is one, is not read twice, and it is NOT an input to the original rep / demo guess below: it is OUR conversation with the
  // pro, not the original demo (its author must never be named as "the original rep", nor its date taken for the demo's).
  const others = g.row ? noteRows.filter((r) => r !== g.row) : noteRows;
  const nb = await (deps.readNoteBodies || readNoteBodies)(page, others, { want: recentNoteN });
  ev.noteBodies = g.note ? [g.note, ...nb.notes] : nb.notes;
  ev.noteBodiesOpened = nb.opened + (g.note ? 1 : 0);
  ev.noteDebug = [...g.debug, ...nb.debug];
  // Second safety pass over the full note text. A hit SKIPS the account but is never auto-banned
  // (a long call summary can mention these words innocently); the Do-Not-Call ban comes from titles only.
  const d2 = decide({ oppRead, opps: oppRead.opps, notes: ev.noteBodies.map((n) => ({ source: 'note', text: n.body, date: n.date })), firstAt: lead.firstAt, now, ignoreOppIds });
  if (d2.verdict !== 'proceed') {
    ev.verdict = 'skip';
    ev.reasons = [...ev.reasons, ...d2.reasons.map((r) => `${r} [in the full note text — not auto-banned, please check]`)];
    ev.flags = [...new Set([...ev.flags, ...(d2.flags || [])])];
    return ev;
  }
  const rd = resolveRepAndDemo({ detail: ev.oppDetail, target, noteRows: others, noteBodies: nb.notes });
  ev.rep = rd.rep; ev.demo = rd.demo; ev.original = rd.original;
  return ev;
}

module.exports = { resolveClosedWon, grabFields, buildEvidence, resolveRepAndDemo, granolaNotes, granolaOwnership, readGranolaNote, demoDoneNote, dateInTitle, readRecord, readNoteBodies, readNoteBody, personAtEnd, readOppDetail, reviewAccount, decide, freePlanWins, readOpportunities, readNotes, CLOSED_WON_RE, WON_FLAG_DAYS };
