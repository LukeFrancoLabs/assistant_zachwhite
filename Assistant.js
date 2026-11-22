#!/usr/bin/env node

/**
 * Pipeline Assistant (this file is Assistant.js) - Automated Salesforce text messaging bot (Node.js / Playwright).
 *
 * Drives a Salesforce Lightning OPPORTUNITIES list view: for each opp in a row range,
 * it clicks the account name to open the account page, clicks the Texts tab,
 * waits 3 seconds for it to load, clicks the compose box near the bottom,
 * pastes the text template, hits Send, then goes back to the opportunities list
 * view and moves to the next row.
 *
 * Uses a persistent Chrome profile (separate from the emailer) so login is remembered.
 * Same architecture as sf-email-bot (emailer).
 *
 * SETUP (once)
 *   npm install playwright
 *
 * RUN
 *   node Assistant.js
 *   node Assistant.js --range 1-10
 *   node Assistant.js --message "Hey, this is Luke from Housecall Pro..."
 *   (with no flags it prompts for message + rows)
 */

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { ContactHistory, createTemplateKey, formatAge } = require('./contactHistory');          // this folder's own copy: the 48h ledger (contact-history.jsonl) is Assistant's alone
const textLog = require('./textLog');
const textQueue = require('./textQueue');
const holdInbox = require('./holdInbox');
const emailLookup = require('./emailLookup');
const emailSource = require('./emailSource');
const tcpa = require('./tcpa');
const sfReview = require('./salesforceReview');
const accountZone = require('./accountZone');
const accountIndustry = require('./accountIndustry');
const autoPlan = require('./autoPlan');
const sfId = require('./sfId');
const emailPersonalize = require('./emailPersonalize');
const contentPicker = require('./contentPicker');
const emailSequence = require('./emailSequence');
const threadReader = require('./threadReader');
const sameDay = require('./sameDay');
const teammateTexted = require('./teammateTexted');
const followupRetired = require('./followupRetired');                  // plain --followup is retired (Luke, 2026-11-02): the board replaces it; one switch, RETIRED in that file
const sender = require('./sender');                                    // who this copy texts and emails as (sender.json): every piece of wording below passes through sender.apply()
const autoDraft = require('./autoDraft');                              // the --auto pipeline as a reusable step: --auto and the plain email and text campaigns write their messages through it

/** This copy (assistant_zachwhite) works from the opportunity PIPELINE LIST only. LDS report / dashboard modes are disabled. */
const PIPELINE_ONLY = true;

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
  userDataDir: path.join(__dirname, '.browser-profile'),
  cdpPort: 9323, // texting browser (separate from pipeliner on 9222)
  // Email uses its OWN browser + profile + port so texting and emailing can run at the
  // SAME TIME on one machine without fighting over the same tab. Each gets its own
  // Salesforce login (concurrent SF sessions are fine).
  emailUserDataDir: path.join(__dirname, '.browser-profile-email'),
  emailCdpPort: 9324,
  // Email send caps (live sends only; --dry-run is exempt). A run stops itself at either one. --max N can lower the per-run cap, never raise it.
  emailMaxPerRun: 300,
  emailMaxPerDay: 1000,
  // --reengage gets its OWN browser so it never collides with text (9323) or email (9324) runs.
  reengageUserDataDir: path.join(__dirname, '.browser-profile-reengage'),
  reengageCdpPort: 9325,
  zonesUserDataDir: path.join(__dirname, '.browser-profile-zones'),
  zonesCdpPort: 9328,
  holdsUserDataDir: path.join(__dirname, '.browser-profile-holds'),
  holdsCdpPort: 9329,
  // --shark / --snapshot (the morning Shark-list backup) gets ITS OWN browser too, so it can run while a long --harvest / --auto is going.
  sharkUserDataDir: path.join(__dirname, '.browser-profile-shark'),
  sharkCdpPort: 9326,
  // --industry reads every dashboard account's Industry off its Salesforce page (hours of page loads), so it gets ITS OWN browser too.
  industryUserDataDir: path.join(__dirname, '.browser-profile-industry'),
  industryCdpPort: 9327,
  // --evening (text tomorrow's Shark list tonight, unattended) gets ITS OWN browser: no other mode maps to this port, so nothing can kill it while nobody is at the Mac.
  eveningUserDataDir: path.join(__dirname, '.browser-profile-evening'),
  eveningCdpPort: 9330,
  // --board (the follow-up board's automatic run, boardRun.js) gets ITS OWN browser: a --followup or --same-day may be running, and starting this one must never close it.
  boardUserDataDir: path.join(__dirname, '.browser-profile-board'),
  boardCdpPort: 9336,
  // --same-day (a second text today to the Shark pros already texted today) gets ITS OWN browser: a --followup may be running on 9325, and starting this one must never close it.
  sameDayUserDataDir: path.join(__dirname, '.browser-profile-same-day'),
  sameDayCdpPort: 9331,
  // --teammate-texted (a text to the pros on the dashboard's 🤝 Teammate texted tab) gets ITS OWN browser too: a --followup may be running on 9325 and a --same-day on 9331, and starting this one must never close either.
  teammateUserDataDir: path.join(__dirname, '.browser-profile-teammate'),
  teammateCdpPort: 9332,
  // --tomorrow (also --shark13 --send): the OVERNIGHT run waits for 8:00 AM in ITS OWN Chrome, so a morning --shark (9326), --queue (9323) or --evening (9330) can never kill it while nobody is at the Mac.
  tomorrowUserDataDir: path.join(__dirname, '.browser-profile-tomorrow'),
  tomorrowCdpPort: 9333,
  startUrl: 'https://housecallpro.lightning.force.com/',
  sfUrlSubstring: 'lightning.force.com',
  // The Salesforce REPORT the email / text campaigns open by themselves (resolveCampaignReportPage). Kept in sender.json (Settings line "Campaign report").
  reportUrl: (() => { try { return require('./senderSetup').reportUrl(); } catch (_) { return 'https://housecallpro.lightning.force.com/lightning/r/Report/00OPD00000H2v6s2AB/view'; } })(),
  // Older call sites still read listUrl / testListUrl — both point at the same campaign report.
  listUrl: (() => { try { return require('./senderSetup').reportUrl(); } catch (_) { return 'https://housecallpro.lightning.force.com/lightning/r/Report/00OPD00000H2v6s2AB/view'; } })(),
  testListUrl: (() => { try { return require('./senderSetup').reportUrl(); } catch (_) { return 'https://housecallpro.lightning.force.com/lightning/r/Report/00OPD00000H2v6s2AB/view'; } })(),

  // Row selectors - tried in order
  rowSelectors: [
    'table[role="grid"] tbody tr',
    'div[role="row"]',
  ],

  // Account link patterns - on Opportunities list, account name column links to /Account/
  accountLinkPatterns: [
    'a[href*="/lightning/r/Account/"]',
    'a[href*="/Account/"]',
  ],

  // Texts tab on the account page
  // Salesforce renders tabs as role="radio" or AXRadioButton
  textsTabSelectors: [
    '[role="radio"][title="Texts"]',
    '[aria-label="Texts"]',
    '[title="Texts"]',
    'span:has-text("Texts")',
    'a:has-text("Texts")',
    '[role="tab"]:has-text("Texts")',
    'li:has-text("Texts")',
    'button:has-text("Texts")',
    '[role="radio"]:has-text("Texts")',
  ],

  // Compose box / text input near the bottom of the texts tab
  // Salesforce renders it as a textarea with placeholder "Type a message or select a template"
  composeSelectors: [
    'textarea[placeholder*="Type a message"]',
    'textarea[placeholder*="type a message"]',
    'textarea[placeholder*="message or select"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="template"]',
    'textarea',
    '[contenteditable="true"][data-placeholder*="message"]',
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"]',
  ],

  // Send button — Salesforce renders it as a plain button labeled "Send"
  sendButtonSelectors: [
    'button[title="Send"]',
    'button[aria-label="Send"]',
    'button:has-text("Send")',
    'button[value="Send"]',
    '[role="button"]:has-text("Send")',
  ],

  accountLoadMs: 5000,       // wait for account page to load
  textsTabLoadMs: 3000,      // wait for texts tab to load (3 seconds)
  afterSendMs: 3000,         // wait after sending before going to next
  afterEmailSendMs: 6000,    // wait after clicking Send on an EMAIL so Salesforce registers and tracks it (texts keep afterSendMs)
  defaultDelayMs: 3000,      // delay between records
};

// ============================================================================
// Helpers
// ============================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compact command-center status line for normal campaign output. */
function commandLog(icon, action, detail = '') {
  const label = String(action).toUpperCase().padEnd(20);
  console.log(`  ${icon} ${label}${detail}`.trimEnd());
}

function missionBanner(pos, end, ident) {
  const progress = end == null ? String(pos) : `${pos}/${end}`;
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`📱 TEXT MISSION ${progress}  //  ${ident}`);
  console.log('═'.repeat(64));
}

function logContactGuard(decision) {
  commandLog('🛡️', 'Contact guard', decision.allowed ? 'CLEAR' : 'HOLD — outreach blocked');
  commandLog('📧', 'Last email', decision.lastEmail
    ? `${formatAge(decision.lastEmail.sentAt)} • ${decision.lastEmail.templateName}`
    : 'No recorded email');
  commandLog('📱', 'Last text', decision.lastText
    ? `${formatAge(decision.lastText.sentAt)} • ${decision.lastText.templateName}`
    : 'No recorded text');
  commandLog('🧬', 'Template history', decision.sameTemplate
    ? `Previously sent ${formatAge(decision.sameTemplate.sentAt)}`
    : 'New for this contact');
}

function contactGuardReason(decision) {
  return decision.reasons.map(({ code, event }) => {
    if (code === 'active_reservation') return 'another outreach mission is active';
    if (code === 'recent_contact') return `${event.channel} sent ${formatAge(event.sentAt)}`;
    if (code === 'same_template') return `same template sent ${formatAge(event.sentAt)}`;
    return code;
  }).join('; ');
}

/**
 * Deep query selector that pierces through all open shadow DOM roots.
 * Returns the first matching element found anywhere in the document,
 * including inside nested shadow roots.
 */
function deepQuerySelectorAll(root, selector) {
  const results = [];
  function walk(node) {
    // Check this node's own children
    const matches = node.querySelectorAll(selector);
    matches.forEach(el => results.push(el));
    // Recurse into shadow roots
    const allElements = node.querySelectorAll('*');
    allElements.forEach(el => {
      if (el.shadowRoot) {
        walk(el.shadowRoot);
      }
    });
  }
  walk(root);
  return results;
}

/**
 * Find elements by exact text anywhere in the document, including shadow DOM.
 * Returns array of { el, tag, text, rect } for elements whose innerText matches.
 */
function deepFindByText(root, searchText, options = {}) {
  const results = [];
  const exact = options.exact !== false;
  function walk(node) {
    const allElements = node.querySelectorAll('*');
    allElements.forEach(el => {
      const text = (el.innerText || el.textContent || '').trim();
      if (exact ? text === searchText : text.toLowerCase().includes(searchText.toLowerCase())) {
        if (el.offsetParent !== null || el.getClientRects().length > 0) {
          const rect = el.getBoundingClientRect();
          results.push({ el, tag: el.tagName.toLowerCase(), text, x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), w: rect.width, h: rect.height });
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(root);
  return results;
}

/**
 * Find all textareas / contenteditable / role=textbox anywhere in the document,
 * including inside shadow DOM roots.
 */
function deepFindComposeBoxes(root) {
  const results = [];
  function walk(node) {
    const els = node.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    els.forEach(el => {
      if (el.offsetParent !== null || el.getClientRects().length > 0) {
        const rect = el.getBoundingClientRect();
        results.push({
          el,
          tag: el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          x: Math.round(rect.x + rect.width/2),
          y: Math.round(rect.y + rect.height/2),
          w: rect.width,
          h: rect.height
        });
      }
    });
    const allElements = node.querySelectorAll('*');
    allElements.forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(root);
  return results;
}

/**
 * Find Send button by text anywhere in the document, including shadow DOM.
 */
function deepFindSendButtons(root) {
  const results = [];
  function walk(node) {
    const els = node.querySelectorAll('button, [role="button"], a, span, input[type="submit"], input[type="button"]');
    els.forEach(el => {
      const text = (el.innerText || el.value || '').trim();
      if (text === 'Send' && (el.offsetParent !== null || el.getClientRects().length > 0)) {
        const rect = el.getBoundingClientRect();
        results.push({
          el,
          tag: el.tagName.toLowerCase(),
          x: Math.round(rect.x + rect.width/2),
          y: Math.round(rect.y + rect.height/2),
          w: rect.width,
          h: rect.height,
          disabled: el.disabled || false
        });
      }
    });
    const allElements = node.querySelectorAll('*');
    allElements.forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(root);
  return results;
}

// ============================================================================
// Virtual cursor — a visible dot that follows mouse moves so you can see what's happening
// ============================================================================
async function injectVirtualCursor(page) {
  await page.addStyleTag({ content: `
    .hermes-cursor {
      position: fixed;
      width: 20px;
      height: 20px;
      border: 3px solid #ff4444;
      border-radius: 50%;
      pointer-events: none;
      z-index: 999999;
      margin-left: -10px;
      margin-top: -10px;
      transition: all 0.1s ease;
      box-shadow: 0 0 10px rgba(255,68,68,0.5);
    }
    .hermes-cursor::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 4px;
      height: 4px;
      background: #ff4444;
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }
  ` });
  await page.evaluate(() => {
    if (!document.querySelector('.hermes-cursor')) {
      const cur = document.createElement('div');
      cur.className = 'hermes-cursor';
      cur.style.left = '0px';
      cur.style.top = '0px';
      cur.style.display = 'none';
      document.body.appendChild(cur);
      document.addEventListener('mousemove', (e) => {
        cur.style.left = e.clientX + 'px';
        cur.style.top = e.clientY + 'px';
        cur.style.display = 'block';
      });
    }
  });
}

async function moveCursorTo(page, x, y) {
  await page.evaluate(({ x, y }) => {
    const cur = document.querySelector('.hermes-cursor');
    if (cur) {
      cur.style.left = x + 'px';
      cur.style.top = y + 'px';
      cur.style.display = 'block';
    }
  }, { x, y });
}

/** TCPA gate: returns true if texting is allowed now; otherwise logs why and when it reopens. */
function tcpaOpen(context = '') {
  const g = tcpa.check();
  if (g.ok) return true;
  commandLog('⏰', 'TCPA hours', `HOLD${context ? ' — ' + context : ''} — ${g.reason}. Texting reopens ${tcpa.nextOpen()}`);
  return false;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve((ans || '').trim()); }));
}

function parseRange(raw) {
  const s = String(raw).trim().toLowerCase();
  if (s === 'all' || s === '*') return { start: 1, end: null };
  let m = s.match(/^(\d+)\s*[-]\s*(\d+)$/);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start < 1 || end < start) throw new Error(`Bad range. Need start>=1 and <=end.`);
    return { start, end };
  }
  m = s.match(/^(\d+)$/);
  if (m) return { start: 1, end: parseInt(m[1], 10) };
  throw new Error(`Could not parse range '${raw}'. Use '1-100', '50-75', or 'all'.`);
}

/**
 * Resolve skip-by-name terms (e.g. "ADN Doors") against the harvested leads.
 * Case-insensitive; an exact name match wins, otherwise a substring match. A term that
 * substring-matches more than one lead is NOT applied (too risky to guess) — it is
 * returned in `ambiguous` so the operator can be more specific.
 * Returns { positions: Set<1-based row>, applied: [{term,row,name}], none: [term], ambiguous: [{term,rows}] }.
 */
function resolveSkips(leads, terms) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const out = { positions: new Set(), applied: [], none: [], ambiguous: [] };
  for (const raw of terms) {
    const term = norm(raw);
    if (!term) continue;
    const rows = leads.map((l, i) => ({ row: i + 1, name: l.name })).filter((r) => norm(r.name) === term);
    const hits = rows.length ? rows : leads.map((l, i) => ({ row: i + 1, name: l.name })).filter((r) => norm(r.name).includes(term));
    if (!hits.length) out.none.push(raw.trim());
    else if (!rows.length && hits.length > 1) out.ambiguous.push({ term: raw.trim(), rows: hits });
    else hits.forEach((h) => { out.positions.add(h.row); out.applied.push({ term: raw.trim(), row: h.row, name: h.name }); });
  }
  return out;
}

function parseArgs(argv) {
  const args = { skip: [], range: null, message: null, delayMs: CONFIG.defaultDelayMs, yes: false, inspect: false, template: null, report: false, email: false, scan: null, fromDashboard: false, fromHand: false, tag: null, cadence: false, core: false, library: false, sequence: false, postdemo: false, dryRun: false, subject: null, bodyFile: null, sent: false, ignoreSms: false, save: false, queue: false, oppy: false, force: false, reengage: false, text: false, review: null, reviewReport: false, mode: null, loadWaitMs: 15000, zones: false, zone: null, threadProbe: null, harvest: false, auto: false, maxSet: false, evidenceOnly: false, again: false, lists: false, kind: null, modes: [], snapshot: false, sharkMode: false, noQueue: false, fromSnapshot: false, noReview: false, once: false, max: 25, maxAgeDays: 7, only: null, followup: false, teammate: false, industry: false, refresh: false, deep: false, unknownZoneGiven: false, send: false, until: null, days: 3, scannedOnly: false, maxTexts: null, unknownZone: 'strict', step: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--range') args.range = argv[++i];
    else if (a === '--skip') args.skip.push(...String(argv[++i] || '').split(',').filter((s) => s.trim()));
    else if (a === '--message' || a === '-m') args.message = argv[++i];
    else if (a === '--template' || a === '-t') args.template = argv[++i];
    else if (a === '--delay') args.delayMs = parseFloat(argv[++i]) * 1000;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--inspect') args.inspect = true;
    else if (a === '--report' || a === '--reports') args.report = true;
    else if (a === '--email' || a === '--emails') args.email = true;
    else if (a === '--core') { args.core = true; args.sequence = true; }   // core = 5 employees or fewer → the 6-step cadence (emailSequence.js)
    else if (a === '--scan') args.scan = String(argv[++i] || '').toLowerCase();   // --scan lds : open that saved report, scan + save it, then email (see REPORT_MODES)
    else if (a === '--from-free-plan') args.fromFreePlan = true;   // email the accounts the dashboard's 🆓 Invoicing & Payments tab lists (🎓 business coaching only once coachingPolicy.js releases it)
    else if (a === '--never-emailed') args.neverEmailed = true;   // a ONE-OFF email (--email-template …): only the accounts we have NEVER emailed (no email of any kind in the log); see prepareNeverEmailedLeads
    else if (a === '--retry-skipped') args.retrySkipped = true;   // --never-emailed: try again the accounts that had no email address when we last opened them (they are left out for good)
    else if (a === '--blast') { args.blast = true; const di = argv.indexOf('--days'); args.blastDays = di >= 0 ? parseInt(argv[di + 1], 10) : 5; }   // --email --blast: ONE email to every lead we have not emailed in over --days days (default 5); a manual run (emailBlast.js)
    else if (a === '--include-never-emailed') args.includeNeverEmailed = true;   // --blast: the leads we have NEVER emailed join too, after the others
    else if (a === '--product') args.blastProduct = String(argv[++i] || '').toLowerCase().trim() || null;   // --blast --product essentials: only leads pitched that plan
    else if (a === '--no-higher') args.blastNoHigher = true;   // with --product: exclude Pros pitched a higher tier (Max/Above miss Essentials promos)
    else if (a === '--list') args.list = String(argv[++i] == null ? '' : argv[i]);   // --blast --list shark|lds|email-report|free-plan: only that list's leads
    else if (a === '--last-typed') args.lastTyped = true;   // --blast: send the email you typed last time (blast-emails.jsonl) instead of typing or picking one
    else if (/^--(never|not[-_]?e?mail|un[-_]?e?mail)/i.test(a)) { console.error(`${a} is not an option: write --never-emailed (a typo here would send the one-off email to every lead on the list, not only the ones we never emailed)`); process.exit(1); }   // never fall through to "everyone" by a typo
    else if (a === '--from-dashboard') args.fromDashboard = true;   // email the accounts already in our system (the dashboard's LDS tab) instead of an open report
    else if (a === '--from-hand') { args.fromHand = true; args.core = true; args.sequence = true; }   // email the leads you added by hand (dashboard Tools > Follow-up board), each its NEXT touch of the 6-touch cadence
    else if (a === '--tag') args.tag = String(argv[++i] || '').replace(/^#+/, '').toLowerCase() || null;   // --from-hand --tag referral: only the hand-added leads carrying that tag (write it without the #)
    else if (/^--(tags|hand-tag|handtag)$/.test(a) || /^--tag=/.test(a)) { console.error(`${a} is not an option: write --tag <name> (ONE tag, without the #), for example --tag referral`); process.exit(1); }   // never fall through to "every hand-added lead" by a typo
    else if (a === '--cadence') args.cadence = true;               // no browser: where every LDS lead stands in the 6-step cadence
    else if (a === '--library') args.library = true;   // the older one-shot trade-matched library email
    else if (a === '--content') { console.error('--content was renamed to --core (core = 5 employees or fewer). Re-run with --core.'); process.exit(1); }   // never fall through to a plain email by accident
    else if (a === '--sequence') args.sequence = true;
    else if (a === '--postdemo') args.postdemo = true;
    else if (a === '--dry-run' || a === '--dryrun') args.dryRun = true;
    else if (a === '--test') args.test = true;      // a practice run: the testing list (CONFIG.testListUrl) and always a dry run (applyTestMode)
    else if (a === '--subject') args.subject = argv[++i];
    else if (a === '--email-template') args.emailTemplate = String(argv[++i] || '').toLowerCase();   // a named email from email-templates.json (e.g. curiosity)
    else if (a === '--body-file') args.bodyFile = argv[++i];
    else if (a === '--sent' || a === '--texted' || a === '--dashboard') args.sent = true;
    else if (a === '--ignore-sms' || a === '--no-sms-guard') args.ignoreSms = true;
    else if (a === '--save' || a === '--snapshot') args.save = true;
    else if (a === '--queue' || a === '--from-saved') args.queue = true;
    else if (a === '--oppy' || a === '--opps' || a === '--opportunities') args.oppy = true;
    else if (a === '--force' || a === '--no-guards') args.force = true;
    else if (a === '--reengage' || a === '--re-engage') args.reengage = true;
    else if (a === '--text' || a === '--texts') args.text = true;
    else if (a === '--once') args.once = true;
    else if (a === '--review') args.review = argv[++i];
    else if (a === '--review-report') args.reviewReport = true;
    else if (a === '--zones') args.zones = true;
    else if (a === '--harvest') args.harvest = true;
    else if (a === '--deep') args.deep = true;
    else if (a === '--zone') args.zone = argv[++i];
    else if (a === '--thread-probe') args.threadProbe = argv[++i];
    else if (a === '--load-wait') args.loadWaitMs = Math.max(0, (parseFloat(argv[++i]) || 15) * 1000);
    else if (a === '--lds' || a === '--inbound-lds' || a === '--inbound-ka-lds') { args.wantLds = a; }
    else if (a === '--shark') { args.snapshot = true; args.sharkMode = true; if (REPORT_MODES.shark) args.mode = 'shark'; }
    else if (a === '--shark13') { args.snapshot = true; args.sharkMode = true; args.shark13 = true; args.mode = 'shark13'; }   // the --shark backup of the T13 report (tomorrow's Shark list); with --send it texts each pro at their own NEXT 8:00 AM (tomorrowSend.js)
    else if (a === '--tomorrow') args.tomorrow = true;                                  // with --send: hold every text until each pro's own NEXT 8:00 AM (tomorrow morning when started at night); nobody is texted tonight (tomorrowSend.js)
    else if (a === '--snapshot') args.snapshot = true;
    else if (a === '--evening') args.evening = true;                                    // text TOMORROW's Shark list TONIGHT at each pro's 7 PM (eveningShark.js; its own flags: --at, --margin, --no-verify)
    else if (a === '--board') args.board = true;                                        // the follow-up board's automatic run (boardRun.js; its own flags: --stage, --trade, --older, --max-emails, --texts-only, --emails-only; --nocheck skips the enrollment look before each text, enrollCheck.js)
    else if (a === '--no-queue') args.noQueue = true;
    else if (a === '--from-snapshot') args.fromSnapshot = true;
    else if (a === '--teammate') args.teammate = true;
    else if (a === '--followup' || a === '--follow-up') args.followup = true;
    else if (a === '--teammate-texted' || a === '--teammate-list') { args.teammateTexted = true; args.followup = true; }   // text the pros on the dashboard's 🤝 Teammate texted tab: the follow-up run with a different list and thread rule (teammateTexted.js)
    else if (a === '--same-day' || a === '--today') { console.error('\n⛔ --same-day is not part of this version of Assistant. Nothing was started.\n'); process.exit(1); }   // refused: never fall through to a plain text campaign by accident
    else if (a === '--holds') args.holds = true;
    else if (a === '--by-email') args.byEmail = true;                                  // --email --by-email: the report lists EMAIL ADDRESSES; each is looked up to its account (emailLookup.js)
    else if (a === '--csv') args.csv = (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) ? String(argv[++i]) : '';   // --email --by-email --csv <file>: the addresses come from a CSV file (emailSource.js) instead of an open report
    else if (a === '--csv-column') args.csvColumn = String(argv[++i] || '');   // which column of the CSV holds the address (its header, or its 1-based position); default: the one named Email
    else if (a === '--no-own-data') args.noOwnData = true;   // --by-email: search Salesforce for every address with no saved lookup (do not match from texted-log.jsonl / account-emails.jsonl first)
    else if (a === '--lookup-only') args.lookupOnly = true;
    else if (a === '--debug-lookup') args.debugLookup = true;
    else if (a === '--lookup-limit') args.lookupLimit = parseInt(argv[++i], 10) || null;
    else if (a === '--industry') args.industry = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--send') args.send = true;
    else if (a === '--until') args.until = argv[++i];
    else if (a === '--days') { const d = parseInt(argv[++i], 10); args.days = Number.isFinite(d) && d >= 0 ? d : 3; }
    else if (a === '--scanned-only') args.scannedOnly = true;
    else if (a === '--no-lds') args.noLds = true;                  // --followup: the Shark accounts only, as before (the LDS leads that are not on the Shark tab are left out)
    else if (a === '--max-texts') args.maxTexts = parseInt(argv[++i], 10) || null;
    else if (a === '--step') args.step = parseInt(argv[++i], 10) || null;
    else if (a === '--unknown-zone') { args.unknownZone = /^hold$/i.test(argv[++i] || '') ? 'hold' : 'strict'; args.unknownZoneGiven = true; }
    else if (a === '--lists') args.lists = true;
    else if (a === '--kind') args.kind = argv[++i];
    else if (a.startsWith('--') && REPORT_MODES[a.slice(2)]) { args.reviewReport = true; args.mode = a.slice(2); args.modes.push(a.slice(2)); }
    else if (a === '--no-review' || a === '--nocheck' || a === '--no-check') { console.error('\n⛔ --nocheck is not part of this version of Assistant: every text and email is checked. Nothing was started.\n'); process.exit(1); }   // refused
    else if (a === '--check') args.check = true;                       // --followup: open each account's Salesforce profile, check it, text it, then the next one (see followupCheckMode)
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--zone-only') args.zoneOnly = argv[++i];                          // --followup --zone-only PT: only pros whose saved time zone is Pacific
    else if (a === '--max') { const v = argv[++i]; args.max = /^all$/i.test(String(v)) ? Number.MAX_SAFE_INTEGER : (parseInt(v, 10) || 25); args.maxSet = true; }
    else if (a === '--auto') args.auto = true;
    else if (a === '--no-auto') args.noAuto = true;      // force template mode even when Settings has Claude drafts on
    else if (a === '--evidence-only') args.evidenceOnly = true;
    else if (a === '--again') args.again = true;
    else if (a === '--max-age-days') args.maxAgeDays = parseFloat(argv[++i]) || 7;
    else if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--pick' || a === '--choose') args.pick = true;                    // --shark --pick: do NOT open the saved report; you open the Shark list you want in Chrome
  }
  if (args.pick && args.snapshot && !args.shark13) args.mode = null;      // no saved report: the manual "open the list, press Enter" path
  if (args.shark13 && args.send) args.tomorrow = true;      // --shark13 is TOMORROW's list: texting it means each pro's next 8:00 AM, never "whoever is inside their hours tonight"
  if (PIPELINE_ONLY) args.noLds = true;      // follow-up never pulls LDS leads in this copy
  return args;
}

/** Refuse LDS entry points in this pipeline-only copy. → error string or null. */
function pipelineOnlyBlock(args) {
  if (!PIPELINE_ONLY) return null;
  const bad = [];
  if (args.wantLds) bad.push(args.wantLds);
  if (args.mode === 'lds' || args.mode === 'inbound-lds') bad.push('--' + args.mode);
  for (const m of args.modes || []) if (m === 'lds' || m === 'inbound-lds') bad.push('--' + m);
  if (args.scan === 'lds' || args.scan === 'inbound-lds') bad.push('--scan ' + args.scan);
  if (args.fromDashboard) bad.push('--from-dashboard');
  if (String(args.list || '').toLowerCase() === 'lds') bad.push('--list lds');
  if (args.kind && /lds/i.test(String(args.kind))) bad.push('--kind ' + args.kind);
  if (!bad.length) return null;
  return `\n⛔ This copy only uses your campaign Salesforce report. LDS mode is not available (${[...new Set(bad)].join(', ')}).\n   Use:  zw   or  zw --text   or  zw --test\n(Nothing was started.)\n`;
}

// ============================================================================
// Text templates
// ============================================================================
const TEMPLATES = {
  '1': {
    name: 'Essentials Promo',
    text: 'Hey its Luke at Housecall Pro. We still have the $26 promo to get started and no contracts. Are you where you want to be this year? Call me at 970-338-3120 or reply here to get started!',
  },
  '2': {
    name: 'Max Plan Promo',
    text: 'Hey its Luke at Housecall Pro. We are running a Max plan promo right now, $99/mo for the first 3 months, no contracts. Want to see what Max can do for your business? Call me at 970-338-3120 or reply here to get started!',
  },
  '3': {
    name: 'Special Offer',
    text: 'Special Offer this week only at Housecall Pro: Sign up for the Max plan at a promotional rate of $99/mo for the first 3 months and recieve a $100 amazon gift card!',
  },
  '4': {
    name: 'HCP Full Stack Promo',
    text: "Hey! If you're still considering Housecall Pro for your business, we can get you started for just $26 for your first month! Alongside our streamlining abilities, we also partner with Google Local Services for top page visibility & high-converting leads, + a free $100 Thumbtack credit and a $50 Amazon gift card. . Reply \"Y\" if interested. Thanks again! - Luke @ HCP",
  },
  '5': {
    name: 'Respectful Follow-Up',
    text: "Hey, Luke here with Housecall Pro. I know our team has reached out a few times. Is finding a new system still on your radar, or would you prefer we leave it here for now? Either way, happy to respect your timing.",
  },
  '6': {
    name: 'Re-Engagement $26 + $100 Amazon',
    text: "Hey its Luke at Housecall Pro reaching back out to see if now is a better time to try out our all in one platform to help you make money and save time everyday. We can also help you rank higher on Google so more customers find you. We still have the promo that gives you the first month for only $26 and a $100 amazon gift card! Reply Y if you want to give us a shot or call me at 970-338-3120",
  },
  '7': {
    name: 'Key Accounts Re-Engagement (Max $99 + $50 Amazon)',
    text: "Hey, you met with our Key Accounts team earlier this year and we wanted to see if now is a better time to try out Housecall Pro at a discounted rate for the first 3 months. You get unlimited users for only $99 on the Max plan and a $50 amazon gift card! We have no contracts and we are ready to partner with you to grow the business and streamline operations.",
  },
  '8': {
    name: 'Follow-Up 1',
    text: 'Just checking in, are you ready to get started with Housecall Pro? Remember, you get a $100 amazon giftcard after your 2nd onboarding session with us and the first month is only $26 with no contracts!\n\n- Luke Franco at HCP\n970-338-3120',
  },
  '9': {
    name: 'Book A Demo',
    text: 'Book a demo: tinyurl.com/housecallprodemo',
  },
  '10': {
    name: 'Account Idea + Book A Demo',
    text: 'Hey, it’s Luke at Housecall Pro! I was looking at your account and had an idea to help you grow your business.\n\nI’d love to show you how our marketing campaigns and Pipeline tool work together to automate lead follow-up and help you win more jobs. Get started for $26 for your first month, plus the Amazon gift card and Thumbtack and Yelp lead credits. We’ll help you build systems that keep your business moving.\n\nCall me: 970-338-3120\nBook a demo: tinyurl.com/housecallprodemo',
  },
  '11': {
    name: 'Connect Tomorrow',
    text: 'Do you have 15 minutes to connect tomorrow on how we can help you win more jobs? Book here: tinyurl.com/housecallprodemo\n\n* Luke at HCP 970-338-3120',
  },
  // The 60-day drip (cadence.js, Day 5 / Day 14 / Day 28): one Housecall Pro feature each, plain characters only.
  '12': {
    name: 'Drip: Online Booking',
    text: "Hey, it's Luke at Housecall Pro. Quick one: online booking lets customers book a job straight from your website or Google, and you get an alert right away when it comes in. No phone tag, no lost leads. Want to see how it would work for your business? tinyurl.com/housecallprodemo",
  },
  '13': {
    name: 'Drip: Pipeline Follow-Up',
    text: "Luke at Housecall Pro again. A lot of quotes go cold because nobody followed up, not because the customer said no. Pipeline keeps every lead and estimate in one view and sends the follow-ups for you. Want to see it on your own estimates? tinyurl.com/housecallprodemo",
  },
  '14': {
    name: 'Drip: Get Paid + Financing',
    text: "Luke at Housecall Pro. Bigger jobs stall when the customer can't pay all at once. With Housecall Pro you get paid on the spot by card, ACH, or financing, and in the 2026 homeowner survey 62% were more likely to book when financing was offered. Want to see how it works? tinyurl.com/housecallprodemo",
  },
  // Luke's 2 PM text (2026-11-03), sent by hand with `email --same-day --template 15` to the Shark pros texted that morning. His own wording, pasted by him and kept character for character (the space after "Housecall Pro" is his).
  // NOT a board stage text on purpose: --same-day refuses a wording that is one of the board's own stage texts (sameDay.boardClash), so never point a stage of cadence.js at this template.
  '15': {
    name: 'Game Plan 2027',
    text: 'Book 30 mins here and I will create you a custom game plan for growth in 2027: tinyurl.com/housecallprodemo\n\n- Luke Franco at Housecall Pro \n970-338-3120',
  },
  // Luke's Day 2 text (2026-11-04: "i want to add in day 2, text 3"): the third text of the 60-day drip (cadence.js, Day 2 · Text 3). His own wording, kept character for character ("thats", "businesses owners" and the space after "us." are his).
  // A board stage text on purpose: --same-day refuses a wording that is one of the board's own stage texts (sameDay.boardClash).
  '16': {
    name: 'Drip: Time Saved',
    text: "I know you were probably slammed yesterday (and everyday) but thats exactly why we are here to help at Housecall Pro. On average businesses owners save 8.5 hours a week when they partner with us. \n\nIs $26 for the first month worth over 40 hours of saved time for you per month?",
  },
};
// The wording above was written by Luke Franco. sender.apply swaps his name, numbers and booking link for this copy's sender (sender.json) and changes nothing else.
for (const t of Object.values(TEMPLATES)) t.text = sender.apply(t.text);
// The texts this person changed or added in Settings (T) are merged over the built-in ones (senderSetup.js). A missing or unreadable file never stops a run.
try { require('./senderSetup').applyTextEdits(TEMPLATES); } catch (_) { /* the built-in texts stay as they are */ }

// 48h re-engage touch (--reengage): a different message than the first touch, sent
// once per account per channel to accounts whose last outreach was 48h–7d ago.
// Template names MUST start with textLog.REENGAGE_PREFIX — that is how "already
// re-engaged" is detected. EDIT THE COPY BELOW BEFORE GOING LIVE.
const REENGAGE_TEXT = {
  name: `${textLog.REENGAGE_PREFIX} (text)`,
  text: "Hey its Luke at HCP. Did you want to activate the software for $26 so we can help you get more jobs and streamline operations? Remember, we give you a $100 amazon giftcard after your 2nd onboarding session with us so this is a win for you!",
};
REENGAGE_TEXT.text = sender.apply(REENGAGE_TEXT.text);
// Saved report modes. LDS / Inbound KA LDS are intentionally omitted in this pipeline-only copy.
const REPORT_MODES = {
  // Default campaign report for zw / zw --text / zw --test (also CONFIG.reportUrl via senderSetup).
  pipeline: { name: 'Zach White Campaign Report', kind: 'Shark', url: 'https://housecallpro.lightning.force.com/lightning/r/Report/00OPD00000H2v6s2AB/view' },
  // `zw --shark13`: tomorrow's Shark list (the T13 report: the pros who would post to T14 at midnight). It opens by itself, like --shark opens the saved T14 report.
  shark13: { name: 'T13 Shark List All', kind: 'Shark', url: 'https://housecallpro.lightning.force.com/lightning/r/Report/00OPD00000GVYkC2AX/view?queryScope=userFolders' },
};
// `email --shark --pick` asks which Shark list to back up. A list whose report is not saved yet (T30, T150+) is opened by hand once and then remembered in report-modes.json.
const SHARK_PICK = [
  { n: 1, key: 'shark', label: 'T14 Shark List All' },
  { n: 2, key: 'shark13', label: 'T13 Shark List (tomorrow\'s T14)' },
  { n: 3, key: 'shark30', label: 'T30' },
  { n: 4, key: 'shark150', label: 'T150+' },
];
// More saved reports without touching code: report-modes.json = { "shark": { "name": "T14 Shark List All", "kind": "Shark", "url": "https://…/Report/<id>/view" } }
// → `email --shark`, `email --auto --shark`, and `email --lists` pick it up.
try {
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, 'report-modes.json'), 'utf8'));
  for (const [k, v] of Object.entries(extra)) {
    if (!(v && /^https:\/\//.test(v.url || '') && /^[a-z0-9-]+$/.test(k))) continue;
    const kind = v.kind || textLog.classifyList(v.name || k);
    if (PIPELINE_ONLY && (/lds/i.test(String(kind || '')) || /lds/i.test(k))) continue;      // this copy never loads an LDS report mode
    REPORT_MODES[k] = { name: v.name || k, url: v.url, kind };
  }
} catch (_) {}

function listTemplates() {
  console.log('\n📋 Available Templates:\n');
  for (const [id, t] of Object.entries(TEMPLATES)) {
    console.log(`  [${id}] ${t.name}`);
    console.log(`      "${t.text}"\n`);
  }
}

// ============================================================================
// Email template (used by --email mode)
// ============================================================================
// The sender's signature (sender.json) — plain text; blank lines separate paragraphs.
const EMAIL_SIGNATURE = sender.apply([
  'Luke Franco',
  'Account Executive',
  'Housecall Pro',
  'Text: 833-337-0813',
  'Call: 970-338-3120',
  '',
  'Book A Demo: https://tinyurl.com/HousecallProDemo',
].join('\n'));

/** The signature for HTML emails: the demo link is a clickable "Book A Demo" shortcut, not a raw URL. */
function signatureHtml() {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return EMAIL_SIGNATURE.split('\n').map((l) => { const m = l.match(/^(Book A Demo):\s+(https?:\/\/\S+)$/); return m ? `<a href="${m[2]}">${m[1]}</a>` : esc(l); }).join('<br>');
}

// First-touch re-engagement email. No per-lead personalization (no original-owner
// reference, no call-notes) — a single clean message that goes to every harvested
// account. Override the subject with --subject and the body with --body-file.
const EMAIL_TEMPLATE = {
  name: 'HCP re-engagement (first touch)',
  subject: 'Is Housecall Pro still on your radar for {{business|your business}}?',
  body: [
    '{{greeting}}',
    '',
    "Luke here with Housecall Pro. I wanted to reach back out and see if the timing's any better now.",
    '',
    'Since you last met with our team, Housecall Pro has only gotten better at taking the busywork off your plate. It puts everything you run the business with in one place:',
    '',
    '• Scheduling & dispatch — a drag-and-drop calendar with automated text/email reminders that cut down no-shows',
    '• Estimates & invoicing — build and send them right from the field, and get paid on the spot by card, ACH, or consumer financing',
    '• Reviews & repeat work — automatically request Google reviews and re-engage past customers so your pipeline keeps filling itself',
    '• Lead capture — online booking, a website, and Google bookings that funnel every new lead into one place to track',
    '• Marketing — postcards and email campaigns that bring old customers back',
    '• QuickBooks — integrates with QuickBooks so your books stay clean with no double entry',
    '',
    'Most Pros tell us it saves them several hours a week and helps them book more jobs. To make it easy to start, we still have our get-started offer: your first month for $26 with no contracts — and right now I can include a $100 gift card to help offset the cost of that first month.',
    '',
    '{{industryBlock}}',
    '',
    'Worth a quick look? Reply here, or grab a time that works using the link below.',
    '',
    EMAIL_SIGNATURE,
  ].join('\n'),
};
EMAIL_TEMPLATE.body = sender.apply(EMAIL_TEMPLATE.body);

const REENGAGE_EMAIL = {
  name: `${textLog.REENGAGE_PREFIX} (email)`,
  subject: 'Quick follow-up from Housecall Pro',
  body: [
    'Hi,',
    '',
    'Luke here again. I wanted to make sure my last message didn\u2019t get buried.',
    '',
    'If running scheduling, invoicing and follow-ups from one place sounds useful, I can get you started for $26 your first month, no contracts, and you\u2019ll get a $100 Amazon gift card after your second onboarding session with us. Many Pros are up and running the same day.',
    '',
    'If the timing still isn\u2019t right, just reply \u201cnot now\u201d and I\u2019ll leave it there.',
    '',
    'Luke Franco',
    'Account Executive',
    'Housecall Pro',
    '970-338-3120',
  ].join('\n'),
};
REENGAGE_EMAIL.body = sender.apply(REENGAGE_EMAIL.body);

/** The named emails in email-templates.json (Luke edits the wording there): { key: { name, subject, body: string | string[] } }. */
function loadEmailTemplates() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-templates.json'), 'utf8')) || {};
    for (const t of Object.values(all)) if (t && typeof t === 'object') { t.subject = sender.apply(t.subject); t.body = Array.isArray(t.body) ? t.body.map((l) => sender.apply(l)) : sender.apply(t.body); }      // Luke's name / numbers / link -> the sender's (sender.json)
    return all;
  } catch (_) { return {}; }
}
const TYPE_YOUR_OWN = 'type-your-own';      // the key of the menu choice that asks you to type the subject and the email
const TYPE_YOUR_OWN_NAME = 'Type your own subject line & email (no signature needed)';
/** email-menu.json = { "menu": ["day-after-demo", …], "typeYourOwn": true }: which emails the "Which email?" menu shows and in what order (an email's key from email-templates.json, or "built-in" for the re-engagement email), and whether the "Type your own…" choice ends it. order is null when there is no usable list. */
function loadMenuFile() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-menu.json'), 'utf8'));
    return { order: Array.isArray(j.menu) ? j.menu.map((k) => String(k).trim().toLowerCase()).filter(Boolean) : null, typeYourOwn: j.typeYourOwn !== false };
  } catch (_) { return { order: null, typeYourOwn: true }; }
}
/**
 * The numbered "Which email?" menu. email-menu.json says which emails it shows and in what order. An email left off the list is not in the menu but stays in email-templates.json
 * (the follow-up board sends some of them by name, and any email can still be named with --email-template). A key that is not an email is skipped. With no list, or a list that
 * leaves nothing, the menu is the built-in re-engagement email #1 and then every email of email-templates.json in file order, as it always was. The LAST choice is "Type your own
 * subject line & email" (typed: true), unless email-menu.json says "typeYourOwn": false.
 */
function emailTemplateMenu() {
  const named = loadEmailTemplates();
  const usable = (k) => named[k] && typeof named[k] === 'object' && named[k].subject && named[k].body;
  const builtIn = { key: null, name: EMAIL_TEMPLATE.name, subject: EMAIL_TEMPLATE.subject };
  const entry = (k) => ({ key: k, name: named[k].name || k, subject: named[k].subject });
  const { order, typeYourOwn } = loadMenuFile();
  let list = order ? [...new Set(order)].map((k) => (k === 'built-in' ? builtIn : usable(k) ? entry(k) : null)).filter(Boolean) : [];
  if (!list.length) list = [builtIn, ...Object.keys(named).filter(usable).map(entry)];
  if (typeYourOwn) list.push({ key: TYPE_YOUR_OWN, name: TYPE_YOUR_OWN_NAME, subject: null, typed: true });
  return list.map(({ key, name, subject, typed }, i) => ({ n: i + 1, key, name, subject, typed: !!typed }));
}
/** The first email of the menu that is an email: what a run that names no email at all uses (a --yes run, a preview), and what Enter takes unless the menu starts with "Type your own". → its key (null = the built-in re-engagement email). */
function defaultEmailKey() {
  const m = emailTemplateMenu().find((x) => !x.typed);
  return m ? m.key : null;
}
/** What the "Which email?" menu does with what was typed: a number or a name → that choice; just Enter → the FIRST choice in the menu. 'built-in' = the re-engagement email picked on purpose (an empty value would mean "no email named", which is the first email); TYPE_YOUR_OWN = the choice that asks you to type one. */
function emailKeyFromMenuPick(menu, pick) {
  const p = String(pick || '').trim().toLowerCase();
  const hit = p ? menu.find((m) => String(m.n) === p || m.key === p) : menu[0];
  if (hit) return hit.key === null ? 'built-in' : hit.key;
  return emailTemplateKey(p) || 'built-in';      // not in the menu: an email named by hand (or a number outside it, which is refused)
}
/** --email-template accepts a menu number (1, 2…) or an email's name. A name works for ANY email of email-templates.json, in the menu or not; "built-in" is the re-engagement email. → the key, or null for the built-in email. Naming no email at all is the FIRST email in the menu (defaultEmailKey). "Type your own…" only works from the menu at the prompt. */
function emailTemplateKey(v, opts = {}) {
  if (v == null || v === '') return defaultEmailKey();
  const s = String(v).trim().toLowerCase(), menu = emailTemplateMenu().filter((m) => !(opts.noTyped && m.typed));      // noTyped: the blast prompt, which has its own "type my own" and no such choice
  const hit = menu.find((m) => String(m.n) === s || m.key === s);
  if (hit && hit.typed) throw new Error(`"${hit.name}" asks you for the subject and the email, so it works from the menu at the prompt, not with --email-template`);
  if (hit) return hit.key;
  if (s === 'built-in') return null;
  const named = loadEmailTemplates();
  if (named[s] && typeof named[s] === 'object' && named[s].subject && named[s].body) return s;      // not in the menu, but it is an email (the board and old habits name them)
  throw new Error(`no email template "${v}" (have: ${menu.map((m) => `${m.n} = ${m.name}`).join('; ')})`);
}
function namedEmailTemplate(key) {
  const t = loadEmailTemplates()[key];
  if (!t || !t.subject || !t.body) throw new Error(`no email template "${key}" in email-templates.json (have: ${Object.keys(loadEmailTemplates()).join(', ') || 'none'})`);
  const body = Array.isArray(t.body) ? t.body.join('\n') : String(t.body);
  const signed = /Housecall Pro\s*\n/.test(body.slice(-200)) ? body : `${body.replace(/\s+$/, '')}\n\n${EMAIL_SIGNATURE}`;
  return { name: t.name || key, subject: t.subject, body: t.ps ? `${signed.replace(/\s+$/, '')}\n\nP.S. ${t.ps}` : signed };       // an optional "ps" goes AFTER the signature
}

/** Resolve the outgoing email {subject, body} from the template + CLI overrides. */
function resolveEmailContent(args) {
  if (args.typedEmail) return { subject: args.typedEmail.subject, body: args.typedEmail.body };      // --blast: the email typed at the prompt (or --last-typed)
  let subject = EMAIL_TEMPLATE.subject;
  let body = EMAIL_TEMPLATE.body;
  const tk = emailTemplateKey(args.emailTemplate);
  if (tk) { const t = namedEmailTemplate(tk); subject = t.subject; body = t.body; }
  if (args.subject) subject = args.subject;
  if (args.bodyFile) {
    try { body = fs.readFileSync(args.bodyFile, 'utf8'); }
    catch (e) { throw new Error(`could not read --body-file "${args.bodyFile}": ${e.message}`); }
  }
  return { subject, body };
}

// ============================================================================
// Browser launch
// ============================================================================
async function launchBrowser(opts = {}) {
  const CDP_PORT = opts.cdpPort || CONFIG.cdpPort;
  const PROFILE_DIR = opts.userDataDir || CONFIG.userDataDir;
  const quiet = !!opts.quiet; // interactive email/text menu: hide Browser link / CDP noise
  let context;

  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    context = browser.contexts()[0] || (await browser.newContext());
    if (!quiet) commandLog('🟢', 'Browser link', `Connected on CDP port ${CDP_PORT}`);
  } catch (cdpErr) {
    if (!quiet) commandLog('🛰️', 'Browser fallback', 'Launching persistent profile');
    try {
      const lockFile = path.join(PROFILE_DIR, 'SingletonLock');
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        args: [
          `--remote-debugging-port=${CDP_PORT}`,
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check'
        ],
        viewport: { width: 1920, height: 1080 }
      });
      if (!quiet) commandLog('🟢', 'Browser link', 'Persistent profile online');
    } catch (e) {
      throw new Error('Could not launch browser: ' + e.message);
    }
  }

  const page = context.pages()[0] || (await context.newPage());
  // Keep the page laid out at 1920x1080 for the whole run: a screenshot (compose-failure snapshot, email debug picture) otherwise makes Chrome re-lay it out at the real window size (clickGuard.js)
  try { await require('./clickGuard').pinViewport(page); } catch (_) {}
  const cleanup = async () => { try { await context.close(); } catch (_) {} };
  // Inject virtual cursor so user can see what's happening
  try { await injectVirtualCursor(page); } catch (_) {}
  return { context, page, cleanup };
}

// Friendly interactive menu after the HCP launch banners. Colour is left out when stdout is not a terminal (or NO_COLOR); FORCE_COLOR=1 turns it on for a test.
const YELLOW = (!process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR)) ? ['\x1b[1;33m', '\x1b[0m'] : ['', ''];
const CYAN = (!process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR)) ? ['\x1b[1;36m', '\x1b[0m'] : ['', ''];
const WELCOME_EMAIL = `
${CYAN[0]}╔══════════════════════════════════════════════════════════╗
║  ${CYAN[1]}${YELLOW[0]}EMAIL CAMPAIGN${YELLOW[1]}  ·  Welcome ${sender.firstName || 'there'}
${CYAN[0]}║${CYAN[1]}
${CYAN[0]}║${CYAN[1]}  1. Sign into Salesforce in the Chrome window
${CYAN[0]}║${CYAN[1]}  2. Your campaign report opens by itself — wait for rows
${CYAN[0]}║${CYAN[1]}  3. Press Enter here when you're ready
${CYAN[0]}╚══════════════════════════════════════════════════════════╝${CYAN[1]}
`;
const WELCOME_TEXT = `
${CYAN[0]}╔══════════════════════════════════════════════════════════╗
║  ${CYAN[1]}${YELLOW[0]}TEXT CAMPAIGN${YELLOW[1]}  ·  Welcome ${sender.firstName || 'there'}
${CYAN[0]}║${CYAN[1]}
${CYAN[0]}║${CYAN[1]}  1. Sign into Salesforce in the Chrome window
${CYAN[0]}║${CYAN[1]}  2. Your campaign report opens by itself — wait for rows
${CYAN[0]}║${CYAN[1]}  3. Press Enter here when you're ready
${CYAN[0]}╚══════════════════════════════════════════════════════════╝${CYAN[1]}
`;

/**
 * `--test`: a practice run. Uses CONFIG.reportUrl (your campaign report), and it is ALWAYS a dry run (--yes cannot change that): the composers are filled in on
 * each account you pick and nothing is sent. Called first thing in main(), before anything else looks at args.dryRun. → true when test mode is on.
 */
function applyTestMode(args) {
  if (!args.test) return false;
  args.dryRun = true;
  CONFIG.listUrl = CONFIG.testListUrl;
  CONFIG.reportUrl = CONFIG.testListUrl;
  return true;
}

/**
 * The practice flags are the one place a typo is dangerous: a flag this program does not know is silently ignored, so a mistyped --dry_run (or --dry, --Dry-Run, --dry-run=true, an en dash typed for the
 * hyphen) would start a LIVE run that the person believes is a practice run. So anything that LOOKS like a practice flag (dashes, then "dry" or "test") but is not spelled exactly --dry-run, --dryrun or
 * --test stops the program before anything starts. → a message, or null.
 */
const PRACTICE_FLAGS = new Set(['--dry-run', '--dryrun', '--test']);
function practiceFlagProblem(argv) {
  for (const raw of argv) {
    const a = String(raw);
    if (PRACTICE_FLAGS.has(a) || !/^[-‐-―−]+(dry|test)[\w-]*(=.*)?$/i.test(a)) continue;
    return `${a} is not a flag: write --dry-run (or --test) exactly. A flag this program does not know is ignored, so the run would have been LIVE and sent real texts. Nothing was started.`;
  }
  return null;
}
/** Was a practice flag given? Looks at the raw command line as well as the parsed flags, so one that another option swallowed as its value (--range --dry-run, --message --test) still counts. */
const practiceFlagGiven = (args, argv) => !!args.dryRun || argv.some((a) => PRACTICE_FLAGS.has(String(a)));

/** Signed in to Salesforce Lightning? A login page does not count: its address can carry "lightning.force.com" inside a startURL, so the host is matched, not a piece of text. */
const onLightning = (p) => { const u = p.url() || ''; return /^https:\/\/[^/]*lightning\.force\.com\//.test(u) && !/okta|login|saml|secur\/frontdoor/i.test(u); };
/** Showing an opportunity list view? (legacy; this copy uses a report.) */
const onOpportunityList = (p) => /\/lightning\/o\/Opportunity\/list/i.test(p.url() || '');
/** Showing a Salesforce report run page? */
const onReportUrl = (p) => /\/lightning\/r\/Report\//i.test(p.url() || '');
/** Wait until the list view shows at least one row, so the harvest that follows never runs on a half-drawn page. */
async function waitForListRows(page, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await bestRowSelector(page)).count > 0) return true; } catch (_) {}
    await sleep(1000);
  }
  return false;
}
/** Wait until the report iframe is present (and ideally has a data grid). */
async function waitForReportFrame(page, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const frame = reportFrame(page);
    if (frame) {
      try {
        const ready = await frame.evaluate(() => !!document.querySelector('table.data-grid-full-table, table[role="grid"], .data-grid'));
        if (ready) return frame;
      } catch (_) { /* frame navigating */ }
      return frame;      // iframe is there even if the grid is still painting
    }
    await sleep(1000);
  }
  return null;
}

/**
 * Open the campaign Salesforce REPORT (CONFIG.reportUrl), wait for sign-in, then wait for the
 * lightningReportApp iframe so harvestReportLeads can scroll its virtualized grid (same path as --report).
 */
async function resolveCampaignReportPage(context, initialPage, o = {}) {
  const url = CONFIG.reportUrl || CONFIG.listUrl;
  const reportId = (() => { try { return new URL(url).pathname.match(/\/Report\/([A-Za-z0-9]+)/i)?.[1] || 'report'; } catch (_) { return 'report'; } })();
  try { await initialPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
  let page = null;
  for (let first = true; !page; first = false) {
    await ask(first
      ? (o.email ? WELCOME_EMAIL : WELCOME_TEXT)
      : '\nChrome is not signed in to Salesforce yet. Finish signing in in the Chrome window, then hit Enter... ');
    const lightning = context.pages().filter(onLightning);
    const onRep = lightning.filter(onReportUrl);
    page = onRep.length ? onRep[onRep.length - 1] : (lightning.length ? lightning[lightning.length - 1] : null);
  }
  try { await page.bringToFront(); } catch (_) {}
  if (!onReportUrl(page) || !(page.url() || '').includes(reportId)) {
    commandLog('📊', 'Campaign report', `Opening ${reportId}`);
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { commandLog('⚠️', 'Campaign report', `could not open it: ${e.message}`); }
  }
  commandLog('⏳', 'Report loading', 'waiting for the report grid (virtualized rows load as we scroll)…');
  if (!(await waitForReportFrame(page))) commandLog('⚠️', 'Campaign report', 'the report iframe is not showing yet — make sure the report finished loading in Chrome');
  else commandLog('✅', 'Campaign report', 'report grid ready');
  return page;
}

/** @deprecated name — this copy opens the campaign report. Kept so older call sites still resolve. */
async function resolveListViewPage(context, initialPage, o = {}) {
  return resolveCampaignReportPage(context, initialPage, o);
}

// ============================================================================
// Row helpers
// ============================================================================

/**
 * Find the account link within a row. Tries multiple strategies:
 * 1. Direct href match for /Account/ patterns
 * 2. Any link to a lightning record
 * 3. First clickable <a> in the row
 * 4. JS evaluation fallback
 */
async function findAccountLink(row) {
  // Strategy 1: Direct account link patterns
  for (const pattern of CONFIG.accountLinkPatterns) {
    const loc = row.locator(pattern).first();
    try { if ((await loc.count()) > 0) return loc; } catch (_) {}
  }

  // Strategy 2: Any link to a lightning record
  const anyRecordLink = row.locator('a[href*="/lightning/r/"]').first();
  try { if ((await anyRecordLink.count()) > 0) return anyRecordLink; } catch (_) {}

  // Strategy 3: First clickable <a> in the row
  const firstLink = row.locator('a[href]').first();
  try { if ((await firstLink.count()) > 0) return firstLink; } catch (_) {}

  // Strategy 4: JS evaluation fallback
  try {
    const linkInfo = await row.evaluate(() => {
      const allLinks = arguments[0].querySelectorAll('a[href]');
      for (const a of allLinks) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/lightning/r/') || href.includes('/Account/') || href.includes('/Opportunity/')) {
          return { found: true, href };
        }
      }
      if (allLinks.length > 0) {
        return { found: true, href: allLinks[0].getAttribute('href') || '' };
      }
      return { found: false };
    });
    if (linkInfo && linkInfo.found) return row.locator(`a[href="${linkInfo.href}"]`).first();
  } catch (_) {}

  return null;
}

async function rowIdentifier(row) {
  const accountLink = await findAccountLink(row);
  if (accountLink) {
    try {
      const txt = ((await accountLink.innerText({ timeout: 2000 })) || '').trim();
      if (txt) return txt.replace(/Edit Account Name/gi, '').trim();
    } catch (_) {}
  }
  try {
    return ((await row.innerText({ timeout: 2000 })) || '').trim().slice(0, 120).replace(/Edit Account Name/gi, '').trim();
  } catch (_) { return null; }
}

/** Prefer the Salesforce Account ID shared with the email campaign ledger. */
async function historyContactIdentity(row, fallbackLabel) {
  const aliases = [`label:${fallbackLabel}`];
  try {
    const accountLink = await findAccountLink(row);
    if (accountLink && (await accountLink.count()) > 0) {
      const href = (await accountLink.getAttribute('href')) || '';
      const match = href.match(/\/Account\/([^/?#]+)/i);
      if (match) return { contactId: `salesforce-account:${match[1]}`, aliases };
    }
  } catch (_) {}
  return { contactId: aliases[0], aliases };
}

async function firstPresent(scope, selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    const loc = scope.locator(sel).first();
    try { if ((await loc.count()) > 0) return loc; } catch (_) {}
  }
  return null;
}

// ============================================================================
// Inspect mode
// ============================================================================
async function inspect(page, howMany = 3) {
  const rows = page.locator(CONFIG.rowSelectors[0]);
  const n = await rows.count();
  console.log(`\nFound ${n} row(s) with rowSelectors[0] = ${JSON.stringify(CONFIG.rowSelectors[0])}\n`);
  for (let i = 0; i < Math.min(howMany, n); i++) {
    const row = rows.nth(i);
    console.log(`--- Row ${i + 1} ---`);
    console.log(`  identifier: ${JSON.stringify(await rowIdentifier(row))}`);
    const accountLink = await findAccountLink(row);
    if (accountLink && (await accountLink.count()) > 0) {
      const href = await accountLink.getAttribute('href');
      console.log(`  account link: ${href}`);
    } else {
      console.log(`  no account link found`);
    }
    console.log('');
  }
}

// ============================================================================
// Scrolling
// ============================================================================
async function scrollList(page) {
  const rows = page.locator(CONFIG.rowSelectors[0]);
  const beforeCount = await rows.count();

  // Step 1: Scroll the last visible row into view
  if (beforeCount > 0) {
    const lastRow = rows.nth(beforeCount - 1);
    try { await lastRow.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch (_) {}
  }

  // Step 2: Incremental scroll — Salesforce's virtual scroller ignores instant
  // jumps to the bottom. It needs small steps with pauses so the lazy loader
  // has time to fetch new rows. Search both the main DOM and shadow DOM.
  try {
    await page.evaluate(async (scrollPx) => {
      function findScrollContainer() {
        // Check shadow DOM first — Salesforce wraps datatable in LWC shadow roots
        function deepFind(root) {
          const candidates = [
            'lightning-datatable .slds-scrollable',
            '.slds-scrollable',
            'lightning-datatable',
            '[role="grid"]',
            '.slds-table_container',
            '.forceVirtualListview',
            '.forceVirtualTreeGrid',
          ];
          for (const sel of candidates) {
            const els = root.querySelectorAll
              ? root.querySelectorAll(sel)
              : [];
            for (const el of els) {
              if (el.scrollHeight > el.clientHeight && el.clientHeight > 0) {
                return el;
              }
            }
            // Recurse into shadow roots
            const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of all) {
              if (el.shadowRoot) {
                const found = deepFind(el.shadowRoot);
                if (found) return found;
              }
            }
          }
          return null;
        }
        return deepFind(document.body);
      }

      const container = findScrollContainer();
      if (!container) return;

      // Incremental scroll: move down in steps, pausing for lazy load
      const step = scrollPx;
      const maxSteps = 10;
      for (let i = 0; i < maxSteps; i++) {
        const before = container.scrollTop;
        container.scrollTop += step;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        if (container.scrollTop === before) break; // can't scroll further
      }
    }, 600);
  } catch (_) {}

  // Step 3: Mouse wheel as fallback (works for some Salesforce layouts)
  try { await page.mouse.wheel(0, 600); } catch (_) {}

  // Step 4: Keyboard scroll
  await page.keyboard.press('PageDown');
  await sleep(500);

  // Step 5: Wait for Salesforce spinner to clear, then give rows time to render
  try {
    await page.waitForSelector('.slds-spinner', { state: 'hidden', timeout: 5000 });
  } catch (_) {}
  await sleep(2500);

  const afterCount = await rows.count();
  if (afterCount > beforeCount) {
    commandLog('🗺️', 'Grid expanded', `${beforeCount} → ${afterCount} leads (+${afterCount - beforeCount})`);
  }

  return afterCount > beforeCount;
}

/**
 * A finite range is complete once every requested row has been attempted.
 * Skipped rows still count as attempted; otherwise one skip makes the desired
 * successful-send count unreachable and the bot keeps loading rows forever.
 */
function isRequestedRangeComplete(seen, done, start, end) {
  if (end == null || seen.length < end) return false;
  for (let pos = start; pos <= end; pos++) {
    const ident = seen[pos - 1];
    if (!ident || !done.has(ident)) return false;
  }
  return true;
}

// ============================================================================
// REPORT MODE (--report)
//
// A Salesforce *report* run page (e.g. the "T14 Shark List All" Opportunities
// report) renders its table inside a same-origin iframe (lightningReportApp.app)
// as a virtualized SLDS data-grid. That means:
//   - the rows are NOT in the main page DOM (so the list-view selectors miss them),
//   - each detail row carries two record links — the Account column (id prefix 001)
//     and the Opportunity column (prefix 006) — plus group-header rows link to a
//     User (005) and "Subtotal" rows have no link, and
//   - only ~a windowful of rows exist in the DOM at once; scrolling recycles them.
//
// So report mode harvests every detail row's Account link up front by scrolling
// the grid once, then navigates straight to each account's record page (reusing
// the exact same Texts-tab compose/send flow as list mode).
// ============================================================================
const REPORT_CONFIG = {
  frameUrlSubstring: 'lightningReportApp',
  // Account record links inside the report. Account ids start with 001; the other
  // linked column (Opportunity) starts with 006 and group headers with 005, so this
  // targets the Account Name column unambiguously and skips group/subtotal rows.
  accountAnchorSelector: 'a[href*="/lightning/r/001"]',
};

/** The Frame object for the report viewer iframe (or null if not present). */
function reportFrame(page) {
  return page.frames().find((f) => (f.url() || '').includes(REPORT_CONFIG.frameUrlSubstring)) || null;
}

/** Finds the scrollable data-grid container inside the report frame and scrolls it. */
async function reportScrollStep(frame, mode) {
  return frame.evaluate((m) => {
    const tbl = document.querySelector('table.data-grid-full-table');
    let sc = tbl;
    while (sc) {
      const cs = getComputedStyle(sc);
      if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break;
      sc = sc.parentElement;
    }
    if (!sc) return { hasScroller: false, atBottom: true, scrollTop: 0 };
    if (m === 'top') sc.scrollTop = 0;
    else if (m === 'down') { sc.scrollTop += Math.max(300, Math.round(sc.clientHeight * 0.8)); sc.dispatchEvent(new Event('scroll', { bubbles: true })); }
    return {
      hasScroller: true,
      scrollTop: Math.round(sc.scrollTop),
      atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2,
    };
  }, mode);
}

/**
 * Parse the report's "Last Outgoing SMS DateTime" cell (e.g. "10/6/2026 4:56 PM")
 * into a Date, or null if blank/unparseable. Handles M/D/YYYY with optional time.
 */
function parseReportDateTime(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  if (m) {
    let H = m[4] != null ? parseInt(m[4], 10) : 0;
    const MIN = m[5] != null ? parseInt(m[5], 10) : 0;
    const S = m[6] != null ? parseInt(m[6], 10) : 0;
    if (m[7]) { const pm = /p/i.test(m[7]); if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
    const dt = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10), H, MIN, S);
    return isNaN(dt) ? null : dt;
  }
  const t = Date.parse(str);
  return isNaN(t) ? null : new Date(t);
}

/**
 * Scroll the whole virtualized report grid once, collecting an ordered, de-duped
 * list of detail-row leads: { name, accountId, url, lastOutgoingSms }. Order follows
 * the report (top-to-bottom), which is what the operator sees and how ranges number.
 * lastOutgoingSms is the report's "Last Outgoing SMS DateTime" cell (SMS sent to that
 * opp by ANYONE in the business) — used to skip anyone texted in the last 48h.
 */
async function harvestReportLeadsRaw(page) {
  const frame = reportFrame(page);
  if (!frame) throw new Error('report iframe not found — open a Salesforce REPORT and let its rows render');

  // One read of the rows that are on screen. A Lightning report renders lazily: a row's account link can be there a moment BEFORE its other cells,
  // so a row read once can come back with most of its columns empty (that is how only a third of the rows of a scan used to get their Timezone).
  // So: every row is read again while it is still thin, and each later sighting adds the cells an earlier one missed (see merge below).
  const readRows = () => frame.evaluate(() => {
    const tbl = document.querySelector('table.data-grid-full-table');
    if (!tbl) return { headerCount: 0, rows: [] };
    const rows = Array.from(tbl.querySelectorAll('tr'));
    // Header cells carry hidden text after the label ("Timezone Opportunity.Timezone__c Column Actions"): keep just the label.
    const tidy = (h) => { const parts = h.replace(/\s*Sorted by .*$/i, '').replace(/\s*Column Actions\s*$/i, '').trim().split(' '); if (parts.length > 1 && /^[A-Za-z0-9]+(?:[._][A-Za-z0-9_]+)+$/.test(parts[parts.length - 1])) parts.pop(); return parts.join(' ').trim(); };
    // Find the "Last Outgoing SMS DateTime" column index from the header row, so we
    // read the right cell regardless of how many columns the report has.
    let smsIdx = -1;
    const headerRow = rows.find((tr) => /Last Outgoing SMS DateTime/i.test(tr.innerText || ''));
    if (headerRow) smsIdx = Array.from(headerRow.querySelectorAll('td,th')).findIndex((c) => /Last Outgoing SMS DateTime/i.test(c.innerText || ''));
    // Column headers, so a snapshot can keep the whole report row (owner, stage, dates, …), not just the account.
    const hdrRow = tbl.querySelector('thead tr') || headerRow;
    const headers = hdrRow ? Array.from(hdrRow.querySelectorAll('th,td')).map((c) => tidy((c.innerText || '').replace(/\s+/g, ' ').trim())) : [];
    return { headerCount: headers.filter(Boolean).length, rows: rows.map((tr) => {
      const a = tr.querySelector('a[href*="/lightning/r/001"]');
      const cells = Array.from(tr.querySelectorAll('td,th'));
      const cols = {};
      // A grouped report (here: by ES) can put a cell in a row that the other rows lack, so counting cells from the left misreads some rows. Anchor on the account
      // link instead: the cell holding it IS the "Account Name" column, so every other cell is offset by the same amount.
      const accHdr = headers.findIndex((h) => /^account( name)?$/i.test(h));
      const linkCell = a ? cells.findIndex((c) => c.contains(a)) : -1;
      const off = (accHdr >= 0 && linkCell >= 0) ? accHdr - linkCell : 0;   // header index = cell index + off
      if (a) cells.forEach((c, i) => { const h = headers[i + off]; const v = (c.innerText || '').replace(/\s+/g, ' ').trim(); if (h && v && v.length <= 140 && v !== (a.innerText || '').trim()) cols[h] = v; });
      return {
        href: a ? a.getAttribute('href') : null,
        name: a ? (a.innerText || '').trim() : null,
        sms: smsIdx >= 0 && cells[smsIdx - off] ? (cells[smsIdx - off].innerText || '').replace(/\s+/g, ' ').trim() : null,
        cols,
      };
    }) };
  });

  const ordered = new Map(); // href -> { name, sms, cols }, insertion order = report order; every sighting of a row is merged in
  let headerCount = 0;
  const thin = (cols) => Object.keys(cols || {}).length < Math.max(3, Math.ceil((headerCount - 1) * 0.6));
  const merge = (row) => {
    const cur = ordered.get(row.href);
    if (!cur) { ordered.set(row.href, { name: row.name, sms: row.sms || null, cols: { ...(row.cols || {}) } }); return true; }
    for (const [k, v] of Object.entries(row.cols || {})) if (!(k in cur.cols)) cur.cols[k] = v;   // a later sighting fills in what had not rendered yet
    if (!cur.sms && row.sms) cur.sms = row.sms;
    if (!cur.name && row.name) cur.name = row.name;
    return false;
  };
  // Read what is on screen; while some row is still thin, give the page a moment and read again.
  let waitBudgetMs = 90000;          // total time the whole scan may spend waiting for cells (a row that never fills in must not stall it)
  const readSettled = async () => {
    let fresh = 0;
    for (let k = 0; k < 5; k++) {
      const res = await readRows(); headerCount = Math.max(headerCount, res.headerCount);
      for (const r of res.rows) if (r.href && merge(r)) fresh++;
      if (!res.rows.some((r) => r.href && thin(r.cols)) || waitBudgetMs <= 0) break;
      await sleep(350); waitBudgetMs -= 350;
    }
    return fresh;
  };
  // One pass from the top of the report to the bottom.
  const sweep = async () => {
    await reportScrollStep(frame, 'top');
    await sleep(800);
    let stable = 0;
    for (let round = 0; round < 800; round++) {
      const fresh = await readSettled();
      const state = await reportScrollStep(frame, 'down');
      await sleep(450);
      if (!state.hasScroller) break;           // not virtualized / nothing to scroll
      if (state.atBottom && !fresh) { stable++; if (stable >= 2) break; }
      else stable = 0;
    }
  };
  await sweep();
  // A second pass over anything that is still missing most of its cells.
  if ([...ordered.values()].some((x) => thin(x.cols))) await sweep();

  const origin = new URL(page.url()).origin;
  const leads = [];
  for (const [href, info] of ordered) {
    const m = href.match(/(001[A-Za-z0-9]{12,15})/);
    const accountId = m ? m[1] : null;
    leads.push({
      name: info.name || '(unnamed account)',
      accountId,
      url: accountId ? `${origin}/lightning/r/Account/${accountId}/view` : null,
      lastOutgoingSms: info.sms || null, // report's Last Outgoing SMS DateTime (any sender)
      cols: info.cols || {},             // every other column of the report row (header → value)
    });
  }
  leads.thinRows = leads.filter((l) => thin(l.cols)).length;   // rows that still came back with most cells empty (the report was probably still loading)
  return leads;
}

/** --report --inspect : harvest and print the first rows so selectors can be verified. */
async function inspectReport(page, howMany = 8) {
  if (!reportFrame(page)) {
    console.log('\n⚠️  No Salesforce report iframe found. Open a report (so rows are visible) and retry.\n');
    return;
  }
  const leads = await harvestReportLeads(page);
  console.log(`\nDetail rows harvested from report (Account links): ${leads.length}\n`);
  if (leads.length === 0) {
    console.log('⚠️  Found the report frame but no Account links. If rows are visible, the');
    console.log('    anchor selector may need adjusting (REPORT_CONFIG.accountAnchorSelector).\n');
    return;
  }
  const withSms = leads.filter((l) => l.lastOutgoingSms).length;
  const recent = leads.filter((l) => { const d = parseReportDateTime(l.lastOutgoingSms); return d && (Date.now() - d.getTime()) < 48 * 3600000; }).length;
  console.log(`  Last Outgoing SMS column read on ${withSms}/${leads.length} rows • ${recent} texted in the last 48h (would be skipped)\n`);
  leads.slice(0, howMany).forEach((l, i) => {
    const d = parseReportDateTime(l.lastOutgoingSms);
    const flag = d && (Date.now() - d.getTime()) < 48 * 3600000 ? '  ⏭️ <48h, SKIP' : '';
    console.log(`  ${String(i + 1).padStart(3)}. ${l.name}`);
    console.log(`       account id : ${l.accountId}`);
    console.log(`       record url : ${l.url}`);
    console.log(`       last SMS   : ${l.lastOutgoingSms || '(none)'}${flag}`);
  });
  if (leads.length > howMany) console.log(`  ... and ${leads.length - howMany} more`);
  console.log('');
  printHoursPlan(partitionByHours(leads, { unknownZone: 'hold' }));     // who a --report run would text right now (their own hours)
  console.log('');
}

/** Queue mode texts by navigating to each account URL, so it only needs a logged-in
 *  Salesforce tab — no particular report/list open. Just confirm login and return it. */
async function resolveAuthedPage(context, initialPage) {
  await ask(
    '\nIn the Chrome window: make sure you are logged into Salesforce,\n' +
    'then press Enter here to continue... '
  );
  const matches = context.pages().filter((p) => (p.url() || '').includes(CONFIG.sfUrlSubstring));
  const page = matches.length ? matches[matches.length - 1] : initialPage;
  try { await page.bringToFront(); } catch (_) {}
  return page;
}

/**
 * Block until Salesforce Lightning is actually loaded and logged in, then return that
 * page. Needed for unattended-style runs (--reengage) that don't prompt: on a fresh or
 * expired profile the start URL bounces to Okta, and without this every account would
 * fail ("skip a ton") while the login page is still showing. On a terminal it first asks you to press Enter, then polls up
 * to `timeoutMs`; throws if login never completes so nothing is attempted.
 */
async function waitForSalesforceLogin(context, initialPage, timeoutMs = 10 * 60 * 1000) {
  // Logged-in Lightning pages look like  …lightning.force.com/lightning/page/home  but Salesforce also
  // rests on the bare  …/lightning  (title "Lightning Experience") and on  /one/one.app  — accept those too.
  const isHome = (u) => /^https:\/\/[^/]*lightning\.force\.com\/(lightning|one\/one\.app)(\/|$|[?#])/.test(u || '') && !/okta|login|saml|secur\/frontdoor/i.test(u || '');
  const find = () => context.pages().find((p) => isHome(p.url()));
  // On a terminal, make the operator confirm (same as the other modes). A scheduled /
  // piped run has no one to press Enter, so it falls through to auto-detection only.
  if (process.stdin.isTTY) {
    try { await (context.pages()[0] || initialPage).bringToFront(); } catch (_) {}
    await ask('\nIn the Chrome window: log into Salesforce (Okta) if needed,\nthen press Enter here to continue... ');
  }
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const p = find();
    if (p) {
      // Let the Lightning shell finish rendering before we start driving it.
      try { await p.waitForLoadState('load', { timeout: 15000 }); } catch (_) {}
      await sleep(4000);
      if (find() === p) {
        try { await p.bringToFront(); } catch (_) {}
        if (announced) commandLog('✅', 'Salesforce login', 'Detected — starting');
        return p;
      }
    }
    if (!announced) {
      commandLog('🔐', 'Waiting for login', 'Log into Salesforce (Okta) in the Chrome window — the run starts automatically once it loads');
      try { await (context.pages()[0] || initialPage).bringToFront(); } catch (_) {}
      announced = true;
    }
    await sleep(2000);
  }
  throw new Error('timed out waiting for Salesforce login — nothing was sent');
}

/** Let the user open the report tab, then return that page. */
async function resolveReportPage(context, initialPage) {
  await ask(
    '\nIn the Chrome window: log in (if needed) and open the Salesforce REPORT you want\n' +
    '(e.g. "T14 Shark List All", or any other Shark list) so the detail rows are visible,\n' +
    'then press Enter here to continue... '
  );
  const matches = context.pages().filter((p) => (p.url() || '').includes(CONFIG.sfUrlSubstring));
  const page = matches.length ? matches[matches.length - 1] : initialPage;
  try { await page.bringToFront(); } catch (_) {}
  return page;
}

/**
 * Best-effort: pull the Pro's email address off the currently-open account page
 * (deep shadow-DOM walk for an element whose text is a bare email). Returns the
 * email string or null. Used to enrich the durable texted-log.
 */
async function scrapeAccountEmail(page) {
  return page.evaluate(() => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let found = null;
    (function walk(n) {
      if (found) return;
      n.querySelectorAll('a, lightning-formatted-email, span').forEach((e) => {
        if (found) return;
        const t = (e.innerText || e.textContent || '').trim();
        if (re.test(t)) found = t;
      });
      n.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document);
    return found;
  }).catch(() => null);
}

// ============================================================================
// Text sending
// ============================================================================
/**
 * Type a message into the focused text box. A line break is typed as Shift+Enter: in a chat-style box a plain Enter can SEND, which would
 * send a half-written text and then the rest as a second one. (A message without line breaks is typed exactly as before.)
 */
async function typeMessage(page, message) {
  sender.assertSendable(message);      // a text that still says [SET sender.json: …] is never typed (the run stops, nothing is sent)
  const lines = String(message).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    if (lines[i]) await page.keyboard.type(lines[i], { delay: 10 });
  }
}

/** Is this run a DRY RUN (--dry-run / --test)? main() switches clickGuard's send lock on for it: from then on nothing can click Send, and textAccount only types, checks and takes the text out again. */
const textDryRun = () => require('./clickGuard').isSendLocked();

/**
 * A DRY RUN types the text and checks it landed, but the Send button is only found, never clicked (clickGuard.lockSend). The typed text must not stay in a real prospect's message box for somebody
 * to send by accident, so it is taken out again: the cursor is still in the box from the typing, so select all, delete, then look. → true when the box is empty, false when text is still in it,
 * null when the box is in a frame that cannot be read from here (select-all + delete was sent, but nobody could check). Clicks nothing, sends nothing.
 */
async function discardDraft(page, log = commandLog) {
  const guard = require('./clickGuard');
  try {
    const f = await guard.focusState(page);
    if (f.hadBox && !f.ok) await guard.focusState(page, { force: true });      // the cursor is not in the box (it was a moment ago): put it back through the page, no click
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await sleep(300);
  } catch (_) {}
  const left = await guard.boxText(page);
  if (!left.known) { log('🧪', 'Draft not checked', 'select-all + delete was sent to the message box, but it is in a frame this program cannot read, so nobody could check that it is empty: look at the box'); return null; }
  if (left.head) { log('⚠️', 'Draft left in the box', `${left.len} character(s) of the dry-run text are still in the message box. It was NOT sent. If the run stops here, clear the box by hand.`); return false; }
  log('🧪', 'Draft cleared', 'the dry-run text was taken out of the message box again');
  return true;
}

/** A dry run that FAILS after typing (Send covered, disabled ...) takes its text out of the box too. Only when the box can be read and holds text: nothing is ever pressed blindly. Never throws. */
async function discardStrayDraft(page, opts = {}) {
  if (!(opts.dryRun || textDryRun())) return;
  try { const t = await require('./clickGuard').boxText(page); if (t.known && t.head) await discardDraft(page); } catch (_) {}
}

/**
 * Where the compose controls are on screen: the landmarks "shortlink", "template", "media", "emoticon", "send" and "compose" (the message box), found by a deep shadow-DOM search of the page and
 * then of its iframes (the SMS panel may live in a cross-origin one). The compose step types from them; ensureTextsPanel waits for them. → [{ landmark, text, x, y, w, h }]
 */
async function findComposeLandmarks(page) {
  const landmarkSearch = await page.evaluate(() => {
    function deepSearch(root) {
      const results = [];
      // Is this element inside the utility bar / macros / search area? The walk goes UP through shadow roots too (it used to stop at the first one, so a utility panel built from
      // web components was never excluded), and remembers the answer per element so the whole page is not re-walked for every element.
      const exclCache = new WeakMap();
      const upOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      const inExcludedArea = (el) => {
        const trail = [];
        let p = upOf(el), res = false;
        for (let i = 0; p && i < 80; i++) {
          if (exclCache.has(p)) { res = exclCache.get(p); break; }
          trail.push(p);
          const pcls = (String(p.className || '')).toLowerCase();
          const pdataId = String(p.getAttribute && p.getAttribute('data-component-id') || '').toLowerCase();
          if (pcls.includes('slds-utility-bar') || pcls.includes('utilitybar')
            || pcls.includes('macro') || pdataId.includes('macro')
            || pcls.includes('force-pop-out') || pcls.includes('oneutilitybaritem')
            || pcls.includes('forcesearchinput') || pcls.includes('uiinputtextforautocomplete')) {
            res = true; break;
          }
          p = upOf(p);
        }
        trail.forEach((q) => exclCache.set(q, res));
        return res;
      };
      function walk(node) {
        const els = node.querySelectorAll('*');
        els.forEach(el => {
          // Check for landmark text (could be in title, aria-label, alt, or innerText)
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
          const allText = text + ' ' + title + ' ' + ariaLabel + ' ' + alt + ' ' + placeholder;

          // Skip utility bar / macros / search areas (className is read with String(): SVG elements return an SVGAnimatedString, not a string)
          if (inExcludedArea(el)) return;

          if (el.offsetParent !== null || el.getClientRects().length > 0) {
            const rect = el.getBoundingClientRect();
            // Match landmark elements
            if (allText.includes('add') && allText.includes('short link') && text.length < 50) {
              results.push({ landmark: 'shortlink', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            if (allText.includes('template') && text.length < 30 && text.length > 0) {
              results.push({ landmark: 'template', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            if (allText.includes('insert') && allText.includes('media') && text.length < 50) {
              results.push({ landmark: 'media', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            if (allText.includes('insert') && allText.includes('emoticon') && text.length < 50) {
              results.push({ landmark: 'emoticon', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            if (allText.includes('send') && text === 'send') {
              results.push({ landmark: 'send', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            // Search for the compose box by its placeholder text
            if (allText.includes('type a message') || allText.includes('message or select')) {
              results.push({ landmark: 'compose', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
            // Also search for any textarea with a message-related placeholder
            if (el.tagName === 'TEXTAREA' && placeholder.includes('message')) {
              results.push({ landmark: 'compose', text: placeholder.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            }
          }
        });
        const allEls = node.querySelectorAll('*');
        allEls.forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
      }
      walk(root);
      return results;
    }
    return deepSearch(document.body);
  });

  // Log landmark summary (one line only) — after combining all landmarks below

  // Also search inside iframes
  const frames = page.frames();
  let iframeLandmarks = [];
  let iframeOffset = { x: 0, y: 0 };
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameResults = await frame.evaluate(() => {
        const results = [];
        document.querySelectorAll('*').forEach(el => {
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
          const allText = text + ' ' + title + ' ' + ariaLabel + ' ' + alt + ' ' + placeholder;
          if (el.offsetParent !== null || el.getClientRects().length > 0) {
            const rect = el.getBoundingClientRect();
            if (allText.includes('add') && allText.includes('short link') && text.length < 50)
              results.push({ landmark: 'shortlink', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (allText.includes('template') && text.length < 30 && text.length > 0)
              results.push({ landmark: 'template', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (allText.includes('insert') && allText.includes('media') && text.length < 50)
              results.push({ landmark: 'media', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (allText.includes('insert') && allText.includes('emoticon') && text.length < 50)
              results.push({ landmark: 'emoticon', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (allText.includes('send') && text === 'send')
              results.push({ landmark: 'send', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (allText.includes('type a message') || allText.includes('message or select'))
              results.push({ landmark: 'compose', text: text.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
            if (el.tagName === 'TEXTAREA' && placeholder.includes('message'))
              results.push({ landmark: 'compose', text: placeholder.substring(0, 40), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
          }
        });
        return results;
      });
      if (frameResults.length > 0) {
        // Get THIS frame's own <iframe> position on the page (the first <iframe> on the page is often another one, such as the softphone panel in the utility bar: using it put the
        // landmarks of a different frame at the wrong place). With no way to tell which element is this frame's, a page with a single iframe is unambiguous; otherwise the frame is skipped.
        let iframeBox = null;
        try { const fe = await frame.frameElement(); iframeBox = await fe.boundingBox(); } catch (_) {}
        if (!iframeBox) { try { if ((await page.locator('iframe').count()) === 1) iframeBox = await page.locator('iframe').first().boundingBox(); } catch (_) {} }
        if (iframeBox) {
          iframeOffset = { x: iframeBox.x, y: iframeBox.y };
          // Adjust coordinates to page-level
          frameResults.forEach(r => {
            r.x = Math.round(iframeBox.x + r.x);
            r.y = Math.round(iframeBox.y + r.y);
            r.inFrame = true;
          });
          iframeLandmarks = frameResults;
          break;
        }
      }
    } catch (_) {}
  }

  return [...landmarkSearch, ...iframeLandmarks];
}

/**
 * Bring the compose box into view by scrolling THE BOX into view, not every scrollable area to its bottom (that carried the page through the whole Activity feed, ~8 s an account). It looks for
 * the message box the compose step types into (a text box whose placeholder reads "Type a message or select a template"), outside the utility bar / macros / pop-outs.
 * → { ok, top, bottom, vh }: ok = the box is fully on screen now, clear of the utility bar along the bottom. No box, or not on screen → ok false (the old scroll to the bottom then runs).
 */
async function revealComposer(page) {
  return page.evaluate(async () => {
    const found = [];
    const walk = (node) => {
      node.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').forEach((el) => {
        const ph = String(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
        if (!(ph.includes('type a message') || ph.includes('message or select'))) return;
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return;
        for (let p = el.parentElement || (el.getRootNode && el.getRootNode().host) || null, i = 0; p && i < 80; p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null, i++) {      // up through shadow roots too
          const c = String(p.className || '').toLowerCase(), d = String((p.getAttribute && p.getAttribute('data-component-id')) || '').toLowerCase();
          if (c.includes('slds-utility-bar') || c.includes('utilitybar') || c.includes('macro') || d.includes('macro') || c.includes('force-pop-out') || c.includes('oneutilitybaritem') || c.includes('forcesearchinput') || c.includes('uiinputtextforautocomplete')) return;
        }
        found.push(el);
      });
      node.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    };
    walk(document);
    const box = found.find((e) => e.tagName === 'TEXTAREA') || found[0];
    if (!box) return { ok: false, why: 'no compose box in the page' };
    box.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 200));
    const r = box.getBoundingClientRect(), vh = window.innerHeight;
    return { ok: r.height > 0 && r.top >= 0 && r.bottom <= vh - 60, top: Math.round(r.top), bottom: Math.round(r.bottom), vh };
  }).catch(() => ({ ok: false, why: 'could not look' }));
}

/**
 * Right after the click on the Texts tab: (1) the tab has to READ as selected. A click that missed leaves the Activity tab on screen, and the scroll after it then runs through that whole feed;
 * if the tab is not selected and no compose box is on screen either, open it again the careful way (threadProbe.openTextsTab). (2) Wait for the compose box and scroll IT into view.
 * → { selected, reopened, revealed }. revealed false = the old scroll-everything-to-the-bottom still has to run. Never throws. `deps` is for the tests.
 */
async function openTextsFast(page, { selected = null, reopen = null, find = findComposeLandmarks, reveal = revealComposer, pause = sleep } = {}) {
  const probe = () => require('./threadProbe');
  const isSel = selected || ((pg) => probe().textsTabSelected(pg));
  const open = reopen || ((pg) => probe().openTextsTab(pg));
  const safe = async (fn, dflt) => { try { return await fn(); } catch (_) { return dflt; } };
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) { await pause(i ? 300 : 500); ok = !!(await safe(() => isSel(page), false)); }
  let reopened = false;
  if (!ok && !hasComposer(await safe(() => find(page), []))) {
    reopened = true; commandLog('🔁', 'Texts tab', 'the click did not select it — opening it again');
    const t = await safe(() => open(page), null); ok = !!(t && t.selected);
  }
  for (let i = 0; i < 10; i++) {
    if (hasComposer(await safe(() => find(page), []))) { const r = await safe(() => reveal(page), null); return { selected: ok, reopened, revealed: !!(r && r.ok) }; }
    await pause(500);
  }
  return { selected: ok, reopened, revealed: false };
}

/** What textAccount throws BEFORE it has typed anything, so the account can safely be tried again. (Anything later, like "Send button not found", is not retried.) */
const NOTHING_TYPED_YET = /^(Compose box not found|Texts tab not found|Could not click Texts tab|did not navigate to account page|page\.goto: Timeout)/;

/** The compose step needs the "template" or the "compose" (message box) landmark. */
const hasComposer = (landmarks) => landmarks.some((l) => l.landmark === 'template' || l.landmark === 'compose');

/**
 * After the Texts tab is clicked the SMS panel has to show its compose box. Sometimes it does not (2 accounts in 3 on 2026-10-29: the click missed, or the panel was slow or failed to load).
 * Wait for the same landmarks the compose step looks for; if they do not show, open the Texts tab again (threadProbe.openTextsTab: real tabs first, clicked until the tab reads as selected)
 * and wait once more; if they still do not show, save what the page looks like (compose-failures/) so the failure explains itself. Advisory: it never throws, the compose step and its
 * fallback still get their turn. → { ok, reopened }. `deps` is for the tests.
 */
async function ensureTextsPanel(page, { find = findComposeLandmarks, reopen = null, snapshot = null, pause = sleep } = {}) {
  const look = async () => { try { return hasComposer(await find(page)); } catch (_) { return false; } };
  const wait = async () => { for (const ms of [0, 2500, 2500, 3000]) { await pause(ms); if (await look()) return true; } return false; };
  if (await wait()) return { ok: true, reopened: false };
  commandLog('🔁', 'Texts panel', 'no compose box yet — opening the Texts tab again');
  try { await (reopen || require('./threadProbe').openTextsTab)(page); } catch (_) {}
  if (await wait()) return { ok: true, reopened: true };
  if (snapshot) { try { await snapshot('no compose box after opening the Texts tab twice'); } catch (_) {} }
  return { ok: false, reopened: true };
}

/**
 * The thread guard (--followup): read the conversation on screen BEFORE typing. An opt-out anywhere in the thread, a pro's message nobody has answered, or a teammate's text in the last 48h holds the send
 * (a reply someone already answered does not: threadReader.decideNormal); so does a thread that cannot be read.
 * An EMPTY thread looks exactly like one that did not load, and an account we have only ever EMAILED has an empty one: it used to hold every such account ("could not read any
 * messages in the thread") and the composer was never opened. So an empty read is read again a few seconds later, and an empty result is believed only when the caller says
 * this account should have no thread yet (`opts.threadMayBeEmpty`, see runFollowup); otherwise it still holds.
 * → null (clear to type) | { status: 'held', reason, kind, read } (a reply or a teammate text is also saved for `email --holds`). `deps` is for the tests.
 */
async function runThreadGuard(page, accountName, opts, { pause = sleep, read = threadReader.readThread } = {}) {
  await pause(800);
  let th = await read(page);
  if (!th.messages.length) { await pause(3000); th = await read(page); }      // the list may simply not have rendered yet
  const verdict = threadReader.decide(th.messages, { mode: opts.threadGuard, emptyOk: !th.messages.length && !!opts.threadMayBeEmpty });
  const saved = threadReader.record({ accountId: opts.accountId, accountName, accountUrl: opts.accountUrl, verdict, mode: opts.threadGuard, messages: th.messages, note: th.messages.length ? null : th.error });
  commandLog(verdict.hold ? '🧵' : '✅', 'Thread read', `${th.messages.length} message(s) • ${verdict.hold ? 'HOLD — ' : ''}${verdict.reason}${th.messages.length || !th.error ? '' : ` (${th.error})`}`);
  if (!verdict.hold) return null;
  try { holdInbox.add({ accountId: opts.accountId, accountName, accountUrl: opts.accountUrl, verdict, messages: th.messages }); } catch (_) {}      // saved + notified: email --holds drafts the reply
  return { status: 'held', reason: verdict.reason, kind: verdict.kind, read: saved };
}

/** How long a page that enrollCheck.js loaded on an account still counts as freshly loaded for the text that follows it. */
const OPENED_FRESH_MS = 60000;

/**
 * Is `page` already open on this account because the caller's own check loaded it a moment ago? (enrollCheck.js reads Customer Status off a fresh load of the account right before each board text,
 * and the text then loaded the very same account again: every text opened its account twice.) `opened` = { page, url, at } from that check; the text then uses the page as it is.
 * Only the first try uses it: a retry after a failure is a fresh load on purpose. Anything that does not match exactly (another page object, another account, an old load, an address that cannot be read) is false = load it as always.
 */
function accountAlreadyOpen(page, accountUrl, opened, now = Date.now()) {
  if (!opened || opened.page !== page || !Number.isFinite(opened.at) || now < opened.at || now - opened.at > OPENED_FRESH_MS) return false;
  const idOf = (u) => (String(u || '').match(/\/lightning\/r\/Account\/([A-Za-z0-9]{15,18})/) || [])[1] || null;
  let here; try { here = page.url(); } catch (_) { return false; }
  const a = idOf(here), b = idOf(accountUrl);
  return !!a && !!b && a.slice(0, 15).toLowerCase() === b.slice(0, 15).toLowerCase();      // (the 15- and the 18-character spelling of one id are the same account)
}

/**
 * Text ONE account: open it, open its Texts tab, type the message into the message box, check it landed, click Send. → { status: 'sent' } (or { status: 'held', ... } from the thread guard).
 * A DRY RUN (clickGuard.lockSend, which --dry-run / --test switch on; or opts.dryRun) does all of that EXCEPT the click: Send is found, scrolled clear and checked, never clicked; the typed text is
 * taken out of the box again; → { status: 'dry-run' }. A caller records nothing for that status (no ledger entry, no texted log), because nothing was sent.
 */
async function textAccount(page, accountName, accountLink, message, rowReadySelector = CONFIG.rowSelectors[0], opts = {}) {
  // opts.opened: the board's enrollment check has just loaded this very account on this page, so it is used as it is (see accountAlreadyOpen)
  const reuse = !!opts.accountUrl && accountAlreadyOpen(page, opts.accountUrl, opts.opened);
  let dry = false;      // true once clickSend has answered "dry run": nothing was clicked, so nothing was sent
  commandLog('🧭', 'Account route', reuse ? `${accountName} is already open (the check just loaded it) — not loading it a second time` : `Navigating to ${accountName}`);

  // Store the originating view URL so we can navigate back to it
  const listViewUrl = page.url();

  // Back to the opportunities list view (list mode; report mode goes straight to the next account). Also what a text that is NOT sent (a current customer) does before it returns.
  const returnToListView = async () => {
    commandLog('↩️', 'Return vector', 'Navigating back to lead grid');
    let returned = false;

    // Strategy 1: Navigate directly to the stored list view URL (most reliable)
    try {
      await page.goto(listViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      try { await page.waitForSelector(rowReadySelector, { timeout: 10000 }); } catch (_) {}
      returned = true;
    } catch (e) {
      commandLog('⚠️', 'Route fallback', 'Direct grid return failed; trying alternate route');
    }

    // Strategy 2: Click the "Opportunities" nav link in the app header
    if (!returned) {
      try {
      const oppNavLink = page.locator('a:has-text("Opportunities")').first();
        if ((await oppNavLink.count()) > 0) {
          await oppNavLink.click();
          await sleep(3000);
          try { await page.waitForSelector(rowReadySelector, { timeout: 10000 }); } catch (_) {}
          returned = true;
        }
      } catch (_) {}
    }

    // Strategy 3: Browser goBack
    if (!returned) {
      try {
        await page.goBack();
        await sleep(3000);
        try { await page.waitForSelector(rowReadySelector, { timeout: 10000 }); } catch (_) {}
        returned = true;
      } catch (_) {}
    }

  };

  // Open the account record. Report mode passes opts.accountUrl and we navigate
  // there directly (the report's row link lives inside an iframe, so a direct
  // goto is more reliable than a click). List-view mode clicks the row's link.
  if (reuse) {
    // nothing to load: the check did, and waited the same accountLoadMs for it
  } else if (opts.accountUrl) {
    await page.goto(opts.accountUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } else {
    await accountLink.click();
  }
  if (!reuse) await sleep(CONFIG.accountLoadMs);

  // Verify we are on the account page
  const currentUrl = page.url();
  if (!currentUrl.includes('/lightning/r/Account/')) {
    throw new Error('did not navigate to account page');
  }
  commandLog('🎯', 'Account locked', 'Record page online');

  // CURRENT CUSTOMERS, the rule the email run applies on every email (emailAccount.js): Customer Status (beta) = "Enrolled: …" (Current Customer, Cancel Requested, Under Review…) is a current customer and is
  // NOT texted, unless the account is only on the free Invoicing and Payments plan. Read on the page that is already open (no second load); a customer found is saved on the held list, so every other mode
  // leaves it alone too. Not made when the caller has just looked (opts.skipCustomerCheck: the board's or a follow-up check handed this page over, or the board's no-look stage).
  if (!opts.skipCustomerCheck) {
    const acctUrl = page.url();
    const acctId = (acctUrl.match(/\/Account\/([A-Za-z0-9]{15,18})/) || [])[1] || opts.accountId || null;
    let g;
    try { g = await customerGate(page, { assumeOpen: true })({ accountId: acctId, name: accountName, url: acctUrl }); }
    catch (e) { g = { ok: false, reason: `the Customer Status check failed: ${e.message} (this text is skipped for now)` }; }
    if (!g.ok) {
      commandLog(g.customer ? '🤝' : '🛑', g.customer ? 'Current customer' : 'Not texting', `${accountName} — ${g.reason}: NOT texted`);
      if (opts.returnToList !== false) await returnToListView();
      return { status: 'skipped', customer: !!g.customer, reason: g.reason };
    }
    if (g.unverified) commandLog('⚠️', 'Customer Status', `${accountName} — the field is not on the page, so it could not be verified (written down in status-checks.jsonl); texting anyway`);
    if (g.moved) { await page.goto(acctUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await sleep(CONFIG.accountLoadMs); }      // the plan check left the page on an opportunity: back to the account for the text
  }

  // Phase 2: Click the Texts tab
  commandLog('📱', 'Text channel', 'Opening Texts tab');

  // Use deep shadow DOM search to find the Texts tab
  // Salesforce wraps everything in shadow DOM (lightning-web-components)
  // The compose box and Send button may also be inside a cross-origin iframe (pure.cloud)
  const textsTabResult = await page.evaluate(() => {
    function deepFindByText(root, searchText) {
      const results = [];
      function walk(node) {
        const allElements = node.querySelectorAll('*');
        allElements.forEach(el => {
          const text = (el.innerText || el.textContent || '').trim();
          if (text === searchText) {
            if (el.offsetParent !== null || el.getClientRects().length > 0) {
              const rect = el.getBoundingClientRect();
              results.push({ tag: el.tagName.toLowerCase(), text, role: el.getAttribute('role'), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), w: rect.width, h: rect.height });
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      }
      walk(root);
      return results;
    }
    return deepFindByText(document.body, 'Texts');
  });

  let revealed = false;      // the compose box was scrolled into view directly: the scroll-to-the-bottom below is not needed
  if (textsTabResult.length > 0) {
    // Move cursor to Texts tab so user can see
    await moveCursorTo(page, textsTabResult[0].x, textsTabResult[0].y);
    await sleep(300);
    // Click the first visible one: only if the Texts tab is what is on top at that spot. The utility bar along the bottom (History, Macros ...), a pop-up or a tab that is clipped away is NOT
    // clicked; openTextsFast just below then opens the tab the careful way.
    const textsClick = await require('./clickGuard').clickAt(page, textsTabResult[0].x, textsTabResult[0].y, { expect: 'texts', what: 'the Texts tab', log: commandLog });
    // A pop-up over the page (the "Org ID Screenflow" one) covers the tab: nothing behind it can be clicked, so do not spend a minute trying (runReportCampaign tries the account once more on a fresh load)
    if (!textsClick.clicked && textsClick.hit && textsClick.hit.popup) throw new Error(`Compose box not found — a pop-up is open on the page ("${textsClick.hit.popup}") and covers the Texts tab (nothing was typed)`);
    // The click has to SELECT the tab (a click that missed leaves the Activity tab on screen, and the scroll below then runs through that whole feed): check it, open it again if it did not select,
    // wait for the compose box and scroll THAT into view. Only when that cannot be done does the old scroll-everything-to-the-bottom run (it also runs if the panel is still not there).
    revealed = (await openTextsFast(page)).revealed;
    if (!revealed) {
      await sleep(CONFIG.textsTabLoadMs);
      // Scroll down to reveal the texts interface — try multiple scroll strategies
      // Salesforce content is inside shadow DOM so window.scrollBy may not work
      await page.evaluate(() => {
        function scrollAll(node) {
          try { node.scrollTop = node.scrollHeight; } catch (_) {}
          try { window.scrollBy(0, 800); } catch (_) {}
          const els = node.querySelectorAll('*');
          els.forEach(el => {
            try {
              const style = getComputedStyle(el);
              if (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') {
                el.scrollTop = el.scrollHeight;
              }
            } catch (_) {}
            if (el.shadowRoot) scrollAll(el.shadowRoot);
          });
        }
        scrollAll(document.body);
      });
      await sleep(1500);
      await page.mouse.wheel(0, 800);
      await sleep(1000);
      await page.keyboard.press('PageDown');
      await sleep(500);
      await page.keyboard.press('PageDown');
      await sleep(1000);
      await page.evaluate(() => {
        function deepQueryAll(root, selector) {
          const results = [];
          function walk(node) {
            const matches = node.querySelectorAll(selector);
            matches.forEach(el => results.push(el));
            const all = node.querySelectorAll('*');
            all.forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
          }
          walk(root);
          return results;
        }
        const containers = deepQueryAll(document.body, '.slds-scrollable, [class*="scrollable"], .forceVisualningsViewport, .oneOne, .tabContent, [role="tabpanel"]');
        containers.forEach(c => {
          try { c.scrollTop = c.scrollHeight; } catch (_) {}
        });
      });
      await sleep(1500);
    }
  } else {
    console.log(`  ⚠️ No "Texts" element found via deep shadow DOM search`);
    // Fallback: try standard selectors
    let textsTab = await firstPresent(page, CONFIG.textsTabSelectors);
    if (textsTab) {
      try {
        await textsTab.scrollIntoViewIfNeeded({ timeout: 3000 });
        await textsTab.click();
        commandLog('🔓', 'Channel access', 'Texts tab activated');
        await sleep(CONFIG.textsTabLoadMs);
      } catch (e) {
        throw new Error('Could not click Texts tab: ' + e.message);
      }
    } else {
      throw new Error('Texts tab not found (searched shadow DOM and standard selectors)');
    }
  }

  commandLog('📡', 'Text channel online', 'Ready for payload');

  // The SMS panel has to show its compose box before anything is read or typed: wait for it, and open the Texts tab again if it does not show (see ensureTextsPanel).
  const panel = await ensureTextsPanel(page, { snapshot: (why) => require('./threadProbe').snapshotFailure(page, { id: opts.accountId, name: accountName, why }) });

  // Thread guard (--followup): read the conversation on screen BEFORE typing. An opt-out, an unanswered reply from the pro, or a teammate's text in 48h holds the send.
  // (No compose box means the panel never opened: an empty read then proves nothing, so it is not believed.)
  if (opts.threadGuard) {
    const held = await runThreadGuard(page, accountName, panel.ok ? opts : { ...opts, threadMayBeEmpty: false });
    if (held) return held;
  }

  commandLog('⌨️', 'Payload input', 'Loading message');

  // Scroll down to reveal the texts interface (not after the compose box was scrolled into view: a page that scrolls could carry it off screen again)
  if (!revealed) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(500);
  }

  // Use deep shadow DOM + iframe search to find landmark elements:
  // 1. "add / edit short link" (leftmost)
  // 2. "template" (right of that)
  // The compose box is ~200px below-left of "template"
  // Then: template -> Insert Media file -> Insert emoticon -> Send button

  const allLandmarks = await findComposeLandmarks(page);

  // Log landmark summary (one line only)
  const landmarkSummary = allLandmarks.map(l => l.landmark).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  if (landmarkSummary) commandLog('📍', 'Compose landmark', landmarkSummary);

  // Find the template landmark — our anchor point
  const templateLandmark = allLandmarks.find(l => l.landmark === 'template');
  const shortlinkLandmark = allLandmarks.find(l => l.landmark === 'shortlink');
  const composeLandmark = allLandmarks.find(l => l.landmark === 'compose');
  const mediaLandmark = allLandmarks.find(l => l.landmark === 'media');
  const emoticonLandmark = allLandmarks.find(l => l.landmark === 'emoticon');
  const sendLandmark = allLandmarks.find(l => l.landmark === 'send');

  if (templateLandmark || composeLandmark) {

    // Step 1: If we have the compose box landmark, use it directly
    // Otherwise, estimate from template position
    let composeX, composeY;

    if (composeLandmark) {
      composeX = Math.round(composeLandmark.x + composeLandmark.w / 2);
      composeY = Math.round(composeLandmark.y + composeLandmark.h / 2);
    } else if (templateLandmark) {
      const templateCenterX = Math.round(templateLandmark.x + templateLandmark.w / 2);
      const templateCenterY = Math.round(templateLandmark.y + templateLandmark.h / 2);
      await moveCursorTo(page, templateCenterX, templateCenterY);
      await page.mouse.move(templateCenterX, templateCenterY);
      await sleep(500);
      const leftEdge = shortlinkLandmark ? shortlinkLandmark.x : templateLandmark.x - 30;
      const rightEdge = sendLandmark ? sendLandmark.x : templateLandmark.x + templateLandmark.w + 80;
      composeX = Math.round((leftEdge + rightEdge) / 2);
      composeY = Math.round(templateLandmark.y + templateLandmark.h + 40);
    } else {
      throw new Error('No template or compose landmark found');
    }

    // The message box is found by what it IS (the page's own text box whose placeholder reads "Type a message or select a template"), scrolled clear of the utility bar, checked to be the topmost
    // thing where it is clicked, and the cursor must really be in it before a single character is typed. (A click that landed on History / Macros used to open those panels, and the message was
    // then typed into them: spaces and Enter activate a focused button.) The estimated spot above is only used when the page has no such box, and is never clicked on the utility bar either.
    const clickGuard = require('./clickGuard');
    const focus = await clickGuard.focusComposer(page, { fallbackPoint: { x: composeX, y: composeY }, inFrame: !!(composeLandmark && composeLandmark.inFrame), moveCursor: (x, y) => moveCursorTo(page, x, y), log: commandLog });
    if (!focus.ok) {
      try { await require('./threadProbe').snapshotFailure(page, { id: opts.accountId, name: accountName, why: `click guard: ${focus.why}`, extra: focus.diag }); } catch (_) {}      // compose-failures/: what the page looked like when the box could not be reached (+ what it was waiting for)
      const stuck = new Error(`Compose box not found — ${focus.why} (nothing was typed)`);
      if (focus.loading) stuck.composerLoading = true;      // it sat under its loading spinner for the whole wait: runReportCampaign counts these (several in a row = the browser is the problem, not the leads)
      throw stuck;
    }
    await typeMessage(page, message);
    // The text has to be IN the box before Send is pressed (a box inside an iframe cannot be read from here and is let through).
    const landed = await clickGuard.boxText(page);
    if (landed.known && landed.len === 0) {
      try { await require('./threadProbe').snapshotFailure(page, { id: opts.accountId, name: accountName, why: 'click guard: the message box is empty after typing (Send not clicked)' }); } catch (_) {}
      throw new Error('Send button not clicked — the message box is empty after typing, so there is nothing to send');
    }
    commandLog('✅', 'Payload loaded', 'Message armed');
    await sleep(2000);

    commandLog('🚀', 'Send command', opts.dryRun || clickGuard.isSendLocked() ? 'DRY RUN — finding Send, NOT clicking it' : 'Dispatching text');

    // Send: looked up again now (typing grows the box and moves it), scrolled clear of the utility bar and checked to be on top. The old estimates are only for a page with no Send button we can find.
    const sendEstimate = sendLandmark ? { x: Math.round(sendLandmark.x + sendLandmark.w / 2), y: Math.round(sendLandmark.y + sendLandmark.h / 2) }
      : templateLandmark ? { x: Math.round(templateLandmark.x + templateLandmark.w + 80), y: Math.round(templateLandmark.y + templateLandmark.h / 2) } : null;
    const sentOut = await clickGuard.clickSend(page, { fallbackPoint: sendEstimate, moveCursor: (x, y) => moveCursorTo(page, x, y), log: commandLog, dryRun: !!opts.dryRun });
    if (!sentOut.ok) {
      try { await require('./threadProbe').snapshotFailure(page, { id: opts.accountId, name: accountName, why: `click guard (message typed, Send not clicked): ${sentOut.why}` }); } catch (_) {}
      await discardStrayDraft(page, opts);      // (a DRY run that fails after typing does not leave its text in the box either; a live run is left exactly as it was)
      throw new Error(sendEstimate ? `Send button not clicked — ${sentOut.why}` : 'Send button not found and no template to estimate from');
    }
    if (sentOut.dry) { dry = true; await discardDraft(page); }      // --dry-run / --test: Send was found but NOT clicked: the typed text comes out again, and the result below says "dry-run"

  } else {
    // No template landmark found — try falling back to old methods
    commandLog('⚠️', 'Compose fallback', 'Searching alternate input route');

    // Try the old deep search for compose box
    const composeResult = await page.evaluate(() => {
      function deepFind(root) {
        const results = [];
        function walk(node) {
          const els = node.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
          els.forEach(el => {
            if (el.offsetParent !== null || el.getClientRects().length > 0) {
              const rect = el.getBoundingClientRect();
              const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
              const phLower = ph.toLowerCase();
              const isComposeBox = phLower.includes('type a message') || phLower.includes('message or select');
              let inExcludedArea = false;
              let parent = el.parentElement;
              for (let i = 0; i < 30; i++) {
                if (!parent) break;
                const pcls = (parent.className || '').toLowerCase();
                const pdataId = (parent.getAttribute && parent.getAttribute('data-component-id') || '').toLowerCase();
                if (pcls.includes('slds-utility-bar') || pcls.includes('utilitybar') || pcls.includes('macro') || pdataId.includes('macro') || pcls.includes('force-pop-out') || pcls.includes('oneutilitybaritem') || pcls.includes('forcesearchinput') || pcls.includes('uiinputtextforautocomplete')) { inExcludedArea = true; break; }
                parent = parent.parentElement;
              }
              if (isComposeBox && !inExcludedArea) {
                results.push({ x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), w: rect.width, h: rect.height, placeholder: ph });
              }
            }
          });
          const all = node.querySelectorAll('*');
          all.forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
        }
        walk(root);
        return results;
      }
      return deepFind(document.body);
    });

    if (composeResult.length > 0) {
      // Same rule as above: nothing is typed unless the cursor is really in the message box, and the utility bar is never clicked.
      const clickGuard = require('./clickGuard');
      const focusFb = await clickGuard.focusComposer(page, { fallbackPoint: { x: composeResult[0].x, y: composeResult[0].y }, moveCursor: (x, y) => moveCursorTo(page, x, y), log: commandLog });
      if (!focusFb.ok) throw new Error(`Compose box not found — ${focusFb.why} (nothing was typed)`);
      await typeMessage(page, message);
      commandLog('✅', 'Payload loaded', 'Message armed via fallback');
      await sleep(2000);

      // Deep search for Send button
      const sendResult = await page.evaluate(() => {
        function deepFindSend(root) {
          const results = [];
          function walk(node) {
            const els = node.querySelectorAll('button.slds-button_brand, button, [role="button"]');
            els.forEach(el => {
              const text = (el.innerText || el.value || '').trim();
              if (text === 'Send' && (el.offsetParent !== null || el.getClientRects().length > 0)) {
                const rect = el.getBoundingClientRect();
                let inExcludedArea = false;
                let parent = el.parentElement;
                for (let i = 0; i < 30; i++) {
                  if (!parent) break;
                  const pcls = (parent.className || '').toLowerCase();
                  const pdataId = (parent.getAttribute && parent.getAttribute('data-component-id') || '').toLowerCase();
                  if (pcls.includes('slds-utility-bar') || pcls.includes('utilitybar') || pcls.includes('macro') || pdataId.includes('macro') || pcls.includes('force-pop-out') || pcls.includes('oneutilitybaritem') || pcls.includes('forcesearchinput') || pcls.includes('uiinputtextforautocomplete')) { inExcludedArea = true; break; }
                  parent = parent.parentElement;
                }
                if (!inExcludedArea) {
                  results.push({ x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), disabled: el.disabled || false, className: el.className });
                }
              }
            });
            const all = node.querySelectorAll('*');
            all.forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
          }
          walk(root);
          return results;
        }
        return deepFindSend(document.body);
      });

      if (sendResult.length > 0) {
        const clickable = sendResult.find(b => !b.disabled) || sendResult[0];
        const sendFb = await require('./clickGuard').clickSend(page, { fallbackPoint: { x: clickable.x, y: clickable.y }, moveCursor: (x, y) => moveCursorTo(page, x, y), log: commandLog, dryRun: !!opts.dryRun });
        if (!sendFb.ok) { await discardStrayDraft(page, opts); throw new Error(`Send button not clicked — ${sendFb.why}`); }
        if (sendFb.dry) { dry = true; await discardDraft(page); }      // --dry-run / --test: Send was found but NOT clicked
        else commandLog('📡', 'Delivery signal', 'Fallback dispatch accepted');
      } else {
        throw new Error('Send button not found via any method');
      }
    } else {
      const blocked = await require('./clickGuard').locate(page, 'compose', { reveal: false });      // say so when a pop-up (e.g. "Org ID Screenflow") is what is in the way
      throw new Error(`Compose box not found — no template landmark and no compose box via deep search${blocked.popup ? `; a pop-up is open on the page ("${blocked.popup}") and blocks it` : ''}`);
    }
  }

  if (!dry) await sleep(CONFIG.afterSendMs);      // (a dry run sent nothing: no need to wait for Salesforce to register it)
  if (dry) commandLog('🧪', 'Dry run complete', `${accountName}: the text was typed and checked, Send was NOT clicked — nothing was sent`);
  else commandLog('🏁', 'Mission complete', `Text sent to ${accountName}`);

  // Report mode navigates straight to the next account, so skip the grid return.
  if (opts.returnToList === false) return { status: dry ? 'dry-run' : 'sent' };

  // Phase 5: Return to the opportunities list view
  await returnToListView();

  return { status: dry ? 'dry-run' : 'sent' };
}

// ============================================================================
// Campaign runner
// ============================================================================
async function runTextCampaign(page, o) {
  const message = o.message;
  const start = o.start;
  const end = o.end;
  const delayMs = o.delayMs;
  const historyTemplateName = o.templateName || 'Custom message';
  const historyTemplateKey = o.templateKey || createTemplateKey('text', historyTemplateName, message);
  const contactHistory = new ContactHistory();

  const seen = [];
  const seenSet = new Set();
  const done = new Map();
  let sentCount = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 10;

  // Skip mechanism
  let skipRequested = false;
  const skipReader = readline.createInterface({ input: process.stdin, terminal: false });
  skipReader.on('line', () => { skipRequested = true; commandLog('⏭️', 'Skip queued', 'Current lead will be bypassed'); });

  const campaignStart = new Date();

  console.log(`\n${'╔' + '═'.repeat(62) + '╗'}`);
  console.log((textDryRun() ? '║  🧪 TEXT COMMAND (DRY-RUN — nothing is sent)' : '║  🚀 TEXT COMMAND ONLINE').padEnd(64) + '║');
  console.log(`║  💬 Payload: ${message.substring(0, 43)}${message.length > 43 ? '…' : ''}`.padEnd(64) + '║');
  console.log(`║  🎯 Range: ${start}-${end || 'END'}`.padEnd(64) + '║');
  console.log('║  ⏭️  Press Enter to skip the active lead'.padEnd(64) + '║');
  console.log('╚' + '═'.repeat(62) + '╝');

  while (true) {
    const rows = page.locator(CONFIG.rowSelectors[0]);
    const count = await rows.count();

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const ident = await rowIdentifier(row);
      if (!ident) continue;
      if (!seenSet.has(ident)) { seen.push(ident); seenSet.add(ident); }
      const pos = seen.indexOf(ident) + 1;

      if (done.has(ident)) continue;
      if (pos < start) { done.set(ident, 'below range'); continue; }
      if (end != null && pos > end) continue;

      missionBanner(pos, end, ident);

      if (skipRequested) {
        skipRequested = false;
        commandLog('⏭️', 'Lead bypassed', `Row ${pos} skipped by operator`);
        done.set(ident, 'SKIPPED (user)');
        continue;
      }

      let guard;
      let historyIdentity;
      try {
        historyIdentity = await historyContactIdentity(row, ident);
        const listAcct = /^salesforce-account:(.+)$/.exec(historyIdentity.contactId || '');          // never the same text twice (the permanent log; the ledger below forgets after ~48 h)
        const listSame = listAcct ? textLog.sentSameMessage(listAcct[1], 'text', { templateName: historyTemplateName, message }) : null;
        if (listSame) { done.set(ident, `SKIPPED: already got this exact text ${formatAge(listSame.at)} — never the same text twice`); commandLog('🛡️', 'Same-text guard', `${ident} — already got this exact text ${formatAge(listSame.at)} — never the same text twice`); continue; }
        guard = contactHistory.reserve({
          contactId: historyIdentity.contactId,
          aliases: historyIdentity.aliases,
          contactLabel: ident,
          channel: 'text',
          templateKey: historyTemplateKey,
          templateName: historyTemplateName,
          content: message,
          source: 'Assistant',
        });
      } catch (historyError) {
        commandLog('⛔', 'Contact guard offline', historyError.message);
        commandLog('🛑', 'Campaign halted', 'No unverified outreach will be sent');
        skipReader.close();
        return summarize({ message, start, end, seen, done, sentCount, campaignStart });
      }
      logContactGuard(guard);
      if (!guard.allowed) {
        const reason = contactGuardReason(guard);
        done.set(ident, `SKIPPED: CONTACT GUARD — ${reason}`);
        commandLog('⏭️', 'Lead protected', reason);
        continue;
      }

      let historyReservationId = guard.reservationId;

      try {
        // Find the account link in this row
        const accountLink = await findAccountLink(row);
        if (!accountLink || (await accountLink.count()) === 0) {
          throw new Error('no account link found in this row');
        }

        const result = await textAccount(page, ident, accountLink, message);

        if (result.status === 'skipped') {      // textAccount's Customer Status look: a current customer is NOT texted (it is saved on the held list). textAccount has already gone back to the list view.
          try { contactHistory.cancelReservation(historyReservationId, `skipped: ${result.reason}`); } catch (_) {}
          historyReservationId = null;
          done.set(ident, `SKIPPED: ${result.reason}`);
          await sleep(Math.min(delayMs, 2000));
          continue;
        }

        if (result.status === 'dry-run') {      // --dry-run / --test: typed and checked, Send NOT clicked. Nothing is recorded, and the reservation is released so a later real run is not blocked.
          try { contactHistory.cancelReservation(historyReservationId, 'dry-run'); } catch (_) {}
          historyReservationId = null;
          done.set(ident, 'DRY-RUN typed, Send NOT clicked');
          consecutiveFailures = 0;
          commandLog('🧪', 'Dry run', `${ident} — would have been texted; nothing was sent or recorded`);
        }

        if (result.status === 'sent') {
          try {
            contactHistory.recordDelivery(historyReservationId);
            historyReservationId = null;
            commandLog('💾', 'History recorded', 'Text delivery added to shared ledger');
          } catch (historyError) {
            done.set(ident, `SENT: HISTORY ERROR — ${historyError.message}`);
            sentCount++;
            commandLog('⛔', 'History write failed', 'Text sent; campaign stopping to prevent duplicates');
            skipReader.close();
            return summarize({ message, start, end, seen, done, sentCount, campaignStart });
          }
          done.set(ident, 'sent');
          sentCount++;
          consecutiveFailures = 0;

          // Durable outreach log (list mode). Derive the account id from the contact
          // identity (salesforce-account:<id>); email isn't captured here because the
          // page has already returned to the list view.
          try {
            const idm = (historyIdentity && historyIdentity.contactId || '').match(/^salesforce-account:(001[A-Za-z0-9]{12,15})/);
            const acctId = idm ? idm[1] : null;
            textLog.recordText({ accountId: acctId, accountName: ident, accountUrl: acctId ? `${CONFIG.startUrl.replace(/\/$/, '')}/lightning/r/Account/${acctId}/view` : null, templateName: historyTemplateName, message, mode: 'list' });
          } catch (_) {}
        }

        // textAccount already navigated back to the list view
        await sleep(delayMs);

      } catch (e) {
        if (historyReservationId) {
          try { contactHistory.cancelReservation(historyReservationId, e.message); } catch (_) {}
        }
        done.set(ident, `SKIPPED: ${e.message}`);
        consecutiveFailures++;
        commandLog('❌', 'Mission failed', `Row ${pos} skipped — ${e.message}`);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          console.log(`\n⛔ Aborting: ${consecutiveFailures} consecutive failures — something is wrong.`);
          console.log(`   Last ${consecutiveFailures} records were all skipped. Fix the issue and re-run.`);
          skipReader.close();
          return summarize({ message, start, end, seen, done, sentCount, campaignStart });
        }
        try {
          await page.goBack();
          await sleep(3000);
          try { await page.waitForSelector(CONFIG.rowSelectors[0], { timeout: 10000 }); } catch (_) {}
        } catch (_) {}
      }

    }

    // Do not scroll past a completed finite range. A skipped row (including a
    // user-requested skip) is a completed attempt and stays in the summary.
    if (isRequestedRangeComplete(seen, done, start, end)) {
      commandLog('🏆', 'Range secured', `${start}-${end} fully attempted; holding position`);
      skipReader.close();
      return summarize({ message, start, end, seen, done, sentCount, campaignStart });
    }

    // Scroll for more — keep going until we have enough rows or hit the end
    const prevLen = seen.length;
    const allDone = seen.every((x) => done.has(x));
    if (allDone && (end == null || seen.length < end)) {
      commandLog('🛰️', 'Recon sweep', `${seen.length} leads cleared; seeking ${end || 'all'}`);
      let scrolled = false;
      let emptyScrolls = 0;
      const maxEmptyScrolls = 5;
      while (emptyScrolls < maxEmptyScrolls) {
        const beforeScroll = seen.length;
        await scrollList(page);
        // Re-scan the DOM for new rows after scrolling
        const newRows = page.locator(CONFIG.rowSelectors[0]);
        const newCount = await newRows.count();
        for (let i = 0; i < newCount; i++) {
          const row = newRows.nth(i);
          const ident = await rowIdentifier(row);
          if (ident && !seenSet.has(ident)) {
            seen.push(ident);
            seenSet.add(ident);
          }
        }
        if (seen.length > beforeScroll) {
          commandLog('📡', 'Leads acquired', `+${seen.length - beforeScroll} new • ${seen.length} total detected`);
          scrolled = true;
          break; // new rows loaded, go back to processing them
        }
        emptyScrolls++;
        if (emptyScrolls < maxEmptyScrolls) {
          commandLog('🔭', 'No contacts', `Recon sweep ${emptyScrolls}/${maxEmptyScrolls}`);
        }
      }
      if (!scrolled && seen.length === prevLen) {
        commandLog('🏁', 'End of grid', 'No additional leads detected');
        break;
      }
    } else if (allDone) {
      break;
    }
  }

  skipReader.close();
  const listResult = summarize({ message, start, end, seen, done, sentCount, campaignStart });
  try { textLog.generateDashboard(); } catch (_) {}
  return listResult;
}

// ============================================================================
// Campaign runner — REPORT mode
// Harvest all account rows from the report, then text the requested range by
// navigating directly to each account. Reuses the same contact guard, history
// ledger, templates, textAccount() send flow, and summary as list mode.
// ============================================================================
/**
 * First-touch texts (--queue, --report) go only to pros whose OWN window is open right now (tcpa.js: 8:00–20:00 in their time zone, Mon–Sat).
 * Everyone else is left for later: a known zone that is closed now, and — unless --unknown-zone strict — a pro whose zone we don't know.
 * A current customer (the held list, a hold nobody has verified yet included) or a closed-won account is never texted, any more than a banned one: it goes to `held` (the rule of the queue day
 * and the overnight run, tomorrowSend.defaultScreen; Luke, 2026-10-29). A plain --queue and --report used to offer them.
 * → { open, waiting:[{ lead, zones, reason }], unknown, banned, held }   (open keeps the list's order)
 */
function partitionByHours(leads, { unknownZone = 'strict', now = new Date() } = {}) {
  const open = [], waiting = [], unknown = [], banned = [], held = [];
  const cust = textLog.readCurrentCustomers(), won = textLog.readClosedWon();
  const heldOut = (id) => { const f = String(id || '').toLowerCase(), k = f.slice(0, 15); return !!k && (cust.has(f) || cust.has(k) || won.has(f) || won.has(k)); };
  for (const l of leads) {
    if (textLog.isBanned(l.accountId)) { banned.push(l); continue; }
    if (heldOut(l.accountId)) { held.push(l); continue; }
    const zs = textLog.zonesFor(l.accountId);
    if (!zs) {
      if (unknownZone !== 'strict') { unknown.push(l); continue; }
      const g = tcpa.check(now);                          // --unknown-zone strict: an unknown zone only inside the all-US window (12:00–8:00 PM Eastern)
      if (g.ok) open.push(l); else waiting.push({ lead: l, zones: null, reason: g.reason });
      continue;
    }
    const g = tcpa.checkZones(zs, now);
    if (g.ok) open.push(l); else waiting.push({ lead: l, zones: zs, reason: g.reason });
  }
  return { open, waiting, unknown, banned, held };
}

/** What partitionByHours found, in a few lines: who is open now, who opens when, who has no known zone. */
function printHoursPlan(part) {
  const label = (zs) => (zs && zs.length ? zs.map((z) => tcpa.ZONE_SHORT[z] || z).join('/') : 'no zone');
  const group = (items, zonesOf) => { const m = new Map(); for (const x of items) { const zs = zonesOf(x); const k = label(zs); const g = m.get(k) || { n: 0, zs }; g.n++; m.set(k, g); } return [...m.entries()].sort((x, y) => y[1].n - x[1].n); };
  const total = part.open.length + part.waiting.length + part.unknown.length + part.banned.length + (part.held ? part.held.length : 0);
  commandLog('⏰', 'Hours', `${total.toLocaleString()} lead(s): ${part.open.length.toLocaleString()} open now · ${part.waiting.length.toLocaleString()} not open yet · ${part.unknown.length.toLocaleString()} with no known time zone${part.banned.length ? ` · ${part.banned.length.toLocaleString()} banned` : ''}${part.held && part.held.length ? ` · ${part.held.length.toLocaleString()} current customer(s) / closed-won, never texted` : ''}   (each is texted only inside its own ${tcpa.WINDOW.knownStartHour}:00–${tcpa.WINDOW.endHour}:00, Mon–Sat)`);
  if (part.open.length) console.log(`     open now        ${group(part.open, (l) => textLog.zonesFor(l.accountId)).map(([k, g]) => `${k} ${g.n}`).join(' · ')}`);
  if (part.waiting.length) console.log(`     not open yet    ${group(part.waiting, (w) => w.zones).map(([k, g]) => `${k} ${g.n} (opens ${tcpa.nextOpenFor(g.zs) || '?'})`).join(' · ')}`);
  if (part.unknown.length) console.log(`     left for later  ${part.unknown.length.toLocaleString()} with no known time zone — they are texted only with --unknown-zone strict (12:00–8:00 PM Eastern). email --harvest or --industry find their zone.`);
}

async function runReportCampaign(page, o) {
  // --auto passes a custom message on each lead (lead.message); everyone else shares o.message.
  const message = o.message || '(custom message per account)';
  const start = o.start;
  const end = o.end;
  const delayMs = o.delayMs;
  const historyTemplateName = o.templateName || 'Custom message';
  const historyTemplateKey = o.templateKey || createTemplateKey('text', historyTemplateName, message);
  const contactHistory = new ContactHistory();

  // First-ever run: backfill the durable texted-log from the contact-history ledger
  // (recent texts sent before this log existed) so the dashboard isn't empty.
  try {
    if (textLog.readAll().length === 0) {
      const n = textLog.seedFromContactHistory();
      if (n) commandLog('📊', 'Texted log seeded', `${n} prior text(s) from contact-history`);
    }
  } catch (_) {}

  // Source: a provided list (e.g. the saved --queue), else harvest the open report.
  let leads;
  if (o.leads) {
    leads = o.leads;
    commandLog('📇', 'Queue loaded', `${leads.length} saved lead(s) to text`);
  } else {
    commandLog('🧭', 'Report harvest', 'Scanning report for account rows…');
    leads = await harvestReportLeads(page);
    commandLog('📇', 'Leads harvested', `${leads.length} account rows detected`);
  }
  if (leads.length === 0) {
    throw new Error(o.leads ? 'queue is empty' : 'no account rows found in report (try: node Assistant.js --report --inspect)');
  }

  const defaultSource = o.source || leads.source || null;   // the report these accounts came from (LDS / Shark)
  // First-touch hours (--queue / --report): only pros whose OWN window is open right now are texted, and the range counts those; the rest are left for later.
  let leftForLater = 0;
  if (o.tcpa && o.tcpaFilter) {
    const part = partitionByHours(leads, { unknownZone: o.tcpaUnknown === 'hold' ? 'hold' : 'strict' });
    printHoursPlan(part);
    leftForLater = part.waiting.length + part.unknown.length;
    leads = Object.assign(part.open.slice(), { source: leads.source });
    if (!leads.length) {
      console.log('\n  ⏰ Nobody on this list is inside their texting hours right now, so nothing was sent. Run it again when the next zone opens.\n');
      return { sentCount: 0, seen: 0, skipped: 0, leftForLater };
    }
  }
  const seen = leads.map((l) => l.name);
  const done = new Map();
  let sentCount = 0;
  let consecutiveFailures = 0;
  let composerStuck = 0;      // accounts in a row whose Texts composer stayed under its loading spinner for the whole wait (clickGuard.focusComposer)
  const maxConsecutiveFailures = 10;
  const campaignStart = new Date();
  const last = end == null ? leads.length : Math.min(end, leads.length);

  // Skip mechanism (press Enter to bypass the active lead)
  let skipRequested = false;
  const skipReader = readline.createInterface({ input: process.stdin, terminal: false });
  skipReader.on('line', () => { skipRequested = true; commandLog('⏭️', 'Skip queued', 'Current lead will be bypassed'); });

  console.log(`\n${'╔' + '═'.repeat(62) + '╗'}`);
  console.log((textDryRun() ? '║  🧪 TEXT COMMAND (REPORT, DRY-RUN — nothing is sent)' : '║  🚀 TEXT COMMAND ONLINE (REPORT)').padEnd(64) + '║');
  console.log(`║  💬 Payload: ${message.substring(0, 43)}${message.length > 43 ? '…' : ''}`.padEnd(64) + '║');
  console.log(`║  🎯 Range: ${start}-${end || 'END'} of ${leads.length}`.padEnd(65) + '║');
  console.log('║  ⏭️  Press Enter to skip the active lead'.padEnd(64) + '║');
  if (o.force) console.log('║  ⚠️  FORCE MODE — ALL guardrails OFF (daily/SMS/contact)'.padEnd(64) + '║');
  console.log('╚' + '═'.repeat(62) + '╝');

  const sentIds = [];
  for (let pos = start; pos <= last; pos++) {
    if (o.shouldStop && o.shouldStop()) { commandLog('🛑', 'Stopped', 'asked to stop — the rest of this batch is left for the next run'); break; }
    const lead = leads[pos - 1];
    if (!lead) continue;
    const ident = lead.name;
    const leadMessage = lead.message || message;
    const leadTemplateKey = lead.message ? createTemplateKey('text', historyTemplateName, leadMessage) : historyTemplateKey;

    // TCPA hours gate: only for callers that opt in (--reengage passes tcpa: true).
    // Not bypassed by --force.
    if (o.tcpa) {
      const zs = textLog.zonesFor(lead.accountId);
      if (!zs && o.tcpaUnknown === 'hold') { done.set(ident, 'SKIPPED: no known time zone'); commandLog('⏰', 'TCPA hours', `${ident} — no known time zone for this contact; not texted`); continue; }
      let g = tcpa.checkZones(zs);
      if (g.ok && o.tcpaMarginMs) g = tcpa.checkZones(zs, new Date(Date.now() + o.tcpaMarginMs));      // --board: a text takes ~30-40 s, so a contact whose window closes inside that margin waits for its next window (the opening edge is checked above)
      if (!g.ok) { done.set(ident, `SKIPPED: outside TCPA hours for this contact (${g.reason})`); commandLog('⏰', 'TCPA hours', `${ident} — closed for this contact (${g.reason})`); continue; }
    }

    // Banlist (Do Not Call etc.): never contacted; --force does not bypass.
    if (textLog.isBanned(lead.accountId)) { done.set(ident, 'SKIPPED: on the banlist'); commandLog('🚫', 'Banlist', `${ident} — never contacted (banlist)`); continue; }

    missionBanner(pos, end, ident);

    if (skipRequested) {
      skipRequested = false;
      commandLog('⏭️', 'Lead bypassed', `Row ${pos} skipped by operator`);
      done.set(ident, 'SKIPPED (user)');
      continue;
    }

    // NEVER THE SAME TEXT TWICE: a lead who already got this exact text (the same wording, or the same named template), however long ago, is not texted it again.
    // The contact ledger below only remembers ~48 hours; texted-log.jsonl is the permanent memory. NOT bypassed by --force. (A text written per lead — --auto, a
    // thread-hold check-in — is compared by its wording only: its template name is the same for every account.)
    const sameText = textLog.sentSameMessage(lead.accountId, 'text', { templateName: lead.message ? null : historyTemplateName, message: leadMessage });
    if (sameText) {
      done.set(ident, `SKIPPED: already got this exact text${sameText.templateName ? ` ("${sameText.templateName}")` : ''} ${formatAge(sameText.at)} — never the same text twice`);
      commandLog('🛡️', 'Same-text guard', `${ident} — already got this exact text ${formatAge(sameText.at)}${sameText.count > 1 ? ` (${sameText.count} times)` : ''} — never the same text twice`);
      continue;
    }

    // --force / --no-guards removes ALL texting guardrails below (daily, report-SMS,
    // and contact-history) so it texts everyone in range regardless of recent contact.
    if (!o.force) {
      // Once-per-day guard (durable): never text the same lead twice within 24h. Backed
      // by the never-pruned texted-log, so it holds across separate runs — report AND
      // queue — even if the 48h contact-history has rolled over.
      // --same-day (o.sameDay) waives THIS guard only: it texts the pros we already texted today on purpose. The other guards below, the banlist, the hours and
      // the contact ledger (same text twice) still apply.
      const priorText = o.sameDay ? null : textLog.textedWithinHours(lead.accountId, 24);
      if (priorText) {
        const hrs = Math.max(1, Math.round((Date.now() - new Date(priorText.at).getTime()) / 3600000));
        done.set(ident, `SKIPPED: already texted ${hrs}h ago (once-per-day guard)`);
        commandLog('🛡️', 'Daily guard', `HOLD — already texted ${hrs}h ago (<24h)`);
        continue;
      }

      // Report-based 48h guard: skip anyone texted by ANYONE in the business within the
      // last 48h, per the report's "Last Outgoing SMS DateTime" column. The local contact
      // history only knows OUR OWN sends — this catches teammates' texts too.
      if (!o.ignoreSms && lead.lastOutgoingSms) {
        const when = parseReportDateTime(lead.lastOutgoingSms);
        if (when && Date.now() - when.getTime() < 48 * 3600000) {
          const hrs = Math.max(1, Math.round((Date.now() - when.getTime()) / 3600000));
          done.set(ident, `SKIPPED: last outgoing SMS ${hrs}h ago (report, <48h)`);
          commandLog('🛡️', 'SMS guard', `HOLD — texted ${hrs}h ago per report (<48h)`);
          continue;
        }
      }
    }

    // Per-account check (--followup --check): the caller opens THIS account's Salesforce profile and checks it now, right before its text, after the cheap local guards above
    // (so no profile is opened for an account they would skip anyway). { ok: false } skips the account; nothing has been reserved or sent yet.
    let checkSkip = false;      // the precheck says this account needs no Customer Status look inside its text (the board's no-look stage)
    let checkOpened = null;      // the page the check just loaded on this account (enrollCheck.js hands it over): the FIRST text try uses it as it is instead of loading the account a second time
    if (o.precheck) {
      let pre; try { pre = await o.precheck(lead); } catch (e) { pre = { ok: false, reason: `the check failed: ${e.message}` }; }
      if (!pre || !pre.ok) { done.set(ident, `SKIPPED: ${(pre && pre.reason) || 'did not pass the Salesforce check'}`); continue; }
      checkOpened = pre.opened || null;
      checkSkip = !!pre.skipCustomerCheck;
    }

    // Contact-history reserve (skipped entirely in --force). When forced we send without
    // reserving; the durable texted-log still records the send for the dashboard.
    let historyReservationId = null;
    if (!o.force) {
      let guard;
      try {
        guard = contactHistory.reserve({
          contactId: lead.accountId ? `salesforce-account:${lead.accountId}` : `label:${ident}`,
          aliases: [`label:${ident}`],
          contactLabel: ident,
          channel: 'text',
          templateKey: leadTemplateKey,
          templateName: historyTemplateName,
          content: leadMessage,
          source: 'Assistant (report)',
          // A recent EMAIL must NOT block a text (the 48h recent-contact cooldown is
          // cross-channel). cooldownHours:0 bypasses that; the durable once-per-day
          // TEXT guard (above) and same_template still prevent same-day/duplicate texts.
          cooldownHours: 0,
        });
      } catch (historyError) {
        commandLog('⛔', 'Contact guard offline', historyError.message);
        commandLog('🛑', 'Campaign halted', 'No unverified outreach will be sent');
        skipReader.close();
        return summarize({ message, start, end, seen, done, sentCount, campaignStart });
      }
      logContactGuard(guard);
      if (!guard.allowed) {
        const reason = contactGuardReason(guard);
        done.set(ident, `SKIPPED: CONTACT GUARD — ${reason}`);
        commandLog('⏭️', 'Lead protected', reason);
        continue;
      }
      historyReservationId = guard.reservationId;
    }
    try {
      if (!lead.accountId) throw new Error('could not resolve account id from report link');

      const textOnce = (firstTry = false) => (o.textOne || textAccount)(page, ident, null, leadMessage, CONFIG.rowSelectors[0], {
        accountUrl: lead.url,
        accountId: lead.accountId,
        returnToList: false,
        opened: firstTry ? checkOpened : null,
        skipCustomerCheck: !!o.skipCustomerCheck || checkSkip || (firstTry && !!checkOpened),      // textAccount's own Customer Status look: not when the check above has just made it (it handed the page over) or said it is not wanted      // a retry is a fresh load on purpose: only the first try may use the page the check loaded
        threadGuard: o.threadGuard || null,
        threadMayBeEmpty: !!(o.threadEmptyOk && o.threadEmptyOk(lead)),      // --followup: this account should have no text thread yet, so an empty one is believed (see runThreadGuard)
      });
      // The SMS panel sometimes does not open, or its thread cannot be read (2 accounts in 3 on 2026-10-29). Nothing has been typed at that point, so the account gets ONE more try on a fresh load.
      let result;
      try { result = await textOnce(true); }
      catch (e) { if (!NOTHING_TYPED_YET.test(e.message)) throw e; commandLog('🔁', 'Retry', `${ident} — ${e.message}; opening the account again`); await sleep(2000); result = await textOnce(); }
      if (result.status === 'held' && result.kind === 'unreadable') { commandLog('🔁', 'Retry', `${ident} — the thread could not be read; opening the account again`); await sleep(2000); result = await textOnce(); }

      if (result.status === 'dry-run') {      // --dry-run / --test: typed and checked, Send NOT clicked. Nothing is recorded (no ledger entry, no texted log, no onSent) and the reservation is released.
        if (historyReservationId) { try { contactHistory.cancelReservation(historyReservationId, 'dry-run'); } catch (_) {} historyReservationId = null; }
        done.set(ident, 'DRY-RUN typed, Send NOT clicked');
        consecutiveFailures = 0;
        composerStuck = 0;
        commandLog('🧪', 'Dry run', `${ident} — would have been texted; nothing was sent or recorded`);
        await sleep(delayMs);
        continue;
      }

      if (result.status === 'held') {
        if (historyReservationId) { try { contactHistory.cancelReservation(historyReservationId, `held: ${result.reason}`); } catch (_) {} historyReservationId = null; }
        done.set(ident, `HELD: ${result.reason}`);
        await sleep(Math.min(delayMs, 2000));       // no text went out: no need to wait the full gap
        continue;
      }

      if (result.status === 'skipped') {      // textAccount's Customer Status look: a current customer is NOT texted (it is saved on the held list). Nothing was typed: the reservation is released.
        if (historyReservationId) { try { contactHistory.cancelReservation(historyReservationId, `skipped: ${result.reason}`); } catch (_) {} historyReservationId = null; }
        done.set(ident, `SKIPPED: ${result.reason}`);
        await sleep(Math.min(delayMs, 2000));       // no text went out: no need to wait the full gap
        continue;
      }

      if (result.status === 'sent') {
        // In --force there's no reservation to finalize (guard was skipped).
        if (historyReservationId) {
          try {
            contactHistory.recordDelivery(historyReservationId);
            historyReservationId = null;
            commandLog('💾', 'History recorded', 'Text delivery added to shared ledger');
          } catch (historyError) {
            done.set(ident, `SENT: HISTORY ERROR — ${historyError.message}`);
            sentCount++;
            commandLog('⛔', 'History write failed', 'Text sent; campaign stopping to prevent duplicates');
            skipReader.close();
            return summarize({ message, start, end, seen, done, sentCount, campaignStart });
          }
        }
        done.set(ident, 'sent');
        sentCount++;
        sentIds.push(lead.accountId);
        consecutiveFailures = 0;
        composerStuck = 0;

        // Durable record for the texted dashboard (never pruned). Grab the Pro's
        // email off the account page while we're still on it (best-effort).
        let email = null;
        try { email = await scrapeAccountEmail(page); } catch (_) {}
        try {
          textLog.recordText({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, email, templateName: historyTemplateName, message: leadMessage, mode: o.mode || (o.leads ? 'queue' : 'report'), source: lead.source || defaultSource, step: o.step });
          commandLog('📊', 'Texted log', email ? `recorded • ${email}` : 'recorded (no email found)');
        } catch (_) {}
        // Queue mode: mark this lead done so it won't be re-texted on the next run.
        if (o.onSent) { try { await o.onSent(lead); } catch (_) {} }
      }
      await sleep(delayMs);
    } catch (e) {
      if (historyReservationId) {
        try { contactHistory.cancelReservation(historyReservationId, e.message); } catch (_) {}
      }
      done.set(ident, `SKIPPED: ${e.message}`);
      consecutiveFailures++;
      composerStuck = e && e.composerLoading ? composerStuck + 1 : 0;
      commandLog('❌', 'Mission failed', `Row ${pos} skipped — ${e.message}`);
      if (composerStuck >= 3) {      // the Texts composer stayed under its loading spinner on 3 accounts in a row: the browser (or its Salesforce session) is the problem, not the leads
        console.log(`\n⛔ Aborting: the Texts composer stayed under its loading spinner on ${composerStuck} accounts in a row — nothing was typed or sent on any of them.`);
        console.log('   Look at the Chrome window: if the composer there never stops spinning, that browser (or its Salesforce session) is the problem. compose-failures/ has what each page was waiting for.');
        skipReader.close();
        const stuckResult = summarize({ message, start, end, seen, done, sentCount, campaignStart });
        stuckResult.composerStuck = composerStuck;
        return stuckResult;
      }
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.log(`\n⛔ Aborting: ${consecutiveFailures} consecutive failures — something is wrong.`);
        skipReader.close();
        return summarize({ message, start, end, seen, done, sentCount, campaignStart });
      }
    }
  }

  skipReader.close();
  const result = summarize({ message, start, end, seen, done, sentCount, campaignStart });
  if (leftForLater) commandLog('⏰', 'Left for later', `${leftForLater.toLocaleString()} lead(s) were not inside their texting hours (or have no known time zone) and were NOT texted — run it again when they open`);
  result.leftForLater = leftForLater;
  result.sentIds = sentIds;
  // Refresh the durable texted dashboard after every report run.
  try {
    const p = textLog.generateDashboard();
    commandLog('📊', 'Texted dashboard', p);
    console.log(`     open it:  file://${p}   (or: email --sent)`);
  } catch (_) {}
  return result;
}

// ============================================================================
// EMAIL MODE (--email)
//
// Email-only sequence: harvest every account from the current LIST or REPORT up
// front, then navigate to each and send ONE first-touch email in a single run.
// No dashboard, no durable ledger, no per-lead personalization. Reuses the proven
// account email composer (emailAccount.js) and the shared 48h contact guard.
// ============================================================================

/** Pick the CONFIG.rowSelectors entry that matches the most rows on this view. */
async function bestRowSelector(page) {
  let best = CONFIG.rowSelectors[0], bestN = -1;
  for (const sel of CONFIG.rowSelectors) {
    let c = 0; try { c = await page.locator(sel).count(); } catch (_) {}
    if (c > bestN) { bestN = c; best = sel; }
  }
  return { sel: best, count: bestN };
}

/**
 * Explain why a list-view harvest came back empty: how many rows each selector sees,
 * and what links the first few rows actually contain (Account 001 vs Opportunity 006).
 */
async function listViewDiag(page) {
  console.log('\n🔎 List-view diagnostic:');
  for (const sel of CONFIG.rowSelectors) {
    let c = 0; try { c = await page.locator(sel).count(); } catch (_) {}
    console.log(`   rows matching ${JSON.stringify(sel)}: ${c}`);
  }
  const { sel } = await bestRowSelector(page);
  const rows = page.locator(sel);
  const n = Math.min(5, await rows.count().catch(() => 0));
  let any001 = false, any006 = false;
  for (let i = 0; i < n; i++) {
    let hrefs = [];
    try { hrefs = await rows.nth(i).locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 6)); } catch (_) {}
    hrefs.forEach((h) => { if (/\/001[A-Za-z0-9]{12,}/.test(h)) any001 = true; if (/\/006[A-Za-z0-9]{12,}/.test(h)) any006 = true; });
    console.log(`   row ${i + 1} links: ${hrefs.length ? hrefs.join('  ') : '(none)'}`);
  }
  if (n === 0) console.log('   → No rows detected. The list may not be loaded/visible, or uses a layout we do not match.');
  else if (!any001 && any006) console.log('   → Rows link to the OPPORTUNITY (006) but have NO Account (001) link. Add the "Account Name" column to this list view so each row links to the account — texting happens on the account.');
  else if (!any001 && !any006) console.log('   → Rows have no record links we recognize.');
  console.log('');
}

/**
 * The number of rows the open list says it has ("323 items • Sorted by Close Date • Filtered by …" in its header; "2,000+ items" is only a lower bound). Only text that is on screen counts (Salesforce keeps
 * pages you opened earlier in the DOM, hidden). → { total, plus, sure } or null when the page does not say; sure = it is the list header itself (it has the "• Sorted by / Filtered by" part), not some other "N items".
 */
async function readListTotal(page) {
  try {
    const loc = page.getByText(/\d[\d,]*\+?\s+items?\b/i);
    const n = Math.min(await loc.count(), 12);
    let first = null;
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const txt = await el.innerText({ timeout: 1500 }).catch(() => '');
      const m = String(txt).match(/(\d[\d,]*)(\+)?\s+items?\b/i);
      if (!m) continue;
      const r = { total: parseInt(m[1].replace(/,/g, ''), 10), plus: !!m[2], sure: /sorted by|filtered by|•/i.test(txt) };
      if (r.sure) return r;
      if (!first) first = r;
    }
    return first;
  } catch (_) { return null; }
}

/** Runs IN THE PAGE: every rendered row of the list (also inside shadow roots / split-view sidebar) with its Account link. → [{ key, accountId, name }]. Rows with no link at all (the spacer rows of a virtualised grid) are left out. */
function pageReadRows() {
  const deepAll = (root, sel, out) => {
    try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (_) {}
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    return out;
  };
  const ID = /\/(001[A-Za-z0-9]{12,15})(?=[/?#]|$)/;
  const OPP = /\/(006[A-Za-z0-9]{12,15})(?=[/?#]|$)/;
  const out = [], seenEl = new Set(), seenKey = new Set();
  const rowSels = 'table[role="grid"] tbody tr, div[role="row"], li[role="option"], .slds-split-view__list-item, .slds-split-view li, .forceVirtualListview .slds-hint-parent';
  for (const r of deepAll(document, rowSels, [])) {
    if (seenEl.has(r)) continue;
    seenEl.add(r);
    if (!r.getClientRects().length) continue;      // not on screen (a page opened earlier that Salesforce keeps hidden in the DOM): not part of this list
    const links = deepAll(r, 'a[href]', []);
    if (!links.length) continue;
    const hrefOf = (a) => a.getAttribute('href') || '';
    const acct = links.find((a) => /\/lightning\/r\/Account\/001/.test(hrefOf(a))) || links.find((a) => /\/Account\/001/.test(hrefOf(a))) || links.find((a) => ID.test(hrefOf(a)));
    const m = acct ? hrefOf(acct).match(ID) : null;
    // Prefer Opportunity id (006) / data-row-key-value as the stable key — virtual lists recycle DOM nodes, so textContent keys collide across scrolls.
    const oppLink = links.find((a) => OPP.test(hrefOf(a)));
    const oppId = oppLink ? (hrefOf(oppLink).match(OPP) || [])[1] : null;
    const key = r.getAttribute('data-row-key-value') || oppId || r.getAttribute('data-row-number') || (m ? m[1] : null) || hrefOf(links[0]) || (r.textContent || '').trim().slice(0, 80);
    if (!key || seenKey.has(key)) continue;
    seenKey.add(key);
    out.push({ key, accountId: m ? m[1] : null, name: acct ? (acct.textContent || '').trim().replace(/Edit Account Name/gi, '').trim() : null });
  }
  return out;
}

/**
 * Runs IN THE PAGE (passed whole to page.evaluate): locate scroll panes that contain
 * Opportunity/Account row links — never the left app nav. reset=true scrolls the best one to top.
 * → { x, y, h, scrollTop, scrollHeight, clientHeight, links } or null.
 */
function pageScrollTargetInPage(reset) {
  const deepAll = (root, sel, out) => {
    try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (_) {}
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    return out;
  };
  const up = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const ROW_SEL = 'table[role="grid"] tbody tr, div[role="row"], li[role="option"], .slds-split-view__list-item';
  const LINK_SEL = 'a[href*="/Account/"], a[href*="/Opportunity/"], a[href*="/001"], a[href*="/006"]';
  const isScrollable = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) && !/(auto|scroll)/.test(cs.overflow)) return false;
      return el.clientHeight > 40;
    } catch (_) { return false; }
  };
  const rowLinksIn = (el) => {
    try { return deepAll(el, LINK_SEL, []).filter((a) => a.getClientRects && a.getClientRects().length).length; }
    catch (_) { return 0; }
  };
  const score = (el) => {
    if (!el) return -1;
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return -1;
    const links = rowLinksIn(el);
    if (links < 1) return -1;
    let s = links * 20;
    const cls = ((el.className && String(el.className)) || '') + ' ' + (el.tagName || '');
    if (/nav|navigation|tabBar|utilityBar|oneAppNav|slds-nav-vertical|global-header|headerBar/i.test(cls)) s -= 500;
    if (/split-view|splitview|list-view-manager|listviewmanager|forcevirtuallist|virtualList|uiVirtualDataTable|scrollerWrapper|scrollable_y/i.test(cls)) s += 40;
    if (el.getAttribute && /listbox|grid/.test(el.getAttribute('role') || '')) s += 15;
    if (el.scrollHeight > el.clientHeight + 4) s += 25;
    s += Math.min(box.height, 900) / 80;
    return s;
  };
  const preferredSels = [
    '.slds-split-view .slds-scrollable_y', '.slds-split-view .slds-scrollable',
    '.slds-split-view_container .slds-scrollable_y', '.slds-split-view_container .slds-scrollable',
    '.slds-split-view__list-container',
    'lst-list-view-manager .slds-scrollable_y', 'lst-list-view-manager .slds-scrollable',
    'force-list-view-manager-grid .slds-scrollable', '.forceListViewManager .slds-scrollable',
    '.forceVirtualListview', '.forceVirtualTreeGrid',
    'lightning-datatable .slds-scrollable_y', 'lightning-datatable .slds-scrollable',
    '.slds-table_container', '.slds-scrollable_y', '.slds-scrollable', '[role="grid"]',
  ];
  const all = [];
  const seen = new Set();
  const consider = (el) => {
    if (!el || seen.has(el)) return;
    if (!isScrollable(el) && !(el.scrollHeight > el.clientHeight + 4)) return;
    if (score(el) < 0) return;
    seen.add(el);
    all.push(el);
  };
  for (const sel of preferredSels) deepAll(document, sel, []).forEach(consider);
  for (const row of deepAll(document, ROW_SEL, [])) {
    if (!row.getClientRects().length || !row.querySelector(LINK_SEL)) continue;
    let el = up(row);
    while (el) { consider(el); el = up(el); }
  }
  all.sort((a, b) => score(b) - score(a));
  const best = all[0] || null;
  if (reset) {
    if (best) best.scrollTop = 0;
    else window.scrollTo(0, 0);
  }
  if (!best) return null;
  const box = best.getBoundingClientRect();
  const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, innerHeight);
  return {
    x: box.left + Math.min(box.width, Math.max(innerWidth - box.left, 0)) / 2,
    y: top + (bottom - top) / 2,
    h: Math.max(bottom - top, 100),
    scrollTop: Math.round(best.scrollTop || 0),
    scrollHeight: Math.round(best.scrollHeight || 0),
    clientHeight: Math.round(best.clientHeight || 0),
    links: rowLinksIn(best),
  };
}

/**
 * Runs IN THE PAGE: scroll every list scroller that holds row links, bring the last row into view,
 * focus the grid. → coords for a follow-up mouse wheel (no click — clicking opens the record).
 */
function pageScrollStepInPage() {
  const deepAll = (root, sel, out) => {
    try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (_) {}
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    return out;
  };
  const up = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const ROW_SEL = 'table[role="grid"] tbody tr, div[role="row"], li[role="option"], .slds-split-view__list-item';
  const LINK_SEL = 'a[href*="/Account/"], a[href*="/Opportunity/"], a[href*="/001"], a[href*="/006"]';
  const isScrollable = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) && !/(auto|scroll)/.test(cs.overflow)) return false;
      return el.clientHeight > 40;
    } catch (_) { return false; }
  };
  const rowLinksIn = (el) => {
    try { return deepAll(el, LINK_SEL, []).filter((a) => a.getClientRects && a.getClientRects().length).length; }
    catch (_) { return 0; }
  };
  const score = (el) => {
    if (!el) return -1;
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return -1;
    const links = rowLinksIn(el);
    if (links < 1) return -1;
    let s = links * 20;
    const cls = ((el.className && String(el.className)) || '') + ' ' + (el.tagName || '');
    if (/nav|navigation|tabBar|utilityBar|oneAppNav|slds-nav-vertical|global-header|headerBar/i.test(cls)) s -= 500;
    if (/split-view|splitview|list-view-manager|listviewmanager|forcevirtuallist|virtualList|scrollerWrapper|scrollable_y/i.test(cls)) s += 40;
    if (el.scrollHeight > el.clientHeight + 4) s += 25;
    return s + Math.min(box.height, 900) / 80;
  };
  const preferredSels = [
    '.slds-split-view .slds-scrollable_y', '.slds-split-view .slds-scrollable',
    '.slds-split-view_container .slds-scrollable_y', '.slds-split-view_container .slds-scrollable',
    '.slds-split-view__list-container',
    'lst-list-view-manager .slds-scrollable_y', 'lst-list-view-manager .slds-scrollable',
    'force-list-view-manager-grid .slds-scrollable', '.forceListViewManager .slds-scrollable',
    '.forceVirtualListview', '.forceVirtualTreeGrid',
    'lightning-datatable .slds-scrollable_y', 'lightning-datatable .slds-scrollable',
    '.slds-table_container', '.slds-scrollable_y', '.slds-scrollable', '[role="grid"]',
  ];
  const scrollers = [];
  const seen = new Set();
  const consider = (el) => {
    if (!el || seen.has(el)) return;
    if (!isScrollable(el) && !(el.scrollHeight > el.clientHeight + 4)) return;
    if (score(el) < 0) return;
    seen.add(el);
    scrollers.push(el);
  };
  for (const sel of preferredSels) deepAll(document, sel, []).forEach(consider);
  for (const row of deepAll(document, ROW_SEL, [])) {
    if (!row.getClientRects().length || !row.querySelector(LINK_SEL)) continue;
    let el = up(row);
    while (el) { consider(el); el = up(el); }
  }
  scrollers.sort((a, b) => score(b) - score(a));
  const rows = deepAll(document, ROW_SEL, []).filter((r) => r.getClientRects().length && r.querySelector(LINK_SEL));
  const lastRow = rows[rows.length - 1] || null;
  if (lastRow) {
    try { lastRow.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' }); } catch (_) {
      try { lastRow.scrollIntoView(false); } catch (__) {}
    }
  }
  let moved = false, atBottom = false;
  for (const el of scrollers) {
    const before = el.scrollTop;
    const stepPx = Math.max(120, Math.floor((el.clientHeight || 300) * 0.8));
    el.scrollTop = before + stepPx;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    try { el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: stepPx, deltaMode: 0 })); } catch (_) {}
    if (el.scrollTop !== before) moved = true;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) atBottom = true;
  }
  const best = scrollers[0] || null;
  const box = best ? best.getBoundingClientRect() : null;
  let lastBox = null;
  if (lastRow) {
    const b = lastRow.getBoundingClientRect();
    lastBox = { x: b.left + b.width / 2, y: Math.min(Math.max(b.top + b.height / 2, 8), innerHeight - 8) };
  }
  const grid = document.querySelector('table[role="grid"], [role="grid"]');
  if (grid && grid.focus) try { grid.focus({ preventScroll: true }); } catch (_) {}
  const top = box ? Math.max(box.top, 0) : 0;
  const bottom = box ? Math.min(box.bottom, innerHeight) : innerHeight;
  return {
    moved,
    atBottom,
    candidates: scrollers.length,
    lastBox,
    x: box ? box.left + Math.min(box.width, Math.max(innerWidth - box.left, 0)) / 2 : (lastBox ? lastBox.x : innerWidth / 2),
    y: box ? top + (bottom - top) / 2 : (lastBox ? lastBox.y : innerHeight / 2),
    h: box ? Math.max(bottom - top, 100) : 400,
    scrollTop: best ? Math.round(best.scrollTop || 0) : 0,
    scrollHeight: best ? Math.round(best.scrollHeight || 0) : 0,
    links: best ? rowLinksIn(best) : 0,
  };
}

/** Where the list scrolls: only a pane that contains Account/Opportunity rows. resetTop scrolls it to the top. → { x, y, h, … } or null. */
async function pageScrollTarget(page, resetTop = false) {
  try { return await page.evaluate(pageScrollTargetInPage, resetTop); } catch (_) { return null; }
}

/**
 * One advance of the open list view. Tries every strategy Salesforce actually responds to:
 *   1) scrollIntoView on the last data row
 *   2) bump scrollTop on EVERY scroller that contains row links (not the app nav)
 *   3) real mouse wheel over the last row (no click — a click would open the record)
 *   4) ArrowDown / PageDown / End on the focused grid
 * → { moved, atBottom, … }
 */
async function scrollListViewStep(page, { escalate = false } = {}) {
  let info = null;
  try { info = await page.evaluate(pageScrollStepInPage); } catch (_) { info = null; }

  // Playwright scrollIntoView on the last grid row — drives the same virtual scroller a person nudges.
  try {
    const last = page.locator('table[role="grid"] tbody tr, [role="grid"] [role="row"], .slds-split-view__list-item').last();
    if (await last.count()) await last.scrollIntoViewIfNeeded({ timeout: 1200 });
  } catch (_) {}

  // Wheel over the last row (or the scroller centre). Do NOT click — that opens the opportunity.
  const wx = info && info.lastBox ? info.lastBox.x : (info ? info.x : 400);
  const wy = info && info.lastBox ? info.lastBox.y : (info ? info.y : 400);
  try {
    await page.mouse.move(wx, wy);
    const delta = Math.max(280, Math.floor(((info && info.h) || 400) * 0.85));
    await page.mouse.wheel(0, delta);
    await page.mouse.wheel(0, Math.floor(delta * 0.6));
    if (escalate) {
      await page.mouse.wheel(0, delta);
      await page.mouse.wheel(0, delta);
    }
  } catch (_) {}

  // Keyboard walk: Salesforce loads the next virtual rows as selection moves down the grid.
  try {
    const presses = escalate ? 24 : 10;
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press('ArrowDown');
      if (i % 5 === 4) await sleep(50);
    }
    await page.keyboard.press('PageDown');
    if (escalate) {
      await page.keyboard.press('PageDown');
      await page.keyboard.press('End');
    }
  } catch (_) {}

  // Also run the older incremental scroller (shadow-DOM aware) when we are stuck mid-list.
  if (escalate) {
    try { await scrollList(page); } catch (_) {}
  }

  // Some list layouts use an explicit "Load More" control instead of infinite scroll.
  try {
    const more = page.getByRole('button', { name: /load more|show more|view more/i }).first();
    if (await more.count() && await more.isVisible().catch(() => false)) {
      await more.click({ timeout: 1500 }).catch(() => {});
      if (info) info.moved = true;
    }
  } catch (_) {}

  return info || { moved: true, atBottom: false };
}

/**
 * Harvest the accounts of the open LIST VIEW → [{ name, accountId, url }] in list order, one per account (an Opportunities list has a row per opportunity, so an account can repeat).
 * Scrolls the list's own pane (a scroller that contains Account/Opportunity links — never the app nav), using scrollTop, mouse wheel over the last row, and ArrowDown/PageDown so Salesforce's
 * lazy / virtual loader keeps fetching. Keeps going until the list header's count is reached, opts.limit, or a long stall. Carries rowsSeen, listTotal, stopped on the array.
 */
async function harvestListLeads(page, opts = {}) {
  const limit = opts.limit || null, maxMs = opts.maxMs || 8 * 60 * 1000;
  const origin = new URL(page.url()).origin;
  const tot = await readListTotal(page);
  const seen = new Map(), keys = new Set();
  let stopped = null, stalls = 0, noAccount = 0, shown = 0;
  const t0 = Date.now(); let lastFreshAt = t0;
  commandLog('📇', 'Harvest scroll', tot
    ? `scrolling the list until all ${tot.total}${tot.plus ? '+' : ''} row(s) are loaded…`
    : 'scrolling the list (wheel + ArrowDown) to load every row…');
  const target = await pageScrollTarget(page, true);
  if (target) commandLog('🗺️', 'List pane', `scroller ready · ${target.links || '?'} link(s) in view · ${target.clientHeight}px tall`);
  else commandLog('⚠️', 'List pane', 'could not pin a list scroller yet — will keep trying with keyboard/wheel');
  await sleep(500);
  for (let step = 0; step < 4000; step++) {
    let fresh = 0;
    let rows = []; try { rows = await page.evaluate(pageReadRows); } catch (_) {}
    for (const r of rows) {
      if (keys.has(r.key)) continue;
      keys.add(r.key); fresh++;
      if (!r.accountId) { noAccount++; continue; }
      if (!seen.has(r.accountId)) seen.set(r.accountId, { name: r.name || '(unnamed account)', accountId: r.accountId, url: `${origin}/lightning/r/Account/${r.accountId}/view` });
    }
    if (fresh) { stalls = 0; lastFreshAt = Date.now(); } else stalls++;
    if (keys.size - shown >= 10 || (fresh && keys.size !== shown)) {
      shown = keys.size;
      commandLog('🗺️', 'Reading list', `${keys.size}${tot ? ` of ${tot.total}${tot.plus ? '+' : ''}` : ''} rows read, ${seen.size} accounts so far`);
    }
    if (limit && seen.size >= limit) { stopped = 'limit'; break; }
    if (tot && tot.sure && !tot.plus && keys.size >= tot.total && stalls >= 1) { stopped = 'complete'; break; }
    if (Date.now() - t0 > maxMs) { stopped = 'time'; break; }
    const underTotal = tot && !tot.plus && keys.size < tot.total;
    const stallLimit = underTotal ? 20 : 8;
    const stallMs = underTotal ? 25000 : 7000;
    if (stalls >= stallLimit && Date.now() - lastFreshAt > stallMs) {
      stopped = keys.size ? (underTotal ? 'stalled' : 'complete') : 'no-rows';
      break;
    }
    const escalate = stalls >= 3 || (underTotal && stalls >= 1 && step > 5);
    await scrollListViewStep(page, { escalate });
    await sleep(escalate ? 650 : 350);
    try { await page.waitForSelector('.slds-spinner, .slds-spinner_container', { state: 'hidden', timeout: 8000 }); } catch (_) {}
    if (fresh === 0 && underTotal) await sleep(500);
  }
  let out = [...seen.values()];
  if (limit) out = out.slice(0, limit);
  out.rowsSeen = keys.size; out.listTotal = tot ? tot.total : null; out.listTotalPlus = tot ? tot.plus : false; out.rowsWithoutAccount = noAccount; out.stopped = stopped || 'complete';
  if (!out.length && !keys.size) {
    const old = await harvestListLeadsOld(page, opts);
    old.rowsSeen = null; old.listTotal = tot ? tot.total : null; old.listTotalPlus = tot ? tot.plus : false; old.stopped = 'fallback';
    return old;
  }
  return out;
}

/** The tail of the "accounts harvested" line: how many rows were read and what the list's own header says. */
function harvestSummary(leads) {
  return `${leads.rowsSeen != null ? ` from ${leads.rowsSeen} row${leads.rowsSeen === 1 ? '' : 's'}` : ''}${leads.listTotal ? ` (the list says ${leads.listTotal}${leads.listTotalPlus ? '+' : ''} items)` : ''}`;
}

/** After a list-view harvest: say plainly when fewer rows were read than the list has (not when the run asked for only the first N accounts), or when the rows have no Account link. */
function warnShortHarvest(leads) {
  if (leads.rowsSeen == null) return;
  const why = { stalled: 'the list stopped loading more rows', time: 'it ran out of time', 'no-rows': 'no rows were found' }[leads.stopped] || leads.stopped;
  if (leads.stopped !== 'limit' && leads.listTotal && !leads.listTotalPlus && leads.rowsSeen < leads.listTotal) console.log(`\n  ⚠️  Only ${leads.rowsSeen} of the list's ${leads.listTotal} rows were read (${why}). In Chrome, scroll the list sidebar / grid all the way down until it shows ${leads.listTotal} rows, then run this again.\n`);
  if (leads.rowsSeen > 0 && !leads.length) console.log(`\n  ⚠️  ${leads.rowsSeen} rows were read but none has an Account link. Add the "Account Name" column to this list view (the email is sent from the account), then run again.\n`);
  else if (leads.rowsWithoutAccount) console.log(`  ℹ️  ${leads.rowsWithoutAccount} row(s) had no Account link and were left out.`);
}

/**
 * The EARLIER way to harvest the accounts of a LIST VIEW: scroll with scrollList and read the rows after each round. Kept as the fallback of harvestListLeads. Pass opts.limit to STOP EARLY once that many
 * accounts are collected. (Report mode uses harvestReportLeads instead.)
 */
async function harvestListLeadsOld(page, opts = {}) {
  const limit = opts.limit || null;
  const origin = new URL(page.url()).origin;
  // Pick whichever row selector actually matches this list view (table-grid vs the
  // div-based enhanced grid), rather than assuming the first one.
  const rowSel = (await bestRowSelector(page)).sel;
  const seen = new Map(); // accountId (or href) -> lead, insertion order = list order
  let stable = 0;
  for (let round = 0; round < 400; round++) {
    const rows = page.locator(rowSel);
    const count = await rows.count();
    const before = seen.size;
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const link = await findAccountLink(row);
      if (!link) continue;
      let href = null;
      try { if ((await link.count()) === 0) continue; href = await link.getAttribute('href'); } catch (_) { continue; }
      if (!href) continue;
      const m = href.match(/(001[A-Za-z0-9]{12,15})/);
      const accountId = m ? m[1] : null;
      const key = accountId || href;
      if (seen.has(key)) continue;
      let name = null;
      try { name = ((await link.innerText({ timeout: 1500 })) || '').trim().replace(/Edit Account Name/gi, '').trim(); } catch (_) {}
      seen.set(key, {
        name: name || '(unnamed account)',
        accountId,
        url: accountId ? `${origin}/lightning/r/Account/${accountId}/view` : null,
      });
    }
    // Stop as soon as we have enough for the requested range — don't scan the rest.
    if (limit && seen.size >= limit) break;
    const grew = seen.size > before;
    const changed = await scrollList(page); // incremental scroll + wait for lazy load
    if (!grew && !changed) { stable++; if (stable >= 2) break; }
    else stable = 0;
  }
  // Only keep rows we can actually open (need an Account id → record URL).
  let out = [...seen.values()].filter((l) => l.url);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** Emails already sent today (local day), from the outreach log. */
function emailsSentToday() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return textLog.readAll().filter((r) => r.channel === 'email' && new Date(r.at) >= midnight).length;
}

/**
 * Cadence intake: take harvested leads → de-duplicate (the same account twice in a scan, or as its 15- and 18-character id), drop the ones
 * that must never get this email (banned, closed-won, current customers), keep only accounts DUE a touch (`--step N` = only those due touch N,
 * e.g. --step 1 to bring every new lead to touch 1), furthest-along first. `knownBefore` = ids that were already in our system before this scan.
 * Logs a one-line breakdown. → the filtered leads (keeps `.source`).
 */
function prepareCadenceLeads(leads, args, knownBefore = null) {
  const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
  const seen = new Set(); const uniq = []; let dupes = 0, noId = 0;
  for (const l of leads) { const k = k15(l.accountId); if (!k) { noId++; continue; } if (seen.has(k)) { dupes++; continue; } seen.add(k); uniq.push(l); }
  const isNew = knownBefore ? uniq.filter((l) => !knownBefore.has(k15(l.accountId))).length : null;
  const won = textLog.readClosedWon(), cust = textLog.readCurrentCustomers(), bans = textLog.readBans(), green = textLog.readGreen();
  let nBan = 0, nWon = 0, nCust = 0, nRecheck = 0;
  const kept = uniq.filter((l) => {
    if (textLog.isBanned(l.accountId, bans, green)) { nBan++; return false; }
    if (won.has(k15(l.accountId)) || won.has(String(l.accountId).toLowerCase())) { nWon++; return false; }
    const held = cust.get(k15(l.accountId)) || cust.get(String(l.accountId).toLowerCase());
    if (held) {
      if (!held.unverified) { nCust++; return false; }
      l.heldAsCustomer = held.status || 'Enrolled';      // held before the free-plan check existed: let it through so the email run looks again (it is never emailed unless the page proves it is free)
      nRecheck++;
    }
    return true;
  });
  const st = emailSequence.status(kept, { minDays: args.days });
  const order = new Map(); Object.entries(st.dueIds).forEach(([step, ls]) => ls.forEach((l) => order.set(l.accountId, Number(step))));
  let due = kept.filter((l) => order.has(l.accountId));
  if (args.step) due = due.filter((l) => order.get(l.accountId) === args.step);
  due.sort((a, b) => order.get(b.accountId) - order.get(a.accountId));
  due.source = leads.source;
  const heldN = kept.length - order.size;
  commandLog('🧮', 'Intake', `${leads.length} read → ${dupes + noId ? `${dupes} duplicate${dupes === 1 ? '' : 's'}${noId ? ` + ${noId} without an id` : ''} removed → ` : ''}${uniq.length} unique${isNew != null ? ` (${isNew} new to our system, ${uniq.length - isNew} already known)` : ''}`);
  commandLog('🚫', 'Never emailed', `${nBan} banned · ${nWon} closed-won · ${nCust} current customers removed`);
  if (nRecheck) commandLog('🔎', 'Re-checking', `${nRecheck} account${nRecheck === 1 ? '' : 's'} held as current customers before the free-plan check: Salesforce is asked again, and only one whose Closed Won opportunities are all Invoicing and Payments is released`);
  commandLog('🔁', 'Cadence', `${due.length} due ${args.step ? `touch ${args.step}` : 'a touch'} now${heldN ? ` · ${heldN} held (replied / too soon / finished)` : ''}${args.step ? ` · ${order.size - due.length} due a different touch (left for later)` : ' — furthest-along first'}`);
  return due;
}

/**
 * --never-emailed (a ONE-OFF email such as --email-template curiosity; the --core sequence picks its own people, and --core --step 1 is its never-emailed group): only the accounts we have
 * NEVER emailed. It is the cadence intake with --step 1 (duplicates out, banned / closed-won / current customers out, and only accounts with no email of ANY kind in the log: any template,
 * any date), plus one more hold: an account that has REPLIED to us is left for you (a person should take it from here). Every send is logged, so running the same command again carries on
 * with whoever is left: no --range bookkeeping between runs of 300. An account that had NO email address when we last opened it (the run says "no recipient": nothing is sent or logged for it, so
 * it would head the list on every run) is left out for good (Luke, 2026-10-29: no email address, no email); --retry-skipped asks again, and an address a report saved since counts as a reason to try again.
 * → the leads (keeps `.source`; `.heldReplied` = the ones left out for a reply, `.noAddress` = the ones left out for having no address).
 */
function prepareNeverEmailedLeads(leads, args) {
  const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
  const first = prepareCadenceLeads(leads, { ...args, step: 1 });      // touch 1 is due only for an account with no email row at all (a legacy email without a step counts as touch 1)
  const replied = new Set(textLog.readReplyRows().filter((r) => r && r.accountId).map((r) => k15(r.accountId)));
  const tried = args.retrySkipped ? new Set() : noRecipientAccounts();      // the account page had no email address when we opened it
  const keep = first.filter((l) => !replied.has(k15(l.accountId)) && !tried.has(k15(l.accountId)));
  keep.source = first.source;
  keep.heldReplied = first.filter((l) => replied.has(k15(l.accountId)));
  keep.noAddress = first.filter((l) => !replied.has(k15(l.accountId)) && tried.has(k15(l.accountId)));
  commandLog('🆕', 'First email', `${keep.length} account${keep.length === 1 ? '' : 's'} we have never emailed${keep.heldReplied.length ? ` · ${keep.heldReplied.length} replied to us and are left for you: ${keep.heldReplied.slice(0, 8).map((l) => l.name).join(', ')}${keep.heldReplied.length > 8 ? ', …' : ''}` : ''}${keep.noAddress.length ? ` · ${keep.noAddress.length} had no email address when we last opened them and are left out for good (--retry-skipped tries them again)` : ''}`);
  return keep;
}

/**
 * Accounts whose last email attempt ended "no recipient": the account page offered no address to click and none was typed in (emailAccount.js saves email-debug/<id>.json for it, one file per
 * account, and nothing deletes it). Nothing is sent or logged for such an account, so a never-emailed list would put it first again on every run; Luke's rule is no address, no email, so it is
 * left out for good. → Set of 15-character ids, minus any account a report has given an address since (that one is worth another try).
 */
function noRecipientAccounts() { return textLog.noRecipientAccounts(); }      // (the code moved to textLog.js unchanged: the follow-up board skips the email stages of these same accounts, cadence.js)

/** --email --inspect : harvest and print who would be emailed (no sending). */
function inspectEmailLeads(leads, howMany = 10, opts = {}) {
  const dailyGuardOn = opts.dailyGuardOn !== false; // report sources pass false
  const emailedToday = leads.filter((l) => textLog.emailedWithinHours(l.accountId, 24)).length;
  console.log(`\nAccounts harvested for email: ${leads.length}`);
  if (dailyGuardOn) console.log(`  ${emailedToday} already emailed in the last 24h (would be skipped) • ${leads.length - emailedToday} to send\n`);
  else console.log(`  Report source: daily "already emailed" guard is OFF — all ${leads.length} would send (${emailedToday} were emailed in the last 24h).\n`);
  leads.slice(0, howMany).forEach((l, i) => {
    const prior = textLog.emailedWithinHours(l.accountId, 24);
    const flag = prior ? `  ⏭️ emailed ${Math.max(1, Math.round((Date.now() - new Date(prior.at).getTime()) / 3600000))}h ago${dailyGuardOn ? ', SKIP' : ' (guard off)'}` : '';
    console.log(`  ${String(i + 1).padStart(3)}. ${l.name}${flag}`);
    console.log(`       account id : ${l.accountId}`);
    console.log(`       record url : ${l.url}`);
  });
  if (leads.length > howMany) console.log(`  ... and ${leads.length - howMany} more`);
  console.log('');
}

/**
 * Email the harvested leads over the requested range in one pass. Mirrors
 * runReportCampaign (contact guard, skip-on-Enter, summary) but sends email via
 * emailAccount() instead of a text. dryRun opens + fills each composer but never
 * clicks Send.
 */
async function runEmailCampaign(page, leads, o) {
  const { emailAccount } = require('./emailAccount'); // lazy to avoid circular require
  // --auto passes lead.subject / lead.body per account; everyone else shares o.subject / o.body.
  const subject = o.subject || '(custom subject per account)';
  const body = o.body || '';
  const start = o.start;
  const end = o.end;
  const delayMs = o.delayMs;
  const dryRun = !!o.dryRun;
  const historyTemplateName = o.templateName || 'Email first-touch';
  const historyTemplateKey = o.templateKey || createTemplateKey('email', historyTemplateName, `${subject}\n${body}`);
  const contactHistory = new ContactHistory();
  const reportEmails = textLog.readReportEmails();   // each account's own Contact: Email from its last report scan — the address to fall back on when the account page has none

  if (!leads.length) throw new Error('no accounts harvested to email');

  const defaultSource = o.source || leads.source || null;   // the report these accounts came from (LDS / Shark)
  const seen = leads.map((l) => l.name);
  const done = new Map();
  let sentCount = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 10;
  const campaignStart = new Date();
  const last = end == null ? leads.length : Math.min(end, leads.length);
  const runCap = Math.min(CONFIG.emailMaxPerRun, o.maxPerRun || Infinity);
  const sentTodayAtStart = dryRun ? 0 : emailsSentToday();
  const dayLeft = Math.max(0, CONFIG.emailMaxPerDay - sentTodayAtStart);
  const sendBudget = Math.min(runCap, dayLeft);
  let capHit = null;

  let skipRequested = false;
  const skipReader = readline.createInterface({ input: process.stdin, terminal: false });
  skipReader.on('line', () => { skipRequested = true; commandLog('⏭️', 'Skip queued', 'Current lead will be bypassed'); });

  console.log(`\n${'╔' + '═'.repeat(62) + '╗'}`);
  console.log(`║  ${dryRun ? '🧪 EMAIL COMMAND (DRY-RUN — no send)' : '🚀 EMAIL COMMAND ONLINE'}`.padEnd(64) + '║');
  console.log(`║  ✉️  Subject: ${subject.substring(0, 42)}${subject.length > 42 ? '…' : ''}`.padEnd(64) + '║');
  console.log(`║  🎯 Range: ${start}-${end || 'END'} of ${leads.length}`.padEnd(65) + '║');
  console.log('║  ⏭️  Press Enter to skip the active lead'.padEnd(64) + '║');
  if (!dryRun) console.log(`║  🚦 Caps: ${runCap}/run · ${CONFIG.emailMaxPerDay}/day (${sentTodayAtStart} sent today → ${sendBudget} can go now)`.padEnd(64) + '║');
  if (o.force) console.log('║  ⚠️  NO-GUARDS (--force) — all email dedup OFF'.padEnd(64) + '║');
  else if (o.skipDailyGuard) console.log('║  ℹ️  Report source — daily "already emailed" guard OFF'.padEnd(64) + '║');
  console.log('╚' + '═'.repeat(62) + '╝');

  for (let pos = start; pos <= last; pos++) {
    if (o.shouldStop && o.shouldStop()) { commandLog('🛑', 'Stopped', 'asked to stop — the rest of this batch is left for the next run'); break; }      // --board: a cap, Ctrl-C or a frozen tab
    const lead = leads[pos - 1];
    if (!lead) continue;
    if (o.canSend) { const why = o.canSend(lead); if (why) { done.set(lead.name, `SKIPPED: outside the contact's hours (${why})`); commandLog('⏰', 'Hours', `${lead.name} — closed for this contact (${why}); not emailed, left for its next window`); continue; } }      // --board: each lead's own texting hours, checked as the sender reaches it
    if (!dryRun && sentCount >= sendBudget) {
      capHit = sentCount >= runCap ? `per-run cap of ${runCap}` : `daily cap of ${CONFIG.emailMaxPerDay} (${sentTodayAtStart} already sent today)`;
      commandLog('🚦', 'Send cap reached', `${capHit} — stopping. The rest are left untouched and will be due next run.`);
      break;
    }
    const ident = lead.name;
    // Fill {{business}} / {{greeting}} / {{industry}} / {{firstName}} from the account name (no-op for plain templates).
    let leadSubject = lead.subject || subject;
    let leadBody = lead.body != null ? lead.body : body;
    if (emailPersonalize.hasTokens(leadSubject) || emailPersonalize.hasTokens(leadBody)) {
      try {
        const p = emailPersonalize.render({ subject: leadSubject, body: leadBody }, ident);
        leadSubject = p.subject; leadBody = p.body;
        commandLog('✍️', 'Personalized', `${ident} → ${p.profile.business || p.profile.firstName || '(generic greeting)'}${p.profile.industry ? ' • ' + p.profile.industry : ''}${p.profile.industryAsset ? ' • 📎 ' + p.profile.industryAsset : ''}`);
      } catch (e) { done.set(ident, `SKIPPED: personalization failed — ${e.message}`); commandLog('⛔', 'Personalize', `${ident} — ${e.message}; not emailed`); continue; }
    }
    let leadBodyHtml = null;
    if (o.library) {
      // --library: trade-matched, hyperlinked email from the content library (contentPicker.js), personalized by account name/industry.
      try {
        const e = contentPicker.buildEmail(ident, { stage: o.contentStage });
        const sigHtml = signatureHtml();
        leadSubject = e.subject;
        leadBody = e.bodyText.replace('[Your name]', EMAIL_SIGNATURE);
        leadBodyHtml = e.bodyHtml.replace('[Your name]', sigHtml);
        commandLog('📚', 'Library content', `${e.picked.label || 'generic'} → ${e.picked.assets.map((a) => a.id).join(', ')}`);
      } catch (err) { done.set(ident, `SKIPPED: content library failed — ${err.message}`); commandLog('⛔', 'Content', `${ident} — ${err.message}; not emailed`); continue; }
    }
    // --sequence: this account's NEXT touch of the 6-step campaign (emailSequence.js): one feature + a different story each time.
    let leadStep = null;
    if (o.sequence) {
      const t = emailSequence.nextTouch(lead.accountId, { minDays: o.minDays, ignoreReplies: !!o.ignoreReplies });
      if (t.hold) { done.set(ident, `SKIPPED: sequence — ${t.hold}`); commandLog('⏳', 'Sequence hold', `${ident} — ${t.hold}`); continue; }
      leadStep = t.step;
      if (lead.wantTemplate) {
        // --board, a stage that sends a named email (cadence.js `emailTemplate`): the board counted this lead's emails and decided this is Email N, so the library's own touch number need not agree with it (a lead with two older one-off emails logged
        // without a step reads as touch 2 here and would never get Email 3). The row is logged as touch N, so the sequence stays in step from here on. The content is the named email: plain text, personalized and signed like the same email sent from the menu.
        leadStep = lead.wantStep || t.step;
        try {
          const nt = namedEmailTemplate(lead.wantTemplate);
          const p = emailPersonalize.render({ subject: nt.subject, body: nt.body }, ident);
          leadSubject = p.subject; leadBody = p.body; leadBodyHtml = null;
          commandLog('🔁', `Sequence touch ${leadStep}`, `${ident} → ${nt.name} (plain text)`);
        } catch (err) { done.set(ident, `SKIPPED: email "${lead.wantTemplate}" failed — ${err.message}`); commandLog('⛔', 'Sequence', `${ident} — ${err.message}; not emailed`); continue; }
      }
      if (!lead.wantTemplate && lead.wantStep && t.step !== lead.wantStep) { done.set(ident, `SKIPPED: sequence — its next touch is ${t.step}, this run is sending touch ${lead.wantStep}`); commandLog('⏳', 'Sequence', `${ident} — next touch is ${t.step}, not ${lead.wantStep}; left for its own turn`); continue; }      // --board: only the stage it was picked for
      if (!lead.wantTemplate) {
        try {
          const e = emailSequence.buildTouch(ident, t.step, { stage: o.contentStage });
          const sigHtml = signatureHtml();
          leadSubject = e.subject;
          leadBody = e.bodyText.replace('[Your name]', EMAIL_SIGNATURE);
          leadBodyHtml = e.bodyHtml.replace('[Your name]', sigHtml);
          commandLog('🔁', `Sequence touch ${t.step}`, `${ident} → ${e.name} (${e.asset ? e.asset.id : 'no link'})`);
        } catch (err) { done.set(ident, `SKIPPED: sequence touch ${t.step} failed — ${err.message}`); commandLog('⛔', 'Sequence', `${ident} — ${err.message}; not emailed`); continue; }
      }
    }
    const leadTemplateKey = (lead.subject || leadStep) ? createTemplateKey('email', historyTemplateName + (leadStep ? ` touch ${leadStep}` : ''), `${leadSubject}\n${leadBody}`) : historyTemplateKey;

    if (textLog.isBanned(lead.accountId)) { done.set(ident, 'SKIPPED: on the banlist'); commandLog('🚫', 'Banlist', `${ident} — never contacted (banlist)`); continue; }

    missionBanner(pos, end, ident);

    if (o.skipPositions && o.skipPositions.has(pos)) {
      commandLog('⏭️', 'Lead bypassed', `Row ${pos} is on the skip list`);
      done.set(ident, 'SKIPPED (skip list)');
      continue;
    }

    if (skipRequested) {
      skipRequested = false;
      commandLog('⏭️', 'Lead bypassed', `Row ${pos} skipped by operator`);
      done.set(ident, 'SKIPPED (user)');
      continue;
    }

    // NEVER THE SAME EMAIL TWICE: a lead who already got this exact email (the same subject and body, or the same --sequence touch), however long ago, is not emailed it
    // again. The contact ledger only remembers ~48 hours; texted-log.jsonl is the permanent memory. NOT bypassed by --force (a --dry-run applies it too, so the preview is true).
    const sameMail = textLog.sentSameMessage(lead.accountId, 'email', { templateName: leadStep ? historyTemplateName : null, subject: leadSubject, body: leadBody, step: leadStep });
    if (sameMail) {
      done.set(ident, `SKIPPED: already got this exact email ${formatAge(sameMail.at)} — never the same email twice`);
      commandLog('🛡️', 'Same-email guard', `${ident} — already got this exact email ${formatAge(sameMail.at)}${sameMail.count > 1 ? ` (${sameMail.count} times)` : ''} — never the same email twice`);
      continue;
    }

    // Once-per-day EMAIL guard (durable): skip anyone we've already emailed in the last
    // 24h. ALWAYS ON (these emails don't log to the SF timeline, so reports can't filter
    // already-emailed leads — this durable guard is the only dedup). Bypassed only by
    // --force, or if a caller explicitly passes skipDailyGuard (not done automatically).
    if (!dryRun && !o.force && !o.skipDailyGuard) {
      const priorEmail = textLog.emailedWithinHours(lead.accountId, 24);
      if (priorEmail) {
        const hrs = Math.max(1, Math.round((Date.now() - new Date(priorEmail.at).getTime()) / 3600000));
        done.set(ident, `SKIPPED: already emailed ${hrs}h ago (once-per-day guard)`);
        commandLog('🛡️', 'Daily email guard', `HOLD — already emailed ${hrs}h ago (<24h)`);
        continue;
      }
    }

    // Contact-history reserve (skipped entirely in --force; the report's own filter is
    // trusted). When forced we send without reserving; the outreach log still records it.
    let historyReservationId = null;
    if (!o.force) {
      let guard;
      try {
        guard = contactHistory.reserve({
          contactId: lead.accountId ? `salesforce-account:${lead.accountId}` : `label:${ident}`,
          aliases: [`label:${ident}`],
          contactLabel: ident,
          channel: 'email',
          templateKey: leadTemplateKey,
          templateName: historyTemplateName,
          content: `${leadSubject}\n${leadBody}`,
          source: 'Assistant (email)',
          // Email is a paired follow-up channel: a recent TEXT must NOT block the
          // email (the 48h recent-contact cooldown is cross-channel). cooldownHours:0
          // bypasses that while STILL blocking the same email going out twice
          // (same_template) and any active reservation for this contact.
          cooldownHours: 0,
        });
      } catch (historyError) {
        commandLog('⛔', 'Contact guard offline', historyError.message);
        commandLog('🛑', 'Campaign halted', 'No unverified outreach will be sent');
        skipReader.close();
        return summarize({ message: subject, start, end, seen, done, sentCount, campaignStart });
      }
      logContactGuard(guard);
      if (!guard.allowed) {
        const reason = contactGuardReason(guard);
        done.set(ident, `SKIPPED: CONTACT GUARD — ${reason}`);
        commandLog('⏭️', 'Lead protected', reason);
        continue;
      }
      historyReservationId = guard.reservationId;
    }
    try {
      if (!lead.url) throw new Error('could not resolve account url');

      commandLog('🧭', 'Account route', `Opening ${ident}`);
      // An account page with no address on it cannot address the composer; the pro's own Contact: Email from the report can. Only used then — an address the page offers still wins.
      const fallbackEmail = lead.email ? null : (textLog.emailOfLead(lead) || (reportEmails.get(String(lead.accountId || '').toLowerCase().slice(0, 15)) || {}).email || null);
      // The plan check of an "Enrolled" account (emailAccount.js → customerPlan.js) is saved the moment it is known, whatever happens to the email after it.
      const onPlan = (p) => {
        try { textLog.recordCurrentCustomer({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, status: p.status, source: lead.source || defaultSource, ...(p.record || {}) }); } catch (_) {}
        if (p.verdict === 'coaching') commandLog('🎓', 'Business coaching', `${ident} — Customer Status (beta) is ${p.status}, and ${p.why}; ${require('./coachingPolicy').held() ? 'business coaching is a different department: not listed as a customer, and NOT emailed (coachingPolicy.js, until coaching-policy.json says otherwise)' : 'a Business Coaching Lead, not a current customer, so it is not held back'}`);
        if (p.verdict === 'free-plan') commandLog('🆓', 'Free plan', `${ident} — Customer Status (beta) is ${p.status}, but ${p.why}; not a current customer, so it is not held back`);
      };
      const result = await emailAccount(page, { accountName: ident, accountUrl: lead.url, subject: leadSubject, body: leadBody, bodyHtml: leadBodyHtml, toEmail: lead.email || null, fallbackEmail }, { dryRun, onPlan, heldAsCustomer: lead.heldAsCustomer || null });

      if (result.status === 'current-customer') {
        if (historyReservationId) { try { contactHistory.cancelReservation(historyReservationId, 'current customer'); } catch (_) {} historyReservationId = null; }
        if (!result.plan) { try { textLog.recordCurrentCustomer({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, status: result.customerStatus, source: lead.source || defaultSource }); } catch (_) {} }   // (a plan check saves its own verdict, through onPlan)
        const coachSkip = !!(result.plan && result.plan.verdict === 'coaching');      // business coaching: a different department, not a "current customer" but never emailed (coachingPolicy.js)
        done.set(ident, `SKIPPED: ${coachSkip ? 'business coaching' : 'current customer'} (Customer Status: ${result.customerStatus})`);
        commandLog(coachSkip ? '🎓' : '🤝', coachSkip ? 'Business coaching' : 'Current customer', `${ident} — Customer Status (beta) is ${result.customerStatus}${result.plan && result.plan.why ? ` — ${result.plan.why}` : ''}; not emailed`);
        continue;
      }
      // Held as a customer before the plan check, and its page now says it is not one (Canceled, Terminated, blank): write that down so it stops being held.
      if (lead.heldAsCustomer && result.customerStatus && result.customerStatus.found && !/^\s*enrolled\b/i.test(result.customerStatus.value || '')) {
        try { textLog.recordCurrentCustomer({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, status: result.customerStatus.value || '(blank)', source: lead.source || defaultSource }); } catch (_) {}
      }
      if (result.customerStatus && !result.customerStatus.found) {
        commandLog('⚠️', 'Customer Status', `${ident} — "Customer Status (beta)" field not found on the page; could not verify (written down in status-checks.jsonl: node statusChecks.js lists them)`);
        try { require('./statusChecks').record({ via: 'send', accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, source: lead.source || defaultSource, found: false, emailed: !dryRun }); } catch (_) {}
      }
      if (dryRun) {
        // Nothing was sent — release the reservation so a later real run isn't blocked.
        try { contactHistory.cancelReservation(historyReservationId, 'dry-run'); } catch (_) {}
        historyReservationId = null;
        const bodyNote = result.bodyOk === false ? ' ⚠️ BODY DID NOT REGISTER' : (result.bodyChars != null ? ` • body ${result.bodyChars} chars${result.editorVerified === false ? ' • editor data not readable (checked the page only)' : result.editorVerified ? ' • confirmed in the editor data' : ''}${result.htmlUsed ? ' • links are clickable' : (o.sequence || o.library) ? ' • PLAIN TEXT (clickable links could not be confirmed)' : ''}` : '');
        const viaReport = result.recipientFrom === 'report' ? ' (typed in from the report)' : '';
        done.set(ident, `DRY-RUN drafted${result.recipient ? ` → ${result.recipient}${viaReport}` : ' (no recipient detected)'}${bodyNote}`);
        commandLog('🧪', 'Draft ready', `${result.recipient ? `would send to ${result.recipient}${viaReport}` : 'composer filled (recipient blank)'}${bodyNote}${result.debug ? ` • page saved: ${result.debug}` : ''}`);
        consecutiveFailures = 0;
        await sleep(delayMs);
        continue;
      }

      if (result.status === 'sent') {
        // In --force there's no reservation to finalize (guard was skipped).
        if (historyReservationId) {
          try {
            contactHistory.recordDelivery(historyReservationId);
            historyReservationId = null;
            commandLog('💾', 'History recorded', 'Email delivery added to shared ledger');
          } catch (historyError) {
            done.set(ident, `SENT: HISTORY ERROR — ${historyError.message}`);
            sentCount++;
            commandLog('⛔', 'History write failed', 'Email sent; campaign stopping to prevent duplicates');
            skipReader.close();
            return summarize({ message: subject, start, end, seen, done, sentCount, campaignStart });
          }
        }
        done.set(ident, 'sent');
        sentCount++;
        consecutiveFailures = 0;
        if (o.onSent) { try { await o.onSent(lead); } catch (_) {} }      // --board: progress, so a frozen tab is noticed
        commandLog('🏁', 'Mission complete', `Email sent to ${ident}${result.recipientFrom === 'report' ? ` (address from the report: ${result.recipient})` : ''}`);

        // Durable record (combined outreach log + dashboard): who, when, the exact
        // subject + body, their email, and the SF link.
        try {
          textLog.recordEmail({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, email: result.recipient || null, templateName: historyTemplateName, subject: leadSubject, body: leadBody, mode: o.logMode || 'email', source: lead.source || defaultSource, step: leadStep });
        } catch (_) {}
      }
      await sleep(delayMs);
    } catch (e) {
      if (historyReservationId) {
        try { contactHistory.cancelReservation(historyReservationId, e.message); } catch (_) {}
      }
      done.set(ident, `SKIPPED: ${e.message}`);
      consecutiveFailures++;
      commandLog('❌', 'Mission failed', `Row ${pos} skipped — ${e.message}`);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.log(`\n⛔ Aborting: ${consecutiveFailures} consecutive failures — something is wrong.`);
        skipReader.close();
        return summarize({ message: subject, start, end, seen, done, sentCount, campaignStart });
      }
    }
  }

  skipReader.close();
  const emailResult = summarize({ message: subject, start, end, seen, done, sentCount, campaignStart });
  // Refresh the combined outreach dashboard so sent emails show up.
  try {
    const p = textLog.generateDashboard();
    commandLog('📊', 'Outreach dashboard', p);
    console.log(`     open it:  file://${p}   (or: email --sent)`);
  } catch (_) {}
  return emailResult;
}

function summarize({ message, start, end, seen, done, sentCount, campaignStart }) {
  const campaignEnd = new Date();
  const fmt = (d) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const elapsed = Math.round((campaignEnd - campaignStart) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const skipped = [...done.entries()].filter(([, v]) => String(v).startsWith('SKIPPED'));

  console.log(`\n${'╔' + '═'.repeat(62) + '╗'}`);
  console.log('║  🏆 TEXT MISSION REPORT'.padEnd(64) + '║');
  console.log(`║  🕐 ${fmt(campaignStart)} → ${fmt(campaignEnd)} (${mins}m ${secs}s)`.padEnd(64) + '║');
  console.log(`║  🎯 Range: ${start}-${end || 'END'}`.padEnd(64) + '║');
  console.log(`║  🚀 Texts delivered: ${sentCount}`.padEnd(64) + '║');
  const dryRuns = [...done.values()].filter((v) => String(v).startsWith('DRY-RUN')).length;
  if (dryRuns) console.log(`║  🧪 Dry run: ${dryRuns} account(s) went through, NOTHING was sent`.padEnd(64) + '║');
  console.log(`║  📡 Leads detected: ${seen.length}`.padEnd(64) + '║');
  console.log(`║  ${skipped.length ? '⚠️' : '✅'} Skipped: ${skipped.length}`.padEnd(64) + '║');
  console.log('╚' + '═'.repeat(62) + '╝');
  if (skipped.length) {
    for (const [k, v] of skipped) console.log(`  ⚠️ ${k} — ${v}`);
  }
  return { sentCount, seen: seen.length, skipped: skipped.length };
}

// ============================================================================
// Main
// ============================================================================
/**
 * --reengage pre-send Salesforce review. Walks `candidates` (oldest first), reviewing each
 * (cached per run so the text and email passes share one review) until `want` accounts pass.
 * skip/unknown accounts are logged to reengage-review.jsonl and never sent. Reviews at most
 * 4x the cap so a list full of closed accounts can't spin forever.
 */
/**
 * Make sure we know an account's time zone before texting it. Looked up in this order, each source read-only, the answer cached in
 * contact-zones.jsonl (a lookup that finds nothing is remembered too, so an account is not searched again for 14 days):
 *   1. the opportunity's own Time Zone field — the field the Shark reports' Time Zone column shows
 *   2. the Account page's address / phone
 * Stops trying a source for the rest of the run when it has clearly nothing to give (5 opportunity pages in a row without a Time Zone field,
 * 3 empty account pages in a row): more page loads would only slow the run down. → IANA zones[] | null
 */
const zoneReads = { oppNoField: 0, accountEmpty: 0, said: {} };
const sayOnce = (key, fn) => { if (!zoneReads.said[key]) { zoneReads.said[key] = true; fn(); } };

async function zoneFromOpportunity(page, lead, opps) {
  if (zoneReads.oppNoField >= 5) return null;
  let list = (opps || []).filter((o) => o && o.id);
  if (!list.length) { try { list = ((await sfReview.readOpportunities(page, lead.accountId)).opps || []).filter((o) => o.id); } catch (_) { list = []; } }
  list.sort((a, b) => (Date.parse(b.closeDate) || 0) - (Date.parse(a.closeDate) || 0));
  for (const o of list.slice(0, 2)) {                                    // the two newest opportunities
    let d; try { d = await sfReview.readOppDetail(page, o.id); } catch (_) { continue; }
    const labels = Object.keys(d.fields || {});
    const key = labels.find((k) => /time\s*-?\s*zone/i.test(k));
    if (!key) {
      zoneReads.oppNoField++;
      sayOnce('oppLabels', () => commandLog('ℹ️', 'Opportunity page', labels.length ? `fields it shows: ${labels.slice(0, 40).join(' · ')}${labels.length > 40 ? ' …' : ''} — no Time Zone among them` : 'no fields could be read from the opportunity page'));
      break;                                                              // same page layout for every opportunity of this kind
    }
    zoneReads.oppNoField = 0;
    const raw = String(d.fields[key] == null ? '' : d.fields[key]).replace(/\s+(Edit|Preview|Change)\b.*$/i, '').trim();
    const tz = require('./tcpa').parseZone(raw);
    if (tz) {
      textLog.recordZone({ accountId: lead.accountId, accountName: lead.name, zones: [tz], source: `opportunity field "${key}"` });
      commandLog('🕐', 'Time zone', `${lead.name} — ${require('./tcpa').ZONE_SHORT[tz] || tz} (the opportunity's "${key}" field says "${raw}")`);
      return [tz];
    }
  }
  return null;
}

async function zoneFromAccountPage(page, lead) {
  let loc;
  try { loc = await accountZone.readLocation(page, lead.accountId); } catch (e) { loc = { ok: false, note: e.message }; }
  textLog.recordZone({ accountId: lead.accountId, accountName: lead.name, state: loc.state, source: loc.state ? loc.source : (loc.ok ? 'lookup: nothing found' : null), address: loc.address, phone: loc.phone });   // (a page that did not load is not "nothing found")
  if (loc.state) {
    zoneReads.accountEmpty = 0;
    commandLog('🕐', 'Time zone', `${lead.name} — ${loc.state} (${(require('./tcpa').zonesForState(loc.state) || []).map((z) => require('./tcpa').ZONE_SHORT[z]).join('/')}, from ${loc.source})`);
    return textLog.zonesFor(lead.accountId);
  }
  zoneReads.accountEmpty++;
  sayOnce('accountLabels', () => { const labels = Object.keys(loc.fields || {}); commandLog('ℹ️', 'Account page', labels.length ? `fields it shows: ${labels.slice(0, 18).join(' · ')}${labels.length > 18 ? ' …' : ''} — no address or phone among them` : 'no fields could be read from the page'); });
  if (zoneReads.accountEmpty === 3) commandLog('ℹ️', 'Time zone', 'three empty account pages in a row: not reading more account pages for time zones this run');
  return null;
}

async function ensureZone(page, lead, opps) {
  const have = textLog.zonesFor(lead.accountId);
  if (have) return have;
  if (textLog.zoneTried(lead.accountId)) return null;                     // looked lately, found nothing
  let z = await zoneFromOpportunity(page, lead, opps);
  let looked = !!z;
  if (!z && zoneReads.accountEmpty < 3) { z = await zoneFromAccountPage(page, lead); looked = true; }
  if (!z) {
    if (!looked) textLog.recordZone({ accountId: lead.accountId, accountName: lead.name, zones: [], source: 'lookup: nothing found' });   // remember that we looked
    commandLog('❓', 'Time zone', `${lead.name} — none found (not on the opportunity, not on the account page)`);
  }
  return textLog.zonesFor(lead.accountId);
}

/** A Closed Won opportunity from the last 30 days (any rep) → the closed-won list, with the OPPORTUNITY OWNER. The account is not texted. */
function noteClosedWon(lead, cw, via) {
  if (!cw) return null;
  const row = textLog.recordClosedWon({ accountId: lead.accountId, accountName: lead.name, accountUrl: lead.url, ...cw, source: via });
  commandLog('🏆', 'Closed won', `${lead.name} — "${cw.name}" closed ${cw.closeDate || '(no date)'}${cw.owner ? ' · owner ' + cw.owner : ' · owner not found'} → added to the closed-won list, NOT texted`);
  return row;
}

async function reviewCandidates(page, candidates, want, cache, tried, ch, via = '48h re-engage', opts = {}) {
  const approved = [];
  let reviewed = 0;
  for (const lead of candidates) {
    if (approved.length >= want || reviewed >= want * 4) break;
    let v = cache.get(lead.accountId);
    if (!v) {
      commandLog('🔎', 'SF review', `${lead.name}`);
      try { v = await sfReview.reviewAccount(page, lead, opts.review || {}); }
      catch (e) { v = { accountId: lead.accountId, accountName: lead.name, verdict: 'unknown', reasons: [`review error: ${e.message}`], warnings: [], opps: [], notesRead: 0 }; }
      textLog.recordReview(v);
      if (v.hardStop && textLog.recordBan({ accountId: lead.accountId, accountName: lead.name, reason: v.hardStop, source: 'reengage review' })) commandLog('🚫', 'Banlist', `${lead.name} added — ${v.hardStop}`);
      noteClosedWon(lead, v.closedWon, via);
      cache.set(lead.accountId, v);
      reviewed++;
      if (opts.stats) { opts.stats.reviewed++; if (v.closedWon) opts.stats.closedWon++; else if (v.verdict === 'skip') opts.stats.otherSkips++; else if (v.verdict === 'unknown') opts.stats.unreadable++; }
      const icon = v.verdict === 'proceed' ? '✅' : v.verdict === 'skip' ? '🛑' : '❓';
      commandLog(icon, `Review: ${v.verdict.toUpperCase()}`, `${v.opps.length} opp(s)${v.reasons.length ? ' — ' + v.reasons.join('; ') : ''}`);
      v.warnings.forEach((w) => commandLog('⚠️', 'Review note', w));
    }
    if (v.verdict === 'proceed' && ch === 'text') {
      // TCPA per contact: text only if the contact's own time zone is inside the window now.
      const zones = opts.lookupZone === false ? textLog.zonesFor(lead.accountId) : await ensureZone(page, lead, v.opps);   // the Shark follow-up never looks a zone up: it uses one only if it is already known
      // opts.unknownZone === 'hold' (the Shark follow-up): no zone found → this contact is not texted at all. (--reengage keeps the strict all-US hours.)
      if (!zones && opts.unknownZone === 'hold') { if (opts.stats) opts.stats.noZone++; commandLog('⏰', 'TCPA hours', `${lead.name} — no time zone found for this contact; not texted without one`); tried.add(`${ch}|${lead.accountId}`); continue; }
      const g = require('./tcpa').checkZones(zones);
      if (!g.ok) { if (opts.stats) opts.stats.closedHours++; commandLog('⏰', 'TCPA hours', `${lead.name} — closed for this contact (${g.reason}); skipped for now`); tried.add(`${ch}|${lead.accountId}`); continue; }
      approved.push(lead);
    } else if (v.verdict === 'proceed') approved.push(lead);
    else tried.add(`${ch}|${lead.accountId}`);
  }
  return approved;
}

const normKind = (k) => (/shark/i.test(k || '') ? 'Shark' : /lds/i.test(k || '') ? 'LDS' : null);

/**
 * The accounts from the NEWEST Shark snapshot that still need an email: not banned, and not emailed since the snapshot
 * was taken (so a re-run picks up where the last one stopped, and accounts a rep already got to are still here).
 * → leads [{ name, accountId, url, lastOutgoingSms }] with .source = { kind, name } and .snapshotAt
 */
function snapshotLeads({ channel = 'email' } = {}) {
  const snaps = textLog.readSnapshots().filter((s) => s.kind === 'Shark');
  const sn = snaps[snaps.length - 1];
  if (!sn) return Object.assign([], { source: null, snapshotAt: null });
  const done = new Set(textLog.readAll().filter((r) => (channel === 'email' ? r.channel === 'email' : r.channel !== 'email') && r.at >= sn.at).map((r) => String(r.accountId || '').toLowerCase().slice(0, 15)));
  const leads = sn.accounts.filter((a) => !textLog.isBanned(a.id) && !done.has(String(a.id).toLowerCase().slice(0, 15)))
    .map((a) => ({ name: a.name || '(unnamed account)', accountId: a.id, url: a.url ? sfId.fixUrl(a.url) : null, lastOutgoingSms: a.sms || null }));
  return Object.assign(leads, { source: { kind: 'Shark', name: sn.name || 'Shark list' }, snapshotAt: sn.at });
}

/**
 * Which report is this page? → { id, name, kind } with kind 'LDS' | 'Shark' | null.
 * Saved modes are recognised by report id; any other report by its title ("T14 Shark List All" → Shark, "… LDS" → LDS).
 */
async function detectReportSource(page) {
  const url = page.url() || '';
  const id = (url.match(/\/Report\/([A-Za-z0-9]{15,18})/) || [])[1] || null;
  const known = id ? Object.values(REPORT_MODES).find((m) => m.url.includes(id)) : null;
  let title = ''; try { title = await page.title(); } catch (_) {}
  const name = known ? known.name : String(title).replace(/\s*[|·].*$/, '').replace(/^\s*(Report|Reports):\s*/i, '').trim();
  return { id, name, kind: (known && known.kind) || textLog.classifyList(name) };
}

/**
 * harvestReportLeadsRaw + remember which list these accounts are on (LDS / Shark) for the dashboard, and save the report's own Time Zone,
 * Industry and Email columns (no account page needed). `record: false` only reads and detects the report: nothing is saved (a --harvest --dry-run).
 */
async function harvestReportLeads(page, { kind, record = true } = {}) {
  const leads = await harvestReportLeadsRaw(page);
  try {
    const src = await detectReportSource(page);
    if (!src.kind && kind) src.kind = kind;   // operator override: --kind LDS|Shark
    leads.source = src;
    if (record && src.kind) textLog.recordListScan({ kind: src.kind, name: src.name, reportId: src.id, accounts: leads.map((l) => ({ id: l.accountId, name: l.name, email: textLog.emailOfLead(l) })) });
  } catch (_) {}
  // Diagnostic (also on --dry-run): what the report's Timezone cells actually said, so a wrong zone can be traced to the cell it came from.
  try {
    const tzKey = (l) => Object.keys(l.cols || {}).find((k) => /time\s*-?\s*zone|timezone|^tz\b/i.test(k));
    const hist = {}; const odd = [];
    for (const l of leads) {
      const k = tzKey(l); const raw = k ? l.cols[k] : '(no Timezone cell read)';
      hist[raw] = (hist[raw] || 0) + 1;
      const z = k ? require('./tcpa').parseZone(raw) : null;
      if (z && z !== 'America/New_York' && odd.length < 6) odd.push(`${l.name}: "${raw}" (other cells: ${Object.entries(l.cols).filter(([h]) => h !== k).slice(0, 4).map(([h, v]) => h + '=' + v).join('; ')})`);
    }
    commandLog('🔎', 'Timezone cells', Object.entries(hist).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([v, n]) => `"${v}" ×${n}`).join(' · '));
    for (const o of odd) commandLog('🔎', 'Not Eastern', o);
  } catch (_) {}
  if (!record) return leads;
  // The Shark / LDS reports carry a "Time Zone" column (the pro's own zone): record it for every row — no account page needed.
  try {
    const z = textLog.zonesFromReport(leads);
    leads.zoneColumn = z;
    if (z.header) commandLog('🕐', 'Time zone column', `"${z.header}" filled on ${z.total} of ${leads.length} account(s) — ${z.recorded} new/changed${z.unparsed.length ? `; could not read: ${z.unparsed.join(' | ')}` : ''}`);
    if (leads.thinRows) commandLog('⚠️', 'Report scan', `${leads.thinRows} of ${leads.length} row(s) came back with most cells empty — the report was probably still loading; scan it again`);
  } catch (_) {}
  // …and an "Industry" column, if the report has one: the account's industry for free, so new leads arrive with theirs.
  try {
    const ic = textLog.industryFromReport(leads);
    leads.industryColumn = ic;
    if (ic.header) commandLog('🏭', 'Industry column', `"${ic.header}" found on ${ic.total} account(s) — ${ic.recorded} new/changed`);
  } catch (_) {}
  // …and an "Email" column: the dashboard shows the address for leads nobody has contacted yet.
  try {
    const ec = textLog.emailsFromReport(leads);
    leads.emailColumn = ec;
    if (ec.header) commandLog('📧', 'Email column', `"${ec.header}" found on ${ec.total} account(s) — ${ec.recorded} new/changed`);
  } catch (_) {}
  return leads;
}

/**
 * Open a Salesforce report (a saved --lds / --inbound-lds mode, or whichever report the operator
 * opens) and collect its account rows, with the "scan again" prompt for big reports.
 * → { page, leads, reportUrl } or null if the operator quit.
 */
async function openReportAndHarvest(context, initialPage, args) {
  let page;
  if (args.mode && REPORT_MODES[args.mode]) {
    const m = REPORT_MODES[args.mode];
    page = await waitForSalesforceLogin(context, initialPage);
    commandLog('🗂️', 'Report mode', `${m.name} — opening ${m.url}`);
    await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 40 && !reportFrame(page); i++) await sleep(1000);
    commandLog('⏳', 'Report loading', `waiting ${Math.round(args.loadWaitMs / 1000)}s for the rows to fill in`);
    await sleep(args.loadWaitMs);
  } else {
    page = await resolveReportPage(context, initialPage);
    let frame = reportFrame(page);
    for (let i = 0; i < 6 && !frame; i++) { await sleep(1000); frame = reportFrame(page); }
  }
  const reportUrl = page.url();
  if (args.byEmail) return { page, leads: [], reportUrl, source: null };      // --by-email reads email addresses itself (emailLookup.harvestEmails)
  let leads = [];
  while (true) {
    commandLog('📇', 'Harvest', 'Scanning report for accounts…');
    try { leads = await harvestReportLeads(page, { kind: normKind(args.kind), record: !args.noRecord }); }
    catch (e) {
      commandLog('⚠️', 'Harvest', e.message);
      if (!process.stdin.isTTY) throw e;
      const ans = (await ask('\n  That tab is not a Salesforce REPORT with rows showing. Open the report in the Chrome window, then press Enter to scan again (q = quit): ')).toLowerCase();
      if (ans === 'q') return null;
      const sf = context.pages().filter((p) => (p.url() || '').includes(CONFIG.sfUrlSubstring));
      if (sf.length) page = sf[sf.length - 1];
      continue;
    }
    commandLog('📬', 'Accounts harvested', `${leads.length}`);
    if (!process.stdin.isTTY) break;
    const ans = (await ask(`\n  Found ${leads.length} account(s). Press Enter to ${leads.length ? 'continue' : 'scan again'}, r = scan again (report may still be loading), q = quit: `)).toLowerCase();
    if (ans === 'q') return null;
    if (ans === 'r' || !leads.length) { await sleep(2000); continue; }
    break;
  }
  return { page, leads, reportUrl, source: leads.source || null };
}

/**
 * The live Customer Status (beta) look at ONE account (enrollCheck.js in its status-only mode: the follow-up board's check, without the opportunities), for everything that contacts an account.
 * "Enrolled: …" (Enrolled: Current Customer, Cancel Requested, Under Review…) is a current customer unless the account is only on the free Invoicing and Payments plan; one found is saved on the held list;
 * a known customer whose status cannot be read now stays held. `assumeOpen`: the account page is already open on `page` (textAccount has just opened it), so it is read as it is.
 * → (page, { assumeOpen }) → async (lead) → { ok, customer?, status?, reason?, unverified?, released?, why?, moved? }
 */
const customerGate = (page, { assumeOpen = false } = {}) => require('./enrollCheck').makeCheck({ getPage: () => page, accountLoadMs: CONFIG.accountLoadMs, startUrl: CONFIG.startUrl, log: () => {}, opportunities: false, assumeOpen });

/** What autoDraft.js needs from this file and the modules it loads (it takes them as arguments so that it can load without a browser). */
const autoDeps = () => ({
  commandLog, ask, textLog, sfReview, autoPlan, tcpa, sfId, ensureZone, noteClosedWon, sendTexts: runReportCampaign, sendEmails: runEmailCampaign,
  checkCustomer: (page, lead) => customerGate(page)(lead),      // the account is looked at BEFORE anything is read or written for it (the text it may get is looked at again, inside textAccount)
});

/**
 * --auto: for each account, read the opportunities + notes, flag/skip what must not be contacted
 * (closed-won in the last 30 days, do-not-call, all closed out…), have Claude write a custom
 * email + text + phone script from the notes, show them, and — unless --dry-run — send the
 * email and text through the normal guarded campaign loops (banlist, TCPA, once-a-day guards).
 * The reading and the writing are autoDraft.js (the plain email and text campaigns use it too); this function picks the accounts and does the sending.
 */
async function runAuto(context, initialPage, args) {
  const ctx = await autoDraft.startSession({ args, deps: autoDeps() });
  if (!ctx) return;
  const { mock, log } = ctx;
  const dryRun = !!args.dryRun || mock;
  const maxN = args.maxSet ? args.max : 10;

  let page; let leads; let leadSource = null;   // which list the accounts come from (LDS / Shark), recorded on every plan + send
  if (args.only) {
    page = await waitForSalesforceLogin(context, initialPage);
    const id = sfId.fix(String(args.only).trim());
    const mine = log.filter((r) => r.accountId && r.accountId.toLowerCase() === id.toLowerCase());
    leads = [{ accountId: id, name: (mine[0] && mine[0].accountName) || id, url: `https://${CONFIG.startUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}/lightning/r/Account/${id}/view` }];
  } else if (args.mode || args.report) {
    // Source = a Salesforce REPORT you open (--report), or a saved non-LDS mode.
    const r = await openReportAndHarvest(context, initialPage, args);
    if (!r) return;
    page = r.page; leads = r.leads; leadSource = r.source && r.source.kind ? { kind: r.source.kind, name: r.source.name } : null;
    if (!leads.length) { console.log('\n⚠️  No accounts found. Open the report so its rows are visible, then retry.\n'); return; }
  } else if (PIPELINE_ONLY) {
    console.log('\n⛔ --auto with no source used to mean the LDS dashboard tab. This copy is pipeline-list only.\n   Use:  zw / zw --text  (your opportunity list)  or  zw --auto --report  (a report you open)\n');
    return;
  } else {
    // Default source = the DASHBOARD's LDS tab (accounts whose opportunities include a Lost Demo
    // stage, from --harvest --deep / --lds / --review reads). Banned accounts and ones already sent a custom
    // outreach are skipped (--again includes the latter).
    page = await waitForSalesforceLogin(context, initialPage);
    const plansNow = textLog.readPlans();
    const all = textLog.lostDemoAccounts(textLog.aggregate());
    const sentAlready = (l) => { const p = plansNow.get(String(l.key).toLowerCase()); return !!p && p.status === 'sent' && !args.again; };
    leadSource = { kind: 'LDS', name: 'dashboard LDS tab' };
    leads = all.filter((l) => !textLog.isBanned(l.key) && !sentAlready(l)).map((l) => ({ accountId: l.key, name: l.name, url: sfId.fixUrl(l.url) }));
    commandLog('🗂️', 'Source', `dashboard LDS tab — ${all.length} account(s): ${all.length - leads.length} skipped (banned / already sent), ${leads.length} to go`);
    if (!leads.length) {
      console.log('\n⚠️  Nothing to work through on the LDS tab yet.\n   Fill it with:  email --harvest --deep   (reads every account)  or  email --lds   (reviews the LDS report)\n   Or point --auto at a report:  email --auto --lds   /   --inbound-lds   /   --report\n');
      return;
    }
  }

  ctx.leadSource = leadSource;

  const todo = leads.slice(0, maxN);
  const results = await autoDraft.draftLeads(page, todo, ctx);
  const ready = autoDraft.summarize(results, ctx, todo.length);
  if (args.evidenceOnly) { console.log('\n  🔬 --evidence-only: no drafts were written and nothing was sent.\n'); return; }
  if (dryRun) { console.log(`\n  🧪 ${args.dryRun ? '--dry-run' : 'mock provider'}: nothing was sent. Drafts are saved to auto-plans.jsonl and the dashboard.\n`); return; }
  if (!ready.length) { console.log('\n  Nothing is ready to send.\n'); return; }

  if (!args.yes) {
    const ok = (await ask(`\n  ▶️  Send ${ready.length} custom outreach package(s) — a text (only where TCPA hours allow) and an email each — shown above? (y/N) `)).toLowerCase();
    if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'Nothing sent. The drafts are saved.'); return; }
  }
  const startedAt = new Date().toISOString();
  const mk = (r) => ({ name: r.lead.name, accountId: r.lead.accountId, url: r.lead.url ? sfId.fixUrl(r.lead.url) : undefined });
  const textLeads = ready.map((r) => ({ ...mk(r), message: r.res.plan.text }));
  await runReportCampaign(page, { start: 1, end: textLeads.length, delayMs: args.delayMs, force: false, templateName: `${textLog.AUTO_PREFIX} (text)`, leads: textLeads, tcpa: true, source: leadSource });
  const emailLeads = ready.map((r) => ({ ...mk(r), subject: r.res.email.subject, body: r.res.email.body }));
  await runEmailCampaign(page, emailLeads, { start: 1, end: emailLeads.length, delayMs: args.delayMs, force: false, templateName: `${textLog.AUTO_PREFIX} (email)`, dryRun: false, source: leadSource });

  // Record what actually went out.
  autoDraft.recordSent(ready, startedAt, ctx);
  console.log('\n  ✅ Auto run complete.\n');
}

/**
 * --shark / --snapshot: back the report up BEFORE reps work it off the list (see the comment at the call site in main()).
 * Read-only. Saves shark-snapshots.jsonl, tags the accounts, queues them for texting and refreshes the dashboard.
 */
async function runSnapshot(context, initialPage, args) {
  const kind = args.sharkMode ? 'Shark' : normKind(args.kind);
  if (!kind) { console.log('\n  --snapshot needs to know which list this is:  --snapshot --kind Shark   (or --kind LDS).  Or just use  --shark.\n'); return; }
  const r = await openReportAndHarvest(context, initialPage, { ...args, kind });
  if (!r) return;
  const leads = r.leads.filter((l) => l.accountId);
  if (!leads.length) { console.log('\n⚠️  No accounts found — open the report so its rows are visible, then retry.\n'); return; }
  const src = r.source || {};
  const listName = src.name || (kind === 'Shark' ? 'T14 Shark List All' : `${kind} list`);
  const prev = textLog.readSnapshots().filter((s) => s.kind === kind && (!src.id || !s.reportId || String(s.reportId).slice(0, 15) === String(src.id).slice(0, 15))).pop();   // the previous scan of the SAME report (T13 and T14 are different lists)
  const snap = textLog.recordSnapshot({ kind, name: listName, reportId: src.id || null, reportUrl: r.reportUrl, accounts: leads.map((l) => ({ id: l.accountId, name: l.name, url: l.url, sms: l.lastOutgoingSms, cols: l.cols })) });
  console.log(`\n  📌 BACKED UP  ${snap.count} account(s) from "${listName}" → shark-snapshots.jsonl + the dashboard (tagged #${kind.toLowerCase()})`);
  // what changed since the previous snapshot (who was added, who dropped off = a rep probably got to them)
  if (prev) {
    const was = new Set(prev.accounts.map((a) => String(a.id).toLowerCase().slice(0, 15)));
    const now = new Set(snap.accounts.map((a) => String(a.id).toLowerCase().slice(0, 15)));
    const added = [...now].filter((k) => !was.has(k)).length, gone = [...was].filter((k) => !now.has(k)).length;
    console.log(`     since the snapshot of ${prev.at.slice(0, 16)}: +${added} new on the report, ${gone} dropped off (still on the dashboard)`);
  }
  if (kind === 'Shark' && !args.shark13) { try { require('./eveningShark').noteMorning(snap, commandLog); } catch (_) {} }   // how many of last night's --evening pros posted anyway
  // text queue (so `email --queue` can text them even after they leave the report)
  if (!args.noQueue) {
    const alreadyTexted = new Set(textLog.readAll().filter((x) => x.channel !== 'email').map((x) => x.accountId).filter(Boolean));
    const res = textQueue.addLeads(leads, { alreadyTexted, source: { kind, name: listName } });
    console.log(`     text queue: +${res.added} new (${res.dupQueue} already queued, ${res.dupTexted} already texted) — ${res.pending} pending.  Text them later:  email --queue --template N --range all`);
  }
  if (r.leads.zoneColumn && r.leads.zoneColumn.header) console.log(`     time zones: the report's "${r.leads.zoneColumn.header}" column covers ${r.leads.zoneColumn.total} account(s) (${r.leads.zoneColumn.recorded} new/changed) — the dashboard's Time zone column and the TCPA text gate use it`);
  else console.log('     time zones: this report has no "Time Zone" column (zones come from the account address instead — email --zones)');
  console.log(`     email them later (even if they've left the report):  email --email --from-snapshot`);
  // remember the report so the next morning is just  email --shark   (never the T13 report: --shark13 has its own)
  try {
    if (args.sharkChoice && src.id && !REPORT_MODES[args.sharkChoice] && /\/lightning\/r\/Report\//.test(r.reportUrl || '')) {
      const f = path.join(__dirname, 'report-modes.json');
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
      cur[args.sharkChoice] = { name: listName, kind: 'Shark', url: r.reportUrl.split('?')[0] + '?queryScope=userFolders' };
      fs.writeFileSync(f + '.new', JSON.stringify(cur, null, 2) + '\n'); fs.renameSync(f + '.new', f);
      console.log(`     saved this report as "${listName}" in report-modes.json — next time it opens by itself from the --shark --pick menu`);
    }
    if (kind === 'Shark' && !args.shark13 && !args.pick && src.id && !REPORT_MODES.shark && /\/lightning\/r\/Report\//.test(r.reportUrl || '')) {
      const f = path.join(__dirname, 'report-modes.json');
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
      cur.shark = { name: listName, kind: 'Shark', url: r.reportUrl.split('?')[0] + '?queryScope=userFolders' };
      fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
      console.log(`     saved this report as  email --shark  (report-modes.json) — next time it opens by itself`);
    }
  } catch (_) {}
  try { textLog.generateDashboard(); console.log('     dashboard refreshed (email --sent) — filter "📌 Shark snapshot — not contacted yet"'); } catch (_) {}
  console.log('');
  return { page: r.page, snap };
}

// ============================================================================
// SHARK FOLLOW-UP (--followup)
//
// RETIRED, FOR NOW (Luke, 2026-11-02: "lets retire follow up for now since the board replaces it"): a plain --followup prints a pointer to --board and starts nothing (followupRetired.js, one switch).
// The code below stays because --same-day, --teammate-texted and --followup --teammate run on it; what follows describes plain --followup as it was.
//
// Another text to the Shark-tab accounts that have had no touch from us (a text OR an email) for --days (default 3) or more —
// the accounts the dashboard's Shark tab shows with "Days since touch" >= 3. Runs in the re-engage browser (CDP 9325).
// A lighter safety net than the 48h re-engage (banlist, closed-won list, held current customers, per-contact TCPA hours, once-a-day + recent-contact +
// "texted by anyone" guards) plus: never the same text twice to one account, and nothing is sent until the exact text and the exact
// accounts have been shown and confirmed (--yes skips the confirm). By default NO Salesforce review of the opportunities before a send
// (--nocheck; Luke, 2026-10-29: "just send the text"); --check opens each account's profile, checks it, texts it, then moves on (see followupCheckMode).
// (2026-11-11: that is about the REVIEW of the opportunities. Every text still reads Customer Status (beta) on the account page it opens anyway, inside textAccount.)
// ============================================================================
const FOLLOWUP_SOURCE = { kind: 'Shark', name: 'Shark follow-up' };
/** An LDS lead texted by --followup (it is not on the Shark tab: textLog.followupDue includeLds) stays an LDS lead in the log. A text marked Shark would put it on the Shark tab and in every Shark count. */
const LDS_FOLLOWUP_SOURCE = { kind: 'LDS', name: 'LDS follow-up' };

/** The follow-up's own text (template 8, the user's wording). --template N or --message "…" send something else. */
const FOLLOWUP_DEFAULT_TEMPLATE = '8';
/**
 * --same-day (a SECOND text to the Shark pros texted earlier today) has NO default text (Luke, 2026-11-02: "I give the wording each run"): --message "…" or --template N, every time. It used to send template 9, which is
 * the follow-up board's own Day 1 · Text 2. It is not a stage of the board either (the board ignores its texts, cadence.js; no "Touchpoint N" label) and it never checks an account in Salesforce first.
 * SAME_DAY_NO_TEXT stands in for the wording only while --inspect lists the pros: a run needs real wording.
 */
const SAME_DAY_NO_TEXT = { name: 'Custom message', text: '' };
/** Why a --same-day run is refused before anything starts (a message to print), or null. `msg` = the wording picked (null before it is known: then the wording-free reasons only). */
function sameDayProblem(args, msg) {
  if (!args.sameDay) return null;
  if (args.check) return '\n⚠️  --same-day never checks an account in Salesforce first: it just texts the pros you already texted today, so --check is not available with it. Nothing was started.\n';
  if (!args.message && !args.template && !args.inspect) return '\n⚠️  --same-day has no default text any more: give the wording every run, e.g.  email --same-day --message "…"  (or --template N). Add --inspect to see who it would text. Nothing was started.\n';
  const clash = msg && msg.text ? sameDay.boardClash(msg, TEMPLATES) : [];
  if (clash.length) return `\n⚠️  That wording is the follow-up board's ${clash.map((c) => c.label).join(' / ')} text ("${clash[0].name}"). The board would count that stage as already sent for every pro you text and move them on, and --same-day must never move a lead on the board. Use other wording. Nothing was started.\n`;
  return null;
}

/**
 * The follow-up SEQUENCE (the steps are registered in textLog.FOLLOWUP_STEPS): step N is the text an account gets the Nth time it goes through
 * --followup, and where an account stands is read from the log. Step 1 = template 8 ("Follow-Up 1"). Step 2 = the success story: its text is
 * NOT WRITTEN YET (null): put it here when it is, and the bot starts sending it to every account that has already had step 1. A step without
 * a text is never sent; the accounts waiting for it are counted in --inspect and at the end of a run.
 */
const FOLLOWUP_TEXT = { 1: TEMPLATES['8'].text, 2: null };
/** The optional text for accounts a TEAMMATE texted in the last 48h: `--followup --teammate` sends it to ONLY those accounts (a normal --followup holds them). */
const FOLLOWUP_TEAMMATE = {
  name: 'Follow-Up (teammate reached out)',
  text: "We know making the change to our software isn't easy but it's worth it. Which is why we are going to give you a $100 amazon giftcard for enrolling, reply Y or N",
};
const followupSequence = () => textLog.FOLLOWUP_STEPS.map((q) => ({ step: q.step, name: q.names[0], label: q.label, text: FOLLOWUP_TEXT[q.step] || null }));

/** The text to send: --message, else --template N, else the follow-up's own text (template 8). The exact text is always shown and confirmed before anything goes out. → { name, text } | null */
async function pickFollowupText(args) {
  if (args.message) return { name: 'Custom message', text: args.message };
  if (args.teammateTexted && !args.template) return teammateTexted.TEXT;
  if (args.teammate && !args.template) return FOLLOWUP_TEAMMATE;
  if (args.sameDay && !args.template) return args.inspect ? SAME_DAY_NO_TEXT : null;      // --same-day has no default text: never fall back to the follow-up's own template 8
  const id = String(args.template || FOLLOWUP_DEFAULT_TEMPLATE);
  const t = TEMPLATES[id];
  if (!t) { console.log(`\n⚠️  There is no template "${args.template}". Use 1–${Object.keys(TEMPLATES).length}, or --message "…".\n`); return null; }
  return { name: t.name, text: t.text };
}

/** --zone-only ET|CT|MT|PT|AZ|AK|HI (or an IANA name) → the zone name the saved contact zones use. Anything else is an error, so a typo never widens a run. */
function zoneOnlyTz(v) {
  if (!v) return null;
  const k = String(v).trim().toUpperCase().replace(/^(EASTERN|EST|EDT)$/, 'ET').replace(/^(CENTRAL|CST|CDT)$/, 'CT').replace(/^(MOUNTAIN|MST|MDT)$/, 'MT').replace(/^(PACIFIC|PST|PDT)$/, 'PT');
  const hit = Object.entries(tcpa.ZONE_SHORT).find(([tz, short]) => short.split(' ')[0] === k || tz.toUpperCase() === k);
  if (!hit) { console.log(`\n  --zone-only: "${v}" is not a time zone I know (use ET, CT, MT, PT, AZ, AK or HI).\n`); process.exit(1); }
  return hit[0];
}
/**
 * How a --followup run checks an account in Salesforce (its opportunities: closed won, current customer, its hours) before texting it:
 *   'none'   --nocheck, the DEFAULT of --followup and the ONLY way of --same-day (it refuses --check, Luke 2026-11-02): no account is opened to check it, the text just goes out (--same-day since 2026-10-27, its pros were all
 *            texted earlier today; plain --followup since 2026-10-29, Luke: "just send the text"). --no-review is the same flag.
 *            (2026-11-11: 'none' means no Salesforce REVIEW. Every text still reads Customer Status (beta) on the account page it opens anyway (textAccount: a current customer is not texted).)
 *   'each'   --check: ONE ACCOUNT AT A TIME (Luke, 2026-10-29): open the account's Salesforce profile, check it, text it, then go to the next account. The batch is listed and
 *            confirmed first, like any other; the check can only take accounts OUT of it. Every check is a fresh look (no 12-hour "proceed" cache).
 *   'batch'  check the whole batch first, then text it all: how --teammate-texted starts (no flag); --check / --nocheck replace it.
 */
const followupCheckMode = (args) => (args.sameDay ? 'none' : args.check ? 'each' : args.noReview || !args.teammateTexted ? 'none' : 'batch');
const followupOptions = (args, msg) => {
  const sd = args.sameDay ? sameDay.cohort() : null;       // --same-day: only the Shark pros texted earlier today (no day limit: they were touched today)
  const tl = args.teammateTexted ? teammateTexted.cohort() : null;       // --teammate-texted: only the pros on the 🤝 Teammate texted tab (no day limit: a teammate just texted them; teammateTexted.due leaves out the ones we texted in the last 24h)
  return { minDays: sd || tl ? 0 : args.days, scannedOnly: args.scannedOnly, includeLds: !args.noLds && !sd && !tl, message: msg ? msg.text : null, templateName: msg ? msg.name : null, maxTexts: args.maxTexts, only: args.only, unknownZone: args.unknownZone === 'hold' ? 'hold' : 'strict', sequence: msg ? null : followupSequence(), onlyStep: args.step || null, teammateOnly: !!args.teammate, zoneOnly: zoneOnlyTz(args.zoneOnly), cohort: sd ? sd.ids : tl ? tl.ids : null, sameDay: sd, teammateList: tl };   // msg = ONE text chosen with --template / --message; none = the sequence decides, per account
};
/** Who a --followup / --same-day / --teammate-texted run would text: followupDue as it is, except --teammate-texted, whose list needs both of its teammate passes (teammateTexted.due). */
const followupDueFor = (args, opts) => (args.teammateTexted ? teammateTexted.due(opts) : textLog.followupDue(opts));
const zoneLabel = (zones) => (zones && zones.length ? zones.map((z) => tcpa.ZONE_SHORT[z] || z).join('/') : 'zone unknown');

/** --followup --inspect: who is due and where the list shrank. No browser, sends nothing. */
function printFollowupPlan(args, msg) {
  const opts = followupOptions(args, msg), sd = opts.sameDay, tl = opts.teammateList;
  const { leads, stats: s } = followupDueFor(args, opts);
  if (sd) sameDay.assertInCohort(leads, sd.ids);
  if (tl) teammateTexted.assertInCohort(leads, tl.ids);
  const g = tcpa.check();
  if (sd) {
    const d = sameDay.describe(sd);
    console.log(`\n🦈 Same-day text — a second text to the Shark pros we already texted today (${sd.day})`);
    console.log(`   ${d.head}`);
    d.notes.forEach(([n, why]) => { if (n) console.log(`   − ${n.toLocaleString().padStart(5)}  ${why}`); });
    console.log('   📌 Not a stage of the follow-up board: it does not count these texts, so no lead moves there (and no "Touchpoint N" label is set). No Salesforce check and no thread read either: it just texts them.');
  } else if (tl) {
    const d = teammateTexted.describe(tl);
    console.log(`\n🤝 Teammate-texted text — the pros on the dashboard's Teammate texted tab: a teammate texted them, so a plain --followup holds them`);
    console.log(`   ${d.head}`);
    d.notes.forEach(([n, why]) => { if (n) console.log(`   − ${n.toLocaleString().padStart(5)}  ${why}`); });
  } else {
    console.log(`\n🦈 Shark follow-up — another text to Shark-tab accounts${opts.includeLds ? ' and LDS leads' : ''} with no touch from us in ${args.days}+ day(s)${args.scannedOnly ? ' (only Shark accounts seen on a report scan or backup)' : ''}`);
    console.log(`   Shark tab: ${s.onShark.toLocaleString()} account(s)`);
    if (opts.includeLds) {
      console.log(`   LDS leads: ${(s.onLds || 0).toLocaleString()} more (an LDS list or a Lost Demo stage, not on the Shark tab): worked after the Shark accounts, same filters; --no-lds leaves them out`);
      if (s.ldsUntouched) console.log(`              ${s.ldsUntouched.toLocaleString()} other LDS leads have had no touch from us at all: they start with the email cadence (email --email --core --scan lds), not with a follow-up`);
    }
  }
  [[s.noId, 'have no Salesforce account id (cannot open the account)'],
   [s.neverTouched, 'were never contacted by us — they need a first text (email --queue / --report)'],
   [s.tooRecent, `were touched less than ${args.days} day(s) ago`],
   [s.banned, 'are on the banlist'],
   [s.closedWon, 'are on the closed-won list (a Closed Won opportunity in the last ' + sfReview.WON_FLAG_DAYS + ' days — see the 🏆 Closed Won tab for the owner)'],
   [s.customer, 'are current customers on the held list (Customer Status "Enrolled", not a free Invoicing and Payments plan — see the 🤝 Current customers tab): never texted'],
   [s.optedOut, 'have an opt-out / "not interested" / do-not-contact note'],
   [s.reviewSkipped, 'were judged "skip" by a Salesforce review in the last 14 days (current customer or closed-won)'],
   [s.teammate, 'were texted by a TEAMMATE in the last 48h (report "Last Outgoing SMS DateTime") — held, not texted; listed on the dashboard\'s 🤝 Teammate tab'],
   [s.notTeammate, '--teammate: no teammate text in the last 48h (only teammate-texted accounts are due)'],
   [s.sequenceDone, 'have been through every step of the follow-up sequence'],
   [s.alreadySent, msg ? `already got this exact text ("${msg.name}")` : null],
   [s.overCap, args.maxTexts ? `were already texted ${args.maxTexts}+ times` : null],
   [s.otherZone, args.zoneOnly ? `are not in the ${args.zoneOnly.toUpperCase()} time zone (--zone-only), or have no known zone` : null],
   [s.textedToday, 'were texted by us in the last 24 hours (the once-a-day guard): they stay on the list for the next run'],
   [s.closedNow, 'are outside texting hours right now in their own time zone'],
   [s.unknownZoneClosed, 'have no known time zone, so they are texted only 12:00–8:00 PM Eastern (Mon–Sat), and that window is closed right now'],
   [s.noZone, 'have no known time zone and --unknown-zone hold is on: not texted without one'],
  ].forEach(([n, why]) => { if (n && why) console.log(`   − ${n.toLocaleString().padStart(5)}  ${why}`); });
  console.log(`   ✅ ${s.eligible.toLocaleString().padStart(5)}  eligible (${s.knownZone.toLocaleString()} with a known time zone on their own hours; ${(s.eligible - s.knownZone).toLocaleString()} with none, ${args.unknownZone === 'hold' ? 'never texted (--unknown-zone hold)' : 'texted only 12:00–8:00 PM Eastern'}) → a run ${{ none: 'texts them with no Salesforce review (--nocheck)', each: 'opens each account in Salesforce, checks it, texts it, then moves to the next (--check)', batch: 'reviews them in Salesforce first' }[followupCheckMode(args)]} (up to --max ${args.max} per batch), longest-waiting first`);
  if (msg && !msg.text) console.log('   💬 No wording yet: --same-day has no default text. A run needs  --message "…"  (or --template N), and the wording may not be one of the follow-up board\'s own stage texts.');
  else if (msg) console.log(`   💬 One text for everybody: [${msg.name}] "${msg.text.replace(/\n/g, ' ⏎ ')}"`);
  else {
    console.log('   📚 Follow-up sequence — the step an account is at decides its text:');
    followupSequence().forEach((q) => {
      const n = s.byStep[q.step] || 0, w = s.waitingForText[q.step] || 0;
      console.log(q.text ? `      Step ${q.step} — ${q.name}: ${n.toLocaleString()} due now  "${q.text.replace(/\n/g, ' ⏎ ')}"` : `      Step ${q.step} — ${q.name}: TEXT NOT WRITTEN YET — ${w.toLocaleString()} account(s) are waiting for it (nothing is sent for this step)`);
    });
  }
  console.log(`   ⏰ ${g.ok ? 'Texting is open in every US zone right now.' : `Not every US zone is open right now (${g.reason}) — each contact is checked against their own time zone; reopens ${tcpa.nextOpen()}`}`);
  console.log('');
  leads.slice(0, 30).forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${l.name}  — ${sd ? sameDay.sinceLabel(l, sd) : tl ? teammateTexted.sinceLabel(l, tl) : `${l.sinceDays} day(s) since touch (📱${l.texts} ✉️${l.emails})`} · ${zoneLabel(l.zones)}`));
  if (leads.length > 30) console.log(`  ... and ${(leads.length - 30).toLocaleString()} more`);
  console.log('');
}

/**
 * --holds: leads whose send was held because the pro replied (or a teammate texted). The conversation was saved when the hold happened (holdInbox.js).
 * Here each one is read and gets a subtle check-in text drafted in Luke's voice; replies that need a real answer are listed for Luke instead.
 *   --holds --inspect   list the open holds (no browser, no model, sends nothing)
 *   --holds --dry-run   also draft the texts and print them (no browser, sends nothing)
 *   --holds             draft, show the exact texts, ask, then send (texting hours, banlist and the once-a-day guard still apply)
 * `deps` lets a test swap the model, the sender and the prompt.
 */
async function runHolds(context, initialPage, args, deps = {}) {
  const complete = deps.complete || null;
  const send = deps.send || runReportCampaign;
  const prompt = deps.ask || ask;
  const login = deps.login || waitForSalesforceLogin;
  const items = holdInbox.open();
  if (!items.length) { console.log('\n  🧵 No open thread holds. When a send is held because a pro replied or a teammate texted, it lands here (and you get a notification).\n'); return { drafted: 0, sent: 0 }; }
  const show = (r) => `${r.accountName || '(unnamed)'}  — ${r.kind === 'replied' ? 'the pro replied' : 'teammate texted'} · held ${String(r.at).slice(0, 16).replace('T', ' ')}`;
  console.log(`\n🧵 THREAD HOLDS — ${items.length} open\n`);
  if (args.inspect) {
    items.forEach((r, i) => { console.log(`  ${String(i + 1).padStart(2)}. ${show(r)}\n      ${r.reason}${r.draft ? `\n      ✍️  draft: ${r.draft}` : ''}${r.status === 'review' ? `\n      👤 needs you: ${r.why}` : ''}`); });
    console.log('\n  --inspect: nothing was drafted or sent.\n'); return { drafted: 0, sent: 0 };
  }
  // Draft whatever has no decision yet (the conversation is read from what the hold saved).
  let drafted = 0;
  for (let r of items) {
    if (r.status !== 'new') continue;
    const d = await holdInbox.draft(r, { complete });
    holdInbox.setDraft(r, d); drafted++;
  }
  const fresh = holdInbox.open();
  const ready = fresh.filter((r) => r.status === 'drafted' && r.draft);
  const mine = fresh.filter((r) => r.status === 'review');
  fresh.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${show(r)}`);
    console.log(`      ${r.reason}`);
    console.log(r.status === 'drafted' ? `      ✍️  will text: "${r.draft}"` : `      👤 needs you (no text will be sent): ${r.why}`);
  });
  const skipped = [...holdInbox.readAll().values()].filter((r) => r.status === 'skipped' && r.draftedAt && Date.now() - Date.parse(r.draftedAt) < 36e5);
  if (skipped.length) console.log(`\n  🚫 ${skipped.length} not texted (opt-out / not interested): ${skipped.map((r) => r.accountName).join(', ')}`);
  console.log(`\n  ${ready.length} text(s) ready · ${mine.length} need you personally`);
  if (args.dryRun) { console.log('\n  🧪 --dry-run: nothing was sent.\n'); return { drafted, sent: 0 }; }
  if (!ready.length) { console.log(''); return { drafted, sent: 0 }; }
  if (!tcpa.anyOpen()) { commandLog('⏰', 'TCPA hours', `HOLD — no US time zone is inside texting hours right now (reopens ${tcpa.nextOpen(undefined, { any: true })}). Nothing sent.`); return { drafted, sent: 0 }; }
  if (!args.yes) {
    const ok = (await prompt(`\n  ▶️  Send these ${ready.length} text(s) exactly as shown? (y/N) `)).toLowerCase();
    if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'Nothing sent.'); return { drafted, sent: 0 }; }
  }
  const page = await login(context, initialPage);
  let sent = 0;
  for (const r of ready) {
    const lead = { name: r.accountName || '(unnamed account)', accountId: r.accountId, url: r.accountUrl, message: r.draft };
    await send(page, { start: 1, end: 1, delayMs: args.delayMs, force: false, message: r.draft, templateName: 'Thread-hold check-in', templateKey: createTemplateKey('text', 'Thread-hold check-in', r.draft), leads: [lead], ignoreSms: true, threadGuard: null, tcpa: true, source: 'Thread hold', mode: 'holds',
      onSent: async () => { sent++; holdInbox.markSent(r); } });
  }
  console.log(`\n  🧵 Thread holds finished: ${sent} of ${ready.length} text(s) sent.\n`);
  return { drafted, sent };
}

/** --followup: the batch loop. `deps` lets a test swap the browser-driven steps (login, review, send, prompt). */
async function runFollowup(context, initialPage, args, msg, deps = {}) {
  const fuRetired = followupRetired.problem(args); if (fuRetired) { console.log(fuRetired); return { batches: 0, texted: 0, won: 0 }; }      // plain --followup is retired (followupRetired.js): the board replaces it; --same-day / --teammate-texted / --followup --teammate are not
  const sdProblem = sameDayProblem(args, msg); if (sdProblem) { console.log(sdProblem); return { batches: 0, texted: 0, won: 0 }; }      // --same-day: no --check, real wording of its own (not a board stage text), before the browser is touched
  const login = deps.login || waitForSalesforceLogin;
  const review = deps.review || reviewCandidates;
  const send = deps.send || runReportCampaign;
  const prompt = deps.ask || ask;
  const opts = followupOptions(args, msg); opts.recordSkips = true;     // the text-cap skips go on the dashboard's 🛑 Skipped tab
  const modeLabel = args.sameDay ? 'Same-day text' : args.teammateTexted ? 'Teammate-texted text' : 'Shark follow-up';
  const runMode = args.sameDay ? sameDay.MODE : args.teammateTexted ? teammateTexted.MODE : 'followup';             // the `mode` of this run's log rows (a --followup that is running counts only its own)
  const checkMode = followupCheckMode(args);                            // 'none' (--nocheck, the default) | 'each' (--check: one account at a time, check then text) | 'batch' (see followupCheckMode)
  const skipReview = checkMode !== 'batch';                             // only 'batch' reviews the whole batch before its confirm; 'each' checks inside the send loop, one account at a time
  const fresh = () => { if (args.sameDay) { const sd = sameDay.cohort(); opts.cohort = sd.ids; opts.sameDay = sd; } if (args.teammateTexted) { const tl = teammateTexted.cohort(); opts.cohort = tl.ids; opts.teammateList = tl; } };   // the pros texted today grow while a --followup keeps texting: re-read them before every batch
  const page = await login(context, initialPage);
  // Same rules as --reengage: a terminal gets the keep-going prompt; a scheduled / piped run (or --once / --only) does one batch.
  const interactive = !!process.stdin.isTTY && !args.once && !args.only;
  const tried = new Set();
  const reviewCache = new Map();
  // a "proceed" verdict from the last 12 hours is still good: an interrupted run shouldn't re-read the same accounts (--check never uses it: looking at the profile again right before the text is its point)
  if (checkMode !== 'each') try { for (const [id, v] of textLog.readReviews()) if (v && v.verdict === 'proceed' && Date.now() - Date.parse(v.at) < 12 * 3600 * 1000) reviewCache.set(id, v); } catch (_) {}
  let batchMax = args.max, batches = 0;
  const startedAt = new Date().toISOString();
  const tally = { reviewed: 0, closedWon: 0, otherSkips: 0, unreadable: 0, noZone: 0, closedHours: 0 };
  const reviewOpts = { unknownZone: args.unknownZone === 'hold' ? 'hold' : 'strict', lookupZone: false, review: { allClosedOut: false, notes: false }, stats: tally };      // what the review reads: the opportunities only, no notes, no time zone lookup
  // --check, ONE account: open its Salesforce profile, check it (closed won / current customer / its hours: the same review as ever), and only then let its text go out. The review logs why it stopped an account.
  const checkOne = async (lead) => {
    const cleared = await review(page, [lead], 1, reviewCache, tried, 'text', 'Shark follow-up', reviewOpts);
    return cleared.length ? { ok: true } : { ok: false, reason: 'did not pass the Salesforce check (the review line above says why)' };
  };
  while (true) {
    if (!tcpa.anyOpen()) { commandLog('⏰', 'TCPA hours', `HOLD — no US time zone is inside texting hours right now (reopens ${tcpa.nextOpen(undefined, { any: true })}). Nothing sent.`); break; }
    fresh();
    const { leads, stats } = followupDueFor(args, opts);
    leads.forEach((l) => { if (l.list === 'LDS') l.source = LDS_FOLLOWUP_SOURCE; });      // the send records `lead.source || the run's source`: an LDS lead stays an LDS lead
    if (args.sameDay) sameDay.assertInCohort(leads, opts.cohort);
    if (args.teammateTexted) teammateTexted.assertInCohort(leads, opts.cohort);
    const candidates = leads.filter((l) => !tried.has(`text|${l.accountId}`));
    commandLog('🦈', modeLabel, `${candidates.length} account(s) due${candidates.some((l) => l.list === 'LDS') ? ` (${candidates.filter((l) => l.list === 'LDS').length} of them LDS leads, texted after the Shark accounts)` : ''} — ${args.sameDay ? 'texted earlier today' : args.teammateTexted ? 'a teammate texted them (🤝 Teammate texted tab)' : `${args.days}+ day(s) since our last touch`} (${checkMode === 'none' ? 'no Salesforce review (--nocheck; add --check to open and check each account right before its text), ' : checkMode === 'each' ? 'checking each account in Salesforce right before its text (--check), ' : 'reviewing '}up to ${batchMax}); ${stats.knownZone} have a known time zone and follow their own hours, the rest are texted ${args.unknownZone === 'hold' ? 'never (--unknown-zone hold)' : 'only 12:00–8:00 PM Eastern, Mon–Sat'}`);
    if (!candidates.length) break;
    // Salesforce review of the WHOLE batch before it is confirmed (opportunities only: closed-won in the last 30 days, current customers). Skips don't count against the cap. Only --teammate-texted still starts this way.
    // --nocheck (the default of --followup / --same-day, and --no-review) skips it: no account is opened. --check skips it too: each account is checked one at a time inside the send loop (checkOne), right before its own text.
    // Either way followupDue has already left out the closed-won list, the held current customers and the pros an earlier review said to skip.
    const due = skipReview ? candidates.slice(0, batchMax) : await review(page, candidates, batchMax, reviewCache, tried, 'text', 'Shark follow-up', reviewOpts);
    if (!due.length) { commandLog('ℹ️', 'Shark follow-up', 'nobody in this batch passed the review / hours check'); break; }
    console.log(`\n  ${'═'.repeat(66)}\n  🦈 ${args.sameDay ? 'SAME-DAY TEXT' : args.teammateTexted ? 'TEAMMATE-TEXTED TEXT' : 'SHARK FOLLOW-UP'} — ${due.length} account(s) ready for ${args.sameDay ? 'a second text today' : args.teammateTexted ? 'a text after a teammate reached out' : 'another text'}${checkMode === 'each' ? ' — each one is checked in Salesforce right before its text' : ''}${args.dryRun ? '   (--dry-run: nothing will be sent)' : ''}\n  ${'═'.repeat(66)}`);
    if (args.sameDay) console.log('  📌 Not a stage of the follow-up board: it does not count this text, so no lead moves there (and no "Touchpoint N" label is set). No Salesforce check and no thread read: it just texts.');
    // One text for everybody (--template / --message), or one group per sequence step: each step goes out under its own template name.
    const groups = msg ? [{ step: null, name: msg.name, text: msg.text, leads: due }]
      : [...new Set(due.map((l) => l.step))].sort((a, b) => a - b).map((st) => { const l0 = due.find((l) => l.step === st); return { step: st, name: l0.stepName, text: l0.stepText, leads: due.filter((l) => l.step === st) }; });
    let n0 = 0;
    for (const g of groups) {
      console.log(`  ${g.step ? `Step ${g.step} — ` : 'Text — '}[${g.name}] → ${g.leads.length} account(s):\n    ${g.text.split('\n').join('\n    ')}\n`);
      g.leads.forEach((l) => console.log(`  ${String(++n0).padStart(3)}. ${l.name}  — ${args.sameDay ? sameDay.sinceLabel(l, opts.sameDay) : args.teammateTexted ? teammateTexted.sinceLabel(l, opts.teammateList) : `${l.sinceDays} day(s) since touch (📱${l.texts} ✉️${l.emails})`} · ${zoneLabel(textLog.zonesFor(l.accountId) || l.zones)}${l.list === 'LDS' ? ' · 🗂️ LDS lead' : ''}`));
      console.log('');
    }
    if (args.dryRun) {
      if (checkMode === 'each') {      // --check --dry-run: do the checks, one account at a time, and say who would be texted. Nothing is sent.
        let would = 0;
        for (const l of due) { const r = await checkOne(l); if (r.ok) would++; commandLog('🧪', 'Dry run', `${l.name} — ${r.ok ? 'passed the check: would be texted' : 'did not pass the check: would NOT be texted'}`); }
        console.log(`\n  🧪 --dry-run: ${would} of ${due.length} would be texted.`);
      }
      console.log('\n  🧪 --dry-run: nothing was sent.\n'); break;
    }
    if (!args.yes) {
      const ok = (await prompt(checkMode === 'each' ? `  ▶️  Check each of these ${due.length} account(s) in Salesforce, one at a time, and text the ones that pass? (y/N) ` : `  ▶️  Send ${groups.length > 1 ? 'these texts' : 'this text'} to these ${due.length} account(s)? (y/N) `)).toLowerCase();
      if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'Nothing sent.'); break; }
    }
    due.forEach((l) => tried.add(`text|${l.accountId}`));
    batches++;
    // An account we have only EMAILED has an empty Texts thread, which the thread guard cannot tell from one that did not load (it held all of them). Believe an empty thread for these, and only
    // these (see runThreadGuard): no text of ours, at least one email (so it is not an account someone texted outside Assistant), nothing in the report's SMS column, no reply on file.
    // --teammate / --teammate-texted expect a conversation, so they never do.
    const repliedIds = new Set(); try { for (const r of textLog.readReplyRows()) if (r && r.accountId) repliedIds.add(String(r.accountId).toLowerCase().slice(0, 15)); } catch (_) {}
    const threadEmptyOk = args.teammate || args.teammateTexted ? undefined : (l) => l.texts === 0 && l.emails > 0 && !l.lastOutgoingSms && !repliedIds.has(String(l.accountId || '').toLowerCase().slice(0, 15));
    for (const g of groups) {
      // ignoreSms: --same-day waives the report's 48h SMS guard too: a --shark backup taken later today puts OUR texts of today in that column and would hold everybody. A teammate's text is
      // still caught by followupDue (teammateTexted) and, for the runs that read it, by the thread guard (--same-day does not read the thread: sameDay.THREAD_READ, Luke 2026-11-03).
      await send(page, { start: 1, end: g.leads.length, delayMs: args.delayMs, force: false, message: g.text, templateName: g.name, templateKey: createTemplateKey('text', g.name, g.text), step: g.step, leads: g.leads, ignoreSms: !!args.teammate || !!args.sameDay || !!args.teammateTexted, threadGuard: args.teammateTexted ? 'nudge' : args.teammate ? 'teammate' : args.sameDay && !sameDay.THREAD_READ ? null : 'normal', tcpa: true, tcpaUnknown: args.unknownZone === 'hold' ? 'hold' : undefined, source: args.sameDay ? sameDay.SOURCE : args.teammateTexted ? teammateTexted.SOURCE : FOLLOWUP_SOURCE, mode: runMode, sameDay: !!args.sameDay,
        precheck: checkMode === 'each' ? checkOne : undefined,      // --check: runReportCampaign calls this for each account right before its text (open the profile, check it, then send)
        threadEmptyOk,
        // after each text that really went out: the dashboard's "Re-engage at stage" becomes "Touchpoint N" (our Nth text/email to this account). Not for --same-day: it is no stage of the follow-up board, so it sets no label either.
        onSent: async (lead) => { if (args.teammateTexted) { try { const h = teammateTexted.closeHold(lead.accountId); if (h) commandLog('🧵', 'Hold closed', `${lead.name} — texted, so email --holds no longer lists it`); } catch (_) {} } if (args.sameDay) return; const r = textLog.recordTouchpointStage({ accountId: lead.accountId, accountName: lead.name, note: `set by the Shark follow-up bot after "${g.name}"${g.step ? ` (step ${g.step})` : ''}` }); if (r) commandLog('🏷️', 'Stage', `${lead.name} → ${r.stage} on the dashboard`); },
      });
    }
    if (!interactive) break;
    fresh();
    const remaining = followupDueFor(args, opts).leads.filter((l) => !tried.has(`text|${l.accountId}`)).length;
    const ans = (await prompt(`\n  🦈 Batch done. Still due: ${remaining}.\n  Keep going? Enter how many accounts to run next (e.g. 25, 100), or press Enter / q to stop: `)).toLowerCase();
    const n = parseInt(ans, 10);
    if (!n || n < 1) break;
    batchMax = n;
  }
  // What this run did. (Texts are counted from the log, so a failed send is not claimed.)
  const texted = textLog.readAll().filter((r) => r.mode === runMode && r.at >= startedAt).length;
  const won = [...new Set(textLog.readClosedWon().values())].filter((w) => w.at >= startedAt && w.source === 'Shark follow-up').length;
  console.log(`\n  🦈 ${modeLabel} finished: ${texted} text(s) sent · ${won} account(s) added to the closed-won list${args.dryRun ? '  (--dry-run: nothing is ever sent)' : ''}.`);
  if (tally.reviewed) console.log(`     Reviewed in Salesforce: ${tally.reviewed} — closed won in the last ${sfReview.WON_FLAG_DAYS} days: ${tally.closedWon} (${Math.round((100 * tally.closedWon) / tally.reviewed)}%)${tally.otherSkips ? ` · other stops (current customer): ${tally.otherSkips}` : ''}${tally.unreadable ? ` · could not be read: ${tally.unreadable}` : ''}${tally.noZone ? ` · no time zone found: ${tally.noZone}` : ''}${tally.closedHours ? ` · outside their hours right now: ${tally.closedHours}` : ''}`);
  if (!msg) { const w = textLog.followupDue({ ...opts, now: new Date() }).stats.waitingForText; for (const [st, n] of Object.entries(w)) console.log(`     ⏳ ${n} account(s) are at step ${Number(st) - 1} and waiting for the step ${st} text (${followupSequence().find((q) => q.step === Number(st)).name}), which is not written yet.`); }
  console.log(args.sameDay ? '     Dashboard (email --sent): these texts are in the outreach log, but the follow-up board does not count them (no lead moved) and no "Touchpoint N" label was set.\n'
    : '     Dashboard (email --sent): 🏆 Closed Won tab = who closed them; the stage of each texted account now reads "Touchpoint N"; the Follow-up column shows each pro\'s step.  Terminal list: node textLog.js --closed-won\n');
  return { batches, texted, won };
}

// ============================================================================
// --industry: read each dashboard account's Industry field from its Salesforce page (read-only)
// ============================================================================
const INDUSTRY_SECONDS_EACH = 5;      // what the time estimates assume: a Lightning account page takes a few seconds to render
const fmtDuration = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

/** The accounts a run would read: everything still unread, capped by --max (a --dry-run reads 3 unless --max says otherwise). */
function industryPlan(args) {
  const { todo, stats } = textLog.industryTodo({ refresh: args.refresh, kind: args.kind, only: args.only });
  const cap = args.maxSet ? args.max : (args.dryRun ? 3 : Infinity);
  return { todo, stats, run: todo.slice(0, cap) };
}

/** --industry --inspect: what a run would read. No browser, nothing sent. */
function printIndustryPlan(args) {
  const { todo, stats: s, run } = industryPlan(args);
  const g = [0, 0, 0]; todo.forEach((l) => g[l.group]++);
  console.log(`\n🏭 Industry — read the Industry and Timezone of each Salesforce account's summary (read-only: nothing is sent or changed)`);
  console.log(`   Dashboard accounts${args.kind ? ` on the ${args.kind} list` : ''}: ${s.total.toLocaleString()}`);
  [[s.withValue, 'already have an industry from Salesforce'], [s.blank, 'were read and have nothing in the Industry field'], [s.unavailable, 'have an account page that is not available (deleted / merged / no access)'], [s.gaveUp, 'had no Industry field on their page twice (left alone; --refresh tries them again)']]
    .forEach(([n, why]) => { if (n) console.log(`   − ${n.toLocaleString().padStart(5)}  ${why}`); });
  console.log(`   ✅ ${todo.length.toLocaleString().padStart(5)}  to read${args.refresh ? ' (--refresh: everything is read again)' : ''}: ${g[0].toLocaleString()} on the Shark tab, ${g[1].toLocaleString()} on LDS, ${g[2].toLocaleString()} others`);
  if (s.noId) console.log(`   ⚠️  ${s.noId.toLocaleString()} dashboard row(s) have no Salesforce account id, so they cannot be opened`);
  console.log(`   ⏱️  This run reads ${run.length.toLocaleString()} (${args.maxSet ? `--max ${args.max}` : args.dryRun ? '--dry-run reads 3 unless --max says more' : 'all of them; --max N reads fewer'}): about ${INDUSTRY_SECONDS_EACH} s each, roughly ${fmtDuration(run.length * INDUSTRY_SECONDS_EACH * 1000)}. Every account is saved as soon as it is read: Ctrl-C any time and run it again to carry on.\n`);
  run.slice(0, 20).forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${l.name}  (${['Shark', 'LDS', 'other'][l.group]})`));
  if (run.length > 20) console.log(`  ... and ${(run.length - 20).toLocaleString()} more`);
  console.log('');
}

/**
 * --industry: open each account in Salesforce, read its Industry field, save it to account-industry.jsonl (the dashboard's Industry column shows it).
 * Read-only: nothing is sent, nothing in Salesforce is changed. `deps` lets a test swap the browser-driven steps (login, read, save).
 */
async function runIndustry(context, initialPage, args, deps = {}) {
  const login = deps.login || waitForSalesforceLogin;
  const read = deps.read || accountIndustry.readIndustry;
  const save = deps.save || ((row) => textLog.recordSfIndustry(row));
  const refreshDashboard = deps.dashboard || (() => textLog.generateDashboard());
  const dry = !!args.dryRun;
  const { todo, stats, run } = industryPlan(args);
  commandLog('🏭', 'Industry', `${todo.length.toLocaleString()} account(s) still need an industry from Salesforce${args.kind ? ` (${args.kind} list)` : ''}; reading ${run.length.toLocaleString()}${dry ? ' — --dry-run: shows what each page offers, saves nothing' : ''}`);
  if (!run.length) { console.log(`\n  Nothing to read${stats.total ? ' — every account on the dashboard already has an answer (--refresh reads them again).' : ': the dashboard has no accounts yet.'}\n`); return { read: 0 }; }
  console.log(`  ⏱️  About ${INDUSTRY_SECONDS_EACH} s each, roughly ${fmtDuration(run.length * INDUSTRY_SECONDS_EACH * 1000)} for ${run.length.toLocaleString()}. Saved after every account: Ctrl-C any time (it stops after the one it is on), then run it again to carry on.`);
  const page = await login(context, initialPage);
  let stop = false;
  const onInt = () => { if (stop) process.exit(130); stop = true; console.log('\n  🛑 Stopping after this account (Ctrl-C again quits now)…'); };
  process.on('SIGINT', onInt);
  const tally = { value: 0, blank: 0, unavailable: 0, miss: 0, failed: 0, zone: 0 }, byInd = {}, byZone = {};
  let n = 0, failStreak = 0, missStreak = 0; const started = Date.now();
  try {
    for (const lead of run) {
      if (stop) break;
      n++;
      let r; try { r = await read(page, lead.accountId); } catch (e) { r = { ok: false, note: e.message }; }
      const where = `${n}/${run.length}`, eta = fmtDuration(((Date.now() - started) / n) * (run.length - n));
      if (!r.ok) {
        tally.failed++; failStreak++;
        console.log(`  ❌ ${where} could not read ${lead.name} — ${r.note || 'the page could not be read'}${dry ? '' : ' (not saved: it is tried again next run)'}`);
        if (dry && r.html) console.log(`       around the label: ${r.html}`);
        if (failStreak >= 5) { console.log('\n  ⛔ 5 reads failed in a row — stopping. Check that the Chrome window on port 9327 is open and logged into Salesforce, then run it again. (email --industry --dry-run --only <accountId> shows what a page offers.)\n'); break; }
        continue;
      }
      failStreak = 0;
      if (r.industry) { tally.value++; byInd[r.industry] = (byInd[r.industry] || 0) + 1; missStreak = 0; }
      else if (r.blank) { tally.blank++; missStreak = 0; }
      else if (r.unavailable) { tally.unavailable++; missStreak = 0; }
      else { tally.miss++; missStreak++; }
      if (!dry) save({ accountId: lead.accountId, accountName: lead.name, industry: r.industry || null, via: r.via, blank: r.blank, miss: r.miss, unavailable: r.unavailable, note: r.note });
      // the account summary's Timezone, from the same visit: saved as the account's time zone (so it can be texted inside ITS hours)
      let zoneNote = '';
      if (r.timezone) {
        const tz = tcpa.parseZone(r.timezone);
        if (tz) {
          const old = textLog.zonesFor(lead.accountId);
          if (!dry && !(old && old.length === 1 && old[0] === tz)) (deps.saveZone || ((row) => textLog.recordZone(row)))({ accountId: lead.accountId, accountName: lead.name, zones: [tz], source: 'account page "Timezone"' });
          tally.zone++; const zs = tcpa.ZONE_SHORT[tz] || tz; byZone[zs] = (byZone[zs] || 0) + 1; zoneNote = `  🕐 ${zs}`;
        } else zoneNote = `  🕐 ? "${r.timezone}"`;
      }
      const what = r.industry ? `🏭 ${r.industry}` : r.blank ? '⚪ empty in Salesforce' : r.unavailable ? '🚫 page not available' : '❔ no Industry field on the page';
      console.log(`  ${where} ${what}${zoneNote}  — ${lead.name}   (${r.via}${r.tab ? ', Details tab' : ''} · ${((r.ms || 0) / 1000).toFixed(1)}s · ~${eta} left)`);
      if (dry) {
        if (r.timezone) console.log(`       time zone: "${r.timezone}" ${tcpa.parseZone(r.timezone) ? '→ ' + (tcpa.ZONE_SHORT[tcpa.parseZone(r.timezone)] || tcpa.parseZone(r.timezone)) : '(not a zone the bot knows)'} (${r.tzVia})`);
        else console.log('       time zone: none on the page');
        console.log(`       fields on the page: ${(r.labels || []).join(', ') || '(none read)'}`);
        if (r.industryLabels && r.industryLabels.length) console.log(`       labels with "industry" in them: ${r.industryLabels.join(', ')}`);
        if (r.html) console.log(`       around the label: ${r.html}`);
      }
      if (!dry && n % 100 === 0) { try { refreshDashboard(); } catch (_) {} }       // watch the dashboard fill in while it runs
      if (missStreak >= 10) { console.log('\n  ⛔ 10 accounts in a row have no Industry field on their page — this layout is probably not one the bot reads yet. Stopping.\n     Run  email --industry --dry-run --only <accountId>  on one of them and send me what it prints.\n'); break; }
    }
  } finally { process.removeListener('SIGINT', onInt); }
  const top = Object.entries(byInd).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`\n  🏭 Industry: read ${n} account(s) — ${tally.value} with an industry · ${tally.blank} empty in Salesforce · ${tally.unavailable} page not available · ${tally.miss} no Industry field on the page · ${tally.failed} could not be read${dry ? '   (--dry-run: nothing was saved)' : ''}`);
  if (top) console.log(`     Most common: ${top}`);
  const zs = Object.entries(byZone).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`     🕐 Time zone read off the same pages: ${tally.zone} of ${n}${zs ? ' — ' + zs : ''}${dry ? '' : '  (saved: the follow-up bot and the dashboard use them to text each pro inside their own hours)'}`);
  if (!dry) { try { refreshDashboard(); console.log('     Saved to account-industry.jsonl. The dashboard\'s Industry column now shows these (open it with email --sent).\n'); } catch (_) {} }
  else console.log('');
  return { read: n, ...tally };
}

// ============================================================================
// --harvest: scan the report that is open in a report view (no account is opened)
// ============================================================================
/** The columns of a scanned report with how many rows have a value in each → [[header, rows], …], most-filled first. */
function reportColumns(leads) {
  const seen = new Map();
  for (const l of leads) for (const k of Object.keys(l.cols || {})) seen.set(k, (seen.get(k) || 0) + 1);
  return [...seen.entries()].sort((x, y) => y[1] - x[1]);
}

/**
 * --harvest: scan the report you have open in a report view (the Shark report) and save what it already shows. No account page is opened, so it
 * takes seconds: the accounts are tagged with their list (#shark), and the report's Time Zone, Industry and Email columns are saved (each only if
 * the report has that column). Read-only. --dry-run prints the report's columns and a few rows and saves nothing.
 * The old per-account read (time zone, opportunities, notes, original rep) is --harvest --deep. `deps.open` lets a test swap the browser step.
 */
async function runReportHarvest(context, initialPage, args, deps = {}) {
  const open = deps.open || openReportAndHarvest;
  const refresh = deps.dashboard || (() => textLog.generateDashboard());
  const kind = normKind(args.kind) || 'Shark';
  const dry = !!args.dryRun;
  commandLog('🌾', 'Harvest', `scanning the ${kind} report you open in a report view${dry ? ' — --dry-run: nothing is saved' : ''}. No account is opened (the per-account read is --harvest --deep).${args.maxSet ? ' --max only applies to --harvest --deep.' : ''}`);
  const r = await open(context, initialPage, { ...args, mode: null, kind, noRecord: dry });
  if (!r) return null;
  const leads = r.leads.filter((l) => l.accountId);
  if (!leads.length) { console.log('\n⚠️  No accounts found — open the report so its detail rows are visible (expand collapsed groups, let it finish loading), then retry.\n'); return null; }
  const src = r.source || {};
  const listName = src.name || `${kind} list`, listKind = src.kind || kind;
  const cols = reportColumns(leads);
  const z = r.leads.zoneColumn || textLog.zonesFromReport(leads, { save: false });
  const ic = r.leads.industryColumn || textLog.industryFromReport(leads, { save: false });
  const ec = r.leads.emailColumn || textLog.emailsFromReport(leads, { save: false });
  const of = `of ${leads.length.toLocaleString()}`;
  const line = (label, c, what, hint) => console.log(`     ${label.padEnd(10)}${c.header ? (dry ? `the report's "${c.header}" column: ${c.recorded.toLocaleString()} would be saved (${c.total.toLocaleString()} ${of} account(s) have one)` : `the report's "${c.header}" column is filled on ${c.total.toLocaleString()} ${of} account(s) — ${c.recorded.toLocaleString()} new/changed`) : `no ${what} column on this report${hint ? ` — ${hint}` : ''}`}`);
  console.log(`\n  ${dry ? '🧪 HARVEST (--dry-run: nothing was saved)' : '🌾 HARVESTED'}  ${leads.length.toLocaleString()} account(s) from "${listName}"${dry ? '' : ` — tagged #${String(listKind).toLowerCase()}; the scan is on the dashboard's Daily harvest tab`}`);
  line('time zone', z, 'Time Zone', 'zones then come from email --zones');
  line('industry', ic, 'Industry', "add the Account's Industry as a column and every scan saves it");
  line('email', ec, 'Email', 'add the Email column to the report to save it here');
  const thin = r.leads.thinRows || 0;
  if (thin) console.log(`     ⚠️  ${thin.toLocaleString()} row(s) came back with most cells empty — the report was probably still loading. Run it again once every row has its columns (the second run only adds what is missing).`);
  if (dry) {
    console.log(`\n     columns on this report (rows with a value): ${cols.map(([h, n]) => `${h} ${n}`).join(' · ') || '(only the account name)'}`);
    console.log('     first rows:');
    leads.slice(0, 5).forEach((l, i) => console.log(`       ${i + 1}. ${l.name}  — ${Object.entries(l.cols || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(' · ')}`));
    console.log('');
    return { leads: leads.length, dry: true };
  }
  console.log('     (no account was opened. The per-account read — time zone, opportunities, notes, original rep — is:  email --harvest --deep)');
  try { refresh(); console.log('     dashboard refreshed (email --sent)'); } catch (_) {}
  console.log('');
  return { leads: leads.length, zones: z, industry: ic, email: ec };
}

// ============================================================================
// --send: stay running through the day and text each queued pro as THEIR OWN window opens
// ============================================================================
/** The message a run will send: --template N / --message, else ask (the same choices the --queue run offers). → { message, templateId, templateName, templateKey } | null */
async function pickSendMessage(args) {
  let message = args.message, templateId = args.template;
  if (!message) {
    if (templateId && TEMPLATES[templateId]) message = TEMPLATES[templateId].text;
    else {
      listTemplates();
      const choice = await ask('\nPick a template number, or type your own message: ');
      if (TEMPLATES[choice]) { message = TEMPLATES[choice].text; templateId = choice; }
      else { message = choice; templateId = null; }
    }
  }
  if (!message) { console.log('Message is required.'); return null; }
  const templateName = templateId && TEMPLATES[templateId] ? TEMPLATES[templateId].name : 'Custom message';
  return { message, templateId, templateName, templateKey: createTemplateKey('text', templateName, message) };
}

/** --until HH:MM → that time today (local clock), or null. */
function parseUntil(s, base = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(base); d.setHours(+m[1], +m[2], 0, 0);
  return d;
}

/** Of the pros whose window is closed now, the ones whose window opens LATER TODAY (a day is the pro's own day), each with the minute it opens. */
function openingsToday(waiting, t) {
  const out = [];
  for (const w of waiting) {
    const zs = w.zones && w.zones.length ? w.zones : null;
    const at = tcpa.openingFor(zs, t);
    if (!at) continue;
    const tz = (zs && zs[0]) || 'America/New_York';
    if (tcpa.localDay(at, tz) !== tcpa.localDay(t, tz)) continue;        // tomorrow (or after a Sunday): not today
    out.push({ lead: w.lead, zones: zs, at });
  }
  return out;
}

/**
 * --send (with --shark or --queue): the hands-off day. Texts every queued pro whose own window is open, then waits for the next window to open
 * and texts those, until nobody is left who can still be texted today (or --until HH:MM). Same rules as --queue: each pro only inside their own
 * hours, banned never, a current customer / closed-won account never, the daily / SMS / contact guards on, a pro with no known zone left unless --unknown-zone strict. A text that fails is tried
 * once more, then left for the next run. Ctrl-C stops after the text it is on.
 * o = { message, templateName, templateKey, delayMs, unknownZone, until, yes }; `deps` lets a test swap the clock, the waiting, the queue, the sender and the prompt.
 */
async function runQueueDay(page, o, deps = {}) {
  if (textDryRun()) { console.log('\n  🧪 --dry-run / --test: --send is the hands-off day (it waits for each pro\'s window and keeps texting until the day is done), so it has no dry run. Nothing was started and nothing was sent.\n     To see who is queued and when their windows open (no browser, nothing sent):  email --queue --inspect\n'); return { sent: 0, batches: 0, dryRun: true }; }
  const now = deps.now || (() => new Date());
  const wait = deps.wait || sleep;
  const pendingLeads = deps.pending || (() => textQueue.pendingLeads());
  const mark = deps.mark || ((l) => textQueue.markTexted(l.accountId));
  const runBatch = deps.runBatch || runReportCampaign;
  const prompt = deps.ask || ask;
  const unknownZone = o.unknownZone === 'hold' ? 'hold' : 'strict';
  const key = (l) => String(l.accountId || '').toLowerCase().slice(0, 15);
  const until = parseUntil(o.until, now());
  const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  // A current customer or a closed-won account is never texted (the overnight run's rule: tomorrowSend.defaultScreen). The email pass and the reviews add to those
  // lists while a run goes on, so they are re-read each time the queue is read. Fail closed: if the check cannot be loaded, nothing is sent.
  let screen;
  if (deps.screen !== undefined) screen = deps.screen;
  else { try { screen = require('./tomorrowSend').defaultScreen(textLog); } catch (e) { console.log(`\n  ⛔ The current-customer check could not be loaded (${e.message}), so nothing was sent.\n`); return { sent: 0, batches: 0, noScreen: true }; } }
  const heldOut = new Map();                                              // key → why: queued pros left out (a current customer / a closed-won account); they stay in the queue
  const queued = () => {
    const all = pendingLeads();
    if (!screen) return all;
    if (screen.refresh) screen.refresh();
    return all.filter((l) => {
      const why = screen.check(l);
      if (!why) return true;
      if (!heldOut.has(key(l))) { heldOut.set(key(l), why); commandLog('🛡️', 'Left out', `${l.name} — ${why}, so it is never texted (it stays in the queue)`); }
      return false;
    });
  };
  let stop = false;
  const onInt = () => { if (stop) process.exit(130); stop = true; console.log('\n  🛑 Stopping after the text it is on (Ctrl-C again quits now)…'); };
  if (!deps.noSignals) process.on('SIGINT', onInt);
  if (!deps.noKeepAwake && process.platform === 'darwin') { try { require('child_process').spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); commandLog('☕', 'Keep awake', 'the Mac stays awake while this runs'); } catch (_) {} }
  const tries = new Map(), gaveUp = new Set();
  let totalSent = 0, batches = 0, last = null;
  try {
    if (!pendingLeads().length) { console.log('\n  🗂️  The text queue is empty — nothing to send today. Back up the Shark list first:  email --shark\n'); return { sent: 0, batches: 0, empty: true }; }
    const first = queued();
    if (!first.length) { console.log(`\n  🛡️  Everybody in the queue is a current customer or a closed-won account (${heldOut.size}), so nothing is texted.\n`); return { sent: 0, batches: 0, nothingToday: true, heldOut: heldOut.size }; }
    last = partitionByHours(first, { unknownZone, now: now() });
    printHoursPlan(last);
    const later = openingsToday(last.waiting, now());
    commandLog('📅', 'Today', `${last.open.length} open now, ${later.length} open later today${later.length ? ` (the last at ${clock(new Date(Math.max(...later.map((x) => x.at.getTime()))))})` : ''}; this run stays open and texts each as their own window opens${until ? `, until ${clock(until)}` : ''}. Ctrl-C stops it.`);
    if (!last.open.length && !later.length) { console.log('\n  ⏰ Nobody in the queue can be texted today (no known time zone, window already closed, or banned). Nothing sent.\n'); return { sent: 0, batches: 0, nothingToday: true }; }
    if (!o.yes) {
      const ans = (await prompt(`\n  ▶️  Text "${o.templateName}" to the queued pros automatically as each one's window opens, until everyone is done? (y/N) `)).toLowerCase();
      if (ans !== 'y' && ans !== 'yes') { commandLog('🛑', 'Mission aborted', 'Nothing sent'); return { sent: 0, batches: 0, aborted: true }; }
    }
    while (!stop) {
      const t = now();
      if (until && t >= until) { commandLog('🛑', 'Until', `reached ${clock(until)} — stopping`); break; }
      const part = partitionByHours(queued().filter((l) => !gaveUp.has(key(l))), { unknownZone, now: t });
      last = part;
      if (part.open.length) {
        batches++;
        commandLog('📤', 'Sending', `${part.open.length} pro(s) are inside their hours now`);
        let res;
        try {
          res = await runBatch(page, { message: o.message, templateName: o.templateName, templateKey: o.templateKey, delayMs: o.delayMs, leads: part.open, onSent: mark, tcpa: true, tcpaUnknown: unknownZone, start: 1, end: null, shouldStop: () => stop });
        } catch (e) { commandLog('❌', 'Sending stopped', `${e.message} — check that the Chrome window is still open and logged into Salesforce`); break; }
        totalSent += (res && res.sentCount) || 0;
        const still = new Set(pendingLeads().map(key));                 // attempted and still queued: it did not go out (a failure or a guard)
        for (const l of part.open) if (still.has(key(l))) { const n = (tries.get(key(l)) || 0) + 1; tries.set(key(l), n); if (n >= 2) gaveUp.add(key(l)); }
        continue;                                                        // more may have opened while this batch was going out
      }
      const next = openingsToday(part.waiting, t);
      if (!next.length) break;                                           // nobody left who can still be texted today
      const at = new Date(Math.min(...next.map((x) => x.at.getTime())));
      const group = next.filter((x) => x.at.getTime() === at.getTime());
      commandLog('⏳', 'Waiting', `${group.length} pro(s) open at ${clock(at)}${next.length > group.length ? `, ${next.length - group.length} more later today` : ''} — leave this window and the Mac as they are (Ctrl-C stops)`);
      while (!stop && now() < at && !(until && now() >= until)) await wait(Math.min(30000, at - now()));
      if (!stop && now() < at) { /* --until came first */ }
    }
  } finally { if (!deps.noSignals) process.removeListener('SIGINT', onInt); }
  const p = last || { open: [], waiting: [], unknown: [], banned: [] };
  const leftZone = p.unknown.length, leftClosed = p.waiting.length + p.open.length;
  console.log(`\n  🏁 Done for today: ${totalSent} text(s) sent in ${batches} batch(es).`);
  if (leftZone) console.log(`     ${leftZone} pro(s) with no known time zone were left (--unknown-zone strict texts them 12:00–8:00 PM Eastern; email --harvest or --industry find their zone).`);
  if (leftClosed) console.log(`     ${leftClosed} pro(s) are still queued for the next run (window closed for today, or not texted).`);
  if (gaveUp.size) console.log(`     ${gaveUp.size} pro(s) were tried twice and not texted (a guard — texted in the last day / by anyone in 48h — or an error). If every text failed, check that the Chrome window is still logged into Salesforce.`);
  if (heldOut.size) console.log(`     ${heldOut.size} pro(s) were left out because they are a current customer or a closed-won account (they stay in the queue and were never texted).`);
  console.log('     Dashboard: email --sent\n');
  return { sent: totalSent, batches, gaveUp: gaveUp.size, left: leftZone + leftClosed, heldOut: heldOut.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // no flags = the EMAIL campaign and its welcome screen (run.sh does the same first, so the email Chrome is the one it starts); --test and --dry-run alone do not name a campaign, so they mean the email campaign too. `--text` is the text campaign.
  if (process.argv.slice(2).every((a) => a === '--test' || a === '--dry-run' || a === '--dryrun')) args.email = true;
  const ldsBlock = pipelineOnlyBlock(args);
  if (ldsBlock) { console.error(ldsBlock); process.exit(1); }
  const testMode = applyTestMode(args);      // --test: the testing list and a DRY RUN, decided here, before anything below looks at args.dryRun
  const practiceProblem = practiceFlagProblem(process.argv.slice(2));
  if (practiceProblem) { console.error(practiceProblem); process.exit(1); }
  const dryAsked = practiceFlagGiven(args, process.argv.slice(2));
  require('./clickGuard').lockSend(dryAsked);      // --dry-run / --test: from here on NOTHING can click Send, whatever mode runs (clickGuard.clickSend is the only place a text is sent): textAccount then types the text, checks it and takes it out again
  if (dryAsked && args.send && !args.tomorrow && (args.queue || args.snapshot)) { console.error('--dry-run / --test cannot go with --send: --send is the hands-off all-day run (it waits for each pro\'s window and keeps texting until the day is done), so it has no dry run.\n  To see who is queued and when their windows open (no browser, nothing sent):  email --queue --inspect\n  For the overnight run (--tomorrow), --dry-run shows its timetable and stops.\n(Nothing was started.)'); process.exit(1); }
  if ((args.content || args.postdemo) && !args.email) { console.error('--content / --postdemo only work with --email, e.g.:  email --email --content --dry-run\n(Without --email this would have started a TEXT run, so nothing was started.)'); process.exit(1); }
  if (args.neverEmailed && !(args.email || args.cadence)) { console.error('--never-emailed goes with --email (the run) or --cadence (the preview), for example:\n  node Assistant.js --cadence --never-emailed --email-template curiosity     (no browser, nothing sent)\n  email --email --from-dashboard --never-emailed --email-template curiosity --range 1-5 --dry-run\n(Without --email this would have started a TEXT run, so nothing was started.)'); process.exit(1); }
  if (args.neverEmailed && args.sequence) { console.error('--never-emailed is for a ONE-OFF email (--email-template curiosity, or --subject / --body-file). The --core sequence picks who is due by itself, and --core --step 1 is its never-emailed group.\n(Nothing was started.)'); process.exit(1); }
  if ((args.includeNeverEmailed || args.list != null || args.lastTyped) && !args.blast) { console.error('--include-never-emailed, --list and --last-typed belong to the email blast:\n  email --email --blast [--days 5] [--include-never-emailed] [--list shark|lds|email-report|free-plan] [--last-typed | --email-template <name>]\n(Nothing was started.)'); process.exit(1); }
  if (args.blast) {
    const eb = require('./emailBlast');
    const why = !(args.email || args.cadence) ? '--blast goes with --email (the run) or --cadence (the preview), for example:\n  node Assistant.js --cadence --blast --email-template curiosity     (no browser, nothing sent)\n  email --email --blast --email-template curiosity --range 1-5 --dry-run'
      : (args.sequence || args.library || args.neverEmailed || args.fromDashboard || args.fromHand || args.fromFreePlan || args.fromSnapshot || args.byEmail || args.scan) ? '--blast picks its own leads (every lead we have not emailed in over --days days) and sends ONE email: it does not go with --core / --sequence / --library / --never-emailed / --from-dashboard / --from-hand / --from-free-plan / --from-snapshot / --by-email / --scan.'
      : !(Number.isInteger(args.blastDays) && args.blastDays >= 1 && args.blastDays <= 365) ? '--days is how many days must have passed since our last email to a lead: a whole number from 1 to 365 (5 when you leave it out).'
      : args.list === '' ? '--list needs a name: shark, lds, email-report or free-plan (leave it out for all of them).'
      : (args.list != null && !eb.parseList(args.list).ok) ? eb.parseList(args.list).error
      : (args.email && !args.dryRun && !args.inspect && !(args.emailTemplate || args.subject || args.bodyFile || args.lastTyped) && (args.yes || !process.stdin.isTTY)) ? 'A blast must be told WHICH email when nobody is there to type it: add --last-typed (the email you typed last time) or --email-template <name> (or --subject with --body-file). In a Terminal without --yes it asks you to type one.'
      : null;
    if (why) { console.error(why + '\n(Nothing was started.)'); process.exit(1); }
    if (args.lastTyped) {      // --last-typed: the email typed at the prompt last time (kept in blast-emails.jsonl)
      const named = [args.emailTemplate && '--email-template', args.subject && '--subject', args.bodyFile && '--body-file'].filter(Boolean), last = eb.readLastTyped();
      const w = named.length ? `--last-typed sends the email you typed last time, so it does not go with ${named.join(' / ')}: name the email one way only.` : !last ? 'No typed email is saved yet: run the blast without --last-typed, type your email at the prompt, and it is kept for next time.' : null;
      if (w) { console.error(w + '\n(Nothing was started.)'); process.exit(1); }
      args.typedEmail = { subject: last.subject, body: last.body };
    }
  }
  if ((args.csv != null || args.csvColumn != null || args.noOwnData) && !(args.email && args.byEmail)) { console.error('--csv / --csv-column / --no-own-data go with --email --by-email, for example:\n  email --email --by-email --csv ~/Downloads/outreach-log.csv --lookup-only     (matches the accounts, sends nothing)\n(Nothing was started.)'); process.exit(1); }
  if (args.csv === '') { console.error('--csv needs the file:  email --email --by-email --csv <file.csv>\n  (to see what is in it first, no browser:  node emailSource.js <file.csv>)\n(Nothing was started.)'); process.exit(1); }
  if (args.csvColumn != null && args.csv == null) { console.error('--csv-column picks a column of the CSV given with --csv.\n(Nothing was started.)'); process.exit(1); }
  if (args.csv && args.scan) { console.error('--csv and --scan both say where the addresses come from: use one of them.\n(Nothing was started.)'); process.exit(1); }
  if (args.tomorrow && args.inspect && !args.queue) { console.error('--inspect with --tomorrow only works for the saved queue:  email --queue --tomorrow --inspect  (no browser, nothing sent). A --shark13 / --shark run has no preview: use --dry-run (it scans, shows the timetable and stops).\n(Nothing was started.)'); process.exit(1); }
  if (args.tomorrow && !((args.send && (args.snapshot || args.queue)) || (args.queue && args.inspect))) { console.error('--tomorrow goes with --send and a list to text, for example:\n  email --shark13 --send --template 6     (scan the T13 report, then text each pro at their own NEXT 8:00 AM)\n  email --queue --send --tomorrow          (the same for the queue you already have)\n  email --queue --tomorrow --inspect       (the timetable, no browser)\n(Nothing was started.)'); process.exit(1); }
  if (args.help) {
    console.log(sender.apply(
      'Pipeline Assistant — texts OR emails leads from a Salesforce Opportunities LIST VIEW or REPORT.\n\n' +
      'NO FLAGS = THE EMAIL CAMPAIGN:\n' +
      '       zw                             (H→C→P letter countdown while Chrome loads, then the welcome screen: sign in to Salesforce (your campaign REPORT opens by itself), press Enter, then pick the email and the rows). This is a LIVE run: it sends.\n' +
      '       zw --test                      a PRACTICE RUN of the same thing: always a DRY RUN (the email is filled in on each account you pick, NOTHING is sent; --yes cannot change that), and always on your campaign report. Pick "Type your own subject line & email" to practise typing one.\n\n' +
      'TEXT:\n' +
      '       node Assistant.js --text                  (the text campaign: list view; prompts for the rows; Claude drafts only when turned on in Settings)\n' +
      '       email --text --test                 a TEXT PRACTICE RUN on the testing list (--dry-run alone does the same on the list you have open): on each account the text is typed into the message box and checked, then taken out again. Send is NEVER clicked and nothing is recorded as sent.\n' +
      '       node Assistant.js --template 1 --range 1-10\n' +
      '       node Assistant.js --message "Hey..." --range 1-10\n' +
      '       node Assistant.js --inspect               (preview list-view row detection)\n' +
      '       node Assistant.js --oppy --template 7 --range all   (text off an OPPORTUNITIES LIST VIEW: harvest all, then text by URL with the daily guard + dashboard)\n' +
      '       node Assistant.js --report                (text off a Salesforce REPORT instead)\n' +
      '       node Assistant.js --report --inspect      (preview Account + Last Outgoing SMS detection)\n' +
      '       node Assistant.js --report --template 1 --range all\n' +
      '       (report mode SKIPS anyone with an outgoing SMS in the last 48h per the report\'s\n' +
      '        "Last Outgoing SMS DateTime" column — i.e. texted by ANYONE. Use --ignore-sms to override.)\n\n' +
      'EMAIL (--email): harvest a list/report, then email each account in one run.\n' +
      '       (runs in its OWN browser — CDP 9324 / .browser-profile-email — so you can run texting AND\n' +
      '        emailing at the same time on one machine; log into Salesforce once in the email window.)\n' +
      '       node Assistant.js --email --inspect       (list who would be emailed; no send)\n' +
      '       node Assistant.js --email --dry-run       (open + fill each composer, never Send)\n' +
      '       node Assistant.js --email --range all     (LIVE: send the email to every account)\n' +
      '       node Assistant.js --email --report --range 1-25\n' +
      '       node Assistant.js --email --core          (CORE accounts, 5 employees or fewer: the 6-step cadence — each account gets its NEXT touch, one feature + a different story each time; --days N = min days apart, default 3)\n' +
      '       node Assistant.js --email --core --scan lds --step 1   (INTAKE: open the saved LDS report, scan + save it, drop duplicates / banned / closed-won / customers, then send touch 1 to everyone not yet emailed; --range all --yes for the whole batch, --dry-run first; live sends stop at 300 per run and 1000 per day, --max N can lower the run cap)\n' +
      '       node Assistant.js --cadence               (no browser: where every LDS lead stands in the 6-step cadence)\n' +
      '       node Assistant.js --email --library       (older one-shot: a trade-matched, linked email per account from the content library; add --postdemo for the post-demo wording)\n' +
      '       node Assistant.js --email --sequence      (same as --core; multi-touch: each account gets its NEXT touch, a different case study / Pro stories / report each time; --days N = min days apart, default 3)\n' +
      '       node Assistant.js --email --skip "ADN Doors,Dorsett Does It"   (never email these accounts by name)\n' +
      '       (at the "Which accounts to email?" prompt you can also type:  skip ADN Doors   — repeat as needed,\n' +
      '        "unskip <name>" undoes one, then enter the range. Exact name wins; a partial name that matches\n' +
      '        several accounts is refused and the matches are listed.)\n' +
      '       node Assistant.js --email --subject "..." --body-file ./email.txt\n\n' +
      'SAVE & QUEUE (snapshot a report, text it later — survives emailing leads off the report):\n' +
      '       node Assistant.js --save                  (scrape the open report/list → durable text-queue.json; no texting)\n' +
      '       node Assistant.js --queue --inspect       (list the saved queue; no browser)\n' +
      '       node Assistant.js --queue --template 6 --range all   (text the saved queue later; marks each done)\n\n' +
      'SHARK FOLLOW-UP — plain --followup is RETIRED (2026-11-02, for now): the follow-up board (email --board) replaces it. --teammate-texted and --followup --teammate are NOT retired; they run on its engine:\n' +
      '       email --shark --pick   asks which Shark list (T14, T13, T30, T150+, or another you open yourself) instead of going straight to T14; add --send to text it\n' +
      '       email --email [--email-template <number or name>]   which email: its number in the "Which email?" menu, or its name (any email of email-templates.json works by name, in the menu or not: day-after-demo, research-reengage, csr-ai, why-now, curiosity, autopilot, past-customers, built-in); asked at the prompt when not given, and just Enter takes the first one (a --yes run with no email named sends the first email too). The menu shows what email-menu.json lists, in that order, and ends with "Type your own subject line & email (no signature needed)": you type the subject and the email, and the greeting, the layout and your signature are added for you (that choice only works from the prompt). csr-ai, past-customers and why-now are emails 3, 4 and 5 of the 60-day drip: the board sends them by itself. More emails: add them to email-templates.json, and to email-menu.json to put them in the menu\n' +
      '       email --email --from-dashboard --never-emailed --email-template curiosity [--range all] [--dry-run]   ONE EMAIL to the LDS leads we have never emailed (no email of any kind in the log; banned, closed-won, customers and anyone who replied are left out). Every send is logged and an account with no email address on its page is left out for good (--retry-skipped asks again), so the same command again is always the next batch; live runs stop at 300 emails per run and 1000 per day\n' +
      '       node Assistant.js --cadence --never-emailed --email-template curiosity   no browser, nothing sent: who that is, the greetings they get and the email as it will read\n' +
      '       email --email --blast [--days 5] [--include-never-emailed] [--list shark|lds|email-report|free-plan] [--last-typed | --email-template <name>] [--range all] [--dry-run]   ONE email, the one YOU TYPE (the prompt asks for the subject, then the body, finished with END; --last-typed sends the email you typed last time again), to every lead we have not emailed in over 5 days, the lead emailed longest ago first (the follow-up board leads; replies, opt-outs and anyone banned / closed-won / a customer are left out). A manual one-off tool: nothing schedules it and the follow-up board never counts it; live runs stop at 300 emails per run and 1000 per day\n' +
      '       node Assistant.js --cadence --blast [--last-typed | --email-template <name>]   no browser, nothing sent: who the blast would reach (in the order it goes), how many already got that exact email, and the email as it will read (in a Terminal it asks you to type the email)\n' +
      '       email --email --from-free-plan [--content] [--dry-run]   emails every account on the dashboard\'s 🆓 Invoicing & Payments tab (Enrolled, but only the free plan; 🎓 business coaching accounts are a different department: not emailed, and not listed as customers, until coachingPolicy.js releases them): no report needed\n' +
      '       email --email --core --from-hand [--tag <tag>] [--step N] [--dry-run]   emails the leads you added by hand (dashboard Tools > Follow-up board, any #tag), each its NEXT touch of the 6-touch cadence; --tag limits it to one of their tags (write it without the #), --step N to the leads due touch N. No report needed\n' +
      '       node Assistant.js --cadence --from-hand [--tag <tag>] [--step N]   no browser, nothing sent: where each hand-added lead stands in the cadence and what --from-hand would send\n' +
      '       email --email --by-email [--scan <report>] [--inspect | --lookup-only [--lookup-limit N] | --dry-run] [--core]   a report of EMAIL ADDRESSES: reads them, finds each one\'s account in Salesforce, skips banned / closed-won / current customers, and emails ONLY that address\n' +
      '       email --email --by-email --csv <file.csv> [--csv-column "Email"] [--inspect | --lookup-only | --dry-run] [--core] [--no-own-data]   the addresses come from a CSV FILE instead of an open report (the dashboard outreach-log export has the account on every row): the account comes from the file, then saved lookups, then our own texted-log / account emails; Salesforce is only searched for the rest\n' +
      '       node emailSource.js <file.csv> [--column "Email"]   no browser, nothing sent: what is in the file and how many addresses still need a Salesforce search\n' +
      '       email --holds [--inspect | --dry-run | --yes]   leads held because the pro replied / a teammate texted: reads the saved conversation, drafts a subtle "just checking in… -Luke at HCP" text (replies needing a real answer are listed for you), asks, then sends. A macOS notification fires when a hold happens.\n' +
      '       email --followup   RETIRED (2026-11-02, for now): it prints a pointer to the follow-up board and starts nothing, whatever flags it has. Its text "Follow-Up 1" is the board\'s Day 3 · Text 4. What is due: email --board --inspect. Send it: email --board\n' +
      '                    NO DEFAULT TEXT: you give the wording every run (--message "…" or --template N); without it nothing starts. A wording that is one of the follow-up board\'s own stage texts (Day 1 · Text 2 "Book a demo", Day 3 · Text 4 "Follow-Up 1", ...) is refused. NOT A BOARD STAGE: the follow-up board does not count these texts, so no lead moves there, and no dashboard "Touchpoint N" label is set. NO CHECK: --check is refused, it never opens an account to check it. NO THREAD READ either: the pro\'s SMS thread is not opened before the text.\n' +
      '                    Own Chrome on port 9331, so it never closes another run\'s browser (--reengage 9325, --teammate-texted 9332, --board 9336): sign in to Salesforce once the first time.\n' +
      '                    The once-a-day guard and the report\'s 48h SMS guard are waived for this mode ONLY (a second text today is the point; a later --shark backup would show your own texts in that column). NO Salesforce review (no account is opened to check opportunities: it just texts them). Still on: banlist, the closed-won list and earlier review verdicts, opt-out notes, teammate texts, each pro\'s own hours, the thread guard (a pro who replied is held for you), the contact ledger, never the same text twice, and the confirm (--yes skips it).\n' +
      '                    A pro who replied today is left to you. The list is re-read before every batch, so pros texted meanwhile are picked up. --inspect = no browser, nothing sent.\n' +
      '       email --teammate-texted [--inspect | --dry-run] [--template N | --message "…"] [--max 25|all] [--yes] [--once] [--zone-only ET] [--only <accountId>]   TEXT THE PROS ON THE DASHBOARD\'S 🤝 TEAMMATE TEXTED TAB (a teammate texted them; the follow-up board no longer pauses them; also --teammate-list).\n' +
      '                    Sends your "We still want to partner with you…" text (--template / --message sends something else). WHO: the pros whose last thread read (3 days) was held because a teammate texted, plus the pros the report\'s SMS column says a teammate texted in 48h. Pros who REPLIED (email --holds) and threads that could not be read are left out and counted.\n' +
      '                    The thread is read again at send time: a teammate\'s text no longer holds the send, but a reply from the pro or an opt-out in the thread does. Still on: the Salesforce review, banlist, closed-won list, opt-out notes, each pro\'s own hours, the contact ledger, never the same text twice, the once-a-day guard (a pro texted in the last 24h waits for the next run) and the confirm (--yes skips it).\n' +
      '                    Own Chrome on port 9332, so it can run next to a live --board (9336): sign in to Salesforce once the first time. --inspect = no browser, nothing sent.\n' +
      '       email --thread-probe <accountId[,id]>   READ-ONLY: open the account\'s Texts tab and dump what the thread looks like (thread-probe-<id>.json/.png); types and sends nothing\n' +
      '       email --followup --teammate       ONLY accounts a teammate texted in the last 48h, with the "making the change isn\'t easy… reply Y or N" text (the follow-up board holds them)\n' +
      '                    THE OLD SEQUENCE went with plain --followup: its step 1, "Follow-Up 1" (template 8), is now the board\'s Day 3 · Text 4; its step 2, the success story, was never written (the board\'s Day 5 · Text 5 is where it goes).\n' +
      '                    The options and rules below belong to the engine the surviving runs share (--followup --teammate, --teammate-texted).\n' +
      '                    [--only <accountId>] [--scanned-only] [--no-lds] [--max-texts N] [--unknown-zone hold]\n' +
      '                    --dry-run: log in and list the accounts + the text, send nothing  |  --scanned-only: only Shark accounts seen on a report scan / backup (not the assumed ones)  |  --no-lds: Shark accounts only (the LDS leads that are not on the Shark tab are left out)\n' +
      '                    Two ways to check an account in Salesforce before its text (no review is the default, since 2026-10-29):\n' +
      '                      (default)  NO review: it just texts. Accounts already on the closed-won list (dashboard tab 🏆 Closed Won, or node textLog.js --closed-won) and current customers on the held list (tab 🤝) stay out.\n' +
      '                      --check    ONE ACCOUNT AT A TIME: the batch is listed and confirmed first, then for each account: open its Salesforce profile → check its opportunities (a Closed Won in the last 30 days goes on the\n' +
      '                                 closed-won list and is NOT texted; a current customer is skipped; an unreadable profile is skipped) → text it → the next account. A fresh look every time. --dry-run does the checks, sends nothing.\n' +
      '                    Then the dashboard stage becomes "Touchpoint N". --teammate-texted still reviews the whole batch first; give it --check (one at a time) to check each account instead.\n' +
      '                    Hours: no time zone is looked up. An account whose zone is already known (from a Shark report scan) is texted inside ITS OWN hours (from 9 AM local;\n' +
      '                    8 AM Eastern; until 8 PM; Mon–Sat); every other account only 12:00–8:00 PM Eastern, Mon–Sat (inside the hours in every US zone at once).\n' +
      '                    Add --unknown-zone hold to never text an account whose zone is not known.\n' +
      '                    Safety: banlist, the closed-won list, current customers (the held list), the hours above, once-a-day + recent-contact guards, never the same text twice to one\n' +
      '                    account, and the exact text + accounts are shown and confirmed first (--yes skips the confirm). Opted-out numbers are not checked here: Salesforce\n' +
      '                    itself blocks a text to a contact who has opted out.\n\n' +
      'RE-ENGAGE (48h follow-up, once per account per channel; no prompts):\n' +
      '       node Assistant.js --reengage --inspect    (list who is due; no browser)\n' +
      '       node Assistant.js --reengage --yes        (text pass THEN email pass, in its own browser: CDP 9325 / .browser-profile-reengage)\n' +
      '       --reengage --text --yes  (text only)   |   --reengage --email --yes  (email only)\n' +
      '       Salesforce review: before every re-engage send it reads the account\'s opportunities + notes and SKIPS accounts closed-won since our first touch or in the last ' + sfReview.WON_FLAG_DAYS + ' days (a Closed Won that is only the free Invoicing and Payments sign-up does not count; a business coaching win does), all-closed-out, or do-not-contact (read-only; logged to reengage-review.jsonl).\n' +
      '       email --lds | --inbound-lds [--max N]   saved report modes (LDS / Inbound KA LDS): opens that report itself, reviews its accounts, saves lds-review.json (sends nothing)\n' +
      '       (report modes wait --load-wait S, default 15, before scanning, then ask Enter = review / r = scan again / q = quit)\n' +
      '       email --auto [--lds | --inbound-lds | --report | --only <accountId>] [--max N] [--dry-run] [--yes] [--again]\n' +
      '                    (no source flag = the dashboard\'s LDS tab, one account at a time; --lds / --inbound-lds / --report = take the accounts from a Salesforce report instead)\n' +
      '                    --evidence-only: just print what Salesforce reading found (no Claude call)\n' +
      '                    per account: read Customer Status (beta) first (a current customer is left out), then your own Granola note (a Salesforce note titled Granola that you wrote), then the 3 most recent opps + notes, FLAG closed-won in 30 days, write a custom email + text + phone script (Claude), then send them (guarded). --dry-run drafts only. See auto-playbook.md / auto-config.json / testimonials.json\n' +
      '       AUTO WORDING, on by default in the plain campaigns: email (= email --email) and email --text write each message from that account\'s Salesforce notes and opportunities (your Granola note first), exactly as --auto does.\n' +
      '                    Per account it reads, writes (Claude), and checks every claim; you see every draft, answer one y/N, and only that kind goes out (email, or text), through the normal guards. Needs Claude signed in.\n' +
      '                    First, for every account, it opens the account and reads Customer Status (beta): "Enrolled: …" (e.g. Enrolled: Current Customer) is a current customer and is left out (saved on the held list), unless the account is only on the free Invoicing and Payments plan. --force does not bypass it.\n' +
      '                    Claude drafts are OFF by default (Settings → Claude drafts → on to enable). --no-auto forces a template. Also template mode when you chose the wording or the mode has its own: --message, --template, --email-template, --subject, --body-file, --sequence / --core, --library, --blast, --never-emailed, a text campaign off a --report.\n' +
      '                    Not part of it: --board, --shark / --queue / --evening / --tomorrow, --reengage, --followup and its variants, --oppy (they keep their fixed wording and timing).\n' +
      '       CUSTOMER STATUS, on by default in EVERY mode: right before every text (and on every email) the account\'s Customer Status (beta) is read on its page. "Enrolled: …" (e.g. Enrolled: Current Customer) is a current customer and is NOT contacted, unless the account is only on the free Invoicing and Payments plan; it is saved on the held list.\n' +
      '       email --shark --send [--template N] [--until HH:MM] [--unknown-zone strict] [--yes]   the hands-off morning: the backup, then it STAYS RUNNING and texts each queued pro as their own 8:00 arrives, until everyone is done (same with  email --queue --send  for a queue you already have). Texts really go out; leave the Chrome window and the Mac as they are. Without --send, --shark sends nothing\n' +
      '       email --evening [--template N] [--at 7pm] [--max-texts N] [--until HH:MM] [--yes] [--dry-run]   TEXT TOMORROW\'S SHARK LIST TONIGHT. The Shark report posts, at midnight, the pros whose last communication is 15 days old, and three reps then text the same pro. This texts tonight\'s batch (the 14-day-old pros, read from a COPY of the Shark report whose day filter is one day earlier) at 7:00 PM in each pro\'s OWN time zone, so they never post. Start it BEFORE you leave: one confirm, then it runs by itself in its own Chrome (CDP 9330) — it relaunches a crashed Chrome, reopens a closed tab, keeps Salesforce signed in and writes a heartbeat. --dry-run = show tonight\'s batch and timetable, send nothing and save no list (it does remember the report)\n' +
      '       email --evening --inspect   no browser: tonight\'s timetable, the heartbeat of the last run, and how many of last night\'s pros posted anyway (the morning --shark prints that too)\n' +
      '       email --board [--max-texts N] [--max-emails N] [--stage d1t2,d3t3] [--texts-only|--emails-only] [--older] [--until HH:MM] [--yes]   THE FOLLOW-UP BOARD ON ITS OWN. Every lead on the board follows thirteen stages by itself (a 60-day drip): Day 1 text 1, email 1 (Day 1 is all marked BY HAND: text 2 is done by hand and the board skips it; text 1 and email 1 only carry the label, the board still sends them if a run picks them); Day 2 text 3; Day 3 text 4, email 2; Day 5 text 5; Day 9 email 3; Day 14 text 6; Day 21 email 4; Day 28 text 7; Day 42 email 5; Day 60 text 8. Each text/email goes out inside that lead\'s OWN hours (8:00-20:00 their time, Mon-Sat). Read from our own log, never the Shark report. Without --trade it first asks GENERAL (the whole board) or INDUSTRY SPECIFIC (pick industries from a list; --trade Plumbing,HVAC does the same up front and skips the question; --yes asks nothing), then WHICH STAGE (a numbered list of the thirteen, 0 or Enter = all stages, e.g. 6 = Day 3 email 2; --stage d3e2 or --stage 6 does the same up front and skips the question), then one confirm, then it runs by itself until nothing more can go out today (its own Chrome, CDP 9336). Only leads whose cadence started in the last 7 days, or that the board has already texted or emailed, run on their own (--older = all)\n' +
      '       email --board --inspect   no browser: the stage table, who we already texted today in stage 1, and what the run would do now (--all lists everyone)\n' +
      '       email --shark13 [--send [--template N]] [--dry-run] [--yes] [--until HH:MM] [--max-texts N] [--unknown-zone hold]   TOMORROW\'S SHARK LIST: the --shark backup of the T13 report (it opens by itself, like --shark opens T14). The T13 pros are the ones who would post to T14 at midnight; emailing them tonight keeps them off T14. With --send it is the OVERNIGHT run: nobody is texted tonight, each pro gets the text at their own NEXT 8:00 AM (tomorrow morning when you start at night; never a Sunday; no known zone: 12:00 PM Eastern). One confirm, then hands-off in its OWN Chrome (CDP 9333; sign in to Salesforce once): it relaunches a crashed Chrome, reopens a closed tab, keeps Salesforce signed in and tells you on the Mac if it needs you. --dry-run = scan, show the timetable, send nothing. Scan BEFORE you email them (an email takes a pro off the list)\n' +
      '       email --queue --send --tomorrow [--template N]   the same overnight run for the queue you already have (also  --shark --send --tomorrow)     email --queue --tomorrow --inspect   its timetable, no browser\n' +
      '       email --shark [--no-queue]   MORNING BACKUP of the Shark list: scrape every account on the report (with its columns) → shark-snapshots.jsonl, tag #shark, show them on the dashboard, queue them for texting. Run it early, before reps work the list. Run it again later to see who dropped off (node textLog.js --shark-diff). Also: --snapshot --kind Shark|LDS for any report.\n' +
      '       email --email --from-snapshot   email the backed-up Shark accounts (even ones reps already pulled off the report); texts: email --queue\n' +
      '       email --lists [--lds] [--inbound-lds] [--shark …] [--report [--kind LDS|Shark]]   tag every account on those reports as LDS or Shark (read-only) so the dashboard shows which list each came from\n' +
      '                    saved reports live in the REPORT_MODES table + report-modes.json (see report-modes.example.json); every report the bot reads is tagged automatically\n' +
      '       email --harvest [--kind Shark|LDS] [--dry-run]   scan the Shark report you have open in a report view and save what it shows (no account is opened): tags the list (#shark) and saves the report\'s Time Zone, Industry and Email columns. --dry-run = print the report\'s columns and a few rows, save nothing\n' +
      '       email --harvest --deep [--max N]   the per-account read: time zone + opportunities + Notes (previews) + original sales rep / demo date → contact-zones.jsonl + account-notes.jsonl (read-only; Activity History is not read)\n' +
      '       email --industry [--max N|all] [--kind Shark|LDS] [--only <accountId[,id]>] [--refresh] [--dry-run] [--inspect]   read each dashboard account\'s Industry and Timezone from its Salesforce page summary (read-only; own browser on port 9327) → account-industry.jsonl + contact-zones.jsonl → the dashboard\'s Industry and Time zone columns. --inspect = the plan, no browser; --dry-run = read 3 and show what the page offers, save nothing\n' +
      '       email --zone <accountId[,id]>   read an account\'s address → time zone and print it (read-only)\n' +
      '       email --zones [--max N] [--refresh]   fill in time zones for accounts that have none: the follow-up board first (its next first texts at the very top), then the rest of the texted log (read-only; feeds the dashboard + TCPA gate); --refresh reads the ones that have one too\n' +
      '       node Assistant.js --zones --dry-run [--max N]   no browser, nothing read: who that run would read, in order\n' +
      '       email --review <accountId[,id]>   run the review on accounts and print what was read (sends nothing)\n' +
      '       Flags: --max N (default 25/run)  --max-age-days D (default 7)  --only <accountId> (single account)  --once (no keep-going prompt)  --dry-run (nothing is sent: the email is filled in, the text is typed, neither is sent)\n' +
      '       On a terminal it asks after each batch whether to keep going and how many accounts to run next.\n\n' +
      'DASHBOARD:\n' +
      '       node Assistant.js --sent                  (open the durable "who we texted" dashboard; no browser/login)\n\n' +
      '       TCPA: ' + tcpa.describe() + ' (the texts of --board, --teammate-texted, --followup --teammate, --reengage, --auto, --queue and --report; not bypassed by --force; --queue/--report text only pros whose own window is open and leave the rest for later, --unknown-zone strict also texts unknown zones 12:00–8:00 PM Eastern; --oppy and the list-view mode are NOT gated; email unaffected).\n' +
      '       Guards (report/queue/oppy texting): once-per-day per lead (durable), 48h "texted by anyone" via report SMS column, local contact history.\n' +
      '       NEVER THE SAME MESSAGE TWICE (texts and emails, every mode): a lead who already got this exact text or email — the same wording, or the same named template / --sequence touch — is skipped however long ago it was (the permanent log texted-log.jsonl is the memory; the contact ledger only remembers ~48 h). A text written per lead (--auto, a thread-hold check-in) is compared by its wording only. --force does NOT bypass this.\n' +
      '       --force (alias --no-guards): removes the recency guards above (once-per-day, 48h SMS, contact ledger) — texts everyone in range regardless of recent contact. It does NOT lift the banlist, the texting hours or the never-the-same-message rule. Use with care.\n' +
      '       Flags: --report  --oppy  --email  --save  --queue  --dry-run  --core  --library  --sequence  --postdemo  --subject  --body-file  --sent  --ignore-sms  --range  --message/-m  --template/-t  --delay  --yes/-y  --inspect\n' +
      '       Text templates: 1=Essentials Promo, 2=Max Plan Promo, 3=Special Offer, 4=Full Stack Promo, 5=Respectful Follow-Up, 6=Re-Engagement $26+$100 Amazon, 7=Key Accounts Max $99+$50 Amazon, 8=Follow-Up 1, 9=Book A Demo, 10=Account Idea + Book A Demo, 11=Connect Tomorrow (15 minutes tomorrow, written for --evening), 15=Game Plan 2027 (book 30 mins + a custom 2027 game plan: the text Luke sends by hand)'
    ));
    return;
  }
  const unsetSender = sender.missing();
  if (unsetSender.length) console.log(`\n  ⚠️  sender.json is not filled in yet (${unsetSender.join(', ')}). Previews and read-only modes work, but a text or email that carries your name or numbers will not be sent until it is.\n     File: ${sender.FILE}\n`);
  if (testMode) {
    const rid = (() => { try { return new URL(CONFIG.reportUrl || CONFIG.listUrl).pathname.match(/\/Report\/([A-Za-z0-9]+)/i)?.[1] || 'campaign report'; } catch (_) { return 'campaign report'; } })();
    console.log(`\n  🧪 TEST RUN: the report is ${rid} and this is a DRY RUN. ${args.email ? 'The email is filled in on each account you pick, but NOTHING is sent.' : (args.text || args.report || args.oppy || args.queue || args.reengage) ? 'The text is typed in and taken out again on each account you pick, but NOTHING is sent.' : 'NOTHING is sent.'}\n`);
  }

  // --sent: build + open the durable texted dashboard (no Salesforce/browser needed).
  if (args.sent) {
    if (textLog.readAll().length === 0) {
      const n = textLog.seedFromContactHistory();
      if (n) console.log(`  📊 Seeded ${n} prior text(s) from the contact-history ledger.`);
    }
    const p = textLog.generateDashboard();
    console.log(`\n  📊 Texted dashboard: ${p}`);
    console.log(`     file://${p}`);
    try { require('child_process').exec(`open "${p}"`); } catch (_) {}
    return;
  }

  // --queue --inspect: just list the saved text queue (no browser/login needed).
  if (args.queue && args.inspect) {
    const sum = textQueue.summary();
    const pending = textQueue.pendingLeads();
    console.log(`\n🗂️  Text queue — ${sum.pending} pending, ${sum.texted} already texted (of ${sum.total} saved)\n`);
    pending.slice(0, 30).forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${l.name}  ${l.url || ''}`));
    if (pending.length > 30) console.log(`  ... and ${pending.length - 30} more`);
    console.log('');
    if (args.tomorrow) { require('./tomorrowSend').preview(pending, { unknownZone: args.unknownZone, textLog, until: args.until, parseUntil, maxTexts: args.maxTexts }); return; }   // --queue --tomorrow --inspect: each pro's next 8:00 AM, no browser
    printHoursPlan(partitionByHours(pending, { unknownZone: args.unknownZone }));
    console.log('');
    return;
  }

  // --reengage --inspect: list who is due (no browser, no send).
  if (args.reengage && args.inspect) {
    for (const ch of ['text', 'email']) {
      const due = textLog.reengageDue(ch, { maxDays: args.maxAgeDays });
      console.log(`\n🔁 48h re-engage — ${due.length} due for ${ch} (this run would send ${Math.min(due.length, args.max)}, cap ${args.max}, window 48h–${args.maxAgeDays}d)\n`);
      due.slice(0, 30).forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${l.name}  (last touch ${l.lastAt})`));
      if (due.length > 30) console.log(`  ... and ${due.length - 30} more`);
    }
    const g = tcpa.check();
    console.log(`  ⏰ TCPA: ${g.ok ? 'texting is open now' : `texting CLOSED now (${g.reason}), reopens ${tcpa.nextOpen()}`} — ${tcpa.describe()}\n`);
    return;
  }

  // --cadence --blast: who an EMAIL BLAST (one email to every lead we have not emailed in over --days days) would reach, and the email as it will read (no browser, nothing sent): emailBlast.js.
  if (args.cadence && args.blast) {
    const eb = require('./emailBlast');
    // nobody named the email and someone is at the keyboard: the same prompt the run shows (type one, the one typed last time, or a saved email). What is typed is kept, so the run can send it with --last-typed.
    if (!args.emailTemplate && !args.subject && !args.bodyFile && !args.typedEmail && !args.yes && process.stdin.isTTY) {
      if (!(await eb.chooseEmail({ args, ask, menu: emailTemplateMenu().filter((m) => !m.typed), emailTemplateKey: (v) => emailTemplateKey(v, { noTyped: true }), signature: EMAIL_SIGNATURE, render: emailPersonalize.render }))) return;      // the blast prompt has its own "type my own" (T)
    }
    let content, which;
    try {
      content = resolveEmailContent(args);
      const key = args.typedEmail ? null : emailTemplateKey(args.emailTemplate);
      const emailName = () => (key ? namedEmailTemplate(key).name : EMAIL_TEMPLATE.name);      // nobody named an email: key is the FIRST email of the menu, what a --yes run sends
      which = args.typedEmail ? eb.typedLabel(args) : (args.subject || args.bodyFile) && !args.emailTemplate ? 'a custom email (--subject / --body-file)' : args.emailTemplate ? emailName() : `${emailName()}  ⚠️ no email chosen (--last-typed, --email-template): the run would ask you to type one (a --yes run sends this one)`;
    } catch (e) { console.log(`\n  ⚠️  ${e.message}\n`); return; }
    eb.preview({ textLog, cadence: require('./cadence'), emailPersonalize, args, content, which });
    return;
  }
  // --cadence --never-emailed: who a ONE-OFF email to the LDS leads would reach, and the email as it will read (no browser, nothing sent): the very intake the email run does.
  if (args.cadence && args.neverEmailed) {
    const lds = textLog.ldsLeads();
    console.log(`\n✉️  ONE-OFF EMAIL — LDS leads in our system: ${lds.length}  (inbound key-account LDS included; banned, closed-won and current customers left out)\n`);
    const leads = prepareNeverEmailedLeads(lds.map((l) => ({ accountId: l.accountId, name: l.name, url: l.url })), args);
    let content; let which;
    try {
      content = resolveEmailContent(args);
      const key = emailTemplateKey(args.emailTemplate);
      const emailName = key ? namedEmailTemplate(key).name : EMAIL_TEMPLATE.name;      // nobody named an email: the FIRST email of the menu, what a --yes run sends
      which = (args.subject || args.bodyFile) && !args.emailTemplate ? 'a custom email (--subject / --body-file)' : args.emailTemplate ? emailName : `${emailName}  ⚠️ no --email-template: the run would ask which email (a --yes run sends this one)`;
    } catch (e) { console.log(`\n  ⚠️  ${e.message}\n`); return; }
    const made = []; let broken = 0;
    for (const l of leads) { try { made.push({ lead: l, mail: emailPersonalize.render(content, l.name) }); } catch (_) { broken++; } }
    const kinds = { team: 0, first: 0, plain: 0 };
    for (const m of made) kinds[m.mail.profile.business ? 'team' : m.mail.profile.firstName ? 'first' : 'plain']++;
    const longSubject = made.filter((m) => m.mail.subject.length > 70).length;
    console.log('');
    console.log(`  Email     : ${which}`);
    console.log(`  Subject   : ${content.subject}`);
    console.log(`  Greetings : ${kinds.team.toLocaleString()} "Hi <business> team," · ${kinds.first.toLocaleString()} "Hi <first name>," · ${kinds.plain.toLocaleString()} plain "Hi,"   (the account name decides; a name that does not read as a business falls back)`);
    if (longSubject) console.log(`  Subjects  : ${longSubject.toLocaleString()} are over 70 characters once the name is in (many inboxes cut those off)`);
    if (broken) console.log(`  ⚠️  ${broken} account(s) could not be personalized and would be skipped`);
    console.log('\n  The first 5, in the order the run takes them:');
    made.slice(0, 5).forEach((m, i) => console.log(`    ${i + 1}. ${m.lead.name}  →  ${m.mail.subject}`));
    if (made.length) {
      console.log(`\n  ── the email for ${made[0].lead.name} ${'─'.repeat(30)}`);
      console.log(`  Subject: ${made[0].mail.subject}\n`);
      console.log(made[0].mail.body.split('\n').map((x) => '    ' + x).join('\n'));
      console.log('  ' + '─'.repeat(52));
    }
    const same = `${args.emailTemplate ? ` --email-template ${args.emailTemplate}` : ''}${args.subject ? ` --subject ${JSON.stringify(args.subject)}` : ''}${args.bodyFile ? ` --body-file ${args.bodyFile}` : ''}`;
    console.log(`\n  Try it (fills 5 composers, sends nothing):   email --email --from-dashboard --never-emailed${same} --range 1-5 --dry-run`);
    console.log(`  Send the first 25 (asks to confirm):          email --email --from-dashboard --never-emailed${same} --range 1-25`);
    console.log(`  Keep going (it stops by itself after 300 emails; every send is logged and an account with no email address is left out for good, so running it again continues):\n                                                email --email --from-dashboard --never-emailed${same} --range all\n`);
    return;
  }

  // --cadence --from-hand: where each lead you added by hand stands in the 6-touch cadence (no browser, nothing sent): the same intake the email run does, then what each one would get.
  if (args.cadence && args.fromHand) {
    const hand = require('./manualShark');
    const found = hand.emailLeads({ tag: args.tag });
    if (!found.ok) { console.log(`\n⚠️  ${found.reason}\n`); return; }
    if (!found.total) { console.log('\n✋ No lead has been added by hand yet: Tools > Follow-up board on the dashboard builds the command that adds one.\n'); return; }
    console.log(`\n✋ EMAIL CADENCE — leads added by hand: ${found.leads.length}${args.tag ? ` tagged #${args.tag}` : ''}  (tags in use: ${Object.entries(found.byTag).map(([t, n]) => `#${t} ${n}`).join(' · ')})`);
    if (found.noName.length) console.log(`⚠️  ${found.noName.length} lead(s) have no business name on file and are left out of the email run: ${found.noName.join(', ')} (remove it with node textLog.js --remove-lead <id> and add it again with --name "Business name")`);
    console.log('');
    const due = prepareCadenceLeads(found.leads.map((l) => ({ accountId: l.accountId, name: l.name, url: l.url })), args);      // the very intake the email run does (logs what it drops)
    const dueKeys = new Set(due.map((l) => String(l.accountId).toLowerCase().slice(0, 15)));
    console.log('');
    for (const x of hand.emailStanding(found.leads, { minDays: args.days })) {
      const sent = x.step ? `touch ${x.step} sent ${String(x.lastAt).slice(0, 10)}` : 'never emailed';
      const verdict = x.dropped ? `left out: ${x.dropped}` : x.hold ? `held: ${x.hold}` : dueKeys.has(String(x.lead.accountId).toLowerCase().slice(0, 15)) ? `✅ would get touch ${x.next}` : `touch ${x.next} is due (not the one --step ${args.step} asks for)`;
      console.log(`  ${String(x.lead.name).padEnd(34).slice(0, 34)} ${x.lead.tags.map((t) => '#' + t).join(' ').padEnd(24)} ${sent.padEnd(26)} →  ${verdict}`);
    }
    console.log(`\n  Send them:  email --email --core --from-hand${args.tag ? ` --tag ${args.tag}` : ''}${args.step ? ` --step ${args.step}` : ''} --dry-run      (drop --dry-run to send; this report sends nothing)\n`);
    return;
  }

  // --cadence: where every core LDS lead stands in the 6-step email cadence (no browser, nothing sent).
  if (args.cadence) {
    const leads = textLog.ldsLeads();
    const st = emailSequence.status(leads, { minDays: args.days });
    console.log(`\n🔁 EMAIL CADENCE — core LDS leads in our system: ${leads.length}  (inbound key-account LDS included for now; banned, closed-won and current customers left out)\n`);
    console.log('  Highest touch already emailed:');
    for (let i = 0; i <= emailSequence.STEPS.length; i++) if (st.atStep[i]) console.log(`    ${i === 0 ? 'never emailed' : `touch ${i} (${emailSequence.STEPS[i - 1].name})`}`.padEnd(46) + String(st.atStep[i]).padStart(5));
    console.log(`\n  Due now (min ${args.days} days apart) — what --email --core --from-dashboard would send:`);
    Object.keys(st.due).sort().forEach((i) => console.log(`    touch ${i} (${emailSequence.STEPS[i - 1].name})`.padEnd(46) + String(st.due[i]).padStart(5)));
    if (!Object.keys(st.due).length) console.log('    nothing due');
    const heldN = Object.values(st.held).reduce((a, b) => a + b, 0);
    if (heldN) { console.log(`\n  Held (${heldN}):`); Object.entries(st.held).forEach(([why, n]) => console.log(`    ${why}`.padEnd(46) + String(n).padStart(5))); }
    console.log('');
    return;
  }

  // --board --industry: --industry READS the Industry of every account from Salesforce (a different job); the follow-up board's own industry filter is --trade. Mixed up, the board would not run at all (the industry read would), so say so.
  if (args.board && args.industry) { console.log('\n  --industry reads the Industry of every account from Salesforce (a different job). To work only some industries on the follow-up board use --trade, e.g.  email --board --trade Plumbing,HVAC\n  Nothing was started.\n'); return; }

  // --industry --inspect: what a run would read (no browser, nothing sent).
  if (args.industry && args.inspect) { printIndustryPlan(args); return; }

  // --holds --inspect / --dry-run: read the saved conversations, no browser.
  if (args.holds && (args.inspect || args.dryRun)) { await runHolds(null, null, args); return; }

  // --evening --inspect: tonight's timetable, the heartbeat of the last run and the morning check. No browser, so a run that is waiting for 7 PM is never touched.
  if (args.evening && args.inspect) { const evening = require('./eveningShark'); await evening.inspect(evening.parseFlags(process.argv.slice(2)), args, { textLog, snapshots: textLog.readSnapshots() }); return; }
  // --board --inspect / --dry-run: the stage table, who was reached today, what the run would do now. No browser and nothing sent, so a run that is going is never touched.
  if (args.board && (args.inspect || args.dryRun)) { const board = require('./boardRun'); board.inspect(board.parseFlags(process.argv.slice(2)), args, { members: (t) => require('./cadence').members({ textLog, now: t }), templates: TEMPLATES, emailSteps: emailSequence.STEPS }); return; }
  // --zones --dry-run / --inspect: who a time-zone run would read and in what order. No browser, nothing read or written. Start it as `node Assistant.js --zones --dry-run`: run.sh would restart the Chrome of a --zones run that is going.
  if (args.zones && (args.dryRun || args.inspect)) {
    const plan = accountZone.zoneTodo({ textLog, cadence: require('./cadence'), refresh: args.refresh }), run = plan.todo.slice(0, args.max), by = (k) => run.filter((x) => x.kind === k).length;
    console.log('\n  🕐 TIME ZONES — who a run would read (no browser, nothing read or written)\n');
    commandLog('🕐', 'Time zones', accountZone.planLine(plan, args));
    if (plan.note) commandLog('⚠️', 'Time zones', plan.note);
    console.log(`\n     This run (--max ${args.max >= Number.MAX_SAFE_INTEGER ? 'all' : args.max}${args.maxSet ? '' : ', the default'}) reads ${run.length.toLocaleString()}: ${by('first')} first texts, ${by('board')} other board leads, ${by('log')} from the log${plan.todo.length > run.length ? `; ${(plan.todo.length - run.length).toLocaleString()} wait for the next run` : ''}.`);
    run.slice(0, 15).forEach((x, i) => console.log(`     ${String(i + 1).padStart(3)}. ${x.name || x.accountId}  — ${{ first: 'first text waiting', board: 'on the board', log: 'in the log' }[x.kind]}`));
    if (run.length > 15) console.log(`          … and ${(run.length - 15).toLocaleString()} more`);
    console.log('\n  Read them with:  email --zones --max N   (roughly 6 to 8 seconds each, in its own Chrome)\n');
    return;
  }

  // --followup: settle the text and the hours BEFORE the browser is used. --inspect shows who is due and sends nothing.
  let followupMsg = null;
  if (args.followup) {
    const fuRetired = followupRetired.problem(args); if (fuRetired) { console.log(fuRetired); return; }          // plain --followup is retired (followupRetired.js): a pointer to --board, before anything is read or started
    if (args.check && args.noReview) { console.log('\n⚠️  --check and --nocheck (--no-review) contradict each other: --check opens each account in Salesforce and checks it right before its text, --nocheck texts straight away. Pick one. Nothing was started.\n'); return; }
    if (args.teammateTexted && (args.sameDay || args.teammate || args.step)) { console.log('\n⚠️  --teammate-texted texts the pros on the Teammate texted tab with ONE text for everybody: it cannot be combined with --same-day, --teammate or --step. Nothing was started.\n'); return; }
    if (args.sameDay && (args.teammate || args.step)) { console.log('\n⚠️  --same-day texts the pros we already texted today with ONE text for everybody: it cannot be combined with --teammate or --step. Nothing was started.\n'); return; }
    const sdEarly = sameDayProblem(args, null); if (sdEarly) { console.log(sdEarly); return; }          // --same-day: --check, or no wording of its own (--inspect needs none): refused before anything is read
    const custom = !!(args.message || args.template || args.teammate || args.sameDay || args.teammateTexted);          // one text for everybody; otherwise the sequence decides, per account
    followupMsg = custom ? await pickFollowupText(args) : null;
    if (custom && !followupMsg) return;
    const sdClash = sameDayProblem(args, followupMsg); if (sdClash) { console.log(sdClash); return; }          // --same-day: a wording that is one of the board's own stage texts would move the lead on it
    if (args.inspect) { printFollowupPlan(args, followupMsg); return; }
    if (!tcpa.anyOpen()) { commandLog('⏰', 'TCPA hours', `HOLD — no US time zone is inside texting hours right now (texting reopens ${tcpa.nextOpen(undefined, { any: true })}). Nothing sent.`); return; }
  }

  // This copy emails/texts from a Salesforce REPORT (CONFIG.reportUrl), not an opportunity list view.
  // Explicit --report still lets you open a different report by hand; plain zw / zw --text open the saved campaign report.
  const isReport = !!args.report || !!args.email || !!args.text;
  const viewLabel = 'REPORT';
  const resolveView = (ctx, init, o) => (args.report ? resolveReportPage(ctx, init) : resolveCampaignReportPage(ctx, init, o));

  // Email runs in its OWN browser (port 9324 / .browser-profile-email) so it can run
  // concurrently with a texting session (port 9323) on the same machine.
  const browserOpts = args.tomorrow ? { cdpPort: CONFIG.tomorrowCdpPort, userDataDir: CONFIG.tomorrowUserDataDir }          // FIRST: the overnight run is never in a Chrome another mode can restart
    : args.evening ? { cdpPort: CONFIG.eveningCdpPort, userDataDir: CONFIG.eveningUserDataDir }
    : args.board ? { cdpPort: CONFIG.boardCdpPort, userDataDir: CONFIG.boardUserDataDir }
    : args.teammateTexted ? { cdpPort: CONFIG.teammateCdpPort, userDataDir: CONFIG.teammateUserDataDir }          // BEFORE the 9325 group below: --teammate-texted implies --followup
    : args.sameDay ? { cdpPort: CONFIG.sameDayCdpPort, userDataDir: CONFIG.sameDayUserDataDir }          // BEFORE the 9325 group below: --same-day implies --followup
    : args.industry ? { cdpPort: CONFIG.industryCdpPort, userDataDir: CONFIG.industryUserDataDir }
    : args.snapshot ? { cdpPort: CONFIG.sharkCdpPort, userDataDir: CONFIG.sharkUserDataDir }
    : (args.zones || args.zone) ? { cdpPort: CONFIG.zonesCdpPort, userDataDir: CONFIG.zonesUserDataDir }
    : args.holds ? { cdpPort: CONFIG.holdsCdpPort, userDataDir: CONFIG.holdsUserDataDir }
    : (args.reengage || args.review || args.reviewReport || args.threadProbe || args.harvest || args.auto || args.lists || args.followup) ? { cdpPort: CONFIG.reengageCdpPort, userDataDir: CONFIG.reengageUserDataDir }
    : args.email ? { cdpPort: CONFIG.emailCdpPort, userDataDir: CONFIG.emailUserDataDir, quiet: true }
    : { quiet: true }; // plain text / email interactive menu: no Browser link / Email browser / Salesforce link noise
  // --evening: ONE run at a time, checked BEFORE the browser is touched: a second start would otherwise attach to the live run's Chrome and load a page in the tab it is texting from
  if (args.evening && !require('./eveningShark').acquireLock(commandLog)) return;
  if (args.board && !require('./boardRun').acquireLock(commandLog)) return;      // ONE board run at a time, refused BEFORE the browser is touched (a second start would load a page in the live run's tab)
  // --tomorrow: ONE overnight run at a time, checked BEFORE the browser is touched (a second start would load a page in the tab the first one is texting from)
  if (args.tomorrow && !require('./tomorrowSend').acquireLock(commandLog)) return;
  const { context, page: initialPage, cleanup } = await launchBrowser(browserOpts);
  try {
    // Specialized modes still announce their own browser; interactive email/text stay quiet (menu is the welcome).
    if (args.tomorrow) commandLog('🌙', 'Overnight browser', `CDP ${CONFIG.tomorrowCdpPort} • its own Chrome and profile (no other mode can restart it; sign in to Salesforce once the first time)`);
    else if (args.evening) commandLog('🌙', 'Evening browser', `CDP ${CONFIG.eveningCdpPort} • its own Chrome and profile (no other mode can restart it; a healthy one is reused, so its Salesforce login stays)`);
    else if (args.board) commandLog('🗂', 'Board browser', `CDP ${CONFIG.boardCdpPort} • its own Chrome and profile (no other mode can restart it; a healthy one is reused, so its Salesforce login stays)`);
    else if (args.teammateTexted) commandLog('🤝', 'Teammate browser', `CDP ${CONFIG.teammateCdpPort} • its own Chrome and profile (never touches a running --followup on ${CONFIG.reengageCdpPort} or --same-day on ${CONFIG.sameDayCdpPort}; sign in to Salesforce once the first time)`);
    else if (args.sameDay) commandLog('📆', 'Same-day browser', `CDP ${CONFIG.sameDayCdpPort} • its own Chrome and profile (never touches a running --followup on ${CONFIG.reengageCdpPort}; sign in to Salesforce once the first time)`);
    else if (args.industry) commandLog('🏭', 'Industry browser',`CDP ${CONFIG.industryCdpPort} • own profile (runs alongside text, email, re-engage and Shark)`);
    else if (args.snapshot) commandLog('🦈', 'Shark browser', `CDP ${CONFIG.sharkCdpPort} • own profile (independent of the text, email and re-engage browsers)`);
    else if (args.zones || args.zone) commandLog('🕐', 'Time-zone browser', `CDP ${CONFIG.zonesCdpPort} • own profile (independent of every other run)`);
    else if (args.holds) commandLog('🧵', 'Holds browser', `CDP ${CONFIG.holdsCdpPort} • own profile (never touches a running --followup; sign in to Salesforce once the first time)`);
    else if (args.reengage || args.review || args.reviewReport || args.threadProbe || args.harvest || args.auto || args.lists || args.followup) commandLog('🔁', 'Re-engage browser', `CDP ${CONFIG.reengageCdpPort} • own profile (independent of text and email browsers)`);
    // email / plain text: no Email browser or Salesforce link line — the interactive menu is the welcome
    if (!browserOpts.quiet) commandLog('🟢', 'Salesforce link', `Loading command environment (${viewLabel} mode)`);
    try { await initialPage.goto(CONFIG.startUrl, { waitUntil: 'domcontentloaded' }); } catch (_) {}

    // --tomorrow: the OVERNIGHT run (tomorrowSend.js): every queued pro is texted at their own NEXT 8:00 AM, hands-off, in its own Chrome. Used by --shark13 --send, --shark --send --tomorrow and --queue --send --tomorrow.
    const runOvernight = async (page) => {
      const ts = require('./tomorrowSend');
      const m = args.dryRun && !(args.template || args.message) ? ts.NO_TEXT : await pickSendMessage(args);
      if (!m) return;
      await ts.runTomorrow(page, { ...m, delayMs: args.delayMs, unknownZone: args.unknownZone, until: args.until, yes: args.yes, dryRun: args.dryRun, maxTexts: args.maxTexts },
        { commandLog, ask, runReportCampaign, textAccount, parseUntil, textLog, textQueue, startUrl: CONFIG.startUrl, port: CONFIG.tomorrowCdpPort, profileDir: path.basename(CONFIG.tomorrowUserDataDir) });
    };

    // --industry: read each dashboard account's Industry field (own browser, read-only).
    if (args.industry) { await runIndustry(context, initialPage, args); return; }

    // --evening: text tomorrow's Shark list tonight, each pro at their own 7 PM, with nobody at the Mac. One confirm, then hands-off (eveningShark.js).
    if (args.evening) { await require('./eveningShark').runMode(context, initialPage, args, { commandLog, ask, openReportAndHarvest, harvestReportLeads, reportFrame, runReportCampaign, pickSendMessage, parseUntil, REPORT_MODES, CONFIG, textLog }); return; }
    // --board: every lead on the follow-up board follows the stages of cadence.js by itself, each text / email inside the lead's own hours (boardRun.js). One confirm, then hands-off.
    if (args.board) { await require('./boardRun').runBoardMode(context, initialPage, args, { commandLog, ask, runReportCampaign, runEmailCampaign, createTemplateKey, TEMPLATES, CONFIG, textLog, parseUntil, emailSequence, emailsSentToday }); return; }

    // --reengage: 48h follow-up from the durable log. Text pass by default, email pass with
    // --email. Unattended-safe: no prompts, capped by --max, once per account per channel.
    // --review <accountId[,id…]>: run the Salesforce review on those accounts and print what
    // was read. Read-only, sends nothing. Use it to verify the rules against real accounts.
    // --harvest: scan the report that is open in a report view and save what it shows (no account is opened). The per-account read is --harvest --deep.
    if (args.harvest && !args.deep) { await runReportHarvest(context, initialPage, args); return; }

    // --harvest --deep [--max N]: per account, in ONE visit each — time zone (from the address), the
    // opportunities, and the Activity History + Notes rows. Read-only; sends nothing. Saves
    // zones to contact-zones.jsonl and the rest to account-notes.jsonl. Accounts due for
    // re-engage first; resumable (skips accounts already harvested and zoned).
    if (args.harvest && args.deep) {
      const page = await waitForSalesforceLogin(context, initialPage);
      const done = textLog.readHarvest();
      const zonesTried = textLog.readZones();
      const seenIds = new Set(); let todo = [];
      const add = (l) => {
        const k = String(l.accountId || '').toLowerCase();
        if (!k || seenIds.has(k)) return; seenIds.add(k);
        const h = done.get(k);
        if (h && h.ok && (textLog.zonesFor(l.accountId) || zonesTried.has(k))) return; // already complete (or its address was tried and had no readable state)
        todo.push({ accountId: l.accountId, name: l.name });
      };
      textLog.reengageDue('text', { maxDays: 365, includeHeld: true }).forEach(add);
      textLog.aggregate().forEach((a) => add({ accountId: a.accountId, name: a.accountName }));
      commandLog('📥', 'Harvest', `${todo.length} account(s) still need zone / opportunities / notes; reading up to ${args.max}`);
      todo = todo.slice(0, args.max);
      let n = 0, zoned = 0, started = Date.now(), failStreak = 0;
      for (const lead of todo) {
        n++;
        let loc, opps = { ok: false, opps: [] }, notes = [];
        try {
          loc = textLog.zonesFor(lead.accountId) ? null : await accountZone.readLocation(page, lead.accountId);
          if (loc) textLog.recordZone({ accountId: lead.accountId, accountName: lead.name, state: loc.state, source: loc.source, address: loc.address, phone: loc.phone });
          opps = await sfReview.readOpportunities(page, lead.accountId);
          notes = opps.ok ? await sfReview.readNotes(page, lead.accountId, { activity: false }) : [];
        } catch (e) { commandLog('❌', 'Harvest', `${lead.name} — ${e.message}`); }
        // A failed read (page closed / logged out / bad link) is NOT saved as harvested, so a rerun
        // retries it. Several in a row means something is wrong — stop instead of burning the list.
        if (!opps.ok) {
          failStreak++;
          console.log(`  ❌ ${n}/${todo.length} could not read ${lead.name} (${opps.note || 'opportunities unreadable'}) — not saved, will retry next run`);
          if (failStreak >= 5) { console.log('\n  ⛔ 5 reads failed in a row — stopping. Check the 9325 Chrome window is open and logged into Salesforce, then rerun.\n'); break; }
          continue;
        }
        failStreak = 0;
        // Original sales rep + demo date, from the Opportunity Owner column and the note previews (no extra page loads).
        let demo = null;
        try {
          const byDate = [...(opps.opps || [])].sort((a, b) => (Date.parse(b.closeDate) || 0) - (Date.parse(a.closeDate) || 0));
          const tgt = byDate.find((o) => /lost[\s_-]*demo/i.test(o.stage)) || byDate[0] || null;
          demo = sfReview.resolveRepAndDemo({ detail: null, target: tgt, noteRows: notes, noteBodies: [] }).original;
        } catch (_) {}
        textLog.recordHarvest({ accountId: lead.accountId, accountName: lead.name, ok: opps.ok, opps: (opps.opps || []).map(({ name, stage, closeDate, owner }) => ({ name, stage, closeDate, owner: owner || '' })), notes: notes.slice(0, 80), demo });
        const st = loc ? loc.state : (textLog.readZones().get(String(lead.accountId).toLowerCase()) || {}).state;
        if (st) zoned++;
        const eta = Math.round(((Date.now() - started) / n) * (todo.length - n) / 60000);
        console.log(`  ${n}/${todo.length} ${st ? '🕐 ' + st : '❓ no zone'}  ${opps.ok ? (opps.opps.length + ' opp(s), ' + notes.length + ' note/activity row(s)') : 'opportunities unreadable'}  — ${lead.name}   (~${eta} min left)`);
      }
      console.log(`\n  📥 Harvested ${todo.length} account(s); ${zoned} with a time zone. Regenerate the dashboard with:  node textLog.js\n`);
      try { textLog.generateDashboard(); } catch (_) {}
      return;
    }

    // --thread-probe <id[,id]>: READ-ONLY look at an account's Texts tab / composer screen (what the text thread looks like). Types and sends nothing.
    if (args.threadProbe) {
      const probe = require('./threadProbe');
      const page = await waitForSalesforceLogin(context, initialPage);
      for (const id of String(args.threadProbe).split(',').map((x) => x.trim()).filter(Boolean)) {
        const fixed = sfId.fix(id);
        probe.print(await probe.probeAccount(page, `${CONFIG.startUrl.replace(/\/$/, '')}/lightning/r/Account/${fixed}/view`, fixed));
        const th = await threadReader.readThread(page);
        console.log(`  🧵 Parsed thread — ${th.messages.length} message(s)${th.ok ? '' : ' (' + th.error + ')'}; our own rep name = "${threadReader.ME}" (set ASSISTANT_SENDER to change)`);
        th.messages.forEach((m) => console.log(`     ${m.dir === 'in' ? '⬅️  pro   ' : '➡️  ' + (m.sender && m.sender.toLowerCase().includes(threadReader.ME) ? 'us    ' : 'TEAM  ')}  ${m.at ? m.at.toLocaleString() : '(time?)'}  ${m.sender || ''}: ${String(m.body).slice(0, 90)}`));
        ['normal', 'teammate'].forEach((mode) => { const v = threadReader.decide(th.messages, { mode }); console.log(`  ${v.hold ? '🧵 HOLD' : '✅ SEND'}  --followup${mode === 'teammate' ? ' --teammate' : ''}: ${v.reason}`); });
        console.log('');
      }
      return;
    }

    // --zone <id[,id]> / --zones [--max N]: read each account's address and cache its time zone
    // (read-only; sends nothing). --zones fills in accounts that have no zone yet: the follow-up board's leads first (the ones it
    // texts next at the very top), then the rest of the texted log, accounts due for re-engage first (accountZone.zoneTodo).
    // Results land in contact-zones.jsonl and the dashboard's Time zone column.
    if (args.zone || args.zones) {
      const page = await waitForSalesforceLogin(context, initialPage);
      let todo;
      if (args.zone) {
        todo = String(args.zone).split(',').map((x) => x.trim()).filter(Boolean).map((id) => ({ accountId: id, name: id }));
      } else {
        const plan = accountZone.zoneTodo({ textLog, cadence: require('./cadence'), refresh: args.refresh });
        commandLog('🕐', 'Time zones', accountZone.planLine(plan, args));
        if (plan.note) commandLog('⚠️', 'Time zones', plan.note);
        todo = plan.todo.slice(0, args.max);
      }
      let ok = 0;
      for (const lead of todo) {
        if (args.zone) textLog.zonesFor(lead.accountId) && commandLog('ℹ️', 'Time zone', `${lead.name} already cached — re-reading`);
        const { loc, row, source: src } = await accountZone.readAndRecord(page, lead, { recordZone: (r) => textLog.recordZone(r) });      // a page that loaded but showed no address is cached as "nothing found" (the next run leaves it alone for 14 days)
        if (loc.zone || loc.state) ok++;
        console.log(`  ${loc.zone || loc.state ? '🕐' : '❓'} ${lead.name}  ${loc.zone || loc.state ? row.zones.map((z) => tcpa.ZONE_SHORT[z]).join('/') + ' (' + src + (loc.zone ? ': "' + loc.zoneRaw + '"' : '') + ')' : 'no Timezone field or state found — ' + (loc.note || 'address not readable')}`);
        if (args.zone) { console.log('     address:', loc.address || '(none)', '| phone:', loc.phone || '(none)'); console.log('     fields read:', Object.keys(loc.fields || {}).join(', ') || '(none)'); }
      }
      console.log(`\n  🕐 ${ok}/${todo.length} resolved. Regenerate the dashboard with:  node textLog.js\n`);
      try { textLog.generateDashboard(); } catch (_) {}
      return;
    }

    // --shark (or --snapshot [--kind …]): BACK UP the report to the dashboard before reps work it off the list.
    // Reads every account on the report (with the report's own columns), saves a dated snapshot, tags them #shark,
    // queues them for texting (--queue), and puts them on the dashboard — so when you text/email them later, the dashboard
    // logs it against the same row even if the account has since dropped off the report. Read-only: sends nothing.
    if (args.snapshot) {
      if (args.send && args.noQueue) { console.log('\n  --send texts the queue, so it cannot be combined with --no-queue.\n'); return; }
      if (args.pick && !args.shark13) {
        console.log('\n  🦈 Which Shark list?');
        SHARK_PICK.forEach((m) => console.log(`     ${m.n}. ${m.label}${REPORT_MODES[m.key] ? '' : '   (not saved yet: you open it once, then it is remembered)'}`));
        console.log(`     ${SHARK_PICK.length + 1}. Another list (you open it in Chrome)`);
        const c = parseInt((await ask(`\n  Pick 1-${SHARK_PICK.length + 1}: `)).trim(), 10);
        const m = SHARK_PICK.find((x) => x.n === c);
        if (!m && c !== SHARK_PICK.length + 1) { console.log('\n  Not a choice. Nothing done.\n'); return; }
        if (m && m.key === 'shark13') {
          args.shark13 = true; args.mode = 'shark13';
          if (args.send && !args.tomorrow) {          // T13 + --send is the OVERNIGHT run: it needs its own Chrome and its lock, chosen before the browser started (run.sh, the lock above), so this run only backs T13 up
            args.send = false;
            console.log('\n  🌙 T13 is tomorrow\'s list: texting it is the overnight run, which needs its own Chrome. This run only backs T13 up and queues it.\n     Then start:  email --queue --send --tomorrow --template N     (or from the start:  email --shark13 --send --template N)\n');
          }
        }      // T13 is tomorrow's list: its own rules (overnight, next 8:00 AM)
        else if (m && REPORT_MODES[m.key]) args.mode = m.key;
        else { args.mode = null; args.sharkChoice = m ? m.key : null; }
        if (args.mode) commandLog('🗂️', 'Shark list', `${(REPORT_MODES[args.mode] || {}).name || args.mode} — opening it for you`);
      }
      const snapRes = await runSnapshot(context, initialPage, args);
      // --send: carry on in this same browser — text each queued pro as their own window opens (the hands-off day)
      if (args.send) {
        if (!snapRes || !snapRes.page) { console.log('\n  --send: the backup did not finish, so nothing is texted.\n'); return; }
        if (args.tomorrow) { await runOvernight(snapRes.page); return; }
        const m = await pickSendMessage(args);
        if (!m) return;
        await runQueueDay(snapRes.page, { ...m, delayMs: args.delayMs, unknownZone: args.unknownZone, until: args.until, yes: args.yes });
      }
      return;
    }

    // --lists: read the saved reports (--lds, --inbound-lds, and any in report-modes.json — or just the ones you name),
    // and/or the report you open (--report [--kind LDS|Shark]); every account found is tagged with that list so the
    // dashboard can show "LDS" vs "Shark". Read-only: sends nothing.
    if (args.lists) {
      let page = await waitForSalesforceLogin(context, initialPage);
      const keys = args.modes.length ? args.modes : (args.report ? [] : Object.keys(REPORT_MODES).filter((k) => k !== 'shark13' && k !== 'shark30' && k !== 'shark150'));   // (--shark13 is tomorrow's list: a plain --lists leaves it alone)
      const summary = [];
      for (const key of keys) {
        const m = REPORT_MODES[key]; if (!m) continue;
        commandLog('🗂️', 'Lists', `${m.name} — opening the report`);
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        for (let i = 0; i < 40 && !reportFrame(page); i++) await sleep(1000);
        commandLog('⏳', 'Report loading', `waiting ${Math.round(args.loadWaitMs / 1000)}s for the rows to fill in`);
        await sleep(args.loadWaitMs);
        try {
          const leads = await harvestReportLeads(page, { kind: m.kind });
          summary.push(`${m.name}: ${leads.length} accounts → ${(leads.source && leads.source.kind) || 'untagged'}`);
        } catch (e) { summary.push(`${m.name}: could not be read (${e.message})`); }
      }
      if (args.report) {
        const r = await openReportAndHarvest(context, initialPage, { ...args, mode: null });
        if (r) summary.push(`${(r.source && r.source.name) || 'the open report'}: ${r.leads.length} accounts → ${(r.source && r.source.kind) || 'NOT tagged (name has no LDS/Shark — rerun with --kind LDS or --kind Shark)'}`);
      }
      console.log('\n  📋 LISTS TAGGED\n' + (summary.length ? summary.map((x) => '     ' + x).join('\n') : '     (nothing scanned)') + '\n  Refresh the dashboard with:  node textLog.js   (or email --sent)\n');
      try { textLog.generateDashboard(); } catch (_) {}
      return;
    }

    // --holds: draft + send the subtle check-in to leads whose send was held by their thread (see runHolds).
    if (args.holds) { await runHolds(context, initialPage, args); return; }

    // --followup: another text to Shark leads with no touch in --days or more (see runFollowup).
    if (args.followup) {
      await runFollowup(context, initialPage, args, followupMsg);
      return;
    }

    // --auto: personalised game plan per account (see runAuto).
    if (args.auto) {
      await runAuto(context, initialPage, args);
      return;
    }

    // --review-report: harvest the open Salesforce REPORT (e.g. an LDS list), run the read-only
    // account review on each account (up to --max, default 25) and save everything read to
    // lds-review.json so emails can be drafted per account. Sends nothing.
    if (args.reviewReport) {
      let page;
      if (args.mode && REPORT_MODES[args.mode]) {
        // Saved mode: log in, then go straight to that report (stays on it for the harvest).
        const m = REPORT_MODES[args.mode];
        page = await waitForSalesforceLogin(context, initialPage);
        commandLog('🗂️', 'Report mode', `${m.name} — opening ${m.url}`);
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        for (let i = 0; i < 40 && !reportFrame(page); i++) await sleep(1000);
        // Big reports (e.g. 30,000 records / 2,000 rows on the page) keep filling in after the
        // frame appears — give them time before the first scan (--load-wait S, default 10).
        commandLog('⏳', 'Report loading', `waiting ${Math.round(args.loadWaitMs / 1000)}s for the rows to fill in`);
        await sleep(args.loadWaitMs);
      } else {
        page = await resolveReportPage(context, initialPage);
      }
      let frame = reportFrame(page);
      for (let i = 0; i < 6 && !frame; i++) { await sleep(1000); frame = reportFrame(page); }
      // Scan, then (on a terminal) let the operator rescan while a big report is still loading.
      let leads = [];
      while (true) {
        commandLog('📇', 'Harvest', 'Scanning report for accounts…');
        leads = await harvestReportLeads(page);
        commandLog('📬', 'Accounts harvested', `${leads.length}`);
        if (!process.stdin.isTTY) break;
        const ans = (await ask(`\n  Found ${leads.length} account(s). Press Enter to ${leads.length ? 'start the review' : 'scan again'}, r = scan again (report may still be loading), q = quit: `)).toLowerCase();
        if (ans === 'q') return;
        if (ans === 'r' || !leads.length) { await sleep(2000); continue; }
        break;
      }
      if (!leads.length) { console.log('\n⚠️  No accounts found. Make sure the report rows are visible, then retry.\n'); return; }
      const log = textLog.readAll();
      const reportUrl = page.url(); // before the reviews navigate away
      const out = [];
      for (const lead of leads.slice(0, args.max)) {
        const mine = lead.accountId ? log.filter((r) => r.accountId && r.accountId.toLowerCase() === lead.accountId.toLowerCase()) : [];
        const firstAt = mine.length ? mine.map((r) => r.at).sort()[0] : null;
        if (textLog.isBanned(lead.accountId)) {
          commandLog('🚫', 'Banlist', `${lead.name} — on the banlist, not reviewed`);
          out.push({ accountId: lead.accountId, accountName: lead.name, verdict: 'skip', reasons: ['on the banlist'], warnings: [], opps: [], notes: [], url: lead.url, banned: true });
          continue;
        }
        commandLog('🔎', 'SF review', lead.name);
        let v;
        try { v = await sfReview.reviewAccount(page, { accountId: lead.accountId, name: lead.name, firstAt }, { detail: true }); }
        catch (e) { v = { accountId: lead.accountId, accountName: lead.name, verdict: 'unknown', reasons: [`review error: ${e.message}`], warnings: [], opps: [], notes: [] }; }
        out.push({ ...v, url: lead.url, priorTouches: mine.length });
        if (v.hardStop && textLog.recordBan({ accountId: lead.accountId, accountName: lead.name, reason: v.hardStop, source: 'LDS review' })) commandLog('🚫', 'Banlist', `${lead.name} added — ${v.hardStop}`);
        const icon = v.verdict === 'proceed' ? '✅' : v.verdict === 'skip' ? '🛑' : '❓';
        commandLog(icon, `Review: ${v.verdict.toUpperCase()}`, `${v.opps.length} opp(s)${v.reasons.length ? ' — ' + v.reasons.join('; ') : ''}`);
      }
      const file = path.join(__dirname, 'lds-review.json');
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reportUrl, accounts: out }, null, 2), 'utf8');
      console.log(`\n  📝 Saved ${out.length} reviewed account(s) → ${file}\n     ${out.filter((x) => x.verdict === 'proceed').length} proceed · ${out.filter((x) => x.verdict === 'skip').length} skip · ${out.filter((x) => x.verdict === 'unknown').length} unknown\n`);
      return;
    }

    if (args.review) {
      const page = await waitForSalesforceLogin(context, initialPage);
      const log = textLog.readAll();
      for (const id of String(args.review).split(',').map((s) => s.trim()).filter(Boolean)) {
        const mine = log.filter((r) => r.accountId && r.accountId.toLowerCase() === id.toLowerCase());
        const firstAt = mine.length ? mine.map((r) => r.at).sort()[0] : null;
        const v = await sfReview.reviewAccount(page, { accountId: id, name: (mine[0] && mine[0].accountName) || id, firstAt });
        console.log(`\n🔎 ${v.accountName}  (${id})  first touch: ${firstAt || 'none logged'}`);
        v.opps.forEach((o) => console.log(`     opp: ${(o.closeDate || 'no-date').padEnd(12)} ${(o.stage || '(no stage)').padEnd(22)} ${o.name}`));
        console.log(`     notes/activities read: ${v.notesRead}`);
        console.log(`     VERDICT: ${v.verdict.toUpperCase()}${v.reasons.length ? ' — ' + v.reasons.join('; ') : ''}`);
        v.warnings.forEach((w) => console.log(`     ⚠️  ${w}`));
      }
      return;
    }

    if (args.reengage) {
      // Both channels in this one browser by default (text pass, then email pass);
      // --text / --email limit it to one.
      const channels = args.text && !args.email ? ['text'] : args.email && !args.text ? ['email'] : ['text', 'email'];
      // Wait for a real, logged-in Lightning page first (Okta on a fresh profile).
      const page = await waitForSalesforceLogin(context, initialPage);
      // Batch loop: after each batch (text pass then email pass), ask whether to keep going
      // and how many accounts to run. Only prompts on an interactive terminal; a scheduled /
      // piped run (or --once / --only) does a single batch and exits. Accounts already tried
      // this session are skipped so a failing one can't be retried every batch.
      const interactive = !!process.stdin.isTTY && !args.once && !args.only;
      const tried = new Set();
      const reviewCache = new Map();
      let batchMax = args.max;
      while (true) {
        let sent = 0;
        for (const ch of channels) {
          if (ch === 'text' && !tcpa.anyOpen()) { commandLog('⏰', 'TCPA hours', `HOLD — no US time zone is inside texting hours right now (texting reopens ${tcpa.nextOpen(undefined, { any: true })}); skipping the text pass, emails still go`); continue; }
          const candidates = textLog.reengageDue(ch, { maxDays: args.maxAgeDays })
            .filter((l) => !args.only || l.accountId.toLowerCase() === String(args.only).toLowerCase())
            .filter((l) => !tried.has(`${ch}|${l.accountId}`));
          commandLog('🔁', 'Re-engage', `${candidates.length} account(s) due for a 48h ${ch} (cap ${batchMax}, window 48h–${args.maxAgeDays}d)`);
          // Salesforce review before ANY send: read opportunities + notes, keep only
          // accounts that pass. Skips don't count against the batch cap.
          const due = args.noReview ? candidates.slice(0, batchMax) : await reviewCandidates(page, candidates, batchMax, reviewCache, tried, ch);
          if (!due.length) continue;
          due.forEach((l) => tried.add(`${ch}|${l.accountId}`));
          sent += due.length;
          const common = { start: 1, end: due.length, delayMs: args.delayMs, force: false };
          if (ch === 'text') {
            await runReportCampaign(page, { ...common, message: REENGAGE_TEXT.text, templateName: REENGAGE_TEXT.name, templateKey: createTemplateKey('text', REENGAGE_TEXT.name, REENGAGE_TEXT.text), leads: due, tcpa: true });
          } else {
            await runEmailCampaign(page, due, { ...common, subject: REENGAGE_EMAIL.subject, body: REENGAGE_EMAIL.body, templateName: REENGAGE_EMAIL.name, dryRun: args.dryRun });
          }
        }
        if (!interactive || !sent) break;
        const remaining = channels.map((ch) => `${textLog.reengageDue(ch, { maxDays: args.maxAgeDays }).filter((l) => !tried.has(`${ch}|${l.accountId}`)).length} ${ch}`).join(', ');
        const ans = (await ask(`\n  🔁 Batch done. Still due: ${remaining}.\n  Keep going? Enter how many accounts to run next (e.g. 25, 100), or press Enter / q to stop: `)).toLowerCase();
        const n = parseInt(ans, 10);
        if (!n || n < 1) break;
        batchMax = n;
      }
      return;
    }

    // --email: harvest the list/report, then email every account in one run.
    if (args.email) {
      // --from-snapshot: email the accounts backed up by `email --shark`, even if reps have since worked them off the report.
      const sysSource = args.fromSnapshot || args.fromDashboard || args.fromFreePlan || args.fromHand || args.blast || (args.byEmail && args.csv);   // accounts come from our own data, not an open report
      // --scan <report>: open that SAVED report ourselves (no clicking), scan it and save its accounts (list-membership.jsonl), then email from it.
      let knownBefore = null; let scanned = null;
      if (args.scan) {
        if (!REPORT_MODES[args.scan]) { console.log(`\n  --scan "${args.scan}" is not a saved report. Saved: ${Object.keys(REPORT_MODES).join(', ')}\n`); return; }
        knownBefore = new Set([...textLog.readListMembership()].map(([k]) => k.slice(0, 15)));
        scanned = await openReportAndHarvest(context, initialPage, { ...args, mode: args.scan });
        if (!scanned) return;
      }
      // --by-email --csv <file>: the addresses come from a CSV file (emailSource.js) instead of an open report. Read it FIRST, so a wrong path or column fails before any browser step.
      let csvList = null;
      if (args.byEmail && args.csv) {
        try { csvList = emailSource.readEmailCsv(args.csv, { column: args.csvColumn }); }
        catch (e) { console.log(`\n  ⚠️  ${e.message}\n`); return; }
        const cs = csvList.stats;
        commandLog('📄', 'CSV file', `${csvList.file} • ${cs.rows} row(s) → ${cs.unique} different address(es) • address column "${csvList.column}"${cs.withAccount ? ` • account named for ${cs.withAccount} (column "${csvList.accountColumn}")` : ''}`);
        if (csvList.others.length) commandLog('ℹ️', 'CSV columns', `other columns with "email" in the name were not used: ${csvList.others.join(', ')} (to use one: --csv-column "<column>")`);
        if (cs.blank || cs.invalid || cs.multi) commandLog('ℹ️', 'CSV rows', `${cs.blank} row(s) without an address, ${cs.invalid} not an address, ${cs.multi} cell(s) with several addresses (the first is used)`);
        if (args.inspect) {
          console.log(`\nEmail addresses in the file: ${csvList.emails.length} (--inspect: nothing looked up, nothing sent)\n`);
          csvList.emails.slice(0, 15).forEach((e, i) => console.log(`  ${String(i + 1).padStart(3)}. ${e.email}${e.name ? '  — ' + e.name : ''}${e.accountId ? '  (' + e.accountId + ')' : ''}`));
          if (csvList.emails.length > 15) console.log(`  ... and ${csvList.emails.length - 15} more`);
          console.log(`\n  What each one needs (no browser):   node emailSource.js ${JSON.stringify(args.csv)}\n  Match the accounts, send nothing:   email --email --by-email --csv ${JSON.stringify(args.csv)} --lookup-only\n`);
          return;
        }
      }
      // --by-email needs the REPORT of addresses: ask for exactly that, look in every tab and give it time to draw (emailLookup.openEmailReport). The list-view prompt asked for the wrong page, took only the newest tab and ended the run after 6 s.
      const page = scanned ? scanned.page : sysSource ? await waitForSalesforceLogin(context, initialPage)
        : args.byEmail ? await emailLookup.openEmailReport(context, { ask, reportFrame, sfUrlSubstring: CONFIG.sfUrlSubstring, sleep, log: commandLog })
        : await resolveView(context, initialPage, { email: true });      // the email campaign's welcome screen (WELCOME_EMAIL)
      if (!page) { console.log('\n  ⛔ No report was opened, so there is nothing to email. Run the same command again once the report is open.\n'); return; }
      // Auto-detect the source regardless of --report: a Salesforce REPORT renders its
      // grid inside a `lightningReportApp` iframe. That iframe loads a beat AFTER the
      // page, so we give it a few seconds to register before deciding — otherwise we'd
      // wrongly fall back to list-view harvesting (which can't read a report and finds
      // ~1 stray link). Only treat it as a list view when there's genuinely no frame.
      let frame = (sysSource || scanned) ? null : reportFrame(page);
      for (let i = 0; i < 6 && !frame && !sysSource && !scanned; i++) { await sleep(1000); frame = reportFrame(page); }
      const onReport = (sysSource || scanned) ? true : !!frame;
      let leads;
      if (args.byEmail) {
        // The report lists email addresses, not accounts: harvest them, look each up in Salesforce, then the normal email flow runs on the accounts found.
        if (!frame && !scanned && !csvList) { console.log('\n  ⚠️  --by-email needs a Salesforce REPORT open (or --scan <saved report>).\n'); return; }
        const origin = new URL(page.url()).origin;
        if (!csvList) commandLog('📧', 'Harvest', 'Reading the email addresses on the report…');
        let emails = csvList ? csvList.emails : await emailLookup.harvestEmails(page, { reportFrame, reportScrollStep, sleep });
        commandLog('📬', 'Emails harvested', `${emails.length} address(es)${emails.headers && emails.headers.length ? ' • columns: ' + emails.headers.filter(Boolean).join(' | ') : ''}`);
        if (!emails.length) { console.log('\n  ⚠️  No email addresses found. Make sure the report has an Email column and its detail rows are showing (not collapsed).\n'); return; }
        if (args.lookupLimit) emails = emails.slice(0, args.lookupLimit);
        if (args.inspect) {
          console.log(`\nEmail addresses on the report: ${emails.length} (--inspect: no Salesforce lookups, nothing sent)\n`);
          emails.slice(0, 15).forEach((e, i) => console.log(`  ${String(i + 1).padStart(3)}. ${e.email}${e.name ? '  — ' + e.name : ''}`));
          if (emails.length > 15) console.log(`  ... and ${emails.length - 15} more`);
          console.log('\n  Next: --email --by-email --lookup-only --lookup-limit 5   (looks the first 5 up in Salesforce, still sends nothing)\n');
          return;
        }
        let ownMatch = null;      // our own files first: an address they tie to exactly ONE account needs no Salesforce search (--no-own-data: search everything that has no saved lookup)
        if (!args.noOwnData) {
          try { ownMatch = emailSource.loadOwn(); commandLog('🗃️', 'Our own files', `${ownMatch.size} address(es) already tied to an account (texted-log.jsonl, account-emails.jsonl): Salesforce is only searched for addresses these and the saved lookups do not answer`); }
          catch (e) { commandLog('⚠️', 'Our own files', `not used (${e.message}): every address without a saved lookup is searched in Salesforce`); }
        }
        const res = await emailLookup.resolveAll(page, emails, { sleep, origin, own: ownMatch, debug: !!args.debugLookup, log: commandLog }, { onProgress: (i, n, e, r, via) => commandLog(r.status === 'found' ? '🔎' : '❔', `Lookup ${i}/${n}`, `${e.email} → ${r.status === 'found' ? `${r.name} (${r.accountId})` : r.status + (r.why ? ' — ' + r.why : '')}${via === 'own' ? '  • from our own files' : via === 'file' ? '  • named in the file' : ''}`) });
        if (res.aborted) {                                    // window closed / Salesforce login / unreadable results: nothing was recorded for the address it stopped on
          const a = res.aborted;
          console.log(`\n  ⛔ Lookups STOPPED at ${a.done}/${a.total}: ${a.message}.`);
          console.log(`     Nothing was recorded for ${a.email} or anything after it; every lookup before it is saved in email-lookups.jsonl.`);
          console.log(`     ${a.kind === 'login' ? 'Sign in to Salesforce in the browser window, then run' : 'Run'} the same command again — it carries on from the saved lookups.\n`);
          process.exit(1);                                    // stop with a failing exit code (cleanup() would only disconnect from the browser; it never closes the window)
        }
        leads = res.leads; leads.source = { kind: 'Email report', name: csvList ? 'email list (CSV)' : (REPORT_MODES[args.scan] && REPORT_MODES[args.scan].name) || 'email report' };
        const by = res.unresolved.reduce((o, u) => (o[u.status] = (o[u.status] || 0) + 1, o), {});
        commandLog('🧮', 'Lookup', `${leads.length} account(s) found • ${res.unresolved.length} not emailed${res.unresolved.length ? ' (' + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : ''}`);
        const how = res.stats || {};
        commandLog('🗃️', 'Matched from', [how.file && `${how.file} named in the file`, how.cache && `${how.cache} saved lookups`, how.own && `${how.own} our own files`, how.searched && `${how.searched} searched in Salesforce`].filter(Boolean).join(' • ') || 'nothing');
        res.unresolved.slice(0, 20).forEach((u) => console.log(`     ${u.status.padEnd(12)} ${u.email}${u.why ? ' — ' + u.why : ''}`));
        if (args.lookupOnly) { console.log(`\n  --lookup-only: ${leads.length} account(s) matched, nothing emailed. Results are saved in email-lookups.jsonl.\n`); leads.slice(0, 20).forEach((l, i) => console.log(`  ${String(i + 1).padStart(3)}. ${l.email} → ${l.name}  ${l.url}`)); return; }
        if (args.sequence) leads = prepareCadenceLeads(leads, args);
      } else if (args.fromFreePlan) {
        leads = textLog.freePlanLeads();
        const coachOut = !require('./coachingPolicy').held();       // business coaching is kept out of outreach (a different department, 2026-10-29) unless the policy releases it
        leads.source = { kind: 'Free plan', name: coachOut ? 'dashboard Invoicing & Payments / Coaching tabs' : 'dashboard Invoicing & Payments tab' };
        commandLog('🆓', 'Free plan', `${leads.length} account(s) on the free Invoicing and Payments plan${coachOut ? ' or business coaching' : ' (business coaching is kept out of outreach, so it is not in this list)'} (banned left out; the email run still skips real customers, replies and anyone emailed today)`);
        if (args.sequence) leads = prepareCadenceLeads(leads, args);
      } else if (args.fromHand) {
        // the leads you added by hand (dashboard Tools > Follow-up board), any #tag: through the same 6-touch cadence intake as the other sources
        const found = require('./manualShark').emailLeads({ tag: args.tag });
        if (!found.ok) { console.log(`\n  ⚠️  ${found.reason}\n`); await ask('\nPress Enter to close the browser... '); return; }
        if (found.noName.length) commandLog('⚠️', 'No name', `${found.noName.length} hand-added lead(s) have no business name on file and are left out: ${found.noName.join(', ')}`);
        leads = found.leads.map((l) => ({ accountId: l.accountId, name: l.name, url: l.url }));
        leads.source = null;      // NOT a list: the emails this run logs carry no source, so a hand-added lead keeps exactly the lists its #tags give it (a Shark / LDS source here would put it on that list for good)
        commandLog('✋', 'Added by hand', `${found.total} lead(s) you worked by hand${args.tag ? `, ${leads.length} tagged #${args.tag}` : ''} (banned, closed-won and customers are dropped, and only an account DUE a touch is kept, below)`);
        if (args.sequence) leads = prepareCadenceLeads(leads, args);
      } else if (args.blast) {
        // ONE email to every lead we have not emailed in over --days days (emailBlast.js): the follow-up board's leads, the longest silence first, never a lead that replied.
        const eb = require('./emailBlast');
        const found = eb.fromBoard({
          textLog,
          cadence: require('./cadence'),
          days: args.blastDays,
          includeNever: !!args.includeNeverEmailed,
          list: eb.parseList(args.list).kind,
          product: args.blastProduct || null,
          noHigher: !!args.blastNoHigher,
        });
        leads = found.leads;
        leads.source = null;      // NOT a list: the emails this run logs carry no source, so a blast never puts a lead on a list it was not on (as --from-hand)
        commandLog('📣', 'Email blast', eb.oneLine(found) + (args.blastProduct ? ` · product ${args.blastProduct}${args.blastNoHigher ? ' (no higher)' : ''}` : ''));
        if (!leads.length) { console.log(`\n  📣 Nobody is due an email blast: every lead was emailed in the last ${args.blastDays} day(s), replied, or has no address. (node Assistant.js --cadence --blast shows the numbers)\n`); await ask('\nPress Enter to close the browser... '); return; }
      } else if (args.fromDashboard) {
        const all = textLog.ldsLeads();
        leads = all.map((l) => ({ accountId: l.accountId, name: l.name, url: l.url }));
        leads.source = { kind: 'LDS', name: 'dashboard LDS tab' };
        commandLog('🗂️', 'Dashboard LDS', `${leads.length} LDS lead(s) in our system (inbound key-account LDS included; banned, closed-won and customers left out)`);
        if (args.sequence) leads = prepareCadenceLeads(leads, args);
      } else if (scanned) {
        leads = scanned.leads; leads.source = scanned.source || leads.source;
        commandLog('📬', 'Accounts scanned', `${leads.length} from ${REPORT_MODES[args.scan].name} (saved to our system)`);
        if (args.sequence) leads = prepareCadenceLeads(leads, args, knownBefore);
      } else if (args.fromSnapshot) {
        leads = snapshotLeads({ channel: 'email' });
        commandLog('📌', 'Snapshot', leads.snapshotAt ? `${leads.length} account(s) from the Shark snapshot of ${leads.snapshotAt.slice(0, 16)} still to email (banned and already-emailed skipped)` : 'no Shark snapshot yet — run:  email --shark');
      } else {
        commandLog('📇', 'Harvest', `Scanning ${onReport ? 'report' : 'list view'} for accounts…`);
        leads = onReport ? await harvestReportLeads(page) : await harvestListLeads(page);
        commandLog('📬', 'Accounts harvested', `${leads.length} account(s) detected${harvestSummary(leads)}`);
        warnShortHarvest(leads);      // says so plainly when fewer rows were read than the list has, or the rows have no Account link
        if (args.sequence) leads = prepareCadenceLeads(leads, args);
      }
      if (args.neverEmailed) leads = prepareNeverEmailedLeads(leads, args);      // --never-emailed: the one-off email goes only to accounts we have never emailed (and none that replied)
      if (onReport && !sysSource && !scanned && leads.length <= 1) {
        console.log('\n  ⚠️  Only found ' + leads.length + ' account in the report. Make sure its detail rows are');
        console.log('      visible (expand collapsed groups, let it finish loading), then retry.');
      }

      if (args.inspect) {
        inspectEmailLeads(leads, 10, { dailyGuardOn: !args.force });
        await ask('\nPress Enter to close the browser... ');
        return;
      }
      if (leads.length === 0) {
        console.log(`\n⚠️  No accounts harvested from the ${onReport ? 'report' : 'list view'}.`);
        if (onReport) console.log('    Make sure the report\'s detail rows are visible (not collapsed), then retry.');
        else console.log('    Open your LIST VIEW or REPORT so rows are visible, then retry. (Reports are auto-detected.)');
        console.log('');
        await ask('\nPress Enter to close the browser... ');
        return;
      }

      // AUTO WORDING (autoDraft.js): only when Settings has Claude drafts on (and the mode does not pick its own wording). Each email is written from that account's Salesforce notes and
      // opportunities: no template menu, every draft is shown, one question, then only the email is sent. Off by default → template picker.
      const autoW = autoDraft.wordingFor(args, 'email');
      let autoCtx = null;
      if (autoW.on) {
        autoCtx = await autoDraft.startSession({ args, deps: autoDeps(), channels: ['email'], noAutoHint: true });
        if (!autoCtx) return;
        commandLog('✨', 'Auto wording', "each email is written from that account's Salesforce notes and opportunities (your Granola note first). Turn Claude drafts off in Settings to pick a template instead.");
      } else commandLog('ℹ️', 'Auto wording', `off — ${autoW.why}`);

      // Which email? Asked only when nothing already chose one (--email-template / --subject / --body-file / --sequence / --library) and someone is at the keyboard.
      if (args.blast && !args.emailTemplate && !args.subject && !args.bodyFile && !args.typedEmail && !args.yes && process.stdin.isTTY) {
        // --blast: type my own now / the one typed last time / a saved email (emailBlast.js); what is typed is kept, so --last-typed can send it again
        if (!(await require('./emailBlast').chooseEmail({ args, ask, menu: emailTemplateMenu().filter((m) => !m.typed), emailTemplateKey: (v) => emailTemplateKey(v, { noTyped: true }), signature: EMAIL_SIGNATURE, render: emailPersonalize.render }))) { commandLog('🛑', 'Mission aborted', 'No emails sent'); return; }
      } else if (!args.blast && !args.emailTemplate && !args.subject && !args.bodyFile && !args.sequence && !args.library && !autoCtx && !args.yes && process.stdin.isTTY) {
        const menu = emailTemplateMenu();
        if (menu.length > 1) {
          console.log('\n  ✉️  Which email?');
          menu.forEach((m) => console.log(m.typed ? `     ${m.n}. ${m.name}\n        you type the subject and the email; the greeting, the layout and your signature are added for you` : `     ${m.n}. ${m.name}\n        "${m.subject}"`));
          const pick = (await ask(`\n  Pick 1-${menu.length} [1]: `)).trim();
          try { args.emailTemplate = emailKeyFromMenuPick(menu, pick); } catch (e) { console.log(`\n  ${e.message}\n`); return; }     // Enter = the first choice in the menu; 'built-in' = the re-engagement email picked on purpose
          if (args.emailTemplate === TYPE_YOUR_OWN) {      // "Type your own subject line & email": the subject and the words are typed here; emailBlast.formatTyped adds the greeting, tidies the layout and adds the signature
            args.emailTemplate = '';
            const typed = await require('./emailBlast').typeEmail({ signature: EMAIL_SIGNATURE, render: emailPersonalize.render, autoFormat: true });
            if (!typed) { commandLog('🛑', 'Mission aborted', 'Nothing typed: no emails sent'); return; }
            args.typedEmail = { subject: typed.subject, body: typed.body };
            console.log(`\n  ✅ Got it.${typed.greeted && typed.signed ? ' A greeting was added at the top and your signature at the bottom.' : typed.greeted ? ' A greeting was added at the top.' : typed.signed ? ' Your signature was added at the bottom.' : ''} The preview below shows the email exactly as it will go.\n`);
          }
        }
      }
      const { subject, body } = autoCtx ? { subject: '', body: '' } : resolveEmailContent(args);

      // Range (which harvested accounts to email)
      let parsed = null;
      let range = args.range;
      // Skip list: names from --skip, plus any "skip <name>[, <name>]" typed at the prompt
      // below (type as many skip lines as you like, then the range). "unskip <name>" undoes one.
      const skipTerms = [...args.skip];
      const reportSkips = () => {
        const r = resolveSkips(leads, skipTerms);
        r.applied.forEach((a) => console.log(`  ⏭️  Will skip row ${a.row}: ${a.name}`));
        r.none.forEach((t) => console.log(`  ⚠️  No account matches "${t}" — nothing skipped for it`));
        r.ambiguous.forEach((a) => {
          console.log(`  ⚠️  "${a.term}" matches ${a.rows.length} accounts — NOT skipped. Be more specific:`);
          a.rows.slice(0, 8).forEach((h) => console.log(`        row ${h.row}: ${h.name}`));
        });
        return r;
      };
      if (skipTerms.length) reportSkips();
      else if (!args.yes) {
        // No --skip given: ask up front. Enter = none. Re-asks while a name is unmatched or
        // ambiguous so a typo can't silently let a do-not-email account through.
        let answer = await ask('\nAny accounts to SKIP? (names, comma-separated — or press Enter for none) ');
        while (answer) {
          const before = skipTerms.length;
          skipTerms.push(...answer.split(',').filter((s) => s.trim()));
          const r = reportSkips();
          if (!r.none.length && !r.ambiguous.length) break;
          skipTerms.length = before; // drop this round's terms so the retry starts clean
          answer = await ask('  Re-enter the skip names (or press Enter for none) ');
        }
      }
      while (true) {
      parsed = null;
      while (!parsed) {
        if (!range) range = await ask(`\nWhich accounts to email? (e.g. 1-25, all; or "skip ADN Doors") [of ${leads.length}] `);
        const sk = String(range).match(/^(un)?skip\s+(.+)$/i);
        if (sk) {
          const terms = sk[2].split(',').filter((s) => s.trim());
          if (sk[1]) { terms.forEach((t) => { const i = skipTerms.findIndex((x) => x.trim().toLowerCase() === t.trim().toLowerCase()); if (i >= 0) skipTerms.splice(i, 1); }); }
          else skipTerms.push(...terms);
          reportSkips();
          range = null;
          continue;
        }
        try { parsed = parseRange(range); } catch (e) { console.log('  ' + e.message); range = null; }
      }
      const skipRes = resolveSkips(leads, skipTerms);
      const lastRow = Math.min(parsed.end || leads.length, leads.length);
      const skippedInRange = [...skipRes.positions].filter((p) => p >= parsed.start && p <= lastRow).length;
      const count = lastRow - parsed.start + 1 - skippedInRange;

      // Preview the exact email + range before anything is sent.
      const bodyLines = body.split('\n');
      console.log(`\n${'─'.repeat(64)}`);
      console.log(args.dryRun ? '🧪 EMAIL DRY-RUN (composer filled, NOT sent)' : '✉️  EMAIL — LIVE SEND to real customers');
      console.log('─'.repeat(64));
      console.log(`  Accounts    : ${parsed.start}-${parsed.end || leads.length} of ${leads.length}  (${count} to process${skippedInRange ? `, ${skippedInRange} on skip list` : ''})`);
      skipRes.applied.filter((a) => a.row >= parsed.start && a.row <= lastRow).forEach((a) => console.log(`  Skipping    : row ${a.row} — ${a.name}`));
      if (args.sequence) {
        const tally = {}; let holds = {};
        leads.slice(parsed.start - 1, lastRow).forEach((l) => { const t = emailSequence.nextTouch(l.accountId, { minDays: args.days }); if (t.hold) holds[t.hold.replace(/[\d.]+ days ago/, 'N days ago')] = (holds[t.hold.replace(/[\d.]+ days ago/, 'N days ago')] || 0) + 1; else tally[t.step] = (tally[t.step] || 0) + 1; });
        console.log(`  Sequence    : 🔁 each account gets its NEXT touch (min ${args.days} days apart)`);
        Object.entries(tally).forEach(([st, n]) => console.log(`                ${n} → touch ${st} (${emailSequence.STEPS[st - 1].name})`));
        Object.entries(holds).forEach(([why, n]) => console.log(`                ${n} held — ${why}`));
      }
      if (args.library) {
        console.log(`  Content     : 📚 library — a trade-matched, linked email per account (${args.postdemo ? 'post-demo' : 'demo'} stage). Samples:`);
        leads.slice(parsed.start - 1, parsed.start + 2).forEach((l) => {
          try { const e = contentPicker.buildEmail(l.name, { stage: args.postdemo ? 'postdemo' : 'demo' }); console.log(`    • ${l.name}: ${e.subject}  [${e.picked.label || 'generic'}: ${e.picked.assets.map((a) => a.id).join(', ')}]`); }
          catch (err) { console.log(`    • ${l.name}: ⚠️ ${err.message}`); }
        });
      } else if (args.sequence) {
        // The cadence builds each account's email itself (greeting, feature, linked story), so show THOSE — not the old default template.
        const firstByStep = new Map();
        leads.slice(parsed.start - 1, lastRow).forEach((l) => { const t = emailSequence.nextTouch(l.accountId, { minDays: args.days }); if (!t.hold && !firstByStep.has(t.step)) firstByStep.set(t.step, l); });
        console.log('\n  Emails going out — one sample per touch (each account gets its own greeting and, where we have one, its own trade story):');
        for (const [step, l] of [...firstByStep].sort((a, b) => a[0] - b[0])) {
          try {
            const e = emailSequence.buildTouch(l.name, step, { stage: args.postdemo ? 'postdemo' : 'demo' });
            console.log(`\n  ── Touch ${step}: ${e.name}   (sample: ${l.name})`);
            console.log(`     Subject: ${e.subject}`);
            console.log(e.bodyText.replace('[Your name]', sender.apply('Luke')).split('\n').map((x) => '     ' + x.replace(/ \((https?:\/\/[^/)]+)[^)]*\)/, ' 🔗 [link → $1]')).join('\n'));
            console.log(`     📎 hyperlinked: "${e.asset.title}" (${e.asset.id})`);
          } catch (err) { console.log(`\n  ── Touch ${step}: ⚠️ ${err.message}`); }
        }
      } else if (autoCtx) {
      console.log("  Wording     : ✨ auto — each email is written from that account's Salesforce notes and opportunities, and shown to you before anything is sent");
      } else {
      console.log(`  Subject     : ${subject}`);
      console.log('  Body preview:\n');
      console.log(bodyLines.slice(0, 14).map((l) => '    ' + l).join('\n'));
      if (bodyLines.length > 14) console.log('    …');
      }
      console.log('');

      if (!autoCtx && !args.dryRun && !args.yes) {
        const ok = (await ask(`  ▶️  Send this email LIVE to ${count} account(s)? (y/N) `)).toLowerCase();
        if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'No emails sent'); return; }
      }

      if (autoCtx) {
        // This batch's accounts that are not on the skip list: written for, shown, confirmed and sent by autoDraft.js (through the same campaign loop, with each account's own subject and body).
        const picked = leads.slice(parsed.start - 1, lastRow).filter((l, i) => !skipRes.positions.has(parsed.start + i));
        const r = await autoDraft.draftAndSend(page, picked, autoCtx, 'email', { leadSource: leads.source || null, maxPerRun: args.maxSet ? args.max : null });
        if (r.outcome === 'aborted') return;
      } else {
      await runEmailCampaign(page, leads, {
        subject, body, ...parsed, delayMs: args.delayMs, dryRun: args.dryRun, skipPositions: skipRes.positions,
        maxPerRun: args.maxSet ? args.max : null, library: args.library, sequence: args.sequence, minDays: args.days, contentStage: args.postdemo ? 'postdemo' : 'demo',
        templateName: args.typedEmail ? (args.blast ? 'Email blast (typed)' : 'Email typed by hand') : args.sequence ? 'Email sequence' : args.library ? 'Email library content' : (args.subject || args.bodyFile) ? 'Email custom' : emailTemplateKey(args.emailTemplate) ? namedEmailTemplate(emailTemplateKey(args.emailTemplate)).name : EMAIL_TEMPLATE.name,
        logMode: args.blast ? 'blast' : null,      // --blast: its emails are logged with mode 'blast', which the follow-up board never counts (cadence.js, emailSequence.js)
        // Daily-email guard stays ON for all sources: these emails do NOT log to the
        // Salesforce timeline (recipient isn't a matched Contact), so reports can't
        // filter already-emailed leads — our durable log is the only dedup. --force
        // still fully bypasses if you explicitly want that.
        force: args.force,
      });
      }

      // Scan once, send in batches: if accounts remain past this batch, offer the next one.
      const nextStart = lastRow + 1;
      if (args.yes || args.dryRun || nextStart > leads.length) break;
      const remaining = leads.length - nextStart + 1;
      const more = (await ask(`\n➡️  ${remaining} account(s) left (${nextStart}-${leads.length}). Email how many next? (a number, "all", or press Enter to finish) `)).trim().toLowerCase();
      if (!more) break;
      if (more === 'all') range = `${nextStart}-${leads.length}`;
      else if (/^\d+$/.test(more) && +more > 0) range = `${nextStart}-${Math.min(leads.length, nextStart + +more - 1)}`;
      else if (/^\d+\s*-\s*\d+$/.test(more) || /^(un)?skip\s/.test(more)) range = more;
      else { console.log('  Not a number — finishing.'); break; }
      }
      await ask('\nPress Enter to close the browser... ');
      return;
    }

    // --save: snapshot the open report (or list) into the durable text queue so the
    // leads can be texted later — even after emailing them drops them off the report.
    if (args.save) {
      const page = await resolveView(context, initialPage);
      // Wait for the report iframe to register before deciding (see --email note).
      let frame = reportFrame(page);
      for (let i = 0; i < 6 && !frame; i++) { await sleep(1000); frame = reportFrame(page); }
      const onReport = !!frame;
      commandLog('📇', 'Snapshot', `Scanning ${onReport ? 'report' : 'list view'} to save…`);
      const leads = onReport ? await harvestReportLeads(page) : await harvestListLeads(page);
      commandLog('📬', 'Leads found', `${leads.length}${harvestSummary(leads)}`);
      warnShortHarvest(leads);
      if (!leads.length) {
        console.log(`\n⚠️  No leads found to save. Make sure the ${onReport ? 'report' : 'list'} rows are visible, then retry.\n`);
        await ask('\nPress Enter to close the browser... ');
        return;
      }
      // Don't queue anyone we've already texted (durable texted-log).
      const alreadyTexted = new Set(textLog.readAll().map((r) => r.accountId).filter(Boolean));
      const res = textQueue.addLeads(leads, { alreadyTexted, source: leads.source });
      console.log(`\n  🗂️  Saved to text queue: +${res.added} new (skipped ${res.dupQueue} already queued, ${res.dupTexted} already texted${res.noId ? `, ${res.noId} no-id` : ''}).`);
      console.log(`      Queue now holds ${res.pending} pending lead(s). Text them later with:  email --queue\n`);
      await ask('\nPress Enter to close the browser... ');
      return;
    }

    // --queue: text leads saved earlier with --save, straight from the durable queue.
    // (--queue --inspect is handled earlier, before the browser launches.)
    if (args.queue) {
      const pending = textQueue.pendingLeads();
      if (!pending.length) {
        console.log('\n  🗂️  Text queue is empty. Snapshot a report first:  email --save\n');
        return;
      }

      // --send: stay running and text each queued pro as their own window opens (instead of one pass now)
      if (args.send) {
        if (args.tomorrow) { await runOvernight(await resolveAuthedPage(context, initialPage)); return; }
        const m = await pickSendMessage(args);
        if (!m) return;
        const page = await resolveAuthedPage(context, initialPage);
        await runQueueDay(page, { ...m, delayMs: args.delayMs, unknownZone: args.unknownZone, until: args.until, yes: args.yes });
        return;
      }

      // Hours: only pros whose OWN window (8:00–20:00 their time, Mon–Sat) is open right now are texted; the rest stay in the queue for later.
      const hoursUnknown = args.unknownZone;
      const hours = partitionByHours(pending, { unknownZone: hoursUnknown });
      printHoursPlan(hours);
      if (!hours.open.length) { console.log('\n  ⏰ Nobody in the queue is inside their texting hours right now. They all stay in the queue: run it again when their zone opens.\n'); return; }
      const ready = hours.open;

      // Pick the message (--template / --message, or interactive).
      let message = args.message;
      let templateId = args.template;
      if (!message) {
        if (templateId && TEMPLATES[templateId]) message = TEMPLATES[templateId].text;
        else {
          listTemplates();
          const choice = await ask('\nPick a template number, or type your own message: ');
          if (TEMPLATES[choice]) { message = TEMPLATES[choice].text; templateId = choice; }
          else { message = choice; templateId = null; }
        }
      }
      if (!message) { console.log('Message is required.'); return; }

      // Range over the pending queue.
      let parsed = null;
      let range = args.range;
      while (!parsed) {
        if (!range) range = await ask(`\nWhich of the ${ready.length} queued leads that are open now to text? (e.g. 1-25, all) `);
        try { parsed = parseRange(range); } catch (e) { console.log('  ' + e.message); range = null; }
      }

      const page = await resolveAuthedPage(context, initialPage);
      const historyTemplateName = templateId ? TEMPLATES[templateId].name : 'Custom message';
      const historyTemplateKey = createTemplateKey('text', historyTemplateName, message);

      if (!args.yes) {
        const n = Math.max(0, Math.min(parsed.end || ready.length, ready.length) - parsed.start + 1);
        const ok = (await ask(`\n  ▶️  Text ${n} queued lead(s) that are inside their hours now with "${historyTemplateName}"? (y/N) `)).toLowerCase();
        if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'No texts sent'); await ask('\nPress Enter to close the browser... '); return; }
      }

      await runReportCampaign(page, {
        message, ...parsed, delayMs: args.delayMs,
        templateName: historyTemplateName, templateKey: historyTemplateKey,
        leads: ready, onSent: (l) => textQueue.markTexted(l.accountId),
        force: args.force,
        tcpa: true, tcpaUnknown: hoursUnknown,        // each pro is checked again just before the text (a window can close during a long run)
      });
      await ask('\nPress Enter to close the browser... ');
      return;
    }

    // --oppy: text off an OPPORTUNITIES LIST VIEW. Harvests every account up front
    // (scrolling the list grid), then texts each by URL via the report-campaign path —
    // so it gets the once-per-day guard, contact guard, and outreach-dashboard logging.
    if (args.oppy) {
      const page = await resolveListViewPage(context, initialPage);

      // Pick the message first.
      let message = args.message;
      let templateId = args.template;
      if (!message) {
        if (templateId && TEMPLATES[templateId]) message = TEMPLATES[templateId].text;
        else {
          listTemplates();
          const choice = await ask('\nPick a template number, or type your own message: ');
          if (TEMPLATES[choice]) { message = TEMPLATES[choice].text; templateId = choice; }
          else { message = choice; templateId = null; }
        }
      }
      if (!message) { console.log('Message is required.'); return; }

      // Pick the range BEFORE harvesting. On a big list (SF loads up to 2000 rows) we
      // only scan up to the END of the requested range — never the whole list.
      let parsed = null;
      let range = args.range;
      while (!parsed) {
        if (!range) range = await ask('\nWhich rows to text? (e.g. 1-100).  "all" scans the whole loaded list — avoid on large lists. ');
        try { parsed = parseRange(range); } catch (e) { console.log('  ' + e.message); range = null; }
      }

      if (parsed.end == null) commandLog('⚠️', 'Full scan', 'Range is "all" — scanning the entire report. Prefer a range like 1-100.');
      commandLog('📇', 'Harvest', `Scanning the report${parsed.end ? ` for accounts (will take the first ${parsed.end})` : ' (all)'}…`);
      let leads = await harvestReportLeads(page);
      if (parsed.end) leads = leads.slice(0, parsed.end);
      commandLog('📬', 'Accounts harvested', `${leads.length} account(s) detected`);

      if (args.inspect) {
        console.log(`\nAccounts harvested (rows up to ${parsed.end || 'end'}): ${leads.length}\n`);
        leads.slice(0, 15).forEach((l, i) => { console.log(`  ${String(i + 1).padStart(3)}. ${l.name}`); console.log(`       ${l.url || '(no account link)'}`); });
        if (leads.length > 15) console.log(`  ... and ${leads.length - 15} more`);
        console.log('');
        await ask('\nPress Enter to close the browser... ');
        return;
      }
      if (!leads.length) {
        console.log('\n⚠️  No accounts harvested. Make sure the list view rows are visible (and start at the top), then retry.\n');
        await ask('\nPress Enter to close the browser... ');
        return;
      }

      const historyTemplateName = templateId ? TEMPLATES[templateId].name : 'Custom message';
      const historyTemplateKey = createTemplateKey('text', historyTemplateName, message);
      if (!args.yes) {
        const n = Math.min(parsed.end || leads.length, leads.length) - parsed.start + 1;
        const ok = (await ask(`\n  ▶️  Text ${n} account(s) with "${historyTemplateName}"? (y/N) `)).toLowerCase();
        if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'No texts sent'); await ask('\nPress Enter to close the browser... '); return; }
      }

      await runReportCampaign(page, {
        message, ...parsed, delayMs: args.delayMs,
        templateName: historyTemplateName, templateKey: historyTemplateKey,
        leads,
        force: args.force,
      });
      await ask('\nPress Enter to close the browser... ');
      return;
    }

    if (args.inspect) {
      const page = await resolveView(context, initialPage);
      await (isReport ? inspectReport(page) : inspect(page));
      await ask('\nPress Enter to close the browser... ');
      return;
    }

    // AUTO WORDING (autoDraft.js): off by default (templates). When Claude drafts are on in Settings, each text is written from the account's notes.
    // This copy works from a report, so template mode is the normal path; Claude drafts can still be turned on.
    const autoText = autoDraft.wordingFor(args, 'text', { isReport: false });
    if (autoText.on) {
      await autoDraft.runAutoText({
        context, initialPage, args,
        io: {
          ask, parseRange, resolveView,
          harvestListLeads: async (page, opts = {}) => {
            let leads = await harvestReportLeads(page);
            if (opts.limit) leads = leads.slice(0, opts.limit);
            leads.rowsSeen = leads.length;
            leads.listTotal = leads.length;
            leads.stopped = 'complete';
            return leads;
          },
          harvestSummary: (leads) => ` from ${leads.length} report row${leads.length === 1 ? '' : 's'}`,
          warnShortHarvest: () => {},
          deps: autoDeps(),
        },
      });
      return;
    }
    commandLog('ℹ️', 'Auto wording', `off — ${autoText.why}`);

    // Get message — from template, --message flag, or interactive prompt
    let message = args.message;
    let selectedTemplateId = args.template;

    // Main campaign loop — keeps going until user quits
    while (true) {
      // Pick template if not already set
      if (!message) {
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║          📋 TEXT CAMPAIGN PANEL          ║');
        console.log('╚═══════════════════════════════════════════╝\n');
        listTemplates();
        const choice = await ask('\nPick a template number, or type your own message: ');
        if (TEMPLATES[choice]) {
          message = TEMPLATES[choice].text;
          selectedTemplateId = choice;
          console.log(`\n  ✅ Selected: [${choice}] ${TEMPLATES[choice].name}`);
        } else {
          message = choice;
          selectedTemplateId = null;
        }
        if (!message) { console.log('Message is required.'); return; }
      }

      // Get range
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║          🔢 SELECT CAMPAIGN RANGE         ║');
      console.log('╚═══════════════════════════════════════════╝');
      if (selectedTemplateId) {
        console.log(`  Template: [${selectedTemplateId}] ${TEMPLATES[selectedTemplateId].name}`);
      } else {
        console.log(`  Custom message: ${message.substring(0, 50)}...`);
      }

      let range = args.range;
      let parsed = null;
      while (!parsed) {
        if (!range) range = await ask('\nWhich rows to text? (e.g. 1-10, all) ');
        try { parsed = parseRange(range); }
        catch (e) { console.log('  ' + e.message); range = null; }
      }
      console.log(`  Range: ${parsed.start}-${parsed.end || 'end'}`);

      // Let user get to the view (only first time)
      if (!page) {
        var page = await resolveView(context, initialPage);
        commandLog('🔗', `Salesforce ${isReport ? 'report' : 'grid'}`, page.url());
      }

      // Confirm
      if (!args.yes) {
        const ok = (await ask(`\n  ▶️  Start campaign ${parsed.start}-${parsed.end || 'end'}?${isReport ? ' (only pros inside their own hours are texted; the rest are left for later)' : ''} (y/N) `)).toLowerCase();
        if (ok !== 'y' && ok !== 'yes') {
          commandLog('🛑', 'Mission aborted', 'No texts sent');
          message = null; // reset so user can pick again
          continue;
        }
      }

      // Run campaign
      const historyTemplateName = selectedTemplateId
        ? TEMPLATES[selectedTemplateId].name
        : 'Custom message';
      const historyTemplateKey = createTemplateKey('text', historyTemplateName, message);
      const campaignOpts = {
        message,
        ...parsed,
        delayMs: args.delayMs,
        templateName: historyTemplateName,
        templateKey: historyTemplateKey,
        ignoreSms: args.ignoreSms, // --ignore-sms disables the report 48h SMS skip
        force: args.force,         // --force/--no-guards disables ALL texting guards
        ...(isReport ? { tcpa: true, tcpaFilter: true, tcpaUnknown: args.unknownZone } : {}),   // report texts: only pros inside their own hours
      };
      await (isReport ? runReportCampaign(page, campaignOpts) : runTextCampaign(page, campaignOpts));

      // Control panel after campaign completes
      console.log('\n╔═══════════════════════════════════════════════════════╗');
      console.log('║              ✅ CAMPAIGN COMPLETE                     ║');
      console.log('╠═══════════════════════════════════════════════════════╣');
      if (selectedTemplateId) {
        console.log(`║  Template: [${selectedTemplateId}] ${TEMPLATES[selectedTemplateId].name.padEnd(35)}║`);
      } else {
        console.log(`║  Custom message${' '.repeat(42)}║`);
      }
      console.log(`║  Range: ${parsed.start}-${parsed.end || 'end'}${' '.repeat(45 - String(parsed.start + '-' + (parsed.end || 'end')).length)}║`);
      console.log('╠═══════════════════════════════════════════════════════╣');
      console.log('║  Options:                                             ║');
      console.log('║    [1] New template + new range                       ║');
      console.log('║    [2] Same template, new range                       ║');
      console.log(`║    [3] New ${isReport ? 'report' : 'list view'}, then new campaign${' '.repeat(isReport ? 16 : 13)}║`);
      console.log('║    [q] Quit                                           ║');
      console.log('╚═══════════════════════════════════════════════════════╝');

      const action = await ask('\n  What next? ');

      if (action === 'q' || action === 'quit' || action === 'exit') {
        console.log('\n  👋 All done. Closing browser...');
        break;
      } else if (action === '1') {
        // New template + new range
        message = null;
        selectedTemplateId = null;
        args.range = null;
        continue;
      } else if (action === '2') {
        // Same template, new range
        args.range = null;
        continue;
      } else if (action === '3') {
        // New view
        console.log(`\n  📂 Open your new Salesforce ${viewLabel} in the browser...`);
        var page = await resolveView(context, initialPage);
        commandLog('🔗', `Salesforce ${isReport ? 'report' : 'grid'}`, page.url());
        message = null;
        selectedTemplateId = null;
        args.range = null;
        continue;
      } else {
        // Try to parse as a range (quick next batch)
        try {
          parsed = parseRange(action);
          continue;
        } catch (e) {
          console.log('  ' + e.message);
          message = null;
          selectedTemplateId = null;
          continue;
        }
      }
    }
  } finally {
    await cleanup();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
}

module.exports = {
  // report source tagging (LDS / Shark) + morning snapshot
  detectReportSource,
  runSnapshot,
  runHolds,
  emailTemplateMenu, emailTemplateKey, resolveEmailContent, parseArgs,
  snapshotLeads,
  REPORT_MODES,
  // --harvest (quick report scan)
  runReportHarvest,
  reportColumns,
  // first-touch hours (--queue / --report) and the hands-off day (--send)
  partitionByHours,
  printHoursPlan,
  runQueueDay,
  openingsToday,
  parseUntil,
  pickSendMessage,
  // --industry
  runIndustry,
  industryPlan,
  printIndustryPlan,
  // --followup
  runFollowup,
  ensureZone,
  reviewCandidates,
  pickFollowupText,
  FOLLOWUP_TEXT,
  followupSequence,
  accountAlreadyOpen,
  typeMessage,
  printFollowupPlan,
  followupOptions,
  sameDayProblem,
  // --auto
  runAuto,
  openReportAndHarvest,
  // List-view (default) mode
  runTextCampaign,
  resolveListViewPage,
  inspect,
  // Report mode (--report)
  runReportCampaign,
  resolveReportPage,
  inspectReport,
  harvestReportLeads,
  reportFrame,
  REPORT_CONFIG,
  parseReportDateTime,
  // Email mode (--email)
  runEmailCampaign,
  prepareCadenceLeads,
  prepareNeverEmailedLeads,
  harvestListLeads,
  resolveEmailContent,
  EMAIL_TEMPLATE,
  // Texted dashboard (--sent)
  scrapeAccountEmail,
  // Shared
  launchBrowser,
  textAccount,
  runThreadGuard,
  findComposeLandmarks,
  ensureTextsPanel,
  openTextsFast,
  revealComposer,
  TEMPLATES,
  isRequestedRangeComplete,
  CONFIG,
};
