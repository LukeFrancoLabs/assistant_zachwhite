'use strict';

/**
 * boardRun — `email --board`: the automatic follow-up. Every lead on the follow-up board follows the thirteen stages of the 60-day drip (cadence.js) by itself, each text and email inside the lead's OWN
 * texting hours, with nobody at the Mac. Started with no --trade it first asks GENERAL or INDUSTRY SPECIFIC (and, for industry specific, which industries), then, with no --stage, WHICH STAGE (0 = every stage, or one or more of the thirteen); then one confirm, then it runs through the day: it texts / emails whoever is ready, waits for the next lead's window or gap, and ends when nothing
 * more can go out today. Start it again tomorrow (the log is the state, so there is nothing to carry over).
 *
 *   email --board --inspect            no browser: the stage table, who was reached today, what the run would do now
 *   email --board [--max-texts N] [--max-emails N] [--stage d1t2,d3t3] [--trade Plumbing,HVAC] [--older] [--until HH:MM] [--yes] [--dry-run]
 *                                           (no --trade: it asks "general or industry specific?" first; --trade names the industries up front and skips that question, --yes asks nothing)
 *                                           (no --stage: it then asks "which stage?", 0 or Enter = every stage; --stage names the stages up front and skips that question)
 *
 * It reuses the senders every other mode uses (runReportCampaign for texts, runEmailCampaign for emails: banlist, hours, once-a-day, never-the-same-message, contact-ledger
 * guards; the SMS thread is NOT read first, see DEFAULTS.threadRead), its own Chrome (port 9336), and the evening run's watchdog (eveningShark.createSession): a crashed Chrome is relaunched, a closed or frozen tab replaced, the Salesforce login
 * kept alive. Dependency-injected end to end (clock, board, senders, session, prompt) so a test can run a whole day in milliseconds.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cadence = require('./cadence');
const tcpa = require('./tcpa');

const DIR = process.env.ASSISTANT_BOARD_DIR || __dirname;
const PORT = 9336;
const PROFILE_DIR = '.browser-profile-board';
const FILES = { lock: path.join(DIR, 'board.lock'), status: path.join(DIR, 'board-status.json'), history: path.join(DIR, 'board-history.jsonl') };
const DEFAULTS = {
  pollMs: 30000, healthEveryMs: 4 * 60000, keepAliveEveryMs: 8 * 60000, stallMs: 4 * 60000,
  batchSize: 20, maxTries: 2, retryAfterMs: 40 * 60000, passGapMs: 3000, troubledWaitMs: 60000,
  maxEarlyFailures: 5,              // a sender that fails this many passes in a row before it even starts on a lead is broken, not unlucky: the run stops and says so
  closeMarginMs: 120000,            // a text / email is only started on a lead whose window stays open this much longer (a send takes ~30-90 s, and none should land after the close)
  textSec: 30, emailSec: 75,        // how long one text / one email takes, for the estimate in the plan
  checkSec: 4,                      // the look at the account before a text adds about this much: its page load is the text's own (the text no longer loads the account a second time), so only reading Customer Status and the page's Opportunities card is extra (an estimate, not timed against the real page; the first 3 accounts of a run also read the Opportunities tab once, to prove the card reads right)
  threadRead: false,                // false = the board does NOT read an account's SMS thread before it texts (Luke, 2026-11-03: "we can take off the thread reading part for --board"); true brings the old read back (Text 2 and later, threadGuard 'normal', as --same-day does)
  noCheckStages: ['d1t2'],          // stages whose text may go out WITHOUT the look at the account (Customer Status + Closed Won, enrollCheck.js): Day 1 · Text 2 comes hours after a Text 1 that was just looked at (Luke, 2026-11-03: "we do not need to check for closed won oppys on day 1, text 2 stage")
  noCheckAfterBoardText1Today: true, // ...but only for a lead whose Text 1 the BOARD ITSELF sent today (Luke, 2026-11-03: "Yes, limit it"; a board text, mode 'board', is looked at right before it goes). Every other lead of those stages is looked at as always: all 58 Text 1s of 2026-11-03 came from the queue run, which does no look, and 348 of the 595 Text 2s ready that day had never been looked at by the board. false = every lead of those stages goes without the look
  lastMinute: '23:59',              // Eastern: after the last window of the day (8 PM Pacific = 11 PM Eastern) the run ends
};

const ZONE = cadence.ZONE;
const k15 = cadence.k15;
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fb; } };
const writeJson = (file, obj) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); };   // atomic: a reader never sees half a file
const defaultLog = (icon, action, detail = '') => console.log(`  ${icon} ${String(action).toUpperCase().padEnd(20)}${detail}`.trimEnd());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const span = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
const clock = (d) => (d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ZONE, timeZoneName: 'short' }) : '—');
const zoneLabel = (zones) => ((zones && zones.length ? zones : null) ? zones.map((z) => (tcpa.ZONE_SHORT && tcpa.ZONE_SHORT[z]) || z).join('/') : 'unknown');
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n).toLocaleString('en-US');

// ============================================================================
// Flags this mode owns (--max-texts, --yes, --until, --dry-run … are parsed by Assistant.js)
// ============================================================================
/**
 * → { older, maxEmails, stages: Set | null, trades: Set | null, textsOnly, emailsOnly, error }. `--stage` takes ids (d1t1 …) or 1-13 (the numbers of the Terminal's "which stage?" list); it answers that question up front, so it is not asked.
 * `--trade Plumbing,HVAC` (also --trades): work only the leads of those industries (the dashboard's 🏭 picker builds it); `unknown` = the leads nothing is known about. It can only NARROW the run.
 */
function parseFlags(argv = []) {
  const f = { older: false, maxEmails: null, stages: null, trades: null, textsOnly: false, emailsOnly: false, error: null };
  const ids = cadence.DEFAULT_STAGES.map((s) => s.id);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--older') f.older = true;
    else if (a === '--texts-only') f.textsOnly = true;
    else if (a === '--emails-only') f.emailsOnly = true;
    else if (a === '--max-emails') { const n = parseInt(argv[++i], 10); if (!(n > 0)) f.error = '--max-emails needs a number, e.g. --max-emails 20'; else f.maxEmails = n; }
    else if (a === '--stage' || a === '--stages') {
      const raw = String(argv[++i] || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const picked = new Set();
      for (const r of raw) { const id = /^\d+$/.test(r) ? ids[Number(r) - 1] : r; if (!ids.includes(id)) { f.error = `--stage: "${r}" is not a stage. Use ${ids.join(', ')} (or 1-${ids.length}).`; break; } picked.add(id); }
      if (!raw.length) f.error = `--stage needs at least one stage: ${ids.join(', ')} (or 1-${ids.length}).`;
      f.stages = picked;
    }
    else if (a === '--trade' || a === '--trades') {
      const v = argv[i + 1], raw = v && !String(v).startsWith('--') ? String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (!raw.length) f.error = '--trade needs at least one industry, e.g. --trade Plumbing,HVAC  (unknown = the leads nothing is known about).';
      else { f.trades = f.trades || new Set(); for (const x of raw) { const k = tradeKey(x); f.trades.add(k === 'none' ? 'unknown' : k); } }
    }
    else if (a === '--max-texts') { if (!(parseInt(argv[i + 1], 10) > 0)) f.error = '--max-texts needs a number, e.g. --max-texts 15 (without one the run would have no cap).'; else i++; }      // (Assistant.js reads the number; it is checked here so a slip cannot leave a first run uncapped)
    else if (/^--max/.test(a)) f.error = `${a}: not a board flag. The caps are --max-texts N and --max-emails N (a mistyped cap would leave the run uncapped).`;
    else if (/^--(trad|industr|sector)/.test(a)) f.error = `${a}: did you mean --trade?  --trade Plumbing,HVAC works only those industries on the follow-up board. (--industry is another job: it reads every account's Industry from Salesforce.)`;      // a typo here must not quietly widen the run to everyone
  }
  if (f.textsOnly && f.emailsOnly) f.error = '--texts-only and --emails-only cannot be used together.';
  return f;
}

// ============================================================================
// --trade: work only some industries (the dashboard's 🏭 picker builds this flag from the same per-lead industry, cadence.members → lead.ind)
// ============================================================================
/** What a --trade value and a lead's industry are compared by: lower case, one space between words. */
const tradeKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
/** A lead's trade key: its industry, or 'unknown' when nothing says (no Salesforce Industry read, no clue in the business name). */
const leadTrade = (lead) => (lead && lead.ind && lead.ind.name ? tradeKey(lead.ind.name) : 'unknown');
/** → Map key → { name, n }: the industries on the board right now, with how many leads each has. */
function tradesOnBoard(leads) {
  const by = new Map();
  for (const l of leads) { const k = leadTrade(l), cur = by.get(k); if (cur) cur.n++; else by.set(k, { name: k === 'unknown' ? 'unknown' : l.ind.name, n: 1 }); }
  return by;
}
/** → null when every industry --trade names is on the board, else the message (it lists the industries that are). A typo must never widen the run to everyone, nor send it nowhere without saying why. */
function checkTrades(flags, leads) {
  if (!flags.trades) return null;
  const by = tradesOnBoard(leads), bad = [...flags.trades].filter((k) => !by.has(k));
  if (!bad.length) return null;
  const list = [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((x) => `${x.name} (${num(x.n)})`).join(', ');
  return `--trade: ${bad.map((k) => `"${k}"`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not an industry on the follow-up board right now. Nothing was started.\n  Industries on the board: ${list}.\n  Spell one as listed (capitals do not matter); several: --trade Plumbing,HVAC; "unknown" = the leads nothing is known about.`;
}
/** → { names, text, flag }: for the plan ("Plumbing, HVAC — 450 of 3,976 leads on the board") and the flag that runs it again, or null without --trade. */
function tradesNote(flags, leads) {
  if (!flags.trades) return null;
  const by = tradesOnBoard(leads), picked = [...flags.trades].map((k) => by.get(k)).filter(Boolean);
  const names = picked.map((x) => x.name);
  return { names, text: `${names.join(', ')} — ${num(picked.reduce((n, x) => n + x.n, 0))} of ${num(leads.length)} leads on the board`, flag: `--trade '${names.join(',')}'` };
}

// ============================================================================
// General or industry specific? The question the Terminal asks when the run was started without --trade
// ============================================================================
/** The answer to "general or industry specific?": g / general / 1 / Enter → 'general'; i / industry / specific / 2 → 'industry'; anything else → null (it is asked again). */
function parseScopeAnswer(text) {
  const s = String(text == null ? '' : text).toLowerCase().trim();
  if (!s || /^(g|gen|general|1|all|everyone|everybody|whole board|the whole board)$/.test(s)) return 'general';
  if (/^(i|ind|industry|industries|s|spec|specific|industry specific|industry-specific|2)$/.test(s)) return 'industry';
  return null;
}

/** The industries on the board for the picker → [{ key, name, n, today, ready }], the biggest first and "unknown" last. n = leads on the board, today = leads this run may send to today, ready = of those, ready right now. */
function tradeChoices(leads, auto) {
  const rows = [...tradesOnBoard(leads).entries()].map(([key, v]) => ({ key, name: v.name, n: v.n, today: 0, ready: 0 }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const e of auto || []) { const r = byKey.get(leadTrade(e.lead)); if (r) { r.today++; if (e.dueNow) r.ready++; } }
  return rows.sort((a, b) => (a.key === 'unknown') - (b.key === 'unknown') || b.n - a.n || a.name.localeCompare(b.name));
}

/** "1,3" / "Plumbing, HVAC" / "unknown" → { keys: Set of trade keys } or { error }. A number is a row of the list shown; a name is matched ignoring capitals, or by its first letters when only one industry starts with them. */
function parseTradePick(text, choices) {
  const raw = String(text == null ? '' : text).split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!raw.length) return { error: 'Type at least one number or industry name.' };
  const keys = new Set(), bad = [];
  for (const r of raw) {
    let hit = null;
    if (/^\d+$/.test(r)) hit = choices[Number(r) - 1] || null;
    else {
      const k = tradeKey(r) === 'none' ? 'unknown' : tradeKey(r);
      hit = choices.find((c) => c.key === k) || null;
      if (!hit) {
        const starts = choices.filter((c) => c.key.startsWith(k));
        if (starts.length === 1) hit = starts[0];
        else if (starts.length > 1) { bad.push(`"${r}" could be ${starts.map((c) => c.name).join(' or ')}`); continue; }
      }
    }
    if (hit) keys.add(hit.key); else bad.push(`"${r}" is not on the list`);
  }
  return bad.length ? { error: `${bad.join('; ')}.` } : { keys };
}

/**
 * "General or industry specific?" → { trades: Set of trade keys | null (general), aborted: true | undefined }.
 * `ask(question)` is the Terminal prompt and `say(line)` prints; `leads` = everyone on the board, `auto` = the entries this run may send to today (look().auto). A slip is asked again (3 tries, then nothing starts).
 * The industries are the same per-lead industry the dashboard's 🏭 picker and --trade use: the Salesforce Industry once `email --industry` has read it, else a guess from the business name.
 */
async function chooseScope({ ask, say = console.log, leads, auto }) {
  say('\n  🏭 WHO SHOULD THIS RUN WORK?');
  say(`     g = GENERAL: the whole board, every industry (${num(leads.length)} leads · ${num((auto || []).length)} can be worked today)`);
  say('     i = INDUSTRY SPECIFIC: only the industries you pick next');
  let scope = null;
  for (let tries = 0; tries < 3 && !scope; tries++) {
    scope = parseScopeAnswer(await ask('  General or industry specific? (g / i, Enter = general) '));
    if (!scope) say('     Type g for general or i for industry specific.');
  }
  if (!scope) return { aborted: true };
  if (scope === 'general') { say('     ✅ GENERAL: the whole board.'); return { trades: null }; }

  const choices = tradeChoices(leads, auto);
  const guessed = leads.filter((l) => l.ind && l.ind.src !== 'sf').length, unknown = leads.filter((l) => !(l.ind && l.ind.name)).length;
  say(`\n     ${pad('#', 4)}${pad('Industry', 32)}${pad('leads', 8)}${pad('can go today', 14)}ready now`);
  choices.forEach((c, i) => say(`     ${pad(i + 1, 4)}${pad(c.key === 'unknown' ? 'unknown (no clue)' : c.name, 32)}${pad(num(c.n), 8)}${pad(num(c.today), 14)}${num(c.ready)}`));
  if (guessed) say(`     ⚠️  ${num(guessed)} of ${num(leads.length)} leads have an industry that is only a GUESS from the business name (the Salesforce Industry has not been read for them), so some sit in the wrong industry${unknown ? `; ${num(unknown)} have no clue (unknown)` : ''}.`);
  for (let tries = 0; tries < 3; tries++) {
    const ans = String(await ask('\n  Which industries? Type the numbers or names, comma-separated (e.g. 1,3 or Plumbing,HVAC).  g = general instead · q = quit: ')).trim();
    if (/^(q|quit|cancel|exit)$/i.test(ans)) return { aborted: true };
    if (/^(g|general)$/i.test(ans)) { say('     ✅ GENERAL: the whole board.'); return { trades: null }; }
    const got = parseTradePick(ans, choices);
    if (got.error) { say(`     ${got.error}`); continue; }
    return { trades: got.keys };
  }
  return { aborted: true };
}

// ============================================================================
// Which stage? The second question the Terminal asks (after "general or industry specific?") when the run was started without --stage
// ============================================================================
/**
 * → { names, ids, text, flag }: for the plan ("Day 3 · Email 2") and the flag that runs it again (`--stage d3e2`), or null when no stage was named (every stage is worked).
 * In the board's order, whatever order they were typed in.
 */
function stagesNote(flags, cfg) {
  if (!flags.stages || !flags.stages.size) return null;
  const picked = cfg.stages.filter((s) => flags.stages.has(s.id));
  return picked.length ? { names: picked.map((s) => s.label), ids: picked.map((s) => s.id), text: picked.map((s) => s.label).join(' + '), flag: `--stage ${picked.map((s) => s.id).join(',')}` } : null;
}

/**
 * The picker's rows → [{ n, id, label, next, ready, later, copy, tag, why }], one per stage in the board's order. n (1-13) is the number --stage takes too; 0 is "every stage" and is not a row.
 * `sum` = summarize() of the board as this run sees it, `names` = copyNamesOf(). `why` = the reason a stage cannot be picked right now (no text written for it, the other channel from --texts-only /
 * --emails-only, nobody can go out for it today), else null: such a pick would start a run that sends nothing.
 */
function stageChoices(sum, names, flags, copyFor) {
  return sum.per.map((p, i) => {
    const s = p.stage;
    const other = flags.textsOnly && s.ch !== 'text' ? '--texts-only' : flags.emailsOnly && s.ch !== 'email' ? '--emails-only' : null;
    const why = s.byHand ? `${s.label} is done by hand: the board never sends it.` : !copyFor(s) ? `${s.label} has no ${s.ch} written yet, so it is held: nothing can go out for it.`
      : other ? `${s.label} is ${s.ch === 'email' ? 'an email' : 'a text'} stage and this run has ${other}.`
      : p.ready + p.later === 0 ? `nobody can go out for ${s.label} today (none ready now, none later today).`
      : null;
    return { n: i + 1, id: s.id, label: s.label, next: p.next, ready: p.ready, later: p.later, copy: names[i], tag: other ? `not with ${other}` : null, hand: !!(s.byHand || s.manual), why };
  });
}

/**
 * "5" / "4,5" / "d3e2" / "" / "0" → { all: true } | { ids: Set of stage ids } | { error }. 0, "all" or Enter = every stage (what a run without this question does); a number is a row of the list shown (1-13, the same numbers
 * --stage takes), an id is the one in its id column; several are separated by commas or spaces. A stage that cannot go out right now (`why`) is refused with the reason, so a pick never starts a run that sends nothing.
 */
function parseStagePick(text, choices) {
  const raw = String(text == null ? '' : text).toLowerCase().split(/[,;\s]+/).filter(Boolean);
  if (!raw.length) return { all: true };
  let all = false; const ids = new Set(), bad = [], refused = [];
  for (const r of raw) {
    if (r === '0' || r === 'all') { all = true; continue; }
    const hit = /^\d+$/.test(r) ? choices[Number(r) - 1] : choices.find((c) => c.id === r);
    if (!hit) { bad.push(`"${r}" is not on the list`); continue; }
    if (hit.why) { if (!refused.includes(hit.why)) refused.push(hit.why); continue; }
    ids.add(hit.id);
  }
  if (bad.length) return { error: `${bad.join('; ')}.` };
  if (all && (ids.size || refused.length)) return { error: '0 means every stage: type it alone, or name the stages you want.' };
  if (all) return { all: true };
  if (refused.length) return { error: refused.join(' ') };
  return { ids };
}

/**
 * "Which stage?" → { stages: Set of stage ids | null (every stage), aborted: true | undefined }.
 * `ask(question)` is the Terminal prompt and `say(line)` prints; `choices` = stageChoices(). 0 or Enter = every stage, what a run without this question does, so nothing changes unless a stage is named.
 * A slip is asked again (3 tries, then nothing starts), like the industry question.
 */
async function chooseStage({ ask, say = console.log, choices }) {
  const total = (k) => choices.reduce((n, c) => n + c[k], 0);
  say('\n  🎯 WHICH STAGE SHOULD THIS RUN HIT?');
  say(`\n     ${pad('#', 4)}${pad('Stage', 23)}${pad('id', 7)}${pad('waiting for it', 16)}${pad('ready now', 11)}${pad('later today', 13)}text / email`);
  say(`     ${pad(0, 4)}${pad('ALL STAGES (default)', 23)}${pad('', 7)}${pad(num(total('next')), 16)}${pad(num(total('ready')), 11)}${pad(num(total('later')), 13)}everything that is due, as before`);
  for (const c of choices) say(`     ${pad(c.n, 4)}${c.hand ? '✋' : '🤖'} ${pad(c.label, 20)}${pad(c.id, 7)}${pad(num(c.next), 16)}${pad(num(c.ready), 11)}${pad(num(c.later), 13)}${c.copy}${c.tag ? `  (${c.tag})` : ''}`);
  say('     ✋ you do it by hand · 🤖 the board does it by itself');
  for (let tries = 0; tries < 3; tries++) {
    const ans = String(await ask('\n  Which stage? Type its number or id (several: 4,5) · 0 or Enter = all stages · q = quit: ')).trim();
    if (/^(q|quit|cancel|exit)$/i.test(ans)) return { aborted: true };
    const got = parseStagePick(ans, choices);
    if (got.error) { say(`     ${got.error}`); continue; }
    if (got.all) { say('     ✅ ALL STAGES: everything that is due.'); return { stages: null }; }
    return { stages: got.ids };
  }
  return { aborted: true };
}

// ============================================================================
// Where everybody stands right now
// ============================================================================
/** The Eastern calendar day's last minute the run works to. */
const endOfRunDay = (t, lastMinute = DEFAULTS.lastMinute) => cadence.instantAt(cadence.dayOf(t, ZONE), lastMinute, ZONE);

/** When a lead's texting window closes today (the earliest across its zones; an unknown zone closes at 8 PM Eastern). Used to send whoever closes soonest first. */
function closeAt(zones, t) {
  const list = zones && zones.length ? zones : [ZONE];
  let min = Infinity;
  for (const tz of list) { const c = cadence.instantAt(cadence.dayOf(t, tz), `${tcpa.WINDOW.endHour}:00`, tz).getTime(); if (c < min) min = c; }
  return min;
}

/** null when a lead's own hours are open now AND stay open for `margin` more ms (the hours check before each send); else why not. `zones` null = unknown: the all-US window. */
function hoursReason(zones, margin = DEFAULTS.closeMarginMs, at = Date.now()) {
  const g = tcpa.checkZones(zones, new Date(at)); if (!g.ok) return g.reason;
  const g2 = margin ? tcpa.checkZones(zones, new Date(at + margin)) : g; return g2.ok ? null : g2.reason;
}

/** → env.gotCopy(lead, stage): did the lead already get this stage's exact text (the same wording or the same named template, ever)? `sentSame(accountId, { name, text })` → { at } | null. */
function gotCopyFor(copyOf, sentSame) {
  if (!sentSame) return null;
  return (lead, s) => { const c = copyOf(s); if (!c || !c.text) return null; try { return sentSame(lead.accountId, c) || null; } catch (_) { return null; } };
}

/**
 * The board as the run sees it: every member evaluated at `t`, with the run's own filters (--stage, --trade, --texts-only, --emails-only, the stages it is not allowed to send).
 * `leads` = the members already read (the plan reads them once to check --trade); without it they are read now.
 * → { all, auto }: `auto` = the ones this run may send today (ready or becoming ready, not paused / held / blocked / over the try limit). `all` holds only the industries --trade asked for.
 */
function look(env, t, leads = null) {
  const { members, cfg, copyFor, gotCopy, flags, tried } = env;
  const everyone = leads || members(t), mine = flags.trades ? everyone.filter((l) => flags.trades.has(leadTrade(l))) : everyone;      // --trade: only the industries asked for (it can only narrow the run)
  const all = cadence.board(mine, cfg, t, { copyFor, gotCopy });
  const picks = (e) => !flags.stages || flags.stages.has(e.next.id);
  const chOk = (e) => !(flags.textsOnly && e.next.ch !== 'text') && !(flags.emailsOnly && e.next.ch !== 'email');
  const auto = all.filter((e) => e.next && (e.state === 'due' || e.state === 'waiting') && picks(e) && chOk(e) && !(tried && tried.gaveUp(e, t)));
  return { all, auto };
}

/** Counts per stage for the plan and for `--inspect`. */
function summarize(all, auto, cfg, t) {
  const end = endOfRunDay(t).getTime();
  const per = cfg.stages.map((s) => ({ stage: s, next: 0, ready: 0, later: 0, today: 0, paused: 0, held: 0, old: 0, blocked: 0 }));
  let finished = 0, noAddress = 0, replied = 0;
  for (const e of all) {
    if (e.noMail && e.noMail.length) noAddress++; if (e.repliedAt && e.state !== 'paused') replied++;      // the email sender found no address for it: its email stages are skipped, the texts go on
    for (const id of e.sentToday) { const i = cfg.stages.findIndex((s) => s.id === id); if (i >= 0) per[i].today++; }
    if (!e.next) { finished++; continue; }
    const p = per[e.nextIdx]; p.next++;
    if (e.state === 'paused') p.paused++; else if (e.state === 'blocked') p.blocked++; else if (e.state === 'held') { if (e.old) p.old++; else p.held++; }
  }
  const autoSet = new Set(auto);
  for (const e of auto) { const p = per[e.nextIdx]; if (e.dueNow) p.ready++; else if (e.opensAt && Date.parse(e.opensAt) < end) p.later++; }
  return { per, finished, total: all.length, autoSet, noAddress, replied };
}

function zoneCounts(entries) {
  const by = {};
  for (const e of entries) { const k = zoneLabel(e.lead.zones); by[k] = (by[k] || 0) + 1; }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([z, n]) => `${z} ${num(n)}`).join(' · ');
}

// ============================================================================
// --board --inspect and the plan before the confirm
// ============================================================================
/** The real log's "did this account ever get this exact text?" (textLog.sentSameMessage), for --inspect; the run gets the same one from Assistant.js. */
const defaultSentSame = (accountId, c) => require('./textLog').sentSameMessage(accountId, 'text', { templateName: c.name, message: c.text });

function printTable(sum, cfg, copyNames) {
  console.log(`\n        ${pad('Stage', 18)}${pad('waiting for it', 16)}${pad('ready now', 12)}${pad('later today', 13)}${pad('reached today', 15)}text / email`);
  sum.per.forEach((p, i) => console.log(`     ${p.stage.byHand || p.stage.manual ? '✋' : '🤖'} ${pad(p.stage.label, 18)}${pad(num(p.next), 16)}${pad(num(p.ready), 12)}${pad(num(p.later), 13)}${pad(num(p.today), 15)}${copyNames[i]}`));
  console.log('     ✋ you do it by hand · 🤖 the board does it by itself');
  const notRun = [];
  const tot = (k) => sum.per.reduce((n, p) => n + p[k], 0);
  if (tot('paused')) notRun.push(`${num(tot('paused'))} asked us to stop (paused for good)`);
  if (tot('held')) notRun.push(`${num(tot('held'))} held (not started on their own)`);
  if (tot('old')) notRun.push(`${num(tot('old'))} older leads the board has not worked lately and that have not replied in the last 30 days (started over ${cfg.autoDays} days ago; --older includes them)`);
  if (tot('blocked')) notRun.push(`${num(tot('blocked'))} waiting for copy that is not written yet`);
  console.log(`\n     Finished all ${cfg.stages.length} stages: ${num(sum.finished)} · not run today: ${notRun.length ? notRun.join(' · ') : 'none'}`);
  if (sum.noAddress) console.log(`     ✉️ ${num(sum.noAddress)} lead(s) have no email address (the sender found none): their email stages are skipped and the texts go on`);
  for (const s of cfg.stages) if (s.byHand) console.log(`     ✋ ${s.label} is done by hand: the board never sends it, and a lead counts as having had it once it has had Text 1.`);
  { const man = cfg.stages.filter((s) => s.manual && !s.byHand), them = man.length > 1 ? 'them' : 'it'; if (man.length) console.log(`     ✋ ${man.map((s) => s.label).join(' and ')} ${man.length > 1 ? 'are' : 'is'} marked BY HAND too (Day 1 is all done by hand). That is a label only: the board still sends ${them} to the leads waiting at ${them} when a run picks ${man.length > 1 ? 'those stages' : 'that stage'}.`); }
  if (sum.replied) console.log(`     💬 ${num(sum.replied)} lead(s) have replied and stay in the cadence: only a "not interested" takes a lead out (the interested ones are on the dashboard's 🎯 Top hit list: node topHit.js)`);
}

/** → the lines of copy names per stage, for the table. */
function copyNamesOf(cfg, templates, emailSteps) {
  return cfg.stages.map((s) => { if (s.byHand) return 'BY HAND: the board skips it'; const c = cadence.copyOf(s, templates, emailSteps); const base = c ? (c.email ? `email touch ${c.touch}: ${c.name}` : `"${c.name}"`) : 'NOT WRITTEN YET (held)'; return s.manual ? `${base}  ✋ BY HAND (Day 1: you do it; the board still sends it if picked)` : base; });
}

/**
 * `email --board --inspect` / `--dry-run`: no browser, nothing sent. deps = { members, templates, emailSteps, now }.
 * Prints the stage table, who was reached today in Day 1 · Text 1, and what the run would do now.
 */
function inspect(flags, args, deps = {}) {
  if (flags.error) { console.log(`\n  ${flags.error}\n`); return null; }       // a mistyped flag (--trade …, --stage …) must not show the whole board as if it had been understood
  const t = deps.now ? deps.now() : new Date();
  const cfg = cadence.loadConfig(deps.cfgFile);
  if (flags.older) cfg.autoDays = Infinity;
  const templates = deps.templates || {}, emailSteps = deps.emailSteps || null;
  const copyFor = (s) => !!cadence.copyOf(s, templates, emailSteps);
  const sentSame = deps.sentSame !== undefined ? deps.sentSame : defaultSentSame;
  const env = { members: deps.members, cfg, copyFor, gotCopy: gotCopyFor((s) => cadence.copyOf(s, templates, emailSteps), sentSame), flags, tried: null };
  const leads = deps.members(t), refused = checkTrades(flags, leads);
  if (refused) { console.log(`\n  ${refused}\n`); return null; }
  const { all, auto } = look(env, t, leads), tn = tradesNote(flags, leads), sn = stagesNote(flags, cfg);
  const sum = summarize(all, auto, cfg, t);
  const names = copyNamesOf(cfg, templates, emailSteps);
  console.log(`\n  🗂 THE FOLLOW-UP BOARD — ${t.toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ZONE, timeZoneName: 'short' })}   (${cfg.stages.length} stages, read from our own log: no Shark report, no browser, nothing sent)`);
  if (tn) console.log(`\n  🏭 ONLY THESE INDUSTRIES (--trade): ${tn.text}. Everything below counts just those leads.`);
  if (sn) console.log(`\n  🎯 ONLY THESE STAGES (--stage): ${sn.text}. "Ready now" and "later today" below count just these.`);
  printTable(sum, cfg, names);

  const today = all.filter((e) => e.sentToday.includes('d1t1'));
  console.log(`\n  ✅ WHO WE ALREADY TEXTED TODAY IN STAGE 1 (Day 1 · Text 1): ${num(today.length)} lead(s)${today.length ? ` — ${zoneCounts(today)}` : ''}`);
  const showAll = process.argv.includes('--all');
  const sorted = today.slice().sort((a, b) => Date.parse(b.doneAt.d1t1) - Date.parse(a.doneAt.d1t1));
  (showAll ? sorted : sorted.slice(0, 12)).forEach((e) => console.log(`       ${clock(e.doneAt.d1t1).padEnd(11)} ${pad(e.lead.name, 40).slice(0, 40)} ${zoneLabel(e.lead.zones).padEnd(8)} next: ${e.next ? e.next.label + (e.dueNow ? ' (ready)' : e.readyAt ? ` (ready ${clock(e.readyAt)})` : '') : 'finished'}`));
  if (!showAll && sorted.length > 12) console.log(`       … and ${num(sorted.length - 12)} more (add --all to list them all)`);

  const ready = auto.filter((e) => e.dueNow);
  const texts = ready.filter((e) => e.next.ch === 'text'), mails = ready.filter((e) => e.next.ch === 'email');
  console.log(`\n  ⏰ READY RIGHT NOW (their own window is open): ${num(texts.length)} text(s) and ${num(mails.length)} email(s)${ready.length ? ` — ${zoneCounts(ready)}` : ''}`);
  const end = endOfRunDay(t).getTime();
  const later = auto.filter((e) => !e.dueNow && e.opensAt && Date.parse(e.opensAt) < end);
  if (later.length) console.log(`     and ${num(later.length)} more become ready later today (a gap ends or a window opens) — the same run picks them up`);
  const textSec = DEFAULTS.textSec + (args && args.noReview ? 0 : DEFAULTS.checkSec);      // (with the enrollment + opportunities check before each text, unless --nocheck)
  const estMin = Math.round((texts.length * textSec + mails.length * DEFAULTS.emailSec) / 60);
  if (ready.length) console.log(`     about ${span(estMin * 60000)} for what is ready now (texts ~${textSec} s each${args && args.noReview ? '' : ' with the enrollment + opportunities check'}, emails ~${DEFAULTS.emailSec} s each)`);
  const fl = [tn && tn.flag, sn && sn.flag].filter(Boolean).join(' '), tflag = fl ? ` ${fl}` : '';
  const asks = [!tn && 'general or industry specific', !sn && 'which stage'].filter(Boolean);      // what the Terminal would still ask: a flag already given answers its question
  console.log(`\n     Run it:  email --board${tflag}${fl ? '  ' : '                       '}(it asks ${asks.length ? `${asks.join(' and ')}, then ` : ''}one confirm, then it runs by itself until nothing more can go out today)`);
  console.log(`     Small first:  email --board${tflag} --max-texts 15 --max-emails 3${sn ? '' : `      ·  one stage:  email --board${tflag} --stage d1t2`}\n`);
  return { sum, all, auto };
}

// ============================================================================
// Lock + heartbeat + notifications
// ============================================================================
let lockHooked = false;
function acquireLock(log = defaultLog) {
  const cur = readJson(FILES.lock, null);
  if (cur && cur.pid && cur.pid !== process.pid) {
    let alive = false; try { process.kill(cur.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    const since = Date.parse(cur.since);
    let upMs = Infinity; try { upMs = require('os').uptime() * 1000; } catch (_) {}
    const beforeBoot = Number.isFinite(since) && Date.now() - since > upMs + 60000;      // written before the last restart of the Mac: that pid is some other program now
    if (alive && !beforeBoot) {
      const st = readJson(FILES.status, {}) || {};
      log('⛔', 'Already running', `a board run is already going (pid ${cur.pid}, started ${cur.since || '?'}${st.updatedAt ? `, last heartbeat ${span(Date.now() - Date.parse(st.updatedAt))} ago` : ''}). Nothing was started.`);
      return false;
    }
  }
  try { writeJson(FILES.lock, { pid: process.pid, since: new Date().toISOString() }); } catch (_) {}
  if (!lockHooked) { lockHooked = true; process.once('exit', releaseLock); }
  return true;
}
function releaseLock() { try { const cur = readJson(FILES.lock, null); if (cur && cur.pid === process.pid) fs.unlinkSync(FILES.lock); } catch (_) {} }
function notifyMac(msg, title = 'Pipeline Assistant follow-up board') {
  try { process.stdout.write('\x07'); } catch (_) {}
  if (process.platform !== 'darwin') return;
  try { require('child_process').execFile('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title ${JSON.stringify(title)} sound name "Glass"`], () => {}); } catch (_) {}
}

// ============================================================================
// The run
// ============================================================================
/**
 * o = { flags, args, cfg, members(t), templates, emailSteps, now(), wait(ms), log, ask, session, sendTexts(batch), sendEmails(batch), emailBudget(), notify(msg), until, maxTexts, maxEmails,
 *       yes, dry, noSignals, noKeepAwake, noStatus, askScope, askStage }      (askScope: ask "general or industry specific?" before the plan: only for a person at the Terminal, never with --trade, --yes or --dry-run;
 *                                                                              askStage: then ask "which stage?" (0 = every stage): the same, never with --stage, --yes or --dry-run)
 * sendTexts / sendEmails({ stage, copy, leads: [{ name, accountId, url, lastOutgoingSms, source, entry }], shouldStop(), onSent(lead) }) → resolves when the batch ends.
 * → { texted, emailed, passes, aborted?, nothing? }
 */
async function runBoard(o) {
  const now = o.now || (() => new Date()), wait = o.wait || sleep, log = o.log || defaultLog, notify = o.notify || notifyMac;
  const flags = o.flags || parseFlags([]), session = o.session;
  const cfg = o.cfg || cadence.loadConfig();
  if (flags.older) cfg.autoDays = Infinity;
  const templates = o.templates || {}, emailSteps = o.emailSteps || null;
  const copyOf = (s) => cadence.copyOf(s, templates, emailSteps);
  const copyFor = (s) => !!copyOf(s);
  const D = { ...DEFAULTS, ...(o.defaults || {}) };
  const maxTexts = o.maxTexts || Infinity, maxEmails = flags.maxEmails || o.maxEmails || Infinity;

  // The run's memory of what it already tried today: a lead whose stage did not go out after we started on it is tried once more later, then left for tomorrow.
  const triedMap = new Map();
  const keyOf = (e, t) => `${k15(e.lead.accountId)}|${e.next ? e.next.id : ''}|${cadence.dayOf(t, ZONE)}`;
  const tried = {
    gaveUp: (e, t) => { const r = triedMap.get(keyOf(e, t)); return !!r && r.n >= D.maxTries; },
    notBefore: (e, t) => { const r = triedMap.get(keyOf(e, t)); return r && r.notBefore ? r.notBefore : 0; },
    charge: (e, t) => { const k = keyOf(e, t), r = triedMap.get(k) || { n: 0 }; r.n++; r.notBefore = t.getTime() + D.retryAfterMs; triedMap.set(k, r); },
  };
  const env = { members: o.members, cfg, copyFor, gotCopy: gotCopyFor(copyOf, o.sentSame), flags, tried };

  // ---- the plan, then one confirm ---------------------------------------------------------------------------------------------------------------------------------------------
  const t0 = now();
  const runDay = cadence.dayOf(t0, ZONE);                       // the Eastern day this run was started on: it ends with it (Hawaii and Alaska leads after midnight are tomorrow's)
  const leads0 = o.members(t0), refused = checkTrades(flags, leads0);       // --trade names an industry that is not on the board: refused before anything is shown or sent
  if (refused) { console.log(`\n  ${refused}\n`); return { refused: true, texted: 0, emailed: 0, passes: 0 }; }
  let first = look(env, t0, leads0), tn = tradesNote(flags, leads0), pickedHere = false, pickedStageHere = false;
  // GENERAL or INDUSTRY SPECIFIC? Asked only of a person at the Terminal (`askScope`), and only when the run was not already narrowed with --trade; --yes and --dry-run never ask. An industry pick is the
  // same filter as --trade (flags.trades), so the table, the confirm and every pass of the loop below work only those industries.
  if (o.askScope && !flags.trades && !o.yes && !o.dry && first.auto.length) {
    const pick = await chooseScope({ ask: o.ask, say: console.log, leads: leads0, auto: first.auto });
    if (pick.aborted) { log('🛑', 'Mission aborted', 'Nothing sent'); return { aborted: true, texted: 0, emailed: 0, passes: 0 }; }
    if (pick.trades) { flags.trades = pick.trades; first = look(env, t0, leads0); tn = tradesNote(flags, leads0); pickedHere = true; }
  }
  // WHICH STAGE? Asked next, of the same person at the Terminal (`askStage`), and only when the run was not already narrowed with --stage; --yes and --dry-run never ask. The numbers shown are for the industries picked above.
  // A stage pick is the same filter as --stage (flags.stages), so the table, the confirm and every pass of the loop below work only those stages; 0 or Enter changes nothing (every stage, as before).
  if (o.askStage && !flags.stages && !o.yes && !o.dry && first.auto.length) {
    const choices = stageChoices(summarize(first.all, first.auto, cfg, t0), copyNamesOf(cfg, templates, emailSteps), flags, copyFor);
    const pick = await chooseStage({ ask: o.ask, say: console.log, choices });
    if (pick.aborted) { log('🛑', 'Mission aborted', 'Nothing sent'); return { aborted: true, texted: 0, emailed: 0, passes: 0 }; }
    if (pick.stages) { flags.stages = pick.stages; first = look(env, t0, leads0); pickedStageHere = true; }
  }
  const sn = stagesNote(flags, cfg);
  const sum = summarize(first.all, first.auto, cfg, t0);
  const names = copyNamesOf(cfg, templates, emailSteps);
  log('🗂', 'Board', `${num(sum.total)} leads · ${num(first.auto.length)} can be worked today`);
  if (tn) log('🏭', 'Industries', `ONLY ${tn.text} (${pickedHere ? 'industry specific' : '--trade'}): nobody else is texted or emailed by this run`);
  if (tn && pickedHere) log('💡', 'Skip the question', `to go straight to these industries next time, add ${tn.flag}  (email --board ${tn.flag})`);
  if (sn) log('🎯', 'Stages', `ONLY ${sn.text} (${pickedStageHere ? 'stage picked' : '--stage'}): the other stages are left alone by this run`);
  if (sn && pickedStageHere) log('💡', 'Skip the question', `to go straight to ${sn.ids.length > 1 ? 'these stages' : 'this stage'} next time, add ${sn.flag}  (email --board ${[tn && tn.flag, sn.flag].filter(Boolean).join(' ')})`);
  printTable(sum, cfg, names);
  const readyNow = first.auto.filter((e) => e.dueNow);
  const laterToday = first.auto.filter((e) => !e.dueNow && e.opensAt && Date.parse(e.opensAt) < endOfRunDay(t0).getTime());
  console.log(`\n     Ready right now: ${num(readyNow.filter((e) => e.next.ch === 'text').length)} text(s), ${num(readyNow.filter((e) => e.next.ch === 'email').length)} email(s)${readyNow.length ? ` (${zoneCounts(readyNow)})` : ''} · becoming ready later today: ${num(laterToday.length)}`);
  const caps = [Number.isFinite(maxTexts) ? `${num(maxTexts)} texts` : null, Number.isFinite(maxEmails) ? `${num(maxEmails)} emails` : null].filter(Boolean);
  if (caps.length) console.log(`     This run stops after ${caps.join(' and ')}.`);
  else console.log(`     ⚠️  NO CAP on this run (no --max-texts / --max-emails): it works through everything that is ready today, ${num(readyNow.filter((e) => e.next.ch === 'text').length)} text(s) and ${num(readyNow.filter((e) => e.next.ch === 'email').length)} email(s) right now and more as windows open.`);
  if (o.enrollCheck === true) console.log('     🔎 Each account is looked up in Salesforce right before its text: one that has enrolled since we last looked (Customer Status) is NOT texted and leaves the board, and neither is one with a Closed Won opportunity in the last ' + require('./closedWonWindow').WON_FLAG_DAYS + ' days (any rep, the free Invoicing and Payments sign-up excepted; read off the account page): that one goes on the 🤝 Current customers tab with the opportunity\'s name. The emails check Customer Status the same way. (--nocheck skips the lookup before texts.) The board does not read the SMS thread before a text.');
  else if (o.enrollCheck === false) console.log('     ⚠️  NO enrollment or opportunities check before the texts (--nocheck): a lead that enrolled since we last looked, or that another rep closed, could still be texted. The emails still check Customer Status.');
  if (!first.auto.length) { log('ℹ️', 'Nothing to do', 'no lead can be texted or emailed today.'); return { nothing: true, texted: 0, emailed: 0, passes: 0 }; }
  if (o.dry) { console.log(`\n  🧪 --dry-run: nothing was sent. To run it for real:  email --board${tn ? ` ${tn.flag}` : ''}${sn ? ` ${sn.flag}` : ''}\n`); return { dry: true, texted: 0, emailed: 0, passes: 0 }; }
  if (!o.yes) {
    const ans = String(await o.ask(`\n  ▶️  Work the follow-up board${tn ? ` (ONLY ${tn.names.join(', ')})` : ''}${sn ? ` (ONLY ${sn.text})` : ''}${caps.length ? ` (stops after ${caps.join(' and ')})` : ' (NO CAP)'} now, with nobody at the computer? It texts and emails each lead its next stage inside THEIR OWN hours, and ends when nothing more can go out today. (y/N) `)).toLowerCase();
    if (ans !== 'y' && ans !== 'yes') { log('🛑', 'Mission aborted', 'Nothing sent'); return { aborted: true, texted: 0, emailed: 0, passes: 0 }; }
  }
  log('🔒', 'Leave running', 'this Terminal tab and the Chrome window (it repairs itself if it crashes or a tab closes); the Mac stays awake. Ctrl-C stops after the one it is on.');
  if (!o.noKeepAwake && process.platform === 'darwin') { try { spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); log('☕', 'Keep awake', 'the Mac stays awake while this runs'); } catch (_) {} }

  let stop = false;
  const onInt = () => { if (stop) process.exit(130); stop = true; log('🛑', 'Stopping', 'after the one it is on (Ctrl-C again quits now)'); };
  if (!o.noSignals) process.on('SIGINT', onInt);

  let texted = 0, emailed = 0, passes = 0, recoveries = 0, attention = null, lastHealth = now().getTime(), lastKeep = now().getTime(), emailsCapped = false, errStreak = 0;
  const byStage = {};
  const beat = (state, note, extra = {}) => { if (o.noStatus) return; try { writeJson(FILES.status, { ...(readJson(FILES.status, {}) || {}), state: attention ? 'needs-attention' : state, note: attention || note, texted, emailed, passes, recoveries, byStage, pid: process.pid, updatedAt: now().toISOString(), ...extra }); } catch (_) {} };
  const told = new Map();
  const tell = (msg) => { const tt = now().getTime(); if (!(told.has(msg) && tt - told.get(msg) < 60 * 60000)) { told.set(msg, tt); try { notify(msg); } catch (_) {} } };

  async function ensureReady(why) {
    let h;
    try { h = await session.health(); } catch (e) { h = { ok: false, kind: 'tab', why: e.message }; }
    if (h.ok) { attention = null; return true; }
    for (let attempt = 1; attempt <= 3 && !h.ok; attempt++) {
      recoveries++;
      log('🛠️', 'Repairing', `${h.why} (${why}) — attempt ${attempt}`);
      try { h = await session.recover(h.kind); } catch (e) { h = { ok: false, kind: h.kind, why: e.message }; }
      if (!h.ok && h.kind === 'login') break;                                    // only a person can sign in
    }
    if (h.ok) { attention = null; log('✅', 'Repaired', 'Chrome and Salesforce are back'); beat('working', 'repaired'); return true; }
    attention = h.kind === 'login' ? `Salesforce is signed out — sign in to the Chrome window on port ${PORT}. The run carries on by itself once you do.` : `could not repair: ${h.why}`;
    log('⛔', 'Needs you', attention);
    beat('needs-attention', attention); tell(`Follow-up board needs you: ${attention}`);
    return false;
  }
  async function tick(why) {
    const tt = now().getTime();
    if (tt - lastHealth >= D.healthEveryMs) { lastHealth = tt; await ensureReady(why); }
    if (tt - lastKeep >= D.keepAliveEveryMs) { lastKeep = tt; try { await session.keepAlive(); } catch (_) {} }
  }

  const emailBudget = () => (o.emailBudget ? o.emailBudget() : Infinity);
  try {
    beat('working', 'confirmed', { startedAt: now().toISOString() });
    while (!stop) {
      let t = now();
      if (cadence.dayOf(t, ZONE) !== runDay) { log('🌙', 'Day over', 'it is past midnight Eastern: this run ends here (start it again tomorrow; the log is the state)'); break; }
      if (o.until && t >= o.until) { log('🛑', 'Until', `reached ${clock(o.until)} — stopping`); break; }
      if (texted >= maxTexts && emailed >= maxEmails) { log('🧢', 'Cap reached', `${num(texted)} text(s) and ${num(emailed)} email(s) sent, as asked`); break; }
      await tick('while waiting');
      if (stop) break;
      t = now();                                                 // a repair above can take minutes: the board is looked at as it is NOW
      const { auto } = look(env, t);
      const budgetLeft = emailBudget();
      if (budgetLeft <= 0 && !emailsCapped) { emailsCapped = true; log('🚦', 'Email cap', 'the daily email cap is reached: no more emails today (texts carry on)'); }
      const canText = texted < maxTexts, canMail = emailed < maxEmails && budgetLeft > 0;
      const due = auto.filter((e) => e.dueNow && tried.notBefore(e, t) <= t.getTime() && ((e.next.ch === 'text' && canText) || (e.next.ch === 'email' && canMail)))
        .sort((a, b) => closeAt(a.lead.zones, t) - closeAt(b.lead.zones, t) || a.nextIdx - b.nextIdx || String(a.readyAt || '').localeCompare(String(b.readyAt || '')));
      if (!due.length) {
        // nothing to send this minute: the next gap or window of a lead that can still go today, or the end
        const end = endOfRunDay(t).getTime();
        const waits = (e) => (!e.dueNow || tried.notBefore(e, t) > t.getTime()) && e.opensAt && Math.max(Date.parse(e.opensAt), tried.notBefore(e, t)) < end && ((e.next.ch === 'text' && canText) || (e.next.ch === 'email' && canMail));
        const upcoming = auto.filter(waits).map((e) => Math.max(Date.parse(e.opensAt), tried.notBefore(e, t)));
        const pending = auto.filter((e) => e.dueNow).length;       // ready but capped / over the budget: nothing to wait for
        if (!upcoming.length) { log('🏁', 'Done for today', pending ? 'what is left is over a cap' : 'nobody else can be texted or emailed today'); break; }
        const next = Math.min(...upcoming);
        beat('waiting', `next: ${clock(new Date(next))}`);
        await wait(Math.max(1000, Math.min(D.pollMs, next - t.getTime() + 1000)));
        continue;
      }

      // one batch: the first lead's stage, up to batchSize leads in the same stage (the ones whose window closes soonest first)
      const stage = due[0].next;
      const room = stage.ch === 'text' ? maxTexts - texted : maxEmails - emailed;
      const batch = due.filter((e) => e.next.id === stage.id).slice(0, Math.max(1, Math.min(D.batchSize, room, stage.ch === 'email' ? Math.max(1, budgetLeft) : Infinity)));
      const copy = copyOf(stage);
      if (!(await ensureReady('before a batch'))) { await wait(Math.min(D.troubledWaitMs, D.pollMs)); continue; }
      passes++;
      log(stage.ch === 'text' ? '💬' : '✉️', stage.label, `${batch.length} lead(s) — ${zoneCounts(batch)}`);
      beat('sending', `${stage.label}: ${batch.length} lead(s)`);

      let reached = 0, abandoned = false, capStop = false, progressAt = Date.now(), ticks = 0;
      const touch = () => { progressAt = Date.now(); };
      const hooks = {
        shouldStop: () => {
          touch();
          const capped = stage.ch === 'text' ? texted >= maxTexts : emailed >= maxEmails;
          if (capped) capStop = true;
          const s = stop || abandoned || capped || (o.until && now() >= o.until);
          if (!s) reached++;
          return !!s;
        },
        onSent: () => { touch(); byStage[stage.id] = (byStage[stage.id] || 0) + 1; if (stage.ch === 'text') texted++; else emailed++; beat('sending', `${num(texted)} texted · ${num(emailed)} emailed`); },
      };
      const leads = batch.map((e) => ({ name: e.lead.name, accountId: e.lead.accountId, url: e.lead.url || undefined, lastOutgoingSms: e.lead.lastOutgoingSms || null, source: sourceOf(e.lead), entry: e }));
      let timer; const frozen = new Promise((resolve) => {
        timer = setInterval(() => {
          if (Date.now() - progressAt > D.stallMs) { abandoned = true; resolve(true); }
          else if (++ticks % 3 === 0) beat('sending', `${stage.label}: ${num(texted)} texted · ${num(emailed)} emailed so far`);
        }, Math.max(20, Math.min(5000, Math.floor(D.stallMs / 4))));
      });
      let outcome;
      const sender = stage.ch === 'text' ? o.sendTexts : o.sendEmails;
      try { outcome = await Promise.race([Promise.resolve().then(() => sender({ stage, copy, leads, ...hooks })).then((res) => ({ res })), frozen.then(() => ({ frozen: true }))]); }
      catch (e) { outcome = { err: e }; }
      finally { clearInterval(timer); }
      // The Texts composer stayed under its loading spinner on several accounts in a row (clickGuard waits for it): the Chrome or its Salesforce session is the problem, not the leads. Stop and say so —
      // trying the same leads again would only repeat it, and the leads before the last one in a broken-off batch are not even charged a try.
      if (outcome.res && outcome.res.composerStuck) {
        attention = `${stage.label}: the Texts composer stayed under its loading spinner on ${outcome.res.composerStuck} accounts in a row, so nothing could be typed (nothing was sent). Look at the board's Chrome window and compose-failures/, then run email --board again.`;
        log('⛔', 'Stopping', attention); tell(`Follow-up board: ${attention}`); beat('needs-attention', attention); break;
      }
      if (outcome.frozen) {
        log('🧊', 'Frozen tab', `no answer for ${span(D.stallMs)} — the tab is replaced and the batch goes on`);
        tell('Follow-up board: the Salesforce tab froze — replacing it, the rest carries on');
        await ensureReady('frozen tab'); try { await session.recover('tab'); } catch (_) {}
      } else if (outcome.err) {
        log('⚠️', 'Batch failed', outcome.err.message);
        await ensureReady('after a failed batch');
      }
      // Whoever the sender started on and did not complete is charged a try (a lead it never got to is not).
      const after = look(env, now());
      const doneNow = new Set(after.all.filter((x) => x.done.includes(stage.id)).map((x) => k15(x.lead.accountId)));
      const troubled = !!(outcome.frozen || outcome.err) || (reached < batch.length && !stop && !capStop && !(o.until && now() >= o.until));   // it broke off by itself (10 failures in a row, the contact guard offline …)
      const failedAtOnce = !!outcome.err && reached === 0;       // it threw before it started on ANY lead (a ledger file it cannot read, a lock …): every pass would fail the same way
      if (failedAtOnce) errStreak++; else if (reached > 0 && !outcome.err && !outcome.frozen) errStreak = 0;
      const started = troubled ? batch.slice(Math.max(0, reached - 1), Math.max(1, reached)) : batch.slice(0, reached);
      for (const e of started) if (!doneNow.has(k15(e.lead.accountId))) tried.charge(e, now());
      if (troubled && !outcome.frozen && !outcome.err) { log('⚠️', 'Ended early', `${stage.label}: the sender stopped after ${reached} of ${batch.length}; the rest is tried again shortly`); await wait(D.troubledWaitMs); }
      if (failedAtOnce) {
        const why = `${stage.label} could not start: ${outcome.err.message}`;
        tell(`Follow-up board: ${why} (failure ${errStreak} of ${D.maxEarlyFailures})`);
        if (errStreak >= D.maxEarlyFailures) { attention = `${why}. It failed ${errStreak} passes in a row, so the run stopped. Fix that, then run email --board again.`; log('⛔', 'Stopping', attention); beat('needs-attention', attention); break; }
        await wait(D.troubledWaitMs * errStreak);               // backs off: 1, 2, 3 … minutes
      }
      await wait(D.passGapMs);
    }
  } finally {
    if (!o.noSignals) process.removeListener('SIGINT', onInt);
  }
  const summary = { texted, emailed, passes, byStage, recoveries, stopped: stop, ...(attention ? { attention } : {}) };
  beat('finished', `${num(texted)} texted, ${num(emailed)} emailed`, { finishedAt: now().toISOString() });
  if (!o.noStatus) { try { fs.appendFileSync(FILES.history, JSON.stringify({ at: now().toISOString(), ...summary }) + '\n'); } catch (_) {} }
  log('🏁', 'Finished', `${num(texted)} text(s) and ${num(emailed)} email(s) sent today by this run${Object.keys(byStage).length ? ` (${Object.entries(byStage).map(([id, n]) => `${(cfg.stages.find((s) => s.id === id) || {}).label || id}: ${n}`).join(' · ')})` : ''}`);
  return summary;
}

/** The list a lead's log rows are filed under: Shark when it is on a Shark list, else LDS; a lead only #tagged by hand gets none. */
function sourceOf(lead) {
  const kind = (lead.kinds || []).includes('Shark') ? 'Shark' : (lead.kinds || [])[0] || null;
  return kind ? { kind, name: `Follow-up board (${kind})` } : null;
}

// ============================================================================
// The entry point Assistant.js calls (with the pieces it owns)
// ============================================================================
/**
 * The options one board text batch hands to runReportCampaign (a function of its own so a test can look at exactly what goes to the sender).
 * No thread read (Luke, 2026-11-03): the board does not open the Texts thread to look for a reply or a teammate's text before it types, so `threadGuard` is null for every stage (DEFAULTS.threadRead = true brings back the old read for
 * Text 2 and later: threadGuard 'normal', as --same-day does: a reply from the pro, or a teammate's text in 48 h, holds the send and is saved in the hold inbox). What still keeps a replied lead from being texted is `cadence.members()`:
 * the reply log, the hold inbox as it already stands, the banlist. `ignoreSms` is on for EVERY board text (Luke, 2026-11-04: "for teammate texted, we do not need to pause those from our outreach cadence"): the report's "last SMS" column cannot tell OUR earlier text from a teammate's, and a teammate's text is no reason to wait (Text 1 used to keep the report's 48 h guard, which skipped exactly those leads). Turning DEFAULTS.threadRead back on would bring back a hold for a teammate's text AND one for an unanswered reply, both against his rules: it needs a thread mode of its own first.
 * `precheck` = the enrollment + opportunities check (enrollCheck.js), run for each lead right before its text; left out with --nocheck. For the stages in DEFAULTS.noCheckStages (Day 1 · Text 2) it is left out only for a lead whose
 * Text 1 the board sent today (it was looked at hours ago): a Text 2 for a Text 1 from an earlier day, or one sent by another mode (the queue run does no look), is looked at as always.
 */
function textOptions({ args, stage, copy, leads, shouldStop, onSent, createTemplateKey, precheck }) {
  const mayGo = DEFAULTS.noCheckStages.includes(stage.id);      // a stage whose text may go without the look
  const look = !precheck ? null : !mayGo ? precheck : DEFAULTS.noCheckAfterBoardText1Today ? async (lead) => (boardText1Today(lead) ? { ok: true, skipCustomerCheck: true } : precheck(lead)) : null;
  return {
    start: 1, end: null, delayMs: args.delayMs, force: false, message: copy.text, templateName: copy.name, templateKey: createTemplateKey('text', copy.name, copy.text),
    leads, source: null, mode: 'board', tcpa: true, tcpaUnknown: args.unknownZone === 'hold' ? 'hold' : 'strict', tcpaMarginMs: DEFAULTS.closeMarginMs, sameDay: !!stage.sameDay,
    threadGuard: DEFAULTS.threadRead && stage.n > 1 ? 'normal' : null, ignoreSms: true, shouldStop, onSent,      // (no `step`: that is the follow-up's own counter, and a text 1 logged as step 1 would read as "Follow-up 1 already sent")
    ...(look ? { precheck: look } : { skipCustomerCheck: true }),      // no look at all (--nocheck, the no-look stage): not even the Customer Status look every other text makes inside textAccount
  };
}

/**
 * Did the BOARD send this lead's Text 1 today? `lead.entry` = its board entry (cadence.evaluate: `sentToday`, `doneAt`, the lead's touches). Only a text of mode 'board' was looked at (enrollCheck.js) right before it went out:
 * a Text 1 from the queue run (`--shark --send`), `--report` or any other mode never was. An entry that says nothing is "no": the lead is looked at.
 */
function boardText1Today(lead) {
  const e = lead && lead.entry;
  if (!e || !Array.isArray(e.sentToday) || !e.sentToday.includes('d1t1') || !e.doneAt || !e.doneAt.d1t1) return false;
  const touches = (e.lead && e.lead.touches) || [];
  return touches.some((t) => t && t.ch === 'text' && t.mode === 'board' && t.at === e.doneAt.d1t1);      // doneAt.d1t1 = the `at` of the lead's first text: that very touch must be a board text
}

async function runBoardMode(context, initialPage, args, api) {
  const { commandLog: log, ask, runReportCampaign, runEmailCampaign, createTemplateKey, TEMPLATES, CONFIG, textLog, parseUntil, emailSequence, emailsSentToday } = api;
  const flags = parseFlags(process.argv.slice(2));
  if (flags.error) { console.log(`\n  ${flags.error}\n`); return; }
  if (args.check && args.noReview) { console.log('\n  --check and --nocheck contradict each other: --check looks each lead up in Salesforce for enrollment right before its text, --nocheck does not. Pick one (no flag = check). Nothing was started.\n'); return; }
  const enrollOn = !args.noReview;                           // the enrollment check before each text is ON unless --nocheck (the emails always check the same thing)
  if (!args.dryRun && !acquireLock(log)) return;             // (Assistant.js already took it before touching the browser: the same process, so a no-op there)
  const { createSession } = require('./eveningShark');
  let session = null;
  try {
    session = createSession({ context, page: null, startUrl: CONFIG.startUrl, port: PORT, profileDir: PROFILE_DIR });
    const cfgNow = cadence.loadConfig();
    const members = (t) => cadence.members({ textLog, now: t, startNewLds: false });
    const precheck = enrollOn ? require('./enrollCheck').makeCheck({ getPage: () => session.page(), accountLoadMs: CONFIG.accountLoadMs, startUrl: CONFIG.startUrl, log }) : null;
    const sendTexts = async ({ stage, copy, leads, shouldStop, onSent }) => runReportCampaign(session.page(), textOptions({ args, stage, copy, leads, shouldStop, onSent, createTemplateKey, precheck }));
    // An email batch takes ~75 s a lead, so each lead's own hours are checked as the sender reaches it (the text sender does the same), with the same margin before the close.
    const sendEmails = async ({ stage, copy, leads, shouldStop, onSent }) => runEmailCampaign(session.page(), leads.map((l) => ({ ...l, wantStep: stage.n, wantTemplate: stage.emailTemplate || null })), {
      start: 1, end: leads.length, delayMs: args.delayMs, force: false, dryRun: false, templateName: 'Follow-up board', sequence: true, minDays: 0, ignoreReplies: true, source: null, shouldStop, onSent,
      canSend: (lead) => hoursReason(lead.entry && lead.entry.lead ? lead.entry.lead.zones : null),
    });
    const delay = Number.isFinite(args.delayMs) ? args.delayMs : 0;
    return await runBoard({
      flags, args, cfg: cfgNow, members, templates: TEMPLATES, emailSteps: emailSequence ? emailSequence.STEPS : null, ask, log,
      session, sendTexts, sendEmails, emailBudget: () => Math.max(0, CONFIG.emailMaxPerDay - emailsSentToday()),
      sentSame: (accountId, c) => textLog.sentSameMessage(accountId, 'text', { templateName: c.name, message: c.text }),
      defaults: { stallMs: Math.max(DEFAULTS.stallMs, 3 * delay + 120000) },      // a long --delay between two leads must not look like a frozen tab (the evening run scales it the same way)
      until: args.until && parseUntil ? parseUntil(args.until) : null, maxTexts: args.maxTexts || null, yes: !!args.yes, dry: !!args.dryRun, enrollCheck: enrollOn,
      askScope: !!process.stdin.isTTY,      // "general or industry specific?" is asked of a person at the Terminal (not a piped / scheduled run, not with --trade or --yes)
      askStage: !!process.stdin.isTTY,      // and so is "which stage?" (not with --stage or --yes; 0 / Enter = every stage)
    });
  } finally {
    if (session) { try { await session.close(); } catch (_) {} }       // a Chrome relaunch opens a link of its own that Assistant.js does not close
    releaseLock();
    setTimeout(() => process.exit(0), 15000).unref();                  // and if anything else still holds the process 15 s after the run ended, let go of it anyway
  }
}

module.exports = { PORT, PROFILE_DIR, FILES, DEFAULTS, parseFlags, look, summarize, inspect, runBoard, runBoardMode, textOptions, acquireLock, releaseLock, closeAt, endOfRunDay, sourceOf, zoneLabel, hoursReason, gotCopyFor, tradeKey, leadTrade, tradesOnBoard, checkTrades, tradesNote, parseScopeAnswer, tradeChoices, parseTradePick, chooseScope, stagesNote, stageChoices, parseStagePick, chooseStage };
