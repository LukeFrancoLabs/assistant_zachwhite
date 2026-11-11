'use strict';

/**
 * emailSource — for `email --email --by-email`: where the list of addresses can come from besides an open Salesforce report, and what we ALREADY know about each
 * address, so Salesforce is only searched for the addresses nothing else answers.
 *
 *   readEmailCsv(file)   a CSV file → the addresses in it. The dashboard's outreach-log export (Account, Salesforce URL, Email, Channel, …) names the account of every row,
 *                        so those need no search at all; a Salesforce export (any column with "email" in its name) or a plain list of addresses works too.
 *   loadOwn()            address → the ONE account our own files tie it to: texted-log.jsonl has the address and the account of every text and email we sent, account-emails.jsonl
 *                        the addresses read off account pages. An address on two accounts is left to the Salesforce search (never guessed).
 *   plan()               what each address of a list needs (the file, a saved lookup, our own files, or a Salesforce search) — the same decision emailLookup.resolveAll makes.
 *
 * Read-only preview, no browser, nothing sent:   node emailSource.js <file.csv> [--column "Email"]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./emailLookup');

const ADDR_G = new RegExp(L.EMAIL_RE.source, 'g');
const ADDR_ONLY = new RegExp('^' + L.EMAIL_RE.source + '$');
const ACCOUNT_ID = '001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?';              // a Salesforce Account id, 15 or 18 characters
const ACCT_IN_URL = new RegExp('/Account/(' + ACCOUNT_ID + ')(?![A-Za-z0-9])');
const ACCT_BARE = new RegExp('^(' + ACCOUNT_ID + ')$');
const k15 = (id) => String(id || '').slice(0, 15).toLowerCase();
const hasAddr = (s) => { ADDR_G.lastIndex = 0; return ADDR_G.test(String(s || '')); };
const fmt = (n) => Number(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------------

/** The separator of a file: whichever of , ; tab the first line uses most (outside quotes). */
function detectDelimiter(text) {
  const n = { ',': 0, ';': 0, '\t': 0 }; let q = false;
  for (const c of String(text).slice(0, 8000)) {
    if (c === '"') q = !q;
    else if (!q) { if (c === '\n' || c === '\r') break; if (c in n) n[c]++; }
  }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ',';
}

/** RFC 4180: quoted fields, "" for a quote, a separator or a line break inside quotes, CRLF / LF / CR line ends, a BOM. A line with nothing in it is skipped. → string[][] */
function parseCsv(text, delim = ',') {
  const s = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  const endRow = () => { row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; endRow(); }
    else cell += c;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

const emailRank = (h) => { const t = String(h).trim(); return /^e-?mail( address)?$/i.test(t) ? 0 : /(^|[:\s-])e-?mail( address)?$/i.test(t) ? 1 : 2; };   // "Email", then "Contact: Email", then anything with email in it
const share = (data, i) => { let n = 0, ok = 0; for (const r of data) { const c = String(r[i] || '').trim(); if (!c) continue; n++; if (hasAddr(c)) ok++; } return n ? ok / n : 0; };

/**
 * A CSV file → the addresses in it.
 *   → { emails:[{ email, name, accountId, url, cols }] (+ .headers), file, column, others, accountColumn, nameColumn, delimiter, stats }
 * The address column is the one named "Email" / "Email Address", else one that ends in "Email" ("Contact: Email"), else any with "email" in its name, else the column
 * whose cells are addresses; `column` (a header, or its 1-based position) overrides. A file whose first line already holds an address has no header row.
 * The account of a row comes from a URL or id column (the dashboard export's "Salesforce URL"); an address whose rows name two different accounts names none.
 * Several addresses in one cell: the first is used. The same address twice: one entry. Throws an Error with a plain message when the file cannot be used.
 */
function readEmailCsv(file, { column = null, text = null } = {}) {
  const abs = path.resolve(String(file || '').replace(/^~(?=$|[\\/])/, os.homedir()));
  let raw;
  if (text != null) raw = String(text);
  else {
    try { raw = fs.readFileSync(abs, 'utf8'); }
    catch (e) { throw new Error(`cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.code === 'EISDIR' ? 'that is a folder, not a file' : e.message}`); }
  }
  const delimiter = detectDelimiter(raw);
  const rows = parseCsv(raw, delimiter);
  if (!rows.length) throw new Error(`${file} is empty`);
  const headerless = rows[0].some((c) => /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(c));
  const width = Math.max(...rows.map((r) => r.length));
  const headers = (headerless ? Array.from({ length: width }, (_, i) => `column ${i + 1}`) : rows[0].map((h) => String(h).trim()));
  const data = headerless ? rows : rows.slice(1);
  const names = headers.join(' | ');
  if (!data.length) throw new Error(`${file} has a header line but no rows`);

  let col = -1;
  if (column != null && String(column).trim() !== '') {
    const want = String(column).trim().toLowerCase();
    col = headers.findIndex((h) => h.toLowerCase() === want);
    if (col < 0 && /^\d+$/.test(want)) col = Number(want) - 1;
    if (col < 0 || col >= headers.length) throw new Error(`there is no column "${column}" in ${file} — its columns are: ${names}`);
  } else {
    const cands = headers.map((h, i) => ({ h, i })).filter(({ h }) => /e-?mail/i.test(h)).sort((a, b) => emailRank(a.h) - emailRank(b.h) || a.i - b.i);
    const pick = cands.find(({ i }) => share(data, i) >= 0.5);
    if (pick) col = pick.i;
    else {
      let best = 0;
      headers.forEach((_, i) => { const s = share(data, i); if (s > best) { best = s; col = i; } });
      if (best < 0.5) throw new Error(`no email column in ${file} — its columns are: ${names} (name the right one with --csv-column "<column>")`);
    }
  }
  const others = headers.filter((h, i) => i !== col && /e-?mail/i.test(h));

  const urlCols = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => i !== col && /url|link|account ?id|(^|[:\s])id$/i.test(h)).map(({ i }) => i);
  const acctOf = (r) => { for (const i of urlCols) { const c = String(r[i] || '').trim(); const m = c.match(ACCT_IN_URL) || c.match(ACCT_BARE); if (m) return m[1]; } return null; };
  const acctHit = urlCols.find((i) => data.some((r) => { const c = String(r[i] || '').trim(); return ACCT_IN_URL.test(c) || ACCT_BARE.test(c); }));
  const nameCol = headers.findIndex((h, i) => i !== col && (/^(account( name)?|company( name)?|business( name)?|name)$/i.test(h) || /(^|[:\s])account name$/i.test(h)));

  const out = new Map(); const stats = { rows: data.length, unique: 0, blank: 0, invalid: 0, multi: 0, duplicates: 0, withAccount: 0, conflicting: 0 };
  for (const r of data) {
    const cell = String(r[col] || '').trim();
    if (!cell) { stats.blank++; continue; }
    const found = cell.match(ADDR_G);
    if (!found) { stats.invalid++; continue; }
    if (new Set(found.map(L.normEmail)).size > 1) stats.multi++;
    const email = L.normEmail(found[0]);
    const accountId = acctOf(r);
    const name = nameCol >= 0 && String(r[nameCol] || '').trim() && !hasAddr(r[nameCol]) ? String(r[nameCol]).trim() : null;
    const prev = out.get(email);
    if (prev) {
      stats.duplicates++;
      if (accountId && prev.accountId && k15(accountId) !== k15(prev.accountId)) prev.clash = true;       // one address on two accounts: the file cannot say which
      else if (accountId && !prev.accountId) prev.accountId = accountId;
      if (!prev.name && name) prev.name = name;
      continue;
    }
    const cols = {}; r.forEach((v, i) => { const h = headers[i]; if (h && v && String(v).length <= 140) cols[h] = String(v).trim(); });
    out.set(email, { email, name, accountId, url: null, cols, clash: false });
  }
  const emails = [...out.values()];
  for (const e of emails) {
    if (e.clash) { e.accountId = null; stats.conflicting++; }
    if (e.accountId) { stats.withAccount++; e.url = null; }                                // the link is built from the Salesforce address the run is on
    delete e.clash;
  }
  stats.unique = emails.length;
  if (!emails.length) throw new Error(`no email addresses in ${file} (column "${headers[col]}": ${stats.blank} empty, ${stats.invalid} not an address)`);
  emails.headers = headers;
  return { emails, file: abs, column: headers[col], others, accountColumn: acctHit != null ? headers[acctHit] : null, nameColumn: nameCol >= 0 ? headers[nameCol] : null, delimiter, stats };
}

// ---------------------------------------------------------------------------------------------------------------------
// our own files: address → account
// ---------------------------------------------------------------------------------------------------------------------

const ACCT_ONLY = new RegExp('^' + ACCOUNT_ID + '$');

/** Rows of texted-log.jsonl ({ email, accountId, accountName, accountUrl, channel, at }) and account-emails.jsonl → Map(address → Map(account → { accountId, name, url, at, via:Set })). */
function ownIndex({ log = [], accountEmails = [] } = {}) {
  const idx = new Map();
  const add = (email, accountId, name, url, at, via) => {
    const e = L.normEmail(email);
    if (!e || !ADDR_ONLY.test(e) || e.length > 120 || !ACCT_ONLY.test(String(accountId || ''))) return;
    let m = idx.get(e); if (!m) idx.set(e, (m = new Map()));
    const k = k15(accountId), cur = m.get(k);
    if (!cur) { m.set(k, { accountId, name: name || null, url: url || null, at: at || '', via: new Set([via]) }); return; }
    cur.via.add(via);
    if (String(accountId).length > String(cur.accountId).length) cur.accountId = accountId;       // the 18-character id beats the 15
    if ((at || '') >= cur.at) { if (name) cur.name = name; if (url) cur.url = url; cur.at = at || cur.at; }
  };
  for (const r of log) add(r && r.email, r && r.accountId, r && r.accountName, r && r.accountUrl, r && r.at, r && r.channel === 'email' ? 'an earlier email' : 'an earlier text');
  for (const r of accountEmails) add(r && r.email, r && r.accountId, r && r.accountName, null, r && r.at, 'a saved account email');
  return idx;
}

/**
 * index → a function (entry | address) → { accountId, name, url, sources } for the ONE account our files tie that address to, else null (nothing known, or the address is on
 * several accounts: that is for Salesforce to say). .size = addresses known, .ambiguous = addresses on more than one account.
 */
function ownMatcher(index) {
  const match = (e) => {
    const m = index.get(L.normEmail(e && e.email ? e.email : e));
    if (!m || m.size !== 1) return null;
    const a = [...m.values()][0];
    return { accountId: a.accountId, name: a.name, url: a.url, sources: [...a.via] };
  };
  match.size = index.size;
  match.ambiguous = [...index.values()].filter((m) => m.size > 1).length;
  return match;
}

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };

/** The matcher over this project's own files (texted-log.jsonl, account-emails.jsonl — the same files textLog.js writes). */
function loadOwn({ dir = __dirname } = {}) {
  return ownMatcher(ownIndex({ log: readJsonl(path.join(dir, 'texted-log.jsonl')), accountEmails: readJsonl(path.join(dir, 'account-emails.jsonl')) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// what a list needs
// ---------------------------------------------------------------------------------------------------------------------

/** What each address of `emails` needs, by the decision resolveAll makes. → { total, file, conflict, cacheFound, cacheMiss:{status:n}, own, search, accounts, samples:{search,conflict} } */
function plan(emails, { cache = new Map(), own = null, maxAgeMissDays = 7 } = {}) {
  const t = { total: emails.length, file: 0, conflict: 0, cacheFound: 0, cacheMiss: {}, own: 0, search: 0, accounts: 0, samples: { search: [], conflict: [] } };
  const accounts = new Set();
  for (const e of emails) {
    const k = L.knownAnswer(e, cache, { own, maxAgeMissDays });
    if (!k) { t.search++; if (t.samples.search.length < 8) t.samples.search.push(e.email); continue; }
    const r = k.r;
    if (r.status === 'found') { t[k.via === 'file' ? 'file' : k.via === 'cache' ? 'cacheFound' : 'own']++; accounts.add(k15(r.accountId)); }
    else if (r.status === 'conflict') { t.conflict++; if (t.samples.conflict.length < 8) t.samples.conflict.push(e.email); }
    else t.cacheMiss[r.status] = (t.cacheMiss[r.status] || 0) + 1;
  }
  t.accounts = accounts.size;
  return t;
}

/** The read-only report `node emailSource.js <file>` prints. */
function describe(csv, p, own) {
  const s = csv.stats, n = fmt, lines = [];
  lines.push(`📄 ${csv.file}`);
  const extras = [s.duplicates && `${n(s.duplicates)} repeats`, s.blank && `${n(s.blank)} rows had no address`, s.invalid && `${n(s.invalid)} were not an address`, s.multi && `${n(s.multi)} cells held several addresses: the first is used`].filter(Boolean);
  lines.push(`   ${n(s.rows)} row(s) → ${n(s.unique)} different email address(es)${extras.length ? '  (' + extras.join(', ') + ')' : ''}`);
  lines.push(`   Address column: "${csv.column}"${csv.others.length ? `   (other columns with "email" in the name, not used: ${csv.others.map((o) => `"${o}"`).join(', ')} — to use one: --csv-column "<column>")` : ''}`);
  lines.push(csv.accountColumn ? `   Account named in the file for ${n(s.withAccount)} of ${n(s.unique)} address(es)  (column "${csv.accountColumn}")${s.conflicting ? `, ${n(s.conflicting)} address(es) sit on two accounts in the file and name none` : ''}` : '   The file names no account: every address is matched from a saved lookup, our own files, or a Salesforce search');
  lines.push('');
  lines.push('What each address needs (checked in this order):');
  const row = (c, text, tail = '') => lines.push(`   ${String(n(c)).padStart(7)}  ${text}${tail}`);
  row(p.file, 'the account is named in the file', '                       → no search');
  row(p.cacheFound, 'a saved Salesforce lookup found the account', '        → no search');
  const miss = Object.entries(p.cacheMiss);
  if (miss.length) row(miss.reduce((a, [, v]) => a + v, 0), `a saved lookup found no account (${miss.map(([k, v]) => `${n(v)} ${k}`).join(', ')})`, '  → not emailed');
  row(p.own, 'our own files tie it to exactly one account', '      → no search');
  if (p.conflict) row(p.conflict, 'the file names a different account than a saved lookup', '  → not emailed');
  row(p.search, 'no usable answer yet (new, or an old "no account")', ' → one Salesforce search each (about 15 s)');
  lines.push(`   ${'-'.repeat(7)}`);
  lines.push(`   ${String(n(p.total)).padStart(7)}  address(es) → emails to up to ${n(p.accounts)} different account(s) (one email per account per run; banned, closed-won, customers and the cadence are applied when the run starts)`);
  if (p.samples.search.length) lines.push(`\n   needs a search, for example: ${p.samples.search.join(', ')}`);
  if (p.samples.conflict.length) lines.push(`   file and saved lookup disagree, for example: ${p.samples.conflict.join(', ')}`);
  if (own) lines.push(`\n   (our own files tie ${n(own.size)} address(es) to an account; ${n(own.ambiguous)} of them sit on more than one account and are left to Salesforce)`);
  return lines.join('\n');
}

module.exports = { readEmailCsv, parseCsv, detectDelimiter, ownIndex, ownMatcher, loadOwn, plan, describe };

if (require.main === module) {
  const argv = process.argv.slice(2); let file = null, column = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--column' || argv[i] === '--csv-column') column = argv[++i]; else if (!file && !argv[i].startsWith('--')) file = argv[i]; }
  if (!file) { console.log('\nUsage: node emailSource.js <file.csv> [--column "Email"]\n  Reads the file and says what each address needs (no browser, nothing sent, nothing written).\n'); process.exit(1); }
  try {
    const csv = readEmailCsv(file, { column });
    const own = loadOwn();
    console.log('\n' + describe(csv, plan(csv.emails, { cache: L.readCache(), own }), own));
    console.log(`\n   Send them:   email --email --by-email --csv ${JSON.stringify(file)}${column ? ` --csv-column ${JSON.stringify(column)}` : ''} --core --dry-run     (drop --dry-run to send; --lookup-only matches the accounts and sends nothing)\n`);
  } catch (e) { console.log(`\n  ⚠️  ${e.message}\n`); process.exit(1); }
}
