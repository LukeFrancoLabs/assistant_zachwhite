'use strict';

/**
 * demoBoard — place demo attendees on a board from the date they attended.
 *
 * Migration rule (Eastern calendar):
 *   - Demo before November 1 of this year → Nurture, at the first nurture touch.
 *   - Demo on or after that date → Post-demo, caught up as if they were added on the
 *     demo day and the board had already worked every outreach whose day is on or
 *     before today. A demo 5 days ago has already had every stage through day 5.
 *     The next stage is the first one after that day. Nothing is sent from here.
 *
 * Dates come from auto plans (originalDemo.date), harvest reads (demo.date), and an
 * optional demo-attended.json in this folder (that file wins when it names an account).
 */

const fs = require('fs');
const path = require('path');
const tcpa = require('./tcpa');

const ZONE = 'America/New_York';
const SF_ORIGIN = 'https://housecallpro.lightning.force.com';
const ROSTER_FILE = path.join(__dirname, 'demo-attended.json');
const SNAPSHOT_FILE = path.join(__dirname, 'demo-board.json');
const NODE_W = 220;
const NODE_GAP = 64;
const NODE_H = 108;

function localDay(date) {
  return tcpa.localDay(date instanceof Date ? date : new Date(date), ZONE);
}

/** November 1 of the year `now` falls in, Eastern. 'YYYY-MM-DD'. */
function novemberCutoff(now = new Date()) {
  return localDay(now).slice(0, 4) + '-11-01';
}

/** Whole Eastern calendar days from the demo date to today. Negative if the demo is still ahead. */
function daysSinceDemo(demoDate, now = new Date()) {
  const today = localDay(now);
  const a = Date.parse(String(demoDate).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(today + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function isoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (typeof value === 'object') return isoDate(value.date || value.demoDate || null);
  return null;
}

function sortStages(stages) {
  return (stages || []).slice().sort((a, b) => (Number(a.outreach) || 0) - (Number(b.outreach) || 0) || (Number(a.day) || 0) - (Number(b.day) || 0));
}

/**
 * Where one attendee sits.
 * stages = { postDemo: [...], nurture: [...] } already sorted.
 * → placement fields, including nextStageId (null when the post-demo sequence is already behind them).
 */
function placePerson(person, stages, now = new Date()) {
  const cutoff = novemberCutoff(now);
  const demoDate = isoDate(person && person.demoDate);
  const base = {
    accountId: person && person.accountId || null,
    name: person && person.name || '(unnamed)',
    url: person && person.url || null,
    demoDate,
    source: person && person.source || null,
  };
  if (!demoDate) {
    return { ...base, boardId: null, daysSince: null, doneStageIds: [], nextStageId: null, status: 'no-date', reason: 'No demo attended date.' };
  }
  const days = daysSinceDemo(demoDate, now);
  if (demoDate < cutoff) {
    const first = (stages.nurture || [])[0] || null;
    return {
      ...base,
      boardId: 'nurture',
      daysSince: days,
      doneStageIds: [],
      nextStageId: first ? first.id : null,
      status: 'nurture',
      reason: 'Demo before November — on the nurture board, at the first touch.',
    };
  }
  const post = stages.postDemo || [];
  if (days != null && days < 0) {
    return {
      ...base,
      boardId: 'post-demo',
      daysSince: days,
      doneStageIds: [],
      nextStageId: post[0] ? post[0].id : null,
      status: 'upcoming',
      reason: 'Demo date is still ahead — they start at the first post-demo outreach.',
    };
  }
  const done = post.filter((s) => Number(s.day) <= days);
  const next = post.find((s) => Number(s.day) > days) || null;
  return {
    ...base,
    boardId: 'post-demo',
    daysSince: days,
    doneStageIds: done.map((s) => s.id),
    nextStageId: next ? next.id : null,
    status: next ? 'catchup' : 'complete',
    reason: next
      ? `Demo was ${days} day${days === 1 ? '' : 's'} ago. Outreach through day ${days} counts as already sent. Next is ${next.label}.`
      : `Demo was ${days} day${days === 1 ? '' : 's'} ago. Every post-demo outreach through day ${days} is already behind them.`,
  };
}

function placePeople(people, stages, now = new Date()) {
  const packed = {
    postDemo: sortStages(stages.postDemo),
    nurture: sortStages(stages.nurture),
  };
  return (people || []).map((p) => placePerson(p, packed, now));
}

function accountUrl(id) {
  if (!id) return null;
  return `${SF_ORIGIN}/lightning/r/Account/${id}/view`;
}

function k15(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9]/g, '');
  return s.length >= 15 ? s.slice(0, 15).toLowerCase() : s.toLowerCase();
}

function readRosterFile() {
  try {
    if (!fs.existsSync(ROSTER_FILE)) return [];
    const j = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (_) { return []; }
}

/** People who have a demo attended date, from plans, harvest, and demo-attended.json. */
function collectAttendees() {
  let textLog;
  try { textLog = require('./textLog'); } catch (_) { textLog = null; }
  let sfId;
  try { sfId = require('./sfId'); } catch (_) { sfId = null; }
  const fix = (id) => {
    try { return sfId && id ? sfId.fix(id) : id; } catch (_) { return id; }
  };
  const byKey = new Map();
  const put = (raw, source, priority) => {
    if (!raw) return;
    const id = fix(raw.accountId || raw.id || raw.key);
    const key = k15(id);
    if (!key) return;
    const demoDate = isoDate(raw.demoDate || raw.originalDemo || raw.demo);
    const cur = byKey.get(key);
    if (cur && cur.priority > priority) return;
    if (cur && cur.priority === priority && cur.demoDate && !demoDate) return;
    byKey.set(key, {
      priority,
      accountId: id,
      name: raw.accountName || raw.name || (cur && cur.name) || null,
      url: raw.accountUrl || raw.url || accountUrl(id),
      demoDate: demoDate || (cur && cur.demoDate) || null,
      source: demoDate ? source : (cur && cur.source) || source,
    });
  };

  if (textLog) {
    try {
      for (const p of textLog.readPlans().values()) put(p, 'plan', 2);
    } catch (_) {}
    try {
      for (const h of textLog.readHarvest().values()) if (h && h.ok !== false) put(h, 'harvest', 1);
    } catch (_) {}
  }
  for (const row of readRosterFile()) put(row, 'roster', 3);

  let bans, won, cust;
  try { bans = textLog && textLog.readBans(); } catch (_) { bans = null; }
  try { won = textLog && textLog.readClosedWon(); } catch (_) { won = null; }
  try { cust = textLog && textLog.readCurrentCustomers(); } catch (_) { cust = null; }
  const blocked = (id) => {
    try { if (textLog && bans && textLog.isBanned(id, bans)) return true; } catch (_) {}
    const keys = [String(id || '').toLowerCase(), k15(id)];
    if (won && keys.some((k) => won.get && won.get(k))) return true;
    if (cust && keys.some((k) => cust.get && cust.get(k))) return true;
    return false;
  };

  const out = [];
  for (const row of byKey.values()) {
    if (!row.demoDate) continue;
    if (blocked(row.accountId)) continue;
    out.push({ accountId: row.accountId, name: row.name || '(unnamed)', url: row.url, demoDate: row.demoDate, source: row.source });
  }
  out.sort((a, b) => String(a.demoDate).localeCompare(String(b.demoDate)) || String(a.name).localeCompare(String(b.name)));
  return out;
}

function stageNode(stage, people, x, y) {
  return {
    id: stage.id,
    kind: 'stage',
    label: stage.label,
    day: stage.day,
    ch: stage.ch,
    hint: stage.hint || null,
    x, y,
    people,
  };
}

function layoutBoard(pack, placements) {
  const stages = sortStages(pack.stages);
  const onStage = new Map();
  const donePeople = [];
  for (const p of placements) {
    if (p.boardId !== pack.id) continue;
    if (p.nextStageId && stages.some((s) => s.id === p.nextStageId)) {
      if (!onStage.has(p.nextStageId)) onStage.set(p.nextStageId, []);
      onStage.get(p.nextStageId).push(p);
    } else if (p.status === 'complete') donePeople.push(p);
  }
  const nodes = [];
  stages.forEach((s, i) => {
    nodes.push(stageNode(s, onStage.get(s.id) || [], 16 + i * (NODE_W + NODE_GAP), 24));
  });
  if (pack.id === 'post-demo') {
    nodes.push({
      id: 'post-demo-done',
      kind: 'end',
      label: 'Sequence already behind them',
      day: null,
      ch: null,
      hint: 'Every post-demo outreach on or before their demo age has already passed.',
      x: 16 + stages.length * (NODE_W + NODE_GAP),
      y: 24,
      people: donePeople,
    });
  }
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: '' });
  const width = 16 + nodes.length * (NODE_W + NODE_GAP) + 8;
  const height = 24 + NODE_H + 28;
  return { id: pack.id, name: pack.name, description: pack.description || '', width, height, nodes, edges };
}

function layoutRouter(counts, cutoff, people) {
  const list = people || [];
  const nodes = [
    { id: 'attended', kind: 'start', label: 'Demo attended', day: null, ch: null, hint: 'Date the demo happened.', x: 16, y: 86, people: list.map(publicPerson), count: counts.total },
    { id: 'split', kind: 'decision', label: 'Before November 1?', day: null, ch: null, hint: 'Cutoff ' + cutoff + ' (Eastern).', x: 16 + (NODE_W + NODE_GAP), y: 86, people: [], count: null },
    { id: 'to-nurture', kind: 'board', label: 'Nurture', day: null, ch: 'email', hint: 'First nurture touch. Demos before this November.', x: 16 + 2 * (NODE_W + NODE_GAP), y: 16, people: list.filter((p) => p.status === 'nurture').map(publicPerson), count: counts.nurture },
    { id: 'to-post', kind: 'board', label: 'Post-demo, caught up', day: null, ch: 'email', hint: 'Outreach through today counts as already sent.', x: 16 + 2 * (NODE_W + NODE_GAP), y: 156, people: list.filter((p) => p.boardId === 'post-demo').map(publicPerson), count: counts.postDemo },
  ];
  const edges = [
    { from: 'attended', to: 'split', label: '' },
    { from: 'split', to: 'to-nurture', label: 'Before Nov' },
    { from: 'split', to: 'to-post', label: 'November on' },
  ];
  return { width: 16 + 3 * (NODE_W + NODE_GAP) + 8, height: 156 + NODE_H + 24, nodes, edges };
}

function publicPerson(p) {
  return {
    accountId: p.accountId,
    name: p.name,
    url: p.url,
    demoDate: p.demoDate,
    daysSince: p.daysSince,
    status: p.status,
    reason: p.reason,
    source: p.source,
    nextStageId: p.nextStageId,
  };
}

function payload(now = new Date()) {
  const boards = require('./boards');
  const post = boards.loadPackFile('post-demo');
  const nurture = boards.loadPackFile('nurture');
  const stages = { postDemo: sortStages(post && post.stages), nurture: sortStages(nurture && nurture.stages) };
  const people = placePeople(collectAttendees(), stages, now);
  const counts = {
    total: people.length,
    nurture: people.filter((p) => p.status === 'nurture').length,
    postDemo: people.filter((p) => p.boardId === 'post-demo').length,
    catchup: people.filter((p) => p.status === 'catchup' || p.status === 'upcoming').length,
    complete: people.filter((p) => p.status === 'complete').length,
  };
  const packs = [];
  for (const meta of boards.listPacks()) {
    const pack = boards.loadPackFile(meta.id);
    if (!pack) continue;
    packs.push(layoutBoard(pack, people));
  }
  const body = {
    ok: true,
    cutoff: novemberCutoff(now),
    zone: ZONE,
    counts,
    people: people.map(publicPerson),
    router: layoutRouter(counts, novemberCutoff(now), people),
    boards: packs,
    nodeWidth: NODE_W,
    nodeHeight: NODE_H,
    generatedAt: new Date(now).toISOString(),
  };
  try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ generatedAt: body.generatedAt, cutoff: body.cutoff, people: body.people }, null, 2) + '\n'); } catch (_) {}
  return body;
}

module.exports = {
  ZONE, ROSTER_FILE, SNAPSHOT_FILE, NODE_W, NODE_H,
  novemberCutoff, daysSinceDemo, isoDate, placePerson, placePeople, collectAttendees, payload,
};

if (require.main === module) {
  const now = new Date('2026-11-23T15:00:00Z'); // 10:00 AM Eastern
  const postDemo = [
    { id: 'pd1', outreach: 1, day: 0, label: 'Outreach 1' },
    { id: 'pd2', outreach: 2, day: 1, label: 'Outreach 2' },
    { id: 'pd3', outreach: 3, day: 1, label: 'Outreach 3' },
    { id: 'pd4', outreach: 4, day: 4, label: 'Outreach 4' },
  ];
  const nurture = [{ id: 'nu1', outreach: 1, day: 0, label: 'Nurture 1' }];
  const stages = { postDemo, nurture };
  const cases = [
    ['2026-10-02', 'nurture', 'nu1', 'before November'],
    ['2026-11-18', 'post-demo', null, '5 days ago, through day 5, sequence done'],
    ['2026-11-22', 'post-demo', 'pd4', '1 day ago, through day 1, next is day 4'],
    ['2026-11-23', 'post-demo', 'pd2', 'today, day 0 already worked, next is day 1'],
  ];
  let failed = 0;
  for (const [demoDate, boardId, nextStageId, label] of cases) {
    const p = placePerson({ name: label, accountId: '001', demoDate }, stages, now);
    const ok = p.boardId === boardId && p.nextStageId === nextStageId;
    if (!ok) {
      failed++;
      console.error('FAIL', label, p);
    } else console.log('ok', label, '→', p.boardId, p.nextStageId || 'done', `(${p.daysSince}d)`);
  }
  if (novemberCutoff(now) !== '2026-11-01') { failed++; console.error('cutoff', novemberCutoff(now)); }
  if (failed) process.exit(1);
  console.log('demoBoard checks passed');
}
