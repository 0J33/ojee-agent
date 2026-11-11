/* ============================================================
   Work: the Forsa work picture for the Work view.

   The host builds it (ClickUp lists, sprint copies, open GitHub PRs) every
   ten minutes into one JSON file; this module only reads it. The ClickUp
   token never enters the container.

   "Run sweep" and "Ask Claude" type a prompt into the Conductor Claude
   session through the runner. A busy session gets it queued (Claude Code
   reads a message typed mid-turn when the turn ends); a session waiting on
   a question does not, because the text would dismiss the question.

   Also here:
     /api/work/activity   what was sent for the owner (outbound.jsonl on the
                          host) with the replies found (outbound-replies.json)
     /api/work/replies    the owner's answers to "Needs you" items, kept in
                          the data volume; the host mirrors them to
                          ~/.local/share/forsa-work/owner-replies.json
                          (owner_replies.py) for the sweep to act on
     /api/work/refresh    starts the host's forsa-work tick through the runner
   ============================================================ */

const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const express = require('express');
const express_json = express.json({ limit: '64kb' });

const HOST_DIR = process.env.WORK_HOST_DIR || '/host/home/ojee/.local/share/forsa-work';
const WORK_FILE = process.env.WORK_FILE || `${HOST_DIR}/work.json`;
const PROMPT_FILE = process.env.WORK_PROMPT_FILE || `${HOST_DIR}/sweep-prompt.txt`;
const OUTBOUND_FILE = `${HOST_DIR}/outbound.jsonl`;
const OUTBOUND_REPLIES = `${HOST_DIR}/outbound-replies.json`;
const FOLLOWUP_FILE = `${HOST_DIR}/team-followup.json`;
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

function readWork() {
  try {
    const st = fs.statSync(WORK_FILE);
    const data = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
    return { ...data, fileAgeMs: Date.now() - st.mtimeMs, followups: readJson(FOLLOWUP_FILE, null) };
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
const ACTIONS = new Set(['reply', 'approve', 'decline', 'done', 'snooze']);

/** Activity: what was sent, newest first, with the replies found. */
function readActivity(days = 14) {
  const floor = Date.now() - days * 86400000;
  let lines = [];
  try { lines = fs.readFileSync(OUTBOUND_FILE, 'utf8').split('\n'); } catch { /* none yet */ }
  const replies = readJson(OUTBOUND_REPLIES, {});
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if ((e.at || 0) < floor) continue;
      out.push({ ...e, text: undefined, reply: replies[e.id] || null });
    } catch { /* a torn line */ }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 300);
}

/** A stable id for a "Waiting on Omar" line of the plan: the same words, the same item. */
const planId = (what) => `plan:${crypto.createHash('sha1').update(String(what || '')).digest('hex').slice(0, 12)}`;

module.exports = function mountWork(app, auth, runners, emitNotify = () => {}) {
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
    emitNotify({ id: severity === 'warn' ? 'agent.work-alert' : 'agent.work-update', title: m.title, body: m.body.slice(0, 600), tag: key ? `work:${key}` : `work:${m.id}`, severity, view: 'work', at: m.at });
    res.json({ ok: true, message: m });
  });

  app.get('/api/work', auth, (_req, res) => {
    const w = readWork();
    if (!w.error) {
      // The plan's "Waiting on Omar" lines get ids, so an answer can point at one.
      w.notes = { ...(w.notes || {}), owner: (w.notes?.owner || []).map((x) => ({ ...x, id: x.id || planId(x.what) })) };
    }
    res.json(w);
  });

  app.get('/api/work/activity', auth, (req, res) => res.json({ activity: readActivity(Math.min(60, Number(req.query.days) || 14)) }));

  /* ── the owner's answers ─────────────────────────────────────────── */

  app.get('/api/work/replies', auth, (_req, res) => res.json({ replies: readReplies() }));
  app.post('/api/work/replies', auth, express_json, (req, res) => {
    const b = req.body || {};
    const id = clip(b.id, 80);
    const action = ACTIONS.has(b.action) ? b.action : 'reply';
    const text = clip(b.text, 4000);
    if (!id) return res.status(400).json({ error: 'Which item is this an answer to?' });
    if (action === 'reply' && !text.trim()) return res.status(400).json({ error: 'Write a reply, or pick an action.' });
    const hours = Math.min(24 * 14, Math.max(1, Number(b.snoozeHours) || 24));
    const r = {
      id, source: clip(b.source, 20) || 'plan', title: clip(b.title, 300), action, text,
      at: Date.now(), snoozeUntil: action === 'snooze' ? Date.now() + hours * 3600000 : null,
      handled: false, handledAt: null, note: null,
    };
    // One live answer per item: a new one replaces an unhandled one.
    const list = readReplies().filter((x) => !(x.id === id && !x.handled));
    writeReplies([r, ...list]);
    res.json({ ok: true, reply: r });
  });
  app.post('/api/work/replies/handled', auth, express_json, (req, res) => {
    const id = clip(req.body?.id, 80);
    const list = readReplies();
    let n = 0;
    for (const x of list) if (x.id === id && !x.handled) { x.handled = true; x.handledAt = Date.now(); x.note = clip(req.body?.note, 1000) || null; n += 1; }
    writeReplies(list);
    res.json({ ok: n > 0, handled: n });
  });
  app.delete('/api/work/replies/:id', auth, (req, res) => {
    const list = readReplies().filter((x) => !(x.id === req.params.id && !x.handled));
    writeReplies(list);
    res.json({ ok: true });
  });

  /* ── the Conductor session ───────────────────────────────────────── */

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
      const text = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      // The scheduled call skips quietly and tries again ten minutes later; the button says why.
      const r = await tellConductor(runners, text, { quietIfQuestion: !!ifDue });
      if (r.ok) writeStamp(Date.now());
      res.json(r);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  /** A "take action" button on an item: one short instruction for the Conductor. */
  app.post('/api/work/ask', auth, express_json, async (req, res) => {
    const text = clip(req.body?.text, 4000).trim();
    if (!text) return res.status(400).json({ error: 'Nothing to ask.' });
    try {
      res.json(await tellConductor(runners, `From the owner, via the Work tab: ${text}\nKeep it short and end with one DONE line.`));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  /** Rebuild the work picture now: the host's forsa-work tick, started by the runner. */
  app.post('/api/work/refresh', auth, async (_req, res) => {
    const r = runners[0];
    if (!r) return res.status(409).json({ error: 'No Claude runner is configured.' });
    try { res.json(await runner(r, 'POST', '/work/tick')); } catch (e) {
      res.status(502).json({ error: /not found|cannot post/i.test(e.message) ? 'The runner on HP is older than this module: restart ojee-claude to rebuild from here.' : e.message });
    }
  });
  app.get('/api/work/refresh', auth, async (_req, res) => {
    const r = runners[0];
    if (!r) return res.json({ active: false });
    try { res.json(await runner(r, 'GET', '/work/tick')); } catch (e) { res.json({ active: false, error: e.message }); }
  });
};

module.exports.planId = planId;
