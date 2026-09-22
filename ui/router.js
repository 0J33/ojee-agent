/* ============================================================
   Router view — the Laya tool router, which runs on Loq.

   Same surface language as the rest of the module: a `.panel` per
   section, `.ag-row` for rows, `.dot` for status, `.fieldline` for
   the dotted-leader readouts, and the design system's `.togrow`
   for the switch.

   Two things shape the code rather than the styling:

   Loq is a laptop. It sleeps, it leaves the house, it gets shut.
   So "no answer" is a state this view RENDERS, not an error it
   throws — an unreachable router is a normal Tuesday and must not
   look like a broken module.

   Every call goes through the console-scoped `api()` handed in by
   index.js, never a bare fetch(). Mounted, this module lives at
   `/agent`, so an absolute `fetch('/api/router/...')` hits the
   console shell instead and every request comes back "unreachable"
   — which is exactly the bug this file shipped with.
   ============================================================ */

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

const dot = (status) => el('span', {
  class: `dot dot--${status === 'err' ? 'err' : status === 'warn' ? 'warn' : status === 'live' ? 'live' : 'ok'}`,
});

/** key · · · · · value — the console's readout line. */
const fline = (k, v, accent) => el('div', { class: 'fieldline' },
  el('span', { class: 'fl-k' }, k),
  el('span', { class: 'fl-lead' }),
  el('span', { class: `fl-v ${accent ? 'fl-v--accent' : ''}` }, v));

/* ── state ───────────────────────────────────────────────────────────── */

let ctx = null;
let api = null;

/* The ask box is ONE element, reused across repaints. render() replaces the
   whole subtree, so a freshly built <input> loses focus and the caret every
   time an answer lands -- on a phone that closes the keyboard after every
   question, which is the entire interaction. Declared up here with the other
   module state because initRouter() below resets it. */
let inputEl = null;

/* Conversation state lives on Loq, keyed by this. Stable per browser so a
   reload continues the thread rather than silently starting a new one. */
const SESSION = (() => {
  try {
    const k = 'ojee-router-session';
    let v = localStorage.getItem(k);
    if (!v) { v = `c-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(k, v); }
    return v;
  } catch { return 'console'; }
})();

const state = {
  loaded: false,
  reachable: false,
  enabled: false,
  ready: false,
  parked: null,
  gpu: null,
  gates: null,
  labels: null,
  chat: null,
  idleMin: null,
  reason: null,
  busy: false,
  query: '',      // survives a repaint; the box is recreated on every render
  turns: [],      // newest first — the phone shows the answer without scrolling
  error: null,
  workflows: null,   // for the id picker, filled lazily on first needs_args
};

/** One turn: route, run, and have the model write the reply. */
async function ask(text, given, repaint) {
  state.busy = true; state.error = null; repaint?.();
  const turn = { text, at: Date.now(), pending: true };
  state.turns.unshift(turn);
  repaint?.();
  try {
    const r = await api('/api/router/chat', {
      method: 'POST',
      body: JSON.stringify({ text: undefined, message: text, session: SESSION, given: given || null }),
    });
    Object.assign(turn, { pending: false, res: r?.error ? null : r, err: r?.error || null });
  } catch (e) {
    Object.assign(turn, { pending: false, res: null, err: e.message });
  } finally {
    state.busy = false;
    repaint?.();
  }
}

async function resetChat(repaint) {
  state.turns = [];
  repaint?.();
  try { await api('/api/router/chat/reset', { method: 'POST', body: JSON.stringify({ session: SESSION }) }); }
  catch { /* the transcript is already gone locally, which is what you asked for */ }
}

/** Workflow names for the id picker; the module already has this endpoint. */
async function loadWorkflows(repaint) {
  if (state.workflows) return;
  const r = await api('/api/n8n/workflows');
  state.workflows = r?.error ? [] : (r.workflows || []);
  repaint?.();
}

export function initRouter(context, scopedApi) {
  ctx = context;
  api = scopedApi;
  // A remount is a new document subtree; the cached input from the last one is
  // detached and would never appear.
  inputEl = null;
}

export async function refreshRouter(repaint) {
  const r = await api('/api/router/status');
  state.loaded = true;
  if (r?.error) {
    Object.assign(state, { reachable: false, enabled: false, reason: r.error });
  } else {
    Object.assign(state, r, { error: null });
  }
  repaint?.();
}

async function toggle(repaint) {
  const want = !state.enabled;
  state.busy = true; repaint?.();
  try {
    const r = await api('/api/router/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: want }),
    });
    ctx?.toast?.(r?.error ? 'err' : 'ok',
      r?.error ? 'Could not switch the router'
        : want ? 'Router on' : 'Router off — GPU memory released',
      r?.error);
  } catch (e) {
    ctx?.toast?.('err', 'Could not switch the router', e.message);
  } finally {
    state.busy = false;
    // The unit takes a moment to bind, and the model ~30s more to load, so
    // the first poll after "on" will usually say enabled-but-not-ready.
    await refreshRouter(repaint);
  }
}

async function tryRoute(text, repaint) {
  state.busy = true; state.error = null; state.query = text; repaint?.();
  try {
    const r = await api('/api/router/route', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (r?.error) { state.error = r.error; state.last = null; }
    else { state.last = r; state.error = null; }
  } catch (e) {
    state.error = e.message; state.last = null;
  } finally {
    state.busy = false;
    repaint?.();
  }
}

/* ── pieces ──────────────────────────────────────────────────────────── */

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;

/** VRAM as the design system's segmented meter. */
function gpuMeter(gpu) {
  if (!gpu?.total_mb) return null;
  const segs = 12;
  const on = Math.min(segs, Math.round((gpu.used_mb / gpu.total_mb) * segs));
  return el('div', { class: 'ag-rt-gpu' },
    el('span', { class: 'label' }, 'GPU'),
    el('div', {
      class: 'meter',
      role: 'img',
      'aria-label': `GPU memory ${gb(gpu.used_mb)} of ${gb(gpu.total_mb)} used`,
    }, Array.from({ length: segs }, (_, i) => el('i', { class: i < on ? 'on' : '' }))),
    el('span', { class: 'meta' }, `${gb(gpu.used_mb)} / ${gb(gpu.total_mb)}`));
}

function statusText() {
  if (!state.reachable) return state.reason === 'timeout' ? 'no answer — Loq may be asleep' : 'unreachable';
  if (!state.enabled) return 'off — holding no GPU memory';
  if (!state.ready) return 'starting — loading the model';
  if (state.parked) return 'on — weights parked, wakes on first request';
  return 'on — ready';
}

function statusTone() {
  if (!state.reachable) return 'warn';
  if (!state.enabled) return 'warn';
  if (!state.ready) return 'live';
  return 'ok';
}

/**
 * The switch.
 *
 * `.togrow` per the design system: the ROW is the button and the switch
 * inside is decoration driven by data-on — no nested <input>, which would
 * be announced twice and flagged as a nested interactive control.
 */
function switchRow(repaint) {
  const on = state.reachable && state.enabled;
  return el('button', {
    class: 'togrow ag-rt-switch',
    type: 'button',
    'data-on': on ? '1' : '0',
    'aria-pressed': on ? 'true' : 'false',
    'aria-disabled': (!state.reachable || state.busy) ? 'true' : null,
    disabled: !state.reachable || state.busy,
    onclick: () => toggle(repaint),
  },
  el('span', { class: 'tlabel' },
    dot(statusTone()),
    el('span', { class: 'ag-rt-switch-name' }, 'Router on Loq')),
  el('span', { class: 'ag-rt-switch-side' },
    el('span', { class: 'meta' }, state.busy ? 'working…' : statusText()),
    el('span', { class: 'toggle', 'aria-hidden': 'true' },
      el('span', { class: 'track' }))));
}

function verdictTag(action) {
  return el('span', {
    class: `vtag ${action === 'dispatch' ? '' : 'vtag--warn'}`,
  }, action === 'dispatch' ? 'ran' : action);
}

/* ── rendering a tool's answer ────────────────────────────────────────────
   Every tool returns a different shape, so the shapes worth reading get a
   renderer and everything else falls back to formatted JSON. A fallback that
   shows the raw object is not a failure — it is still the answer, and it beats
   a renderer that guesses wrong and hides the useful half. */

const kv = (k, v) => el('div', { class: 'ag-row ag-kv' },
  el('span', {}), el('span', { class: 'ag-row-name' }, k), el('span', { class: 'meta' }, v));

const RENDER = {
  fleet_status: (d) => (d.hosts || []).map((h) => kv(h.name,
    [h.cpu != null ? `cpu ${Number(h.cpu).toFixed(0)}%` : null,
     h.mem != null ? `mem ${Number(h.mem).toFixed(0)}%` : null,
     h.up === false ? 'down' : null].filter(Boolean).join(' · ') || '—')),

  service_status: (d) => (d.services || []).map((x) => kv(x.name, x.detail || (x.ok ? 'up' : 'down'))),

  n8n_list: (d) => (d.workflows || []).slice(0, 40)
    .map((w) => kv(w.name, w.active ? 'active' : 'off')),

  n8n_executions: (d) => (d.executions || []).slice(0, 15)
    .map((e) => kv(e.wf || e.id, `${e.status} · ${e.started ? new Date(e.started).toLocaleString() : ''}`)),

  claude_session: (d) => (d.sessions || []).map((x) => kv(x.title || x.id, `${x.state}${x.cwd ? ` · ${x.cwd}` : ''}`)),

  web_search: (d) => [
    d.note ? el('p', { class: 'meta' }, d.note) : null,
    ...(d.results || []).map((r) => el('div', { class: 'ag-rt-hit' },
      el('a', { class: 'ag-rt-hit-title', href: r.url, target: '_blank', rel: 'noopener' }, r.title),
      r.snippet ? el('p', { class: 'meta' }, r.snippet) : null)),
  ].filter(Boolean),

  api_discover: (d) => (d.apis || []).map((a) => el('div', { class: 'ag-rt-hit' },
    el('a', { class: 'ag-rt-hit-title', href: a.url, target: '_blank', rel: 'noopener' }, a.name),
    el('p', { class: 'meta' }, a.desc || ''))),

  repo_lookup: (d) => [
    d.log ? el('pre', { class: 'code' }, d.log) : null,
    ...(d.matches || []).slice(0, 12).map((m) => el('pre', { class: 'code' }, m)),
  ].filter(Boolean),

  web_fetch: (d) => el('p', { class: 'ag-rt-text' }, String(d.text || '').slice(0, 1200)),

  home_device: (d) => d.state
    ? Object.entries(d.state).slice(0, 8).map(([k, v]) => kv(k.replace(/_/g, ' '), String(v)))
    : null,

  public_api: (d) => {
    // Whatever the catalogue returned. Weather is the common one and has a
    // shape worth naming; the rest is better shown than guessed at.
    if (d.current) {
      return Object.entries(d.current)
        .filter(([k]) => k !== 'time' && k !== 'interval')
        .map(([k, v]) => kv(k.replace(/_/g, ' '), String(v)));
    }
    if (d.rates) return Object.entries(d.rates).map(([k, v]) => kv(k, String(v)));
    return null;
  },
};

function renderResult(tool, data) {
  if (data == null) return null;
  if (data.error) return el('div', { class: 'alert alert--err' }, el('b', {}, 'Tool failed'), el('span', {}, String(data.error)));
  let body = null;
  try { body = RENDER[tool]?.(data) ?? null; } catch { body = null; }
  const has = Array.isArray(body) ? body.filter(Boolean).length : !!body;
  if (has) return el('div', { class: 'ag-rt-body' }, body);
  return el('pre', { class: 'code ag-rt-json' }, JSON.stringify(data, null, 2).slice(0, 2000));
}

/**
 * The tool wants a specific thing named, and Laya does not produce arguments.
 * Rather than making you know a workflow id, the id field becomes a picker of
 * the real workflows — the module already has that list.
 */
function argsForm(turn, repaint) {
  const needs = turn.res.needs || [];
  const vals = {};
  const fields = needs.map((k) => {
    if (k === 'id') {
      loadWorkflows(repaint);
      const sel = el('select', { class: 'select', 'aria-label': 'Workflow' },
        el('option', { value: '' }, '— pick a workflow —'),
        (state.workflows || []).map((w) => el('option', { value: w.id }, `${w.name}${w.active ? '' : '  (off)'}`)));
      sel.addEventListener('change', () => { vals.id = sel.value; });
      return el('div', { class: 'field' }, el('label', {}, 'workflow'), sel);
    }
    const inp = el('input', { class: 'input', type: 'text', 'aria-label': k });
    inp.addEventListener('input', () => { vals[k] = inp.value; });
    return el('div', { class: 'field' }, el('label', {}, k), inp);
  });
  return el('div', { class: 'ag-rt-args stack' },
    el('p', { class: 'meta' }, turn.res.note || 'Needs more to go on.'),
    ...fields,
    el('button', {
      class: 'btn btn--sm', type: 'button', disabled: state.busy,
      onclick: () => ask(turn.text, { ...turn.args, ...vals }, repaint),
    }, 'Run it'));
}

function turnBlock(turn, repaint) {
  const r = turn.res;
  const head = el('div', { class: 'ag-rt-said' }, el('span', { class: 'ag-rt-you' }, turn.text));

  if (turn.pending) {
    return el('div', { class: 'ag-rt-turn' }, head,
      el('span', { class: 'skeleton', style: 'height:38px;display:block' }));
  }
  if (turn.err) {
    return el('div', { class: 'ag-rt-turn' }, head,
      el('div', { class: 'alert alert--err' }, el('b', {}, 'Failed'), el('span', {}, turn.err)));
  }
  if (!r) return el('div', { class: 'ag-rt-turn' }, head);

  const bits = [head];

  // The reply the model wrote. It leads because it is what you asked for.
  if (r.reply) bits.push(el('p', { class: 'ag-rt-reply' }, r.reply));

  if (r.action === 'needs') {
    bits.push(pickOne(turn, r, repaint));
  }

  // The structured result stays, under a disclosure. The model dropped a fact
  // the first time it was asked to summarise a list, so the data it was given
  // is never thrown away — prose that loses something is fine beside the
  // source and dangerous instead of it.
  if (r.result) {
    const body = renderResult(r.tool, r.result);
    if (body) {
      bits.push(el('details', { class: 'ag-rt-detail' },
        el('summary', {},
          el('span', { class: 'meta' },
            `${r.tool} · ${pct(r.confidence || 0)}${r.route_ms ? ` · routed in ${r.route_ms} ms` : ''}`
            + `${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s total` : ''}`)),
        body));
    }
  } else if (r.tool && r.action !== 'needs') {
    bits.push(el('div', { class: 'ag-rt-trace' },
      el('span', { class: 'meta' },
        r.action === 'answered'
          ? `answered directly${r.confidence ? ` · router was ${pct(r.confidence)} on ${r.tool}` : ''}`
          : `${r.tool} · ${pct(r.confidence || 0)}`)));
  }

  return el('div', { class: 'ag-rt-turn' }, bits);
}

/**
 * The fuzzy matcher could not settle it, so ask — with the real candidates it
 * was choosing between, as buttons. One tap beats retyping a name.
 */
function pickOne(turn, r, repaint) {
  const opts = (r.needs && r.needs.options) || [];
  const field = (r.needs && r.needs.field) || 'value';
  if (!opts.length) {
    const inp = el('input', { class: 'input', type: 'text', 'aria-label': field });
    return el('div', { class: 'ag-rt-args stack' },
      el('div', { class: 'field' }, el('label', {}, field), inp),
      el('button', {
        class: 'btn btn--sm', type: 'button', disabled: state.busy,
        onclick: () => inp.value.trim() && ask(turn.text, { [field]: inp.value.trim() }, repaint),
      }, 'Run it'));
  }
  return el('div', { class: 'ag-rt-args' },
    el('div', { class: 'ag-rt-picks' },
      opts.map((o) => el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', disabled: state.busy,
        onclick: () => ask(turn.text, { [field]: o.id ?? o.name }, repaint),
      }, o.name || String(o.id)))));
}

function askInput(repaint) {
  if (inputEl) return inputEl;
  inputEl = el('input', {
    class: 'input',
    type: 'text',
    'aria-label': 'Ask the router',
    enterkeyhint: 'send',
    autocomplete: 'off',
    autocapitalize: 'none',
    oninput: (e) => { state.query = e.target.value; },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim();
      if (!v) return;
      e.target.value = '';
      ask(v, null, repaint);
    },
  });
  return inputEl;
}

function askPanel(repaint) {
  const input = askInput(repaint);
  const go = el('button', {
    class: 'btn btn--sm', type: 'button',
    disabled: state.busy || !state.ready,
    onclick: () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      ask(v, null, repaint);
      input.focus();
    },
  }, state.busy ? '…' : 'Send');

  const chat = state.chat;
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Chat'),
      el('span', { class: 'ag-rt-head-side' },
        chat ? el('span', { class: 'meta' },
          `${chat.model}${chat.loaded ? '' : ' · cold'}`) : null,
        state.turns.length ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onclick: () => resetChat(repaint),
        }, 'Clear') : null)),
    el('div', { class: 'ag-rt-try' }, input, go),
    !state.ready && el('span', { class: 'help' },
      state.enabled ? 'waiting for the model to finish loading' : 'turn it on first'),
    state.turns.length
      ? el('div', { class: 'ag-rt-turns' }, state.turns.slice(0, 15).map((t) => turnBlock(t, repaint)))
      : el('div', { class: 'empty' },
          el('b', {}, 'ask it something'),
          el('p', {}, '"how is loq doing" · "whats the weather in cairo" · '
            + '"what can you do" · "is couchdb up"')));
}

/* ── view ────────────────────────────────────────────────────────────── */

export function viewRouter(repaint) {
  if (!state.loaded) {
    return el('div', { class: 'stack-lg' },
      el('span', { class: 'skeleton', style: 'height:64px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:150px;display:block' }));
  }

  const head = el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Router'),
      el('span', { class: 'meta' }, 'local, on Loq')),
    switchRow(repaint),
    state.reachable
      ? el('div', { class: 'ag-rt-facts' },
          gpuMeter(state.gpu),
          el('div', { class: 'ag-rt-lines' },
            state.labels != null ? fline('tools', String(state.labels)) : null,
            state.gates ? fline('read gate', String(state.gates.read)) : null,
            state.gates ? fline('write gate', String(state.gates.write)) : null,
            state.idleMin != null ? fline('idle park', `${state.idleMin} min`) : null))
      : el('div', { class: 'ag-problem' },
          el('strong', {}, 'Loq is not answering'),
          el('p', { class: 'meta' },
            'The router runs on Loq, so this says nothing about HP — the console and '
            + 'everything else here are unaffected. Check the laptop is awake and on '
            + 'the tailnet.'),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => refreshRouter(repaint),
          }, 'Check again')));

  return el('div', { class: 'stack-lg ag-rt' },
    head,
    state.reachable ? askPanel(repaint) : null,
    el('p', { class: 'meta' },
      'One switch. Off stops the router and releases the language model too, so '
      + 'nothing is held on Loq. Left on, both park themselves when idle.'));
}
