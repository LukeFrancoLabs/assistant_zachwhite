'use strict';

/**
 * sfId — repair Salesforce 18-character record IDs that lost their letter case.
 *
 * An 18-char Salesforce ID = 15 case-SENSITIVE chars + a 3-char checksum that encodes which of
 * those 15 chars are uppercase. Some of our logged IDs were lowercased (seeded from the contact
 * ledger, which lowercases keys), and Salesforce rejects those URLs as "malformed". The checksum
 * survives lowercasing (it's just uppercased back), so the original case is fully recoverable.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const isUpper = (c) => c >= 'A' && c <= 'Z';

/** The 3-char checksum for a 15-char (case-correct) ID. */
function suffixFor(id15) {
  let out = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) if (isUpper(id15[chunk * 5 + i])) bits += 1 << i;
    out += ALPHABET[bits];
  }
  return out;
}

/** True if an 18-char ID is internally consistent (case matches its checksum). */
function isValid18(id) {
  return typeof id === 'string' && id.length === 18 && suffixFor(id.slice(0, 15)) === id.slice(15).toUpperCase() && id.slice(15) === id.slice(15).toUpperCase();
}

/**
 * Return `id` with its case restored when it was lowercased. Valid IDs, 15-char IDs and anything
 * unrecognised come back unchanged.
 */
function fix(id) {
  if (typeof id !== 'string' || id.length !== 18 || isValid18(id)) return id;
  const sfx = id.slice(15).toUpperCase();
  if (![...sfx].every((c) => ALPHABET.includes(c))) return id;
  const base = id.slice(0, 15).toLowerCase();
  let out = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    const bits = ALPHABET.indexOf(sfx[chunk]);
    for (let i = 0; i < 5; i++) {
      const c = base[chunk * 5 + i];
      out += (bits >> i) & 1 ? c.toUpperCase() : c;
    }
  }
  return out + sfx;
}

/** Fix the record ID inside an Account/Opportunity URL. */
function fixUrl(url) {
  return typeof url === 'string' ? url.replace(/(\/lightning\/r\/(?:[A-Za-z]+\/)?)([A-Za-z0-9]{18})(?=[/?]|$)/, (_, pre, id) => pre + fix(id)) : url;
}

module.exports = { fix, fixUrl, isValid18, suffixFor };
