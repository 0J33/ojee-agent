/* ============================================================
   Forsa work loop: the server half only, kept until forsa-aios
   replaces it.

   The Work tab is gone from this module (26 Nov: the work product
   moves to forsa-aios; the UI is in git history, ui/work.js before
   the redesign). What stays are the endpoints something on HP still
   calls, so the Forsa loop keeps running in the meantime:

     POST /api/work/sweep?ifDue=55   n8n "Forsa work loop", every ten
                                     minutes: types the sweep prompt into
                                     the Conductor session if it is due
     GET  /api/work/sweep            when the last sweep went out
     POST /api/work/messages         notify.py on HP: Claude's messages to
                                     the owner, raised as notifications
     GET  /api/work/messages         the same feed, read back
     GET  /api/work/replies          owner_replies.py: the owner's open
     POST /api/work/replies/handled  answers, and marking one handled

   Nothing here is drawn by the UI. Delete this file and its mount in
   server.js once forsa-aios owns the loop.
   ============================================================ */

const fs = require('fs');
const fetch = require('node-fetch');
const express = require('express');
const express_json = express.json({ limit: '64kb' });

const HOST_DIR = process.env.WORK_HOST_DIR || '/host/home/ojee/.local/share/forsa-work';
const PROMPT_FILE = process.env.WORK_PROMPT_FILE || `${HOST_DIR}/sweep-prompt.txt`;
const SESSION_CWD = process.env.WORK_SESSION_CWD || '/home/ojee/work/forsa-ecosystem';
// Between turns: safe to type into. 'running' is mid-turn; 'starting' and
// 'queued' are handled by the runner's own send().
const SAFE = new Set(['idle', 'done', 'blocked', 'waiting', 'error', 'stopped']);
// When the last sweep went out: kept in the module's data volume so a restart
// does not send an extra one. The n8n "Forsa work loop" workflow calls
// /api/work/sweep?ifDue=55 every ten minutes; the button calls it without.
const STAMP_FILE = process.env.WORK_STAMP_FILE || '/app/data/work-sweep.json';
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };
const writeJson = (p, v) => { try { fs.writeFileSync(`${p}.tmp`, JSON.stringify(v)); fs.renameSync(`${p}.tmp`, p); } catch { /* best effort */ } };
const readStamp = () => readJson(STAMP_FILE, {}).at || 0;
const writeStamp = (at) => writeJson(STAMP_FILE, { at });

async function runner(r, method, path, body) {
  const res = await fetch(`${r.url}/api${path}`, {
    method,
    timeout: 8000,
    headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error((json && (json.error || json.message)) || `runner answered ${res.status}`);
  return json;
}

async function findSession(runners) {
  const r = runners[0];
  if (!r) return { error: 'No Claude runner is configured.' };
  const { sessions = [] } = await runner(r, 'GET', '/sessions');
  const s = sessions.filter((x) => x.cwd === SESSION_CWD)
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
  if (!s) return { error: `No Claude session in ${SESSION_CWD}.` };
  return {
    runner: r,
    session: {
      id: s.id, title: s.title, state: s.state, alive: s.alive, question: !!s.question,
      lastActivityAt: s.lastActivityAt, lastPromptAt: s.lastPromptAt,
      lastAssistant: String(s.lastAssistant || '').slice(0, 400),
    },
  };
}

/** Type a prompt into the Conductor session. Throws with a status for the caller. */
async function tellConductor(runners, text, { quietIfQuestion = false } = {}) {
  const found = await findSession(runners);
  if (found.error) throw Object.assign(new Error(found.error), { status: 409 });
  const s = found.session;
  if (s.question) {
    if (quietIfQuestion) return { skipped: 'question open' };
    throw Object.assign(new Error('The session is waiting on a question. Answer it in the Claude view first.'), { status: 409 });
  }
  const queued = s.alive && !SAFE.has(s.state);
  await runner(found.runner, 'POST', `/sessions/${encodeURIComponent(s.id)}/message`, { text });
  return { ok: true, queued, session: s.id, wasState: s.state };
}

const NOTES_FILE = process.env.WORK_NOTES_FILE || '/app/data/work-messages.json';
const readNotes = () => readJson(NOTES_FILE, []);
const writeNotes = (list) => writeJson(NOTES_FILE, list.slice(0, 200));
const clip = (v, n) => String(v || '').replace(/\s+$/, '').slice(0, n);

const REPLIES_FILE = process.env.WORK_REPLIES_FILE || '/app/data/owner-replies.json';
const readReplies = () => readJson(REPLIES_FILE, []);
const writeReplies = (list) => writeJson(REPLIES_FILE, list.slice(0, 300));

module.exports = function mountWorkLegacy(app, auth, runners, emitNotify = () => {}) {
  // Messages from Claude to the owner: kept here (the Work tab's feed) and
  // pushed to the console's notifications. They replace the Discord webhook.
  // A message with a key that is already in the feed is not sent again
  // (notify.py dedupes too; this catches a second sender).
  app.get('/api/work/messages', auth, (_req, res) => res.json({ messages: readNotes() }));
  app.post('/api/work/messages', auth, express_json, (req, res) => {
    const b = req.body || {};
    const title = clip(b.title, 200);
    if (!title) return res.status(400).json({ error: 'A message needs a title.' });
    const severity = b.severity === 'warn' ? 'warn' : 'info';
    const key = b.key ? clip(b.key, 120) : null;
    const list = readNotes();
    const dup = key && list.find((x) => x.key === key && Date.now() - x.at < 7 * 86400000);
    if (dup) return res.json({ ok: true, deduped: true, message: dup });
    const m = { id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, body: clip(b.body, 4000), severity, link: clip(b.link, 500) || null, key, decision: !!b.decision, at: Date.now() };
    writeNotes([m, ...list]);
    const kind = severity === 'warn' ? 'agent.work-alert' : 'agent.work-update';
    emitNotify({ id: kind, key: `${kind}:${key || m.id}`, title: m.title, body: m.body.slice(0, 600), severity, at: m.at });
    res.json({ ok: true, message: m });
  });

  /* ── the owner's answers ─────────────────────────────────────────── */

  app.get('/api/work/replies', auth, (_req, res) => res.json({ replies: readReplies() }));
  app.post('/api/work/replies/handled', auth, express_json, (req, res) => {
    const id = clip(req.body?.id, 80);
    const list = readReplies();
    let n = 0;
    for (const x of list) if (x.id === id && !x.handled) { x.handled = true; x.handledAt = Date.now(); x.note = clip(req.body?.note, 1000) || null; n += 1; }
    writeReplies(list);
    res.json({ ok: n > 0, handled: n });
  });
  /* ── the Conductor session ───────────────────────────────────────── */

  app.get('/api/work/sweep', auth, (_req, res) => res.json({ lastSweepAt: readStamp() || null }));

  app.post('/api/work/sweep', auth, async (req, res) => {
    try {
      const ifDue = Number(req.query.ifDue) || 0;
      if (ifDue && Date.now() - readStamp() < ifDue * 60_000) return res.json({ skipped: 'not due', lastSweepAt: readStamp() });
      const text = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      // The scheduled call skips quietly and tries again ten minutes later; the button says why.
      const r = await tellConductor(runners, text, { quietIfQuestion: !!ifDue });
      if (r.ok) writeStamp(Date.now());
      res.json(r);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

};

