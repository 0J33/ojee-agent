/* ============================================================
   ojee-agent — the Assistant view.

   OpenCode's Zen gateway, hosted on HP as `opencode serve`, opened
   from here. Three places, one row of tabs:

     Sessions   every session, or every session opened in one path
     New        a path on the machine and a title — that is a session
     <id>       its transcript and a composer under it

   The model is the part worth watching. Zen's free tier is a queue:
   a model can run out mid-conversation, and the answer to that is
   not an error screen but a different model. The module walks its
   preference order until one replies and says which one did, so the
   chip in the bar and the tag under each answer are one fact read
   at two moments.

   A session's path is decided when the session is opened — opencode
   will not re-path a live one — so the path belongs to New, and the
   list shows the path every session already has.

   Routes live under the view: #/agent/assistant/<rest>, where rest
   is '', 'new' or a session id. The console reads the first two
   segments only, so a deep link opens straight to the transcript.

   The same panes open as a modal from the console's overview and
   idle screens. There, navigation stays in memory instead of going
   through location.hash: a chat window must not be able to take the
   page it is sitting on somewhere else.
   ============================================================ */

import { ensureIcons } from './claude-icons.js';

/* loq's Downloads/user-robot.svg, verbatim. The sprite is already in the
   host's index.html; this is the same drawing for a host that has neither. */
const ROBOT = 'm21,23c0,.553-.448,1-1,1s-1-.447-1-1c0-2.206-1.794-4-4-4h-6c-2.206,0-4,1.794-4,4,0,.553-.448,1-1,1s-1-.447-1-1c0-3.309,2.691-6,6-6h6c3.309,0,6,2.691,6,6Zm1-15.5v2c0,.827-.673,1.5-1.5,1.5h-.5c0,2.206-1.794,4-4,4h-8c-2.206,0-4-1.794-4-4h-.5c-.827,0-1.5-.673-1.5-1.5v-2c0-.827.673-1.5,1.5-1.5h.5c0-2.206,1.794-4,4-4h3v-1c0-.553.448-1,1-1s1,.447,1,1v1h3c2.206,0,4,1.794,4,4h.5c.827,0,1.5.673,1.5,1.5Zm-4-1.5c0-1.103-.897-2-2-2h-8c-1.103,0-2,.897-2,2v5c0,1.103.897,2,2,2h8c1.103,0,2-.897,2-2v-5Zm-8.5,1c-.828,0-1.5.672-1.5,1.5s.672,1.5,1.5,1.5,1.5-.672,1.5-1.5-.672-1.5-1.5-1.5Zm5,0c-.828,0-1.5.672-1.5,1.5s.672,1.5,1.5,1.5,1.5-.672,1.5-1.5-.672-1.5-1.5-1.5Z';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
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

const pref = (key, value) => {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window, blocked storage: the default it is */ }
  return null;
};

const problem = (title, detail, action) => el('div', { class: 'ag-problem' },
  el('strong', {}, title), detail ? el('p', { class: 'meta' }, detail) : null, action || null);

/**
 * The Assistant's own mark, as a node. The sprite is already on the page by
 * the time any of this renders — ensured in mount() — so this is a <use>, the
 * same shape the shell's own icons take.
 */
function robot(cls) {
  if (typeof ctx?.icon === 'function') {
    const probe = document.createElement('span');
    probe.innerHTML = ctx.icon('i-assistant', cls);
    if (probe.firstElementChild) return probe.firstElementChild;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-assistant');
  svg.append(use);
  return svg;
}

let ctx = null;
let host = null;          // the element this instance renders into
let mode = 'view';        // 'view' | 'modal'

const S = {
  cfg: null,              // { configured, defaultPath, model, models } | null
  cfgError: null,         // the config call itself failed — see loadConfig()
  sessions: null,         // null = not loaded, [] = none
  one: null,              // a session fetched on its own, for a deep link
  msgs: null,             // null = not loaded, [] = empty transcript
  id: null,
  tab: 'sessions',        // 'sessions' | 'new' | 'chat'
  model: null,            // the model that answered last
  fallback: false,        // and whether it had to be a different one
  pick: pref('ag-as-model') || null,   // the model the reader chose
  dir: pref('ag-as-dir') || '',
  path: pref('ag-as-path') || '',
  title: '',
  draft: '',
  busy: false,
  error: null,
};

const api = (p, o = {}) => ctx.api(p, o);
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });

function ensureAssistantIcon() {
  const sprite = document.getElementById('sprite');
  if (!sprite || document.getElementById('i-assistant')) return;
  const sym = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
  sym.id = 'i-assistant';
  sym.setAttribute('viewBox', '-2 -2.5 28.5 28.5');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ROBOT);
  sym.appendChild(p);
  sprite.appendChild(sym);
}

function loadCss() {
  if (document.getElementById('ag-as-css') || !ctx?.base) return;
  const link = document.createElement('link');
  link.id = 'ag-as-css';
  link.rel = 'stylesheet';
  link.href = `${ctx.base}/ui/assistant.css`;
  document.head.appendChild(link);
}

/* ── the small vocabulary the Claude view shares ───────────────────── */

/** An icon from the sprite, as a node — the same call the Claude view makes. */
const svg = (name, cls = 'ic') => {
  const t = document.createElement('template');
  t.innerHTML = ctx.icon(`i-${name}`, cls);
  return t.content.firstChild;
};

const lbl = (text) => el('span', { class: 'ag-as-lbl' }, text);

/** `.dot` is the design system's; the tone is optional. */
const dot = (tone) => el('span', { class: tone ? `dot dot--${tone}` : 'dot' });

/** The human name for a `provider/id`, falling back to the id itself. */
function modelName(key) {
  if (!key) return '';
  const found = (S.cfg?.models || []).find((m) => m.key === key);
  return found?.name || key;
}

/** `/media/…/ojee.net` → `…/ojee.net`: a chip has a width to respect. */
const shortPath = (p) => {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join('/')}`;
};

/* ── data ───────────────────────────────────────────────────────────── */

async function loadConfig() {
  try {
    S.cfg = await api('/assistant/config');
    S.cfgError = null;
    S.model = S.cfg?.model || S.model;
    // A pick stored as a bare id — the server accepts either — is resolved
    // against the catalog, so the control shows the name of the model rather
    // than an id the reader never typed.
    if (S.cfg?.models?.length && S.pick && !S.pick.includes('/')) {
      const hit = S.cfg.models.find((m) => m.id === S.pick);
      if (hit) { S.pick = hit.key; pref('ag-as-model', S.pick); }
    }
    // A pick the server no longer offers is a dead end — every message would
    // come back "model not found" — so drop it. Only when the catalog really
    // came back: a failed call is handled above, and a fallback catalog (the
    // server's own short list while /provider is briefly down) must not be
    // read as "your model was removed".
    if (S.cfg?.catalog === 'server' && S.cfg?.models?.length
      && S.pick && !S.cfg.models.some((m) => m.key === S.pick)) {
      S.pick = null;
      pref('ag-as-model', '');
    }
    if (!S.path) S.path = S.cfg?.defaultPath || '';
    S.error = null;
  } catch (e) {
    // A call that did not answer is NOT the same fact as an unset
    // OPENCODE_URL: one is fixed by trying again, the other by editing an
    // environment. Reporting the second for the first sends the reader off to
    // change a setting that is already right, and offers nothing to press.
    S.cfg = { configured: false };
    S.cfgError = e.message;
  }
}

/** One session, so a transcript opened by link can show its title. */
async function loadOne(id) {
  try { S.one = await api(`/assistant/sessions/${encodeURIComponent(id)}`); }
  catch { S.one = null; }
}

async function loadSessions() {
  const q = S.dir ? `?directory=${encodeURIComponent(S.dir)}` : '';
  try {
    S.sessions = await api(`/assistant/sessions${q}`);
    S.error = null;
  } catch (e) {
    S.error = e.message;
    if (S.sessions === null) S.sessions = [];
  }
}

async function loadMsgs() {
  if (!S.id) { S.msgs = null; return; }
  try {
    S.msgs = await api(`/assistant/sessions/${encodeURIComponent(S.id)}/messages`);
    S.error = null;
  } catch (e) {
    S.error = e.message;
    if (S.msgs === null) S.msgs = [];
  }
}

async function send() {
  const text = String(S.draft || '').trim();
  if (!text || S.busy) return;
  const directory = String(S.path || S.cfg?.defaultPath || '').trim();

  S.busy = true;
  S.error = null;
  S.draft = '';
  paint();

  // The conversation is made by the first message, not by a form filled in
  // before it. That is the whole difference between a dialog you open to talk
  // and a dialog you open to configure.
  let phantom = null;
  try {
    if (!S.id) {
      const s = await post('/assistant/sessions', { directory: directory || '/' });
      S.id = s.id;
      pref('ag-as-sid', s.id);
      S.msgs = [];
      await loadSessions();
      // In the view the transcript is a real place, so the URL becomes it —
      // replaceState rather than a hash change, which would re-enter routing
      // half way through sending.
      if (mode === 'view') history.replaceState(null, '', `#/assistant/${encodeURIComponent(s.id)}`);
    }

    // Echo the line immediately: a reply is seconds away and a chat that
    // swallows what you typed while you wait reads as broken.
    phantom = { info: { role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text }] };
    S.msgs = [...(S.msgs || []), phantom];
    paint();

    const chosen = S.pick;
    const r = await post(`/assistant/sessions/${encodeURIComponent(S.id)}/message`,
      { text, ...(chosen ? { model: chosen } : {}) });

    // Whatever answered becomes the model we are on, and whether it was the
    // one that was asked for is kept — the callout under the head is the only
    // place that says so out loud.
    if (r.model) {
      S.fallback = !!(chosen && r.model !== chosen);
      S.model = r.model;
      if (S.pick !== r.model) { S.pick = r.model; pref('ag-as-model', r.model); }
    }
    await loadMsgs();
  } catch (e) {
    // Hand the text back: losing what you typed to a dead gateway is the
    // one failure a chat window must not commit.
    if (phantom) S.msgs = (S.msgs || []).filter((m) => m !== phantom);
    S.draft = text;
    S.error = e.message;
    ctx.toast?.('err', 'That did not work', e.message);
  } finally {
    S.busy = false;
    paint();
    const box = host?.querySelector('.ag-as-input');
    if (box && document.activeElement !== box) box.focus();
  }
}

async function openNew() {
  if (S.busy) return;
  const directory = String(S.path || S.cfg?.defaultPath || '').trim();
  S.busy = true;
  S.error = null;
  paint();
  try {
    const s = await post('/assistant/sessions', {
      directory,
      ...(S.title.trim() ? { title: S.title.trim() } : {}),
    });
    pref('ag-as-path', directory);
    S.dir = directory;
    pref('ag-as-dir', directory);
    S.title = '';
    S.msgs = [];
    S.tab = 'sessions';
    await loadSessions();
    // In the view the transcript is a deep link; in the modal it is state,
    // because moving the hash under an open dialog would take the console
    // behind it to another page.
    if (mode === 'view') { go(s.id); return; }
    S.id = s.id;
    pref('ag-as-sid', s.id);
    await loadMsgs();
    paint();
  } catch (e) {
    S.error = e.message;
    ctx.toast?.('err', 'That did not work', e.message);
    paint();
  } finally {
    S.busy = false;
  }
}

async function openSession(id) {
  if (S.busy) return;
  pref('ag-as-sid', id);
  S.msgs = null;
  S.tab = 'sessions';
  S.error = null;
  S.one = null;
  S.fallback = false;
  if (mode === 'view') { go(id); return; }
  S.id = id;
  paint();
  await loadMsgs();
  paint();
}

/* ── routing (the view only) ────────────────────────────────────────── */

function sub() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const i = parts.indexOf('assistant');
  return i >= 0 ? parts.slice(i + 1).filter(Boolean).map(decodeURIComponent) : [];
}

function go(...segs) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const i = parts.indexOf('assistant');
  const prefix = i >= 0 ? parts.slice(0, i + 1) : [...parts, 'assistant'];
  const next = `#/${[...prefix, ...segs.map(encodeURIComponent)].join('/')}`;
  if (location.hash !== next) location.hash = next;
  else routeAssistant();
}

/* ── routing ────────────────────────────────────────────────────────── */

export function routeAssistant() {
  const [first] = sub();
  const nextId = first && first !== 'new' ? first : null;
  const nextTab = first === 'new' ? 'new' : 'sessions';
  const changed = nextId !== S.id;
  S.id = nextId;
  S.tab = nextTab;
  if (changed) { S.msgs = null; S.one = null; }
  paint();
  if (nextId) {
    // A link opened straight to a transcript has never seen the list, and the
    // list is what gives a session its title — fetch the one session so the
    // header does not have to print the raw id.
    const known = (S.sessions || []).some((s) => s.id === nextId);
    const boot = known ? null : loadOne(nextId);
    Promise.all([loadMsgs(), boot]).then(paint);
  } else loadSessions().then(paint);
}

function showSessions() {
  S.tab = 'sessions';
  S.id = null;
  S.one = null;
  S.fallback = false;
  if (mode === 'modal') { paint(); loadSessions().then(paint); return; }
  go();
}

function showNew() {
  S.tab = 'new';
  S.id = null;
  if (mode === 'modal') { paint(); return; }
  go('new');
}

/* ── the panes ──────────────────────────────────────────────────────── */

/**
 * Which model answers next.
 *
 * A chip could only report a fact; this states it and lets it be changed.
 * Groups by provider because `opencode` (free tier) and `opencode-go`
 * (subscription) are separate catalogs on the same server, and the reader
 * picking "the good one" should not have to know that. The select keeps the
 * last model that answered in step with reality: a fallback that replied is
 * adopted, so the next message starts where the last one succeeded.
 */
function modelPicker() {
  const models = S.cfg?.models || [];
  if (!models.length) return null;
  const pick = S.pick || S.cfg?.model || models[0].key;

  const sel = el('select', {
    class: 'select ag-as-pick',
    'aria-label': 'Model that answers next',
    title: pick,
    onchange: (e) => { S.pick = e.target.value; pref('ag-as-model', S.pick); },
  });
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  for (const [provider, list] of groups) {
    const og = el('optgroup', { label: provider });
    for (const m of list) og.append(el('option', { value: m.key }, m.name));
    sel.append(og);
  }
  // A pick the catalog has temporarily lost still has to appear, or the
  // control would silently show some other model as if it were chosen.
  if (!models.some((m) => m.key === pick)) sel.append(el('option', { value: pick }, pick));
  sel.value = pick;
  return sel;
}

function tabs() {
  // As in the Claude view: being inside a conversation reads as still being
  // on Sessions, so the tab that is lit is the one you came from.
  const active = (S.id || S.tab === 'chat') ? 'sessions' : S.tab;
  return el('div', { class: 'segctl ag-as-tabs', role: 'group', 'aria-label': 'Assistant' },
    el('button', {
      type: 'button',
      'aria-pressed': String(active === 'sessions'),
      onclick: showSessions,
    }, 'Sessions'),
    el('button', {
      type: 'button',
      'aria-pressed': String(active === 'new'),
      onclick: showNew,
    }, 'New'));
}

/**
 * One line under the tabs: what there is, which model answers it, and the way
 * to make more. Same shape as the Claude view's verdict — the dot carries
 * whether anything about the current model is worth knowing (a fallback), and
 * the model itself is a control rather than a label, because the point of it
 * is that it can be changed.
 */
function verdict() {
  const n = S.sessions?.length || 0;
  const key = S.pick || S.model;
  return el('div', { class: 'ag-verdict ag-as-verdict' },
    dot(S.fallback ? 'warn' : n ? 'ok' : null),
    el('strong', {}, n ? `${n} session${n === 1 ? '' : 's'}` : 'no sessions'),
    el('span', { class: 'meta' }, key ? `on ${modelName(key)}` : ''),
    modelPicker(),
    el('button', { class: 'btn btn--sm ag-as-verdict-new', type: 'button', onclick: () => go('new') },
      svg('plus'), 'New session'));
}

function pathRow(action) {
  return el('div', { class: 'ag-as-cwdrow' },
    el('input', {
      class: 'input',
      value: S.path,
      placeholder: '/home/ojee',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'Path the session runs in',
      oninput: (e) => { S.path = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); action(); } },
    }),
    el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: action }, 'Use'));
}

function filterRow() {
  return el('div', { class: 'ag-as-cwdrow ag-as-filter' },
    el('input', {
      class: 'input',
      value: S.dir,
      placeholder: 'every path',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'Only sessions opened in this path',
      oninput: (e) => { S.dir = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); refilter(); } },
    }),
    el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: refilter }, 'Filter'),
    S.dir ? el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      onclick: () => { S.dir = ''; pref('ag-as-dir', ''); refilter(); },
    }, 'All') : null);
}

async function refilter() {
  pref('ag-as-dir', S.dir);
  S.sessions = null;
  paint();
  await loadSessions();
  paint();
}

const clock = (ms) => {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* Three columns, like every list in this module: the title, the folder it
   lives in, and when it last changed. Two columns left the clock stranded a
   thousand pixels from the thing it timestamps. */
function sessionRow(s) {
  return el('button', {
    class: 'ag-as-row',
    type: 'button',
    onclick: () => openSession(s.id),
  },
  el('span', { class: 'ag-as-row-title' }, s.title || s.slug || s.id),
  el('span', { class: 'ag-as-row-path' }, s.directory || '/'),
  el('span', { class: 'ag-as-row-when meta' }, clock(s.time?.updated)));
}

function listPane() {
  const retry = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: async () => { S.sessions = null; paint(); await loadSessions(); paint(); },
  }, 'Try again');
  const wrap = (panel) => el('section', { class: 'stack-lg' }, tabs(), verdict(), panel);

  if (S.sessions === null) {
    return wrap(el('section', { class: 'panel stack' },
      el('span', { class: 'skeleton', style: 'height:18px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:120px;display:block' })));
  }
  if (S.error && !S.sessions.length) {
    return wrap(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Sessions'),
      problem('OpenCode is not answering', S.error, retry)));
  }
  if (!S.sessions.length) {
    return wrap(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Sessions'),
      problem(S.dir ? 'No session in that path' : 'No sessions yet',
        S.dir
          ? 'Nothing has been opened there. Change the path, or clear it to see every session.'
          : 'Open one under New — a path and a title are all a session takes.',
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: showNew }, 'New session'))));
  }
  return wrap(el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Sessions'),
      el('span', { class: 'meta' }, `${S.sessions.length} ${S.sessions.length === 1 ? 'session' : 'sessions'}`)),
    filterRow(),
    el('div', { class: 'ag-as-list' }, S.sessions.map(sessionRow))));
}

/* Two panels, the way the Claude view splits a new session: where it runs,
   and what to call it. One form with everything in it read as setup. */
function newPane() {
  const retry = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: async () => { S.error = null; await openNew(); },
  }, 'Try again');
  return el('section', { class: 'stack-lg' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Folder'),
      pathRow(openNew),
      el('span', { class: 'help' },
        'Where the session runs. Fixed once it is open — opencode will not move a live one.')),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Session'),
      el('div', { class: 'field' },
        el('label', { for: 'ag-as-title-input' }, 'Title (optional)'),
        el('input', {
          id: 'ag-as-title-input',
          class: 'input',
          value: S.title,
          maxlength: '120',
          oninput: (e) => { S.title = e.target.value; },
        })),
      S.error ? problem('Could not open a session', S.error, retry) : null,
      el('div', { class: 'ag-as-start' },
        el('span', { class: 'meta' },
          'Opens a conversation straight away — you can type in it the moment it exists.'),
        el('button', {
          class: 'btn', type: 'button', disabled: S.busy || undefined, onclick: openNew,
        }, S.busy ? 'Opening…' : 'Open session'))));
}

/* ── a reply, drawn from its Markdown ─────────────────────────────────── */

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(el('code', { class: 'ag-as-md-c' }, m[1]));
    else if (m[2] != null) out.push(el('strong', { class: 'ag-as-md-b' }, ...inline(m[2])));
    else {
      const href = m[4] || m[5];
      out.push(el('a', { class: 'ag-as-md-a', href, target: '_blank', rel: 'noreferrer noopener' }, m[3] || m[5]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The same renderer the Claude view uses for a reply — fenced code, headings,
 * lists, quotes, rules and tables — with this view's own class names. A model
 * answers in Markdown; showing it raw puts `**` and `#` in front of the reader
 * as if they were the words.
 */
function md(src) {
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
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.append(el('pre', { class: 'ag-as-md-code' }, code.join('\n')));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...rest] = body;
      out.append(el('div', { class: 'ag-as-md-tablewrap' }, el('table', { class: 'ag-as-md-table' },
        head ? el('tr', {}, head.map((c) => el('th', { class: 'ag-as-md-th' }, ...inline(c)))) : null,
        rest.map((r) => el('tr', {}, r.map((c) => el('td', { class: 'ag-as-md-td' }, ...inline(c))))))));
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      out.append(el('div', { class: `ag-as-md-h ag-as-md-h${Math.min(m[1].length, 3)}` }, ...inline(m[2])));
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush();
      const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      out.append(el('div', { class: 'ag-as-md-li', style: `--d:${depth}` },
        el('span', { class: 'ag-as-md-mark' }, /\d/.test(m[2]) ? m[2] : '•'), el('span', {}, ...inline(m[3]))));
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flush();
      out.append(el('div', { class: 'ag-as-md-quote' }, ...inline(m[1])));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.append(el('div', { class: 'ag-as-md-hr' }));
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

const textOf = (m) => (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

const stampOf = (m) => {
  const ms = m.info?.time?.completed || m.info?.time?.created;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * One message, in the Claude view's shape: who said it on one line, then what
 * they said. For a reply, "who" is the model — that is the fallback made
 * legible, because a conversation where two different models answered is a
 * fact the reader can see rather than one they have to be told.
 */
function messageOf(m) {
  const tools = (m.parts || []).filter((p) => p.type === 'tool' && p.tool).map((p) => p.tool);
  const time = stampOf(m);
  const who = (label) => el('span', { class: 'ag-as-msg-who' }, label,
    time ? el('span', { class: 'meta' }, time) : null);

  if (m.info?.role === 'user') {
    return el('div', { class: 'ag-as-msg ag-as-msg--user' }, who('You'),
      el('div', { class: 'ag-as-pre' }, textOf(m)));
  }
  return el('div', { class: 'ag-as-msg ag-as-msg--assistant' },
    who(modelName(m.info?.modelID) || m.info?.modelID || 'Assistant'),
    textOf(m) ? md(textOf(m)) : null,
    tools.length ? el('div', { class: 'ag-as-tools meta' }, tools.map((t) => `› ${t}`).join('  ')) : null);
}

function transcript() {
  if (S.msgs === null) {
    return el('div', { class: 'ag-as-transcript' },
      el('span', { class: 'skeleton', style: 'height:56px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:56px;display:block' }));
  }
  const shown = S.msgs.filter((m) => m.info?.role === 'user' || textOf(m)
    || (m.parts || []).some((p) => p.type === 'tool'));
  if (!shown.length) {
    // An empty box the size of a full reply is the least inviting thing this
    // view can show. Say who is on the other end instead.
    return el('div', { class: 'ag-as-transcript is-empty' },
      robot('ic ag-as-empty-ic'),
      el('p', { class: 'ag-as-empty-lead' }, 'Nothing here yet.'),
      el('p', { class: 'meta' }, 'Type below — the session is made when you send.'));
  }
  return el('div', { class: 'ag-as-transcript' }, shown.map(messageOf));
}

function composerNote() {
  if (S.busy) return 'Waiting — if this model cannot answer, the next one will.';
  const key = S.pick || S.model;
  if (S.fallback && key) return `${modelName(key)} is answering. Send to keep it.`;
  return 'Enter sends · Shift+Enter makes a new line';
}

function composer() {
  const box = el('textarea', {
    class: 'textarea ag-as-input',
    rows: '3',
    placeholder: 'Message the Assistant — Enter to send',
    'aria-label': 'Message',
    oninput: (e) => { S.draft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    },
  });
  box.value = S.draft;
  return el('div', { class: 'ag-as-compose' },
    box,
    el('div', { class: 'ag-as-compose-bar' },
      el('span', { class: 'meta ag-as-compose-note' }, composerNote()),
      el('button', {
        class: 'btn btn--sm ag-as-send', type: 'button', disabled: S.busy || undefined, onclick: send,
      }, S.busy ? '…' : 'Send')));
}

/* ── a conversation ─────────────────────────────────────────────────── */

function detailHead(s) {
  const path = s?.directory || S.path || S.cfg?.defaultPath || '';
  const key = S.pick || S.model;
  return el('header', { class: 'ag-as-head' },
    el('button', {
      class: 'iconbtn', type: 'button', title: 'All sessions', 'aria-label': 'All sessions',
      onclick: showSessions,
    }, svg('back')),
    el('div', { class: 'ag-as-head-main' },
      el('span', { class: 'ag-as-title' }, s?.title || 'New conversation'),
      el('div', { class: 'ag-as-chips' },
        el('span', { class: 'ag-as-chip', title: 'Model' },
          key ? modelName(key) : 'no model'),
        S.fallback ? el('span', { class: 'ag-as-chip ag-as-chip--warn', title: 'The chosen model could not answer' },
          'fallback') : null,
        path ? el('span', { class: 'ag-as-chip ag-as-chip--path', title: path }, shortPath(path)) : null)),
    el('div', { class: 'ag-as-head-actions' },
      modelPicker(),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', title: 'Start a new conversation',
        onclick: newConversation,
      }, svg('plus'), lbl('New'))));
}

/** The Claude view's callouts: state, said once, above the work. */
function callouts() {
  const out = [];
  if (S.error && S.msgs?.length) {
    out.push(el('div', { class: 'alert alert--err' }, el('b', {}, 'Error'), el('span', {}, S.error)));
  }
  if (S.fallback) {
    const key = S.pick || S.model;
    out.push(el('div', { class: 'alert alert--warn' }, el('b', {}, 'Fallback'),
      el('span', {}, key
        ? `${modelName(key)} answered because the model you chose could not. The next message starts here unless you change it above.`
        : 'The model you chose could not answer, so another one did.')));
  }
  if (S.cfg && !S.cfg.configured && !S.cfgError) {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Not configured'),
      el('span', {}, 'Set OPENCODE_URL for this module to an `opencode serve` instance.')));
  }
  return out;
}

function detailPane() {
  // The list is what names a session; `S.one` is the same session fetched on
  // its own when a link reached the transcript before the list did.
  const s = (S.sessions || []).find((x) => x.id === S.id)
    || (S.one?.id === S.id ? S.one : null);
  // `stack ag-as-detail`, not a panel: tabs, head, callouts, body, composer —
  // the same five-part shape the Claude view gives a conversation.
  return el('section', { class: 'stack ag-as-detail' },
    tabs(),
    el('div', { class: 'ag-as-headwrap' }, detailHead(s)),
    el('div', { class: 'ag-as-callouts' }, ...callouts()),
    el('div', { class: 'ag-as-body' }, transcript()),
    composer());
}

/* ── paint ──────────────────────────────────────────────────────────── */

async function retryConfig() {
  S.cfg = null;
  S.cfgError = null;
  paint();
  await loadConfig();
  paint();
}

/** A blank conversation — the state the overview's dialog opens in. */
function newConversation() {
  S.id = null;
  S.one = null;
  S.msgs = [];
  S.error = null;
  S.fallback = false;
  S.tab = 'chat';
  paint();
}

function paint() {
  if (!host) return;
  const top = (panel) => el('section', { class: 'stack-lg' }, tabs(), panel);

  let view;
  if (!S.cfg) {
    view = top(el('section', { class: 'panel stack' },
      el('span', { class: 'skeleton', style: 'height:18px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:160px;display:block' })));
  } else if (S.cfgError) {
    // Not answering and not configured are different facts with different
    // fixes — one wants a button, the other wants an environment variable.
    view = top(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Assistant'),
      problem('OpenCode is not answering', S.cfgError,
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', onclick: retryConfig,
        }, 'Try again'))));
  } else if (!S.cfg.configured) {
    view = top(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Assistant'),
      problem('OpenCode is not configured',
        'Set OPENCODE_URL for this module to an `opencode serve` instance.')));
  } else if (S.id || S.tab === 'chat') {
    view = detailPane();
  } else if (S.tab === 'new') {
    view = newPane();
  } else {
    view = listPane();
  }
  host.replaceChildren(view);
  const t = host.querySelector('.ag-as-transcript');
  if (t) t.scrollTop = t.scrollHeight;
}

/* ── lifecycle ──────────────────────────────────────────────────────── */

export async function mountAssistant(el0, context) {
  ctx = context;
  mode = 'view';
  host = el0;
  S.msgs = null;
  S.busy = false;
  S.error = null;
  ensureIcons();
  ensureAssistantIcon();
  loadCss();
  await loadConfig();
  routeAssistant();
}

export function unmountAssistant() {
  host = null;
  ctx = null;
  mode = 'view';
}

/**
 * The same view, opened as a dialog. It starts on New: a path and a title
 * are the whole of a session, and every other session is one click away in
 * Sessions. Returns a stop() for the caller to run when the dialog closes.
 */
export async function mountAssistantModal(el0, context) {
  ctx = context;
  mode = 'modal';
  host = el0;
  host.classList.add('as-chat');
  // Straight into a conversation, not into the Folder/Session form: the dialog
  // is opened to say something, and the session is made by the first message
  // it sends. `chat` with no id is exactly that state.
  S.tab = 'chat';
  S.id = null;
  S.one = null;
  S.msgs = [];
  S.busy = false;
  S.error = null;
  S.fallback = false;
  S.draft = '';
  S.sessions = null;
  ensureIcons();
  ensureAssistantIcon();
  loadCss();
  await loadConfig();
  paint();
  if (S.cfg?.configured) {
    await loadSessions();
    paint();
    // Land on the words: the whole point of the dialog is to type in it.
    host.querySelector('.ag-as-input')?.focus();
  }
  return () => {
    host = null;
    ctx = null;
    mode = 'view';
  };
}

