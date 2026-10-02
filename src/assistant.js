/**
 * The Assistant, as seen from the console.
 *
 * The model itself is OpenCode — opencode.ai — and it is hosted on HP:
 * `opencode serve`, a headless server holding every session on disk. This file
 * is only a window onto it: list and open sessions, read a transcript, send a
 * message.
 *
 * Three things shape the code:
 *
 * opencode only answers reliably from inside an OpenCode process, so nothing
 * here talks to opencode.ai directly. Every call goes to OPENCODE_URL, which is
 * the server on HP. The subscription (OpenCode Go) is a credential on that
 * machine, not in this module — there is no API key anywhere in this repo, and
 * the models available are whatever `opencode serve` itself reports.
 *
 * A model can refuse. Quota, rate limit, a cold model pulled out of rotation —
 * they look the same from here: an HTTP error from one model. So a message may
 * walk down the preference order until one of them answers, and the pair that
 * actually answered comes back with the reply. The UI shows it, because "which
 * model am I on" is not a detail you should have to guess at. The reader can
 * also choose the model outright; that choice only decides where the walk
 * starts, not whether it may continue.
 *
 * A session's path is fixed when it is opened. opencode refuses to re-path a
 * live session (PATCH is a no-op for it), so the path is a property of the
 * request that creates the session and not an editable field afterwards. The
 * list shows the path every session has; the composer sets the one the next
 * session gets.
 */
const express = require('express');
const fetch = require('node-fetch');

const OPENCODE_URL = (process.env.OPENCODE_URL || '').replace(/\/+$/, '');

/**
 * Which providers the reader may pick from. `opencode` carries the free tier
 * and `opencode-go` the subscription; both are served by the same `opencode
 * serve`, so the answer is one request rather than a guess about entitlements.
 */
const PROVIDERS = (process.env.OPENCODE_PROVIDERS || 'opencode,opencode-go')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Fallback preference order — the free models, in the order they should be
 * tried when nothing better is known. Used when `opencode serve` cannot be
 * asked for its catalog, so a transient failure still leaves a working picker
 * rather than an empty one.
 */
const DEFAULT_ORDER = [
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free',
  'mimo-v2.5-free',
  'jev-1.13-free',
  'space-bunny-free',
  'ling-3.0-flash-fin-free',
  'longcat-2.5-preview-free',
  'nemotron-3-ultra-free',
  'fledge-alpha-free',
  'muse-spark-1.2-contributor-free',
].map((modelID) => ({ provider: 'opencode', id: modelID, name: modelID }));

/** Where a new session lands when the composer is left alone. */
const DEFAULT_PATH = process.env.OPENCODE_PATH || '/home/ojee';

/* A reply is worth waiting for: an agent turn may run tools for a while, and
   the first turn of a session carries the whole system prompt — on a busy
   machine that alone is a minute. */
const CHAT_TIMEOUT_MS = Number(process.env.OPENCODE_CHAT_TIMEOUT_MS || 300000);
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 15000);

const configured = () => !!OPENCODE_URL;

/**
 * One `fetch` with a deadline, returning the parsed body either way.
 * opencode answers 500 with a JSON body describing the failure, and that
 * description is the only thing that says whether the next model is worth a
 * try — so an error response is still read, never thrown away.
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

/* ── the model catalog and rotation ───────────────────────────────────── */

let modelCache = { at: 0, order: null };

/** `provider/id` — the one string the UI stores, sends and reads back. */
const key = (m) => `${m.provider}/${m.id}`;

/**
 * Resolve what the reader sent. A pair (`opencode-go/qwen3.8-max`) is taken
 * literally, and passed through even when the catalog has not listed it — an
 * operator pinning a model must not have it silently dropped. A bare id is
 * matched against the catalog, because only the server knows which provider a
 * given id lives under, and naming the wrong one is a 500 that reads like an
 * outage.
 */
function resolve(order, wanted) {
  if (!wanted) return null;
  const s = String(wanted).trim();
  if (!s) return null;
  if (s.includes('/')) {
    const at = s.indexOf('/');
    const provider = s.slice(0, at);
    const id = s.slice(at + 1);
    return order.find((m) => m.provider === provider && m.id === id)
      || { provider, id, name: id };
  }
  return order.find((m) => m.id === s) || null;
}

/** Everything the server says we may use, for the providers we expose. */
async function fetchCatalog() {
  const out = await ask(`${OPENCODE_URL}/provider`, {}, 15000);
  if (!out.ok || !Array.isArray(out.data?.all)) return [];
  const found = [];
  const seen = new Set();
  for (const p of out.data.all) {
    if (!PROVIDERS.includes(p.id)) continue;
    for (const m of Object.values(p.models || {})) {
      const id = m.modelID || m.id;
      if (!id || seen.has(`${p.id}/${id}`)) continue;
      seen.add(`${p.id}/${id}`);
      found.push({ provider: p.id, id, name: m.name || id });
    }
  }
  return found;
}

/**
 * Every model, in the order a message should try them.
 *
 * Read from `opencode serve` rather than hard-coded: the catalog is the
 * subscription's, it changes as models come and go, and only the server can
 * say which provider an id belongs to. `OPENCODE_MODELS` pins the head of the
 * list for an operator who wants one; failing to reach the server falls back
 * to DEFAULT_ORDER, so a blip leaves a working picker rather than an empty one.
 */
/* Whether the last catalog came from the server or the fallback list — the UI
   needs the difference so a blip cannot be read as "your model was removed". */
let catalogSource = null;

async function modelCatalog() {
  if (Date.now() - modelCache.at < 600000 && modelCache.order) return modelCache.order;

  const pinned = (process.env.OPENCODE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fromServer = await fetchCatalog();
  const pool = fromServer.length ? fromServer : DEFAULT_ORDER;
  catalogSource = fromServer.length ? 'server' : 'fallback';

  const rank = (m) => {
    const i = DEFAULT_ORDER.findIndex((d) => key(d) === key(m));
    return i === -1 ? DEFAULT_ORDER.length : i;
  };

  let order;
  if (pinned.length) {
    const head = pinned.map((s) => resolve(pool, s)).filter(Boolean);
    const headKeys = new Set(head.map(key));
    order = [...head, ...pool.filter((m) => !headKeys.has(key(m)))];
  } else {
    order = [...pool].sort((a, b) => rank(a) - rank(b)
      || a.provider.localeCompare(b.provider)
      || a.name.localeCompare(b.name));
  }

  modelCache = { at: Date.now(), order };
  return order;
}

/** The model a message will try first: the reader's pick, the last to answer,
 *  or the head of the order — in that order of preference. */
let currentModel = null;

async function preferredModel(wanted) {
  const order = await modelCatalog();
  const picked = resolve(order, wanted) || resolve(order, currentModel) || order[0] || null;
  if (picked) currentModel = key(picked);
  return picked;
}

/**
 * Is this the model refusing, or is the message just broken?
 *
 * Quota and rate limits are the case worth rotating on: another model in the
 * list will answer the same prompt. A malformed request — or an id this server
 * does not have — will fail on every model, and burning all of them on one bad
 * prompt only delays the error.
 */
function isModelExhausted(res) {
  if (res.status === 429) return true;
  const s = JSON.stringify(res.data || '').toLowerCase();
  if (/not found|unknown model|does not exist/.test(s)) return false;
  return /rate.?limit|quota|capacity|out of|exceeded|too many|temporarily unavailable|no available|credit|global regions|upstream request failed|region not/.test(s);
}

/* ── the routes ───────────────────────────────────────────────────────── */

function mount(app, auth) {
  const r = express.Router();

  r.get('/config', auth, async (_req, res) => {
    const order = await modelCatalog();
    const now = await preferredModel();
    res.json({
      configured: configured(),
      url: OPENCODE_URL || null,
      defaultPath: DEFAULT_PATH,
      catalog: catalogSource,
      model: now ? key(now) : null,
      models: order.map((m) => ({ ...m, key: key(m) })),
    });
  });

  /** The current model and everything else that could answer instead. */
  r.get('/models', auth, async (_req, res) => {
    const order = await modelCatalog();
    const now = await preferredModel();
    res.json({ model: now && key(now), models: order.map((m) => ({ ...m, key: key(m) })) });
  });

  /**
   * One session, for a transcript opened by deep link. The list is what gives
   * a session its title, and a link straight to the transcript should not
   * render the raw id where a title exists.
   */
  r.get('/sessions/:id', auth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'not configured' });
    const out = await ask(`${OPENCODE_URL}/session/${encodeURIComponent(req.params.id)}`, {}, 30000);
    if (!out.ok) return res.status(out.status === 404 ? 404 : 502).json({ error: out.error || `HTTP ${out.status}` });
    res.json(out.data);
  });

  /**
   * Every session, or every session opened in one path.
   * `?directory=` is passed through: opencode filters on it server-side, and
   * the UI keeps one path selected at a time rather than paging a year of
   * transcripts into a sidebar.
   */
  r.get('/sessions', auth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'not configured' });
    const q = req.query.directory ? `?directory=${encodeURIComponent(req.query.directory)}` : '';
    const out = await ask(`${OPENCODE_URL}/session${q}`);
    if (!out.ok) return res.status(502).json({ error: out.error || `HTTP ${out.status}` });
    res.json(Array.isArray(out.data) ? out.data : []);
  });

  /**
   * Open a session. The path arrives as `?directory=` on purpose: it is a
   * property of creation, and a body field is silently ignored by opencode.
   */
  r.post('/sessions', auth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'not configured' });
    const directory = String(req.body?.directory || DEFAULT_PATH).trim() || DEFAULT_PATH;
    const title = req.body?.title ? String(req.body.title).slice(0, 120) : undefined;
    const out = await ask(`${OPENCODE_URL}/session?directory=${encodeURIComponent(directory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    }, 30000);
    if (!out.ok) return res.status(502).json({ error: out.error || `HTTP ${out.status}` });
    res.json(out.data);
  });

  /** A transcript, as opencode stores it. */
  r.get('/sessions/:id/messages', auth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'not configured' });
    const out = await ask(`${OPENCODE_URL}/session/${encodeURIComponent(req.params.id)}/message`, {}, 30000);
    if (!out.ok) return res.status(502).json({ error: out.error || `HTTP ${out.status}` });
    res.json(Array.isArray(out.data) ? out.data : []);
  });

  /**
   * Send one message and take the first model that answers.
   *
   * `model` in the body is where the walk STARTS, not a ceiling: when the
   * reader's pick refuses, the rest of the order still get their turn, because
   * a refusing model is exactly what a fallback is for. The pair that replied
   * comes back with it and is remembered, so the next message starts there
   * instead of re-testing the models that just refused.
   */
  r.post('/sessions/:id/message', auth, async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'not configured' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });

    // Accept a string key or the { providerID, modelID } object opencode uses.
    const sent = req.body?.model;
    const wanted = typeof sent === 'string' && sent ? sent
      : sent && typeof sent === 'object' && sent.modelID
        ? `${sent.providerID || 'opencode'}/${sent.modelID}` : null;

    const order = await modelCatalog();
    const first = await preferredModel(wanted);
    const at = first ? order.findIndex((m) => key(m) === key(first)) : -1;
    const candidates = at === -1
      ? (first ? [first, ...order] : order)
      : [...order.slice(at), ...order.slice(0, at)];

    let last = null;
    for (const model of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const out = await ask(`${OPENCODE_URL}/session/${encodeURIComponent(req.params.id)}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: { providerID: model.provider, modelID: model.id },
          parts: [{ type: 'text', text }],
        }),
      }, CHAT_TIMEOUT_MS);

      // opencode reports some upstream failures as HTTP 200 carrying a message
      // with no parts in it — the turn was retried and gave up, and the only
      // signal left is that nothing came back. Counting that as an answer
      // would show an empty bubble AND pin the next message to the model that
      // just failed, so it is treated as a refusal and the walk continues.
      const parts = out.data?.parts || [];
      const said = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      const worked = parts.some((p) => p.type === 'tool');
      if (out.ok && (said || worked)) {
        currentModel = key(model);
        return res.json({ ...out.data, model: key(model) });
      }
      last = { model: key(model), ...out, error: out.ok ? 'empty reply' : out.error };
      if (out.ok || isModelExhausted(out)) continue;
      break;
    }

    res.status(502).json({
      error: last?.error || `HTTP ${last?.status}`,
      model: last?.model || null,
      detail: last?.data?.data?.message || last?.data?.name || null,
    });
  });

  app.use('/api/assistant', r);
  return true;
}

module.exports = { mount, configured, url: OPENCODE_URL };
