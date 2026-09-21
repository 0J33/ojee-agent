/**
 * tmux, driven from outside.
 *
 * Each session is a normal interactive `claude` running in a tmux session on
 * a private socket. That is what makes the terminal in the browser the real
 * one: attaching is `tmux attach`, several viewers can watch at once, and the
 * process outlives both the viewer and the runner.
 *
 * Two things about sending text, both found by testing rather than assumed:
 *
 *   - Text is TYPED (send-keys -l), never pasted. A bracketed paste reaches
 *     Claude wrapped as <pasted_content>, which it treats as untrusted data
 *     rather than an instruction from the user. Typed text arrives as a
 *     genuine prompt; newlines are Ctrl+J, which Claude Code's input takes as
 *     "new line" rather than "submit".
 *   - tmux reads an argument ending in ";" as a command separator and drops
 *     the ";". A trailing ";" is therefore sent on its own as "\;".
 */

const { execFile } = require('child_process');

class Tmux {
  constructor({ bin, socket, conf, env = process.env }) {
    this.bin = bin;
    this.socket = socket;
    this.conf = conf;
    // The server inherits the environment of whoever starts it, and every
    // pane inherits the server's. Starting it from a clean one keeps a stray
    // API key or a parent session's markers out of every session.
    this.env = env;
  }

  run(args, { timeout = 8000, input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, ['-L', this.socket, ...args], { timeout, env: this.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || '').trim();
          return reject(err);
        }
        resolve(String(stdout));
      });
      if (input != null) { child.stdin.end(input); }
    });
  }

  async ok(args) {
    try { await this.run(args); return true; } catch { return false; }
  }

  /** Is the server up? `list-sessions` fails when it is not. */
  async serverUp() {
    try { await this.run(['list-sessions', '-F', '#{session_name}']); return true; } catch (e) {
      // "no server running" and "error connecting" both mean down; an empty
      // server (exit-empty off) lists nothing and succeeds.
      return false;
    }
  }

  /**
   * Start the server if it is not running. In systemd mode the unit owns it
   * and this only reports; starting it here would put the server in the
   * runner's cgroup, where a runner restart kills every session.
   */
  async ensureServer(mode) {
    if (await this.serverUp()) return true;
    if (mode === 'systemd') return false;
    await this.run(['-f', this.conf, 'start-server']);
    return this.serverUp();
  }

  async has(name) {
    return this.ok(['has-session', '-t', `=${name}`]);
  }

  /** name, pane pid, whether the pane's process has exited. */
  async list() {
    let out = '';
    try {
      out = await this.run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}']);
    } catch { return []; }
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, pid, dead, status] = l.split('\t');
      return { name, pid: Number(pid) || null, dead: dead === '1', status: status === '' ? null : Number(status) };
    });
  }

  /**
   * @param {object} o
   * @param {string} o.name
   * @param {string} o.cwd
   * @param {string[]} o.argv   program and arguments (run without a shell)
   * @param {object} o.env      extra environment for this session only
   */
  async create({ name, cwd, argv, env = {}, cols = 200, rows = 50 }) {
    const args = ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push('--', ...argv);
    await this.run(args);
  }

  async kill(name) {
    return this.ok(['kill-session', '-t', `=${name}`]);
  }

  target(name) { return `=${name}:`; }

  async keys(name, ...keys) {
    await this.run(['send-keys', '-t', this.target(name), ...keys]);
  }

  /** Type text literally. Newlines become Ctrl+J (a new line, not a submit). */
  async type(name, text, { chunk = 400 } = {}) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.keys(name, 'C-j');
      const line = lines[i];
      for (let at = 0; at < line.length; at += chunk) {
        let piece = line.slice(at, at + chunk);
        let semis = 0;
        while (piece.endsWith(';')) { piece = piece.slice(0, -1); semis += 1; }
        if (piece) await this.run(['send-keys', '-t', this.target(name), '-l', '--', piece]);
        for (let s = 0; s < semis; s++) await this.run(['send-keys', '-t', this.target(name), '-l', '--', '\\;']);
      }
    }
  }

  /** The visible screen as plain text (no colour codes). */
  async capture(name, { history = 0, join = false } = {}) {
    const args = ['capture-pane', '-p', '-t', this.target(name)];
    // -J rejoins lines the pane wrapped, so a long URL comes back whole.
    if (join) args.push('-J');
    if (history) args.push('-S', `-${history}`);
    try { return await this.run(args); } catch { return ''; }
  }

  async panePid(name) {
    try {
      const out = await this.run(['display-message', '-p', '-t', this.target(name), '#{pane_pid}']);
      return Number(out.trim()) || null;
    } catch { return null; }
  }

  /** argv for a viewer: attach to one session, leaving the others alone. */
  attachArgv(name) {
    return [this.bin, '-L', this.socket, 'attach-session', '-t', `=${name}`];
  }
}

module.exports = { Tmux };
