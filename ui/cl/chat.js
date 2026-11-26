/* ============================================================
   The chat: a session read as a conversation, live.

   Where its data comes from (no polling, no screen-scraping for
   anything a structured source can say):
   - the runner's live channel (/sessions/:id/live, SSE): the last
     2 MB of the transcript on connect, then every new line as
     Claude Code writes it; the session's state from its hooks,
     with the question / plan / permission it is asking (as the
     hook described it) and the tool call running now
   - your message is drawn the moment you send it, and becomes the
     real one when it shows up in the transcript (or in Claude
     Code's queue, which the transcript also records)
   - the screen, read by the runner only for what nothing else
     says: permission mode, Claude Code's suggestion, words typed
     in the terminal but not sent, and the options of a dialog no
     hook spelled out

   Long sessions stay quick: only the newest rows are drawn; older
   ones are drawn, then fetched, as you scroll up to them.
   ============================================================ */

import { h, icon, swap, clip, clock, dur, fmtSize, touch, fine, copyText, pref } from './dom.js';
import { makeMd, diffView } from './md.js';
import { keyRow } from './term.js';
import { S, api, post, upsert, online, modelLabel, missingRoute, toast } from './state.js';

const STEP = 120;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TOOL_ICON = { Bash: 'term', Read: 'file', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', WebFetch: 'link', WebSearch: 'search', Task: 'layers', Agent: 'layers', TodoWrite: 'check', AskUserQuestion: 'ask', ExitPlanMode: 'summary', Skill: 'zap' };
const unent = (t) => { let x = String(t ?? ''); for (let k = 0; k < 3 && /&(amp|lt|gt|quot|#39);/.test(x); k++) x = x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); return x; };
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p || '';
const lines = (t) => (t ? String(t).split('\n').length : 0);
const time = (at) => (at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** Commands people reach for, until the runner's full list arrives. */
const SLASH = [
  ['/compact', 'Summarise the conversation to free context', true], ['/clear', 'Start a fresh conversation'],
  ['/model', 'Pick the model'], ['/context', 'How full the context is'], ['/usage', 'Plan usage and resets'],
  ['/cost', 'Tokens so far'], ['/status', 'Version, model, account'], ['/todos', 'The to-do list'],
  ['/tasks', 'Background tasks'], ['/agents', 'Subagents'], ['/mcp', 'MCP servers'], ['/memory', 'Memory files'],
  ['/review', 'Review a pull request', true], ['/init', 'Write a CLAUDE.md'], ['/rewind', 'Go back to an earlier point'],
  ['/export', 'Export the conversation'], ['/add-dir', 'Add a working folder', true], ['/help', 'Every command'],
].map(([name, desc, args]) => ({ name, desc, args: !!args, source: 'Claude Code' }));
const cmdCache = new Map();

export function createChat({ session: s0, onPath, onAgent, onOpenAgents, keys = false }) {
  const dev = s0.device;
  const id = s0.id;
  let s = s0;
  const ctx = S.ctx;
  const { md, pre, copyBtn, withPaths } = makeMd({ onPath, toast });
  let agent = null;          // a subagent being read (read only), or null
  let es = null;
  let pollTimer = null;
  let destroyed = false;
  let screen = null;          // { mode, suggestion, draft, menu } from the runner
  let sugGone = null;
  const pending = [];         // optimistic sends: { text, at, state, error }
  const sent = [];            // what was sent, for Up to recall
  const attach = [];
  let sending = false;

  /* ── the list ─────────────────────────────────────────────────── */

  const top = h('div', { class: 'cl-top' });
  const list = h('div', { class: 'cl-msgs' });
  const pend = h('div', { class: 'cl-pend' });
  const scroll = h('div', { class: 'cl-scroll', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off', tabindex: '0' }, h('div', { class: 'cl-col' }, top, list, pend));
  const jump = h('button', { class: 'btn sm cl-jump', type: 'button', hidden: true, onclick: () => toBottom(true) }, icon('down', 's'), 'Latest');
  const agentBar = h('div', { class: 'cl-agentbar', hidden: true });
  const card = h('div', { class: 'cl-card-host' });
  const live = h('div', { class: 'cl-live', 'aria-live': 'polite' });
  const tray = h('div', { class: 'cl-tray', hidden: true });
  const slash = h('div', { class: 'cl-slash', role: 'listbox', 'aria-label': 'Commands', hidden: true });
  const input = h('textarea', {
    class: 'cl-input', rows: '1', 'aria-label': 'Message', autocomplete: 'off', autocapitalize: 'sentences',
    enterkeyhint: touch() ? 'enter' : 'send', spellcheck: 'true',
  });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles(picker.files); picker.value = ''; } });
  const keep = (e) => e.preventDefault();
  const sendBtn = h('button', { class: 'btn pri cl-send', type: 'button', 'aria-label': 'Send', onpointerdown: keep, onclick: () => send() }, icon('send', 's'));
  const hint = h('div', { class: 'cl-hint' });
  const keysHost = h('div', { class: 'cl-keyhost' });
  const compose = h('div', { class: 'cl-compose' },
    h('button', { class: 'ib cl-attach', type: 'button', title: 'Attach images or files', 'aria-label': 'Attach', onpointerdown: keep, onclick: () => picker.click() }, icon('plus')),
    h('div', { class: 'cl-inwrap' }, input, slash), picker, sendBtn);
  const dock = h('div', { class: 'cl-dock' }, card, live, tray, compose, hint);
  const el = h('div', { class: 'cl-chat' }, agentBar, h('div', { class: 'cl-scrollwrap' }, scroll, jump), dock, keysHost);

  // items: every message loaded, results folded into their call.
  let items = [];
  let first = 0;
  let start = 0;
  let truncated = false;
  let loading = false;
  let byTool = new Map();
  let orphans = new Map();
  let follow = true;
  let armed = false;

  function fold(msgs, into) {
    const added = [];
    const touched = [];
    for (const m of msgs) {
      if (m.role === 'result' && m.toolUseId) {
        const t = byTool.get(m.toolUseId);
        if (t) { t.result = m; touched.push(t); continue; }
        orphans.set(m.toolUseId, m);
      }
      if (m.role === 'hook' && m.toolUseId && byTool.get(m.toolUseId)) {
        const t = byTool.get(m.toolUseId);
        (t.hooks ||= []).push(m);
        touched.push(t);
        continue;
      }
      if (m.role === 'tool' && m.id) {
        byTool.set(m.id, m);
        const o = orphans.get(m.id);
        if (o) {
          orphans.delete(m.id);
          m.result = o;
          o._node?.remove();
          const k = items.indexOf(o);
          if (k >= 0) { items.splice(k, 1); if (k < first) first -= 1; }
        }
      }
      added.push(m);
    }
    if (into === 'end') items.push(...added); else items.unshift(...added);
    return { added, touched };
  }

  /** Calls that never got a result, before a later turn: not "running". */
  function settle() {
    let later = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m.role === 'user' || m.role === 'turn') later = true;
      if (m.role === 'tool' && !m.result && later && !m.stale) { m.stale = true; m._node?._update?.(); }
    }
  }

  const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
  function toBottom(force) {
    if (force || follow) { scroll.scrollTop = scroll.scrollHeight; follow = true; }
    jump.hidden = true;
  }
  scroll.addEventListener('scroll', () => { armed = true; follow = nearBottom(); if (follow) jump.hidden = true; }, { passive: true });
  const ro = new ResizeObserver(() => { if (follow) scroll.scrollTop = scroll.scrollHeight; });
  ro.observe(scroll);
  ro.observe(list);
  const io = new IntersectionObserver((es2) => {
    if (armed && es2.some((e) => e.isIntersecting) && (first > 0 || truncated) && !loading) earlier();
  }, { root: scroll, rootMargin: '240px 0px 0px 0px' });
  io.observe(top);

  /* ── rows ─────────────────────────────────────────────────────── */

  const mediaUrl = (m) => (m.url ? m.url : `${ctx.base}/api/claude/d/${encodeURIComponent(dev)}/sessions/${id}/media/${encodeURIComponent(m.id)}${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
  const images = (list2) => (list2?.length ? h('div', { class: 'cl-imgs' }, list2.map((m) => h('a', { class: 'cl-img', href: mediaUrl(m), target: '_blank', rel: 'noopener', title: `Open the image${m.size ? ` (${fmtSize(m.size)})` : ''}` },
    h('img', { src: mediaUrl(m), alt: 'Attached image', loading: 'lazy', decoding: 'async' })))) : null);

  /** A block cut to its first lines, with a way to see all of it. */
  function clamp(node, n, max = 14) {
    if (n <= max) return node;
    node.classList.add('clamped');
    node.style.setProperty('--max', `${max * 1.5}em`);
    const more = h('button', { class: 'cl-more', type: 'button' }, `Show all ${n} lines`);
    more.addEventListener('click', () => {
      const shut = node.classList.toggle('clamped');
      more.textContent = shut ? `Show all ${n} lines` : 'Show less';
    });
    return h('div', { class: 'cl-clampwrap' }, node, more);
  }

  /** What you wrote: a long paste reads like Claude Code's "[Pasted text]", one chip that opens. */
  function userText(text) {
    const t = String(text ?? '');
    const ls = t.split('\n');
    if (ls.length <= 14 && t.length <= 1600) return h('div', { class: 'tx' }, ...withPaths(t));
    let head = '';
    let body = t;
    const br = t.indexOf('\n\n');
    if (br > 0 && br < 400) { head = t.slice(0, br); body = t.slice(br + 2); }
    const n = body.split('\n').length;
    const full = h('pre', { class: 'cl-pre cl-paste', hidden: true }, body);
    const chip = h('button', { class: 'cl-pastechip', type: 'button', 'aria-expanded': 'false' }, icon('file', 's'),
      h('span', {}, 'Pasted text'), h('span', { class: 'm dim' }, `${n} lines`));
    chip.addEventListener('click', () => { full.hidden = !full.hidden; chip.setAttribute('aria-expanded', String(!full.hidden)); });
    return h('div', { class: 'tx' }, head ? h('div', {}, ...withPaths(head)) : null, chip, full);
  }

  function toolTarget(m) {
    const i = m.input || {};
    if (i.file_path) return [h('span', { class: 'm tgt' }, base(i.file_path)), h('span', { class: 'm dim' }, ` ${String(i.file_path).replace(/\/[^/]*$/, '').replace(/^.*?([^/]+\/[^/]+)$/, '…/$1')}`)];
    if (m.tool === 'Bash') return [h('span', { class: 'm tgt' }, clip(i.description || i.command || m.text, 140))];
    if (m.tool === 'TodoWrite' && i.todos) return [h('span', {}, `${i.todos.filter((t) => t.status === 'completed').length} of ${i.todos.length} done`)];
    if (m.tool === 'Task' || m.tool === 'Agent') return [h('span', {}, clip([i.subagent_type, i.description].filter(Boolean).join(' · ') || m.text, 140))];
    return [h('span', { class: 'm tgt' }, clip(m.text || '', 140))];
  }

  function toolStatus(m) {
    const r = m.result;
    if (!r && !m.id) return null;
    if (!r) return m.stale ? h('span', { class: 'st-tag dim' }, 'no result') : h('span', { class: 'st-tag run' }, h('span', { class: 'spin' }), 'running');
    if (r.exitCode != null && r.exitCode !== 0) return h('span', { class: 'st-tag err m' }, `exit ${r.exitCode}`);
    if (r.interrupted) return h('span', { class: 'st-tag warn' }, 'interrupted');
    if (r.error) return h('span', { class: 'st-tag err' }, 'error');
    if (r.background) return h('span', { class: 'st-tag dim' }, 'background');
    if (r.patch) { const a = r.patch.reduce((n, x) => n + x.lines.filter((l) => l[0] === '+').length, 0); const d = r.patch.reduce((n, x) => n + x.lines.filter((l) => l[0] === '-').length, 0); return h('span', { class: 'st-tag m' }, h('span', { class: 'add' }, `+${a}`), ' ', h('span', { class: 'del' }, `−${d}`)); }
    if (r.media?.length) return h('span', { class: 'st-tag dim' }, `${r.media.length} image${r.media.length === 1 ? '' : 's'}`);
    if (m.tool === 'AskUserQuestion') {
      const a = [...String(r.text || '').matchAll(/"[^"]*"="([^"]*)"/g)].map((x) => x[1]);
      return h('span', { class: 'st-tag' }, a.length ? `→ ${clip(a.join(', '), 60)}` : 'answered');
    }
    if (m.tool === 'Write') return h('span', { class: 'st-tag m' }, h('span', { class: 'add' }, `+${lines(m.input?.content)}`), r.change === 'create' ? ' new' : '');
    if (m.tool === 'Edit' || m.tool === 'MultiEdit') return h('span', { class: 'st-tag dim' }, 'edited');
    const n = lines(r.text);
    return h('span', { class: 'st-tag dim m' }, r.text?.trim() ? `${n} line${n === 1 ? '' : 's'}` : 'done');
  }

  function toolInput(m) {
    const i = m.input;
    if (!i) return m.text ? pre(m.text) : null;
    switch (m.tool) {
      case 'Bash': return h('div', { class: 'cl-cmd' }, h('span', { class: 'm dim' }, '$'), h('pre', { class: 'cl-pre m' }, i.command || ''), copyBtn(() => i.command || '', 'Copy command'));
      case 'Edit': case 'MultiEdit': case 'Write': {
        const patch = m.result?.patch;
        if (patch) return diffView({ patch }).el;
        if (m.tool === 'AskUserQuestion') {
      const a = [...String(r.text || '').matchAll(/"[^"]*"="([^"]*)"/g)].map((x) => x[1]);
      return h('span', { class: 'st-tag' }, a.length ? `→ ${clip(a.join(', '), 60)}` : 'answered');
    }
    if (m.tool === 'Write') return clamp(h('pre', { class: 'cl-pre m' }, i.content || ''), lines(i.content), 24);
        if (m.tool === 'MultiEdit') return h('div', {}, (i.edits || []).map((e) => diffView({ oldText: e.old_string, newText: e.new_string }).el));
        return diffView({ oldText: i.old_string, newText: i.new_string }).el;
      }
      case 'Read': return i.offset || i.limit ? h('div', { class: 'dim' }, `lines ${i.offset || 1}–${(i.offset || 1) + (i.limit || 0)}`) : null;
      case 'TodoWrite': return h('div', { class: 'cl-todos' }, (i.todos || []).map((t) => h('div', { class: `todo ${t.status}` }, icon(t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'activity' : 'dot', 's'), h('span', {}, t.content))));
      case 'Task': case 'Agent': return h('div', {},
        onAgent && m.id && !agent ? h('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); onAgent(m.id); } }, icon('layers', 's'), 'Open its transcript') : null,
        i.prompt ? clamp(h('div', { class: 'cl-prose' }, md(i.prompt)), lines(i.prompt), 10) : null);
      default: return i.json && i.json !== '{}' ? clamp(pre(i.json, 'm'), lines(i.json), 16) : null;
    }
  }

  function toolOutput(m) {
    const r = m.result;
    if (!r) return null;
    const full = r.size && r.size > (r.text || '').length;
    const out = h('div', { class: `cl-out${r.error ? ' bad' : ''}` });
    const bar = h('div', { class: 'cl-outbar' },
      h('span', {}, r.error ? 'Error' : 'Output'),
      r.exitCode != null ? h('span', { class: `m ${r.exitCode ? 'err' : 'dim'}` }, `exit ${r.exitCode}`) : null,
      full ? h('button', {
        class: 'btn ghost sm', type: 'button',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const x = await api(dev, `/sessions/${id}/full/${encodeURIComponent(m.id)}${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
            r.text = x.text; r.size = x.text.length;
            m._node?._update?.(true);
          } catch (err) { toast('err', 'Could not load the whole output', err.message); b.disabled = false; }
        },
      }, `Load all ${fmtSize(r.size)}`) : null,
      r.text ? copyBtn(() => r.text, 'Copy output') : null);
    out.append(bar);
    if (r.text?.trim() && !(r.patch && !r.error)) out.append(clamp(pre(r.text, `m${r.error ? ' err' : ''}`), lines(r.text), 20));
    if (r.stderr) out.append(h('div', { class: 'cl-outbar' }, h('span', {}, 'stderr')), clamp(pre(r.stderr, 'm warn'), lines(r.stderr), 10));
    if (r.media?.length) out.append(images(r.media));
    if (!r.text?.trim() && !r.media?.length && !r.patch) out.append(h('div', { class: 'dim' }, '(no output)'));
    return out;
  }

  function toolRow(m) {
    const row = h('div', { class: 'cl-tool' });
    const head = h('button', { class: 'cl-tool-h', type: 'button', 'aria-expanded': 'false' });
    const body = h('div', { class: 'cl-tool-b', hidden: true });
    let built = false;
    const paintHead = () => {
      head.replaceChildren(icon(TOOL_ICON[m.tool] || (m.tool?.startsWith('mcp__') ? 'box' : 'zap'), 's'),
        h('span', { class: 'nm' }, m.tool?.startsWith('mcp__') ? m.tool.split('__').slice(-1)[0] : m.tool),
        h('span', { class: 'what' }, ...toolTarget(m)), toolStatus(m));
      row.classList.toggle('bad', !!(m.result?.error || (m.result?.exitCode ?? 0) !== 0));
      row.classList.toggle('run', !m.result && !m.stale && !!m.id);
    };
    const fill = () => body.replaceChildren(...[toolInput(m), toolOutput(m), ...(m.hooks || []).map(hookRow)].filter(Boolean));
    head.addEventListener('click', () => {
      const open = body.hidden;
      if (open && !built) { built = true; fill(); }
      body.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      row.classList.toggle('open', open);
    });
    paintHead();
    row.append(head, body);
    row._update = (reopen) => { paintHead(); if (built) fill(); if (reopen) { body.hidden = false; row.classList.add('open'); } };
    return row;
  }

  function hookRow(m) {
    return h('div', { class: `cl-hook${m.error ? ' bad' : ''}` }, icon(m.error ? 'warn' : 'zap', 's'),
      h('span', { class: 'm dim' }, m.name ? `hook ${m.name}` : 'hook'), h('span', { class: 'tx' }, ...withPaths(m.text)));
  }

  function render(m) {
    switch (m.role) {
      case 'user': return h('div', { class: 'msg me' }, h('div', { class: 'bub' }, userText(m.text), images(m.media)),
        h('div', { class: 'meta' }, m.midTurn ? h('span', {}, 'sent mid-turn') : null, h('span', { class: 'm' }, time(m.at)), copyBtn(() => m.text, 'Copy message')));
      case 'assistant': return h('div', { class: 'msg as' }, md(m.text),
        h('div', { class: 'meta' }, h('span', { class: 'm' }, time(m.at)), m.model && m.model !== s.model?.current ? h('span', {}, modelLabel(m.model)) : null, copyBtn(() => m.text, 'Copy reply')));
      case 'thinking': {
        // Thinking the transcript did not keep (signed or summarised away)
        // says nothing: no row for it.
        if (!m.text?.trim()) return null;
        const empty = false;
        const b = h('div', { class: 'cl-think-b', hidden: true });
        const t = h('button', { class: 'cl-think', type: 'button', 'aria-expanded': 'false', disabled: empty || null },
          icon('chev', 's'), h('span', {}, empty ? 'Thought' : 'Thinking'), empty ? null : h('span', { class: 'prev' }, clip(m.text, 120)));
        t.addEventListener('click', () => { if (!b.firstChild) b.append(md(m.text)); b.hidden = !b.hidden; t.setAttribute('aria-expanded', String(!b.hidden)); });
        return h('div', { class: 'cl-thinkwrap' }, t, b);
      }
      case 'tool': return toolRow(m);
      case 'result': return h('div', { class: 'cl-tool' }, h('div', { class: 'cl-tool-h' }, icon('log', 's'), h('span', { class: 'nm' }, 'Output'), h('span', { class: 'what m' }, clip(m.text, 140))));
      case 'hook': return hookRow(m);
      case 'command': return h('div', { class: 'cl-slashrow' }, h('span', { class: 'm' }, m.text.startsWith('/') ? m.text : `/${m.text}`), m.args ? h('span', { class: 'dim' }, clip(m.args, 200)) : null);
      case 'command-out': return h('div', { class: 'cl-cmdout' }, clamp(pre(m.text, 'm'), lines(m.text), 16));
      case 'turn': return h('div', { class: 'cl-turn' }, h('span', {}, `Worked for ${dur(m.ms)}`));
      case 'error': return h('div', { class: 'cl-note bad' }, icon('warn', 's'), h('span', {}, h('b', {}, `Request failed (${m.kind})`), ' ', m.text));
      default: return h('div', { class: `cl-note${m.kind === 'warning' ? ' warn' : ''}` }, h('span', {}, m.kind === 'task' ? `Background task: ${unent(m.text)}` : m.kind === 'peer' ? m.text : m.text));
    }
  }

  // Consecutive tool calls share one block; past four, the older ones fold
  // behind "N earlier steps" so a long run of tools reads as one step.
  function node(m) { if (m._node === undefined) m._node = render(m); return m._node; }
  function place(nodes0, where = 'end') {
    const nodes = nodes0.filter(Boolean);
    const frag = document.createDocumentFragment();
    let steps = where === 'end' ? list.lastElementChild?.classList.contains('cl-steps') ? list.lastElementChild : null : null;
    const out = [];
    for (const n of nodes) {
      if (n.classList.contains('cl-tool') || n.classList.contains('cl-thinkwrap')) {
        if (!steps) { steps = stepsBox(); out.push(steps); }
        steps._add(n);
      } else { steps = null; out.push(n); }
    }
    out.forEach((n) => frag.append(n));
    if (where === 'end') list.append(frag); else list.prepend(frag);
  }
  function stepsBox() {
    const inner = h('div', { class: 'cl-steps-in' });
    const more = h('button', { class: 'cl-steps-more', type: 'button', hidden: true });
    const box = h('div', { class: 'cl-steps' }, more, inner);
    let open = false;
    const fold = () => {
      const all = [...inner.children];
      const tools = all.filter((x) => x.classList.contains('cl-tool'));
      const hide = open ? 0 : Math.max(0, all.length - 3);
      all.forEach((x, k) => { x.hidden = k < hide; });
      more.hidden = all.length <= 4 && !open;
      if (all.length <= 4) { all.forEach((x) => { x.hidden = false; }); more.hidden = true; return; }
      const names = {};
      for (const t of tools) { const n = t.querySelector('.nm')?.textContent || 'tool'; names[n] = (names[n] || 0) + 1; }
      more.replaceChildren(icon(open ? 'chevdown' : 'chev', 's'), h('span', {}, open ? 'Fold steps' : `${hide} earlier step${hide === 1 ? '' : 's'}`),
        h('span', { class: 'dim' }, Object.entries(names).map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ''}`).join(' · ')));
    };
    more.addEventListener('click', () => { open = !open; fold(); });
    box._add = (n) => { inner.append(n); fold(); };
    return box;
  }

  function drawTop() {
    swap(top, `${first}:${truncated}:${loading}:${items.length}`, () => (first > 0 || truncated
      ? h('button', { class: 'btn ghost sm cl-earlier', type: 'button', disabled: loading || null, onclick: () => earlier() }, loading ? 'Loading earlier messages…' : 'Earlier messages')
      : items.length ? h('div', { class: 'cl-start' }, 'Start of the conversation') : null));
  }

  function drawAll() {
    first = Math.max(0, items.length - STEP);
    list.replaceChildren();
    place(items.slice(first).map(node));
    if (!items.length) list.append(h('div', { class: 'cl-empty' }, agent ? 'This subagent has written nothing yet.' : 'Nothing said yet. Send the first message below.'));
    drawTop();
  }

  async function earlier() {
    if (first > 0) {
      const from = Math.max(0, first - STEP);
      const hgt = scroll.scrollHeight;
      place(items.slice(from, first).map(node), 'start');
      first = from;
      drawTop();
      scroll.scrollTop += scroll.scrollHeight - hgt;
      return;
    }
    if (!truncated || loading) return;
    loading = true;
    drawTop();
    try {
      const r = await api(dev, `${agent ? `/sessions/${id}/agents/${encodeURIComponent(agent)}/transcript` : `/sessions/${id}/transcript`}?detail=1&before=${start}`);
      const hgt = scroll.scrollHeight;
      const { added } = fold(r.messages || [], 'start');
      settle();
      start = r.start ?? 0;
      truncated = !!r.truncated;
      first = added.length;
      const from = Math.max(0, first - STEP);
      place(items.slice(from, first).map(node), 'start');
      first = from;
      loading = false;
      drawTop();
      scroll.scrollTop += scroll.scrollHeight - hgt;
    } catch (e) {
      toast('err', 'Could not load earlier messages', e.message);
    } finally { loading = false; drawTop(); }
  }

  function reset(msgs, info) {
    items = []; byTool = new Map(); orphans = new Map();
    fold(msgs, 'end');
    settle();
    start = info.start ?? 0;
    truncated = !!info.truncated;
    drawAll();
    requestAnimationFrame(() => toBottom(true));
  }

  function append(msgs) {
    if (!msgs.length) return;
    const stick = follow || nearBottom();
    list.querySelector(':scope > .cl-empty')?.remove();
    const { added, touched } = fold(msgs, 'end');
    for (const t of touched) t._node?._update?.();
    place(added.map(node));
    settle();
    // A long-open tab trims what it draws back to a few pages.
    if (items.length - first > STEP * 4 && stick) {
      const keepFrom = items.length - STEP * 2;
      for (let i = first; i < keepFrom; i++) items[i]._node?.remove();
      list.querySelectorAll('.cl-steps').forEach((b) => { if (!b.querySelector('.cl-steps-in').children.length) b.remove(); });
      first = keepFrom;
      drawTop();
    }
    reconcilePending(added);
    if (stick) toBottom(true); else if (added.some((m) => m.role === 'assistant' || m.role === 'user')) jump.hidden = false;
  }

  /* ── the live channel ─────────────────────────────────────────── */

  let gotHello = false;
  let failures = 0;
  function connect() {
    es?.close();
    clearTimeout(pollTimer);
    if (destroyed || !online(dev)) { paintLive(); return; }
    gotHello = false;
    const url = `${ctx.base}/api/claude/d/${encodeURIComponent(dev)}/sessions/${id}/live${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`;
    es = new EventSource(url);
    const on = (name, fn) => es.addEventListener(name, (e) => { let d = null; try { d = JSON.parse(e.data); } catch { return; } fn(d); });
    on('hello', (d) => {
      gotHello = true;
      failures = 0;
      // A reconnect: carry on from what is already drawn when the snapshot covers it.
      const lastUuid = items.length ? items[items.length - 1].uuid : null;
      const at = lastUuid ? d.messages.findIndex((m) => m.uuid === lastUuid) : -1;
      if (at >= 0 && items.length) append(d.messages.slice(at + 1));
      else reset(d.messages || [], d);
      if (d.screen !== undefined) { screen = d.screen; }
      if (d.session && !agent) { upsert(dev, d.session); s = d.session; }
      paintAll();
    });
    on('messages', (d) => append(d.messages || []));
    on('session', (d) => { if (agent) return; upsert(dev, d); s = d; paintAll(); S.paint('session'); });
    on('screen', (d) => { screen = d; paintAll(); });
    on('reset', () => connect());
    on('removed', () => S.paint('removed'));
    es.onerror = () => {
      if (destroyed) return;
      // EventSource reconnects by itself. A runner without /live (older than
      // this console) never says hello: read the transcript the old way.
      if (!gotHello && ++failures >= 2) { es.close(); es = null; pollOld(); }
    };
  }

  let cursor = null;
  async function pollOld() {
    if (destroyed) return;
    try {
      const base2 = agent ? `/sessions/${id}/agents/${encodeURIComponent(agent)}/transcript` : `/sessions/${id}/transcript`;
      const r = await api(dev, `${base2}?detail=1${cursor == null ? '' : `&cursor=${cursor}`}`);
      if (cursor == null) reset(r.messages || [], r); else append(r.messages || []);
      cursor = r.cursor;
      if (!agent) { const v = await api(dev, `/sessions/${id}`).catch(() => null); if (v) { upsert(dev, v); s = v; } }
      paintAll();
    } catch (e) { if (missingRoute(e)) return; }
    pollTimer = setTimeout(pollOld, document.hidden ? 10_000 : 3000);
  }

  /* ── what Claude is asking: cards from the hooks ─────────────── */

  const answers = new Map(); // question index -> { pick:Set, other }
  async function answer(body, key = 'answer') {
    if (S.busy.has(`${key}:${id}`)) return;
    S.busy.add(`${key}:${id}`);
    paintCard();
    try {
      const v = await post(dev, `/sessions/${id}/answer`, body);
      upsert(dev, v); s = v;
      answers.clear();
    } catch (e) {
      toast('err', 'The answer did not go through', missingRoute(e) ? 'This runner is older than the console. Answer in the terminal.' : e.message);
    } finally { S.busy.delete(`${key}:${id}`); paintAll(); }
  }

  function questionCard(p) {
    const qs = p.questions || [];
    const busy = S.busy.has(`answer:${id}`);
    const one = qs.length === 1 && !qs[0].multiSelect;
    const ready = () => qs.every((q, i) => { const a = answers.get(i); return a && (a.other?.trim() || a.pick?.size); });
    const submit = () => answer({ kind: 'question', answers: qs.map((q, i) => { const a = answers.get(i) || {}; return a.other?.trim() ? { other: a.other.trim() } : { pick: [...(a.pick || [])] }; }) });
    const box = h('section', { class: 'cl-card q', 'aria-label': 'Claude is asking' });
    qs.forEach((q, qi) => {
      const a = answers.get(qi) || { pick: new Set(), other: '' };
      answers.set(qi, a);
      const opts = h('div', { class: 'opts', role: q.multiSelect ? 'group' : 'radiogroup', 'aria-label': q.question });
      q.options.forEach((o, oi) => {
        const on = a.pick.has(oi);
        opts.append(h('button', {
          class: `opt${on ? ' on' : ''}`, type: 'button', disabled: busy || null,
          role: q.multiSelect ? 'checkbox' : 'radio', 'aria-checked': String(on),
          onclick: () => {
            if (q.multiSelect) { if (a.pick.has(oi)) a.pick.delete(oi); else a.pick.add(oi); a.other = ''; paintCard(true); return; }
            a.pick = new Set([oi]); a.other = '';
            if (one) submit(); else paintCard(true);
          },
        }, h('span', { class: 'n m' }, q.multiSelect ? icon(on ? 'check' : 'dot', 's') : String(oi + 1)),
        h('span', { class: 'ol' }, h('span', { class: 'lb' }, o.label), o.description ? h('span', { class: 'ds' }, o.description) : null)));
      });
      const other = h('input', { class: 'input cl-other', placeholder: q.multiSelect ? 'Or say something else…' : 'Something else…', value: a.other || '', disabled: busy || null, enterkeyhint: 'send' });
      other.addEventListener('input', () => { a.other = other.value; if (other.value) a.pick.clear(); box.querySelector('.send')?.toggleAttribute('disabled', !ready()); opts.querySelectorAll('.opt.on').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }); });
      other.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && other.value.trim() && (one || ready())) { e.preventDefault(); submit(); } });
      box.append(h('div', { class: 'qq' }, h('div', { class: 'qh' }, q.header ? h('span', { class: 'tag' }, q.header) : null, h('span', { class: 'qt' }, q.question)), opts, h('div', { class: 'otherrow' }, other)));
    });
    box.append(h('div', { class: 'foot' },
      h('span', { class: 'dim' }, one ? 'Tap an answer to send it' : qs.some((q) => q.multiSelect) ? 'Pick any that apply' : 'Answer each, then send'),
      h('button', { class: `btn pri sm send${one ? ' only-other' : ''}`, type: 'button', disabled: busy || !ready() || null, onclick: submit }, busy ? h('span', { class: 'spin' }) : null, one ? 'Send' : 'Send answers')));
    return box;
  }

  function menuCard(title, sub2, menuData, extra = null) {
    const busy = S.busy.has(`answer:${id}`);
    const opts = menuData?.options?.length
      ? h('div', { class: 'opts' }, menuData.options.map((o) => h('button', { class: `opt${o.selected ? ' cur' : ''}`, type: 'button', disabled: busy || null, onclick: () => answer({ kind: 'menu', n: o.n }) },
        h('span', { class: 'n m' }, String(o.n)), h('span', { class: 'ol' }, h('span', { class: 'lb' }, o.label), o.desc ? h('span', { class: 'ds' }, o.desc) : null))))
      : h('div', { class: 'dim' }, 'Reading the options from the terminal…');
    return h('section', { class: 'cl-card', 'aria-label': title },
      h('div', { class: 'qh' }, h('span', { class: 'qt' }, title)), sub2 || null, extra, opts,
      h('div', { class: 'foot' }, h('span', { class: 'dim' }, 'Esc closes it in the terminal'),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: busy || null, onclick: () => sendKey('Escape') }, 'Esc')));
  }

  function paintCard(force = false) {
    const p = !agent && s.alive ? s.prompt : null;
    const menuData = screen?.menu || null;
    const sig = JSON.stringify([p?.kind, p?.id, p?.at, menuData, S.busy.has(`answer:${id}`)]);
    if (!force && card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    let c = null;
    if (p?.kind === 'question') c = questionCard(p);
    else if (p?.kind === 'plan') {
      const planEl = h('div', { class: 'cl-plan' }, md(p.plan));
      c = menuCard('Approve this plan?', null, menuData, h('div', { class: 'cl-planwrap' }, planEl));
    } else if (p?.kind === 'permission') {
      const i = p.input || {};
      const what = i.command || i.file_path || i.url || (i.json && i.json !== '{}' ? clip(i.json, 400) : null);
      c = menuCard(`Allow ${p.tool || 'this tool'}?`, what ? h('pre', { class: 'cl-pre m' }, what) : (p.text ? h('div', { class: 'dim' }, p.text) : null),
        menuData || { options: [{ n: 1, label: 'Allow' }] });
    } else if (menuData && s.alive) {
      c = menuCard('The terminal is asking', null, menuData);
    }
    card.replaceChildren(...(c ? [c] : []));
    el.classList.toggle('asking', !!c);
  }

  /* ── the line above the box: what it is doing now ────────────── */

  let tick = null;
  function paintLive() {
    clearInterval(tick);
    tick = null;
    const off = !online(dev);
    const a = s.activity;
    let tone = null; let text = null; let sub2 = null; let action = null; let since = null;
    if (agent) { text = 'Reading a subagent'; sub2 = 'read only: messages go to the main session'; action = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => view(null) }, 'Back to main'); }
    else if (off) { text = 'Offline'; sub2 = 'its machine is asleep or away; it carries on when it is back'; }
    else if (s.state === 'starting') { tone = 'ok'; text = 'Starting'; sub2 = s.detail; }
    else if (s.state === 'queued') { text = 'Queued'; sub2 = s.detail || 'waiting for a free slot'; }
    else if (s.state === 'paused') { tone = 'warn'; text = 'Paused'; sub2 = s.detail; action = h('button', { class: 'btn sm', type: 'button', onclick: () => resume() }, 'Resume now'); }
    else if (!s.alive) { text = 'Not running'; sub2 = 'a message resumes it'; }
    else if (s.state === 'running') {
      tone = 'ok';
      if (a) { text = a.tool; sub2 = clip(a.text?.replace(new RegExp(`^${a.tool}: ?`), ''), 120); since = a.at; } else { text = s.background && !s.lastPromptAt ? 'Background work' : 'Thinking'; since = s.lastPromptAt; }
      action = h('button', { class: 'btn ghost sm', type: 'button', title: 'Stop this turn (Esc)', onclick: () => interrupt() }, icon('pause', 's'), 'Stop');
    } else if (s.state === 'error') { tone = 'err'; text = 'Error'; sub2 = s.detail || s.lastError?.text; }
    else if (s.state === 'blocked') { tone = 'warn'; text = 'Blocked'; sub2 = s.detail; }
    const bg = s.background ? (s.background.subagents || 0) + (s.background.shells || 0) : 0;
    const bgChip = bg && onOpenAgents ? h('button', { class: 'chip sm cl-bgchip', type: 'button', onclick: () => onOpenAgents() }, h('span', { class: 'dot live', style: '--c:var(--ok)' }), `${bg} in background`) : null;
    const sig = JSON.stringify([tone, text, sub2, since, bg, !!action, agent]);
    if (live.dataset.sig !== sig) {
      live.dataset.sig = sig;
      live.replaceChildren(...(text || bgChip ? [
        text ? h('span', { class: 'dot live', style: `--c:${tone ? `var(--${tone})` : 'var(--fg-3)'}` }) : null,
        text ? h('span', { class: 'lt' }, text) : null,
        sub2 ? h('span', { class: 'ls' }, sub2) : null,
        since ? h('span', { class: 'm dim el' }) : null,
        h('span', { class: 'grow' }), bgChip, action,
      ].filter(Boolean) : []));
      live.hidden = !text && !bgChip;
    }
    const elx = live.querySelector('.el');
    if (elx && since) {
      const upd = () => { elx.textContent = dur(Date.now() - (typeof since === 'number' ? since : Date.parse(since))); };
      upd();
      tick = setInterval(upd, 1000);
    }
  }

  /* ── the box ──────────────────────────────────────────────────── */

  const ghost = () => (!agent && s.alive && screen?.suggestion && sugGone !== screen.suggestion ? screen.suggestion : null);
  function paintBox() {
    const off = !online(dev);
    const g = !input.value ? ghost() : null;
    const ph = agent ? 'Message the main session' : s.state === 'waiting' ? 'Answer Claude…' : !s.alive ? 'Message to resume it…' : s.state === 'running' ? 'Queue a message…' : `Message ${s.title || 'Claude'}…`;
    input.placeholder = g || ph;
    compose.classList.toggle('ghost', !!g);
    input.disabled = off;
    sendBtn.disabled = off || sending || s.state === 'starting';
    sendBtn.setAttribute('aria-label', s.alive ? 'Send' : 'Resume with this message');
    const mode = String(screen?.mode || '').toLowerCase();
    const modeLabel = !s.alive || !screen ? null : !mode ? 'Ask first' : mode.includes('bypass') ? 'Bypass' : mode.includes('accept') ? 'Auto-edit' : mode.includes('plan') ? 'Plan' : mode;
    swap(hint, JSON.stringify([modeLabel, g, screen?.draft, keys, fine()]), () => [
      modeLabel ? h('button', { class: 'chip cl-mode', type: 'button', title: `Permission mode: ${screen?.mode || 'default'}. Tap to cycle (Shift+Tab).`, onpointerdown: keep, onclick: () => sendKey('BTab') }, icon('shield', 's'), modeLabel) : null,
      screen?.draft ? h('span', { class: 'cl-draft' }, icon('warn', 's'), h('span', {}, 'Typed in the terminal, not sent: ', h('span', { class: 'm' }, clip(screen.draft, 48))),
        h('button', { class: 'btn ghost sm', type: 'button', onpointerdown: keep, onclick: () => sendKey('Enter') }, 'Send it')) : null,
      h('span', { class: 'grow' }),
      g ? h('span', { class: 'dim' }, touch() ? 'Suggested · Send sends it' : 'Suggested · Tab to edit · Enter to send') : fine() ? h('span', { class: 'dim kbd-hint' }, h('kbd', {}, '⏎'), ' send ', h('kbd', {}, '⇧⏎'), ' new line ', h('kbd', {}, '/'), ' commands') : null,
    ]);
  }

  function grow() {
    const vh = window.visualViewport?.height || innerHeight;
    const cap = Math.max(44, Math.min(touch() ? 140 : 240, Math.round(vh * (touch() ? 0.22 : 0.3))));
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, cap)}px`;
  }

  // Slash commands: the runner's full list (commands, skills), else the short one.
  let matches = [];
  let pick = 0;
  function commands() {
    const c = cmdCache.get(id);
    if (Array.isArray(c)) return c;
    if (!c && online(dev)) {
      cmdCache.set(id, 'loading');
      api(dev, `/sessions/${id}/commands`).then((r) => { cmdCache.set(id, r?.commands?.length ? r.commands : SLASH); if (!slash.hidden) drawSlash(); }).catch(() => cmdCache.set(id, SLASH));
    }
    return SLASH;
  }
  const closeSlash = () => { slash.hidden = true; matches = []; input.removeAttribute('aria-activedescendant'); };
  function drawSlash() {
    const m = /^\/(\S*)$/.exec(input.value);
    if (!m) { closeSlash(); return; }
    const q = m[1].toLowerCase();
    const all = commands();
    const starts = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
    const inside = q ? all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q)) : [];
    matches = [...starts, ...inside].slice(0, 60);
    if (!matches.length) { closeSlash(); return; }
    pick = Math.min(pick, matches.length - 1);
    slash.replaceChildren(...matches.map((c, i) => h('button', {
      class: `cl-slash-it${i === pick ? ' cur' : ''}`, type: 'button', role: 'option', id: `cl-sl-${i}`, 'aria-selected': String(i === pick),
      onpointerdown: keep, onclick: () => useSlash(i, true),
    }, h('span', { class: 'm' }, c.name), h('span', { class: 'ds' }, c.desc || ''), c.source && c.source !== 'Claude Code' ? h('span', { class: 'tag' }, c.source) : null)));
    slash.hidden = false;
    input.setAttribute('aria-activedescendant', `cl-sl-${pick}`);
    slash.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
  function useSlash(i, now) {
    const c = matches[i];
    if (!c) return;
    closeSlash();
    if (c.args || !now) { input.value = `${c.name} `; grow(); input.focus(); return; }
    input.value = c.name;
    send();
  }

  let hist = -1;
  input.addEventListener('input', () => {
    pick = 0; hist = -1; grow(); drawSlash();
    if (input.value) { const g = ghost(); if (g) sugGone = g; }
    paintBox();
  });
  input.addEventListener('blur', () => setTimeout(closeSlash, 120));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the console's shortcuts stay out of the box
    if (!slash.hidden && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; drawSlash(); return; }
      if (e.key === 'Tab') { e.preventDefault(); useSlash(pick, false); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch()) { e.preventDefault(); useSlash(pick, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    const g = !input.value ? ghost() : null;
    if (e.key === 'Tab' && !e.shiftKey && g) { e.preventDefault(); input.value = g; sugGone = g; grow(); paintBox(); return; }
    if (e.key === 'Enter' && !e.isComposing && ((e.ctrlKey || e.metaKey) || (!e.shiftKey && !e.altKey && !touch()))) { e.preventDefault(); send(); return; }
    // Up in an empty box with a message queued: it comes back here to edit, out of the queue.
    if (e.key === 'ArrowUp' && !input.value && !e.shiftKey && queue().length) { e.preventDefault(); takeQueued(queue()[queue().length - 1].id, true); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sent.length && !e.shiftKey && (!input.value || (hist >= 0 && input.value === sent[sent.length - 1 - hist]))) {
      e.preventDefault();
      hist = Math.max(-1, Math.min(sent.length - 1, hist + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = hist < 0 ? '' : sent[sent.length - 1 - hist];
      grow(); paintBox();
      return;
    }
    if (e.key === 'Escape' && !input.value && s.alive) { e.preventDefault(); sendKey('Escape'); }
  });
  const filesOf = (dt) => [...(dt?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  input.addEventListener('paste', (e) => { const f = filesOf(e.clipboardData); if (f.length) { e.preventDefault(); addFiles(f); } });
  el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => { el.classList.remove('drop'); const f = [...(e.dataTransfer?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });

  function addFiles(files) {
    for (const file of [...(files || [])].filter(Boolean)) {
      const image = IMAGE_MIME.includes(file.type);
      const max = image ? 20 : 100;
      if (file.size > max * 1048576) { toast('err', `${file.name || 'That file'} is too large`, `The limit is ${max} MB.`); continue; }
      attach.push({ id: Math.random().toString(36).slice(2), file, image, url: image ? URL.createObjectURL(file) : null });
    }
    paintTray();
    input.focus();
  }
  function paintTray() {
    tray.replaceChildren(...attach.map((a) => h('div', { class: `cl-att${a.image ? ' img' : ''}`, title: `${a.file.name || 'pasted'} · ${fmtSize(a.file.size)}` },
      a.image ? h('img', { src: a.url, alt: a.file.name || 'Pasted image' }) : h('span', { class: 'f' }, icon('file', 's'), h('span', { class: 'nm' }, a.file.name || 'file'), h('span', { class: 'm dim' }, fmtSize(a.file.size))),
      h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${a.file.name || 'attachment'}`, onpointerdown: keep, onclick: () => { const i = attach.indexOf(a); if (a.url) URL.revokeObjectURL(a.url); attach.splice(i, 1); paintTray(); } }, icon('x', 's')))));
    tray.hidden = !attach.length;
  }
  async function upload() {
    for (const a of attach.slice()) {
      await ctx.api(`/claude/d/${encodeURIComponent(dev)}/sessions/${id}/${a.image ? 'image' : 'file'}`, {
        method: 'POST',
        headers: { 'content-type': a.file.type || 'application/octet-stream', ...(a.image ? {} : { 'x-file-name': encodeURIComponent(a.file.name || '') }) },
        body: a.file,
      });
    }
  }

  /* ── sending: drawn at once, made real by the transcript ──────── */

  const queue = () => (s.outbox || []).filter((m) => !takenIds.has(m.id));
  const takenIds = new Set();

  async function send(override = null) {
    let text = override ?? input.value.trim();
    const files = override == null ? attach.length : 0;
    if (!text && !files && override == null) { text = ghost(); if (text) sugGone = text; }
    if ((!text && !files) || sending) return;
    if (files && !s.alive) { toast('err', 'Resume the session first', 'Files attach to a running session.'); return; }
    if (text) { if (sent[sent.length - 1] !== text) sent.push(text); if (sent.length > 50) sent.shift(); }
    // Keyboard input for Claude Code itself (a slash command, a "!" shell line,
    // a "#" memory line) is typed as it is, never resumes or switches model.
    const raw = text && /^[/!#]/.test(text) && s.alive;
    const midTurn = s.alive && ['running', 'starting'].includes(s.state);
    const p = text && !raw ? { text, at: Date.now(), state: 'sending', midTurn } : null;
    if (p) { pending.push(p); paintPending(); follow = true; toBottom(true); }
    if (override == null) { input.value = ''; input.style.height = ''; closeSlash(); }
    sending = true;
    paintBox();
    try {
      if (files) await upload();
      let v;
      if (raw || files) v = await post(dev, `/sessions/${id}/keys`, text ? { text, enter: true } : { keys: ['Enter'] });
      else v = await post(dev, `/sessions/${id}/message`, { text });
      if (files) { for (const a of attach) if (a.url) URL.revokeObjectURL(a.url); attach.length = 0; paintTray(); }
      if (v?.id) { upsert(dev, v); s = v; }
      if (p) { p.state = (s.outbox || []).some((m) => m.text === text) ? 'queued' : 'sent'; }
      kickScreen();
    } catch (e) {
      const typed = /typed .*not sent/i.test(e.message);
      if (p) { p.state = 'failed'; p.error = typed ? 'Typed into the terminal, but not sent' : e.message; }
      else { input.value = text || ''; grow(); }
      toast('err', typed ? 'Typed but not sent' : 'Not sent', typed ? 'It is in the terminal\'s box: press Send it below, or Enter in the terminal.' : e.message);
    } finally {
      sending = false;
      paintAll();
      S.paint('session');
    }
  }

  /** A message shows up in the conversation (or the queue): its stand-in goes. */
  function reconcilePending(added) {
    let changed = false;
    for (const m of added) {
      if (m.role !== 'user') continue;
      // Attachments arrive as "[Image #1] words": the words are the message.
      const got = norm(m.text);
      const i = pending.findIndex((p) => p.state !== 'failed' && (got === norm(p.text) || got.endsWith(norm(p.text))));
      if (i >= 0) { pending.splice(i, 1); changed = true; }
    }
    // Stand-ins that never showed up within a minute and are not queued: drop.
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.state === 'sent' && Date.now() - p.at > 60_000) { pending.splice(i, 1); changed = true; }
    }
    if (changed) paintPending();
  }

  async function takeQueued(qid, toBox = false) {
    takenIds.add(qid);
    paintPending();
    try {
      const r = await post(dev, `/sessions/${id}/outbox/take`, { id: qid });
      if (r.session) { upsert(dev, r.session); s = r.session; }
      if (toBox) { const t = r.message?.text || ''; input.value = input.value ? `${t}\n${input.value}` : t; grow(); input.focus(); }
      for (let i = pending.length - 1; i >= 0; i--) if (norm(pending[i].text) === norm(r.message?.text)) pending.splice(i, 1);
    } catch (e) {
      takenIds.delete(qid);
      toast('err', 'Already sent', /nothing waiting/i.test(e.message) ? 'It went in before it could be taken back.' : e.message);
    }
    setTimeout(() => takenIds.delete(qid), 30_000);
    paintAll();
  }
  async function sendQueueNow(qid) {
    try { const v = await post(dev, `/sessions/${id}/outbox/send`, { id: qid }); upsert(dev, v); s = v; } catch (e) { toast('err', 'Nothing to send', e.message); }
    paintAll();
  }

  function paintPending() {
    const q = queue();
    const shownQ = new Set(q.map((m) => norm(m.text)));
    const rows = [
      // The queue, as Claude Code (and so the transcript) holds it.
      ...q.map((m) => h('div', { class: 'msg me queued' }, h('div', { class: 'bub' }, userText(m.text)),
        h('div', { class: 'meta show' }, h('span', { class: 'qtag' }, icon('clock', 's'), 'Queued · goes in at the next step'),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => sendQueueNow(m.id) }, q.length > 1 ? 'Send all now' : 'Send now'),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => takeQueued(m.id, true) }, 'Edit'),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => takeQueued(m.id) }, 'Remove')))),
      // What is on its way: drawn at once, gone when it arrives.
      ...pending.filter((p) => p.state === 'failed' || !shownQ.has(norm(p.text))).map((p) => h('div', { class: `msg me pending ${p.state}` }, h('div', { class: 'bub' }, userText(p.text)),
        h('div', { class: 'meta show' }, p.state === 'failed'
          ? [h('span', { class: 'err' }, icon('warn', 's'), p.error || 'Not sent'),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pending.splice(pending.indexOf(p), 1); send(p.text); } }, 'Send again'),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pending.splice(pending.indexOf(p), 1); input.value = p.text; grow(); input.focus(); paintPending(); } }, 'Edit')]
          : h('span', { class: 'dim' }, p.state === 'sending' ? 'Sending…' : p.midTurn ? 'Sent · Claude reads it at its next step' : 'Sent'))))];
    const stick = follow || nearBottom();
    pend.replaceChildren(...rows);
    if (stick) toBottom(true);
  }

  /* ── keys, stop, resume ───────────────────────────────────────── */

  let screenKick = 0;
  const kickScreen = () => { screenKick = Date.now(); };
  async function sendKey(key) {
    if (!s.alive) { toast('err', 'Not running', 'Resume the session first.'); return; }
    try { await post(dev, `/sessions/${id}/keys`, { keys: [key] }); kickScreen(); } catch (e) {
      if (missingRoute(e) && key === 'Escape') { await interrupt(); return; }
      toast('err', 'The key did not go through', e.message);
    }
  }
  async function interrupt() { try { await post(dev, `/sessions/${id}/interrupt`); } catch (e) { toast('err', 'Could not stop it', e.message); } }
  async function resume() {
    try { const v = await post(dev, `/sessions/${id}/resume`, {}); upsert(dev, v); s = v; paintAll(); S.paint('session'); } catch (e) { toast('err', 'Could not resume', e.message); }
  }

  /* ── subagents ────────────────────────────────────────────────── */

  let agentsList = [];
  async function loadAgents() {
    if (!online(dev)) return;
    try { const r = await api(dev, `/sessions/${id}/agents?limit=60`); agentsList = r.agents || []; } catch { agentsList = []; }
    paintAgentBar();
  }
  function paintAgentBar() {
    const running = agentsList.filter((a) => a.running);
    const cur = agent ? agentsList.find((a) => a.id === agent) || { id: agent, description: agent } : null;
    agentBar.hidden = !running.length && !cur;
    swap(agentBar, JSON.stringify([agent, running.map((a) => a.id), cur?.running]), () => [
      cur ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => view(null) }, icon('back', 's'), 'Main session') : h('span', { class: 'lt' }, icon('layers', 's'), 'Main session'),
      cur ? h('span', { class: 'cur' }, h('span', { class: `dot${cur.running ? ' live' : ''}`, style: `--c:var(--${cur.running ? 'ok' : 'fg-3'})` }), clip(cur.description || cur.type || cur.id, 60)) : null,
      h('span', { class: 'grow' }),
      running.length && !cur ? h('button', { class: 'chip', type: 'button', onclick: () => onOpenAgents?.() }, h('span', { class: 'dot live', style: '--c:var(--ok)' }), `${running.length} subagent${running.length === 1 ? '' : 's'} running`) : null,
    ]);
  }
  function view(agentId) {
    agent = agentId;
    items = []; byTool = new Map(); orphans = new Map(); cursor = null;
    list.replaceChildren();
    pend.replaceChildren();
    el.classList.toggle('agent', !!agent);
    paintAgentBar();
    connect();
    paintAll();
  }

  /* ── keys row under the chat (phones, or asked for) ───────────── */

  function setKeys(on) {
    keys = on;
    keysHost.replaceChildren(...(on ? [keyRow((k) => sendKey(k[2]))] : []));
  }

  function paintAll() {
    if (destroyed) return;
    paintCard();
    paintLive();
    paintBox();
    if (!agent) paintPending();
  }

  /* ── start ────────────────────────────────────────────────────── */

  grow();
  setKeys(keys);
  connect();
  loadAgents();
  paintAll();
  const agentTimer = setInterval(() => { if (!document.hidden && s.alive && (s.background?.subagents || agentsList.some((a) => a.running))) loadAgents(); }, 10_000);

  return {
    el,
    input,
    update(next) {
      if (!next || next.id !== id) return;
      const wasAlive = s.alive;
      s = next;
      if (!agent) paintAll();
      if (!wasAlive && s.alive && !es && !pollTimer) connect();
      if ((s.background?.subagents || 0) !== (agentsList.filter((a) => a.running).length)) loadAgents();
    },
    focus() { if (fine()) input.focus({ preventScroll: true }); },
    setKeys,
    send: (t) => send(t),
    agents: () => agentsList,
    viewAgent: (a) => view(a),
    openAgentFor(toolUseId) { const a = agentsList.find((x) => x.toolUseId === toolUseId); if (a) view(a.id); else loadAgents().then(() => { const b = agentsList.find((x) => x.toolUseId === toolUseId); if (b) view(b.id); else toast('err', 'No transcript for that agent', 'Claude Code did not keep one.'); }); },
    reveal(toolId) {
      const m = items.find((x) => x.role === 'tool' && x.id === toolId);
      const n = m?._node;
      if (!n?.isConnected) return false;
      n.closest('.cl-steps')?.querySelectorAll('.cl-steps-in > *').forEach((x) => { x.hidden = false; });
      n.scrollIntoView({ block: 'center' });
      n.classList.add('flash');
      setTimeout(() => n.classList.remove('flash'), 1600);
      return true;
    },
    /** Subagents, background commands and schedules, read from the record. */
    backgroundWork() {
      const ms = (v) => (typeof v === 'number' ? v : Date.parse(v) || null);
      const notes = items.filter((m) => m.role === 'note' && (m.kind === 'task' || m.kind === 'schedule'));
      const used = new Set();
      const out = [];
      for (const m of items) {
        if (m.role !== 'tool') continue;
        const i = m.input || {};
        let kind = null;
        if (m.tool === 'Agent' || m.tool === 'Task') kind = 'agent';
        else if (m.tool === 'Bash' && i.background) kind = 'shell';
        else if (/^monitor$/i.test(m.tool)) kind = 'monitor';
        else if (/schedule|wakeup|cron|loop/i.test(m.tool) && !/delete|list|stop/i.test(m.tool)) kind = 'schedule';
        if (!kind) continue;
        const name = kind === 'agent' ? [i.subagent_type, i.description].filter(Boolean).join(': ') || 'Subagent' : kind === 'shell' ? (i.description || String(i.command || '').split('\n')[0].slice(0, 90)) : clip(m.text || m.tool, 90);
        const end = notes.find((n) => !used.has(n) && n.kind === 'task' && n.toolUseId === m.id);
        if (end) used.add(end);
        const bg = kind !== 'agent' || i.background;
        let status;
        if (end) status = /fail|error|killed|cancel/i.test(end.status || '') ? 'failed' : 'done';
        else if (m.result?.error) status = 'failed';
        else if (kind === 'schedule') status = m.result ? 'scheduled' : 'running';
        else if (!bg && m.result) status = 'done';
        else if (m.stale && !bg) status = 'no result';
        else status = 'running';
        const a = kind === 'agent' ? agentsList.find((x) => x.toolUseId === m.id) : null;
        if (a?.running) status = 'running';
        out.push({ id: m.id, kind, name, status, agentId: a?.id || null, started: ms(m.at), ended: end ? ms(end.at) : (!bg && m.result ? ms(m.result.at) : null), outputFile: end?.outputFile || null, summary: end ? unent(end.text) : null });
      }
      return out;
    },
    destroy() {
      destroyed = true;
      es?.close();
      clearTimeout(pollTimer);
      clearInterval(tick);
      clearInterval(agentTimer);
      io.disconnect();
      ro.disconnect();
      for (const a of attach) if (a.url) URL.revokeObjectURL(a.url);
    },
  };
}

export { pref };
