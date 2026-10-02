#!/usr/bin/env node
/**
 * ojee MCP — the tools the Assistant uses to touch the rest of the console.
 *
 * This is an MCP stdio server, not a route: `opencode serve` spawns it as a
 * child process on HP and the model calls the tools below by name
 * (`ojee_ac_command`, `ojee_fleet_hosts`, `ojee_ssh_run` …). It lives in this
 * repo because the Assistant is what they belong to, but it runs on the host —
 * opencode cannot reach into a container — so it talks to the modules over
 * loopback ports that compose publishes, and to the two other machines over
 * ssh with the keys that already live in ~/.ssh.
 *
 * Deliberate constraints:
 *
 *   - No dependencies. Node 22 has fetch, and spawning ssh needs only
 *     child_process — so this runs on a bare `node` with nothing installed.
 *   - Reads are projected. `fleet_hosts` returns the handful of fields a
 *     person asks about rather than a snapshot's worth of nested JSON, because
 *     the model's context is the scarce resource, not the wire.
 *   - Two tools change things (`ac_command`, `agent_restart_service`). Their
 *     descriptions say so, because the model should be reading the intent
 *     back to the reader before it acts on it.
 *   - disinteg is reached through loq. HP's key is not authorised there, and
 *     authorising it would mean editing another machine's authorized_keys to
 *     serve this one — the jump uses loq's key, which already works.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout, which is what
 * MCP's stdio transport is.
 */
const { spawn } = require('node:child_process');

const HOME_URL = (process.env.MCP_HOME_URL || 'http://127.0.0.1:8110').replace(/\/+$/, '');
const FLEET_URL = (process.env.MCP_FLEET_URL || 'http://127.0.0.1:8400').replace(/\/+$/, '');
const AGENT_URL = (process.env.MCP_AGENT_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
const DISINTEG = process.env.MCP_DISINTEG_SSH || 'disinteg@100.118.201.77';

/**
 * Machines this tool will run a command on — an arbitrary host is not a thing
 * this exposes. loq defaults to its `Host loq` alias on HP, which is what
 * selects `id_ed25519_loq`; override with MCP_LOQ_SSH where no such alias
 * exists.
 */
const SSH_HOSTS = {
  loq: process.env.MCP_LOQ_SSH || 'loq',
  disinteg: DISINTEG,
};

/* ── talking to the modules ─────────────────────────────────────────── */

async function call(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * `get`/`post` return the payload, not the envelope, and they throw when the
 * call fails. Both matter: returning `{ok,status,data}` left callers reading a
 * field that was never there (`Array.isArray(envelope)` is false), which turned
 * a dead module into "there are no devices" — a confident wrong answer instead
 * of an error the model could act on.
 */
const get = (url, ms) => want(url, {}, ms);
const post = (url, body, ms) => want(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}, ms);

/** One call, parsed. Throws a readable error the model can act on. */
async function want(url, opts, ms) {
  const out = await call(url, opts, ms);
  if (!out.ok) {
    const detail = out.error || (out.data && (out.data.message || out.data.error || JSON.stringify(out.data).slice(0, 300)));
    throw new Error(`${opts?.method || 'GET'} ${url} → ${out.status || 'unreachable'}${detail ? `: ${detail}` : ''}`);
  }
  return out.data;
}

/* ── running a command on another machine ───────────────────────────── */

function sh(command, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message, killed }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
  });
}

/**
 * SSH is per-hop: loq answers its own key directly, disinteg answers loq's —
 * so a command for disinteg is run as a remote command on loq. The reader is
 * told which shape was used, because "it ran" and "it ran twice-removed" are
 * different facts when something looks odd.
 */
async function sshRun({ host, command, timeout = 60 }) {
  const target = SSH_HOSTS[host];
  if (!target) throw new Error(`Unknown host "${host}". Known: ${Object.keys(SSH_HOSTS).join(', ')}.`);
  const seconds = Math.max(5, Math.min(300, Number(timeout) || 60));
  const via = host === 'disinteg' ? 'via loq' : 'direct';
  const args = host === 'disinteg'
    // Remote command is passed as one argv on the far side; ssh does the
    // quoting for the inner hop when the whole thing is a single argument.
    ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'loq', `ssh -o BatchMode=yes -o ConnectTimeout=15 ${target} ${JSON.stringify(command)}`]
    : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, command];
  const r = await sh('ssh', args, seconds * 1000);
  return {
    host, via, command, exitCode: r.code, timedOut: r.killed,
    stdout: r.stdout.slice(0, 12000),
    stderr: r.stderr.slice(0, 4000),
  };
}

/* ── the tools ──────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'ac_command',
    description:
      'Set something on an air conditioner: temperature, power, mode, fan, swing, eco/quiet. '
      + 'CHANGES STATE — confirm the reader wants it before calling. After the call, report the new '
      + 'target_temperature from the result. Default device is the living-room AC.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device id. Omit for the default (ac-living).' },
        target_temperature: { type: 'number', description: 'Setpoint in °C (this unit allows 20–28).' },
        power: { type: 'boolean', description: 'Turn the unit on or off.' },
        mode: { type: 'string', enum: ['cool', 'heat', 'dry', 'fan', 'auto'], description: 'Operating mode.' },
        fan: { type: 'string', description: 'Fan speed, e.g. auto, low, medium, high.' },
        quiet: { type: 'boolean' },
        eco: { type: 'string' },
        swing_vertical: { type: 'boolean' },
        swing_horizontal: { type: 'boolean' },
      },
    },
    handler: async (a) => {
      const device = a.device || 'ac-living';
      const body = {};
      for (const k of ['target_temperature', 'power', 'mode', 'fan', 'quiet', 'eco', 'swing_vertical', 'swing_horizontal']) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      if (!Object.keys(body).length) throw new Error('Nothing to change — pass at least one field.');
      await post(`${HOME_URL}/api/devices/${encodeURIComponent(device)}/command`, body, 30000);
      const after = await get(`${HOME_URL}/api/devices/${encodeURIComponent(device)}`, 15000);
      return after.data;
    },
  },
  {
    name: 'home_devices',
    description:
      'List the smart-home devices and their current state (power, mode, target and measured '
      + 'temperature, room, online). Use this before ac_command to see what is there and what '
      + 'values are accepted.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const list = await get(`${HOME_URL}/api/devices`, 15000);
      const arr = Array.isArray(list) ? list : (list?.devices || []);
      // Capabilities are ~4KB of labels, icons and hints per device. The
      // model needs the constraints, not the product copy: one short string
      // per control keeps the range and the accepted values and drops the rest.
      const controls = (caps) => (caps || []).map((c) => {
        if (c.kind === 'range') return `${c.key} ${c.min}..${c.max}${c.unit || ''}`;
        if (c.options?.length) return `${c.key}=${c.options.map((o) => o.value).join('|')}`;
        return `${c.key}:${c.kind}`;
      });
      return arr.map((d) => ({
        id: d.id, name: d.name, kind: d.kind, room: d.room, available: d.available,
        state: d.state, controls: controls(d.capabilities),
      }));
    },
  },
  {
    name: 'fleet_hosts',
    description:
      'Every machine in the fleet with CPU and GPU temperature, CPU load and memory. '
      + 'This is the fast way to answer "what is the CPU temp on X" for any device.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const snap = await want(`${FLEET_URL}/api/hosts`);
      const hosts = snap?.hosts || (Array.isArray(snap) ? snap : []);
      return {
        at: snap?.at,
        hosts: hosts.map((h) => ({
          id: h.id, name: h.name, role: h.role, kind: h.kind, online: h.online, stale: h.stale,
          cpuTempC: h.cpu?.tempC ?? null, cpuPct: h.cpu?.pct ?? null, cpuLoad: h.cpu?.load ?? null,
          cpuModel: h.cpu?.model || null,
          gpuTempC: h.gpu?.tempC ?? null, gpuPct: h.gpu?.pct ?? null, gpuModel: h.gpu?.model || null,
          memPct: h.mem?.pct ?? null, batteryPct: h.battery?.pct ?? null,
          alerts: (h.alerts || []).map((x) => x.text),
        })),
      };
    },
  },
  {
    name: 'fleet_host',
    description:
      'Everything fleet knows about one machine: sensors, disks, network, services and open '
      + 'alerts. Use fleet_hosts first to get the id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Host id, e.g. hp, loq, disinteg.' } },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const h = await want(`${FLEET_URL}/api/hosts/${encodeURIComponent(id)}`);
      return h?.host || h;
    },
  },
  {
    name: 'agent_services',
    description: 'Services running in the agent module on this box, with their state and uptime.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const s = await get(`${AGENT_URL}/api/services`, 15000);
      const arr = Array.isArray(s) ? s : (s?.services || []);
      return arr.map((x) => ({ id: x.id, name: x.name, state: x.state, uptime: x.uptime, pid: x.pid }));
    },
  },
  {
    name: 'agent_restart_service',
    description:
      'Restart one service in the agent module. CHANGES STATE — confirm with the reader first '
      + 'and only for a service they named.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Service id from agent_services.' } },
      required: ['id'],
    },
    handler: async ({ id }) => post(`${AGENT_URL}/api/services/${encodeURIComponent(id)}/restart`, {}, 30000),
  },
  {
    name: 'ssh_run',
    description:
      'Run one shell command on another machine over ssh and return stdout, stderr and the exit '
      + 'code. Hosts: "loq" (the laptop) and "disinteg". disinteg is reached through loq, so expect '
      + 'it to be slower. Read-only commands are preferred; anything that changes the machine '
      + 'should be confirmed with the reader first.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: ['loq', 'disinteg'] },
        command: { type: 'string', description: 'The command to run, as one line of shell.' },
        timeout: { type: 'number', description: 'Seconds before it is killed (default 60, max 300).' },
      },
      required: ['host', 'command'],
    },
    handler: sshRun,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ── the transport ──────────────────────────────────────────────────── */

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isCall = id !== undefined && id !== null;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ojee', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return ok(id, {});

  if (method === 'tools/list') {
    return ok(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === 'tools/call') {
    const tool = BY_NAME.get(params?.name);
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.handler(params?.arguments || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return ok(id, { content: [{ type: 'text', text: text || '(nothing to show)' }] });
    } catch (e) {
      // A failed tool is an answer, not a broken session: the model reads it
      // and decides what to do next.
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  }

  if (isCall) fail(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Never let a handler's rejection kill the server: opencode would see the
    // MCP connection drop and the session would lose every tool at once.
    Promise.resolve().then(() => handle(msg)).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, e.message);
    });
  }
});
