'use strict';

/**
 * accountZone — find which US time zone(s) an Account is in, so texts can respect TCPA
 * hours per contact. READ-ONLY: opens the Account record page and reads its address
 * (Billing, else Shipping) and phone; sends nothing, changes nothing.
 *
 * The account's own Timezone field wins; State → time zone(s) comes from tcpa.js (split states list every zone they span, and the
 * texting gate then requires the window to be open in ALL of them). The state is read from
 * the labelled address fields; failing that, from a "City, ST 12345" pattern in the page text.
 * Results are cached in contact-zones.jsonl (see textLog.recordZone) so each account is read once.
 */

const tcpa = require('./tcpa');
const sfId = require('./sfId');
const sfReview = require('./salesforceReview');
const SF_HOST = 'housecallpro.lightning.force.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);

/** Pull a state out of free address text: "Tampa, FL 33602", "Austin, Texas 78701", "…, TX". */
function stateFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  let m = t.match(/,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  if (m && tcpa.normalizeState(m[1])) return tcpa.normalizeState(m[1]);
  m = t.match(/,\s*([A-Za-z][A-Za-z .]+?)\s+\d{5}(?:-\d{4})?\b/);
  if (m && tcpa.normalizeState(m[1])) return tcpa.normalizeState(m[1]);
  m = t.match(/,\s*([A-Z]{2})\b(?:,|\s|$)/);
  if (m && tcpa.normalizeState(m[1])) return tcpa.normalizeState(m[1]);
  return null;
}

/** Open the account page and read its address fields. → { ok, state, source, address, phone, fields } */
async function readLocation(page, accountId) {
  accountId = sfId.fix(accountId); // lowercased IDs are rejected by Salesforce as malformed
  try {
    await page.goto(`https://${SF_HOST}/lightning/r/Account/${accountId}/view`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { return { ok: false, note: `nav failed: ${e.message}` }; }
  await sleep(4500);
  const grab = () => sfReview.grabFields(page);   // shadow-aware label/value reader shared with the opportunity page
  let r = await grab();
  for (let i = 0; i < 4 && !Object.keys(r.fields).length; i++) { await sleep(1500); r = await grab(); }
  const f = r.fields;
  // The account's own "Timezone" field (highlights panel, e.g. "Eastern") — the account-level answer. The shadow-DOM field reader
  // misses that panel, so read it from the rendered text, scoped to the text before the first related list ("Contacts (n)").
  let zone = null, zoneRaw = null;
  const tzKey = Object.keys(f).find((k) => /^time\s*-?\s*zone$/i.test(k));
  if (tzKey) zoneRaw = f[tzKey];
  if (!zoneRaw) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    const head = String(body).split(/\nContacts\s*\n?\(\d+\)/)[0];
    const m = head.match(/(?:^|\n)\s*Time\s*-?\s*zone\s*\n+\s*([^\n]+)/i);
    if (m) zoneRaw = m[1].trim();
  }
  if (zoneRaw) zone = tcpa.parseZone(zoneRaw);
  const key = (re) => Object.keys(f).find((k) => re.test(k));
  const stateKey = key(/^(billing|mailing) state/i) || key(/^state/i);
  const addrKey = key(/^billing address/i) || key(/^address/i) || key(/^shipping address/i);
  const phoneKey = key(/^phone/i);
  let state = stateKey ? tcpa.normalizeState(f[stateKey]) : null;
  let source = state ? 'state field' : null;
  const address = addrKey ? f[addrKey] : null;
  if (!state && address) { state = stateFromText(address); if (state) source = 'address'; }
  if (!state) { const other = key(/^shipping address/i); if (other) { state = stateFromText(f[other]); if (state) source = 'shipping address'; } }
  return { ok: Object.keys(f).length > 0 || !!zoneRaw, zone, zoneRaw, state, source, address, phone: phoneKey ? f[phoneKey] : null, fields: f, note: (Object.keys(f).length || zoneRaw) ? '' : 'no fields read from the account page' };
}

/**
 * Read one account's page and cache what it says (`recordZone` appends to contact-zones.jsonl). → { loc, row, source }
 * A page that loaded but showed no zone and no state is cached as 'lookup: nothing found', so textLog.zoneTried leaves it alone for two weeks;
 * a page that did not load is not (the next run reads it again).
 */
async function readAndRecord(page, lead, { recordZone }) {
  const loc = await readLocation(page, lead.accountId);
  const source = loc.zone ? 'account Timezone field' : (loc.source || (loc.ok ? 'lookup: nothing found' : null));
  const row = recordZone({ accountId: lead.accountId, accountName: lead.name, state: loc.state, zones: loc.zone ? [loc.zone] : undefined, source, address: loc.address, phone: loc.phone });
  return { loc, row, source };
}

/**
 * Who `email --zones` reads, in order, each account once (ids compared on their first 15 characters, any case):
 *   first   the follow-up board's leads with no zone that the board would text FIRST: never contacted, on a Shark list or added by hand, inside the automatic window (cadence autoDays)
 *   board   the rest of the board with no zone: leads already in their cadence and inside that window, then the older ones and the LDS leads nobody started
 *   log     every other account in the texted log, the re-engage list first
 * Accounts that already have a zone are left out, and so are the ones whose address was read within `triedDays` and showed nothing (textLog.zoneTried); `refresh` keeps both.
 * deps: { textLog, cadence } = the modules (a test passes fakes). → { todo: [{ accountId, name, kind }], first, board, log, tried, note }
 */
function zoneTodo({ textLog, cadence, now = new Date(), refresh = false, triedDays = 14 }) {
  const zones = textLog.readZones(), at = now.getTime();
  const seen = new Set(), todo = [], n = { first: 0, board: 0, log: 0, tried: 0 };
  let note = null;
  const add = (id, name, kind) => {
    const k = k15(id);
    if (!k || seen.has(k)) return;
    if (!refresh) {
      if (textLog.zonesFor(id, zones)) return;
      if (textLog.zoneTried(k, triedDays, at, zones)) { seen.add(k); n.tried++; return; }      // by the 15-character key: textLog.readZones() stores every row under it, whatever spelling the row was written with
    }
    seen.add(k); todo.push({ accountId: id, name, kind }); n[kind]++;
  };
  try {
    const autoDays = cadence.loadConfig().autoDays;
    const since = (m) => { const t = Date.parse(m.enrolledAt); return Number.isFinite(t) ? t : Infinity; };
    const old = (m) => Number.isFinite(autoDays) && at - since(m) > autoDays * 864e5;
    const tier = (m) => (old(m) ? 2 : (m.touches || []).length ? 1 : m.startable ? 0 : 2);
    cadence.members({ textLog, now, startNewLds: false })
      .map((m, i) => ({ m, i, t: tier(m) }))
      .sort((a, b) => a.t - b.t || since(a.m) - since(b.m) || a.i - b.i)
      .forEach(({ m, t }) => add(m.accountId, m.name, t === 0 ? 'first' : 'board'));
  } catch (e) { note = `could not read the follow-up board (${e.message}): reading the texted log's accounts only`; }
  textLog.reengageDue('text', { maxDays: 365, includeHeld: true }).forEach((l) => add(l.accountId, l.name, 'log'));
  textLog.aggregate().forEach((a) => add(a.accountId, a.accountName, 'log'));
  return { todo, ...n, note };
}

/** The one line that says what a zoneTodo() plan holds, for the run and for --dry-run. `max` = how many a run reads (--max). */
function planLine(plan, { refresh = false, max = Infinity } = {}) {
  const n = (x) => Number(x).toLocaleString('en-US');
  return `${n(plan.todo.length)} account(s) ${refresh ? 'to read' : 'have no time zone yet'}: ${n(plan.first)} first texts waiting on the follow-up board, ${n(plan.board)} other board leads, ${n(plan.log)} others in the log${plan.tried ? `; ${n(plan.tried)} left alone (their address showed nothing in the last 14 days; --refresh reads them again)` : ''}. Reading up to ${n(Math.min(max, plan.todo.length))}`;
}

module.exports = { readLocation, readAndRecord, zoneTodo, planLine, stateFromText };
