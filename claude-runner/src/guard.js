/**
 * The few commands an unattended session is not allowed to run.
 *
 * Bypass-permissions mode means nobody approves anything, on a box that also
 * runs the console, Caddy, n8n and the home hub — and whose user is in the
 * docker group, so a session is root in all but name. This is not a sandbox
 * and does not try to be one. It is a short list of the mistakes that would
 * take the rest of the box down, or that no task should need, checked by a
 * PreToolUse hook (hooks still run under bypass) that blocks the call and
 * tells Claude why, so it can do something else or end with BLOCKED.
 *
 * Deliberately narrow. A guard that blocks ordinary work gets switched off,
 * and then it protects nothing.
 */

const path = require('path');

/** Containers whose loss takes a service down for everyone else. */
const PROTECTED_CONTAINERS = [
  'caddy', 'ojee-console', 'ojee-agent', 'ojee-remote', 'ojee-fleet', 'fleet', 'home',
  'n8n', 'couchdb', 'guacd', 'odysseus', 'chromadb', 'searxng', 'ntfy',
];

/** User units a session must not stop: this runner, and the remote agent. */
const PROTECTED_UNITS = /\b(ojee-claude(?:-tmux)?|ojee-remote-agent)(?:\.service)?\b/;

const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * @param {object} o
 * @param {string} o.command   the Bash command about to run
 * @param {string} o.cwd       the session's working directory
 * @param {string} o.home      $HOME
 * @param {string} o.stackDir  the docker stack's directory (~/stack)
 * @returns {string|null}      why it is refused, or null to allow
 */
function check({ command, cwd, home, stackDir }) {
  const cmd = String(command || '');
  const inStack = stackDir && cwd && within(path.resolve(cwd), stackDir);

  if (/(^|[\s;&|(])sudo(\s|$)/.test(cmd)) {
    return 'sudo is not available to unattended sessions on this machine (it would wait for a password nobody will type). If the task needs root, stop and end your message with "BLOCKED: needs sudo — <what for>".';
  }

  if (/\bgit\b[^;&|]*\bpush\b[^;&|]*(\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/.test(cmd)) {
    return 'Force-pushing is blocked for unattended sessions. Push a new branch instead, or end with "BLOCKED:" if a force push is really required.';
  }

  if (stackDir && !inStack) {
    const variants = [stackDir, stackDir.replace(home, '~'), stackDir.replace(home, '$HOME'), stackDir.replace(home, '${HOME}')];
    // The path itself, not a prefix of a longer name: ~/stack-notes is fine.
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (variants.some((v) => v && new RegExp(`${esc(v)}(?=$|[/\\s"';&|)])`).test(cmd))) {
      return `${stackDir} is the running docker stack (console, Caddy, n8n, home). Sessions outside it may not touch it. Start a session in that folder if the task is about the stack.`;
    }
  }

  if (!inStack && /\bdocker\b/.test(cmd)) {
    if (/\bdocker\b[^;&|]*\b(system|volume|network|image|builder|container)\s+prune\b/.test(cmd)) {
      return 'docker prune commands affect every container on this box, including the console stack. Blocked for unattended sessions.';
    }
    const destructive = /\bdocker\b[^;&|]*\b(stop|rm|kill|restart|down|pause|rename|update)\b/.test(cmd);
    const hit = PROTECTED_CONTAINERS.find((n) => new RegExp(`(^|[\\s/=:"'])${n.replace(/[-]/g, '\\-')}([\\s"';&|]|$)`).test(cmd));
    if (destructive && hit) {
      return `"${hit}" is part of the console stack on this box. Unattended sessions may not stop, remove or restart it.`;
    }
  }

  if (/\bsystemctl\b[^;&|]*\b(stop|restart|kill|disable|mask)\b/.test(cmd) && PROTECTED_UNITS.test(cmd)) {
    return 'That unit runs this session (or the remote desktop agent). Stopping it would end the session mid-task.';
  }

  const rm = /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+([^;&|]+)/.exec(cmd);
  if (rm) {
    const targets = rm[1].trim().split(/\s+/).filter((t) => !t.startsWith('-'));
    const dangerous = new Set(['/', '/*', '~', '~/', '$HOME', '${HOME}', home, `${home}/`, `${home}/*`, '~/*', '$HOME/*', '/home', '/home/']);
    if (targets.some((t) => dangerous.has(t.replace(/^["']|["']$/g, '')))) {
      return 'Refusing to recursively delete the root or home directory.';
    }
  }

  return null;
}

module.exports = { check, PROTECTED_CONTAINERS };
