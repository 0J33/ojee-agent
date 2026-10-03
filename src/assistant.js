/**
 * The Assistant, as seen from the console.
 *
 * The model is OpenCode — `opencode serve` on HP, holding every session on
 * disk. This file is the console's side of it, and it does four things the
 * server alone does not:
 *
 *   1. One live connection. It holds a single subscription to opencode's
 *      global event stream (every directory, every session) and fans it out
 *      to the pages that have the Assistant open — so a reply streams into
 *      whichever window is looking, and keeps going when none is.
 *
 *   2. Turns that survive a refusing model. A message is sent asynchronously
 *      and watched. When the model refuses — quota, rate limit, the free tier
 *      turning the request away, a reply with nothing in it — the failed
 *      exchange is removed and the same words go to the next model, and the
 *      page is told which one took over. That runs here, not in the page,
 *      so it still happens after the quick chat is closed.
 *
 *   3. Settings: the default model, the fallback order, which tools ask
 *      first, which are off, and what pings. Stored in DATA_DIR.
 *
 *   4. Pings. A finished reply, a tool waiting for approval, a turn that
 *      failed — as `notify` events on /api/events (the phone app turns those
 *      into notifications) and, when ASSISTANT_DISCORD_WEBHOOK is set, Discord.
 *
 * Things learned the hard way, and kept:
 *
 * - opencode reports some upstream failures as a turn that ends with nothing
 *   in it. That is a refusal, not an answer, or the next message is pinned to
 *   the model that just failed.
 * - The free tier refuses any request whose tool set was changed — a `tools`
 *   map on the prompt, or a permission rule that DENIES a tool. Asking first
 *   is fine. So "off" is offered, and it takes the free models out of the
 *   walk instead of failing on each in turn.
 * - Permissions, messages and replies are per directory: every call carries
 *   the session's own `?directory=`, or opencode looks in the wrong instance
 *   and says there is nothing pending.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const fetch = require('node-fetch');
const L = require('./assistant-logic');

const OPENCODE_URL = (process.env.OPENCODE_URL || '').replace(/\/+$/, '');
const PROVIDERS = (process.env.OPENCODE_PROVIDERS || 'opencode,opencode-go')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DEFAULT_PATH = process.env.OPENCODE_PATH || '/home/ojee';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'assistant.json');
const WEBHOOK = process.env.ASSISTANT_DISCORD_WEBHOOK || '';
/* The host's filesystem, mounted read-only into the container: the folder
   picker reads it directly instead of opening an opencode instance in every
   directory it shows. Standalone (no /host), it falls back to opencode. */
const HOST_ROOT = process.env.HOST_ROOT || (fs.existsSync('/host/home') ? '/host' : '');
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 15000);
/* opencode retries a refusing provider on its own, with back-off. Twice is
   enough to know: after that the turn moves to the next model. */
const RETRY_LIMIT = Number(process.env.OPENCODE_RETRY_LIMIT || 2);

/** Fallback preference order when the server cannot be asked for its catalog. */
const DEFAULT_ORDER = [
  'mimo-v2.6-flash-free', 'deepseek-v4-flash-free', 'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free', 'mimo-v2.5-free', 'big-pickle', 'space-bunny-free',
  'ling-3.1-flash-free', 'longcat-2.5-preview-free', 'nemotron-3-ultra-free', 'fledge-alpha-free',
].map((id) => ({ provider: 'opencode', id, name: id }));

const configured = () => !!OPENCODE_URL;

/* ── talking to opencode ──────────────────────────────────────────────── */

/**
 * One call with a deadline, returning the parsed body either way: opencode
 * answers 500 with a JSON body describing the failure, and that description
 * is the only thing that says what went wrong.
 */
async function ask(url, opts = {}, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

/** `/session/x` in `dir`'s instance. */
function ocUrl(p, dir, query = {}) {
  const q = new URLSearchParams();
  if (dir) q.set('directory', dir);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `${OPENCODE_URL}${p}${s ? `?${s}` : ''}`;
}

const oc = (p, { dir, method = 'GET', body, query, timeout } = {}) => ask(ocUrl(p, dir, query), {
  method,
  headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
}, timeout);

/** The message opencode gave, or the transport's. */
const why = (out) => out.data?.data?.message || out.data?.message || out.error || `HTTP ${out.status}`;

/* ── the model catalog ────────────────────────────────────────────────── */

let modelCache = { at: 0, order: null, source: null };

async function fetchCatalog() {
  const out = await oc('/provider', { timeout: 15000 });
  if (!out.ok || !Array.isArray(out.data?.all)) return [];
  const found = [];
  const seen = new Set();
  for (const p of out.data.all) {
    if (!PROVIDERS.includes(p.id)) continue;
    for (const m of Object.values(p.models || {})) {
      const id = m.modelID || m.id;
      if (!id || seen.has(`${p.id}/${id}`) || m.status === 'deprecated') continue;
      seen.add(`${p.id}/${id}`);
      found.push({
        provider: p.id,
        id,
        name: m.name || id,
        context: m.limit?.context || null,
        cost: m.cost?.input ?? null,
        reasoning: !!m.reasoning,
      });
    }
  }
  return found;
}

/**
 * Every model, in the order a turn should try them: free models first, in
 * the order known to answer best, then the subscription's. `OPENCODE_MODELS`
 * pins the head for an operator who wants one.
 */
async function modelCatalog(force = false) {
  if (!force && Date.now() - modelCache.at < 600000 && modelCache.order) return modelCache.order;
  const pinned = (process.env.OPENCODE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fromServer = await fetchCatalog();
  const pool = fromServer.length ? fromServer : DEFAULT_ORDER;
  const rank = (m) => {
    const i = DEFAULT_ORDER.findIndex((d) => L.key(d) === L.key(m));
    return i === -1 ? DEFAULT_ORDER.length : i;
  };
  let order = [...pool].sort((a, b) => (L.isFree(b) - L.isFree(a)) || rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (pinned.length) {
    const head = pinned.map((s) => L.resolve(pool, s)).filter(Boolean);
    const keys = new Set(head.map(L.key));
    order = [...head, ...order.filter((m) => !keys.has(L.key(m)))];
  }
  modelCache = { at: Date.now(), order, source: fromServer.length ? 'server' : 'fallback' };
  return order;
}

/* ── settings ─────────────────────────────────────────────────────────── */

let settings = L.normalizeSettings({});
try { settings = L.normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch { /* first run */ }

function saveSettings(next) {
  settings = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 2));
    fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`assistant: could not save settings (${e.message})`);
  }
  return settings;
}

/* ── live state ───────────────────────────────────────────────────────── */

const H = {
  online: false,
  error: 'not connected yet',
  version: null,
  sessions: new Map(),    // id → session info
  listedAt: 0,
  status: new Map(),      // id → { type, attempt, message, next }
  perms: new Map(),       // permission id → request
  questions: new Map(),   // question id → request
  failed: new Map(),      // id → { model, error, at } — the last turn's failure
  turns: new Map(),       // id → the turn being supervised
  clients: new Set(),     // page streams
  pings: new Set(),       // /api/events streams (notify only)
  recentPings: [],
};

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of H.clients) res.write(frame);
}

/** What the page gets: every type it draws, nothing it does not. */
const FORWARD = new Set([
  'session.created', 'session.updated', 'session.deleted', 'session.status', 'session.idle', 'session.error',
  'session.compacted', 'message.updated', 'message.removed', 'message.part.updated', 'message.part.delta',
  'message.part.removed', 'permission.asked', 'permission.replied', 'question.asked', 'question.replied',
  'question.rejected', 'todo.updated',
]);

const dirOf = (id) => H.sessions.get(id)?.directory || null;

async function sessionInfo(id) {
  if (H.sessions.has(id)) return H.sessions.get(id);
  const out = await oc(`/session/${encodeURIComponent(id)}`, { timeout: 15000 });
  if (out.ok && out.data?.id) { H.sessions.set(id, out.data); return out.data; }
  return null;
}

/** What a page needs to draw a session row without fetching its transcript. */
function stateOf(id) {
  const st = H.status.get(id);
  const perms = [...H.perms.values()].filter((p) => p.sessionID === id);
  const qs = [...H.questions.values()].filter((q) => q.sessionID === id);
  const turn = H.turns.get(id);
  let state = 'idle';
  if (perms.length || qs.length) state = 'waiting';
  else if (st?.type === 'retry') state = 'retrying';
  else if (st?.type === 'busy' || turn) state = 'working';
  else if (H.failed.has(id)) state = 'error';
  return {
    state,
    retry: st?.type === 'retry' ? { attempt: st.attempt, message: st.message, next: st.next } : null,
    failed: H.failed.get(id) || null,
    turn: turn ? { model: L.key(turn.candidates[turn.i]), attempt: turn.i, startedAt: turn.startedAt } : null,
  };
}

/* ── turns ────────────────────────────────────────────────────────────── */

/**
 * Send one message and watch it through.
 *
 * `candidates` is the walk, first model to last. A turn knows which messages
 * it created (the user message, then each assistant step whose parentID is
 * that user message), whether anything was said or done, and the last error
 * — which is all it needs to decide, at idle, between done and next model.
 */
async function startTurn(sessionID, { text, agent, candidates, reason = null }) {
  const dir = dirOf(sessionID) || DEFAULT_PATH;
  const turn = {
    sessionID, dir, text, agent, candidates,
    i: 0,
    startedAt: Date.now(),
    sentAt: Date.now(),
    userIds: new Set(),
    asstIds: new Set(),
    texts: new Map(),
    produced: false,
    error: null,
    stopping: null,       // 'user' | 'fallback'
  };
  H.turns.set(sessionID, turn);
  H.failed.delete(sessionID);
  return sendTurn(turn, reason);
}

async function sendTurn(turn, reason) {
  const model = turn.candidates[turn.i];
  turn.sentAt = Date.now();
  turn.produced = false;
  turn.error = null;
  turn.stopping = null;
  turn.userIds.clear();
  turn.asstIds.clear();
  turn.texts.clear();
  // The settings decide what asks first; they are put on the session at each
  // message, so a change applies to every conversation, not only new ones.
  await oc(`/session/${encodeURIComponent(turn.sessionID)}`, {
    dir: turn.dir, method: 'PATCH', body: { permission: L.rulesFor(settings) },
  });
  const body = { parts: [{ type: 'text', text: turn.text }] };
  if (model) body.model = { providerID: model.provider, modelID: model.id };
  if (turn.agent) body.agent = turn.agent;
  const out = await oc(`/session/${encodeURIComponent(turn.sessionID)}/prompt_async`, { dir: turn.dir, method: 'POST', body, timeout: 30000 });
  broadcast('turn', { sessionID: turn.sessionID, phase: 'started', model: model ? L.key(model) : null, attempt: turn.i, reason });
  if (!out.ok) {
    H.turns.delete(turn.sessionID);
    const error = { name: 'SendError', data: { message: why(out) } };
    finishFailed(turn, error);
    return { ok: false, error: why(out) };
  }
  return { ok: true, model: model ? L.key(model) : null };
}

function finishFailed(turn, error) {
  const model = turn.candidates[turn.i];
  const f = { model: model ? L.key(model) : null, error: L.errorText(error), name: error?.name || null, at: Date.now() };
  H.failed.set(turn.sessionID, f);
  broadcast('turn', { sessionID: turn.sessionID, phase: 'failed', ...f });
  const s = H.sessions.get(turn.sessionID);
  if (settings.notify.errors) {
    notify('The Assistant could not answer', `${s?.title || 'A conversation'}: ${f.error}`, `assistant:err:${turn.sessionID}`, turn.sessionID);
  }
}

/** Remove a failed exchange, so the next model answers the same words cleanly. */
async function dropExchange(turn) {
  const ids = [...turn.asstIds, ...turn.userIds];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await oc(`/session/${encodeURIComponent(turn.sessionID)}/message/${encodeURIComponent(id)}`, { dir: turn.dir, method: 'DELETE' });
  }
}

/** The session went idle: done, failed, or on to the next model. */
async function settle(sessionID) {
  const turn = H.turns.get(sessionID);
  if (!turn || turn.settling) return;
  // A stale idle from before this turn was sent.
  if (Date.now() - turn.sentAt < 300 && !turn.userIds.size) return;
  turn.settling = true;
  try {
    if (turn.stopping === 'user') {
      H.turns.delete(sessionID);
      broadcast('turn', { sessionID, phase: 'stopped' });
      return;
    }
    const failed = turn.stopping === 'fallback' || (!turn.produced && L.isRefusal(turn.error)) || (!turn.produced && !turn.error);
    const model = turn.candidates[turn.i];
    if (failed && turn.i + 1 < turn.candidates.length && (turn.stopping === 'fallback' || L.isRefusal(turn.error))) {
      const reason = turn.error ? L.errorText(turn.error) : turn.stopping === 'fallback' ? 'kept retrying' : 'empty reply';
      await dropExchange(turn);
      const from = model ? L.key(model) : null;
      turn.i += 1;
      const to = L.key(turn.candidates[turn.i]);
      broadcast('turn', { sessionID, phase: 'fallback', from, to, reason });
      turn.settling = false;
      await sendTurn(turn, reason);
      return;
    }
    H.turns.delete(sessionID);
    if (failed || (turn.error && !turn.produced)) { finishFailed(turn, turn.error); return; }
    if (turn.error && turn.error.name !== 'MessageAbortedError') {
      // Said something, then failed: what was said stays, and so does the error.
      finishFailed(turn, turn.error);
      return;
    }
    broadcast('turn', { sessionID, phase: 'done', model: model ? L.key(model) : null, fellBack: turn.i > 0 });
    if (settings.notify.done) {
      const s = H.sessions.get(sessionID);
      const said = [...turn.texts.values()].join(' ').replace(/\s+/g, ' ').trim();
      notify(`Assistant: ${s?.title || 'reply ready'}`, said.slice(0, 300) || 'Finished.', `assistant:done:${sessionID}`, sessionID);
    }
  } finally {
    if (H.turns.get(sessionID) === turn) turn.settling = false;
  }
}

/** Feed one opencode event to the turn it belongs to. */
function track(type, p) {
  const sid = p?.sessionID || p?.info?.sessionID || p?.part?.sessionID;
  const turn = sid ? H.turns.get(sid) : null;
  if (!turn) return;
  if (type === 'message.updated') {
    const info = p.info;
    if (info.role === 'user' && (info.time?.created || 0) >= turn.sentAt - 5000) turn.userIds.add(info.id);
    if (info.role === 'assistant' && (turn.userIds.has(info.parentID) || (info.time?.created || 0) >= turn.sentAt - 1000)) {
      turn.asstIds.add(info.id);
      if (info.error && info.error.name !== 'MessageAbortedError') turn.error = info.error;
    }
  } else if (type === 'message.part.updated') {
    const part = p.part;
    if (!turn.asstIds.has(part.messageID)) return;
    if (part.type === 'text' && part.text?.trim()) { turn.produced = true; turn.texts.set(part.id, part.text); }
    if (part.type === 'tool') turn.produced = true;
  } else if (type === 'message.part.delta') {
    if (turn.asstIds.has(p.messageID) && p.field === 'text' && p.delta?.trim()) {
      // Reasoning streams as text too; only a text or tool part counts as an
      // answer, which part.updated settles. A delta proves the model is up.
    }
  } else if (type === 'session.error') {
    if (p.error?.name === 'MessageAbortedError') return;
    turn.error = p.error;
  } else if (type === 'session.status') {
    if (p.status?.type === 'retry' && settings.fallback && (p.status.attempt || 0) >= RETRY_LIMIT
      && turn.i + 1 < turn.candidates.length && !turn.stopping && !turn.produced) {
      turn.stopping = 'fallback';
      turn.error = { name: 'RetryError', data: { message: p.status.message || 'kept retrying' } };
      oc(`/session/${encodeURIComponent(sid)}/abort`, { dir: turn.dir, method: 'POST' });
    }
  }
}

/* ── the upstream stream ──────────────────────────────────────────────── */

let upstream = null;
let upTimer = null;
let watchdog = null;

function setOnline(on, error = null) {
  if (H.online === on && H.error === error) return;
  H.online = on;
  H.error = error;
  broadcast('upstream', { online: on, error });
}

function onEvent(ev) {
  const payload = ev?.payload;
  if (!payload?.type) return;
  const { type, properties: p = {} } = payload;
  if (type === 'server.connected' || type === 'server.heartbeat') return;

  switch (type) {
    case 'session.created':
    case 'session.updated':
      if (p.info?.id) H.sessions.set(p.info.id, { ...H.sessions.get(p.info.id), ...p.info });
      break;
    case 'session.deleted':
      if (p.info?.id) {
        H.sessions.delete(p.info.id); H.status.delete(p.info.id); H.failed.delete(p.info.id); H.turns.delete(p.info.id);
      }
      break;
    case 'session.status':
      if (p.status?.type === 'idle') H.status.delete(p.sessionID); else H.status.set(p.sessionID, p.status);
      break;
    case 'permission.asked': {
      H.perms.set(p.id, p);
      if (settings.notify.needsYou) {
        const s = H.sessions.get(p.sessionID);
        notify('The Assistant is asking', `${s?.title || 'A conversation'} wants to use ${p.permission}${p.patterns?.[0] && p.patterns[0] !== '*' ? `: ${p.patterns[0]}` : ''}`, `assistant:ask:${p.sessionID}`, p.sessionID);
      }
      break;
    }
    case 'permission.replied': H.perms.delete(p.requestID); break;
    case 'question.asked':
      H.questions.set(p.id, p);
      if (settings.notify.needsYou) notify('The Assistant has a question', p.questions?.[0]?.question || '', `assistant:ask:${p.sessionID}`, p.sessionID);
      break;
    case 'question.replied':
    case 'question.rejected': H.questions.delete(p.requestID); break;
    default: break;
  }

  track(type, p);
  if (FORWARD.has(type)) broadcast('oc', { type, properties: p, directory: ev.directory || null });
  if (type === 'session.idle' || (type === 'session.status' && p.status?.type === 'idle')) {
    setTimeout(() => settle(p.sessionID), 50);
  }
}

function connect() {
  if (!configured() || upstream) return;
  const target = new URL('/global/event', OPENCODE_URL);
  const lib = target.protocol === 'https:' ? https : http;
  let buf = '';
  const req = lib.request(target, { headers: { accept: 'text/event-stream' } });
  upstream = req;
  const retry = (error) => {
    if (upstream !== req) return;
    upstream = null;
    req.destroy();
    clearTimeout(watchdog);
    setOnline(false, error);
    clearTimeout(upTimer);
    upTimer = setTimeout(connect, 5000);
  };
  // opencode sends a heartbeat every ten seconds; silence means it is gone.
  const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => retry('stopped answering'), 35000); };
  req.on('response', (r) => {
    if (r.statusCode !== 200) { r.resume(); retry(`HTTP ${r.statusCode}`); return; }
    alive();
    setOnline(true, null);
    // Anything that happened while it was down: re-read what is pending.
    refreshPending();
    r.setEncoding('utf8');
    r.on('data', (chunk) => {
      alive();
      buf += chunk;
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch { /* not ours */ }
      }
    });
    r.on('end', () => retry('the stream closed'));
    r.on('error', () => retry('the stream broke'));
  });
  req.on('error', (e) => retry(e.code === 'ECONNREFUSED' ? 'not running' : (e.code || e.message)));
  req.end();
}

/** Sessions, statuses and pending prompts, read afresh. */
async function listSessions() {
  let out = await oc('/experimental/session', { query: { limit: 500, roots: 'true' }, timeout: 20000 });
  if (!out.ok || !Array.isArray(out.data)) out = await oc('/session', { timeout: 20000 });
  if (!out.ok || !Array.isArray(out.data)) return { error: why(out) };
  for (const s of out.data) H.sessions.set(s.id, { ...H.sessions.get(s.id), ...s });
  H.listedAt = Date.now();
  return { list: out.data };
}

/** Directories something might be pending in: those used in the last two days. */
function liveDirs() {
  const cut = Date.now() - 2 * 86400000;
  const dirs = new Set([DEFAULT_PATH]);
  for (const s of H.sessions.values()) if ((s.time?.updated || 0) > cut && s.directory) dirs.add(s.directory);
  return [...dirs].slice(0, 12);
}

async function refreshPending() {
  if (!H.sessions.size) await listSessions();
  const dirs = liveDirs();
  const res = await Promise.all(dirs.map(async (dir) => {
    const [st, pe, qu] = await Promise.all([
      oc('/session/status', { dir }), oc('/permission', { dir }), oc('/question', { dir }),
    ]);
    return { st, pe, qu };
  }));
  H.perms.clear();
  H.questions.clear();
  for (const { st, pe, qu } of res) {
    if (st.ok && st.data && typeof st.data === 'object') {
      for (const [id, v] of Object.entries(st.data)) if (v?.type && v.type !== 'idle') H.status.set(id, v);
    }
    if (pe.ok && Array.isArray(pe.data)) for (const p of pe.data) H.perms.set(p.id, p);
    if (qu.ok && Array.isArray(qu.data)) for (const q of qu.data) H.questions.set(q.id, q);
  }
}

/* ── pings ────────────────────────────────────────────────────────────── */

function notify(title, body, tag, sessionID) {
  const n = { title, body, tag, sessionID: sessionID || null, at: Date.now(), discord: !!WEBHOOK };
  H.recentPings.unshift(n);
  H.recentPings.length = Math.min(H.recentPings.length, 20);
  const frame = `event: notify\ndata: ${JSON.stringify({ title, body, tag, view: 'assistant', id: sessionID || null })}\n\n`;
  for (const res of H.pings) res.write(frame);
  broadcast('notify', n);
  if (WEBHOOK) {
    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: title.slice(0, 250), description: String(body || '').slice(0, 1500), color: 0x00ffff }] }),
    }).catch(() => { n.discord = false; });
  }
}

/* ── the folder picker ────────────────────────────────────────────────── */

async function listDir(p, hidden) {
  const want = path.posix.normalize(p || DEFAULT_PATH);
  if (!want.startsWith('/')) return { error: 'A folder starts with /' };
  const parent = want === '/' ? null : path.posix.dirname(want);
  if (HOST_ROOT) {
    try {
      const real = path.join(HOST_ROOT, want);
      const items = await fs.promises.readdir(real, { withFileTypes: true });
      const dirs = items.filter((d) => d.isDirectory() || (d.isSymbolicLink() && (() => { try { return fs.statSync(path.join(real, d.name)).isDirectory(); } catch { return false; } })()));
      const shown = dirs.filter((d) => hidden || !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
      const entries = shown.slice(0, 1000).map((d) => ({
        name: d.name,
        path: path.posix.join(want, d.name),
        git: fs.existsSync(path.join(real, d.name, '.git')),
      }));
      return { path: want, parent, home: DEFAULT_PATH, entries, truncated: shown.length > 1000 };
    } catch (e) {
      return { path: want, parent, home: DEFAULT_PATH, entries: [], error: e.code === 'ENOENT' ? 'No such folder' : e.code === 'EACCES' ? 'Not allowed to read this folder' : e.message };
    }
  }
  const out = await oc('/file', { dir: '/', query: { path: want.slice(1) || '.' } });
  if (!out.ok || !Array.isArray(out.data)) return { path: want, parent, home: DEFAULT_PATH, entries: [], error: why(out) };
  const entries = out.data.filter((n) => n.type === 'directory' && (hidden || !n.name.startsWith('.')))
    .map((n) => ({ name: n.name, path: n.absolute, git: false }));
  return { path: want, parent, home: DEFAULT_PATH, entries };
}

/* ── the routes ───────────────────────────────────────────────────────── */

function bad(res, status, error) { return res.status(status).json({ error }); }

function mount(app, auth) {
  const r = express.Router();
  const need = (_req, res, next) => (configured() ? next() : bad(res, 503, 'OPENCODE_URL is not set'));

  r.get('/config', auth, async (_req, res) => {
    if (!configured()) return res.json({ configured: false });
    const [order, health, agents, mcp] = await Promise.all([
      modelCatalog(),
      oc('/global/health', { timeout: 5000 }),
      oc('/agent', { dir: DEFAULT_PATH, timeout: 8000 }),
      oc('/mcp', { dir: DEFAULT_PATH, timeout: 8000 }),
    ]);
    if (health.ok) H.version = health.data?.version || null;
    res.json({
      configured: true,
      url: OPENCODE_URL,
      reachable: health.ok,
      error: health.ok ? null : why(health),
      version: H.version,
      online: H.online,
      defaultPath: DEFAULT_PATH,
      home: DEFAULT_PATH.startsWith('/home/') ? DEFAULT_PATH.split('/').slice(0, 3).join('/') : null,
      catalog: modelCache.source,
      models: order.map((m) => ({ ...m, key: L.key(m), free: L.isFree(m) })),
      agents: agents.ok && Array.isArray(agents.data)
        ? agents.data.filter((a) => a.mode !== 'subagent' && !a.hidden).map((a) => ({ name: a.name, description: a.description || '' }))
        : [{ name: 'build', description: '' }, { name: 'plan', description: '' }],
      mcp: mcp.ok ? mcp.data : null,
      settings,
      webhook: !!WEBHOOK,
      pings: H.recentPings.slice(0, 10),
    });
  });

  r.put('/settings', auth, (req, res) => res.json(saveSettings(L.patchSettings(settings, req.body || {}))));

  r.post('/notify/test', auth, (_req, res) => {
    notify('Assistant test ping', 'If you can read this, pings from the Assistant arrive.', 'assistant:test');
    res.json({ ok: true, discord: !!WEBHOOK });
  });

  /** Every session with its live state — what the list and the overview draw. */
  r.get('/state', auth, need, async (req, res) => {
    if (req.query.fresh || Date.now() - H.listedAt > 30000 || !H.sessions.size) {
      const out = await listSessions();
      if (out.error && !H.sessions.size) return bad(res, 502, out.error);
    }
    const sessions = [...H.sessions.values()]
      .filter((s) => !s.parentID && !s.time?.archived)
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .map((s) => ({ ...s, live: stateOf(s.id) }));
    res.json({
      online: H.online,
      error: H.error,
      sessions,
      permissions: [...H.perms.values()],
      questions: [...H.questions.values()],
    });
  });

  /** The page's live stream: opencode's events, and this module's own. */
  r.get('/events', auth, (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    res.write(`event: upstream\ndata: ${JSON.stringify({ online: H.online, error: H.error })}\n\n`);
    H.clients.add(res);
    connect();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); H.clients.delete(res); });
  });

  r.get('/sessions/:id', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    res.json({ ...s, live: stateOf(s.id) });
  });

  r.get('/sessions/:id/messages', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const out = await oc(`/session/${encodeURIComponent(s.id)}/message`, { dir: s.directory, timeout: 30000 });
    if (!out.ok) return bad(res, 502, why(out));
    res.json({
      session: { ...s, live: stateOf(s.id) },
      messages: Array.isArray(out.data) ? out.data : [],
      permissions: [...H.perms.values()].filter((p) => p.sessionID === s.id),
      questions: [...H.questions.values()].filter((q) => q.sessionID === s.id),
    });
  });

  /**
   * Open a conversation. The directory is a property of creation — opencode
   * will not re-path a live session — so it arrives here and nowhere else.
   * With `text`, the first message goes straight after.
   */
  r.post('/sessions', auth, need, async (req, res) => {
    const b = req.body || {};
    const quick = b.source === 'quick';
    const directory = String(b.directory || (quick ? settings.quickPath : null) || DEFAULT_PATH).trim() || DEFAULT_PATH;
    const body = { permission: L.rulesFor(settings), metadata: { source: quick ? 'quick' : 'view' } };
    if (b.title) body.title = String(b.title).slice(0, 120);
    const out = await oc('/session', { dir: directory, method: 'POST', body, timeout: 30000 });
    if (!out.ok || !out.data?.id) return bad(res, 502, why(out));
    H.sessions.set(out.data.id, out.data);
    let sent = null;
    if (b.text && String(b.text).trim()) {
      sent = await prompt(out.data.id, b);
    }
    res.json({ ...out.data, live: stateOf(out.data.id), sent });
  });

  r.patch('/sessions/:id', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const title = String(req.body?.title || '').trim().slice(0, 120);
    if (!title) return bad(res, 400, 'A title cannot be empty');
    const out = await oc(`/session/${encodeURIComponent(s.id)}`, { dir: s.directory, method: 'PATCH', body: { title } });
    if (!out.ok) return bad(res, 502, why(out));
    H.sessions.set(s.id, { ...s, ...out.data });
    res.json(out.data);
  });

  r.delete('/sessions/:id', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    if (H.status.get(s.id)) await oc(`/session/${encodeURIComponent(s.id)}/abort`, { dir: s.directory, method: 'POST' });
    H.turns.delete(s.id);
    const out = await oc(`/session/${encodeURIComponent(s.id)}`, { dir: s.directory, method: 'DELETE' });
    if (!out.ok) return bad(res, 502, why(out));
    H.sessions.delete(s.id); H.failed.delete(s.id); H.status.delete(s.id);
    res.json({ ok: true });
  });

  async function prompt(id, b) {
    const text = String(b.text || '').trim();
    if (!text) return { ok: false, error: 'Nothing to send' };
    const s = await sessionInfo(id);
    if (!s) return { ok: false, error: 'No such conversation' };
    if (H.turns.has(id) || H.status.get(id)) return { ok: false, error: 'Still answering — stop it first, or wait' };
    const order = await modelCatalog();
    const sent = typeof b.model === 'string' ? b.model : null;
    // The session remembers the model its last message went to. When that
    // message failed on every model, the one it names is the one that just
    // refused — starting there again is how a conversation gets stuck.
    const recorded = s.model?.providerID ? `${s.model.providerID}/${s.model.id}` : null;
    const last = H.failed.get(id)?.model === recorded ? null : recorded;
    const first = L.resolve(order, sent) || L.resolve(order, last) || L.resolve(order, settings.defaultModel) || order[0];
    const agent = ['build', 'plan'].includes(b.agent) ? b.agent : (s.agent || settings.agent);
    const list = L.candidates(order, { first, fallbacks: settings.fallbacks, fallback: settings.fallback, freeOk: L.freeOk(settings) });
    if (!list.length) return { ok: false, error: 'No model can take this: every tool switched off rules out the free tier, and no other model is listed' };
    H.turns.delete(id);
    return startTurn(id, { text, agent, candidates: list });
  }

  /** Send a message. Returns at once; the reply arrives on /events. */
  r.post('/sessions/:id/prompt', auth, need, async (req, res) => {
    const out = await prompt(req.params.id, req.body || {});
    if (!out.ok) return bad(res, out.error === 'No such conversation' ? 404 : 409, out.error);
    res.json(out);
  });

  /** The last message again — the failed exchange removed first. */
  r.post('/sessions/:id/retry', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const out = await oc(`/session/${encodeURIComponent(s.id)}/message`, { dir: s.directory, timeout: 30000 });
    if (!out.ok || !Array.isArray(out.data)) return bad(res, 502, why(out));
    const msgs = out.data;
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].info.role === 'user') { at = i; break; }
    if (at < 0) return bad(res, 409, 'There is nothing to retry');
    const text = msgs[at].parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim();
    for (const m of msgs.slice(at).reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await oc(`/session/${encodeURIComponent(s.id)}/message/${encodeURIComponent(m.info.id)}`, { dir: s.directory, method: 'DELETE' });
    }
    H.failed.delete(s.id);
    const sent = await prompt(s.id, { ...req.body, text });
    if (!sent.ok) return bad(res, 409, sent.error);
    res.json(sent);
  });

  r.post('/sessions/:id/abort', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const turn = H.turns.get(s.id);
    if (turn) turn.stopping = 'user';
    const out = await oc(`/session/${encodeURIComponent(s.id)}/abort`, { dir: s.directory, method: 'POST' });
    if (!out.ok) return bad(res, 502, why(out));
    // Idle never comes for a turn that had not started yet.
    setTimeout(() => { if (H.turns.get(s.id) === turn && !H.status.get(s.id)) settle(s.id); }, 1500);
    res.json({ ok: true });
  });

  r.post('/sessions/:id/permissions/:pid', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const reply = req.body?.reply;
    if (!['once', 'always', 'reject'].includes(reply)) return bad(res, 400, 'reply is once, always or reject');
    const body = { reply };
    if (req.body?.message) body.message = String(req.body.message).slice(0, 500);
    const out = await oc(`/permission/${encodeURIComponent(req.params.pid)}/reply`, { dir: s.directory, method: 'POST', body });
    if (!out.ok) return bad(res, out.status === 404 ? 404 : 502, why(out));
    H.perms.delete(req.params.pid);
    res.json({ ok: true });
  });

  r.post('/sessions/:id/questions/:qid', auth, need, async (req, res) => {
    const s = await sessionInfo(req.params.id);
    if (!s) return bad(res, 404, 'No such conversation');
    const reject = !!req.body?.reject;
    const out = reject
      ? await oc(`/question/${encodeURIComponent(req.params.qid)}/reject`, { dir: s.directory, method: 'POST', body: {} })
      : await oc(`/question/${encodeURIComponent(req.params.qid)}/reply`, { dir: s.directory, method: 'POST', body: { answers: Array.isArray(req.body?.answers) ? req.body.answers : [] } });
    if (!out.ok) return bad(res, 502, why(out));
    H.questions.delete(req.params.qid);
    res.json({ ok: true });
  });

  r.get('/fs', auth, need, async (req, res) => {
    const out = await listDir(req.query.path, req.query.hidden === '1');
    const recent = [];
    for (const s of [...H.sessions.values()].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))) {
      if (s.directory && !recent.includes(s.directory)) recent.push(s.directory);
      if (recent.length >= 6) break;
    }
    res.json({ ...out, recent });
  });

  app.use('/api/assistant', r);

  /**
   * The module's ping stream: the phone app subscribes to every module's
   * /api/events and turns `notify` events into notifications.
   */
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    H.pings.add(res);
    connect();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); H.pings.delete(res); });
  });

  // Watch from the start: a turn must be supervised whether or not a page is open.
  if (configured()) setTimeout(connect, 500);
  return true;
}

/** The Assistant's line for the console's front page. Never throws. */
async function summary() {
  if (!configured()) return { configured: false };
  if (!H.sessions.size && H.online) await listSessions().catch(() => null);
  const roots = [...H.sessions.values()].filter((s) => !s.parentID && !s.time?.archived);
  const states = roots.map((s) => ({ s, ...stateOf(s.id) }));
  return {
    configured: true,
    up: H.online,
    error: H.online ? null : H.error,
    working: states.filter((x) => x.state === 'working' || x.state === 'retrying').length,
    waiting: states.filter((x) => x.state === 'waiting').map((x) => ({ id: x.s.id, title: x.s.title })),
    failed: states.filter((x) => x.state === 'error').length,
    sessions: roots.length,
  };
}

module.exports = { mount, configured, summary, url: OPENCODE_URL };
