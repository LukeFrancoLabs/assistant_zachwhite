'use strict';

/**
 * sendQueue — what the dashboard's ⏳ Send queue tab lists: exactly what `email --board` will send, in the order it will reach it, each with an approximate time.
 *
 * The list is the board run's own (boardRun.look → `auto`: the lead's next stage, a text or an email, is ready or becoming ready; a lead that is held, waiting for copy, finished or outside the
 * automatic window), so this tab and `email --board --inspect` cannot disagree. (Until 2026-11-02 the tab was the saved `--queue` list plus the old `--followup` due list: about 2,100 rows, most of
 * them older leads the board shows greyed and never works on its own, and none of the Day 1 text 2s the board was about to send.)
 *
 * The order and the times replay the run (boardRun.runBoard): whoever's window closes soonest goes first, then the earlier stage, then the one that has waited longest; a pass takes the first lead's
 * stage and up to `batchSize` leads of that stage; a text takes `textSec` (the text and the look at the account before it), an email `emailSec`; a lead is only started when its own window is open and
 * stays open `closeMarginMs` more (the run's own hours check); when nobody can go it jumps to the next gap or window. An approximation: the real run reads the board again before every pass and
 * skips whoever the Salesforce check refuses.
 *
 *   schedule(auto, now)               → [{ e, eta }] in the order the run reaches them (eta = ISO time, null = no window in the next 8 days)
 *   counts(all, auto, endOfDayMs)     → the numbers `--board --inspect` prints
 *   introHtml / noteHtml              → the text above the table
 */

const tcpa = require('./tcpa');

let _board = null;
/** boardRun, loaded on first use (the dashboard is the only caller; it keeps this file free of the run's own start-up). */
const board = () => _board || (_board = require('./boardRun'));

const num = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || `${one}s`)}`;

/**
 * `auto` = boardRun.look(...).auto at `now`. o = { textSec, emailSec, batchSize, closeMarginMs, closeAt, hoursReason } (a test passes its own; the defaults are the run's boardRun.DEFAULTS).
 * → [{ e, eta }]: every entry of `auto`, in the order the run will work it. Nothing in `auto` is changed.
 */
function schedule(auto, now = new Date(), o = {}) {
  const D = board().DEFAULTS;
  const textSec = o.textSec != null ? o.textSec : D.textSec + D.checkSec, emailSec = o.emailSec != null ? o.emailSec : D.emailSec;
  const batchSize = o.batchSize || D.batchSize, margin = o.closeMarginMs != null ? o.closeMarginMs : D.closeMarginMs;
  const closeAt = o.closeAt || board().closeAt, hours = o.hoursReason || board().hoursReason;
  const nowMs = now.getTime();
  const secOf = (e) => (e.next.ch === 'email' ? emailSec : textSec) * 1000;

  const items = (auto || []).filter((e) => e && e.next).map((e, i) => {
    const zones = e.lead && e.lead.zones && e.lead.zones.length ? e.lead.zones : null;
    const opens = e.opensAt ? Date.parse(e.opensAt) : NaN;
    return { e, i, zones, zk: zones ? zones.slice().sort().join(',') : '', ready: Number.isFinite(opens) ? Math.max(opens, nowMs) : null, eta: null };
  });
  const done = new Set(), out = [];
  let pending = items.filter((it) => it.ready != null), cursor = nowMs;
  while (pending.length) {
    // who may start right now: its stage's wait is over and its own hours are open (and stay open a little longer)
    const openBy = new Map(), closeBy = new Map();
    const isOpen = (it) => { let v = openBy.get(it.zk); if (v === undefined) { v = hours(it.zones, margin, cursor) === null; openBy.set(it.zk, v); } return v; };
    const closeOf = (it) => { let v = closeBy.get(it.zk); if (v === undefined) { v = closeAt(it.zones, new Date(cursor)); closeBy.set(it.zk, v); } return v; };
    const eligible = pending.filter((it) => it.ready <= cursor && isOpen(it));
    if (!eligible.length) {
      // nobody can go: jump to the next gap that ends or window that opens (one look per set of zones: the earliest ready lead of that set decides it)
      const first = new Map();
      for (const it of pending) { const r = first.get(it.zk); if (r === undefined || it.ready < r) first.set(it.zk, it.ready); }
      let next = Infinity;
      for (const [zk, r] of first) {
        const zones = zk ? zk.split(',') : null, from = Math.max(cursor, r);
        const t = hours(zones, margin, from) === null ? from : (() => { const d = tcpa.openingFor(zones, new Date(from)); return d ? d.getTime() : Infinity; })();
        if (t < next) next = t;
      }
      if (!Number.isFinite(next) || next <= cursor) break;      // no window in the next 8 days for anyone left (or no progress possible): they get no time
      cursor = next;
      continue;
    }
    eligible.sort((a, b) => closeOf(a) - closeOf(b) || a.e.nextIdx - b.e.nextIdx || String(a.e.readyAt || '').localeCompare(String(b.e.readyAt || '')) || a.i - b.i);
    const stage = eligible[0].e.next.id;
    let took = 0;
    for (const it of eligible) {
      if (took >= batchSize) break;
      if (it.e.next.id !== stage) continue;
      if (took > 0 && hours(it.zones, margin, cursor) !== null) continue;      // its window closed while the pass was working: left for its next opening
      it.eta = new Date(cursor).toISOString(); done.add(it); out.push(it); took++;
      cursor += secOf(it.e);
    }
    pending = pending.filter((it) => !done.has(it));
  }
  for (const it of items) if (!done.has(it)) out.push(it);       // no window within 8 days: listed last, with no time
  return out.map((it) => ({ e: it.e, eta: it.eta }));
}

/**
 * The numbers `email --board --inspect` prints, from the same two lists: `all` = every member evaluated, `auto` = the ones the run may work today. endOfDayMs = the run day's last minute (boardRun.endOfRunDay).
 */
function counts(all, auto, endOfDayMs) {
  const c = { board: (all || []).length, worked: (auto || []).length, texts: 0, emails: 0, readyTexts: 0, readyEmails: 0, later: 0, paused: 0, held: 0, old: 0, blocked: 0, finished: 0 };
  for (const e of auto || []) {
    const mail = e.next.ch === 'email';
    if (mail) c.emails++; else c.texts++;
    if (e.dueNow) { if (mail) c.readyEmails++; else c.readyTexts++; }
    else if (e.opensAt && Date.parse(e.opensAt) < endOfDayMs) c.later++;
  }
  for (const e of all || []) {
    if (!e.next) c.finished++;
    else if (e.state === 'paused') c.paused++;
    else if (e.state === 'blocked') c.blocked++;
    else if (e.state === 'held') { if (e.old) c.old++; else c.held++; }
  }
  return c;
}

/** What the tab is, above the table. meta = { autoDays, textSec, emailSec } (the run's own numbers). */
function introHtml(meta = {}) {
  const d = meta.autoDays, days = Number.isFinite(d) ? `${d}-day ` : '';
  return `<div class="sub" style="margin-bottom:10px">Exactly what <code>email --board</code> will send, in the order it will reach it, with an <b>approximate</b> send time: every lead on the follow-up board whose next stage (a text or an email) is ready or becoming ready, the same list as <code>email --board --inspect</code>. A lead the board does not work on its own (held, or older than the ${days}automatic window and not replied in the last 30 days) is not listed. Times are the first moment the lead's own texting window is open after its stage's wait (8:00 AM–8:00 PM their time when the zone is known; 12:00–8:00 PM Eastern when it isn't; never Sunday), then a text about every ${num(meta.textSec || 0)} seconds and an email about every ${num(meta.emailSec || 0)}. They shift if the board isn't running, if the Salesforce check skips a lead, or if a cap is hit. Times shown in your local time.</div>`;
}

/** The counts line under it: what is listed, what is ready, and what the board leaves out and why. c = counts(); o = { autoDays, saved } (saved = live entries of the old `--queue` file). */
function noteHtml(c, o = {}) {
  const left = [];
  if (c.paused) left.push(`${num(c.paused)} asked us to stop`);
  if (c.held) left.push(`${num(c.held)} held (not started on their own)`);
  if (c.old) left.push(`${num(c.old)} older leads that have not replied in the last 30 days (started over ${Number.isFinite(o.autoDays) ? o.autoDays : '7'} days ago; <code>email --board --older</code> includes them)`);
  if (c.blocked) left.push(`${num(c.blocked)} waiting for copy that is not written yet`);
  const lines = [
    `<b>${plural(c.worked, 'lead')}</b> can be worked by the board (${plural(c.texts, 'text')} and ${plural(c.emails, 'email')}). Ready right now: ${plural(c.readyTexts, 'text')} and ${plural(c.readyEmails, 'email')}${c.later ? `; ${num(c.later)} more become ready later today` : ''}. <span class="muted">(as of when this page was built)</span>`,
    `Not listed: ${left.length ? left.join(' · ') : 'nobody'}${c.finished ? ` · ${num(c.finished)} finished every stage` : ''}.`,
  ];
  if (o.saved) lines.push(`The saved <code>--queue</code> list (${plural(o.saved, 'entry', 'entries')}) is not part of this tab: the board does not send from it.`);
  return `<div class="sub" style="margin-bottom:10px">${lines.join('<br>')}</div>`;
}

module.exports = { schedule, counts, introHtml, noteHtml };
