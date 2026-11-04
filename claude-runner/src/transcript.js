/**
 * Reading Claude Code's own session files.
 *
 * Every session — started here, from a terminal on the box, or from anywhere
 * else that shares ~/.claude — is a JSONL file under
 * `<config>/projects/<encoded cwd>/<session id>.jsonl`. That file is the
 * record: the terminal is a view of the process, the transcript is what
 * happened. So the runner reads it for three things the screen cannot give
 * reliably: which model actually answered, which request failed and why, and
 * a readable history that still exists after the process is gone.
 *
 * The directory name is an encoding of the cwd that has changed between
 * versions (and long paths get shortened), so nothing here computes it.
 * Session ids are unique; a file is found by its name.
 */

const fs = require('fs');
const path = require('path');
const { classify, textOf } = require('./limits');

/** First directory in `projectDirs` holding `<id>.jsonl`, or null. */
function findTranscript(projectDirs, id) {
  const file = `${id}.jsonl`;
  for (const dir of projectDirs) {
    let subs;
    try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory() && !s.isSymbolicLink()) continue;
      const p = path.join(dir, s.name, file);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Incremental reader: remembers its byte offset, returns only complete new
 * lines. A line Claude Code is still writing stays in `partial` until its
 * newline arrives, so a half-written JSON object is never parsed.
 */
class Tail {
  constructor(file, offset = 0) {
    this.file = file;
    this.offset = offset;
    this.partial = '';
  }

  read(maxBytes = 4 * 1024 * 1024) {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    // Truncated or replaced underneath us: start again rather than read garbage.
    if (st.size < this.offset) { this.offset = 0; this.partial = ''; }
    if (st.size === this.offset) return [];
    const len = Math.min(maxBytes, st.size - this.offset);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
    this.offset += len;
    const text = this.partial + buf.toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop();
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* a corrupt line is skipped, not fatal */ }
    }
    return out;
  }
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** A one-line summary of a tool call, for the readable transcript. */
function toolSummary(name, input = {}) {
  const i = input || {};
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  if (name === 'AskUserQuestion') {
    return (i.questions || []).map((q) => q.question).filter(Boolean).join(' · ');
  }
  return clip(typeof pick === 'string' ? pick : JSON.stringify(i), 400);
}

/** The tool input a reader needs to see what a call did, clipped. */
function toolInput(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const c = (v, n = 8000) => (typeof v === 'string' ? clip(v, n) : v);
  switch (name) {
    case 'Bash': return { command: c(i.command, 4000), description: c(i.description, 300), background: !!i.run_in_background };
    case 'Edit': return { file_path: i.file_path, old_string: c(i.old_string), new_string: c(i.new_string), replace_all: !!i.replace_all };
    case 'MultiEdit': return { file_path: i.file_path, edits: (i.edits || []).slice(0, 20).map((e) => ({ old_string: c(e.old_string, 3000), new_string: c(e.new_string, 3000) })) };
    case 'Write': return { file_path: i.file_path, content: c(i.content) };
    case 'Read': return { file_path: i.file_path, offset: i.offset, limit: i.limit };
    case 'TodoWrite': return { todos: (i.todos || []).slice(0, 60).map((t) => ({ content: clip(t.content || t.activeForm || '', 300), status: t.status })) };
    case 'Task': case 'Agent': return { description: c(i.description, 300), subagent_type: i.subagent_type, prompt: c(i.prompt, 6000) };
    default: {
      let j;
      try { j = JSON.stringify(i, null, 2); } catch { j = ''; }
      return { json: clip(j, 6000) };
    }
  }
}

const stripAnsi = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
const tag = (text, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
};

/**
 * Turn raw transcript entries into what a person reads: prompts, replies, the
 * tools in between, and failures. Everything else Claude Code records
 * (snapshots, hook summaries, UI state) is dropped.
 *
 * Sidechain entries belong to subagents and are left out: the main thread is
 * the conversation, and a subagent's failure surfaces there anyway.
 *
 * `detail` (the console's transcript view asks for it) adds what the plain
 * list leaves out: thinking, each call's input and id, results tied to their
 * call and clipped longer, command output, background-task notices and how
 * long each turn took. Without it the shape is exactly what it always was.
 */
function toMessages(entries, { detail = false, sidechain = false } = {}) {
  const out = [];
  for (const e of entries) {
    // A subagent's own file is all sidechain: read it when asked to.
    if (!e || (e.isSidechain && !sidechain)) continue;
    const at = e.timestamp || null;

    if (e.type === 'assistant') {
      const err = classify(e);
      if (err) { out.push({ role: 'error', kind: err.kind, text: err.text, at, uuid: e.uuid }); continue; }
      const model = e.message?.model && e.message.model !== '<synthetic>' ? e.message.model : null;
      for (const b of e.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text, model, at, uuid: e.uuid });
        else if (b.type === 'tool_use') {
          const m = { role: 'tool', tool: b.name, text: toolSummary(b.name, b.input), at, uuid: e.uuid };
          if (detail) { m.id = b.id || null; m.input = toolInput(b.name, b.input); }
          out.push(m);
        } else if (detail && (b.type === 'thinking' || b.type === 'redacted_thinking')) {
          out.push({ role: 'thinking', text: clip(b.thinking || '', 20000), at, uuid: e.uuid });
        }
      }
      continue;
    }

    if (e.type === 'user' && !e.isMeta) {
      const c = e.message?.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const body = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
          const m = { role: 'result', text: clip(body, detail ? 6000 : 600), error: !!b.is_error, at, uuid: e.uuid };
          if (detail) { m.toolUseId = b.tool_use_id || null; m.size = body.length; }
          out.push(m);
        }
        continue;
      }
      const text = textOf(e.message);
      if (!text.trim()) continue;
      const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
      if (cmd) {
        const m = { role: 'command', text: cmd[1], at, uuid: e.uuid };
        if (detail) { const a = tag(text, 'command-args'); if (a) m.args = clip(a, 2000); }
        out.push(m);
        continue;
      }
      if (/^<local-command-stdout>|^<local-command-stderr>/.test(text)) {
        if (detail) {
          const body = stripAnsi(tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr') ?? '');
          if (body.trim()) out.push({ role: 'command-out', text: clip(body, 6000), at, uuid: e.uuid });
        }
        continue;
      }
      if (/^<local-command-caveat>/.test(text)) continue;
      if (detail && /^\s*<task-notification>/.test(text)) {
        const summary = tag(text, 'summary') || tag(text, 'status') || 'A background task finished';
        out.push({ role: 'note', kind: 'task', text: clip(summary, 600), status: tag(text, 'status'), at, uuid: e.uuid });
        continue;
      }
      const m = { role: 'user', text, at, uuid: e.uuid };
      if (detail && Array.isArray(c)) { const n = c.filter((b) => b.type === 'image').length; if (n) m.images = n; }
      out.push(m);
      continue;
    }

    // A message sent while Claude was mid-turn is not a `user` entry: Claude
    // Code records it as a queued_command attachment when it reaches the turn.
    // Yours (origin human) are messages like any other; another session's
    // (peer) is a note; task notifications stay out, as above.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      const a = e.attachment;
      const kind = a.origin?.kind || (a.commandMode === 'task-notification' ? 'task-notification' : a.humanTurn ? 'human' : null);
      const p = a.prompt;
      const text = typeof p === 'string' ? p
        : Array.isArray(p) ? p.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      const when = a.timestamp || at;
      if (kind === 'human' && text.trim()) {
        const m = { role: 'user', text, at: when, uuid: e.uuid, midTurn: true };
        if (detail && Array.isArray(p)) { const n = p.filter((b) => b && b.type === 'image').length; if (n) m.images = n; }
        out.push(m);
      } else if (kind === 'peer' && detail && text.trim()) {
        const from = /from-name="([^"]+)"/.exec(text)?.[1] || 'another session';
        const body = text.replace(/<\/?cross-session-message[^>]*>/g, '').trim();
        out.push({ role: 'note', kind: 'peer', text: clip(`From ${from}: ${body}`, 600), at: when, uuid: e.uuid });
      }
      continue;
    }

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      out.push({ role: 'note', text: 'Conversation compacted', at, uuid: e.uuid });
    } else if (detail && e.type === 'system') {
      if (e.subtype === 'turn_duration' && e.durationMs) out.push({ role: 'turn', ms: Number(e.durationMs) || 0, at, uuid: e.uuid });
      else if (e.subtype === 'informational' && e.content) out.push({ role: 'note', kind: e.level || 'info', text: clip(e.content, 600), at, uuid: e.uuid });
      else if (e.subtype === 'scheduled_task_fire' && e.content) out.push({ role: 'note', kind: 'schedule', text: clip(e.content, 300), at, uuid: e.uuid });
    }
  }
  // The same words twice in a row within a minute are one message recorded
  // two ways (queued, then delivered as a turn): show it once.
  return out.filter((m, i) => {
    if (m.role !== 'user') return true;
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const o = out[j];
      if (o.role !== 'user') continue;
      if (o.text.trim() === m.text.trim() && Math.abs(Date.parse(m.at) - Date.parse(o.at)) < 60000) return false;
      break;
    }
    return true;
  });
}

/**
 * Whole lines between two byte offsets. A start inside a line skips to the
 * next one (the caller pages back from it again); the end is where the last
 * complete line stops. Returns the entries and the offsets actually covered.
 */
function readRange(file, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let from = 0;
  if (start > 0) {
    // Is `start` itself a line start? Only if the byte before it is a newline.
    const prev = Buffer.alloc(1);
    const fd2 = fs.openSync(file, 'r');
    try { fs.readSync(fd2, prev, 0, 1, start - 1); } finally { fs.closeSync(fd2); }
    if (prev[0] !== 0x0a) {
      const nl = buf.indexOf(0x0a);
      from = nl < 0 ? len : nl + 1;
    }
  }
  const last = buf.lastIndexOf(0x0a);
  const to = last < from ? from : last + 1;
  const entries = [];
  for (const l of buf.subarray(from, to).toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    try { entries.push(JSON.parse(l)); } catch { /* a corrupt line is skipped */ }
  }
  return { entries, start: start + from, end: start + to };
}

/**
 * What the runner needs from a session file without keeping all of it:
 * title, cwd, first prompt, last activity. Reads the head and the tail only —
 * transcripts reach hundreds of megabytes.
 */
function describe(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const info = { file, id: path.basename(file, '.jsonl'), size: st.size, modified: st.mtimeMs, cwd: null, title: null, firstPrompt: null };

  const readSlice = (start, len) => {
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    return buf.toString('utf8').split('\n');
  };
  const scan = (lines) => {
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (!info.cwd && typeof e.cwd === 'string') info.cwd = e.cwd;
      if (e.type === 'custom-title' && e.customTitle) info.title = e.customTitle;
      else if (e.type === 'ai-title' && e.aiTitle && !info.aiTitle) info.aiTitle = e.aiTitle;
      if (!info.firstPrompt && e.type === 'user' && !e.isMeta && !e.isSidechain) {
        const t = textOf(e.message).trim();
        if (t && !t.startsWith('<')) info.firstPrompt = clip(t.replace(/\s+/g, ' '), 140);
      }
    }
  };

  const HEAD = 256 * 1024;
  scan(readSlice(0, Math.min(HEAD, st.size)));
  if (st.size > HEAD) scan(readSlice(Math.max(HEAD, st.size - HEAD), Math.min(HEAD, st.size - HEAD)));
  info.title = info.title || info.aiTitle || null;
  delete info.aiTitle;
  return info;
}

/** Every session file under the given project dirs, newest first. */
function listSessions(projectDirs, { limit = 60 } = {}) {
  const seen = new Map();
  for (const dir of projectDirs) {
    let subs;
    try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(path.join(dir, s.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, s.name, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const id = f.slice(0, -6);
        if (!seen.has(id) || seen.get(id).m < st.mtimeMs) seen.set(id, { p, m: st.mtimeMs });
      }
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => describe(x.p))
    .filter(Boolean);
}

/**
 * A session's subagents: Claude Code writes each one's conversation to
 * <projects>/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl, with a
 * .meta.json beside it (agentType, description, the toolUseId that launched
 * it). Newest first, at most `limit`: a long session has thousands.
 */
function subagentDir(transcript) {
  if (!transcript) return null;
  return path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
}

function listSubagents(transcript, { limit = 40 } = {}) {
  const dir = subagentDir(transcript);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = [];
  for (const n of names) {
    const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(n);
    if (!m) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    files.push({ id: m[1], file: path.join(dir, n), size: st.size, modified: st.mtimeMs, created: st.birthtimeMs || st.ctimeMs });
  }
  files.sort((a, b) => b.modified - a.modified);
  return files.slice(0, limit).map((f) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${f.id}.meta.json`), 'utf8')); } catch { /* none */ }
    return {
      id: f.id,
      type: meta.agentType || null,
      description: clip(meta.description || '', 200) || null,
      toolUseId: meta.toolUseId || null,
      size: f.size,
      modified: f.modified,
      created: f.created,
    };
  });
}

/** One subagent's file, or null. The id is checked: it becomes a path. */
function subagentFile(transcript, agentId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(agentId || ''))) return null;
  const f = path.join(subagentDir(transcript) || '', `agent-${agentId}.jsonl`);
  return transcript && fs.existsSync(f) ? f : null;
}

module.exports = { findTranscript, Tail, toMessages, readRange, describe, listSessions, toolSummary, toolInput, listSubagents, subagentFile };
