'use strict';

/**
 * teamSync — Luke pushes shared templates/kit; each rep (or Luke on their machine) pulls.
 *
 * Source (first that exists):
 *   1. ASSISTANT_TEAM_SHARED env (Dropbox / Google Drive / shared folder Luke updates)
 *   2. ./team-shared/ next to this script (checked into git, or a symlink to the shared folder)
 *
 * Usage:
 *   node teamSync.js --status          what would sync
 *   node teamSync.js --pull            copy managed files into this folder
 *   node teamSync.js --pull --dry-run  show only
 *   node teamSync.js --pack            refresh team-shared/ from this copy (Luke: publish)
 *
 * After --pull, Pipeline Assistant kit + email templates match Luke’s pack. Text bodies still
 * live in sender.json (per-rep); Pipeline Assistant kit points at template numbers, not bodies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOCAL_SHARED = path.join(ROOT, 'team-shared');
const SHARED = process.env.ASSISTANT_TEAM_SHARED || LOCAL_SHARED;

function readManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && Array.isArray(j.files)) return j.files.filter((n) => n && !String(n).startsWith('_'));
  } catch (_) {}
  return ['day-desk.json', 'email-templates.json', 'email-menu.json'];
}

function destFor(name) {
  // day-desk.json stays under team-shared/ so dayDesk.js finds it; email files live at repo root
  if (name === 'day-desk.json') return path.join(LOCAL_SHARED, name);
  return path.join(ROOT, name);
}

function sourceFor(name) {
  return path.join(SHARED, name);
}

function status() {
  const files = readManifest(SHARED);
  console.log(`\n  Team shared folder: ${SHARED}`);
  console.log(`  (set ASSISTANT_TEAM_SHARED to a Dropbox/Drive path Luke updates remotely)\n`);
  for (const name of files) {
    const src = sourceFor(name);
    const dst = destFor(name);
    const haveSrc = fs.existsSync(src);
    const haveDst = fs.existsSync(dst);
    let same = false;
    if (haveSrc && haveDst) {
      try { same = fs.readFileSync(src).equals(fs.readFileSync(dst)); } catch (_) {}
    }
    const mark = !haveSrc ? 'missing in shared' : !haveDst ? 'needs pull' : same ? 'in sync' : 'out of date';
    console.log(`  ${mark.padEnd(16)}  ${name}`);
  }
  console.log('');
}

function pull({ dryRun = false } = {}) {
  if (!fs.existsSync(SHARED)) {
    console.error(`\n  No shared folder at ${SHARED}\n  Create team-shared/ or set ASSISTANT_TEAM_SHARED.\n`);
    process.exit(1);
  }
  const files = readManifest(SHARED);
  let n = 0;
  for (const name of files) {
    const src = sourceFor(name);
    const dst = destFor(name);
    if (!fs.existsSync(src)) { console.log(`  skip (not in shared): ${name}`); continue; }
    if (dryRun) { console.log(`  would copy  ${name}  →  ${path.relative(ROOT, dst)}`); n++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`  pulled  ${name}`);
    n++;
  }
  console.log(dryRun ? `\n  ${n} file(s) would update.\n` : `\n  ${n} file(s) updated. Open Pipeline Assistant / Templates on localhost to see them.\n`);
}

/** Luke: copy this machine's managed files into team-shared/ so others can --pull (or so Dropbox gets the update). */
function pack({ dryRun = false } = {}) {
  fs.mkdirSync(LOCAL_SHARED, { recursive: true });
  // Always keep a manifest in the pack
  const manifestPath = path.join(LOCAL_SHARED, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      _comment: 'Managed by teamSync --pack',
      files: ['day-desk.json', 'email-templates.json', 'email-menu.json'],
    }, null, 2) + '\n');
  }
  const files = readManifest(LOCAL_SHARED);
  let n = 0;
  for (const name of files) {
    if (name === 'day-desk.json') {
      // already lives in team-shared; ensure default exists
      const desk = path.join(LOCAL_SHARED, 'day-desk.json');
      if (!fs.existsSync(desk)) {
        console.log('  (day-desk.json missing — leave defaults in dayDesk.js or add one)');
      } else {
        console.log(`  ok      ${name}`);
      }
      continue;
    }
    const src = path.join(ROOT, name);
    const dst = path.join(LOCAL_SHARED, name);
    if (!fs.existsSync(src)) { console.log(`  skip (not in this copy): ${name}`); continue; }
    if (dryRun) { console.log(`  would pack  ${name}`); n++; continue; }
    fs.copyFileSync(src, dst);
    console.log(`  packed  ${name}`);
    n++;
  }
  // If ASSISTANT_TEAM_SHARED points elsewhere, also copy the whole pack there
  if (SHARED !== LOCAL_SHARED && fs.existsSync(path.dirname(SHARED))) {
    fs.mkdirSync(SHARED, { recursive: true });
    for (const name of ['manifest.json', ...files]) {
      const from = path.join(LOCAL_SHARED, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(SHARED, name);
      if (!dryRun) fs.copyFileSync(from, to);
      console.log(`  ${dryRun ? 'would mirror' : 'mirrored'} → ${to}`);
    }
  }
  console.log(dryRun ? `\n  dry-run done.\n` : `\n  Pack ready in ${LOCAL_SHARED}\n  Reps run:  node teamSync.js --pull\n`);
}

function main(argv) {
  const args = argv.slice(2);
  const dry = args.includes('--dry-run');
  if (args.includes('--status') || !args.length) return status();
  if (args.includes('--pull')) return pull({ dryRun: dry });
  if (args.includes('--pack')) return pack({ dryRun: dry });
  console.log('Usage: node teamSync.js --status | --pull [--dry-run] | --pack [--dry-run]');
}

module.exports = { SHARED, LOCAL_SHARED, pull, pack, status, readManifest };

if (require.main === module) main(process.argv);
