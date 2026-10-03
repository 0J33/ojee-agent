/* ============================================================
   ojee-agent — the Assistant's shared core.

   Everything the full view (assistant.js) and the quick chat
   (assistant-quick.js) both need, held once:

     the store      sessions, transcripts, what is pending, what
                    each turn is doing — one copy per page, fed by
                    one event stream, so the quick chat and the
                    full view show the same reply as it streams
     the stream     /api/assistant/events: opencode's own events
                    (message parts, deltas, permissions) plus the
                    module's turn events (started, fallback, done)
     the transcript a conversation drawn incrementally: a delta
                    updates one part, never the whole log
     the composer   words, model, mode, send / stop

   Both entry points import this file by the same URL, so the
   browser keeps one instance of it however the two are loaded.
   ============================================================ */

import { ensureIcons } from './claude-icons.js';

/* ── small pieces ───────────────────────────────────────────────────── */

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'value') n.value = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

export function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window: the default it is */ }
  return null;
}

let ctx = null;

/** An icon from the sprite, as a node. */
export const svg = (name, cls = 'ic') => {
  const t = document.createElement('template');
  t.innerHTML = ctx?.icon ? ctx.icon(`i-${name}`, cls) : `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  return t.content.firstChild;
};

/** The Assistant's own mark (the console sprite carries it; a host without it gets nothing). */
export const mark = (cls = 'ic') => (document.getElementById('i-assistant') ? svg('assistant', cls) : svg('chip', cls));

export const problem = (title, detail, action) => el('div', { class: 'ag-problem' },
  el('strong', {}, title), detail ? el('p', { class: 'meta' }, detail) : null, action || null);

export const toast = (...a) => ctx?.toast?.(...a);

export function relTime(ms) {
  if (!ms) return '—';
  if (ctx?.relTime) return ctx.relTime(ms);
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

export function dur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export const kfmt = (n) => (!n ? '0' : n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`);

/** `/home/ojee/x` → `~/x`. */
export function shortPath(p) {
  if (!p) return '';
  const home = S.cfg?.home;
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

/* ── the store ──────────────────────────────────────────────────────── */

export const S = {
  cfg: null,
  cfgError: null,
  online: null,
  upError: null,
  sessions: new Map(),
  listed: false,
  listError: null,
  status: new Map(),      // sid → { type, attempt, message, next }
  perms: new Map(),
  questions: new Map(),
  convs: new Map(),       // sid → { loading, error, msgs: Map(id → { info, parts: Map }) }
  turns: new Map(),       // sid → { phase, model, fallbacks: [], error, at }
  pings: [],
};

const listeners = new Set();
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what, sid = null) { for (const fn of [...listeners]) { try { fn(what, sid); } catch (e) { console.error('[assistant]', e); } } }

export const api = (p, o = {}) => ctx.api(`/assistant${p}`, o);
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });

let es = null;
let esTimer = null;
let users = 0;

/** Start the store for a mount. Safe to call from both entry points. */
export function connect(context) {
  if (!ctx || !ctx.api) ctx = context;
  else ctx = { ...ctx, ...Object.fromEntries(Object.entries(context).filter(([, v]) => v != null)) };
  ensureIcons();
  loadCss();
  users += 1;
  if (!es) listen();
  if (!S.cfg && !S.cfgLoading) loadConfig();
  if (!S.listed || Date.now() - (S.listedAt || 0) > 15000) loadState();
}

export function disconnect() {
  users = Math.max(0, users - 1);
  if (users) return;
  clearTimeout(esTimer);
  es?.close();
  es = null;
}

function loadCss() {
  if (document.getElementById('ag-as-css') || !ctx?.base) return;
  const link = document.createElement('link');
  link.id = 'ag-as-css';
  link.rel = 'stylesheet';
  link.href = `${ctx.base}/ui/assistant.css`;
  document.head.appendChild(link);
}

let attempt = 0;
function listen() {
  es = new EventSource(`${ctx.base}/api/assistant/events`);
  es.onopen = () => {
    // Back after a gap: what changed meanwhile is re-read, not guessed.
    if (attempt) { loadState(); for (const sid of S.convs.keys()) loadConv(sid); }
    attempt = 0;
  };
  es.onerror = () => {
    es?.close();
    es = null;
    S.online = false;
    S.upError = 'The module stream dropped — reconnecting';
    emit('upstream');
    if (!users) return;
    const wait = Math.min(1000 * 2 ** attempt, 15000);
    attempt += 1;
    esTimer = setTimeout(() => { if (users && !es) listen(); }, wait);
  };
  const handle = (name, fn) => es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error('[assistant]', err); } });
  handle('upstream', (d) => { S.online = !!d.online; S.upError = d.error || null; emit('upstream'); });
  handle('oc', ({ type, properties }) => apply(type, properties || {}));
  handle('turn', onTurn);
  handle('notify', (n) => { S.pings.unshift(n); S.pings.length = Math.min(S.pings.length, 20); emit('notify'); });
}

export async function loadConfig() {
  S.cfgLoading = true;
  try {
    S.cfg = await api('/config');
    S.cfgError = null;
    if (S.cfg?.online != null && S.online == null) S.online = S.cfg.online;
  } catch (e) {
    S.cfgError = e.message;
  } finally {
    S.cfgLoading = false;
  }
  emit('config');
}

export async function loadState() {
  try {
    const r = await api('/state');
    S.sessions = new Map(r.sessions.map((s) => [s.id, s]));
    S.status.clear();
    for (const s of r.sessions) {
      const l = s.live || {};
      if (l.state === 'working') S.status.set(s.id, { type: 'busy' });
      if (l.state === 'retrying') S.status.set(s.id, { type: 'retry', ...l.retry });
      if (l.failed && !S.turns.get(s.id)) S.turns.set(s.id, { phase: 'failed', model: l.failed.model, error: l.failed.error, fallbacks: [], at: l.failed.at });
      if (l.turn && !S.turns.get(s.id)) S.turns.set(s.id, { phase: 'started', model: l.turn.model, fallbacks: [], at: l.turn.startedAt });
    }
    S.perms = new Map((r.permissions || []).map((p) => [p.id, p]));
    S.questions = new Map((r.questions || []).map((q) => [q.id, q]));
    S.online = r.online;
    S.upError = r.error;
    S.listed = true;
    S.listedAt = Date.now();
    S.listError = null;
  } catch (e) {
    S.listError = e.message;
  }
  emit('sessions');
}

export async function loadConv(sid, { quiet = false } = {}) {
  let c = S.convs.get(sid);
  if (!c) { c = { loading: true, error: null, msgs: new Map() }; S.convs.set(sid, c); }
  else if (!quiet) c.loading = true;
  emit('conv', sid);
  try {
    const r = await api(`/sessions/${encodeURIComponent(sid)}/messages`);
    const msgs = new Map();
    for (const m of r.messages) {
      const parts = new Map();
      for (const p of m.parts || []) parts.set(p.id, { ...p, _v: 1 });
      msgs.set(m.info.id, { info: m.info, parts });
    }
    c.msgs = msgs;
    c.loading = false;
    c.error = null;
    c.loadedAt = Date.now();
    if (r.session) S.sessions.set(sid, { ...S.sessions.get(sid), ...r.session });
    for (const p of r.permissions || []) S.perms.set(p.id, p);
    for (const q of r.questions || []) S.questions.set(q.id, q);
  } catch (e) {
    c.loading = false;
    c.error = e.message;
  }
  emit('conv', sid);
  emit('sessions');
}

/** One opencode event, into the store. */
function apply(type, p) {
  const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID || null;
  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const info = p.info;
      if (!info?.id || info.parentID) return;
      S.sessions.set(info.id, { ...S.sessions.get(info.id), ...info });
      emit('sessions'); emit('session', info.id);
      return;
    }
    case 'session.deleted':
      if (p.info?.id) { S.sessions.delete(p.info.id); S.convs.delete(p.info.id); S.turns.delete(p.info.id); emit('sessions'); emit('removed', p.info.id); }
      return;
    case 'session.status':
      if (p.status?.type === 'idle') S.status.delete(sid); else S.status.set(sid, p.status);
      emit('sessions'); emit('session', sid); emit('conv', sid);
      return;
    case 'session.idle':
      S.status.delete(sid);
      emit('sessions'); emit('session', sid); emit('conv', sid);
      return;
    case 'permission.asked': S.perms.set(p.id, p); emit('sessions'); emit('conv', sid); return;
    case 'permission.replied': S.perms.delete(p.requestID); emit('sessions'); emit('conv', sid); return;
    case 'question.asked': S.questions.set(p.id, p); emit('sessions'); emit('conv', sid); return;
    case 'question.replied': case 'question.rejected': S.questions.delete(p.requestID); emit('sessions'); emit('conv', sid); return;
    default: break;
  }
  let c = S.convs.get(sid);
  // A conversation opened a moment ago: its first events can arrive before
  // the call that created it has answered. They are its whole history, so
  // they start the transcript instead of being dropped.
  if (!c && sid && type.startsWith('message.')) {
    const s = S.sessions.get(sid);
    if (s && Date.now() - (s.time?.created || 0) < 120000) {
      c = { loading: false, error: null, msgs: new Map(), loadedAt: Date.now() };
      S.convs.set(sid, c);
    }
  }
  if (!c || c.loading) return;
  if (type === 'message.updated') {
    const m = c.msgs.get(p.info.id);
    if (m) m.info = p.info; else c.msgs.set(p.info.id, { info: p.info, parts: new Map() });
  } else if (type === 'message.removed') {
    c.msgs.delete(p.messageID);
  } else if (type === 'message.part.updated') {
    const part = p.part;
    let m = c.msgs.get(part.messageID);
    if (!m) { m = { info: { id: part.messageID, sessionID: sid, role: 'assistant', time: { created: Date.now() } }, parts: new Map() }; c.msgs.set(part.messageID, m); }
    const old = m.parts.get(part.id);
    m.parts.set(part.id, { ...part, _v: (old?._v || 0) + 1 });
  } else if (type === 'message.part.delta') {
    const m = c.msgs.get(p.messageID);
    const part = m?.parts.get(p.partID);
    if (!part) return;
    part[p.field] = (part[p.field] || '') + p.delta;
    part._v += 1;
  } else if (type === 'message.part.removed') {
    c.msgs.get(p.messageID)?.parts.delete(p.partID);
  } else return;
  emit('conv', sid);
}

function onTurn(d) {
  const sid = d.sessionID;
  const t = S.turns.get(sid) || { fallbacks: [] };
  if (d.phase === 'started') {
    S.turns.set(sid, { ...t, phase: 'started', model: d.model, fallbacks: d.attempt ? t.fallbacks : [], at: t.phase === 'started' || t.phase === 'fallback' ? t.at : Date.now() });
  } else if (d.phase === 'fallback') {
    S.turns.set(sid, { ...t, phase: 'fallback', model: d.to, fallbacks: [...(t.fallbacks || []), { from: d.from, to: d.to, reason: d.reason }] });
  } else if (d.phase === 'done') {
    S.turns.set(sid, { ...t, phase: 'done', model: d.model, at: Date.now() });
  } else if (d.phase === 'failed') {
    S.turns.set(sid, { ...t, phase: 'failed', model: d.model, error: d.error, at: d.at || Date.now() });
  } else if (d.phase === 'stopped') {
    S.turns.set(sid, { ...t, phase: 'stopped', at: Date.now() });
  }
  emit('sessions'); emit('session', sid); emit('conv', sid);
}

/* ── derived ────────────────────────────────────────────────────────── */

export const STATE = {
  working: { label: 'working', dot: 'live' },
  retrying: { label: 'retrying', dot: 'warn' },
  waiting: { label: 'needs you', dot: 'warn' },
  error: { label: 'failed', dot: 'err' },
  idle: { label: 'idle', dot: null },
};

/** What a conversation is doing right now. */
export function liveState(sid) {
  for (const p of S.perms.values()) if (p.sessionID === sid) return 'waiting';
  for (const q of S.questions.values()) if (q.sessionID === sid) return 'waiting';
  const st = S.status.get(sid);
  if (st?.type === 'retry') return 'retrying';
  const t = S.turns.get(sid);
  if (st?.type === 'busy' || t?.phase === 'started' || t?.phase === 'fallback') return 'working';
  if (t?.phase === 'failed') return 'error';
  return 'idle';
}
export const busy = (sid) => ['working', 'retrying', 'waiting'].includes(liveState(sid));

export const dot = (state) => el('span', { class: STATE[state]?.dot ? `dot dot--${STATE[state].dot}` : 'dot' });
export const stateTag = (state) => el('span', { class: `ag-as-state ag-as-state--${state}` }, STATE[state]?.label || state);

export const sessionsSorted = () => [...S.sessions.values()]
  .filter((s) => !s.parentID && !s.time?.archived)
  .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));

/** Is this title still the placeholder opencode gives before it names a session? */
export const untitled = (s) => !s?.title || /^New session - \d{4}-/.test(s.title);
export const titleOf = (s) => (untitled(s) ? 'New conversation' : s.title);

export const models = () => S.cfg?.models || [];
export function modelName(key) {
  if (!key) return '';
  const m = models().find((x) => x.key === key);
  return m?.name || key.split('/').pop();
}
/** The model a session last used, as a key. */
export const sessionModel = (s) => (s?.model?.providerID ? `${s.model.providerID}/${s.model.id}` : null);
/** The model a new message goes to when nothing is picked. */
export const defaultModel = () => S.cfg?.settings?.defaultModel || models()[0]?.key || null;

/* ── actions ────────────────────────────────────────────────────────── */

export async function createSession(body) {
  const s = await post('/sessions', body);
  S.sessions.set(s.id, s);
  // Brand new: there is nothing to fetch, and fetching would race the
  // first events of the reply that is already on its way.
  if (!S.convs.has(s.id)) S.convs.set(s.id, { loading: false, error: null, msgs: new Map(), loadedAt: Date.now() });
  if (s.sent?.ok) S.turns.set(s.id, { phase: 'started', model: s.sent.model, fallbacks: [], at: Date.now(), users: 0, text: body.text });
  if (s.sent && !s.sent.ok) S.turns.set(s.id, { phase: 'failed', error: s.sent.error, fallbacks: [], at: Date.now() });
  emit('sessions');
  return s;
}

const userCount = (sid) => [...(S.convs.get(sid)?.msgs.values() || [])].filter((m) => m.info.role === 'user').length;

export async function sendMessage(sid, { text, model, agent }) {
  S.turns.set(sid, { phase: 'started', model, fallbacks: [], at: Date.now(), users: userCount(sid), text });
  emit('conv', sid); emit('sessions');
  try {
    const r = await post(`/sessions/${encodeURIComponent(sid)}/prompt`, { text, model: model || undefined, agent });
    return r;
  } catch (e) {
    S.turns.set(sid, { phase: 'failed', error: e.message, fallbacks: [], at: Date.now() });
    emit('conv', sid); emit('sessions');
    throw e;
  }
}

export async function retry(sid, model) {
  S.turns.set(sid, { phase: 'started', model, fallbacks: [], at: Date.now() });
  emit('conv', sid);
  try { await post(`/sessions/${encodeURIComponent(sid)}/retry`, { model: model || undefined }); }
  catch (e) { S.turns.set(sid, { phase: 'failed', error: e.message, fallbacks: [], at: Date.now() }); emit('conv', sid); toast('err', 'Could not retry', e.message); }
}

export async function abort(sid) {
  try { await post(`/sessions/${encodeURIComponent(sid)}/abort`); }
  catch (e) { toast('err', 'Could not stop it', e.message); }
}

export async function rename(sid, title) {
  const s = await api(`/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  S.sessions.set(sid, { ...S.sessions.get(sid), ...s });
  emit('sessions'); emit('session', sid);
}

export async function remove(sid) {
  await api(`/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
  S.sessions.delete(sid);
  S.convs.delete(sid);
  S.turns.delete(sid);
  emit('sessions'); emit('removed', sid);
}

export async function saveSettings(patch) {
  const next = await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
  if (S.cfg) S.cfg.settings = next;
  emit('config');
  return next;
}

async function replyPerm(p, reply) {
  try {
    await post(`/sessions/${encodeURIComponent(p.sessionID)}/permissions/${encodeURIComponent(p.id)}`, { reply });
    S.perms.delete(p.id);
    emit('conv', p.sessionID); emit('sessions');
  } catch (e) { toast('err', 'That did not go through', e.message); }
}

async function replyQuestion(q, answers, reject = false) {
  try {
    await post(`/sessions/${encodeURIComponent(q.sessionID)}/questions/${encodeURIComponent(q.id)}`, reject ? { reject: true } : { answers });
    S.questions.delete(q.id);
    emit('conv', q.sessionID); emit('sessions');
  } catch (e) { toast('err', 'That did not go through', e.message); }
}

/* ── Markdown ───────────────────────────────────────────────────────────
   Built from DOM nodes, never innerHTML: the text is whatever a model
   wrote. Paragraphs, headings, lists, quotes, fenced code with a copy
   button, tables, rules, and inline code, bold, italics, strikethrough
   and links. A fence still being streamed is drawn as code already. */

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|(?<![\w*])\*([^*\n]+?)\*(?!\w)|(?<![\w_])_([^_\n]+?)_(?![\w])|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(el('code', { class: 'ag-as-md-c' }, m[1]));
    else if (m[2] != null || m[3] != null) out.push(el('strong', { class: 'ag-as-md-b' }, ...inline(m[2] ?? m[3])));
    else if (m[4] != null) out.push(el('s', { class: 'ag-as-md-s' }, ...inline(m[4])));
    else if (m[5] != null || m[6] != null) out.push(el('em', { class: 'ag-as-md-i' }, ...inline(m[5] ?? m[6])));
    else {
      const href = m[8] || m[9];
      out.push(el('a', { class: 'ag-as-md-a', href, target: '_blank', rel: 'noreferrer noopener' }, m[7] || m[9]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { class: 'ag-as-offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    ta.remove();
  }
  if (btn) {
    btn.classList.add('is-done');
    btn.replaceChildren(svg('check'));
    setTimeout(() => { btn.classList.remove('is-done'); btn.replaceChildren(svg('copy')); }, 1400);
  }
}

const copyBtn = (get, label = 'Copy') => el('button', {
  class: 'ag-as-copy', type: 'button', title: label, 'aria-label': label,
  onclick: (e) => { e.stopPropagation(); copyText(get(), e.currentTarget); },
}, svg('copy'));

function codeBlock(lang, code) {
  return el('div', { class: 'ag-as-code' },
    el('div', { class: 'ag-as-code-bar' },
      el('span', { class: 'ag-as-code-lang' }, lang || 'text'),
      copyBtn(() => code, 'Copy code')),
    el('pre', { class: 'ag-as-code-pre' }, el('code', {}, code)));
}

export function md(src) {
  const out = el('div', { class: 'ag-as-md' });
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = el('p', { class: 'ag-as-md-p' });
    para.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l)); });
    out.append(p);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line))) {
      flush();
      const fence = m[1];
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
      out.append(codeBlock(m[2], code.join('\n')));
    } else if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...rest] = body;
      out.append(el('div', { class: 'ag-as-md-tablewrap' }, el('table', { class: 'ag-as-md-table' },
        el('thead', {}, el('tr', {}, head.map((c) => el('th', { class: 'ag-as-md-th' }, ...inline(c))))),
        el('tbody', {}, rest.map((r) => el('tr', {}, r.map((c) => el('td', { class: 'ag-as-md-td' }, ...inline(c)))))))));
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      out.append(el('div', { class: `ag-as-md-h ag-as-md-h${Math.min(m[1].length, 3)}`, role: 'heading', 'aria-level': String(Math.min(m[1].length + 2, 6)) }, ...inline(m[2])));
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      flush();
      const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      const task = m[3] ? /x/i.test(m[3]) : null;
      out.append(el('div', { class: `ag-as-md-li${task === true ? ' is-done' : ''}`, style: `--d:${depth}` },
        el('span', { class: 'ag-as-md-mark' }, task != null ? (task ? svg('check') : '–') : /\d/.test(m[2]) ? m[2] : '•'),
        el('span', {}, ...inline(m[4]))));
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flush();
      const q = [m[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ''));
      out.append(el('blockquote', { class: 'ag-as-md-quote' }, ...q.flatMap((l, k) => (k ? [el('br'), ...inline(l)] : inline(l)))));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.append(el('hr', { class: 'ag-as-md-hr' }));
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

/* ── tools ──────────────────────────────────────────────────────────── */

const pretty = (s) => String(s || '').replace(/^ojee_/, '').replace(/_/g, ' ');
const first = (v) => (Array.isArray(v) ? v[0] : v);

const TOOLS = {
  bash: ['terminal', 'Shell', (i) => i.command],
  read: ['file', 'Read', (i) => shortPath(i.filePath)],
  write: ['edit', 'Write', (i) => shortPath(i.filePath)],
  edit: ['edit', 'Edit', (i) => shortPath(i.filePath)],
  multiedit: ['edit', 'Edit', (i) => shortPath(i.filePath)],
  apply_patch: ['edit', 'Patch', (i) => (i.patchText || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1] || ''],
  patch: ['edit', 'Patch', () => ''],
  grep: ['search', 'Search', (i) => `${i.pattern || ''}${i.path ? `  in ${shortPath(i.path)}` : ''}`],
  glob: ['search', 'Find files', (i) => `${i.pattern || ''}${i.path ? `  in ${shortPath(i.path)}` : ''}`],
  list: ['folder', 'List', (i) => shortPath(i.path)],
  webfetch: ['external', 'Fetch', (i) => i.url],
  websearch: ['search', 'Web search', (i) => i.query],
  todowrite: ['list', 'Plan', (i) => (i.todos ? `${i.todos.length} step${i.todos.length === 1 ? '' : 's'}` : '')],
  todoread: ['list', 'Plan', () => ''],
  task: ['chip', 'Subagent', (i) => i.description || i.prompt],
  skill: ['chip', 'Skill', (i) => i.name],
  question: ['info', 'Question', (i) => first(i.questions)?.question],
};

/** Console tools by their purpose, not their wire names. */
const CONSOLE = {
  ojee_fleet_hosts: ['gauge', 'Fleet', () => 'every machine'],
  ojee_fleet_host: ['gauge', 'Fleet', (i) => i.host || i.id || i.name],
  ojee_home_devices: ['house', 'Home devices', () => 'read'],
  ojee_ac_command: ['house', 'AC', (i) => Object.entries(i).filter(([k]) => k !== 'device' && k !== 'id').map(([k, v]) => `${k} ${v}`).join(', ')],
  ojee_agent_services: ['server', 'Services', () => 'this box'],
  ojee_agent_restart_service: ['restart', 'Restart', (i) => i.service || i.id || i.name],
  ojee_ssh_run: ['terminal', 'Remote shell', (i) => `${i.host || i.target || ''}${i.command ? `: ${i.command}` : ''}`],
};

export function toolInfo(name, input = {}) {
  const t = CONSOLE[name] || TOOLS[name] || (name?.startsWith('ojee_') ? ['server', 'Console', () => pretty(name)] : ['code', pretty(name), () => '']);
  let arg = '';
  try { arg = t[2](input || {}) || ''; } catch { arg = ''; }
  if (!arg && input && Object.keys(input).length && !TOOLS[name]) {
    arg = Object.entries(input).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  }
  return { icon: t[0], label: t[1], arg: String(arg).replace(/\s+/g, ' ').trim() };
}

const clip = (s, n = 8000) => {
  const t = String(s ?? '');
  return t.length > n ? { text: t.slice(0, n), more: t.length - n } : { text: t, more: 0 };
};

function outBlock(label, text, cls = '') {
  const { text: t, more } = clip(text);
  if (!t.trim()) return null;
  return el('div', { class: `ag-as-tool-block ${cls}` },
    el('div', { class: 'ag-as-tool-blocklabel' }, el('span', {}, label), copyBtn(() => String(text), `Copy ${label.toLowerCase()}`)),
    el('pre', { class: 'ag-as-tool-pre' }, t),
    more ? el('div', { class: 'meta ag-as-tool-more' }, `… ${kfmt(more)} more characters`) : null);
}

function diffBlock(diff) {
  if (!diff) return null;
  const lines = String(diff).split('\n').filter((l) => !/^(Index:|={3,}|diff --git|\\ No newline)/.test(l));
  const shown = lines.slice(0, 400);
  return el('div', { class: 'ag-as-diff', role: 'figure', 'aria-label': 'Changes' },
    shown.map((l) => el('div', {
      class: `ag-as-diff-l${/^\+(?!\+\+)/.test(l) ? ' is-add' : /^-(?!--)/.test(l) ? ' is-del' : /^@@/.test(l) ? ' is-hunk' : /^(\+\+\+|---)/.test(l) ? ' is-file' : ''}`,
    }, l || ' ')),
    lines.length > shown.length ? el('div', { class: 'meta ag-as-tool-more' }, `… ${lines.length - shown.length} more lines`) : null);
}

function todoList(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  return el('div', { class: 'ag-as-todos' }, todos.map((t) => el('div', { class: `ag-as-todo is-${t.status || 'pending'}` },
    el('span', { class: 'ag-as-todo-mark' }, t.status === 'completed' ? svg('check') : t.status === 'in_progress' ? el('span', { class: 'dot dot--live' }) : el('span', { class: 'ag-as-todo-box' })),
    el('span', {}, t.content || t.title || ''))));
}

function toolDetail(part) {
  const st = part.state || {};
  const input = st.input || {};
  const md0 = st.metadata || {};
  const kids = [];
  if (part.tool === 'bash') {
    if (input.command) kids.push(outBlock('Command', input.command, 'is-cmd'));
    kids.push(outBlock('Output', st.output ?? md0.output ?? ''));
  } else if (['edit', 'multiedit', 'apply_patch', 'patch'].includes(part.tool) && (md0.diff || input.patchText)) {
    kids.push(diffBlock(md0.diff || input.patchText));
  } else if (part.tool === 'write') {
    kids.push(outBlock(shortPath(input.filePath) || 'Content', input.content || ''));
  } else if (part.tool === 'todowrite' || part.tool === 'todoread') {
    kids.push(todoList(input.todos || md0.todos));
  } else {
    const keys = Object.keys(input);
    if (keys.length) {
      kids.push(el('div', { class: 'ag-as-kv' }, keys.map((k) => el('div', { class: 'ag-as-kv-row' },
        el('span', { class: 'ag-as-kv-k' }, k),
        el('span', { class: 'ag-as-kv-v' }, typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k], null, 1))))));
    }
    if (part.tool !== 'read') kids.push(outBlock('Result', st.output || ''));
    else if (st.output) kids.push(outBlock('Read', st.output));
  }
  if (st.status === 'error') kids.push(el('div', { class: 'ag-as-tool-err' }, svg('warn'), el('span', {}, String(st.error || 'Failed'))));
  return kids.filter(Boolean);
}

function toolRow(part, prevOpen) {
  const st = part.state || {};
  const { icon, label, arg } = toolInfo(part.tool, st.input);
  const status = st.status || 'pending';
  const took = st.time?.end && st.time?.start ? dur(st.time.end - st.time.start) : '';
  const title = st.title && st.title !== arg ? st.title : '';
  const detail = el('div', { class: 'ag-as-tool-body' });
  const d = el('details', { class: `ag-as-tool is-${status}`, 'data-call': part.callID || '' },
    el('summary', { class: 'ag-as-tool-sum' },
      el('span', { class: 'ag-as-tool-ic' }, svg(icon)),
      el('span', { class: 'ag-as-tool-name' }, label),
      el('span', { class: 'ag-as-tool-arg', title: arg }, arg || title),
      el('span', { class: 'ag-as-tool-st' },
        status === 'running' || status === 'pending' ? el('span', { class: 'ag-as-spin', 'aria-label': 'running' })
          : status === 'error' ? el('span', { class: 'ag-as-tool-bad' }, 'failed')
            : el('span', { class: 'ag-as-tool-took' }, took)),
      el('span', { class: 'ag-as-tool-chev' }, svg('chevron'))),
    detail);
  // The body is built on first open: a long session has hundreds of these.
  const fill = () => { if (!detail.childElementCount) detail.append(...toolDetail(part)); };
  d.addEventListener('toggle', () => { if (d.open) fill(); });
  // Edits show their diff without a click; everything else stays a line.
  const auto = ['edit', 'apply_patch', 'multiedit'].includes(part.tool) && status === 'completed' && (st.metadata?.diff || '').length < 4000;
  if (prevOpen ?? auto) { d.open = true; fill(); }
  return d;
}

/* ── permission and question cards ──────────────────────────────────── */

const PERM_TEXT = {
  bash: 'Run this command?',
  edit: 'Change this file?',
  write: 'Write this file?',
  apply_patch: 'Apply this patch?',
  webfetch: 'Fetch this page?',
  websearch: 'Search the web?',
  external_directory: 'Work outside the conversation’s folder?',
  doom_loop: 'It is repeating itself. Let it continue?',
};

function permCard(p, toolPart) {
  const tool = toolPart?.state?.input || {};
  const name = p.permission;
  const head = PERM_TEXT[name] || (name.startsWith('ojee_') ? `Use ${toolInfo(name).label.toLowerCase()} on the console?` : `Use ${pretty(name)}?`);
  const what = p.metadata?.command || first(p.patterns?.filter((x) => x !== '*'))
    || (Object.keys(tool).length ? toolInfo(name, tool).arg : '') || '';
  const always = (p.always || []).filter(Boolean);
  const diff = p.metadata?.diff;
  const busyBtn = (b) => { for (const x of b.parentElement.querySelectorAll('button')) x.disabled = true; };
  return el('div', { class: 'ag-as-ask', role: 'group', 'aria-label': 'Permission request' },
    el('div', { class: 'ag-as-ask-head' }, svg('warn'), el('strong', {}, head)),
    what ? el('pre', { class: 'ag-as-ask-what' }, what) : null,
    diff ? diffBlock(diff) : null,
    el('div', { class: 'ag-as-ask-actions' },
      el('button', { class: 'btn btn--sm', type: 'button', onclick: (e) => { busyBtn(e.currentTarget); replyPerm(p, 'once'); } }, 'Allow'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        title: always.length ? `Allow without asking again in this conversation: ${always.join(', ')}` : 'Allow without asking again in this conversation',
        onclick: (e) => { busyBtn(e.currentTarget); replyPerm(p, 'always'); },
      }, always.length && always[0] !== '*' ? `Always allow ${always[0]}` : 'Always allow'),
      el('button', { class: 'btn btn--ghost btn--sm ag-as-deny', type: 'button', onclick: (e) => { busyBtn(e.currentTarget); replyPerm(p, 'reject'); } }, 'Deny')));
}

function questionCard(q) {
  const picks = q.questions.map(() => new Set());
  const customs = q.questions.map(() => '');
  const submit = () => replyQuestion(q, q.questions.map((_, i) => [...picks[i], ...(customs[i].trim() ? [customs[i].trim()] : [])]));
  return el('div', { class: 'ag-as-ask ag-as-ask--q', role: 'group', 'aria-label': 'Question' },
    q.questions.map((qq, i) => el('div', { class: 'ag-as-q' },
      el('div', { class: 'ag-as-ask-head' }, svg('info'), el('strong', {}, qq.question)),
      el('div', { class: 'ag-as-q-opts' }, (qq.options || []).map((o) => el('button', {
        class: 'ag-as-q-opt', type: 'button', 'aria-pressed': 'false', title: o.description || null,
        onclick: (e) => {
          const b = e.currentTarget;
          if (!qq.multiple) {
            picks[i].clear();
            for (const x of b.parentElement.children) x.setAttribute('aria-pressed', 'false');
          }
          if (picks[i].has(o.label)) { picks[i].delete(o.label); b.setAttribute('aria-pressed', 'false'); }
          else { picks[i].add(o.label); b.setAttribute('aria-pressed', 'true'); }
          if (!qq.multiple && q.questions.length === 1 && !customs[0]) submit();
        },
      }, el('span', {}, o.label), o.description ? el('span', { class: 'ag-as-q-desc' }, o.description) : null))),
      qq.custom !== false ? el('input', { class: 'input ag-as-q-custom', placeholder: 'Or type an answer', oninput: (e) => { customs[i] = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } }) : null)),
    el('div', { class: 'ag-as-ask-actions' },
      el('button', { class: 'btn btn--sm', type: 'button', onclick: submit }, 'Answer'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => replyQuestion(q, null, true) }, 'Dismiss')));
}

/* ── the transcript ─────────────────────────────────────────────────── */

const HIDDEN = new Set(['step-start', 'step-finish', 'snapshot', 'agent']);

function partNode(part, msg, prev, streaming) {
  switch (part.type) {
    case 'text':
      if (part.synthetic || part.ignored || !String(part.text || '').trim()) return null;
      return el('div', { class: `ag-as-text${streaming && !part.time?.end ? ' is-streaming' : ''}` }, md(part.text));
    case 'reasoning': {
      const text = String(part.text || '').trim();
      if (!text) return null;
      const live = !part.time?.end && streaming;
      const took = part.time?.end && part.time?.start ? dur(part.time.end - part.time.start) : '';
      const d = el('details', { class: `ag-as-think${live ? ' is-live' : ''}` },
        el('summary', { class: 'ag-as-think-sum' },
          el('span', {}, live ? 'Thinking' : 'Thought'),
          took ? el('span', { class: 'meta' }, took) : null,
          live ? el('span', { class: 'ag-as-think-tail' }, text.split('\n').filter(Boolean).pop()?.slice(-90) || '') : null,
          el('span', { class: 'ag-as-tool-chev' }, svg('chevron'))),
        el('div', { class: 'ag-as-think-body' }, md(text)));
      if (prev?.open) d.open = true;
      return d;
    }
    case 'tool':
      return toolRow(part, prev?.open);
    case 'patch':
      return part.files?.length ? el('div', { class: 'ag-as-note' }, svg('edit'),
        el('span', {}, `Changed ${part.files.length} file${part.files.length === 1 ? '' : 's'}: `, part.files.map((f) => shortPath(f)).join(', '))) : null;
    case 'file':
      return el('div', { class: 'ag-as-note' }, svg('file'), el('span', {}, part.filename || part.url || 'file'));
    case 'retry':
      return el('div', { class: 'ag-as-note is-warn' }, svg('refresh'),
        el('span', {}, `Retry ${part.attempt}: ${part.error?.data?.message?.split('\n')[0] || 'the provider failed'}`));
    case 'subtask':
      return el('div', { class: 'ag-as-note' }, svg('chip'), el('span', {}, `Handed to ${part.agent}: ${part.description || ''}`));
    case 'compaction':
      return el('div', { class: 'ag-as-note' }, svg('info'), el('span', {}, 'Earlier messages were summarised to make room.'));
    default:
      return null;
  }
}

/**
 * A conversation, drawn into `host` and kept in step with the store.
 * Each part is redrawn only when its version moves; a delta to the text
 * being streamed redraws that text and nothing else.
 */
export function transcript(sid, { empty, onPickModel } = {}) {
  const log = el('div', { class: 'ag-as-log', tabindex: '0', role: 'log', 'aria-label': 'Conversation' });
  const thread = el('div', { class: 'ag-as-thread' });
  const jump = el('button', { class: 'ag-as-jump', type: 'button', hidden: true, onclick: () => { stick = true; toEnd(true); } }, svg('arrow'), 'Latest');
  const wrap = el('div', { class: 'ag-as-logwrap' }, log, jump);
  log.append(thread);

  const parts = new Map();   // part id → { node, sv }
  const cards = new Map();   // permission / question id → its card, kept while pending
  const cardFor = (x, toolPart) => {
    if (!cards.has(x.id)) cards.set(x.id, x.questions ? questionCard(x) : permCard(x, toolPart));
    return cards.get(x.id);
  };
  const turns = new Map();   // user msg id (or '_') → { node, you, reply, sign, youV }
  let stick = true;
  let raf = 0;
  let timer = null;
  let lastScroll = 0;

  log.addEventListener('scroll', () => {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    // A scroll the code made (to the end) must not count as the reader leaving.
    if (Date.now() - lastScroll > 120) stick = near;
    if (near) jump.hidden = true;
  }, { passive: true });

  function toEnd(smooth) {
    lastScroll = Date.now();
    log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function turnFor(key) {
    let t = turns.get(key);
    if (!t) {
      t = { node: el('section', { class: 'ag-as-turn' }), you: null, reply: el('div', { class: 'ag-as-reply' }), sign: el('div', { class: 'ag-as-sign' }), extra: el('div', { class: 'ag-as-extra' }) };
      t.node.append(t.reply, t.extra, t.sign);
      turns.set(key, t);
    }
    return t;
  }

  function youNode(m) {
    const text = [...m.parts.values()].filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n');
    const files = [...m.parts.values()].filter((p) => p.type === 'file');
    return el('div', { class: 'ag-as-you' },
      el('div', { class: 'ag-as-you-box' },
        el('div', { class: 'ag-as-you-text' }, text),
        files.length ? el('div', { class: 'ag-as-you-files' }, files.map((f) => el('span', { class: 'ag-as-chip' }, svg('file'), f.filename || 'file'))) : null),
      el('div', { class: 'ag-as-you-meta' },
        el('span', { class: 'meta' }, clock(m.info.time?.created)),
        copyBtn(() => text, 'Copy message')));
  }

  function signNode(asst, isLast, state) {
    if (!asst.length) return null;
    const lastMsg = asst[asst.length - 1].info;
    const done = !!lastMsg.time?.completed || !!lastMsg.error;
    if (isLast && state !== 'idle' && state !== 'error') return null;
    if (!done && !isLast) return null;
    const tokens = asst.reduce((n, m) => n + (m.info.tokens?.output || 0) + (m.info.tokens?.reasoning || 0), 0);
    const ctxTok = (lastMsg.tokens?.input || 0) + (lastMsg.tokens?.cache?.read || 0);
    const cost = asst.reduce((n, m) => n + (m.info.cost || 0), 0);
    const start = asst[0].info.time?.created;
    const end = lastMsg.time?.completed;
    const key = lastMsg.providerID ? `${lastMsg.providerID}/${lastMsg.modelID}` : null;
    const t = S.turns.get(sid);
    const fell = isLast && t?.fallbacks?.length && t.model === key ? t.fallbacks : [];
    const text = asst.flatMap((m) => [...m.parts.values()]).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n\n');
    return [
      el('span', { class: 'ag-as-sign-model', title: key || '' }, modelName(key) || 'Model'),
      lastMsg.agent && lastMsg.agent !== 'build' ? el('span', { class: 'ag-as-sign-bit' }, lastMsg.agent) : null,
      fell.length ? el('span', { class: 'ag-as-sign-bit is-warn', title: fell.map((f) => `${modelName(f.from)}: ${f.reason}`).join('\n') }, `after ${fell.length} refused`) : null,
      tokens ? el('span', { class: 'ag-as-sign-bit', title: `${kfmt(ctxTok)} tokens of context` }, `${kfmt(tokens)} out`) : null,
      cost ? el('span', { class: 'ag-as-sign-bit' }, `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`) : null,
      start && end ? el('span', { class: 'ag-as-sign-bit' }, dur(end - start)) : null,
      text.trim() ? copyBtn(() => text, 'Copy reply') : null,
    ];
  }

  function workingNode(state) {
    const t = S.turns.get(sid);
    const st = S.status.get(sid);
    const model = t?.model || sessionModel(S.sessions.get(sid));
    const since = t?.at || Date.now();
    const line = state === 'retrying'
      ? `Retrying ${modelName(model)}${st?.attempt ? ` (attempt ${st.attempt})` : ''} — ${String(st?.message || '').split('\n')[0].slice(0, 120)}`
      : state === 'waiting' ? 'Waiting for you' : `${modelName(model) || 'Working'}`;
    return el('div', { class: `ag-as-working is-${state}` },
      el('span', { class: 'ag-as-pulse' }),
      el('span', { class: 'ag-as-working-text' }, line),
      state === 'waiting' ? null : el('span', { class: 'ag-as-working-t meta', 'data-since': String(since) }, dur(Date.now() - since)));
  }

  function errorNode(t, isLast) {
    if (!isLast || !t || t.phase !== 'failed') return null;
    return el('div', { class: 'ag-as-fail', role: 'alert' },
      el('div', { class: 'ag-as-fail-head' }, svg('warn'), el('strong', {}, 'No answer'),
        t.model ? el('span', { class: 'meta' }, modelName(t.model)) : null),
      el('p', { class: 'ag-as-fail-text' }, t.error || 'The model failed.'),
      t.fallbacks?.length ? el('p', { class: 'meta' }, `Also tried: ${t.fallbacks.map((f) => modelName(f.from)).join(', ')}`) : null,
      el('div', { class: 'ag-as-ask-actions' },
        el('button', { class: 'btn btn--sm', type: 'button', onclick: () => retry(sid) }, svg('refresh'), 'Try again'),
        onPickModel ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: (e) => onPickModel(e.currentTarget, (key) => retry(sid, key)) }, 'Try another model') : null));
  }

  function fallbackNotes(isLast) {
    const t = S.turns.get(sid);
    if (!isLast || !t?.fallbacks?.length || !['started', 'fallback'].includes(t.phase)) return [];
    return t.fallbacks.map((f) => el('div', { class: 'ag-as-note is-warn' }, svg('swap'),
      el('span', {}, `${modelName(f.from)} did not answer (${f.reason}) — asking ${modelName(f.to)}`)));
  }

  function sync() {
    raf = 0;
    const c = S.convs.get(sid);
    if (!c || (c.loading && !c.msgs.size)) {
      thread.replaceChildren(el('div', { class: 'ag-as-loading' },
        el('span', { class: 'skeleton', style: 'height:44px;width:55%;margin-left:auto' }),
        el('span', { class: 'skeleton', style: 'height:96px' }),
        el('span', { class: 'skeleton', style: 'height:44px;width:40%;margin-left:auto' })));
      turns.clear(); parts.clear();
      return;
    }
    if (c.error && !c.msgs.size) {
      thread.replaceChildren(problem('Could not open this conversation', c.error,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => loadConv(sid) }, 'Try again')));
      turns.clear(); parts.clear();
      return;
    }
    const before = stick;
    const state = liveState(sid);
    const msgs = [...c.msgs.values()].sort((a, b) => (a.info.id < b.info.id ? -1 : 1));

    // Group: each user message opens a turn; assistant steps join the turn
    // of the message they answer.
    const order = [];
    const asstOf = new Map();
    let cur = null;
    for (const m of msgs) {
      if (m.info.role === 'user') { cur = m.info.id; order.push(cur); asstOf.set(cur, { user: m, asst: [] }); continue; }
      const k = (m.info.parentID && asstOf.has(m.info.parentID)) ? m.info.parentID : (cur || '_');
      if (!asstOf.has(k)) { order.push(k); asstOf.set(k, { user: null, asst: [] }); }
      asstOf.get(k).asst.push(m);
    }
    const t = S.turns.get(sid);
    // Sent, and opencode has not echoed the message back yet: it is drawn
    // straight away rather than after the round trip.
    const users = msgs.filter((m) => m.info.role === 'user').length;
    const pendingSend = ['working', 'retrying'].includes(state) && t?.users != null && users <= t.users && t.text;

    if (!order.length && !pendingSend) {
      thread.replaceChildren(empty ? empty() : el('div', { class: 'ag-as-empty' }, mark('ic ic--xl'), el('b', {}, 'Nothing here yet')));
      turns.clear(); parts.clear();
      return;
    }

    const live = new Set();
    const nodes = [];
    order.forEach((k, idx) => {
      const { user, asst } = asstOf.get(k);
      const isLast = idx === order.length - 1;
      const T = turnFor(k);
      live.add(k);
      if (user) {
        const uv = [...user.parts.values()].reduce((n, p) => n + p._v, 0);
        if (T.youV !== uv) {
          const n = youNode(user);
          if (T.you) T.you.replaceWith(n); else T.node.prepend(n);
          T.you = n;
          T.youV = uv;
        }
      }
      // Parts, in message then part order.
      const want = [];
      for (const m of asst) {
        const streaming = !m.info.time?.completed;
        const ps = [...m.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const p of ps) {
          if (HIDDEN.has(p.type)) continue;
          const have = parts.get(p.id);
          const sv = `${p._v}:${streaming ? 1 : 0}`;
          if (!have || have.sv !== sv) {
            const n = partNode(p, m, have?.node, streaming && isLast);
            if (have?.node && n) have.node.replaceWith(n);
            else if (have?.node && !n) have.node.remove();
            parts.set(p.id, { sv, node: n });
          }
          const node = parts.get(p.id).node;
          if (node) want.push(node);
          // A permission waiting on this very tool call sits under it.
          if (p.type === 'tool') {
            for (const pr of S.perms.values()) if (pr.sessionID === sid && pr.tool?.callID === p.callID) want.push(cardFor(pr, p));
            for (const q of S.questions.values()) if (q.sessionID === sid && q.tool?.callID === p.callID) want.push(cardFor(q));
          }
        }
        if (m.info.error && m.info.error.name !== 'MessageAbortedError' && !(isLast && t?.phase === 'failed')) {
          want.push(el('div', { class: 'ag-as-note is-err' }, svg('warn'), el('span', {}, String(m.info.error.data?.message || m.info.error.name).split('\n')[0])));
        }
        if (m.info.error?.name === 'MessageAbortedError') want.push(el('div', { class: 'ag-as-note' }, svg('stop'), el('span', {}, 'Stopped')));
      }
      // Reconcile the reply's children with `want` without touching nodes in place.
      const kids = T.reply.children;
      want.forEach((n, i) => { if (kids[i] !== n) T.reply.insertBefore(n, kids[i] || null); });
      while (kids.length > want.length) kids[kids.length - 1].remove();

      // Under the reply: what is pending that no tool row claimed, the
      // working line, fallbacks, the failure.
      const extra = [];
      if (isLast) {
        const calls = new Set(asst.flatMap((m) => [...m.parts.values()]).filter((p) => p.type === 'tool').map((p) => p.callID));
        for (const pr of S.perms.values()) if (pr.sessionID === sid && !calls.has(pr.tool?.callID)) extra.push(cardFor(pr, null));
        for (const q of S.questions.values()) if (q.sessionID === sid && !calls.has(q.tool?.callID)) extra.push(cardFor(q));
        extra.push(...fallbackNotes(true));
        if (['working', 'retrying'].includes(state) && !pendingSend) extra.push(workingNode(state));
        const fail = errorNode(t, true);
        if (fail) extra.push(fail);
      }
      // Rebuilt only when something in it changed: a card being clicked
      // must not be swapped out from under the pointer.
      const sig = JSON.stringify([isLast, state, !!pendingSend, t?.phase, t?.model, t?.fallbacks?.length, t?.error,
        [...S.perms.keys()], [...S.questions.keys()], asst.length]);
      if (T.extraSig !== sig) { T.extra.replaceChildren(...extra); T.extraSig = sig; }
      const sign = signNode(asst, isLast, state);
      const ssig = JSON.stringify([asst.length, asst.map((m) => [m.info.time?.completed, m.info.tokens?.output]), state, isLast, t?.fallbacks?.length]);
      if (T.signSig !== ssig) { T.sign.replaceChildren(...(sign || []).filter(Boolean)); T.signSig = ssig; }
      nodes.push(T.node);
    });

    // An optimistic turn: the message was sent and opencode has not echoed it yet.
    if (pendingSend) {
      const ghost = el('section', { class: 'ag-as-turn is-pending' },
        el('div', { class: 'ag-as-you' }, el('div', { class: 'ag-as-you-box' }, el('div', { class: 'ag-as-you-text' }, t.text))),
        el('div', { class: 'ag-as-extra' }, workingNode('working')));
      nodes.push(ghost);
    }

    for (const k of [...turns.keys()]) if (!live.has(k)) turns.delete(k);
    for (const id of [...cards.keys()]) if (!S.perms.has(id) && !S.questions.has(id)) cards.delete(id);
    const kids = thread.children;
    nodes.forEach((n, i) => { if (kids[i] !== n) thread.insertBefore(n, kids[i] || null); });
    while (kids.length > nodes.length) kids[kids.length - 1].remove();

    if (before) toEnd(false);
    else jump.hidden = false;

    clearInterval(timer);
    if (['working', 'retrying'].includes(state)) {
      timer = setInterval(() => {
        for (const n of thread.querySelectorAll('.ag-as-working-t')) n.textContent = dur(Date.now() - Number(n.dataset.since));
      }, 1000);
    }
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };
  const off = on((what, id) => {
    if ((what === 'conv' || what === 'session') && id === sid) schedule();
    else if (what === 'config') { parts.clear(); for (const T of turns.values()) { T.signSig = null; T.extraSig = null; } schedule(); }
  });
  if (!S.convs.has(sid) || !S.convs.get(sid).loadedAt) loadConv(sid);
  sync();

  return {
    el: wrap,
    log,
    sync: schedule,
    toEnd: () => { stick = true; toEnd(false); },
    destroy() { off(); clearInterval(timer); cancelAnimationFrame(raf); },
  };
}

/* ── the model menu ─────────────────────────────────────────────────── */

let menuOpen = null;

/**
 * A searchable list of every model, anchored to the control that opened it.
 * Free models first, then the subscription's, each with its context size.
 * Escape closes the menu only — never the dialog behind it.
 */
export function modelMenu(anchor, current, onPick, { allowDefault = false } = {}) {
  menuOpen?.close();
  const list = models();
  const q = el('input', { class: 'input ag-as-menu-q', placeholder: 'Find a model', 'aria-label': 'Find a model', spellcheck: 'false', autocomplete: 'off' });
  const box = el('div', { class: 'ag-as-menu-list', role: 'listbox', 'aria-label': 'Models' });
  const menu = el('div', { class: 'ag-as-menu', role: 'dialog', 'aria-label': 'Choose a model' }, q, box);
  let sel = 0;
  let shown = [];
  const def = defaultModel();

  const paint = () => {
    const f = q.value.trim().toLowerCase();
    const rows = [];
    if (allowDefault && !f) rows.push({ key: null, name: `Default — ${modelName(def)}`, group: null });
    for (const m of list) {
      if (f && !`${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(f)) continue;
      rows.push({ ...m, group: m.free ? 'Free' : 'OpenCode Go' });
    }
    shown = rows;
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    let g = undefined;
    const out = [];
    rows.forEach((m, i) => {
      if (m.group !== g && m.group) { out.push(el('div', { class: 'ag-as-menu-group' }, m.group)); }
      g = m.group;
      out.push(el('button', {
        class: `ag-as-menu-item${i === sel ? ' is-sel' : ''}${m.key === current ? ' is-cur' : ''}`,
        type: 'button', role: 'option', 'aria-selected': String(m.key === current),
        onmousemove: () => { if (sel !== i) { sel = i; paint(); } },
        onclick: () => { close(); onPick(m.key); },
      },
      el('span', { class: 'ag-as-menu-name' }, m.name),
      m.context ? el('span', { class: 'ag-as-menu-ctx' }, `${kfmt(m.context)}`) : null,
      m.key === current ? svg('check') : el('span', { class: 'ag-as-menu-gap' })));
    });
    if (!rows.length) out.push(el('div', { class: 'meta ag-as-menu-none' }, list.length ? 'No model matches.' : 'The model list has not loaded.'));
    box.replaceChildren(...out);
    box.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  };

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const phone = innerWidth <= 560;
    if (phone) { menu.classList.add('is-sheet'); return; }
    const w = 340;
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    const below = innerHeight - r.bottom;
    const h = Math.min(420, Math.max(below, r.top) - 16);
    menu.style.width = `${w}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${h}px`;
    if (below >= 300 || below >= r.top) menu.style.top = `${r.bottom + 6}px`;
    else menu.style.bottom = `${innerHeight - r.top + 6}px`;
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); anchor.focus?.(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); const m = shown[sel]; if (m) { close(); onPick(m.key); } }
  };
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const scrim = el('div', { class: 'ag-as-menu-scrim', onclick: () => close() });
  function close() {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', close);
    menu.remove(); scrim.remove();
    if (menuOpen?.close === close) menuOpen = null;
  }
  q.addEventListener('input', () => { sel = 0; paint(); });
  // On the window, capturing: that runs before anything on the document, so
  // the dialog behind never hears the Escape that closes this menu.
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', close);
  if (innerWidth <= 560) document.body.append(scrim);
  document.body.append(menu);
  place();
  sel = Math.max(0, (allowDefault && !current ? 0 : -1));
  paint();
  const ci = shown.findIndex((m) => m.key === current);
  if (ci >= 0) { sel = ci; paint(); }
  if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) q.focus();
  menuOpen = { close };
  return { close };
}

/* ── the composer ───────────────────────────────────────────────────── */

/**
 * Words, the model they go to, the mode, and send — or stop while a reply is
 * coming. `sid()` is the conversation it belongs to (null before the first
 * message); `onSend({text, model, agent})` does the sending.
 */
export function composer({ sid, onSend, placeholder = 'Ask anything', escStops = true, autofocus = false, storeKey = 'ag-as-draft' }) {
  // A phone's Enter is its newline key — a send button sits beside it. Any
  // other device sends on Enter, as every chat box does.
  const fine = !(window.matchMedia('(hover: none) and (pointer: coarse)').matches && innerWidth < 900);
  const ta = el('textarea', {
    class: 'ag-as-input', rows: '1', placeholder, 'aria-label': 'Message', spellcheck: 'true', enterkeyhint: fine ? 'send' : 'enter',
  });
  let pick = null;          // an explicit model for the next message, or null
  let agent = null;         // an explicit mode, or null
  const draftKey = () => `${storeKey}:${sid() || 'new'}`;
  ta.value = pref(draftKey()) || '';

  const modelBtn = el('button', { class: 'ag-as-pickbtn', type: 'button', 'aria-haspopup': 'listbox', title: 'Model for the next message' });
  const modeBtn = el('button', { class: 'ag-as-modebtn', type: 'button', title: 'Build: may change files and run tools. Plan: reads and proposes, changes nothing.' });
  const sendBtn = el('button', { class: 'ag-as-send', type: 'button' });
  const note = el('span', { class: 'ag-as-cnote' });
  const root = el('div', { class: 'ag-as-composer' },
    ta,
    el('div', { class: 'ag-as-cbar' }, modelBtn, modeBtn, note, sendBtn));

  const curModel = () => {
    if (pick) return pick;
    const id = sid();
    const m = sessionModel(S.sessions.get(id));
    const t = id ? S.turns.get(id) : null;
    // A conversation whose last message failed everywhere goes back to the
    // default, not to the model that refused it (the server does the same).
    if (t?.phase === 'failed' && t.model === m) return defaultModel();
    return m || defaultModel();
  };
  const curAgent = () => agent || S.sessions.get(sid())?.agent || S.cfg?.settings?.agent || 'build';

  function size() {
    ta.style.height = 'auto';
    const max = Math.max(120, Math.round(innerHeight * 0.32));
    ta.style.height = `${Math.min(max, ta.scrollHeight + 2)}px`;
    ta.style.overflowY = ta.scrollHeight + 2 > max ? 'auto' : 'hidden';
  }

  function refresh() {
    const id = sid();
    const isBusy = id && busy(id);
    const m = curModel();
    modelBtn.replaceChildren(el('span', { class: 'ag-as-pickbtn-name' }, m ? modelName(m) : 'Model'), el('span', { class: 'ag-as-pickbtn-chev' }, svg('chevron')));
    modelBtn.classList.toggle('is-picked', !!pick);
    modelBtn.disabled = !models().length;
    const a = curAgent();
    modeBtn.textContent = a === 'plan' ? 'Plan' : 'Build';
    modeBtn.classList.toggle('is-plan', a === 'plan');
    sendBtn.replaceChildren(isBusy ? svg('stop') : svg('arrow'));
    sendBtn.classList.toggle('is-stop', !!isBusy);
    sendBtn.title = isBusy ? `Stop${escStops ? ' (Esc)' : ''}` : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', isBusy ? 'Stop the reply' : 'Send');
    sendBtn.disabled = !isBusy && !ta.value.trim();
    const st = id ? liveState(id) : 'idle';
    note.textContent = st === 'waiting' ? 'Waiting for your answer above'
      : st === 'retrying' ? 'Provider is retrying'
        : S.online === false ? 'OpenCode is not answering' : '';
  }

  async function submit() {
    const id = sid();
    if (id && busy(id)) { toast('warn', 'Still answering', escStops ? 'Esc or the stop button ends this reply.' : 'Stop this reply first, or wait for it.'); return; }
    const text = ta.value.trim();
    if (!text) return;
    const sent = { text, model: pick, agent: agent || undefined };
    ta.value = '';
    pref(draftKey(), null);
    size();
    refresh();
    try {
      await onSend(sent);
      pick = null;
    } catch (e) {
      ta.value = text;
      size();
      toast('err', 'Not sent', e.message);
    }
    refresh();
  }

  ta.addEventListener('input', () => { size(); refresh(); pref(draftKey(), ta.value || null); });
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && fine))) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && escStops && sid() && busy(sid())) { e.preventDefault(); e.stopPropagation(); abort(sid()); }
  });
  sendBtn.addEventListener('click', () => { const id = sid(); if (id && busy(id)) abort(id); else submit(); });
  modelBtn.addEventListener('click', () => modelMenu(modelBtn, curModel(), (key) => { pick = key; refresh(); ta.focus(); }));
  modeBtn.addEventListener('click', () => { agent = curAgent() === 'plan' ? 'build' : 'plan'; refresh(); });

  const off = on((what, id) => { if (what === 'config' || what === 'upstream' || id === sid()) refresh(); });
  requestAnimationFrame(() => { size(); if (autofocus) ta.focus(); });
  refresh();

  return {
    el: root,
    input: ta,
    focus: () => { ta.focus({ preventScroll: true }); const n = ta.value.length; ta.setSelectionRange(n, n); },
    refresh,
    setPick: (k) => { pick = k; refresh(); },
    reload: () => { ta.value = pref(draftKey()) || ''; size(); refresh(); },
    destroy: off,
  };
}
