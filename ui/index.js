/* ============================================================
   ojee-agent — the AI and automation module.

   Five views over the AI and automation stack: what is running,
   the Claude Code sessions on the host (claude.js), n8n's
   workflows and their recent runs, Odysseus, and the stack's own
   containers.

   What is NOT here any more: CPU graphs, memory bars, a list of
   every container on the box, and a whitelist of restart commands
   for things this module has nothing to do with. That was a host
   dashboard living inside an automation tool, and ojee-fleet now
   reads the machine directly rather than asking a service on it
   over HTTP for numbers already sitting in /proc.
   ============================================================ */

import { mountClaude, routeClaude, unmountClaude } from './claude.js';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const ago = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const dot = (status) => el('span', {
  class: `dot dot--${status === 'err' ? 'err' : status === 'warn' ? 'warn' : 'ok'}`,
});

/* ── state ───────────────────────────────────────────────────────────── */

let ctx = null;
let root = null;
let timer = null;
// The Claude view owns the page while it is open: its own data, its own
// event stream, a live terminal. This module's render() stays out of it.
let claudeOpen = false;

const state = {
  view: 'overview',
  config: null,
  services: [],
  workflows: null,        // null = not loaded, {error} = refused
  executions: null,
  odysseus: null,
  busy: null,
  error: null,
  execWindow: null,
};

/** Never throws: a section that cannot load says so, in place. */
const api = async (path, opts = {}) => {
  const res = await ctx.api(path.replace(/^\/api/, ''), opts);
  return res;
};
const tryApi = async (path, opts) => {
  try { return await api(path, opts); } catch (e) { return { error: e.message }; }
};

/* ── pieces ──────────────────────────────────────────────────────────── */

/**
 * A section that could not load.
 *
 * It says what is wrong and what to do about it, because the common failure
 * here is a rotated API key and "failed to load" gives you nowhere to go.
 */
const problem = (title, detail, action) => el('div', { class: 'ag-problem' },
  el('strong', {}, title),
  detail ? el('p', { class: 'meta' }, detail) : null,
  action || null);

const serviceRow = (s) => el('div', { class: `ag-row ag-svc ${s.present && !s.ok ? 'is-bad' : ''}` },
  dot(!s.present ? 'warn' : s.ok ? 'ok' : 'err'),
  el('span', { class: 'ag-row-name' }, s.name),
  el('span', { class: 'meta' }, s.role),
  el('span', { class: 'meta ag-svc-detail' }, s.detail),
  s.present
    ? el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      disabled: state.busy === s.id,
      onclick: () => restart(s),
    }, state.busy === s.id ? '…' : 'Restart')
    : el('span', { class: 'meta' }, '—'));

function viewOverview() {
  const wrap = el('section', { class: 'stack-lg' });
  const deployed = state.services.filter((s) => s.present);
  const stopped = deployed.filter((s) => !s.ok);
  const wf = Array.isArray(state.workflows) ? state.workflows : [];
  const active = wf.filter((w) => w.active);
  const execs = Array.isArray(state.executions) ? state.executions : [];
  const failed = execs.filter((e) => e.status === 'error' || e.status === 'failed');

  wrap.append(el('div', { class: 'ag-verdict' },
    dot(stopped.length ? 'err' : failed.length ? 'warn' : 'ok'),
    el('strong', {},
      stopped.length ? `${stopped.length} service${stopped.length === 1 ? '' : 's'} stopped`
        : state.workflows?.error ? 'n8n is not answering'
          : `${active.length} workflow${active.length === 1 ? '' : 's'} active`),
    el('span', { class: 'meta' },
      failed.length ? `${failed.length} failed run${failed.length === 1 ? '' : 's'} recently` : 'nothing failing')));

  wrap.append(el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Stack'),
    el('div', { class: 'ag-list' }, state.services.map(serviceRow))));

  if (state.workflows?.error) {
    wrap.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Workflows'),
      problem('n8n did not answer', state.workflows.error)));
  } else if (wf.length) {
    wrap.append(el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' },
        el('h3', { class: 'h3' }, 'Recent runs'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go('workflows') }, 'All workflows')),
      execs.length
        ? el('div', { class: 'ag-list' }, execs.slice(0, 6).map(execRow))
        : el('p', { class: 'meta' }, 'Nothing has run recently.')));
  }

  if (state.odysseus?.configured) {
    wrap.append(el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Odysseus'),
      el('div', { class: 'ag-list' },
        el('div', { class: 'ag-row ag-kv' },
          dot(state.odysseus.up ? 'ok' : 'err'),
          el('span', { class: 'ag-row-name' }, state.odysseus.up ? (state.odysseus.status || 'up') : 'not answering'),
          el('span', { class: 'meta' }, state.odysseus.error || state.odysseus.version || '')))));
  }

  return wrap;
}

const execRow = (e) => el('div', {
  class: `ag-row ag-exec ${e.status === 'error' || e.status === 'failed' ? 'is-bad' : ''}`,
},
dot(e.status === 'error' || e.status === 'failed' ? 'err' : e.status === 'running' ? 'warn' : 'ok'),
el('span', { class: 'ag-row-name' }, e.workflowName || e.workflowId || 'unnamed'),
el('span', { class: 'meta' }, e.status || '—'),
el('span', { class: 'meta' }, e.mode || ''),
el('span', { class: 'meta' }, ago(e.startedAt)));

function viewWorkflows() {
  if (state.workflows?.error) {
    return el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Workflows'),
      problem('n8n did not answer', state.workflows.error,
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: () => { state.workflows = null; refresh(); },
        }, 'Try again')));
  }
  const wf = Array.isArray(state.workflows) ? state.workflows : [];
  const execs = Array.isArray(state.executions) ? state.executions : [];
  const lastFor = (id) => execs.find((e) => String(e.workflowId) === String(id));

  return el('section', { class: 'stack-lg' },
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' },
        el('h3', { class: 'h3' }, 'Workflows'),
        el('span', { class: 'meta' }, `${wf.filter((w) => w.active).length} active of ${wf.length}`)),
      wf.length
        ? el('div', { class: 'ag-list' }, wf.map((w) => {
          const last = lastFor(w.id);
          return el('div', { class: 'ag-row ag-wf' },
            dot(w.active ? 'ok' : 'warn'),
            el('span', { class: 'ag-row-name', title: w.name }, w.name),
            el('span', { class: 'meta' }, last ? `${last.status} · ${ago(last.startedAt)}` : 'never run'),
            el('span', { class: 'meta' }, (w.tags || []).join(', ')),
            el('button', {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              disabled: state.busy === `wf:${w.id}`,
              onclick: () => toggleWorkflow(w),
            }, state.busy === `wf:${w.id}` ? '…' : w.active ? 'Deactivate' : 'Activate'));
        }))
        : el('p', { class: 'meta' }, 'n8n has no workflows.')),

    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' },
        el('h3', { class: 'h3' }, 'Recent runs'),
        // Say the window, so an empty list reads as "nothing lately" rather
        // than "this is broken".
        state.execWindow
          ? el('span', { class: 'meta' }, `last ${state.execWindow} days`)
          : null),
      execs.length
        ? el('div', { class: 'ag-list' }, execs.map(execRow))
        : el('p', { class: 'meta' },
          state.execWindow
            ? `Nothing has run in the last ${state.execWindow} days.`
            : 'Nothing has run recently.')));
}

function viewOdysseus() {
  const o = state.odysseus;
  if (!o?.configured) {
    return el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'Odysseus'),
      problem('Not configured here', 'Set ODYSSEUS_URL to point this module at it.'));
  }
  const parts = state.services.filter((s) => ['odysseus', 'chromadb', 'searxng', 'ntfy'].includes(s.id));
  return el('section', { class: 'stack-lg' },
    el('section', { class: 'panel stack' },
      el('div', { class: 'ag-panel-head' },
        el('h3', { class: 'h3' }, 'Odysseus'),
        (state.config?.links || []).find((l) => l.label === 'Odysseus')
          ? el('a', {
            class: 'btn btn--ghost btn--sm',
            href: state.config.links.find((l) => l.label === 'Odysseus').href,
            target: '_blank',
            rel: 'noreferrer',
          }, 'Open')
          : null),
      el('div', { class: 'ag-list' },
        el('div', { class: 'ag-row ag-kv' },
          dot(o.up ? 'ok' : 'err'),
          el('span', { class: 'ag-row-name' }, o.up ? (o.status || 'up') : 'not answering'),
          el('span', { class: 'meta' }, o.error || '')),
        o.version
          ? el('div', { class: 'ag-row ag-kv' },
            el('span', {}), el('span', { class: 'ag-row-name' }, 'version'),
            el('span', { class: 'meta' }, String(o.version)))
          : null)),

    el('section', { class: 'panel stack' },
      el('h3', { class: 'h3' }, 'What it runs on'),
      el('div', { class: 'ag-list' }, parts.map(serviceRow))));
}

function viewServices() {
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Services'),
      el('span', { class: 'meta' }, 'the containers this module is responsible for')),
    el('div', { class: 'ag-list' }, state.services.map(serviceRow)),
    el('p', { class: 'meta' },
      'Everything else on this machine — and its CPU, memory and disks — lives in Fleet.'));
}

/* ── actions ─────────────────────────────────────────────────────────── */

async function restart(s) {
  state.busy = s.id; render();
  try {
    const r = await api(`/api/services/${s.id}/restart`, { method: 'POST' });
    ctx.toast?.(r?.error ? 'err' : 'ok', r?.error ? `Could not restart ${s.name}` : `Restarted ${s.name}`);
  } catch (e) {
    ctx.toast?.('err', `Could not restart ${s.name}`, e.message);
  } finally {
    state.busy = null;
    await refresh();
  }
}

async function toggleWorkflow(w) {
  state.busy = `wf:${w.id}`; render();
  const action = w.active ? 'deactivate' : 'activate';
  try {
    const r = await api(`/api/n8n/workflows/${w.id}/${action}`, { method: 'POST' });
    ctx.toast?.(r?.error ? 'err' : 'ok',
      r?.error ? `Could not ${action} ${w.name}` : `${w.active ? 'Deactivated' : 'Activated'} ${w.name}`,
      r?.error);
  } catch (e) {
    ctx.toast?.('err', `Could not ${action} ${w.name}`, e.message);
  } finally {
    state.busy = null;
    await refresh();
  }
}

/* ── load ────────────────────────────────────────────────────────────── */

async function refresh() {
  const [cfg, svc, wf, ex, ody] = await Promise.all([
    state.config ? state.config : tryApi('/api/config'),
    tryApi('/api/services'),
    tryApi('/api/n8n/workflows'),
    tryApi('/api/n8n/executions'),
    tryApi('/api/odysseus'),
  ]);
  state.config = cfg?.error ? null : cfg;
  state.services = svc?.services || [];
  state.workflows = wf?.error ? { error: wf.error } : (wf?.workflows || []);
  state.executions = ex?.error ? [] : (ex?.executions || []);
  state.execWindow = ex?.windowDays || null;
  state.odysseus = ody?.error ? { configured: true, up: false, error: ody.error } : ody;
  render();
}

function go(view) {
  state.view = view;
  ctx.setView?.(view);
  render();
}

function render() {
  if (!root || state.view === 'claude') return;
  root.replaceChildren();
  if (!state.services.length && state.workflows === null) {
    root.append(el('div', { class: 'stack-lg' },
      el('span', { class: 'skeleton', style: 'height:56px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:180px;display:block' })));
    return;
  }
  const body = state.view === 'workflows' ? viewWorkflows()
    : state.view === 'odysseus' ? viewOdysseus()
      : state.view === 'services' ? viewServices()
        : viewOverview();
  root.append(body);
}

/* ── module contract ─────────────────────────────────────────────────── */

export default {
  async mount(mountEl, context) {
    root = mountEl;
    ctx = context;
    state.view = context.view || 'overview';

    if (!document.getElementById('ag-css')) {
      const link = document.createElement('link');
      link.id = 'ag-css';
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/agent.css`;
      document.head.appendChild(link);
    }

    if (state.view === 'claude') {
      claudeOpen = true;
      await mountClaude(root, ctx);
    } else {
      render();
      await refresh();
    }
    // n8n's own state changes on its schedule, not ours; a minute is often
    // enough to see a run land without polling a workflow engine to death.
    timer = setInterval(() => { if (!document.hidden && state.view !== 'claude') refresh(); }, 60_000);
  },

  async setView(view) {
    state.view = view || 'overview';
    if (state.view === 'claude') {
      if (claudeOpen) routeClaude();
      else { claudeOpen = true; await mountClaude(root, ctx); }
      return;
    }
    if (claudeOpen) { unmountClaude(); claudeOpen = false; }
    render();
    if (!state.services.length && state.workflows === null) await refresh();
  },

  async unmount() {
    if (claudeOpen) { unmountClaude(); claudeOpen = false; }
    if (timer) clearInterval(timer);
    timer = null; root = null; ctx = null;
    state.services = []; state.workflows = null; state.executions = null;
  },
};
