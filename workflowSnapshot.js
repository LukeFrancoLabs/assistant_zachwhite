#!/usr/bin/env node
'use strict';

/**
 * workflowSnapshot — the numbers and facts behind the published Pipeline Assistant workflow diagram (pipeline-diagram.html), as one small JSON document.
 * Read-only: no browser, nothing is sent, no log is changed. (Only --post writes: workflow-posts/ and workflow-snapshots.jsonl, its own files.)
 *
 *   node workflowSnapshot.js            a plain summary of today's numbers
 *   node workflowSnapshot.js --json     the whole document
 *   node workflowSnapshot.js --post     save the document and print the ONE ArtifactData call that adds it to the diagram's database
 *
 * The page shows the newest document of the collection "workflow" (one new document per run, so nothing is ever read before a write). The diagram's address is in
 * workflow-diagram.json ({ "url": "https://claude.ai/artifact/..." }).
 *
 * Numbers come from the readers the dashboard uses (textLog.js, cadence.js, boardRun.js, holdInbox.js). Facts (the Closed Won window, the stages and their copy,
 * the texting hours, the email caps) are read from the code and config, so the diagram changes when they do. Every figure is read on its own: one that fails is
 * left out and listed in `missing`, and the rest still go.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const ZONE = 'America/New_York';
const CONFIG_FILE = path.join(DIR, 'workflow-diagram.json');
const SNAP_FILE = path.join(DIR, 'workflow-snapshots.jsonl');
const POST_DIR = path.join(DIR, 'workflow-posts');
const DAY = 864e5;

const num = (n) => Number(n).toLocaleString('en-US');
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fallback; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return null; } };
const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(Math.abs(n));

/** The text templates, read from the TEMPLATES block of Assistant.js (an object literal of plain strings) without loading the bot. */
function readTemplates() {
  const src = fs.readFileSync(path.join(DIR, 'Assistant.js'), 'utf8');
  const m = src.match(/const TEMPLATES = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('the TEMPLATES block was not found in Assistant.js');
  return vm.runInNewContext('(' + m[1] + ')', Object.create(null), { timeout: 1000 });
}

function snapshot(now = new Date()) {
  const missing = [];
  const safe = (what, fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { missing.push(`${what}: ${String(e.message).slice(0, 140)}`); return fallback; } };
  const tl = require('./textLog'), cadence = require('./cadence'), boardRun = require('./boardRun');
  const day = cadence.dayOf(now, ZONE), yday = cadence.addDays(day, -1), weekFrom = cadence.addDays(day, -7);
  const etDate = (iso) => cadence.dayOf(new Date(iso), ZONE);
  const cfg = cadence.loadConfig();
  const templates = safe('text templates', readTemplates, {});
  const emailSteps = safe('email steps', () => require('./emailSequence').STEPS, null);
  const copyOf = (s) => cadence.copyOf(s, templates, emailSteps);

  // ---- facts: what the code and config say right now ----
  const facts = safe('facts', () => {
    const W = require('./tcpa').WINDOW;
    const bot = fs.readFileSync(path.join(DIR, 'Assistant.js'), 'utf8');
    const pick = (re, src) => { const m = src.match(re); return m ? Number(m[1]) : null; };
    return {
      wonDays: require('./closedWonWindow').WON_FLAG_DAYS,
      autoDays: cfg.autoDays,
      hours: { start: W.knownStartHour, end: W.endHour, unknownStartET: W.startHour + 3, sunday: !!W.allowSunday },
      caps: { emailPerRun: pick(/emailMaxPerRun:\s*(\d+)/, bot), emailPerDay: pick(/emailMaxPerDay:\s*(\d+)/, bot) },
      stages: cfg.stages.map((s) => {
        const c = copyOf(s), one = (x) => String(x || '').replace(/\{\{([^}|]*)\|?([^}]*)\}\}/g, (_, a, b) => b || a).replace(/\s+/g, ' ').trim();
        const text = c && c.text ? one(c.text) : '';
        return { id: s.id, day: s.day, ch: s.ch, n: s.n, label: s.label, afterMin: s.afterMin || 0, sameDay: !!s.sameDay, template: s.template || null, copy: c ? c.name : null, held: !c, byHand: !!s.byHand, manual: !!s.manual,
                 text: text.length > 700 ? text.slice(0, 699) + '…' : text, subject: c && c.subject ? one(c.subject) : '' };
      }),
    };
  });
  const stageFacts = new Map(((facts && facts.stages) || []).map((s) => [s.id, s]));

  // ---- the board ----
  const leads = safe('board members', () => cadence.members({ textLog: tl, now }), []);
  let sum = null, autoCount = 0;
  safe('board stages', () => {
    const gotCopy = boardRun.gotCopyFor(copyOf, (id, c) => tl.sentSameMessage(id, 'text', { templateName: c.name, message: c.text }));
    const r = boardRun.look({ members: () => leads, cfg, copyFor: (s) => !!copyOf(s), gotCopy, flags: {}, tried: null }, now, leads);
    sum = boardRun.summarize(r.all, r.auto, cfg, now); autoCount = r.auto.length;
  });
  const tot = (k) => (sum ? sum.per.reduce((n, p) => n + p[k], 0) : null);
  const has = (l, kind) => (l.kinds || []).includes(kind);
  const onShark = leads.filter((l) => has(l, 'Shark')).length, onLds = leads.filter((l) => has(l, 'LDS')).length;
  const otherLists = leads.filter((l) => !has(l, 'Shark') && !has(l, 'LDS')).length, byHand = leads.filter((l) => l.hand).length;
  const neverContacted = leads.filter((l) => !(l.touches || []).length).length;

  // ---- the parked lists ----
  const won = safe('closed-won list', () => tl.closedWonList(), []);
  const wonDays = (facts && facts.wonDays) || require('./closedWonWindow').WON_FLAG_DAYS;
  const usDate = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : Date.parse(s); };
  const wonRecent = won.filter((r) => now.getTime() - usDate(r.closeDate) <= wonDays * DAY).length;
  const custRows = safe('customer rows', () => [...new Map([...tl.readCustomerRows().values()].map((r) => [k15(r.accountId), r])).values()], []);
  const heldIds = safe('current customers', () => new Set([...tl.readCurrentCustomers().values()].map((r) => k15(r.accountId))), new Set());
  // business coaching is marked the way the dashboard marks it: a coaching verdict, or a Closed Won opportunity that is a coaching product (customerPlan.entryIsCoaching)
  const plan = safe('plan check', () => require('./customerPlan'));
  const entryCoach = (e) => !!e && (!!e.coaching || (plan && typeof plan.entryIsCoaching === 'function' && plan.entryIsCoaching(e)));
  const coachIds = new Set(custRows.filter((c) => c.verdict === 'coaching' || (Array.isArray(c.closedWon) && c.closedWon.some(entryCoach))).map((c) => k15(c.accountId)));
  const heldCustomers = [...heldIds].filter((k) => !coachIds.has(k)).length, coaching = coachIds.size;
  const freePlan = custRows.filter((r) => r.verdict === 'free-plan').length;
  const bans = safe('do-not-contact list', () => { const m = new Map(); for (const r of tl.readBans().values()) m.set(k15(r.accountId), r); return m; }, new Map());
  const wonIds = new Set(won.map((r) => k15(r.accountId)));
  // review skips that no other list already holds (the same account can be a skip, a Closed Won and a customer at once)
  const skips = safe('review skips', () => { const m = new Set(); for (const r of tl.readReviews().values()) { const k = k15(r.accountId); if (r.verdict === 'skip' && !r.moot && now.getTime() - Date.parse(r.at) < 14 * DAY && !wonIds.has(k) && !heldIds.has(k) && !bans.has(k)) m.add(k); } return m.size; });
  const ldsTotal = safe('LDS list', () => tl.ldsLeads().length);
  const bannedWeek = [...bans.values()].filter((r) => now.getTime() - Date.parse(r.at) <= 7 * DAY).length;
  const teamHeld = leads.filter((l) => l.teammateAt).length;      // a teammate texted it lately (the Shark report's last-SMS stamp says it; the board no longer reads the SMS thread). Since 2026-11-04 that holds nothing: the lead stays in the cadence
  const top = safe('top hit list', () => require('./topHit').list(), null);
  const topN = top && Array.isArray(top.rows) ? top.rows.length : null, topHidden = top && Array.isArray(top.hidden) ? top.hidden.length : null;

  // ---- what went out ----
  const since = new Date(now.getTime() - 10 * DAY).toISOString();
  const rows = safe('log', () => tl.readAll(), []);
  const recent = rows.filter((r) => String(r.at) >= since).map((r) => ({ r, d: etDate(r.at) }));
  const isMail = (r) => r.channel === 'email';
  const yRows = recent.filter((x) => x.d === yday).map((x) => x.r), wRows = recent.filter((x) => x.d >= weekFrom && x.d < day).map((x) => x.r);
  const split = (list) => ({ texts: list.filter((r) => !isMail(r)).length, emails: list.filter(isMail).length });
  const sentWith = (list, id) => {
    const s = stageFacts.get(id); if (!s || s.held) return 0;
    return list.filter((r) => (s.ch === 'email' ? isMail(r) && (r.step === s.n || (s.n === 1 && /^Curiosity/i.test(r.templateName || ''))) : !isMail(r) && r.templateName === s.copy)).length;
  };
  const yd = split(yRows), wk = split(wRows);

  // ---- replies, the sheet, the dashboard ----
  const reps = safe('replies', () => tl.readReplyRows(), []);
  const repY = reps.filter((r) => String(r.at) >= since && etDate(r.at) === yday);
  const scan = safe('newest Shark scan', () => tl.newestSharkScan());
  const built = safe('dashboard page', () => fs.statSync(path.join(DIR, 'texted-dashboard.html')).mtime.toISOString());

  // ---- one entry per node of the diagram: pill = the number shown on it, rows = the list in its details ----
  const n = {};
  const put = (id, pill, rows) => { n[id] = { pill: Number.isFinite(pill) ? pill : null, rows: rows.filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== 'NaN') }; };
  const v = (x) => (typeof x === 'number' && Number.isFinite(x) ? num(x) : x === null || x === undefined ? null : String(x));

  put('shark', onShark, [['Leads on the board', v(onShark)], ['Newest report scan', scan && scan.at ? `${scan.name || 'Shark report'}, ${etDate(scan.at)}` : null]]);
  put('lds', onLds, [['Leads on the board', v(onLds)], ['On the LDS list in all', v(ldsTotal)]]);
  put('csv', otherLists, [['Leads from other lists (email reports, free plan)', v(otherLists)], ['Added by hand', v(byHand)]]);
  put('board', leads.length, [['Leads on the board', v(leads.length)], ['Never contacted', v(neverContacted)], ['Finished every stage', v(sum && sum.finished)], ['Asked us to stop (paused)', v(tot('paused'))],
    ['Held (not started on their own)', v(tot('held'))], [`Started over ${facts ? facts.autoDays : 7} days ago, not run on their own`, v(tot('old'))], ['Waiting for copy that is not written', v(tot('blocked'))]]);
  put('scrub', null, [[`Closed Won list (last ${wonDays} days)`, v(wonRecent)], ['Current customers held', v(heldCustomers)], ['Business coaching held', v(coaching)], ['Skipped for 14 days, on no other list', v(skips)], ['Free plan, back in the cadence', v(freePlan)], ['Note', 'one account can be on more than one list']]);
  put('c_won', won.length, [['On the list, any age', v(won.length)], [`Closed in the last ${wonDays} days`, v(wonRecent)]]);
  put('c_cust', heldCustomers, [['Held as current customers', v(heldCustomers)], ['Free plan, released to the cadence', v(freePlan)]]);
  put('c_coach', coaching, [['Business coaching accounts', v(coaching)]]);
  put('c_skip', skips, [['Skipped in the last 14 days, on no other list', v(skips)]]);
  put('dnc', null, [['Accounts on the list', v(bans.size)], ['Added in the last 7 days', v(bannedWeek)]]);
  put('c_dnc', bans.size, [['Accounts on the list', v(bans.size)], ['Added in the last 7 days', v(bannedWeek)]]);
  put('team', null, [['Leads a teammate texted lately', v(teamHeld)]]);
  put('c_team', teamHeld, [['Leads a teammate texted in the last 48 hours (they stay in the cadence)', v(teamHeld)]]);
  put('c_top', topN, [['On the Top hit list', v(topN)], ['Left off (banned, customers, taken off by hand)', v(topHidden)]]);
  put('due', sum ? autoCount : null, [['Allowed to run on their own now', v(autoCount)], ['Leads waiting for a next stage', v(sum ? sum.per.reduce((a, p) => a + p.next, 0) : null)], ['Reached a stage today', v(tot('today'))]]);
  for (const s of cfg.stages) {
    const p = sum ? sum.per.find((x) => x.stage.id === s.id) : null;
    put(s.id, p ? p.next : null, [['Waiting for this stage', v(p && p.next)], ['Reached today', v(p && p.today)], ['Sent yesterday, any run', v(sentWith(yRows, s.id))], ['Sent in the 7 days to yesterday', v(sentWith(wRows, s.id))]]);
  }
  put('log', rows.length, [['Texts and emails logged', v(rows.length)], ['Yesterday', `${num(yd.texts)} texts, ${num(yd.emails)} emails`], ['The 7 days to yesterday', `${num(wk.texts)} texts, ${num(wk.emails)} emails`]]);
  put('dash', null, [['Dashboard page built', built ? built.slice(0, 16).replace('T', ' ') + ' UTC' : null]]);
  put('replies', repY.length, [['Replies yesterday', v(repY.length)], ['Interested yesterday', v(repY.filter((r) => r.interested).length)], ['Replies logged in all', v(reps.length)], ['Flagged as opt-outs in all', v(reps.filter((r) => r.optout).length)]]);
  put('say', reps.filter((r) => r.optout).length, [['Replies flagged as opt-outs, all time', v(reps.filter((r) => r.optout).length)], ['Replies flagged interested, all time', v(reps.filter((r) => r.interested).length)], ['Replies asking for the gift card, all time', v(reps.filter((r) => r.gift).length)]]);
  put('c_gift', reps.filter((r) => r.gift).length, [['Replies mentioning the gift card, all time', v(reps.filter((r) => r.gift).length)]]);

  return { v: 1, asOf: now.toISOString(), day, yday, facts, n, missing };
}

module.exports = { snapshot, readTemplates };

if (require.main === module) {
  const args = process.argv.slice(2);
  const now = new Date(), doc = snapshot(now);
  const pills = {}; for (const [id, x] of Object.entries(doc.n)) if (x.pill !== null) pills[id] = x.pill;
  if (args.includes('--post')) {
    const conf = readJson(CONFIG_FILE, null);
    if (!conf || !conf.url) { console.log('No diagram address yet: publish pipeline-diagram.html, then save its address in workflow-diagram.json as {"url": "https://claude.ai/artifact/..."}.'); process.exit(1); }
    // the change since the last post (a different calendar day), added to each node's list
    const prev = (readLines(SNAP_FILE) || []).filter((r) => r.day !== doc.day).pop();
    if (prev) for (const [id, x] of Object.entries(doc.n)) if (x.pill !== null && Number.isFinite(prev.pills[id])) x.rows.push(['Change since the last update', x.pill === prev.pills[id] ? 'none' : sign(x.pill - prev.pills[id])]);
    fs.mkdirSync(POST_DIR, { recursive: true });
    const id = `${doc.day}_${Math.floor(now.getTime() / 1000)}`, file = path.join(POST_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    fs.appendFileSync(SNAP_FILE, JSON.stringify({ at: doc.asOf, day: doc.day, pills }) + '\n');
    console.log(`Workflow numbers as of ${doc.asOf}: ${num(doc.n.board.pill || 0)} leads on the board${doc.missing.length ? `; ${doc.missing.length} figure(s) left out (${doc.missing.join(' | ')})` : ''}.`);
    console.log(`ArtifactData input: ${JSON.stringify({ action: 'set', url: conf.url, collection: 'workflow', doc_id: id, file_path: file })}`);
    // the same document for every other page that shows the map ("also" in workflow-diagram.json: the dashboard's Graph tab reads its own copy), one more line each
    for (const url of (Array.isArray(conf.also) ? conf.also : [])) console.log(`ArtifactData input: ${JSON.stringify({ action: 'set', url, collection: 'workflow', doc_id: id, file_path: file })}`);
  } else if (args.includes('--json')) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(`\n  Pipeline Assistant workflow numbers, as of ${doc.asOf} (Eastern day ${doc.day}):\n`);
    for (const [id, x] of Object.entries(doc.n)) console.log(`   ${id.padEnd(8)} ${x.pill === null ? '—'.padStart(7) : num(x.pill).padStart(7)}   ${x.rows.map((r) => `${r[0]}: ${r[1]}`).join(' · ')}`);
    if (doc.facts) console.log(`\n  Facts: Closed Won window ${doc.facts.wonDays} days · automatic window ${doc.facts.autoDays} days · texting ${doc.facts.hours.start}:00-${doc.facts.hours.end}:00 their time (unknown zone ${doc.facts.hours.unknownStartET}:00-${doc.facts.hours.end}:00 ET) · email caps ${doc.facts.caps.emailPerRun}/run, ${doc.facts.caps.emailPerDay}/day`);
    if (doc.missing.length) console.log(`\n  Left out: ${doc.missing.join(' | ')}`);
    console.log('\n  --json shows the document; --post saves it and prints the ArtifactData call.\n');
  }
}
