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

module.exports = function mountWork(app, auth, runners) {
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
      if (s.alive && !SAFE.has(s.state)) return ifDue ? res.json({ skipped: `busy (${s.state})` }) : res.status(409).json({ error: `The session is busy (${s.state}). The work loop sends the sweep when it is free.` });
      const text = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      await runner(found.runner, 'POST', `/sessions/${encodeURIComponent(s.id)}/message`, { text });
      writeStamp(Date.now());
      res.json({ ok: true, session: s.id, wasState: s.state });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
};
