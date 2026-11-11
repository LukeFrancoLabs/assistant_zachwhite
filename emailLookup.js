'use strict';

/**
 * emailLookup — `email --email --by-email`: a Salesforce report whose rows are EMAIL ADDRESSES, not accounts.
 *
 *   0. openEmailReport()    ask for the report, find it in ANY tab, wait for it to draw; if there is none, say what Chrome has open and ask again.
 *   1. harvestEmails()      read every row of the open report and keep its email address (the report has no Account link to follow).
 *   2. findAccountByEmail() search Salesforce for that address, and find the ACCOUNT it belongs to (a Contact's account, or the account itself).
 *   3. the normal email flow takes over with { name, accountId, url, email }: banned / closed-won / current customers / already-emailed are skipped as always,
 *      and the email goes ONLY to the address on the report (emailAccount refuses a composer addressed to anyone else).
 *
 * Every lookup is cached in email-lookups.jsonl (newest line per address wins) so a re-run does not search the same address twice.
 * A miss is only believed if the results page was really READ: a closed window / Salesforce login stops the run (LookupAbort) and an unreadable page
 * comes back as status 'error' (shown, never cached). A closed window used to answer "none" for every address left, and that was cached for 7 days.
 * The pure parts (rowsToEmails, pickAccount) are tested without a browser; the page parts are written against the usual Lightning markup and
 * `--by-email --debug-lookup` prints what a results page actually offered, so the selectors can be tuned from real output.
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = process.env.ASSISTANT_EMAIL_LOOKUP_FILE || path.join(__dirname, 'email-lookups.jsonl');
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const normEmail = (e) => String(e || '').trim().toLowerCase();

/** The lookups cannot go on. `kind` = 'browser' (window closed) | 'crash' (the tab died: "Aw, Snap! Error code 5") | 'login' | 'errors' (the results page keeps being unreadable). */
class LookupAbort extends Error { constructor(message, kind) { super(message); this.name = 'LookupAbort'; this.kind = kind; } }
const GONE_RE = /Target (page, context or browser has been )?closed|Browser has been closed|Session closed|Page closed/i;
const CRASH_RE = /Target crashed|Page crashed|tab not responding/i;
const LOGIN_RE = /\/\/login\.salesforce\.com|[?&]ec=30\d|\/login\.jsp/i;
/** Run `p`, but stop waiting after `ms` (a dead tab can leave close() / evaluate() hanging for ever). */
const within = (p, ms, what = 'timed out') => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(what)), ms); Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
/** Is the page we search with dead? → 'closed' (window closed / browser quit) | 'crashed' (the tab's process died or stopped answering) | null. `err` = what a Playwright call just threw, if anything. */
function pageState(page, err) {
  try { if (page.isClosed()) return 'closed'; } catch (_) {}
  const msg = String((err && err.message) || err || '');
  if (page.__crashed || CRASH_RE.test(msg)) return 'crashed';
  return GONE_RE.test(msg) ? 'closed' : null;
}
const pageGone = (page, err) => !!pageState(page, err);
/** A cached "none" is believable only if the results page was really read (`readable`) or it says why (the contact has no account). Rows written before this check carry neither. */
const hollowMiss = (r) => r.status === 'none' && !r.why && !(r.readable > 0);

// ---------------------------------------------------------------------------------------------------------------------
// 1. harvest the report
// ---------------------------------------------------------------------------------------------------------------------

/** Runs IN THE REPORT FRAME: every visible row of the grid → { headers, rows:[{ cells:[text…] }] }. Header cells keep just their label. */
function scrapeGrid() {
  const tbl = document.querySelector('table.data-grid-full-table');
  if (!tbl) return { found: false, headers: [], rows: [] };
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const tidy = (h) => clean(h).replace(/\s*Sorted by .*$/i, '').replace(/\s*Column Actions\s*$/i, '');
  const hdrRow = tbl.querySelector('thead tr');
  const headers = hdrRow ? Array.from(hdrRow.querySelectorAll('th,td')).map((c) => tidy(c.innerText)) : [];
  const rows = Array.from(tbl.querySelectorAll('tbody tr, tr')).filter((tr) => tr !== hdrRow).map((tr) => ({
    cells: Array.from(tr.querySelectorAll('td,th')).map((c) => clean(c.innerText)),
    mailto: Array.from(tr.querySelectorAll('a[href^="mailto:"]')).map((a) => a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]),
  }));
  return { found: true, headers, rows };
}

/**
 * Raw grid rows → [{ email, name, cols }]. The email column is the header that says "email" (else any cell that is exactly an address); a row
 * without an address (group headers, subtotals) is dropped; the same address twice keeps its first row. `name` is a Name / Company / Account cell if there is one.
 */
function rowsToEmails(headers, rows) {
  const hi = headers.findIndex((h) => /e-?mail/i.test(h || ''));
  const nameIdx = headers.findIndex((h) => /^(account|company|business|name|full name|contact|first name)\b/i.test(h || '') && !/e-?mail/i.test(h || ''));
  const seen = new Set(), out = [];
  for (const r of rows) {
    const cells = r.cells || [];
    let email = null;
    if (hi >= 0) { const m = (cells[hi] || '').match(EMAIL_RE); if (m) email = m[0]; }
    if (!email) { const c = cells.find((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)); if (c) email = c; }
    if (!email && r.mailto && r.mailto.length) email = r.mailto[0];
    if (!email) continue;
    const key = normEmail(email);
    if (seen.has(key)) continue;
    seen.add(key);
    const cols = {}; cells.forEach((v, i) => { const h = headers[i]; if (h && v && v.length <= 140) cols[h] = v; });
    out.push({ email: key, name: nameIdx >= 0 && cells[nameIdx] && !EMAIL_RE.test(cells[nameIdx]) ? cells[nameIdx] : null, cols });
  }
  return out;
}

/** Scroll the whole (virtualized) report once, collecting every email. `deps` = { reportFrame, reportScrollStep, sleep } from Assistant. */
async function harvestEmails(page, deps) {
  const { reportFrame, reportScrollStep, sleep } = deps;
  const frame = reportFrame(page);
  if (!frame) throw new Error('report iframe not found — open a Salesforce REPORT and let its rows render');
  const byEmail = new Map(); let headers = [];
  const read = async () => {
    const g = await frame.evaluate(scrapeGrid);
    if (g.headers.filter(Boolean).length > headers.filter(Boolean).length) headers = g.headers;
    let fresh = 0;
    for (const e of rowsToEmails(g.headers.length ? g.headers : headers, g.rows)) if (!byEmail.has(e.email)) { byEmail.set(e.email, e); fresh++; }
    return fresh;
  };
  await reportScrollStep(frame, 'top'); await sleep(800);
  let stable = 0;
  for (let round = 0; round < 800; round++) {
    const fresh = await read();
    const st = await reportScrollStep(frame, 'down'); await sleep(450);
    if (!st.hasScroller) break;
    if (st.atBottom && !fresh) { stable++; if (stable >= 2) break; } else stable = 0;
  }
  const out = [...byEmail.values()];
  out.headers = headers;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1b. find the report in the browser
// ---------------------------------------------------------------------------------------------------------------------

const PROBE_BASE = process.env.REPORT_PROBE_BASE || path.join(__dirname, 'report-probe');   // report-probe.json + .png: what Chrome showed when no report was found
const SF_HOST = 'lightning.force.com';
const REPORT_URL_RE = /\/Report\/|lightningReportApp|\/reports?\//i;
const plainUrl = (u) => String(u || '').split(/[?#]/)[0].slice(0, 110);                      // no query / hash: they can carry session ids
const urlOf = (p) => { try { return p.url() || ''; } catch (_) { return ''; } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** Has the report's grid drawn rows yet? (its frame appears a moment before its table does) */
async function gridDrawn(frame, { sleep = nap, rowsMs = 20000, tickMs = 1000, evalMs = 5000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { const g = await within(frame.evaluate(scrapeGrid), evalMs, 'frame not answering'); if (g.found && g.rows.length) return true; } catch (_) {}
    if (Date.now() - t0 >= rowsMs) return false;
    await sleep(tickMs);
  }
}

/**
 * The Salesforce tab that has the report open → the page, or null. EVERY Salesforce tab is looked at (newest first: the report need not be the last one opened) and a report
 * that is still drawing gets time: Lightning adds the grid's frame a few seconds after the page itself, on a cold browser up to ~20. With nothing report-like open there is
 * nothing to wait for, so it gives up sooner. `deps` = { reportFrame, sfUrlSubstring, sleep, log, waitMs, quickMs, noTabMs, rowsMs, tickMs, evalMs }.
 */
async function findReportTab(context, deps) {
  const { reportFrame, sfUrlSubstring = SF_HOST, sleep = nap, log = () => {}, waitMs = 30000, quickMs = 8000, noTabMs = 4000 } = deps;
  const t0 = Date.now(); let said = false;
  for (;;) {
    const sf = context.pages().filter((p) => { try { return !p.isClosed() && urlOf(p).includes(sfUrlSubstring); } catch (_) { return false; } });
    for (const p of [...sf].reverse()) {
      let frame = null; try { frame = reportFrame(p); } catch (_) {}
      if (!frame) continue;
      await gridDrawn(frame, deps);
      return p;
    }
    const waited = Date.now() - t0;
    const limit = !sf.length ? noTabMs : sf.some((p) => REPORT_URL_RE.test(urlOf(p))) ? waitMs : quickMs;
    if (waited >= limit) return null;
    if (!said && waited >= Math.min(3000, limit / 2)) { said = true; log('⏳', 'Report', 'No report grid yet — giving it a few seconds to draw…'); }
    await sleep(deps.tickMs || 1000);
  }
}

/** What Chrome has open: every tab's address (no query), title and child frames. */
async function describeTabs(context) {
  const out = [];
  for (const p of context.pages()) {
    let title = '', frames = [];
    try { title = String(await within(p.title(), 2000, 'no title')).slice(0, 80); } catch (_) {}
    try { frames = p.frames().slice(1).map((f) => plainUrl(f.url())).filter(Boolean); } catch (_) {}
    out.push({ url: plainUrl(urlOf(p)), title, frames });
  }
  return out;
}

/** Leave what Chrome showed next to the code (report-probe.json + .png) so a miss can be diagnosed from the files. Never throws. */
async function saveProbe(context, tabs, sfUrlSubstring = SF_HOST) {
  try { fs.writeFileSync(PROBE_BASE + '.json', JSON.stringify({ at: new Date().toISOString(), tabs }, null, 2)); } catch (_) {}
  try {
    const pages = context.pages();
    const shot = [...pages].reverse().find((p) => urlOf(p).includes(sfUrlSubstring)) || pages[pages.length - 1];
    if (shot) await within(shot.screenshot({ path: PROBE_BASE + '.png' }), 8000, 'screenshot timed out');
  } catch (_) {}
}

/**
 * `--by-email`: ask for the REPORT of email addresses and find it. The list-view prompt this replaces asked for an Opportunities list view, looked only at the newest Salesforce
 * tab, waited 6 s for the report and then ENDED the run, so you had to Ctrl+C and start again. This checks every tab, waits for the report to draw and, when
 * there is none, says what Chrome has open and asks again. → the report's page, or null (q, or `maxTries` goes by without one). `deps` = findReportTab's + { ask, say, maxTries }.
 */
async function openEmailReport(context, deps) {
  const { ask, say = console.log, maxTries = 4, sfUrlSubstring = SF_HOST } = deps;
  let question = '\nIn the Chrome window: log in (if needed) and open your Salesforce REPORT of EMAIL ADDRESSES (the report itself, not a list view),\n' +
                 'wait until its rows are showing, then press Enter here to continue (q to quit)... ';
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const ans = String((await ask(question)) || '').trim().toLowerCase();
    if (ans === 'q' || ans === 'quit') return null;
    const page = await findReportTab(context, deps);
    if (page) { try { await page.bringToFront(); } catch (_) {} return page; }
    const tabs = await describeTabs(context);
    say('\n  ⚠️  No Salesforce report is open in the browser. What Chrome has open:');
    tabs.slice(0, 8).forEach((t, i) => say(`     ${i + 1}. ${t.url || '(blank)'}${t.title ? '  —  ' + t.title : ''}${t.frames.length ? `  [${t.frames.length} frame(s)]` : ''}`));
    if (!tabs.some((t) => REPORT_URL_RE.test(t.url))) say("     None of these looks like a report page (a report's address contains /Report/).");
    await saveProbe(context, tabs, sfUrlSubstring);
    say(`     A snapshot of what Chrome showed was saved as ${path.basename(PROBE_BASE)}.json / .png`);
    question = '\n  Open the report in the Chrome window, wait for its rows, then press Enter to look again (q to quit)... ';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. find the account for an address
// ---------------------------------------------------------------------------------------------------------------------

/** The Lightning global-search results page for a term. */
function searchUrl(origin, term) {
  const state = { componentDef: 'forceSearch:search', attributes: { term, scopeMap: { type: 'TOP_RESULTS' }, context: { disableSpellCorrection: false, SEARCH_ACTIVITY: { term } } }, state: {} };
  return `${origin}/one/one.app?source=aloha#${Buffer.from(JSON.stringify(state)).toString('base64')}`;
}

/** Runs IN THE PAGE: every record link on the results page with the text of the row/card it sits in. */
function scrapeResults() {
  const out = [];
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  (function walk(root) {
    root.querySelectorAll('a[href*="/lightning/r/"]').forEach((a) => {
      const m = a.getAttribute('href').match(/\/lightning\/r\/(?:([A-Za-z_]+)\/)?([A-Za-z0-9]{15,18})\/view/);
      if (!m) return;
      const box = a.closest('tr, li, article, [role="row"], .slds-card, .search-result') || a.parentElement;
      out.push({ obj: m[1] || null, id: m[2], text: clean(a.innerText), rowText: clean(box && box.innerText).slice(0, 600), rowKey: box ? (box.getAttribute('data-row-key-value') || box.getAttribute('data-id') || '') : '' });
    });
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
  })(document);
  return out;
}

const kindOf = (r) => (r.obj && /^account$/i.test(r.obj)) || /^001/.test(r.id) ? 'account' : (r.obj && /^contact$/i.test(r.obj)) || /^003/.test(r.id) ? 'contact' : (r.obj && /^lead$/i.test(r.obj)) || /^00Q/.test(r.id) ? 'lead' : 'other';

/**
 * Results-page links → which account the address belongs to. Only rows that mention the address count.
 *   → { status:'found', accountId, name } | { status:'contact', contactId } (a contact with no account link in its row: open it)
 *     | { status:'lead-only' } | { status:'ambiguous', accounts:[…] } | { status:'none' }
 */
function pickAccount(links, email) {
  const want = normEmail(email);
  const rows = links.filter((l) => String(l.rowText || '').toLowerCase().includes(want));
  const accounts = new Map(), contacts = new Map(); let leads = 0;
  for (const l of rows) {
    const k = kindOf(l);
    if (k === 'account') accounts.set(l.id.slice(0, 15), { accountId: l.id, name: l.text });
    else if (k === 'contact') contacts.set(l.id.slice(0, 15), l.id);
    else if (k === 'lead') leads++;
  }
  // A contact's row also names its account: take any account link that shares a row with the address.
  if (accounts.size === 1) return { status: 'found', ...[...accounts.values()][0] };
  if (accounts.size > 1) return { status: 'ambiguous', accounts: [...accounts.values()] };
  if (contacts.size === 1) return { status: 'contact', contactId: [...contacts.values()][0] };
  if (contacts.size > 1) return { status: 'ambiguous', accounts: [...contacts.values()].map((id) => ({ contactId: id })) };
  return leads ? { status: 'lead-only' } : { status: 'none' };
}

/** Runs IN THE PAGE (a Contact record): its Account link. */
function scrapeContactAccount() {
  let hit = null;
  (function walk(root) {
    if (hit) return;
    root.querySelectorAll('a[href*="/lightning/r/001"], a[href*="/lightning/r/Account/"]').forEach((a) => {
      if (hit) return;
      const m = a.getAttribute('href').match(/\/(001[A-Za-z0-9]{12,15})\/view/);
      const r = a.getBoundingClientRect();
      if (m && r.width > 2 && (a.innerText || '').trim()) hit = { accountId: m[1], name: (a.innerText || '').replace(/\s+/g, ' ').trim() };
    });
    root.querySelectorAll('*').forEach((e) => { if (!hit && e.shadowRoot) walk(e.shadowRoot); });
  })(document);
  return hit;
}

/**
 * Look one address up in Salesforce. → { status, accountId?, name?, url?, why? }.
 * deps = { sleep, origin, debug }: with debug, the links the results page showed are returned in `seen` so a wrong pick can be tuned.
 * A page that cannot be read is never "none": a closed window / crashed tab / Salesforce login THROWS LookupAbort; an error page or a results page that
 * never evaluated returns { status:'error' } (shown, never cached). A none carries `readable` (how many times the results page was read) so the cache can trust it.
 * deps.confirmNone: a "none" is asked once more after a reload (a tab's first search may have hit a page that was still starting up).
 */
async function findAccountByEmail(page, email, deps) {
  const { sleep, origin } = deps;
  const evalMs = deps.evalTimeoutMs || 20000;
  const gone = (err) => {
    const s = pageState(page, err);
    if (s === 'closed') throw new LookupAbort('the browser window was closed, so Salesforce can no longer be searched', 'browser');
    if (s === 'crashed') { page.__crashed = true; throw new LookupAbort('the browser tab crashed ("Aw, Snap!") or stopped answering', 'crash'); }
  };
  try {
    gone();
    await page.goto(searchUrl(origin, email), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(gone);   // a slow load is fine (the results are polled below); a dead page is not
    let links = [], pick = { status: 'none' }, readable = 0, lastErr = null;
    const poll = async () => {
      for (let i = 0; i < 8; i++) {                     // search results fill in after the page loads
        await sleep(i === 0 ? 3000 : 1500);
        try { links = await within(page.evaluate(scrapeResults), evalMs, 'tab not responding'); readable++; } catch (e) { gone(e); links = []; lastErr = e; }
        pick = pickAccount(links, email);
        if (pick.status !== 'none') break;
      }
    };
    await poll();
    if (pick.status === 'none' && deps.confirmNone) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(gone); await poll(); }
    const seen = deps.debug ? links.slice(0, 40) : undefined;
    if (pick.status === 'none') {                       // "nothing found" only means something if this really was Salesforce's results page
      const url = String(page.url() || '');
      if (LOGIN_RE.test(url)) throw new LookupAbort('Salesforce is asking for a login', 'login');
      if (/^chrome-error:/i.test(url)) return { status: 'error', why: 'the browser could not reach Salesforce (network error)' };
      if (!readable) return { status: 'error', why: `the results page could not be read${lastErr ? ' (' + String(lastErr.message).split('\n')[0].slice(0, 100) + ')' : ''}` };
    }
    if (pick.status === 'contact') {
      await page.goto(`${origin}/lightning/r/Contact/${pick.contactId}/view`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(gone);
      let acc = null;
      for (let i = 0; i < 6 && !acc; i++) { await sleep(2000); try { acc = await within(page.evaluate(scrapeContactAccount), evalMs, 'tab not responding'); } catch (e) { gone(e); } }
      pick = acc ? { status: 'found', ...acc } : { status: 'none', why: 'the contact has no account' };
    }
    if (pick.status === 'found') return { status: 'found', accountId: pick.accountId, name: pick.name, url: `${origin}/lightning/r/Account/${pick.accountId}/view`, seen };
    return { ...pick, readable, seen };
  } catch (e) { if (e instanceof LookupAbort) throw e; return { status: 'error', why: e.message.slice(0, 160) }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------------------------------------------------
function readCache() {
  const out = new Map();
  try {
    if (!fs.existsSync(CACHE_FILE)) return out;
    for (const l of fs.readFileSync(CACHE_FILE, 'utf8').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.email) out.set(r.email, r); } catch (_) {} }
  } catch (_) {}
  return out;
}
function writeCache(row) { try { fs.appendFileSync(CACHE_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', 'utf8'); } catch (_) {} return row; }

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const accountUrl = (origin, id) => `${origin}/lightning/r/Account/${id}/view`;

/**
 * What we already know about an address WITHOUT searching Salesforce → { r, via } or null (it needs a search). `cache` = readCache(); `own` = emailSource.loadOwn() or null.
 *   via 'file'   the list itself names the account (a CSV with a Salesforce URL column). A saved lookup that found a DIFFERENT account makes it a 'conflict': left out, never guessed.
 *   via 'cache'  a saved Salesforce lookup: a found account is always trusted; a miss only while it is fresh and its results page was really read.
 *   via 'own'    our own files tie the address to exactly ONE account (it is on every text and email we sent, and on the account pages we read). Only for an address Salesforce has
 *                never really answered (no saved lookup, an error, or a "none" whose results page was never read). A saved "no account" / "only a lead" / "several accounts" is
 *                Salesforce's word: it stands while fresh and is asked AGAIN after 7 days, it is never overruled by our files.
 */
function knownAnswer(e, cache, { own = null, origin = null, maxAgeMissDays = 7, now = Date.now() } = {}) {
  const cached = cache.get(e.email);
  const link = (id, stored) => (origin ? accountUrl(origin, id) : stored || null);
  if (e.accountId) {
    if (cached && cached.status === 'found' && k15(cached.accountId) !== k15(e.accountId)) return { via: 'file', r: { email: e.email, status: 'conflict', why: `the file names account ${e.accountId} but a saved Salesforce lookup found ${cached.accountId}` } };
    return { via: 'file', r: { email: e.email, status: 'found', accountId: e.accountId, name: e.name || null, url: link(e.accountId, e.url) } };
  }
  const stale = cached && (cached.status === 'error' || hollowMiss(cached) || (cached.status !== 'found' && now - Date.parse(cached.at) > maxAgeMissDays * 864e5));
  if (cached && !stale) return { via: 'cache', r: cached };
  const unanswered = !cached || cached.status === 'error' || hollowMiss(cached);
  let mine = null; try { mine = unanswered && own ? own(e) : null; } catch (_) {}
  if (mine) return { via: 'own', r: { email: e.email, status: 'found', accountId: mine.accountId, name: mine.name || e.name || null, url: link(mine.accountId, mine.url), sources: mine.sources } };
  return null;
}

/**
 * Resolve every harvested address to an account (cached: a found account is always trusted; a miss only if its results page was really read, and for 7 days).
 * `aborted` (else null) = the lookups had to stop (window closed / Salesforce login / unreadable results): { message, kind, done, total, email }. Nothing is recorded for the address it stopped on.
 * The searches run in their OWN tab (deps.openTab, else page.context().newPage(); neither → the page we were given): Lightning never reloads between searches (each one only
 * changes the #hash), so one tab keeps growing until its process dies ("Aw, Snap! Error code: 5", after ~400 searches). The tab is replaced every `recycleEvery` searches and at
 * once when it crashes or stops answering (the address it was on is searched again); an address that kills two tabs in a row is reported as an error and skipped. deps.log narrates it.
 * deps.own (emailSource.loadOwn()): an address with no usable saved lookup that our own files tie to exactly ONE account is matched without a search (see knownAnswer), and an entry that
 * carries `accountId` (a CSV naming the account) needs none either. Only the addresses nothing answers are searched, and only those are saved to the cache.
 * → { leads:[{ name, accountId, url, email, reportName }], unresolved:[{ email, status, why }], stats:{ file, cache, own, searched } }
 */
async function resolveAll(page, emails, deps, { onProgress = null, maxAgeMissDays = 7, maxErrorsInARow = 3, recycleEvery = 50 } = {}) {
  const cache = readCache(), leads = [], unresolved = [], seenAccounts = new Map(), stats = { file: 0, cache: 0, own: 0, searched: 0 };
  let errorsInARow = 0;
  const log = (icon, label, text) => { try { if (deps.log) deps.log(icon, label, text); } catch (_) {} };
  const openTab = deps.openTab || (typeof page.context === 'function' ? () => page.context().newPage() : null);
  let tab = page, owned = false, inTab = 0, cold = false;
  const closeTab = async () => { if (owned) { owned = false; try { await within(tab.close(), deps.closeTimeoutMs || 5000); } catch (_) {} } };
  const freshTab = async () => {
    const why = tab.__crashed ? 'the last one crashed' : inTab >= recycleEvery ? `after ${inTab} searches, to keep it light` : 'for the searches';
    await closeTab();
    try { tab = await within(openTab(), 30000); }
    catch (err) { throw new LookupAbort(`could not open a new browser tab (${String(err.message).split('\n')[0].slice(0, 120)})`, 'browser'); }
    owned = true; inTab = 0; cold = true;
    try { tab.on('crash', () => { tab.__crashed = true; }); } catch (_) {}
    log('🗂️', 'Search tab', `fresh tab opened (${why})`);
  };
  const stop = async (message, kind, done, email) => { await closeTab(); return { leads, unresolved, stats, aborted: { message, kind, done, total: emails.length, email } }; };
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    const known = knownAnswer(e, cache, { own: deps.own, origin: deps.origin, maxAgeMissDays });
    let r = known ? known.r : null, fresh = false, via = known ? known.via : 'searched';
    if (known) stats[via]++;
    if (!known) {
      let f = null, crashes = 0;
      while (!f) {
        try {
          if (openTab && (!owned || inTab >= recycleEvery || tab.__crashed)) await freshTab();
          f = await findAccountByEmail(tab, e.email, { ...deps, confirmNone: cold });
          cold = false; inTab++;
        } catch (err) {
          if (!(err instanceof LookupAbort)) throw err;
          if (err.kind !== 'crash' || !openTab) return stop(err.message, err.kind, i, e.email);
          tab.__crashed = true;                          // the next pass opens a fresh tab and searches this address again
          log('🩹', 'Tab crashed', `${e.email}: ${crashes ? 'it crashed a second tab, so this address is skipped' : 'opening a fresh tab and searching it again'}`);
          if (++crashes >= 2) f = { status: 'error', why: 'the browser tab crashed twice while searching this address' };
        }
      }
      if (deps.debug && f.status !== 'found') console.log(`\n  🔬 ${e.email} → ${f.status}. Record links the results page showed:\n${JSON.stringify(f.seen || [], null, 1).slice(0, 3000)}\n`);
      const { seen, ...rest } = f;
      r = f.status === 'error' ? { email: e.email, at: new Date().toISOString(), ...rest } : writeCache({ email: e.email, ...rest });   // an error is shown, never remembered
      fresh = true; stats.searched++;
    }
    if (onProgress) onProgress(i + 1, emails.length, e, r, via);
    if (fresh) {                                         // the results page keeps being unreadable: stop instead of walking the rest of the report
      errorsInARow = r.status === 'error' ? errorsInARow + 1 : 0;
      if (errorsInARow >= maxErrorsInARow) return stop(`${errorsInARow} lookups in a row could not read the Salesforce results page (${r.why})`, 'errors', i + 1, e.email);
    }
    if (r.status !== 'found') { unresolved.push({ email: e.email, status: r.status, why: r.why || null }); continue; }
    const k = String(r.accountId).toLowerCase().slice(0, 15);
    if (seenAccounts.has(k)) { unresolved.push({ email: e.email, status: 'same-account', why: `same account as ${seenAccounts.get(k)} (one email per account per run)` }); continue; }
    seenAccounts.set(k, e.email);
    leads.push({ name: r.name || e.name || '(unnamed account)', accountId: r.accountId, url: r.url, email: e.email, reportName: e.name || null });
  }
  await closeTab();
  return { leads, unresolved, aborted: null, stats };
}

module.exports = { knownAnswer, openEmailReport, findReportTab, describeTabs, harvestEmails, rowsToEmails, scrapeGrid, scrapeResults, scrapeContactAccount, pickAccount, searchUrl, findAccountByEmail, resolveAll, readCache, writeCache, LookupAbort, pageGone, hollowMiss, CACHE_FILE, EMAIL_RE, normEmail };
