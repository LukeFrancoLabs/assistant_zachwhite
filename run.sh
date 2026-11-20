#!/bin/bash
# Pipeline Assistant launcher for assistant_zachwhite — install with ./install-zw.sh, then type: zw
# TEXT mode uses CDP 9323 / .browser-profile.
# EMAIL mode (--email) uses CDP 9324 / .browser-profile-email so it can run at the
# SAME TIME as a texting session on this machine (each gets its own Chrome + SF login).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Flags this version of Assistant does not have (--same-day / --today, --nocheck / --no-review / --no-check): Assistant.js refuses them before anything starts, so no Chrome is started (or closed) for them first.
for a in "$@"; do case "$a" in --same-day|--today|--nocheck|--no-review|--no-check) exec node Assistant.js "$@" ;; esac; done

# No flags = the EMAIL campaign (Pipeline Assistant opens on its welcome screen). Every flag works exactly as before: `zw --text` is the text campaign, `zw --board` the board, and so on.
# --test (a practice run on your own list, always a dry run) and --dry-run do not name a campaign either, so `zw --test` and `zw --dry-run` are the email campaign too. So is `zw --no-auto` (it only says: pick a template instead of writing each email from the account's notes).
# Done HERE, before the port is picked below, so the email browser (9324) is the one started.
ONLY_MODIFIERS=1
for a in "$@"; do case "$a" in --test|--dry-run|--dryrun|--no-auto) ;; *) ONLY_MODIFIERS=0 ;; esac; done
if [ $ONLY_MODIFIERS = 1 ]; then set -- --email "$@"; fi
# FIRST LAUNCH and SETTINGS (senderSetup.js): the very first time it asks for your first name and your email signature, makes you check every letter and saves them in sender.json (once: nothing
# is asked again). After that every launch starts with a small box: Enter starts, S opens Settings. zw --settings opens Settings and stops. It only talks on a terminal, and never for
# --help, --yes, --inspect or --sent. Cancelled with Ctrl-C (130) or not saved (4) = nothing is started. If the screen itself crashes, one warning line is printed and the run carries on:
# nothing is sent while the name or numbers are missing (sender.js).
if [ -f "$SCRIPT_DIR/senderSetup.js" ]; then
  node "$SCRIPT_DIR/senderSetup.js" "$@"
  SETUP_RC=$?
  case $SETUP_RC in
    0) ;;
    3) exit 0 ;;
    4|130) exit $SETUP_RC ;;
    *) echo "⚠️  The setup screen could not run (the run carries on; nothing is sent while your name or numbers are missing)." ;;
  esac
fi
# (end of the first-launch setup)

# HCP manta + 3-2-1 while Chrome finishes loading. No other loading animation.
hcp_manta_countdown() {
  local CYAN='\033[1;36m' BOLD='\033[1m' RESET='\033[0m'
  if [ -t 1 ]; then
    printf '\n%b' "$CYAN"
    cat <<'MANTA'
              __
     .-------()----.
   .'               '.
  /   .-.       .-.   \\
 |   /   \\ HCP /   \\   |
  \\  \\___/     \\___/  /
   '.     manta     .'
     '-------------'
MANTA
    printf '%b\n' "$RESET"
  fi
  printf '%b3...%b\n' "$BOLD" "$RESET"
  sleep 1
  printf '%b2...%b\n' "$BOLD" "$RESET"
  sleep 1
  printf '%b1...%b\n' "$BOLD" "$RESET"
  sleep 1
}

# Pick port + profile based on whether this is an email run.
CDP_PORT=9323
PROFILE_DIR=".browser-profile"
for arg in "$@"; do
  if [ "$arg" = "--industry" ]; then
    # Reading every account's Industry off its Salesforce page takes hours, so it has its OWN browser and never collides with a text, email, re-engage or Shark run.
    CDP_PORT=9327
    PROFILE_DIR=".browser-profile-industry"
    break
  elif [ "$arg" = "--zones" ] || [ "$arg" = "--zone" ]; then
    # Reading account time zones has its OWN browser so it can run next to a followup/harvest/shark run.
    CDP_PORT=9328
    PROFILE_DIR=".browser-profile-zones"
    break
  elif [ "$arg" = "--shark" ] || [ "$arg" = "--snapshot" ] || [ "$arg" = "--shark13" ]; then
    # The morning Shark-list backup has its OWN browser so it never collides with a running harvest/auto/re-engage (9325).
    CDP_PORT=9326
    PROFILE_DIR=".browser-profile-shark"
    break
  elif [ "$arg" = "--holds" ]; then
    # Thread-hold replies have their OWN browser so starting one never kills a running --followup / --queue / --reengage (9325).
    CDP_PORT=9329
    PROFILE_DIR=".browser-profile-holds"
    break
  elif [ "$arg" = "--reengage" ] || [ "$arg" = "--re-engage" ] || [ "$arg" = "--review" ] || [ "$arg" = "--auto" ] || [ "$arg" = "--lists" ] || [ "$arg" = "--harvest" ] || [ "$arg" = "--zones" ] || [ "$arg" = "--zone" ] || [ "$arg" = "--thread-probe" ] || [ "$arg" = "--review-report" ] || [ "$arg" = "--lds" ] || [ "$arg" = "--inbound-lds" ] || [ "$arg" = "--inbound-ka-lds" ] || [ "$arg" = "--followup" ] || [ "$arg" = "--follow-up" ]; then
    # Re-engage (text + email) has its OWN browser so it never collides with the others.
    CDP_PORT=9325
    PROFILE_DIR=".browser-profile-reengage"
    break
  elif [ "$arg" = "--evening" ]; then
    # The evening run (texts tomorrow's Shark list tonight, with nobody at the Mac) has its OWN browser: no other mode maps to 9330, so nothing can kill it while it waits for 7 PM.
    CDP_PORT=9330
    PROFILE_DIR=".browser-profile-evening"
    break
  elif [ -f "$SCRIPT_DIR/report-modes.json" ] && [ "${arg#--}" != "$arg" ] && grep -q "\"${arg#--}\"[[:space:]]*:" "$SCRIPT_DIR/report-modes.json"; then
    CDP_PORT=9325
    PROFILE_DIR=".browser-profile-reengage"
    break
  elif [ "$arg" = "--email" ] || [ "$arg" = "--emails" ]; then
    CDP_PORT=9324
    PROFILE_DIR=".browser-profile-email"
  fi
done
# --same-day (a SECOND text today to the Shark pros already texted today; also --today) has its OWN browser, whatever order the flags come in: --followup --same-day must
# not land on 9325, where a running --followup lives, and starting this one must never close that Chrome.
for arg in "$@"; do
  if [ "$arg" = "--same-day" ] || [ "$arg" = "--today" ]; then
    CDP_PORT=9331
    PROFILE_DIR=".browser-profile-same-day"
    break
  fi
done
# --teammate-texted (text the pros on the dashboard's Teammate texted tab; also --teammate-list) has its OWN browser, whatever order the flags come in: it implies --followup (9325), and
# starting this one must never close a running --followup or --same-day (9331).
for arg in "$@"; do
  if [ "$arg" = "--teammate-texted" ] || [ "$arg" = "--teammate-list" ]; then
    CDP_PORT=9332
    PROFILE_DIR=".browser-profile-teammate"
    break
  fi
done
# --board (the follow-up board's automatic run) has its OWN browser, whatever order the flags come in: starting it must never close a running --followup (9325), --same-day (9331)
# or the overnight run (9333), and no other mode may close it while it works through the day.
for arg in "$@"; do
  if [ "$arg" = "--board" ]; then
    CDP_PORT=9336
    PROFILE_DIR=".browser-profile-board"
    break
  fi
done
# --tomorrow (the OVERNIGHT run: each pro is texted at their own NEXT 8:00 AM; --shark13 --send implies it) has its OWN browser, whatever order the flags come in: a morning
# --shark (9326), --queue (9323) or --evening (9330) must never kill the Chrome it waits in.
TOMORROW=0; HAS13=0; HAS_SEND=0; HAS_QUEUE=0
for arg in "$@"; do
  [ "$arg" = "--tomorrow" ] && TOMORROW=1
  [ "$arg" = "--shark13" ] && HAS13=1
  [ "$arg" = "--send" ] && HAS_SEND=1
  [ "$arg" = "--queue" ] && HAS_QUEUE=1
done
if [ $HAS13 = 1 ] && [ $HAS_SEND = 1 ]; then TOMORROW=1; fi
if [ $TOMORROW = 1 ]; then
  CDP_PORT=9333
  PROFILE_DIR=".browser-profile-tomorrow"
fi
export CDP_PORT PROFILE_DIR

# --holds --inspect / --dry-run only read saved files: no browser, so nothing running is touched.
HOLDS=0; PREVIEW=0
for arg in "$@"; do
  [ "$arg" = "--holds" ] && HOLDS=1
  { [ "$arg" = "--inspect" ] || [ "$arg" = "--dry-run" ]; } && PREVIEW=1
done
if [ $HOLDS = 1 ] && [ $PREVIEW = 1 ]; then
  exec node Assistant.js "$@"
fi

# --evening --inspect only reads saved files: no browser, so a run that is waiting for 7 PM is never touched.
EVENING=0; EV_INSPECT=0
for arg in "$@"; do
  [ "$arg" = "--evening" ] && EVENING=1
  [ "$arg" = "--inspect" ] && EV_INSPECT=1
done
if [ $EVENING = 1 ] && [ $EV_INSPECT = 1 ]; then
  exec node Assistant.js "$@"
fi

# --board --inspect / --dry-run only read saved files: no browser, so a board run that is going is never touched. A second live --board is refused HERE, before the kill below
# (board.lock holds the pid of the running one): starting it would close the first one's Chrome in the middle of a text.
BOARD=0; BD_PREVIEW=0
for arg in "$@"; do
  [ "$arg" = "--board" ] && BOARD=1
  { [ "$arg" = "--inspect" ] || [ "$arg" = "--dry-run" ]; } && BD_PREVIEW=1
done
if [ $BOARD = 1 ] && [ $BD_PREVIEW = 1 ]; then
  exec node Assistant.js "$@"
fi
if [ $BOARD = 1 ] && [ -f "$SCRIPT_DIR/board.lock" ]; then
  LOCK_PID=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$SCRIPT_DIR/board.lock" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null && ps -p "$LOCK_PID" -o command= 2>/dev/null | grep -q 'Assistant\.js'; then
    echo "⛔ A board run is already going (pid $LOCK_PID; its Chrome is on port $CDP_PORT). Starting a second one would close that Chrome in the middle of a text, so nothing was started. Stop the first one with Ctrl-C in its Terminal tab."
    exit 1
  fi
fi

# --same-day --inspect only reads saved files: no browser, so a --same-day run that is going is never touched. A second live --same-day is refused HERE, before the kill
# below: starting it would close the first one's Chrome in the middle of a text.
# --same-day has NO default text (Luke, 2026-11-02): without --message / --template Assistant.js refuses it before anything starts, so there is no reason to start (or kill) a Chrome for it either.
SAME_DAY=0; SD_INSPECT=0; SD_TEXT=0
for arg in "$@"; do
  { [ "$arg" = "--same-day" ] || [ "$arg" = "--today" ]; } && SAME_DAY=1
  [ "$arg" = "--inspect" ] && SD_INSPECT=1
  { [ "$arg" = "--message" ] || [ "$arg" = "-m" ] || [ "$arg" = "--template" ] || [ "$arg" = "-t" ]; } && SD_TEXT=1
done
if [ $SAME_DAY = 1 ] && { [ $SD_INSPECT = 1 ] || [ $SD_TEXT = 0 ]; }; then
  exec node Assistant.js "$@"
fi
if [ $SAME_DAY = 1 ] && pgrep -f '^node Assistant\.js .*--(same-day|today)( |$)' >/dev/null 2>&1; then
  echo "⛔ A --same-day run is already going (its Chrome is on port $CDP_PORT). Starting a second one would close that Chrome in the middle of a text, so nothing was started."
  exit 1
fi

# --teammate-texted --inspect only reads saved files: no browser, so a run that is going is never touched. A second live --teammate-texted is refused HERE, before the kill
# below: starting it would close the first one's Chrome in the middle of a text.
TEAMMATE=0; TM_INSPECT=0
for arg in "$@"; do
  { [ "$arg" = "--teammate-texted" ] || [ "$arg" = "--teammate-list" ]; } && TEAMMATE=1
  [ "$arg" = "--inspect" ] && TM_INSPECT=1
done
if [ $TEAMMATE = 1 ] && [ $TM_INSPECT = 1 ]; then
  exec node Assistant.js "$@"
fi
if [ $TEAMMATE = 1 ] && pgrep -f '^node Assistant\.js .*--(teammate-texted|teammate-list)( |$)' >/dev/null 2>&1; then
  echo "⛔ A --teammate-texted run is already going (its Chrome is on port $CDP_PORT). Starting a second one would close that Chrome in the middle of a text, so nothing was started."
  exit 1
fi

# Plain --followup is RETIRED (Luke, 2026-11-02: the follow-up board replaces it): Assistant.js prints a pointer to --board and starts nothing, so there is no reason to start (or kill) a Chrome for it,
# and the kill below could end a --reengage / --auto / --lds run that lives on 9325. --same-day and --teammate-texted are NOT retired (handled above), nor is --followup --teammate (it goes on to 9325 as before).
# followupRetired.js is the one switch: `node followupRetired.js` exits 0 while plain --followup is retired and 1 once it is back, and then the run goes on as it always did.
FOLLOWUP=0; FU_OTHER=0
for arg in "$@"; do
  { [ "$arg" = "--followup" ] || [ "$arg" = "--follow-up" ]; } && FOLLOWUP=1
  { [ "$arg" = "--same-day" ] || [ "$arg" = "--today" ] || [ "$arg" = "--teammate-texted" ] || [ "$arg" = "--teammate-list" ] || [ "$arg" = "--teammate" ]; } && FU_OTHER=1
done
if [ $FOLLOWUP = 1 ] && [ $FU_OTHER = 0 ] && node followupRetired.js >/dev/null 2>&1; then
  exec node Assistant.js "$@"
fi

# --queue --tomorrow --inspect only reads saved files: no browser, so a run that is waiting for 8:00 AM is never touched. A second live overnight run is refused HERE, before the
# kill below (tomorrow.lock holds the pid of the running one): starting it would close the first one's Chrome and the run waiting in it.
OV_INSPECT=0
for arg in "$@"; do [ "$arg" = "--inspect" ] && OV_INSPECT=1; done
if [ $TOMORROW = 1 ] && [ $OV_INSPECT = 1 ] && [ $HAS_QUEUE = 1 ]; then
  exec node Assistant.js "$@"
fi
if [ $TOMORROW = 1 ] && [ -f "$SCRIPT_DIR/tomorrow.lock" ]; then
  LOCK_PID=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$SCRIPT_DIR/tomorrow.lock" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null && ps -p "$LOCK_PID" -o command= 2>/dev/null | grep -q 'Assistant\.js'; then
    echo "⛔ An overnight run is already going (pid $LOCK_PID; its Chrome is on port $CDP_PORT). Starting a second one would close that Chrome and the run waiting in it, so nothing was started. Stop the first one with Ctrl-C in its Terminal tab."
    exit 1
  fi
fi

# The OUTREACH DASHBOARD (outreachDashboard.js): a local HTML page, outreach-dashboard/index.html, that lists everyone this run texts or emails and updates itself a few seconds after
# each send. It opens here, once per launch and BEFORE the browser below starts, so the Salesforce sign-in window still ends up on top. The read-only previews above (--inspect, and
# --dry-run on --board / --holds ...) exec and never reach it; the script itself also skips --help, --inspect and --sent. It is a convenience: if it cannot be built or opened the run
# carries on (one warning line is printed), and ASSISTANT_NO_DASHBOARD=1 switches it off (nothing opened, and no send writes it; empty, 0, false, no and off leave it on).
case "${ASSISTANT_NO_DASHBOARD:-}" in
  ''|0|false|FALSE|False|no|NO|No|off|OFF|Off)
    node "$SCRIPT_DIR/outreachDashboard.js" --launch "$@" >/dev/null 2>&1 || echo "⚠️  The outreach dashboard could not be opened (the run carries on without it; ASSISTANT_NO_DASHBOARD=1 stops it trying)."
    ;;
esac

# A HEALTHY evening / overnight Chrome is reused, never restarted: its Salesforce login lives in it, and starting the command a second time (or again after a crash of
# the bot itself) must not kill a run that is waiting for 7 PM / 8 AM. (Assistant.js refuses a second live run, so nothing is driven twice.)
REUSE=0
if { [ "$EVENING" = 1 ] || [ "$TOMORROW" = 1 ] || [ "$BOARD" = 1 ]; } && curl -s -m 3 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
  REUSE=1
  if [ "$TOMORROW" = 1 ]; then WHICH=overnight; elif [ "$BOARD" = 1 ]; then WHICH=board; else WHICH=evening; fi
  echo "♻️  The $WHICH Chrome is already up on port $CDP_PORT - reusing it (its Salesforce login stays)"
fi

if [ $REUSE = 0 ]; then
  # Kill any existing browser on OUR port only (so starting the emailer won't kill a
  # running texter, and vice-versa).
  lsof -ti :$CDP_PORT | xargs kill -9 2>/dev/null
  rm -f "$SCRIPT_DIR/$PROFILE_DIR/SingletonLock" 2>/dev/null
  sleep 1

  # Start browser in background (reads CDP_PORT / PROFILE_DIR from env)
  node start-browser.js &
  BROWSER_PID=$!

  # Wait for CDP port to be available (no dollar / lift-off animation — only the manta countdown after)
  for i in $(seq 1 30); do
    if curl -s http://localhost:$CDP_PORT/json/version >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! curl -s http://localhost:$CDP_PORT/json/version >/dev/null 2>&1; then
    echo "❌ Browser did not start in time"
    kill $BROWSER_PID 2>/dev/null
    exit 1
  fi

  sleep 1
  hcp_manta_countdown
fi

# Run the texter (connects via CDP)
node Assistant.js "$@"

# Keep browser running
wait $BROWSER_PID