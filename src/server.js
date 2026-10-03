/**
 * ojee-agent — the AI and automation module.
 *
 * What it is now: unattended Claude Code sessions (through the host runner in
 * claude-runner/), the Assistant (OpenCode's Zen gateway, hosted as
 * opencode serve), n8n's workflows, the Odysseus stack, and the services
 * those depend on. What it used to be: a host dashboard with CPU graphs, a
 * list of every container on the box, and a whitelist of restart commands.
 *
 * That half is gone, and its absence is the point. Monitoring lives in
 * ojee-fleet, which reads this machine directly rather than asking a service
 * on it over HTTP for numbers already sitting in /proc. A module that both
 * watched the host AND ran the automations was two modules wearing one name,
 * and neither half could be understood without ignoring the other.
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
const assistantModule = require('./assistant');

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
const STACK = [
  { match: /^n8n$/, id: 'n8n', label: 'n8n', role: 'workflow engine' },
  { match: /^odysseus[-_]?odysseus/, id: 'odysseus', label: 'Odysseus', role: 'agent' },
  { match: /chromadb/, id: 'chromadb', label: 'ChromaDB', role: 'vector store' },
  { match: /searxng/, id: 'searxng', label: 'SearXNG', role: 'search' },
  { match: /ntfy/, id: 'ntfy', label: 'ntfy', role: 'notifications' },
  { match: /^couchdb$/, id: 'couchdb', label: 'CouchDB', role: 'sync' },
];

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
  { id: 'overview', label: 'Overview', icon: 'i-grid' },
  { id: 'claude', label: 'Claude', icon: 'i-log' },
  { id: 'assistant', label: 'Assistant', icon: 'i-assistant' },
  { id: 'workflows', label: 'Workflows', icon: 'i-auto' },
  // The Router tab is gone: the Laya router lives on Loq, a laptop that is
  // asleep more often than it is on, and it was the one view on this module
  // that always had something to explain about another machine. src/router.js
  // and ui/router.js are still in the tree — put the entry above back and it
  // returns.
  { id: 'odysseus', label: 'Odysseus', icon: 'i-shield' },
  { id: 'services', label: 'Services', icon: 'i-gauge' },
];

app.get('/module.json', (_req, res) => res.json({
  id: process.env.MODULE_ID || 'agent',
  name: process.env.MODULE_NAME || 'Agent',
  version: '3.1.0',
  icon: 'i-cpu',
  views: VIEWS,
  ui: '/ui/index.js',
  // The console opens this without mounting the module first — the
  // Assistant button on the overview and the idle display both import it
  // straight into a dialog — so it is advertised on its own.
  assistant: '/ui/assistant.js',
  health: '/api/health',
  capabilities: ['summary', 'sse'],
}));

app.get('/api/config', (_req, res) => res.json({
  timezone: TIMEZONE,
  links: [
    N8N_DOMAIN ? { label: 'n8n', href: `https://${N8N_DOMAIN}` } : null,
    ODYSSEUS_DOMAIN ? { label: 'Odysseus', href: `https://${ODYSSEUS_DOMAIN}` } : null,
    COUCHDB_DOMAIN ? { label: 'CouchDB', href: `https://${COUCHDB_DOMAIN}` } : null,
  ].filter(Boolean),
  has: {
    n8n: !!N8N_API_KEY,
    odysseus: !!ODYSSEUS_URL,
    claude: CLAUDE_CONFIGURED,
    assistant: assistantModule.configured(),
  },
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
  if (!ODYSSEUS_URL) return { configured: false };
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
    }
  }
  const events = String(req.get('accept') || '').includes('text/event-stream') || /\/events(\?|$)/.test(rest);
  const up = http.request({
    hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers,
    // A laptop that is asleep answers nothing at all: give up rather than hang.
    timeout: events ? 0 : 15_000,
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
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20_000);
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
 * Every runner's one-line state for the front page, added up. Never throws.
 * A laptop that is offline is not a problem and is not reported as one.
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
    down: all.filter(({ r, x }) => !x.ok && !r.sleeps).map(({ r, x }) => ({ id: r.id, label: r.label, error: x.error })),
    error: up.length ? null : all.map(({ r, x }) => `${r.label}: ${x.error}`).join(' · '),
    running: sum('running'),
    waiting: sum('waiting'),
    blocked: sum('blocked'),
    paused: sum('paused'),
    errors: sum('errors'),
    attention: up.flatMap(({ r, x }) => (x.data.attention || []).map((a) => ({ ...a, device: r.id, title: multi ? `${a.title} (${r.label})` : a.title }))),
  };
}

/* ── health and summary ───────────────────────────────────────────────── */

app.get('/api/health', async (_req, res) => {
  const services = await stackServices();
  const deployed = services.filter((s) => s.present);
  const down = deployed.filter((s) => !s.ok);
  res.json({
    ok: true,
    reason: down.length ? `${down.map((s) => s.name).join(', ')} stopped` : null,
    services: deployed.length,
    running: deployed.length - down.length,
  });
});

app.get('/api/summary', auth, async (_req, res) => {
  const [services, wf, ex, ody, cc, as] = await Promise.all([
    stackServices(),
    n8n('/workflows?limit=100'),
    n8n('/executions?limit=25&includeData=false'),
    odysseus(),
    claudeSummary(),
    assistantModule.summary().catch(() => ({ configured: false })),
  ]);
  const deployed = services.filter((s) => s.present);
  const stopped = deployed.filter((s) => !s.ok);

  const workflows = wf.ok ? (wf.data.data || []) : [];
  const active = workflows.filter((w) => w.active).length;
  const cutoff = Date.now() - EXEC_WINDOW_DAYS * 86400_000;
  const execs = (ex.ok ? (ex.data.data || []) : []).filter((e) => {
    const t = Date.parse(e.startedAt);
    return !Number.isFinite(t) || t >= cutoff;
  });
  const failed = execs.filter((e) => e.status === 'error' || e.status === 'failed');

  const ccNeeds = cc.up ? (cc.waiting || 0) + (cc.blocked || 0) + (cc.errors || 0) : 0;
  const facts = [
    cc.configured
      ? {
        k: 'Claude',
        v: !cc.up ? 'runner not answering'
          : [`${cc.running} running`, ccNeeds ? `${ccNeeds} need${ccNeeds === 1 ? 's' : ''} you` : null, cc.paused ? `${cc.paused} paused` : null]
            .filter(Boolean).join(' · '),
      }
      : null,
    as.configured
      ? {
        k: 'Assistant',
        v: !as.up ? 'OpenCode not answering'
          : [as.working ? `${as.working} working` : null, as.waiting.length ? `${as.waiting.length} asking` : null,
            !as.working && !as.waiting.length ? `idle · ${as.sessions} chats` : null].filter(Boolean).join(' · '),
      }
      : null,
    wf.ok
      ? { k: 'Workflows', v: `${active} active of ${workflows.length}` }
      : { k: 'n8n', v: wf.reason === 'bad-key' ? 'key rejected' : wf.reason === 'no-key' ? 'no API key' : 'not answering' },
    ex.ok && execs.length
      ? {
        k: 'Last run',
        v: `${execs[0].workflowData?.name
          || workflows.find((w) => String(w.id) === String(execs[0].workflowId))?.name
          || execs[0].workflowId} · ${execs[0].status || 'running'}`,
      }
      : null,
    failed.length ? { k: 'Failed runs', v: `${failed.length} of the last ${execs.length}` } : null,
    ody.configured ? { k: 'Odysseus', v: ody.up ? (ody.status || 'up') : (ody.error || 'down') } : null,
    stopped.length
      ? { k: 'Stopped', v: stopped.map((s) => s.name).join(', ') }
      : { k: 'Stack', v: `all ${deployed.length} up` },
  ].filter(Boolean).slice(0, 4);

  const alerts = [
    ...(cc.up ? (cc.attention || []).map((x) => ({
      text: `${x.title} ${x.state === 'waiting' ? 'needs your input' : x.state === 'blocked' ? 'is blocked' : 'hit an error'}`,
      severity: x.state === 'error' ? 'err' : 'warn',
      view: 'claude',
    })) : []),
    ...(as.configured && as.up ? as.waiting.map((x) => ({ text: `The Assistant is asking to use a tool in “${x.title}”`, severity: 'warn', view: 'assistant' })) : []),
    ...(cc.configured ? (cc.down || []).map((d) => ({ text: RUNNERS.length > 1 ? `The Claude runner on ${d.label} is not answering` : 'The Claude runner is not answering', severity: 'warn', view: 'claude' })) : []),
    ...stopped.map((s) => ({ text: `${s.name} is not running`, severity: 'err', view: 'services' })),
    ...(wf.ok ? [] : [{ text: n8nWhy(wf.reason, wf.detail), severity: 'warn', view: 'workflows' }]),
    ...(ody.configured && !ody.up ? [{ text: `Odysseus is not answering`, severity: 'warn', view: 'odysseus' }] : []),
    ...(failed.length ? [{ text: `${failed.length} workflow run${failed.length === 1 ? '' : 's'} failed`, severity: 'warn', view: 'workflows' }] : []),
  ];

  res.json({
    status: stopped.length ? 'err' : alerts.length ? 'warn' : 'ok',
    headline: stopped.length
      ? `${stopped.length} of ${deployed.length} services stopped`
      : wf.ok
        ? `${active} workflow${active === 1 ? '' : 's'} active${failed.length ? ` · ${failed.length} failed run${failed.length === 1 ? '' : 's'}` : ''}`
        : 'automation stack up · n8n unreachable',
    facts,
    alerts: alerts.slice(0, 5),
    // The console draws this module as a board with traffic on its traces:
    // the rate follows what is actually running, a queue bead lights per
    // waiting job, and a failed run turns one trace red. Idle has to LOOK
    // idle, so nothing here is padded to keep the board busy.
    model: {
      running: (cc.up ? Number(cc.running) || 0 : 0) + (as.up ? as.working : 0)
        + execs.filter((e) => e.status === 'running').length,
      queued: (cc.up ? Number(cc.waiting) || 0 : 0) + (as.up ? as.waiting.length : 0)
        + execs.filter((e) => e.status === 'waiting' || e.status === 'new').length,
      failed: failed.length,
      idle: !(cc.up && Number(cc.running) > 0) && !(as.up && as.working) && !execs.some((e) => e.status === 'running'),
    },
  });
});

/* ── static ───────────────────────────────────────────────────────────── */

// xterm.js for the Claude terminal, from node_modules — no build step, no
// CDN. Same layout as ojee-remote's, so the two terminals load identically.
for (const parts of [['@xterm', 'xterm', 'lib'], ['@xterm', 'xterm', 'css'], ['@xterm', 'addon-fit', 'lib'], ['@xterm', 'addon-clipboard', 'lib']]) {
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', ...parts), { maxAge: '1h' }));
}

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
