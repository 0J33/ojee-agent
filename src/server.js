/**
 * ojee-agent — the AI and automation module.
 *
 * What it is now: n8n's workflows, the Odysseus stack, and the services those
 * two depend on. What it used to be: a host dashboard with CPU graphs, a list
 * of every container on the box, and a whitelist of restart commands.
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
const express = require('express');
const fetch = require('node-fetch');
const { exec } = require('child_process');

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
const CODE_AGENT_URL = (process.env.CODE_AGENT_URL || '').replace(/\/+$/, '');
const CODE_AGENT_TOKEN = process.env.CODE_AGENT_TOKEN || '';

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
  { id: 'workflows', label: 'Workflows', icon: 'i-auto' },
  { id: 'odysseus', label: 'Odysseus', icon: 'i-shield' },
  { id: 'services', label: 'Services', icon: 'i-gauge' },
];

app.get('/module.json', (_req, res) => res.json({
  id: process.env.MODULE_ID || 'agent',
  name: process.env.MODULE_NAME || 'Agent',
  version: '2.0.0',
  icon: 'i-cpu',
  views: VIEWS,
  ui: '/ui/index.js',
  health: '/api/health',
  capabilities: ['summary'],
}));

app.get('/api/config', (_req, res) => res.json({
  timezone: TIMEZONE,
  links: [
    N8N_DOMAIN ? { label: 'n8n', href: `https://${N8N_DOMAIN}` } : null,
    ODYSSEUS_DOMAIN ? { label: 'Odysseus', href: `https://${ODYSSEUS_DOMAIN}` } : null,
    COUCHDB_DOMAIN ? { label: 'CouchDB', href: `https://${COUCHDB_DOMAIN}` } : null,
  ].filter(Boolean),
  has: { n8n: !!N8N_API_KEY, odysseus: !!ODYSSEUS_URL, code: !!CODE_AGENT_URL },
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
  const executions = (r.data.data || []).map((e) => ({
    id: e.id,
    workflowId: e.workflowId,
    workflowName: e.workflowData?.name || names.get(String(e.workflowId)) || null,
    status: e.status || (e.finished ? 'success' : 'running'),
    startedAt: e.startedAt,
    stoppedAt: e.stoppedAt,
    mode: e.mode,
  }));
  return res.json({ executions });
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

/* ── the code agent ───────────────────────────────────────────────────── */

app.get('/api/code', auth, async (_req, res) => {
  if (!CODE_AGENT_URL) return res.json({ configured: false });
  try {
    const r = await fetch(`${CODE_AGENT_URL}/health`, {
      timeout: 6000,
      headers: CODE_AGENT_TOKEN ? { authorization: `Bearer ${CODE_AGENT_TOKEN}` } : {},
    });
    return res.json({ configured: true, up: r.ok, status: r.status });
  } catch (e) {
    return res.json({ configured: true, up: false, error: e.message });
  }
});

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
  const [services, wf, ex, ody] = await Promise.all([
    stackServices(),
    n8n('/workflows?limit=100'),
    n8n('/executions?limit=25&includeData=false'),
    odysseus(),
  ]);
  const deployed = services.filter((s) => s.present);
  const stopped = deployed.filter((s) => !s.ok);

  const workflows = wf.ok ? (wf.data.data || []) : [];
  const active = workflows.filter((w) => w.active).length;
  const execs = ex.ok ? (ex.data.data || []) : [];
  const failed = execs.filter((e) => e.status === 'error' || e.status === 'failed');

  const facts = [
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
  });
});

/* ── static ───────────────────────────────────────────────────────────── */

app.use('/ui', express.static(`${__dirname}/../ui`, {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));
app.use(express.static(`${__dirname}/../public`, {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`ojee-agent (AI + automation) on :${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  n8n ${N8N_API_KEY ? N8N_URL : 'no API key'} · odysseus ${ODYSSEUS_URL || 'not configured'}`);
});

module.exports = app;
