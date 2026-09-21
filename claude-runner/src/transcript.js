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

/**
 * Turn raw transcript entries into what a person reads: prompts, replies, the
 * tools in between, and failures. Everything else Claude Code records
 * (snapshots, hook summaries, UI state) is dropped.
 *
 * Sidechain entries belong to subagents and are left out: the main thread is
 * the conversation, and a subagent's failure surfaces there anyway.
 */
function toMessages(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || e.isSidechain) continue;
    const at = e.timestamp || null;

    if (e.type === 'assistant') {
      const err = classify(e);
      if (err) { out.push({ role: 'error', kind: err.kind, text: err.text, at, uuid: e.uuid }); continue; }
      const model = e.message?.model && e.message.model !== '<synthetic>' ? e.message.model : null;
      for (const b of e.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text, model, at, uuid: e.uuid });
        else if (b.type === 'tool_use') out.push({ role: 'tool', tool: b.name, text: toolSummary(b.name, b.input), at, uuid: e.uuid });
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
          out.push({ role: 'result', text: clip(body, 600), error: !!b.is_error, at, uuid: e.uuid });
        }
        continue;
      }
      const text = textOf(e.message);
      if (!text.trim()) continue;
      const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
      if (cmd) { out.push({ role: 'command', text: cmd[1], at, uuid: e.uuid }); continue; }
      if (/^<local-command-stdout>|^<local-command-caveat>/.test(text)) continue;
      out.push({ role: 'user', text, at, uuid: e.uuid });
      continue;
    }

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      out.push({ role: 'note', text: 'Conversation compacted', at, uuid: e.uuid });
    }
  }
  return out;
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

module.exports = { findTranscript, Tail, toMessages, describe, listSessions, toolSummary };
