/**
 * ojee-agent — host stats, container control and a Claude Code agent surface.
 *
 * Runs standalone or as an ojee-console module. Authentication is NOT here:
 * mounted, the console has already run three gates (tailnet, TOTP, device
 * trust) and asserts the caller in a signed X-Console-User header; standalone,
 * the tailnet is the boundary. A second password prompt in front of that adds
 * nothing but a thing to forget.
 *
 * SECURITY: this process mounts docker.sock and /:/host:ro. It is effectively
 * root for the actions whitelisted in ACTIONS. Do not expose it beyond a
 * tailnet, and read the README before deploying it anywhere else.
 */
const express = require('express');
const fetch = require('node-fetch');
const si = require('systeminformation');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const CODE_AGENT_URL = process.env.CODE_AGENT_URL || '';
const CODE_AGENT_TOKEN = process.env.CODE_AGENT_TOKEN || '';
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL || 'https://agent.example.com').replace(/\/+$/, '');
const DASHBOARD_HOST = (() => { try { return new URL(DASHBOARD_BASE_URL).host; } catch { return 'this server'; } })();
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const N8N_DOMAIN = process.env.N8N_DOMAIN || '';
const OPENWEBUI_DOMAIN = process.env.OPENWEBUI_DOMAIN || '';
const COUCHDB_DOMAIN = process.env.COUCHDB_DOMAIN || '';
const ODYSSEUS_DOMAIN = process.env.ODYSSEUS_DOMAIN || '';
const LOQ_SFTP_URL = process.env.LOQ_SFTP_URL || '';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Auth ─────────────────────────────────────────────────────────────────
// Public-ish endpoint so the SPA can discover its configured domains
// without having them hardcoded.  No auth — these are display URLs the
// user already needs to type into a browser anyway.
app.get('/api/config', (req, res) => {
  res.json({
    dashboardBaseUrl: DASHBOARD_BASE_URL,
    n8nDomain: N8N_DOMAIN,
    couchdbDomain: COUCHDB_DOMAIN,
    odysseusDomain: ODYSSEUS_DOMAIN,
    loqSftpUrl: LOQ_SFTP_URL,
    timezone: TIMEZONE,
  });
});

// The console authenticates upstream and signs the identity it asserts.
// Standalone, the tailnet is the boundary. Either way there is nothing for
// this middleware to check, so it only records who the caller is.
const auth = (req, res, next) => {
  req.user = req.get('x-console-user') || 'standalone';
  next();
};

// ─── Stats ────────────────────────────────────────────────────────────────
let lastNet = null, lastNetTime = 0;
let lastDiskIO = null, lastDiskIOTime = 0;

const readNvidiaSmi = () => new Promise((resolve) => {
  exec('nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
    if (err || !stdout.trim()) return resolve(null);
    const [name, util, memUtil, memTotal, memUsed, temp] = stdout.trim().split('\n')[0].split(',').map(s => s.trim());
    resolve({
      model: name,
      vendor: 'NVIDIA',
      vram_mb: parseInt(memTotal, 10) || 0,
      vram_used_mb: parseInt(memUsed, 10) || 0,
      util: parseInt(util, 10),
      mem_util: parseInt(memUtil, 10),
      temp: parseInt(temp, 10)
    });
  });
});

// Parse /proc/diskstats (mounted via /host) to compute real host disk I/O.
// Columns: major minor name reads_completed reads_merged sectors_read read_ms
//   writes_completed writes_merged sectors_written write_ms ...
// Sector size is almost always 512 bytes. Sum over real block devices (sdX, nvmeXnY).
const readHostDiskIO = () => {
  try {
    const raw = fs.readFileSync('/host/proc/diskstats', 'utf8');
    let totalReadSectors = 0, totalWriteSectors = 0;
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const name = parts[2];
      if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+)$/.test(name)) continue;
      totalReadSectors += parseInt(parts[5], 10) || 0;
      totalWriteSectors += parseInt(parts[9], 10) || 0;
    }
    return { r_bytes: totalReadSectors * 512, w_bytes: totalWriteSectors * 512 };
  } catch { return null; }
};
app.get('/api/stats', auth, async (req, res) => {
  try {
    const [cpu, mem, load, os, disk, temp, net, gpuNvidia] = await Promise.all([
      si.cpu(), si.mem(), si.currentLoad(), si.osInfo(),
      si.fsSize(), si.cpuTemperature(), si.networkStats(),
      readNvidiaSmi()
    ]);
    const diskIOSnap = readHostDiskIO();
    const now = Date.now();
    const primary = net.find(n => n.iface === 'wlo1') || net[0] || {};
    let rxPerS = 0, txPerS = 0;
    if (lastNet && lastNetTime) {
      const dt = (now - lastNetTime) / 1000;
      rxPerS = Math.max(0, (primary.rx_bytes - lastNet.rx_bytes) / dt);
      txPerS = Math.max(0, (primary.tx_bytes - lastNet.tx_bytes) / dt);
    }
    lastNet = primary; lastNetTime = now;

    // Read host filesystem stats via /host mount (container's si.fsSize() only
    // sees overlay mounts, which misses /home on separate partitions).
    const hostFs = (p) => {
      try {
        const s = fs.statfsSync(p);
        const size = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return { size, used: size - free, use: size ? ((size - free) / size) * 100 : 0 };
      } catch { return null; }
    };
    const rootDisk = hostFs('/host') || disk.find(d => d.mount === '/') || disk[0] || {};
    const homeDisk = hostFs('/host/home');
    // Delta for disk I/O per second
    let readPerS = null, writePerS = null;
    if (diskIOSnap) {
      if (lastDiskIO && lastDiskIOTime) {
        const dt = (now - lastDiskIOTime) / 1000;
        readPerS = Math.max(0, Math.round((diskIOSnap.r_bytes - lastDiskIO.r_bytes) / dt));
        writePerS = Math.max(0, Math.round((diskIOSnap.w_bytes - lastDiskIO.w_bytes) / dt));
      }
      lastDiskIO = diskIOSnap; lastDiskIOTime = now;
    }
    const gpuController = gpuNvidia;
    res.json({
      hostname: os.hostname,
      os: `${os.distro} ${os.release}`,
      uptime: si.time().uptime,
      cpu: {
        model: `${cpu.manufacturer} ${cpu.brand}`.trim(),
        physical: cpu.physicalCores,
        cores: cpu.cores,
        avg: load.currentLoad,
        load: [load.avgLoad || 0, 0, 0]
      },
      gpu: gpuController,
      memory: {
        total: mem.total,
        used: mem.active,
        percent: Math.round((mem.active / mem.total) * 100)
      },
      swap: { total: mem.swaptotal, used: mem.swapused },
      disk: {
        total: rootDisk.size,
        used: rootDisk.used,
        percent: Math.round(rootDisk.use || 0),
        read_per_s: readPerS,
        write_per_s: writePerS
      },
      home: homeDisk && homeDisk.size !== rootDisk.size ? {
        total: homeDisk.size,
        used: homeDisk.used,
        percent: Math.round(homeDisk.use || 0)
      } : null,
      temps: [
        temp.main != null ? { label: 'CPU Package', current: Math.round(temp.main) } : null
      ].filter(Boolean),
      network: {
        sent_per_s: Math.round(txPerS),
        recv_per_s: Math.round(rxPerS)
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Services (docker + systemd) ──────────────────────────────────────────
const execP = (cmd) => new Promise((resolve) => {
  exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(stdout || ''));
});

app.get('/api/services', auth, async (req, res) => {
  const compose = await execP('docker ps --format "{{.Names}}|{{.State}}|{{.Status}}"');
  const svc = {};
  compose.split('\n').filter(Boolean).forEach(l => {
    const [name, state, status] = l.split('|');
    svc[name] = { desc: name, active: state === 'running', status };
  });
  res.json(svc);
});

// ─── Actions (whitelisted, container-safe via docker.sock) ───────────────
const ACTIONS = {
  'restart-n8n': 'docker restart n8n',
  'restart-dashboard': 'docker restart dashboard',
  'restart-couchdb': 'docker restart couchdb',
  'restart-odysseus': 'docker restart odysseus',
  'compose-up': 'docker compose --project-directory /host-stack up -d',
  'compose-down': 'docker compose --project-directory /host-stack down',
};

app.post('/api/action', auth, (req, res) => {
  const cmd = ACTIONS[req.body.action];
  if (!cmd) return res.status(400).json({ error: 'unknown action' });
  exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') });
  });
});

// ─── Module contract ──────────────────────────────────────────────────────
const pkg = require('../package.json');

app.get('/module.json', (req, res) => res.json({
  id: 'agent',
  name: 'Agent',
  version: pkg.version,
  views: [
    { id: 'dashboard', label: 'Stats', icon: 'i-server' },
    { id: 'services', label: 'Services', icon: 'i-grid' },
    { id: 'actions', label: 'Actions', icon: 'i-cog' },
    { id: 'chat', label: 'Code', icon: 'i-log' },
  ],
  ui: '/ui/index.js',
  health: '/api/health',
  capabilities: ['sse'],
}));

app.get('/api/health', async (req, res) => {
  // Reports degraded rather than failing when docker is unreachable: stats
  // still work, and the console shows the reason instead of hiding the module.
  const docker = await execP('docker ps --format "{{.Names}}"');
  const ok = docker.trim().length > 0;
  res.json({
    ok,
    reason: ok ? null : 'docker.sock unreachable — container controls will not work',
    containers: docker.trim() ? docker.trim().split('\n').length : 0,
    codeAgent: codeAgentUp(),
  });
});

// ─── Static ───────────────────────────────────────────────────────────────
app.use('/ui', express.static(path.join(__dirname, '..', 'ui'), {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));
// Standalone shell — never requested when mounted in a console.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ─── Code Agent proxy (Loq laptop Claude Code) ─────────────────────────
// Forward requests to the loq code-agent over the tailnet. Auth passthrough
// using the server-side CODE_AGENT_TOKEN — clients use the dashboard's JWT.
const codeAgentUp = () => !!CODE_AGENT_URL && !!CODE_AGENT_TOKEN;

const codeAgentReq = async (pathAndQuery, opts = {}) => {
  if (!codeAgentUp()) throw new Error('code agent not configured');
  const r = await fetch(`${CODE_AGENT_URL}${pathAndQuery}`, {
    ...opts,
    headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r;
};

app.get('/api/code-agent/config', auth, (req, res) => res.json({ enabled: codeAgentUp() }));

app.get('/api/code-agent/dirs', auth, async (req, res) => {
  try {
    const qs = req.query.path ? `?path=${encodeURIComponent(req.query.path)}` : '';
    const r = await codeAgentReq(`/api/dirs${qs}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/sessions', auth, async (req, res) => {
  try { const r = await codeAgentReq('/api/sessions'); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/code-agent/sessions', auth, async (req, res) => {
  try {
    const r = await codeAgentReq('/api/sessions', { method: 'POST', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.patch('/api/code-agent/sessions/:id', auth, async (req, res) => {
  try {
    const r = await codeAgentReq(`/api/sessions/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/api/code-agent/sessions/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/sessions/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/sessions/:id/history', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/sessions/${req.params.id}/history`); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Past conversation history across all projects
app.get('/api/code-agent/history', auth, async (req, res) => {
  try { const r = await codeAgentReq('/api/history'); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/history/:project/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/history/${encodeURIComponent(req.params.project)}/${encodeURIComponent(req.params.id)}`); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/api/code-agent/history/:project/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/history/${encodeURIComponent(req.params.project)}/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' }); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.patch('/api/code-agent/history/:project/:id', auth, async (req, res) => {
  try {
    const r = await codeAgentReq(`/api/history/${encodeURIComponent(req.params.project)}/${encodeURIComponent(req.params.id)}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Reconnect to an in-progress session stream
app.get('/api/code-agent/sessions/:id/stream', auth, async (req, res) => {
  if (!codeAgentUp()) return res.status(503).json({ error: 'code agent not configured' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const upstream = await fetch(`${CODE_AGENT_URL}/api/sessions/${req.params.id}/stream`, {
      headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}` },
      signal: ac.signal
    });
    if (!upstream.ok) return res.status(upstream.status).json(await upstream.json().catch(() => ({})));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.on('data', chunk => res.write(chunk));
    upstream.body.on('end', () => res.end());
    upstream.body.on('error', () => res.end());
  } catch (e) {
    if (e.name !== 'AbortError') res.status(502).json({ error: String(e.message || e) });
  }
});

// Resume a past conversation
app.post('/api/code-agent/sessions/resume', auth, async (req, res) => {
  try {
    const r = await codeAgentReq('/api/sessions/resume', { method: 'POST', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Message endpoint: stream SSE from loq through to our client.
app.post('/api/code-agent/sessions/:id/messages', auth, async (req, res) => {
  if (!codeAgentUp()) return res.status(503).json({ error: 'code agent not configured' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const upstream = await fetch(`${CODE_AGENT_URL}/api/sessions/${req.params.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: ac.signal
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.on('data', chunk => res.write(chunk));
    upstream.body.on('end', () => res.end());
    upstream.body.on('error', () => res.end());
  } catch (e) {
    if (e.name !== 'AbortError') res.status(502).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`dashboard listening on :${PORT}`));
