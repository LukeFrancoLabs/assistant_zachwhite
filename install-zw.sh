#!/bin/bash
# Install the `zw` command: an alias to this folder's run.sh.
# Run once from this folder (or from anywhere: bash /path/to/assistant_zachwhite/install-zw.sh).
# Coworkers and you both end up typing just:  zw

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$SCRIPT_DIR/run.sh"
ALIAS_LINE="alias zw='$RUN'"

chmod +x "$RUN" "$SCRIPT_DIR/install-zw.sh"

# Prefer zsh on macOS; fall back to bash profile when that is the login shell.
SHELL_NAME="$(basename "${SHELL:-zsh}")"
if [ "$SHELL_NAME" = bash ]; then
  RC="${HOME}/.bash_profile"
  [ -f "$RC" ] || RC="${HOME}/.bashrc"
else
  RC="${HOME}/.zshrc"
fi
touch "$RC"

# Replace an old zw alias, or append a new one. Leave every other line alone.
if grep -qE '^[[:space:]]*alias[[:space:]]+zw=' "$RC" 2>/dev/null; then
  # portable in-place edit without depending on GNU vs BSD sed -i
  TMP="$(mktemp)"
  awk -v line="$ALIAS_LINE" '
    /^[[:space:]]*alias[[:space:]]+zw=/ { print line; next }
    { print }
  ' "$RC" > "$TMP" && mv "$TMP" "$RC"
  echo "Updated existing zw alias in $RC"
else
  printf '\n# assistant_zachwhite launcher\n%s\n' "$ALIAS_LINE" >> "$RC"
  echo "Added zw alias to $RC"
fi

# Make it available in this Terminal session too (when sourced or run under the same shell).
# shellcheck disable=SC2139
alias zw="$RUN" 2>/dev/null || true

echo
echo "Done. In a new Terminal window (or run:  source $RC ) type:"
echo "  zw          # live run"
echo "  zw --test   # practice run, nothing sent"
echo
echo "Check:  type zw"
type zw 2>/dev/null || echo "(open a new Terminal, or: source $RC)"
