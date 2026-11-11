'use strict';

/**
 * dncByEmail — put an EMAIL ADDRESS on the do-not-contact list (banlist.jsonl).
 *
 * A pro asks to be left alone and all Luke has is the address they wrote from. The banlist works on account ids, so this finds every account that uses the address and
 * bans each one: `recordBan` for BOTH its 18-character and its 15-character id (isBanned matches the exact string, see the banlist-id-forms note). Every send path checks the
 * list right before it sends and reads the file fresh, so a ban also stops a bot that is already running.
 *
 *   node textLog.js --dnc <email> [<email> …] [--why "reason"] [--dry-run]
 *
 * The dashboard's 🛑 Skipped tab has a box ("Put an email on the do-not-contact list") that shows which accounts an address matches and builds that command. A static page
 * cannot write files, so on its own the box can only build the command. In the Claude app with dncMcpServer.js connected (server "assistant-dnc"), the box also gets a
 * "Put on the list now" button: the page calls the helper through the artifact `mcp` capability (HOST_SERVER / TOOL_NAME below) and the helper runs putOnDnc. The box embeds
 * parseEmails and canonEmail from here, so the page, the command and the helper read an address the same way.
 *
 * WHERE AN ADDRESS COMES FROM: every log that pairs an address with an account: account-emails.jsonl (the report's Contact: Email column), texted-log.jsonl (the address a text
 * or an email went to), list-membership.jsonl and shark-snapshots.jsonl (report scans) and email-lookups.jsonl (Salesforce lookups by address; an ambiguous lookup names every
 * account it found). An account that uses the address in ANY of them is banned. Gmail ignores dots and +tags (l.uker+x@gmail.com is the inbox of luker@gmail.com), so those match
 * too. An address no account uses bans nothing, says so, and the command exits with 2.
 *
 * Nothing in here opens a browser or sends anything.
 */

const fs = require('fs');
const path = require('path');

const USAGE = 'node textLog.js --dnc <email address> [<email address> …] [--why "reason"] [--dry-run]';
const SF_ACCOUNT_ID = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const HOST_SERVER = 'host:assistant-dnc';     // how the Claude app names the local helper (dncMcpServer.js, MCP server "assistant-dnc")
const TOOL_NAME = 'put_on_dnc';

/**
 * Every email address in a piece of text, lowercased and once each, in the order found. "Name <a@b.com>", "mailto:a@b.com", a comma list and a pasted email all work.
 * → { emails: [...], bad: [words with an @ that are not an address] }
 * (Self-contained on purpose: the dashboard page embeds this function's source.)
 */
function parseEmails(text) {
  const s = String(text == null ? '' : text).slice(0, 20000);
  const found = s.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || [];
  const seen = new Set(), emails = [], bad = [];
  found.forEach((m) => { const e = m.toLowerCase(); if (!seen.has(e)) { seen.add(e); emails.push(e); } });
  s.split(/[\s,;<>()"[\]]+/).forEach((w) => {
    if (w.indexOf('@') !== -1 && !/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(w) && bad.indexOf(w) === -1) bad.push(w);
  });
  return { emails, bad };
}

/** The address as its mailbox: lowercase, and for Gmail without the dots and the +tag (Gmail delivers them all to the same inbox). Other domains stay exact. (Self-contained: embedded in the page.) */
function canonEmail(email) {
  const s = String(email == null ? '' : email).trim().toLowerCase(), at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at), domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local + '@' + domain;
}

function eachRow(file, fn) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch (_) { continue; }      // (a half-written last line while a bot appends)
    if (r && typeof r === 'object') fn(r);
  }
}

/**
 * Every address the logs in `dir` pair with an account. → Map canonEmail → Map key15 → { key, ids:Set, names:[], emails:Set, sources:Set }
 * `emailOfLead` reads the Contact: Email column of a report row (textLog.emailOfLead).
 */
function buildIndex(dir, emailOfLead) {
  const index = new Map(), seen = new Set();
  const add = (source, id, name, raw) => {
    const sid = String(id == null ? '' : id).trim();
    if (!raw || !SF_ACCOUNT_ID.test(sid)) return;
    const pair = source + '|' + sid + '|' + raw;
    if (seen.has(pair)) return;
    seen.add(pair);
    const key = sid.slice(0, 15).toLowerCase();
    for (const email of parseEmails(raw).emails) {
      const ck = canonEmail(email);
      let byKey = index.get(ck); if (!byKey) index.set(ck, (byKey = new Map()));
      let e = byKey.get(key); if (!e) byKey.set(key, (e = { key, ids: new Set(), names: [], emails: new Set(), sources: new Set() }));
      e.ids.add(sid); e.emails.add(email); e.sources.add(source);
      if (name && !e.names.includes(name)) e.names.push(name);
    }
  };
  eachRow(path.join(dir, 'account-emails.jsonl'), (r) => add('account-emails', r.accountId, r.accountName, r.email));
  eachRow(path.join(dir, 'texted-log.jsonl'), (r) => add('texted-log', r.accountId, r.accountName, r.email));
  eachRow(path.join(dir, 'list-membership.jsonl'), (r) => (Array.isArray(r.accounts) ? r.accounts : []).forEach((a) => { if (a) add('list-membership', a.id, a.name, a.email); }));
  eachRow(path.join(dir, 'shark-snapshots.jsonl'), (r) => (Array.isArray(r.accounts) ? r.accounts : []).forEach((a) => { if (a && emailOfLead) add('shark-snapshots', a.id, a.name, emailOfLead(a)); }));
  eachRow(path.join(dir, 'email-lookups.jsonl'), (r) => {
    if (r.status === 'found') add('email-lookups', r.accountId, r.name, r.email);
    else if (r.status === 'ambiguous') (Array.isArray(r.accounts) ? r.accounts : []).forEach((a) => { if (a) add('email-lookups', a.accountId, a.name, r.email); });
  });
  return index;
}

/** The 18- and 15-character id of an account entry. An 18-character id with its case restored (sfId.fix) when the logs have one; otherwise only the 15-character form is known. */
function idsOf(entry, sfId) {
  for (const raw of entry.ids) {
    if (raw.length !== 18) continue;
    const f = sfId.fix(raw);
    if (sfId.isValid18(f)) return { id18: f, id15: f.slice(0, 15) };
  }
  const any = [...entry.ids][0];
  return { id18: null, id15: any.slice(0, 15) };
}

/** The accounts that use `email` (its own mailbox, see canonEmail). → [{ key, name, id18, id15, exact, emails, sources }] by name */
function accountsFor(index, email, sfId) {
  const byKey = index.get(canonEmail(email));
  if (!byKey) return [];
  return [...byKey.values()].map((e) => ({ key: e.key, name: e.names[0] || null, ...idsOf(e, sfId), exact: e.emails.has(email), emails: [...e.emails].sort(), sources: [...e.sources].sort() }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || a.key.localeCompare(b.key));
}

function defaultDeps() {
  const textLog = require('./textLog');
  return { dir: __dirname, recordBan: textLog.recordBan, readBans: textLog.readBans, readGreen: textLog.readGreen, emailOfLead: textLog.emailOfLead, sfId: require('./sfId') };
}

/**
 * Put every account that uses one of `emails` on the banlist. → { results:[{ email, accounts:[{ ...account, status, added:[ids], green }] }], banned, already, noAccount, added }
 * status: 'banned' (new), 'topped' (was banned under one id form, the other form added), 'already', 'again' (an account an earlier address already covered), 'would' (dry run).
 * `deps` = { dir, recordBan, readBans, readGreen, emailOfLead, sfId } (defaults to the real ones; tests pass their own).
 */
function putOnDnc(emails, { why = null, dryRun = false, deps = defaultDeps() } = {}) {
  const lower = (id) => String(id || '').toLowerCase();
  const index = buildIndex(deps.dir, deps.emailOfLead), green = deps.readGreen();
  const bans = deps.readBans(), have = new Set([...bans.keys()]);      // an id counts as banned once recorded, also by an earlier address in this same call
  const handled = new Map(), results = [];
  const tally = { banned: 0, already: 0, noAccount: 0, added: 0 };
  for (const email of emails) {
    const accounts = accountsFor(index, email, deps.sfId);
    if (!accounts.length) { tally.noAccount++; results.push({ email, accounts: [] }); continue; }
    const row = { email, accounts: [] };
    for (const acct of accounts) {
      if (handled.has(acct.key)) { row.accounts.push({ ...handled.get(acct.key), status: 'again' }); continue; }
      const ids = [acct.id18, acct.id15].filter(Boolean), added = [];
      const reason = why ? `${why} (${email})` : `put on the do-not-contact list by email address (${email})`;
      const before = ids.filter((id) => have.has(lower(id))).length;
      for (const id of ids) {
        if (have.has(lower(id))) continue;
        if (!dryRun) deps.recordBan({ accountId: id, accountName: acct.name, reason, source: 'dnc by email' });
        have.add(lower(id)); added.push(id);
      }
      const status = !added.length ? 'already' : dryRun ? 'would' : before ? 'topped' : 'banned';
      const done = { ...acct, status, added, green: ids.some((id) => green.has(lower(id))) };
      handled.set(acct.key, done); row.accounts.push(done);
      if (added.length) { tally.banned++; tally.added += added.length; } else tally.already++;
    }
    results.push(row);
  }
  return { results, ...tally };
}

/** `--dnc` arguments → { emails, bad, why, dryRun, error }. Each argument may hold several addresses (a pasted email, a comma list). */
function parseArgs(argv) {
  const out = { emails: [], bad: [], why: null, dryRun: false, error: null }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--why') {
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) { out.error = '--why needs the reason after it, in quotes:  --why "asked to stop by email"'; return out; }
      out.why = String(argv[++i]).trim() || null; continue;
    }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--')) { out.error = `Unknown option ${a}`; return out; }
    const p = parseEmails(a);
    p.emails.forEach((e) => { if (!seen.has(e)) { seen.add(e); out.emails.push(e); } });
    p.bad.forEach((b) => out.bad.push(b));
    if (!p.emails.length && !p.bad.length && a.trim()) out.bad.push(a.trim());
  }
  return out;
}

const STATUS_LINE = {
  banned: '🚫 put on the list now',
  topped: '🚫 was on the list under one id form; the other form is added now',
  already: '✅ already on the list',
  again: '↩️  same account as an address above',
  would: '🚫 would be put on the list',
};

/** What a run did, as lines of text: the command prints them and the helper sends them back as its answer. r = putOnDnc's result. */
function reportLines(r, { dryRun = false, bad = [], count = r.results.length } = {}) {
  const L = [`\n🚫 Do-not-contact by email: ${count} address${count === 1 ? '' : 'es'}${dryRun ? '  (dry run: nothing is written)' : ''}`];
  if (bad.length) L.push(`   ⚠️  Not an email address, left out: ${bad.join(' ')}`);
  for (const row of r.results) {
    L.push(`\n  ${row.email}`);
    if (!row.accounts.length) {
      L.push('    ❌ No account in our logs uses this address, so nothing was banned.');
      L.push('       If you know the business, find it on the dashboard and run:  node textLog.js --ban <its account id> "why"');
      continue;
    }
    for (const acct of row.accounts) {
      const ids = acct.id18 ? `${acct.id18} + ${acct.id15}` : `${acct.id15} (only the 15-character id is in the logs)`;
      L.push(`    ${STATUS_LINE[acct.status]}: ${acct.name || '(unnamed)'}  ${ids}`);
      if (acct.status === 'again') continue;
      L.push(`       found in: ${acct.sources.join(', ')}${acct.exact ? '' : `   ·   same inbox as ${acct.emails.join(', ')} (Gmail ignores dots and +tags)`}`);
      if (acct.green) L.push('       ⚠️  This account is on the green banlist (cleared earlier), which overrides the ban: it can still be contacted until that entry is taken out.');
    }
  }
  const parts = [];
  if (r.banned) parts.push(`${r.banned} account${r.banned === 1 ? '' : 's'} ${dryRun ? 'to put' : 'put'} on the list`);
  if (r.already) parts.push(`${r.already} already on it`);
  if (r.noAccount) parts.push(`${r.noAccount} address${r.noAccount === 1 ? '' : 'es'} with no account`);
  L.push(`\nDone: ${parts.join(' · ')}.`);
  if (r.banned && !dryRun) L.push('Every text and email path checks the list before it sends, so this holds from now on, even for a run that is already going.');
  L.push('');
  return L;
}

/** The command. → { code, changed }: 0 done, 1 could not run (usage), 2 an address matched no account. `out` prints a line (tests collect them). */
function cli(argv, out = console.log, deps) {
  const a = parseArgs(argv);
  if (a.error) { out(`\n❌ ${a.error}\n\nUsage:  ${USAGE}\n`); return { code: 1, changed: false }; }
  if (!a.emails.length) { out(`\n❌ ${a.bad.length ? 'Not an email address: ' + a.bad.join(' ') : 'No email address given'}.\n\nUsage:  ${USAGE}\n`); return { code: 1, changed: false }; }
  const r = putOnDnc(a.emails, { why: a.why, dryRun: a.dryRun, deps });
  reportLines(r, { dryRun: a.dryRun, bad: a.bad, count: a.emails.length }).forEach((l) => out(l));
  return { code: r.noAccount ? 2 : 0, changed: !a.dryRun && r.added > 0 };
}

// ---- the dashboard box ----------------------------------------------------------------------------------------------------------------------------------------------

/** The box's markup, for the top of the 🛑 Skipped tab. Uses the page's own .addbox / .pill / .lnote styles. */
function boxHtml() {
  return `<details id="dncbox" class="addbox">
      <summary>🚫 Put an email on the do-not-contact list</summary>
      <div class="sub" style="margin:8px 0 0">For a pro who asked you to stop. Type the email address they wrote from (pasting the whole email works, every address in it is picked up). The box shows which accounts use the address. In the Claude app with the Assistant helper connected, <b>Put on the list now</b> does it with one click. Anywhere else, copy the command and run it in Terminal. Either way every account that uses the address goes on the list straight away, so no text or email run contacts them again, even one that is already going.</div>
      <div class="abg">
        <label>Email address (several: one per line or separated by commas)<textarea id="dnc-in" rows="2" placeholder="owner@example.com"></textarea></label>
        <label>Why (optional, it is saved with the ban)<input type="text" id="dnc-why" placeholder="e.g. replied to our email asking us to stop"></label>
      </div>
      <div class="abh" id="dnc-hint"></div>
      <div id="dnc-list"></div>
      <div id="dnc-go-row" hidden><div class="abd" style="margin-top:10px"><button type="button" id="dnc-go" style="border-color:var(--accent);font-weight:600" disabled>Put on the list now</button><span class="abh" style="margin:0">The Claude app asks you to confirm, then every account that uses the address goes on the list.</span></div></div>
      <div id="dnc-result" aria-live="polite"></div>
      <div class="abc"><code id="dnc-cmd">Type an email address above</code><button type="button" id="dnc-copy">Copy command</button></div>
    </details>`;
}

/**
 * The box's behaviour, run in the page with the page's ROWS and APPDIR (its source is embedded, so it must not use anything from this file).
 * It lists the dashboard accounts an address matches (the command and the helper search every log, which is wider), builds `node textLog.js --dnc …`, and, when the page
 * can reach the local helper (the `mcp` capability, server HOST, tool TOOL), shows "Put on the list now". The page never calls the helper on load, only on that click.
 */
function dncBoxClient(parseEmails, canonEmail, ROWS, APPDIR, HOST, TOOL) {
  const E = (id) => document.getElementById(id);
  if (!E('dncbox')) return;
  const DQ = String.fromCharCode(34), SQ = String.fromCharCode(39);
  const shq = (s) => SQ + String(s).split(SQ).join(SQ + DQ + SQ + DQ + SQ) + SQ;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
  const byMail = new Map();      // canonical address → [{ row, email }]: the dashboard accounts that use it
  ROWS.forEach((r) => { if (r && r.email) parseEmails(r.email).emails.forEach((e) => { const k = canonEmail(e); if (!byMail.has(k)) byMail.set(k, []); byMail.get(k).push({ row: r, email: e }); }); });
  const sentOf = (r) => (r.texts || 0) + ' text' + (r.texts === 1 ? '' : 's') + ', ' + (r.emails || 0) + ' email' + (r.emails === 1 ? '' : 's') + ' sent';
  let bridge = null;             // the mcp capability, once this view has shown it can reach the helper
  const go = E('dnc-go');
  function update() {
    const raw = E('dnc-in').value, P = parseEmails(raw), why = E('dnc-why').value.trim(), lines = [], hint = [];
    let fresh = 0;
    P.emails.forEach((email) => {
      const hits = byMail.get(canonEmail(email)) || [];
      if (!hits.length) { lines.push('<div class="lnote"><span class="pill unk">no account here</span> <b>' + esc(email) + '</b> is not on this dashboard. The command also searches every log, and says so if it finds no account.</div>'); fresh++; return; }
      hits.forEach((h) => {
        const same = h.email === email ? '' : ' (the same inbox as ' + esc(h.email) + ', Gmail ignores dots and +tags)';
        if (h.row.banned) lines.push('<div class="lnote"><span class="pill skip">🚫 already on the list</span> <b>' + esc(h.row.name) + '</b> uses ' + esc(email) + same + '</div>');
        else { fresh++; lines.push('<div class="lnote"><span class="pill ok">✅ goes on the list</span> <b>' + esc(h.row.name) + '</b> uses ' + esc(email) + same + ' · ' + sentOf(h.row) + '</div>'); }
      });
    });
    if (!raw.trim()) hint.push('Type or paste an email address.');
    else if (!P.emails.length) hint.push('⚠️ No email address found in that.');
    if (P.bad.length) hint.push('⚠️ Not an email address, left out: ' + esc(P.bad.join(' ')));
    if (P.emails.length && !fresh) hint.push('Everything you typed is already on the list. ' + (bridge ? 'The button is still safe to press' : 'The command is still safe to run') + ': it adds an id form that is missing.');
    let cmd = '';
    if (P.emails.length) {
      cmd = 'cd ' + shq(APPDIR) + ' && node textLog.js --dnc ' + P.emails.map((e) => (/^[A-Za-z0-9._+@-]+$/.test(e) ? e : shq(e))).join(' ');
      if (why) cmd += ' --why ' + shq(why);
    }
    E('dnc-list').innerHTML = lines.join('');
    E('dnc-hint').innerHTML = hint.join('  ·  ');
    E('dnc-cmd').textContent = cmd || 'Type an email address above';
    E('dnc-copy').dataset.cmd = cmd;
    if (go) go.disabled = !P.emails.length;
  }
  E('dnc-copy').addEventListener('click', () => {
    const cmd = E('dnc-copy').dataset.cmd;
    if (!cmd) { E('dnc-hint').textContent = 'Type an email address first.'; return; }
    const done = () => { const b = E('dnc-copy'), t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = t; }, 1800); };
    const fallback = () => {
      const ta = document.createElement('textarea'); ta.value = cmd; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      if (ok) done(); else E('dnc-hint').textContent = 'Copy was blocked. Select the command below and copy it.';
    };
    try { navigator.clipboard.writeText(cmd).then(done, fallback); } catch (_) { fallback(); }
  });
  E('dnc-in').addEventListener('input', update);
  E('dnc-why').addEventListener('input', update);

  // ---- one click, in the Claude app with the helper connected
  const failText = (e) => {
    const code = e && e.code, said = e && e.result && e.result.content && e.result.content[0] && e.result.content[0].text;
    if (code === 'tool_error') return 'The helper refused: ' + (said || 'no reason given') + ' Use the command below instead.';
    if (code === 'cancelled') return 'You declined the confirmation, so nothing was changed.';
    if (code === 'server_not_connected') return 'The helper is not connected in this Claude app, so nothing was changed. Use the command below.';
    if (code === 'approval_required' || code === 'not_in_manifest' || code === 'consent_required' || code === 'not_granted') return 'This page is not allowed to use the helper, so nothing was changed. Use the command below, or allow it for this page and try again.';
    if (code === 'server_unavailable' || code === 'upstream_error') return 'The helper did not answer, so the ban may or may not have gone through. Pressing the button again is safe, and so is the command below.';
    return 'That did not work (' + (code || 'unknown error') + '). Nothing is known to have changed. Use the command below.';
  };
  const resultHtml = (p) => {
    const L = [];
    p.results.forEach((r) => {
      const accts = r.accounts || [];
      if (!accts.length) { L.push('<div class="lnote"><span class="pill unk">no account</span> <b>' + esc(r.email) + '</b>: no account in the logs uses it, so nothing was banned. If you know the business, find it on the dashboard and use <code>node textLog.js --ban</code> with its account id.</div>'); return; }
      accts.forEach((a) => {
        if (a.status === 'again') return;
        const added = a.status === 'banned' || a.status === 'topped', would = a.status === 'would';
        L.push('<div class="lnote"><span class="pill ' + (added ? 'skip' : would ? 'unk' : 'ok') + '">' + (added ? '🚫 put on the list' : would ? 'would be put on the list' : '✅ already on the list') + '</span> <b>' + esc(a.name || '(unnamed)') + '</b> uses ' + esc(r.email) + (a.green ? ' · ⚠️ it is on the green banlist, which overrides the ban' : '') + '</div>');
      });
    });
    if (!p.dryRun) L.push('<div class="lnote">Done. Every text and email run skips them from now on. The Skipped tab lists them once the dashboard is rebuilt and republished.</div>');
    return L.join('');
  };
  async function putNow() {
    const P = parseEmails(E('dnc-in').value), why = E('dnc-why').value.trim();
    if (!bridge || !P.emails.length || go.disabled) return;
    const input = { emails: P.emails.join('\n') };
    if (why) input.why = why;
    const label = go.textContent;
    go.disabled = true; go.textContent = 'Putting on the list…';
    E('dnc-result').innerHTML = '<div class="lnote">Waiting for the helper. The Claude app may ask you to confirm.</div>';
    try {
      const res = await bridge.callTool(HOST, TOOL, input);
      const p = res && res.payload && typeof res.payload === 'object' ? res.payload : null;
      if (!p || !Array.isArray(p.results)) { E('dnc-result').innerHTML = '<div class="lnote"><span class="pill unk">unclear</span> The helper answered in a form this page does not understand. Run the command below to be sure.</div>'; return; }
      p.results.forEach((r) => (r.accounts || []).forEach((a) => { if (a.status === 'banned' || a.status === 'topped' || a.status === 'already') ROWS.forEach((row) => { if (k15(row.key) === k15(a.id15)) row.banned = true; }); }));
      E('dnc-result').innerHTML = resultHtml(p);
      update();
    } catch (e) {
      E('dnc-result').innerHTML = '<div class="lnote"><span class="pill skip">not done</span> ' + esc(failText(e)) + '</div>';
    } finally {
      go.textContent = label; go.disabled = !parseEmails(E('dnc-in').value).emails.length;
    }
  }
  if (go) go.addEventListener('click', putNow);
  try {
    const cl = window.claude;
    if (go && cl && typeof cl.use === 'function') {
      cl.use('mcp').then((mcp) => {
        if (!mcp || typeof mcp.listTools !== 'function' || typeof mcp.callTool !== 'function') return;
        return mcp.listTools(HOST).then((l) => {
          const s = ((l && l.servers) || []).find((x) => x && x.server === HOST);
          if (s && (!(s.tools || []).length || s.tools.some((t) => t && t.name === TOOL))) { bridge = mcp; E('dnc-go-row').hidden = false; update(); }
        });
      }).catch(() => {});
    }
  } catch (_) {}
  update();
}

/** The script that wires the box up, to sit in the page after SKIP (ROWS and APPDIR are page constants by then). */
function boxScript() {
  return '\n// 🚫 Put an email on the do-not-contact list (Skipped tab): shows which accounts an address matches, builds the node textLog.js --dnc command and, in the Claude app with the local helper connected, can put them on the list with one click.\n'
    + '(' + dncBoxClient.toString() + ')(' + parseEmails.toString() + ', ' + canonEmail.toString() + ', ROWS, APPDIR, ' + JSON.stringify(HOST_SERVER) + ', ' + JSON.stringify(TOOL_NAME) + ');\n';
}

module.exports = { parseEmails, canonEmail, buildIndex, accountsFor, putOnDnc, parseArgs, reportLines, cli, boxHtml, boxScript, USAGE, HOST_SERVER, TOOL_NAME };
