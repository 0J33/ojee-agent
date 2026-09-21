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
const { Tail, toMessages, listSessions, findTranscript } = require('./transcript');
const logins = require('./logins');
const { bridge } = require('./terminal');

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
    hooks: {
      SessionStart: hook,
      SessionEnd: hook,
      UserPromptSubmit: hook,
      Stop: hook,
      Notification: hook,
      PreToolUse: [
        { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [cmd('hook.js')] },
        { matcher: 'Bash', hooks: [cmd('guard.js')] },
      ],
      PostToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [cmd('hook.js')] }],
    },
  };
}

const UNATTENDED = `You are running unattended, in a session started from the ojee console on this machine. Nobody is watching the terminal while you work.

- Do not stop to ask for confirmation or clarification. Make the most reasonable decision, say what you assumed in your final message, and keep going until the task is complete.
- Ask the user something (with the AskUserQuestion tool) only when you genuinely cannot continue without them — missing credentials, a choice with irreversible consequences, or requirements that contradict each other. Asking sends them a notification.
- When the whole task is finished, end your final message with a line that starts with "DONE:" and a one-line summary.
- If you are blocked and cannot continue, end your final message with a line that starts with "BLOCKED:" and the reason.
- sudo is not available here. Some commands that could take down other services on this machine are blocked; if one is, find another way or end with BLOCKED.
`;


function writeFiles(FILES) {
  for (const d of [config.STATE_DIR, config.RUNTIME_DIR, path.join(config.STATE_DIR, 'sessions'), config.ACCOUNTS_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(FILES.settingsFile, JSON.stringify(claudeSettings(), null, 2));
  fs.writeFileSync(FILES.unattendedFile, UNATTENDED);
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
  const tmux = new Tmux({ bin: config.TMUX_BIN, socket: config.TMUX_SOCKET, conf: FILES.tmuxConf, env: tmuxEnv });
  const accounts = new Accounts({ config, store, log });
  const notifier = new Notifier({
    webhook: config.DISCORD_WEBHOOK,
    consoleUrl: config.CONSOLE_URL,
    settings: () => store.settings,
    log,
  });
  const sessions = new Sessions({ config, store, tmux, accounts, notifier, files: FILES, log });
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
  const stateView = () => ({
    version: VERSION,
    sessions: sessions.all().map((s) => sessions.view(s)).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)),
    accounts: accountsView(),
    settings: store.settings,
    models: config.MODELS,
    notify: { enabled: notifier.enabled, recent: notifier.recent.slice(0, 20) },
    runner: { tmux: runtime.tmux, claude: runtime.claude, host: config.HOST, stackDir: config.STACK_DIR, home: config.HOME, defaultCwd: config.DEFAULT_CWD },
  });
  const runtime = { tmux: null, claude: null };

  /* ── health, state, events ───────────────────────────────────────── */

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));
  app.get('/api/health', auth, (_req, res) => res.json({ ok: true, version: VERSION, tmux: runtime.tmux, claude: runtime.claude }));
  app.get('/api/state', auth, (_req, res) => res.json(stateView()));

  app.get('/api/summary', auth, (_req, res) => {
    const all = sessions.all();
    const count = (st) => all.filter((s) => s.state === st).length;
    const active = accounts.get(store.settings.activeAccount);
    res.json({
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
    if (typeof b.title === 'string' && b.title.trim()) { s.title = b.title.trim().slice(0, 70); s.titleSource = 'user'; }
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
    if (await sessions.isAlive(s)) {
      if (s.state === 'paused') { s.pausedUntil = Date.now(); await sessions.resumePaused(s); }
      return res.json(sessions.view(s));
    }
    await sessions.start(s, { prompt: String(req.body?.prompt || '') });
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

  app.get('/api/sessions/:id/transcript', auth, wrap(async (req, res) => {
    const s = need(req);
    if (!sessions.hasTranscript(s)) return res.json({ messages: [], cursor: 0, file: null });
    const size = fs.statSync(s.transcript).size;
    let cursor = req.query.cursor != null ? Number(req.query.cursor) : null;
    let truncated = false;
    // First load: the tail only. A long session's file runs to hundreds of MB.
    if (cursor == null || !Number.isFinite(cursor) || cursor > size) {
      cursor = Math.max(0, size - 3 * 1024 * 1024);
      truncated = cursor > 0;
    }
    const tail = new Tail(s.transcript, cursor);
    const entries = tail.read(8 * 1024 * 1024);
    // Starting mid-file, the first line is almost always a fragment.
    const messages = toMessages(entries);
    res.json({
      messages: req.query.cursor == null ? messages.slice(-400) : messages,
      cursor: tail.offset - Buffer.byteLength(tail.partial),
      truncated: truncated || (req.query.cursor == null && messages.length > 400),
      file: s.transcript,
    });
  }));

  app.get('/api/sessions/:id/screen', auth, wrap(async (req, res) => {
    const s = need(req);
    res.json({ alive: await sessions.isAlive(s), screen: await tmux.capture(s.tmux) });
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
    watchLogin(a);
    res.json({ ok: true, tmux: name });
  }));

  app.get('/api/accounts/:id/login', auth, wrap(async (req, res) => {
    res.json(await logins.state({ tmux }, needAcct(req)));
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
        await accounts.status(a);
        sessions.emit('accounts');
      }
    }, 2000);
    loginWatch.set(a.id, t);
  }

  /* ── settings and notifications ───────────────────────────────────── */

  app.get('/api/settings', auth, (_req, res) => res.json(store.settings));

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
    for (const k of ['autoSwitchAccounts', 'unattended', 'guard', 'resumeInterrupted']) {
      if (b[k] !== undefined) patch[k] = !!b[k];
    }
    if (b.maxRunning !== undefined) patch.maxRunning = Math.max(1, Math.min(10, Number(b.maxRunning) || 3));
    if (b.stallMinutes !== undefined) patch.stallMinutes = Math.max(5, Math.min(240, Number(b.stallMinutes) || 20));
    if (b.modelRetryHours !== undefined) patch.modelRetryHours = Math.max(1, Math.min(168, Number(b.modelRetryHours) || 5));
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
    const ok = await notifier.send('done', { title: 'Test from the Claude runner', text: 'If you can read this, pings work.', force: true, tag: `test:${Date.now()}` });
    res.json({ ok });
  }));

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
    clearTimeout(tickTimer);
    clearInterval(authTimer);
    for (const t of loginWatch.values()) clearInterval(t);
    for (const s of sessions.all()) sessions.stopBootWatch(s);
    for (const res of streams) { try { res.end(); } catch { /* closed */ } }
    await new Promise((r) => (apiServer ? apiServer.close(r) : r()));
    await new Promise((r) => (hookServer ? hookServer.close(r) : r()));
    store.flush();
  }

  return { app, start, stop, store, sessions, accounts, tmux, notifier, config, onUpgrade };
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

module.exports = { createRunner, claudeSettings, UNATTENDED };
