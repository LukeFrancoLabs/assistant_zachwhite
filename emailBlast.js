'use strict';

/**
 * emailBlast — `email --email --blast`: ONE email, the one you type, to every lead we have not emailed in over N days (default 5), the lead emailed LONGEST AGO first.
 * A manual, one-off tool (Luke, 2026-11-03: "use blast as a manual, one-off tool"): nothing schedules it, and the follow-up board never counts it.
 *
 * THE EMAIL is written by you at the prompt: the subject (one line), then the body (type or paste it, finish with a line that says END). What you typed is kept (blast-emails.jsonl), so the next run
 * can send the SAME email again with `--last-typed` (or L at the prompt): a run stops at 300 emails, and carrying on must not mean typing it again (a re-typed email that differs by one word is a
 * different email, and a lead that already got the first one would get it twice). A saved email (--email-template <name>) or --subject with --body-file still work. Emoji are refused (they arrive
 * as "?" in the sent email); your standard signature is added at the end unless you typed your own.
 *
 * WHO: the follow-up board's leads (cadence.members: every lead on a list — Shark, LDS, Email report, Free plan — and the ones added by hand with a list tag, minus the banned, the
 * closed-won, the current customers, the opted-out and the fresh review skips) whose NEWEST email in our log (texted-log.jsonl: any template, any run, the board's own emails and earlier blasts too) is more
 * than N days old. Counted and left out:
 *   · a lead that has replied to us or asked us to stop: a person takes it from here (the rule --never-emailed uses)
 *   · a lead the email sender found no address for (textLog.noRecipientAccounts)
 *   · a lead on no list (tagged only with a label of your own)
 * A lead we have NEVER emailed is not "not emailed in N days" in the follow-up sense (its first email has its own run: --never-emailed): it joins only with --include-never-emailed, after the others.
 * ORDER: the lead emailed LONGEST AGO first (so `--range 1-25` is the 25 we have been quiet to the longest, and the run's 300-email cap takes the coldest first); the never-emailed last.
 *
 * The send is the normal email run (runEmailCampaign): the banlist, the once-a-day guard, never the same email twice, the contact ledger and the Customer Status read on the account page all still
 * apply, and every send is logged, so running the same command again carries on with whoever is left. The log rows carry no list (source null), so a blast never puts a lead on a list it was not on.
 *
 * THE BOARD never counts a blast email: its log rows carry mode 'blast' (MODE), which cadence.evaluate leaves out of every count, of "our last touch" and of "sent today" (as it does a --same-day text),
 * and which emailSequence.standing leaves out of the sequence's touch count. So no lead moves a stage, nobody's Email 2 is used up, and the board's own emails go out exactly as if the blast had not
 * happened. A blast email still counts as an EMAIL everywhere else: the once-a-day guard, never the same email twice, the daily email cap, the sequence's "last email was N days ago" spacing, and the
 * next blast's "emailed in the last N days".
 *
 *   node emailBlast.js [--days N] [--include-never-emailed] [--list shark|lds|email-report|free-plan]   the audience (no browser, nothing sent)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 5;
const MODE = 'blast';                         // the `mode` its log rows carry (cadence.BLAST_MODE: the follow-up board ignores such rows)
const DRAFTS = 'blast-emails.jsonl';          // the emails typed at the prompt, one JSON line each, the newest last
const LISTS = { shark: 'Shark', lds: 'LDS', 'email-report': 'Email report', 'free-plan': 'Free plan' };       // --list name → the list kind cadence.members reports
const fmt = (x) => Number(x).toLocaleString('en-US');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const when = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '?'; };
const days1 = (d) => `${(Math.round(d * 10) / 10).toLocaleString('en-US')} day${Math.round(d * 10) / 10 === 1 ? '' : 's'}`;

/** --list value → { ok, kind } (kind null = every list) or { ok: false, error }. */
function parseList(text) {
  const t = String(text == null ? '' : text).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!t || t === 'all') return { ok: true, kind: null };
  if (LISTS[t]) return { ok: true, kind: LISTS[t] };
  return { ok: false, error: `--list "${text}" is not a list: use ${Object.keys(LISTS).join(', ')} (or leave it out for all of them)` };
}

/** The newest email we sent a lead (a board member: touches = [{ ch, at, mode, title }]) → { at, title } | null. */
function lastEmailOf(lead) {
  let best = null;
  for (const t of (lead && lead.touches) || []) if (t && t.ch === 'email' && t.at && Number.isFinite(Date.parse(t.at)) && (!best || Date.parse(t.at) > Date.parse(best.at))) best = t;
  return best ? { at: best.at, title: best.title || null } : null;
}

/**
 * The blast's audience from a list of board members. → { leads, stats, days, includeNever, list }.
 * leads = [{ accountId, name, url, lastEmailAt, lastEmailTitle, daysSince, kinds }] in the order the run takes them (never an `email`, `subject`, `body`, `source` or `step`: the email run reads those).
 * stats partitions the pool: pool = labelOnly + wrongList + onList; onList = tooRecent + never + stale; ready = stale (+ never when included) - replied - noAddress.
 */
function audience(members, { now = new Date(), days = DEFAULT_DAYS, includeNever = false, list = null } = {}) {
  const cutoff = now.getTime() - days * 864e5;
  const s = { pool: 0, labelOnly: 0, wrongList: 0, onList: 0, tooRecent: 0, never: 0, stale: 0, replied: 0, noAddress: 0, ready: 0, byList: {}, oldest: null, newest: null };
  const emailed = [], never = [];
  for (const l of members || []) {
    if (!l || !l.accountId) continue;
    s.pool++;
    const kinds = l.kinds || [];
    if (!kinds.length) { s.labelOnly++; continue; }
    if (list && !kinds.includes(list)) { s.wrongList++; continue; }
    s.onList++;
    const last = lastEmailOf(l);
    if (!last) s.never++;
    else if (Date.parse(last.at) >= cutoff) { s.tooRecent++; continue; }      // exactly N days is not "over N days"
    else s.stale++;
    if (!last && !includeNever) continue;
    if (l.optedOut || l.repliedAt) { s.replied++; continue; }
    if (l.noEmail) { s.noAddress++; continue; }
    const row = { accountId: l.accountId, name: l.name, url: l.url, lastEmailAt: last ? last.at : null, lastEmailTitle: last ? last.title : null, daysSince: last ? (now.getTime() - Date.parse(last.at)) / 864e5 : null, kinds: kinds.slice() };
    (last ? emailed : never).push(row);
  }
  emailed.sort((a, b) => Date.parse(a.lastEmailAt) - Date.parse(b.lastEmailAt));      // the lead emailed longest ago first (a stable sort: ties keep the board's order)
  const leads = emailed.concat(never);
  s.ready = leads.length;
  for (const r of leads) { const k = r.kinds.join('+'); s.byList[k] = (s.byList[k] || 0) + 1; }
  if (emailed.length) { s.oldest = emailed[0].daysSince; s.newest = emailed[emailed.length - 1].daysSince; }
  return { leads, stats: s, days, includeNever: !!includeNever, list: list || null };
}

/** The audience read from the real data: the board's members (cadence.members), then audience(). `textLog` and `cadence` are the modules (a test passes its own). */
function fromBoard({ textLog, cadence, now = new Date(), days = DEFAULT_DAYS, includeNever = false, list = null } = {}) {
  const members = cadence.members({ textLog, now, startNewLds: false });
  return audience(members, { now, days, includeNever, list });
}

/** Silence buckets of the ready leads that were emailed before (how many days since their last email), in the order the run takes them: the longest silence first. */
function buckets(res) {
  const b = { 'over 30 days': 0, '15-30 days': 0, '8-14 days': 0, 'under 8 days': 0 };
  for (const l of res.leads) { if (l.daysSince == null) continue; b[l.daysSince < 8 ? 'under 8 days' : l.daysSince < 15 ? '8-14 days' : l.daysSince < 31 ? '15-30 days' : 'over 30 days']++; }
  return Object.entries(b).filter(([, v]) => v).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
}

/** The numbers, as lines for the preview. */
function describe(res) {
  const s = res.stats, d = res.days, plural = d === 1 ? '' : 's', L = [];
  const row = (c, text, tail = '') => `   ${String(fmt(c)).padStart(7)}  ${text}${tail}`;
  L.push(`📣 EMAIL BLAST — every lead we have not emailed in over ${d} day${plural}${res.list ? `  (only the ${res.list} list)` : ''}`);
  L.push(row(s.pool, 'leads on the follow-up board', '   (every lead on a list; banned, closed-won, current customers and opt-outs are not on it)'));
  if (s.labelOnly) L.push(row(s.labelOnly, 'on no list (only a label of your own)', '   → left out'));
  if (s.wrongList) L.push(row(s.wrongList, `not on the ${res.list} list`, '   → left out (--list)'));
  L.push(row(s.tooRecent, `emailed in the last ${d} day${plural}`, '   → not yet'));
  L.push(row(s.never, 'never emailed', res.includeNever ? '   → INCLUDED, after the others (--include-never-emailed)' : '   → not in this blast (add --include-never-emailed to put them last)'));
  L.push(row(s.stale, `emailed more than ${d} day${plural} ago`));
  if (s.replied) L.push(row(s.replied, 'of the leads above: replied or asked to stop', '   → left for you'));
  if (s.noAddress) L.push(row(s.noAddress, 'of the leads above: no email address', '   → left out'));
  L.push(`   ${'-'.repeat(7)}`);
  const byList = Object.entries(s.byList).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
  L.push(row(s.ready, 'READY', byList ? `   (${byList})` : ''));
  if (s.ready) {
    const nv = res.leads.filter((l) => l.daysSince == null).length;
    L.push(`           ORDER: the lead emailed LONGEST AGO goes first${s.oldest != null ? ` (#1: ${days1(s.oldest)} since our last email), the most recently emailed last (${days1(s.newest)})` : ''}${nv ? `, then the ${fmt(nv)} never emailed` : ''}`);
    if (buckets(res)) L.push(`           in that order: ${buckets(res)}`);
  }
  return L.join('\n');
}

/** One line for the run's log. */
function oneLine(res) {
  const s = res.stats, d = res.days;
  const emailedBefore = res.leads.filter((l) => l.daysSince != null).length;
  return `${fmt(s.ready)} lead(s) to email${res.includeNever && s.never ? ` (${fmt(emailedBefore)} not emailed in over ${d} days, the one emailed longest ago first, then ${fmt(s.ready - emailedBefore)} never emailed)` : ` (not emailed in over ${d} days, the one emailed longest ago first)`} • ${fmt(s.tooRecent)} emailed in the last ${d} days are not in it${s.replied ? ` • ${fmt(s.replied)} replied or asked to stop and are left for you` : ''}${s.never && !res.includeNever ? ` • ${fmt(s.never)} never emailed are not in it (--include-never-emailed)` : ''}`;
}

// ============================================================================
// The email you type
// ============================================================================
const draftsFile = (o) => path.join((o && o.dir) || process.env.ASSISTANT_BLAST_DIR || __dirname, DRAFTS);
/** Every email typed at the prompt, the oldest first (a damaged line is skipped). → [{ at, subject, body }] */
function readTyped(o) {
  let text = ''; try { text = fs.readFileSync(draftsFile(o), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (r && typeof r.subject === 'string' && typeof r.body === 'string' && r.subject.trim() && r.body.trim()) out.push(r);
  }
  return out;
}
/** The email typed last, or null. */
function readLastTyped(o) { const all = readTyped(o); return all.length ? all[all.length - 1] : null; }
/** Keeps an email typed at the prompt (appended: the older ones stay). → the saved row */
function saveTyped({ subject, body, at }, o) {
  const row = { at: (at ? new Date(at) : new Date()).toISOString(), subject: String(subject).trim(), body: String(body) };
  fs.appendFileSync(draftsFile(o), JSON.stringify(row) + '\n');
  return row;
}

const EMOJI = /[\p{Emoji_Presentation}\u{1F000}-\u{1FAFF}️⃣]/u;      // emoji and the variation selector that turns a symbol into one; dashes, curly quotes, bullets and ™ are fine
/** The emoji in a text (each once). */
function emojiIn(text) { const f = new Set(); for (const ch of String(text == null ? '' : text)) if (EMOJI.test(ch)) f.add(ch === '️' ? '(an emoji variation mark)' : ch); return [...f]; }

/** What is wrong with a typed email, as plain sentences ([] = usable). render = emailPersonalize.render: a {{placeholder}} it cannot fill is found now, not at lead 300. */
function checkTyped({ subject, body }, { render = null } = {}) {
  const p = [], s = String(subject == null ? '' : subject).trim(), b = String(body == null ? '' : body).trim();
  if (!s) p.push('the subject is empty');
  if (!b) p.push('the body is empty');
  const bad = emojiIn(`${s}\n${b}`);
  if (bad.length) p.push(`it has emoji (${bad.slice(0, 6).join(' ')}): they arrive as "?" in the sent email, so take them out`);
  if (s.length > 200) p.push('the subject is over 200 characters');
  if (s && b && render) { try { render({ subject: s, body: b }, 'Sample Plumbing LLC'); } catch (e) { p.push(`a {{placeholder}} cannot be filled in: ${e.message}`); } }
  return p;
}

const GREETING_START = /^(?:\{\{greeting\}\}|hi\b|hello\b|hey\b|dear\b|good (?:morning|afternoon|evening)\b|greetings\b)/i;
/** Is the signature already at the end of a body? The sender's name on a line of its own, or a Call: / Text: / Book A Demo: line, in the last 300 characters. ("Housecall Pro" in the text proves nothing: nearly every email says it.) */
function endsSigned(body, signature) {
  const tail = String(body == null ? '' : body).slice(-300);
  const name = String(signature || '').split('\n')[0].trim();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /(^|\n)[ \t]*(?:Call|Text):[ \t]*[+(\d]/i.test(tail) || /(^|\n)[ \t]*Book A Demo:/i.test(tail) || (!!name && new RegExp(`(^|\\n)[ \\t]*${esc(name)}[ \\t]*(\\n|$)`, 'i').test(tail));
}
/**
 * A typed email laid out like the saved ones: tidy spacing (no trailing spaces, at most one blank line between paragraphs), a {{greeting}} line at the top unless the email starts with a
 * greeting of its own, and the signature at the bottom unless it is already there. → { body, addedGreeting, addedSignature }
 */
function formatTyped(body, signature = '') {
  let b = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const addedGreeting = !GREETING_START.test(b.split('\n')[0].trim());
  if (addedGreeting) b = `{{greeting}}\n\n${b}`;
  const addedSignature = !!signature && !endsSigned(b, signature);
  if (addedSignature) b = `${b}\n\n${signature}`;
  return { body: b, addedGreeting, addedSignature };
}

/**
 * Asks you to type the email: the subject (one line), then the body, finished by a line that says END (or Ctrl-D). Pasting the whole email at the subject prompt works too: the first line is the
 * subject, the rest is the body. input = the stream to read (process.stdin), out = where the words go, signature = your standard signature (added unless the body already ends with one:
 * "Housecall Pro" in its last 200 characters), render = emailPersonalize.render (checks the {{placeholders}}).
 * autoFormat (the "Type your own subject line & email" choice of the email menu): nothing has to be typed but the words. The email is laid out with formatTyped (a greeting on top, tidy
 * spacing, the signature at the bottom whenever it is not already there: the words "Housecall Pro" in the text do not count as a signature).
 * → { subject, body, signed } (signed: the signature was added; with autoFormat also greeted: the greeting was added) or null when you cancel (Ctrl-C, or the input ends before there is a subject).
 */
async function typeEmail({ input = process.stdin, out = console.log, signature = '', render = null, tries = 3, autoFormat = false } = {}) {
  const tty = !!(input && input.isTTY && process.stdout && process.stdout.isTTY);
  const rl = require('readline').createInterface(tty ? { input, output: process.stdout, terminal: true } : { input, terminal: false });
  const queue = [], waiting = []; let ended = false, cancelled = false;
  rl.on('line', (l) => { if (waiting.length) waiting.shift()(l); else queue.push(l); });
  rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  rl.on('SIGINT', () => { cancelled = true; rl.close(); });
  const next = (prompt) => {                                  // the next line typed or pasted (lines pasted together are already queued: no prompt for those); null = the input ended
    if (cancelled) return Promise.resolve(null);
    if (queue.length) return Promise.resolve(queue.shift());
    if (ended) return Promise.resolve(null);
    if (prompt) { if (tty) { rl.setPrompt(prompt); rl.prompt(); } else out(prompt); }
    return new Promise((res) => waiting.push(res));
  };
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (autoFormat) {
        out('\n  ✍️  Type your own subject line and email.');
        out('     First the subject (one line), then the email: type or paste it and finish with a line that says END (or press Ctrl-D). Ctrl-C cancels.');
        out('     No greeting or signature needed: "Hi <business> team," (or "Hi <first name>,", or just "Hi,") goes at the top for each lead and your signature at the bottom. {{business|your business}} puts the business name in anywhere.');
        out('     No emoji (they arrive as "?").');
      } else {
        out('\n  ✍️  Type the email you want to send.');
        out('     First the subject (one line), then the body: type or paste it and finish with a line that says END (or press Ctrl-D). Ctrl-C cancels.');
        out('     {{greeting}} becomes "Hi <business> team," (or "Hi <first name>,", or just "Hi,") for each lead; {{business|your business}} puts the business name in anywhere.');
        out(`     No emoji (they arrive as "?").${signature ? ' Your standard signature is added at the end unless you type your own.' : ''}`);
      }
      let subject = await next('\n  Subject: ');
      if (subject === null || cancelled) return null;
      subject = subject.replace(/^\s*subject:\s*/i, '').trim();
      out('  Body (finish with END on a line of its own):');
      const lines = [];
      for (;;) { const l = await next(''); if (l === null || cancelled) break; if (/^\s*END\s*$/i.test(l)) break; lines.push(l); }
      if (cancelled) return null;
      const body = lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
      const problems = checkTyped({ subject, body }, { render });
      if (!problems.length) {
        if (autoFormat) { const f = formatTyped(body, signature); return { subject, body: f.body, signed: f.addedSignature, greeted: f.addedGreeting }; }
        const hasSig = /Housecall Pro/i.test(body.slice(-200));
        return { subject, body: hasSig || !signature ? body : `${body}\n\n${signature}`, signed: !hasSig && !!signature };
      }
      out('\n  ⚠️  Not usable yet:'); problems.forEach((x) => out(`     • ${x}`));
      if (attempt === tries) break;
      const again = await next('\n  Type it again? [Y/n] ');
      if (again === null || /^\s*n/i.test(again)) return null;
    }
    return null;
  } finally { rl.close(); }
}

/**
 * The "Which email?" prompt of a blast: T = type it now, L = the one typed last time, or a saved email (a number). Sets args.typedEmail ({ subject, body }) or args.emailTemplate.
 * → true (an email is chosen) or false (nothing chosen: the caller stops, nothing is started). deps = { args, ask, menu, emailTemplateKey, signature, render, input?, out?, dir?, typer? }
 */
async function chooseEmail({ args, ask, menu = [], emailTemplateKey, signature = '', render = null, input, out = console.log, dir, typer = typeEmail } = {}) {
  const last = readLastTyped({ dir });
  out('\n  ✉️  Which email?');
  out('     T. Type my own now');
  if (last) out(`     L. The one I typed last time (${when(last.at)}): "${clip(last.subject, 70)}"`);
  menu.forEach((m) => out(`     ${m.n}. ${m.name}\n        "${m.subject}"`));
  const pick = String((await ask(`\n  Pick T${last ? ', L' : ''} or 1-${menu.length} [T]: `)) || '').trim();
  const p = pick.toLowerCase();
  if (!p || p === 't') {
    const typed = await typer({ input, out, signature, render });
    if (!typed) { out('\n  Nothing typed: nothing was started.\n'); return false; }
    saveTyped(typed, { dir });
    args.typedEmail = { subject: typed.subject, body: typed.body };
    out(`\n  ✅ Saved. To send this same email again later (to carry on after the 300-email cap, say): add --last-typed${typed.signed ? '\n     (your standard signature was added at the end)' : ''}\n`);
    return true;
  }
  if (p === 'l' && last) { args.typedEmail = { subject: last.subject, body: last.body }; return true; }
  try { args.emailTemplate = emailTemplateKey(pick) || 'built-in'; return true; }      // 'built-in' = the re-engagement email picked on purpose (an empty value would mean "no email named")
  catch (e) { out(`\n  ${e.message}\n`); return false; }
}

/** How the email is named in the preview. */
function typedLabel(args) { return `the email you typed: "${clip(args.typedEmail && args.typedEmail.subject, 70)}"`; }

/**
 * `node Assistant.js --cadence --blast …`: the audience, the email as each lead would get it, and the commands. No browser, nothing sent.
 * deps = { textLog, cadence, emailPersonalize, args, content: { subject, body }, which: the email's name, now?, out? }
 */
function preview({ textLog, cadence, emailPersonalize, args, content, which, now = new Date(), out = console.log }) {
  const list = parseList(args.list).kind;
  const res = fromBoard({ textLog, cadence, now, days: args.blastDays, includeNever: !!args.includeNeverEmailed, list });
  out(`\n${describe(res)}\n`);
  const made = []; let broken = 0, already = 0;
  for (const l of res.leads) {
    try {
      const mail = emailPersonalize.render(content, l.name);
      made.push({ lead: l, mail });
      if (textLog.sentSameMessage(l.accountId, 'email', { subject: mail.subject, body: mail.body })) already++;
    } catch (_) { broken++; }
  }
  const kinds = { team: 0, first: 0, plain: 0 };
  for (const m of made) kinds[m.mail.profile.business ? 'team' : m.mail.profile.firstName ? 'first' : 'plain']++;
  const longSubject = made.filter((m) => m.mail.subject.length > 70).length;
  out(`  Email     : ${which}`);
  out(`  Subject   : ${content.subject}`);
  out(`  Greetings : ${fmt(kinds.team)} "Hi <business> team," · ${fmt(kinds.first)} "Hi <first name>," · ${fmt(kinds.plain)} plain "Hi,"`);
  out('  Board     : a blast email is not counted by the follow-up board: no lead moves a stage because of it');
  if (longSubject) out(`  Subjects  : ${fmt(longSubject)} are over 70 characters once the name is in (many inboxes cut those off)`);
  if (already) out(`  ⚠️  ${fmt(already)} of them already got THIS exact email once: the run skips them (never the same email twice). Pick another email to reach them.`);
  if (broken) out(`  ⚠️  ${fmt(broken)} lead(s) could not be personalized and would be skipped`);
  if (made.length) {
    out('\n  The first 5, in the order the run takes them (the lead emailed longest ago first):');
    made.slice(0, 5).forEach((m, i) => out(`    ${i + 1}. ${m.lead.name}  (${m.lead.daysSince == null ? 'never emailed' : `last email ${Math.floor(m.lead.daysSince)} days ago${m.lead.lastEmailTitle ? ': ' + String(m.lead.lastEmailTitle).slice(0, 50) : ''}`})  →  ${m.mail.subject}`));
    if (made.length > 5 && made[made.length - 1].lead.daysSince != null) { const z = made[made.length - 1]; out(`    …\n    ${made.length}. ${z.lead.name}  (last email ${Math.floor(z.lead.daysSince)} days ago)`); }
    out(`\n  ── the email for ${made[0].lead.name} ${'─'.repeat(30)}`);
    out(`  Subject: ${made[0].mail.subject}\n`);
    out(made[0].mail.body.split('\n').map((x) => '    ' + x).join('\n'));
    out('  ' + '─'.repeat(52));
  } else out('\n  Nobody is due: nothing would be sent.');
  const named = args.typedEmail ? ' --last-typed' : `${args.emailTemplate ? ` --email-template ${args.emailTemplate}` : ''}${args.subject ? ` --subject ${JSON.stringify(args.subject)}` : ''}${args.bodyFile ? ` --body-file ${args.bodyFile}` : ''}`;
  const same = ` --days ${res.days}${args.includeNeverEmailed ? ' --include-never-emailed' : ''}${res.list ? ` --list ${args.list}` : ''}${named}`;
  out(`\n  Try it (fills 5 composers, sends nothing):   email --email --blast${same} --range 1-5 --dry-run`);
  out(`  Send the first 25 (asks to confirm):          email --email --blast${same} --range 1-25`);
  out(`  Keep going (it stops by itself after 300 emails; every send is logged, so the next run leaves those out):\n                                                email --email --blast${same} --range all\n`);
  return res;
}

module.exports = { DEFAULT_DAYS, MODE, DRAFTS, LISTS, parseList, lastEmailOf, audience, fromBoard, buckets, describe, oneLine, readTyped, readLastTyped, saveTyped, emojiIn, checkTyped, endsSigned, formatTyped, typeEmail, chooseEmail, typedLabel, preview };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const days = val('--days') != null ? parseInt(val('--days'), 10) : DEFAULT_DAYS;
  const pl = parseList(val('--list'));
  if (!(days >= 1) || !pl.ok) { console.error(!pl.ok ? pl.error : '--days must be a whole number, 1 or more'); process.exit(1); }
  const res = fromBoard({ textLog: require('./textLog'), cadence: require('./cadence'), days, includeNever: argv.includes('--include-never-emailed'), list: pl.kind });
  console.log('\n' + describe(res) + '\n');
}
