/* ============================================================
   Work: the Forsa work picture for the Work view.

   The host builds it (ClickUp lists, sprint copies, open GitHub PRs) every
   ten minutes into one JSON file; this module only reads it. The ClickUp
   token never enters the container.

   "Sweep now" types the sweep prompt into the Conductor Claude session
   through the runner, but only while that session is between turns: typing
   into a busy session would dismiss an open question and lose its answer.
   ============================================================ */

const fs = require('fs');
const fetch = require('node-fetch');
const express = require('express');
const express_json = express.json({ limit: '64kb' });

const WORK_FILE = process.env.WORK_FILE || '/host/home/ojee/.local/share/forsa-work/work.json';
const PROMPT_FILE = process.env.WORK_PROMPT_FILE || '/host/home/ojee/.local/share/forsa-work/sweep-prompt.txt';
const SESSION_CWD = process.env.WORK_SESSION_CWD || '/home/ojee/work/forsa-ecosystem';
// Between turns: safe to type into. 'running' is mid-turn; 'starting' and
// 'queued' are handled by the runner's own send().
const SAFE = new Set(['idle', 'done', 'blocked', 'waiting', 'error', 'stopped']);
// When the last sweep went out: kept in the module's data volume so a restart
// does not send an extra one. The n8n "Forsa work loop" workflow calls
// /api/work/sweep?ifDue=55 every ten minutes; the button calls it without.
const STAMP_FILE = process.env.WORK_STAMP_FILE || '/app/data/work-sweep.json';
const readStamp = () => { try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')).at || 0; } catch { return 0; } };
const writeStamp = (at) => { try { fs.writeFileSync(STAMP_FILE, JSON.stringify({ at })); } catch { /* best effort */ } };

function readWork() {
  try {
    const st = fs.statSync(WORK_FILE);
    const data = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
    return { ...data, fileAgeMs: Date.now() - st.mtimeMs };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'The work file has not been built yet (forsa-work timer on the host).' : e.message };
  }
}

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

const NOTES_FILE = process.env.WORK_NOTES_FILE || '/app/data/work-messages.json';
const readNotes = () => { try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return []; } };
const writeNotes = (list) => { try { fs.writeFileSync(NOTES_FILE, JSON.stringify(list.slice(0, 200))); } catch { /* best effort */ } };
const clip = (v, n) => String(v || '').replace(/\s+$/, '').slice(0, n);

module.exports = function mountWork(app, auth, runners, emitNotify = () => {}) {
  // Messages from Claude to the owner: kept here (the Work tab's feed) and
  // pushed to the console's notifications. They replace the Discord webhook.
  app.get('/api/work/messages', auth, (_req, res) => res.json({ messages: readNotes() }));
  app.post('/api/work/messages', auth, express_json, (req, res) => {
    const b = req.body || {};
    const title = clip(b.title, 200);
    if (!title) return res.status(400).json({ error: 'A message needs a title.' });
    const severity = b.severity === 'warn' ? 'warn' : 'info';
    const m = { id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, body: clip(b.body, 4000), severity, link: clip(b.link, 500) || null, at: Date.now() };
    writeNotes([m, ...readNotes()]);
    emitNotify({ id: severity === 'warn' ? 'agent.work-alert' : 'agent.work-update', title: m.title, body: m.body.slice(0, 600), tag: `work:${m.id}`, severity, view: 'work', at: m.at });
    res.json({ ok: true, message: m });
  });

  app.get('/api/work', auth, (_req, res) => res.json(readWork()));

  app.get('/api/work/session', auth, async (_req, res) => {
    try {
      const found = await findSession(runners);
      res.json(found.error ? found : found.session);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  app.get('/api/work/sweep', auth, (_req, res) => res.json({ lastSweepAt: readStamp() || null }));

  app.post('/api/work/sweep', auth, async (req, res) => {
    try {
      const ifDue = Number(req.query.ifDue) || 0;
      if (ifDue && Date.now() - readStamp() < ifDue * 60_000) return res.json({ skipped: 'not due', lastSweepAt: readStamp() });
      const found = await findSession(runners);
      if (found.error) return res.status(409).json(found);
      const s = found.session;
      // The scheduled call skips quietly and tries again ten minutes later; the button says why.
      if (s.question) return ifDue ? res.json({ skipped: 'question open' }) : res.status(409).json({ error: 'The session is waiting on a question. Answer it in the Claude view first.' });
      // A busy session gets it too: Claude Code queues a message typed mid-turn
      // and reads it when the turn ends. Waiting for "between turns" meant the
      // Conductor, which is never idle for long, went a day without a sweep.
      const queued = s.alive && !SAFE.has(s.state);
      const text = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      await runner(found.runner, 'POST', `/sessions/${encodeURIComponent(s.id)}/message`, { text });
      writeStamp(Date.now());
      res.json({ ok: true, queued, session: s.id, wasState: s.state });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
};
