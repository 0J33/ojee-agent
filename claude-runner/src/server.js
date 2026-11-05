/**
 * claude-runner — unattended Claude Code sessions on this machine.
 *
 * The host half of the agent module's Claude view. The module (a container)
 * cannot start a session in an arbitrary folder or share the user's own
 * ~/.claude, so this runs on the host as a systemd user service and the
 * module proxies to it. Nothing here renders UI.
 *
 * Two listeners:
 *   HOST:PORT   the API the module calls. Bearer token required. On the HP
 *               box HOST is the tailnet address — the token and the tailnet
 *               are the boundary, so it is never 0.0.0.0.
 *   HOOK_SOCK   a Unix socket in $XDG_RUNTIME_DIR for bin/hook.js. Only this
 *               user can open it, so it needs no token.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { Store } = require('./store');
const { Tmux } = require('./tmux');
const { Accounts, cleanEnv } = require('./accounts');
const { Notifier } = require('./notify');
const { Sessions } = require('./sessions');
const { Tail, toMessages, readRange, listSessions, findTranscript, listSubagents, subagentFile, finishedAgents } = require('./transcript');
const { parseScreen } = require('./screen');
const { enterWhenTyped } = require('./submit');

/** A browser file name made safe for a path: no folders, no shell-hostile characters. */
function safeName(raw, type) {
  let name = '';
  try { name = decodeURIComponent(String(raw || '')); } catch { name = String(raw || ''); }
  name = name.split(/[\\/]/).pop().replace(/[^\w.-]+/g, '_').replace(/^[.]+/, '').slice(-80);
  if (!name) {
    const sub = String(type || '').split(';')[0].split('/')[1] || 'bin';
    name = `pasted.${sub.replace(/[^\w]+/g, '').slice(0, 10) || 'bin'}`;
  }
  return name;
}
const logins = require('./logins');
const { bridge } = require('./terminal');
const { Governor } = require('./governor');

const VERSION = require('../package.json').version;
const ROOT = path.resolve(__dirname, '..');
const log = (tag, ...a) => console.log(new Date().toISOString(), `[${tag}]`, ...a);

/* ── files the runner writes for claude ────────────────────────────────── */

const filesFor = (cfg) => ({
  sessionSh: path.join(ROOT, 'bin', 'session.sh'),
  settingsFile: path.join(cfg.STATE_DIR, 'claude-settings.json'),
  unattendedFile: path.join(cfg.STATE_DIR, 'unattended.md'),
  // In the repo, not written at start: ojee-claude-tmux.service reads it,
  // and may start before the runner has ever run.
  tmuxConf: path.join(ROOT, 'deploy', 'tmux.conf'),
});

/**
 * The settings every runner session gets via --settings. They add to the
 * user's own settings (hooks from every source run), they do not replace them.
 */
function claudeSettings() {
  const node = process.execPath;
  const cmd = (script) => ({ type: 'command', command: `"${node}" "${path.join(ROOT, 'bin', script)}"`, timeout: 5 });
  const hook = [{ hooks: [cmd('hook.js')] }];
  return {
    // The one-time "Bypass Permissions mode — accept?" screen would otherwise
    // stop the first unattended launch on a machine.
    skipDangerousModePermissionPrompt: true,
    // The fullscreen renderer takes mouse input, so clicks in the console's
    // terminal reach Claude (tmux forwards them once the app asks for the
    // mouse). Tested: hooks and typed input behave the same in it. It also
    // retires the "Try the new fullscreen renderer?" offer after turns.
    tui: 'fullscreen',
    hooks: {
      SessionStart: hook,
      SessionEnd: hook,
      UserPromptSubmit: hook,
      Stop: hook,
      Notification: hook,
      SubagentStart: hook,
      SubagentStop: hook,
      PreToolUse: [
        { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [cmd('hook.js')] },
        { matcher: 'Bash', hooks: [cmd('guard.js')] },
      ],
      PostToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [cmd('hook.js')] }],
    },
  };
}

/** One line about the machine: measured, unless the env file says more. */
function machineNote(cfg = config) {
  if (cfg.MACHINE_NOTE) return cfg.MACHINE_NOTE;
  const os = require('os');
  const gb = Math.round(os.totalmem() / 2 ** 30);
  return `This machine (${cfg.DEVICE_LABEL}) is a laptop (${os.cpus().length} threads, ${gb} GB) that also runs other services and overheats under sustained load.`;
}

const unattendedText = (cfg = config) => `You are running unattended, in a session started from the ojee console on this machine. Nobody is watching the terminal while you work.

- Do not stop to ask for confirmation or clarification. Make the most reasonable decision, say what you assumed in your final message, and keep going until the task is complete.
- Ask the user something (with the AskUserQuestion tool) only when you genuinely cannot continue without them — missing credentials, a choice with irreversible consequences, or requirements that contradict each other. Asking sends them a notification.
- When the whole task is finished, end your final message with a line that starts with "DONE:" and a one-line summary.
- If you are blocked and cannot continue, end your final message with a line that starts with "BLOCKED:" and the reason.
- sudo is not available here. Some commands that could take down other services on this machine are blocked; if one is, find another way or end with BLOCKED.
- ${machineNote(cfg)} Run heavy commands (test suites, builds, installs) one at a time, keep their parallelism low (for example vitest or jest with 2 workers), and do not have several subagents run builds or tests at the same time.
- Never kill, signal or attach to processes or tmux sessions you did not start yourself: other Claude Code sessions and the user's own programs may be running on this machine.
`;
const UNATTENDED = unattendedText();


function writeFiles(FILES) {
  for (const d of [config.STATE_DIR, config.RUNTIME_DIR, path.join(config.STATE_DIR, 'sessions'), config.ACCOUNTS_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // Every session's TMPDIR: a missing one breaks mktemp and os.tmpdir().
  try { fs.mkdirSync(config.SESSION_TMPDIR, { recursive: true, mode: 0o700 }); } catch { /* reported by the tools that need it */ }
  fs.writeFileSync(FILES.settingsFile, JSON.stringify(claudeSettings(), null, 2));
  fs.writeFileSync(FILES.unattendedFile, unattendedText(config));
  fs.chmodSync(FILES.sessionSh, 0o755);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function createRunner(overrides = {}) {
  Object.assign(config, overrides);
  const FILES = filesFor(config);
  writeFiles(FILES);

  const store = new Store(path.join(config.STATE_DIR, 'state.json'), {
    settings: config.DEFAULT_SETTINGS,
    accounts: [{ id: 'main', label: 'Main', dir: null, addedAt: Date.now(), limits: {} }],
  });
  const tmuxEnv = cleanEnv(process.env);
  delete tmuxEnv.TMUX;
  delete tmuxEnv.TMUX_PANE;
  const tmux = new Tmux({ bin: config.TMUX_BIN, socket: config.TMUX_SOCKET, conf: FILES.tmuxConf, env: tmuxEnv, mode: config.TMUX_MODE });
  const accounts = new Accounts({ config, store, log });
  // Pings: Discord from here (so they arrive when HP is down), and a
  // `notify` event on /api/events for the console's app channel. Kept for a
  // while so the Agent module, reconnecting, can ask for what it missed.
  const recentNotify = [];
  let emitNotify = () => {};
  const notifier = new Notifier({
    webhook: config.DISCORD_WEBHOOK,
    consoleUrl: config.CONSOLE_URL,
    settings: () => store.settings,
    consolePrefs: () => store.data.consoleNotify,
    deviceLabel: config.DEVICE_LABEL,
    emit: (n) => {
      recentNotify.push(n);
      while (recentNotify.length > 50) recentNotify.shift();
      emitNotify(n);
    },
    log,
  });
  const sessions = new Sessions({ config, store, tmux, accounts, notifier, files: FILES, log });
  // Only when the sessions live in their own unit: in dev (self mode) the
  // tmux server shares the runner's cgroup, and freezing that would freeze us.
  const governor = config.TMUX_MODE === 'systemd'
    ? new Governor({ unit: 'ojee-claude-tmux.service', settings: () => store.settings, thermal: config.THERMAL_BACKOFF, log })
    : null;
  for (const a of accounts.list()) { try { accounts.prepare(a); } catch (e) { log('accounts', `${a.id}: ${e.message}`); } }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const tokenOk = (req) => {
    if (!config.TOKEN) return isLoopback(config.HOST);
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(config.TOKEN);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const auth = (req, res, next) => (tokenOk(req) ? next() : res.status(401).json({ error: 'unauthorized' }));

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    res.status(e.status || 500).json({ error: e.message || String(e) });
  });
  const need = (req) => {
    const s = sessions.get(req.params.id);
    if (!s) throw Object.assign(new Error('No such session'), { status: 404 });
    return s;
  };
  const needAcct = (req) => {
    const a = accounts.get(req.params.id);
    if (!a) throw Object.assign(new Error('No such account'), { status: 404 });
    return a;
  };

  const accountsView = () => accounts.list().map((a) => accounts.describe(a));
  const device = () => ({ id: config.DEVICE_ID, label: config.DEVICE_LABEL });
  const stateView = () => ({
    version: VERSION,
    device: device(),
    sessions: sessions.all().map((s) => sessions.view(s)).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)),
    accounts: accountsView(),
    settings: store.settings,
    models: config.MODELS,
    notify: { enabled: notifier.enabled, recent: notifier.recent.slice(0, 20), console: store.data.consoleNotify ? { at: store.data.consoleNotify.at } : null },
    runner: { tmux: runtime.tmux, claude: runtime.claude, host: config.HOST, port: config.PORT, stackDir: config.STACK_DIR, home: config.HOME, defaultCwd: config.DEFAULT_CWD },
    governor: governor ? governor.view() : { active: false, reason: 'only when sessions run in ojee-claude-tmux.service' },
  });
  const runtime = { tmux: null, claude: null };

  /* ── health, state, events ───────────────────────────────────────── */

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
  app.get('/api/health', auth, (_req, res) => res.json({ ok: true, version: VERSION, device: device(), tmux: runtime.tmux, claude: runtime.claude }));
  app.get('/api/state', auth, (_req, res) => res.json(stateView()));

  app.get('/api/summary', auth, (_req, res) => {
    const all = sessions.all();
    const count = (st) => all.filter((s) => s.state === st).length;
    const active = accounts.get(store.settings.activeAccount);
    res.json({
      device: device(),
      running: count('running') + count('starting'),
      waiting: count('waiting'),
      blocked: count('blocked'),
      paused: count('paused'),
      errors: count('error'),
      queued: count('queued'),
      total: all.length,
      account: active ? { id: active.id, label: active.label, status: accounts.describe(active).status } : null,
      attention: all.filter((s) => ['waiting', 'blocked', 'error'].includes(s.state))
        .map((s) => ({ id: s.id, title: s.title, state: s.state, detail: s.detail })).slice(0, 5),
    });
  });

  const streams = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) { try { res.write(frame); } catch { /* closed */ } }
  };
  emitNotify = (n) => broadcast('notify', n);
  sessions.on('change', (s) => broadcast('session', sessions.view(s)));
  sessions.on('removed', (id) => broadcast('removed', { id }));
  sessions.on('accounts', () => broadcast('accounts', { accounts: accountsView(), settings: store.settings }));

  app.get('/api/events', auth, (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: state\ndata: ${JSON.stringify(stateView())}\n\n`);
    const since = Number(req.query.since);
    if (since > 0) for (const n of recentNotify) if (n.at > since && Date.now() - n.at < 30 * 60_000) res.write(`event: notify\ndata: ${JSON.stringify(n)}\n\n`);
    streams.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    // The RESPONSE closing is the client leaving. The request's own 'close'
    // also fires once a request body has been read, which is not a hang-up.
    res.on('close', () => { clearInterval(ping); streams.delete(res); });
  });

  /* ── folders ──────────────────────────────────────────────────────── */

  app.get('/api/fs', auth, wrap(async (req, res) => {
    const abs = path.resolve(String(req.query.path || config.DEFAULT_CWD));
    const hidden = req.query.hidden === '1';
    let st;
    try { st = fs.statSync(abs); } catch { return res.status(404).json({ error: `${abs} does not exist`, path: abs }); }
    if (!st.isDirectory()) return res.status(400).json({ error: `${abs} is not a folder`, path: abs });
    let list;
    try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {
      return res.status(403).json({ error: `Cannot read ${abs}: ${e.code || e.message}`, path: abs, parent: path.dirname(abs) });
    }
    const entries = [];
    for (const e of list) {
      if (!hidden && e.name.startsWith('.')) continue;
      const p = path.join(abs, e.name);
      let dir = e.isDirectory();
      if (e.isSymbolicLink()) { try { dir = fs.statSync(p).isDirectory(); } catch { dir = false; } }
      if (!dir) continue;
      entries.push({ name: e.name, path: p, git: fs.existsSync(path.join(p, '.git')), hidden: e.name.startsWith('.') });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const recent = [...new Set(sessions.all().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((s) => s.cwd))].slice(0, 8);
    res.json({
      path: abs,
      parent: abs === '/' ? null : path.dirname(abs),
      home: config.HOME,
      git: fs.existsSync(path.join(abs, '.git')),
      entries: entries.slice(0, 1000),
      truncated: entries.length > 1000,
      recent,
    });
  }));

  app.post('/api/fs/mkdir', auth, wrap(async (req, res) => {
    const abs = path.resolve(String(req.body.path || ''));
    if (!req.body.path) return res.status(400).json({ error: 'path required' });
    fs.mkdirSync(abs, { recursive: true });
    res.json({ ok: true, path: abs });
  }));

  /* ── sessions ─────────────────────────────────────────────────────── */

  app.get('/api/sessions', auth, (_req, res) => res.json({ sessions: stateView().sessions }));

  app.post('/api/sessions', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const s = await sessions.create({
      cwd: b.cwd,
      prompt: b.prompt,
      title: b.title,
      model: b.model || undefined,
      fallback: b.fallback === undefined ? undefined : b.fallback,
      account: b.account || undefined,
      unattended: b.unattended,
      autoContinue: b.autoContinue,
      notifyDone: b.notifyDone ?? null,
    });
    res.status(201).json(sessions.view(s));
  }));

  app.get('/api/sessions/:id', auth, wrap(async (req, res) => res.json(sessions.view(need(req)))));

  app.patch('/api/sessions/:id', auth, wrap(async (req, res) => {
    const s = need(req);
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) {
      s.title = b.title.trim().slice(0, 70);
      s.titleSource = 'user';
      // Where the conversation file ended when this rename happened: a
      // /rename further down than this is newer and wins.
      try { if (sessions.hasTranscript(s)) s.titleOffset = fs.statSync(s.transcript).size; } catch { /* no file yet */ }
    }
    if (b.notifyDone !== undefined) s.notifyDone = b.notifyDone === null ? null : !!b.notifyDone;
    if (b.autoContinue !== undefined) s.autoContinue = Math.max(0, Math.min(10, Number(b.autoContinue) || 0));
    if (b.unattended !== undefined) s.unattended = !!b.unattended;
    if (b.account !== undefined) {
      if (!accounts.get(b.account)) return res.status(400).json({ error: 'No such account' });
      s.account = b.account;
    }
    if (b.model?.preferred) s.model.preferred = b.model.preferred;
    if (b.model && 'fallback' in b.model) s.model.fallback = b.model.fallback || null;
    store.save();
    sessions.emit('change', s);
    res.json(sessions.view(s));
  }));

  app.post('/api/sessions/:id/message', auth, wrap(async (req, res) => {
    const s = need(req);
    await sessions.send(s, req.body?.text);
    res.json(sessions.view(s));
  }));

  app.post('/api/sessions/:id/interrupt', auth, wrap(async (req, res) => {
    await sessions.interrupt(need(req));
    res.json({ ok: true });
  }));

  app.post('/api/sessions/:id/end', auth, wrap(async (req, res) => {
    const s = need(req);
    await sessions.end(s);
    res.json(sessions.view(s));
  }));

  app.post('/api/sessions/:id/resume', auth, wrap(async (req, res) => {
    const s = need(req);
    // Resume now is a person saying "try it": it goes ahead even when every
    // account is recorded as spent, because the record may be stale.
    if (await sessions.isAlive(s)) {
      if (s.state === 'paused') { s.pausedUntil = Date.now(); await sessions.resumePaused(s, { force: true }); }
      return res.json(sessions.view(s));
    }
    await sessions.start(s, { prompt: String(req.body?.prompt || ''), force: true });
    res.json(sessions.view(s));
  }));

  /** Move a session to another model or account now, keeping the conversation. */
  app.post('/api/sessions/:id/relaunch', auth, wrap(async (req, res) => {
    const s = need(req);
    const b = req.body || {};
    if (b.account && !accounts.get(b.account)) return res.status(400).json({ error: 'No such account' });
    if (b.model && !config.MODELS.some((m) => m.id === b.model)) return res.status(400).json({ error: 'Unknown model' });
    if (b.model) s.model.preferred = b.model;
    await sessions.relaunch(s, { model: b.model, account: b.account, prompt: String(b.prompt || ''), why: 'Restarted from the console' });
    res.json(sessions.view(s));
  }));

  app.delete('/api/sessions/:id', auth, wrap(async (req, res) => {
    const s = need(req);
    res.json(await sessions.remove(s, { purge: req.query.purge === '1' }));
  }));

  /**
   * A transcript file, read the way the console asks: the tail first, then
   * what is new after `cursor`, or (detail) whole lines before `before`.
   * The main session's file and a subagent's are served the same way.
   */
  function sendTranscript(file, req, res, { sidechain = false } = {}) {
    const size = fs.statSync(file).size;
    const detail = req.query.detail === '1';
    const opts = { detail, sidechain };
    if (detail && req.query.before != null) {
      // Paging back: the whole lines that end at `before`, about 2 MB of them.
      const before = Math.min(size, Math.max(0, Number(req.query.before) || 0));
      const r = readRange(file, Math.max(0, before - 2 * 1024 * 1024), before);
      return res.json({ messages: toMessages(r.entries, opts), start: r.start, truncated: r.start > 0, file });
    }
    let cursor = req.query.cursor != null ? Number(req.query.cursor) : null;
    let truncated = false;
    if (detail && (cursor == null || !Number.isFinite(cursor) || cursor > size)) {
      // First load, detailed: the last 2 MB as whole lines, every message in
      // them, and where they start, so the reader can page back from there.
      const r = readRange(file, Math.max(0, size - 2 * 1024 * 1024), size);
      return res.json({ messages: toMessages(r.entries, opts), cursor: r.end, start: r.start, truncated: r.start > 0, file });
    }
    // First load: the tail only. A long session's file runs to hundreds of MB.
    if (cursor == null || !Number.isFinite(cursor) || cursor > size) {
      cursor = Math.max(0, size - 3 * 1024 * 1024);
      truncated = cursor > 0;
    }
    const tail = new Tail(file, cursor);
    const entries = tail.read(8 * 1024 * 1024);
    // Starting mid-file, the first line is almost always a fragment.
    const messages = toMessages(entries, opts);
    return res.json({
      messages: req.query.cursor == null ? messages.slice(-400) : messages,
      cursor: tail.offset - Buffer.byteLength(tail.partial),
      truncated: truncated || (req.query.cursor == null && messages.length > 400),
      file,
    });
  }

  app.get('/api/sessions/:id/transcript', auth, wrap(async (req, res) => {
    const s = need(req);
    if (!sessions.hasTranscript(s)) return res.json({ messages: [], cursor: 0, start: 0, file: null });
    sendTranscript(s.transcript, req, res);
  }));

  /**
   * The session's subagents (Task/Agent runs, background agents), newest
   * first: id, type, description, the call that launched it, and whether it
   * is still running (the hooks say so, or its file changed a moment ago).
   */
  app.get('/api/sessions/:id/agents', auth, wrap(async (req, res) => {
    const s = need(req);
    if (!sessions.hasTranscript(s)) return res.json({ agents: [] });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 40));
    const live = new Set((s.background || []).filter((t) => t.type === 'subagent').map((t) => t.id));
    // Finished = a completed/failed/stopped notification is in the log. An
    // agent waiting on its own background work has none yet, so it is still
    // running (as Claude Code's own agent list shows it). One silent for two
    // hours with no notification was lost (a restart): not running.
    const done = finishedAgents(s.transcript);
    const now = Date.now();
    res.json({
      agents: listSubagents(s.transcript, { limit }).map((a) => ({
        ...a,
        // Writing in the last 5 minutes beats an old notification: a resumed
        // agent keeps the "completed" one from its earlier run.
        running: live.has(a.id) || now - a.modified < 300_000 || (!done.has(a.id) && now - a.modified < 2 * 3600_000),
      })),
    });
  }));

  app.get('/api/sessions/:id/agents/:agentId/transcript', auth, wrap(async (req, res) => {
    const s = need(req);
    const file = sessions.hasTranscript(s) ? subagentFile(s.transcript, req.params.agentId) : null;
    if (!file) return res.status(404).json({ error: 'No such subagent' });
    sendTranscript(file, req, res, { sidechain: true });
  }));

  /**
   * What the terminal shows right now that the transcript cannot: an open
   * menu (permission prompt, question, /model), the spinner line, background
   * agents, the permission mode, unsent input. Read from the screen.
   */
  app.get('/api/sessions/:id/prompt', auth, wrap(async (req, res) => {
    const s = need(req);
    const alive = await sessions.isAlive(s);
    if (!alive) return res.json({ alive, menu: null, activity: null, agents: [], mode: null, draft: null });
    res.json({ alive, ...parseScreen(await tmux.capture(s.tmux, { ansi: true })) });
  }));

  /**
   * Keys for the session's terminal, from a console with no terminal open:
   * Esc, arrows, Tab, a menu's option, a slash command. Body, any of:
   *   keys:   tmux key names, from the list below
   *   text:   typed literally (newlines become Ctrl+J)
   *   enter:  press Enter after the text
   *   choose: an option number of the menu on screen, picked with the arrows
   *           and Enter the way a person would
   * Unlike /message it never restarts, resumes or switches model: it is the
   * keyboard, nothing more.
   */
  const KEY_NAMES = /^(Escape|Enter|Tab|BTab|Up|Down|Left|Right|PPage|NPage|Home|End|Space|BSpace|DC|C-[a-z]|M-[a-z]|[0-9]|[a-zA-Z])$/;
  app.post('/api/sessions/:id/keys', auth, wrap(async (req, res) => {
    const s = need(req);
    const b = req.body || {};
    const keys = Array.isArray(b.keys) ? b.keys.map(String) : [];
    if (keys.length > 40 || keys.some((k) => !KEY_NAMES.test(k))) return res.status(400).json({ error: 'Unknown key' });
    const text = typeof b.text === 'string' ? b.text : '';
    if (text.length > 20000) return res.status(400).json({ error: 'Too long' });
    if (!(await sessions.isAlive(s))) return res.status(409).json({ error: 'The session is not running. Resume it first.' });
    if (b.choose != null) {
      const n = Number(b.choose);
      const { menu } = parseScreen(await tmux.capture(s.tmux));
      const want = menu?.options.findIndex((o) => o.n === n);
      if (!menu || want == null || want < 0) return res.status(409).json({ error: 'That menu is no longer open' });
      const cur = Math.max(0, menu.options.findIndex((o) => o.selected));
      const d = want - cur;
      const moves = d > 0 ? Array(d).fill('Down') : Array(-d).fill('Up');
      if (moves.length) await tmux.keys(s.tmux, ...moves);
      await new Promise((r) => setTimeout(r, 150));
      await tmux.keys(s.tmux, 'Enter');
    } else {
      if (keys.length) await tmux.keys(s.tmux, ...keys);
      if (text) await tmux.type(s.tmux, text);
      if (text && b.enter) { if (!(await enterWhenTyped(tmux, s.tmux))) return res.status(409).json({ error: 'Typed but not sent: the input box still showed Claude Code\'s suggestion. Check the terminal.' }); }
      else if (!text && b.enter) await tmux.keys(s.tmux, 'Enter');
    }
    sessions.touch(s);
    res.json(sessions.view(s));
  }));

  /**
   * An image pasted in the browser. Saved on this machine, then its path is
   * pasted into the session as a bracketed paste — tested: Claude Code turns
   * a pasted image path into an [Image #n] attachment (typing it would not).
   * Any other file (a PDF, a video, a log) is saved the same way and its path
   * pasted as text, so Claude can open it with its own tools.
   */
  const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const pastePath = async (s, buf, name, tail = '') => {
    const dir = path.join(config.STATE_DIR, 'uploads', s.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${name}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    await tmux.run(['load-buffer', '-b', 'ojee-image', '-'], { input: `${file}${tail}` });
    await tmux.run(['paste-buffer', '-p', '-d', '-b', 'ojee-image', '-t', `=${s.tmux}:`]);
    return file;
  };
  app.post('/api/sessions/:id/image', auth, express.raw({ type: 'image/*', limit: '20mb' }), wrap(async (req, res) => {
    const s = need(req);
    const ext = IMAGE_TYPES[String(req.get('content-type') || '').split(';')[0].trim()];
    if (!ext) return res.status(415).json({ error: 'PNG, JPEG, GIF or WebP only' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty image' });
    if (!(await sessions.isAlive(s))) return res.status(409).json({ error: 'The session is not running — resume it first.' });
    res.json({ ok: true, path: await pastePath(s, req.body, `pasted.${ext}`) });
  }));
  app.post('/api/sessions/:id/file', auth, express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
    const s = need(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty file' });
    if (!(await sessions.isAlive(s))) return res.status(409).json({ error: 'The session is not running — resume it first.' });
    res.json({ ok: true, path: await pastePath(s, req.body, safeName(req.get('x-file-name'), req.get('content-type')), ' ') });
  }));

  app.get('/api/sessions/:id/screen', auth, wrap(async (req, res) => {
    const s = need(req);
    // ?history=N adds that many lines of scrollback, joined where the pane
    // wrapped them (for copying out of it). Without it: the screen, as ever.
    const history = Math.min(5000, Math.max(0, Number(req.query.history) || 0));
    res.json({ alive: await sessions.isAlive(s), screen: await tmux.capture(s.tmux, history ? { history, join: true } : {}) });
  }));

  /* ── history: every conversation on the machine ──────────────────── */

  app.get('/api/history', auth, wrap(async (_req, res) => {
    const list = listSessions(accounts.projectDirs(), { limit: 80 });
    const live = await agentsJson();
    const liveIds = new Map(live.map((a) => [a.sessionId, a]));
    res.json({
      sessions: list.map((h) => {
        const managed = sessions.byClaudeId(h.id);
        const l = liveIds.get(h.id);
        return {
          ...h,
          file: undefined,
          managed: managed ? managed.id : null,
          runningElsewhere: !!l && !managed,
          liveStatus: l?.status || null,
        };
      }),
    });
  }));

  app.post('/api/history/:id/adopt', auth, wrap(async (req, res) => {
    const id = req.params.id;
    const file = findTranscript(accounts.projectDirs(), id);
    if (!file) return res.status(404).json({ error: 'No conversation with that id' });
    // A conversation open in a terminal somewhere else on this machine (the
    // user's own claude, another tool) is theirs: resuming it here too would
    // run two processes on one conversation. Only when asked twice.
    if (!req.body?.force) {
      const live = (await agentsJson()).find((a) => a.sessionId === id);
      if (live && !sessions.byClaudeId(id)) return res.status(409).json({ error: 'That conversation is running in a terminal on this machine. Close it there first.', reason: 'running-elsewhere' });
    }
    const info = require('./transcript').describe(file);
    const s = sessions.adopt({ id, cwd: req.body?.cwd || info.cwd, title: req.body?.title || info.title || info.firstPrompt });
    res.json(sessions.view(s));
  }));

  /* ── accounts ─────────────────────────────────────────────────────── */

  app.get('/api/accounts', auth, (_req, res) => res.json({ accounts: accountsView(), activeAccount: store.settings.activeAccount }));

  app.post('/api/accounts', auth, wrap(async (req, res) => {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label required' });
    const a = accounts.add(label);
    await accounts.status(a);
    sessions.emit('accounts');
    res.status(201).json(accounts.describe(a));
  }));

  app.patch('/api/accounts/:id', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    if (req.body?.label) a.label = String(req.body.label).trim().slice(0, 40);
    store.save();
    sessions.emit('accounts');
    res.json(accounts.describe(a));
  }));

  app.delete('/api/accounts/:id', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    const using = sessions.all().filter((s) => s.account === a.id && ['starting', 'running', 'waiting', 'paused'].includes(s.state));
    if (using.length) return res.status(409).json({ error: `${using.length} session(s) are using ${a.label}. Move or end them first.` });
    const r = accounts.remove(a.id);
    sessions.emit('accounts');
    res.json(r);
  }));

  app.post('/api/accounts/:id/refresh', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    await accounts.status(a);
    sessions.emit('accounts');
    res.json(accounts.describe(a));
  }));

  /** Forget recorded limits — for when you know an account is fine again. */
  app.post('/api/accounts/:id/clear-limits', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    a.limits = {};
    store.save();
    sessions.accountRestored();
    sessions.emit('accounts');
    res.json(accounts.describe(a));
  }));

  /**
   * Make an account the active one: new sessions start on it. With
   * `move: true`, sessions on other accounts move too — now if they are
   * between turns, at the end of the turn if they are working.
   */
  app.post('/api/accounts/:id/activate', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    store.updateSettings({ activeAccount: a.id });
    let moved = 0;
    if (req.body?.move) {
      for (const s of sessions.all()) {
        if (s.account === a.id) continue;
        if (['idle', 'done', 'blocked', 'waiting', 'error'].includes(s.state) && await sessions.isAlive(s)) {
          await sessions.relaunch(s, { account: a.id, why: `Moved to ${a.label}` });
          moved += 1;
        } else if (s.state === 'paused') {
          s.account = a.id;
          s.pausedUntil = Date.now();
          moved += 1;
        } else if (s.state === 'running' || s.state === 'starting') {
          s.moveTo = a.id;
          moved += 1;
        } else {
          s.account = a.id;
        }
      }
      store.save();
    }
    sessions.emit('accounts');
    res.json({ ok: true, active: a.id, moved });
  }));

  app.post('/api/accounts/:id/login', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    if (a.dir) accounts.prepare(a);
    const name = await logins.start({ tmux, accounts, config }, a);
    loginSeen.delete(a.id);
    watchLogin(a);
    res.json({ ok: true, tmux: name });
  }));

  /**
   * Whoever notices a finished login first — this poll or the watcher —
   * re-reads the account. The watcher lives in memory and does not survive a
   * runner restart; the page polling this does.
   */
  const loginSeen = new Set();
  async function loginFinished(a) {
    if (loginSeen.has(a.id)) return;
    loginSeen.add(a.id);
    const auth = await accounts.status(a);
    if (auth.loggedIn) sessions.accountRestored();
    sessions.emit('accounts');
  }

  app.get('/api/accounts/:id/login', auth, wrap(async (req, res) => {
    const a = needAcct(req);
    const st = await logins.state({ tmux }, a);
    if (st.finished) await loginFinished(a);
    res.json(st);
  }));

  app.post('/api/accounts/:id/login/code', auth, wrap(async (req, res) => {
    await logins.submitCode({ tmux }, needAcct(req), req.body?.code || '');
    res.json({ ok: true });
  }));

  app.delete('/api/accounts/:id/login', auth, wrap(async (req, res) => {
    await logins.cancel({ tmux }, needAcct(req));
    res.json({ ok: true });
  }));

  /** When a login finishes, re-read that account's status and say so. */
  const loginWatch = new Map();
  function watchLogin(a) {
    clearInterval(loginWatch.get(a.id));
    const started = Date.now();
    const t = setInterval(async () => {
      const st = await logins.state({ tmux }, a);
      if (st.finished || !st.running || Date.now() - started > 15 * 60_000) {
        clearInterval(t);
        loginWatch.delete(a.id);
        if (st.finished) await loginFinished(a);
        else { await accounts.status(a); sessions.emit('accounts'); }
      }
    }, 2000);
    loginWatch.set(a.id, t);
  }

  /* ── settings and notifications ───────────────────────────────────── */

  app.get('/api/settings', auth, (_req, res) => res.json(store.settings));

  app.get('/api/governor', auth, (_req, res) => res.json(governor ? governor.view() : { active: false, reason: 'only when sessions run in ojee-claude-tmux.service' }));

  app.put('/api/settings', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    const known = new Set(config.MODELS.map((m) => m.id));
    if (b.defaultModel !== undefined) {
      if (!known.has(b.defaultModel)) return res.status(400).json({ error: 'Unknown default model' });
      patch.defaultModel = b.defaultModel;
    }
    if (b.fallbackModel !== undefined) {
      if (b.fallbackModel && !known.has(b.fallbackModel)) return res.status(400).json({ error: 'Unknown fallback model' });
      patch.fallbackModel = b.fallbackModel || null;
    }
    for (const k of ['autoSwitchAccounts', 'unattended', 'guard', 'resumeInterrupted', 'governor', 'lightFootprint']) {
      if (b[k] !== undefined) patch[k] = !!b[k];
    }
    if (b.maxRunning !== undefined) patch.maxRunning = Math.max(1, Math.min(10, Number(b.maxRunning) || 3));
    if (b.stallMinutes !== undefined) patch.stallMinutes = Math.max(5, Math.min(240, Number(b.stallMinutes) || 20));
    if (b.modelRetryHours !== undefined) patch.modelRetryHours = Math.max(1, Math.min(168, Number(b.modelRetryHours) || 5));
    if (b.cpuCapPct !== undefined) patch.cpuCapPct = Math.max(10, Math.min(100, Number(b.cpuCapPct) || 60));
    if (b.tempTarget !== undefined) patch.tempTarget = Math.max(60, Math.min(95, Number(b.tempTarget) || 80));
    if (b.notify && typeof b.notify === 'object') {
      patch.notify = {};
      for (const k of Object.keys(config.DEFAULT_SETTINGS.notify)) if (b.notify[k] !== undefined) patch.notify[k] = !!b.notify[k];
    }
    const s = store.updateSettings(patch);
    sessions.emit('accounts');
    res.json(s);
  }));

  app.post('/api/notify/test', auth, wrap(async (_req, res) => {
    if (!notifier.enabled) return res.status(409).json({ error: 'No webhook — set CLAUDE_DISCORD_WEBHOOK in the runner\'s env file.' });
    const ok = await notifier.send('done', { title: `Test from the Claude runner on ${config.DEVICE_LABEL}`, text: 'This is a test from Settings → Notifications. If you can read this, pings from this runner work.', force: true, test: true, tag: `test:${Date.now()}` });
    res.json({ ok, device: config.DEVICE_LABEL });
  }));

  /** The console's notification choices, relayed by the Agent module. */
  app.put('/api/notify-prefs', auth, (req, res) => {
    const b = req.body || {};
    if (!b.types || typeof b.types !== 'object') return res.status(400).json({ error: 'types is required' });
    store.data.consoleNotify = { quiet: b.quiet || null, tz: typeof b.tz === 'string' ? b.tz : null, types: b.types, at: Date.now() };
    store.save();
    res.json({ ok: true });
  });

  /* ── the hook socket ──────────────────────────────────────────────── */

  const hookApp = express();
  hookApp.use(express.json({ limit: '4mb' }));
  hookApp.post('/hook', (req, res) => {
    res.json({ ok: true });
    try { sessions.onHook(req.body || {}); } catch (e) { log('hook', e.message); }
  });

  /* ── terminals ────────────────────────────────────────────────────── */

  const wss = new WebSocketServer({ noServer: true });
  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://runner');
    const m = /^\/api\/(sessions|accounts)\/([^/]+)\/terminal$/.exec(url.pathname);
    if (!m || !tokenOk(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    let name;
    // The attach client's own cwd: home, which always exists. The session's
    // folder may have been deleted since, and the pane has its own anyway.
    const cwd = config.HOME;
    if (m[1] === 'sessions') {
      const s = sessions.get(m[2]);
      if (!s) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      name = s.tmux;
    } else {
      const a = accounts.get(m[2]);
      if (!a) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      name = logins.name(a);
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      if (!(await tmux.has(name))) {
        ws.send(JSON.stringify({ t: 'status', state: 'error', detail: 'This session has no running terminal. Resume it first.' }));
        ws.close();
        return;
      }
      // A pane left in tmux's history mode looks blank and ignores keys.
      await tmux.leaveHistory(name);
      bridge(ws, { argv: tmux.attachArgv(name), cols: url.searchParams.get('cols'), rows: url.searchParams.get('rows'), cwd });
    });
  }

  /* ── helpers ──────────────────────────────────────────────────────── */

  function agentsJson() {
    return new Promise((resolve) => {
      execFile(config.CLAUDE_BIN, ['agents', '--json'], { env: cleanEnv(process.env), timeout: 15_000 }, (err, out) => {
        try { resolve(JSON.parse(String(out))); } catch { resolve([]); }
      });
    });
  }

  function version(bin, args) {
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: 15_000 }, (err, out) => resolve(err ? null : String(out).trim().split('\n')[0]));
    });
  }

  /* ── lifecycle ────────────────────────────────────────────────────── */

  let tickTimer = null;
  let authTimer = null;
  let apiServer = null;
  let hookServer = null;

  async function start({ listen = true } = {}) {
    runtime.claude = await version(config.CLAUDE_BIN, ['--version']);
    runtime.tmux = await version(config.TMUX_BIN, ['-V']);
    const up = await tmux.ensureServer(config.TMUX_MODE);
    if (governor) await governor.start();
    if (!up) log('tmux', config.TMUX_MODE === 'systemd' ? 'server not running — is ojee-claude-tmux.service up?' : 'could not start the tmux server');
    await accounts.refreshAll().catch(() => {});
    await sessions.reconcile();

    if (listen) {
      try { fs.unlinkSync(config.HOOK_SOCK); } catch { /* none */ }
      hookServer = http.createServer(hookApp);
      await new Promise((r) => hookServer.listen(config.HOOK_SOCK, r));
      fs.chmodSync(config.HOOK_SOCK, 0o600);

      apiServer = http.createServer(app);
      apiServer.on('upgrade', onUpgrade);
      await new Promise((r, j) => { apiServer.once('error', j); apiServer.listen(config.PORT, config.HOST, r); });
      log('runner', `v${VERSION} on ${config.HOST}:${config.PORT} · claude ${runtime.claude || 'missing'} · tmux ${runtime.tmux || 'missing'} (${config.TMUX_MODE})`);
      if (!notifier.enabled) log('runner', 'no CLAUDE_DISCORD_WEBHOOK — pings are recorded but not sent');
    }

    const loop = async () => {
      try { await sessions.tick(); } catch (e) { log('tick', e.stack || e.message); }
      tickTimer = setTimeout(loop, config.TICK_MS);
    };
    tickTimer = setTimeout(loop, 1000);
    authTimer = setInterval(() => accounts.refreshAll().then(() => sessions.emit('accounts')).catch(() => {}), config.AUTH_CHECK_MS);
  }

  async function stop() {
    governor?.stop();
    clearTimeout(tickTimer);
    clearInterval(authTimer);
    for (const t of loginWatch.values()) clearInterval(t);
    for (const s of sessions.all()) sessions.stopBootWatch(s);
    for (const res of streams) { try { res.end(); } catch { /* closed */ } }
    await new Promise((r) => (apiServer ? apiServer.close(r) : r()));
    await new Promise((r) => (hookServer ? hookServer.close(r) : r()));
    store.flush();
  }

  return { app, start, stop, store, sessions, accounts, tmux, notifier, config, onUpgrade, governor };
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

if (require.main === module) {
  if (!config.TOKEN && !isLoopback(config.HOST)) {
    console.error(`FATAL: RUNNER_TOKEN must be set when listening on ${config.HOST}.`);
    process.exit(1);
  }
  const runner = createRunner();
  runner.start().catch((e) => { console.error(e); process.exit(1); });
  const bye = () => runner.stop().finally(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

module.exports = { createRunner, claudeSettings, UNATTENDED, unattendedText };
