/* ============================================================
   ojee-agent - the Claude view.

   Unattended Claude Code sessions, through a runner on each machine
   that runs them (claude-runner/ in this repo) - HP, and LOQ when it
   is awake. Four places, one row of tabs:

     Sessions   what is running on every device, what needs you, and
                every other conversation on a machine
     New        a device, a folder anywhere on it, a prompt, a model
     Accounts   one device's Claude logins, which one is active, which
                are out and until when - and logging one in
     Settings   one device's default and fallback model, auto-switch,
                pings, CPU

   Every device is its own runner with its own accounts and settings;
   the module proxies each under /claude/d/<device>/ and merges their
   event streams into one (/claude/all/events). A device that is off
   (a laptop asleep) is a state drawn like any other, not an error.

   A session opens to its REAL terminal (tmux attach, the same
   one you would get typing `claude` in a shell there), with a
   readable transcript beside it and a message box under both.

   Routes live under the view: #/agent/claude/<rest>, where rest
   is '', 'new', 'accounts', 'settings' or a session id. The
   console only reads the first two segments, so a deep link from
   a Discord ping opens straight to the session.
   ============================================================ */

import { startTerminal, keyStrip, copyText } from './claude-term.js';
import { createTranscript } from './claude-transcript.js';
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
  // Every field in this view, dialogs included: 16px on a touch screen, or
  // iOS zooms the page in when it takes focus (claude.css).
  if (tag === 'input' || tag === 'textarea' || tag === 'select') n.classList.add('ag-cl-in');
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
  // One entry per device: { id, label, sleeps, online, error, data, seenAt },
  // where data is that runner's { sessions, accounts, settings, models,
  // notify, runner, governor } - kept when it goes offline, drawn as stale.
  devs: null,
  error: null,
  dev: pref('ag-cl-dev'),                   // the device Accounts / Settings / history show
  filter: pref('ag-cl-filter') || 'all',    // sessions list: 'all' or a device id
  tab: 'sessions',
  detail: null,         // session id when a session is open
  history: null,
  historyOpen: false,
  fs: null,
  hidden: false,
  form: null,
  pane: pref('ag-cl-pane') === 'transcript' ? 'transcript' : 'terminal', // in a session, remembered
  term: null,
  termState: null,
  // The transcript being read: its view, the file offset the next poll reads
  // from, and the screen state (an open menu, the spinner line) beside it.
  transcript: { id: null, cursor: null, timer: null, gen: 0, view: null },
  prompt: { id: null, data: null, timer: null, gen: 0 },
  // The session's subagents, and which one the transcript shows (null: the session).
  agents: { id: null, list: null, timer: null, gen: 0, viewing: null },
  // What each device's runner can do, learned on first use: an older runner
  // has no /keys, /prompt or detailed transcript, and the view falls back.
  caps: {},
  sent: {},             // messages sent per session, for Up to recall

  login: null,          // { id, state, timer, term }
  busy: new Set(),
  // Per-viewer layout, remembered in this browser only.
  compose: pref('ag-cl-compose') === '1',   // the message box (the terminal is the way in)
  max: pref('ag-cl-max') === '1',           // the session filling the window
  keys: pref('ag-cl-keys') === '1',         // the special-key row
};

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window, blocked storage: the default layout it is */ }
  return null;
}

/* ── small pieces ───────────────────────────────────────────────────── */

/** A button label that phones hide, leaving the icon (the title still says it). */
const lbl = (text) => el('span', { class: 'ag-cl-lbl' }, text);

const svg = (name, cls = 'ic') => {
  const t = document.createElement('template');
  t.innerHTML = ctx.icon(`i-${name}`, cls);
  return t.content.firstChild;
};

const api = (dev, path, opts = {}) => ctx.api(`/claude/d/${encodeURIComponent(dev)}${path}`, opts);
const post = (dev, path, body) => api(dev, path, { method: 'POST', body: JSON.stringify(body || {}) });

/* ── devices ────────────────────────────────────────────────────────── */

const devOf = (id) => S.devs?.find((d) => d.id === id) || null;
const dataOf = (id) => devOf(id)?.data || null;
const devLabel = (id) => devOf(id)?.label || id || '-';
const online = (id) => !!devOf(id)?.online;
/** More than one device: only then is a device named anywhere. */
const multi = () => (S.devs?.length || 0) > 1;
/** The device Accounts, Settings and history are showing. */
function curDev() {
  if (S.dev && devOf(S.dev)) return S.dev;
  return S.devs?.[0]?.id || null;
}
function setDev(id) {
  S.dev = id;
  pref('ag-cl-dev', id);
}
const devTag = (id) => (multi() ? el('span', { class: 'ag-cl-devtag', title: `Runs on ${devLabel(id)}` }, devLabel(id)) : null);
/** Why a device cannot be used right now, in words. */
function offWhy(d) {
  if (!d || d.online) return null;
  const seen = d.seenAt ? ` · last seen ${ctx.relTime(d.seenAt)}` : '';
  return d.sleeps ? `${d.label} is offline: asleep, shut or away${seen}` : `${d.label} is not answering${d.error ? ` (${d.error})` : ''}${seen}`;
}
/** Every device's sessions in one list, most recently active first. */
const allSessions = () => (S.devs || []).flatMap((d) => d.data?.sessions || [])
  .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
/** A runner's state, with each session marked with the device it runs on. */
function stamp(data, dev) {
  for (const x of data.sessions || []) x.device = dev;
  return data;
}

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
/** The state word, plus how much is still running in the background. */
const stateTag = (state, bg = null) => {
  const n = bg ? (bg.subagents || 0) + (bg.shells || 0) : 0;
  return el('span', { class: `ag-cl-state ag-cl-state--${state}`, title: n ? bgText(bg) : null },
    STATE[state]?.label || state, n ? ` · ${n} bg` : '');
};
// The Agent overview lists sessions too; it words and colours them the same.
export { dot as stateDot, stateTag };
const bgText = (bg) => [bg.subagents ? `${bg.subagents} subagent${bg.subagents === 1 ? '' : 's'}` : null,
  bg.shells ? `${bg.shells} command${bg.shells === 1 ? '' : 's'}` : null].filter(Boolean).join(', ') + ' in the background';

const modelLabel = (id) => (S.devs || []).map((d) => d.data?.models?.find((m) => m.id === id)).find(Boolean)?.label || id || '-';
const acctLabel = (id, dev) => dataOf(dev)?.accounts?.find((a) => a.id === id)?.label || id || '-';

const ago = (ms) => (ms ? ctx.relTime(ms) : '-');
const at = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms);
  const same = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return same ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
};
const shortPath = (p, dev) => {
  const home = dataOf(dev)?.runner?.home;
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

function upsert(dev, v) {
  const data = dataOf(dev);
  if (!data || !v?.id) return;
  v.device = dev;
  const i = data.sessions.findIndex((s) => s.id === v.id);
  if (i >= 0) data.sessions[i] = v; else data.sessions.unshift(v);
}

const session = (id) => allSessions().find((s) => s.id === id) || null;

async function load() {
  try {
    const r = await ctx.api('/claude/all/state');
    const prev = S.devs || [];
    S.devs = (r.devices || []).map((d) => {
      const old = prev.find((x) => x.id === d.id);
      return {
        id: d.id,
        label: d.label,
        sleeps: !!d.sleeps,
        online: !!d.online,
        error: d.error || null,
        // Offline: what was last known stays, drawn as stale.
        data: d.state ? stamp(d.state, d.id) : old?.data || null,
        seenAt: d.online ? Date.now() : old?.seenAt || null,
      };
    });
    S.error = null;
  } catch (e) {
    S.error = e.message;
  }
}

function listen() {
  sse?.stop();
  sse = ctx.sse('/claude/all/events', {
    events: {
      state: ({ device, data }) => {
        const d = devOf(device);
        if (!d || !data) return;
        d.data = stamp(data, device);
        d.online = true;
        d.error = null;
        d.seenAt = Date.now();
        paint('device');
      },
      session: ({ device, data }) => {
        const d = devOf(device);
        if (d) d.seenAt = Date.now();
        upsert(device, data);
        paint('session');
      },
      removed: ({ device, data }) => {
        const x = dataOf(device);
        if (x) x.sessions = x.sessions.filter((s) => s.id !== data?.id);
        if (S.detail === data?.id) go();
        else paint('session');
      },
      accounts: ({ device, data }) => {
        const x = dataOf(device);
        if (!x || !data) return;
        x.accounts = data.accounts;
        x.settings = data.settings;
        paint(device === curDev() ? 'accounts' : 'session');
      },
      device: ({ device, online: on, error }) => {
        const d = devOf(device);
        if (!d) return;
        // It answered until now: that is when it was last seen.
        if (d.online && !on) d.seenAt = Date.now();
        d.online = !!on;
        d.error = error || null;
        paint('device');
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
 * parts that must not be rebuilt under the user - a form being filled in, a
 * terminal, a transcript being read.
 */
function paint(reason) {
  if (!root) return;
  const retry = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { await load(); paint(); } }, 'Try again');
  if (S.error && !S.devs) {
    root.replaceChildren(el('section', { class: 'stack-lg' },
      tabs(),
      el('section', { class: 'panel stack' },
        el('h3', { class: 'h3' }, 'Claude'),
        problem('The Claude runner is not answering', S.error, retry))));
    return;
  }
  if (S.devs && !S.devs.some((d) => d.data)) {
    // Nothing known from any device. One runner: the same card as ever.
    root.replaceChildren(el('section', { class: 'stack-lg' },
      tabs(),
      el('section', { class: 'panel stack' },
        el('h3', { class: 'h3' }, 'Claude'),
        S.devs.length
          ? problem(multi() ? 'No Claude runner is answering' : 'The Claude runner is not answering',
            S.devs.map((d) => (multi() ? `${d.label}: ${d.error || 'offline'}` : d.error || 'offline')).join(' · '), retry)
          : problem('No Claude runner is configured', 'Set CLAUDE_RUNNER_URL and CLAUDE_RUNNER_TOKEN for this module.'))));
    return;
  }
  if (!S.devs) {
    root.replaceChildren(el('div', { class: 'stack-lg' },
      el('span', { class: 'skeleton', style: 'height:44px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:220px;display:block' })));
    return;
  }

  if (S.detail) return paintDetail(reason);
  if (S.tab === 'new') {
    // Never rebuild a form being filled in; a device coming or going only
    // changes the device picker.
    if (reason === 'device') return paintDevPick();
    if (reason) return;
    return paintNew();
  }
  if (S.tab === 'settings') { if (reason === 'session') return; return paintSettings(); }
  if (S.tab === 'accounts') return paintAccounts(reason === 'device' ? null : reason);
  return paintSessions();
}

/** Which device a place shows - a row of buttons, only with more than one. */
function devSwitch(onpick, value = curDev()) {
  if (!multi()) return null;
  return el('div', { class: 'segctl ag-cl-devswitch', role: 'group', 'aria-label': 'Device' },
    S.devs.map((d) => el('button', {
      type: 'button',
      'aria-pressed': String(value === d.id),
      title: offWhy(d) || `On ${d.label}`,
      onclick: () => onpick(d.id),
    }, el('span', { class: d.online ? 'dot dot--ok ag-cl-devdot' : 'dot ag-cl-devdot' }), d.label)));
}

/** A device that cannot be reached, as a card rather than an error. */
const offCard = (d) => el('section', { class: 'panel stack' },
  problem(d.sleeps ? `${d.label} is offline` : `${d.label} is not answering`, offWhy(d),
    el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { await load(); paint(); } }, 'Check again')));

/* ── sessions ───────────────────────────────────────────────────────── */

/** A session on a device that is offline: its last known state is stale. */
const offTag = () => el('span', { class: 'ag-cl-state ag-cl-state--stopped', title: 'Its device is offline; this is the last known state' }, 'offline');

function sessionRow(s) {
  const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
  const off = !online(s.device);
  return el('button', { class: `ag-cl-row ag-cl-srow ${['error'].includes(s.state) && !off ? 'is-bad' : ''}${off ? ' is-off' : ''}`, type: 'button', onclick: () => go(s.id) },
    off ? dot('stopped') : dot(s.state),
    el('span', { class: 'ag-cl-srow-main' },
      el('span', { class: 'ag-cl-srow-title' }, s.title || s.id.slice(0, 8)),
      el('span', { class: 'ag-cl-srow-sub' },
        devTag(s.device), shortPath(s.cwd, s.device), ' · ', modelLabel(s.model?.current), fell ? ' (fallback)' : '', ' · ', acctLabel(s.account, s.device))),
    off ? offTag() : stateTag(s.state, s.background),
    el('span', { class: 'meta ag-cl-srow-when' }, ago(s.lastActivityAt)));
}

/** One row per device: up or not, what it runs, how loaded it is. */
function devicesPanel() {
  if (!multi()) return null;
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Devices'),
      el('span', { class: 'meta' }, `${S.devs.filter((d) => d.online).length} of ${S.devs.length} online`)),
    el('div', { class: 'ag-cl-list' }, S.devs.map((d) => {
      const x = d.data;
      const open = (x?.sessions || []).filter((s) => s.state !== 'stopped').length;
      const active = x?.accounts?.find((a) => a.id === x.settings?.activeAccount);
      const g = x?.governor;
      const sub = d.online && x
        ? [x.runner?.claude ? `Claude Code ${String(x.runner.claude).replace(/\s*\(Claude Code\)/, '')}` : 'Claude Code not found',
          `${open} open`,
          active ? `on ${active.label}${active.status !== 'ok' ? ` (${active.status})` : ''}` : null,
          `${(x.accounts || []).length} account${(x.accounts || []).length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
        : offWhy(d);
      const load = d.online && g ? [g.active ? `CPU ${g.usagePct}% of cap ${g.capPct}%` : 'governor off', g.temp != null ? `${g.temp} °C` : null].filter(Boolean).join(' · ') : '';
      return el('button', {
        class: `ag-cl-row ag-cl-drow${d.online ? '' : ' is-off'}`,
        type: 'button',
        title: `Show only ${d.label}'s sessions`,
        onclick: () => { S.filter = d.id; pref('ag-cl-filter', d.id); paint(); },
      },
      el('span', { class: d.online ? 'dot dot--ok' : d.sleeps ? 'dot' : 'dot dot--warn' }),
      el('span', { class: 'ag-cl-srow-main' },
        el('span', { class: 'ag-cl-srow-title' }, d.label, el('span', { class: 'meta ag-cl-drow-state' }, d.online ? 'online' : d.sleeps ? 'offline' : 'not answering')),
        el('span', { class: 'ag-cl-srow-sub' }, sub)),
      el('span', { class: 'meta ag-cl-srow-when' }, load));
    })));
}

function paintSessions() {
  const all = allSessions();
  if (S.filter !== 'all' && !devOf(S.filter)) S.filter = 'all';
  const sessions = multi() && S.filter !== 'all' ? all.filter((s) => s.device === S.filter) : all;
  const first = dataOf(S.devs.find((d) => d.data)?.id);
  const accounts = first?.accounts || [];
  const settings = first?.settings || {};
  const live = sessions.filter((s) => !['stopped'].includes(s.state));
  const ended = sessions.filter((s) => s.state === 'stopped');
  // What needs you is counted over every device, whatever the filter says.
  const reachable = all.filter((s) => online(s.device));
  const needs = reachable.filter((s) => ['waiting', 'blocked', 'error'].includes(s.state));
  const working = reachable.filter((s) => ['running', 'starting'].includes(s.state));
  const paused = reachable.filter((s) => s.state === 'paused');
  // One device: which account it is on. Several: the Devices panel says.
  const active = multi() ? null : accounts.find((a) => a.id === settings.activeAccount);
  const offline = multi() ? S.devs.filter((d) => !d.online) : [];

  const verdict = el('div', { class: 'ag-verdict ag-cl-verdict' },
    dot(needs.length ? 'waiting' : working.length ? 'running' : 'idle'),
    el('strong', {}, needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you`
      : working.length ? `${working.length} working` : live.length ? 'nothing working right now' : 'no sessions'),
    el('span', { class: 'meta' },
      [working.length && needs.length ? `${working.length} working` : null,
        paused.length ? `${paused.length} paused` : null,
        active ? `on ${active.label}${active.status !== 'ok' ? ` (${active.status})` : ''}` : null,
        ...offline.map((d) => `${d.label} ${d.sleeps ? 'offline' : 'not answering'}`)].filter(Boolean).join(' · ')),
    el('button', { class: 'btn btn--sm ag-cl-verdict-new', type: 'button', onclick: () => go('new') }, svg('plus'), 'New session'));

  const wrap = el('section', { class: 'stack-lg' }, tabs(), verdict);

  if (needs.length) {
    wrap.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Needs you'),
      el('div', { class: 'ag-cl-list' }, needs.map((s) => el('button', { class: 'ag-cl-row ag-cl-need', type: 'button', onclick: () => go(s.id) },
        dot(s.state),
        el('span', { class: 'ag-cl-srow-main' },
          el('span', { class: 'ag-cl-srow-title' }, devTag(s.device), s.title),
          el('span', { class: 'ag-cl-need-q' }, s.question?.text || s.detail || s.lastError?.text || '')),
        stateTag(s.state))))));
  }

  const filter = multi() ? el('div', { class: 'segctl ag-cl-devswitch', role: 'group', 'aria-label': 'Show sessions on' },
    [['all', 'All'], ...S.devs.map((d) => [d.id, d.label])].map(([id, label]) => el('button', {
      type: 'button',
      'aria-pressed': String(S.filter === id),
      onclick: () => { S.filter = id; pref('ag-cl-filter', id); paint(); },
    }, label))) : null;
  const fdev = multi() && S.filter !== 'all' ? devOf(S.filter) : null;
  wrap.append(el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Sessions'),
      el('span', { class: 'meta' }, `${live.length} open${ended.length ? ` · ${ended.length} ended` : ''}`)),
    filter,
    fdev && !fdev.online ? el('p', { class: 'meta' }, `${offWhy(fdev)}. Its sessions are as they were last seen; they carry on when it is back.`) : null,
    live.length
      ? el('div', { class: 'ag-cl-list' }, live.map(sessionRow))
      : el('div', { class: 'empty' },
        svg('terminal'),
        el('b', {}, 'No sessions'),
        el('p', {}, multi()
          ? `Start one in any folder on ${fdev ? fdev.label : S.devs.map((d) => d.label).join(' or ')}. It runs unattended with bypass permissions and pings Discord when it needs you.`
          : 'Start one in any folder on this machine. It runs unattended with bypass permissions and pings Discord when it needs you.'),
        el('button', { class: 'btn btn--sm', type: 'button', onclick: () => go('new') }, 'New session')),
    ended.length ? el('details', { class: 'ag-cl-ended' },
      el('summary', { class: 'meta' }, `Ended (${ended.length})`),
      el('div', { class: 'ag-cl-list' }, ended.map(sessionRow))) : null));

  wrap.append(devicesPanel());

  const hdev = curDev();
  const loadHistory = async () => {
    const dev = curDev();
    S.history = { dev, list: null };
    paint();
    const r = await api(dev, '/history').then((x) => ({ list: x.sessions })).catch((e) => ({ error: e.message }));
    if (S.history?.dev === dev) { S.history = { dev, ...r }; paint(); }
  };
  const hist = el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, multi() ? `Other conversations on ${devLabel(hdev)}` : 'Other conversations on this machine'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: async () => {
          S.historyOpen = !S.historyOpen;
          if (S.historyOpen && (!S.history || S.history.dev !== curDev() || S.history.error)) await loadHistory();
          else paint();
        },
      }, S.historyOpen ? 'Hide' : 'Show')));
  if (S.historyOpen) {
    hist.append(devSwitch((id) => { setDev(id); loadHistory(); }));
    const H = S.history;
    if (!online(hdev)) hist.append(el('p', { class: 'meta' }, offWhy(devOf(hdev))));
    else if (!H || H.dev !== hdev || (!H.list && !H.error)) hist.append(el('span', { class: 'skeleton', style: 'height:80px;display:block' }));
    else if (H.error) hist.append(problem('Could not list conversations', H.error));
    else {
      const others = H.list.filter((h) => !h.managed);
      hist.append(others.length
        ? el('div', { class: 'ag-cl-list' }, others.map((h) => el('div', { class: 'ag-cl-row ag-cl-hrow' },
          el('span', { class: 'ag-cl-srow-main' },
            el('span', { class: 'ag-cl-srow-title' }, h.title || h.firstPrompt || h.id.slice(0, 8)),
            el('span', { class: 'ag-cl-srow-sub' }, shortPath(h.cwd || '?', hdev), ' · ', ago(h.modified),
              h.runningElsewhere ? ' · running in a terminal' : '')),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            // Open in a terminal there: a second process on the same
            // conversation would fork it. The runner refuses it too.
            disabled: S.busy.has(`adopt:${h.id}`) || h.runningElsewhere,
            title: h.runningElsewhere ? 'Running in a terminal on that machine. Close it there first' : null,
            onclick: async () => {
              const v = await act(`adopt:${h.id}`, () => post(hdev, `/history/${h.id}/adopt`, {}));
              if (v) { upsert(hdev, v); S.history = null; go(v.id); }
            },
          }, 'Open'))))
        : el('p', { class: 'meta' }, `Every conversation on ${multi() ? devLabel(hdev) : 'this machine'} is already listed above.`));
      hist.append(el('p', { class: 'meta' }, 'Opening one here lets you resume it, read it and message it: the same conversation, not a copy.'));
    }
  }
  wrap.append(hist);
  root.replaceChildren(wrap);
}

/* ── one session ────────────────────────────────────────────────────── */

/**
 * What can be done to a session, as buttons. The head shows them labelled;
 * the maximized bar shows the same set as icons (Resume keeps its word: it
 * is the one that matters when it shows), plus Rename, since the title is
 * not on screen there.
 */
function actionButtons(s, { compact = false } = {}) {
  const dev = s.device;
  const off = !online(dev);
  const alive = s.alive && !off;
  const busy = (k) => off || S.busy.has(`${k}:${s.id}`);
  const cls = (v = 'btn--ghost') => `btn ${v} btn--sm${compact ? ' ag-cl-sq' : ''}`;
  const L = (t) => (compact ? null : lbl(t));
  return [
    // Labels in .ag-cl-lbl: a phone shows the icons (each keeps its name as
    // a title and aria-label) so the actions take one short row, not two.
    s.state === 'running' && !off ? el('button', { class: cls(), type: 'button', title: 'Stop the current turn (Esc)', 'aria-label': 'Stop turn', onclick: () => interrupt(s) }, svg('pause'), L('Stop turn')) : null,
    !alive || s.state === 'paused'
      ? el('button', { class: `btn btn--sm ag-cl-resume`, type: 'button', disabled: busy('resume'), title: off ? offWhy(devOf(dev)) : 'Start Claude again in this conversation', onclick: () => act(`resume:${s.id}`, () => post(dev, `/sessions/${s.id}/resume`, {}).then((v) => upsert(dev, v)), 'Resuming') }, svg('play'), s.state === 'paused' ? 'Resume now' : 'Resume')
      : null,
    compact ? el('button', { class: cls(), type: 'button', title: 'Rename', 'aria-label': 'Rename', onclick: () => rename(s) }, svg('edit')) : null,
    el('button', { class: cls(), type: 'button', title: 'Change model or account', 'aria-label': 'Change', disabled: off, onclick: () => changeSession(s) }, svg('swap'), L('Change')),
    alive ? el('button', { class: cls(), type: 'button', title: 'End the session (the conversation is kept)', 'aria-label': 'End', disabled: busy('end'), onclick: () => endSession(s) }, svg('stop'), L('End')) : null,
    el('button', { class: 'btn btn--ghost btn--sm btn--icon ag-cl-sq', type: 'button', title: 'Delete', 'aria-label': 'Delete', disabled: off, onclick: () => deleteSession(s) }, svg('trash')),
  ];
}

function detailHead(s) {
  const dev = s.device;
  const off = !online(dev);
  const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
  const actual = s.model?.actual && s.model.actual !== s.model.current ? s.model.actual : null;
  return el('header', { class: 'ag-cl-head' },
    el('div', { class: 'ag-cl-head-main' },
      el('button', { class: 'ag-cl-title', type: 'button', title: 'Rename', onclick: () => rename(s) }, s.title),
      el('div', { class: 'ag-cl-chips' },
        off ? offTag() : stateTag(s.state, bgOf(s)),
        multi() ? el('span', { class: 'ag-cl-chip ag-cl-chip--dev', title: 'Device' }, devLabel(dev)) : null,
        el('span', { class: 'ag-cl-chip', title: 'Model' }, modelLabel(s.model?.current), fell ? ' · fallback' : '', actual ? ` (answered by ${modelLabel(actual)})` : ''),
        el('span', { class: 'ag-cl-chip', title: 'Account' }, acctLabel(s.account, dev)),
        el('span', { class: 'ag-cl-chip ag-cl-chip--path', title: s.cwd }, shortPath(s.cwd, dev)))),
    el('div', { class: 'ag-cl-head-actions' }, ...actionButtons(s)));
}

function detailCallouts(s) {
  const out = [];
  if (!online(s.device)) {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Offline'),
      el('span', {}, `${offWhy(devOf(s.device))}. What is shown is how it was last seen; a session there carries on when the machine wakes.`)));
    return out;
  }
  // Under the transcript, the live line and the menu say all of this; only
  // what they do not (an error) stays above it. An older runner, with no
  // screen to read, still gets the question here.
  const tx = S.pane === 'transcript';
  if (tx && cap(s.device).prompt !== false && s.state !== 'error') {
    if (bgOf(s)) out.push(el('div', { class: 'alert alert--info ag-cl-bgnote' }, el('b', {}, 'Background'), el('span', {}, bgText(bgOf(s)))));
    return out;
  }
  if (s.state === 'waiting' && s.question) {
    out.push(el('div', { class: 'alert alert--warn ag-cl-q' }, el('b', {}, 'Asking'),
      el('span', {}, el('span', { class: 'ag-cl-pre' }, s.question.text),
        el('span', { class: 'meta ag-cl-hint' }, S.pane === 'transcript'
          ? 'Pick an answer under the transcript, or type one: a message dismisses the question and becomes the answer.'
          : 'Answer in the terminal, or open the transcript to answer with buttons.'))));
  } else if (s.state === 'blocked') {
    out.push(el('div', { class: 'alert alert--warn' }, el('b', {}, 'Blocked'), el('span', {}, s.detail || '')));
  } else if (s.state === 'paused') {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Paused'),
      el('span', {}, `${s.detail || 'Out of usage'}. It resumes on its own at ${at(s.pausedUntil)}.`)));
  } else if (s.state === 'error') {
    out.push(el('div', { class: 'alert alert--err' }, el('b', {}, 'Error'), el('span', {}, s.detail || s.lastError?.text || '')));
  } else if (s.state === 'done') {
    out.push(el('div', { class: 'alert alert--ok' }, el('b', {}, 'Done'), el('span', {}, s.detail || '')));
  } else if (s.state === 'queued') {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Queued'), el('span', {}, s.detail || 'Waiting for a free slot.')));
  } else if (s.state === 'starting' && s.detail) {
    out.push(el('div', { class: 'alert alert--info' }, el('b', {}, 'Starting'), el('span', {}, s.detail)));
  }
  if (bgOf(s)) {
    out.push(el('div', { class: 'alert alert--info ag-cl-bgnote' }, el('b', {}, 'Background'), el('span', {}, bgText(bgOf(s)))));
  }
  return out;
}

function paintDetail(reason) {
  const s = session(S.detail);
  if (!s) {
    const away = (S.devs || []).filter((d) => !d.online && !d.data);
    root.replaceChildren(el('section', { class: 'stack-lg' }, tabs(),
      el('section', { class: 'panel stack' }, problem('No such session', away.length
        ? `It may have been deleted, or it runs on ${away.map((d) => d.label).join(' or ')}, which ${away.length === 1 ? 'is' : 'are'} offline.`
        : 'It may have been deleted.',
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go() }, 'All sessions')))));
    return;
  }

  // Live updates rebuild only the bars, the head and the callouts. The
  // terminal, the transcript and a half-typed message stay exactly as they are.
  const existing = root.querySelector(`[data-session="${s.id}"]`);
  if (existing) {
    existing.querySelector('.ag-cl-headwrap').replaceChildren(detailHead(s));
    existing.querySelector('.ag-cl-callouts').replaceChildren(...detailCallouts(s));
    paintTopBar(s);
    updateComposer(s);
    paintLive(s);
    paintMenu(s);
    sizeTerminal();
    // A session that came back (resumed, relaunched into a new tmux session)
    // gets its terminal back; one that is gone gets the "not running" card.
    if (S.pane === 'terminal') {
      const dead = !S.term || ['closed', 'error', 'disconnected'].includes(S.termState);
      const up = s.alive && online(s.device);
      if (up && dead) mountPane(s);
      else if (!up && !existing.querySelector('.ag-cl-noterm')) mountPane(s);
    }
    return;
  }

  stopPane();
  const view = el('section', {
    class: `stack ag-cl-detail${S.max ? ' is-max' : ''}${S.compose ? ' has-compose' : ''}${S.pane === 'transcript' ? ' is-tx' : ''}`,
    'data-session': s.id,
  },
    tabs(),
    el('div', { class: 'ag-cl-maxbar' }),
    el('div', { class: 'ag-cl-headwrap' }, detailHead(s)),
    el('div', { class: 'ag-cl-callouts' }, ...detailCallouts(s)),
    el('div', { class: 'ag-cl-panes' }, ...paneTabs(s)),
    el('div', { class: 'ag-cl-body' }),
    composer(s));
  root.replaceChildren(view);
  paintTopBar(s);
  if (!typeWatch) { window.addEventListener('keydown', typeAnywhere, true); typeWatch = true; }
  watchViewport();
  lockPage();
  updateComposer(s);
  mountPane(s);
  onViewport();
}

/** Open sessions in a steady order (oldest first), so chips do not jump about. */
const switchable = (s) => allSessions()
  .filter((x) => x.id === s.id || x.state !== 'stopped')
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));

/**
 * The bar above a session, in both layouts: a way back (All sessions, or
 * Restore when maximized), a chip per open session to hop between them, and
 * when maximized the session's state and every action the head has.
 *
 * Maximized: the session takes the whole window (not the browser's
 * fullscreen, just everything the console draws around the view covered).
 * The console's chrome is not touched; the view is lifted over it (fixed,
 * above the nav and tab bar, below dialogs and toasts so Rename and Delete
 * still work).
 */
/**
 * A small menu under a button, for the phone's maximized bar. One open at a
 * time; a tap outside, Esc or a pick closes it. While one is open the bar is
 * not rebuilt under it (a live update waits for it to close).
 */
let openPop = null;
function closePop() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.close();
}
function popMenu(anchor, items, label) {
  if (openPop?.anchor === anchor) { closePop(); return; }
  closePop();
  const bar = anchor.closest('.ag-cl-maxbar, .ag-cl-agentbar');
  const menu = el('div', { class: 'ag-cl-pop', role: 'menu', 'aria-label': label },
    items.filter(Boolean).map((it) => el('button', {
      class: `ag-cl-pop-item${it.current ? ' is-current' : ''}${it.danger ? ' is-danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      disabled: it.disabled || null,
      'aria-current': it.current ? 'true' : null,
      onclick: () => { closePop(); it.onclick(); },
    }, it.lead || null, el('span', { class: 'ag-cl-pop-label' }, it.label), it.meta ? el('span', { class: 'ag-cl-pop-meta' }, it.meta) : null)));
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); anchor.focus(); } };
  bar.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  openPop = {
    anchor,
    close() {
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      const cur = session(S.detail);
      if (cur) { paintTopBar(cur); paintAgentBar(cur); }
    },
  };
  menu.querySelector('.ag-cl-pop-item:not([disabled])')?.focus({ preventScroll: true });
  // On a phone the menu can open past the screen's edge: bring all of it into view.
  requestAnimationFrame(() => menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

/**
 * The maximized bar on a phone: one row. The session (dot, name, a chevron)
 * opens the switcher; then the one action that matters now (Stop while it
 * works, Resume when it is not running); then "more" for the rest; then
 * Restore. CSS shows this only on a narrow screen.
 */
function compactBar(s) {
  const dev = s.device;
  const off = !online(dev);
  const alive = s.alive && !off;
  const name = el('button', {
    class: 'ag-cl-mx-name',
    type: 'button',
    title: 'Switch session',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e) => popMenu(e.currentTarget, switchable(s).map((x) => ({
      label: x.title,
      lead: online(x.device) ? dot(x.state) : dot('stopped'),
      meta: `${multi() ? `${devLabel(x.device)} · ` : ''}${online(x.device) ? STATE[x.state]?.label || x.state : 'offline'}`,
      current: x.id === s.id,
      onclick: () => { if (x.id !== s.id) go(x.id); },
    })).concat([{ label: 'All sessions', lead: svg('back'), onclick: () => { setMax(false); go(); } }]), 'Sessions'),
  }, off ? dot('stopped') : dot(s.state), el('span', { class: 'ag-cl-mx-title' }, s.title), svg('chevron', 'ic ag-cl-mx-chev'));
  const primary = s.state === 'running' && !off
    ? el('button', { class: 'btn btn--ghost btn--sm ag-cl-sq ag-cl-mx-act', type: 'button', title: 'Stop the current turn (Esc)', 'aria-label': 'Stop turn', onclick: () => interrupt(s) }, svg('pause'))
    : !alive || s.state === 'paused'
      ? el('button', { class: 'btn btn--sm ag-cl-mx-act ag-cl-mx-resume', type: 'button', disabled: off || S.busy.has(`resume:${s.id}`), title: off ? offWhy(devOf(dev)) : 'Start Claude again in this conversation', onclick: () => act(`resume:${s.id}`, () => post(dev, `/sessions/${s.id}/resume`, {}).then((v) => upsert(dev, v)), 'Resuming') }, svg('play'), s.state === 'paused' ? 'Now' : 'Resume')
      : null;
  const more = el('button', {
    class: 'btn btn--ghost btn--sm ag-cl-sq ag-cl-mx-act',
    type: 'button',
    title: 'More: rename, change, end, delete',
    'aria-label': 'More actions',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e) => popMenu(e.currentTarget, [
      { label: 'Rename', lead: svg('edit'), onclick: () => rename(s) },
      { label: 'Change model or account', lead: svg('swap'), disabled: off, onclick: () => changeSession(s) },
      alive ? { label: 'End the session', lead: svg('stop'), onclick: () => endSession(s) } : null,
      { label: 'Delete', lead: svg('trash'), danger: true, disabled: off, onclick: () => deleteSession(s) },
    ], 'Session actions'),
  }, svg('menu'));
  return el('div', { class: 'ag-cl-mx' }, name, primary, more);
}

function paintTopBar(s) {
  const bar = root?.querySelector('.ag-cl-maxbar');
  if (!bar || (openPop && bar.contains(openPop.anchor))) return;
  // Rebuild only on a change: a rebuild on every state tick swallowed taps
  // on its buttons (the switcher, "more", Resume) mid-press.
  const sig = JSON.stringify([S.max, s.id, s.state, s.alive, bgOf(s), s.title, online(s.device),
    switchable(s).map((x) => [x.id, x.title, x.state, online(x.device), x.background])]);
  if (bar.dataset.sig === sig && bar.firstChild) return;
  bar.dataset.sig = sig;
  const strip = el('div', { class: 'ag-cl-switch', role: 'group', 'aria-label': 'Sessions' },
    switchable(s).map((x) => el('button', {
      class: `ag-cl-switch-item${x.id === s.id ? ' is-current' : ''}${online(x.device) && ['waiting', 'blocked', 'error'].includes(x.state) ? ' is-needs' : ''}`,
      type: 'button',
      title: `${x.title}${multi() ? ` on ${devLabel(x.device)}` : ''}: ${online(x.device) ? STATE[x.state]?.label || x.state : 'offline'}${x.background ? ` (${bgText(x.background)})` : ''}`,
      'aria-current': x.id === s.id ? 'true' : null,
      onclick: () => { if (x.id !== s.id) go(x.id); },
    }, online(x.device) ? dot(x.state) : dot('stopped'), devTag(x.device), el('span', {}, x.title))));
  const keep = bar.querySelector('.ag-cl-switch')?.scrollLeft || 0;
  bar.replaceChildren(
    S.max
      ? el('button', { class: 'btn btn--sm ag-cl-restore', type: 'button', title: 'Back to the normal view', onclick: () => setMax(false) }, svg('unfull'), lbl('Restore'))
      : el('button', { class: 'iconbtn ag-cl-back', type: 'button', title: 'All sessions', 'aria-label': 'All sessions', onclick: () => go() }, svg('back')),
    strip,
    ...(S.max ? [el('div', { class: 'ag-cl-maxacts' }, online(s.device) ? stateTag(s.state, bgOf(s)) : offTag(), ...actionButtons(s, { compact: true })), compactBar(s)] : []));
  // The current chip in view, without moving the page.
  strip.scrollLeft = keep;
  requestAnimationFrame(() => {
    const cur = strip.querySelector('.is-current');
    if (!cur) return;
    const l = cur.offsetLeft - strip.offsetLeft;
    if (l < strip.scrollLeft || l + cur.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, l - 24);
  });
}

/**
 * Put the keyboard in the terminal - on a desktop, where it is what you came
 * to type into. Not on a touch screen: focusing there raises the keyboard
 * over half the screen before anyone asked for it.
 */
function focusTerminal() {
  if (!S.term || !window.matchMedia('(pointer: fine)').matches) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.closest('input, textarea, select, [contenteditable]') && !a.closest('.ag-cl-term')) return;
  S.term.focus();
}

/**
 * Type into the session from anywhere on its page. Without this, a key
 * pressed after clicking a button (Maximize, a session chip) went nowhere -
 * and "/" opened the console's jump menu instead of Claude's command list.
 * Moving focus during keydown sends the character to the terminal, and the
 * console's shortcut, which checks focus, stands down.
 */
function typeAnywhere(e) {
  if (!S.detail || !root?.isConnected) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.key.length !== 1) return;
  const a = document.activeElement;
  if (a && a !== document.body && (a.closest('input, textarea, select, [contenteditable]') || a.isContentEditable)) return;
  if (document.querySelector('.modal-backdrop, .cp-backdrop')) return; // a dialog or the jump menu is open
  if (S.pane === 'terminal' && S.term) { S.term.focus(); return; }
  // The transcript: the message box takes the key (and "/" opens commands).
  const box = root.querySelector('.ag-cl-compose:not([hidden]) .ag-cl-input');
  if (S.pane === 'transcript' && box && window.matchMedia('(pointer: fine)').matches) box.focus();
}

/**
 * An image pasted or dropped on the terminal or the message box: uploaded to
 * the box, where the runner pastes its path into Claude, which attaches it as
 * [Image #n], exactly as dragging a file into a local terminal does.
 */
async function sendImage(dev, id, file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { ctx.toast?.('err', 'Image too large', 'The limit is 20 MB.'); return; }
  try {
    await ctx.api(`/claude/d/${encodeURIComponent(dev)}/sessions/${id}/image`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'image/png' },
      body: file,
    });
    ctx.toast?.('ok', 'Image attached', 'Add your message and send it.');
    if (S.pane === 'terminal') S.term?.focus();
  } catch (e) {
    ctx.toast?.('err', 'Could not attach the image', e.message);
  }
}

function setMax(on) {
  closePop();
  S.max = on;
  pref('ag-cl-max', on ? '1' : '0');
  const view = root?.querySelector('.ag-cl-detail');
  view?.classList.toggle('is-max', on);
  const s = session(S.detail);
  if (view && s) {
    view.querySelector('.ag-cl-panes').replaceChildren(...paneTabs(s));
    paintTopBar(s);
  }
  lockPage();
  // Focus inside the overlay can scroll the page underneath it; the normal
  // view is laid out to fit from the top.
  if (!on) window.scrollTo(0, 0);
  sizeTerminal();
  if (S.pane === 'terminal') S.term?.focus();
}

/** While maximized or typing, the page behind must not scroll. */
function lockPage() {
  const on = !!S.detail && !!root?.querySelector('.ag-cl-detail.is-max, .ag-cl-detail.is-kb');
  document.documentElement.style.overflow = on ? 'hidden' : '';
}

/**
 * How tall whatever is pinned to the bottom of the window is - the console's
 * phone tab bar, its status bar, a standalone shell's - so the terminal ends
 * above it rather than underneath. Found by asking what is drawn at the
 * bottom edge, not by knowing the host's markup.
 */
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

/**
 * The terminal (or transcript) fills the screen from where it starts down to
 * the bottom of what is visible - measured, not a guess per layout, because
 * the console's chrome differs between phone and desktop and the standalone
 * shell differs again. Maximized and typing layouts use flex instead.
 */
function sizeTerminal() {
  const view = root?.querySelector('.ag-cl-detail');
  if (!view) return;
  if (view.matches('.is-max, .is-kb')) { view.style.removeProperty('--ag-cl-termh'); return; }
  const pane = view.querySelector('.ag-cl-term, .ag-cl-txwrap, .ag-cl-noterm');
  if (!pane) return;
  const visible = window.visualViewport?.height || innerHeight;
  const top = pane.getBoundingClientRect().top + window.scrollY;
  const box = view.querySelector('.ag-cl-compose');
  const below = box && !box.hidden ? box.offsetHeight + 8 : 0;
  // A phone gives the pane less of a floor: with the message box grown, the
  // box must still end above the console's bottom bar.
  const phone = innerWidth <= 560;
  if (phone) {
    // On a phone the header above the pane takes half the screen, so fitting
    // the pane under it left a sliver of chat. Instead the pane is a whole
    // screen tall (less the tab bar and the message box): scroll past the
    // header once and the chat fills the screen.
    const full = Math.floor(visible - bottomChrome(view, visible) - below - 56);
    view.style.setProperty('--ag-cl-termh', `${Math.max(240, full)}px`);
    keepComposerInView(view);
    return;
  }
  const min = 300;
  const h = Math.floor(visible - bottomChrome(view, visible) - top - below - 10);
  view.style.setProperty('--ag-cl-termh', `${Math.max(min, h)}px`);
  // Whatever still sits below it in the page (the host's padding, a status
  // bar in the flow) shows up as overflow: take exactly that off, once.
  const doc = document.documentElement;
  const over = doc.scrollHeight - doc.clientHeight;
  if (over > 0) view.style.setProperty('--ag-cl-termh', `${Math.max(min, h - over)}px`);
  keepComposerInView(view);
}

/**
 * The message box ends above whatever is pinned to the bottom of the window
 * (the console's phone tab bar, measured, not assumed) and above the
 * keyboard (the visual viewport). If it does not, the page scrolls by the
 * difference.
 */
function keepComposerInView(view) {
  const box = view.querySelector('.ag-cl-compose');
  if (!box || box.hidden || view.matches('.is-max, .is-kb')) return;
  const vv = window.visualViewport;
  const visible = vv?.height || innerHeight;
  const limit = (vv?.offsetTop || 0) + visible - bottomChrome(view, visible) - 4;
  const r = box.getBoundingClientRect();
  if (r.bottom > limit) window.scrollBy(0, Math.ceil(r.bottom - limit));
}

/**
 * A phone's keyboard covers the page instead of shrinking it, and Claude's
 * input line is at the bottom of the terminal - exactly what it covers. The
 * visual viewport is the part left above the keyboard: while it is much
 * shorter than the page and focus is in this view, the view switches to a
 * typing layout sized to it (bars hidden, special keys shown), and the
 * terminal refits so its bottom line sits on top of the keyboard.
 */
function onViewport() {
  const view = root?.querySelector('.ag-cl-detail');
  if (!view) return;
  const vv = window.visualViewport;
  if (vv) {
    view.style.setProperty('--ag-cl-vvh', `${Math.round(vv.height)}px`);
    view.style.setProperty('--ag-cl-vvtop', `${Math.round(vv.offsetTop)}px`);
  }
  const keyboard = !!vv && vv.scale < 1.05
    && document.documentElement.clientHeight - vv.height > 120
    && view.contains(document.activeElement);
  const was = view.classList.contains('is-kb');
  view.classList.toggle('is-kb', keyboard);
  // The keyboard going away leaves the page wherever the browser scrolled it
  // to reveal the input; the normal view fits from the top.
  if (was && !keyboard && !S.max) window.scrollTo(0, 0);
  lockPage();
  sizeTerminal();
}

let viewportWatch = null;
let typeWatch = false;
function watchViewport() {
  if (viewportWatch) return;
  const vv = window.visualViewport;
  let raf = 0;
  const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(onViewport); };
  vv?.addEventListener('resize', run);
  vv?.addEventListener('scroll', run);
  window.addEventListener('resize', run);
  document.addEventListener('focusin', run);
  document.addEventListener('focusout', run);
  viewportWatch = () => {
    vv?.removeEventListener('resize', run);
    vv?.removeEventListener('scroll', run);
    window.removeEventListener('resize', run);
    document.removeEventListener('focusin', run);
    document.removeEventListener('focusout', run);
  };
}

/** The message box shows under the transcript always, under the terminal when asked. */
const composeShown = () => S.compose || S.pane === 'transcript';

function setCompose(on) {
  S.compose = on;
  pref('ag-cl-compose', on ? '1' : '0');
  const view = root?.querySelector('.ag-cl-detail');
  if (!view) return;
  view.classList.toggle('has-compose', on);
  const box = view.querySelector('.ag-cl-compose');
  box.hidden = !composeShown();
  const s = session(S.detail);
  if (s) {
    view.querySelector('.ag-cl-panes').replaceChildren(...paneTabs(s));
    view.querySelector('.ag-cl-callouts').replaceChildren(...detailCallouts(s));
  }
  sizeTerminal();
  if (on) box.querySelector('.ag-cl-input')?.focus();
}

function setKeys(on) {
  S.keys = on;
  pref('ag-cl-keys', on ? '1' : '0');
  S.term?.toggleKeys(on);
  const s = session(S.detail);
  if (s) {
    root.querySelector('.ag-cl-panes')?.replaceChildren(...paneTabs(s));
    paintTxKeys(s);
  }
  sizeTerminal();
}

function paneTabs(s) {
  const term = S.pane === 'terminal';
  return [
    el('div', { class: 'segctl ag-cl-pane-tabs', role: 'group', 'aria-label': 'View' },
      el('button', { type: 'button', 'aria-pressed': String(term), onclick: () => switchPane('terminal') }, svg('terminal'), 'Terminal'),
      el('button', { type: 'button', 'aria-pressed': String(!term), onclick: () => switchPane('transcript') }, svg('log'), 'Transcript')),
    el('div', { class: 'ag-cl-term-bar' },
      term ? el('span', { class: 'meta ag-cl-term-state' }, !online(s.device) ? 'offline' : S.termState || (s.alive ? 'connecting…' : 'not running')) : null,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        'aria-pressed': String(S.keys),
        title: 'Keys a phone keyboard lacks: Esc, arrows, Tab, Ctrl+C, y and n, 1 to 3',
        'aria-label': 'Special keys',
        onclick: () => setKeys(!S.keys),
      }, svg('keyboard'), lbl('Keys')),
      term ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Copy the selection, or pick text to copy (a long press does this on a phone)', 'aria-label': 'Copy', onclick: () => copyFromTerminal(s) }, svg('copy'), lbl('Copy')) : null,
      term ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Reconnect', 'aria-label': 'Reconnect', onclick: () => S.term?.reconnect() }, svg('refresh'), lbl('Reconnect')) : null,
      term ? el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        'aria-pressed': String(S.compose),
        title: S.compose ? 'Hide the message box' : 'Show a message box under the terminal',
        'aria-label': S.compose ? 'Hide message box' : 'Message box',
        onclick: () => setCompose(!S.compose),
      }, svg('edit'), lbl(S.compose ? 'Hide message' : 'Message')) : null,
      S.max ? null : el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Fill the window with this session', 'aria-label': 'Maximize', onclick: () => setMax(true) }, svg('full'), lbl('Maximize'))),
  ];
}

function switchPane(pane) {
  const s = session(S.detail);
  if (!s) return;
  S.pane = pane;
  pref('ag-cl-pane', pane);
  const view = root.querySelector('.ag-cl-detail');
  view?.classList.toggle('is-tx', pane === 'transcript');
  root.querySelector('.ag-cl-panes')?.replaceChildren(...paneTabs(s));
  const box = root.querySelector('.ag-cl-compose');
  if (box) box.hidden = !composeShown();
  view?.querySelector('.ag-cl-callouts')?.replaceChildren(...detailCallouts(s));
  mountPane(s);
}

function stopPane() {
  S.term?.teardown();
  S.term = null;
  clearTimeout(S.transcript.timer);
  S.transcript.timer = null;
  S.transcript.gen += 1;
  clearTimeout(S.prompt.timer);
  S.prompt.timer = null;
  S.prompt.gen += 1;
  clearTimeout(S.agents.timer);
  S.agents.gen += 1;
}

function mountPane(s) {
  const body = root.querySelector('.ag-cl-body');
  if (!body) return;
  stopPane();
  if (S.pane === 'terminal') {
    const label = (t) => { S.termState = null; const x = root.querySelector('.ag-cl-term-state'); if (x) x.textContent = t; };
    if (!online(s.device)) {
      label('offline');
      body.replaceChildren(el('div', { class: 'empty ag-cl-noterm' },
        svg('terminal'),
        el('b', {}, `${devLabel(s.device)} is offline`),
        el('p', {}, 'The terminal comes back when the machine does. Nothing here is lost.')));
      requestAnimationFrame(sizeTerminal);
      return;
    }
    if (!s.alive) {
      label('not running');
      body.replaceChildren(el('div', { class: 'empty ag-cl-noterm' },
        svg('terminal'),
        el('b', {}, 'Not running'),
        el('p', {}, s.state === 'paused'
          ? `Paused until ${at(s.pausedUntil)}. It starts again on its own; "Resume now" tries sooner.`
          : 'The conversation is kept. Resume it to get the terminal back, or read the transcript.'),
        s.state === 'paused' ? null : el('button', { class: 'btn btn--sm', type: 'button', onclick: () => act(`resume:${s.id}`, () => post(s.device, `/sessions/${s.id}/resume`, {}).then((v) => upsert(s.device, v)), 'Resuming') }, svg('play'), 'Resume')));
      requestAnimationFrame(sizeTerminal);
      return;
    }
    S.termState = 'connecting';
    requestAnimationFrame(sizeTerminal);
    S.term = startTerminal({
      host: body,
      ctx,
      path: `/d/${encodeURIComponent(s.device)}/sessions/${s.id}/terminal`,
      keys: S.keys,
      onImage: (file) => sendImage(s.device, s.id, file),
      onPick: () => pickText(s),
      onState: (st, detail) => {
        S.termState = st;
        if (st === 'connected') focusTerminal();
        const stateEl = root?.querySelector('.ag-cl-term-state');
        if (stateEl) stateEl.textContent = detail ? `${st} · ${detail}` : st;
      },
    });
    return;
  }
  mountTranscript(s, body);
}

/* ── the transcript ─────────────────────────────────────────────────── */

const cap = (dev) => (S.caps[dev] ||= {});
/** An express 404 for a route an older runner does not have. */
const missingRoute = (e) => /^(not found|cannot (get|post))/i.test(String(e?.message || ''));

/**
 * The session's record, kept per session: coming back to this pane draws it
 * again at once (the same nodes) and then asks only for what is new.
 */
function mountTranscript(s, body) {
  const T = S.transcript;
  // Which conversation: the session's own, or one of its subagents'. Read
  // only either way: the message box stays bound to the session.
  // The choice survives the console mounting this module again (it did not:
  // a reload put every subagent view back on the session).
  if (S.agents.id !== s.id) S.agents = { id: s.id, list: null, timer: null, gen: S.agents.gen + 1, viewing: savedAgent(s.id) };
  const agent = S.agents.viewing;
  const key = `${s.id}:${agent || ''}`;
  const base = agent ? `/sessions/${s.id}/agents/${encodeURIComponent(agent)}/transcript` : `/sessions/${s.id}/transcript`;
  if (T.key !== key || !T.view) {
    T.view?.destroy();
    T.id = s.id;
    T.key = key;
    T.cursor = null;
    T.view = createTranscript({
      el,
      svg,
      modelLabel: (id) => (id ? modelLabel(id) : null),
      toast: ctx.toast,
      onEarlier: (before) => api(s.device, `${base}?detail=1&before=${before}`),
      onAgent: agent ? null : (toolUseId) => openAgentFor(s, toolUseId),
    });
  }
  // Each mount is a generation: a pull still in flight from an earlier one
  // (Transcript, Terminal, Transcript inside a request) must not append to
  // the list or start a second loop.
  const gen = T.gen;
  const view = T.view;
  let bar = body.querySelector(':scope > .ag-cl-agentbar');
  if (view.el.parentNode !== body) {
    bar = el('div', { class: 'ag-cl-agentbar' });
    body.replaceChildren(bar, view.el);
    requestAnimationFrame(() => { sizeTerminal(); view.scroll.scrollTop = view.scroll.scrollHeight; });
  }
  paintAgentBar(s);
  const current = () => S.transcript === T && T.gen === gen && T.key === key && S.pane === 'transcript' && S.detail === s.id;
  const pull = async () => {
    try {
      const first = T.cursor == null;
      const r = await api(s.device, `${base}?detail=1${first ? '' : `&cursor=${T.cursor}`}`);
      if (!current()) return;
      if (first) {
        // An older runner sends no `start`: it cannot page back.
        cap(s.device).detail = r.start != null;
        view.reset(r.messages || [], { start: r.start, truncated: r.start != null && r.truncated, older: r.start == null && !!r.truncated });
      } else view.append(r.messages || []);
      T.cursor = r.cursor;
      view.error(null);
      if (!agent) paintQueued(session(s.id) || s);
      paintLive(session(s.id) || s);
      paintAgentBar(session(s.id) || s);
    } catch (e) {
      if (!current()) return;
      view.error(agent ? `Could not read this subagent: ${e.message}` : `Could not read the transcript: ${e.message}`);
    }
    if (!current()) return;
    const busy = ['running', 'starting', 'waiting'].includes(session(s.id)?.state)
      || (agent && S.agents.list?.find((a) => a.id === agent)?.running);
    T.timer = setTimeout(pull, document.hidden ? 10000 : busy ? 2000 : 4000);
  };
  pull();
  watchPrompt(s);
  watchAgents(s);
  paintTxKeys(s);
  paintLive(s);
}

/* ── subagents ──────────────────────────────────────────────────────── */

/** The session's subagents, kept fresh while the transcript is open. */
function watchAgents(s) {
  const A = S.agents;
  clearTimeout(A.timer);
  const gen = ++A.gen;
  const run = async () => {
    if (A.gen !== gen || S.pane !== 'transcript' || S.detail !== s.id) return;
    const cur = session(s.id) || s;
    if (online(cur.device) && cap(cur.device).agents !== false) {
      try {
        const r = await api(cur.device, `/sessions/${cur.id}/agents?limit=60`);
        if (A.gen !== gen) return;
        const before = JSON.stringify((A.list || []).filter((a) => a.running).map((a) => a.id));
        A.list = r.agents || [];
        cap(cur.device).agents = true;
        // The head's subagent count follows this list (bgOf): repaint it on a change.
        if (before !== JSON.stringify(A.list.filter((a) => a.running).map((a) => a.id)) && S.detail === cur.id) paintDetail();
      } catch (e) {
        if (missingRoute(e)) cap(cur.device).agents = false;
      }
    }
    if (A.gen !== gen) return;
    paintAgentBar(cur);
    if (cap(cur.device).agents === false) return;
    const busy = cur.alive && (['running', 'starting'].includes(cur.state) || A.list?.some((a) => a.running));
    A.timer = setTimeout(run, document.hidden ? 20000 : busy ? 5000 : 15000);
  };
  run();
}

/** Show a subagent's transcript, or the session's own (null). */
// Messages sent while the session was mid-turn, kept until they show up in
// the transcript (sessionStorage, so a reload does not lose them).
/**
 * The session's background work for display, with the subagent count taken
 * from the same list the subagent picker uses (finished = a completion
 * notice in the log), so the head, the picker and the live line agree.
 */
function bgOf(s) {
  const b = s.background;
  const A = S.agents;
  if (!A || A.id !== s.id || !Array.isArray(A.list)) return b;
  const running = A.list.filter((a) => a.running).length;
  const shells = b?.shells || 0;
  if (!running && !shells) return null;
  return { ...(b || {}), subagents: running, shells };
}

const QUEUE_KEY = 'ag-cl-queued:';
function queued(id) { try { return JSON.parse(sessionStorage.getItem(QUEUE_KEY + id) || '[]'); } catch { return []; } }
function setQueued(id, list) { try { if (list.length) sessionStorage.setItem(QUEUE_KEY + id, JSON.stringify(list)); else sessionStorage.removeItem(QUEUE_KEY + id); } catch { /* private window */ } }
/** Drop the queued messages that have arrived (or are two hours old), then draw the rest. */
function paintQueued(s) {
  const view = S.transcript.id === s.id && !S.agents.viewing ? S.transcript.view : null;
  let list = queued(s.id).filter((q) => Date.now() - q.at < 7200000);
  if (view) list = list.filter((q) => !view.hasUserText(q.text, q.at));
  setQueued(s.id, list);
  view?.setPending(list);
}

const AGENT_KEY = 'ag-cl-agent:';
function savedAgent(id) { try { return sessionStorage.getItem(AGENT_KEY + id) || null; } catch { return null; } }
function saveAgent(id, agent) { try { if (agent) sessionStorage.setItem(AGENT_KEY + id, agent); else sessionStorage.removeItem(AGENT_KEY + id); } catch { /* private window */ } }

function viewAgent(s, id) {
  closePop();
  S.agents.viewing = id;
  saveAgent(s.id, id);
  updateComposer(s);
  clearTimeout(S.transcript.timer);
  S.transcript.gen += 1;
  const body = root?.querySelector('.ag-cl-body');
  if (body) mountTranscript(s, body);
}

/** "Open its transcript" on an Agent or Task call in the main view. */
async function openAgentFor(s, toolUseId) {
  if (cap(s.device).agents === false) { tooOldForAgents(s); return; }
  let a = S.agents.list?.find((x) => x.toolUseId === toolUseId);
  if (!a) {
    try {
      const r = await api(s.device, `/sessions/${s.id}/agents?limit=200`);
      a = (r.agents || []).find((x) => x.toolUseId === toolUseId);
    } catch (e) { if (missingRoute(e)) { cap(s.device).agents = false; tooOldForAgents(s); return; } }
  }
  if (!a) { ctx.toast?.('err', 'No transcript for that agent', 'Claude Code did not keep one, or it is older than the list goes.'); return; }
  viewAgent(s, a.id);
}

const tooOldForAgents = (s) => ctx.toast?.('err', 'This runner is too old for subagent views', `Restart the Claude runner on ${devLabel(s.device)} (ojee-claude) to read subagents here.`);

/**
 * The switcher above the transcript, shown only when there are subagents:
 * the session, then each subagent with what it was asked to do and whether
 * it still runs. An older runner gets one plain line saying so instead,
 * when the transcript shows the session has subagents at all.
 */
function paintAgentBar(s) {
  const bar = root?.querySelector('.ag-cl-agentbar');
  if (!bar || !s || openPop?.anchor && bar.contains(openPop.anchor)) return;
  const A = S.agents;
  // Running subagents only (owner, 4 Nov); the one being read stays listed after it finishes.
  const list = (A.id === s.id ? A.list || [] : []).filter((a) => a.running || a.id === A.viewing);
  if (cap(s.device).agents === false) {
    const has = (s.background?.subagents || 0) > 0 || S.transcript.view?.hasAgents?.();
    delete bar.dataset.sig;
    bar.replaceChildren(...(has ? [el('div', { class: 'ag-cl-agentnote' }, svg('info'),
      el('span', {}, `Subagent transcripts need a newer Claude runner on ${devLabel(s.device)}. Restart ojee-claude there to switch to them here.`))] : []));
    requestAnimationFrame(sizeTerminal);
    return;
  }
  if (!list.length && !A.viewing) { delete bar.dataset.sig; if (bar.firstChild) { bar.replaceChildren(); requestAnimationFrame(sizeTerminal); } return; }
  const viewing = A.viewing ? list.find((a) => a.id === A.viewing) || { id: A.viewing, description: A.viewing } : null;
  const running = list.filter((a) => a.running).length;
  const name = (a) => a.description || a.type || a.id;
  // Rebuild only when what the bar shows changed. It was rebuilt on every
  // transcript poll (every 2 s while a session works), so a tap that landed
  // mid-rebuild hit a button that was already gone and the menu never opened.
  const sig = JSON.stringify([s.id, A.viewing, viewing?.running, list.map((a) => [a.id, a.running, name(a)])]);
  if (bar.dataset.sig === sig && bar.firstChild) return;
  bar.dataset.sig = sig;
  const pick = el('button', {
    class: 'ag-cl-agentpick',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    title: 'Switch between the session and its subagents',
    onclick: (e) => popMenu(e.currentTarget, [
      { label: 'Main session', lead: svg('terminal'), meta: 'you talk to this', current: !A.viewing, onclick: () => viewAgent(s, null) },
      ...list.map((a) => ({
        label: name(a),
        lead: el('span', { class: a.running ? 'dot dot--live' : 'dot dot--ok' }),
        meta: `${a.running ? 'running' : 'done'} · ${ago(a.modified)}`,
        current: a.id === A.viewing,
        onclick: () => viewAgent(s, a.id),
      })),
    ], 'Session and subagents'),
  },
  viewing ? el('span', { class: viewing.running ? 'dot dot--live' : 'dot dot--ok' }) : svg('terminal'),
  el('span', { class: 'ag-cl-agentpick-label' }, viewing ? `Subagent: ${name(viewing)}` : 'Main session'),
  el('span', { class: 'ag-cl-agentpick-count' }, `${running} running`),
  svg('chevron', 'ic ag-cl-mx-chev'));
  bar.replaceChildren(...[pick,
    viewing ? el('button', { class: 'btn btn--ghost btn--sm ag-cl-agentback', type: 'button', title: 'Back to the main session', onclick: () => viewAgent(s, null) }, svg('back'), lbl('Main')) : null].filter(Boolean));
  bar.classList.toggle('is-agent', !!viewing);
  requestAnimationFrame(sizeTerminal);
}

/** Pull both the transcript and the screen soon: something was just sent. */
function kick() {
  // For a few seconds after anything is sent, watch the screen closely: a
  // command may open a menu, a key may close one.
  S.prompt.fastUntil = Date.now() + 12000;
  const s = session(S.detail);
  if (!s || S.pane !== 'transcript') return;
  setTimeout(() => {
    if (S.detail !== s.id || S.pane !== 'transcript') return;
    const body = root?.querySelector('.ag-cl-body');
    if (!body) return;
    clearTimeout(S.transcript.timer);
    S.transcript.gen += 1;
    clearTimeout(S.prompt.timer);
    S.prompt.gen += 1;
    mountTranscript(session(s.id) || s, body);
  }, 700);
}

/**
 * The screen beside the transcript: a menu open in the terminal (drawn as
 * buttons), the spinner line, background agents, unsent input. Polled while
 * the transcript is open: often while it works or asks, slowly otherwise.
 */
function watchPrompt(s) {
  const P = S.prompt;
  if (P.id !== s.id) { P.id = s.id; P.data = null; }
  const gen = P.gen;
  const run = async () => {
    if (P.gen !== gen || S.pane !== 'transcript' || S.detail !== s.id) return;
    const cur = session(s.id) || s;
    if (cur.alive && online(cur.device) && cap(cur.device).prompt !== false) {
      try { P.data = await api(cur.device, `/sessions/${cur.id}/prompt`); }
      catch (e) { if (missingRoute(e)) cap(cur.device).prompt = false; P.data = null; }
    } else P.data = null;
    if (P.gen !== gen) return;
    paintMenu(cur);
    paintLive(cur);
    if (cap(cur.device).prompt === false) return;
    const busy = ['running', 'starting', 'waiting'].includes(cur.state) || P.data?.menu || Date.now() < (P.fastUntil || 0);
    P.timer = setTimeout(run, document.hidden ? 10000 : busy ? 1200 : 4000);
  };
  run();
}

const ONE_LINE = (t, n = 160) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

/** One line: what the session is doing now. */
function paintLive(s) {
  const box = root?.querySelector('.ag-cl-live');
  if (!box || !s) return;
  const p = S.prompt.id === s.id ? S.prompt.data : null;
  const tool = S.transcript.id === s.id ? S.transcript.view?.running() : null;
  let state = s.state;
  let main;
  let sub = '';
  if (!online(s.device)) { state = 'stopped'; main = 'Offline'; sub = offWhy(devOf(s.device)) || ''; }
  else if (!s.alive) {
    main = s.state === 'paused' ? 'Paused' : s.state === 'queued' ? 'Queued' : 'Not running';
    sub = s.state === 'paused' ? `resumes on its own at ${at(s.pausedUntil)}` : 'a message resumes it';
  } else if (p?.menu) { state = 'waiting'; main = 'Waiting on you'; sub = 'a menu is open in the terminal: pick below'; }
  else if (s.state === 'waiting') { main = 'Waiting on you'; sub = ONE_LINE(s.question?.text || s.detail); }
  else if (s.state === 'running' || s.state === 'starting') {
    main = p?.activity ? ONE_LINE(p.activity, 90) : tool ? `Running ${tool.tool}` : s.state === 'starting' ? 'Starting' : 'Working';
    sub = tool ? ONE_LINE(tool.input?.description || tool.text, 120) : ONE_LINE(s.detail || '');
  } else {
    main = STATE[s.state]?.label || s.state;
    main = main.charAt(0).toUpperCase() + main.slice(1);
    sub = ONE_LINE(s.detail || (s.lastActivityAt ? `last activity ${ago(s.lastActivityAt)}` : ''));
  }
  const agents = p?.agents || [];
  // Rebuild only on a change, and keep the agents list open across rebuilds:
  // it folded shut every two seconds while a session worked.
  const sig = JSON.stringify([state, main, sub, agents, p?.mode, p?.draft, p?.suggestion]);
  if (box.dataset.sig === sig && box.firstChild) return;
  box.dataset.sig = sig;
  box.replaceChildren(...[
    el('span', { class: `ag-cl-live-dot ag-cl-live-dot--${state}` }),
    el('span', { class: 'ag-cl-live-main', title: String(main || '') }, main),
    sub ? el('span', { class: 'ag-cl-live-sub', title: sub }, sub) : null,
    agents.length ? el('details', { class: 'ag-cl-live-agents', open: S.liveAgentsOpen || false, ontoggle: (e) => { S.liveAgentsOpen = e.currentTarget.open; } },
      el('summary', { title: agents.map((a) => `${a.name}: ${a.doing}`).join('\n') }, `${agents.length} agent${agents.length === 1 ? '' : 's'}`),
      el('div', { class: 'ag-cl-live-agentlist' }, agents.map((a) => el('div', { title: `${a.name}: ${a.doing}${a.meta ? ` · ${a.meta}` : ''}` }, el('b', {}, a.name), ` ${a.doing}`, a.meta ? el('span', { class: 'meta' }, ` · ${a.meta}`) : null)))) : null,
    p?.mode ? el('span', { class: 'ag-cl-live-mode', title: 'Permission mode (Shift+Tab switches it)' }, p.mode) : null,
    p?.draft ? el('span', { class: 'ag-cl-live-draft', title: 'Typed in the terminal and not sent. A message from here is added after it.' }, `Unsent in the terminal: ${ONE_LINE(p.draft, 60)}`) : null,
    // Claude Code's suggested next message (faint in its input box; Tab takes it there).
    p?.suggestion ? el('span', { class: 'ag-cl-live-sug', title: p.suggestion },
      el('span', { class: 'ag-cl-live-sugk' }, 'Suggested'),
      el('span', { class: 'ag-cl-live-sugt' }, ONE_LINE(p.suggestion, 90)),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Put it in the message box to edit', onpointerdown: (e) => e.preventDefault(),
        onclick: () => { const t = root.querySelector('.ag-cl-input'); if (!t) return; t.value = p.suggestion; t.dispatchEvent(new Event('input')); t.focus(); } }, 'Use'),
      el('button', { class: 'btn btn--sm', type: 'button', title: 'Send it as it is',
        onclick: () => { const t = root.querySelector('.ag-cl-input'); if (!t) return; t.value = p.suggestion; send(s.id); } }, 'Send')) : null,
  ].filter(Boolean));
}

/** A menu open in the terminal, as buttons that pick its options. */
function paintMenu(s) {
  const box = root?.querySelector('.ag-cl-menu');
  if (!box || !s) return;
  const p = S.prompt.id === s.id ? S.prompt.data : null;
  const menu = S.pane === 'transcript' && s.alive ? p?.menu : null;
  const sig = menu ? JSON.stringify(menu) : '';
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!menu) { box.replaceChildren(); requestAnimationFrame(sizeTerminal); return; }
  const busy = () => S.busy.has(`key:${s.id}`);
  box.replaceChildren(el('div', { class: 'ag-cl-menu-card', role: 'group', 'aria-label': menu.title || 'Menu' },
    menu.title ? el('div', { class: 'ag-cl-menu-title' }, menu.title) : null,
    el('div', { class: 'ag-cl-menu-opts' }, menu.options.map((o) => el('button', {
      class: `ag-cl-opt${o.selected ? ' is-cur' : ''}`,
      type: 'button',
      disabled: busy(),
      onclick: () => choose(s, o.n),
    }, el('span', { class: 'ag-cl-opt-n' }, String(o.n)),
    el('span', { class: 'ag-cl-opt-main' }, el('span', { class: 'ag-cl-opt-label' }, o.label), o.desc ? el('span', { class: 'ag-cl-opt-desc' }, o.desc) : null)))),
    menu.more ? el('div', { class: 'meta' }, 'More options below: move with ↑ and ↓ under Keys, then Enter.') : null,
    el('div', { class: 'ag-cl-menu-foot' },
      el('span', { class: 'meta' }, menu.multi ? 'Several can be picked: each tap toggles one, then pick Submit or press Enter.' : (menu.footer || '')),
      el('div', { class: 'ag-cl-menu-keys' },
        (menu.hotkeys || []).map((h) => el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: `${h.key}: ${h.label} (for the highlighted option)`, onclick: () => sendKey(s, h.key) }, `${h.key} · ${h.label}`)),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Close the menu (Esc)', onclick: () => sendKey(s, 'Escape') }, 'Esc')))));
  requestAnimationFrame(sizeTerminal);
}

/** The key row under the transcript, sent through the runner. */
function paintTxKeys(s) {
  const box = root?.querySelector('.ag-cl-txkeys');
  if (!box) return;
  if (!S.keys) { box.replaceChildren(); return; }
  if (!box.firstChild) box.append(keyStrip((k) => sendKey(session(S.detail) || s, k[2])));
}

/** Keys from the console, for a runner that may not have /keys yet. */
async function keysApi(s, body) {
  if (cap(s.device).keys === false) throw Object.assign(new Error('old runner'), { old: true });
  try { return await post(s.device, `/sessions/${s.id}/keys`, body); } catch (e) {
    if (missingRoute(e)) { cap(s.device).keys = false; throw Object.assign(new Error('old runner'), { old: true }); }
    throw e;
  }
}
const oldRunner = (s) => ctx.toast?.('err', 'Not on this runner yet', `The Claude runner on ${devLabel(s.device)} is older than this console. Update it, or use the terminal.`);

async function sendKey(s, key) {
  if (!s?.alive) { ctx.toast?.('err', 'Not running', 'Resume the session first.'); return; }
  try {
    await keysApi(s, { keys: [key] });
  } catch (e) {
    if (e.old && key === 'Escape') { await interrupt(s); return; }
    if (e.old) { oldRunner(s); return; }
    ctx.toast?.('err', 'The key did not go through', e.message);
    return;
  }
  S.prompt.fastUntil = Date.now() + 12000;
  setTimeout(() => { S.prompt.gen += 1; clearTimeout(S.prompt.timer); if (S.pane === 'transcript') watchPrompt(s); }, 350);
}

async function choose(s, n) {
  const r = await act(`key:${s.id}`, () => keysApi(s, { choose: n }).catch((e) => { if (e.old) { oldRunner(s); return null; } throw e; }));
  if (r) { upsert(s.device, r); kick(); }
}

async function interrupt(s) {
  await act(`int:${s.id}`, () => post(s.device, `/sessions/${s.id}/interrupt`));
  kick();
}

/**
 * Copy out of the terminal: the selection if there is one (or what a drag
 * selected last), else the sheet to pick text from.
 */
async function copyFromTerminal(s) {
  if (S.term && await S.term.copy()) return;
  pickText(s);
}

const URLS = /https?:\/\/[^\s<>"'`│┃]+[^\s<>"'`│┃.,;:!?)\]]/g;
/** Text with its URLs as links. */
function linkified(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URLS)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { class: 'ag-cl-md-a', href: m[0], target: '_blank', rel: 'noreferrer noopener' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/**
 * The terminal as plain text in a sheet, where a phone's own selection
 * handles (or a mouse) pick what to copy and links open on a tap. The text
 * is tmux's: the screen and its scrollback, wrapped lines joined.
 */
async function pickText(s) {
  const pre = el('pre', { class: 'ag-cl-pick-pre', tabindex: '0' }, 'Loading…');
  const note = el('span', { class: 'meta' }, 'Select text, then Copy selection. Links open on a tap.');
  const keepSel = (e) => e.preventDefault();
  const copyBtn = (label, get) => el('button', {
    class: 'btn btn--sm',
    type: 'button',
    onpointerdown: keepSel,
    onmousedown: keepSel,
    onclick: async () => {
      const t = get();
      if (!t) { note.textContent = 'Nothing selected yet.'; return; }
      const ok = await copyText(t);
      note.textContent = ok ? `Copied ${t.length} characters.` : 'The browser refused the clipboard.';
    },
  }, svg('copy'), label);
  let text = '';
  const body = el('div', { class: 'stack ag-cl-pick' },
    pre,
    el('div', { class: 'ag-cl-pick-bar' },
      copyBtn('Copy selection', () => {
        const sel = window.getSelection();
        return sel && pre.contains(sel.anchorNode) ? sel.toString() : '';
      }),
      copyBtn('Copy all', () => text),
      note));
  const done = ctx.modal({ title: 'Copy from the terminal', body, actions: [{ label: 'Close', value: false, variant: 'ghost' }] });
  try {
    const r = await api(s.device, `/sessions/${s.id}/screen?history=3000`);
    text = String(r.screen || '');
  } catch { text = ''; }
  if (!text.trim()) text = S.term?.bufferText() || '';
  text = text.replace(/\s+$/, '');
  pre.replaceChildren(...linkified(text || '(the terminal is empty)'));
  requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
  await done;
}

/* ── the message box ────────────────────────────────────────────────── */

/**
 * The commands people reach for. Anything else can be typed: the box sends
 * whatever starts with "/" to Claude Code as it is. [name, what it does,
 * takes words after it]
 */
const SLASH = [
  ['/compact', 'Summarise the conversation to free context; words after it say what to keep', true],
  ['/clear', 'Start a fresh conversation in this session'],
  ['/model', 'Pick the model (opens a menu)'],
  ['/context', 'How full the context window is'],
  ['/usage', 'Plan usage and when limits reset'],
  ['/cost', 'Tokens and cost so far'],
  ['/status', 'Version, model, account'],
  ['/todos', 'The current to-do list'],
  ['/tasks', 'Background tasks and shells'],
  ['/agents', 'Subagents'],
  ['/mcp', 'MCP servers'],
  ['/memory', 'Memory files'],
  ['/permissions', 'Allow and deny rules'],
  ['/review', 'Review a pull request', true],
  ['/init', 'Write a CLAUDE.md for this folder'],
  ['/rewind', 'Go back to an earlier point'],
  ['/export', 'Export the conversation'],
  ['/add-dir', 'Add a working folder', true],
  ['/config', 'Settings'],
  ['/hooks', 'Hooks'],
  ['/doctor', 'Check the installation'],
  ['/help', 'Every command'],
];

const touch = () => window.matchMedia('(pointer: coarse)').matches;

function composer(s) {
  const text = el('textarea', {
    class: 'textarea ag-cl-input',
    rows: '1',
    enterkeyhint: touch() ? 'enter' : 'send',
    autocomplete: 'off',
    'aria-label': 'Message',
  });
  const slash = el('div', { class: 'ag-cl-slash', role: 'listbox', 'aria-label': 'Commands', hidden: true });
  let pick = 0;
  let matches = [];
  // Grows with what is typed, up to a share of what is visible: on a phone a
  // tall box would push itself under the bottom bar or the keyboard.
  const grow = () => {
    const visible = window.visualViewport?.height || innerHeight;
    const cap = innerWidth <= 560 || touch() ? Math.max(66, Math.min(160, Math.round(visible * 0.24))) : 220;
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight + 2, cap)}px`;
  };
  const closeSlash = () => { slash.hidden = true; matches = []; };
  const drawSlash = () => {
    const v = text.value;
    const m = /^\/(\S*)$/.exec(v);
    if (!m) { closeSlash(); return; }
    matches = SLASH.filter(([n]) => n.slice(1).startsWith(m[1].toLowerCase()));
    if (!matches.length) { closeSlash(); return; }
    pick = Math.min(pick, matches.length - 1);
    slash.replaceChildren(...matches.map(([n, d], i) => el('button', {
      class: `ag-cl-slash-item${i === pick ? ' is-cur' : ''}`,
      type: 'button',
      role: 'option',
      'aria-selected': String(i === pick),
      onpointerdown: (e) => e.preventDefault(),
      onclick: () => useSlash(i, true),
    }, el('span', { class: 'ag-cl-slash-name' }, n), el('span', { class: 'ag-cl-slash-desc' }, d))));
    slash.hidden = false;
    slash.querySelector('.is-cur')?.scrollIntoView({ block: 'nearest' });
  };
  /** A command picked: one that takes words waits for them; the rest go now. */
  const useSlash = (i, go) => {
    const c = matches[i];
    if (!c) return;
    closeSlash();
    if (c[2] || !go) { text.value = `${c[0]} `; grow(); text.focus(); return; }
    text.value = c[0];
    send(s.id);
  };
  let hist = -1;
  text.addEventListener('input', () => { pick = 0; hist = -1; grow(); drawSlash(); });
  text.addEventListener('blur', () => setTimeout(closeSlash, 150));
  text.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the console's own shortcuts stay out of the box
    if (!slash.hidden && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        drawSlash();
        return;
      }
      if (e.key === 'Tab') { e.preventDefault(); useSlash(pick, false); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch()) { e.preventDefault(); useSlash(pick, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.isComposing && ((e.ctrlKey || e.metaKey) || (!e.shiftKey && !e.altKey && !touch()))) {
      e.preventDefault();
      send(s.id);
      return;
    }
    // Up and Down in an empty (or recalled) box walk back through what was sent.
    const sent = S.sent[s.id] || [];
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sent.length && !e.shiftKey
      && (!text.value || (hist >= 0 && text.value === sent[sent.length - 1 - hist]))) {
      e.preventDefault();
      hist = Math.max(-1, Math.min(sent.length - 1, hist + (e.key === 'ArrowUp' ? 1 : -1)));
      text.value = hist < 0 ? '' : sent[sent.length - 1 - hist];
      grow();
      return;
    }
    // Esc in an empty box is the terminal's Esc: it stops the turn or
    // closes a menu.
    if (e.key === 'Escape' && !text.value) {
      e.preventDefault();
      const cur = session(s.id);
      if (cur?.alive) sendKey(cur, 'Escape');
    }
  });
  const imageOf = (list) => [...(list || [])].find((f) => f && f.type && f.type.startsWith('image/'));
  text.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    sendImage(s.device, s.id, item.getAsFile());
  });
  text.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  text.addEventListener('drop', (e) => {
    const f = imageOf(e.dataTransfer?.files);
    if (!f) return;
    e.preventDefault();
    sendImage(s.device, s.id, f);
  });

  const box = el('div', { class: 'ag-cl-compose', hidden: !composeShown() },
    el('div', { class: 'ag-cl-live', 'aria-live': 'polite' }),
    el('div', { class: 'ag-cl-menu' }),
    el('div', { class: 'ag-cl-txkeys' }),
    el('div', { class: 'ag-cl-compose-row' },
      slash,
      el('button', {
        class: 'btn btn--ghost btn--sm ag-cl-sq ag-cl-slashbtn',
        type: 'button',
        title: 'Commands: /compact, /model and the rest',
        'aria-label': 'Commands',
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => { if (!text.value.startsWith('/')) text.value = '/'; pick = 0; text.focus(); grow(); drawSlash(); },
      }, '/'),
      text,
      el('button', { class: 'btn btn--ghost btn--sm ag-cl-sq ag-cl-stopbtn', type: 'button', title: 'Stop the turn (Esc)', 'aria-label': 'Stop the turn', hidden: true, onclick: () => interrupt(session(s.id) || s) }, svg('stop')),
      el('button', { class: 'btn btn--sm ag-cl-send', type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => send(s.id) }, 'Send')),
    el('div', { class: 'ag-cl-compose-bar' },
      el('span', { class: 'meta ag-cl-compose-note' }),
      el('span', { class: 'meta ag-cl-compose-hint' }, touch() ? '/ for commands · Keys for Esc and arrows' : 'Enter sends · Shift+Enter new line · / commands · Esc stops · ↑ last message')));
  // The box grows with what is typed and with a menu; the pane above gives
  // way to it.
  new ResizeObserver(() => sizeTerminal()).observe(box);
  return box;
}

function updateComposer(s) {
  const btn = root.querySelector('.ag-cl-send');
  const note = root.querySelector('.ag-cl-compose-note');
  const input = root.querySelector('.ag-cl-input');
  const stop = root.querySelector('.ag-cl-stopbtn');
  if (!btn || !note || !input) return;
  const busy = S.busy.has(`send:${s.id}`);
  btn.disabled = busy || s.state === 'starting' || !online(s.device);
  btn.textContent = busy ? '…' : s.alive ? 'Send' : 'Resume';
  btn.title = s.alive ? 'Send (Enter)' : 'Resume the session with this message';
  if (stop) stop.hidden = !(s.alive && s.state === 'running');
  const narrow = innerWidth <= 560;
  input.placeholder = s.state === 'waiting' ? (narrow ? 'Answer Claude' : 'Answer Claude, or / for a command')
    : s.alive ? (narrow ? 'Message Claude' : 'Message Claude, or / for a command') : (narrow ? 'Message to resume' : 'Resume the session with a message');
  // Reading a subagent: the box still talks to the session, and says so.
  if (S.agents.viewing && S.agents.id === s.id && s.alive) input.placeholder = narrow ? 'Message the main session' : 'Message the main session (subagents are read only)';
  note.textContent = !online(s.device) ? `${devLabel(s.device)} is offline.`
    : s.state === 'starting' ? 'Starting. Wait a moment.'
      : s.state === 'running' ? 'Working. A message now is queued and read after this step.'
        : s.state === 'queued' ? 'Queued. A message now is added to its first prompt.'
          : s.model?.current !== s.model?.preferred ? `On ${modelLabel(s.model?.current)}; the next message goes back to ${modelLabel(s.model?.preferred)} if it is available.` : '';
}

async function send(id) {
  const input = root.querySelector('.ag-cl-input');
  const text = input?.value.trim();
  if (!text) return;
  const s = session(id);
  if (!s) return;
  const dev = s.device;
  const sent = (S.sent[id] ||= []);
  if (sent[sent.length - 1] !== text) sent.push(text);
  if (sent.length > 50) sent.shift();
  // A slash command, a "!" shell line or a "#" memory line is keyboard input
  // for Claude Code itself, not a message: typed as it is, with no resume or
  // model switch, into a session that is running. Everything else goes as a
  // message, which also resumes a stopped session and answers a question.
  const raw = /^[/!#]/.test(text) && s.alive && cap(dev).keys !== false;
  const busyNow = s.alive && ['running', 'starting'].includes(s.state);
  const r = await act(`send:${id}`, async () => {
    if (raw) {
      try { return await keysApi(s, { text, enter: true }); } catch (e) { if (!e.old) throw e; }
    }
    return post(dev, `/sessions/${id}/message`, { text });
  });
  if (r) {
    input.value = '';
    input.style.height = '';
    if (busyNow && !raw) { setQueued(id, [...queued(id), { text, at: Date.now() }]); paintQueued(s); }
    if (S.transcript.id === id) S.transcript.view?.follow();
    upsert(dev, r);
    paint('session');
    kick();
  }
}

async function rename(s) {
  const input = el('input', { class: 'input', value: s.title, maxlength: '70' });
  const ok = await ctx.modal({ title: 'Rename session', body: el('div', { class: 'field' }, el('label', {}, 'Title'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }] });
  if (!ok || !input.value.trim()) return;
  const v = await act(`rename:${s.id}`, () => api(s.device, `/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ title: input.value.trim() }) }));
  if (v) { upsert(s.device, v); paint('session'); }
}

async function endSession(s) {
  const ok = await ctx.modal({ title: 'End this session?', body: el('p', { class: 'meta' }, 'Claude stops. The conversation is kept and can be resumed later.'), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'End', value: true }] });
  if (!ok) return;
  const v = await act(`end:${s.id}`, () => post(s.device, `/sessions/${s.id}/end`));
  if (v) { upsert(s.device, v); paintDetail(); mountPane(v); }
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
  const r = await act(`del:${s.id}`, () => api(s.device, `/sessions/${s.id}${purge.checked ? '?purge=1' : ''}`, { method: 'DELETE' }), 'Deleted');
  const x = dataOf(s.device);
  if (r) { if (x) x.sessions = x.sessions.filter((y) => y.id !== s.id); go(); }
}

function modelSelect(dev, value, { allowNone = false } = {}) {
  const sel = el('select', { class: 'select' },
    allowNone ? el('option', { value: '' }, 'None') : null,
    (dataOf(dev)?.models || []).map((m) => el('option', { value: m.id }, m.label)));
  sel.value = value || '';
  return sel;
}

function accountSelect(dev, value) {
  const sel = el('select', { class: 'select' }, (dataOf(dev)?.accounts || []).map((a) => el('option', { value: a.id },
    `${a.label}${a.email ? ` · ${a.email}` : ''}${a.status !== 'ok' ? ` (${a.status === 'limited' ? `out until ${at(a.limitedUntil)}` : a.status})` : ''}`)));
  sel.value = value;
  return sel;
}

async function changeSession(s) {
  const dev = s.device;
  const model = modelSelect(dev, s.model?.preferred);
  const fallback = modelSelect(dev, s.model?.fallback, { allowNone: true });
  const account = accountSelect(dev, s.account);
  const done = el('select', { class: 'select' },
    el('option', { value: 'default' }, `Use the setting (${dataOf(dev)?.settings?.notify?.done ? 'on' : 'off'})`),
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
    let v = await api(dev, `/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if ((moveModel || moveAcct) && s.alive) {
      v = await post(dev, `/sessions/${s.id}/relaunch`, { model: moveModel ? model.value : undefined, account: moveAcct ? account.value : undefined });
    }
    upsert(dev, v);
    paint('session');
  }, 'Saved');
}

/* ── new session ────────────────────────────────────────────────────── */

/** Browse the folders of the device the form is for. */
async function browse(p) {
  const dev = S.form?.device || curDev();
  const q = new URLSearchParams();
  if (p) q.set('path', p);
  if (S.hidden) q.set('hidden', '1');
  let next;
  try {
    next = { ...(await api(dev, `/fs?${q}`)), device: dev };
  } catch (e) {
    next = { ...(S.fs?.device === dev ? S.fs : {}), device: dev, error: e.message };
  }
  // The device was switched while this was on its way: drop it.
  if ((S.form?.device || curDev()) !== dev) return;
  S.fs = next;
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
  const dev = f.device;
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
      f.recent.map((r) => el('button', { class: 'ag-cl-chip ag-cl-chip--btn', type: 'button', onclick: () => browse(r), title: r }, shortPath(r, dev)))) : null,
  ].filter(Boolean));
}

async function mkdir() {
  const input = el('input', { class: 'input', placeholder: 'folder name' });
  const dev = S.fs.device;
  const ok = await ctx.modal({ title: `New folder in ${shortPath(S.fs.path, dev)}${multi() ? ` on ${devLabel(dev)}` : ''}`, body: el('div', { class: 'field' }, el('label', {}, 'Name'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Create', value: true }] });
  const name = input.value.trim();
  if (!ok || !name) return;
  if (name.includes('/') && !name.startsWith('/')) { /* allow nested */ }
  const target = name.startsWith('/') ? name : `${S.fs.path.replace(/\/$/, '')}/${name}`;
  const r = await act('mkdir', () => post(dev, '/fs/mkdir', { path: target }));
  if (r) browse(r.path);
}

/** The device a new session goes to: the last one used, else the first; never one that is offline. */
function newDevice() {
  const usable = (id) => online(id) && dataOf(id);
  const last = pref('ag-cl-newdev');
  if (last && usable(last)) return last;
  return (S.devs.find((d) => usable(d.id)) || S.devs.find((d) => d.data) || S.devs[0]).id;
}

/** The per-device parts of the form: folder, model, account - from that runner's settings. */
function formFor(dev, keep = {}) {
  const x = dataOf(dev) || {};
  const set = x.settings || {};
  return {
    prompt: '', title: '', notifyDone: 'default', autoContinue: 0,
    ...keep,
    device: dev,
    cwd: x.runner?.defaultCwd || '',
    model: set.defaultModel,
    fallback: set.fallbackModel || '',
    account: set.activeAccount,
    unattended: keep.unattended ?? set.unattended !== false,
  };
}

function setFormDevice(dev) {
  if (!S.form || S.form.device === dev) return;
  const { prompt, title, notifyDone, autoContinue, unattended } = S.form;
  S.form = formFor(dev, { prompt, title, notifyDone, autoContinue, unattended });
  S.fs = null;
  paintNew();
}

function devPick() {
  const F = S.form;
  return [
    el('div', { class: 'segctl ag-cl-devswitch', role: 'group', 'aria-label': 'Device' },
      S.devs.map((d) => el('button', {
        type: 'button',
        'aria-pressed': String(F.device === d.id),
        disabled: !d.online || !d.data,
        title: offWhy(d) || `Run it on ${d.label}`,
        onclick: () => setFormDevice(d.id),
      }, el('span', { class: d.online ? 'dot dot--ok ag-cl-devdot' : 'dot ag-cl-devdot' }), d.label))),
    ...S.devs.filter((d) => !d.online).map((d) => el('p', { class: 'meta ag-cl-devoff' }, offWhy(d))),
    F.device && !online(F.device) ? el('div', { class: 'alert alert--warn' }, el('b', {}, 'Offline'),
      el('span', {}, `${devLabel(F.device)} went offline. Pick another device, or wait for it.`)) : null,
  ];
}

/** A device coming or going while the form is open: only the picker changes. */
function paintDevPick() {
  const host = root?.querySelector('.ag-cl-devpick');
  if (!host || !S.form) return;
  host.replaceChildren(...devPick().filter(Boolean));
}

function paintNew() {
  if (!S.form || !devOf(S.form.device)) S.form = formFor(newDevice());
  const F = S.form;
  const set = dataOf(F.device)?.settings || {};
  const bind = (k, conv = (v) => v) => (e) => { F[k] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); };

  const cwd = el('input', {
    class: 'input ag-cl-cwd',
    value: F.cwd,
    placeholder: '/path/to/project',
    spellcheck: 'false',
    oninput: bind('cwd'),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(e.target.value); } },
  });
  const model = modelSelect(F.device, F.model);
  model.addEventListener('change', bind('model'));
  const fb = modelSelect(F.device, F.fallback, { allowNone: true });
  fb.addEventListener('change', bind('fallback'));
  const acct = accountSelect(F.device, F.account);
  acct.addEventListener('change', bind('account'));
  const done = el('select', { class: 'select', onchange: bind('notifyDone') },
    el('option', { value: 'default' }, `Use the setting (${set.notify?.done ? 'on' : 'off'})`),
    el('option', { value: 'on' }, 'On'), el('option', { value: 'off' }, 'Off'));
  done.value = F.notifyDone;

  const view = el('section', { class: 'stack-lg' },
    tabs(),
    multi() ? el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Device'),
        el('span', { class: 'meta' }, 'where Claude runs; the folder, accounts and settings are that machine\u2019s')),
      el('div', { class: 'stack ag-cl-devpick' }, ...devPick().filter(Boolean))) : null,
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, multi() ? `Folder on ${devLabel(F.device)}` : 'Folder'),
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
        el('span', {}, 'Unattended instructions: decide instead of asking, end with DONE: or BLOCKED:')),
      el('div', { class: 'field ag-cl-narrow' }, el('label', {}, 'Nudge to continue'),
        el('input', { class: 'input', type: 'number', min: '0', max: '10', value: String(F.autoContinue), oninput: bind('autoContinue', Number) }),
        el('span', { class: 'help' }, 'times to say “continue” if a turn ends without DONE or BLOCKED'))),
    el('div', { class: 'ag-cl-start' },
      el('span', { class: 'meta' }, 'Runs with bypass permissions. Pings go to Discord when it needs you.'),
      el('button', { class: 'btn', type: 'button', disabled: S.busy.has('create'), onclick: create }, S.busy.has('create') ? 'Starting…' : 'Start session')));
  root.replaceChildren(view);
  if (!S.fs || S.fs.device !== F.device || S.fs.path !== F.cwd) browse(F.cwd || undefined); else paintBrowser();
}

async function create() {
  const F = S.form;
  if (!F.cwd) { ctx.toast?.('warn', 'Pick a folder first'); return; }
  if (!online(F.device)) { ctx.toast?.('warn', `${devLabel(F.device)} is offline`, 'Pick another device.'); return; }
  const dev = F.device;
  const v = await act('create', () => post(dev, '/sessions', {
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
    pref('ag-cl-newdev', dev);
    upsert(dev, v);
    S.form = null;
    S.pane = 'terminal';
    go(v.id);
  }
}

/* ── accounts ───────────────────────────────────────────────────────── */

function acctStatus(a) {
  if (a.status === 'needs-login') return { dot: 'err', text: a.limitText ? `Needs login: ${a.limitText}` : 'Not logged in' };
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
        [a.email, a.plan ? a.plan.toUpperCase() : null, a.main ? '~/.claude' : shortPath(a.dir, curDev())].filter(Boolean).join(' · ')),
      el('span', { class: 'ag-cl-arow-status' }, st.text,
        models.length ? ` · ${models.map(([f, until]) => `${f[0].toUpperCase()}${f.slice(1)} out until ${at(until)}`).join(', ')}` : '')),
    el('span', { class: 'ag-cl-arow-actions' },
      !a.active ? el('button', { class: 'btn btn--sm', type: 'button', onclick: () => activate(a) }, 'Make active') : null,
      el('button', { class: `btn btn--sm ${a.status === 'needs-login' ? '' : 'btn--ghost'}`, type: 'button', onclick: () => startLogin(a) }, a.loggedIn ? 'Log in again' : 'Log in'),
      el('button', { class: 'btn btn--ghost btn--sm btn--icon ag-cl-sq', type: 'button', title: 'More', 'aria-label': `More for ${a.label}`, onclick: () => accountMenu(a) }, svg('cog'))));
}

/** Accounts and Settings: switch device, keeping the place. */
const switchTo = (tab) => (id) => { setDev(id); stopLogin(); go(tab, id); };

function paintAccounts(reason) {
  const dev = curDev();
  const d = devOf(dev);
  if (!d?.online || !d.data) {
    if (reason) return;
    stopLogin();
    root.replaceChildren(el('section', { class: 'stack-lg' }, tabs(), devSwitch(switchTo('accounts')), offCard(d || { label: 'The device', sleeps: false })));
    return;
  }
  const { accounts, settings } = d.data;
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
    devSwitch(switchTo('accounts')),
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, multi() ? `Accounts on ${d.label}` : 'Accounts'),
        el('span', { class: 'meta' }, 'normal Claude subscription logins, no API keys')),
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
            const a = await act('add-acct', () => post(dev, '/accounts', { label: name }));
            // The live update may have added it already; replace, never duplicate.
            if (a) { d.data.accounts = [...d.data.accounts.filter((x) => x.id !== a.id), a]; paintAccounts(); startLogin(a); }
          },
        }, 'Add and log in')),
      el('p', { class: 'meta' }, `Gets its own login folder${multi() ? ` on ${d.label}` : ''}; history, settings and CLAUDE.md are shared with ~/.claude there, so any session can continue on it.`)));
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
  const r = await act(`activate:${a.id}`, () => post(curDev(), `/accounts/${a.id}/activate`, { move: move.checked }));
  if (r) ctx.toast?.('ok', `${a.label} is active`, r.moved ? `${r.moved} session(s) moving` : '');
}

async function accountMenu(a) {
  const dev = curDev();
  const choice = await ctx.modal({
    title: a.label,
    body: el('p', { class: 'meta' }, a.main ? `${multi() ? devLabel(dev) : 'This machine'}'s own ~/.claude login.` : `Login folder: ${a.dir}`),
    actions: [
      { label: 'Check login', value: 'refresh', variant: 'ghost' },
      { label: 'Forget limits', value: 'clear', variant: 'ghost' },
      { label: 'Rename', value: 'rename', variant: 'ghost' },
      ...(a.main ? [] : [{ label: 'Remove', value: 'remove', variant: 'danger' }]),
    ],
  });
  if (choice === 'refresh') await act(`r:${a.id}`, () => post(dev, `/accounts/${a.id}/refresh`), 'Checked');
  else if (choice === 'clear') await act(`c:${a.id}`, () => post(dev, `/accounts/${a.id}/clear-limits`), 'Limits forgotten');
  else if (choice === 'rename') {
    const input = el('input', { class: 'input', value: a.label, maxlength: '40' });
    if (await ctx.modal({ title: 'Rename account', body: el('div', { class: 'field' }, el('label', {}, 'Label'), input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true }] })) {
      await act(`n:${a.id}`, () => api(dev, `/accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ label: input.value }) }));
    }
  } else if (choice === 'remove') {
    const ok = await ctx.modal({ title: `Remove ${a.label}?`, body: el('p', { class: 'meta' }, `Its login folder is left on disk (${a.dir}); delete it by hand if you want the login gone.`), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Remove', value: true, variant: 'danger' }] });
    if (ok) {
      const r = await act(`rm:${a.id}`, () => api(dev, `/accounts/${a.id}`, { method: 'DELETE' }), 'Removed');
      const x = dataOf(dev);
      if (r && x) { x.accounts = x.accounts.filter((y) => y.id !== a.id); paintAccounts(); }
    }
  }
}

async function startLogin(a) {
  const dev = curDev();
  const r = await act(`login:${a.id}`, () => post(dev, `/accounts/${a.id}/login`));
  if (!r) return;
  stopLogin();
  S.login = { dev, id: a.id, state: null, timer: null, term: null, showTerm: false };
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
  const { id, dev } = S.login;
  try {
    S.login.state = await api(dev, `/accounts/${id}/login`);
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
  const L = S.login;
  const a = dataOf(L.dev)?.accounts?.find((x) => x.id === L.id);
  const st = S.login.state || {};
  // One code box for the whole login. The panel is rebuilt on every poll
  // (every 2 s while the login runs); a fresh <input> each time wiped a
  // pasted code and took the focus away mid-paste. Reusing the node keeps
  // its value; focus and selection are put back after it is re-attached.
  if (!L.codeEl) {
    L.codeEl = el('input', { class: 'input', placeholder: 'Paste the code from the sign-in page', spellcheck: 'false', autocomplete: 'off' });
    L.codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); L.submitCode?.(); } });
  }
  const code = L.codeEl;
  const hadFocus = document.activeElement === code;
  const sel = hadFocus ? [code.selectionStart, code.selectionEnd] : null;
  const refocus = () => { if (hadFocus && code.isConnected) { code.focus(); try { code.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } } };
  L.submitCode = async () => {
    if (!code.value.trim()) return;
    const ok = await act('code', () => post(L.dev, `/accounts/${L.id}/login/code`, { code: code.value.trim() }), 'Code sent');
    if (ok) { code.value = ''; pollLogin(); }
  };
  const status = !S.login.state ? 'Starting the login…'
    : st.finished ? 'Logged in.'
      : st.failed ? `Login failed: ${st.error}. Start again and paste the whole code (it ends with a # part) from the page that link opens, not an older one.`
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
          await post(L.dev, `/accounts/${L.id}/login`, {}).catch(() => {});
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
        onclick: () => L.submitCode(),
      }, 'Submit')) : null,
    el('div', { class: 'ag-cl-login-actions' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { S.login.showTerm = !S.login.showTerm; paintLogin(); } }, svg('terminal'), S.login.showTerm ? 'Hide terminal' : 'Show terminal'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: async () => { const { id, dev } = L; stopLogin(); await api(dev, `/accounts/${id}/login`, { method: 'DELETE' }).catch(() => {}); paintAccounts(); },
      }, st.finished || !st.running ? 'Close' : 'Cancel')),
    el('div', { class: 'ag-cl-login-term' }));
  if (update && host.firstChild && S.login.term) {
    // Keep a live terminal: rebuild only the text around it.
    const old = host.querySelector('.ag-cl-login-term');
    panel.querySelector('.ag-cl-login-term').replaceWith(old);
    host.replaceChildren(panel);
    refocus();
    return;
  }
  S.login.term?.teardown();
  S.login.term = null;
  host.replaceChildren(panel);
  refocus();
  if (S.login.showTerm && st.running) {
    S.login.term = startTerminal({ host: panel.querySelector('.ag-cl-login-term'), ctx, path: `/d/${encodeURIComponent(L.dev)}/accounts/${L.id}/terminal` });
  }
}

/* ── settings ───────────────────────────────────────────────────────── */

async function saveSettings(patch, what = 'Saved') {
  const dev = curDev();
  const r = await act('settings', async () => {
    const next = await api(dev, '/settings', { method: 'PUT', body: JSON.stringify(patch) });
    const x = dataOf(dev);
    if (x) x.settings = next;
    return next;
  });
  if (r) ctx.toast?.('ok', what);
  return r;
}

function toggleRow(key, label, extraClass = '', { notify = false, detail = null } = {}) {
  const set = dataOf(curDev())?.settings || {};
  const on = notify ? !!set.notify?.[key] : !!set[key];
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
  const dev = curDev();
  const d = devOf(dev);
  if (!d?.online || !d.data) {
    root.replaceChildren(el('section', { class: 'stack-lg' }, tabs(), devSwitch(switchTo('settings')), offCard(d || { label: 'The device', sleeps: false })));
    return;
  }
  const { settings, notify, runner, governor } = d.data;
  const def = modelSelect(dev, settings.defaultModel);
  def.addEventListener('change', () => saveSettings({ defaultModel: def.value }, 'Default model saved'));
  const fb = modelSelect(dev, settings.fallbackModel, { allowNone: true });
  fb.addEventListener('change', () => saveSettings({ fallbackModel: fb.value || null }, 'Fallback model saved'));
  const num = (key, min, max, label, help) => el('div', { class: 'field ag-cl-narrow' }, el('label', {}, label),
    el('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(settings[key]), onchange: (e) => saveSettings({ [key]: Number(e.target.value) }) }),
    help ? el('span', { class: 'help' }, help) : null);

  const thermal = governor?.thermal !== false;
  root.replaceChildren(el('section', { class: 'stack-lg' },
    tabs(),
    devSwitch(switchTo('settings')),
    multi() ? el('p', { class: 'meta' }, `Settings for sessions on ${d.label}. Each device keeps its own.`) : null,
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
        ? el('p', { class: 'meta' }, 'Sent to the Claude webhook (CLAUDE_DISCORD_WEBHOOK), separate from fleet\'s.')
        : el('div', { class: 'alert alert--warn' }, el('b', {}, 'No webhook'), el('span', {}, `Set CLAUDE_DISCORD_WEBHOOK in ~/.config/ojee-claude/env on ${multi() ? d.label : 'the host'} and restart the runner. Until then pings are only listed below.`)),
      // Which pings go where (app, Discord, quiet hours, cooldowns) is set
      // with every other module's in the console; only excerpts stay here.
      el('p', { class: 'meta' }, 'Which pings are sent (to the app and to Discord) and quiet hours are set in ',
        el('a', { href: '#/settings/notifications', class: 'ag-link' }, 'Settings → Notifications'),
        notify?.console ? `. This runner last received them ${at(notify.console.at)}.` : '. This runner has not received them yet; until it does, the defaults apply.'),
      el('div', { class: 'ag-cl-toggles' }, NOTIFY.filter(([k]) => k === 'excerpts').map(([k, label, detail]) => toggleRow(k, label, '', { notify: true, detail }))),
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
      el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'CPU and heat'),
        el('span', { class: 'meta ag-cl-gov' }, govLine(governor))),
      el('p', { class: 'meta' }, thermal
        ? 'Sessions run test suites and builds that take every core. The governor holds their combined CPU under the cap by pausing them in short slices, and lowers the cap while the CPU is hotter than the target. A busy terminal may stutter; nothing is lost.'
        : 'Sessions run test suites and builds that take every core. The governor holds their combined CPU under the cap by pausing them in short slices. A busy terminal may stutter; nothing is lost.'),
      thermal ? null : el('p', { class: 'meta' }, `No temperature back-off on ${multi() ? d.label : 'this machine'}: its CPU runs near its limit even when idle and its firmware manages heat (THERMAL_BACKOFF=0 in the runner's env).`),
      el('div', { class: 'ag-cl-toggles' },
        toggleRow('governor', 'CPU governor', '', { detail: 'cap the sessions\u2019 CPU and back off when hot' }),
        toggleRow('lightFootprint', 'Light footprint', '', { detail: 'low priority, and test runners and bundlers default to two workers (new launches)' })),
      el('div', { class: 'grid grid--2 ag-cl-opts' },
        num('cpuCapPct', 10, 100, 'CPU cap (% of all threads)', `what all sessions together may use${governor?.threads ? ` (${governor.threads} threads)` : ''}`),
        thermal ? num('tempTarget', 60, 95, 'Temperature target (°C)', 'above it the cap comes down') : null)),
    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Runner'),
      el('div', { class: 'ag-cl-list' },
        ...[['Device', d.data.device ? `${d.data.device.label} (${d.data.device.id})` : d.label], ['Claude Code', runner?.claude || 'not found'], ['tmux', runner?.tmux || 'not found'],
          ['Listening on', runner?.port ? `${runner.host}:${runner.port}` : runner?.host], ['Protected stack folder', runner?.stackDir]]
          .map(([k, v]) => el('div', { class: 'ag-cl-row ag-cl-kv' }, el('span', { class: 'meta' }, k), el('span', {}, v || '-')))))));
}

function govLine(g) {
  if (!g) return '';
  if (!g.active) return g.reason ? `off: ${g.reason}` : 'off';
  return [
    g.temp != null ? `${g.temp} °C` : null,
    `sessions ${g.usagePct}% of cap ${g.capPct}%`,
    g.frozenPct ? `pausing ${g.frozenPct}%` : null,
    g.hot ? 'backing off (hot)' : null,
  ].filter(Boolean).join(' · ');
}

/** While Settings is open, keep the CPU readout live. */
let govTimer = null;
function watchGovernor() {
  clearInterval(govTimer);
  govTimer = setInterval(async () => {
    if (S.tab !== 'settings' || S.detail || !root) { clearInterval(govTimer); govTimer = null; return; }
    const dev = curDev();
    if (!online(dev)) return;
    try {
      const g = await api(dev, '/governor');
      const x = dataOf(dev);
      if (x) x.governor = g;
      const line = root.querySelector('.ag-cl-gov');
      if (line && curDev() === dev) line.textContent = govLine(g);
    } catch { /* runner restarting */ }
  }, 3000);
}

/* ── routing and lifecycle ──────────────────────────────────────────── */

export function routeClaude() {
  const [first, second] = sub();
  const prevDetail = S.detail;
  const prevTab = S.tab;
  if (first && /^[0-9a-f-]{36}$/i.test(first)) { S.detail = first; }
  else { S.detail = null; S.tab = ['new', 'accounts', 'settings'].includes(first) ? first : 'sessions'; }
  // #/agent/claude/settings/loq: that device's settings (a deep link).
  if (second && ['accounts', 'settings'].includes(first) && (!S.devs || devOf(second))) setDev(second);
  if (prevDetail !== S.detail) { closePop(); stopPane(); }
  if (S.tab !== 'accounts' || S.detail) stopLogin();
  // A new place starts at its top, not wherever the last one was scrolled to.
  if (prevDetail !== S.detail || prevTab !== S.tab) window.scrollTo(0, 0);
  paint();
  lockPage();
  if (S.tab === 'settings' && !S.detail) watchGovernor();
}

export async function mountClaude(el0, context) {
  root = el0;
  ctx = context;
  // iOS enlarges text it thinks is too small to read, differently on each
  // view and after each zoom; the console's sizes are meant as written.
  document.documentElement.style.setProperty('-webkit-text-size-adjust', '100%');
  document.documentElement.style.setProperty('text-size-adjust', '100%');
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
  window.removeEventListener('keydown', typeAnywhere, true);
  typeWatch = false;
  clearInterval(govTimer);
  govTimer = null;
  document.documentElement.style.overflow = '';
  viewportWatch?.();
  viewportWatch = null;
  stopPane();
  stopLogin();
  sse?.stop();
  sse = null;
  root = null;
}
