/**
 * The Laya tool router, as seen from the console.
 *
 * The router itself runs on Loq, because that is where the GPU is. This file
 * is only a window onto it: status, an on/off switch, and a box to try an
 * utterance against it.
 *
 * Two things shape the code:
 *
 * Loq is a laptop. It sleeps, it leaves the house, it gets shut. So every
 * call here treats "no answer" as a state to render, not an error to throw —
 * an unreachable router is a normal Tuesday, and the module must show a
 * router that is off rather than a module that is broken.
 *
 * The switch talks to the supervisor (8401), never to the router (8400).
 * Asking the router to turn itself off works exactly once and then there is
 * nobody left to turn it back on. The supervisor is a separate always-on
 * process holding no GPU memory, and it is what survives the off.
 */
const express = require('express');
const fetch = require('node-fetch');

const ROUTER_URL = (process.env.ROUTER_URL || '').replace(/\/+$/, '');
const SUPERVISOR_URL = (process.env.ROUTER_SUPERVISOR_URL || '').replace(/\/+$/, '');

/* The n8n front door that decides AND runs the tool. Proxied through here
   rather than called from the page: same-origin keeps the browser out of
   cross-origin rules, and the console's auth already covers this route. */
const ASSISTANT_URL = (process.env.ASSISTANT_URL
  || `${(process.env.N8N_URL || 'http://n8n:5678').replace(/\/+$/, '')}/webhook/assistant`);

/** Loq may be asleep; a short timeout keeps the console responsive. */
const TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS || 2500);

async function ask(url, opts = {}, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    // AbortError and ECONNREFUSED mean the same thing to a reader: not there.
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

function mount(app, auth) {
  if (!ROUTER_URL || !SUPERVISOR_URL) return false;
  const r = express.Router();

  r.get('/status', auth, async (_req, res) => {
    const sup = await ask(`${SUPERVISOR_URL}/status`);
    if (!sup.ok) {
      return res.json({ reachable: false, reason: sup.error, enabled: false });
    }
    // The supervisor knows whether the unit is up; only the router itself
    // knows whether the weights are parked, so ask it too when it is running.
    const health = sup.data.enabled ? await ask(`${ROUTER_URL}/health`) : null;
    // The language model lives in ollama, a separate service, so whether it is
    // resident is its own question — and the one that explains a slow first
    // reply.
    const chat = sup.data.enabled ? await ask(`${ROUTER_URL}/chat/health`, {}, 6000) : null;
    res.json({
      reachable: true,
      enabled: !!sup.data.enabled,
      chat: chat && chat.ok ? chat.data : null,
      gpu: sup.data.gpu || null,
      ready: !!(health && health.ok),
      parked: health && health.ok ? !!health.data.parked : null,
      idleMin: health && health.ok ? health.data.idle_min : null,
      labels: health && health.ok ? health.data.labels : null,
      gates: health && health.ok ? health.data.gates : null,
    });
  });

  r.post('/toggle', auth, async (req, res) => {
    const want = !!req.body?.enabled;
    const out = await ask(`${SUPERVISOR_URL}/${want ? 'on' : 'off'}`,
      { method: 'POST' }, 15000);
    if (!out.ok) return res.status(502).json({ error: out.error });
    res.json({ enabled: !!out.data.enabled, gpu: out.data.gpu || null });
  });

  r.post('/route', auth, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });
    // Loading the model on a cold start takes longer than a status poll should.
    const out = await ask(`${ROUTER_URL}/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }, 20000);
    if (!out.ok) return res.status(502).json({ error: out.error });
    res.json(out.data);
  });

  /**
   * Ask: decide AND run, in one call.
   *
   * The timeout is generous because this is the whole chain — the router on
   * Loq, then whichever tool it picked, which may itself be fetching a web
   * page or grepping a repo. A tight timeout here would report "unreachable"
   * for a tool that was merely slow.
   */
  r.post('/ask', auth, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });
    // Anything else on the body (id, project, url …) is the caller supplying
    // the arguments a previous needs_args asked for.
    const { text: _drop, ...args } = req.body || {};
    const out = await ask(ASSISTANT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...args }),
    }, 45000);
    if (!out.ok) return res.status(502).json({ error: out.error });
    res.json(out.data);
  });

  /**
   * Chat: the whole chain in one call — route, resolve the noun, run the tool,
   * then a small local model writes the reply.
   *
   * The long timeout is the point. A cold ollama load is ~40s on its own, and
   * the tool in the middle may be fetching a page. Reporting "unreachable"
   * because the first message of the day was slow would be a lie.
   */
  r.post('/chat', auth, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'no message' });
    const out = await ask(`${ROUTER_URL}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        session: String(req.body?.session || 'console'),
        given: req.body?.given || null,
      }),
    }, 120000);
    if (!out.ok) return res.status(502).json({ error: out.error });
    res.json(out.data);
  });

  r.post('/chat/reset', auth, async (req, res) => {
    const out = await ask(`${ROUTER_URL}/chat/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '.', session: String(req.body?.session || 'console') }),
    }, 15000);
    res.json(out.ok ? out.data : { error: out.error });
  });

  app.use('/api/router', r);
  return true;
}

module.exports = { mount, configured: () => !!(ROUTER_URL && SUPERVISOR_URL) };
