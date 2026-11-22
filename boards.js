'use strict';

/**
 * boards — modular follow-up boards for Pipeline Assistant.
 *
 * Packs live in boards/*.json (tracked defaults). Per-rep overrides + which pack
 * is active live in boards-local.json (gitignored).
 *
 * The Board tab lets a rep change day offsets and templates per stage without
 * editing JSON by hand — e.g. move Outreach 3 from day 1 to day 5.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'boards');
const LOCAL_FILE = path.join(__dirname, 'boards-local.json');
const CADENCE_FILE = path.join(__dirname, 'follow-up-cadence.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function dripPack() {
  const cadence = require('./cadence');
  return {
    id: 'drip',
    name: 'Cold drip (60-day)',
    description: 'The classic Shark/hand-board cadence — texts + emails over ~60 days.',
    tag: null,
    stages: cadence.DEFAULT_STAGES.map((s, i) => ({
      ...s,
      outreach: i + 1,
      hint: s.byHand ? 'By hand — board skips sending this stage.' : (s.manual ? 'Marked manual (board can still send).' : null),
    })),
  };
}

function loadPackFile(id) {
  if (id === 'drip') return dripPack();
  const file = path.join(DIR, `${id}.json`);
  const j = readJson(file, null);
  if (!j || !Array.isArray(j.stages) || !j.stages.length) return null;
  return {
    id: j.id || id,
    name: j.name || id,
    description: j.description || '',
    tag: j.tag || null,
    industry: j.industry || null,
    fresh: !!j.fresh,
    autoDays: j.autoDays != null ? Number(j.autoDays) : null,
    stages: j.stages.map((s, i) => ({
      outreach: s.outreach != null ? Number(s.outreach) : i + 1,
      afterMin: s.afterMin || 0,
      ...s,
      id: String(s.id),
      day: Number(s.day) || 0,
      ch: s.ch === 'text' ? 'text' : 'email',
      n: Number(s.n) || (i + 1),
      label: s.label || `Outreach ${i + 1}`,
    })),
  };
}

function listPacks() {
  const ORDER = ['post-demo', 'nurture', 'drip-hvac', 'drip-plumbing', 'drip-electrical', 'drip'];
  const byId = new Map();
  byId.set('drip', dripPack());
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith('.json')) continue;
      const id = name.replace(/\.json$/, '');
      if (id === 'drip') continue;
      const p = loadPackFile(id);
      if (p) byId.set(p.id, p);
    }
  } catch (_) { /* no boards dir yet */ }
  const ordered = [];
  for (const id of ORDER) {
    if (!byId.has(id)) continue;
    const p = byId.get(id);
    ordered.push({ id: p.id, name: p.name, description: p.description || '', stageCount: p.stages.length, industry: p.industry || null });
    byId.delete(id);
  }
  for (const p of byId.values()) {
    ordered.push({ id: p.id, name: p.name, description: p.description || '', stageCount: (p.stages || []).length, industry: p.industry || null });
  }
  return ordered;
}

function readLocal() {
  return readJson(LOCAL_FILE, {}) || {};
}

function writeLocal(obj) {
  writeAtomic(LOCAL_FILE, JSON.stringify(obj, null, 2) + '\n');
}

function activeBoardId() {
  const local = readLocal();
  if (local.activeBoard && loadPackFile(local.activeBoard)) return local.activeBoard;
  return 'post-demo'; // default for Pipeline Assistant reps: post-demo board
}

function setActiveBoard(id) {
  if (!loadPackFile(id)) return { ok: false, error: 'Unknown board "' + id + '".' };
  const local = readLocal();
  local.activeBoard = id;
  writeLocal(local);
  return { ok: true, activeBoard: id };
}

function packOverrides(packId) {
  const local = readLocal();
  const boards = local.boards && typeof local.boards === 'object' ? local.boards : {};
  const one = boards[packId] && typeof boards[packId] === 'object' ? boards[packId] : {};
  return (one.stages && typeof one.stages === 'object') ? one.stages : {};
}

/** Drip pack also reads legacy follow-up-cadence.json overrides. */
function legacyDripOverrides() {
  const j = readJson(CADENCE_FILE, {}) || {};
  return (j.stages && typeof j.stages === 'object') ? j.stages : {};
}

function mergeStage(base, over) {
  const out = { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of ['template', 'message', 'afterMin', 'label', 'emailTemplate', 'day', 'byHand', 'manual', 'hint']) {
    if (over[k] !== undefined) out[k] = over[k];
  }
  if (over.day !== undefined) {
    const d = Number(over.day);
    if (Number.isFinite(d) && d >= 0) out.day = d;
  }
  if (over.afterMin !== undefined) {
    const m = Number(over.afterMin);
    if (Number.isFinite(m) && m >= 0) out.afterMin = m;
  }
  if (over.message) out.template = null;
  // Rebuild label day prefix when day changes but label still has old "Day N"
  if (over.day !== undefined && out.label) {
    out.label = String(out.label).replace(/Day\s+\d+/i, 'Day ' + out.day);
  }
  return out;
}

function loadPackMerged(id) {
  const pack = loadPackFile(id);
  if (!pack) return null;
  const over = id === 'drip'
    ? { ...legacyDripOverrides(), ...packOverrides('drip') }
    : packOverrides(id);
  const stages = pack.stages.map((s) => mergeStage(s, over[s.id]));
  return { ...pack, stages, overrides: over };
}

function loadActive() {
  return loadPackMerged(activeBoardId()) || loadPackMerged('drip');
}

/**
 * Prefer Tuesday or Friday a few days after the demo.
 * → { dayOffset, weekday, reason }
 */
function suggestNextStepsDay(demoDate = new Date()) {
  const d = new Date(demoDate);
  const dow = d.getDay(); // 0 Sun … 6 Sat
  // Mon/Tue → Friday same week; Wed–Sun → next Tuesday
  let targetDow;
  let reason;
  if (dow === 1 || dow === 2) {
    targetDow = 5; // Friday
    reason = 'Demo was early week → Friday works well for a circle-back.';
  } else {
    targetDow = 2; // Tuesday
    reason = 'Demo was mid/late week → next Tuesday works well for a circle-back.';
  }
  let add = (targetDow - dow + 7) % 7;
  if (add < 3) add += 7; // at least a few days later
  if (add === 0) add = 7;
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { dayOffset: add, weekday: weekdays[targetDow], reason };
}

function saveStage(packId, stageId, payload) {
  const pack = loadPackFile(packId);
  if (!pack) return { ok: false, error: 'Unknown board "' + packId + '".' };
  const base = pack.stages.find((s) => s.id === stageId);
  if (!base) return { ok: false, error: 'Unknown stage "' + stageId + '".' };

  const local = readLocal();
  if (!local.boards || typeof local.boards !== 'object') local.boards = {};
  if (!local.boards[packId] || typeof local.boards[packId] !== 'object') local.boards[packId] = {};
  if (!local.boards[packId].stages || typeof local.boards[packId].stages !== 'object') local.boards[packId].stages = {};
  const cur = { ...(local.boards[packId].stages[stageId] || {}) };

  if (payload && payload.reset) {
    delete local.boards[packId].stages[stageId];
    // Also clear legacy drip override when resetting drip stages
    if (packId === 'drip') {
      const leg = readJson(CADENCE_FILE, {}) || {};
      if (leg.stages && leg.stages[stageId]) {
        delete leg.stages[stageId];
        writeAtomic(CADENCE_FILE, JSON.stringify(leg, null, 2) + '\n');
      }
    }
    writeLocal(local);
    return { ok: true };
  }

  if (payload.day !== undefined && payload.day !== null && payload.day !== '') {
    const d = Number(payload.day);
    if (!Number.isFinite(d) || d < 0 || d > 365) return { ok: false, error: 'Day must be a number from 0 to 365.' };
    cur.day = d;
  }
  if (payload.afterMin !== undefined && payload.afterMin !== null && payload.afterMin !== '') {
    const m = Number(payload.afterMin);
    if (!Number.isFinite(m) || m < 0) return { ok: false, error: 'afterMin must be ≥ 0.' };
    cur.afterMin = m;
  }
  if (base.ch === 'text') {
    if (payload.template != null && String(payload.template).trim()) {
      cur.template = String(payload.template).trim();
      delete cur.message;
    }
  } else if (payload.emailTemplate != null && String(payload.emailTemplate).trim()) {
    cur.emailTemplate = String(payload.emailTemplate).trim();
  }

  local.boards[packId].stages[stageId] = cur;
  // Keep drip overrides mirrored into follow-up-cadence.json so existing board runs pick them up
  if (packId === 'drip') {
    const leg = readJson(CADENCE_FILE, {}) || {};
    if (!leg.stages || typeof leg.stages !== 'object') leg.stages = {};
    leg.stages[stageId] = { ...(leg.stages[stageId] || {}), ...cur };
    writeAtomic(CADENCE_FILE, JSON.stringify(leg, null, 2) + '\n');
  }
  writeLocal(local);
  return { ok: true };
}

/** Stages shaped for cadence.evaluate / copyOf when the active pack is not drip. */
function stagesForCadence() {
  return loadActive().stages;
}

/** Cadence config fragment for a named pack (nurture, post-demo, …). */
function configForPack(id, base = {}) {
  const pack = loadPackMerged(id);
  if (!pack) return null;
  return {
    ...base,
    stages: pack.stages,
    boardId: pack.id,
    boardName: pack.name,
    boardFresh: !!pack.fresh,
    autoDays: pack.autoDays != null && Number.isFinite(pack.autoDays) ? pack.autoDays : (base.autoDays != null ? base.autoDays : 7),
  };
}

module.exports = {
  DIR, LOCAL_FILE,
  listPacks, loadPackFile, loadPackMerged, loadActive, activeBoardId, setActiveBoard,
  saveStage, packOverrides, suggestNextStepsDay, stagesForCadence, configForPack,
};

if (require.main === module) {
  const a = loadActive();
  console.log(`\n  Active board: ${a.name} (${a.id}) — ${a.stages.length} stages\n`);
  for (const s of a.stages) {
    console.log(`  ${String(s.outreach).padStart(2)}. Day ${String(s.day).padStart(2)}  ${s.label.padEnd(36)}  ${s.emailTemplate || s.template || '—'}`);
  }
  const tip = suggestNextStepsDay();
  console.log(`\n  Next-steps tip today: Day ${tip.dayOffset} (${tip.weekday}) — ${tip.reason}\n`);
}
