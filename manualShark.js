'use strict';

/**
 * manualShark — a lead worked BY HAND, #tagged with its kind, and tracked for stage 2.
 *
 * Luke works some leads himself: stage 1 (the email, the text and the phone call) is his, and he only wants the system to take over at stage 2 (the follow-up: the
 * "Follow-Up 1" text and the next email touch, 3+ days after the last touch). He #tags the lead with the kind of lead it is: #shark (the Shark list: the bot's follow-up text),
 * #lds (the LDS list: the follow-up text and the email cadence) or a tag of his own such as #referral (a label to filter by; no bot acts on it).
 * `node textLog.js --add-lead <Salesforce account link or id> --tag shark` records that stage 1 (the dashboard's Tools > Follow-up board builds the command):
 *
 *   manual-shark.jsonl  { type:'add', id, at, on, accountId, accountName, accountUrl, did:['email','text','call'], note, tags:['shark'] }   (a call is only noted here: the log has no call channel)
 *                       { type:'tags', id, at, tags } changes the tags of an add (--tag-lead), { type:'remove', id, at } takes it back out
 *   texted-log.jsonl    one REAL row per text / email done: mode 'manual', step 1 for the email, `manualId` = the add's id. The rows carry NO list: the tags decide the lists
 *                       (textLog.aggregate() turns #shark / #lds into the account's Shark / LDS source), so changing a tag never has to touch the log.
 *
 * Real rows, not a side table, so everything that reads the log respects the touch with no change of its own, even in a bot that is already running: the once-a-day text / email
 * guards, the "already texted" check that keeps a lead out of the text queue, "days since touch", the `--followup` due list (3+ days later, #shark) and the email cadence
 * (touch 1 sent by hand, so the next one is touch 2; #lds leads are emailed by `--email --core --from-dashboard`).
 * `--remove-lead` voids the rows again (textLog.readAll skips a voided row, so a NEW process forgets the touch; the log itself is never rewritten and a bot that was already
 * running keeps treating the lead as touched, which is the safe side).
 *
 *   node textLog.js --add-lead <link|id> [<link|id> …] --tag shark,lds,referral [--did email,text,call] [--on today|yesterday|2026-10-27|"10/27 9:30"] [--name "Business"] [--note "…"] [--dry-run] [--again]
 *   node textLog.js --tag-lead <link|id> --tag lds                 replace the tags of a lead added by hand
 *   node textLog.js --remove-lead <link|id>
 *   node textLog.js --manual-leads                                 who was added by hand, with what tags, and when their stage 2 is due
 *   (--add-shark / --remove-shark / --manual-shark are the first names of the same commands: --add-shark means --tag shark)
 *   email --email --core --from-hand [--tag referral] [--step N] [--dry-run]    the EMAIL cadence for every lead added by hand (any tag): each gets its next touch; emailLeads() below is its lead list
 *   node Assistant.js --cadence --from-hand [--tag referral]                              no browser: where each of them stands in the cadence
 *
 * Nothing in here opens a browser or sends anything.
 */

const fs = require('fs');
const textLog = require('./textLog');
const sfId = require('./sfId');
const textQueue = require('./textQueue');

const SF_ORIGIN = 'https://housecallpro.lightning.force.com';
const DIDS = ['email', 'text', 'call'];
const STAGE2_DAYS = 3;                       // the follow-up bot's own rule (textLog.followupDue minDays): 3+ whole calendar days since our last touch
const TAG_KINDS = textLog.MANUAL_TAG_KINDS;  // #shark and #lds are real lists; every other tag is a label
const MAX_TAGS = 6;
const NO_TAG = 'tag the lead with its kind: --tag shark (the Shark list), --tag lds (the LDS list) or a tag of your own such as --tag referral (several: --tag shark,referral)';
const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayName = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayNum = (day) => { const [y, m, d] = String(day).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const readJsonl = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const hashTags = (tags) => tags.map((t) => `#${t}`).join(' ');

/** The account id in whatever was pasted: a Salesforce link, an 18- or a 15-character id. → { id: 18 characters, case repaired, note? } | { error } */
function parseAccountRef(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { error: 'no Salesforce account link or id given' };
  const m = s.match(/(?:^|[^A-Za-z0-9])(001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)(?![A-Za-z0-9])/);
  if (!m) {
    const other = s.match(/\/lightning\/r\/(?:([A-Za-z_]+)\/)?[A-Za-z0-9]{15,18}/);
    if (other && other[1] && other[1] !== 'Account') return { error: `that link is for a ${other[1]} record, not an Account: open the account's own page in Salesforce and copy that link` };
    return { error: `"${s.slice(0, 60)}" has no Salesforce account id in it (an account id starts with 001 and is 15 or 18 characters)` };
  }
  let id = m[1], note = null;
  if (id.length === 15) id += sfId.suffixFor(id); else id = sfId.fix(id);
  if (!sfId.isValid18(id)) note = 'the letter case of that id does not match its checksum (Salesforce ids are case-sensitive): check that the link opens the right account';
  return { id, note };
}

/**
 * The tags he typed: "shark,lds,referral", "#Shark #referral", or an array. Lowercase, no '#', letters / digits / - / _ (up to 24 characters), no repeats, at most 6.
 * → { tags: [...] } | { error }   (an empty input is { tags: [] }: the caller decides whether that is allowed)
 */
function parseTags(input) {
  const raw = Array.isArray(input) ? input.flatMap((x) => String(x).split(/[\s,;]+/)) : String(input == null ? '' : input).split(/[\s,;]+/);
  const tags = [];
  for (const x of raw) {
    const t = String(x).trim().replace(/^#+/, '').toLowerCase();
    if (!t) continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(t)) return { error: `"${x}" cannot be a tag: use letters, numbers, - and _ (up to 24 characters), e.g. shark, lds, referral, trade-show` };
    if (!tags.includes(t)) tags.push(t);
  }
  if (tags.length > MAX_TAGS) return { error: `at most ${MAX_TAGS} tags per lead (you gave ${tags.length})` };
  return { tags };
}

/** A day / moment the way he types it. → { at: Date } | { error }. Date only = noon that day (a date-only TODAY is simply now); nothing, "now" or "today" = now. */
function parseWhen(text, now = new Date()) {
  const t = String(text == null ? '' : text).trim().toLowerCase();
  if (!t || t === 'now' || t === 'today') return { at: now };
  let y, mo, d, H = null, M = 0, m;
  if (t === 'yesterday') { const x = new Date(now); x.setDate(x.getDate() - 1); y = x.getFullYear(); mo = x.getMonth() + 1; d = x.getDate(); }
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]+(\d{1,2}):(\d{2})\s*([ap]m)?)?$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4] != null) { H = +m[4]; M = +m[5]; if (m[6]) H = (H % 12) + (m[6] === 'pm' ? 12 : 0); } }
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?:\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?$/))) {
    mo = +m[1]; d = +m[2]; y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    if (m[4] != null) { H = +m[4]; M = +m[5]; if (m[6]) H = (H % 12) + (m[6] === 'pm' ? 12 : 0); }
    if (!m[3] && new Date(y, mo - 1, d, 12).getTime() > now.getTime() + 864e5) y -= 1;          // "12/30" typed in January means last December
  }
  const bad = `cannot read "${text}" as a day: use today, yesterday, 2026-10-27 or 10/27, with an optional time such as "10/27 9:30"`;
  if (y == null || mo < 1 || mo > 12 || d < 1 || d > 31 || (H != null && (H > 23 || M > 59))) return { error: bad };
  const at = H == null ? new Date(y, mo - 1, d, 12, 0, 0) : new Date(y, mo - 1, d, H, M, 0);
  if (isNaN(at) || at.getMonth() !== mo - 1 || at.getDate() !== d) return { error: bad };
  if (H == null && dayOf(at) === dayOf(now)) return { at: now };
  if (at.getTime() > now.getTime() + 5 * 60000) return { error: `${dayName(at)} ${H == null ? '' : clock(at) + ' '}is in the future: this records what you already did` };
  return { at };
}

/** What the log, the saved reports and the saved zones already know about this account: { spelling, name, texts, emails, lastAt } */
function lookup(id, rows) {
  const k = k15(id);
  let spelling = null, name = null, texts = 0, emails = 0, lastAt = null;
  for (const r of rows) {
    if (k15(r.accountId) !== k) continue;
    if (!spelling || String(r.at) >= String(spelling.at)) spelling = { id: r.accountId, at: r.at };
    if (r.accountName && (!name || String(r.at) >= String(name.at))) name = { v: r.accountName, at: r.at };
    if (r.mode === textLog.MANUAL_MODE) continue;
    if (r.channel === 'email') emails++; else texts++;
    if (!lastAt || String(r.at) > String(lastAt)) lastAt = r.at;
  }
  let nm = name ? name.v : null;
  if (!nm) { const sn = textLog.snapshotMap().get(k); if (sn && sn.name) nm = sn.name; }
  if (!nm) {
    const scans = readJsonl(textLog.LIST_FILE);
    for (let i = scans.length - 1; i >= 0 && !nm; i--) for (const a of scans[i].accounts || []) if (a && k15(a.id) === k && a.name) { nm = a.name; break; }
  }
  if (!nm) { const z = textLog.readZones(); const zr = z.get(String(id).toLowerCase()) || z.get(k); if (zr && zr.accountName) nm = zr.accountName; }
  // the spelling the log already uses (so the new rows land on the same dashboard row), when it is a proper 18-character id
  return { spelling: spelling && spelling.id && spelling.id.length === 18 ? spelling.id : null, name: nm, texts, emails, lastAt };
}

/** The date stage 2 starts: the Nth calendar day after the day of the touch. */
function stage2Day(on) { const d = new Date(on); d.setDate(d.getDate() + STAGE2_DAYS); return d; }

/** What stage 2 means for these tags, one line each: the bot that takes a #shark lead, the one that takes a #lds lead, and that a tag of his own is only a label. */
function stage2Lines(tags, emailed) {
  const L = [];
  if (tags.includes('shark')) L.push('#shark: the follow-up board texts it (email --board --inspect lists who is due)');
  if (tags.includes('lds')) L.push('#lds: the follow-up board texts it too (email --board takes LDS leads)');
  const own = tags.filter((t) => !TAG_KINDS[t]);
  if (own.length) L.push(`${hashTags(own)}: ${own.length === 1 ? 'a label' : 'labels'} for the Follow-up board and the filters; no text goes out for ${own.length === 1 ? 'it' : 'them'}`);
  L.push(`email, whatever the tags: ${emailed ? 'touch 2' : 'touch 1 (you did not email it)'} of the cadence goes out with email --email --core --from-hand --step ${emailed ? 2 : 1}`);
  return L;
}

/**
 * The text queue (`--shark` / `--shark13` put every report row there as 'pending' and `--queue` texts them later, hours or days on). A lead you texted yourself must not be texted
 * AGAIN by it: the once-a-day guard only looks back 24 hours, so the queue entry is marked texted (by hand). --remove-lead puts it back.
 */
const pendingInQueue = (id) => textQueue.load().filter((e) => e.status === 'pending' && k15(e.accountId) === k15(id)).length;
function takeOffQueue(id, addId, atIso) {
  const q = textQueue.load(); let n = 0;
  for (const e of q) if (e.status === 'pending' && k15(e.accountId) === k15(id)) { e.status = 'texted'; e.textedAt = atIso; e.by = 'hand'; e.manualId = addId; n++; }
  if (n) textQueue.save(q);
  return n;
}
function putBackOnQueue(addIds) {
  const q = textQueue.load(); let n = 0;
  for (const e of q) if (e.by === 'hand' && e.manualId && addIds.has(e.manualId) && e.status === 'texted') { e.status = 'pending'; e.textedAt = null; delete e.by; delete e.manualId; n++; }
  if (n) textQueue.save(q);
  return n;
}

/**
 * Record one lead. → { ok:false, reason } | { ok:true, dryRun, id, account:{id,name,url}, at: Date, did, tags, rows, warnings:[…], stage2: Date, known:{…} }
 * Refuses: no tag, a banned account, a text/email-less add (a call alone has no row for the follow-up to count from), a moment in the future, a second add of the same day.
 */
function addLead({ ref, name = null, did = null, on = null, note = null, tags = null, again = false, dryRun = false, now = new Date() } = {}) {
  const p = parseAccountRef(ref); if (p.error) return { ok: false, reason: p.error };
  const pt = parseTags(tags); if (pt.error) return { ok: false, reason: pt.error };
  if (!pt.tags.length) return { ok: false, reason: NO_TAG };
  const list = (did == null ? DIDS : (Array.isArray(did) ? did : String(did).split(/[\s,+]+/))).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const badDid = list.filter((x) => !DIDS.includes(x));
  if (badDid.length) return { ok: false, reason: `--did takes email, text and call (not "${badDid.join('", "')}")` };
  const didSet = DIDS.filter((x) => list.includes(x));
  if (!didSet.includes('email') && !didSet.includes('text')) return { ok: false, reason: 'stage 1 has to include the email or the text: a call alone leaves no touch for the follow-up to count from (add --did text,call or --did email,call)' };
  const w = parseWhen(on, now); if (w.error) return { ok: false, reason: w.error };

  const rows = textLog.readAll();
  const known = lookup(p.id, rows);
  const id = known.spelling || p.id;
  const acctName = (name && String(name).trim()) || known.name || null;
  const url = `${SF_ORIGIN}/lightning/r/Account/${p.id}/view`;
  const warnings = [];
  if (p.note) warnings.push(p.note);

  if ([id, p.id, k15(id)].some((x) => textLog.isBanned(x))) return { ok: false, reason: `${acctName || id} is on the do-not-contact list: it is not added (node textLog.js --banlist)` };
  const dup = textLog.readManualRecords().adds.find((a) => k15(a.accountId) === k15(id) && dayOf(new Date(a.on)) === dayOf(w.at));
  if (dup && !again) return { ok: false, reason: `${acctName || id} was already added for ${dayName(w.at)} (${(dup.did || []).join(' + ')}, ${hashTags(dup.tags)}). Pass --again to add it a second time, or --tag-lead to change its tags`, duplicate: true };

  const cw = textLog.readClosedWon(); const won = cw.get(String(id).toLowerCase()) || cw.get(k15(id));
  if (won) warnings.push(`on the closed-won list ("${won.opp || ''}", closed ${won.closeDate || '?'}): the bot will leave it alone and it stays off the Follow-up board`);
  const cust = textLog.readCurrentCustomers(); const cu = cust.get(String(id).toLowerCase()) || cust.get(k15(id));
  if (cu) warnings.push(`held as a current customer (${cu.status || 'Enrolled'}${cu.unverified ? ', not re-checked yet' : ''}): the bot leaves it alone and it stays off the Follow-up board`);
  const rv = textLog.readReviews().get(id); if (rv && rv.verdict === 'skip' && !rv.moot && now.getTime() - Date.parse(rv.at) < 14 * 864e5) warnings.push('a Salesforce review said skip in the last 14 days: the follow-up will not text it');
  if (known.texts || known.emails) warnings.push(`the bot already contacted it: ${known.texts} text${known.texts === 1 ? '' : 's'}, ${known.emails} email${known.emails === 1 ? '' : 's'}, last ${String(known.lastAt).slice(0, 10)}`);
  if (!acctName) warnings.push('no business name known for this account (not in any saved report): add --name "Business name" so it shows up with a name');

  const addId = `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const at = w.at.toISOString();
  const label = dayName(w.at);
  const base = { at, accountId: id, accountName: acctName, accountUrl: url, email: null, templateName: 'Stage 1 by hand', mode: textLog.MANUAL_MODE, source: null, manualId: addId };
  const logRows = [];
  if (didSet.includes('text')) logRows.push({ ...base, channel: 'text', message: `Texted by hand: stage 1, ${label} (not sent by Pipeline Assistant)`, subject: null, body: null, step: null });
  if (didSet.includes('email')) logRows.push({ ...base, channel: 'email', message: null, subject: 'Emailed by hand (stage 1)', body: `Emailed by hand: stage 1, ${label} (not sent by Pipeline Assistant)`, step: 1 });
  const rec = { type: 'add', id: addId, at: now.toISOString(), on: at, accountId: id, accountName: acctName, accountUrl: url, did: didSet, note: note ? String(note).trim() : null, tags: pt.tags };
  const queued = didSet.includes('text') ? pendingInQueue(id) : 0;
  const lastTouch = known.lastAt && new Date(known.lastAt) > w.at ? new Date(known.lastAt) : w.at;      // the bot may have touched it since: stage 2 counts from the LAST touch
  const out = { ok: true, dryRun: !!dryRun, id: addId, account: { id, name: acctName, url }, at: w.at, did: didSet, tags: pt.tags, rows: logRows, warnings, stage2: stage2Day(lastTouch), lastTouch, known, rec, queued };
  if (dryRun) return out;
  // the add first, then both rows in ONE append (one write call, so a bot appending at the same moment cannot split them)
  fs.appendFileSync(textLog.MANUAL_FILE, JSON.stringify(rec) + '\n', 'utf8');
  fs.appendFileSync(textLog.LOG_FILE, logRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (queued) takeOffQueue(id, addId, at);
  return out;
}

/** Replace the tags of a lead added by hand (every add of that account). Nothing else about it changes. → { ok, adds, before, after } */
function tagLead({ ref, tags = null, dryRun = false } = {}) {
  const p = parseAccountRef(ref); if (p.error) return { ok: false, reason: p.error };
  const pt = parseTags(tags); if (pt.error) return { ok: false, reason: pt.error };
  if (!pt.tags.length) return { ok: false, reason: NO_TAG };
  const adds = textLog.readManualRecords().adds.filter((a) => k15(a.accountId) === k15(p.id));
  if (!adds.length) return { ok: false, reason: 'no lead added by hand matches that account (node textLog.js --manual-leads lists them)' };
  const before = [...new Set(adds.flatMap((a) => textLog.manualTags(a)))];
  if (!dryRun) fs.appendFileSync(textLog.MANUAL_FILE, adds.map((a) => JSON.stringify({ type: 'tags', id: a.id, at: new Date().toISOString(), accountId: a.accountId, accountName: a.accountName, tags: pt.tags })).join('\n') + '\n', 'utf8');
  return { ok: true, dryRun: !!dryRun, adds, before, after: pt.tags };
}

function addDaysIso(isoOrDate, days) {
  const d = new Date(isoOrDate);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString();
}

function parseExpiresInput(expiresAt, expiresDays, boardAt, pack) {
  if (expiresAt) {
    const t = Date.parse(expiresAt);
    if (!Number.isFinite(t)) return { error: `cannot read expiresAt "${expiresAt}"` };
    return { expiresAt: new Date(t).toISOString() };
  }
  const days = expiresDays != null && expiresDays !== ''
    ? Number(expiresDays)
    : (pack && pack.expiresDays != null ? Number(pack.expiresDays) : null);
  if (days == null || !Number.isFinite(days)) return { expiresAt: null };
  if (days < 1 || days > 730) return { error: 'expiresDays must be between 1 and 730' };
  return { expiresAt: addDaysIso(boardAt, days), expiresDays: days };
}

/**
 * Put a hand-added lead on a cadence board (e.g. nurture slow drip), or clear it.
 * Nurture sets an expiration date (pack expiresDays, default 90); when it hits, graduateExpiredNurture
 * moves them onto the Re-engage list (#reengage).
 * → { ok, board, boardAt, boardExpiresAt, adds, tags }
 */
function setLeadBoard({ ref, board = null, dryRun = false, now = new Date(), expiresAt = null, expiresDays = null, graduateTo = null } = {}) {
  const p = parseAccountRef(ref); if (p.error) return { ok: false, reason: p.error };
  let boardId = board == null || board === '' || board === false ? null : String(board).trim().toLowerCase();
  if (boardId === 'none' || boardId === 'clear' || boardId === 'off') boardId = null;
  let pack = null;
  if (boardId) {
    pack = require('./boards').loadPackFile(boardId);
    if (!pack) return { ok: false, reason: `unknown board "${boardId}" (try nurture, post-demo, drip-hvac, …)` };
  }
  const adds = textLog.readManualRecords().adds.filter((a) => k15(a.accountId) === k15(p.id));
  if (!adds.length) return { ok: false, reason: 'no lead added by hand matches that account — add them first (My leads / --add-lead), then mark Nurture' };
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const exp = boardId ? parseExpiresInput(expiresAt, expiresDays, at, pack) : { expiresAt: null };
  if (exp.error) return { ok: false, reason: exp.error };
  // Keep existing tags, ensure board tag is present when assigning; drop nurture tag when clearing nurture.
  const beforeTags = [...new Set(adds.flatMap((a) => textLog.manualTags(a)))];
  let afterTags = beforeTags.slice();
  if (boardId) {
    if (!afterTags.includes(boardId)) afterTags.push(boardId);
    // Leaving re-engage when going back into an active / nurture board
    afterTags = afterTags.filter((t) => t !== 'reengage');
  } else {
    // Clearing board: expire→reengage keeps a destination tag; manual leave / Back to active drops both.
    afterTags = afterTags.filter((t) => t !== 'nurture');
    if (graduateTo) {
      if (!afterTags.includes(graduateTo)) afterTags.push(graduateTo);
    } else {
      afterTags = afterTags.filter((t) => t !== 'reengage');
    }
    if (!afterTags.length) afterTags = ['referral'];
  }
  const out = {
    ok: true,
    dryRun: !!dryRun,
    board: boardId,
    boardAt: boardId ? at : null,
    boardExpiresAt: boardId ? exp.expiresAt : null,
    adds,
    tags: afterTags,
    beforeTags,
  };
  if (dryRun) return out;
  const lines = [];
  for (const a of adds) {
    const row = { type: 'board', id: a.id, at, accountId: a.accountId, accountName: a.accountName, board: boardId };
    if (exp.expiresAt) row.expiresAt = exp.expiresAt;
    if (graduateTo) row.graduatedFrom = 'nurture';
    lines.push(JSON.stringify(row));
    if (afterTags.join(',') !== textLog.manualTags(a).join(',')) {
      lines.push(JSON.stringify({ type: 'tags', id: a.id, at, accountId: a.accountId, accountName: a.accountName, tags: afterTags }));
    }
  }
  fs.appendFileSync(textLog.MANUAL_FILE, lines.join('\n') + '\n', 'utf8');
  return out;
}

/** Shortcut: move a hand lead onto the slow nurture board (expires in pack.expiresDays, default 90). */
function nurtureLead({ ref, dryRun = false, now = new Date(), expiresAt = null, expiresDays = null } = {}) {
  return setLeadBoard({ ref, board: 'nurture', dryRun, now, expiresAt, expiresDays });
}

/**
 * Nurture leads whose expiration date has passed → off nurture, onto #reengage list.
 * Safe to call often (dayDesk / members); only writes when someone actually expires.
 * → { graduated: [{ accountId, name, expiresAt, tags }], skipped }
 */
function graduateExpiredNurture({ now = new Date(), dryRun = false } = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const pack = require('./boards').loadPackFile('nurture') || {};
  const defaultDays = Number.isFinite(Number(pack.expiresDays)) ? Number(pack.expiresDays) : 90;
  const dest = pack.graduateTo || 'reengage';
  const byAcct = new Map();
  for (const a of textLog.readManualRecords().adds) {
    const k = k15(a.accountId);
    if (!k) continue;
    const onNur = a.board === 'nurture' || textLog.manualTags(a).includes('nurture');
    if (!onNur) continue;
    const cur = byAcct.get(k);
    if (!cur || String(a.boardAt || a.on || '') >= String(cur.boardAt || '')) {
      byAcct.set(k, a);
    }
  }
  const graduated = [];
  for (const a of byAcct.values()) {
    const start = a.boardAt || a.on;
    let expMs = a.boardExpiresAt ? Date.parse(a.boardExpiresAt) : NaN;
    if (!Number.isFinite(expMs) && start) expMs = Date.parse(addDaysIso(start, defaultDays));
    if (!Number.isFinite(expMs) || expMs > t.getTime()) continue;
    const r = setLeadBoard({
      ref: a.accountId,
      board: null,
      dryRun,
      now: t,
      graduateTo: dest,
    });
    if (!r.ok) continue;
    graduated.push({
      accountId: a.accountId,
      name: a.accountName || a.accountId,
      expiresAt: a.boardExpiresAt || (Number.isFinite(expMs) ? new Date(expMs).toISOString() : null),
      tags: r.tags,
    });
  }
  return { graduated, dest, dryRun: !!dryRun };
}

/** Take a lead added by hand back out: its touches are voided (readAll skips them) and it leaves the lists it was tagged into unless a real report has it too. → { ok, removed:[adds] } */
function removeLead({ ref, dryRun = false } = {}) {
  const p = parseAccountRef(ref); if (p.error) return { ok: false, reason: p.error };
  const adds = textLog.readManualRecords().adds.filter((a) => k15(a.accountId) === k15(p.id));
  if (!adds.length) return { ok: false, reason: 'no lead added by hand matches that account (node textLog.js --manual-leads lists them)' };
  let requeued = 0;
  if (!dryRun) {
    fs.appendFileSync(textLog.MANUAL_FILE, adds.map((a) => JSON.stringify({ type: 'remove', id: a.id, at: new Date().toISOString(), accountId: a.accountId, accountName: a.accountName })).join('\n') + '\n', 'utf8');
    requeued = putBackOnQueue(new Set(adds.map((a) => a.id)));
  }
  return { ok: true, removed: adds, dryRun: !!dryRun, requeued };
}

/** The leads added by hand, newest first, each with its tags and when its stage 2 starts (3 days after the LAST touch of any kind: yours or the bot's). */
function listLeads(now = new Date()) {
  const last = new Map();
  for (const r of textLog.readAll()) { const k = k15(r.accountId); if (k && (!last.get(k) || String(r.at) > last.get(k))) last.set(k, r.at); }
  const today = dayNum(dayOf(now));
  return textLog.readManualRecords().adds.slice().sort((a, b) => (a.on < b.on ? 1 : -1)).map((a) => {
    const lt = last.get(k15(a.accountId)) || a.on, n = today - dayNum(dayOf(new Date(lt)));
    return { ...a, lastTouch: lt, sinceDays: n, stage2: stage2Day(lt), due: n >= STAGE2_DAYS };
  });
}

/**
 * The email run's lead list: every lead added by hand (one per account, the newest add's name and link), or only those carrying ONE tag.
 * `email --email --core --from-hand [--tag referral]` takes these through the usual cadence intake (banned, closed-won and customers dropped, only accounts DUE a touch kept).
 * A lead with no business name on file is left out (`noName`): the greeting would read the account id.
 * → { ok, leads:[{ accountId, name, url, tags }], total, byTag:{ tag: n }, noName:[accountId] } | { ok:false, reason }
 */
function emailLeads({ tag = null } = {}) {
  const pt = parseTags(tag); if (pt.error) return { ok: false, reason: pt.error };
  if (pt.tags.length > 1) return { ok: false, reason: '--tag takes ONE tag here, for example --tag referral' };
  const byAcct = new Map();
  for (const a of textLog.readManualRecords().adds.slice().sort((x, y) => (x.on < y.on ? 1 : -1))) {      // newest add first: its name and link win
    const k = k15(a.accountId); if (!k) continue;
    let l = byAcct.get(k);
    if (!l) { l = { accountId: a.accountId, name: a.accountName || null, url: a.accountUrl || `${SF_ORIGIN}/lightning/r/Account/${a.accountId}/view`, tags: [] }; byAcct.set(k, l); }
    else if (!l.name && a.accountName) l.name = a.accountName;
    for (const t of textLog.manualTags(a)) if (!l.tags.includes(t)) l.tags.push(t);
  }
  const all = [...byAcct.values()], byTag = {};
  for (const l of all) for (const t of l.tags) byTag[t] = (byTag[t] || 0) + 1;
  const tagged = pt.tags.length ? all.filter((l) => l.tags.includes(pt.tags[0])) : all;
  if (pt.tags.length && !tagged.length) return { ok: false, reason: all.length ? `no lead added by hand is tagged #${pt.tags[0]} (tags in use: ${Object.entries(byTag).map(([t, n]) => `#${t} ${n}`).join(' · ')})` : 'no lead has been added by hand yet' };
  return { ok: true, leads: tagged.filter((l) => l.name), total: all.length, byTag, noName: tagged.filter((l) => !l.name).map((l) => l.accountId) };
}

/** Where each of these leads stands in the 6-touch email cadence. → [{ lead, step: the highest touch emailed (0 = none), lastAt, next: the touch due, hold: why not (or null), dropped: why the email run's intake leaves it out (or null) }] */
function emailStanding(leads, { minDays = 3 } = {}) {
  const es = require('./emailSequence');
  const rows = textLog.readAll(), replies = textLog.readReplyRows(), bans = textLog.readBans(), green = textLog.readGreen(), won = textLog.readClosedWon(), cust = textLog.readCurrentCustomers();
  return leads.map((l) => {
    const lower = String(l.accountId).toLowerCase(), c = cust.get(k15(l.accountId)) || cust.get(lower);
    const s = es.standing(l.accountId, { rows, replies }), t = es.nextTouch(l.accountId, { minDays, rows, replies });
    const dropped = textLog.isBanned(l.accountId, bans, green) ? 'on the do-not-contact list' : (won.has(k15(l.accountId)) || won.has(lower)) ? 'closed-won' : (c && !c.unverified) ? 'a current customer' : null;
    return { lead: l, step: s.lastStep, lastAt: s.lastAt, next: t.step || null, hold: t.hold || null, dropped };
  });
}

// ---- command line ------------------------------------------------------------------------------------------------------------------------------------------------
const VALUE_FLAGS = new Set(['--did', '--on', '--name', '--note', '--tag', '--board', '--expires', '--expires-days']);
const BOOL_FLAGS = new Set(['--dry-run', '--again']);
function parseArgs(tokens) {
  const o = { refs: [], flags: {} };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (VALUE_FLAGS.has(t)) { if (i + 1 >= tokens.length) return { error: `${t} needs a value` }; o.flags[t] = t === '--tag' && o.flags[t] ? `${o.flags[t]},${tokens[++i]}` : tokens[++i]; }      // (--tag shark --tag lds = --tag shark,lds)
    else if (BOOL_FLAGS.has(t)) o.flags[t] = true;
    else if (t.startsWith('--')) return { error: `unknown option ${t}` };
    else o.refs.push(t);
  }
  return o;
}
const didText = (did) => did.map((x) => ({ email: '✉️  email', text: '📱 text', call: '📞 call' }[x])).join(' · ');
const USAGE_ADD = 'node textLog.js --add-lead <Salesforce account link or id> [more links…] --tag shark|lds|<your own tag>[,…] [--did email,text,call] [--on yesterday|2026-10-27|"10/27 9:30"] [--name "Business name"] [--note "…"] [--dry-run]';

/** The `node textLog.js --add-lead | --tag-lead | --remove-lead | --manual-leads` entry (and the older --add-shark / --remove-shark / --manual-shark). → { code, changed } (changed = the dashboard needs regenerating) */
function cli(argv, out = console.log) {
  const cmd = { '--add-shark': '--add-lead', '--remove-shark': '--remove-lead', '--manual-shark': '--manual-leads' }[argv[0]] || argv[0];
  const a = parseArgs(argv.slice(1));
  if (a.error) { out(`\n❌ ${a.error}\n`); return { code: 1, changed: false }; }
  if (cmd === '--manual-leads') {
    const leads = listLeads();
    const stand = new Map(emailStanding(emailLeads().leads).map((x) => [k15(x.lead.accountId), x]));
    out(`\n✋ Leads added by hand — ${leads.length}\n`);
    for (const l of leads) {
      const when = new Date(l.on), x = stand.get(k15(l.accountId));
      out(`  ${dayName(when).padEnd(12)} ${(l.accountName || '(no name)').padEnd(34).slice(0, 34)} ${l.accountId}  ${l.did.join('+').padEnd(15)} ${hashTags(l.tags).padEnd(22)} ${l.due ? '⏳ stage 2 due now' : `stage 2 from ${dayName(l.stage2)}`}${l.note ? `  — ${l.note}` : ''}`);
      if (x) out(`               ✉️  email cadence: ${x.dropped ? `left out (${x.dropped})` : x.hold ? `held, ${x.hold}` : `touch ${x.next} is due now`}${x.step ? ` · touch ${x.step} sent ${String(x.lastAt).slice(0, 10)}` : ' · never emailed'}`);
    }
    if (leads.length) out('\n  Email them (their next touch each):  email --email --core --from-hand --dry-run      ·      no browser, who would get what:  node Assistant.js --cadence --from-hand');
    out('');
    return { code: 0, changed: false };
  }
  const dry = !!a.flags['--dry-run'];
  if (cmd === '--remove-lead') {
    if (a.refs.length !== 1) { out('\nUsage:  node textLog.js --remove-lead <Salesforce account link or id>\n'); return { code: 1, changed: false }; }
    const r = removeLead({ ref: a.refs[0], dryRun: dry });
    if (!r.ok) { out(`\n❌ ${r.reason}\n`); return { code: 1, changed: false }; }
    for (const x of r.removed) out(`\n${dry ? '(dry run) would take' : '✋ Took'} ${x.accountName || x.accountId} back out: its by-hand touches (${x.did.join(' + ')}, ${dayName(new Date(x.on))}) no longer count${dry ? '' : '. A bot that was already running keeps treating it as touched until it is restarted.'}`);
    if (r.requeued) out(`   Put it back on the text queue (${r.requeued}).`);
    out('');
    return { code: 0, changed: !dry };
  }
  if (cmd === '--graduate-nurture') {
    const r = graduateExpiredNurture({ dryRun: dry });
    out(`\n🌱→📣 Nurture → Re-engage — ${r.graduated.length} expired\n`);
    for (const g of r.graduated) {
      out(`  ${g.name}  ${g.accountId}  expired ${String(g.expiresAt || '').slice(0, 10)}  → ${hashTags(g.tags || [r.dest])}`);
    }
    if (!r.graduated.length) out('  (nobody past their nurture expiration date)');
    out('');
    return { code: 0, changed: !dry && r.graduated.length > 0 };
  }
  if (cmd === '--nurture-lead' || cmd === '--set-board') {
    if (a.refs.length !== 1) {
      out(cmd === '--nurture-lead'
        ? '\nUsage:  node textLog.js --nurture-lead <Salesforce account link or id> [--expires-days 90 | --expires 2026-06-01] [--dry-run]\n        Puts a hand-added lead on the slow Nurture drip. When the expiration hits, they move to #reengage.\n'
        : '\nUsage:  node textLog.js --set-board <Salesforce account link or id> --board nurture|none [--expires-days N] [--dry-run]\n');
      return { code: 1, changed: false };
    }
    const board = cmd === '--nurture-lead' ? 'nurture' : (a.flags['--board'] || null);
    if (cmd === '--set-board' && board == null) { out('\n❌ --set-board needs --board nurture (or --board none to clear)\n'); return { code: 1, changed: false }; }
    const r = setLeadBoard({
      ref: a.refs[0],
      board,
      dryRun: dry,
      expiresAt: a.flags['--expires'] || null,
      expiresDays: a.flags['--expires-days'] || null,
    });
    if (!r.ok) { out(`\n❌ ${r.reason}\n`); return { code: 1, changed: false }; }
    const name = (r.adds[0] && (r.adds[0].accountName || r.adds[0].accountId)) || a.refs[0];
    if (r.board) {
      const exp = r.boardExpiresAt ? ` · expires ${dayName(new Date(r.boardExpiresAt))} → #reengage` : '';
      out(`\n${dry ? '(dry run) would move' : '🌱 Moved'} ${name} onto the ${r.board} board (${hashTags(r.tags)})${exp}. Slow drip starts from this moment.\n`);
    } else out(`\n${dry ? '(dry run) would clear' : 'Cleared'} the board assignment for ${name} (${hashTags(r.tags)}).\n`);
    return { code: 0, changed: !dry };
  }
  if (cmd === '--tag-lead') {
    if (a.refs.length !== 1 || !a.flags['--tag']) { out('\nUsage:  node textLog.js --tag-lead <Salesforce account link or id> --tag shark|lds|<your own tag>[,…]     (replaces the lead\'s tags)\n'); return { code: 1, changed: false }; }
    const r = tagLead({ ref: a.refs[0], tags: a.flags['--tag'], dryRun: dry });
    if (!r.ok) { out(`\n❌ ${r.reason}\n`); return { code: 1, changed: false }; }
    const nm = r.adds[0].accountName || r.adds[0].accountId;
    out(`\n${dry ? '(dry run, nothing written) Would tag' : '✋ Tagged'} ${nm}: ${hashTags(r.before)}  →  ${hashTags(r.after)}`);
    for (const l of stage2Lines(r.after, r.adds.some((x) => (x.did || []).includes('email')))) out(`   ${l}`);
    const gone = r.before.filter((t) => !r.after.includes(t) && TAG_KINDS[t]);
    if (gone.length && !dry) out(`   ${hashTags(gone)} no longer applies: a bot that was already running keeps its own list until it is restarted.`);
    out('');
    return { code: 0, changed: !dry };
  }
  // --add-lead (and --add-shark: the same, with #shark added to whatever --tag says)
  if (!a.refs.length) { out(`\nUsage:  ${USAGE_ADD}\n`); return { code: 1, changed: false }; }
  if (a.refs.length > 1 && a.flags['--name']) { out('\n❌ --name is for one account at a time\n'); return { code: 1, changed: false }; }
  const tagInput = argv[0] === '--add-shark' ? `shark,${a.flags['--tag'] || ''}` : (a.flags['--tag'] || '');
  const tp = parseTags(tagInput);
  if (tp.error) { out(`\n❌ ${tp.error}\n`); return { code: 1, changed: false }; }
  if (!tp.tags.length) { out(`\n❌ ${NO_TAG}\n\nUsage:  ${USAGE_ADD}\n`); return { code: 1, changed: false }; }
  let added = 0, failed = 0;
  for (const ref of a.refs) {
    const r = addLead({ ref, name: a.flags['--name'], did: a.flags['--did'] || null, on: a.flags['--on'] || null, note: a.flags['--note'] || null, tags: tp.tags, again: !!a.flags['--again'], dryRun: dry });
    if (!r.ok) { failed++; out(`\n❌ ${r.duplicate ? '↩️  ' : ''}${r.reason}`); continue; }
    added++;
    const s2 = r.stage2, n = dayNum(dayOf(new Date())) - dayNum(dayOf(r.lastTouch));
    out(`\n${dry ? '(dry run, nothing written) ' : ''}✋ ${dry ? 'Would add' : 'Added'} to the Follow-up board: ${r.account.name || '(no name known)'}  (${r.account.id})`);
    out(`   Tags: ${hashTags(r.tags)}`);
    out(`   Stage 1, by you: ${didText(r.did)} — ${dayName(r.at)}, ${clock(r.at)}`);
    out(`   Stage 2 ${n >= STAGE2_DAYS ? 'is due now' : `starts ${dayName(s2)}, ${STAGE2_DAYS} days after the last touch`}:`);
    for (const l of stage2Lines(r.tags, r.did.includes('email'))) out(`     ${l}`);
    out(`   Your touch counts as its first one: the once-a-day guards and the text queue see it${r.did.includes('email') ? ', and the email cadence starts at touch 2' : '; the email cadence still starts at touch 1 (you did not email it)'}.`);
    if (r.queued) out(`   ${dry ? 'Would take' : 'Took'} it off the text queue (it was waiting there for a first text).`);
    for (const w of r.warnings) out(`   ⚠️  ${w}`);
    if (!dry) out(`   Change its tags: node textLog.js --tag-lead ${r.account.id} --tag ${r.tags.join(',')}   ·   Undo: node textLog.js --remove-lead ${r.account.id}`);
  }
  out('');
  return { code: failed && !added ? 1 : 0, changed: added > 0 && !dry };
}

module.exports = {
  parseAccountRef, parseWhen, parseTags, addLead, tagLead, setLeadBoard, nurtureLead,
  graduateExpiredNurture, removeLead, listLeads, emailLeads, emailStanding,
  stage2Day, stage2Lines, cli, STAGE2_DAYS, DIDS, MAX_TAGS,
};
