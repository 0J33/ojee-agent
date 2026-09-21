#!/bin/sh
# One tmux session = one Claude Code conversation, and this loop is its pane.
#
# It runs launch.sh (written by the runner before every launch). When the
# runner needs the SAME conversation under a different account or model, it
# rewrites launch.sh, drops a `relaunch` flag and ends the claude process;
# this loop sees the flag and starts claude again, now with --resume, so the
# conversation carries on. Without the flag, claude ending means the session
# ended, and so does the loop.
#
#   session.sh <session state dir>

dir="$1"
[ -d "$dir" ] || { echo "ojee-claude: no state dir $dir"; exit 98; }

while :; do
  sh "$dir/launch.sh"
  code=$?
  echo "$code $(date +%s)" >> "$dir/exits"
  if [ -f "$dir/relaunch" ]; then
    rm -f "$dir/relaunch"
    continue
  fi
  exit "$code"
done
