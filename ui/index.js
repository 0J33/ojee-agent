/* ============================================================
   ojee-agent — the AI and automation module.

   Five views over the AI and automation stack: an overview led by
   the Claude Code sessions on the host, those sessions themselves
   (claude.js), n8n's workflows and their recent runs, Odysseus,
   and the stack's own containers.

   What is NOT here any more: CPU graphs, memory bars, a list of
   every container on the box, and a whitelist of restart commands
   for things this module has nothing to do with. That was a host
   dashboard living inside an automation tool, and ojee-fleet now
   reads the machine directly rather than asking a service on it
   over HTTP for numbers already sitting in /proc.
   ============================================================ */

import { mountClaude, routeClaude, unmountClaude, stateDot, stateTag } from './claude.js';
import { ensureIcons } from './claude-icons.js';

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
let claudeTimer = null;
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
  claude: null,           // the runner's /api/state; null = not loaded, {error} = down
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

const restartBtn = (s) => el('button', {
  class: 'btn btn--ghost btn--sm',
  type: 'button',
  disabled: state.busy === s.id,
  onclick: () => restart(s),
}, state.busy === s.id ? '…' : 'Restart');

const serviceRow = (s) => el('div', { class: `ag-row ag-svc ${s.present && !s.ok ? 'is-bad' : ''}` },
  dot(!s.present ? 'warn' : s.ok ? 'ok' : 'err'),
  el('span', { class: 'ag-row-name' }, s.name),
  el('span', { class: 'meta' }, s.role),
  el('span', { class: 'meta ag-svc-detail' }, s.detail),
  s.present ? restartBtn(s) : el('span', { class: 'meta' }, '—'));

/* ── overview ────────────────────────────────────────────────────────────
   What the module is mostly FOR now is the Claude sessions on the host, so
   they lead: a verdict that says whether anything needs you, four readouts,
   and the open sessions with the last thing each one said. The stack and
   n8n sit beside them, compact — a stopped container still gets its
   Restart button, a running one only its uptime (Services has the rest).

   The Claude parts repaint every few seconds from the runner; the rest on
   the module's minute. Each repaint replaces only its own slot. */

const NEEDS = ['waiting', 'blocked', 'error'];
const WORKING = ['running', 'starting'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A reply as one line of text: links to their words, no bold or code marks. */
const plain = (t) => String(t)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*|`+/g, '')
  .replace(/^\s*(#+|[-*]|\d+\.)\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

const icon = (name) => {
  const t = document.createElement('template');
  t.innerHTML = ctx.icon(`i-${name}`, 'ic');
  return t.content.firstChild;
};

/** Into the Claude view, whatever this module is mounted as. */
function openClaude(...segs) {
  const mod = location.hash.replace(/^#\/?/, '').split('/')[0] || 'agent';
  location.hash = `#/${[mod, 'claude', ...segs].map(encodeURIComponent).join('/')}`;
}

function claudeParts() {
  const c = state.claude;
  if (!c || c.error) return null;
  const open = (c.sessions || []).filter((s) => s.state !== 'stopped');
  return {
    c,
    open,
    needs: open.filter((s) => NEEDS.includes(s.state)),
    working: open.filter((s) => WORKING.includes(s.state)),
    paused: open.filter((s) => s.state === 'paused'),
    active: (c.accounts || []).find((a) => a.id === c.settings?.activeAccount) || null,
  };
}

function ovVerdict() {
  const p = claudeParts();
  const deployed = state.services.filter((s) => s.present);
  const stopped = deployed.filter((s) => !s.ok);
  const wf = Array.isArray(state.workflows) ? state.workflows : [];
  const execs = Array.isArray(state.executions) ? state.executions : [];
  const failed = execs.filter((e) => e.status === 'error' || e.status === 'failed');

  const [tone, head] = p?.needs.length
    ? ['warn', `${plural(p.needs.length, 'session')} need${p.needs.length === 1 ? 's' : ''} you`]
    : stopped.length ? ['err', `${plural(stopped.length, 'service')} stopped`]
      : p?.working.length ? ['live', `${plural(p.working.length, 'session')} working`]
        : state.claude?.error ? ['warn', 'The Claude runner is not answering']
          : ['ok', 'All quiet'];
  return el('div', { class: 'ag-verdict' },
    el('span', { class: `dot dot--${tone}` }),
    el('strong', {}, head),
    el('span', { class: 'meta' }, [
      p?.needs.length && p.working.length ? `${p.working.length} working` : null,
      p?.needs.length && stopped.length ? `${stopped.length} stopped` : null,
      deployed.length ? `stack ${deployed.length - stopped.length}/${deployed.length} up` : null,
      state.workflows?.error ? 'n8n not answering' : `${wf.filter((w) => w.active).length}/${wf.length} workflows active`,
      failed.length ? plural(failed.length, 'failed run') : null,
    ].filter(Boolean).join(' · ')));
}

function tile(label, value, meta, { tone, unit, tag, onclick, title } = {}) {
  return el('button', { class: `panel stat ag-ov-tile ${tone ? `is-${tone}` : ''}`, type: 'button', title, onclick },
    el('span', { class: 'label' }, label),
    el('span', { class: 'value' }, String(value), unit ? el('sup', {}, unit) : null, tag || null),
    el('span', { class: 'meta' }, meta));
}

function ovTiles() {
  if (!state.config?.has?.claude) return null;
  const p = claudeParts();
  if (!p) return null;
  const { c, open, needs, working, paused, active } = p;

  const bg = open.reduce((n, s) => n + (s.background?.subagents || 0) + (s.background?.shells || 0), 0);
  const count = (st) => needs.filter((s) => s.state === st).length;
  const g = c.governor;
  const target = c.settings?.tempTarget || 80;
  const heat = g?.temp == null ? null : g.temp >= target + 8 ? 'err' : g.temp >= target ? 'warn' : null;
  const accts = c.accounts || [];
  const ready = accts.filter((a) => a.status === 'ok');
  const others = accts.filter((a) => a !== active && a.status !== 'ok');

  return el('div', { class: 'tiles' },
    tile('Working', working.length,
      [`${open.length} open`, paused.length ? `${paused.length} paused` : null, bg ? `${bg} bg` : null].filter(Boolean).join(' · '),
      { onclick: () => openClaude() }),
    tile('Needs you', needs.length,
      needs.length
        ? [count('waiting') ? `${count('waiting')} asking` : null, count('blocked') ? `${count('blocked')} blocked` : null,
          count('error') ? plural(count('error'), 'error') : null].filter(Boolean).join(' · ')
        : 'nothing waiting',
      { tone: count('error') ? 'err' : needs.length ? 'warn' : null, onclick: () => (needs[0] ? openClaude(needs[0].id) : openClaude()) }),
    tile('Session CPU', g?.active ? g.usagePct : '—',
      !g ? 'no reading' : !g.active ? `governor off${g.reason ? ` — ${g.reason}` : ''}`
        : g.frozenPct ? `held back ${g.frozenPct}% · cap ${g.capPct}%`
          : `cap ${g.capPct}% · ${g.threads} threads`,
      {
        unit: g?.active ? '%' : null,
        tag: g?.temp != null ? el('span', { class: `vtag ${heat ? `vtag--${heat}` : ''}` }, `${g.temp}°C`) : null,
        tone: g?.hot ? 'warn' : null,
        title: 'CPU used by the Claude sessions on HP, as a share of all its threads',
        onclick: () => openClaude('settings'),
      }),
    tile('Accounts', ready.length,
      [active ? `on ${active.label}${active.status !== 'ok' ? ` (${active.status})` : ''}` : 'none active',
        ...others.map((a) => `${a.label} ${a.status}`)].join(' · '),
      { unit: `/${accts.length}`, tone: active && active.status !== 'ok' ? 'warn' : null, onclick: () => openClaude('accounts') }));
}

function ovSessionRow(s, c) {
  const home = c.runner?.home;
  const where = home && s.cwd?.startsWith(home) ? `~${s.cwd.slice(home.length)}` : s.cwd;
  const model = c.models?.find((m) => m.id === s.model?.current)?.label || s.model?.current;
  const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
  const said = NEEDS.includes(s.state)
    ? s.question?.text || s.detail || s.lastError?.text
    : s.lastAssistant || s.detail;
  return el('button', { class: `ag-cl-row ag-ov-srow ${s.state === 'error' ? 'is-bad' : ''}`, type: 'button', onclick: () => openClaude(s.id) },
    stateDot(s.state),
    el('span', { class: 'ag-ov-srow-main' },
      el('span', { class: 'ag-ov-srow-title' }, s.title || s.id.slice(0, 8)),
      el('span', { class: 'ag-ov-srow-sub' }, [where, model ? `${model}${fell ? ' (fallback)' : ''}` : null].filter(Boolean).join(' · ')),
      said ? el('span', { class: 'ag-ov-srow-said' }, plain(said)) : null),
    el('span', { class: 'ag-ov-srow-side' },
      stateTag(s.state, s.background),
      el('span', { class: 'meta' }, s.lastActivityAt ? ctx.relTime(s.lastActivityAt) : '—')));
}

const SHOWN = 8;

function ovSessions() {
  if (!state.config?.has?.claude) return null;
  const head = el('div', { class: 'ag-panel-head' },
    el('h3', { class: 'h3' }, 'Claude sessions'),
    el('div', { class: 'ag-ov-actions' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openClaude('new') }, icon('plus'), 'New'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openClaude() }, 'All')));
  const panel = el('section', { class: 'panel stack' }, head);
  if (!state.claude) {
    panel.append(el('span', { class: 'skeleton', style: 'height:120px;display:block' }));
    return panel;
  }
  if (state.claude.error) {
    panel.append(problem('The Claude runner is not answering', state.claude.error,
      el('p', { class: 'meta' }, 'It runs on HP as ojee-claude.service; sessions keep running in tmux while it is down.')));
    return panel;
  }
  const { c, open } = claudeParts();
  // Needs you, then working, then the rest; most recently active first.
  const rank = (s) => (NEEDS.includes(s.state) ? 0 : WORKING.includes(s.state) ? 1 : 2);
  const sorted = [...open].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  if (!sorted.length) {
    panel.append(el('div', { class: 'empty' },
      icon('terminal'),
      el('b', {}, 'No sessions open'),
      el('p', {}, 'Start one in any folder on HP. It runs unattended and pings Discord when it needs you.'),
      el('button', { class: 'btn btn--sm', type: 'button', onclick: () => openClaude('new') }, 'New session')));
    return panel;
  }
  panel.append(el('div', { class: 'ag-cl-list' }, sorted.slice(0, SHOWN).map((s) => ovSessionRow(s, c))));
  if (sorted.length > SHOWN) {
    panel.append(el('button', { class: 'btn btn--ghost btn--sm ag-ov-more', type: 'button', onclick: () => openClaude() },
      `${sorted.length - SHOWN} more`));
  }
  return panel;
}

function ovStack() {
  const deployed = state.services.filter((s) => s.present);
  const up = deployed.filter((s) => s.ok).length;
  const o = state.odysseus;
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Stack'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go('services') }, `${up} of ${deployed.length} up`)),
    el('div', { class: 'ag-list' }, state.services.map((s) => {
      const bad = s.present && !s.ok;
      // A container can be up while the app in it is not.
      const sick = s.id === 'odysseus' && o?.configured && s.ok && !o.up ? 'API not answering' : null;
      return el('div', { class: `ag-row ag-ov-svc ${bad ? 'is-bad' : ''}` },
        dot(!s.present || sick ? 'warn' : s.ok ? 'ok' : 'err'),
        el('span', { class: 'ag-row-name' }, s.name),
        // "(healthy)" is what the dot already says.
        el('span', { class: 'meta' }, sick || (s.present ? s.detail.replace(/\s*\(healthy\)/, '') : 'not deployed')),
        bad ? restartBtn(s) : null);
    })));
}

const ovExecRow = (e) => {
  const bad = e.status === 'error' || e.status === 'failed';
  return el('div', { class: `ag-row ag-ov-exec ${bad ? 'is-bad' : ''}`, title: e.status || '' },
    dot(bad ? 'err' : e.status === 'running' ? 'warn' : 'ok'),
    el('span', { class: 'ag-row-name' }, e.workflowName || e.workflowId || 'unnamed'),
    el('span', { class: 'meta' }, ago(e.startedAt)));
};

function ovWorkflows() {
  const panel = el('section', { class: 'panel stack' });
  if (state.workflows?.error) {
    panel.append(el('h3', { class: 'h3' }, 'Workflows'), problem('n8n did not answer', state.workflows.error));
    return panel;
  }
  const wf = Array.isArray(state.workflows) ? state.workflows : [];
  const execs = Array.isArray(state.executions) ? state.executions : [];
  panel.append(
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Workflows'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => go('workflows') },
        `${wf.filter((w) => w.active).length} of ${wf.length} active`)),
    execs.length
      ? el('div', { class: 'ag-list' }, execs.slice(0, 5).map(ovExecRow))
      : el('p', { class: 'meta' }, state.execWindow ? `Nothing has run in the last ${state.execWindow} days.` : 'Nothing has run recently.'));
  return panel;
}

const slot = (name, content) => el('div', { class: 'ag-ov-slot', 'data-slot': name }, content);

function viewOverview() {
  const side = el('div', { class: 'stack-lg ag-ov-side' }, ovStack(), ovWorkflows());
  return el('section', { class: 'stack-lg' },
    slot('verdict', ovVerdict()),
    slot('tiles', ovTiles()),
    state.config?.has?.claude
      ? el('div', { class: 'ag-ov-cols' }, slot('sessions', ovSessions()), side)
      : side);
}

/** Only the parts drawn from the runner, in place. */
function repaintClaude() {
  if (!root || state.view !== 'overview') return;
  for (const [name, make] of [['verdict', ovVerdict], ['tiles', ovTiles], ['sessions', ovSessions]]) {
    const s = root.querySelector(`[data-slot="${name}"]`);
    if (s) s.replaceChildren(...[make()].filter(Boolean));
  }
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

async function loadClaude() {
  if (state.config && !state.config.has?.claude) { state.claude = null; return; }
  const r = await tryApi('/api/claude/state');
  state.claude = r?.error ? { error: r.error } : r;
}

async function refresh() {
  const [cfg, svc, wf, ex, ody] = await Promise.all([
    state.config ? state.config : tryApi('/api/config'),
    tryApi('/api/services'),
    tryApi('/api/n8n/workflows'),
    tryApi('/api/n8n/executions'),
    tryApi('/api/odysseus'),
    loadClaude(),
  ]);
  state.config = cfg?.error ? null : cfg;
  state.services = svc?.services || [];
  state.workflows = wf?.error ? { error: wf.error } : (wf?.workflows || []);
  state.executions = ex?.error ? [] : (ex?.executions || []);
  state.execWindow = ex?.windowDays || null;
  state.odysseus = ody?.error ? { configured: true, up: false, error: ody.error } : ody;
  if (!state.config?.has?.claude) state.claude = null;
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

    // claude.css too: the overview draws sessions the way the Claude view does.
    for (const [id, file] of [['ag-css', 'agent.css'], ['ag-cl-css', 'claude.css']]) {
      if (document.getElementById(id)) continue;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/${file}`;
      document.head.appendChild(link);
    }
    ensureIcons();

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
    // Sessions change by the second; the overview keeps up with them.
    claudeTimer = setInterval(async () => {
      if (document.hidden || state.view !== 'overview' || !state.config?.has?.claude) return;
      await loadClaude();
      repaintClaude();
    }, 5000);
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
    clearInterval(claudeTimer);
    timer = null; claudeTimer = null; root = null; ctx = null;
    state.services = []; state.workflows = null; state.executions = null; state.claude = null;
  },
};
