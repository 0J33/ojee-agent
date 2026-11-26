/**
 * ojee-agent, shown in the console as **Claude**: unattended Claude Code
 * sessions on each machine that runs them, through the host runner in
 * claude-runner/ (HP, and LOQ when it is awake).
 *
 * That is the whole module now (26 Nov redesign). What else used to live
 * here is either off or out of sight:
 *   - Assistant, Workflows, Odysseus: off behind AGENT_DISABLE (features.js)
 *   - the stack's containers: a health check that says nothing until
 *     something is wrong, then one line here and an alert
 *   - Work: moved to forsa-aios; only the endpoints HP's Forsa loop still
 *     calls stay, server-side (work-legacy.js)
 *
 * Runs standalone or as an ojee-console module. Authentication is NOT here:
 * mounted, the console has already run three gates (tailnet, TOTP, device
 * trust); standalone, the tailnet is the boundary.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const { exec } = require('child_process');
/* The Assistant: OpenCode's Zen gateway, hosted on this stack as
   `opencode serve` and reached through OPENCODE_URL. */
const fs = require('fs');
const assistantModule = require('./assistant');
const mountWorkLegacy = require('./work-legacy');
const notifyStream = require('./notify-stream');
const features = require('./features');

const PORT = process.env.PORT || 8080;
const TIMEZONE = process.env.TIMEZONE || 'UTC';

/* Where the pieces live. Each is optional: a deployment without Odysseus
   should show a module without an Odysseus section, not a broken one. */
const N8N_URL = (process.env.N8N_URL || 'http://n8n:5678').replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const N8N_DOMAIN = process.env.N8N_DOMAIN || '';
const ODYSSEUS_URL = (process.env.ODYSSEUS_URL || '').replace(/\/+$/, '');
const ODYSSEUS_DOMAIN = process.env.ODYSSEUS_DOMAIN || '';
const COUCHDB_DOMAIN = process.env.COUCHDB_DOMAIN || '';
/* The Claude runners: a host service (claude-runner/ in this repo) on each
   machine that runs sessions, because sessions have to start in any folder on
   that machine and share the user's own ~/.claude — neither of which a
   container can do. */
const RUNNERS = readRunners(process.env);
const CLAUDE_CONFIGURED = RUNNERS.length > 0;

/**
 * Which runners there are, in the order the UI lists them.
 *
 *   CLAUDE_RUNNER_URL / _TOKEN            the first one (HP). The CODE_AGENT_*
 *                                         names the old code-agent used still work.
 *   CLAUDE_RUNNER_ID / _LABEL             its id and label (default hp / HP)
 *   CLAUDE_RUNNER_<ID>_URL / _TOKEN       any other (e.g. _LOQ_); optional
 *   CLAUDE_RUNNER_<ID>_LABEL / _SLEEPS    _SLEEPS=1: a laptop, so being
 *                                         offline is normal, not an alert
 *   CLAUDE_RUNNERS                        or all of it as JSON:
 *                                         [{id,label,url,token,sleeps}]
 */
function readRunners(env) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const out = [];
  const add = (r) => {
    const id = slug(r.id);
    if (!id || !clean(r.url) || out.some((x) => x.id === id)) return;
    out.push({ id, label: String(r.label || id.toUpperCase()), url: clean(r.url), token: String(r.token || ''), sleeps: !!r.sleeps });
  };
  if (env.CLAUDE_RUNNERS) {
    try { for (const r of JSON.parse(env.CLAUDE_RUNNERS)) add(r); } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`CLAUDE_RUNNERS is not valid JSON (${e.message}) — ignored`);
    }
  }
  add({
    id: env.CLAUDE_RUNNER_ID || 'hp',
    label: env.CLAUDE_RUNNER_LABEL || 'HP',
    url: env.CLAUDE_RUNNER_URL || env.CODE_AGENT_URL,
    token: env.CLAUDE_RUNNER_TOKEN || env.CODE_AGENT_TOKEN,
    sleeps: /^(1|true|yes)$/i.test(env.CLAUDE_RUNNER_SLEEPS || ''),
  });
  for (const [k, v] of Object.entries(env)) {
    const m = /^CLAUDE_RUNNER_([A-Z0-9]+)_URL$/.exec(k);
    if (!m) continue;
    const p = `CLAUDE_RUNNER_${m[1]}_`;
    add({ id: m[1], label: env[`${p}LABEL`], url: v, token: env[`${p}TOKEN`], sleeps: /^(1|true|yes)$/i.test(env[`${p}SLEEPS`] || '') });
  }
  return out;
}

const runnerById = (id) => RUNNERS.find((r) => r.id === id) || null;

/* ── notifications ────────────────────────────────────────────────────── */

/**
 * Every alert this module can raise, for the console's Settings → Notifications
 * (each kind listed and switchable) and its inbox. An alert's `key` is
 * `<kind>:<device>:<subject>` — the session or account it is about — so the
 * same thing stays one inbox item however its words or numbers change.
 *
 *   blocking         toast + push (Claude is waiting on you); the rest is
 *                    inbox + badge only
 *   defaultChannels  where it goes until the owner chooses: app, discord
 *   threshold        the condition behind it, where there is one to tune
 *   hold / clearMin  how many checks it must hold before it raises, and how
 *                    long it must be gone before it resolves (flapping)
 */
const kind = (id, label, description, o = {}) => ({
  id,
  label,
  description,
  severity: o.severity || 'warn',          // info | warn | critical
  blocking: !!o.blocking,
  // toast: inbox + toast + push (and through quiet hours); inbox: badge only.
  channel: o.channel || (o.blocking ? 'toast' : o.severity === 'info' && !(o.channels || []).length ? 'off' : 'inbox'),
  discord: (o.channels || []).includes('discord'),
  defaultChannels: o.channels || ['app'],
  view: 'claude',
  discordBy: id.startsWith('agent.claude-') ? 'module' : undefined,
  cooldownMin: 10,
  hold: o.hold ?? 1,
  clearMin: o.clearMin ?? 0,
  ...(o.source ? { source: o.source } : {}),
  ...(o.params ? { params: o.params } : {}),
});
const ALERT_KINDS = [
  kind('agent.claude-needs-input', 'Claude: asks you something', 'A session asked a question, wants a plan approved, or wants permission for a tool. It waits until you answer.', { blocking: true, channels: ['app', 'discord'] }),
  kind('agent.claude-blocked', 'Claude: blocked', 'A session ended its turn with BLOCKED: it cannot go on without you.', { channels: ['app', 'discord'] }),
  kind('agent.claude-error', 'Claude: session error', 'A session failed to start, crashed, or kept failing after three retries.', { severity: 'critical', channels: ['app', 'discord'] }),
  kind('agent.claude-stalled', 'Claude: gone quiet', 'A working session wrote nothing for this long while no tool was running and nothing ran in the background. Long builds and subagents do not count.', { params: [{ key: 'stallMinutes', label: 'Quiet for', type: 'number', unit: 'min', default: 30, min: 5, max: 240 }] }),
  kind('agent.claude-needs-login', 'Claude: account needs login', 'An account is logged out (found by a session or by the check every 15 minutes). Sessions cannot use it until it is logged in again.', { channels: ['app', 'discord'] }),
  kind('agent.claude-account-limited', 'Claude: account limited', 'An account hit its 5-hour or weekly limit; sessions move to another or wait until it resets.', { severity: 'info', channel: 'inbox', clearMin: 5, source: 'alerts' }),
  kind('agent.claude-all-limited', 'Claude: every account out', 'Every account is limited or logged out; sessions are paused until the soonest reset.', { channels: ['app', 'discord'] }),
  kind('agent.claude-model-fallback', 'Claude: switched model', 'A model hit its limit and a session moved to the fallback model.', { severity: 'info', channels: [] }),
  kind('agent.claude-account-switch', 'Claude: switched account', 'An account ran out and sessions moved to another.', { severity: 'info', channels: [] }),
  kind('agent.claude-done', 'Claude: finished', 'A session ended with DONE. Off by default: unattended work finishing is the normal case. A session set to ping when done always does.', { severity: 'info', channels: [] }),
  kind('agent.claude-runner-down', 'Claude: runner not answering', 'The runner on a machine that should be up (not a laptop that sleeps) stopped answering for 3 minutes.', { hold: 6, clearMin: 2, source: 'alerts' }),
  kind('agent.service-down', 'Claude: a stack service stopped', 'One of the containers this module looks after (n8n, CouchDB…) is stopped.', { severity: 'critical', hold: 4, clearMin: 2, source: 'alerts' }),
  // Claude's messages to the owner about the Forsa work (work-legacy.js) until forsa-aios takes them.
  { ...kind('agent.work-update', 'Forsa: message from Claude', 'Claude reports something about the Forsa work: a release, a moved deadline, a decision taken.', { severity: 'info' }), view: null },
  { ...kind('agent.work-alert', 'Forsa: needs your attention', 'Claude hit something on the Forsa work only you can unblock.'), view: null },
  { ...kind('agent.assistant-needs-you', 'Assistant: needs you', 'The Assistant wants to use a tool that asks first, or has a question.', { blocking: true }), view: 'assistant', off: 'assistant' },
  { ...kind('agent.assistant-failed', 'Assistant: could not answer', 'Every model refused, or the turn broke.'), view: 'assistant', off: 'assistant' },
  { ...kind('agent.assistant-replied', 'Assistant: replied', 'A reply finished, with its first lines.', { severity: 'info', channels: [] }), view: 'assistant', off: 'assistant' },
].filter((k) => !(k.off && features.off(k.off))).map(({ off, ...k }) => k);

/**
 * How far back "recent runs" goes.
 *
 * n8n keeps executions until its own pruning removes them, so the list
 * otherwise reaches back to whenever that was and a run from March sits next
 * to one from this morning looking equally current. Nothing is deleted here —
 * this is a view, and n8n remains the record.
 */
const EXEC_WINDOW_DAYS = Number(process.env.N8N_EXEC_DAYS || 30);

/**
 * The containers this module is responsible for.
 *
 * Deliberately a list, not "every container on the host": fleet shows all of
 * them, and a module that also showed all of them would be a second, slightly
 * different answer to the same question — the kind of overlap where the two
 * eventually disagree and you have to work out which one is lying.
 */
const ODYSSEUS_PARTS = new Set(['odysseus', 'chromadb', 'searxng', 'ntfy']);
const STACK = [
  { match: /^n8n$/, id: 'n8n', label: 'n8n', role: 'workflow engine' },
  { match: /^odysseus[-_]?odysseus/, id: 'odysseus', label: 'Odysseus', role: 'agent' },
  { match: /chromadb/, id: 'chromadb', label: 'ChromaDB', role: 'vector store' },
  { match: /searxng/, id: 'searxng', label: 'SearXNG', role: 'search' },
  { match: /ntfy/, id: 'ntfy', label: 'ntfy', role: 'notifications' },
  { match: /^couchdb$/, id: 'couchdb', label: 'CouchDB', role: 'sync' },
// Odysseus switched off (src/features.js) takes its containers with it: they
// are stopped on purpose, and a stopped one would otherwise be an alert.
].filter((s) => !(features.off('odysseus') && ODYSSEUS_PARTS.has(s.id)));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

const auth = (req, _res, next) => {
  req.user = req.get('x-console-user') || 'standalone';
  next();
};

const execP = (cmd, timeout = 6000) => new Promise((resolve) => {
  exec(cmd, { timeout }, (err, stdout) => resolve(stdout || ''));
});

/* ── module contract ──────────────────────────────────────────────────── */

const VIEWS = [
  { id: 'claude', label: 'Claude', icon: 'i-term' },
  // Off by default and not part of the redesigned module; AGENT_DISABLE=
  // brings them back (src/features.js), drawn by their old UI.
  ...(features.off('assistant') ? [] : [{ id: 'assistant', label: 'Assistant', icon: 'i-assistant' }]),
];

app.get('/module.json', (_req, res) => res.json({
  id: process.env.MODULE_ID || 'agent',
  name: process.env.MODULE_NAME || 'Claude',
  version: '4.0.0',
  icon: 'i-term',
  views: VIEWS,
  defaultView: 'claude',
  viewTabs: false,
  ui: '/ui/index.js',
  // The console opens this without mounting the module first — the
  // Assistant button on the overview — so it is advertised on its own.
  assistant: features.off('assistant') ? undefined : '/ui/assistant.js',
  health: '/api/health',
  capabilities: ['summary', 'sse', 'notify'],
  // Every alert kind (see ALERT_KINDS). `notifications` is the name older
  // consoles read; `alerts` the one the redesigned shell does.
  alerts: ALERT_KINDS,
  notifications: ALERT_KINDS,
  notifyTest: CLAUDE_CONFIGURED ? ['discord'] : [],
}));

app.get('/api/config', (_req, res) => res.json({
  timezone: TIMEZONE,
  has: { claude: CLAUDE_CONFIGURED, assistant: assistantModule.configured() },
  off: features.list(),
  devices: RUNNERS.map((r) => ({ id: r.id, label: r.label, sleeps: r.sleeps })),
}));

/* ── the stack's own containers ───────────────────────────────────────── */

/** Docker's prefix for a container it is replacing and has not removed yet. */
const RENAMED = /^[0-9a-f]{8,}_/;

async function stackServices() {
  const out = await execP('docker ps -a --format "{{.Names}}|{{.State}}|{{.Status}}"');
  const seen = out.split('\n').filter(Boolean).map((l) => {
    const [name, state, status] = l.split('|');
    return { name, running: state === 'running', status };
  // A redeploy leaves the old container behind under a hashed name until the
  // new one is up. Matching it would report the service as stopped because it
  // is being deployed.
  }).filter((c) => !RENAMED.test(c.name));
  return STACK.map((def) => {
    const hit = seen.find((c) => def.match.test(c.name));
    return {
      id: def.id,
      name: def.label,
      role: def.role,
      container: hit?.name || null,
      // Absent and stopped are different states and the difference matters:
      // one is a deployment that never included this piece, the other is a
      // piece that died.
      present: !!hit,
      ok: !!hit?.running,
      detail: hit?.status || 'not deployed',
    };
  });
}

app.get('/api/services', auth, async (_req, res) => res.json({ services: await stackServices() }));

app.post('/api/services/:id/restart', auth, async (req, res) => {
  const svc = (await stackServices()).find((s) => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'unknown service' });
  if (!svc.container) return res.status(409).json({ error: `${svc.name} is not deployed here` });
  // The container NAME comes from docker itself, never from the request — the
  // request only picks which of our own services to act on.
  const out = await execP(`docker restart ${JSON.stringify(svc.container)}`, 30_000);
  return res.json({ ok: true, restarted: svc.container, out: out.trim().slice(0, 200) });
});

/* ── n8n ──────────────────────────────────────────────────────────────── */

/**
 * n8n's public API, wrapped so its failure modes come back as states rather
 * than exceptions. The one that matters: an API key that n8n no longer
 * accepts answers 401 to everything, and "no workflows" and "you are not
 * allowed to ask" must not look the same on screen.
 */
async function n8n(pathname, opts = {}) {
  if (!N8N_API_KEY) return { ok: false, reason: 'no-key' };
  try {
    const r = await fetch(`${N8N_URL}/api/v1${pathname}`, {
      ...opts,
      headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'content-type': 'application/json', ...(opts.headers || {}) },
      timeout: 8000,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'bad-key' };
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: e.message };
  }
}

const N8N_REASONS = {
  'no-key': 'No n8n API key is configured (set N8N_API_KEY).',
  'bad-key': 'n8n rejected the API key — issue a new one in n8n under Settings → API.',
  unreachable: 'n8n is not answering.',
};
const n8nWhy = (reason, detail) => N8N_REASONS[reason] || `n8n returned ${reason}${detail ? ` (${detail})` : ''}`;

app.get('/api/n8n/workflows', auth, async (_req, res) => {
  const r = await n8n('/workflows?limit=100');
  if (!r.ok) return res.status(502).json({ error: n8nWhy(r.reason, r.detail), reason: r.reason });
  const workflows = (r.data.data || []).map((w) => ({
    id: w.id,
    name: w.name,
    active: !!w.active,
    updatedAt: w.updatedAt,
    tags: (w.tags || []).map((t) => t.name).filter(Boolean),
  }));
  return res.json({ workflows });
});

app.get('/api/n8n/executions', auth, async (_req, res) => {
  const [r, wf] = await Promise.all([
    n8n('/executions?limit=25&includeData=false'),
    // includeData=false leaves out workflowData, so an execution knows only
    // its workflow's ID — and "nK8qxpVEXAksjVHT · waiting" tells you nothing
    // about which automation that is. Asking for the data instead would pull
    // every node of every run across the wire to read one name.
    n8n('/workflows?limit=100'),
  ]);
  if (!r.ok) return res.status(502).json({ error: n8nWhy(r.reason, r.detail), reason: r.reason });
  const names = new Map((wf.ok ? wf.data.data || [] : []).map((w) => [String(w.id), w.name]));
  const cutoff = Date.now() - EXEC_WINDOW_DAYS * 86400_000;
  const executions = (r.data.data || []).filter((e) => {
    const t = Date.parse(e.startedAt);
    // A run with no parseable timestamp is kept: dropping it would hide
    // something that may well be current.
    return !Number.isFinite(t) || t >= cutoff;
  }).map((e) => ({
    id: e.id,
    workflowId: e.workflowId,
    workflowName: e.workflowData?.name || names.get(String(e.workflowId)) || null,
    status: e.status || (e.finished ? 'success' : 'running'),
    startedAt: e.startedAt,
    stoppedAt: e.stoppedAt,
    mode: e.mode,
  }));
  return res.json({ executions, windowDays: EXEC_WINDOW_DAYS });
});

app.post('/api/n8n/workflows/:id/:action', auth, async (req, res) => {
  const { id, action } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ error: 'bad workflow id' });
  if (action !== 'activate' && action !== 'deactivate') {
    return res.status(400).json({ error: 'action must be activate or deactivate' });
  }
  const r = await n8n(`/workflows/${id}/${action}`, { method: 'POST' });
  if (!r.ok) return res.status(502).json({ error: n8nWhy(r.reason, r.detail), reason: r.reason });
  return res.json({ ok: true, id, active: action === 'activate' });
});

/* ── odysseus ─────────────────────────────────────────────────────────── */

async function odysseus() {
  if (!ODYSSEUS_URL || features.off('odysseus')) return { configured: false };
  const probe = async (p) => {
    try {
      const r = await fetch(`${ODYSSEUS_URL}${p}`, { timeout: 6000, redirect: 'manual' });
      // A redirect to a login page is a service that is up and guarding
      // itself, not a service that is down.
      if (r.status >= 300 && r.status < 400) return { ok: true, guarded: true, status: r.status };
      if (!r.ok) return { ok: false, status: r.status };
      const text = await r.text();
      try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: null }; }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const [health, version] = await Promise.all([probe('/api/health'), probe('/api/version')]);
  return {
    configured: true,
    up: !!health.ok,
    status: health.data?.status || (health.ok ? 'up' : 'down'),
    version: version.data?.version || version.data || null,
    error: health.ok ? null : (health.error || `HTTP ${health.status}`),
  };
}

app.get('/api/odysseus', auth, async (_req, res) => res.json(await odysseus()));

/* ── Forsa work loop: server-side only, until forsa-aios (work-legacy.js) ── */

mountWorkLegacy(app, auth, RUNNERS, (n) => notifyStream.emit(n));

/* ── the Claude runners ───────────────────────────────────────────────── */

/**
 * Everything under /api/claude/d/<device>/* goes to that device's runner,
 * with its token added here — the browser never holds one. /api/claude/* with
 * no device is the first runner (HP), as it was before there were two.
 * Hand-rolled on node:http for the same two reasons the console's own proxy
 * is: an event stream must not be buffered, and a terminal is a WebSocket
 * upgrade, which express never sees.
 */
function runnerRequest(runner, rest, req, res) {
  if (!runner) {
    return res.status(CLAUDE_CONFIGURED ? 404 : 503).json(CLAUDE_CONFIGURED
      ? { error: 'No such device', reason: 'no-device' }
      : { error: 'The Claude runner is not configured here (set CLAUDE_RUNNER_URL and CLAUDE_RUNNER_TOKEN).', reason: 'not-configured' });
  }
  const target = new URL(`/api${rest}`, runner.url);
  const headers = {
    accept: req.get('accept') || 'application/json',
    authorization: `Bearer ${runner.token}`,
  };
  let body = null;
  let stream = false;
  // Never a body on GET/HEAD/DELETE. express.json() leaves req.body as {} on
  // those, and sending it made the runner read a body on the event stream's
  // GET — after which Node reports the request closed and the stream was
  // dropped after its first event.
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    const type = req.get('content-type') || '';
    if (!type || type.includes('application/json')) {
      body = Buffer.from(JSON.stringify(req.body ?? {}));
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    } else {
      // Anything else (a pasted image) was never parsed: pass the bytes on.
      stream = true;
      headers['content-type'] = type;
      if (req.get('content-length')) headers['content-length'] = req.get('content-length');
      if (req.get('x-file-name')) headers['x-file-name'] = req.get('x-file-name');
    }
  }
  const events = String(req.get('accept') || '').includes('text/event-stream') || /\/(events|live)(\?|$)/.test(rest);
  const up = http.request({
    hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers,
    // A laptop that is asleep answers nothing at all: give up rather than hang.
    // An upload over the tailnet can take longer than an answer.
    timeout: events ? 0 : stream ? 180_000 : 15_000,
  }, (r) => {
    res.status(r.statusCode || 502);
    for (const k of ['content-type', 'cache-control']) if (r.headers[k]) res.setHeader(k, r.headers[k]);
    if (String(r.headers['content-type'] || '').includes('text/event-stream')) {
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      res.socket?.setNoDelay(true);
    }
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    res.status(502).json({
      error: runner.sleeps
        ? `${runner.label} is offline (${e.code || e.message}) — asleep, shut, or away from the tailnet.`
        : `The Claude runner on ${runner.label} is not answering (${e.code || e.message}). On the host: systemctl --user status ojee-claude`,
      reason: 'unreachable',
      device: runner.id,
    });
  });
  // A closed tab must not leave the runner streaming into a dead socket.
  res.on('close', () => { if (!up.destroyed) up.destroy(); });
  if (stream) req.pipe(up);
  else up.end(body);
}

/** One runner's JSON, or null. Never throws; a sleeping laptop is a null. */
async function runnerJson(runner, pathname, timeout = 4000) {
  try {
    const r = await fetch(`${runner.url}/api${pathname}`, { timeout, headers: { authorization: `Bearer ${runner.token}` } });
    if (!r.ok) return { ok: false, error: r.status === 401 ? 'the runner rejected the token' : `HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    const why = e.type === 'request-timeout' ? 'no answer' : (e.code || e.message);
    return { ok: false, error: runner.sleeps ? `offline — ${why}` : `not answering — ${why}` };
  }
}

const deviceInfo = (r) => ({ id: r.id, label: r.label, sleeps: r.sleeps });

/** Every runner's whole state at once, each marked online or not. */
app.get('/api/claude/all/state', auth, async (_req, res) => {
  const all = await Promise.all(RUNNERS.map(async (r) => {
    const x = await runnerJson(r, '/state');
    return { ...deviceInfo(r), online: x.ok, error: x.ok ? null : x.error, state: x.ok ? x.data : null };
  }));
  res.json({ devices: all });
});

/**
 * One event stream for every runner. Each upstream event is passed on as
 * {device, data}; a runner dropping away or coming back is a `device` event,
 * so an offline laptop is a state the page draws, never a broken stream.
 */
app.get('/api/claude/all/events', auth, (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  let closed = false;
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const links = RUNNERS.map((runner) => {
    const link = { runner, up: null, timer: null, watchdog: null, online: null };
    const status = (online, error = null) => {
      if (link.online === online) return;
      link.online = online;
      send('device', { device: runner.id, online, error });
    };
    const retry = (error) => {
      link.up?.destroy();
      link.up = null;
      clearTimeout(link.watchdog);
      status(false, error);
      if (!closed) link.timer = setTimeout(connect, 10_000);
    };
    // The runner pings every 20 s. A laptop that fell asleep mid-stream sends
    // nothing and closes nothing; silence is how that looks.
    const alive = () => {
      clearTimeout(link.watchdog);
      link.watchdog = setTimeout(() => retry('offline — stopped answering'), 50_000);
    };
    function connect() {
      if (closed) return;
      const target = new URL('/api/events', runner.url);
      let buf = '';
      const up = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET',
        headers: { accept: 'text/event-stream', authorization: `Bearer ${runner.token}` },
      });
      link.up = up;
      const connectTimer = setTimeout(() => { if (link.up === up) retry(runner.sleeps ? 'offline — no answer' : 'not answering'); }, 6000);
      up.on('response', (r) => {
        clearTimeout(connectTimer);
        if (r.statusCode !== 200) { r.resume(); retry(r.statusCode === 401 ? 'the runner rejected the token' : `HTTP ${r.statusCode}`); return; }
        alive();
        status(true);
        r.setEncoding('utf8');
        r.on('data', (chunk) => {
          alive();
          buf += chunk;
          let at;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, at);
            buf = buf.slice(at + 2);
            let event = 'message';
            const data = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (!data.length) continue;
            try {
              const parsed = JSON.parse(data.join('\n'));
              send(event, { device: runner.id, data: parsed });
            } catch { /* a frame that is not JSON is not ours */ }
          }
        });
        r.on('end', () => { if (link.up === up) retry('the runner closed the stream'); });
        r.on('error', () => { if (link.up === up) retry('the stream broke'); });
      });
      up.on('error', (e) => { clearTimeout(connectTimer); if (link.up === up) retry(runner.sleeps ? `offline — ${e.code || e.message}` : `not answering — ${e.code || e.message}`); });
      up.end();
    }
    connect();
    return link;
  });
  // A data frame, not a comment: the browser's EventSource hides comments,
  // and the Claude view needs to see the stream is alive to notice one that
  // died silently (a phone asleep, a network change) and reconnect.
  const ping = setInterval(() => { if (!closed) res.write(`event: ping\ndata: ${Date.now()}\n\n`); }, 20_000);
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
    for (const l of links) { clearTimeout(l.timer); clearTimeout(l.watchdog); l.up?.destroy(); }
  });
});

app.use('/api/claude/d/:device', auth, (req, res) => runnerRequest(runnerById(req.params.device), req.url, req, res));
app.use('/api/claude', auth, (req, res) => runnerRequest(RUNNERS[0] || null, req.url, req, res));

/** WebSocket upgrades for the terminal, forwarded with the runner's token. */
function runnerUpgrade(req, socket, head) {
  const m = /^\/api\/claude(?:\/d\/([a-z0-9-]+))?(\/(?:sessions|accounts)\/[^/?]+\/terminal)(\?.*)?$/.exec(req.url || '');
  if (!m) return false;
  const runner = m[1] ? runnerById(m[1]) : RUNNERS[0];
  if (!runner) { socket.end(`HTTP/1.1 ${CLAUDE_CONFIGURED ? '404 Not Found' : '503 Service Unavailable'}\r\n\r\n`); return true; }
  const target = new URL(`/api${m[2]}${m[3] || ''}`, runner.url);
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${runner.token}` };
  // The console's identity headers are for this module, not for the runner.
  for (const k of Object.keys(headers)) if (k.startsWith('x-console-') || k === 'cookie') delete headers[k];
  const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers, timeout: 10_000 });
  up.on('upgrade', (res, upSocket, upHead) => {
    up.setTimeout(0);
    upSocket.setTimeout(0);
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => { socket.destroy(); upSocket.destroy(); };
    socket.on('error', close);
    upSocket.on('error', close);
    socket.on('close', close);
    upSocket.on('close', close);
  });
  up.on('response', (res) => {
    socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
  });
  up.on('timeout', () => up.destroy());
  up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  up.end();
  return true;
}

/**
 * Every runner's summary, added up. Never throws. A laptop that is offline
 * is not a problem and is not reported as one.
 */
async function claudeSummary() {
  if (!CLAUDE_CONFIGURED) return { configured: false };
  const all = await Promise.all(RUNNERS.map(async (r) => ({ r, x: await runnerJson(r, '/summary', 3000) })));
  const up = all.filter(({ x }) => x.ok);
  const sum = (k) => up.reduce((n, { x }) => n + (Number(x.data[k]) || 0), 0);
  const multi = RUNNERS.length > 1;
  return {
    configured: true,
    up: up.length > 0,
    multi,
    runners: all.map(({ r, x }) => ({ id: r.id, label: r.label, sleeps: r.sleeps, ok: x.ok, error: x.ok ? null : x.error, data: x.ok ? x.data : null })),
    running: sum('running'),
    waiting: sum('waiting'),
    blocked: sum('blocked'),
    paused: sum('paused'),
    errors: sum('errors'),
    idle: sum('idle'),
  };
}

/* ── the stack's containers: a check that says nothing until something is wrong ── */

/** Down since when, per service, so a restart in progress does not alert. */
const serviceDown = new Map();
async function serviceHealth() {
  const services = await stackServices();
  const deployed = services.filter((s) => s.present);
  const now = Date.now();
  for (const s of deployed) {
    if (s.ok) serviceDown.delete(s.id);
    else if (!serviceDown.has(s.id)) serviceDown.set(s.id, now);
  }
  const down = deployed.filter((s) => !s.ok).map((s) => ({ ...s, since: serviceDown.get(s.id) }));
  return { total: deployed.length, down, ok: !down.length };
}

/* ── a two-hour history of how many sessions work and wait, for the overview's spark ── */

const SPARK_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'claude-spark.json');
const SPARK_POINTS = 120; // one a minute
let spark = (() => { try { const j = JSON.parse(fs.readFileSync(SPARK_FILE, 'utf8')); return Array.isArray(j) ? j.slice(-SPARK_POINTS) : []; } catch { return []; } })();
let lastClaude = null;
async function sampleSpark() {
  const cc = await claudeSummary().catch(() => null);
  if (cc?.configured) lastClaude = { at: Date.now(), cc };
  if (!cc?.up) return;
  spark.push({ t: Date.now(), working: cc.running, needs: cc.waiting + cc.blocked + cc.errors });
  spark = spark.filter((p) => Date.now() - p.t < SPARK_POINTS * 60_000 + 30_000).slice(-SPARK_POINTS);
  try { fs.mkdirSync(path.dirname(SPARK_FILE), { recursive: true }); fs.writeFileSync(SPARK_FILE, JSON.stringify(spark)); } catch { /* a read-only disk loses the history, not the module */ }
}
if (CLAUDE_CONFIGURED) { setTimeout(sampleSpark, 5000); setInterval(sampleSpark, 60_000).unref(); }

/* ── health and summary ───────────────────────────────────────────────── */

app.get('/api/health', async (_req, res) => {
  const h = await serviceHealth();
  res.json({
    ok: true,
    reason: h.down.length ? `${h.down.map((s) => s.name).join(', ')} stopped` : null,
    services: h.total,
    running: h.total - h.down.length,
  });
});

/** The one line the Claude view shows when a container is down, and nothing otherwise. */
app.get('/api/stack', auth, async (_req, res) => res.json(await serviceHealth()));

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};
const clockAt = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });

/**
 * Everything wrong right now, each with a stable key: the console raises
 * an item when a key appears (after the kind's hold), updates it while the
 * key stays, and resolves it quietly when the key is gone.
 */
function claudeAlerts(cc) {
  const out = [];
  if (!cc?.configured) return out;
  for (const r of cc.runners) {
    const tag = cc.multi ? ` (${r.label})` : '';
    if (!r.ok) {
      if (!r.sleeps) out.push({ key: r.id, notify: 'agent.claude-runner-down', kind: 'agent.claude-runner-down', severity: 'warn', text: `The Claude runner on ${r.label} is not answering`, detail: r.error, route: '#/agent/claude' });
      continue;
    }
    const d = r.data;
    for (const a of d.attention || []) {
      const k = a.state === 'waiting' ? 'needs-input' : a.state === 'blocked' ? 'blocked' : 'error';
      const what = a.prompt === 'permission' ? 'wants permission' : a.prompt === 'plan' ? 'wants a plan approved' : a.state === 'waiting' ? 'is asking a question' : a.state === 'blocked' ? 'is blocked' : 'hit an error';
      out.push({
        key: `${r.id}:${a.id}`, notify: `agent.claude-${k}`, kind: `agent.claude-${k}`,
        severity: k === 'error' ? 'err' : 'warn', blocking: k === 'needs-input',
        text: `${a.title}${tag} ${what}`, detail: a.question || a.detail || null,
        route: `#/agent/claude/${a.id}`, since: a.at || null, action: k === 'needs-input' ? 'Answer' : 'Open',
      });
    }
    for (const st of d.stalled || []) {
      out.push({ key: `${r.id}:${st.id}`, notify: 'agent.claude-stalled', kind: 'agent.claude-stalled', severity: 'warn', text: `${st.title}${tag} has gone quiet`, detail: st.since ? `Nothing new for ${ago(st.since)}, with nothing running` : null, route: `#/agent/claude/${st.id}`, since: st.since });
    }
    const accts = d.accounts || [];
    for (const a of accts) {
      if (a.status === 'needs-login') {
        out.push({ key: `${r.id}:${a.id}`, notify: 'agent.claude-needs-login', kind: 'agent.claude-needs-login', severity: 'warn', text: `Claude account ${a.label}${tag} needs login`, detail: a.text || a.authError || 'Not logged in', route: '#/agent/claude/accounts', action: 'Log in' });
      } else if (a.status === 'limited') {
        out.push({ key: `${r.id}:${a.id}`, notify: 'agent.claude-account-limited', kind: 'agent.claude-account-limited', severity: 'info', text: `Claude account ${a.label}${tag} is limited${a.limitedUntil ? ` until ${clockAt(a.limitedUntil)}` : ''}`, detail: a.limitWindow === 'five_hour' ? '5-hour window' : a.limitWindow === 'seven_day' ? 'weekly limit' : a.text, route: '#/agent/claude/accounts' });
      }
    }
    if (accts.length && accts.every((a) => a.status === 'needs-login' || a.status === 'limited') && (d.paused || 0) > 0) {
      out.push({ key: `${r.id}:-`, notify: 'agent.claude-all-limited', kind: 'agent.claude-all-limited', severity: 'warn', text: `Every Claude account${tag} is out`, detail: `${d.paused} session${d.paused === 1 ? '' : 's'} paused until the soonest reset`, route: '#/agent/claude/accounts' });
    }
  }
  return out;
}

app.get('/api/summary', auth, async (_req, res) => {
  const [stack, cc, as] = await Promise.all([
    serviceHealth(),
    claudeSummary(),
    assistantModule.summary().catch(() => ({ configured: false })),
  ]);
  lastClaude = cc.configured ? { at: Date.now(), cc } : lastClaude;
  const alerts = [
    ...claudeAlerts(cc),
    ...stack.down.map((sv) => ({ key: sv.id, notify: 'agent.service-down', kind: 'agent.service-down', severity: 'err', text: `${sv.name} is not running`, detail: sv.detail, route: '#/agent/claude', since: sv.since })),
    ...(as.configured && as.up ? as.waiting.map((x) => ({ key: x.id, notify: 'agent.assistant-needs-you', kind: 'agent.assistant-needs-you', severity: 'warn', blocking: true, text: `The Assistant is asking in “${x.title}”`, route: '#/agent/assistant' })) : []),
  ];
  const needs = cc.up ? cc.waiting + cc.blocked + cc.errors : 0;
  const accts = cc.up ? cc.runners.filter((r) => r.ok).flatMap((r) => r.data.accounts || []) : [];
  const acctOk = accts.filter((a) => a.status === 'ok').length;
  const blocking = alerts.some((a) => a.blocking);
  const status = !cc.configured ? (stack.down.length ? 'err' : 'ok')
    : !cc.up ? 'warn'
      : alerts.some((a) => a.severity === 'err') ? 'err'
        : alerts.some((a) => a.severity === 'warn') ? 'warn' : 'ok';
  res.json({
    status,
    // The verdict under the module's name on the overview.
    headline: !cc.configured ? (stack.down.length ? `${stack.down.length} service${stack.down.length === 1 ? '' : 's'} stopped` : 'no runner configured')
      : !cc.up ? 'runner not answering'
        : needs ? `${needs} waiting${blocking ? ' for you' : ''}`
          : cc.running ? `${cc.running} working` : 'all quiet',
    // Four numbers for the overview's row.
    metrics: cc.up ? [
      { k: 'working', label: 'Working', v: cc.running },
      { k: 'needs', label: 'Needs you', v: needs, sev: needs ? 'err' : null },
      { k: 'idle', label: 'Idle', v: cc.idle },
      { k: 'accounts', label: 'Accounts', v: acctOk, of: accts.length, unit: 'ok', sev: accts.length && acctOk < accts.length ? 'warn' : null },
    ] : [],
    // Sessions working, one point a minute for the last two hours.
    spark: { label: 'working', points: spark.map((p) => [p.t, p.working]), max: Math.max(1, ...spark.map((p) => p.working)) },
    facts: cc.up ? [
      { k: 'Claude', v: [`${cc.running} working`, needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, cc.paused ? `${cc.paused} paused` : null].filter(Boolean).join(' · ') },
      { k: 'Accounts', v: `${acctOk} of ${accts.length} ok` },
      stack.down.length ? { k: 'Stopped', v: stack.down.map((sv) => sv.name).join(', ') } : null,
    ].filter(Boolean) : [{ k: 'Claude', v: cc.configured ? 'runner not answering' : 'not configured' }],
    alerts,
  });
});

/* ── static ───────────────────────────────────────────────────────────── */

// xterm.js for the Claude terminal, from node_modules — no build step, no
// CDN. Same layout as ojee-remote's, so the two terminals load identically.
for (const parts of [['@xterm', 'xterm', 'lib'], ['@xterm', 'xterm', 'css'], ['@xterm', 'addon-fit', 'lib'], ['@xterm', 'addon-clipboard', 'lib']]) {
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', ...parts), { maxAge: '1h' }));
}

/** The console's choices for this module's notifications. The runners get
    theirs (the Claude types, quiet hours) now and whenever they come back. */
let notifyPrefs = null;
const runnerPrefs = () => (notifyPrefs ? {
  quiet: notifyPrefs.quiet, tz: notifyPrefs.tz || null,
  types: Object.fromEntries(Object.entries(notifyPrefs.types || {}).filter(([k]) => k.startsWith('agent.claude-'))),
} : null);
async function pushRunnerPrefs(runner) {
  const body = runnerPrefs();
  if (!body) return;
  try {
    await fetch(`${runner.url}/api/notify-prefs`, { method: 'PUT', timeout: 6000, headers: { 'content-type': 'application/json', authorization: `Bearer ${runner.token}` }, body: JSON.stringify(body) });
  } catch { /* asleep; sent again when it reconnects */ }
}

app.post('/api/notify/prefs', auth, (req, res) => {
  const b = req.body || {};
  if (!b.types || typeof b.types !== 'object') return res.status(400).json({ error: 'types is required' });
  notifyPrefs = { quiet: b.quiet || null, tz: b.tz || null, types: b.types };
  assistantModule.setConsolePrefs(notifyPrefs);
  for (const r of RUNNERS) pushRunnerPrefs(r);
  res.json({ ok: true });
});

/** "Test its Discord": every runner posts a test to its own webhook. */
app.post('/api/notify/test', auth, async (_req, res) => {
  const out = await Promise.all(RUNNERS.map(async (r) => {
    try {
      const x = await fetch(`${r.url}/api/notify/test`, { method: 'POST', timeout: 10_000, headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` }, body: '{}' });
      const j = await x.json().catch(() => ({}));
      return { device: r.label, ok: x.ok && j.ok !== false, error: x.ok ? null : (j.error || `HTTP ${x.status}`) };
    } catch (e) {
      return { device: r.label, ok: false, error: r.sleeps ? 'offline' : (e.code || e.message) };
    }
  }));
  const ok = out.some((x) => x.ok);
  res.status(ok ? 200 : 502).json({ ok, detail: out.map((x) => `${x.device}: ${x.ok ? 'sent' : x.error}`).join(' · '), runners: out, error: ok ? null : out.map((x) => `${x.device}: ${x.error}`).join(' · ') });
});

/**
 * One standing subscription per runner: its `notify` events are relayed onto
 * this module's /api/events, where the console picks them up. Resumes with
 * ?since= so a reconnect does not lose a ping; a runner coming back is sent
 * the console's notification choices again.
 */
function relayRunner(runner) {
  let lastAt = Date.now();
  let attempt = 0;
  const connect = () => {
    const target = new URL(`/api/events?since=${lastAt}`, runner.url);
    let buf = '';
    let idle = null;
    const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${runner.token}` } });
    // end, error and the idle timer can all fire for one dropped stream; only
    // the first may schedule a reconnect, or every drop doubles the chains.
    let done = false;
    const retry = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      up.destroy();
      const wait = Math.min(120_000, 5000 * 2 ** attempt);
      attempt += 1;
      setTimeout(connect, wait).unref?.();
    };
    const alive = () => { clearTimeout(idle); idle = setTimeout(retry, 60_000); };
    up.on('response', (r) => {
      if (r.statusCode !== 200) { r.resume(); retry(); return; }
      attempt = 0;
      alive();
      pushRunnerPrefs(runner);
      r.setEncoding('utf8');
      r.on('data', (chunk) => {
        alive();
        buf += chunk;
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (!/^event: notify$/m.test(frame)) continue;
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          try {
            const n = JSON.parse(data);
            if (typeof n.id !== 'string' || !n.id.startsWith('agent.claude-')) continue;
            lastAt = Math.max(lastAt, Number(n.at) || Date.now());
            // The runner's tag is `<kind>:<subject>`; the console's key is
            // `<alert kind>:<device>:<subject>`, the same one /api/summary uses.
            const subject = String(n.tag || '').split(':').slice(1).join(':') || '-';
            const route = typeof n.route === 'string' ? n.route.replace('/accounts/-/', `/accounts/${runner.id}/`) : n.route;
            // `key` is the subject (the console makes it module:kind:key), the
            // same one /api/summary states, so an event and an alert are one item.
            const info = ['agent.claude-model-fallback', 'agent.claude-account-switch', 'agent.claude-done'].includes(n.id);
            notifyStream.emit({ ...n, route, key: `${runner.id}:${subject}`, device: runner.id, state: n.state || (info ? 'update' : 'raise'), blocking: n.id === 'agent.claude-needs-input', severity: n.severity === 'err' ? 'critical' : n.severity });
          } catch { /* not ours */ }
        }
      });
      r.on('end', retry);
      r.on('error', retry);
    });
    up.on('error', retry);
    up.end();
  };
  connect();
}
for (const r of RUNNERS) relayRunner(r);

notifyStream.mount(app, auth);
assistantModule.mount(app, auth);

app.use('/ui', express.static(`${__dirname}/../ui`, {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));
app.use(express.static(`${__dirname}/../public`, {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!runnerUpgrade(req, socket, head)) socket.destroy();
});
server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`ojee-agent (AI + automation) on :${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  n8n ${N8N_API_KEY ? N8N_URL : 'no API key'} · odysseus ${ODYSSEUS_URL || 'not configured'} · claude runners ${RUNNERS.map((r) => `${r.id}=${r.url}${r.token ? '' : ' (no token)'}`).join(', ') || 'not configured'} · assistant ${assistantModule.configured() ? assistantModule.url : 'not configured'}`);
});

module.exports = app;
