'use strict';

/**
 * contentLibrary — browse the Sales Content Finder snapshot for Pipeline Assistant.
 *
 * Data from content-library/ (refresh with: node syncContentLibrary.js).
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'content-library');
const LIB = path.join(DIR, 'library.json');
const INDEX = path.join(DIR, 'index.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function asOptions(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    if (x && typeof x === 'object') return { id: String(x.id != null ? x.id : x.label || ''), label: String(x.label || x.id || '') };
    return { id: String(x), label: String(x) };
  }).filter((x) => x.id);
}

function catalog() {
  const assets = readJson(LIB, []);
  const index = readJson(INDEX, null);
  return {
    source: (index && index.source) || 'https://hcp-brand-content.github.io/sales-content-finder/',
    syncedAt: (index && index.syncedAt) || null,
    assetCount: Array.isArray(assets) ? assets.length : 0,
    pathCount: index && Array.isArray(index.paths) ? index.paths.length : 0,
    trades: asOptions(index && index.trades),
    needs: asOptions(index && index.needs),
    competitors: asOptions(index && index.competitors),
    segments: asOptions(index && index.segments),
    regions: asOptions(index && index.regions),
  };
}

function listAssets({ trade, need, q, type, limit = 80 } = {}) {
  let assets = readJson(LIB, []);
  if (!Array.isArray(assets)) assets = [];
  const qq = String(q || '').toLowerCase().trim();
  const needKey = need ? String(need) : '';
  assets = assets.filter((a) => {
    if (trade && trade !== 'any' && trade !== 'any_mech') {
      const mech = ['HVAC', 'Plumbing', 'Electrical', 'Refrigeration'];
      if (a.trade !== trade && a.trade !== 'All' && !(a.trade === 'Mechanical' && mech.includes(trade))) return false;
    }
    if (trade === 'any_mech') {
      const mech = ['HVAC', 'Plumbing', 'Electrical', 'Refrigeration', 'Mechanical', 'All'];
      if (!mech.includes(a.trade)) return false;
    }
    if (needKey) {
      const needs = Array.isArray(a.need) ? a.need : [a.need];
      if (!needs.map(String).includes(needKey) && !(needKey === 'proof' && a.type === 'Case study')) return false;
    }
    if (type && a.type !== type) return false;
    if (qq) {
      const hay = [a.title, a.id, a.trade, a.competitor, a.triggers, a.why, a.subject, a.moment].join(' ').toLowerCase();
      if (!hay.includes(qq)) return false;
    }
    return true;
  });
  return assets.slice(0, Math.max(1, Math.min(200, Number(limit) || 80))).map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    trade: a.trade,
    need: a.need,
    competitor: a.competitor || null,
    segment: a.segment || null,
    region: a.region || null,
    priority: a.priority || null,
    url: a.url,
    subject: a.subject || null,
    sms: a.sms || null,
    why: a.why || null,
    useWhen: a.useWhen || null,
    cta: a.cta || null,
    email: a.email || null,
  }));
}

function findPath({ trade, need, competitor, segment, region, stage } = {}) {
  const index = readJson(INDEX, null);
  if (!index || !Array.isArray(index.paths)) return { ok: false, error: 'Content index missing. Run: node syncContentLibrary.js' };
  const t = trade || 'any';
  const n = need || null;
  const c = competitor || null;
  const s = segment || null;
  const r = region || null;
  const st = stage || 'demo';

  const exact = index.paths.find((p) =>
    p.path.trade === t
    && (p.path.need || null) === n
    && (p.path.competitor || null) === c
    && (p.path.segment || null) === s
    && (p.path.region || null) === r
    && (p.path.stage || 'demo') === st
  );
  if (exact) return { ok: true, ...exact, catalog: catalog() };

  // Fall back to nearest path with same trade+need
  const near = index.paths.find((p) =>
    p.path.trade === t
    && (p.path.need || null) === n
    && !p.path.competitor && !p.path.segment && !p.path.region
    && (p.path.stage || 'demo') === 'demo'
  );
  if (near) return { ok: true, ...near, approximate: true, catalog: catalog() };
  return { ok: true, path: { trade: t, need: n, competitor: c, segment: s, region: r, stage: st }, best: null, also: [], catalog: catalog() };
}

function payload(query = {}) {
  const cat = catalog();
  const assets = listAssets(query);
  const match = findPath(query);
  return {
    ...cat,
    query: {
      trade: query.trade || 'any',
      need: query.need || '',
      competitor: query.competitor || '',
      segment: query.segment || '',
      region: query.region || '',
      q: query.q || '',
      type: query.type || '',
    },
    match: match.ok ? { best: match.best, also: match.also || [], tradePick: match.tradePick || null, approximate: !!match.approximate, startHere: !!match.startHere } : null,
    assets,
  };
}

module.exports = { catalog, listAssets, findPath, payload, DIR, LIB, INDEX };
