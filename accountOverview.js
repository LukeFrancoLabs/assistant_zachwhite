'use strict';

/**
 * accountOverview — read the "Customer Overview" grid off a Salesforce Account page, READ-ONLY.
 *
 * That card is laid out as rows of LABELS with the row of VALUES underneath, matched by position:
 *
 *   Customer Status (beta) | Industry | Company Goal | Website
 *   -                      | -        | -            | -
 *
 * so a label's value is not next to it in the DOM, it is the same-numbered cell of the row after. Reading "whatever follows the label"
 * returns the NEXT LABEL ("Industry", "Company Goal"), which is how Customer Status once came back as "Industry".
 *
 * readOverview(page) → { found, fields: { 'customer status (beta)': '-', industry: 'HVAC', … }, get(labelRegex) }
 * A cell that shows "-" / "–" / empty is returned as '' (blank in Salesforce).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readOnce(page) {
  return page.evaluate(() => {
    const fields = {};
    let rows = 0;
    const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    const cells = (row) => Array.from(row.children).map((c) => norm(c.innerText || c.textContent));
    (function walk(root) {
      root.querySelectorAll('div.slds-grid.slds-wrap').forEach((grid) => {
        const next = grid.nextElementSibling;
        if (!next || !/\bslds-grid\b/.test(next.className || '')) return;
        const labels = cells(grid), values = cells(next);
        if (labels.length < 2 || labels.length !== values.length) return;
        if (labels.some((l) => !l || l.length > 60)) return;
        rows++;
        labels.forEach((l, i) => { fields[l.toLowerCase()] = values[i].replace(/^[-–—]$/, ''); });
      });
      root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); });
    })(document);
    return { rows, fields };
  });
}

async function readOverview(page, { tries = 6 } = {}) {
  let res = { rows: 0, fields: {} };
  for (let i = 0; i < tries; i++) {
    try { res = await readOnce(page); } catch (_) { await sleep(1500); continue; }
    if (res.fields['customer status (beta)'] !== undefined) break;
    try { await page.evaluate(() => window.scrollBy(0, 600)); } catch (_) {}
    await sleep(1000);
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
  const get = (re) => { const k = Object.keys(res.fields).find((x) => re.test(x)); return k === undefined ? null : res.fields[k]; };
  return { found: res.rows > 0, fields: res.fields, get };
}

module.exports = { readOverview };

// node accountOverview.js [port]   → prints the overview fields of the Account page open in that browser (read-only)
if (require.main === module) {
  const path = require('path');
  const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
  (async () => {
    const b = await chromium.connectOverCDP(`http://localhost:${process.argv[2] || 9324}`);
    const page = b.contexts()[0].pages().find((p) => (p.url() || '').includes('/lightning/r/Account/'));
    if (!page) throw new Error('no Account page open');
    const o = await readOverview(page);
    console.log(JSON.stringify(o.fields, null, 1));
    console.log('customer status:', JSON.stringify(o.get(/^customer status/)), ' industry:', JSON.stringify(o.get(/^industry$/)));
    await b.close();
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
