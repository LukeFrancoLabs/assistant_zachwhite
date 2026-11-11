'use strict';

/**
 * syncEmailContent — snapshot the Sales Content Finder library into email-content.json so emails can attach the right
 * one-pager / case study for the account's trade. Re-run whenever marketing updates the finder (read-only: one GET).
 *
 *   node syncEmailContent.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = 'https://hcp-brand-content.github.io/sales-content-finder/';
const KEEP = ['id', 'title', 'url', 'type', 'trade', 'segment', 'competitor', 'priority', 'status', 'linkPending', 'proofPending', 'subject', 'email', 'source'];

/** Pull the `const DATA = [...]` literal out of the finder's HTML and evaluate it in an empty sandbox. */
function extractData(html) {
  const a = html.indexOf('const DATA = [');
  if (a < 0) throw new Error('could not find the DATA list in the content finder page (did its layout change?)');
  const b = html.indexOf('\n];', a);
  if (b < 0) throw new Error('could not find the end of the DATA list');
  return vm.runInNewContext('(' + html.slice(a + 'const DATA = '.length, b + 2) + ')', Object.create(null), { timeout: 2000 });
}

async function sync(out = path.join(__dirname, 'email-content.json')) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`content finder returned HTTP ${res.status}`);
  const data = extractData(await res.text());
  const rows = data.map((d) => Object.fromEntries(KEEP.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])));
  fs.writeFileSync(out, JSON.stringify({ syncedAt: new Date().toISOString(), source: SOURCE, assets: rows }, null, 1) + '\n');
  return rows;
}

module.exports = { sync, extractData };

if (require.main === module) {
  sync().then((rows) => {
    const by = {};
    rows.forEach((r) => { const k = `${r.trade} / ${r.type}`; by[k] = (by[k] || 0) + 1; });
    console.log(`synced ${rows.length} assets → email-content.json`);
    Object.entries(by).sort().forEach(([k, n]) => console.log(`  ${n}  ${k}`));
  }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
