'use strict';

/**
 * autoDraft — the --auto pipeline, as a step any campaign can use.
 *
 * For ONE account it FIRST reads Customer Status (beta) and leaves a current customer alone ("Enrolled: Current Customer" and the other Enrolled statuses, unless the account is only on the free
 * Invoicing and Payments plan: enrollCheck.js), then reads Salesforce (the opportunities, the rep's own Granola note, the last notes: salesforceReview.buildEvidence), leaves out what must not be contacted (Closed Won in
 * the last 30 days, do-not-contact, every opportunity closed out), has Claude write an email, a text and a phone script from what it read, checks every claim in code (autoPlan.makePlan)
 * and saves the game plan. It sends nothing itself.
 *
 *   email --auto    both kinds, to the accounts of the dashboard's LDS tab or a report ......... Assistant.js runAuto
 *   email           the email campaign: each account's email is written this way, only the email is sent ... draftAndSend(…, 'email'), called from the --email block
 *   email --text    the text campaign off a list view: the same, only the text is sent ............... runAutoText
 *
 * The plain campaigns use it when Settings has Claude drafts on (wordingFor says when): off by default (templates). --no-auto forces templates; --message / --template / --email-template / --subject / --body-file mean the
 * rep chose the wording; the sequences (--sequence, --core), --library, --blast and --never-emailed have their own; a text campaign off a report keeps its templates.
 * Nothing is sent before the rep has seen every draft: they are printed, then there is one question (y/N; --yes skips it). A draft that fails the checks (needs-review, error) is never sent.
 *
 * Everything this file needs from outside (the logger, the prompt, the Salesforce and Claude steps, the two campaign loops) comes in through `deps`, so it loads without a browser and the
 * whole flow can be tried with stand-ins:
 *   deps = { commandLog, ask, textLog, sfReview, autoPlan, tcpa, sfId, ensureZone, noteClosedWon, sendTexts, sendEmails,
 *            checkCustomer(page, lead) → { ok, customer?, status?, reason?, unverified?, released?, why? }   (optional: without it no Customer Status check is made here;
 *            the texts that go out are looked at again inside textAccount, and every email inside emailAccount) }
 */

// ---------------------------------------------------------------------------------------------
// Who gets auto wording
// ---------------------------------------------------------------------------------------------
/**
 * Should this plain email / text campaign write each message from the account's notes and opportunities?
 * OFF by default (templates only). Turn on in Settings: `zw --settings` → Claude drafts → on.
 * Also off, with the reason (for the log line), when: --no-auto; the rep chose the wording (--message, --template,
 * --email-template, --subject, --body-file); the mode has its own wording (--sequence / --core, --library, --blast,
 * --never-emailed); or it is a text campaign off a report (those keep their templates). → { on, why }
 */
function wordingFor(args, channel, { isReport = false } = {}) {
  const off = (why) => ({ on: false, why });
  if (args.noAuto) return off('--no-auto');
  if (channel === 'email') {
    if (args.sequence || args.core) return off("--sequence / --core send the cadence's own emails");
    if (args.library) return off('--library picks its own content');
    if (args.blast) return off('--blast sends one email to everybody');
    if (args.neverEmailed) return off('--never-emailed sends one named email');
    if (args.emailTemplate || args.subject || args.bodyFile) return off('--email-template / --subject / --body-file pick the wording');
  } else {
    if (isReport) return off('a text campaign off a report keeps its templates');
    if (args.message || args.template) return off('--message / --template pick the wording');
  }
  let claudeOn = false;
  try { claudeOn = !!require('./senderSetup').claudeDraftsOn(); } catch (_) { claudeOn = false; }
  if (!claudeOn) return off('Claude drafts are off — turn them on in Settings (S → Claude drafts → on)');
  return { on: true, why: '' };
}

// ---------------------------------------------------------------------------------------------
// What a run prints about the Salesforce reading
// ---------------------------------------------------------------------------------------------
/** The dedicated "original demo" block: who ran the demo and when (so Luke can reference them). */
function printOriginalDemo(o) {
  const fmt = (iso) => { const d = new Date(iso + 'T12:00:00'); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  console.log('\n  🎯 ORIGINAL DEMO');
  if (!o) { console.log('       (no rep or demo found)'); return; }
  console.log(`       Original Sales Rep on Demo:  ${o.repName ? `${o.repName}   (${o.repSource})` : 'not found'}`);
  console.log(`       Date of Original Demo:       ${o.date ? `${fmt(o.date)}   (${o.dateSource})` : `not confirmed${o.oppCloseDate ? `   (opportunity close date ${o.oppCloseDate} is shown, not used as a demo date)` : ''}`}`);
  if (o.dateEvidence) console.log(`          evidence: ${o.dateEvidence}`);
  if ((o.others || []).length) console.log(`       Also named on the notes:     ${o.others.join(', ')}`);
  if (o.oppStage) console.log(`       Opportunity:                 ${o.oppStage}${o.oppCloseDate ? `  ·  close date ${o.oppCloseDate}` : ''}`);
  const why = Object.entries(o.why || {});
  if (why.length) console.log(`       Why it didn't close:         ${why.map(([k, v]) => `${k.replace(/^Demo Objection/, 'Objection')}: ${v}`).join('  ·  ')}`);
  console.log('');
}

/** The "notes first" line of an account: did the rep's own Granola note turn up? (ev.granola is null when the review stopped before the check.) */
function printGranola(g, commandLog) {
  if (!g) return;
  if (g.found) commandLog('🥣', 'Granola note', `found "${g.title}"${g.date ? ' (' + g.date + ')' : ''}${g.owner ? ' by ' + g.owner : ''} — matched on ${g.matchedOn}, read via ${g.how || '?'}, ${g.chars} chars: it leads the evidence`);
  else commandLog('🥣', 'Granola note', `none to use — ${g.reason}`);
}

/** Compact, saveable record of exactly what the Salesforce reading found (shown on the dashboard + `textLog.js --plan`). */
function readSummary(ev) {
  const trim = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const d = ev.oppDetail;
  return {
    opps: (ev.recentOpps || []).map((o) => ({ name: trim(o.name, 90), stage: trim(o.stage, 40), closeDate: o.closeDate, owner: o.owner || '' })),
    oppCount: (ev.opps || []).length,
    oppFields: d ? Object.fromEntries(Object.entries(d.fields || {}).filter(([k, v]) => v && !/^(created|last modified|system|owner id)/i.test(k)).slice(0, 16).map(([k, v]) => [trim(k, 50), trim(v, 300)])) : {},
    oppOwner: d ? d.owner || null : null,
    repSource: ev.rep ? ev.rep.source : null,
    demoSource: ev.demo ? ev.demo.source : null,
    notesList: (ev.noteTitles || []).slice(0, 12).map((n) => ({ date: n.date, title: trim(n.title, 90), by: n.owner || '', preview: trim(n.preview, 110) })),
    notesTotal: (ev.noteRows || []).length,
    notesOpened: ev.noteBodiesOpened || 0,
    noteDebug: (ev.noteDebug || []).slice(0, 6),
    safety: ev.safety || null,
  };
}

// ---------------------------------------------------------------------------------------------
// A session: the settings, the provider, and a Claude that answers
// ---------------------------------------------------------------------------------------------
/**
 * Load the settings and make sure Claude answers BEFORE any Salesforce reading (an expired login would otherwise only show up after minutes of reading). → ctx, or null when Claude does
 * not answer (what to do is printed; nothing was read or sent). `channels` = the kinds this run sends ('text', 'email'); `noAutoHint` adds "or --no-auto" to that message (plain campaigns).
 * ctx.leadSource (which list the accounts come from: LDS / Shark) is set by the caller and recorded on every plan and send.
 */
async function startSession({ args, deps, channels = ['text', 'email'], noAutoHint = false }) {
  const { commandLog, textLog, autoPlan } = deps;
  const cfg = autoPlan.loadConfig();
  const provider = autoPlan.chooseProvider();
  const library = autoPlan.loadTestimonials();
  const playbook = autoPlan.loadPlaybook();
  const mock = provider === 'mock';
  commandLog('🤖', 'Auto', `LLM: ${provider}${mock ? ' (MOCK — drafts only, never sent)' : ''} • ${library.length} testimonial(s) • offer: ${cfg.offer}`);
  if (!playbook) commandLog('⚠️', 'Auto', 'auto-playbook.md is empty or missing — the drafts will be generic');
  const log = textLog.readAll();

  if (!args.evidenceOnly && !mock) {
    const pf = await autoPlan.preflight(provider);
    if (!pf.ok) {
      console.log(`\n❌ Claude (${provider}) isn't answering: ${pf.detail}`);
      console.log(provider === 'cli'
        ? '   Fix: run  claude auth login --sso  in a terminal, finish the browser sign-in, then rerun this command.\n   Nothing was read or sent.\n'
        : '   AUTO_LLM=api needs a valid ANTHROPIC_API_KEY (or unset AUTO_LLM to use your Claude login). Nothing was read or sent.\n');
      if (noAutoHint) console.log('   Or turn Claude drafts off in Settings (S → Claude drafts → off) and rerun to pick a template instead.\n');
      return null;
    }
    commandLog('✅', 'Claude', `${provider} is answering`);
  }
  return { args, deps, cfg, provider, library, playbook, mock, log, channels, leadSource: null, evidenceOnly: !!args.evidenceOnly };
}

// ---------------------------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------------------------
/**
 * ONE account through the pipeline: read Salesforce → leave out what must not be contacted → write the game plan → save it. Prints what it reads and what it writes.
 * → null (no account id, or on the banlist: nothing to report), or { lead, status, ... } with status 'customer' (Customer Status says current customer) | 'flagged' | 'skipped' | 'evidence' | 'ready' | 'needs-review' | 'error';
 *   a written plan also carries `res` (autoPlan.makePlan's answer) and `row` (the saved plan).
 */
async function draftLead(page, lead, ctx, { idx = 1, total = 1 } = {}) {
  const { deps, cfg, provider, library, playbook, log, leadSource } = ctx;
  const { commandLog, textLog, sfReview, autoPlan, tcpa } = deps;
  const ident = lead.name;
  console.log(`\n${'═'.repeat(64)}\n🤖 AUTO ${idx}/${total}  //  ${ident}\n${'═'.repeat(64)}`);
  if (!lead.accountId) { commandLog('⏭️', 'Skipped', 'no account id on this row'); return null; }
  if (textLog.isBanned(lead.accountId)) {
    commandLog('🚫', 'Banlist', `${ident} — never contacted (banlist)`);
    textLog.recordPlan({ source: leadSource, accountId: lead.accountId, accountName: ident, status: 'skipped', flags: ['banned'], reasons: ['on the banlist'] });
    return null;
  }
  // CURRENT CUSTOMERS, before anything is read or written: open the account and read "Customer Status (beta)". "Enrolled: …" (Enrolled: Current Customer, Cancel Requested, Under Review…) is
  // a current customer and is never contacted, unless the account is only on the free Invoicing and Payments plan: the rule the email run applies on every email (enrollCheck.js, customerPlan.js).
  // A customer found is saved on the held list, so every other mode leaves it alone too. A known customer whose status cannot be read now stays held. --force does not bypass this.
  if (deps.checkCustomer) {
    commandLog('🔎', 'Customer Status', `${ident} — reading "Customer Status (beta)" before anything else`);
    let c;
    try { c = await deps.checkCustomer(page, lead); }
    catch (e) { c = { ok: false, reason: `the Customer Status check failed: ${e.message} (skipped for now)` }; }
    if (!c || !c.ok) {
      const customer = !!(c && c.customer); const reason = (c && c.reason) || 'the Customer Status check gave no answer (skipped for now)';
      commandLog(customer ? '🤝' : '🛑', customer ? 'Current customer' : 'Not contacting', `${ident} — ${reason}: NOT contacted`);
      textLog.recordPlan({ source: leadSource, accountId: lead.accountId, accountName: ident, status: 'skipped', flags: [customer ? 'current_customer' : 'customer_status_unchecked'], reasons: [reason] });
      return { lead, status: customer ? 'customer' : 'skipped', reasons: [reason] };
    }
    const said = c.status === undefined ? '' : `"${c.status || 'blank'}": `;
    if (c.unverified) commandLog('⚠️', 'Customer Status', `${ident} — the field is not on the page, so it could not be verified (written down in status-checks.jsonl); carrying on`);
    else if (c.released) commandLog('🆓', 'Not a customer', `${ident} — Customer Status (beta) is "${c.status}", but ${c.why || 'it is only the free plan'}: not a current customer, carrying on`);
    else commandLog('✅', 'Customer Status', `${ident} — ${said}not a current customer`);
  }
  const mine = log.filter((r) => r.accountId && r.accountId.toLowerCase() === lead.accountId.toLowerCase()).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const firstAt = mine.length ? mine[mine.length - 1].at : null;

  commandLog('🔎', 'Reading Salesforce', `opportunities, your own Granola note if there is one, and the ${cfg.recentNotes} most recent notes`);
  let ev;
  try { ev = await sfReview.buildEvidence(page, { accountId: lead.accountId, name: ident, firstAt }, { recentOppN: cfg.recentOpps, recentNoteN: cfg.recentNotes, now: Date.now() }); }
  catch (e) { ev = { ok: false, verdict: 'unknown', reasons: [`review error: ${e.message}`], warnings: [], flags: [], opps: [], recentOpps: [], noteRows: [], noteTitles: [], noteBodies: [] }; }
  textLog.recordReview({ accountId: lead.accountId, accountName: ident, verdict: ev.verdict, reasons: ev.reasons, warnings: ev.warnings, flags: ev.flags, hardStop: ev.hardStop, opps: ev.opps.map(({ name, stage, closeDate }) => ({ name, stage, closeDate })), notesRead: ev.noteRows.length, notes: ev.noteRows.slice(0, 10), source: 'auto' });
  if (ev.hardStop && textLog.recordBan({ accountId: lead.accountId, accountName: ident, reason: ev.hardStop, source: 'auto review' })) commandLog('🚫', 'Banlist', `${ident} added — ${ev.hardStop}`);
  deps.noteClosedWon({ accountId: lead.accountId, name: ident, url: lead.url }, ev.closedWon, 'auto');

  console.log(`  Opportunities (${ev.recentOpps.length} most recent of ${ev.opps.length}):`);
  ev.recentOpps.forEach((o) => console.log(`    ${(o.closeDate || 'no date').padEnd(12)} ${(o.stage || '').padEnd(20)} ${o.name}${o.owner ? '  — ' + o.owner : ''}`));
  if (ev.verdict !== 'proceed') {
    const flagged = ev.flags.includes('closed_won_30d');
    commandLog(flagged ? '🚩' : '🛑', flagged ? 'FLAGGED' : `Not contacting (${ev.verdict})`, ev.reasons.join('; '));
    textLog.recordPlan({ source: leadSource, accountId: lead.accountId, accountName: ident, status: flagged ? 'flagged' : 'skipped', flags: ev.flags, reasons: ev.reasons, recentOpps: ev.recentOpps });
    return { lead, status: flagged ? 'flagged' : 'skipped', reasons: ev.reasons };
  }
  printGranola(ev.granola, commandLog);
  printOriginalDemo(ev.original);
  console.log(`  Notes on the account: ${(ev.noteRows || []).length}   ·   opened the last ${ev.noteBodiesOpened} and read: ${ev.noteBodies.length}`);
  (ev.noteTitles || []).slice(0, ctx.evidenceOnly ? 12 : 6).forEach((n) => console.log(`     ${(n.date || 'undated').padEnd(11)} ${(n.title || '').slice(0, 70)}${n.owner ? '  — ' + n.owner : ''}`));
  ev.noteBodies.forEach((b, i) => {
    const lim = ctx.evidenceOnly || b.granola ? 1200 : 500;
    console.log(`\n  ${b.granola ? '🥣' : '📝'} NOTE ${i + 1}/${ev.noteBodies.length}${b.granola ? ' (YOUR GRANOLA NOTE, matched on ' + b.matchedOn + ')' : ''} — ${b.date || 'undated'} — ${b.subject || 'Untitled'}${b.assignedTo ? ' — ' + b.assignedTo : ''}   [read via: ${b.how || '?'}, ${b.body.length} chars]`);
    console.log(b.body.slice(0, lim).split('\n').map((l) => '       ' + l).join('\n') + (b.body.length > lim ? '\n       …' : ''));
  });
  if (!ev.noteBodies.length || ctx.evidenceOnly) {
    (ev.noteDebug || []).forEach((d) => console.log(`     ↳ "${d.title}" ${d.date || ''}: ${d.tried.join(' → ')}${d.how ? ' ⇒ ' + d.how : ' ⇒ nothing readable'}`));
  }
  if (ev.safety) console.log(`  🛡️  Safety check: scanned ${ev.safety.notesListed} note titles for Do-Not-Call — none found`);
  ev.warnings.forEach((w) => console.log(`  ⚠️  ${w}`));
  if (ctx.evidenceOnly) {
    // Debug view of exactly what the reader saw — no Claude call, no plan, nothing sent.
    const d = ev.oppDetail;
    console.log(`\n  🔬 EVIDENCE ONLY — opportunity page: ${d ? `${d.oppName} (owner: ${d.owner || 'not found'})` : '(none opened)'}`);
    if (d) { Object.entries(d.fields || {}).slice(0, 40).forEach(([k, v]) => console.log(`     ${k}: ${String(v).slice(0, 140)}`)); }
    textLog.recordPlan({ source: leadSource, accountId: lead.accountId, accountName: ident, status: 'evidence-only', flags: ev.flags, reasons: ev.reasons, rep: ev.rep, demo: ev.demo, originalDemo: ev.original, recentOpps: ev.recentOpps, notes: ev.noteBodies.map((b) => ({ date: b.date, by: b.assignedTo, subject: b.subject, body: b.body, how: b.how })), read: readSummary(ev) });
    return { lead, status: 'evidence', reasons: [] };
  }

  const zones = await deps.ensureZone(page, lead);
  const state = ((textLog.readZones().get(lead.accountId.toLowerCase()) || {}).state) || null;
  commandLog('✍️', 'Writing game plan', `${provider} • checking every claim against the notes`);
  const res = await autoPlan.makePlan({ account: { name: ident, accountId: lead.accountId, state }, ev, prior: mine, cfg, playbook, library, provider });
  const icon = res.status === 'ready' ? '✅' : res.status === 'error' ? '❌' : '🟡';
  commandLog(icon, `Plan: ${res.status.toUpperCase()}`, res.problems.length ? res.problems.join(' | ') : `confidence ${res.plan && res.plan.confidence} (${res.attempts} attempt${res.attempts === 1 ? '' : 's'})`);
  if (res.plan && (res.plan.notes_digest || []).length) {
    console.log('\n  🧠 WHAT THE NOTES SAY (digest)');
    res.plan.notes_digest.forEach((d) => console.log(`     • ${d.date || 'undated'}${d.by ? ' [' + d.by + ']' : ''}: ${d.gist}`));
  }
  if (res.plan && res.plan.email) {
    console.log(`\n  ✉️  EMAIL — ${res.email ? res.email.subject : res.plan.email.subject}\n${(res.email ? res.email.body : res.plan.email.body).split('\n').map((l) => '     ' + l).join('\n')}`);
    console.log(`\n  📱 TEXT (${(res.plan.text || '').length} chars)\n     ${res.plan.text}`);
    console.log(`\n  📞 PHONE SCRIPT\n${String(res.plan.call_script || '').split('\n').map((l) => '     ' + l).join('\n')}`);
    if (res.plan.rep_notes) console.log(`\n  📝 For you: ${res.plan.rep_notes}`);
  }
  if (ctx.channels.includes('text')) {
    const zoneNow = tcpa.checkZones(zones);
    console.log(`  🕐 Time zone: ${state || 'unknown'} → texting ${zoneNow.ok ? 'open now' : 'closed now (' + zoneNow.reason + ')'}`);
  }
  const row = textLog.recordPlan({ source: leadSource,
    accountId: lead.accountId, accountName: ident, status: res.status, flags: ev.flags, reasons: ev.reasons, warnings: ev.warnings, problems: res.problems,
    rep: ev.rep, demo: ev.demo, originalDemo: ev.original, recentOpps: ev.recentOpps,
    notes: ev.noteBodies.map((b) => ({ date: b.date, by: b.assignedTo, subject: b.subject, body: b.body, how: b.how })),
    digest: res.plan ? (res.plan.notes_digest || []) : [],
    email: res.email || null, text: res.plan ? res.plan.text : null, callScript: res.plan ? res.plan.call_script : null,
    confidence: res.plan ? res.plan.confidence : null, repNotes: res.plan ? res.plan.rep_notes : null, evidenceUsed: res.plan ? res.plan.evidence_used : [], testimonialId: res.plan ? res.plan.testimonial_id : null,
    provider, attempts: res.attempts, state,
    read: readSummary(ev),
  });
  return { lead, status: res.status, res, row };
}

// ---------------------------------------------------------------------------------------------
// Several accounts
// ---------------------------------------------------------------------------------------------
const MAX_FAILS_IN_A_ROW = 3;

/**
 * Every account in `leads`, one after the other. One that throws is reported and skipped (status 'error'); three in a row stop the run (a closed browser or a lost Salesforce login
 * would otherwise fail the rest one by one). → [result] in the order read; an account with nothing to report (no id, banlist) has no result.
 */
async function draftLeads(page, leads, ctx) {
  const results = [];
  let idx = 0; let fails = 0;
  for (const lead of leads) {
    idx++;
    try {
      const r = await draftLead(page, lead, ctx, { idx, total: leads.length });
      fails = 0;
      if (r) results.push(r);
    } catch (e) {
      fails++;
      ctx.deps.commandLog('❌', 'Draft failed', `${lead.name} — ${e.message}`);
      results.push({ lead, status: 'error', res: { status: 'error', problems: [e.message] }, reasons: [e.message] });
      if (fails >= MAX_FAILS_IN_A_ROW) { ctx.deps.commandLog('⛔', 'Stopping', `${fails} accounts in a row failed — check the browser window and the Salesforce login. The rest were not read.`); break; }
    }
  }
  return results;
}

/** The summary block: how many of each, why the rest was left out, and a fresh dashboard. → the results with status 'ready'. */
function summarize(results, ctx, total) {
  const { textLog } = ctx.deps;
  const by = (s) => results.filter((r) => r.status === s);
  console.log(`\n${'═'.repeat(64)}\n🤖 AUTO SUMMARY — ${total} account(s) looked at`);
  console.log(`  ✅ ready: ${by('ready').length}   🟡 needs review: ${by('needs-review').length}   🚩 flagged (closed-won ${ctx.cfg.wonFlagDays}d): ${by('flagged').length}   🤝 current customers: ${by('customer').length}   🛑 skipped: ${by('skipped').length}   ❌ error: ${by('error').length}`);
  by('flagged').forEach((r) => console.log(`  🚩 ${r.lead.name} — ${r.reasons.join('; ')}`));
  by('customer').forEach((r) => console.log(`  🤝 ${r.lead.name} — ${r.reasons.join('; ')}`));
  by('needs-review').forEach((r) => console.log(`  🟡 ${r.lead.name} — ${r.res.problems.join(' | ')}`));
  by('error').forEach((r) => console.log(`  ❌ ${r.lead.name} — ${((r.res && r.res.problems) || []).join(' | ')}`));
  try { textLog.generateDashboard(); console.log('  📊 Dashboard refreshed — click an account name to see its game plan.'); } catch (_) {}
  return by('ready');
}

/** Record what actually went out: each ready plan is saved again as 'sent' (with which kinds) when the log shows an Auto custom send to it since `startedAt`. */
function recordSent(ready, startedAt, ctx) {
  const { textLog } = ctx.deps;
  const after = textLog.readAll().filter((r) => r.at >= startedAt && String(r.templateName || '').startsWith(textLog.AUTO_PREFIX));
  for (const r of ready) {
    const sent = { text: after.some((x) => x.accountId === r.lead.accountId && x.channel !== 'email'), email: after.some((x) => x.accountId === r.lead.accountId && x.channel === 'email') };
    textLog.recordPlan({ source: ctx.leadSource, ...r.row, at: new Date().toISOString(), status: sent.text || sent.email ? 'sent' : 'ready', sent });
  }
}

// ---------------------------------------------------------------------------------------------
// Draft → show → confirm → send, one kind (the plain email and text campaigns)
// ---------------------------------------------------------------------------------------------
/**
 * Write the message for each account in `leads` (the range the rep picked), show every draft, ask once, then send only `channel` ('email' | 'text') through the campaign loop, which keeps
 * all its own guards (banlist, once a day, contact guard, TCPA hours for texts, send caps). Accounts already emailed / texted in the last 24 hours are left out BEFORE anything is read for
 * them (the loop would skip them anyway), unless --force. --dry-run: the drafts are made and the loop runs as a dry run (composer filled / text typed, never sent), without the question.
 * → { outcome: 'sent' | 'aborted' | 'nothing' | 'mock', ready }
 */
async function draftAndSend(page, leads, ctx, channel, { leadSource = null, maxPerRun = null } = {}) {
  const { args, deps } = ctx;
  const { commandLog, ask, textLog, sfId } = deps;
  ctx.leadSource = leadSource;
  const email = channel === 'email';
  const today = email ? (id) => textLog.emailedWithinHours(id, 24) : (id) => textLog.textedWithinHours(id, 24);
  const todo = [];
  for (const l of leads) {
    if (!args.force && l.accountId && today(l.accountId)) { commandLog('⏭️', 'Already today', `${l.name} — ${email ? 'emailed' : 'texted'} in the last 24 hours (the once-a-day guard): nothing was written for it`); continue; }
    todo.push(l);
  }
  if (!todo.length) { console.log('\n  Nothing left to write for this range.\n'); return { outcome: 'nothing', ready: 0 }; }

  commandLog('⏳', 'Writing', `${todo.length} ${email ? 'email' : 'text'} message(s), each from that account's notes and opportunities — a minute or two each`);
  const results = await draftLeads(page, todo, ctx);
  const ready = summarize(results, ctx, todo.length);
  if (ctx.mock) { console.log('\n  🧪 mock provider: nothing was sent. Drafts are saved to auto-plans.jsonl and the dashboard.\n'); return { outcome: 'mock', ready: ready.length }; }
  if (!ready.length) { console.log('\n  Nothing is ready to send.\n'); return { outcome: 'nothing', ready: 0 }; }

  if (!args.dryRun && !args.yes) {
    const q = email
      ? `\n  ▶️  Send ${ready.length} custom email(s) LIVE, each written from its account's notes and shown above? (y/N) `
      : `\n  ▶️  Text ${ready.length} custom message(s), each written from its account's notes and shown above — only pros inside their own hours? (y/N) `;
    const ok = (await ask(q)).toLowerCase();
    if (ok !== 'y' && ok !== 'yes') { commandLog('🛑', 'Mission aborted', 'Nothing sent. The drafts are saved.'); return { outcome: 'aborted', ready: ready.length }; }
  }

  const startedAt = new Date().toISOString();
  const mk = (r) => ({ name: r.lead.name, accountId: r.lead.accountId, url: r.lead.url ? sfId.fixUrl(r.lead.url) : undefined });
  if (email) {
    const emailLeads = ready.map((r) => ({ ...mk(r), subject: r.res.email.subject, body: r.res.email.body }));
    await deps.sendEmails(page, emailLeads, { start: 1, end: emailLeads.length, delayMs: args.delayMs, force: args.force, templateName: `${textLog.AUTO_PREFIX} (email)`, dryRun: !!args.dryRun, source: leadSource, maxPerRun });
  } else {
    const textLeads = ready.map((r) => ({ ...mk(r), message: r.res.plan.text }));
    await deps.sendTexts(page, { start: 1, end: textLeads.length, delayMs: args.delayMs, force: args.force, templateName: `${textLog.AUTO_PREFIX} (text)`, leads: textLeads, tcpa: true, tcpaUnknown: args.unknownZone, source: leadSource });
  }
  if (!args.dryRun) recordSent(ready, startedAt, ctx);
  return { outcome: 'sent', ready: ready.length };
}

// ---------------------------------------------------------------------------------------------
// The plain text campaign, start to finish
// ---------------------------------------------------------------------------------------------
/**
 * `email --text` off a LIST VIEW, the auto way: Claude answers? → which rows → open the list → read the accounts in those rows → draftAndSend('text').
 * One range per run (the accounts are read from the open list, which a text campaign leaves): run it again for the next rows.
 * `io` = { ask, parseRange, resolveView, harvestListLeads, harvestSummary, warnShortHarvest, deps } from Assistant.js.
 */
async function runAutoText({ context, initialPage, args, io }) {
  const { commandLog } = io.deps;
  const ctx = await startSession({ args, deps: io.deps, channels: ['text'], noAutoHint: true });
  if (!ctx) return;
  commandLog('✨', 'Auto wording', "each text is written from that account's Salesforce notes and opportunities (your Granola note first). Turn Claude drafts off in Settings to pick a template instead.");

  let range = args.range; let parsed = null;
  while (!parsed) {
    if (!range) range = await io.ask('\nWhich rows to text? (e.g. 1-10, all) ');
    try { parsed = io.parseRange(range); } catch (e) { console.log('  ' + e.message); range = null; }
  }
  console.log(`  Range: ${parsed.start}-${parsed.end || 'end'}`);
  if (parsed.end == null) commandLog('⚠️', 'Full scan', 'Range is "all" — scanning the entire loaded list (up to 2000), and every account in it is read and written for. This is slow; prefer a range like 1-10.');

  const page = await io.resolveView(context, initialPage);
  commandLog('🔗', 'Salesforce grid', page.url());
  commandLog('📇', 'Harvest', `Scanning the list view${parsed.end ? ` for the first ${parsed.end} account(s)` : ' (all)'}…`);
  const all = await io.harvestListLeads(page, { limit: parsed.end });
  commandLog('📬', 'Accounts harvested', `${all.length} account(s) detected${io.harvestSummary(all)}`);
  io.warnShortHarvest(all);
  if (!all.length) {
    console.log('\n⚠️  No accounts harvested. Make sure the list view rows are visible (and start at the top), then retry.\n');
    await io.ask('\nPress Enter to close the browser... ');
    return;
  }
  const picked = all.slice(parsed.start - 1, parsed.end == null ? undefined : parsed.end);
  await draftAndSend(page, picked, ctx, 'text', { leadSource: all.source || null });
  await io.ask('\nPress Enter to close the browser... ');
}

module.exports = { wordingFor, startSession, draftLead, draftLeads, summarize, recordSent, draftAndSend, runAutoText, printOriginalDemo, printGranola, readSummary };
