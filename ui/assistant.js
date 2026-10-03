/* ============================================================
   ojee-agent — the Assistant view.

   OpenCode, hosted on HP as `opencode serve`, with the console's
   own tools wired in (fleet, AC, services, shells on loq and
   disinteg). Three places, one row of tabs — the Claude view's
   shape, because it is the same kind of thing:

     Sessions   what is working, what needs you, and every
                conversation — searchable, by folder, by day
     New        a folder on HP, a first message, a model, a mode
     Settings   default and fallback models, which tools ask
                first or are off, the quick chat's folder, pings
     <id>       one conversation: streamed as it is written,
                tool calls as rows that open, approvals inline,
                and a composer that picks model and mode

   Routes live under the view: #/agent/assistant/<rest>, where rest
   is '', 'new', 'settings' or a session id (ses_…). The console
   reads the first two segments only, so a deep link from a ping
   lands on the conversation.

   The quick chat on the console's overview is assistant-quick.js;
   both draw from assistant-core.js, so a reply started in one is
   the same reply, live, in the other.
   ============================================================ */

import {
  el, pref, svg, mark, problem, toast, relTime, dur, kfmt, shortPath,
  S, on, connect, disconnect, loadState, loadConfig, loadConv,
  STATE, liveState, busy, dot, stateTag, sessionsSorted, titleOf, untitled,
  models, modelName, sessionModel, defaultModel,
  createSession, sendMessage, abort, rename, remove, saveSettings, api,
  transcript, composer, modelMenu,
} from './assistant-core.js';

export { mountAssistantModal } from './assistant-quick.js';

let ctx = null;
let root = null;
let off = null;
let T = null;          // the open transcript
let C = null;          // the open composer
let vpOff = null;

const V = {
  tab: 'sessions',      // sessions | new | settings
  detail: null,         // a session id
  q: '',
  dir: pref('ag-as-dirf') || 'all',
  limit: 60,
  fs: null,
  hidden: false,
  form: null,           // New: { dir, text, title, model, agent }
  busy: new Set(),
};

/* ── routing ────────────────────────────────────────────────────────── */

function sub() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const i = parts.indexOf('assistant');
  return i >= 0 ? parts.slice(i + 1).filter(Boolean).map(decodeURIComponent) : [];
}

export function go(...segs) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const i = parts.indexOf('assistant');
  const prefix = i >= 0 ? parts.slice(0, i + 1) : [parts[0] || 'agent', 'assistant'];
  const next = `#/${[...prefix, ...segs.map(encodeURIComponent)].join('/')}`;
  if (location.hash !== next) location.hash = next;
  else routeAssistant();
}

export function routeAssistant() {
  const [first] = sub();
  const prev = V.detail;
  const prevTab = V.tab;
  if (first && /^ses_/.test(first)) V.detail = first;
  else { V.detail = null; V.tab = ['new', 'settings'].includes(first) ? first : 'sessions'; }
  if (prev !== V.detail || prevTab !== V.tab) { closeDetail(); window.scrollTo(0, 0); }
  paint();
}

/* ── shell ──────────────────────────────────────────────────────────── */

const TABS = [['sessions', 'Sessions'], ['new', 'New'], ['settings', 'Settings']];

function tabs() {
  const active = V.detail ? 'sessions' : V.tab;
  return el('div', { class: 'segctl ag-as-tabs', role: 'group', 'aria-label': 'Assistant' },
    TABS.map(([id, label]) => el('button', {
      type: 'button', 'aria-pressed': String(active === id),
      onclick: () => (id === 'sessions' ? go() : go(id)),
    }, label)));
}

async function act(key, fn, ok) {
  if (V.busy.has(key)) return null;
  V.busy.add(key);
  try {
    const r = await fn();
    if (ok) toast('ok', ok);
    return r;
  } catch (e) {
    toast('err', 'That did not work', e.message);
    return null;
  } finally {
    V.busy.delete(key);
  }
}

function notConfigured() {
  return el('section', { class: 'stack-lg ag-as-page' }, tabs(), el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Assistant'),
    S.cfgError
      ? problem('The Assistant did not answer', S.cfgError, el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { S.cfgError = null; paint(); await loadConfig(); loadState(); } }, 'Try again'))
      : problem('No OpenCode server is configured', 'Set OPENCODE_URL for this module — the address of `opencode serve` (on HP: ojee-opencode.service).')));
}

function paint(reason) {
  if (!root) return;
  if (S.cfgError && !S.cfg) return root.replaceChildren(notConfigured());
  if (S.cfg && !S.cfg.configured) return root.replaceChildren(notConfigured());
  if (V.detail) return paintDetail(reason);
  if (V.tab === 'new') { if (reason) return; return paintNew(); }
  if (V.tab === 'settings') { if (reason && reason !== 'config') return; return paintSettings(); }
  return paintSessions();
}

/* ── sessions ───────────────────────────────────────────────────────── */

function upLine() {
  if (S.online === false) {
    return el('div', { class: 'alert alert--warn' }, el('b', {}, 'Offline'),
      el('span', {}, `OpenCode on HP is not answering${S.upError ? ` (${S.upError})` : ''}. It runs as ojee-opencode.service; conversations are kept on disk and come back with it.`));
  }
  return null;
}

function rowSub(s) {
  const m = sessionModel(s);
  const tok = (s.tokens?.output || 0) + (s.tokens?.reasoning || 0);
  return [shortPath(s.directory), m ? modelName(m) : null, s.agent === 'plan' ? 'plan' : null,
    tok ? `${kfmt(tok)} out` : null, s.cost ? `$${s.cost.toFixed(s.cost < 0.01 ? 4 : 2)}` : null,
    s.metadata?.source === 'quick' ? 'quick chat' : null].filter(Boolean).join(' · ');
}

function sessionRow(s) {
  const st = liveState(s.id);
  return el('button', { class: `ag-as-row${st === 'error' ? ' is-bad' : ''}`, type: 'button', onclick: () => go(s.id) },
    dot(st),
    el('span', { class: 'ag-as-row-main' },
      el('span', { class: `ag-as-row-title${untitled(s) ? ' is-untitled' : ''}` }, titleOf(s)),
      el('span', { class: 'ag-as-row-sub' }, rowSub(s))),
    st !== 'idle' ? stateTag(st) : el('span'),
    el('span', { class: 'meta ag-as-row-when' }, relTime(s.time?.updated)));
}

function dayOf(ms) {
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= today.getTime()) return 'Today';
  if (t >= today.getTime() - 86400000) return 'Yesterday';
  if (t >= today.getTime() - 6 * 86400000) return 'This week';
  if (t >= today.getTime() - 30 * 86400000) return 'This month';
  return 'Older';
}

function paintSessions() {
  const all = sessionsSorted();
  const states = all.map((s) => [s, liveState(s.id)]);
  const needs = states.filter(([, st]) => st === 'waiting').map(([s]) => s);
  const working = states.filter(([, st]) => st === 'working' || st === 'retrying').map(([s]) => s);
  const failed = states.filter(([, st]) => st === 'error').map(([s]) => s);

  const dirs = [];
  for (const s of all) if (s.directory && !dirs.includes(s.directory)) dirs.push(s.directory);
  if (V.dir !== 'all' && !dirs.includes(V.dir)) V.dir = 'all';
  const q = V.q.trim().toLowerCase();
  const list = all.filter((s) => (V.dir === 'all' || s.directory === V.dir)
    && (!q || `${titleOf(s)} ${s.directory} ${sessionModel(s) || ''}`.toLowerCase().includes(q)));

  const head = needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you`
    : working.length ? `${working.length} working` : S.listed ? (all.length ? 'All quiet' : 'No conversations yet') : 'Loading';
  const verdict = el('div', { class: 'ag-verdict ag-as-verdict' },
    dot(needs.length ? 'waiting' : working.length ? 'working' : failed.length ? 'error' : 'idle'),
    el('strong', {}, head),
    el('span', { class: 'meta' }, [
      needs.length && working.length ? `${working.length} working` : null,
      failed.length ? `${failed.length} failed` : null,
      S.cfg ? `default ${modelName(defaultModel())}` : null,
      S.cfg?.version ? `OpenCode ${S.cfg.version}` : null,
    ].filter(Boolean).join(' · ')),
    el('button', { class: 'btn btn--sm ag-as-verdict-new', type: 'button', onclick: () => go('new') }, svg('plus'), 'New conversation'));

  const page = el('section', { class: 'stack-lg ag-as-page' }, tabs(), verdict, upLine());

  if (needs.length) {
    page.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Needs you'),
      el('div', { class: 'ag-as-list' }, needs.map((s) => {
        const p = [...S.perms.values()].find((x) => x.sessionID === s.id);
        const qq = [...S.questions.values()].find((x) => x.sessionID === s.id);
        const what = p ? `Wants to use ${p.permission}${p.patterns?.[0] && p.patterns[0] !== '*' ? `: ${p.patterns[0]}` : ''}` : qq?.questions?.[0]?.question || '';
        return el('button', { class: 'ag-as-row ag-as-need', type: 'button', onclick: () => go(s.id) },
          dot('waiting'),
          el('span', { class: 'ag-as-row-main' }, el('span', { class: 'ag-as-row-title' }, titleOf(s)), el('span', { class: 'ag-as-need-q' }, what)),
          stateTag('waiting'));
      }))));
  }

  const search = el('input', {
    class: 'input ag-as-search', type: 'search', placeholder: 'Search conversations', value: V.q, 'aria-label': 'Search conversations',
    oninput: (e) => { V.q = e.target.value; V.limit = 60; const pos = e.target.selectionStart; paint(); const n = root.querySelector('.ag-as-search'); n?.focus(); n?.setSelectionRange(pos, pos); },
  });
  const dirChips = dirs.length > 1 ? el('div', { class: 'ag-as-dirs', role: 'group', 'aria-label': 'Folder' },
    [['all', 'All folders'], ...dirs.slice(0, 8).map((d) => [d, shortPath(d)])].map(([id, label]) => el('button', {
      class: 'ag-as-chip ag-as-chip--btn', type: 'button', 'aria-pressed': String(V.dir === id), title: id === 'all' ? null : id,
      onclick: () => { V.dir = id; pref('ag-as-dirf', id); paint(); },
    }, label))) : null;

  const panel = el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Conversations'),
      el('span', { class: 'meta' }, S.listed ? `${list.length}${list.length !== all.length ? ` of ${all.length}` : ''}` : '')),
    el('div', { class: 'ag-as-filterbar' }, search, dirChips));

  if (!S.listed && !S.listError) {
    panel.append(el('span', { class: 'skeleton', style: 'height:220px;display:block' }));
  } else if (S.listError && !all.length) {
    panel.append(problem('Could not list conversations', S.listError, el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => loadState() }, 'Try again')));
  } else if (!all.length) {
    panel.append(el('div', { class: 'empty' }, mark('ic ic--xl'), el('b', {}, 'No conversations yet'),
      el('p', {}, 'Ask about the fleet, the AC, a service, or a folder on HP. It can read, run and change things — and asks before anything that changes something.'),
      el('button', { class: 'btn btn--sm', type: 'button', onclick: () => go('new') }, 'Start one')));
  } else if (!list.length) {
    panel.append(el('p', { class: 'meta' }, q ? `Nothing matches “${V.q}”.` : 'No conversations in this folder.'));
  } else {
    const groups = el('div', { class: 'ag-as-groups' });
    let g = null; let box = null;
    for (const s of list.slice(0, V.limit)) {
      const d = dayOf(s.time?.updated || 0);
      if (d !== g) { g = d; box = el('div', { class: 'ag-as-list' }); groups.append(el('div', { class: 'ag-as-day' }, d), box); }
      box.append(sessionRow(s));
    }
    panel.append(groups);
    if (list.length > V.limit) {
      panel.append(el('button', { class: 'btn btn--ghost btn--sm ag-as-more', type: 'button', onclick: () => { V.limit += 100; paint(); } }, `${list.length - V.limit} more`));
    }
  }
  page.append(panel);
  root.replaceChildren(page);
}

/* ── one conversation ───────────────────────────────────────────────── */

function closeDetail() {
  T?.destroy(); T = null;
  C?.destroy(); C = null;
  vpOff?.(); vpOff = null;
  document.documentElement.style.overflow = '';
}

function headChips(s) {
  const st = liveState(s.id);
  const m = sessionModel(s);
  const tok = (s.tokens?.input || 0) + (s.tokens?.output || 0) + (s.tokens?.reasoning || 0) + (s.tokens?.cache?.read || 0);
  return [
    stateTag(st),
    m ? el('span', { class: 'ag-as-chip', title: m }, modelName(m)) : null,
    s.agent ? el('span', { class: 'ag-as-chip' }, s.agent) : null,
    el('button', { class: 'ag-as-chip ag-as-chip--btn ag-as-chip--path', type: 'button', title: `${s.directory} — copy`, onclick: () => navigator.clipboard?.writeText(s.directory).then(() => toast('ok', 'Folder copied')) }, svg('folder'), shortPath(s.directory)),
    tok ? el('span', { class: 'ag-as-chip', title: `${tok.toLocaleString()} tokens in total` }, `${kfmt(tok)} tokens`) : null,
    s.cost ? el('span', { class: 'ag-as-chip' }, `$${s.cost.toFixed(s.cost < 0.01 ? 4 : 2)}`) : null,
  ];
}

function detailHead(s) {
  const b = busy(s.id);
  return el('header', { class: 'ag-as-head' },
    el('button', { class: 'iconbtn', type: 'button', title: 'All conversations', 'aria-label': 'All conversations', onclick: () => go() }, svg('back')),
    el('div', { class: 'ag-as-head-main' },
      el('button', { class: `ag-as-title${untitled(s) ? ' is-untitled' : ''}`, type: 'button', title: 'Rename', onclick: () => renameDialog(s) }, titleOf(s)),
      el('div', { class: 'ag-as-chips' }, ...headChips(s))),
    el('div', { class: 'ag-as-head-actions' },
      b ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Stop the reply (Esc)', 'aria-label': 'Stop', onclick: () => abort(s.id) }, svg('stop'), el('span', { class: 'ag-as-lbl' }, 'Stop')) : null,
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Reload the transcript', 'aria-label': 'Reload', onclick: () => loadConv(s.id) }, svg('refresh'), el('span', { class: 'ag-as-lbl' }, 'Reload')),
      el('button', { class: 'btn btn--ghost btn--sm btn--icon ag-as-sq', type: 'button', title: 'Delete', 'aria-label': 'Delete', onclick: () => deleteDialog(s) }, svg('trash'))));
}

/** The other conversations, for hopping between them on a wide screen. */
function rail(current) {
  const list = sessionsSorted().slice(0, 40);
  return el('nav', { class: 'ag-as-rail', 'aria-label': 'Conversations' },
    el('button', { class: 'btn btn--sm ag-as-rail-new', type: 'button', onclick: () => go('new') }, svg('plus'), 'New conversation'),
    el('div', { class: 'ag-as-rail-list' }, list.map((s) => {
      const st = liveState(s.id);
      return el('button', {
        class: `ag-as-rail-item${s.id === current ? ' is-current' : ''}`, type: 'button',
        'aria-current': s.id === current ? 'page' : null, title: `${titleOf(s)} — ${shortPath(s.directory)}`,
        onclick: () => { if (s.id !== current) go(s.id); },
      }, dot(st), el('span', { class: 'ag-as-rail-t' }, titleOf(s)), el('span', { class: 'ag-as-rail-w' }, relTime(s.time?.updated)));
    })));
}

function emptyConversation() {
  return el('div', { class: 'ag-as-empty' },
    mark('ic ic--xl'),
    el('b', {}, 'Ask anything'),
    el('p', {}, 'It runs on HP with this folder as its workspace, and can reach the fleet, the AC, the stack’s services and a shell on loq or disinteg.'),
    el('div', { class: 'ag-as-sugg' }, ['What are the CPU temps across the fleet?', 'What is the AC set to?', 'Which services in the stack are down?']
      .map((t) => el('button', { class: 'ag-as-chip ag-as-chip--btn', type: 'button', onclick: () => { C.input.value = t; C.input.dispatchEvent(new Event('input')); C.focus(); } }, t))));
}

function paintDetail(reason) {
  const s = S.sessions.get(V.detail);
  if (!s) {
    if (!S.listed) { root.replaceChildren(el('div', { class: 'stack-lg' }, el('span', { class: 'skeleton', style: 'height:56px;display:block' }), el('span', { class: 'skeleton', style: 'height:300px;display:block' }))); return; }
    closeDetail();
    root.replaceChildren(el('section', { class: 'stack-lg ag-as-page' }, tabs(), el('section', { class: 'panel stack' },
      problem('No such conversation', 'It may have been deleted.', el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go() }, 'All conversations')))));
    return;
  }
  const existing = root.querySelector(`.ag-as-detail[data-session="${s.id}"]`);
  if (existing) {
    existing.querySelector('.ag-as-headwrap').replaceChildren(detailHead(s));
    const r = existing.querySelector('.ag-as-railwrap');
    if (r && reason !== 'conv') r.replaceChildren(rail(s.id));
    C?.refresh();
    return;
  }
  closeDetail();
  T = transcript(s.id, { empty: emptyConversation, onPickModel: (anchor, pick) => modelMenu(anchor, null, pick) });
  C = composer({
    sid: () => V.detail,
    onSend: (m) => sendMessage(V.detail, m),
    placeholder: 'Message the Assistant',
    escStops: true,
    autofocus: !window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  });
  const view = el('section', { class: 'ag-as-detail', 'data-session': s.id },
    el('div', { class: 'ag-as-railwrap' }, rail(s.id)),
    el('div', { class: 'ag-as-convo' },
      el('div', { class: 'ag-as-headwrap' }, detailHead(s)),
      T.el,
      C.el));
  root.replaceChildren(view);
  watchViewport();
  size();
}

/* The conversation fills the window from where it starts to the bottom of
   what is visible — measured, as the Claude view does, because the console's
   chrome differs between phone and desktop. A phone keyboard switches it to
   a layout sized to what the keyboard leaves. */
function bottomChrome(view, visible) {
  const x = Math.round(innerWidth / 2);
  let n = document.elementFromPoint(x, Math.max(0, Math.round(visible) - 2));
  while (n && n !== document.body && n !== document.documentElement) {
    if (view.contains(n)) return 0;
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') return Math.max(0, visible - n.getBoundingClientRect().top);
    n = n.parentElement;
  }
  return 0;
}

/** How far down the window the host's pinned top bars reach. */
function topChrome(view) {
  // Bars can stack (status, title, a module's tab row): step down through
  // each pinned one until something that scrolls is under the probe.
  let y = 2;
  for (let i = 0; i < 6; i++) {
    let n = document.elementFromPoint(Math.round(innerWidth / 2), y);
    let pinned = null;
    while (n && n !== document.body && n !== document.documentElement) {
      if (view.contains(n)) return y - 2;
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') { pinned = n; break; }
      n = n.parentElement;
    }
    if (!pinned) return y - 2;
    y = Math.ceil(pinned.getBoundingClientRect().bottom) + 2;
  }
  return y - 2;
}

/* On a phone the module's object and readings sit ABOVE the view in one
   scrolling column. A conversation is not read under them: the page is
   scrolled so the conversation starts under the top bars, and it is sized
   to the screen from there. The object is one swipe up. */
function fitPhone(view) {
  const visible = window.visualViewport?.height || innerHeight;
  const top = topChrome(view);
  const h = Math.floor(visible - top - bottomChrome(view, visible) - 6);
  view.style.setProperty('--ag-as-h', `${Math.max(320, h)}px`);
  const y = view.getBoundingClientRect().top + window.scrollY - top - 4;
  if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
}

function size() {
  const view = root?.querySelector('.ag-as-detail');
  if (!view) return;
  // The rail earns its column only when the conversation keeps a reading
  // width beside it — measured on the view, not the window, because the
  // console's own nav and the module's object take a share of the window.
  view.classList.toggle('has-rail', view.clientWidth >= 1040);
  if (view.classList.contains('is-kb')) { view.style.removeProperty('--ag-as-h'); return; }
  if (innerWidth <= 900) { fitPhone(view); return; }
  const visible = window.visualViewport?.height || innerHeight;
  const top = view.getBoundingClientRect().top + window.scrollY;
  const h = Math.floor(visible - bottomChrome(view, visible) - top - 12);
  view.style.setProperty('--ag-as-h', `${Math.max(360, h)}px`);
  const doc = document.documentElement;
  const over = doc.scrollHeight - doc.clientHeight;
  if (over > 0 && window.scrollY === 0) view.style.setProperty('--ag-as-h', `${Math.max(360, h - over)}px`);
}

function onViewport() {
  const view = root?.querySelector('.ag-as-detail');
  if (!view) return;
  const vv = window.visualViewport;
  if (vv) {
    view.style.setProperty('--ag-as-vvh', `${Math.round(vv.height)}px`);
    view.style.setProperty('--ag-as-vvtop', `${Math.round(vv.offsetTop)}px`);
  }
  const kb = !!vv && vv.scale < 1.05 && document.documentElement.clientHeight - vv.height > 120 && view.contains(document.activeElement);
  const was = view.classList.contains('is-kb');
  view.classList.toggle('is-kb', kb);
  document.documentElement.style.overflow = kb ? 'hidden' : '';
  if (was && !kb && innerWidth > 900) window.scrollTo(0, 0);
  size();
  if (kb !== was) T?.toEnd();
}

function watchViewport() {
  if (vpOff) return;
  const vv = window.visualViewport;
  let raf = 0;
  const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(onViewport); };
  vv?.addEventListener('resize', run);
  vv?.addEventListener('scroll', run);
  window.addEventListener('resize', run);
  document.addEventListener('focusin', run);
  document.addEventListener('focusout', run);
  vpOff = () => {
    vv?.removeEventListener('resize', run);
    vv?.removeEventListener('scroll', run);
    window.removeEventListener('resize', run);
    document.removeEventListener('focusin', run);
    document.removeEventListener('focusout', run);
  };
}

/** Esc stops a reply from anywhere on the page, not only from the box. */
function onKey(e) {
  if (e.key !== 'Escape' || !V.detail || !root?.isConnected) return;
  if (document.querySelector('.modal-backdrop, .cp-backdrop, .ag-as-menu, .ag-qc')) return;
  if (busy(V.detail)) { e.preventDefault(); abort(V.detail); }
}

async function renameDialog(s) {
  const input = el('input', { class: 'input', value: titleOf(s), maxlength: '120' });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.closest('.modal')?.querySelector('.modal-foot .btn:last-child')?.click(); } });
  const ok = await ctx.modal({ title: 'Rename conversation', body: el('div', { class: 'field' }, el('label', {}, 'Title'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }] });
  if (!ok || !input.value.trim()) return;
  await act(`rename:${s.id}`, () => rename(s.id, input.value.trim()));
}

async function deleteDialog(s) {
  const ok = await ctx.modal({
    title: 'Delete this conversation?',
    body: el('p', { class: 'meta' }, `“${titleOf(s)}” and everything in it is removed from OpenCode on HP. This cannot be undone.`),
    actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Delete', value: true, variant: 'danger' }],
  });
  if (!ok) return;
  const r = await act(`del:${s.id}`, () => remove(s.id).then(() => true), 'Deleted');
  if (r && V.detail === s.id) go();
}

/* ── new ────────────────────────────────────────────────────────────── */

async function browse(p) {
  const q = new URLSearchParams();
  if (p) q.set('path', p);
  if (V.hidden) q.set('hidden', '1');
  try { V.fs = await api(`/fs?${q}`); } catch (e) { V.fs = { ...(V.fs || {}), error: e.message }; }
  if (V.form && V.fs.path && !V.fs.error) V.form.dir = V.fs.path;
  paintBrowser();
}

function crumbs(p) {
  const parts = p.split('/').filter(Boolean);
  const out = [el('button', { class: 'ag-as-crumb', type: 'button', onclick: () => browse('/') }, '/')];
  let acc = '';
  parts.forEach((part, i) => {
    acc += `/${part}`;
    const target = acc;
    out.push(el('button', { class: 'ag-as-crumb', type: 'button', onclick: () => browse(target), 'aria-current': i === parts.length - 1 ? 'location' : null }, part));
    if (i < parts.length - 1) out.push(el('span', { class: 'ag-as-crumb-sep' }, '/'));
  });
  return out;
}

function paintBrowser() {
  const host = root?.querySelector('.ag-as-browser');
  if (!host || !V.fs) return;
  const f = V.fs;
  const input = root.querySelector('.ag-as-cwd');
  if (input && f.path && document.activeElement !== input) input.value = f.path;
  host.replaceChildren(...[
    el('div', { class: 'ag-as-crumbs' }, f.path ? crumbs(f.path) : null),
    el('div', { class: 'ag-as-browser-bar' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: !f.parent, onclick: () => browse(f.parent) }, svg('folderUp'), 'Up'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => browse(f.home) }, svg('house'), 'Home'),
      el('label', { class: 'check ag-as-hidden' }, el('input', { type: 'checkbox', checked: V.hidden, onchange: (e) => { V.hidden = e.target.checked; browse(f.path); } }), el('span', {}, 'Hidden'))),
    f.error ? el('p', { class: 'meta ag-as-err' }, f.error) : null,
    el('div', { class: 'ag-as-fsdirs' },
      (f.entries || []).length
        ? f.entries.map((d) => el('button', { class: 'ag-as-dir', type: 'button', onclick: () => browse(d.path), title: d.path },
          svg('folder'), el('span', {}, d.name), d.git ? el('span', { class: 'ag-as-git' }, 'git') : null))
        : el('p', { class: 'meta' }, 'No folders here.')),
    f.truncated ? el('p', { class: 'meta' }, 'Showing the first 1000.') : null,
    (f.recent || []).length ? el('div', { class: 'ag-as-recent' },
      el('span', { class: 'label' }, 'Recent'),
      f.recent.map((r) => el('button', { class: 'ag-as-chip ag-as-chip--btn', type: 'button', onclick: () => browse(r), title: r }, shortPath(r)))) : null,
  ].filter(Boolean));
}

function paintNew() {
  if (!V.form) V.form = { dir: S.cfg?.defaultPath || '', text: '', title: '', model: null, agent: S.cfg?.settings?.agent || 'build' };
  const F = V.form;
  const cwd = el('input', {
    class: 'input ag-as-cwd', value: F.dir, placeholder: '/path/on/HP', spellcheck: 'false',
    oninput: (e) => { F.dir = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(e.target.value); } },
  });
  const modelBtn = el('button', { class: 'ag-as-pickbtn ag-as-pickbtn--field', type: 'button' });
  const paintModel = () => modelBtn.replaceChildren(el('span', { class: 'ag-as-pickbtn-name' }, F.model ? modelName(F.model) : `Default — ${modelName(defaultModel())}`), el('span', { class: 'ag-as-pickbtn-chev' }, svg('chevron')));
  paintModel();
  modelBtn.addEventListener('click', () => modelMenu(modelBtn, F.model, (k) => { F.model = k; paintModel(); }, { allowDefault: true }));
  const mode = el('div', { class: 'segctl ag-as-mode', role: 'group', 'aria-label': 'Mode' },
    [['build', 'Build'], ['plan', 'Plan']].map(([id, label]) => el('button', {
      type: 'button', 'aria-pressed': String(F.agent === id),
      onclick: (e) => { F.agent = id; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); },
    }, label)));
  const text = el('textarea', {
    id: 'ag-as-first', class: 'textarea ag-as-first', rows: '6', placeholder: 'What should it do? Leave empty to open the conversation and type there.',
    oninput: (e) => { F.text = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); } },
  }, F.text);
  const startBtn = el('button', { class: 'btn', type: 'button', onclick: start }, V.busy.has('create') ? 'Starting…' : 'Start');

  root.replaceChildren(el('section', { class: 'stack-lg ag-as-page' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Folder on HP'), el('span', { class: 'meta' }, 'its workspace: where it reads, runs and writes')),
      el('div', { class: 'ag-as-cwdrow' }, cwd, el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => browse(cwd.value) }, 'Go')),
      el('div', { class: 'ag-as-browser' }, el('span', { class: 'skeleton', style: 'height:120px;display:block' }))),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'First message'),
      el('div', { class: 'field' }, el('label', { for: 'ag-as-first' }, 'Message'), text, el('span', { class: 'help' }, 'Ctrl+Enter starts')),
      el('div', { class: 'field' }, el('label', { for: 'ag-as-title' }, 'Title (optional)'),
        el('input', { id: 'ag-as-title', class: 'input', value: F.title, maxlength: '120', placeholder: 'Named for you after the first reply', oninput: (e) => { F.title = e.target.value; } }))),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Options'),
      el('div', { class: 'grid grid--2 ag-as-opts' },
        el('div', { class: 'field' }, el('label', {}, 'Model'), modelBtn, el('span', { class: 'help' }, 'where it starts; a model that refuses hands over to the next')),
        el('div', { class: 'field' }, el('label', {}, 'Mode'), mode, el('span', { class: 'help' }, 'Plan reads and proposes; it changes nothing')))),
    el('div', { class: 'ag-as-start' },
      el('span', { class: 'meta' }, `Asks before ${askList() || 'nothing'}. Change that in Settings.`),
      startBtn)));
  if (!V.fs || V.fs.path !== F.dir) browse(F.dir || undefined); else paintBrowser();
}

function askList() {
  const t = S.cfg?.settings?.tools || {};
  return [t.shell === 'ask' ? 'shell commands' : null, t.edit === 'ask' ? 'file edits' : null, t.console === 'ask' ? 'console actions' : null, t.web === 'ask' ? 'web requests' : null].filter(Boolean).join(', ');
}

async function start() {
  const F = V.form;
  if (!F.dir?.startsWith('/')) { toast('warn', 'Pick a folder first'); return; }
  V.busy.add('create'); paintStartBtn();
  try {
    const s = await createSession({ directory: F.dir, title: F.title || undefined, text: F.text || undefined, model: F.model || undefined, agent: F.agent });
    V.form = null;
    go(s.id);
  } catch (e) {
    toast('err', 'Could not start it', e.message);
  } finally {
    V.busy.delete('create'); paintStartBtn();
  }
}
function paintStartBtn() {
  const b = root?.querySelector('.ag-as-start .btn');
  if (b) { b.disabled = V.busy.has('create'); b.textContent = V.busy.has('create') ? 'Starting…' : 'Start'; }
}

/* ── settings ───────────────────────────────────────────────────────── */

async function save(patch, what = 'Saved') {
  const r = await act('settings', () => saveSettings(patch));
  if (r) toast('ok', what);
}

function toggleRow(on, label, detail, onchange) {
  return el('button', {
    class: 'togrow', type: 'button', 'data-on': on ? '1' : '0', 'aria-pressed': String(on),
    onclick: (e) => {
      const b = e.currentTarget;
      const next = b.dataset.on !== '1';
      b.dataset.on = next ? '1' : '0';
      b.setAttribute('aria-pressed', String(next));
      onchange(next);
    },
  }, el('span', { class: 'ag-as-tog' }, el('span', { class: 'tlabel' }, label), detail ? el('span', { class: 'ag-as-tog-detail' }, detail) : null),
  el('span', { class: 'toggle' }, el('span', { class: 'track' })));
}

const TOOL_GROUPS = [
  ['shell', 'Shell commands', 'bash on HP, in the conversation’s folder'],
  ['edit', 'File edits', 'edit, write and patch files'],
  ['console', 'Console actions', 'set the AC, restart a service, run a shell on loq or disinteg — reading never asks'],
  ['web', 'Web', 'fetch pages and search'],
];

function paintSettings() {
  if (!S.cfg) {
    root.replaceChildren(el('section', { class: 'stack-lg ag-as-page' }, tabs(), el('span', { class: 'skeleton', style: 'height:300px;display:block' })));
    return;
  }
  const set = S.cfg.settings;
  const defBtn = el('button', { class: 'ag-as-pickbtn ag-as-pickbtn--field', type: 'button' },
    el('span', { class: 'ag-as-pickbtn-name' }, set.defaultModel ? modelName(set.defaultModel) : `Automatic — ${modelName(models()[0]?.key)}`),
    el('span', { class: 'ag-as-pickbtn-chev' }, svg('chevron')));
  defBtn.addEventListener('click', () => modelMenu(defBtn, set.defaultModel, (k) => save({ defaultModel: k }, 'Default model saved'), { allowDefault: true }));

  const fbs = set.fallbacks || [];
  const addFb = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: fbs.length >= 8 }, svg('plus'), 'Add');
  addFb.addEventListener('click', () => modelMenu(addFb, null, (k) => { if (k && !fbs.includes(k)) save({ fallbacks: [...fbs, k] }, 'Fallback added'); }));
  const move = (i, d) => { const n = [...fbs]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); save({ fallbacks: n }, 'Order saved'); };

  const anyOff = Object.values(set.tools).includes('off');
  const tools = TOOL_GROUPS.map(([k, label, detail]) => el('div', { class: 'ag-as-toolrow' },
    el('div', { class: 'ag-as-tog' }, el('span', { class: 'tlabel' }, label), el('span', { class: 'ag-as-tog-detail' }, detail)),
    el('div', { class: 'segctl ag-as-toolseg', role: 'group', 'aria-label': label },
      [['allow', 'Allow'], ['ask', 'Ask'], ['off', 'Off']].map(([v, l]) => el('button', {
        type: 'button', 'aria-pressed': String(set.tools[k] === v),
        onclick: () => save({ tools: { [k]: v } }, `${label}: ${l.toLowerCase()}`),
      }, l)))));

  const quickPath = el('input', { class: 'input', value: set.quickPath || '', placeholder: S.cfg.defaultPath, spellcheck: 'false' });
  const mcp = S.cfg.mcp || {};

  root.replaceChildren(el('section', { class: 'stack-lg ag-as-page' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Models'),
      el('div', { class: 'grid grid--2 ag-as-opts' },
        el('div', { class: 'field' }, el('label', {}, 'Default model'), defBtn, el('span', { class: 'help' }, 'new conversations and the quick chat start here; a conversation then keeps its own')),
        el('div', { class: 'field' }, el('label', {}, 'Mode'),
          el('div', { class: 'segctl ag-as-mode', role: 'group', 'aria-label': 'Default mode' },
            [['build', 'Build'], ['plan', 'Plan']].map(([id, l]) => el('button', { type: 'button', 'aria-pressed': String(set.agent === id), onclick: () => save({ agent: id }, `Default mode: ${l}`) }, l))),
          el('span', { class: 'help' }, 'Plan reads and proposes; it changes nothing'))),
      toggleRow(set.fallback, 'Fall back when a model refuses', 'quota, rate limit, the free tier saying no, an empty reply: the same message goes to the next model', (v) => save({ fallback: v }, v ? 'Fallback on' : 'Fallback off')),
      set.fallback ? el('div', { class: 'stack ag-as-fbs' },
        el('div', { class: 'ag-panel-head' }, el('span', { class: 'label' }, 'Try these first'), addFb),
        fbs.length
          ? el('ol', { class: 'ag-as-fblist' }, fbs.map((k, i) => el('li', { class: 'ag-as-fbitem' },
            el('span', { class: 'ag-as-fbn' }, String(i + 1)),
            el('span', { class: 'ag-as-fbname', title: k }, modelName(k)),
            el('button', { class: 'iconbtn ag-as-fbbtn', type: 'button', title: 'Earlier', 'aria-label': 'Move earlier', disabled: i === 0, onclick: () => move(i, -1) }, svg('chevron', 'ic ag-as-up')),
            el('button', { class: 'iconbtn ag-as-fbbtn', type: 'button', title: 'Later', 'aria-label': 'Move later', disabled: i === fbs.length - 1, onclick: () => move(i, 1) }, svg('chevron', 'ic ag-as-down')),
            el('button', { class: 'iconbtn ag-as-fbbtn', type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => save({ fallbacks: fbs.filter((x) => x !== k) }, 'Fallback removed') }, svg('close')))))
          : el('p', { class: 'meta' }, 'None picked: after the first model, the rest are tried in catalog order — free models first.'),
        el('p', { class: 'meta' }, `${models().length} models · ${models().filter((m) => m.free).length} free, the rest on OpenCode Go${S.cfg.catalog === 'fallback' ? ' · catalog unavailable, showing the built-in list' : ''}.`)) : null),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Tools'), el('span', { class: 'meta' }, 'applies to every conversation from its next message')),
      el('div', { class: 'ag-as-toolrows' }, tools),
      anyOff ? el('div', { class: 'alert alert--warn' }, el('b', {}, 'Free tier'),
        el('span', {}, 'OpenCode’s free models refuse any request with a tool switched off, so while one is off only OpenCode Go models are used.')) : null),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Quick chat'),
      el('div', { class: 'field' }, el('label', {}, 'Folder'),
        el('div', { class: 'ag-as-cwdrow' }, quickPath,
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => save({ quickPath: quickPath.value.trim() || null }, 'Quick chat folder saved') }, 'Save')),
        el('span', { class: 'help' }, 'where conversations started from the overview’s Assistant button work'))),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Pings'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => act('test', () => api('/notify/test', { method: 'POST', body: '{}' }), 'Test ping sent') }, 'Send a test')),
      S.cfg.webhook
        ? el('p', { class: 'meta' }, 'Sent to Discord (ASSISTANT_DISCORD_WEBHOOK) and to the console app.')
        : el('div', { class: 'alert alert--info' }, el('b', {}, 'App only'), el('span', {}, 'Pings reach the console phone app. Set ASSISTANT_DISCORD_WEBHOOK in the agent module’s environment to send them to Discord too.')),
      el('div', { class: 'ag-as-toggles' },
        toggleRow(set.notify.needsYou, 'Needs you', 'a tool waiting for approval, or a question', (v) => save({ notify: { needsYou: v } })),
        toggleRow(set.notify.errors, 'Failed', 'every model refused, or the turn broke', (v) => save({ notify: { errors: v } })),
        toggleRow(set.notify.done, 'Replied', 'a reply finished — with its first lines', (v) => save({ notify: { done: v } }))),
      (S.cfg.pings || []).length ? el('details', {}, el('summary', { class: 'meta' }, 'Recent pings'),
        el('div', { class: 'ag-as-list' }, S.cfg.pings.map((n) => el('div', { class: 'ag-as-row ag-as-ping' },
          el('span', { class: 'meta' }, relTime(n.at)), el('span', { class: 'ag-as-row-title' }, n.title), el('span', { class: 'meta' }, n.discord ? 'discord + app' : 'app'))))) : null),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Server'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { await loadConfig(); toast('ok', 'Re-read'); } }, svg('refresh'), 'Re-read')),
      el('div', { class: 'ag-as-list' },
        ...[
          ['OpenCode', S.cfg.reachable ? `${S.cfg.version || 'up'} · ${S.online === false ? 'event stream down' : 'live'}` : `not answering${S.cfg.error ? ` — ${S.cfg.error}` : ''}`],
          ['Address', S.cfg.url],
          ['Console tools', Object.entries(mcp).map(([k, v]) => `${k}: ${v.status}${v.error ? ` (${v.error})` : ''}`).join(' · ') || 'none'],
          ['Default folder', S.cfg.defaultPath],
          ['Models', `${models().length} (${S.cfg.catalog === 'server' ? 'from the server' : 'built-in list'})`],
        ].map(([k, v]) => el('div', { class: 'ag-as-row ag-as-kv' }, el('span', { class: 'meta' }, k), el('span', {}, v || '—')))))));
}

/* ── lifecycle ──────────────────────────────────────────────────────── */

export async function mountAssistant(el0, context) {
  root = el0;
  ctx = context;
  connect(context);
  off = on((what, sid) => {
    if (!root) return;
    if (V.detail) {
      if (what === 'removed' && sid === V.detail) { go(); return; }
      if (what === 'sessions' || what === 'session' || what === 'config' || what === 'upstream') paint('session');
      return;
    }
    if (V.tab === 'sessions' && ['sessions', 'session', 'config', 'upstream', 'removed'].includes(what)) {
      if (root.contains(document.activeElement) && document.activeElement.matches('.ag-as-search')) {
        const pos = document.activeElement.selectionStart; paint(); const n = root.querySelector('.ag-as-search'); n?.focus(); n?.setSelectionRange(pos, pos);
      } else paint();
    }
    if (V.tab === 'settings' && what === 'config') paint('config');
    if (V.tab === 'new' && what === 'config' && !root.querySelector('.ag-as-cwd')) paint();
  });
  window.addEventListener('keydown', onKey);
  routeAssistant();
}

export function unmountAssistant() {
  closeDetail();
  off?.(); off = null;
  window.removeEventListener('keydown', onKey);
  disconnect();
  root = null;
}
