/**
 * Where everything lives, read once from the environment.
 *
 * The runner is a host service, not a container: it has to start sessions in
 * any folder on the box and share the user's own ~/.claude, so these are real
 * paths on the real machine. Defaults follow the XDG layout; the env file the
 * installer writes (~/.config/ojee-claude/env) overrides any of them.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const env = process.env;
const xdg = (name, fallback) => env[name] || path.join(HOME, fallback);

const STATE_DIR = env.STATE_DIR || path.join(xdg('XDG_STATE_HOME', '.local/state'), 'ojee-claude');
const DATA_DIR = env.DATA_DIR || path.join(xdg('XDG_DATA_HOME', '.local/share'), 'ojee-claude');
const RUNTIME_DIR = env.RUNTIME_DIR
  || (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'ojee-claude') : path.join(STATE_DIR, 'run'));

/** tmux: an explicit binary, else the one the installer unpacked, else PATH. */
function tmuxBin() {
  if (env.TMUX_BIN) return env.TMUX_BIN;
  const local = path.join(DATA_DIR, 'bin', 'tmux');
  return fs.existsSync(local) ? local : 'tmux';
}

/**
 * A Unix socket path must fit in sun_path (108 bytes on Linux); a longer one
 * is silently truncated and fails with a misleading EADDRINUSE. Fall back to
 * a short, per-user name in /tmp when the preferred path is too long.
 */
function hookSock(preferred) {
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const tag = require('crypto').createHash('sha1').update(preferred).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `ojee-claude-${process.getuid?.() ?? 'u'}-${tag}.sock`);
}

const config = {
  HOME,
  PORT: Number(env.PORT || 7777),
  // Loopback unless told otherwise. On the HP box the env file sets the
  // tailnet address: that plus the token is the boundary, and 0.0.0.0 would
  // put a bypass-permissions shell on both Wi-Fi networks.
  HOST: env.HOST || env.BIND || '127.0.0.1',
  TOKEN: env.RUNNER_TOKEN || env.CODE_AGENT_TOKEN || '',

  CLAUDE_BIN: env.CLAUDE_BIN || path.join(HOME, '.local', 'bin', 'claude'),
  TMUX_BIN: tmuxBin(),
  TMUX_SOCKET: env.TMUX_SOCKET || 'ojee-claude',
  // "systemd": ojee-claude-tmux.service owns the tmux server, so restarting
  // the runner never kills a session. "self": the runner starts it (dev, tests).
  TMUX_MODE: env.TMUX_MODE || 'self',

  STATE_DIR,
  DATA_DIR,
  RUNTIME_DIR,
  HOOK_SOCK: hookSock(env.HOOK_SOCK || path.join(RUNTIME_DIR, 'hook.sock')),
  ACCOUNTS_DIR: path.join(DATA_DIR, 'accounts'),
  // The account every install already has: whatever `claude` uses by default.
  DEFAULT_CLAUDE_DIR: env.DEFAULT_CLAUDE_DIR || path.join(HOME, '.claude'),

  DISCORD_WEBHOOK: env.CLAUDE_DISCORD_WEBHOOK || '',
  CONSOLE_URL: (env.CONSOLE_URL || '').replace(/\/+$/, ''),
  STACK_DIR: env.STACK_DIR || path.join(HOME, 'stack'),
  DEFAULT_CWD: env.DEFAULT_CWD || HOME,

  // How often the background checks run. Tests shorten these.
  TICK_MS: Number(env.TICK_MS || 15_000),
  AUTH_CHECK_MS: Number(env.AUTH_CHECK_MS || 15 * 60_000),
};

/**
 * Models offered in the UI. `id` is what goes to --model; the family is how a
 * limit message ("your Fable limit") is matched back to a model.
 */
config.MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable' },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', family: 'haiku' },
];

config.DEFAULT_SETTINGS = {
  defaultModel: 'claude-fable-5-1',
  fallbackModel: 'claude-opus-5',
  // A model limit carries no reset time; this is when to try the preferred
  // model again.
  modelRetryHours: 5,
  autoSwitchAccounts: true,
  activeAccount: 'main',
  maxRunning: 3,
  stallMinutes: 20,
  unattended: true,
  guard: true,
  resumeInterrupted: true,
  notify: {
    needsInput: true,
    blocked: true,
    error: true,
    stalled: true,
    modelFallback: true,
    accountSwitch: true,
    allLimited: true,
    needsLogin: true,
    done: false,
    excerpts: true,
  },
};

module.exports = config;
