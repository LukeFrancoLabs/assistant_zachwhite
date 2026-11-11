'use strict';

/**
 * accountOpportunities — an account's opportunities read off the ACCOUNT PAGE itself, READ-ONLY.
 *
 * The account page has an "Opportunities (2)" card in its left column: one tile per opportunity, its name as a link and "Close Date:", "Products Text:", "Stage:" under it. The board's check right
 * before a text reads that card, so it needs no trip to the Opportunities tab (a page load of its own, and another one back to the account for the text). It returns what
 * salesforceReview.readOpportunities() returns, { ok, opps: [{ name, stage, closeDate, owner, id }], note }, so salesforceReview.reviewAccount() takes it as `deps.readOpportunities`.
 *
 * The card is trusted only when it is COMPLETE: its title's count equals the tiles found (and is not "6+"), and every tile gave a Stage and a Close Date that parses (salesforceReview.decide() cannot
 * tell a recent Closed Won from one whose date it cannot read). Anything else (no card on that layout, still rendering, more rows than it shows) reads the Opportunities tab instead, as before.
 * The real markup could only be checked against screenshots, so makeReader() proves itself on the real page at the start of every run: its first `calibrate` card reads are also read from the tab,
 * and if the two ever disagree the run reads the tab from then on and says so.
 *
 *   node accountOpportunities.js [accountId|link …] [--port N] [--profile DIR] [--headless]
 *       the real-page check, read-only: opens its OWN Chrome window with the board's profile (so its Salesforce login), loads two accounts we have screenshots of (or the ones you name), reads each account's
 *       opportunities from the card AND from the Opportunities tab and says whether they agree. Refuses to open a window while the board's Chrome (port 9336) is up; --port N uses a Chrome that is already up instead.
 *       Run it from anywhere:  node ~/Assistant/accountOpportunities.js
 */

const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLOSED_WON_RE = /closed[\s_/-]*won/i;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Runs IN THE PAGE (page.evaluate: nothing from outside is visible here). The "Opportunities (n)" heading(s), and for each the opportunity tiles under it, through shadow roots. */
function scanCard() {
  const clean = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const parentOf = (e) => e.parentElement || (e.getRootNode && e.getRootNode().host) || null;      // up, through shadow roots
  const titleRe = /^Opportunities\s*\(\s*(\d+)\s*(\+?)\s*\)$/i;
  const OPP = 'a[href*="/lightning/r/Opportunity/"]';
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const deep = (root, sel, out = []) => { root.querySelectorAll(sel).forEach((e) => out.push(e)); root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) deep(e.shadowRoot, sel, out); }); return out; };
  const textOf = (e) => String(e.innerText || e.textContent || '');
  const heads = [];
  const scan = (root) => root.querySelectorAll('*').forEach((e) => {
    if (e.shadowRoot) scan(e.shadowRoot);
    for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !/^\s*Opportunities(\s*\(\s*\d+\s*\+?\s*\))?\s*$/i.test(n.nodeValue || '')) continue;      // "Opportunities" on its own (the count in a span next to it) or the whole "Opportunities (2)"
      for (let x = e, i = 0; x && i < 4; x = parentOf(x), i++) {                                  // up to the element whose whole text is "Opportunities (n)"
        const m = clean(x.textContent).match(titleRe);
        if (m) { if (!heads.some((h) => h.el === x) && shown(x)) heads.push({ el: x, count: parseInt(m[1], 10), plus: !!m[2] }); break; }
      }
    }
  });
  scan(document);
  return {
    cards: heads.map((h) => {
      let box = null;                                                                              // the card: the first ancestor of the heading that holds opportunity links
      if (h.count > 0) for (let x = parentOf(h.el), i = 0; x && i < 14; x = parentOf(x), i++) if (deep(x, OPP).length) { box = x; break; }
      const links = box ? deep(box, OPP) : [];
      return {
        count: h.count, plus: h.plus, linkCount: links.length,
        tiles: links.map((a) => {                                                                  // a tile: the first ancestor of the link that shows a "Stage:" line
          let t = a;
          for (let hops = 0; t && t !== box && hops < 8; t = parentOf(t), hops++) if (/\bStage\s*:/i.test(textOf(t))) break;
          return { name: clean(a.textContent), href: a.getAttribute('href') || '', text: t ? textOf(t) : '', links: t ? deep(t, OPP).length : 0 };
        }),
      };
    }),
  };
}

const LABEL_LINE = /^[A-Za-z][A-Za-z ]{0,30}:$/;      // "Close Date:" (a value such as "Basecamp+ :" is not one)
/** The value of `label` in a tile's text: on the same line ("Stage: Closed Lost"), else on the next one. '' when there is none. */
function field(text, label) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/ /g, ' ').trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${label}\\s*:\\s*(.*)$`, 'i'));
    if (!m) continue;
    const v = (m[1] || lines[i + 1] || '').trim();
    return LABEL_LINE.test(v) ? '' : v;
  }
  return '';
}

/** What scanCard() found → { found, complete, opps, why }. `complete` = every opportunity of the account is in `opps`, with a stage and a close date that parses. */
function interpret(scan) {
  const cards = (scan && scan.cards) || [];
  const no = (why, found = true) => ({ found, complete: false, opps: [], why });
  if (!cards.length) return no('no "Opportunities (n)" card on the account page', false);
  if (cards.length > 1) return no(`${cards.length} "Opportunities" cards on the account page`);
  const c = cards[0];
  if (c.plus) return no(`the card says "${c.count}+": it shows fewer than the account has`);
  if (c.count === 0) return { found: true, complete: true, opps: [], why: '' };
  if (c.linkCount !== c.count || c.tiles.length !== c.count) return no(`the card says ${c.count} but shows ${c.linkCount}`);
  const opps = [];
  for (const t of c.tiles) {
    if (t.links !== 1) return no('an opportunity tile could not be told apart from the next one');
    const stage = field(t.text, 'Stage'), closeDate = field(t.text, 'Close Date');
    if (!stage) return no(`no Stage on the tile of "${t.name}"`);
    if (!Number.isFinite(Date.parse(closeDate))) return no(`no readable Close Date on the tile of "${t.name}"`);
    if (CLOSED_WON_RE.test(t.text) && !CLOSED_WON_RE.test(stage)) return no(`the tile of "${t.name}" mentions Closed Won but its Stage line does not`);
    opps.push({ name: t.name, stage, closeDate, owner: '', id: ((t.href.match(/\/Opportunity\/([A-Za-z0-9]{15,18})/) || [])[1]) || '' });
  }
  return { found: true, complete: true, opps, why: '' };
}

/** Read the card of the account page that is open (a card that is still rendering is given a few more tries). → interpret()'s result */
async function readCard(page, { tries = 3, wait = 800, sleep: slp = sleep } = {}) {
  let last = { found: false, complete: false, opps: [], why: 'the account page could not be read' };
  for (let i = 0; i < tries; i++) {
    try { last = interpret(await page.evaluate(scanCard)); } catch (_) { last = { found: false, complete: false, opps: [], why: 'the account page could not be read' }; }
    if (last.complete || i === tries - 1) break;
    await slp(wait);
  }
  return last;
}

const dayKey = (d) => {      // a calendar day as text: "11/28/2024" and "2024-11-28" are the same day, whatever the time zone of this Mac
  const s = norm(d), us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/), iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (us) return `${us[3].length === 2 ? 2000 + Number(us[3]) : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : s.toLowerCase();
};
const oppKey = (o) => `${norm(o.name).toLowerCase()}|${norm(o.stage).toLowerCase()}|${dayKey(o.closeDate)}`;
/** The same opportunities (name, stage, close day), in any order? */
function sameOpps(a, b) {
  const x = (a || []).map(oppKey).sort(), y = (b || []).map(oppKey).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/**
 * The reader for one run: `(page, accountId) → { ok, opps, note, via }`, the shape of salesforceReview.readOpportunities. Card first; the Opportunities tab when the card is not usable, and
 * for the first `calibrate` accounts whose card WAS usable too, to compare (a disagreement switches the rest of the run to the tab). That tab read leaves the page on the tab: the caller goes back to the account.
 * deps = { log(icon, action, detail), sleep, calibrate, tab(page, accountId) → readOpportunities' result, card(page) → readCard's result }  (a test passes fakes)
 */
function makeReader(deps = {}) {
  const log = deps.log || (() => {});
  const calibrate = Number.isFinite(deps.calibrate) ? deps.calibrate : 3;
  const readTab = deps.tab || ((page, id) => require('./salesforceReview').readOpportunities(page, id));
  const readTheCard = deps.card || ((page) => readCard(page, { sleep: deps.sleep }));
  const said = new Set();
  let compared = 0, agreed = 0, distrust = false;
  return async function readOpportunities(page, accountId) {
    if (!distrust) {
      const c = await readTheCard(page);
      if (c.complete) {
        if (compared < calibrate) {
          compared++;
          const tab = await readTab(page, accountId);
          if (tab && tab.ok) {
            if (sameOpps(c.opps, tab.opps)) {
              agreed++;
              log('🔬', 'Opportunities', `check ${agreed}/${calibrate}: the account-page card and the Opportunities tab agree (${c.opps.length} opportunit${c.opps.length === 1 ? 'y' : 'ies'})${compared === calibrate ? ' — the card is used from here on' : ''}`);
            } else {
              distrust = true;
              log('⚠️', 'Opportunities', `the account-page card and the Opportunities tab DISAGREE (${c.opps.length} on the card, ${(tab.opps || []).length} on the tab); reading the Opportunities tab for the rest of this run`);
              return tab;
            }
          } else log('ℹ️', 'Opportunities', 'could not compare the card with the Opportunities tab on this account (the tab could not be read); using the card');
        }
        return { ok: true, opps: c.opps, note: '', via: 'account page' };
      }
      if (!said.has(c.why)) { said.add(c.why); log('ℹ️', 'Opportunities', `the account-page card is not usable (${c.why}): reading the Opportunities tab for accounts like this`); }
    }
    return readTab(page, accountId);
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The real-page check (node accountOpportunities.js …): card vs Opportunities tab, on accounts you can look at yourself
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const SF_BASE = 'https://housecallpro.lightning.force.com';
const SF_HOME = /^https:\/\/[^/]*lightning\.force\.com\/(lightning|one\/one\.app)(\/|$|[?#])/;
const SIGN_IN = /okta|login|saml|secur\/frontdoor/i;
const BOARD_PORT = 9336;
const SAMPLE_ACCOUNTS = ['0011N00001Hc2ryQAB', '001PD00000cwIZqYAM'];      // two accounts in the saved debug screenshots (2 opportunities, 1 opportunity)

/** Open one account in `page`, read its opportunities from the card AND from the Opportunities tab, and compare. → { id, card, tab, verdict: 'agree' | 'disagree' | 'card-unusable' | 'tab-unreadable' } */
async function verifyAccount(page, accountId, { base = SF_BASE, readTab, settleMs = 4500, sleep: slp = sleep } = {}) {
  const id = require('./sfId').fix(accountId);
  const tabRead = readTab || ((p, i) => require('./salesforceReview').readOpportunities(p, i));
  await page.goto(`${base}/lightning/r/Account/${id}/view`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await slp(settleMs);                                                        // Lightning renders after the load event: the board waits the same way before it reads
  const card = await readCard(page, { sleep: slp });
  let tab; try { tab = await tabRead(page, id); } catch (e) { tab = { ok: false, opps: [], note: e.message }; }
  const verdict = !card.complete ? 'card-unusable' : !tab || !tab.ok ? 'tab-unreadable' : sameOpps(card.opps, tab.opps) ? 'agree' : 'disagree';
  return { id, card, tab, verdict };
}

const NOUN = (n) => `${n} opportunit${n === 1 ? 'y' : 'ies'}`;
const oneLine = (o) => `${o.name} | ${o.stage} | ${o.closeDate}`;
/** The lines that show one verifyAccount() result. */
function describe(r) {
  const tabOk = !!(r.tab && r.tab.ok);
  const L = [`  ${{ agree: '✅', disagree: '❌' }[r.verdict] || '⚠️'} ${r.id}`];
  L.push(`     card: ${r.card.complete ? NOUN(r.card.opps.length) : `NOT usable: ${r.card.why}`}`);
  if (r.card.complete) r.card.opps.forEach((o) => L.push(`           · ${oneLine(o)}`));
  L.push(`     tab : ${tabOk ? NOUN(r.tab.opps.length) : `could not be read${r.tab && r.tab.note ? ` (${r.tab.note})` : ''}`}`);
  if (tabOk && r.verdict !== 'agree') r.tab.opps.forEach((o) => L.push(`           · ${oneLine(o)}`));
  L.push(`     ${{ agree: 'AGREE: the card shows exactly what the Opportunities tab shows', disagree: 'DISAGREE: the board would read the Opportunities tab for the rest of its run', 'card-unusable': 'the board would read the Opportunities tab for an account like this', 'tab-unreadable': 'not compared: the Opportunities tab could not be read' }[r.verdict]}`);
  return L;
}

const isPortUp = (port) => new Promise((resolve) => {
  const req = require('http').get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
});
const waitEnter = (q) => new Promise((resolve) => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, () => { rl.close(); resolve(); }); });

/**
 * The command line. argv = the arguments after the script; deps (tests): { chromium, readTab, out, boardUp(), waitEnter(question), isTTY, settleMs, sleep }. → the exit code: 0 = every account agreed, 1 = something did not, 2 = could not start.
 */
async function cli(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const taken = new Set(); ['--port', '--profile', '--base'].forEach((n) => { const i = argv.indexOf(n); if (i >= 0) { taken.add(i); taken.add(i + 1); } });
  const given = argv.filter((a, i) => !String(a).startsWith('--') && !taken.has(i));
  const ids = (given.length ? given : SAMPLE_ACCOUNTS).map((a) => (String(a).match(/\/Account\/([A-Za-z0-9]{15,18})/) || String(a).match(/^([A-Za-z0-9]{15,18})$/) || [])[1]);
  if (ids.some((x) => !x)) { out(`\n  Not an account id or account link: ${given.join(' ')}\n`); return 2; }
  const base = (opt('--base') || SF_BASE).replace(/\/$/, ''), custom = base !== SF_BASE;
  const signedIn = (u) => !SIGN_IN.test(u || '') && (custom ? String(u || '').startsWith(base) : SF_HOME.test(u || ''));
  const chromium = deps.chromium || require(path.join(__dirname, 'node_modules', 'playwright')).chromium;
  const settle = deps.settleMs === undefined ? 4500 : deps.settleMs;
  const port = opt('--port');
  let browser = null, context = null, page = null;
  out('');
  try {
    if (port) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (e) { out(`  No Chrome is listening on port ${port}. Leave out --port to open a window of its own.\n`); return 2; }
      context = browser.contexts()[0]; page = context.pages()[0] || await context.newPage();
      out(`  Using the Chrome that is already up on port ${port} (its first tab: a run that is using it would be disturbed)`);
    } else {
      if (await (deps.boardUp || (() => isPortUp(BOARD_PORT)))()) { out(`  The board's Chrome is up on port ${BOARD_PORT}, so a run may be going and its profile is in use: no second window was opened.\n  When no run is going, close that Chrome and run this again, or point it at a Chrome you know is idle:  --port ${BOARD_PORT}\n`); return 2; }
      const profile = opt('--profile') || path.join(__dirname, '.browser-profile-board');
      context = await chromium.launchPersistentContext(profile, { headless: argv.includes('--headless'), args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'], viewport: { width: 1920, height: 1080 } });
      page = context.pages()[0] || await context.newPage();
      out(`  Opened its own Chrome window with the board's profile (${path.basename(profile)}); it closes when the check ends`);
    }
    await page.goto(`${base}/lightning/r/Account/${ids[0]}/view`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await (deps.sleep || sleep)(Math.min(settle, 3000));
    if (!signedIn(page.url())) {
      out('  ⚠️  This window is not signed in to Salesforce.');
      if (!(deps.isTTY !== undefined ? deps.isTTY : process.stdin.isTTY)) { out('  Run it in a Terminal so it can wait for you to sign in, then again.\n'); return 2; }
      await (deps.waitEnter || waitEnter)('  Sign in to Salesforce in that window, then press Enter here... ');
    }
    const results = [];
    for (const id of ids) {
      const r = await verifyAccount(page, id, { base, readTab: deps.readTab, settleMs: settle, sleep: deps.sleep });
      results.push(r); out(''); describe(r).forEach((l) => out(l));
    }
    const agree = results.filter((r) => r.verdict === 'agree').length;
    out(`\n  ${agree === results.length ? '✅' : '⚠️ '} The card read the same opportunities as the Opportunities tab on ${agree} of ${results.length} account(s).${agree === results.length ? '' : ' Where they differ the board reads the tab (see above).'}\n`);
    return agree === results.length ? 0 : 1;
  } finally {
    try { if (context && !browser) await context.close(); else if (browser) await browser.close(); } catch (_) {}      // a launched window is closed; an attached Chrome is only disconnected
  }
}

module.exports = { scanCard, interpret, readCard, field, sameOpps, makeReader, verifyAccount, describe, cli, SAMPLE_ACCOUNTS };

if (require.main === module) cli(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error('\n  ERR', e.message, '\n'); process.exit(2); });
