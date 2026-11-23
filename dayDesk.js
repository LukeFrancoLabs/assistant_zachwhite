'use strict';

/**
 * dayDesk — data for the Pipeline Assistant localhost page (no Shark/LDS campaigns).
 *
 * Builds one JSON payload for /api/daydesk:
 *   morning   — ranked "what needs me today" (holds, interested replies needing follow-up, personal board due)
 *   replies   — recent inbound replies (from replies.jsonl)
 *   kit       — post-call / post-demo quick actions (from team-shared/day-desk.json or built-in defaults)
 *   myLeads   — hand-added personal follow-ups + next stage
 *   today     — what this copy already sent today
 *
 * Never sends. Never touches Salesforce. Safe to call from the dashboard server.
 */

const fs = require('fs');
const path = require('path');

const SHARED_DIR = process.env.ASSISTANT_TEAM_SHARED || path.join(__dirname, 'team-shared');
const DESK_FILE = path.join(SHARED_DIR, 'day-desk.json');
const NOTE_RE = /^\s*\[Top hit list\]/i;
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);

const DEFAULT_KIT = [
  { id: 'day-after-demo', kind: 'email', key: 'day-after-demo', label: 'Day-after-demo email', hint: 'Send after a demo while it’s fresh' },
  { id: 'book-demo', kind: 'text', template: '9', label: 'Book a demo text', hint: 'Short booking-link text' },
  { id: 'account-idea', kind: 'text', template: '10', label: 'Account idea + book demo', hint: 'Longer first-touch style text' },
  { id: 'respectful', kind: 'text', template: '5', label: 'Respectful follow-up', hint: 'Soft close / timing check' },
  { id: 'curiosity', kind: 'email', key: 'curiosity', label: 'Curiosity email', hint: 'Campaigns + Pipeline angle' },
];

function loadKit() {
  try {
    const j = JSON.parse(fs.readFileSync(DESK_FILE, 'utf8'));
    if (j && Array.isArray(j.kit) && j.kit.length) return j.kit;
  } catch (_) { /* defaults */ }
  return DEFAULT_KIT;
}

function sfUrl(id) {
  if (!id) return null;
  try { return require('./sfId').fixUrl('https://housecallpro.lightning.force.com/lightning/r/Account/' + id + '/view'); }
  catch (_) { return 'https://housecallpro.lightning.force.com/lightning/r/Account/' + id + '/view'; }
}

function clip(s, n = 220) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function kitPayload() {
  const kit = loadKit();
  let emails = {};
  try { emails = JSON.parse(fs.readFileSync(path.join(__dirname, 'email-templates.json'), 'utf8')) || {}; } catch (_) {}
  let texts = {};
  try {
    const setup = require('./senderSetup');
    const view = setup.textsView();
    for (const item of view.items) texts[item.id] = item;
  } catch (_) { /* templates optional */ }

  return kit.map((k) => {
    if (k.kind === 'email') {
      const t = emails[k.key] || {};
      const body = Array.isArray(t.body) ? t.body.join('\n') : String(t.body || '');
      return {
        id: k.id, kind: 'email', key: k.key, label: k.label || t.name || k.key, hint: k.hint || '',
        subject: t.subject || '', preview: clip(body, 280),
        command: null,
      };
    }
    const t = texts[String(k.template)] || {};
    return {
      id: k.id, kind: 'text', template: String(k.template), label: k.label || t.name || ('Text ' + k.template), hint: k.hint || '',
      preview: clip(t.text || '', 280),
      command: null,
    };
  });
}

function morningFromHolds() {
  try {
    return require('./holdInbox').open().map((h) => ({
      kind: 'hold',
      priority: 1,
      title: h.kind === 'replied' ? 'Pro replied — held' : 'Teammate texted — held',
      name: h.accountName || '(unknown)',
      accountId: h.accountId || null,
      url: h.accountUrl || sfUrl(h.accountId),
      at: h.at,
      detail: clip(h.reason || h.kind),
      status: h.status || 'new',
      action: 'Open the account in Salesforce',
    }));
  } catch (_) { return []; }
}

function morningFromReplies(now = new Date()) {
  let rows = [];
  try { rows = require('./textLog').readReplyRows(); } catch (_) { return []; }
  const byAcct = new Map();
  try {
    const all = require('./textLog').readAll();
    for (const r of all) {
      const k = k15(r.accountId); if (!k) continue;
      const t = Date.parse(r.at); if (!Number.isFinite(t)) continue;
      if (!byAcct.has(k) || t > byAcct.get(k)) byAcct.set(k, t);
    }
  } catch (_) {}

  const seen = new Set();
  const out = [];
  const sorted = rows.slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  for (const r of sorted) {
    if (r.manual || NOTE_RE.test(r.reply || '')) continue;
    if (r.optout) continue;
    if (!r.interested) continue;
    const k = r.accountId ? k15(r.accountId) : `n:${String(r.accountName || '').toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const lastSend = r.accountId ? byAcct.get(k15(r.accountId)) : null;
    const replyT = Date.parse(r.at);
    const after = Number.isFinite(lastSend) && Number.isFinite(replyT) ? lastSend > replyT : false;
    if (after) continue; // already followed up after the reply
    const ageDays = Number.isFinite(replyT) ? Math.round((now.getTime() - replyT) / 864e5 * 10) / 10 : null;
    out.push({
      kind: 'interested',
      priority: 2,
      title: 'Interested reply — needs a follow-up',
      name: r.accountName || '(unknown)',
      accountId: r.accountId || null,
      url: sfUrl(r.accountId),
      at: r.at,
      detail: clip(r.reply),
      ageDays,
      channel: r.channel === 'email' ? 'email' : 'text',
      action: 'Open the account, then pick the check-in on Quick kit',
    });
    if (out.length >= 40) break;
  }
  return out;
}

function morningFromPersonalBoard(now = new Date()) {
  try {
    const cadence = require('./cadence');
    const textLog = require('./textLog');
    const cfg = cadence.loadConfig();
    const members = cadence.members({ textLog, now }).filter((m) => m.hand);
    const evaluated = cadence.board(members, cfg, now);
    return evaluated.filter((e) => e.dueNow || e.state === 'due').map((e) => ({
      kind: 'board',
      priority: 3,
      title: e.next ? ('Due: ' + e.next.label) : 'Board due',
      name: e.lead.name,
      accountId: e.lead.accountId,
      url: e.lead.url || sfUrl(e.lead.accountId),
      at: e.readyAt || e.lead.enrolledAt || null,
      detail: e.next ? (e.next.ch === 'email' ? 'Email stage ready' : 'Text stage ready') : (e.hold || e.state),
      stage: e.next ? e.next.id : null,
      action: e.next && e.next.ch === 'email'
        ? 'Email stage is ready — open the account'
        : 'Text stage is ready — open the account',
    }));
  } catch (_) { return []; }
}

function myLeadsPayload(now = new Date()) {
  try {
    const cadence = require('./cadence');
    const textLog = require('./textLog');
    const cfg = cadence.loadConfig();
    const members = cadence.members({ textLog, now }).filter((m) => m.hand);
    const evaluated = cadence.board(members, cfg, now);
    return evaluated.map((e) => ({
      name: e.lead.name,
      accountId: e.lead.accountId,
      url: e.lead.url || sfUrl(e.lead.accountId),
      tags: e.lead.own || [],
      state: e.state,
      next: e.next ? e.next.label : (e.state === 'finished' ? 'Finished' : null),
      dueNow: !!e.dueNow,
      hold: e.hold || null,
      lastAt: e.lastAt || null,
      enrolledAt: e.lead.enrolledAt || null,
      addCommand: null,
    })).sort((a, b) => (b.dueNow ? 1 : 0) - (a.dueNow ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  } catch (_) { return []; }
}

function repliesPayload() {
  let rows = [];
  try { rows = require('./textLog').readReplyRows(); } catch (_) { return []; }
  return rows
    .filter((r) => r && !r.manual && !NOTE_RE.test(r.reply || ''))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, 200)
    .map((r) => ({
      at: r.at,
      name: r.accountName || '(unknown)',
      accountId: r.accountId || null,
      url: sfUrl(r.accountId),
      ch: r.channel === 'email' ? 'email' : 'text',
      reply: clip(r.reply, 400),
      interested: !!r.interested,
      optout: !!r.optout,
      gift: !!r.gift,
    }));
}

function todayPayload() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  let rows = [];
  try {
    rows = require('./textLog').readAll().filter((r) => r && r.mode !== 'manual' && Date.parse(r.at) >= t0);
  } catch (_) { rows = []; }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let texts = 0, emails = 0;
  const list = rows.slice(0, 100).map((r) => {
    const ch = r.channel === 'email' ? 'email' : 'text';
    if (ch === 'email') emails++; else texts++;
    return {
      at: r.at,
      name: r.accountName || r.email || '(no name)',
      url: r.accountUrl || sfUrl(r.accountId),
      channel: ch,
      template: r.templateName || null,
      subject: ch === 'email' ? (r.subject || null) : null,
      preview: clip(ch === 'email' ? r.body : r.message, 160),
    };
  });
  // recount from all today rows not just preview
  texts = 0; emails = 0;
  for (const r of rows) { if (r.channel === 'email') emails++; else texts++; }
  return { sends: rows.length, texts, emails, rows: list };
}

function howToAddLead() {
  return {
    hint: 'After you talk to a pro, add them here. The board updates as soon as you click Add.',
    command: null,
  };
}

function build() {
  const now = new Date();
  const morning = []
    .concat(morningFromHolds())
    .concat(morningFromReplies(now))
    .concat(morningFromPersonalBoard(now))
    .sort((a, b) => (a.priority - b.priority) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

  let replyCount = 0;
  try { replyCount = require('./textLog').readReplyRows().filter((r) => r && !r.manual).length; } catch (_) {}

  return {
    generatedAt: now.toISOString(),
    morning,
    replies: repliesPayload(),
    kit: kitPayload(),
    myLeads: myLeadsPayload(now),
    today: todayPayload(),
    addLead: howToAddLead(),
    meta: {
      replyFeedReady: replyCount > 0,
      replyHint: replyCount > 0 ? null : 'Replies appear after a Gmail feed runs (node replyPoller.js --setup). Holds still show if a send was paused.',
      sharedDir: SHARED_DIR,
    },
  };
}

module.exports = { build, loadKit, DEFAULT_KIT, SHARED_DIR, DESK_FILE };

if (require.main === module) {
  const d = build();
  console.log(`\n  Pipeline Assistant  morning=${d.morning.length}  replies=${d.replies.length}  myLeads=${d.myLeads.length}  today=${d.today.sends}\n`);
  for (const m of d.morning.slice(0, 8)) console.log(`  • [${m.kind}] ${m.name} — ${m.title}`);
  console.log('');
}
