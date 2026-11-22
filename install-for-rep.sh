#!/usr/bin/env bash
# install-for-rep.sh — Luke (or the rep) stands up a Pipeline Assistant copy for one person.
#
# Usage:
#   ./install-for-rep.sh "Zach White"
#   ./install-for-rep.sh "Zach White" ~/assistant_zach
#   ASSISTANT_TEAM_SHARED=/path/to/Dropbox/assistant-team ./install-for-rep.sh "Zach White"
#
# What it does:
#   1. Copies this folder to a new directory (or uses the one you pass)
#   2. Strips machine-local secrets (sender.json, cookies, run state) so they start clean
#   3. npm install + Playwright Chromium
#   4. Pulls Luke’s shared templates/kit (teamSync --pull)
#   5. Runs install-zw.sh so `zw` opens the welcome menu on that machine
#   6. Prints the first-run checklist for the rep
#
# Safe to re-run on an existing copy: it will not overwrite sender.json if present.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo ""
  echo "  Usage:  ./install-for-rep.sh \"First Last\" [target-folder]"
  echo ""
  exit 1
fi

slug="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_|_$//g')"
TARGET="${2:-$HOME/assistant_${slug}}"

echo ""
echo "  Installing Pipeline Assistant for:  $NAME"
echo "  Target folder:            $TARGET"
echo ""

copy_tree() {
  # Prefer rsync; fall back to tar so install works on a bare Mac too.
  local src="$1" dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude 'node_modules' \
      --exclude 'sender.json' \
      --exclude 'outreach-dashboard' \
      --exclude 'chrome-profile*' \
      --exclude 'email-debug' \
      --exclude '*.jsonl' \
      --exclude '.git' \
      "$src/" "$dst/"
  else
    tar -C "$src" \
      --exclude 'node_modules' \
      --exclude 'sender.json' \
      --exclude 'outreach-dashboard' \
      --exclude 'chrome-profile*' \
      --exclude 'email-debug' \
      --exclude '*.jsonl' \
      --exclude '.git' \
      -cf - . | tar -C "$dst" -xf -
  fi
}

if [[ "$TARGET" == "$ROOT" ]]; then
  echo "  Target is this same folder — skipping copy."
else
  if [[ -d "$TARGET" ]]; then
    echo "  Folder already exists — updating files (keeping sender.json / logs)."
  else
    echo "  Creating folder…"
  fi
  copy_tree "$ROOT" "$TARGET"
fi

cd "$TARGET"

echo "  → npm install"
npm install --no-fund --no-audit

echo "  → Playwright Chromium"
npx playwright install chromium >/dev/null

if [[ -n "${ASSISTANT_TEAM_SHARED:-}" ]]; then
  echo "  → team sync from \$ASSISTANT_TEAM_SHARED"
  node teamSync.js --pull || true
else
  echo "  → team sync from local team-shared/"
  node teamSync.js --pull || true
fi

if [[ ! -f sender.json ]]; then
  echo "  → starter sender.json (rep fills booking link + phone in Settings)"
  cat > sender.json <<EOF
{
  "fullName": "$NAME",
  "firstName": "$(printf '%s' "$NAME" | awk '{print $1}')",
  "email": "",
  "phone": "",
  "bookingLink": "",
  "title": "Account Executive",
  "timezone": "America/New_York"
}
EOF
fi

if [[ -x ./install-zw.sh ]]; then
  echo "  → install-zw.sh (shell alias)"
  ./install-zw.sh || true
else
  echo "  (no install-zw.sh — rep can run: node Assistant.js)"
fi

echo ""
echo "  ────────────────────────────────────────────────────────"
echo "  Done. Hand this to $NAME:"
echo ""
echo "    1. Open a new terminal and type:  zw"
echo "    2. First time: Settings → fill booking link + phone"
echo "    3. Browser opens localhost Pipeline Assistant (Morning / Replies / Kit)"
echo "    4. Optional — replies in Pipeline Assistant: node replyPoller.js --setup"
echo "    5. Optional — Luke updates templates: node teamSync.js --pull"
echo ""
echo "  Folder:  $TARGET"
echo "  ────────────────────────────────────────────────────────"
echo ""
