#!/usr/bin/env node
'use strict';
/**
 * senderSetup — the FIRST-LAUNCH SETUP and the SETTINGS screen. run.sh starts it before anything else. It only exists in the copy of the folder that is handed to someone:
 * share/build-package.js adds it to the zip, and the folder the zip is built from has no such file and works as it always did.
 *
 * WHY: every text and email carries the sender's first name, full name, job title, call number, text number and booking link: sender.js swaps them into the wording the moment a run starts.
 * And the list that opens by itself (Assistant.js, CONFIG.listUrl) has to be the sender's OWN pipeline, never a teammate's. Whoever gets this folder types all of it in here, ONCE,
 * instead of editing sender.json by hand.
 *
 *   first launch      seven questions (the first name, the five lines of the email signature, and the pipeline list), then everything is shown EXACTLY as it will be used, and nothing is saved
 *                     until the person types "yes" (or fixes a line first). Pressing Enter alone never saves.
 *   every launch      a small box (who it sends as, which list opens): Enter starts the run, S opens Settings
 *   zw --settings       opens Settings and stops: nothing is started
 *   Settings > T      the TEXT MESSAGES: read the ready-made texts, change their wording, add texts of your own. Saved in text-templates.json (only what was changed or added). <first name>, <full name>,
 *                     <call number>, <text number> and <booking link> stand for the sender's own details and are filled in when a text is sent. The copy's program calls applyTextEdits() (below) right
 *                     after the built-in texts are set up, so an edited text is what the text campaign lists, types and sends. text-defaults.json (made by share/build-package.js) holds the built-in texts.
 *   Settings > Claude drafts (line 8)  off by default: plain email / text campaigns pick a template. Turn on to let Claude write each message from the account's notes (needs Claude Code signed in).
 *
 * THE PIPELINE LIST is the address of a Salesforce OPPORTUNITIES list view, pasted from the browser's address bar. Only a housecallpro.lightning.force.com/lightning/o/Opportunity/list?filterName=...
 * address is accepted (the rest of it is dropped). share/build-package.js patches the copy's Assistant.js so CONFIG.listUrl and CONFIG.testListUrl come from listUrl() below: the saved link, else the one
 * this zip was built to offer (PKG_LIST_URL, if any), else the person's own recently viewed opportunities, never somebody else's list. listUrl() never throws and never comes back blank.
 *
 * Saved in sender.json (the file sender.js reads; ASSISTANT_SENDER_FILE points at another one, for tests) together with "confirmedAt": when the details were checked. Details that are complete
 * but were never confirmed here (typed by hand, or sent along with the folder) are asked about once too, with the old answers ready to keep.
 *
 * It talks only on a terminal, and never for --help, --yes, --inspect or --sent (nobody to answer; ASSISTANT_NO_SETUP=1 skips it too).
 * Exit status: 0 = go on with the run, 3 = finished, do NOT start the run (zw --settings), 130 = cancelled (Ctrl-C, or the input ended): nothing was saved and nothing is started,
 * 4 = the details could not be saved (or Settings could not open): nothing is started. Any other status means this screen itself crashed: run.sh says so and the run carries on, because
 * a text or email that still lacks a detail is never sent (sender.js), so nothing goes out wrong.
 *
 *   node senderSetup.js --selfcheck   (no questions, nothing written) proves this file and sender.js work together; the packager runs it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CMD = 'zw';
const FILE = process.env.ASSISTANT_SENDER_FILE || path.join(__dirname, 'sender.json');      // the very file sender.js reads
const TEXTS_FILE = process.env.ASSISTANT_TEXTS_FILE || path.join(__dirname, 'text-templates.json');      // the texts this person changed or added (Settings > T)
const DEFAULTS_FILE = path.join(__dirname, 'text-defaults.json');      // the built-in texts with <tokens> where the sender's details go (made by share/build-package.js)

// The signature exactly as Assistant.js builds it (its EMAIL_SIGNATURE, before sender.apply). The packager checks that the two are the same, line for line, so what is shown here IS what is sent.
const SIGNATURE_TEMPLATE = [
  'Luke Franco',
  'Account Executive',
  'Housecall Pro',
  'Text: 833-337-0813',
  'Call: 970-338-3120',
  '',
  'Book A Demo: https://tinyurl.com/HousecallProDemo',
].join('\n');

const REQUIRED = ['fullName', 'callNumber', 'textNumber', 'bookingLink'];      // what sender.js cannot do without (firstName and title have a fallback there); the pipeline list is checked on its own, in needsFirstRun
const SKIP_FLAGS = new Set(['--help', '-h', '--yes', '-y', '--inspect', '--sent', '--texted', '--dashboard']);      // nobody to ask, or nothing is sent
const HELP = `Who this copy texts and emails as, and the pipeline list that opens by itself. Saved by the setup screen: change it with Settings (type S when ${CMD} starts, or run ${CMD} --settings). fullName must match how Salesforce shows your name on a text.`;

// ---------------------------------------------------------------- what a good answer looks like
const WORD = "\\p{L}[\\p{L}'’.\\-]*";
const NAME_RE = new RegExp(`^${WORD}(?: ${WORD})+$`, 'u');      // two words or more
const FIRST_RE = new RegExp(`^${WORD}$`, 'u');                 // one word
/** All lower case or ALL UPPER CASE ("jane smith") gets capitals; a name typed with its own mix ("McDonald") is left exactly as typed. */
const tidyCase = (s) => (s === s.toLowerCase() || s === s.toUpperCase())
  ? s.toLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (m, pre, c) => pre + c.toUpperCase())
  : s;

function parseFullName(raw) {
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return { error: 'Please type your full name.' };
  if (!NAME_RE.test(s)) return { error: s.includes(' ') ? 'Letters only, please (hyphens, apostrophes and periods are fine).' : 'Type your first AND last name, the way Salesforce shows it on your texts.' };
  return { value: tidyCase(s) };
}
function parseFirstName(raw) {
  const s = String(raw).trim();
  if (!s) return { error: 'Please type your first name.' };
  if (!FIRST_RE.test(s)) return { error: 'One word, letters only (a hyphen or an apostrophe is fine).' };
  return { value: tidyCase(s) };
}
function parseTitle(raw) {
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return { error: 'Please type your job title.' };
  if (s.length > 60) return { error: 'That is a long title: 60 characters at most.' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’.,&/()+\-]*$/u.test(s)) return { error: "Letters, numbers and spaces only (and . , & / ( ) + - ' are fine)." };      // no $ or [ ]: sender.js puts the title into the wording with replace()
  return { value: s };
}
/** A US number: any punctuation is fine, 10 digits (a leading 1 is dropped), area code and exchange start with 2-9. → 555-234-5678 */
function parsePhone(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return { error: 'That is not a 10-digit US phone number. Type it like 555-234-5678.' };
  return { value: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` };
}
/** A web link, with or without https://. → https://tinyurl.com/jane-demo */
function parseLink(raw) {
  const s = String(raw).trim().replace(/^[<"'(]+|[>"')]+$/g, '');
  if (!s) return { error: 'Please type your booking link.' };
  if (/\s/.test(s)) return { error: 'A link has no spaces in it.' };
  const bare = s.replace(/^https?:\/\//i, '');
  const label = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})+(?:/\\S*)?$`).test(bare)) return { error: 'That does not look like a web link. Type it like tinyurl.com/jane-demo.' };
  return { value: `${/^http:\/\//i.test(s) ? 'http' : 'https'}://${bare}` };
}
/** Claude drafts for plain email / text campaigns: on or off (default off — templates only, no Claude). */
function parseOnOff(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { error: 'Type on or off.' };
  if (['on', 'yes', 'y', 'true', '1', 'enable', 'enabled'].includes(s)) return { value: 'on' };
  if (['off', 'no', 'n', 'false', '0', 'disable', 'disabled'].includes(s)) return { value: 'off' };
  return { error: 'Type on or off.' };
}

// ---------------------------------------------------------------- the pipeline list
const LIST_HOST = 'housecallpro.lightning.force.com';
const LIST_PATH = '/lightning/o/Opportunity/list';
/** What a copy opens when no list was ever saved: the person's OWN recently viewed opportunities (Salesforce's standard "Recent" list view), never somebody else's list. */
const GENERIC_LIST = `https://${LIST_HOST}${LIST_PATH}?filterName=Recent`;
const BUILT_IN_LIST_RAW = 'https://housecallpro.lightning.force.com/lightning/o/Opportunity/list?filterName=Zach_White_Official_Fire_Pipeline';      // Zach White's Official Fire Pipeline (this copy); share/build-package.js can also fill PKG_LIST_URL
const BUILT_IN_LIST = /^\{\{.*\}\}$/.test(BUILT_IN_LIST_RAW) ? '' : BUILT_IN_LIST_RAW;      // (it is still the placeholder when this file is run from share/)

/**
 * A pipeline list: the address of a Salesforce OPPORTUNITIES list view, pasted from the browser's address bar (with or without https://). Everything else in the address is dropped.
 * → https://housecallpro.lightning.force.com/lightning/o/Opportunity/list?filterName=00B3t00000AbCdEFGH
 */
function parseList(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^[<"'(]+|[>"')]+$/g, '');
  if (!s) return { error: 'Please paste your pipeline list link.' };
  if (/\s/.test(s)) return { error: "A link has no spaces in it: paste the whole address from your browser's address bar, in one piece." };
  let u = null;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch (_) { /* not an address at all */ }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return { error: "That does not look like a web link. Open your list in Salesforce and copy the whole address from your browser's address bar." };
  if (u.host !== LIST_HOST) return { error: `That is not a Housecall Pro Salesforce link: it should start with https://${LIST_HOST}/ . Open your list in Salesforce and copy the address from your browser's address bar.` };
  if (!/^\/lightning\/o\/Opportunity\/list\/?$/i.test(u.pathname)) return { error: 'This tool works from an OPPORTUNITIES list: the link should contain /lightning/o/Opportunity/list . In Salesforce open the Opportunities tab, pick your list, then copy the address.' };
  const name = u.searchParams.get('filterName') || '';
  if (!name) return { error: 'That link does not say which list it is (the address should end with ?filterName=...). In Salesforce pick your list from the list menu, then copy the address again.' };
  if (!/^[A-Za-z0-9_]{1,80}$/.test(name)) return { error: 'The list name in that link has characters a Salesforce list never has. Copy the address again from the address bar.' };
  return { value: `https://${LIST_HOST}${LIST_PATH}?filterName=${name}` };
}

const FIELDS = [
  { key: 'fullName', label: 'Full name', ask: 'Your FULL name, exactly as Salesforce shows it on your texts', example: 'Jane Smith', parse: parseFullName },
  { key: 'firstName', label: 'First name', ask: 'Your FIRST name, the way your texts should say it', example: 'Jane', parse: parseFirstName, fallback: (v) => String(v.fullName || '').split(' ')[0] },
  { key: 'title', label: 'Job title', ask: 'Your job title, the second line of your email signature', example: 'Account Executive', parse: parseTitle, fallback: () => 'Account Executive' },
  { key: 'callNumber', label: 'Call number', ask: 'The phone number pros should CALL', example: '555-234-5678', parse: parsePhone },
  { key: 'textNumber', label: 'Text number', ask: 'The phone number pros should TEXT', example: '555-345-6789', parse: parsePhone },
  { key: 'bookingLink', label: 'Booking link', ask: 'Your booking link, where pros book a demo with you', example: 'tinyurl.com/jane-demo', parse: parseLink },
  { key: 'listUrl', label: 'Pipeline list', ask: 'Your PIPELINE LIST: the Salesforce Opportunities list you work from', hint: 'In your normal browser open that list, copy the whole address from the address bar, and paste it here.', example: 'https://housecallpro.lightning.force.com/lightning/o/Opportunity/list?filterName=00B3t00000AbCdEFGH', parse: parseList, fallback: () => BUILT_IN_LIST },
  // Settings only (not asked on first launch): plain email / text campaigns use templates unless this is on.
  { key: 'claudeDrafts', label: 'Claude drafts', ask: 'Claude drafts for plain email and text campaigns', hint: 'off = pick a ready-made template (no Claude). on = Claude writes each message from that account\'s Salesforce notes (needs Claude Code signed in).', example: 'off', parse: parseOnOff, fallback: () => 'off', settingsOnly: true },
];
const KEYS = FIELDS.map((f) => f.key);
const SETUP_FIELDS = FIELDS.filter((f) => !f.settingsOnly);      // first launch asks these; Settings shows every line
const LINE_NUMBER = new RegExp(`^[1-${FIELDS.length}]$`);      // "1" up to the last line (single digits)
const SETUP_COUNT = SETUP_FIELDS.length;
const COUNT_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][SETUP_COUNT] || String(SETUP_COUNT);
/** → true when Settings has Claude drafts turned on (missing / anything else = off). */
function claudeDraftsOn(values) {
  const v = values != null ? values : (() => { try { return load().values; } catch (_) { return {}; } })();
  return String(v.claudeDrafts || '').trim().toLowerCase() === 'on';
}

// ---------------------------------------------------------------- the saved details
/** What sender.json holds now: the six details, when they were confirmed, and the rest of the file (kept as it is when it is saved again). */
function load() {
  let text = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (_) { /* no file yet */ }
  let raw = {};
  let broken = false;
  if (text != null && text.trim()) {
    try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) raw = j; else broken = true; } catch (_) { broken = true; }
  }
  const values = {};
  for (const k of KEYS) values[k] = String(raw[k] == null ? '' : raw[k]).trim();
  // Claude drafts default off when the key was never saved (older sender.json files).
  if (!values.claudeDrafts) values.claudeDrafts = 'off';
  else {
    const c = parseOnOff(values.claudeDrafts);
    values.claudeDrafts = c.error ? 'off' : c.value;
  }
  return { values, confirmedAt: typeof raw.confirmedAt === 'string' ? raw.confirmedAt : '', raw, broken, text };
}
/** First launch, or complete details that nobody has checked here yet. A pipeline list that is missing, or is not a good link, counts as an incomplete detail. */
const needsFirstRun = (state) => REQUIRED.some((k) => !state.values[k]) || !!parseList(state.values.listUrl).error || !state.confirmedAt;

/**
 * The pipeline list this copy opens by itself: Assistant.js's CONFIG.listUrl and CONFIG.testListUrl (share/build-package.js patches the copy to read it from here). The link saved in sender.json; until
 * one is saved, the one this zip was built to offer (if any); otherwise the person's own recently viewed opportunities, never somebody else's list. It never throws and never comes back blank:
 * a missing, unreadable or hand-edited sender.json just falls through to the next choice.
 */
function listUrl() {
  try {
    const r = parseList(load().values.listUrl);
    if (!r.error) return r.value;
  } catch (_) { /* fall through to the next choice */ }
  const built = parseList(BUILT_IN_LIST);
  return built.error ? GENERIC_LIST : built.value;
}
/** The list's name inside its link (a Salesforce id like 00B3t00000AbCdEFGH, or an API name), for the small box; '' when there is none. */
const listName = (url) => { try { return new URL(url).searchParams.get('filterName') || ''; } catch (_) { return ''; } };

class Cancelled extends Error {}
class SaveFailed extends Error {}
let textsSaved = false;      // a text was saved in this Settings session (so "nothing was saved" would be wrong after a Ctrl-C)

/** Writes sender.json in one piece (a temporary file, then a rename), so a crash can never leave half a file. A file that could not be read is kept next to it first. */
function save(values, state) {
  const out = { _help: HELP };
  for (const k of KEYS) out[k] = values[k];
  if (!out.claudeDrafts) out.claudeDrafts = 'off';
  out.confirmedAt = new Date().toISOString();
  for (const [k, v] of Object.entries(state.raw || {})) if (!(k in out)) out[k] = v;
  const tmp = `${FILE}.tmp-${process.pid}`;
  try {
    if (state.broken && state.text) fs.writeFileSync(`${FILE}.broken-${Date.now()}`, state.text);
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to remove */ }
    throw new SaveFailed(`Could not save ${FILE}: ${e.message}`);
  }
}

/** The email signature for these details, made by the real sender.js (a fresh copy of it that reads these details), so the preview is the thing that will be sent. */
function signatureLines(values) {
  const tmp = path.join(os.tmpdir(), `assistant-sender-preview-${process.pid}-${Date.now()}.json`);
  const senderPath = require.resolve('./sender');
  const before = process.env.ASSISTANT_SENDER_FILE;
  fs.writeFileSync(tmp, JSON.stringify(values));
  process.env.ASSISTANT_SENDER_FILE = tmp;
  delete require.cache[senderPath];
  try {
    return require('./sender').apply(SIGNATURE_TEMPLATE).split('\n');
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_SENDER_FILE; else process.env.ASSISTANT_SENDER_FILE = before;
    delete require.cache[senderPath];
    try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
  }
}

// ---------------------------------------------------------------- the text messages (Settings > T)
const MAX_TEXT = 1600;      // the most one text may hold, once the sender's details are in
const NAME_MAX = 60;
const MAX_ADDED = 40;      // how many texts of their own one person can add
const REENGAGE_PREFIX = '48h Re-engage';      // textLog.js takes a text whose name starts like this for the 48-hour re-engage touch: no name of ours may (the packager checks that the two agree)
const TOKEN_RE = /<[ \t]*(first[ \t]+name|full[ \t]+name|call[ \t]+number|text[ \t]+number|booking[ \t]+link)[ \t]*>/gi;
const TEXTS_HELP = `Your text messages. Saved by Settings (type S when ${CMD} starts, then T). Only the texts you changed or added are listed here: every other text is the built-in one. <first name>, <full name>, <call number>, <text number> and <booking link> are filled in from your details when a text is sent.`;
const marker = (field) => `[SET sender.json: ${field}]`;      // the very marker sender.js writes where a detail is missing, and refuses to type
// Names the history and the follow-up board read as having a MEANING of their own (textLog.js: GENERIC_TEMPLATES, AUTO_PREFIX, REENGAGE_PREFIX, FOLLOWUP_STEPS; cadence.js: the 'Follow-up board' email):
// no text of ours may carry one (the packager checks that textLog.js and cadence.js still say what this list says).
const RESERVED_NAMES = ['custom message', 'email first-touch', '(text)', '(email)', 'follow-up board', 'follow-up 1', 'friendly check-in', 'follow-up 2 (success story)'];
const RESERVED_PREFIXES = [REENGAGE_PREFIX.toLowerCase(), 'auto custom'];
const KEEP_SYMBOLS = /[\u{a9}\u{ae}\u{2122}]/gu;      // (c), (R) and TM are fine in a business text, although the emoji list includes them
/**
 * What cannot be typed into the message box, or can scramble a text message, in a piece of text WITHOUT line breaks → 'control' (a tab ...) | 'special' (emoji and pictograms, invisible and
 * direction-changing characters, lone surrogates, private-use and unassigned characters, anything outside the basic multilingual plane) | null when it is fine.
 */
function oddChar(s) {
  if (/\p{Cc}/u.test(s)) return 'control';
  if (/[\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{fffd}\u{10000}-\u{10ffff}]/u.test(s)) return 'special';
  if (/\p{Extended_Pictographic}/u.test(s.replace(KEEP_SYMBOLS, ''))) return 'special';
  return null;
}

/**
 * A text with its <tokens> filled in from the sender's details, the way sender.js fills them into the built-in texts (apply): a missing detail comes out as the same [SET sender.json: ...] marker,
 * which is never typed. The booking link goes in without https://, as it does in the built-in texts.
 */
function expandTokens(text, v) {
  const val = (k) => String(v && v[k] != null ? v[k] : '').trim();
  const by = {
    'first name': val('firstName') || val('fullName').split(/\s+/)[0] || marker('fullName'),
    'full name': val('fullName') || marker('fullName'),
    'call number': val('callNumber') || marker('callNumber'),
    'text number': val('textNumber') || marker('textNumber'),
    'booking link': val('bookingLink').replace(/^https?:\/\//i, '') || marker('bookingLink'),
  };
  return String(text).replace(TOKEN_RE, (m, name) => by[name.toLowerCase().replace(/\s+/g, ' ')]);
}

/** The wording of one text (with <tokens>) → { value, sent } or { error }. `value` is the wording tidied for saving; `sent` is what will be typed for the sender `v`. */
function checkText(raw, v) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  if (!text.trim()) return { error: 'The text is empty.' };
  const odd1 = oddChar(text.replace(/\n/g, ''));
  if (odd1 === 'control') return { error: 'The text has a character that cannot be typed into the message box (a tab, for example).' };
  if (odd1) return { error: 'Emoji and other special symbols are not allowed: they can scramble a text message. Plain letters, numbers and punctuation only.' };
  if (/\{\{|\}\}/.test(text)) return { error: 'Please take the {{ }} out. Your details go in only where you type <first name>, <full name>, <call number>, <text number> or <booking link>.' };
  if (/\[SET sender\.json/i.test(text)) return { error: 'The text has a [SET sender.json ...] marker in it: please take it out.' };
  const odd = text.replace(TOKEN_RE, '').match(/<[^<>\n]{0,40}>?|[<>]/);
  if (odd) return { error: `"${odd[0]}" is not one of the details this tool can fill in. Use <first name>, <full name>, <call number>, <text number> or <booking link>, or take the < > out.` };
  const sent = expandTokens(text, v);
  if (sent.length > MAX_TEXT) return { error: `That is ${sent.length} characters once your details are in: ${MAX_TEXT} at most.` };
  return { value: text, sent };
}

/** The name of a text, as the list shows it → { value } or { error }. `others` = the names the other texts have (two texts never share one: the history records texts by name). */
function checkName(raw, others) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'Please type a name for this text (the list shows it).' };
  if (s.length > NAME_MAX) return { error: `That name is long: ${NAME_MAX} characters at most.` };
  if (oddChar(s)) return { error: 'Letters, numbers and ordinary punctuation only, please.' };
  const low = s.toLowerCase();
  if (RESERVED_NAMES.includes(low) || RESERVED_PREFIXES.some((p) => low.startsWith(p))) return { error: 'That name has a meaning of its own in the history of sends (a follow-up step, the 48-hour re-engage, a custom message ...): please pick another.' };
  if ((others || []).some((o) => String(o).toLowerCase() === s.toLowerCase())) return { error: 'Another text already has that name: please pick another.' };
  return { value: s };
}

/** What text-templates.json holds: the built-in texts this person changed (by number) and the texts they added (in order), and the rest of the file (kept as it is when it is saved again). Never throws. */
function loadTexts(file = TEXTS_FILE) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { /* no file yet */ }
  let raw = {};
  let broken = false;
  if (text != null && text.trim()) {
    try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) raw = j; else broken = true; } catch (_) { broken = true; }
  }
  const edited = {};
  const added = [];
  const dropped = [];      // what the file holds that this version cannot use: named in a warning, and kept in a copy of the file when it is saved again
  const good = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && typeof e.name === 'string' && typeof e.text === 'string';
  if (raw.edited != null) {
    if (typeof raw.edited === 'object' && !Array.isArray(raw.edited)) {
      for (const [id, e] of Object.entries(raw.edited)) { if (/^[1-9]\d{0,3}$/.test(id) && good(e)) edited[id] = { name: e.name, text: e.text }; else dropped.push(`edited ${JSON.stringify(id)}`); }
    } else dropped.push('"edited" is not a list of numbered texts');
  }
  if (raw.added != null) {
    if (Array.isArray(raw.added)) raw.added.forEach((e, i) => { if (good(e)) added.push({ name: e.name, text: e.text }); else dropped.push(`added #${i + 1}`); });
    else dropped.push('"added" is not a list of texts');
  }
  return { edited, added, dropped, raw, broken, text, file };
}

/** Writes text-templates.json in one piece (a temporary file, then a rename), like sender.json: a crash can never leave half a file. A file that could not be read is kept next to it first. */
function saveTexts(edited, added, state) {
  const file = (state && state.file) || TEXTS_FILE;
  const out = { _help: TEXTS_HELP, edited, added };
  for (const [k, v] of Object.entries((state && state.raw) || {})) if (!(k in out)) out[k] = v;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    if (state && (state.broken || (state.dropped && state.dropped.length)) && state.text) fs.writeFileSync(`${file}.broken-${Date.now()}`, state.text);
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to remove */ }
    throw new SaveFailed(`Could not save ${file}: ${e.message}`);
  }
}

/** The built-in texts, with <tokens> where the sender's details go: [{ id, name, text }] in number order. Throws when text-defaults.json is missing or is not what the packager writes. */
function loadDefaults(file = DEFAULTS_FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = j && j.texts;
  if (!t || typeof t !== 'object') throw new Error('it has no "texts" in it');
  const list = Object.keys(t).filter((id) => /^[1-9]\d{0,3}$/.test(id) && t[id] && typeof t[id].text === 'string').sort((a, b) => Number(a) - Number(b)).map((id) => ({ id, name: String(t[id].name), text: t[id].text }));
  if (!list.length) throw new Error('it holds no texts');
  return list;
}

/**
 * The program's side of Settings > T: the copy's program calls this right after the sender's details went into the built-in TEMPLATES. A text the person changed replaces the built-in one with the same
 * number (its <tokens> filled in from sender.json); the texts they added get the next numbers, in the order they were added. Anything that is not a good text is skipped with ONE warning line and the
 * built-in wording stays. It never throws and never stops a run. `opts` (file, values, quiet) is for tests.
 */
function applyTextEdits(TEMPLATES, opts = {}) {
  const res = { changed: 0, added: 0, skipped: [] };
  try {
    const st = loadTexts(opts.file);
    const shown = path.basename(st.file);
    if (st.broken) {
      res.skipped.push('the whole file');
      if (!opts.quiet) console.warn(`\n⚠\ufe0f  ${shown} could not be read, so the built-in texts are used. Open Settings (type S when ${CMD} starts, then T) to look at your texts.\n`);
      return res;
    }
    const v = opts.values || load().values;
    const top = Math.max(0, ...Object.keys(TEMPLATES).map(Number).filter(Number.isFinite));
    const taken = Object.values(TEMPLATES).map((t) => (t && t.name) || '');      // the names in use: the built-in ones, then each added text's
    if (st.dropped.length) res.skipped.push(`${st.dropped.length} entr${st.dropped.length === 1 ? 'y' : 'ies'} in the wrong shape (${st.dropped.slice(0, 3).join(', ')}${st.dropped.length > 3 ? ', ...' : ''})`);
    for (const [id, e] of Object.entries(st.edited)) {
      if (!TEMPLATES[id]) continue;      // a text this version does not have: nothing to replace
      const c = checkText(e.text, v);
      if (c.error) { res.skipped.push(`text ${id} (${c.error})`); continue; }
      TEMPLATES[id] = Object.assign({}, TEMPLATES[id], { text: c.sent });      // only the wording: a built-in text keeps its name (the history and the follow-up board know a text by its name)
      res.changed++;
    }
    st.added.forEach((e, i) => {
      const c = checkText(e.text, v);
      const n = checkName(e.name, taken);
      if (c.error || n.error) { res.skipped.push(`your text "${String(e.name).slice(0, 30)}" (${c.error || n.error})`); return; }
      TEMPLATES[String(top + 1 + i)] = { name: n.value, text: c.sent };
      taken.push(n.value);
      res.added++;
    });
    if (res.skipped.length && !opts.quiet) console.warn(`\n⚠\ufe0f  ${shown}: ${res.skipped.join('; ')}: skipped, the built-in wording is used. Open Settings (type S when ${CMD} starts, then T) to fix it.\n`);
  } catch (_) { /* a missing or unreadable file never stops a run */ }
  return res;
}

// ---------------------------------------------------------------- talking to the person
/** One reader for the whole conversation (lines that arrive early wait their turn). ask() → the line, or null when the input has ended (Ctrl-C, Ctrl-D). */
function makeIO({ input = process.stdin, output = process.stdout } = {}) {
  const tty = !!(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output, terminal: tty });
  const early = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (l) => { if (waiting.length) waiting.shift()(l); else early.push(l); });
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
  rl.on('SIGINT', () => rl.close());
  const colour = !!(tty && !process.env.NO_COLOR);
  return {
    color: (code, s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s),
    out: (s = '') => { output.write(`${s}\n`); },
    ask: (q) => new Promise((resolve) => {
      if (tty && !closed) { rl.setPrompt(q); rl.prompt(); } else output.write(`${q}\n`);
      if (early.length) return resolve(early.shift());
      if (closed) return resolve(null);
      return waiting.push(resolve);
    }),
    close: () => { try { rl.close(); } catch (_) { /* already closed */ } },
  };
}

function box(io, rows) {
  const w = Math.max(...rows.map((r) => r.length));
  io.out(`  ┌${'─'.repeat(w + 2)}┐`);
  rows.forEach((r) => io.out(`  │ ${io.color('1', r.padEnd(w))} │`));
  io.out(`  └${'─'.repeat(w + 2)}┘`);
}

/** One question. Enter keeps the answer shown (when there is one); a bad answer is explained and asked again. */
async function askField(io, field, draft, n, total) {
  const keep = draft[field.key] || (field.fallback ? field.fallback(draft) : '');
  io.out('');
  io.out(`  ${io.color('1', `${n} of ${total}`)} · ${field.ask}`);
  if (field.hint) io.out(`         ${field.hint}`);
  io.out(`         (for example: ${field.example})${keep ? `    Press Enter to keep: ${keep}` : ''}`);
  for (;;) {
    const ans = await io.ask('  > ');
    if (ans === null) throw new Cancelled();
    const typed = ans.trim() || keep;
    if (!typed) { io.out('    This one is needed: please type it.'); continue; }
    const r = field.parse(typed);
    if (r.error) { io.out(`    ${r.error}`); continue; }
    io.out(`    ✓ ${r.value}`);
    return r.value;
  }
}

/** Changing the full name also asks for the first name again: it follows the new name unless it was a name of its own. */
async function askLine(io, draft, idx) {
  const f = FIELDS[idx];
  const oldFirst = String(draft.fullName || '').split(' ')[0];
  draft[f.key] = await askField(io, f, draft, idx + 1, FIELDS.length);
  if (f.key === 'fullName') {
    if (draft.firstName === oldFirst) draft.firstName = '';
    io.out('\n  Your full name is set, so check your first name too:');
    draft.firstName = await askField(io, FIELDS[1], draft, 2, FIELDS.length);
  }
}
/** First-launch questions only (Settings-only lines like Claude drafts are skipped). */
async function askAll(io, draft) {
  for (let i = 0; i < SETUP_FIELDS.length; i++) {
    const f = SETUP_FIELDS[i];
    const oldFirst = String(draft.fullName || '').split(' ')[0];
    draft[f.key] = await askField(io, f, draft, i + 1, SETUP_FIELDS.length);
    if (f.key === 'fullName' && draft.firstName === oldFirst) draft.firstName = '';
  }
  if (!draft.claudeDrafts) draft.claudeDrafts = 'off';
}

/** The check-it-yourself screen. Only the word yes saves; a number fixes that line and shows everything again. → 'yes' | 'quit' */
async function review(io, draft) {
  for (;;) {
    const rule = `  ${'─'.repeat(66)}`;
    io.out('');
    io.out(rule);
    io.out(`  ${io.color('1;33', 'PLEASE CHECK EVERY LETTER AND NUMBER.')} This is what goes out under your name.`);
    io.out('');
    SETUP_FIELDS.forEach((f, i) => io.out(`   ${i + 1}  ${f.label.padEnd(13)} ${draft[f.key]}`));
    if (draft.claudeDrafts && draft.claudeDrafts !== 'off') {
      io.out(`   ${FIELDS.findIndex((f) => f.key === 'claudeDrafts') + 1}  ${'Claude drafts'.padEnd(13)} on  (Claude writes each email/text)`);
    }
    io.out('');
    io.out(`   Your texts introduce you as: ${draft.firstName}`);
    io.out('   Your email signature, exactly as it will be sent:');
    io.out('');
    signatureLines(draft).forEach((l) => io.out(`        ${l}`));
    io.out('');
    io.out('   Your full name must match how Salesforce shows you on a text: that is how your own texts are recognised.');
    io.out('   Tip: paste the booking link into a browser once, to be sure it opens.');
    io.out(`   Line ${SETUP_COUNT} is the list that opens by itself after you sign in to Salesforce. Make sure it is YOUR pipeline, not a teammate's:`);
    io.out('   every account on that list is texted and emailed under your name.');
    io.out(rule);
    const ans = await io.ask(`  Is it all right?  Type yes to save, a number (1-${SETUP_COUNT}) to fix that line, or quit:  `);
    if (ans === null) throw new Cancelled();
    const t = ans.trim().toLowerCase();
    if (t === 'yes' || t === 'y') return 'yes';
    if (t === 'quit' || t === 'q' || t === 'exit') return 'quit';
    if (/^[1-9]$/.test(t) && Number(t) >= 1 && Number(t) <= SETUP_COUNT) {
      const setupIdx = Number(t) - 1;
      const fullIdx = FIELDS.indexOf(SETUP_FIELDS[setupIdx]);
      await askLine(io, draft, fullIdx);
      continue;
    }
    io.out(`    Please type yes, a number from 1 to ${SETUP_COUNT}, or quit. (Enter alone does not save.)`);
  }
}

const SAVED = (io) => `\n  ${io.color('1;32', '✓ Saved.')} A change applies from the next run. To change anything later, type S when ${CMD} starts, or run: ${CMD} --settings\n`;

/** The very first launch (or details nobody has confirmed here yet). → true when saved, false when the person quit without saving */
async function firstRun(io, state) {
  const draft = { ...state.values };
  const prefilled = FIELDS.some((f) => state.values[f.key]) || !!BUILT_IN_LIST;
  io.out('');
  box(io, ['Welcome! Let us set up your name, email signature and pipeline list.', 'You do this once; it is saved.']);
  io.out('');
  io.out('  Your texts and emails go out under what you type here, so every letter counts.');
  io.out(`  ${COUNT_WORD} quick questions, then you check everything and confirm before anything is saved.`);
  if (prefilled) io.out('  Some answers are already filled in (shown after "Press Enter to keep"): Enter keeps one, or type the right one.');
  await askAll(io, draft);
  if (await review(io, draft) !== 'yes') return false;
  save(draft, state);
  io.out(SAVED(io));
  return true;
}

// ---------------------------------------------------------------- Settings > T: reading and changing the texts
const tidyBody = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\s+$/, '');      // how two wordings are compared: the end of the text does not count
const TEXT_SAVED = (io, id) => `\n  ${io.color('1;32', '✓ Saved.')}${id ? ` (text ${id})` : ''} It is used from the next run.\n`;

/** The texts as Settings shows them: the built-in ones (changed or not), then the ones the person added, numbered after the last built-in one (the very numbers applyTextEdits gives them). */
function textsView() {
  const defaults = loadDefaults();
  const st = loadTexts();
  const items = defaults.map((d) => (st.edited[d.id] && tidyBody(st.edited[d.id].text) !== tidyBody(d.text)
    ? { id: d.id, name: d.name, text: st.edited[d.id].text, kind: 'changed', original: d }      // the name stays the built-in one: the history knows a text by its name
    : { id: d.id, name: d.name, text: d.text, kind: 'built-in', original: d }));
  const top = Number(defaults[defaults.length - 1].id);
  st.added.forEach((a, i) => items.push({ id: String(top + 1 + i), name: a.name, text: a.text, kind: 'yours', index: i }));
  return { items, defaults, st };
}

/** "16 ready-made, 2 changed, 1 of your own" for the line in Settings. */
function textsSummary() {
  try {
    const { items } = textsView();
    const changed = items.filter((x) => x.kind === 'changed').length;
    const yours = items.filter((x) => x.kind === 'yours').length;
    return `${items.length - yours} ready-made${changed ? `, ${changed} changed` : ''}${yours ? `, ${yours} of your own` : ''}`;
  } catch (_) { return '(not available in this folder)'; }
}

/** The lines of a new wording, up to a line that says END. → the wording as typed (an empty string when nothing was typed) */
async function askTextBody(io, hasCurrent) {
  io.out('');
  io.out('  Type or paste the new wording. When you are done, type END on a line by itself.');
  io.out('  Where your own details go, type <first name>, <full name>, <call number>, <text number> or <booking link>:');
  io.out('  they are filled in from your settings when the text is sent.');
  if (hasCurrent) io.out('  (Type END straight away to keep the wording as it is.)');
  const lines = [];
  for (;;) {
    const ans = await io.ask('  | ');
    if (ans === null) throw new Cancelled();
    if (ans.trim().toUpperCase() === 'END') break;
    lines.push(ans);
  }
  return lines.join('\n');
}

/** The name and the wording of one text, shown exactly as they will be typed; only the word yes accepts them. → { name, text } or null when the person did not accept */
async function writeText(io, values, current, otherNames, opts = {}) {
  let name;
  if (opts.fixedName) {      // a ready-made text keeps its name: the history of sends (and the follow-up board) know a text by its name
    name = current.name;
    io.out('');
    io.out(`  The name stays "${name}": the history of sends knows a text by its name.`);
  }
  while (!name) {
    io.out('');
    io.out(`  The name of the text, as the list shows it${current ? `    Press Enter to keep: ${current.name}` : ''}`);
    const ans = await io.ask('  > ');
    if (ans === null) throw new Cancelled();
    const r = checkName(ans.trim() || (current ? current.name : ''), otherNames);
    if (r.error) { io.out(`    ${r.error}`); continue; }
    name = r.value;
    io.out(`    ✓ ${name}`);
    break;
  }
  let body;
  for (;;) {
    const raw = await askTextBody(io, !!current);
    const kept = current ? checkText(current.text, values) : null;
    if (!raw.trim() && kept && !kept.error) { body = kept; io.out('    Nothing typed: the wording stays as it was.'); break; }
    const r = checkText(raw, values);
    if (r.error) { io.out(`    ${r.error}`); io.out('    Please type it again.'); continue; }
    body = r;
    break;
  }
  const rule = `  ${'─'.repeat(66)}`;
  io.out('');
  io.out(rule);
  io.out(`  ${io.color('1;33', 'THIS IS EXACTLY WHAT WILL BE TYPED FOR YOU:')}`);
  io.out('');
  body.sent.split('\n').forEach((l) => io.out(`      ${l}`));
  io.out('');
  io.out(`  ${body.sent.length} characters.`);
  if (opts.unsaved) io.out('  (This uses your SAVED details: you have changed some above that are not saved yet.)');
  io.out(rule);
  const ans = await io.ask('  Save it?  Type yes to save, or just press Enter to leave it as it was:  ');
  if (ans === null) throw new Cancelled();
  if (!/^(y|yes)$/i.test(ans.trim())) { io.out('\n  Nothing was changed.'); return null; }
  return { name, text: body.value };
}

/** Saves what writeText returned for a built-in or an added text. A built-in text written back exactly as it was is no longer "changed". */
function storeEdit(view, item, got) {
  const edited = { ...view.st.edited };
  const added = view.st.added.map((a) => ({ ...a }));
  if (item.kind === 'yours') added[item.index] = { name: got.name, text: got.text };
  else if (tidyBody(got.text) === tidyBody(item.original.text)) delete edited[item.id];
  else edited[item.id] = { name: item.original.name, text: got.text };      // the name stays the built-in one
  saveTexts(edited, added, view.st);
  textsSaved = true;
}

/** One text: its wording, and e to change it (r to put the original back, x to remove one of your own). → true when something was saved */
async function textScreen(io, values, view, item, unsaved) {
  const rule = `  ${'─'.repeat(66)}`;
  io.out('');
  io.out(rule);
  io.out(`  Text ${item.id}: ${io.color('1', item.name)}${item.kind === 'changed' ? '   (changed from the original)' : item.kind === 'yours' ? '   (your own)' : ''}`);
  io.out('');
  tidyBody(item.text).split('\n').forEach((l) => io.out(`      ${l}`));
  io.out(rule);
  const extra = item.kind === 'changed' ? ', r to put the original back' : item.kind === 'yours' ? ', x to remove it' : '';
  const ans = await io.ask(`  Type e to change it${extra}, or just press Enter to go back:  `);
  if (ans === null) throw new Cancelled();
  const t = ans.trim().toLowerCase();
  if (t === 'e' || t === 'edit') {
    const got = await writeText(io, values, item, view.items.filter((x) => x !== item).map((x) => x.name), { fixedName: item.kind !== 'yours', unsaved });
    if (!got) return false;
    if (got.name === item.name && tidyBody(got.text) === tidyBody(item.text)) { io.out('\n  Nothing was changed: that is the wording it already has.'); return false; }
    storeEdit(view, item, got);
    io.out(TEXT_SAVED(io, item.id));
    return true;
  }
  if ((t === 'r' && item.kind === 'changed') || (t === 'x' && item.kind === 'yours')) {
    const putBack = t === 'r';
    const ok = await io.ask(`  ${putBack ? 'Put the original text back?' : 'Remove this text?'}  Type yes to do it, or just press Enter to leave it as it is:  `);
    if (ok === null) throw new Cancelled();
    if (!/^(y|yes)$/i.test(ok.trim())) { io.out('\n  Nothing was changed.'); return false; }
    if (putBack) {
      const edited = { ...view.st.edited };
      delete edited[item.id];
      saveTexts(edited, view.st.added, view.st);
      io.out(TEXT_SAVED(io, item.id));
    } else {
      saveTexts(view.st.edited, view.st.added.filter((a, i) => i !== item.index), view.st);
      io.out(`\n  ${io.color('1;32', '✓ Removed.')} (the texts after it move up one number)\n`);
    }
    textsSaved = true;
    return true;
  }
  return false;
}

/** A new text of the person's own. → true when it was saved */
async function newText(io, values, view, unsaved) {
  if (view.st.added.length >= MAX_ADDED) { io.out(`\n  You already have ${MAX_ADDED} texts of your own: remove one first (open it and type x).`); return false; }
  const got = await writeText(io, values, null, view.items.map((x) => x.name), { unsaved });
  if (!got) return false;
  saveTexts({ ...view.st.edited }, [...view.st.added, { name: got.name, text: got.text }], view.st);
  textsSaved = true;
  io.out(TEXT_SAVED(io, String(Number(view.items[view.items.length - 1].id) + 1)));
  return true;
}

/** The list of texts: a number opens one, n writes a new one, Enter goes back to Settings. → true when anything was saved */
async function textsMenu(io, values, unsaved) {
  let saved = false;
  for (;;) {
    let view;
    try { view = textsView(); } catch (_) {
      io.out(`\n  The built-in texts could not be read (${path.basename(DEFAULTS_FILE)} is missing or damaged in this folder), so they cannot be changed here.`);
      return saved;
    }
    io.out('');
    io.out(`  ${io.color('1;33', 'YOUR TEXT MESSAGES')}  (saved in ${path.basename(TEXTS_FILE)})`);
    if (view.st.broken) io.out(`  ⚠\ufe0f  ${path.basename(TEXTS_FILE)} could not be read: the built-in texts are shown, and the next change you save replaces that file (a copy of it is kept next to it).`);
    if (view.st.dropped.length && !view.st.broken) io.out(`  Warning: ${view.st.dropped.length} entr${view.st.dropped.length === 1 ? 'y' : 'ies'} in ${path.basename(TEXTS_FILE)} could not be understood and ${view.st.dropped.length === 1 ? 'is' : 'are'} not used (${view.st.dropped.slice(0, 3).join(', ')}${view.st.dropped.length > 3 ? ', ...' : ''}). The next change you save keeps a copy of the file next to it.`);
    view.items.forEach((x) => io.out(`  ${x.id.padStart(2)}  ${x.name}${x.kind === 'changed' ? '    ← changed' : ''}${x.kind === 'yours' ? '    ← yours' : ''}`));
    const ans = await io.ask('  Type a number to read or change that text, n to write a new one, or just press Enter when you are done:  ');
    if (ans === null) throw new Cancelled();
    const t = ans.trim().toLowerCase();
    if (t === '') return saved;
    if (t === 'n' || t === 'new') { if (await newText(io, values, view, unsaved)) saved = true; continue; }
    const item = /^\d{1,4}$/.test(t) ? view.items.find((x) => x.id === String(Number(t))) : null;
    if (item) { if (await textScreen(io, values, view, item, unsaved)) saved = true; continue; }
    io.out('    Type a number from the list, n, or press Enter.');
  }
}

/** Change any line, then check the result and confirm it. → true when something was saved */
function fieldDisplay(f, draft, state) {
  const v = draft[f.key] || (f.settingsOnly ? 'off' : '(not set)');
  const changed = draft[f.key] !== state.values[f.key] ? '    ← changed' : '';
  const note = f.key === 'claudeDrafts' ? (claudeDraftsOn(draft) ? '  (Claude writes each email/text)' : '  (templates only, no Claude)') : '';
  return `   ${FIELDS.indexOf(f) + 1}  ${f.label.padEnd(13)} ${v}${note}${changed}`;
}

async function settings(io, state) {
  const draft = { ...state.values };
  if (!draft.claudeDrafts) draft.claudeDrafts = 'off';
  let touchedTexts = false;
  for (;;) {
    io.out('');
    io.out(`  ${io.color('1;33', 'SETTINGS')}  (saved in ${path.basename(FILE)})`);
    FIELDS.forEach((f) => io.out(fieldDisplay(f, draft, state)));
    io.out(`   T  ${'Text messages'.padEnd(13)} ${textsSummary()}`);
    const ans = await io.ask(`  Type a number to change that line, a to go through your name/numbers/list, T for your text messages, or just press Enter when you are done:  `);
    if (ans === null) throw new Cancelled();
    const t = ans.trim().toLowerCase();
    if (t === '') break;
    if (t === 'a' || t === 'all') await askAll(io, draft);
    else if (t === 't' || t === 'texts') { if (await textsMenu(io, state.values, KEYS.some((k) => draft[k] !== state.values[k]))) touchedTexts = true; }
    else if (LINE_NUMBER.test(t)) await askLine(io, draft, Number(t) - 1);
    else io.out(`    Type a number from 1 to ${FIELDS.length}, a, T, or press Enter.`);
  }
  if (KEYS.every((k) => draft[k] === state.values[k])) { io.out(touchedTexts ? '\n  Your details are unchanged.' : '\n  No changes.'); return false; }
  // Claude-only change: confirm with a short yes, without re-asking the signature lines.
  const onlyClaude = KEYS.every((k) => k === 'claudeDrafts' || draft[k] === state.values[k]);
  if (onlyClaude) {
    const ans = await io.ask(`  Save Claude drafts as ${draft.claudeDrafts}?  Type yes to save, or quit:  `);
    if (ans === null) throw new Cancelled();
    const t = ans.trim().toLowerCase();
    if (t !== 'yes' && t !== 'y') { io.out('\n  Nothing was changed.'); return false; }
  } else if (await review(io, draft) !== 'yes') { io.out('\n  Nothing was changed.'); return false; }
  save(draft, state);
  io.out(SAVED(io));
  return true;
}

/** The small box at the start of every launch. → 'start' | 'settings' */
async function startScreen(io, v) {
  io.out('');
  box(io, [`Sending as:  ${v.fullName}${v.title ? `  ·  ${v.title}` : ''}`, `Pipeline list:  ${listName(v.listUrl) || '(not set)'}`, '', '[Enter] Start          [S] Settings']);
  for (;;) {
    const ans = await io.ask('  > ');
    if (ans === null) throw new Cancelled();
    const t = ans.trim().toLowerCase();
    if (t === '') return 'start';
    if (t === 's' || t === 'settings') return 'settings';
    if (t === 'q' || t === 'quit') throw new Cancelled();
    io.out('    Press Enter to start, or type S for Settings.');
  }
}

// ---------------------------------------------------------------- the whole thing
async function main(argv = process.argv.slice(2), opts = {}) {
  if (argv.includes('--selfcheck')) return selfcheck();
  const wantSettings = argv.includes('--settings');
  const envOff = String(process.env.ASSISTANT_NO_SETUP || '').trim().toLowerCase();
  const off = envOff !== '' && !['0', 'false', 'no', 'off'].includes(envOff);
  if (!wantSettings && (off || argv.some((a) => SKIP_FLAGS.has(a)))) return 0;
  const interactive = opts.interactive !== undefined ? opts.interactive : !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    if (wantSettings) { process.stderr.write('Settings needs a terminal: open Terminal and run it there.\n'); return 4; }
    return 0;      // nobody to ask: the run goes on, and a message that still lacks a detail is never sent (sender.js)
  }
  let state = load();
  const io = makeIO(opts);
  try {
    if (needsFirstRun(state)) {
      if (!await firstRun(io, state)) { io.out('\n  Nothing was saved and nothing was started. Run it again when you are ready.'); return 130; }
      return wantSettings ? 3 : 0;
    }
    if (wantSettings) { await settings(io, state); return 3; }
    for (;;) {
      if (await startScreen(io, state.values) === 'start') return 0;
      await settings(io, state);
      state = load();
    }
  } catch (e) {
    if (e instanceof Cancelled) { io.out(textsSaved ? '\n  Cancelled: the texts you saved stay saved; nothing else was saved and nothing was started.' : '\n  Cancelled: nothing was saved and nothing was started.'); return 130; }
    if (e instanceof SaveFailed) { io.out(`\n  ⛔ ${e.message}\n  Nothing was started.`); return 4; }
    process.stderr.write(`\n  The setup screen had a problem (${e && e.message}). ${wantSettings ? '' : 'The run goes on; nothing is sent while your name or numbers are missing.'}\n`);
    return wantSettings ? 4 : 0;
  } finally {
    io.close();
  }
}

/** No questions, nothing written: does the signature come out right for sample details, with none of the first author's words left in it? → exit status */
function selfcheck() {
  try {
    const text = signatureLines({ fullName: 'Jane Smith', firstName: 'Jane', title: 'Account Executive', callNumber: '555-234-5678', textNumber: '555-345-6789', bookingLink: 'https://tinyurl.com/jane-demo' }).join('\n');
    const bad = [];
    for (const want of ['Jane Smith', 'Account Executive', 'Text: 555-345-6789', 'Call: 555-234-5678', 'Book A Demo: https://tinyurl.com/jane-demo']) if (!text.includes(want)) bad.push(`missing "${want}"`);
    if (/Luke|970-338-3120|833-337-0813|housecallprodemo|\[SET sender\.json/i.test(text)) bad.push('still holds the first author\'s words or a [SET sender.json] marker');
    const link = `https://${LIST_HOST}${LIST_PATH}?filterName=00B3t00000AbCdEFGH`;      // the pipeline list: an address pasted from the browser is cut down to this, and a copy never has a blank or foreign one
    const pasted = parseList(`${link}&0.source=alohaHeader`);
    if (pasted.error || pasted.value !== link) bad.push('a pasted pipeline list link is not read right');
    if (parseList(GENERIC_LIST).error) bad.push('the fallback pipeline list is not a good link');
    const used = listUrl();
    if (parseList(used).error) bad.push(`listUrl() gave ${JSON.stringify(used)}`);
    // the text messages: the <tokens>, the checks, and the merge over the built-in texts (a temporary file, removed again)
    const v = { fullName: 'Jane Smith', firstName: 'Jane', callNumber: '555-234-5678', textNumber: '555-345-6789', bookingLink: 'https://tinyurl.com/jane-demo' };
    if (expandTokens('Hi <first name> <FULL  name> <call number> <text number> <Booking Link>', v) !== 'Hi Jane Jane Smith 555-234-5678 555-345-6789 tinyurl.com/jane-demo') bad.push('the <tokens> of a text are not filled in right');
    if (!/\[SET sender\.json: callNumber\]/.test(expandTokens('<call number>', { ...v, callNumber: '' }))) bad.push('a missing detail does not come out as a [SET sender.json] marker in a text');
    for (const [what, text] of [['an empty text', ' \n '], ['a tab', 'a\tb'], ['an emoji', 'Hi \u{1F600}'], ['a mistyped detail', 'Hi <firstname>'], ['{{ }}', 'Hi {{name}}'], ['a [SET] marker', '[SET sender.json: fullName]'], ['a text over the limit', 'x'.repeat(MAX_TEXT + 1)]]) {
      if (!checkText(text, v).error) bad.push(`a text with ${what} is accepted`);
    }
    if (checkText('Hey, it’s <first name> at Housecall Pro.\n\nCall me: <call number>', v).error) bad.push('a normal text is refused');
    if (!checkName('48h re-engage mine').error || !checkName('Same', ['same']).error || !checkName('').error || checkName('A fine name', ['another']).error) bad.push('text names are not checked right');
    const T = { 1: { name: 'One', text: 'a' }, 3: { name: 'Three', text: 'c' } };
    const tmpTexts = path.join(os.tmpdir(), `assistant-texts-check-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpTexts, JSON.stringify({ edited: { 3: { name: 'Three!', text: 'Hi <first name>, call <call number>' }, 9: { name: 'Nine', text: 'no such text' } }, added: [{ name: 'Mine', text: 'My own <booking link>' }, { name: 'Bad', text: 'Hi <nope>' }] }));
      const r = applyTextEdits(T, { file: tmpTexts, values: v, quiet: true });
      if (T[3].name !== 'Three' || T[3].text !== 'Hi Jane, call 555-234-5678' || T[1].text !== 'a' || !T[4] || T[4].text !== 'My own tinyurl.com/jane-demo' || T[5] || T[9] || r.changed !== 1 || r.added !== 1 || r.skipped.length !== 1) bad.push('the texts a person changed or added are not merged over the built-in ones right');
    } finally { try { fs.unlinkSync(tmpTexts); } catch (_) { /* already gone */ } }
    for (const n of ['Custom message', 'FOLLOW-UP 1', 'Follow-up board', '(text)', 'Friendly Check-In', 'Auto custom plan', '48h Re-engage 2']) if (!checkName(n).error) bad.push(`the name "${n}" is accepted for a text`);
    for (const cp of [0x202e, 0x2066, 0x061c, 0x180e, 0x2061, 0xfff9, 0xe000, 0xfffd, 0x2764, 0x263a, 0x2600, 0x2705, 0x2b50, 0xd83d]) if (!checkText(`Hi ${String.fromCharCode(cp)} there`, v).error) bad.push(`a text with the character U+${cp.toString(16)} is accepted`);
    if (checkText(`Housecall Pro${String.fromCharCode(0xae)} ${String.fromCharCode(0x2122)} ${String.fromCharCode(0xa9)}`, v).error) bad.push('the registered, trade mark and copyright signs are refused');
    const shapeFile = path.join(os.tmpdir(), `assistant-texts-shape-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(shapeFile, JSON.stringify({ edited: [], added: { name: 'x', text: 'y' } }));
      const shaped = loadTexts(shapeFile);
      if (shaped.broken || shaped.dropped.length !== 2) bad.push('a texts file with the wrong shape is not noticed');
    } finally { try { fs.unlinkSync(shapeFile); } catch (_) { /* already gone */ } }
    if (fs.existsSync(DEFAULTS_FILE)) {      // in the copy that is handed out: every built-in text must be a good text, with none of the first author's words in it
      for (const d of loadDefaults()) {
        const c = checkText(d.text, v);
        if (c.error) bad.push(`built-in text ${d.id} is not a good text (${c.error})`);
        else if (/Luke|Franco|970-338-3120|833-337-0813|housecallprodemo|\[SET sender\.json/i.test(c.sent)) bad.push(`built-in text ${d.id} still holds the first author's words`);
      }
    }
    if (parseOnOff('on').value !== 'on' || parseOnOff('OFF').value !== 'off' || !parseOnOff('maybe').error) bad.push('on/off for Claude drafts is not read right');
    if (claudeDraftsOn({ claudeDrafts: 'on' }) !== true || claudeDraftsOn({ claudeDrafts: 'off' }) !== false || claudeDraftsOn({}) !== false) bad.push('claudeDraftsOn() is not right');
    if (bad.length) { console.error(`senderSetup self-check FAILED: ${bad.join('; ')}`); return 1; }
    console.log('senderSetup self-check OK');
    return 0;
  } catch (e) {
    console.error(`senderSetup self-check FAILED: ${e && e.message}`);
    return 1;
  }
}

module.exports = { FIELDS, SETUP_FIELDS, REQUIRED, SIGNATURE_TEMPLATE, FILE, LIST_HOST, GENERIC_LIST, parseFullName, parseFirstName, parseTitle, parsePhone, parseLink, parseOnOff, parseList, listUrl, listName, claudeDraftsOn, load, save, needsFirstRun, signatureLines, main, selfcheck,
  TEXTS_FILE, DEFAULTS_FILE, MAX_TEXT, MAX_ADDED, REENGAGE_PREFIX, RESERVED_NAMES, RESERVED_PREFIXES, oddChar, expandTokens, checkText, checkName, loadTexts, saveTexts, loadDefaults, applyTextEdits, textsView, textsMenu };

if (require.main === module) {
  main().then(
    (rc) => { process.stdout.write('', () => process.exit(rc)); },
    (e) => { process.stderr.write(`senderSetup: ${e && e.message}\n`); process.exit(process.argv.includes('--settings') ? 4 : 0); },
  );
}
