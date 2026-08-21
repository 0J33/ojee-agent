#!/bin/bash
# Install the code-agent as a systemd USER service on this laptop.
# Idempotent — safe to re-run after code changes.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/code-agent"
CONFIG_DIR="$HOME/.config/code-agent"
UNIT_DIR="$HOME/.config/systemd/user"

echo "[1/5] copying files → $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$UNIT_DIR"
cp "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"

echo "[2/5] npm install"
(cd "$INSTALL_DIR" && npm install --omit=dev --silent)

echo "[3/5] env file: $CONFIG_DIR/env"
if [ ! -f "$CONFIG_DIR/env" ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  cat > "$CONFIG_DIR/env" <<EOF
# code-agent config — edit and restart: systemctl --user restart code-agent
CODE_AGENT_TOKEN=$TOKEN
PORT=7777
BIND=0.0.0.0
DEFAULT_CWD=/media/ojee/NVME/Code/[GIT]/Claude/
EOF
  chmod 600 "$CONFIG_DIR/env"
  echo "  generated new token. Copy this to the dashboard .env:"
  echo "  CODE_AGENT_TOKEN=$TOKEN"
else
  echo "  env already exists, keeping"
  echo "  token: $(grep CODE_AGENT_TOKEN "$CONFIG_DIR/env" | cut -d= -f2)"
fi

echo "[4/5] systemd unit"
NODE_BIN=$(command -v node)
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH"; exit 1; fi
sed "s|ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" "$SCRIPT_DIR/code-agent.service" > "$UNIT_DIR/code-agent.service"
echo "  using node: $NODE_BIN"
systemctl --user daemon-reload

echo "[5/5] enable + start"
systemctl --user enable --now code-agent.service
sleep 1
systemctl --user status code-agent.service --no-pager | head -12 || true

echo ""
echo "done. tail logs: journalctl --user -u code-agent -f"
echo "or:              tail -f $INSTALL_DIR/code-agent.log"
