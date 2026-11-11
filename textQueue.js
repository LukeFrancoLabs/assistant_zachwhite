'use strict';

/**
 * textQueue — a DURABLE "text these later" list snapshotted from a report.
 *
 * WHY: the T14 report only shows opps with no recent outreach. The moment you EMAIL
 * a lead on that report, it bumps the account's last-outgoing communication and the
 * lead drops off the report — so you lose it before you can text it. `email
 * --save` snapshots every lead on the open report into this queue BEFORE you email,
 * and `email --queue` texts them later, straight from the saved list, even after
 * they've vanished from the report.
 *
 * Storage: text-queue.json — a JSON array of entries:
 *   { accountId, accountName, accountUrl, lastOutgoingSms, savedAt, status, textedAt }
 * status: 'pending' (waiting to be texted) | 'texted' (done).
 * Gitignored (lead PII).
 *
 * WHO IS STILL WAITING: only a queue run (--queue, the --send day, the overnight run) or the ➕ box marks an entry 'texted'. The follow-up board, --followup, --same-day, --evening and a text
 * sent by hand reach the same pros and write only the texted log, so an entry one of them already reached would stay 'pending' here, show on the dashboard's send queue, and be texted AGAIN by
 * the next --queue run (the never-the-same-text, once-a-day and contact-ledger guards cover one template, 24 hours and about 48, not a different template a few days later). So the queue reads
 * the texted log too: a pending entry with a text of ours dated at or after its `savedAt` counts as texted (pendingLeads, summary, addLeads and textedElsewhere all agree). That is worked out on
 * every read and never written, so a hand text taken back with --remove-lead puts the entry back, and a log that cannot be read just turns the check off.
 */

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, 'text-queue.json');

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);   // how ids are compared everywhere: the log holds one account under its 15- and its 18-character id, in any case

function load() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

function save(arr) {
  // Written to a temp file and renamed over the queue: a run that polls the queue (--tomorrow checks it every 30 s) never reads a half-written file, which load() would see as an empty queue.
  try { const tmp = `${QUEUE_FILE}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8'); fs.renameSync(tmp, QUEUE_FILE); } catch (_) {}
}

/**
 * key15 → the times (ms) of every TEXT of ours to that account, from the permanent texted log. An email is not a text (the queue exists for the pros an email took off the report); a legacy row
 * with no channel is a text. `rows` = textLog.readAll() (a test passes its own). → null when the log cannot be read: the check is then off and the queue behaves as it did before it existed.
 */
function textTimes(rows) {
  try {
    const times = new Map();
    for (const r of rows || require('./textLog').readAll()) {
      if (!r || r.channel === 'email') continue;
      const k = k15(r.accountId), t = Date.parse(r.at);
      if (!k || !Number.isFinite(t)) continue;
      if (!times.has(k)) times.set(k, []);
      times.get(k).push(t);
    }
    return times;
  } catch (_) { return null; }
}

/** → the time (ms) of the first text of ours to this entry's account at or after the moment it was saved, or null (no log, no usable savedAt, no such text: the entry stays as it was). */
function textedSince(entry, times) {
  const saved = Date.parse(entry && entry.savedAt), list = times && times.get(k15(entry && entry.accountId));
  if (!list || !Number.isFinite(saved)) return null;
  let first = null;
  for (const t of list) if (t >= saved && (first === null || t < first)) first = t;
  return first;
}

/** The pending entries of `queue`, split by what the texted log says → { live: [entry], elsewhere: [{ entry, at }] } (`at` = ISO time of the text that already reached them). */
function split(queue, rows) {
  const times = textTimes(rows), live = [], elsewhere = [];
  for (const e of queue.filter((x) => x.status === 'pending')) {
    const at = textedSince(e, times);
    if (at === null) live.push(e); else elsewhere.push({ entry: e, at: new Date(at).toISOString() });
  }
  return { live, elsewhere };
}

/**
 * Add harvested leads to the queue. Skips any whose accountId is already in the queue
 * (any status) so re-saving the same report doesn't duplicate. Optionally also skips
 * accountIds passed in `alreadyTexted` (e.g. from the texted-log). Returns a summary
 * (`pending` is what a --queue run will work: entries the log shows as texted since they were saved are not counted).
 */
function addLeads(leads, { alreadyTexted = new Set(), source = null, rows = null } = {}) {
  const queue = load();
  const have = new Set(queue.map((e) => e.accountId).filter(Boolean));
  const savedAt = new Date().toISOString();
  let added = 0, dupQueue = 0, dupTexted = 0, noId = 0;
  for (const l of leads) {
    if (!l.accountId) { noId++; continue; }
    if (have.has(l.accountId)) { dupQueue++; continue; }
    if (alreadyTexted.has(l.accountId)) { dupTexted++; continue; }
    queue.push({
      accountId: l.accountId,
      accountName: l.name || null,
      accountUrl: l.url || null,
      lastOutgoingSms: l.lastOutgoingSms || null,
      savedAt,
      source: source && source.kind ? { kind: source.kind, name: source.name || null } : null,   // the report it was saved from (LDS / Shark)
      status: 'pending',
      textedAt: null,
    });
    have.add(l.accountId);
    added++;
  }
  save(queue);
  return { added, dupQueue, dupTexted, noId, total: queue.length, pending: split(queue, rows).live.length };
}

/** Pending entries, oldest-saved first, as lead objects runReportCampaign understands — without the ones the texted log shows were already texted since they were saved (see the header). */
function pendingLeads({ rows = null } = {}) {
  return split(load(), rows).live
    .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt))
    .map((e) => ({ name: e.accountName || '(unnamed account)', accountId: e.accountId, url: e.accountUrl, lastOutgoingSms: e.lastOutgoingSms || null, source: e.source || null }));
}

/** The entries still 'pending' in the file that the texted log says another mode already texted (what pendingLeads leaves out): [{ accountId, accountName, accountUrl, savedAt, textedAt }], oldest-saved first. */
function textedElsewhere({ rows = null } = {}) {
  return split(load(), rows).elsewhere
    .sort((a, b) => new Date(a.entry.savedAt) - new Date(b.entry.savedAt))
    .map(({ entry: e, at }) => ({ accountId: e.accountId, accountName: e.accountName || null, accountUrl: e.accountUrl || null, savedAt: e.savedAt, textedAt: at }));
}

/** Mark an account as texted (so --queue won't text it again). */
function markTexted(accountId) {
  if (!accountId) return;
  const queue = load();
  const e = queue.find((x) => x.accountId === accountId && x.status === 'pending');
  if (e) { e.status = 'texted'; e.textedAt = new Date().toISOString(); save(queue); }
}

/** Remove all 'texted' entries (optional housekeeping). Returns how many were cleared. */
function clearTexted() {
  const queue = load();
  const kept = queue.filter((e) => e.status !== 'texted');
  const cleared = queue.length - kept.length;
  save(kept);
  return cleared;
}

/** { total, pending, texted, elsewhere }: `pending` is what a --queue run will work; `texted` counts the `elsewhere` entries too (another mode texted them), so pending + texted is always total. */
function summary({ rows = null } = {}) {
  const q = load(), { live, elsewhere } = split(q, rows);
  return { total: q.length, pending: live.length, texted: q.filter((e) => e.status === 'texted').length + elsewhere.length, elsewhere: elsewhere.length };
}

module.exports = { load, save, addLeads, pendingLeads, textedElsewhere, markTexted, clearTexted, summary, QUEUE_FILE };
