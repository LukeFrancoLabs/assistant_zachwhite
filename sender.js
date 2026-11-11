'use strict';

/**
 * sender — WHO this copy texts and emails as.
 *
 * Pipeline Assistant's wording was written by Luke Franco: his name, his call number, his text number and his booking link are in the texts, the emails,
 * the email signature and the AI prompts. This copy is for someone else, so every piece of wording passes through apply() the moment it is loaded: Luke's strings are swapped
 * for the ones in sender.json, and nothing else in the wording changes.
 *
 * A field left empty comes out as a visible marker, e.g. [SET sender.json: callNumber], and typeMessage() / emailAccount() refuse to send a message that still has one
 * (assertSendable), so a half-filled sender.json can never put Luke's name, or a blank, in front of a pro. A message typed by hand with --message has no marker and goes as typed.
 *
 *   sender.json = {
 *     "fullName":    "…",   the name Salesforce shows on YOUR texts in a thread (it is how the tool tells your texts from a teammate's or a pro's)
 *     "firstName":   "…",   optional: the first word of fullName
 *     "title":       "…",   optional: the email signature's job title (default: Account Executive)
 *     "callNumber":  "…",   the number pros are told to call
 *     "textNumber":  "…",   the number pros are told to text
 *     "bookingLink": "…"    your booking link, with or without https://
 *   }
 *
 * The file is read once when a run starts: change it, then start the run again. ASSISTANT_SENDER_FILE points at a different file (tests only).
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.ASSISTANT_SENDER_FILE || path.join(__dirname, 'sender.json');

// What the wording this copy started from says for its first author. apply() swaps these and only these.
const ORIGIN_LINK = /(https?:\/\/)?tinyurl\.com\/housecallprodemo/gi;
const REQUIRED = ['fullName', 'callNumber', 'textNumber', 'bookingLink'];
const MARKER = /\[SET sender\.json: [A-Za-z]+\]/;
const marker = (field) => `[SET sender.json: ${field}]`;

const clean = (v) => String(v == null ? '' : v).trim();
function read() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}
const j = read();
const S = {
  fullName: clean(j.fullName),
  firstName: clean(j.firstName) || clean(j.fullName).split(/\s+/)[0] || '',
  title: clean(j.title),
  callNumber: clean(j.callNumber),
  textNumber: clean(j.textNumber),
  bookingLink: clean(j.bookingLink),
};

/** The fields of sender.json that are still empty and that the wording needs. */
function missing() {
  return REQUIRED.filter((f) => !S[f]);
}

/** Luke's strings in a piece of wording → this sender's (or a visible marker where sender.json has nothing yet). Anything that is not a string comes back as it was. */
function apply(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(/Luke Franco/g, S.fullName || marker('fullName'))
    .replace(/\bLuke\b/g, S.firstName || marker('fullName'))
    .replace(/970-338-3120/g, S.callNumber || marker('callNumber'))
    .replace(/833-337-0813/g, S.textNumber || marker('textNumber'))
    .replace(ORIGIN_LINK, (m, scheme) => {
      const link = S.bookingLink.replace(/^https?:\/\//i, '');
      return link ? (scheme ? 'https://' : '') + link : marker('bookingLink');
    })
    .replace(/\bAccount Executive\b/g, S.title || 'Account Executive');
}

const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A pattern for this sender's full name as a thread prints it (spaces flexible); matches nothing while fullName is empty. */
const selfRe = S.fullName ? new RegExp(S.fullName.split(/\s+/).map(esc).join('\\s+'), 'i') : /(?!)/;

/** Stops the whole run, before anything is typed, when a message still has a [SET sender.json: …] marker. Messages without one pass untouched. */
function assertSendable(...parts) {
  for (const p of parts) {
    const m = typeof p === 'string' ? p.match(MARKER) : null;
    if (m) {
      console.error(`\n⛔ Pipeline Assistant will not send this: the message still has ${m[0]}.\n   Fill in ${FILE}, then start the run again. Nothing was sent.\n`);
      process.exit(2);
    }
  }
}

module.exports = {
  FILE,
  apply,
  assertSendable,
  missing,
  esc,
  selfRe,
  get fullName() { return S.fullName; },
  get firstName() { return S.firstName; },
  get title() { return S.title || 'Account Executive'; },
  get callNumber() { return S.callNumber; },
  get textNumber() { return S.textNumber; },
  get bookingLink() { return S.bookingLink; },
};
