/**
 * The session manager.
 *
 * A session is one Claude Code conversation running interactively inside a
 * tmux session — the real terminal, the same one you would get typing
 * `claude` into a shell on the box. The runner does not parse that terminal
 * to know what is happening; it has three better sources, each tested:
 *
 *   hooks        Claude Code calls bin/hook.js on SessionStart, a submitted
 *                prompt, a finished turn (with the last reply), a question
 *                (AskUserQuestion), and a notification. That is the timeline.
 *   transcript   the session's own JSONL: which model actually answered, and
 *                every failed request with a machine-readable reason.
 *   tmux         whether the process is still alive, and the screen for
 *                exactly two things: prompts at startup nobody is there to
 *                answer (folder trust), and notice menus between turns that
 *                would otherwise take the next message's Enter.
 *
 * Switching a session's model or account never uses `/model` (tested: it
 * also saves that model as the user's default for every new session).
 * Instead the wrapper loop in bin/session.sh restarts `claude --resume <id>`
 * with new flags, and the conversation carries on where it stopped.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { classify, retryAt, family } = require('./limits');
const { findTranscript, Tail } = require('./transcript');

/** States in which a claude process is expected to exist. */
const LIVE = new Set(['starting', 'running', 'idle', 'waiting', 'blocked', 'done', 'paused']);
/** States that count against "how many run at once". */
const BUSY = new Set(['starting', 'running']);

const MINUTE = 60_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** POSIX single-quoting: safe for any byte except NUL. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const continueText = (why) => `${why} Continue the task from where you left off.`;

/**
 * Claude Code shows the occasional notice as a menu after a turn — seen on
 * 2.1.267: "Try the new fullscreen renderer? 1. Yes, try it  2. Not now".
 * Unattended, it sits there, and the next message's Enter would pick "Yes".
 * These are recognised by their footer (a question from AskUserQuestion says
 * "Enter to select" instead) and answered with their own decline option.
 * A menu with no decline option is left alone and reported as needing you.
 */
const MENU = /Enter to confirm/i;
const DECLINE = /^\s*(?:❯\s*)?(?:\d+\.\s*)?(Not now|No thanks|No, thanks|Maybe later|Skip|Don['’]t show (?:this )?again|Dismiss|Remind me later)\b/i;

/** A reply whose last line asks something is a question for the user. */
function asksSomething(text) {
  const tail = String(text || '').trim().split('\n').filter((l) => l.trim()).slice(-2).join(' ');
  return /\?\s*(\*\*)?\s*$/.test(tail);
}

/** The line a marker sits on, or null. Only the end of a reply counts. */
function marker(text, word) {
  const lines = String(text || '').trim().split('\n').slice(-6);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = new RegExp(`^\\s*(?:\\*\\*)?${word}:?(?:\\*\\*)?:?\\s*(.*)$`).exec(lines[i]);
    if (m) return m[1].trim() || word;
  }
  return null;
}

/** Children of a pid, from /proc. */
function childrenOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { /* fall through to a scan */ }
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch { /* gone */ }
  }
  return out;
}

const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

class Sessions extends EventEmitter {
  constructor({ config, store, tmux, accounts, notifier, files, log = () => {} }) {
    super();
    this.config = config;
    this.store = store;
    this.tmux = tmux;
    this.accounts = accounts;
    this.notifier = notifier;
    this.files = files; // { sessionSh, settingsFile, unattendedFile }
    this.log = log;
    this.tails = new Map();
    this.alive = new Map();      // id -> bool, from the last reconcile
    this.watchers = new Map();   // id -> interval (boot-time screen watcher)
    this.busyOps = new Set();    // ids with a launch/relaunch in flight
  }

  get settings() { return this.store.settings; }
  all() { return Object.values(this.store.sessions); }
  get(id) { return this.store.sessions[id] || null; }

  byClaudeId(cid) {
    return this.all().find((s) => s.claudeId === cid || s.id === cid) || null;
  }

  dir(s) { return path.join(this.config.STATE_DIR, 'sessions', s.id); }

  modelLabel(id) { return this.config.MODELS.find((m) => m.id === id)?.label || id || '—'; }
  familyLabel(f) { return this.config.MODELS.find((m) => m.family === f)?.label.split(' ')[0] || f || 'That model'; }

  /* ── what the API sees ──────────────────────────────────────────────── */

  view(s) {
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      state: s.state,
      detail: s.detail || null,
      question: s.question || null,
      model: s.model,
      account: s.account,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      lastPromptAt: s.lastPromptAt || null,
      pausedUntil: s.pausedUntil || null,
      lastAssistant: s.lastAssistant ? clip(s.lastAssistant, 600) : null,
      lastError: s.lastError || null,
      alive: this.alive.get(s.id) ?? null,
      launches: s.launches || 0,
      unattended: s.unattended !== false,
      autoContinue: s.autoContinue || 0,
      notifyDone: s.notifyDone ?? null,
      queuedAt: s.state === 'queued' ? s.queuedAt : null,
      tmux: s.tmux,
    };
  }

  setState(s, state, detail = null) {
    const changed = s.state !== state || s.detail !== detail;
    s.state = state;
    s.detail = detail;
    s.updatedAt = Date.now();
    if (state !== 'paused') s.pausedUntil = null;
    if (changed) {
      this.store.save();
      this.emit('change', s);
    }
  }

  touch(s) {
    s.lastActivityAt = Date.now();
    if (s.stallNotified) s.stallNotified = false;
  }

  busyCount() { return this.all().filter((s) => BUSY.has(s.state)).length; }

  /* ── creating ───────────────────────────────────────────────────────── */

  async create({ cwd, prompt = '', title = '', model, fallback, account, unattended, autoContinue = 0, notifyDone = null }) {
    const dir = path.resolve(String(cwd || this.config.DEFAULT_CWD));
    let st;
    try { st = fs.statSync(dir); } catch { throw Object.assign(new Error(`${dir} does not exist`), { status: 400 }); }
    if (!st.isDirectory()) throw Object.assign(new Error(`${dir} is not a folder`), { status: 400 });

    const set = this.settings;
    const preferred = model || set.defaultModel;
    const fb = fallback === undefined ? set.fallbackModel : (fallback || null);
    const id = randomUUID();
    const firstLine = String(prompt).trim().split('\n')[0];
    const s = {
      id,
      claudeId: id,
      managed: true,
      title: clip(title || firstLine || path.basename(dir) || 'session', 70),
      titleSource: title ? 'user' : 'auto',
      cwd: dir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      state: 'queued',
      detail: null,
      model: { preferred, current: preferred, fallback: fb && fb !== preferred ? fb : null, actual: null },
      account: account || set.activeAccount,
      unattended: unattended ?? set.unattended,
      autoContinue: Math.max(0, Math.min(10, Number(autoContinue) || 0)),
      notifyDone,
      nudges: 0,
      launches: 0,
      tmux: `cc-${id.slice(0, 8)}`,
      transcript: null,
      tailOffset: 0,
      retries: {},
      queuedAt: Date.now(),
      pendingPrompt: String(prompt || ''),
    };
    this.store.sessions[id] = s;
    this.store.save();

    if (this.busyCount() < set.maxRunning) await this.start(s);
    else this.setState(s, 'queued', `Waiting for a slot — ${set.maxRunning} already running`);
    this.emit('change', s);
    return s;
  }

  /**
   * Start a session that has no live process: first launch, a queued one, or
   * one that is being resumed. Picks a usable account first; if none is,
   * the session waits paused instead of launching into a known wall.
   */
  async start(s, { prompt } = {}) {
    const text = prompt ?? (s.pendingPrompt || '');
    const pick = this.pickAccountModel(s);
    if (!pick) {
      s.pendingPrompt = text;
      return this.pauseAll(s, 'Every account is out of usage.');
    }
    s.account = pick.account;
    s.model.current = pick.model;
    s.pendingPrompt = '';
    await this.launch(s, { prompt: text });
  }

  /**
   * The account and model this session should use right now: its own
   * account with the preferred model, else its own account with the
   * fallback, else (if allowed) another account.
   */
  pickAccountModel(s) {
    const acc = this.accounts;
    const own = acc.get(s.account) || acc.get(this.settings.activeAccount) || acc.list()[0];
    const pref = s.model.preferred;
    const fb = s.model.fallback;
    if (own && acc.usable(own, family(pref))) return { account: own.id, model: pref };
    if (own && fb && acc.usable(own, family(fb))) return { account: own.id, model: fb };
    if (!this.settings.autoSwitchAccounts && own && !acc.needsLogin(own) && !acc.accountLimitedUntil(own)) {
      return { account: own.id, model: pref };
    }
    if (this.settings.autoSwitchAccounts) {
      const alt = acc.alternative(own?.id, family(pref));
      if (alt) return { account: alt.id, model: pref };
      const alt2 = fb ? acc.alternative(own?.id, family(fb)) : null;
      if (alt2) return { account: alt2.id, model: fb };
    }
    return null;
  }

  /* ── launching ──────────────────────────────────────────────────────── */

  hasTranscript(s) {
    if (s.transcript && fs.existsSync(s.transcript)) return true;
    const f = findTranscript(this.accounts.projectDirs(), s.claudeId);
    if (f) { s.transcript = f; return true; }
    return false;
  }

  /** Write the script bin/session.sh runs for the next launch. */
  writeLaunch(s, { prompt = '' } = {}) {
    const dir = this.dir(s);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = path.join(dir, 'prompt.txt');
    if (prompt) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    else { try { fs.unlinkSync(promptFile); } catch { /* none */ } }

    const acct = this.accounts.get(s.account);
    const resume = this.hasTranscript(s);
    const env = {
      ...(acct ? this.accounts.env(acct) : {}),
      OJEE_CLAUDE_SESSION: s.id,
      OJEE_CLAUDE_HOOK_SOCK: this.config.HOOK_SOCK,
      OJEE_CLAUDE_GUARD: this.settings.guard ? '1' : '0',
      OJEE_CLAUDE_STACK_DIR: this.config.STACK_DIR,
      COLORTERM: 'truecolor',
    };
    const args = [
      this.config.CLAUDE_BIN,
      resume ? '--resume' : '--session-id', s.claudeId,
      '--model', s.model.current,
    ];
    const fb = s.model.fallback;
    if (fb && fb !== s.model.current) args.push('--fallback-model', fb);
    args.push('--dangerously-skip-permissions', '--settings', this.files.settingsFile);
    if (!resume && s.title) args.push('--name', s.title);

    const script = [
      '#!/bin/sh',
      `# Written by ojee-claude before each launch of session ${s.id}. Edits are overwritten.`,
      `cd ${q(s.cwd)} || { echo "ojee-claude: cannot enter ${s.cwd.replace(/"/g, '')}"; exit 97; }`,
      // Drop every CLAUDE*/ANTHROPIC* variable this process inherited. An API
      // key or token would bill per token without anyone noticing, and the
      // markers a parent Claude Code session leaves (a session id, "child
      // session") change how claude behaves — one turns transcripts off.
      "for v in $(env | sed -n -e 's/^\\(CLAUDE[A-Za-z0-9_]*\\)=.*/\\1/p' -e 's/^\\(ANTHROPIC[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
      'unset TMUX TMUX_PANE',
      'P=',
      `if [ -f ${q(promptFile)} ]; then P=$(cat ${q(promptFile)}); rm -f ${q(promptFile)}; fi`,
      [
        'exec env',
        ...Object.entries(env).map(([k, v]) => `${k}=${q(v)}`),
        ...args.map(q),
        s.unattended !== false ? `--append-system-prompt "$(cat ${q(this.files.unattendedFile)})"` : '',
        '${P:+"$P"}',
      ].filter(Boolean).join(' '),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'launch.sh'), script, { mode: 0o700 });
    return { resume };
  }

  async launch(s, { prompt = '' } = {}) {
    if (this.busyOps.has(s.id)) return;
    this.busyOps.add(s.id);
    try {
      const acct = this.accounts.get(s.account);
      if (acct) await this.accounts.trust(acct, s.cwd);
      this.writeLaunch(s, { prompt });
      // A pane left over from an earlier exit (kept so its output can be
      // read) is replaced, not reused.
      if (await this.tmux.has(s.tmux)) await this.tmux.kill(s.tmux);
      await this.tmux.create({
        name: s.tmux,
        cwd: s.cwd,
        argv: ['/bin/sh', this.files.sessionSh, this.dir(s)],
      });
      s.launches = (s.launches || 0) + 1;
      s.launchedAt = Date.now();
      s.launchHadPrompt = !!prompt;
      s.expectExit = false;
      s.relaunching = false;
      s.question = null;
      this.alive.set(s.id, true);
      this.touch(s);
      this.setState(s, 'starting', `Starting on ${this.modelLabel(s.model.current)} · ${this.accountLabel(s.account)}`);
      this.watchBoot(s);
    } catch (e) {
      this.setState(s, 'error', `Could not start: ${e.stderr || e.message}`);
      this.notifier.send('error', { session: s, text: `Could not start the session: ${e.stderr || e.message}` });
    } finally {
      this.busyOps.delete(s.id);
    }
  }

  accountLabel(id) { return this.accounts.get(id)?.label || id; }

  /**
   * Change model and/or account and continue the same conversation. If the
   * process is alive, the loop in session.sh restarts it; if not, it is
   * launched fresh with --resume.
   */
  async relaunch(s, { model, account, prompt = '', why = '' } = {}) {
    if (model) s.model.current = model;
    if (account) s.account = account;
    s.pausedUntil = null;
    const alive = await this.isAlive(s);
    if (!alive) return this.launch(s, { prompt });

    this.busyOps.add(s.id);
    try {
      const acct = this.accounts.get(s.account);
      if (acct) await this.accounts.trust(acct, s.cwd);
      this.writeLaunch(s, { prompt });
      fs.writeFileSync(path.join(this.dir(s), 'relaunch'), String(Date.now()));
      s.relaunching = true;
      s.expectExit = true;
      s.launchedAt = Date.now();
      s.launchHadPrompt = !!prompt;
      s.launches = (s.launches || 0) + 1;
      s.question = null;
      this.setState(s, 'starting', why || `Restarting on ${this.modelLabel(s.model.current)} · ${this.accountLabel(s.account)}`);
      await this.killClaude(s);
      this.watchBoot(s);
    } finally {
      this.busyOps.delete(s.id);
    }
  }

  /** End the claude process inside the pane, leaving the pane (and the loop). */
  async killClaude(s) {
    const pane = await this.tmux.panePid(s.tmux);
    if (!pane) return;
    const kids = childrenOf(pane);
    for (const pid of kids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 30 && kids.some(alivePid); i++) await delay(200);
    for (const pid of kids) if (alivePid(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }

  async isAlive(s) {
    const panes = await this.tmux.list();
    const p = panes.find((x) => x.name === s.tmux);
    const alive = !!p && !p.dead;
    this.alive.set(s.id, alive);
    return alive;
  }

  /**
   * While a session boots, answer the prompts Claude Code shows before it
   * accepts input, because nobody is at the terminal to answer them:
   *
   *   "Is this a project you trust?"  — defaults to "No, exit"
   *   "Bypass Permissions mode … accept?"
   *
   * The trust prompt is normally pre-empted by Accounts.trust(); this is the
   * fallback. A login screen means the account is not logged in, which is
   * handled like any other dead account. Stops at SessionStart or after 90s.
   */
  watchBoot(s) {
    this.stopBootWatch(s);
    const started = Date.now();
    let answering = false;
    const t = setInterval(async () => {
      if (answering) return;
      if (s.state !== 'starting' || Date.now() - started > 90_000) {
        this.stopBootWatch(s);
        if (s.state === 'starting' && Date.now() - started > 90_000) {
          const screen = await this.tmux.capture(s.tmux);
          this.setState(s, 'error', 'Claude did not finish starting within 90s — open the terminal to see why.');
          this.notifier.send('error', { session: s, text: `Claude did not finish starting.\n\n${clip(screen.trim().split('\n').slice(-8).join('\n'), 800)}` });
        }
        return;
      }
      answering = true;
      try {
        const screen = await this.tmux.capture(s.tmux);
        if (/trust this folder/i.test(screen) && /Yes,? I trust/i.test(screen)) {
          await this.choose(s, screen, /Yes,? I trust/i);
        } else if (/Bypass Permissions/i.test(screen) && /Yes,? I accept/i.test(screen)) {
          await this.choose(s, screen, /Yes,? I accept/i);
        } else if (MENU.test(screen) && (await this.handleMenu(s, screen)) === 'dismissed') {
          // a notice at startup, declined
        } else if (/Select login method|Please run \/login|Not logged in/i.test(screen)) {
          this.stopBootWatch(s);
          await this.onError(s, { kind: 'auth', text: 'Not logged in', at: Date.now() }, 'boot');
        }
      } finally {
        answering = false;
      }
    }, 1500);
    this.watchers.set(s.id, t);
  }

  stopBootWatch(s) {
    const t = this.watchers.get(s.id);
    if (t) clearInterval(t);
    this.watchers.delete(s.id);
  }

  /** Move a selection menu's cursor (❯) onto the wanted option and pick it. */
  async choose(s, screen, want) {
    const lines = screen.split('\n');
    const w = lines.findIndex((l) => want.test(l));
    if (w < 0) return false;
    let cur = -1;
    for (let i = Math.max(0, w - 6); i <= Math.min(lines.length - 1, w + 6); i++) {
      if (/^\s*❯/.test(lines[i])) { cur = i; break; }
    }
    if (cur < 0) return false;
    const d = w - cur;
    const keys = d > 0 ? Array(d).fill('Down') : Array(-d).fill('Up');
    if (keys.length) await this.tmux.keys(s.tmux, ...keys);
    await delay(250);
    await this.tmux.keys(s.tmux, 'Enter');
    this.log('boot', `${s.id.slice(0, 8)}: answered "${lines[w].trim()}"`);
    return true;
  }

  /**
   * Answer a notice menu with its decline option. Returns 'dismissed',
   * 'unknown' (a menu we will not guess at), or null (no menu).
   */
  async handleMenu(s, screen = null) {
    const text = screen ?? await this.tmux.capture(s.tmux);
    if (!MENU.test(text)) return null;
    if (text.split('\n').some((l) => DECLINE.test(l))) {
      const ok = await this.choose(s, text, DECLINE);
      if (ok) { await delay(400); return 'dismissed'; }
    }
    return 'unknown';
  }

  /* ── talking to a session ───────────────────────────────────────────── */

  /**
   * Send a message. Typed into the live terminal when there is one; if the
   * process is gone, the session is resumed with the message as its prompt.
   * If the session could return to its preferred model, the message rides
   * that restart instead of an extra one later.
   */
  async send(s, text) {
    const msg = String(text || '').trim();
    if (!msg) throw Object.assign(new Error('Empty message'), { status: 400 });
    if (s.state === 'queued') { s.pendingPrompt = [s.pendingPrompt, msg].filter(Boolean).join('\n\n'); this.store.save(); return; }
    if (s.state === 'starting') throw Object.assign(new Error('Still starting — try again in a moment'), { status: 409 });

    const alive = await this.isAlive(s);
    s.nudges = 0;
    if (!alive) return this.start(s, { prompt: msg });

    const acct = this.accounts.get(s.account);
    const pref = s.model.preferred;
    if (s.model.current !== pref && acct && this.accounts.usable(acct, family(pref))) {
      return this.relaunch(s, { model: pref, prompt: msg, why: `Back on ${this.modelLabel(pref)}` });
    }
    if (s.state === 'paused') {
      // A message is a person saying "try now". Let it through.
      s.pausedUntil = null;
    }
    // A notice menu would take the Enter meant for this message.
    await this.handleMenu(s);
    // A pending question dialog would swallow the text; dismiss it first,
    // so the message becomes the answer.
    if (s.question) { await this.tmux.keys(s.tmux, 'Escape'); await delay(400); }
    await this.type(s, msg);
  }

  async type(s, text) {
    await this.tmux.type(s.tmux, text);
    await delay(200);
    await this.tmux.keys(s.tmux, 'Enter');
    s.lastPromptAt = Date.now();
    s.question = null;
    this.touch(s);
    this.setState(s, 'running', null);
  }

  async interrupt(s) {
    if (await this.isAlive(s)) await this.tmux.keys(s.tmux, 'Escape');
  }

  /** Stop the process. The conversation stays and can be resumed. */
  async end(s) {
    s.expectExit = true;
    this.stopBootWatch(s);
    // Wait for claude to actually exit: it appends to its transcript while
    // shutting down, so deleting the file before then just recreates it.
    const pane = await this.tmux.panePid(s.tmux);
    const pids = pane ? [pane, ...childrenOf(pane)] : [];
    await this.tmux.kill(s.tmux);
    for (let i = 0; i < 40 && pids.some(alivePid); i++) await delay(150);
    this.alive.set(s.id, false);
    this.setState(s, 'stopped', 'Ended from the console');
  }

  async remove(s, { purge = false } = {}) {
    await this.end(s);
    delete this.store.sessions[s.id];
    this.tails.delete(s.id);
    fs.rmSync(this.dir(s), { recursive: true, force: true });
    let purged = false;
    if (purge && this.hasTranscript(s)) {
      try {
        fs.unlinkSync(s.transcript);
        fs.rmSync(s.transcript.replace(/\.jsonl$/, ''), { recursive: true, force: true });
        fs.rmSync(path.join(this.config.DEFAULT_CLAUDE_DIR, 'file-history', s.claudeId), { recursive: true, force: true });
        purged = true;
      } catch { /* leave it */ }
    }
    this.store.save();
    this.emit('removed', s.id);
    return { purged };
  }

  /** Take over a conversation that was started somewhere else. */
  adopt({ id, cwd, title }) {
    if (!UUID.test(String(id))) throw Object.assign(new Error('Not a session id'), { status: 400 });
    const existing = this.byClaudeId(id);
    if (existing) return existing;
    const s = {
      id,
      claudeId: id,
      managed: true,
      adopted: true,
      title: clip(title || path.basename(cwd || '') || id.slice(0, 8), 70),
      titleSource: title ? 'user' : 'auto',
      cwd: cwd || this.config.DEFAULT_CWD,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      state: 'stopped',
      detail: 'Picked up from history — resume to continue it here.',
      model: { preferred: this.settings.defaultModel, current: this.settings.defaultModel, fallback: this.settings.fallbackModel, actual: null },
      account: this.settings.activeAccount,
      unattended: this.settings.unattended,
      autoContinue: 0,
      notifyDone: null,
      nudges: 0,
      launches: 0,
      tmux: `cc-${id.slice(0, 8)}`,
      transcript: findTranscript(this.accounts.projectDirs(), id),
      tailOffset: null, // start at the end: old failures are history, not news
      retries: {},
    };
    this.store.sessions[id] = s;
    this.store.save();
    this.emit('change', s);
    return s;
  }

  /* ── hooks ──────────────────────────────────────────────────────────── */

  onHook(evt) {
    const s = (evt.ojee_session && this.get(evt.ojee_session)) || this.byClaudeId(evt.session_id);
    if (!s) return;
    if (evt.session_id && evt.session_id !== s.claudeId) {
      // A resume that forked to a new id: follow the conversation, not the name.
      s.claudeId = evt.session_id;
      s.transcript = null;
      this.tails.delete(s.id);
    }
    if (evt.transcript_path && !s.transcript && fs.existsSync(evt.transcript_path)) s.transcript = evt.transcript_path;
    this.touch(s);

    switch (evt.hook_event_name) {
      case 'SessionStart': {
        this.stopBootWatch(s);
        s.relaunching = false;
        s.expectExit = false;
        if (s.state === 'starting') this.setState(s, s.launchHadPrompt ? 'running' : 'idle', null);
        break;
      }
      case 'UserPromptSubmit': {
        s.question = null;
        s.lastPromptAt = Date.now();
        this.setState(s, 'running', null);
        break;
      }
      case 'PreToolUse': {
        if (evt.tool_name === 'AskUserQuestion' || evt.tool_name === 'ExitPlanMode') {
          const qs = evt.tool_input?.questions;
          const text = evt.tool_name === 'ExitPlanMode'
            ? `Wants approval for a plan:\n${clip(evt.tool_input?.plan || '', 1200)}`
            : (qs || []).map((x) => `${x.question}${x.options?.length ? `\n${x.options.map((o) => `  • ${o.label}`).join('\n')}` : ''}`).join('\n\n');
          s.question = { text: text || 'Claude is asking something — see the terminal.', at: Date.now() };
          this.setState(s, 'waiting', 'Asked a question');
          this.notifier.send('needsInput', { session: s, text: s.question.text });
        }
        break;
      }
      case 'PostToolUse': {
        if (s.question) { s.question = null; this.setState(s, 'running', null); }
        break;
      }
      case 'Notification': {
        if (evt.notification_type === 'permission_prompt' && s.state !== 'waiting') {
          s.question = { text: evt.message || 'Claude is waiting on a prompt in the terminal.', at: Date.now() };
          this.setState(s, 'waiting', evt.message || 'Waiting in the terminal');
          this.notifier.send('needsInput', { session: s, text: s.question.text });
        }
        break;
      }
      case 'Stop': {
        this.readTranscript(s);
        this.onStop(s, evt.last_assistant_message);
        break;
      }
      case 'SessionEnd': {
        if (!s.relaunching) s.claudeEnded = Date.now();
        break;
      }
      default: break;
    }
    this.store.save();
    this.emit('change', s);
  }

  /** A turn finished. Decide what that means. */
  onStop(s, lastMessage) {
    // A failed request already moved or paused the session this turn.
    if (s.relaunching || s.state === 'paused' || s.state === 'starting') return;
    if (s.errorAt && s.lastPromptAt && s.errorAt >= s.lastPromptAt && s.state === 'error') return;

    const msg = String(lastMessage ?? s.lastAssistant ?? '');
    if (msg) s.lastAssistant = clip(msg, 4000);
    s.question = null;

    const blocked = marker(msg, 'BLOCKED');
    const done = marker(msg, 'DONE');
    if (blocked) {
      this.setState(s, 'blocked', clip(blocked, 300));
      this.notifier.send('blocked', { session: s, text: blocked });
    } else if (done) {
      this.setState(s, 'done', clip(done, 300));
      const want = s.notifyDone ?? this.settings.notify?.done;
      if (want) this.notifier.send('done', { session: s, text: done, force: s.notifyDone === true });
    } else if (asksSomething(msg)) {
      s.question = { text: clip(msg.trim().split('\n\n').slice(-1)[0], 1200), at: Date.now() };
      this.setState(s, 'waiting', 'Asked a question');
      this.notifier.send('needsInput', { session: s, text: s.question.text });
    } else if (s.autoContinue && (s.nudges || 0) < s.autoContinue) {
      s.nudges = (s.nudges || 0) + 1;
      this.setState(s, 'idle', `Nudging it to keep going (${s.nudges}/${s.autoContinue})`);
      setTimeout(() => {
        if (s.state === 'idle') this.type(s, 'Continue. When the whole task is finished, end with a line starting "DONE:"; if you cannot continue, end with "BLOCKED:" and why.').catch(() => {});
      }, 3000);
    } else {
      this.setState(s, 'idle', null);
    }

    // Asked to move to another account while it was working: now is the
    // first moment that does not cut a turn in half.
    if (s.moveTo && s.moveTo !== s.account) {
      const to = s.moveTo;
      s.moveTo = null;
      this.relaunch(s, { account: to, why: `Moved to ${this.accountLabel(to)}` }).catch((e) => this.log('move', e.message));
    }
  }

  /* ── transcript ─────────────────────────────────────────────────────── */

  readTranscript(s) {
    if (!this.hasTranscript(s)) return;
    let tail = this.tails.get(s.id);
    if (!tail || tail.file !== s.transcript) {
      let offset = s.tailOffset;
      if (offset == null) { try { offset = fs.statSync(s.transcript).size; } catch { offset = 0; } }
      tail = new Tail(s.transcript, offset);
      this.tails.set(s.id, tail);
    }
    const entries = tail.read();
    s.tailOffset = tail.offset;
    if (!entries.length) return;
    this.touch(s);

    let lastErr = null;
    for (const e of entries) {
      if (e.isSidechain) continue;
      if (e.type === 'assistant') {
        const c = classify(e);
        if (c) { lastErr = { c, uuid: e.uuid }; continue; }
        const model = e.message?.model;
        if (model && model !== '<synthetic>') this.noteModel(s, model);
        const text = (e.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) s.lastAssistant = clip(text, 4000);
        // A reply after an error means the error was recovered from.
        lastErr = null;
      } else if ((e.type === 'custom-title' || e.type === 'ai-title') && s.titleSource !== 'user') {
        const t = e.customTitle || e.aiTitle;
        if (t && t !== s.title) { s.title = clip(t, 70); this.emit('change', s); }
      }
    }
    if (lastErr && lastErr.uuid !== s.lastErrorUuid) {
      s.lastErrorUuid = lastErr.uuid;
      this.onError(s, lastErr.c, 'transcript').catch((e) => this.log('error-handler', e.message));
    }
    this.store.save();
  }

  /** Record which model actually answered; notice a native fallback. */
  noteModel(s, model) {
    s.model.actual = model;
    const want = family(s.model.current);
    const got = family(model);
    if (want && got && want !== got && s.fallbackSeenLaunch !== s.launches) {
      s.fallbackSeenLaunch = s.launches;
      this.notifier.send('modelFallback', {
        session: s,
        text: `Asked for ${this.modelLabel(s.model.current)}, answered by ${this.modelLabel(model)} — Claude Code fell back on its own (usually overload).`,
      });
    }
  }

  /* ── failures ───────────────────────────────────────────────────────── */

  async onError(s, c, source) {
    s.lastError = { kind: c.kind, text: c.text, at: c.at || Date.now(), source };
    s.errorAt = Date.now();
    const acct = this.accounts.get(s.account);
    const set = this.settings;
    this.log('error', `${s.id.slice(0, 8)} ${c.kind}: ${clip(c.text, 120)}`);

    switch (c.kind) {
      case 'model-limit': {
        const fam = c.family || family(s.model.current);
        const until = retryAt(c, { modelRetryHours: set.modelRetryHours });
        if (acct) this.accounts.markModelLimited(acct, fam, { until, text: c.text });
        const fb = s.model.fallback;
        if (fb && family(fb) !== fam && acct && this.accounts.usable(acct, family(fb))) {
          const why = `${this.familyLabel(fam)} ran out on ${acct.label}, so this session moved to ${this.modelLabel(fb)}.`;
          await this.relaunch(s, { model: fb, prompt: continueText(why), why: `${this.familyLabel(fam)} limit — continuing on ${this.modelLabel(fb)}` });
          this.notifier.send('modelFallback', { session: s, text: `${c.text}\n\nContinuing on ${this.modelLabel(fb)}. ${this.familyLabel(fam)} is tried again after ${fmt(until)}.`, tag: `modelFallback:${acct.id}:${fam}` });
          return;
        }
        return this.moveOrPause(s, c.text);
      }
      case 'account-limit': {
        if (acct) this.accounts.markAccountLimited(acct, { until: retryAt(c), window: c.window, text: c.text });
        return this.moveOrPause(s, c.text);
      }
      case 'auth': {
        if (acct) {
          this.accounts.markNeedsLogin(acct, c.text);
          this.notifier.send('needsLogin', {
            session: s,
            title: `${acct.label} needs to log in again`,
            text: `${c.text}\n\nLog it back in from Agent → Claude → Accounts.`,
            tag: `needsLogin:${acct.id}`,
          });
        }
        return this.moveOrPause(s, c.text);
      }
      case 'throttled':
      case 'transient': {
        const n = (s.retries[c.kind] || 0) + 1;
        s.retries[c.kind] = n;
        const wait = c.kind === 'throttled' ? 5 * MINUTE : 2 * MINUTE;
        if (n <= 3) {
          this.pause(s, Date.now() + wait, `${c.kind === 'throttled' ? 'Rate limited' : 'API error'} — retrying (${n}/3): ${clip(c.text, 160)}`);
          return;
        }
        s.retries[c.kind] = 0;
        if (c.kind === 'throttled') {
          if (acct) this.accounts.markAccountLimited(acct, { until: Date.now() + 60 * MINUTE, window: null, text: c.text });
          return this.moveOrPause(s, c.text);
        }
        this.setState(s, 'error', clip(c.text, 300));
        this.notifier.send('error', { session: s, text: `${c.text}\n\nRetried three times; left for you to look at.` });
        return;
      }
      default: {
        this.setState(s, 'error', clip(c.text, 300));
        this.notifier.send('error', { session: s, text: c.text });
      }
    }
  }

  /**
   * The session's account cannot continue. Move it to another account if
   * that is allowed and one is usable; otherwise wait for the soonest reset.
   */
  async moveOrPause(s, why) {
    const from = this.accounts.get(s.account);
    if (this.settings.autoSwitchAccounts) {
      const pick = this.pickAccountModel(s);
      if (pick && pick.account !== s.account) {
        const to = this.accounts.get(pick.account);
        this.store.updateSettings({ activeAccount: to.id });
        await this.relaunch(s, {
          account: to.id,
          model: pick.model,
          prompt: continueText(`The ${from?.label || s.account} account ran out, so this session moved to ${to.label}.`),
          why: `Moved to ${to.label}`,
        });
        this.notifier.send('accountSwitch', {
          session: s,
          title: `Switched from ${from?.label || s.account} to ${to.label}`,
          text: `${why}\n\nSessions on ${from?.label || s.account} move to ${to.label} as they hit the limit. New sessions start on ${to.label}.`,
          tag: `accountSwitch:${from?.id}:${to.id}`,
        });
        this.emit('accounts');
        return;
      }
    }
    return this.pauseAll(s, why);
  }

  pauseAll(s, why) {
    const acct = this.accounts.get(s.account);
    const modelBack = acct ? this.accounts.modelLimitedUntil(acct, family(s.model.preferred)) : null;
    const until = this.accounts.earliestReturn() || modelBack || Date.now() + 60 * MINUTE;
    const auto = this.settings.autoSwitchAccounts;
    this.pause(s, until, `${auto ? 'Every account is out' : 'Out of usage (auto-switch is off)'} — resumes ${fmt(until)}`);
    this.notifier.send('allLimited', {
      session: s,
      title: auto ? 'Every Claude account is out of usage' : `${acct?.label || s.account} is out of usage`,
      text: `${why}\n\nPaused until ${fmt(until)}; it resumes on its own.${auto ? '' : ' Auto-switch is off — switch accounts in Agent → Claude to continue sooner.'}`,
      tag: 'allLimited',
    });
    this.emit('accounts');
  }

  pause(s, until, detail) {
    s.pausedUntil = until;
    s.state = 'paused';
    s.detail = detail;
    s.updatedAt = Date.now();
    this.store.save();
    this.emit('change', s);
  }

  /** A pause ran out: continue on whatever can take it now. */
  async resumePaused(s) {
    const pick = this.pickAccountModel(s);
    if (!pick) {
      const until = this.accounts.earliestReturn() || Date.now() + 30 * MINUTE;
      this.pause(s, until, `Still out of usage — resumes ${fmt(until)}`);
      return;
    }
    const alive = await this.isAlive(s);
    const pending = s.pendingPrompt;
    const note = s.lastError?.kind === 'transient' || s.lastError?.kind === 'throttled'
      ? 'The last request failed with a temporary API error.'
      : 'The session was paused by a usage limit and has now resumed.';
    if (!alive) {
      s.account = pick.account;
      s.model.current = pick.model;
      s.pendingPrompt = '';
      return this.launch(s, { prompt: pending || continueText(note) });
    }
    if (pick.account === s.account && pick.model === s.model.current) {
      return this.type(s, continueText(note));
    }
    return this.relaunch(s, { account: pick.account, model: pick.model, prompt: continueText(note) });
  }

  /**
   * An account is usable again (logged back in, or its limits cleared): the
   * sessions paused waiting for one should not sit out the rest of an hour.
   */
  accountRestored() {
    let n = 0;
    for (const s of this.all()) {
      if (s.state === 'paused') { s.pausedUntil = Date.now(); n += 1; }
    }
    if (n) this.store.save();
    return n;
  }

  /* ── the periodic pass ──────────────────────────────────────────────── */

  async tick() {
    const now = Date.now();
    if (this.accounts.expire(now)) this.emit('accounts');
    const panes = new Map((await this.tmux.list()).map((p) => [p.name, p]));

    for (const s of this.all()) {
      const pane = panes.get(s.tmux);
      const alive = !!pane && !pane.dead;
      this.alive.set(s.id, alive);

      if (alive) this.readTranscript(s);

      // A paused session may have no process; the pause stands and resuming
      // relaunches it, so it falls through to the pause check below.
      if (LIVE.has(s.state) && s.state !== 'paused' && !alive && !s.relaunching && !this.busyOps.has(s.id)) {
        if (s.launchedAt && now - s.launchedAt < 5000) continue;
        this.readTranscript(s);
        if (!LIVE.has(s.state) || s.state === 'paused' || s.relaunching) continue;
        const code = pane?.status ?? lastExit(this.dir(s));
        this.stopBootWatch(s);
        if (s.expectExit) {
          this.setState(s, 'stopped', 'Ended');
        } else if (code === 0 || code == null) {
          this.setState(s, 'stopped', 'Claude exited');
        } else {
          this.setState(s, 'error', `Claude exited with code ${code}`);
          this.notifier.send('error', { session: s, text: `Claude exited unexpectedly (code ${code}). The conversation is kept; resume it from the console.` });
        }
        continue;
      }

      if (s.state === 'paused' && s.pausedUntil && now >= s.pausedUntil && !this.busyOps.has(s.id)) {
        await this.resumePaused(s).catch((e) => this.log('resume', e.message));
        continue;
      }

      // Between turns, a notice menu may be sitting on the screen.
      if (alive && ['idle', 'done', 'blocked', 'waiting', 'error'].includes(s.state) && !this.busyOps.has(s.id)) {
        const screen = await this.tmux.capture(s.tmux);
        const menu = await this.handleMenu(s, screen);
        if (menu === 'dismissed') this.log('menu', `${s.id.slice(0, 8)}: declined a notice`);
        else if (menu === 'unknown' && !s.question) {
          const lines = screen.split('\n').filter((l) => l.trim());
          const at = lines.findIndex((l) => MENU.test(l));
          s.question = { text: lines.slice(Math.max(0, at - 6), at + 1).join('\n').trim(), at: Date.now(), screen: true };
          this.setState(s, 'waiting', 'A prompt is open in the terminal');
          this.notifier.send('needsInput', { session: s, text: s.question.text });
        } else if (!menu && s.question?.screen) {
          // Answered in the terminal.
          s.question = null;
          this.setState(s, 'idle', null);
        }
      }

      const stallMs = (this.settings.stallMinutes || 20) * MINUTE;
      if (s.state === 'running' && alive && now - (s.lastActivityAt || now) > stallMs && !s.stallNotified) {
        s.stallNotified = true;
        const screen = await this.tmux.capture(s.tmux);
        this.notifier.send('stalled', {
          session: s,
          text: `Nothing new for ${this.settings.stallMinutes} minutes. The last lines on screen:\n\`\`\`\n${clip(screen.trim().split('\n').filter((l) => l.trim()).slice(-8).join('\n'), 900)}\n\`\`\``,
        });
        this.emit('change', s);
      }
    }

    await this.startQueued();
  }

  async startQueued() {
    const max = this.settings.maxRunning || 3;
    const queued = this.all().filter((s) => s.state === 'queued').sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    for (const s of queued) {
      if (this.busyCount() >= max) break;
      await this.start(s);
    }
  }

  /**
   * After a runner restart: re-attach to every session whose tmux session
   * survived, and deal with the ones that did not (a reboot kills tmux).
   */
  async reconcile() {
    const panes = new Map((await this.tmux.list()).map((p) => [p.name, p]));
    for (const s of this.all()) {
      const pane = panes.get(s.tmux);
      const alive = !!pane && !pane.dead;
      this.alive.set(s.id, alive);
      s.relaunching = false;
      if (alive || !LIVE.has(s.state)) continue;
      if (s.state === 'paused') continue; // resumes on schedule, relaunching then
      const wasWorking = s.state === 'running' || s.state === 'starting';
      if (wasWorking && this.settings.resumeInterrupted) {
        this.log('reconcile', `${s.id.slice(0, 8)} was ${s.state} and its process is gone — resuming`);
        this.notifier.send('error', { session: s, title: `${s.title} was interrupted`, text: 'Its process was gone when the runner started (a reboot, or tmux was restarted). Resuming it.' });
        await this.start(s, { prompt: continueText('This session was interrupted by a restart of the machine or its session host.') });
      } else {
        this.setState(s, 'stopped', 'Its process ended while the runner was down');
      }
    }
    this.store.save();
  }
}

function lastExit(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, 'exits'), 'utf8').trim().split('\n');
    const n = Number(lines[lines.length - 1].split(' ')[0]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function fmt(ms) {
  if (!ms) return 'later';
  const d = new Date(ms);
  const tz = process.env.TIMEZONE || undefined;
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return sameDay ? time : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })} ${time}`;
}

module.exports = { Sessions, asksSomething, marker, LIVE, BUSY, fmt };
