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
    case 'Task': case 'Agent': return { description: c(i.description, 300), subagent_type: i.subagent_type, prompt: c(i.prompt, 6000), background: !!i.run_in_background };
    default: {
      let j;
      try { j = JSON.stringify(i, null, 2); } catch { j = ''; }
      return { json: clip(j, 6000) };
    }
  }
}


/** How much of a tool's output a reader gets inline; the rest is one request away (/full). */
const RESULT_MAX = 20_000;

/**
 * Images in a message's content blocks, as references the console fetches
 * one at a time (/media): base64 in the event stream would make a chat with
 * screenshots megabytes per refresh. `id` is the entry's uuid, where in the
 * entry, and which image.
 */
function imagesOf(blocks, uuid, where) {
  const out = [];
  (blocks || []).forEach((b, i) => {
    if (b && b.type === 'image' && b.source) {
      out.push({ id: `${uuid}~${where}${i}`, type: b.source.media_type || 'image/png', size: b.source.data ? Math.round(b.source.data.length * 0.75) : null, url: b.source.type === 'url' ? b.source.url : null });
    }
  });
  return out;
}

/**
 * What a tool result says beyond its text: the edit as hunks with line
 * numbers (Edit/Write record a structuredPatch), a command's exit code, an
 * interrupt, the background task it became, and images it returned (a
 * screenshot read back).
 */
function resultExtras(e, b, body, index) {
  const x = {};
  const r = e.toolUseResult;
  // One entry can carry several results; toolUseResult belongs to the first.
  const tr = index === 0 && r && typeof r === 'object' ? r : null;
  if (tr && Array.isArray(tr.structuredPatch) && tr.structuredPatch.length) {
    let budget = 600;
    x.patch = tr.structuredPatch.slice(0, 40).map((h) => {
      const lines = (h.lines || []).slice(0, Math.max(0, budget));
      budget -= lines.length;
      return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: lines.map((l) => clip(l, 400)), cut: (h.lines || []).length > lines.length };
    }).filter((h) => h.lines.length);
    if (tr.type) x.change = tr.type; // create | update
  }
  if (tr && ('stdout' in tr || 'stderr' in tr)) {
    if (tr.interrupted) x.interrupted = true;
    if (tr.backgroundTaskId) x.background = tr.backgroundTaskId;
    if (tr.stderr && String(tr.stderr).trim() && !b.is_error) x.stderr = clip(stripAnsi(tr.stderr), 4000);
  }
  const code = /^(?:Error: )?Exit code (\d+)/m.exec(String(body || '').slice(0, 200));
  if (code) x.exitCode = Number(code[1]);
  else if (tr && ('stdout' in tr) && !b.is_error && !tr.interrupted && !tr.backgroundTaskId) x.exitCode = 0;
  if (Array.isArray(b.content)) {
    const imgs = imagesOf(b.content, e.uuid, `r${index}.`);
    if (imgs.length) x.media = imgs;
  }
  return x;
}

/**
 * One image out of a transcript, by the id imagesOf gave it. Read from the
 * end backwards (the image asked for is nearly always recent), whole lines
 * only, giving up after 64 MB.
 */
function imageAt(file, id) {
  const m = /^([0-9a-f-]{36})~(u|r\d+\.)(\d+)$/i.exec(String(id || ''));
  if (!m) return null;
  const [, uuid, where, idx] = m;
  const entry = findLine(file, `"uuid":"${uuid}"`);
  if (!entry) return null;
  let blocks = entry.message?.content;
  if (where !== 'u') {
    const ri = Number(where.slice(1, -1));
    blocks = (Array.isArray(blocks) ? blocks : []).filter((b) => b.type === 'tool_result')[ri]?.content;
  }
  const b = Array.isArray(blocks) ? blocks[Number(idx)] : null;
  if (!b || b.type !== 'image' || b.source?.type !== 'base64') return null;
  return { type: b.source.media_type || 'image/png', data: Buffer.from(b.source.data, 'base64') };
}

/**
 * The last whole line of a transcript containing `needle`, parsed, read from
 * the end backwards in 8 MB steps (what is asked for is nearly always recent;
 * an old one in a 400 MB file costs about a second).
 */
function findLine(file, needle, maxBytes = 1024 * 1024 * 1024) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const CHUNK = 8 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const all = Buffer.concat([buf, carry]);
      const at = all.lastIndexOf(needle);
      if (at >= 0) {
        const ls = all.lastIndexOf(0x0a, at) + 1;
        if (ls === 0 && start > 0) { carry = all; end = start; continue; }
        const le = all.indexOf(0x0a, at);
        try { return JSON.parse(all.subarray(ls, le < 0 ? all.length : le).toString('utf8')); } catch { return null; }
      }
      // Keep the first (partial) line: its start is in the chunk before.
      const nl = all.indexOf(0x0a);
      carry = nl >= 0 ? all.subarray(0, nl) : all;
      end = start;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

/** A tool's whole output, by its call's id, for a result the stream clipped. */
function fullResult(file, toolUseId) {
  if (!/^[\w-]{6,80}$/.test(String(toolUseId || ''))) return null;
  const e = findLine(file, `"tool_use_id":"${toolUseId}"`);
  const b = (Array.isArray(e?.message?.content) ? e.message.content : []).find((x) => x.tool_use_id === toolUseId);
  if (!b) return null;
  const body = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
  return { text: body.slice(0, 4 * 1024 * 1024), size: body.length, error: !!b.is_error };
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
        let ri = 0;
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const body = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
          const m = { role: 'result', text: clip(body, detail ? RESULT_MAX : 600), error: !!b.is_error, at, uuid: e.uuid };
          if (detail) {
            m.toolUseId = b.tool_use_id || null;
            m.size = body.length;
            Object.assign(m, resultExtras(e, b, body, ri));
          }
          ri += 1;
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
        // The ids tie it to the call that started it, for the console's background panel.
        out.push({ role: 'note', kind: 'task', text: clip(summary, 600), status: tag(text, 'status'), toolUseId: tag(text, 'tool-use-id') || null, taskId: tag(text, 'task-id') || null, outputFile: tag(text, 'output-file') || null, at, uuid: e.uuid });
        continue;
      }
      const m = { role: 'user', text, at, uuid: e.uuid };
      if (detail && Array.isArray(c)) { const imgs = imagesOf(c, e.uuid, 'u'); if (imgs.length) { m.images = imgs.length; m.media = imgs; } }
      out.push(m);
      continue;
    }

    // What a hook said: a message it showed, context it added, an error it
    // raised. Claude Code records these as attachments; a Stop hook's errors
    // sit in its summary.
    if (detail && e.type === 'attachment' && /^hook_/.test(e.attachment?.type || '')) {
      const a = e.attachment;
      const text = typeof a.content === 'string' ? a.content : Array.isArray(a.content) ? a.content.map((x) => x?.text || '').join('\n') : (a.stderr || a.stdout || '');
      if (String(text).trim()) {
        out.push({ role: 'hook', kind: a.type.replace(/^hook_/, ''), name: a.hookName || a.hookEvent || null, toolUseId: a.toolUseID || null, text: clip(stripAnsi(text), 4000), error: /error|blocking/.test(a.type), at, uuid: e.uuid });
      }
      continue;
    }
    if (detail && e.type === 'system' && e.subtype === 'stop_hook_summary') {
      const errs = (e.hookErrors || []).map((x) => (typeof x === 'string' ? x : x?.error || x?.message || JSON.stringify(x))).filter(Boolean);
      if (errs.length || e.preventedContinuation) {
        out.push({ role: 'hook', kind: e.preventedContinuation ? 'blocked' : 'error', name: 'Stop', text: clip(stripAnsi(errs.join('\n') || e.stopReason || 'A Stop hook stopped the turn'), 4000), error: true, at, uuid: e.uuid });
      }
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
      } else if (kind === 'task-notification' && detail && /<task-notification>/.test(text)) {
        // A background task that finished mid-turn arrives queued, not as a turn.
        const summary = tag(text, 'summary') || tag(text, 'status') || 'A background task finished';
        out.push({ role: 'note', kind: 'task', text: clip(summary, 600), status: tag(text, 'status'), toolUseId: tag(text, 'tool-use-id') || null, taskId: tag(text, 'task-id') || null, outputFile: tag(text, 'output-file') || null, at: when, uuid: e.uuid });
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
  // One message recorded two ways (queued mid-turn as an attachment, then
  // delivered as a turn) shows once. Only that pair is folded: two sends of
  // the same words are two messages and both show (owner, 11 Nov: a message
  // sent twice showed once, which hid the double send).
  return out.filter((m, i) => {
    if (m.role !== 'user') return true;
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const o = out[j];
      if (o.role !== 'user') continue;
      if (!!o.midTurn !== !!m.midTurn && o.text.trim() === m.text.trim() && Math.abs(Date.parse(m.at) - Date.parse(o.at)) < 60000) return false;
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

/**
 * Which subagents have finished: Claude Code records a task notification in
 * the session's log when one completes, fails or is stopped. Read once, then
 * only what was appended since, per log file.
 */
const FINISHED = /<task-id>([A-Za-z0-9_-]+)<\/task-id>[\s\S]{0,4000}?<status>(completed|failed|killed|stopped|cancelled)<\/status>[\s\S]{0,600}?<\/summary>/g;
const finishedCache = new Map(); // transcript -> { offset, done: Set, tail: string }
function finishedAgents(transcript) {
  if (!transcript) return new Set();
  let c = finishedCache.get(transcript);
  let size;
  try { size = fs.statSync(transcript).size; } catch { return c ? c.done : new Set(); }
  if (!c || size < c.offset) { c = { offset: 0, done: new Set(), tail: '' }; finishedCache.set(transcript, c); }
  if (size === c.offset) return c.done;
  const fd = fs.openSync(transcript, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024;
    let pos = c.offset;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      // Keep the last 8 KB of each chunk for the next, so a notification split
      // across the boundary is still matched.
      const text = c.tail + buf.toString('utf8');
      FINISHED.lastIndex = 0;
      let m;
      while ((m = FINISHED.exec(text))) {
        // "completed" with "is waiting on its own background work" means it
        // paused for a command or a run of its own: still alive.
        if (/waiting on its own background work/.test(m[0])) c.done.delete(m[1]);
        else c.done.add(m[1]);
      }
      c.tail = text.slice(-8192);
    }
    c.offset = size;
  } finally { fs.closeSync(fd); }
  return c.done;
}

module.exports = { imageAt, fullResult, RESULT_MAX, findTranscript, Tail, toMessages, readRange, describe, listSessions, toolSummary, toolInput, listSubagents, subagentFile, finishedAgents };
