#!/usr/bin/env node
'use strict';

/**
 * replyPoller — how a REPacked copy fills Analytics (replies) without Luke's Claude Desktop jobs.
 *
 * THE GAP
 *   Sends are logged locally (texted-log.jsonl) → dashboard Sends / Analytics "messages sent" work out of the box.
 *   Replies live in replies.jsonl, which is written by optOut.js AFTER someone feeds it Gmail messages as JSON.
 *   Luke's Mac does that with a Claude Desktop Gmail connector on a schedule. A rep's Mac does not have that
 *   unless they set one up (or use one of the paths below).
 *   Email OPENS are not tracked anywhere in this tool (Gmail does not expose opens; Salesforce Lightning email
 *   status is not scraped). Analytics can show replies and template reply rates, not open rates.
 *
 * PATHS FOR A REP
 *   1) Claude Desktop + Gmail connector (same as Luke): scheduled task pulls SMS-Magic + outreach replies →
 *      pipes JSON into this script. See: node replyPoller.js --setup
 *   2) One-shot ingest of a JSON export: node replyPoller.js --sms emails.json / --email emails.json
 *   3) Manual review queue: node optOut.js --review
 *
 * WHAT GETS WRITTEN
 *   replies.jsonl          → Analytics / Top hit / engagement tabs
 *   banlist.jsonl          → clear STOP opt-outs only
 *   optout-processed.jsonl → dedupe
 *   optout-review.jsonl    → ambiguous matches for a human
 *
 *   node replyPoller.js --setup
 *   node replyPoller.js --sms <emails.json|-> [--dry-run]
 *   node replyPoller.js --email <emails.json|-> [--dry-run]
 *   node replyPoller.js --status
 */

const fs = require('fs');
const path = require('path');
const optOut = require('./optOut');
const textLog = require('./textLog');

const REPLY_FILE = textLog.REPLY_FILE;
const CMD = 'zw';

function readJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function loadEmails(arg) {
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j)) throw new Error('JSON must be an array of { id, subject, body, date, from? }');
  return j;
}

function printSetup() {
  console.log(`
══════════════════════════════════════════════════════════════
  How reps get replies onto the Analytics dashboard
══════════════════════════════════════════════════════════════

  WHAT WORKS TODAY WITHOUT ANY POLLER
  • Every text/email this tool SENDS is already on the localhost dashboard (Sends tab).
  • Template scorecards count messages sent. Reply % stays 0 until replies.jsonl has rows.

  WHAT NEEDS A GMAIL FEED
  • Text replies: Salesforce SMS-Magic emails the rep ("SMS-Magic: New Message received from … via sms").
  • Email replies: the pro hits Reply on the outreach email; it lands in the rep's Gmail.
  • optOut.js reads those messages (as JSON) and appends replies.jsonl for Analytics.

  EMAIL OPENS
  • Not available. Gmail does not tell this tool who opened mail. Salesforce Lightning email
    open/click reports are not wired in. Do not expect an "opened" column unless we later
    add open pixels or a Salesforce engagement scrape (separate project).

  OPTION A — Claude Desktop Gmail connector (closest to Luke's setup)
  1. Install Claude Desktop on the rep's Mac and connect their Gmail account.
  2. Schedule two small jobs (or one combined job) that:
       a) Search Gmail for: subject:(SMS-Magic: New Message received) newer_than:7d
          → build JSON [{ id, subject, body, date }]
          → run:  node replyPoller.js --sms -
       b) Search Gmail for replies to outreach (Re: …) newer_than:7d
          → build JSON [{ id, subject, from, body, date }]
          → run:  node replyPoller.js --email -
  3. Confirm SMS-Magic notification emails are routed to THAT Gmail (Salesforce / SMS-Magic
     settings), not only Luke's inbox.
  4. Open http://127.0.0.1:9340/ → Analytics. Replies should appear after the first successful pull.

  OPTION B — One-shot JSON file (no connector)
  Export or paste messages into emails.json, then:
       node replyPoller.js --sms emails.json
       node replyPoller.js --email emails.json
  Each object needs at least: id (stable Gmail message id), subject, body, date.
  Email replies also need: from.

  OPTION C — Check what is waiting
       node optOut.js --review
       node replyPoller.js --status

  After a pull: refresh the dashboard (or restart ${CMD}) so Analytics reloads replies.jsonl.
`);
}

function printStatus() {
  const replies = readJsonl(REPLY_FILE);
  const processed = readJsonl(optOut.DONE_FILE);
  const review = readJsonl(optOut.REVIEW_FILE);
  const texts = replies.filter((r) => r.channel !== 'email').length;
  const emails = replies.filter((r) => r.channel === 'email').length;
  const interested = replies.filter((r) => r.interested && !r.optout).length;
  const optouts = replies.filter((r) => r.optout).length;
  console.log(`
  replies.jsonl     ${replies.length}  (texts ${texts} · emails ${emails} · interested ${interested} · opt-outs ${optouts})
  processed         ${processed.length}
  needs review      ${review.length}${review.length ? '  →  node optOut.js --review' : ''}
`);
  if (!replies.length) {
    console.log('  Analytics will look empty until a Gmail feed runs. See: node replyPoller.js --setup\n');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const a = argv.find((x) => x === '--setup' || x === '--status' || x === '--sms' || x === '--email' || x === '--help' || x === '-h');
  if (!a || a === '--help' || a === '-h') {
    console.log('usage: node replyPoller.js --setup | --status | --sms <emails.json|-> | --email <emails.json|-> [--dry-run]');
    return;
  }
  if (a === '--setup') return printSetup();
  if (a === '--status') return printStatus();
  const file = argv[argv.indexOf(a) + 1];
  if (!file) { console.error('Pass a JSON file path, or - for stdin.'); process.exit(1); }
  let emails;
  try { emails = loadEmails(file); } catch (e) { console.error(e.message); process.exit(1); }
  if (a === '--sms') {
    const res = optOut.ingest(emails, { dryRun });
    console.log(`\n${dryRun ? '(dry run) ' : ''}${res.length} SMS-Magic email(s)\n`);
    for (const r of res) console.log(`  ${String(r.action).padEnd(16)} ${r.name || ''}  ${r.reply ? '"' + String(r.reply).replace(/\s+/g, ' ').slice(0, 70) + '"' : ''} ${r.detail || ''}`);
    console.log('');
    return;
  }
  if (a === '--email') {
    const res = optOut.ingestEmailReplies(emails, { dryRun });
    console.log(`\n${dryRun ? '(dry run) ' : ''}${res.length} email reply(ies)\n`);
    for (const r of res) console.log(`  ${String(r.action).padEnd(18)} ${r.name || r.from || ''}  ${r.reply ? '"' + String(r.reply).replace(/\s+/g, ' ').slice(0, 70) + '"' : ''} ${r.detail || ''}`);
    console.log('');
  }
}

module.exports = { printSetup, printStatus };

if (require.main === module) {
  try { main(); } catch (e) { console.error(e && e.message ? e.message : e); process.exit(1); }
}
