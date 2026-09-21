#!/bin/bash
# Install the Claude runner as two systemd --user services on this machine.
#
#   ./deploy/install.sh            install; start nothing
#   ./deploy/install.sh --start    install, retire the old code-agent, start
#
# Idempotent — run it again after a `git pull`. It never overwrites the env
# file, so the token and webhook survive.
#
# tmux: the system one if it is 3.2 or newer; otherwise the Ubuntu package is
# unpacked into ~/.local/share/ojee-claude (apt-get download + dpkg -x), which
# needs no sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/ojee-claude"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/ojee-claude"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
START=0
[ "${1:-}" = "--start" ] && START=1

say() { printf '\n[%s] %s\n' "$1" "$2"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

say 1/7 "node"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node is not on PATH"
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "node 20+ required ($("$NODE" -v))"
echo "  $NODE $("$NODE" -v)"

say 2/7 "claude"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
if [ -x "$CLAUDE_BIN" ]; then echo "  $CLAUDE_BIN — $("$CLAUDE_BIN" --version 2>/dev/null || echo '?')"
else echo "  WARNING: no claude at $CLAUDE_BIN. Install Claude Code, or set CLAUDE_BIN in $CONF/env."; fi

say 3/7 "npm install"
(cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --silent)

say 4/7 "tmux"
TMUX_BIN=""
if command -v tmux >/dev/null 2>&1; then
  v="$(tmux -V | sed -n 's/^tmux \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
  set -- $v
  if [ "${1:-0}" -gt 3 ] || { [ "${1:-0}" -eq 3 ] && [ "${2:-0}" -ge 2 ]; }; then TMUX_BIN="$(command -v tmux)"; fi
fi
if [ -z "$TMUX_BIN" ]; then
  echo "  no tmux 3.2+ on PATH — unpacking the package into $DATA/tmux (no sudo)"
  work="$(mktemp -d)"
  (
    cd "$work"
    apt-get download tmux >/dev/null
    # Its two libraries, under whichever name this release uses. A missing
    # one is only fetched if the system does not already have it.
    for p in libevent-core-2.1-7t64 libevent-core-2.1-7 libutempter0; do apt-get download "$p" >/dev/null 2>&1 || true; done
    rm -rf "$DATA/tmux" && mkdir -p "$DATA/tmux"
    for d in ./*.deb; do dpkg -x "$d" "$DATA/tmux"; done
  )
  rm -rf "$work"
  mkdir -p "$DATA/bin"
  cat > "$DATA/bin/tmux" <<EOF
#!/bin/sh
LD_LIBRARY_PATH="$DATA/tmux/usr/lib/x86_64-linux-gnu:$DATA/tmux/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" exec "$DATA/tmux/usr/bin/tmux" "\$@"
EOF
  chmod +x "$DATA/bin/tmux"
  TMUX_BIN="$DATA/bin/tmux"
fi
"$TMUX_BIN" -V >/dev/null || die "tmux at $TMUX_BIN does not run"
echo "  $TMUX_BIN — $("$TMUX_BIN" -V)"

say 5/7 "env file: $CONF/env"
mkdir -p "$CONF"
if [ ! -f "$CONF/env" ]; then
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
  HOST_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  cat > "$CONF/env" <<EOF
# ojee-claude runner — edit, then: systemctl --user restart ojee-claude
#
# The API listens on HOST:PORT. HOST is the tailnet address: that and the
# token are the boundary. Never 0.0.0.0 — this runs Claude with bypass
# permissions.
HOST=${HOST_IP:-127.0.0.1}
PORT=7777
RUNNER_TOKEN=$TOKEN

# The agent module's own setting for the same pair, in the stack's .env:
#   CLAUDE_RUNNER_URL=http://${HOST_IP:-<tailnet ip>}:7777
#   CLAUDE_RUNNER_TOKEN=<the token above>

CLAUDE_BIN=$CLAUDE_BIN
TMUX_BIN=$TMUX_BIN

# Discord pings. Its own webhook, not fleet's. Empty = pings are only listed
# in the console.
CLAUDE_DISCORD_WEBHOOK=
# Where a ping's "Open in console" link points.
CONSOLE_URL=https://console.ojee.net

# Sessions started outside this folder may not touch it (the guard).
STACK_DIR=$HOME/stack
DEFAULT_CWD=$HOME
TIMEZONE=${TZ:-Africa/Cairo}
EOF
  chmod 600 "$CONF/env"
  echo "  written. Token for the stack's .env (CLAUDE_RUNNER_TOKEN): $TOKEN"
else
  echo "  exists, kept"
  grep -q '^TMUX_BIN=' "$CONF/env" || echo "TMUX_BIN=$TMUX_BIN" >> "$CONF/env"
fi

say 6/7 "systemd units → $UNITS"
mkdir -p "$UNITS"
for u in ojee-claude-tmux.service ojee-claude.service; do
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@NODE@|$NODE|g" -e "s|@TMUX@|$TMUX_BIN|g" "$ROOT/deploy/$u" > "$UNITS/$u"
done
systemctl --user daemon-reload
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "  WARNING: lingering is off — sessions stop when you log out. Fix: loginctl enable-linger $USER"
fi

say 7/7 "start"
if [ "$START" = 1 ]; then
  if systemctl --user is-active --quiet code-agent.service 2>/dev/null; then
    echo "  retiring the old code-agent (it holds :7777 on every interface)"
    systemctl --user disable --now code-agent.service
  fi
  systemctl --user enable --now ojee-claude-tmux.service ojee-claude.service
  sleep 2
  systemctl --user --no-pager --lines=5 status ojee-claude.service || true
else
  echo "  not started. When ready:"
  if systemctl --user is-active --quiet code-agent.service 2>/dev/null; then
    echo "    systemctl --user disable --now code-agent.service    # the old one, on 0.0.0.0:7777"
  fi
  echo "    systemctl --user enable --now ojee-claude-tmux.service ojee-claude.service"
  echo "  or re-run: $0 --start"
fi

echo
echo "logs: journalctl --user -u ojee-claude -f"
echo "sessions by hand: $TMUX_BIN -L ojee-claude ls"
