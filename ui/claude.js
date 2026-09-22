/* ============================================================
   ojee-agent — the Claude view.

   Unattended Claude Code sessions on the host, through the runner
   (claude-runner/ in this repo). Four places, one row of tabs:

     Sessions   what is running, what needs you, and every other
                conversation on the machine
     New        a folder anywhere on the box, a prompt, a model
     Accounts   the Claude logins, which one is active, which are
                out and until when — and logging one in
     Settings   default and fallback model, auto-switch, pings

   A session opens to its REAL terminal (tmux attach, the same
   one you would get typing `claude` in a shell there), with a
   readable transcript beside it and a message box under both.

   Routes live under the view: #/agent/claude/<rest>, where rest
   is '', 'new', 'accounts', 'settings' or a session id. The
   console only reads the first two segments, so a deep link from
   a Discord ping opens straight to the session.
   ============================================================ */

import { startTerminal } from './claude-term.js';
import { ensureIcons } from './claude-icons.js';

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

let ctx = null;
let root = null;
let sse = null;

const S = {
  data: null,           // { sessions, accounts, settings, models, notify, runner }
  error: null,
  tab: 'sessions',
  detail: null,         // session id when a session is open
  history: null,
  historyOpen: false,
  fs: null,
  hidden: false,
  form: null,
  pane: 'terminal',     // 'terminal' | 'transcript' in a session
  term: null,
  termState: null,
  transcript: { id: null, messages: [], cursor: null, timer: null, truncated: false },
  login: null,          // { id, state, timer, term }
  busy: new Set(),
  // Per-viewer layout, remembered in this browser only.
  compose: pref('ag-cl-compose') === '1',   // the message box (the terminal is the way in)
  max: pref('ag-cl-max') === '1',           // the session filling the window
};

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window, blocked storage: the default layout it is */ }
  return null;
}

/* ── small pieces ───────────────────────────────────────────────────── */

const svg = (name, cls = 'ic') => {
  const t = document.createElement('template');
  t.innerHTML = ctx.icon(`i-${name}`, cls);
  return t.content.firstChild;
};

const api = (path, opts = {}) => ctx.api(`/claude${path}`, opts);
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

const STATE = {
  queued: { label: 'queued', dot: null },
  starting: { label: 'starting', dot: 'info' },
  running: { label: 'working', dot: 'live' },
  idle: { label: 'idle', dot: 'ok' },
  waiting: { label: 'needs you', dot: 'warn' },
  blocked: { label: 'blocked', dot: 'warn' },
  done: { label: 'done', dot: 'ok' },
  paused: { label: 'paused', dot: 'warn' },
  error: { label: 'error', dot: 'err' },
  stopped: { label: 'stopped', dot: null },
};
// A plain .dot is the design system's dim one: nothing running, nothing wrong.
const dot = (state) => el('span', { class: STATE[state]?.dot ? `dot dot--${STATE[state].dot}` : 'dot' });
const stateTag = (state) => el('span', { class: `ag-cl-state ag-cl-state--${state}` }, STATE[state]?.label || state);

const modelLabel = (id) => S.data?.models?.find((m) => m.id === id)?.label || id || '—';
const acctLabel = (id) => S.data?.accounts?.find((a) => a.id === id)?.label || id || '—';

const ago = (ms) => (ms ? ctx.relTime(ms) : '—');
const at = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const same = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return same ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
};
const shortPath = (p) => {
  const home = S.data?.runner?.home;
  return home && p?.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

function sub() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const i = parts.indexOf('claude');
  return i >= 0 ? parts.slice(i + 1).filter(Boolean).map(decodeURIComponent) : [];
}

function go(...segs) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const i = parts.indexOf('claude');
  const prefix = i >= 0 ? parts.slice(0, i + 1) : [...parts, 'claude'];
  const next = `#/${[...prefix, ...segs.map(encodeURIComponent)].join('/')}`;
  if (location.hash !== next) location.hash = next;
  else routeClaude();
}

async function act(key, fn, ok) {
  if (S.busy.has(key)) return null;
  S.busy.add(key);
  paint();
  try {
    const r = await fn();
    if (ok) ctx.toast?.('ok', ok);
    return r;
  } catch (e) {
    ctx.toast?.('err', 'That did not work', e.message);
    return null;
  } finally {
    S.busy.delete(key);
    paint();
  }
}

const problem = (title, detail, action) => el('div', { class: 'ag-problem' },
  el('strong', {}, title), detail ? el('p', { class: 'meta' }, detail) : null, action || null);

/* ── data ───────────────────────────────────────────────────────────── */

function upsert(v) {
  if (!S.data) return;
  const i = S.data.sessions.findIndex((s) => s.id === v.id);
  if (i >= 0) S.data.sessions[i] = v; else S.data.sessions.unshift(v);
}

const session = (id) => S.data?.sessions?.find((s) => s.id === id) || null;

async function load() {
  try {
    S.data = await api('/state');
    S.error = null;
  } catch (e) {
    S.error = e.message;
  }
}

function listen() {
  sse?.stop();
  sse = ctx.sse('/claude/events', {
    events: {
      state: (d) => { S.data = d; S.error = null; paint(); },
      session: (v) => { upsert(v); paint('session'); },
      removed: ({ id }) => {
        if (S.data) S.data.sessions = S.data.sessions.filter((s) => s.id !== id);
        if (S.detail === id) go();
        else paint();
      },
      accounts: ({ accounts, settings }) => {
        if (!S.data) return;
        S.data.accounts = accounts;
        S.data.settings = settings;
        paint('accounts');
      },
    },
    onError: () => { /* reconnects on its own; the last state stays on screen */ },
  });
}

/* ── the shell of the view ──────────────────────────────────────────── */

const TABS = [['sessions', 'Sessions'], ['new', 'New'], ['accounts', 'Accounts'], ['settings', 'Settings']];

function tabs() {
  const active = S.detail ? 'sessions' : S.tab;
  return el('div', { class: 'segctl ag-cl-tabs', role: 'group', 'aria-label': 'Claude' },
    TABS.map(([id, label]) => el('button', {
      type: 'button',
      'aria-pressed': String(active === id),
      onclick: () => (id === 'sessions' ? go() : go(id)),
    }, label)));
}

/**
 * Repaint what the current place shows. `reason` lets a live update skip the
 * parts that must not be rebuilt under the user — a form being filled in, a
 * terminal, a transcript being read.
 */
function paint(reason) {
  if (!root) return;
  if (S.error && !S.data) {
    root.replaceChildren(el('section', { class: 'stack-lg' },
      tabs(),
      el('section', { class: 'panel stack' },
        el('h3', { class: 'h3' }, 'Claude'),
        problem('The Claude runner is not answering', S.error,
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { await load(); paint(); } }, 'Try again')))));
    return;
  }
  if (!S.data) {
    root.replaceChildren(el('div', { class: 'stack-lg' },
      el('span', { class: 'skeleton', style: 'height:44px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:220px;display:block' })));
    return;
  }

  if (S.detail) return paintDetail(reason);
  if (S.tab === 'new') { if (reason) return; return paintNew(); }
  if (S.tab === 'settings') { if (reason === 'session') return; return paintSettings(); }
  if (S.tab === 'accounts') return paintAccounts(reason);
  return paintSessions();
}

/* ── sessions ───────────────────────────────────────────────────────── */

function sessionRow(s) {
  const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
  return el('button', { class: `ag-cl-row ag-cl-srow ${['error'].includes(s.state) ? 'is-bad' : ''}`, type: 'button', onclick: () => go(s.id) },
    dot(s.state),
    el('span', { class: 'ag-cl-srow-main' },
      el('span', { class: 'ag-cl-srow-title' }, s.title || s.id.slice(0, 8)),
      el('span', { class: 'ag-cl-srow-sub' },
        shortPath(s.cwd), ' · ', modelLabel(s.model?.current), fell ? ' (fallback)' : '', ' · ', acctLabel(s.account))),
    stateTag(s.state),
    el('span', { class: 'meta ag-cl-srow-when' }, ago(s.lastActivityAt)));
}

function paintSessions() {
  const { sessions, accounts, settings } = S.data;
  const live = sessions.filter((s) => !['stopped'].includes(s.state));
  const ended = sessions.filter((s) => s.state === 'stopped');
  const needs = sessions.filter((s) => ['waiting', 'blocked', 'error'].includes(s.state));
  const working = sessions.filter((s) => ['running', 'starting'].includes(s.state));
  const paused = sessions.filter((s) => s.state === 'paused');
  const active = accounts.find((a) => a.id === settings.activeAccount);

  const verdict = el('div', { class: 'ag-verdict ag-cl-verdict' },
    dot(needs.length ? 'waiting' : working.length ? 'running' : 'idle'),
    el('strong', {}, needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you`
      : working.length ? `${working.length} working` : live.length ? 'nothing working right now' : 'no sessions'),
    el('span', { class: 'meta' },
      [working.length && needs.length ? `${working.length} working` : null,
        paused.length ? `${paused.length} paused` : null,
        active ? `on ${active.label}${active.status !== 'ok' ? ` (${active.status})` : ''}` : null].filter(Boolean).join(' · ')),
    el('button', { class: 'btn btn--sm ag-cl-verdict-new', type: 'button', onclick: () => go('new') }, svg('plus'), 'New session'));

  const wrap = el('section', { class: 'stack-lg' }, tabs(), verdict);

  if (needs.length) {
    wrap.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Needs you'),
      el('div', { class: 'ag-cl-list' }, needs.map((s) => el('button', { class: 'ag-cl-row ag-cl-need', type: 'button', onclick: () => go(s.id) },
        dot(s.state),
        el('span', { class: 'ag-cl-srow-main' },
          el('span', { class: 'ag-cl-srow-title' }, s.title),
          el('span', { class: 'ag-cl-need-q' }, s.question?.text || s.detail || s.lastError?.text || '')),
        stateTag(s.state))))));
  }

  wrap.append(el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Sessions'),
      el('span', { class: 'meta' }, `${live.length} open${ended.length ? ` · ${ended.length} ended` : ''}`)),
    live.length
      ? el('div', { class: 'ag-cl-list' }, live.map(sessionRow))
      : el('div', { class: 'empty' },
        svg('terminal'),
        el('b', {}, 'No sessions'),
        el('p', {}, 'Start one in any folder on this machine. It runs unattended with bypass permissions and pings Discord when it needs you.'),
        el('button', { class: 'btn btn--sm', type: 'button', onclick: () => go('new') }, 'New session')),
    ended.length ? el('details', { class: 'ag-cl-ended' },
      el('summary', { class: 'meta' }, `Ended (${ended.length})`),
      el('div', { class: 'ag-cl-list' }, ended.map(sessionRow))) : null));

  const hist = el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Other conversations on this machine'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: async () => {
          S.historyOpen = !S.historyOpen;
          if (S.historyOpen && !S.history) S.history = await api('/history').then((r) => r.sessions).catch((e) => ({ error: e.message }));
          paint();
        },
      }, S.historyOpen ? 'Hide' : 'Show')));
  if (S.historyOpen) {
    if (!S.history) hist.append(el('span', { class: 'skeleton', style: 'height:80px;display:block' }));
    else if (S.history.error) hist.append(problem('Could not list conversations', S.history.error));
    else {
      const others = S.history.filter((h) => !h.managed);
      hist.append(others.length
        ? el('div', { class: 'ag-cl-list' }, others.map((h) => el('div', { class: 'ag-cl-row ag-cl-hrow' },
          el('span', { class: 'ag-cl-srow-main' },
            el('span', { class: 'ag-cl-srow-title' }, h.title || h.firstPrompt || h.id.slice(0, 8)),
            el('span', { class: 'ag-cl-srow-sub' }, shortPath(h.cwd || '?'), ' · ', ago(h.modified),
              h.runningElsewhere ? ' · running in a terminal' : '')),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            disabled: S.busy.has(`adopt:${h.id}`),
            onclick: async () => {
              const v = await act(`adopt:${h.id}`, () => post(`/history/${h.id}/adopt`, {}));
              if (v) { upsert(v); S.history = null; go(v.id); }
            },
          }, 'Open'))))
        : el('p', { class: 'meta' }, 'Every conversation on this machine is already listed above.'));
      hist.append(el('p', { class: 'meta' }, 'Opening one here lets you resume it, read it and message it — the same conversation, not a copy.'));
    }
  }
  wrap.append(hist);
  root.replaceChildren(wrap);
}

/* ── one session ────────────────────────────────────────────────────── */

function detailHead(s) {
  const alive = s.alive;
  const busy = (k) => S.busy.has(`${k}:${s.id}`);
  const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
  const actual = s.model?.actual && s.model.actual !== s.model.current ? s.model.actual : null;
  return el('header', { class: 'ag-cl-head' },
    el('button', { class: 'iconbtn', type: 'button', title: 'All sessions', 'aria-label': 'All sessions', onclick: () => go() }, svg('back')),
    el('div', { class: 'ag-cl-head-main' },
      el('button', { class: 'ag-cl-title', type: 'button', title: 'Rename', onclick: () => rename(s) }, s.title),
      el('div', { class: 'ag-cl-chips' },
        stateTag(s.state),
        el('span', { class: 'ag-cl-chip', title: 'Model' }, modelLabel(s.model?.current), fell ? ' · fallback' : '', actual ? ` (answered by ${modelLabel(actual)})` : ''),
        el('span', { class: 'ag-cl-chip', title: 'Account' }, acctLabel(s.account)),
        el('span', { class: 'ag-cl-chip ag-cl-chip--path', title: s.cwd }, shortPath(s.cwd)))),
    el('div', { class: 'ag-cl-head-actions' },
      s.state === 'running' ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Interrupt the current turn (Esc)', onclick: () => act(`int:${s.id}`, () => post(`/sessions/${s.id}/interrupt`)) }, svg('pause'), 'Stop turn') : null,
      !alive || s.state === 'paused'
        ? el('button', { class: 'btn btn--sm', type: 'button', disabled: busy('resume'), onclick: () => act(`resume:${s.id}`, () => post(`/sessions/${s.id}/resume`, {}).then(upsert), 'Resuming') }, svg('play'), s.state === 'paused' ? 'Resume now' : 'Resume')
        : null,
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => changeSession(s) }, svg('swap'), 'Change'),
      alive ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: busy('end'), onclick: () => endSession(s) }, svg('stop'), 'End') : null,
      el('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', title: 'Delete', 'aria-label': 'Delete', onclick: () => deleteSession(s) }, svg('trash'))));
}

function detailCallouts(s) {
  const out = [];
  if (s.state === 'waiting' && s.question) {
    out.push(el('div', { class: 'alert alert--warn ag-cl-q' }, el('b', {}, 'Asking'),
      el('span', {}, el('span', { class: 'ag-cl-pre' }, s.question.text),
        el('span', { class: 'meta ag-cl-hint' }, S.compose
          ? 'Answer in the terminal, or with the message box — a message dismisses the question and becomes the answer.'
          : 'Answer in the terminal.'))));
  } else if (s.state === 'blocked') {
    out.push(el('div', { class: 'alert alert--warn' }, el('b', {}, 'Blocked'), el('span', {}, s.detail || '')));
  } else if (s.state === 'paused') {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Paused'),
      el('span', {}, `${s.detail || 'Out of usage'} — resumes on its own at ${at(s.pausedUntil)}.`)));
  } else if (s.state === 'error') {
    out.push(el('div', { class: 'alert alert--err' }, el('b', {}, 'Error'), el('span', {}, s.detail || s.lastError?.text || '')));
  } else if (s.state === 'done') {
    out.push(el('div', { class: 'alert alert--ok' }, el('b', {}, 'Done'), el('span', {}, s.detail || '')));
  } else if (s.state === 'queued') {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Queued'), el('span', {}, s.detail || 'Waiting for a free slot.')));
  } else if (s.state === 'starting' && s.detail) {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Starting'), el('span', {}, s.detail)));
  }
  return out;
}

function paintDetail(reason) {
  const s = session(S.detail);
  if (!s) {
    root.replaceChildren(el('section', { class: 'stack-lg' }, tabs(),
      el('section', { class: 'panel stack' }, problem('No such session', 'It may have been deleted.',
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go() }, 'All sessions')))));
    return;
  }

  // Live updates rebuild only the head and the callouts. The terminal, the
  // transcript and a half-typed message stay exactly as they are.
  const existing = root.querySelector(`[data-session="${s.id}"]`);
  if (existing) {
    existing.querySelector('.ag-cl-headwrap').replaceChildren(detailHead(s));
    existing.querySelector('.ag-cl-callouts').replaceChildren(...detailCallouts(s));
    existing.querySelector('.ag-cl-maxbar').replaceChildren(...maxBar(s));
    updateComposer(s);
    // A session that came back (resumed, relaunched into a new tmux session)
    // gets its terminal back; one that is gone gets the "not running" card.
    if (S.pane === 'terminal') {
      const dead = !S.term || ['closed', 'error', 'disconnected'].includes(S.termState);
      if (s.alive && dead) mountPane(s);
      else if (!s.alive && !S.term && !existing.querySelector('.ag-cl-noterm')) mountPane(s);
    }
    return;
  }

  stopPane();
  const text = el('textarea', {
    class: 'textarea ag-cl-input',
    rows: '3',
    placeholder: 'Message Claude — Ctrl+Enter to send',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(s.id); } },
  });
  const view = el('section', {
    class: `stack ag-cl-detail${S.max ? ' is-max' : ''}${S.compose ? ' has-compose' : ''}`,
    'data-session': s.id,
  },
    tabs(),
    el('div', { class: 'ag-cl-maxbar' }, ...maxBar(s)),
    el('div', { class: 'ag-cl-headwrap' }, detailHead(s)),
    el('div', { class: 'ag-cl-callouts' }, ...detailCallouts(s)),
    el('div', { class: 'ag-cl-panes' }, ...paneTabs(s)),
    el('div', { class: 'ag-cl-body' }),
    el('div', { class: 'ag-cl-compose', hidden: !S.compose },
      text,
      el('div', { class: 'ag-cl-compose-bar' },
        el('span', { class: 'meta ag-cl-compose-note' }),
        el('button', { class: 'btn btn--sm ag-cl-send', type: 'button', onclick: () => send(s.id) }, 'Send'))));
  root.replaceChildren(view);
  lockPage();
  updateComposer(s);
  mountPane(s);
}

/**
 * Maximized: the session takes the whole window — not the browser's
 * fullscreen, just everything the console draws around the view covered —
 * with a switcher to hop between sessions and a way back. The console's
 * chrome is not touched; the view is lifted over it (fixed, above the nav
 * and tab bar, below dialogs and toasts so Rename and Delete still work).
 */
function maxBar(s) {
  const others = (S.data?.sessions || [])
    .filter((x) => x.id === s.id || x.state !== 'stopped')
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return [
    el('button', { class: 'btn btn--sm ag-cl-restore', type: 'button', title: 'Back to the normal view', onclick: () => setMax(false) }, svg('unfull'), 'Restore'),
    el('div', { class: 'ag-cl-switch', role: 'group', 'aria-label': 'Sessions' },
      others.map((x) => el('button', {
        class: `ag-cl-switch-item${x.id === s.id ? ' is-current' : ''}`,
        type: 'button',
        title: `${x.title} — ${STATE[x.state]?.label || x.state}`,
        'aria-current': x.id === s.id ? 'true' : null,
        onclick: () => { if (x.id !== s.id) go(x.id); },
      }, dot(x.state), el('span', {}, x.title)))),
  ];
}

function setMax(on) {
  S.max = on;
  pref('ag-cl-max', on ? '1' : '0');
  const view = root?.querySelector('.ag-cl-detail');
  view?.classList.toggle('is-max', on);
  const s = session(S.detail);
  if (view && s) view.querySelector('.ag-cl-panes').replaceChildren(...paneTabs(s));
  lockPage();
  S.term?.focus();
}

/** While maximized, the page behind must not scroll under the wheel. */
function lockPage() {
  const on = S.max && !!S.detail && !!root?.querySelector('.ag-cl-detail.is-max');
  document.documentElement.style.overflow = on ? 'hidden' : '';
}

function setCompose(on) {
  S.compose = on;
  pref('ag-cl-compose', on ? '1' : '0');
  const view = root?.querySelector('.ag-cl-detail');
  if (!view) return;
  view.classList.toggle('has-compose', on);
  const box = view.querySelector('.ag-cl-compose');
  box.hidden = !on;
  const s = session(S.detail);
  if (s) {
    view.querySelector('.ag-cl-panes').replaceChildren(...paneTabs(s));
    view.querySelector('.ag-cl-callouts').replaceChildren(...detailCallouts(s));
  }
  if (on) box.querySelector('.ag-cl-input')?.focus();
}

function paneTabs(s) {
  return [
    el('div', { class: 'segctl ag-cl-pane-tabs', role: 'group', 'aria-label': 'View' },
      el('button', { type: 'button', 'aria-pressed': String(S.pane === 'terminal'), onclick: () => switchPane('terminal') }, svg('terminal'), 'Terminal'),
      el('button', { type: 'button', 'aria-pressed': String(S.pane === 'transcript'), onclick: () => switchPane('transcript') }, svg('log'), 'Transcript')),
    el('div', { class: 'ag-cl-term-bar' },
      S.pane === 'terminal' ? el('span', { class: 'meta ag-cl-term-state' }, S.termState || (s.alive ? 'connecting…' : 'not running')) : null,
      S.pane === 'terminal' ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Special keys', onclick: () => S.term?.toggleKeys() }, svg('keyboard'), 'Keys') : null,
      S.pane === 'terminal' ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => S.term?.reconnect() }, svg('refresh'), 'Reconnect') : null,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        'aria-pressed': String(S.compose),
        title: S.compose ? 'Hide the message box' : 'Show a message box under the terminal',
        onclick: () => setCompose(!S.compose),
      }, svg('edit'), S.compose ? 'Hide message' : 'Message'),
      S.max ? null : el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Fill the window with this session', onclick: () => setMax(true) }, svg('full'), 'Maximize')),
  ];
}

function switchPane(pane) {
  const s = session(S.detail);
  if (!s) return;
  S.pane = pane;
  root.querySelector('.ag-cl-panes')?.replaceChildren(...paneTabs(s));
  mountPane(s);
}

function stopPane() {
  S.term?.teardown();
  S.term = null;
  clearTimeout(S.transcript.timer);
  S.transcript.timer = null;
}

function mountPane(s) {
  const body = root.querySelector('.ag-cl-body');
  if (!body) return;
  stopPane();
  if (S.pane === 'terminal') {
    if (!s.alive) {
      body.replaceChildren(el('div', { class: 'empty ag-cl-noterm' },
        svg('terminal'),
        el('b', {}, 'Not running'),
        el('p', {}, s.state === 'paused'
          ? `Paused until ${at(s.pausedUntil)}. It starts again on its own; "Resume now" tries sooner.`
          : 'The conversation is kept. Resume it to get the terminal back, or read the transcript.')));
      return;
    }
    S.termState = 'connecting';
    S.term = startTerminal({
      host: body,
      ctx,
      path: `/sessions/${s.id}/terminal`,
      onState: (st, detail) => {
        S.termState = st;
        const stateEl = root?.querySelector('.ag-cl-term-state');
        if (stateEl) stateEl.textContent = detail ? `${st} · ${detail}` : st;
      },
    });
    return;
  }
  // Transcript
  if (S.transcript.id !== s.id) S.transcript = { id: s.id, messages: [], cursor: null, timer: null, truncated: false };
  const list = el('div', { class: 'ag-cl-transcript' });
  body.replaceChildren(list);
  const pull = async () => {
    try {
      const q = S.transcript.cursor != null ? `?cursor=${S.transcript.cursor}` : '';
      const r = await api(`/sessions/${s.id}/transcript${q}`);
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (S.transcript.cursor == null) { S.transcript.messages = r.messages; S.transcript.truncated = r.truncated; list.replaceChildren(); }
      else S.transcript.messages.push(...r.messages);
      if (S.transcript.cursor == null && r.truncated) list.append(el('p', { class: 'meta ag-cl-trunc' }, 'Earlier messages are in the file; showing the most recent.'));
      for (const m of r.messages) list.append(message(m));
      S.transcript.cursor = r.cursor;
      if (!S.transcript.messages.length && !list.children.length) list.append(el('p', { class: 'meta' }, 'Nothing yet.'));
      if (nearBottom || r.messages.length === S.transcript.messages.length) list.scrollTop = list.scrollHeight;
    } catch (e) {
      list.append(el('p', { class: 'meta' }, `Could not read the transcript: ${e.message}`));
    }
    if (S.pane === 'transcript' && S.detail === s.id && !document.hidden) S.transcript.timer = setTimeout(pull, 3000);
    else if (S.pane === 'transcript' && S.detail === s.id) S.transcript.timer = setTimeout(pull, 10000);
  };
  pull();
}

function message(m) {
  const cls = `ag-cl-msg ag-cl-msg--${m.role}${m.error ? ' is-bad' : ''}`;
  const time = m.at ? new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  if (m.role === 'user') return el('div', { class: cls }, el('span', { class: 'ag-cl-msg-who' }, 'You', el('span', { class: 'meta' }, time)), el('div', { class: 'ag-cl-pre' }, m.text));
  if (m.role === 'assistant') return el('div', { class: cls }, el('span', { class: 'ag-cl-msg-who' }, modelLabel(m.model) || 'Claude', el('span', { class: 'meta' }, time)), el('div', { class: 'ag-cl-pre' }, m.text));
  if (m.role === 'tool') return el('div', { class: cls }, el('span', { class: 'ag-cl-tool' }, m.tool), el('span', { class: 'ag-cl-tool-arg' }, m.text));
  if (m.role === 'result') {
    const first = String(m.text || '').split('\n')[0];
    return el('details', { class: cls }, el('summary', {}, first || '(no output)'), el('div', { class: 'ag-cl-pre' }, m.text));
  }
  if (m.role === 'error') return el('div', { class: `${cls} is-bad` }, el('span', { class: 'ag-cl-msg-who' }, `Request failed · ${m.kind}`), el('div', { class: 'ag-cl-pre' }, m.text));
  return el('div', { class: cls }, el('span', { class: 'meta' }, m.text));
}

function updateComposer(s) {
  const btn = root.querySelector('.ag-cl-send');
  const note = root.querySelector('.ag-cl-compose-note');
  const input = root.querySelector('.ag-cl-input');
  if (!btn || !note || !input) return;
  const busy = S.busy.has(`send:${s.id}`);
  btn.disabled = busy || s.state === 'starting';
  btn.textContent = busy ? '…' : s.alive ? 'Send' : 'Resume with this';
  input.placeholder = s.state === 'waiting' ? 'Answer Claude…' : s.alive ? 'Message Claude — Ctrl+Enter to send' : 'Resume the session with a message…';
  note.textContent = s.state === 'starting' ? 'Starting — wait a moment.'
    : s.state === 'running' ? 'Working — a message now is queued by Claude Code and read after this turn.'
      : s.state === 'queued' ? 'Queued — a message now is added to its first prompt.'
        : s.model?.current !== s.model?.preferred ? `On ${modelLabel(s.model?.current)}; the next message goes back to ${modelLabel(s.model?.preferred)} if it is available.` : '';
}

async function send(id) {
  const input = root.querySelector('.ag-cl-input');
  const text = input?.value.trim();
  if (!text) return;
  const r = await act(`send:${id}`, () => post(`/sessions/${id}/message`, { text }));
  if (r) { input.value = ''; upsert(r); paint('session'); }
}

async function rename(s) {
  const input = el('input', { class: 'input', value: s.title, maxlength: '70' });
  const ok = await ctx.modal({ title: 'Rename session', body: el('div', { class: 'field' }, el('label', {}, 'Title'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }] });
  if (!ok || !input.value.trim()) return;
  const v = await act(`rename:${s.id}`, () => api(`/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ title: input.value.trim() }) }));
  if (v) { upsert(v); paint('session'); }
}

async function endSession(s) {
  const ok = await ctx.modal({ title: 'End this session?', body: el('p', { class: 'meta' }, 'Claude stops. The conversation is kept and can be resumed later.'), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'End', value: true }] });
  if (!ok) return;
  const v = await act(`end:${s.id}`, () => post(`/sessions/${s.id}/end`));
  if (v) { upsert(v); paintDetail(); mountPane(v); }
}

async function deleteSession(s) {
  const purge = el('input', { type: 'checkbox' });
  const ok = await ctx.modal({
    title: 'Delete this session?',
    body: el('div', { class: 'stack' },
      el('p', { class: 'meta' }, 'It is ended and removed from this list.'),
      el('label', { class: 'check' }, purge, el('span', {}, 'Also delete the conversation itself (cannot be undone)'))),
    actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Delete', value: true, variant: 'danger' }],
  });
  if (!ok) return;
  const r = await act(`del:${s.id}`, () => api(`/sessions/${s.id}${purge.checked ? '?purge=1' : ''}`, { method: 'DELETE' }), 'Deleted');
  if (r) { S.data.sessions = S.data.sessions.filter((x) => x.id !== s.id); go(); }
}

function modelSelect(value, { allowNone = false } = {}) {
  const sel = el('select', { class: 'select' },
    allowNone ? el('option', { value: '' }, 'None') : null,
    S.data.models.map((m) => el('option', { value: m.id }, m.label)));
  sel.value = value || '';
  return sel;
}

function accountSelect(value) {
  const sel = el('select', { class: 'select' }, S.data.accounts.map((a) => el('option', { value: a.id },
    `${a.label}${a.email ? ` · ${a.email}` : ''}${a.status !== 'ok' ? ` (${a.status === 'limited' ? `out until ${at(a.limitedUntil)}` : a.status})` : ''}`)));
  sel.value = value;
  return sel;
}

async function changeSession(s) {
  const model = modelSelect(s.model?.preferred);
  const fallback = modelSelect(s.model?.fallback, { allowNone: true });
  const account = accountSelect(s.account);
  const done = el('select', { class: 'select' },
    el('option', { value: 'default' }, `Use the setting (${S.data.settings.notify?.done ? 'on' : 'off'})`),
    el('option', { value: 'on' }, 'On'), el('option', { value: 'off' }, 'Off'));
  done.value = s.notifyDone === true ? 'on' : s.notifyDone === false ? 'off' : 'default';
  const nudges = el('input', { class: 'input', type: 'number', min: '0', max: '10', value: String(s.autoContinue || 0) });
  const ok = await ctx.modal({
    title: 'Change this session',
    body: el('div', { class: 'stack' },
      el('div', { class: 'field' }, el('label', {}, 'Model'), model),
      el('div', { class: 'field' }, el('label', {}, 'Fallback when it runs out'), fallback),
      el('div', { class: 'field' }, el('label', {}, 'Account'), account),
      el('div', { class: 'field' }, el('label', {}, 'Ping when done'), done),
      el('div', { class: 'field' }, el('label', {}, 'Nudge to continue'), nudges,
        el('span', { class: 'help' }, 'times to say “continue” when a turn ends without DONE or BLOCKED')),
      s.alive ? el('p', { class: 'meta' }, 'A different model or account restarts Claude and resumes this same conversation.') : null),
    actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }],
  });
  if (!ok) return;
  await act(`change:${s.id}`, async () => {
    const patch = {
      model: { preferred: model.value, fallback: fallback.value || null },
      notifyDone: done.value === 'on' ? true : done.value === 'off' ? false : null,
      autoContinue: Number(nudges.value) || 0,
    };
    const moveModel = model.value !== s.model?.current;
    const moveAcct = account.value !== s.account;
    // Not running: the account is only recorded, and used at the next start.
    if (!s.alive && moveAcct) patch.account = account.value;
    let v = await api(`/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if ((moveModel || moveAcct) && s.alive) {
      v = await post(`/sessions/${s.id}/relaunch`, { model: moveModel ? model.value : undefined, account: moveAcct ? account.value : undefined });
    }
    upsert(v);
    paint('session');
  }, 'Saved');
}

/* ── new session ────────────────────────────────────────────────────── */

async function browse(p) {
  const q = new URLSearchParams();
  if (p) q.set('path', p);
  if (S.hidden) q.set('hidden', '1');
  try {
    S.fs = await api(`/fs?${q}`);
  } catch (e) {
    S.fs = { ...(S.fs || {}), error: e.message };
  }
  if (S.form && S.fs.path && !S.fs.error) S.form.cwd = S.fs.path;
  paintBrowser();
}

function crumbs(p) {
  const parts = p.split('/').filter(Boolean);
  const out = [el('button', { class: 'ag-cl-crumb', type: 'button', onclick: () => browse('/') }, '/')];
  let acc = '';
  parts.forEach((part, i) => {
    acc += `/${part}`;
    const target = acc;
    out.push(el('button', { class: 'ag-cl-crumb', type: 'button', onclick: () => browse(target), 'aria-current': i === parts.length - 1 ? 'location' : null }, part));
    if (i < parts.length - 1) out.push(el('span', { class: 'ag-cl-crumb-sep' }, '/'));
  });
  return out;
}

function paintBrowser() {
  const host = root?.querySelector('.ag-cl-browser');
  if (!host || !S.fs) return;
  const f = S.fs;
  const pathInput = root.querySelector('.ag-cl-cwd');
  if (pathInput && f.path && document.activeElement !== pathInput) pathInput.value = f.path;
  // replaceChildren() would print a null as the text "null"; el() skips them.
  host.replaceChildren(...[
    el('div', { class: 'ag-cl-crumbs' }, f.path ? crumbs(f.path) : null),
    el('div', { class: 'ag-cl-browser-bar' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: !f.parent, onclick: () => browse(f.parent) }, svg('folderUp'), 'Up'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => browse(f.home) }, svg('house'), 'Home'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => mkdir() }, svg('plus'), 'New folder'),
      el('label', { class: 'check ag-cl-hidden' }, el('input', { type: 'checkbox', checked: S.hidden, onchange: (e) => { S.hidden = e.target.checked; browse(f.path); } }), el('span', {}, 'Hidden'))),
    f.error ? el('p', { class: 'meta ag-cl-err' }, f.error) : null,
    el('div', { class: 'ag-cl-dirs' },
      (f.entries || []).length
        ? f.entries.map((d) => el('button', { class: 'ag-cl-dir', type: 'button', onclick: () => browse(d.path), title: d.path },
          svg('folder'), el('span', {}, d.name), d.git ? el('span', { class: 'ag-cl-git' }, 'git') : null))
        : el('p', { class: 'meta' }, 'No folders here.')),
    f.truncated ? el('p', { class: 'meta' }, 'Showing the first 1000.') : null,
    (f.recent || []).length ? el('div', { class: 'ag-cl-recent' },
      el('span', { class: 'label' }, 'Recent'),
      f.recent.map((r) => el('button', { class: 'ag-cl-chip ag-cl-chip--btn', type: 'button', onclick: () => browse(r), title: r }, shortPath(r)))) : null,
  ].filter(Boolean));
}

async function mkdir() {
  const input = el('input', { class: 'input', placeholder: 'folder name' });
  const ok = await ctx.modal({ title: `New folder in ${shortPath(S.fs.path)}`, body: el('div', { class: 'field' }, el('label', {}, 'Name'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Create', value: true }] });
  const name = input.value.trim();
  if (!ok || !name) return;
  if (name.includes('/') && !name.startsWith('/')) { /* allow nested */ }
  const target = name.startsWith('/') ? name : `${S.fs.path.replace(/\/$/, '')}/${name}`;
  const r = await act('mkdir', () => post('/fs/mkdir', { path: target }));
  if (r) browse(r.path);
}

function paintNew() {
  const set = S.data.settings;
  if (!S.form) {
    S.form = { cwd: S.data.runner?.defaultCwd || '', prompt: '', title: '', model: set.defaultModel, fallback: set.fallbackModel || '', account: set.activeAccount, unattended: set.unattended !== false, notifyDone: 'default', autoContinue: 0 };
  }
  const F = S.form;
  const bind = (k, conv = (v) => v) => (e) => { F[k] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); };

  const cwd = el('input', {
    class: 'input ag-cl-cwd',
    value: F.cwd,
    placeholder: '/path/to/project',
    spellcheck: 'false',
    oninput: bind('cwd'),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(e.target.value); } },
  });
  const model = modelSelect(F.model);
  model.addEventListener('change', bind('model'));
  const fb = modelSelect(F.fallback, { allowNone: true });
  fb.addEventListener('change', bind('fallback'));
  const acct = accountSelect(F.account);
  acct.addEventListener('change', bind('account'));
  const done = el('select', { class: 'select', onchange: bind('notifyDone') },
    el('option', { value: 'default' }, `Use the setting (${set.notify?.done ? 'on' : 'off'})`),
    el('option', { value: 'on' }, 'On'), el('option', { value: 'off' }, 'Off'));
  done.value = F.notifyDone;

  const view = el('section', { class: 'stack-lg' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Folder'),
      el('div', { class: 'ag-cl-cwdrow' }, cwd,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => browse(cwd.value) }, 'Go')),
      el('div', { class: 'ag-cl-browser' }, el('span', { class: 'skeleton', style: 'height:120px;display:block' }))),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Task'),
      el('div', { class: 'field' }, el('label', { for: 'ag-cl-prompt' }, 'Prompt'),
        el('textarea', { id: 'ag-cl-prompt', class: 'textarea ag-cl-prompt', rows: '7', placeholder: 'What should Claude do? It runs unattended: say what "done" looks like.', oninput: bind('prompt') }, F.prompt),
        el('span', { class: 'help' }, 'Leave empty to open an idle session and work in its terminal')),
      el('div', { class: 'field' }, el('label', { for: 'ag-cl-title' }, 'Title (optional)'),
        el('input', { id: 'ag-cl-title', class: 'input', value: F.title, maxlength: '70', oninput: bind('title') }))),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Options'),
      el('div', { class: 'grid grid--2 ag-cl-opts' },
        el('div', { class: 'field' }, el('label', {}, 'Model'), model),
        el('div', { class: 'field' }, el('label', {}, 'Fallback when it runs out'), fb),
        el('div', { class: 'field' }, el('label', {}, 'Account'), acct),
        el('div', { class: 'field' }, el('label', {}, 'Ping when done'), done)),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: F.unattended, onchange: bind('unattended') }),
        el('span', {}, 'Unattended instructions — decide instead of asking, end with DONE: or BLOCKED:')),
      el('div', { class: 'field ag-cl-narrow' }, el('label', {}, 'Nudge to continue'),
        el('input', { class: 'input', type: 'number', min: '0', max: '10', value: String(F.autoContinue), oninput: bind('autoContinue', Number) }),
        el('span', { class: 'help' }, 'times to say “continue” if a turn ends without DONE or BLOCKED'))),
    el('div', { class: 'ag-cl-start' },
      el('span', { class: 'meta' }, 'Runs with bypass permissions. Pings go to Discord when it needs you.'),
      el('button', { class: 'btn', type: 'button', disabled: S.busy.has('create'), onclick: create }, S.busy.has('create') ? 'Starting…' : 'Start session')));
  root.replaceChildren(view);
  if (!S.fs || S.fs.path !== F.cwd) browse(F.cwd || undefined); else paintBrowser();
}

async function create() {
  const F = S.form;
  if (!F.cwd) { ctx.toast?.('warn', 'Pick a folder first'); return; }
  const v = await act('create', () => post('/sessions', {
    cwd: F.cwd,
    prompt: F.prompt,
    title: F.title,
    model: F.model,
    fallback: F.fallback || null,
    account: F.account,
    unattended: F.unattended,
    autoContinue: F.autoContinue,
    notifyDone: F.notifyDone === 'on' ? true : F.notifyDone === 'off' ? false : null,
  }));
  if (v) {
    upsert(v);
    S.form = null;
    S.pane = 'terminal';
    go(v.id);
  }
}

/* ── accounts ───────────────────────────────────────────────────────── */

function acctStatus(a) {
  if (a.status === 'needs-login') return { dot: 'err', text: a.limitText ? `Needs login — ${a.limitText}` : 'Not logged in' };
  if (a.status === 'limited') return { dot: 'warn', text: `Out until ${at(a.limitedUntil)}${a.limitWindow ? ` (${a.limitWindow === 'five_hour' ? '5-hour' : a.limitWindow === 'seven_day' ? 'weekly' : a.limitWindow} limit)` : ''}` };
  if (a.status === 'unknown') return { dot: 'info', text: a.authError || 'Not checked yet' };
  return { dot: 'ok', text: 'Available' };
}

function accountRow(a) {
  const st = acctStatus(a);
  const models = Object.entries(a.modelLimits || {});
  return el('div', { class: `ag-cl-row ag-cl-arow ${a.status === 'needs-login' ? 'is-bad' : ''}` },
    el('span', { class: `dot dot--${st.dot}` }),
    el('span', { class: 'ag-cl-srow-main' },
      el('span', { class: 'ag-cl-srow-title' }, a.label, a.active ? el('span', { class: 'ag-cl-active' }, 'active') : null),
      el('span', { class: 'ag-cl-srow-sub' },
        [a.email, a.plan ? a.plan.toUpperCase() : null, a.main ? '~/.claude' : shortPath(a.dir)].filter(Boolean).join(' · ')),
      el('span', { class: 'ag-cl-arow-status' }, st.text,
        models.length ? ` · ${models.map(([f, until]) => `${f[0].toUpperCase()}${f.slice(1)} out until ${at(until)}`).join(', ')}` : '')),
    el('span', { class: 'ag-cl-arow-actions' },
      !a.active ? el('button', { class: 'btn btn--sm', type: 'button', onclick: () => activate(a) }, 'Make active') : null,
      el('button', { class: `btn btn--sm ${a.status === 'needs-login' ? '' : 'btn--ghost'}`, type: 'button', onclick: () => startLogin(a) }, a.loggedIn ? 'Log in again' : 'Log in'),
      el('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', title: 'More', 'aria-label': `More for ${a.label}`, onclick: () => accountMenu(a) }, svg('cog'))));
}

function paintAccounts(reason) {
  const { accounts, settings } = S.data;
  const list = root.querySelector('.ag-cl-acct-list');
  if (list && reason) {
    list.replaceChildren(...accounts.map(accountRow));
    const t = root.querySelector('.ag-cl-autoswitch');
    if (t) { t.dataset.on = settings.autoSwitchAccounts ? '1' : '0'; t.setAttribute('aria-pressed', String(!!settings.autoSwitchAccounts)); }
    return;
  }
  if (reason === 'session') return;
  const label = el('input', { class: 'input', placeholder: 'Label, e.g. Second', maxlength: '40' });
  const view = el('section', { class: 'stack-lg' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Accounts'),
        el('span', { class: 'meta' }, 'normal Claude subscription logins — no API keys')),
      el('div', { class: 'ag-cl-list ag-cl-acct-list' }, accounts.map(accountRow)),
      toggleRow('autoSwitchAccounts', 'Auto-switch accounts', 'ag-cl-autoswitch', { detail: 'when one runs out, sessions move to the next available account' }),
      el('p', { class: 'meta' }, 'Sessions move to the next available account in this order and pick up where they stopped. With it off, they pause until the account resets.')),
    el('div', { class: 'ag-cl-login' }),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Add an account'),
      el('div', { class: 'ag-cl-cwdrow' }, label,
        el('button', {
          class: 'btn btn--sm',
          type: 'button',
          onclick: async () => {
            const name = label.value.trim();
            if (!name) return;
            const a = await act('add-acct', () => post('/accounts', { label: name }));
            // The live update may have added it already; replace, never duplicate.
            if (a) { S.data.accounts = [...S.data.accounts.filter((x) => x.id !== a.id), a]; paintAccounts(); startLogin(a); }
          },
        }, 'Add and log in')),
      el('p', { class: 'meta' }, 'Gets its own login folder; history, settings and CLAUDE.md are shared with ~/.claude, so any session can continue on it.')));
  root.replaceChildren(view);
  if (S.login) paintLogin();
}

async function activate(a) {
  const move = el('input', { type: 'checkbox', checked: true });
  const ok = await ctx.modal({
    title: `Make ${a.label} active?`,
    body: el('div', { class: 'stack' },
      el('p', { class: 'meta' }, 'New sessions start on it.'),
      el('label', { class: 'check' }, move, el('span', {}, 'Move existing sessions too (between turns now, working ones when their turn ends)'))),
    actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Make active', value: true }],
  });
  if (!ok) return;
  const r = await act(`activate:${a.id}`, () => post(`/accounts/${a.id}/activate`, { move: move.checked }));
  if (r) ctx.toast?.('ok', `${a.label} is active`, r.moved ? `${r.moved} session(s) moving` : '');
}

async function accountMenu(a) {
  const choice = await ctx.modal({
    title: a.label,
    body: el('p', { class: 'meta' }, a.main ? 'This machine\'s own ~/.claude login.' : `Login folder: ${a.dir}`),
    actions: [
      { label: 'Check login', value: 'refresh', variant: 'ghost' },
      { label: 'Forget limits', value: 'clear', variant: 'ghost' },
      { label: 'Rename', value: 'rename', variant: 'ghost' },
      ...(a.main ? [] : [{ label: 'Remove', value: 'remove', variant: 'danger' }]),
    ],
  });
  if (choice === 'refresh') await act(`r:${a.id}`, () => post(`/accounts/${a.id}/refresh`), 'Checked');
  else if (choice === 'clear') await act(`c:${a.id}`, () => post(`/accounts/${a.id}/clear-limits`), 'Limits forgotten');
  else if (choice === 'rename') {
    const input = el('input', { class: 'input', value: a.label, maxlength: '40' });
    if (await ctx.modal({ title: 'Rename account', body: el('div', { class: 'field' }, el('label', {}, 'Label'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }] })) {
      await act(`n:${a.id}`, () => api(`/accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ label: input.value }) }));
    }
  } else if (choice === 'remove') {
    const ok = await ctx.modal({ title: `Remove ${a.label}?`, body: el('p', { class: 'meta' }, `Its login folder is left on disk (${a.dir}); delete it by hand if you want the login gone.`), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Remove', value: true, variant: 'danger' }] });
    if (ok) {
      const r = await act(`rm:${a.id}`, () => api(`/accounts/${a.id}`, { method: 'DELETE' }), 'Removed');
      if (r) { S.data.accounts = S.data.accounts.filter((x) => x.id !== a.id); paintAccounts(); }
    }
  }
}

async function startLogin(a) {
  const r = await act(`login:${a.id}`, () => post(`/accounts/${a.id}/login`));
  if (!r) return;
  stopLogin();
  S.login = { id: a.id, state: null, timer: null, term: null, showTerm: false };
  paintLogin();
  pollLogin();
}

function stopLogin() {
  if (!S.login) return;
  clearTimeout(S.login.timer);
  S.login.term?.teardown();
  S.login = null;
}

async function pollLogin() {
  if (!S.login) return;
  const id = S.login.id;
  try {
    S.login.state = await api(`/accounts/${id}/login`);
  } catch (e) {
    S.login.state = { error: e.message };
  }
  if (!S.login || S.login.id !== id) return;
  paintLogin(true);
  if (S.login.state?.running && !S.login.state?.finished) S.login.timer = setTimeout(pollLogin, 2000);
}

function paintLogin(update) {
  const host = root?.querySelector('.ag-cl-login');
  if (!host || !S.login) return;
  const a = S.data.accounts.find((x) => x.id === S.login.id);
  const st = S.login.state || {};
  const code = el('input', { class: 'input', placeholder: 'Paste the code from the sign-in page', spellcheck: 'false', autocomplete: 'off' });
  const status = !S.login.state ? 'Starting the login…'
    : st.finished ? 'Logged in.'
      : st.failed ? `Login failed: ${st.error}. Start again and paste the whole code — it ends with a # part — from the page that link opens, not an older one.`
        : st.error ? `Could not read the login: ${st.error}`
          : !st.running ? 'The login window has closed.'
            : st.url ? (st.wantsCode ? 'Open the sign-in page, approve, then paste the whole code it shows (including the part after #).' : 'Open the sign-in page and approve.')
              : 'Waiting for the sign-in link…';
  const panel = el('section', { class: 'panel stack ag-cl-login-panel' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, `Log in: ${a?.label || S.login.id}`),
      el('button', {
        class: `btn btn--sm ${st.failed || (S.login.state && !st.running && !st.finished) ? '' : 'btn--ghost'}`,
        type: 'button',
        onclick: async () => {
          await post(`/accounts/${S.login.id}/login`, {}).catch(() => {});
          clearTimeout(S.login.timer);
          S.login.state = null;
          paintLogin();
          pollLogin();
        },
      }, st.failed || (S.login.state && !st.running && !st.finished) ? 'Try again' : 'Restart')),
    el('p', { class: 'meta' }, status),
    st.url ? el('a', { class: 'btn btn--sm ag-cl-login-link', href: st.url, target: '_blank', rel: 'noreferrer noopener' }, svg('external'), 'Open the sign-in page') : null,
    st.running && !st.finished ? el('div', { class: 'ag-cl-cwdrow' }, code,
      el('button', {
        class: 'btn btn--sm',
        type: 'button',
        onclick: async () => {
          if (!code.value.trim()) return;
          const ok = await act('code', () => post(`/accounts/${S.login.id}/login/code`, { code: code.value.trim() }), 'Code sent');
          if (ok) { code.value = ''; pollLogin(); }
        },
      }, 'Submit')) : null,
    el('div', { class: 'ag-cl-login-actions' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { S.login.showTerm = !S.login.showTerm; paintLogin(); } }, svg('terminal'), S.login.showTerm ? 'Hide terminal' : 'Show terminal'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: async () => { const id = S.login.id; stopLogin(); await api(`/accounts/${id}/login`, { method: 'DELETE' }).catch(() => {}); paintAccounts(); },
      }, st.finished || !st.running ? 'Close' : 'Cancel')),
    el('div', { class: 'ag-cl-login-term' }));
  if (update && host.firstChild && S.login.term) {
    // Keep a live terminal: rebuild only the text around it.
    const old = host.querySelector('.ag-cl-login-term');
    panel.querySelector('.ag-cl-login-term').replaceWith(old);
    host.replaceChildren(panel);
    return;
  }
  S.login.term?.teardown();
  S.login.term = null;
  host.replaceChildren(panel);
  if (S.login.showTerm && st.running) {
    S.login.term = startTerminal({ host: panel.querySelector('.ag-cl-login-term'), ctx, path: `/accounts/${S.login.id}/terminal` });
  }
}

/* ── settings ───────────────────────────────────────────────────────── */

async function saveSettings(patch, what = 'Saved') {
  const r = await act('settings', async () => {
    const next = await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
    S.data.settings = next;
    return next;
  });
  if (r) ctx.toast?.('ok', what);
  return r;
}

function toggleRow(key, label, extraClass = '', { notify = false, detail = null } = {}) {
  const on = notify ? !!S.data.settings.notify?.[key] : !!S.data.settings[key];
  return el('button', {
    class: `togrow ${extraClass}`,
    type: 'button',
    'data-on': on ? '1' : '0',
    'aria-pressed': String(on),
    onclick: async (e) => {
      const btn = e.currentTarget;
      const next = btn.dataset.on !== '1';
      btn.dataset.on = next ? '1' : '0';
      btn.setAttribute('aria-pressed', String(next));
      await saveSettings(notify ? { notify: { [key]: next } } : { [key]: next });
    },
  }, el('span', { class: 'ag-cl-tog' }, el('span', { class: 'tlabel' }, label), detail ? el('span', { class: 'ag-cl-tog-detail' }, detail) : null),
  el('span', { class: 'toggle' }, el('span', { class: 'track' })));
}

/* Short labels: a toggle row's label is instrument type (uppercase, bold),
   which a sentence does not survive. The detail goes underneath. */
const NOTIFY = [
  ['needsInput', 'Needs your input', 'a question, or a prompt waiting in the terminal'],
  ['blocked', 'Blocked', 'it ended with BLOCKED:'],
  ['error', 'Errors', 'failed requests, crashes, sessions a restart interrupted'],
  ['stalled', 'Gone quiet', 'nothing new for the stall time while working'],
  ['modelFallback', 'Model switched', 'the default model ran out; continuing on the fallback'],
  ['accountSwitch', 'Account switched', 'an account ran out; sessions moved'],
  ['allLimited', 'All accounts out', 'sessions paused until the soonest reset'],
  ['needsLogin', 'Needs login', 'an account was logged out'],
  ['done', 'Finished', 'it ended with DONE:'],
  ['excerpts', 'Include excerpts', 'what Claude said, in the ping itself'],
];

function paintSettings() {
  const { settings, notify, runner } = S.data;
  const def = modelSelect(settings.defaultModel);
  def.addEventListener('change', () => saveSettings({ defaultModel: def.value }, 'Default model saved'));
  const fb = modelSelect(settings.fallbackModel, { allowNone: true });
  fb.addEventListener('change', () => saveSettings({ fallbackModel: fb.value || null }, 'Fallback model saved'));
  const num = (key, min, max, label, help) => el('div', { class: 'field ag-cl-narrow' }, el('label', {}, label),
    el('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(settings[key]), onchange: (e) => saveSettings({ [key]: Number(e.target.value) }) }),
    help ? el('span', { class: 'help' }, help) : null);

  root.replaceChildren(el('section', { class: 'stack-lg' },
    tabs(),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Models'),
      el('div', { class: 'grid grid--2 ag-cl-opts' },
        el('div', { class: 'field' }, el('label', {}, 'Default model'), def, el('span', { class: 'help' }, 'new sessions start on this')),
        el('div', { class: 'field' }, el('label', {}, 'Fallback model'), fb, el('span', { class: 'help' }, 'used when the default runs out on an account'))),
      num('modelRetryHours', 1, 168, 'Try the default again after (hours)', 'a model limit gives no reset time')),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Accounts'),
      toggleRow('autoSwitchAccounts', 'Auto-switch accounts', '', { detail: 'when one runs out, sessions move to the next available account' }),
      el('p', { class: 'meta' }, 'Manage logins under Accounts.')),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Discord pings'),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          disabled: !notify?.enabled,
          onclick: () => act('test', () => post('/notify/test'), 'Test ping sent'),
        }, 'Send a test')),
      notify?.enabled
        ? el('p', { class: 'meta' }, 'Sent to the Claude webhook (CLAUDE_DISCORD_WEBHOOK) — separate from fleet\'s.')
        : el('div', { class: 'alert alert--warn' }, el('b', {}, 'No webhook'), el('span', {}, 'Set CLAUDE_DISCORD_WEBHOOK in ~/.config/ojee-claude/env on the host and restart the runner. Until then pings are only listed below.')),
      el('div', { class: 'ag-cl-toggles' }, NOTIFY.map(([k, label, detail]) => toggleRow(k, label, '', { notify: true, detail }))),
      (notify?.recent || []).length ? el('details', {},
        el('summary', { class: 'meta' }, 'Recent pings'),
        el('div', { class: 'ag-cl-list' }, notify.recent.map((n) => el('div', { class: 'ag-cl-row ag-cl-ping' },
          el('span', { class: 'meta' }, at(n.at)),
          el('span', { class: 'ag-cl-srow-title' }, n.title),
          el('span', { class: 'meta' }, n.sent ? 'sent' : 'not sent'))))) : null),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Sessions'),
      el('div', { class: 'grid grid--2 ag-cl-opts' },
        num('maxRunning', 1, 10, 'Working at once', 'more wait in a queue'),
        num('stallMinutes', 5, 240, 'Stalled after (minutes)', 'with nothing new while working')),
      el('div', { class: 'ag-cl-toggles' },
        toggleRow('unattended', 'Unattended', '', { detail: 'new sessions decide instead of asking, and end with DONE: or BLOCKED:' }),
        toggleRow('guard', 'Guard the machine', '', { detail: 'block sudo, force-push, and stopping or touching the console stack' }),
        toggleRow('resumeInterrupted', 'Resume after reboot', '', { detail: 'sessions a restart interrupted pick up again on their own' }))),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Runner'),
      el('div', { class: 'ag-cl-list' },
        ...[['Claude Code', runner?.claude || 'not found'], ['tmux', runner?.tmux || 'not found'], ['Listening on', runner?.host], ['Protected stack folder', runner?.stackDir]]
          .map(([k, v]) => el('div', { class: 'ag-cl-row ag-cl-kv' }, el('span', { class: 'meta' }, k), el('span', {}, v || '—')))))));
}

/* ── routing and lifecycle ──────────────────────────────────────────── */

export function routeClaude() {
  const [first] = sub();
  const prevDetail = S.detail;
  const prevTab = S.tab;
  if (first && /^[0-9a-f-]{36}$/i.test(first)) { S.detail = first; }
  else { S.detail = null; S.tab = ['new', 'accounts', 'settings'].includes(first) ? first : 'sessions'; }
  if (prevDetail !== S.detail) stopPane();
  if (S.tab !== 'accounts' || S.detail) stopLogin();
  // A new place starts at its top, not wherever the last one was scrolled to.
  if (prevDetail !== S.detail || prevTab !== S.tab) window.scrollTo(0, 0);
  paint();
  lockPage();
}

export async function mountClaude(el0, context) {
  root = el0;
  ctx = context;
  ensureIcons();
  if (!document.getElementById('ag-cl-css')) {
    const link = document.createElement('link');
    link.id = 'ag-cl-css';
    link.rel = 'stylesheet';
    link.href = `${ctx.base}/ui/claude.css`;
    document.head.appendChild(link);
  }
  routeClaude();
  await load();
  routeClaude();
  listen();
}

export function unmountClaude() {
  document.documentElement.style.overflow = '';
  stopPane();
  stopLogin();
  sse?.stop();
  sse = null;
  root = null;
}
