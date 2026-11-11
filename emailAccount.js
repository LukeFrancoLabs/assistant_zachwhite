'use strict';

/**
 * emailAccount — send an email from a Salesforce ACCOUNT record page, in the SAME
 * Assistant browser/profile as the texter (no separate emailer, no second login).
 *
 * Validated composer facts (live):
 *   - To auto-fills from the account (no fragile recipient lookup needed)
 *   - Subject:  input[placeholder="Enter Subject..."]
 *   - Body:     a CK Editor iframe whose URL contains /email/htmlbody/html → contenteditable
 *   - Send:     a button labeled "Send" in the docked composer
 *
 * The composer OPENER (the account's Activity "Email" action) is discovered at
 * runtime (scroll it into view + click). Dry-run drafts but never clicks Send.
 *
 * CLI (validation): node emailAccount.js <accountUrlOrId> "Subject" "Body text"   (dry-run)
 *                   add --send to actually send (caution: real email).
 */

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./Assistant');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);   // a page that has crashed never answers

const SUBJECT_SEL = 'input[placeholder="Enter Subject..."]';

// Typographic quotes / dashes and non-breaking spaces compare as their plain forms. CKEditor hands an apostrophe back as &rsquo;, so a business name like
// "Carpentry’s Finest" in the greeting failed the body check although the text was typed correctly (2026-10-27) and the email was skipped.
const plain = (s) => String(s || '').replace(/[‘’‛′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—]/g, '-').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

async function composerOpen(page) {
  try { return (await page.locator(SUBJECT_SEL).count()) > 0; } catch (_) { return false; }
}

/** Does the open composer have a recipient? Returns the recipient email, or null. */
async function composerRecipient(page) {
  return page.evaluate(() => {
    const re = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    let hit = null;
    (function walk(n) {
      if (hit) return;
      n.querySelectorAll('[class*="pill" i], lightning-pill, .slds-pill, [data-recipient]').forEach((e) => {
        if (hit) return;
        const m = (e.innerText || e.textContent || '').match(re);
        if (m) hit = m[0];
      });
      n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document);
    return hit;
  }).catch(() => null);
}

/**
 * The composer opened with an EMPTY To — the Activity "Email" action does that, and an account page with no address on it never offers the click that
 * addresses the composer. Type `email` (the report's own Contact: Email) into the To field — the text input just above Subject, in the same composer —
 * and keep it only if it turned into a recipient. Never throws. → the recipient the composer shows now (null: nothing took).
 * Not yet seen against live Salesforce (its To field is found by position, not by name): `--dry-run` shows whether it took.
 */
async function addRecipient(page, email) {
  try {
    const spot = await within(page.evaluate((subjSel) => {
      const inputs = [];
      (function walk(n) {
        n.querySelectorAll('input').forEach((e) => inputs.push(e));
        n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      })(document);
      const subj = inputs.find((e) => e.matches(subjSel));
      if (!subj) return null;
      const s = subj.getBoundingClientRect();
      let best = null;
      for (const e of inputs) {
        if (e === subj || !['text', 'email', 'search', ''].includes((e.type || '').toLowerCase())) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) continue;                         // not on screen
        if (r.bottom > s.top + 4 || s.top - r.bottom > 120) continue;       // not just above the subject line
        if (r.right < s.left - 4 || r.left > s.right + 4) continue;         // not in the same composer
        if (!best || r.bottom > best.bottom) best = r;
      }
      return best ? { x: Math.round(best.x + best.width / 2), y: Math.round(best.y + best.height / 2) } : null;
    }, SUBJECT_SEL), 10000);
    if (!spot) return null;
    await page.mouse.click(spot.x, spot.y);
    await sleep(300);
    await page.keyboard.type(email, { delay: 15 });
    await sleep(500);
    for (const key of ['Enter', 'Tab']) {                                   // either one turns a typed address into a recipient in a Lightning composer
      await page.keyboard.press(key);
      await sleep(800);
      const got = await composerRecipient(page);
      if (got) return got;
    }
  } catch (_) {}
  return null;
}

/** After a failure, leave what the page looked like (email-debug/<account>.png + .json) so the skip can be explained later. Never throws. → the path, or ''. */
async function saveDebug(page, o, why) {
  try {
    const dir = path.join(__dirname, 'email-debug');
    fs.mkdirSync(dir, { recursive: true });
    const idm = String(o.accountUrl || '').match(/Account\/([A-Za-z0-9]{15,18})/);
    const key = String((idm && idm[1]) || o.accountName || 'account').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    const info = await within(page.evaluate(() => {
      const emails = new Set(), inputs = [];
      const re = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g;
      (function walk(n) {
        n.querySelectorAll('a, span, lightning-formatted-email').forEach((e) => { const t = (e.innerText || e.textContent || '').trim(); if (t.length < 80) (t.match(re) || []).forEach((m) => emails.add(m)); });
        n.querySelectorAll('input, textarea, select').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) inputs.push({ tag: e.tagName.toLowerCase(), type: e.type || null, placeholder: e.placeholder || null, aria: e.getAttribute('aria-label'), cls: String(e.className || '').slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        });
        n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      })(document);
      return { title: document.title, emailsOnPage: [...emails].slice(0, 20), inputs: inputs.slice(0, 40) };
    }), 8000) || {};
    fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({ at: new Date().toISOString(), account: o.accountName || null, url: page.url(), why, wantedEmail: o.toEmail || o.fallbackEmail || null, ...info }, null, 1));
    await within(page.screenshot({ path: path.join(dir, key + '.png') }).catch(() => {}), 8000);
    return `email-debug/${key}`;
  } catch (_) { return ''; }
}

/**
 * Open the email composer WITH the recipient set. Primary strategy: click the Pro's
 * email ADDRESS on the account (Account Admin Login Email / a contact's email) — in
 * this org that opens the docked composer addressed to them. Fallback: the Activity
 * "Email" action (which can open with an empty To).
 */
async function openEmailComposer(page, wantEmail = null) {
  if ((await composerOpen(page)) && (await composerRecipient(page))) return true;

  // Strategy 1: click an email-address link on the account → opens composer addressed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await page.evaluate((want) => {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const onpage = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.top >= -4; };
      let found = null;
      (function walk(n) {
        if (found) return;
        n.querySelectorAll('a, lightning-formatted-email, button, span').forEach((e) => {
          if (found) return;
          const t = (e.innerText || e.textContent || '').trim();
          if (emailRe.test(t) && (!want || t.toLowerCase() === want)) { try { e.scrollIntoView({ block: 'center' }); } catch (_) {} if (onpage(e)) { const r = e.getBoundingClientRect(); found = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), email: t }; } }
        });
        n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      })(document);
      return found;
    }, wantEmail ? String(wantEmail).toLowerCase() : null);
    if (target) {
      await page.mouse.click(target.x, target.y);
      await sleep(2500);
      if (await composerOpen(page)) return true;
    }
    await sleep(1000);
  }

  // Strategy 2 (fallback): the Activity "Email" action — may open without a recipient.
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await page.evaluate(() => {
      const onpage = (e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.left >= 0 && r.top >= -4; };
      let found = null;
      (function walk(n) {
        if (found) return;
        n.querySelectorAll('a,button,li,span,[role="tab"],[role="button"],[role="menuitem"]').forEach((e) => {
          if (found) return;
          const t = (e.innerText || e.textContent || '').trim();
          const title = (e.getAttribute && (e.getAttribute('title') || e.getAttribute('aria-label'))) || '';
          if (t === 'Email' || title === 'Email') { try { e.scrollIntoView({ block: 'center' }); } catch (_) {} if (onpage(e)) { const r = e.getBoundingClientRect(); found = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } }
        });
        n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
      })(document);
      return found;
    });
    if (target) {
      await page.mouse.click(target.x, target.y);
      await sleep(2500);
      if (await composerOpen(page)) return true;
    }
    await sleep(1000);
  }
  return false;
}

/**
 * Read "Customer Status (beta)" off the open account page. "Enrolled" = a current customer
 * (e.g. an oppy closed-lost last year but another rep closed-won one this year) — never email them.
 * Waits a few seconds for the lazy-loaded record layout. → { found:boolean, value:string|null }
 */
async function readCustomerStatus(page) {
  // Primary: the Customer Overview grid (labels row, values row, matched by position). Falls through to the older label-neighbour read.
  try {
    const ov = await require('./accountOverview').readOverview(page);
    const v = ov.get(/^customer status/);
    if (ov.found && v !== null) return { found: true, value: v };
  } catch (_) {}
  const read = () => page.evaluate(() => {
    const label = /^customer status\s*\(beta\)\s*$/i;
    let value = null, found = false;
    (function walk(n) {
      if (found) return;
      n.querySelectorAll('span, label, dt, div, p').forEach((e) => {
        if (found) return;
        if (e.children.length > 1) return;
        if (!label.test((e.textContent || '').trim())) return;
        const box = e.closest('.slds-form-element, records-record-layout-item, [class*="form-element"]') || e.parentElement;
        const txt = ((box && box.innerText) || '').split('\n').map((x) => x.trim()).filter(Boolean)
          .filter((x) => !label.test(x) && !/^help$/i.test(x));
        found = true;
        value = (txt[0] || '').replace(/^[-–—]$/, '');
        // A blank Customer Status must not pick up the NEXT field's label as its value (it read "Industry").
        if (/^(industry|time\s*-?\s*zone|account (name|owner|type|status)|type|rating|phone|website|employees|description|primary poc|org id)$/i.test(value)) value = '';   // empty or "-" = not a customer
      });
      if (!found) n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document);
    return { found, value };
  }).catch(() => ({ found: false, value: null }));
  let res = { found: false, value: null };
  for (let i = 0; i < 6; i++) {
    res = await read();
    if (res.found) break;
    try { await page.evaluate(() => window.scrollBy(0, 600)); } catch (_) {}
    await sleep(1000);
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
  return res;
}

/**
 * "Enrolled" alone does not make a customer: the free Invoicing and Payments sign-up is Enrolled too. Reads the account's Closed Won opportunities (customerPlan.js).
 * → { verdict:'customer'|'free-plan'|'unknown', why, retry, closedWon, record }. Never throws; whatever it cannot read is 'unknown' and the account stays held.
 * It leaves the page on an opportunity: the caller goes back to the account page.
 */
async function checkPlan(page, o) {
  const m = String(o.accountUrl || '').match(/\/Account\/([A-Za-z0-9]{15,18})/);
  if (!m) return { verdict: 'unknown', retry: false, why: 'no account id in the page address, so the plan was not checked', closedWon: [], record: {} };
  try { return await require('./customerPlan').checkAccount(page, { accountId: m[1] }); }
  catch (e) { return { verdict: 'unknown', retry: true, why: `the plan check failed (${e.message})`, closedWon: [], record: {} }; }
}

/**
 * Open the composer on an account and fill subject + body (+ send unless dryRun).
 * @param {{accountName?:string,accountUrl?:string,subject:string,body:string,bodyHtml?:string,toEmail?:string,fallbackEmail?:string}} o
 *   toEmail        the address the composer MUST be addressed to (--by-email); anything else is refused
 *   fallbackEmail  typed into an EMPTY To (the report's own Contact: Email) when the account page has no address to click
 * @param {{dryRun?:boolean,skipCustomerCheck?:boolean,onPlan?:Function,heldAsCustomer?:string}} opts
 *   onPlan          called with { status, verdict, why, closedWon, record } as soon as an Enrolled account's plan has been checked (the caller saves it), whatever happens next
 *   heldAsCustomer  the Customer Status this account was held with before the plan check existed: if the page will not show its status now, it is NOT emailed
 */
async function emailAccount(page, o, opts = {}) {
  const dryRun = !!opts.dryRun;
  if (!dryRun) require('./sender').assertSendable(o.subject, o.body, o.bodyHtml);      // an email that still says [SET sender.json: …] is never sent (the run stops, nothing is sent)
  if (o.accountUrl && !(page.url() || '').includes(o.accountUrl.split('/lightning/')[1] || '####')) {
    await page.goto(o.accountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(CONFIG.accountLoadMs);
  }
  // Current-customer check (read-only): Customer Status (beta) = Enrolled → do not email, unless its only Closed Won opportunity is the free Invoicing and Payments plan (customerPlan.js).
  let customerStatus = null;
  if (!opts.skipCustomerCheck) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { customerStatus = await readCustomerStatus(page); break; }
      catch (err) { await page.waitForLoadState('domcontentloaded').catch(() => {}); await sleep(2000); }
    }
    // An account held as a customer before the plan check existed was dropped without a look; a page that will not show its status must not turn that into an email.
    if (opts.heldAsCustomer && !(customerStatus && customerStatus.found)) {
      return { status: 'current-customer', customerStatus: opts.heldAsCustomer, plan: { verdict: 'unknown', retry: true, why: 'Customer Status could not be read, so the earlier hold stands', closedWon: [], record: {} } };
    }
    if (customerStatus && customerStatus.found && /^\s*enrolled\b/i.test(customerStatus.value || '')) {   // "Enrolled: …" (Current Customer, Cancel Requested, Under Review…) = customer unless free; Canceled / Terminated / empty / "-" = still emailable
      const plan = await checkPlan(page, o);
      if (opts.onPlan) { try { opts.onPlan({ status: customerStatus.value, ...plan }); } catch (_) {} }
      // Business coaching is a different department (Luke, 2026-10-29: coachingPolicy.js, "until I say otherwise"): never emailed, though not listed as a current customer; only the free plan, and coaching once the policy releases it, goes on to the composer.
      if (plan.verdict !== 'free-plan' && !(plan.verdict === 'coaching' && !require('./coachingPolicy').held())) return { status: 'current-customer', customerStatus: customerStatus.value, plan };
      // Free Invoicing and Payments only (or business coaching, once released): not a customer, carry on. The opportunity pages replaced the account page, so go back to it for the composer.
      await page.goto(o.accountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(CONFIG.accountLoadMs);
    }
  }
  // Salesforce can re-navigate right after domcontentloaded, which destroys the page
  // context mid-evaluate ("Execution context was destroyed"). That is transient: wait
  // for the page to settle and retry rather than failing the account.
  const tryOpen = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { if (await openEmailComposer(page, o.toEmail)) return true; }
      catch (err) {
        if (!/context was destroyed|navigation/i.test(String(err && err.message))) throw err;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(3000);
      }
    }
    return false;
  };
  let opened = await tryOpen();
  if (!opened) {
    // A page that was not ready the first time is the usual reason (2026-10-27: Luker earthworks and AandB seevices were skipped, then went out fine on the next
    // try): reload the account page once and look again before giving up.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(CONFIG.accountLoadMs);
    opened = await tryOpen();
  }
  if (!opened) { const dbg = await saveDebug(page, o, 'composer did not open'); throw new Error(`could not open the email composer on this account${dbg ? ` (page saved: ${dbg}.png)` : ''}`); }
  await sleep(1500);

  // An account page with no address on it opens the composer with an EMPTY To. When the report gave us the pro's own address, put that in.
  let recipientFrom = null;
  if (o.fallbackEmail && !(await composerRecipient(page))) {
    if (await addRecipient(page, o.fallbackEmail)) recipientFrom = 'report';
  }

  // Subject
  const subj = page.locator(SUBJECT_SEL).first();
  await subj.click({ timeout: 8000 });
  await subj.fill(o.subject || '');

  // Body — CK Editor iframe. BUG THIS GUARDS AGAINST: the editor visibly showed the
  // typed text but Send captured an EMPTY body (only the subject arrived), because
  // CKEditor hadn't synced its contenteditable into the underlying model/output yet.
  // So: type into the REAL editable (the frame <body> can precede it in DOM order),
  // nudge the editor to flush (input/change + blur), let it settle, then VERIFY the
  // text registered before we ever click Send.
  const bf = page.frames().find((f) => (f.url() || '').includes('/email/htmlbody/html'));
  if (!bf) throw new Error('email body editor (CK Editor iframe) not found');
  const bodyText = o.body || '';
  // Hyperlinked body: execCommand('insertHTML') showed the text but sent an EMPTY body (2026-10-24, first live --core emails), so it is never used.
  // The links go in through the editor's own API (CKEDITOR instance .setData), the way the editor itself loads content, and only when reading
  // the editor's data back shows both the text and every link. Anything else falls back to plain typing (EMAIL_HTML_BODY=0 forces plain).
  const wantHtml = !!o.bodyHtml && process.env.EMAIL_HTML_BODY !== '0';

  const editable = async () => {
    const ce = bf.locator('[contenteditable="true"]').first();
    return (await ce.count()) > 0 ? ce : bf.locator('body').first();
  };
  const fillBody = async () => {
    const ed = await editable();
    await ed.click({ timeout: 8000 });
    // Clean slate (ControlOrMeta = Cmd on this Mac) so a retry doesn't duplicate text.
    try { await ed.press('ControlOrMeta+a'); await ed.press('Delete'); } catch (_) {}
    await ed.type(bodyText, { delay: 4 });
    // Flush: fire the events CKEditor commits on, then blur, then let it settle.
    try { await ed.evaluate((el) => { ['input', 'keyup', 'change'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true }))); el.blur && el.blur(); }); } catch (_) {}
    await sleep(1200);
  };
  // Verify the body registered by looking for a distinctive slice of it in ANY frame.
  // CKEditor commonly puts the editable area in a NESTED iframe (designMode), which a
  // single-frame read misses — that caused false "did not register" skips even though
  // the text was clearly typed. So scan every frame's editables + <body> for the probe.
  const want = bodyText.replace(/\s+/g, ' ').trim();
  const probe = plain(want).slice(0, 25);
  const checkBody = async () => {
    if (!probe) return { ok: true, chars: 0 };
    for (const f of page.frames()) {
      let txt = '';
      try {
        txt = await f.evaluate(() => {
          const parts = [];
          document.querySelectorAll('[contenteditable="true"]').forEach((el) => parts.push(el.innerText || el.textContent || ''));
          if (document.body) parts.push(document.body.innerText || '');
          return parts.join(' ');
        });
      } catch (_) {}
      const norm = (txt || '').replace(/\s+/g, ' ').trim();
      if (plain(norm).includes(probe)) return { ok: true, chars: norm.length };
    }
    return { ok: false, chars: 0 };
  };

  // What Send actually uses is the editor's OWN data (CKEDITOR.instances[...].getData()), not what the page shows. When the editor exposes it, require the text there too.
  // The editor's data is HTML: tags become spaces, and every entity (&rsquo; &eacute; &#8217; …) is decoded by the browser itself, which knows them all.
  const htmlText = async (htmls) => {
    const spaced = htmls.map((h) => String(h || '').replace(/<[^>]*>/g, ' '));
    try {
      const out = await within(page.evaluate((a) => a.map((s) => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }), spaced), 10000);
      if (out) return out;
    } catch (_) {}
    return spaced.map((s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"').replace(/&[nm]dash;/g, '-'));
  };
  const ckCheck = async () => {
    const data = [];
    for (const f of page.frames()) {
      try { const r = await f.evaluate(() => { const C = window.CKEDITOR; return C && C.instances ? Object.values(C.instances).map((i) => { try { return i.getData(); } catch (_) { return ''; } }) : null; }); if (r) data.push(...r); } catch (_) {}
    }
    if (!data.length) return { present: false, ok: true, data };
    const text = await htmlText(data);
    return { present: true, ok: !probe || text.some((d) => plain(d).includes(probe)), data };
  };
  // Load the HTML body through the editor's API. → true only when the editor's data now holds the text AND every link with its full href.
  const hrefsWanted = (o.bodyHtml || '').match(/href="[^"]+"/g) ? (o.bodyHtml.match(/href="[^"]+"/g)).map((h) => h.slice(6, -1).replace(/&amp;/g, '&')) : [];
  const fillHtml = async () => {
    let set = false;
    for (const f of page.frames()) {
      try { if (await f.evaluate((html) => { const C = window.CKEDITOR; const ins = C && C.instances ? Object.values(C.instances) : []; if (!ins.length) return false; ins[0].setData(html); return true; }, o.bodyHtml)) { set = true; break; } } catch (_) {}
    }
    if (!set) return false;
    await sleep(1500);
    const c = await ckCheck();
    return c.present && c.ok && c.data.some((d) => hrefsWanted.every((h) => d.replace(/&amp;/g, '&').includes(h)));
  };

  let htmlUsed = false;
  if (wantHtml) { try { htmlUsed = await fillHtml(); } catch (_) { htmlUsed = false; } }
  if (!htmlUsed) await fillBody();                                   // plain typing: the path that has always sent correctly
  let res = await checkBody(); let ck = await ckCheck();
  if (!res.ok || !ck.ok) { await fillBody(); htmlUsed = false; res = await checkBody(); ck = await ckCheck(); }
  let bodyOk = res.ok && ck.ok;
  const links = htmlUsed ? { wanted: hrefsWanted.length, found: hrefsWanted.length } : null;

  // Never send a recipient-less email. (Clicking the Pro's email address should have
  // populated the To field; the Activity "Email" action sometimes doesn't.)
  const recipient = await composerRecipient(page);
  // The address the composer MUST show: the report's address in a --by-email run, or the one we typed in ourselves from the report.
  const wanted = o.toEmail || (recipientFrom === 'report' ? o.fallbackEmail : null);
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (dryRun && wanted && !same(recipient, wanted)) return { status: 'drafted', dryRun: true, recipient, wrongRecipient: true, bodyChars: res.chars, bodyOk: false, customerStatus };
  if (dryRun) {
    const dbg = recipient ? '' : await saveDebug(page, o, 'dry-run: no recipient');
    return { status: 'drafted', dryRun: true, recipient, recipientFrom, bodyChars: res.chars, bodyOk, editorVerified: ck.present, htmlUsed, links, customerStatus, debug: dbg ? `${dbg}.png` : null };
  }
  if (!recipient) {
    const dbg = await saveDebug(page, o, 'no recipient');
    const why = o.fallbackEmail ? `; the report's ${o.fallbackEmail} would not go into the To field` : '; no address on the account page and none in the report';
    throw new Error(`email has no recipient — skipped (To was empty${why})${dbg ? ` (page saved: ${dbg}.png)` : ''}`);
  }
  if (wanted && !same(recipient, wanted)) throw new Error(`the composer is addressed to ${recipient}, not the report's address ${wanted} — skipped`);
  // Guard against the subject-only bug: refuse to send if the body didn't register.
  if (!bodyOk) { const dbg = await saveDebug(page, o, 'body did not register'); throw new Error(`email body did not register in the editor — skipped to avoid sending a subject-only email${dbg ? ` (page saved: ${dbg}.png)` : ''}`); }

  // Send
  const sendSelectors = ['button[title="Send"]', 'button:has-text("Send")', 'span.label.bBody:has-text("Send")', '[role="button"]:has-text("Send")'];
  let sent = false;
  for (const sel of sendSelectors) {
    const loc = page.locator(sel).first();
    try { if ((await loc.count()) > 0) { await loc.click({ timeout: 5000 }); sent = true; break; } } catch (_) {}
  }
  if (!sent) throw new Error('Send button not found');
  await sleep(CONFIG.afterEmailSendMs || CONFIG.afterSendMs);
  return { status: 'sent', bodyChars: res.chars, editorVerified: ck.present, htmlUsed, recipient, recipientFrom, customerStatus };
}

module.exports = { emailAccount, openEmailComposer, readCustomerStatus };

// ---------------------------------------------------------------------------
if (require.main === module) {
  const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
  const arg = process.argv[2];
  const subject = process.argv[3] || 'Shark test (do not send)';
  const body = process.argv[4] || 'Shark dry-run body — not sent.';
  const doSend = process.argv.includes('--send');
  if (!arg) { console.error('usage: node emailAccount.js <accountUrlOrId> "Subject" "Body" [--send]'); process.exit(1); }
  const url = arg.startsWith('http') ? arg : `https://housecallpro.lightning.force.com/lightning/r/Account/${arg}/view`;
  (async () => {
    const b = await chromium.connectOverCDP(`http://localhost:${CONFIG.cdpPort}`);
    const ctx = b.contexts()[0];
    const page = ctx.pages().find((p) => (p.url() || '').includes('/lightning/r/Account/')) || (await ctx.newPage());
    const r = await emailAccount(page, { accountUrl: url, subject, body }, { dryRun: !doSend });
    console.log('result:', JSON.stringify(r));
    await b.close();
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
