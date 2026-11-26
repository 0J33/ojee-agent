/* ============================================================
   The Claude view: Claude Code sessions on every machine that runs
   them, through each machine's runner (claude-runner/).

   One page. On a wide screen: the sessions and accounts in a left
   column, the open session (terminal or chat) filling the rest.
   On a phone: the list, and a session opens over it, edge to edge,
   sized to what the keyboard leaves.

   Routes, under the view: #/<module>/claude/<rest>, where rest is
   '', a session id, 'new', 'accounts[/<device>[/<account>]]' or
   'settings[/<device>]'. The console only reads the first two
   segments, so a deep link from a ping opens straight to a session.
   ============================================================ */

import { h, icon, swap, pref, closeMenu } from './dom.js';
import { S, stamp, devOf, dataOf, upsert, allSessions, session, multi, online, parseRoute, go, curDev, setDev, stateOf } from './state.js';
import { sessionsPanel, accountsPanel, stackLine } from './list.js';
import { createSessionView } from './session.js';
import { createNewSession, createAccounts, createSettings } from './forms.js';
import { watchViewport, watchFit, scrollerOf } from './viewport.js';

let sse = null;
let main = null;          // { key, ctl }
let unwatch = [];
let beat = 0;
let beatTimer = null;
let stackTimer = null;

const els = {};

async function load() {
  try {
    const r = await S.ctx.api('/claude/all/state');
    const prev = S.devs || [];
    S.devs = (r.devices || []).map((d) => {
      const old = prev.find((x) => x.id === d.id);
      return { id: d.id, label: d.label, sleeps: !!d.sleeps, online: !!d.online, error: d.error || null, data: d.state ? stamp(d.state, d.id) : old?.data || null, seenAt: d.online ? Date.now() : old?.seenAt || null };
    });
    S.error = null;
  } catch (e) { S.error = e.message; }
}

async function loadStack() {
  try { S.stack = await S.ctx.api('/stack'); } catch { S.stack = null; }
}

/**
 * One merged stream for every runner. It can die without a word (a phone
 * asleep, a network change), so silence for a minute, the page coming back
 * into view or the network returning reloads everything and reconnects.
 */
function listen() {
  sse?.stop();
  beat = Date.now();
  const alive = (fn) => (arg) => { beat = Date.now(); fn(arg); };
  const events = {
    ping: () => {},
    state: ({ device, data }) => { const d = devOf(device); if (!d || !data) return; d.data = stamp(data, device); d.online = true; d.error = null; d.seenAt = Date.now(); paint('device'); },
    session: ({ device, data }) => { const d = devOf(device); if (d) d.seenAt = Date.now(); upsert(device, data); paint('session'); },
    removed: ({ device, data }) => { const x = dataOf(device); if (x) x.sessions = x.sessions.filter((s) => s.id !== data?.id); if (S.route.id === data?.id) go(); else paint('session'); },
    accounts: ({ device, data }) => { const x = dataOf(device); if (!x || !data) return; x.accounts = data.accounts; x.settings = data.settings; paint('accounts'); },
    device: ({ device, online: on, error }) => { const d = devOf(device); if (!d) return; if (d.online && !on) d.seenAt = Date.now(); d.online = !!on; d.error = error || null; paint('device'); },
  };
  sse = S.ctx.sse('/claude/all/events', { events: Object.fromEntries(Object.entries(events).map(([k, fn]) => [k, alive(fn)])), onError: () => {} });
}
let resyncing = false;
async function resync() {
  if (!S.root || resyncing) return;
  resyncing = true;
  try { await load(); if (S.root) { listen(); paint('device'); } } finally { resyncing = false; }
}
const onWake = () => { if (!document.hidden) resync(); };

/* ── painting ─────────────────────────────────────────────────────── */

function summary() {
  const all = allSessions().filter((s) => s.state !== 'stopped');
  const needs = all.filter((s) => stateOf(s).group === 'needs' && online(s.device)).length;
  const hosts = new Set(all.map((s) => s.device)).size;
  const working = all.filter((s) => ['running', 'starting'].includes(s.state) && online(s.device)).length;
  return [
    `${all.length} session${all.length === 1 ? '' : 's'}${multi() ? ` on ${hosts || S.devs.length} host${(hosts || S.devs.length) === 1 ? '' : 's'}` : ''}`,
    working ? `${working} working` : null,
    needs ? `${needs} waiting for you` : null,
  ].filter(Boolean).join(' · ');
}

function routeKey(r) { return `${r.kind}:${r.id || ''}:${r.dev || ''}`; }

function mainFor(r) {
  const back = () => go();
  if (r.kind === 'session') {
    const s = session(r.id);
    if (!s) return null;
    return createSessionView(s, { onBack: back });
  }
  if (r.kind === 'new') return createNewSession({ onBack: back });
  if (r.kind === 'accounts') return createAccounts({ dev: r.dev, acct: r.acct, onBack: back });
  if (r.kind === 'settings') return createSettings({ dev: r.dev, onBack: back });
  return null;
}

function emptyMain() {
  const needs = allSessions().filter((s) => stateOf(s).group === 'needs' && online(s.device));
  return h('section', { class: 'panel cl-pick' }, h('div', { class: 'empty' }, icon('term'),
    h('b', {}, needs.length ? `${needs.length} session${needs.length === 1 ? '' : 's'} waiting for you` : 'Pick a session'),
    h('p', {}, needs.length ? 'Open one on the left to answer it.' : 'Its terminal opens here, with the chat one tap away.'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => go('new') }, icon('plus', 's'), 'New session')));
}

function paint(reason) {
  if (!S.root) return;
  const r = S.route;
  if (!S.devs) {
    S.root.replaceChildren(h('div', { class: 'cl-skel' }, h('div', { class: 'sk', style: 'height:28px;width:160px' }), h('div', { class: 'sk', style: 'height:16px;width:260px;margin-top:8px' }), h('div', { class: 'sk', style: 'height:360px;margin-top:24px' })));
    return;
  }
  if (!els.grid) build();
  if (!S.devs.some((d) => d.data)) {
    S.root.classList.add('cl-down');
    swap(els.side, `down:${S.error}:${S.devs.map((d) => d.error).join()}`, () => h('div', { class: 'panel' }, h('div', { class: 'empty' }, icon('warn'),
      h('b', {}, S.devs.length ? (multi() ? 'No Claude runner is answering' : 'The Claude runner is not answering') : 'No Claude runner is configured'),
      h('p', {}, S.devs.length ? S.devs.map((d) => `${d.label}: ${d.error || 'offline'}`).join(' · ') : 'Set CLAUDE_RUNNER_URL and CLAUDE_RUNNER_TOKEN for this module.'),
      h('button', { class: 'btn sm', type: 'button', onclick: async () => { await load(); paint(); } }, icon('refresh', 's'), 'Try again'))));
    els.grid.dataset.view = 'list';
    return;
  }
  S.root.classList.remove('cl-down');
  const line = summary();
  els.sub.textContent = line;
  // The shell sets its own line on navigation: say ours after it.
  if (S.ctx.header?.setSub) requestAnimationFrame(() => S.ctx?.header?.setSub(line));
  swap(els.stack, JSON.stringify(S.stack?.down?.map((x) => [x.id, S.busy.has(`svc:${x.id}`)]) || []), () => stackLine());
  // The list: rebuilt only when what it shows changed, so a tap on a row is never lost.
  const sig = JSON.stringify([r.id, S.filter, pref('cl-ended'), S.devs.map((d) => [d.id, d.online]), allSessions().map((s) => [s.id, s.title, s.state, s.alive, s.lastActivityAt, s.activity?.tool, s.activity?.text, s.prompt?.kind, s.detail, s.account])]);
  swap(els.list, sig, () => sessionsPanel(r.id));
  const dev = curDev();
  swap(els.accts, JSON.stringify([dev, dataOf(dev)?.accounts, dataOf(dev)?.settings?.autoSwitchAccounts, multi()]), () => accountsPanel());

  const key = routeKey(r);
  els.grid.dataset.view = r.kind === 'list' ? 'list' : r.kind === 'session' ? 'session' : 'form';
  if (main?.key === key && main.ctl) {
    if (r.kind === 'session') { const s = session(r.id); if (s) main.ctl.update(s); else if (reason !== 'busy') { main.ctl.destroy(); main = null; els.main.replaceChildren(gone()); } }
    else main.ctl.update?.(reason);
    return;
  }
  main?.ctl?.destroy();
  closeMenu();
  const ctl = mainFor(r);
  main = { key, ctl };
  els.main.replaceChildren(ctl ? ctl.el : r.kind === 'session' ? gone() : emptyMain());
  S.root.classList.toggle('cl-open', r.kind !== 'list');
}

const gone = () => h('section', { class: 'panel cl-pick' }, h('div', { class: 'empty' }, icon('warn'), h('b', {}, 'No such session'),
  h('p', {}, (S.devs || []).some((d) => !d.online) ? 'It may have been deleted, or its machine is offline.' : 'It may have been deleted.'),
  h('button', { class: 'btn sm', type: 'button', onclick: () => go() }, 'All sessions')));

function build() {
  els.sub = h('p', {});
  els.stack = h('div', { class: 'cl-stackhost' });
  els.list = h('div', { class: 'cl-listhost' });
  els.accts = h('div', { class: 'cl-acctshost' });
  els.side = h('aside', { class: 'cl-side', 'aria-label': 'Sessions' }, els.stack, els.list, els.accts);
  els.main = h('div', { class: 'cl-main' });
  els.grid = h('div', { class: 'cl-grid' }, els.side, els.main);
  const acts = [
    h('button', { class: 'ib', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => go('settings', curDev()) }, icon('cog')),
    h('button', { class: 'btn pri', type: 'button', onclick: () => go('new') }, icon('plus', 's'), 'New session'),
  ];
  // Inside the console the shell draws the page header (the module's name
  // and this summary line); its right side takes these buttons.
  const shellHead = S.ctx.header?.actions;
  if (shellHead) {
    els.acts = acts;
    shellHead.append(...acts);
    S.root.replaceChildren(els.grid);
  } else {
    S.root.replaceChildren(h('header', { class: 'ph cl-ph' }, h('div', {}, h('h1', {}, 'Claude'), els.sub), h('div', { class: 'acts' }, ...acts)), els.grid);
  }
  // The page fits one screen on a wide display; the side scrolls on its own.
  const scroller = scrollerOf(S.root);
  unwatch.push(watchFit(els.grid, scroller, (avail) => { S.root.style.setProperty('--cl-h', `${Math.max(420, avail)}px`); }));
  unwatch.push(watchViewport(S.root));
}

function route() {
  const prev = S.route;
  S.route = parseRoute();
  if (S.route.dev && (S.route.kind === 'accounts' || S.route.kind === 'settings') && devOf(S.route.dev)) setDev(S.route.dev);
  if (prev.kind !== S.route.kind || prev.id !== S.route.id) {
    const sc = scrollerOf(S.root);
    if (sc && sc !== document.documentElement) sc.scrollTop = 0; else window.scrollTo(0, 0);
  }
  paint('route');
}

/* ── lifecycle ────────────────────────────────────────────────────── */

export async function mountClaude(el, ctx) {
  S.root = el;
  S.ctx = ctx;
  S.paint = paint;
  S.reload = async () => { await load(); paint('device'); };
  S.route_changed = route;
  for (const k of Object.keys(els)) delete els[k];
  el.classList.add('cl');
  if (!document.getElementById('cl-css')) {
    const link = h('link', { id: 'cl-css', rel: 'stylesheet', href: `${ctx.base}/ui/claude.css` });
    document.head.append(link);
  }
  S.route = parseRoute();
  paint();
  await Promise.all([load(), loadStack()]);
  if (!S.root) return;
  route();
  listen();
  beatTimer = setInterval(() => { if (!document.hidden && S.root && Date.now() - beat > 60_000) resync(); }, 15_000);
  stackTimer = setInterval(async () => { if (document.hidden) return; const before = JSON.stringify(S.stack?.down || []); await loadStack(); if (JSON.stringify(S.stack?.down || []) !== before) paint(); }, 60_000);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('pageshow', onWake);
}

export function routeClaude() { if (S.root) route(); }

export function unmountClaude() {
  main?.ctl?.destroy();
  main = null;
  closeMenu();
  sse?.stop();
  sse = null;
  for (const u of unwatch.splice(0)) u();
  clearInterval(beatTimer);
  clearInterval(stackTimer);
  window.removeEventListener('hashchange', route);
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('online', onWake);
  window.removeEventListener('pageshow', onWake);
  for (const b of els.acts || []) b.remove();
  S.root?.classList.remove('cl', 'cl-open', 'max', 'kb');
  S.root = null;
  for (const k of Object.keys(els)) delete els[k];
}
