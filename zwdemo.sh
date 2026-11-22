#!/bin/bash
# zwdemo — Pipeline Assistant director demo (mock Morning / Today / leads).
# Install alias via ./install-zw.sh, then type: zwdemo
# Safe: does not send, does not write real outreach logs. Port 9341 by default.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export ZW_DEMO=1
export ASSISTANT_DEMO_PORT="${ASSISTANT_DEMO_PORT:-9341}"

exec node "$SCRIPT_DIR/outreachDashboard.js" --demo "$@"
