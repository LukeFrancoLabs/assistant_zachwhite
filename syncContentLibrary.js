'use strict';

/**
 * syncContentLibrary — pull the Sales Content Finder into content-library/
 * and walk every browse path (trade × need × competitor × size × region × stage).
 *
 * Source: https://hcp-brand-content.github.io/sales-content-finder/
 *
 * Writes:
 *   content-library/library.json   — full asset catalog
 *   content-library/index.json     — every path → best / also matches
 *   content-library/library.md     — human-readable catalog
 *   content-library/library.csv    — spreadsheet-friendly
 *   email-content.json             — slim snapshot for email attach
 *
 *   node syncContentLibrary.js
 *   node syncContentLibrary.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = 'https://hcp-brand-content.github.io/sales-content-finder/';
const OUT_DIR = path.join(__dirname, 'content-library');
const EMAIL_OUT = path.join(__dirname, 'email-content.json');
const EMAIL_KEEP = ['id', 'title', 'url', 'type', 'trade', 'segment', 'competitor', 'priority', 'status', 'linkPending', 'proofPending', 'subject', 'email', 'source', 'need', 'region'];

function extractBlock(html, startMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error('missing ' + startMarker);
  // Find matching ]; for array or }; for object — DATA / NEEDS / TRADES are arrays
  const open = html.indexOf('[', a);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(open, i);
}

function extractData(html) {
  return vm.runInNewContext('(' + extractBlock(html, 'const DATA = [') + ')', Object.create(null), { timeout: 5000 });
}

function extractMatchEngine(html) {
  // Pull NEEDS through match() so we can evaluate paths with the finder's own scorer.
  const start = html.indexOf('const NEEDS = [');
  const end = html.indexOf('\nfunction match(inp){');
  if (start < 0 || end < 0) throw new Error('could not locate matching engine in finder HTML');
  // Include match function body through the closing brace before the next section
  let i = html.indexOf('\nfunction match(inp){', start);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  const code = html.slice(start, j);
  const sandbox = { DATA: null, console };
  vm.createContext(sandbox);
  // DATA injected later; define engine now with placeholder
  vm.runInContext('var DATA = [];\n' + code + '\nthis.__engine = { NEEDS, TRADES, COMPETITORS, SEGMENTS, REGIONS, MECH_TRADES, START_HERE, match, scoreAsset };', sandbox, { timeout: 5000 });
  return sandbox.__engine;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
}

function toCsv(assets) {
  const cols = ['id', 'title', 'type', 'trade', 'need', 'competitor', 'segment', 'region', 'priority', 'status', 'url', 'subject', 'triggers'];
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join('|') : String(v == null ? '' : v);
    return /["\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const a of assets) lines.push(cols.map((c) => esc(a[c])).join(','));
  return lines.join('\n') + '\n';
}

function toMarkdown(assets, meta) {
  const byNeed = new Map();
  for (const a of assets) {
    const needs = Array.isArray(a.need) ? a.need : [a.need || 'other'];
    for (const n of needs) {
      if (!byNeed.has(n)) byNeed.set(n, []);
      byNeed.get(n).push(a);
    }
  }
  let md = `# Sales Content Library\n\n`;
  md += `Source: ${SOURCE} (pulled ${meta.syncedAt}). ${assets.length} assets.\n\n`;
  md += `Browse paths walked: ${meta.pathCount} (trade × need × competitor × size × region × stage).\n\n`;
  for (const [need, list] of [...byNeed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const uniq = [...new Map(list.map((x) => [x.id, x])).values()];
    md += `## ${need} — ${uniq.length}\n\n`;
    for (const a of uniq) {
      md += `### ${a.title}\n`;
      md += `- id: ${a.id} | type: ${a.type} | trade: ${a.trade}`;
      if (a.segment) md += ` | size: ${a.segment}`;
      if (a.competitor) md += ` | competitor: ${a.competitor}`;
      if (a.region) md += ` | region: ${a.region}`;
      md += `\n`;
      if (a.url) md += `- url: ${a.url}\n`;
      if (a.why) md += `- why: ${a.why}\n`;
      if (a.useWhen) md += `- useWhen: ${a.useWhen}\n`;
      if (a.subject) md += `- email subject: ${a.subject}\n`;
      if (a.sms) md += `- sms: ${a.sms}\n`;
      md += `\n`;
    }
  }
  return md;
}

function slimResult(r) {
  if (!r) return null;
  return {
    id: r.a.id,
    title: r.a.title,
    type: r.a.type,
    trade: r.a.trade,
    score: r.score,
    reasons: r.reasons || [],
    url: r.a.url,
    subject: r.a.subject || null,
  };
}

function walkPaths(engine, DATA) {
  const { NEEDS, TRADES, COMPETITORS, SEGMENTS, REGIONS, match } = engine;
  // Re-bind DATA inside engine by replacing match's closed DATA — we run match via sandbox
  // Instead: call score through a fresh context each batch. Simpler: monkey-patch by evaluating match with DATA in scope.
  const sandbox = { DATA, NEEDS, TRADES, COMPETITORS, SEGMENTS, REGIONS, MECH_TRADES: engine.MECH_TRADES, START_HERE: engine.START_HERE, match: engine.match, scoreAsset: engine.scoreAsset };
  // engine.match closes over DATA from original sandbox — need to re-run code with our DATA
  // Fix: re-extract and run with injected DATA
  return null; // replaced below
}

async function sync({ dryRun = false } = {}) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`content finder returned HTTP ${res.status}`);
  const html = await res.text();
  const DATA = extractData(html);

  // Rebuild matching engine bound to this DATA
  const start = html.indexOf('const NEEDS = [');
  let i = html.indexOf('\nfunction match(inp){', start);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  const engineCode = html.slice(start, j);
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext('var DATA = ' + JSON.stringify(DATA) + ';\n' + engineCode + '\nthis.E = { NEEDS, TRADES, COMPETITORS, SEGMENTS, REGIONS, MECH_TRADES, START_HERE, match };', sandbox, { timeout: 8000 });
  const { NEEDS, TRADES, COMPETITORS, SEGMENTS, REGIONS, match } = sandbox.E;

  const stages = ['demo', 'postdemo'];
  const paths = [];
  const pathResults = [];

  for (const trade of TRADES) {
    for (const need of [{ id: '', label: '(any need)' }, ...NEEDS]) {
      // Base path (no competitor / size / region)
      paths.push({ trade: trade.id, need: need.id || null, competitor: null, segment: null, region: null, stage: 'demo' });
      // Competitor paths for competitive need
      if (need.id === 'competitive') {
        for (const c of COMPETITORS) {
          paths.push({ trade: trade.id, need: need.id, competitor: c, segment: null, region: null, stage: 'demo' });
        }
      }
    }
  }
  // Size + region matrix for mechanical trades (high-value paths)
  for (const tradeId of ['HVAC', 'Plumbing', 'Electrical']) {
    for (const needId of ['competitive', 'proof', 'product', 'growth', 'ai', '']) {
      for (const seg of SEGMENTS) {
        paths.push({ trade: tradeId, need: needId || null, competitor: null, segment: seg.id, region: null, stage: 'demo' });
      }
      for (const reg of REGIONS) {
        paths.push({ trade: tradeId, need: needId || null, competitor: null, segment: null, region: reg.id, stage: 'demo' });
      }
    }
  }
  // Post-demo stage variants for HVAC/Plumbing/Electrical proof + competitive
  for (const tradeId of ['HVAC', 'Plumbing', 'Electrical', 'any']) {
    for (const needId of ['proof', 'competitive', 'product']) {
      for (const stage of stages) {
        paths.push({ trade: tradeId, need: needId, competitor: null, segment: null, region: null, stage });
      }
    }
  }

  // Deduplicate paths
  const seen = new Set();
  const uniquePaths = [];
  for (const p of paths) {
    const key = [p.trade, p.need || '', p.competitor || '', p.segment || '', p.region || '', p.stage || 'demo'].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    uniquePaths.push(p);
  }

  for (const p of uniquePaths) {
    const inp = {
      trade: p.trade,
      need: p.need || '',
      competitor: p.competitor || '',
      segment: p.segment || '',
      region: p.region || '',
      issue: '',
      persona: '',
    };
    const result = match(inp);
    pathResults.push({
      path: p,
      startHere: !!result.startHere,
      best: slimResult(result.best),
      tradePick: slimResult(result.tradePick),
      also: (result.also || []).map(slimResult),
    });
  }

  const syncedAt = new Date().toISOString();
  const meta = { syncedAt, source: SOURCE, assetCount: DATA.length, pathCount: uniquePaths.length };

  const index = {
    ...meta,
    trades: TRADES,
    needs: NEEDS,
    competitors: COMPETITORS,
    segments: SEGMENTS,
    regions: REGIONS,
    paths: pathResults,
  };

  const emailSnap = {
    syncedAt,
    source: SOURCE,
    assets: DATA.map((d) => Object.fromEntries(EMAIL_KEEP.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]))),
  };

  const md = toMarkdown(DATA, meta);
  const csv = toCsv(DATA);

  if (dryRun) {
    console.log(`dry-run: ${DATA.length} assets, ${uniquePaths.length} paths (not written)`);
    return { assets: DATA, paths: pathResults, meta };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeJson(path.join(OUT_DIR, 'library.json'), DATA);
  writeJson(path.join(OUT_DIR, 'index.json'), index);
  fs.writeFileSync(path.join(OUT_DIR, 'library.md'), md);
  fs.writeFileSync(path.join(OUT_DIR, 'library.csv'), csv);
  writeJson(EMAIL_OUT, emailSnap);

  return { assets: DATA, paths: pathResults, meta };
}

module.exports = { sync, extractData, SOURCE };

if (require.main === module) {
  const dry = process.argv.includes('--dry-run');
  sync({ dryRun: dry }).then(({ assets, paths, meta }) => {
    console.log(`\n  Sales Content Library ← ${SOURCE}`);
    console.log(`  ${assets.length} assets · ${paths.length} paths · ${meta.syncedAt}`);
    const byTrade = {};
    assets.forEach((a) => { byTrade[a.trade] = (byTrade[a.trade] || 0) + 1; });
    Object.entries(byTrade).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`    ${String(n).padStart(3)}  ${t}`));
    const withBest = paths.filter((p) => p.best).length;
    console.log(`  Paths with a best match: ${withBest}/${paths.length}`);
    if (!dry) console.log(`  Wrote content-library/library.json, index.json, library.md, library.csv + email-content.json\n`);
  }).catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
}
