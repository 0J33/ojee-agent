/**
 * Claude accounts, as normal `claude` logins.
 *
 * No API keys and no tokens: every account is an ordinary subscription login
 * made with `claude auth login`, stored where `claude` stores it. What makes a
 * second one possible is CLAUDE_CONFIG_DIR — tested: a different config dir
 * has its own `.credentials.json` and its own `.claude.json`, so two logins
 * never see each other.
 *
 * The first account is the machine's existing ~/.claude. Every other account
 * gets a config dir under ~/.local/share/ojee-claude/accounts/<id>, in which
 * everything EXCEPT the login is a symlink back to ~/.claude: history,
 * settings, CLAUDE.md, plugins, skills. That is what lets a session that ran
 * out on one account resume under another — `claude --resume <id>` finds the
 * same transcript either way — and what keeps `claude --resume` typed by hand
 * in a terminal seeing every session.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

/** Entries shared between accounts. Everything else stays per-login. */
const SHARED_DIRS = [
  'projects', 'sessions', 'session-env', 'file-history', 'todos', 'tasks', 'shell-snapshots',
  'plugins', 'skills', 'agents', 'commands', 'output-styles', 'hooks', 'ide', 'paste-cache', 'jobs',
];
const SHARED_FILES = ['CLAUDE.md', 'settings.json', 'history.jsonl', 'keybindings.json'];

/**
 * What a fresh login dir copies from the main `.claude.json`: onboarding done
 * (or the first launch stops at a theme picker nobody will answer), the
 * user's MCP servers, and which folders are already trusted. Nothing that
 * identifies the account.
 */
const SEED_KEYS = [
  'hasCompletedOnboarding', 'lastOnboardingVersion', 'installMethod', 'autoUpdates',
  'autoUpdatesProtectedForNative', 'mcpServers', 'theme', 'shiftEnterKeyBindingInstalled',
  'hasSeenTasksHint', 'lastReleaseNotesSeen', 'hasUsedBackslashReturn',
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

class Accounts {
  constructor({ config, store, log = () => {} }) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.runtime = new Map(); // id -> { auth, checkedAt }
  }

  list() { return this.store.accounts; }
  get(id) { return this.store.accounts.find((a) => a.id === id) || null; }

  /** Config dir for an account; the main one is whatever `claude` uses by default. */
  dir(acct) { return acct.dir || this.config.DEFAULT_CLAUDE_DIR; }

  /** The file holding an account's settings and folder trust. */
  claudeJson(acct) {
    return acct.dir ? path.join(acct.dir, '.claude.json') : path.join(this.config.HOME, '.claude.json');
  }

  /** Environment that points `claude` at this account. */
  env(acct) { return acct.dir ? { CLAUDE_CONFIG_DIR: acct.dir } : {}; }

  /** Every projects dir, deduplicated through the symlinks. */
  projectDirs() {
    const out = new Set();
    for (const a of this.list()) {
      const p = path.join(this.dir(a), 'projects');
      try { out.add(fs.realpathSync(p)); } catch { /* not created yet */ }
    }
    if (!out.size) out.add(path.join(this.config.DEFAULT_CLAUDE_DIR, 'projects'));
    return [...out];
  }

  /* ── creating and preparing ─────────────────────────────────────────── */

  add(label) {
    const base = slug(label) || 'account';
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`;
    const acct = { id, label: String(label || id).slice(0, 40), dir: path.join(this.config.ACCOUNTS_DIR, id), addedAt: Date.now(), limits: {} };
    this.prepare(acct);
    this.store.accounts.push(acct);
    this.store.save();
    return acct;
  }

  /**
   * Link the shared entries into a secondary account's dir and seed its
   * `.claude.json`. Idempotent, and never replaces a real file with a link —
   * if something diverged, it stays diverged rather than being deleted.
   */
  prepare(acct) {
    if (!acct.dir) return;
    const main = this.config.DEFAULT_CLAUDE_DIR;
    fs.mkdirSync(acct.dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(main, { recursive: true });

    for (const name of SHARED_DIRS) {
      const src = path.join(main, name);
      const dst = path.join(acct.dir, name);
      if (!fs.existsSync(src)) fs.mkdirSync(src, { recursive: true });
      if (!fs.existsSync(dst) && !isLink(dst)) fs.symlinkSync(src, dst);
    }
    for (const name of SHARED_FILES) {
      const src = path.join(main, name);
      const dst = path.join(acct.dir, name);
      if (fs.existsSync(src) && !fs.existsSync(dst) && !isLink(dst)) fs.symlinkSync(src, dst);
    }

    const cj = path.join(acct.dir, '.claude.json');
    if (!fs.existsSync(cj)) {
      let from = {};
      try { from = JSON.parse(fs.readFileSync(path.join(this.config.HOME, '.claude.json'), 'utf8')); } catch { /* none */ }
      const seed = {};
      for (const k of SEED_KEYS) if (from[k] !== undefined) seed[k] = from[k];
      seed.hasCompletedOnboarding = true;
      seed.projects = {};
      for (const [p, v] of Object.entries(from.projects || {})) {
        if (v?.hasTrustDialogAccepted) seed.projects[p] = { hasTrustDialogAccepted: true };
      }
      fs.writeFileSync(cj, JSON.stringify(seed, null, 2), { mode: 0o600 });
    }
  }

  remove(id) {
    const acct = this.get(id);
    if (!acct) return false;
    if (!acct.dir) throw new Error('The main account is this machine\'s own ~/.claude and cannot be removed.');
    this.store.data.accounts = this.store.accounts.filter((a) => a.id !== id);
    if (this.store.settings.activeAccount === id) this.store.settings.activeAccount = this.store.accounts[0]?.id || 'main';
    this.store.save();
    // The login dir is left on disk: deleting a credential by accident is
    // worse than a stray folder. Say where it is.
    return { removed: true, leftOnDisk: acct.dir };
  }

  /* ── login state ────────────────────────────────────────────────────── */

  /** `claude auth status --json` for one account. Never throws. */
  status(acct) {
    return new Promise((resolve) => {
      const env = { ...cleanEnv(process.env), ...this.env(acct) };
      execFile(this.config.CLAUDE_BIN, ['auth', 'status', '--json'], { env, timeout: 30_000 }, (err, stdout) => {
        let s = null;
        try { s = JSON.parse(String(stdout)); } catch { /* not JSON */ }
        const auth = s
          ? { loggedIn: !!s.loggedIn, email: s.email || null, plan: s.subscriptionType || null, org: s.orgName || null, method: s.authMethod || null }
          : { loggedIn: null, error: err ? (err.code === 'ENOENT' ? `claude not found at ${this.config.CLAUDE_BIN}` : String(err.message).slice(0, 200)) : 'unreadable status' };
        this.runtime.set(acct.id, { auth, checkedAt: Date.now() });
        // A successful login clears an earlier "needs login".
        if (auth.loggedIn && acct.limits?.auth) { delete acct.limits.auth; this.store.save(); }
        resolve(auth);
      });
    });
  }

  async refreshAll() {
    await Promise.all(this.list().map((a) => this.status(a)));
  }

  auth(acct) { return this.runtime.get(acct.id)?.auth || null; }

  /* ── limits ─────────────────────────────────────────────────────────── */

  limits(acct) {
    acct.limits = acct.limits || {};
    acct.limits.models = acct.limits.models || {};
    return acct.limits;
  }

  markAccountLimited(acct, { until, window, text }) {
    this.limits(acct).account = { until, window: window || null, text: text || null, at: Date.now() };
    this.store.save();
  }

  markModelLimited(acct, familyName, { until, text }) {
    if (!familyName) return;
    this.limits(acct).models[familyName] = { until, text: text || null, at: Date.now() };
    this.store.save();
  }

  markNeedsLogin(acct, text) {
    this.limits(acct).auth = { text: text || 'Login expired', at: Date.now() };
    const rt = this.runtime.get(acct.id);
    if (rt) rt.auth = { ...(rt.auth || {}), loggedIn: false };
    this.store.save();
  }

  /** Drop limits whose time has passed. Returns true if anything changed. */
  expire(now = Date.now()) {
    let changed = false;
    for (const a of this.list()) {
      const l = this.limits(a);
      if (l.account && l.account.until && l.account.until <= now) { delete l.account; changed = true; }
      for (const [f, v] of Object.entries(l.models)) {
        if (v.until && v.until <= now) { delete l.models[f]; changed = true; }
      }
    }
    if (changed) this.store.save();
    return changed;
  }

  needsLogin(acct) {
    return !!this.limits(acct).auth || this.auth(acct)?.loggedIn === false;
  }

  accountLimitedUntil(acct, now = Date.now()) {
    const u = this.limits(acct).account?.until;
    return u && u > now ? u : null;
  }

  modelLimitedUntil(acct, familyName, now = Date.now()) {
    const u = familyName ? this.limits(acct).models[familyName]?.until : null;
    return u && u > now ? u : null;
  }

  /** Can this account take a request for this model family right now? */
  usable(acct, familyName = null, now = Date.now()) {
    if (!acct || this.needsLogin(acct)) return false;
    if (this.accountLimitedUntil(acct, now)) return false;
    if (familyName && this.modelLimitedUntil(acct, familyName, now)) return false;
    return true;
  }

  /** First usable account other than `exceptId`, in the order they are listed. */
  alternative(exceptId, familyName = null) {
    return this.list().find((a) => a.id !== exceptId && this.usable(a, familyName)) || null;
  }

  /** When the soonest spent account comes back, for pausing honestly. */
  earliestReturn(now = Date.now()) {
    const times = this.list()
      .filter((a) => !this.needsLogin(a))
      .map((a) => this.accountLimitedUntil(a, now))
      .filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  describe(acct) {
    const now = Date.now();
    const l = this.limits(acct);
    const auth = this.auth(acct);
    let status = 'ok';
    if (this.needsLogin(acct)) status = 'needs-login';
    else if (this.accountLimitedUntil(acct, now)) status = 'limited';
    else if (!auth) status = 'unknown';
    return {
      id: acct.id,
      label: acct.label,
      dir: this.dir(acct),
      main: !acct.dir,
      active: this.store.settings.activeAccount === acct.id,
      status,
      email: auth?.email || null,
      plan: auth?.plan || null,
      loggedIn: auth?.loggedIn ?? null,
      authError: auth?.error || null,
      limitedUntil: this.accountLimitedUntil(acct, now),
      limitWindow: l.account?.window || null,
      limitText: l.account?.text || l.auth?.text || null,
      modelLimits: Object.fromEntries(Object.entries(l.models)
        .filter(([, v]) => !v.until || v.until > now)
        .map(([f, v]) => [f, v.until])),
      checkedAt: this.runtime.get(acct.id)?.checkedAt || null,
    };
  }

  /* ── folder trust ───────────────────────────────────────────────────── */

  /**
   * Mark `cwd` trusted for this account, so an unattended launch does not
   * stop at "Is this a project you trust?" — whose default answer is "No,
   * exit". Claude Code itself names the key: projects[<path>].hasTrustDialogAccepted
   * in the account's .claude.json.
   *
   * Written under the same lock directory `claude` uses (`.claude.json.lock`)
   * and by atomic rename, because a running session rewrites this file. If
   * the lock cannot be had, the launch goes ahead and the screen watcher
   * answers the dialog instead.
   */
  async trust(acct, cwd) {
    const file = this.claudeJson(acct);
    const lock = `${file}.lock`;
    let got = false;
    for (let i = 0; i < 30 && !got; i++) {
      try { fs.mkdirSync(lock); got = true; } catch (e) {
        if (e.code !== 'EEXIST') return false;
        try {
          // A lock nobody has touched for 15s belongs to a process that died.
          if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) { fs.rmdirSync(lock); continue; }
        } catch { /* raced with its owner releasing it */ }
        await delay(100);
      }
    }
    if (!got) return false;
    try {
      let data = {};
      try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* new file */ }
      data.projects = data.projects || {};
      const keys = new Set([cwd]);
      try { keys.add(fs.realpathSync(cwd)); } catch { /* fine */ }
      let changed = false;
      for (const k of keys) {
        if (data.projects[k]?.hasTrustDialogAccepted) continue;
        data.projects[k] = { ...(data.projects[k] || {}), hasTrustDialogAccepted: true };
        changed = true;
      }
      if (changed) {
        const tmp = `${file}.ojee-${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        await fsp.rename(tmp, file);
      }
      return true;
    } catch (e) {
      this.log('trust', e.message);
      return false;
    } finally {
      try { fs.rmdirSync(lock); } catch { /* already gone */ }
    }
  }
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * The environment a `claude` started by the runner should see. Strips what
 * would change which account or mode it runs as — an API key or token would
 * silently bill per token, which is exactly what this setup must never do —
 * and the markers a parent Claude Code session leaves behind (one of them
 * turns transcript saving off).
 */
function cleanEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete out[k];
  }
  return out;
}

module.exports = { Accounts, cleanEnv, SHARED_DIRS, SHARED_FILES };
