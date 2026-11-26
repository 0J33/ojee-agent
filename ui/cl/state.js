/* ============================================================
   The Claude view's shared state: every device's runner state,
   the route, and the helpers every part uses to read and act on
   it. One object, read everywhere; app.js repaints from it.
   ============================================================ */

import { pref } from './dom.js';

export const S = {
  ctx: null,
  root: null,
  // One per device: { id, label, sleeps, online, error, data, seenAt }, where
  // data is that runner's /state. Kept when it goes offline, drawn as stale.
  devs: null,
  error: null,
  route: { kind: 'list', id: null, dev: null },
  dev: pref('cl-dev'),                 // the device Accounts / Settings show
  filter: pref('cl-filter') || 'all',  // the list: 'all' or a device id
  busy: new Set(),
  stack: null,                         // /api/stack: only drawn when something is down
  paint: () => {},
};

/* ── devices ──────────────────────────────────────────────────────── */

export const devOf = (id) => S.devs?.find((d) => d.id === id) || null;
export const dataOf = (id) => devOf(id)?.data || null;
export const devLabel = (id) => devOf(id)?.label || id || '';
export const online = (id) => !!devOf(id)?.online;
export const multi = () => (S.devs?.length || 0) > 1;

export function curDev() {
  if (S.dev && devOf(S.dev)) return S.dev;
  return (S.devs?.find((d) => d.online && d.data) || S.devs?.find((d) => d.data) || S.devs?.[0])?.id || null;
}
export function setDev(id) { S.dev = id; pref('cl-dev', id); }

export function offWhy(d) {
  if (!d || d.online) return null;
  return d.sleeps ? `${d.label} is asleep or away` : `${d.label}'s runner is not answering${d.error ? ` (${d.error})` : ''}`;
}

/* ── sessions ─────────────────────────────────────────────────────── */

export const allSessions = () => (S.devs || []).flatMap((d) => d.data?.sessions || [])
  .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
export const session = (id) => allSessions().find((s) => s.id === id) || null;

export function stamp(data, dev) {
  for (const x of data.sessions || []) x.device = dev;
  return data;
}

export function upsert(dev, v) {
  const data = dataOf(dev);
  if (!data || !v?.id) return;
  v.device = dev;
  const i = data.sessions.findIndex((s) => s.id === v.id);
  if (i >= 0) data.sessions[i] = v; else data.sessions.unshift(v);
}

/**
 * What each state means on screen: its word, its colour, and which group of
 * the list it sits in. Red is for what waits on you; green for work going on.
 */
export const STATES = {
  waiting: { label: 'Needs you', tone: 'err', group: 'needs' },
  blocked: { label: 'Blocked', tone: 'warn', group: 'needs' },
  error: { label: 'Error', tone: 'err', group: 'needs' },
  starting: { label: 'Starting', tone: 'ok', group: 'working', live: true },
  running: { label: 'Working', tone: 'ok', group: 'working', live: true },
  queued: { label: 'Queued', tone: null, group: 'working' },
  paused: { label: 'Paused', tone: 'warn', group: 'idle' },
  idle: { label: 'Idle', tone: null, group: 'idle' },
  done: { label: 'Done', tone: null, group: 'idle' },
  stopped: { label: 'Ended', tone: null, group: 'ended' },
};
export const stateOf = (s) => (online(s.device) ? STATES[s.state] || { label: s.state, tone: null, group: 'idle' } : { label: 'Offline', tone: null, group: s.state === 'stopped' ? 'ended' : 'idle', off: true });

export const models = (dev) => dataOf(dev)?.models || S.devs?.map((d) => d.data?.models).find(Boolean) || [];
export const modelLabel = (id) => (S.devs || []).map((d) => d.data?.models?.find((m) => m.id === id)).find(Boolean)?.label || id || '';
export const acctLabel = (id, dev) => dataOf(dev)?.accounts?.find((a) => a.id === id)?.label || id || '';
export function shortPath(p, dev) {
  const home = dataOf(dev)?.runner?.home;
  return home && p?.startsWith(home) ? `~${p.slice(home.length)}` : p || '';
}

/* ── talking to the runners ───────────────────────────────────────── */

export const api = (dev, path, opts = {}) => S.ctx.api(`/claude/d/${encodeURIComponent(dev)}${path}`, opts);
export const post = (dev, path, body) => api(dev, path, { method: 'POST', body: JSON.stringify(body || {}) });
export const patch = (dev, path, body) => api(dev, path, { method: 'PATCH', body: JSON.stringify(body || {}) });
export const put = (dev, path, body) => api(dev, path, { method: 'PUT', body: JSON.stringify(body || {}) });
export const toast = (...a) => S.ctx?.toast?.(...a);
/** An express 404 for a route an older runner does not have. */
export const missingRoute = (e) => /^(not found|cannot (get|post))|404/i.test(String(e?.message || ''));

/**
 * Run an action once at a time per key, with the reason on failure as a
 * toast (what happened, not "error").
 */
export async function act(key, fn, ok) {
  if (S.busy.has(key)) return null;
  S.busy.add(key);
  S.paint('busy');
  try {
    const r = await fn();
    if (ok) toast('ok', ok);
    return r;
  } catch (e) {
    toast('err', 'That did not work', e.message);
    return null;
  } finally {
    S.busy.delete(key);
    S.paint('busy');
  }
}

/* ── routes: #/<module>/claude/<rest> ─────────────────────────────── */

export function sub() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const i = parts.indexOf('claude');
  return i >= 0 ? parts.slice(i + 1).filter(Boolean).map(decodeURIComponent) : [];
}

export function go(...segs) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const i = parts.indexOf('claude');
  const prefix = i >= 0 ? parts.slice(0, i + 1) : [...parts.slice(0, 1), 'claude'];
  const next = `#/${[...prefix, ...segs.filter(Boolean).map(encodeURIComponent)].join('/')}`;
  if (location.hash !== next) location.hash = next;
  else S.route_changed?.();
}

export function parseRoute() {
  const [a, b, c] = sub();
  if (a && /^[0-9a-f-]{36}$/i.test(a)) return { kind: 'session', id: a, dev: null };
  if (a === 'new') return { kind: 'new', id: null, dev: null };
  if (a === 'accounts' || a === 'settings') return { kind: a, id: null, dev: b || null, acct: c || null };
  return { kind: 'list', id: null, dev: null };
}
