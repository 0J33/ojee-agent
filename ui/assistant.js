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
  tab: 'sessions',        // 'sessions' | 'new'
  model: null,            // the model that answered last
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

/* ── data ───────────────────────────────────────────────────────────── */

async function loadConfig() {
  try {
    S.cfg = await api('/assistant/config');
    S.cfgError = null;
    S.model = S.cfg?.model || S.model;
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
  if (!text || !S.id || S.busy) return;
  S.busy = true;
  S.error = null;
  S.draft = '';
  paint();
  try {
    const r = await post(`/assistant/sessions/${encodeURIComponent(S.id)}/message`,
      { text, ...(S.pick ? { model: S.pick } : {}) });
    // Whatever answered becomes the model we are on. If the pick refused and
    // the fallback replied, staying on the exhausted model would only buy the
    // same refusal on the next message.
    if (r.model) {
      S.model = r.model;
      if (S.pick !== r.model) { S.pick = r.model; pref('ag-as-model', r.model); }
    }
    await loadMsgs();
  } catch (e) {
    // Hand the text back: losing what you typed to a dead gateway is the
    // one failure a chat window must not commit.
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
  return el('div', { class: 'segctl ag-as-tabs', role: 'group', 'aria-label': 'Assistant' },
    el('button', {
      type: 'button',
      'aria-pressed': String(S.tab === 'sessions' && !S.id),
      onclick: showSessions,
    }, 'Sessions'),
    el('button', {
      type: 'button',
      'aria-pressed': String(S.tab === 'new'),
      onclick: showNew,
    }, 'New'));
}

function bar() {
  return el('div', { class: 'ag-as-bar' }, tabs(), modelPicker());
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

function sessionRow(s) {
  return el('button', {
    class: 'ag-as-row',
    type: 'button',
    onclick: () => openSession(s.id),
  },
  el('span', { class: 'ag-as-row-main' },
    el('span', { class: 'ag-as-row-title' }, s.title || s.slug || s.id),
    el('span', { class: 'ag-as-row-sub' }, s.directory || '/')),
  el('span', { class: 'ag-as-row-when meta' }, clock(s.time?.updated)));
}

function listPane() {
  const retry = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: async () => { S.sessions = null; paint(); await loadSessions(); paint(); },
  }, 'Try again');

  if (S.sessions === null) {
    return el('section', { class: 'panel stack' },
      el('span', { class: 'skeleton', style: 'height:18px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:120px;display:block' }));
  }
  if (S.error && !S.sessions.length) {
    return el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Sessions'),
      problem('OpenCode is not answering', S.error, retry));
  }
  if (!S.sessions.length) {
    return el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Sessions'),
      problem(S.dir ? 'No session in that path' : 'No sessions yet',
        S.dir
          ? 'Nothing has been opened there. Change the path, or clear it to see every session.'
          : 'Open one under New — a path and a title are all a session takes.',
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: showNew }, 'New session')));
  }
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Sessions'),
      el('span', { class: 'meta' }, `${S.sessions.length} ${S.sessions.length === 1 ? 'session' : 'sessions'}`)),
    filterRow(),
    el('div', { class: 'ag-as-list' }, S.sessions.map(sessionRow)));
}

function newPane() {
  return el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'New session'),
    el('div', { class: 'field' },
      el('label', {}, 'Path'),
      pathRow(openNew),
      el('span', { class: 'help' }, 'Where the session runs. Fixed once it is open — opencode will not move a live one.')),
    el('div', { class: 'field' },
      el('label', {}, 'Title (optional)'),
      el('input', {
        class: 'input',
        value: S.title,
        maxlength: '120',
        oninput: (e) => { S.title = e.target.value; },
      })),
    S.error ? problem('Could not open a session', S.error) : null,
    el('div', { class: 'ag-as-start' },
      el('span', { class: 'meta' },
        'The model chosen in the bar answers first. If it cannot, the next one picks up the reply.'),
      el('button', {
        class: 'btn', type: 'button', disabled: S.busy || undefined, onclick: openNew,
      }, S.busy ? 'Opening…' : 'Open session')));
}

const textOf = (m) => (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

function bubble(m) {
  const text = textOf(m);
  const tools = (m.parts || []).filter((p) => p.type === 'tool' && p.tool).map((p) => p.tool);
  if (m.info?.role === 'user') {
    return el('div', { class: 'ag-as-msg ag-as-msg--user' },
      el('span', { class: 'ag-as-who' }, 'you'),
      el('div', { class: 'ag-as-text' }, text));
  }
  // The model tag is the answer to "which one actually replied" — the whole
  // point of the fallback, so it travels with the reply rather than only
  // living in the bar while you are reading the message.
  return el('div', { class: 'ag-as-msg ag-as-msg--bot' },
    el('span', { class: 'ag-as-who' }, 'assistant'),
    text ? el('div', { class: 'ag-as-text' }, text) : null,
    tools.length ? el('div', { class: 'ag-as-tools meta' }, tools.map((t) => `› ${t}`).join('  ')) : null,
    m.info?.modelID ? el('div', { class: 'ag-as-model meta' }, m.info.modelID) : null);
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
    return el('div', { class: 'ag-as-transcript is-empty' },
      el('span', { class: 'meta' }, 'Nothing here yet. Say something.'));
  }
  return el('div', { class: 'ag-as-transcript' }, shown.map(bubble));
}

function composer() {
  const box = el('textarea', {
    class: 'textarea ag-as-input',
    rows: '3',
    placeholder: 'Ask the Assistant…',
    'aria-label': 'Message',
    oninput: (e) => { S.draft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    },
  });
  box.value = S.draft;
  return el('div', { class: 'ag-as-compose' },
    S.error && S.msgs?.length ? el('div', { class: 'ag-as-err meta' }, S.error) : null,
    el('div', { class: 'ag-as-compose-bar' },
      box,
      el('button', {
        class: 'btn', type: 'button', disabled: S.busy || undefined, onclick: send,
      }, S.busy ? 'Thinking…' : 'Send')),
    el('div', { class: 'ag-as-note meta' },
      // The model is stated by the picker in the bar, so naming it again here
      // would be the same fact twice; the waiting line is the one worth saying.
      S.busy ? 'waiting — if this model cannot answer, the next one will'
        : 'Enter sends, Shift+Enter makes a new line'));
}

function detailPane() {
  // The list is what names a session; `S.one` is the same session fetched on
  // its own when a link reached the transcript before the list did.
  const s = (S.sessions || []).find((x) => x.id === S.id)
    || (S.one?.id === S.id ? S.one : null);
  return el('section', { class: 'ag-as-detail' },
    el('div', { class: 'ag-as-head' },
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', onclick: showSessions,
      }, '← Sessions'),
      el('span', { class: 'ag-as-head-main' },
        el('span', { class: 'ag-as-title' }, s?.title || S.id || ''),
        s?.directory ? el('span', { class: 'ag-as-path meta' }, s.directory) : null)),
    transcript(),
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

function paint() {
  if (!host) return;
  const parts = [bar()];
  if (!S.cfg) {
    parts.push(el('section', { class: 'panel stack' },
      el('span', { class: 'skeleton', style: 'height:18px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:160px;display:block' })));
  } else if (S.cfgError) {
    // Not answering and not configured are different facts with different
    // fixes — one wants a button, the other wants an environment variable.
    // This branch used to report them as one, so a blip told the reader to go
    // change a setting that was already right.
    parts.push(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Assistant'),
      problem('OpenCode is not answering', S.cfgError,
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', onclick: retryConfig,
        }, 'Try again'))));
  } else if (!S.cfg.configured) {
    parts.push(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Assistant'),
      problem('OpenCode is not configured',
        'Set OPENCODE_URL for this module to an `opencode serve` instance.')));
  } else if (S.id) {
    parts.push(detailPane());
  } else if (S.tab === 'new') {
    parts.push(newPane());
  } else {
    parts.push(listPane());
  }
  host.replaceChildren(...parts);
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
  S.tab = 'new';
  S.id = null;
  S.msgs = null;
  S.busy = false;
  S.error = null;
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
  }
  return () => {
    host = null;
    ctx = null;
    mode = 'view';
  };
}

