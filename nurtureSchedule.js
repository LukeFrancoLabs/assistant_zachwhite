'use strict';

/**
 * nurtureSchedule — space nurture touches across a long wait (fall → summer),
 * then ramp up as the reconnect date approaches.
 *
 * Quiet period: 1–2 soft touches only.
 * Ramp (last ~45 days): denser soft touches, then graduate to #reengage.
 */

const path = require('path');

const SEASONS = {
  spring: { month: 3, day: 1, label: 'spring' },
  summer: { month: 6, day: 1, label: 'summer' },
  fall: { month: 9, day: 1, label: 'fall' },
  autumn: { month: 9, day: 1, label: 'fall' },
  winter: { month: 12, day: 1, label: 'winter' },
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const RAMP_DAYS = 45; // denser touches in the last ~45 days before reconnect
const MIN_SPAN = 21;
const MAX_SPAN = 730;

function dayNum(isoOrDate) {
  const d = new Date(isoOrDate);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 864e5);
}

function addDays(from, n) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString();
}

function utcNoon(y, m, day) {
  return new Date(Date.UTC(y, m - 1, day, 12, 0, 0)).toISOString();
}

/** Next occurrence of month/day at or after `now` (UTC calendar). */
function nextMonthDay(month, day, now = new Date()) {
  const y = now.getUTCFullYear();
  let at = utcNoon(y, month, day);
  if (Date.parse(at) <= now.getTime() + 3 * 864e5) at = utcNoon(y + 1, month, day);
  return at;
}

/**
 * Parse "summer", "june", "2026-06-01", "6/1", "90 days".
 * → { at, label, kind: 'season'|'month'|'date'|'days' } | { error }
 */
function parseReconnectWhen(input, now = new Date()) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { error: 'no reconnect timing given' };
  const t = raw.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  const daysM = t.match(/^(\d+)\s*d(?:ays?)?$/);
  if (daysM) {
    const n = Number(daysM[1]);
    if (n < MIN_SPAN || n > MAX_SPAN) return { error: `reconnect window must be ${MIN_SPAN}–${MAX_SPAN} days` };
    return { at: addDays(now, n), label: `${n} days`, kind: 'days', days: n };
  }

  if (SEASONS[t]) {
    const s = SEASONS[t];
    return { at: nextMonthDay(s.month, s.day, now), label: s.label, kind: 'season' };
  }

  if (MONTHS[t]) {
    return { at: nextMonthDay(MONTHS[t], 1, now), label: t, kind: 'month' };
  }

  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const at = utcNoon(+m[1], +m[2], +m[3]);
    if (Date.parse(at) <= now.getTime()) return { error: 'reconnect date must be in the future' };
    return { at, label: at.slice(0, 10), kind: 'date' };
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getUTCFullYear();
    let at = utcNoon(y, mo, d);
    if (Date.parse(at) <= now.getTime() + 3 * 864e5) at = utcNoon(y + 1, mo, d);
    return { at, label: at.slice(0, 10), kind: 'date' };
  }

  return { error: `cannot read "${input}" — try summer, june, 2026-06-01, or 90 days` };
}

function loadBaseStages() {
  try {
    const pack = require('./boards').loadPackFile('nurture');
    return (pack && pack.stages) || [];
  } catch (_) {
    return [];
  }
}

/**
 * Day offsets from join → reconnect.
 * Long waits stay quiet early; last RAMP_DAYS densify before reconnect.
 */
function dayOffsetsForSpan(spanDays) {
  const D = Math.max(MIN_SPAN, Math.min(MAX_SPAN, Math.round(spanDays)));
  if (D <= 45) {
    // Compact: scale the classic 14/28/45/60/75/90 shape into D
    const fracs = [0.15, 0.30, 0.50, 0.65, 0.82, 0.95];
    return uniqueSorted(fracs.map((f) => Math.max(1, Math.round(D * f))));
  }
  const rampStart = Math.max(1, D - RAMP_DAYS);
  const quiet = uniqueSorted([
    Math.max(14, Math.round(D * 0.08)),
    Math.max(28, Math.round(D * 0.28)),
  ].filter((d) => d < rampStart - 7));
  const ramp = uniqueSorted([
    rampStart,
    Math.round(D - 30),
    Math.round(D - 14),
    Math.round(D - 3),
  ].filter((d) => d > quiet[quiet.length - 1] && d < D && d >= 1));
  return uniqueSorted(quiet.concat(ramp)).slice(0, 6);
}

function uniqueSorted(arr) {
  return [...new Set(arr.map((n) => Math.round(n)).filter((n) => n >= 1))].sort((a, b) => a - b);
}

/**
 * → { spanDays, reconnectAt, expiresAt, reconnectLabel, stages }
 * Stages are pack templates with day offsets stretched to the reconnect window.
 */
function buildNurturePlan({ from = new Date(), until = null, reconnect = null, label = null } = {}) {
  const start = from instanceof Date ? from : new Date(from);
  let untilAt = until;
  let untilLabel = label;
  if (reconnect && !untilAt) {
    const p = parseReconnectWhen(reconnect, start);
    if (p.error) return { error: p.error };
    untilAt = p.at;
    untilLabel = p.label;
  }
  if (!untilAt) {
    // Default: pack expiresDays (90)
    let days = 90;
    try {
      const pack = require('./boards').loadPackFile('nurture');
      if (pack && pack.expiresDays) days = Number(pack.expiresDays) || 90;
    } catch (_) { /* default */ }
    untilAt = addDays(start, days);
    untilLabel = untilLabel || `${days} days`;
  }
  const spanDays = dayNum(untilAt) - dayNum(start);
  if (spanDays < MIN_SPAN) return { error: `reconnect is only ${spanDays} days out — need at least ${MIN_SPAN}` };
  if (spanDays > MAX_SPAN) return { error: `reconnect is ${spanDays} days out — max ${MAX_SPAN}` };

  const offsets = dayOffsetsForSpan(spanDays);
  const base = loadBaseStages();
  if (!base.length) return { error: 'nurture pack has no stages' };

  const stages = offsets.map((day, i) => {
    const src = base[Math.min(i, base.length - 1)];
    const quiet = day < spanDays - RAMP_DAYS;
    return {
      ...src,
      id: src.id || ('nur' + (i + 1)),
      outreach: i + 1,
      day,
      n: src.ch === 'email'
        ? offsets.slice(0, i + 1).filter((_, j) => (base[Math.min(j, base.length - 1)].ch === 'email')).length
        : offsets.slice(0, i + 1).filter((_, j) => (base[Math.min(j, base.length - 1)].ch !== 'email')).length,
      label: `Day ${day} · ${String(src.label || '').replace(/^Day\s+\d+\s*·\s*/i, '') || (src.ch === 'email' ? 'Email' : 'Text')}`,
      hint: quiet
        ? (src.hint || 'Quiet-period soft touch — long wait until reconnect.')
        : ('Getting close to reconnect (' + (untilLabel || 'target') + '). ' + (src.hint || '')),
    };
  });

  // Fix n counters properly from assigned ch
  let textN = 0, emailN = 0;
  for (const s of stages) {
    if (s.ch === 'email') { emailN++; s.n = emailN; }
    else { textN++; s.n = textN; }
  }

  return {
    spanDays,
    reconnectAt: new Date(untilAt).toISOString(),
    expiresAt: new Date(untilAt).toISOString(),
    reconnectLabel: untilLabel || String(untilAt).slice(0, 10),
    stages,
    rampDays: RAMP_DAYS,
  };
}

module.exports = {
  SEASONS, RAMP_DAYS, MIN_SPAN, MAX_SPAN,
  parseReconnectWhen, buildNurturePlan, dayOffsetsForSpan, addDays, nextMonthDay,
};

if (require.main === module) {
  const arg = process.argv[2] || 'summer';
  const plan = buildNurturePlan({ reconnect: arg, from: new Date() });
  if (plan.error) { console.error(plan.error); process.exit(1); }
  console.log(`\n  Nurture until ${plan.reconnectLabel} (${plan.spanDays} days) → #reengage\n`);
  for (const s of plan.stages) {
    console.log(`  Day ${String(s.day).padStart(3)}  ${s.ch.padEnd(5)}  ${s.label}`);
  }
  console.log('');
}
