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
/* One warm attempt per mount: a retry loop on a cold model would queue
   another 40-second load behind the first. */
let warmed = false;

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
  state.busy = true; state.error = null;
  // Appended, not prepended: a conversation reads downward. The transcript
  // scrolls to the bottom after each render, the way every chat does.
  const turn = { text, startedAt: Date.now(), pending: true };
  state.turns.push(turn);
  startTicking();
  repaint?.();
  try {
    const r = await api('/api/router/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, session: SESSION, given: given || null }),
    });
    Object.assign(turn, { res: r?.error ? null : r, err: r?.error || null });
  } catch (e) {
    Object.assign(turn, { res: null, err: e.message });
  } finally {
    turn.pending = false;
    turn.tookMs = Date.now() - turn.startedAt;
    state.busy = false;
    stopTicking();
    repaint?.();
  }
}

/* A pending turn shows how long it has been waiting, counting up.
   The tick mutates that one text node rather than repainting: a repaint at
   4Hz would rebuild the transcript and fight the scroll position. */
let tick = null;
function startTicking() {
  if (tick) return;
  tick = setInterval(() => {
    let any = false;
    for (const t of state.turns) {
      if (!t.pending) continue;
      any = true;
      if (t.elEl) t.elEl.textContent = secs(Date.now() - t.startedAt);
    }
    if (!any) stopTicking();
  }, 100);
}
function stopTicking() {
  if (tick) { clearInterval(tick); tick = null; }
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
  warmed = false;
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
  // Start the model loading now, while this page is being read, rather than
  // when the first message is sent. Once per view; nothing waits on it.
  if (state.ready && state.chat && !state.chat.loaded && !warmed) {
    warmed = true;
    api('/api/router/chat/warm', { method: 'POST' })
      .then(() => refreshRouter(repaint))
      .catch(() => { warmed = false; });
  }
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

/* ── pieces ──────────────────────────────────────────────────────────── */

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

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
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* A turn, in the console's own conversation idiom.

   The Claude view already established what a message looks like here:
   .ag-cl-msg, full width, a left accent bar for you and plain text for the
   reply, with a .ag-cl-msg-who label above each. Right-aligned bubbles would
   have been a second idiom for the same thing in the same document -- and
   this module's stylesheet loads beside every other module's. */
function turnBlock(turn, repaint) {
  const r = turn.res;
  const out = [el('div', { class: 'ag-cl-msg ag-cl-msg--user' },
    el('span', { class: 'ag-cl-msg-who' }, 'You',
      el('span', { class: 'meta' }, clock(turn.startedAt))),
    el('div', { class: 'ag-cl-pre' }, turn.text))];

  if (turn.pending) {
    const elapsed = el('span', { class: 'ag-ch-elapsed' }, secs(Date.now() - turn.startedAt));
    turn.elEl = elapsed;
    out.push(el('div', { class: 'ag-cl-msg ag-cl-msg--assistant' },
      el('span', { class: 'ag-cl-msg-who' }, 'thinking', elapsed),
      el('span', { class: 'ag-ch-dots' }, el('i'), el('i'), el('i'))));
    return el('div', { class: 'ag-ch-turn' }, out);
  }

  if (turn.err) {
    out.push(el('div', { class: 'ag-cl-msg ag-cl-msg--error is-bad' },
      el('span', { class: 'ag-cl-msg-who' }, 'Request failed'),
      el('div', { class: 'ag-cl-pre' }, turn.err)));
    return el('div', { class: 'ag-ch-turn' }, out);
  }
  if (!r) return el('div', { class: 'ag-ch-turn' }, out);

  const who = [
    r.tool && r.action !== 'answered' ? r.tool : (state.chat?.model || 'assistant'),
    turn.tookMs != null ? secs(turn.tookMs) : null,
    r.confidence ? pct(r.confidence) : null,
  ].filter(Boolean);

  const body = [el('span', { class: 'ag-cl-msg-who' }, who[0],
    el('span', { class: 'meta' }, who.slice(1).join(' · ')))];
  if (r.reply) body.push(el('div', { class: 'ag-cl-pre' }, r.reply));
  if (r.action === 'needs') body.push(pickOne(turn, r, repaint));
  if (r.action === 'confirm') body.push(confirmRow(turn, r, repaint));
  out.push(el('div', { class: 'ag-cl-msg ag-cl-msg--assistant' }, body));

  // The data the reply was written from, kept and collapsed -- the model
  // dropped a fact the first time it summarised a list.
  const data = r.result ? renderResult(r.tool, r.result) : null;
  if (data) {
    out.push(el('details', { class: 'ag-cl-msg ag-cl-msg--result ag-ch-data' },
      el('summary', {}, el('span', { class: 'meta' },
        `${r.tool} result${r.route_ms != null ? ` · routed in ${Math.round(r.route_ms)} ms` : ''}`)),
      data));
  }
  return el('div', { class: 'ag-ch-turn' }, out);
}

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
    el('div', { class: 'ag-ch-picks' },
      opts.map((o) => el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', disabled: state.busy,
        onclick: () => ask(turn.text, { [field]: o.id ?? o.name }, repaint),
      }, o.name || String(o.id)))));
}

/**
 * Anything with a side effect asks before it acts.
 *
 * Not belt-and-braces: "tell me some breaking bad quotes" routed to
 * reminder_send at 0.976, cleared the 0.85 write gate, and posted that
 * sentence to Discord. A threshold cannot catch a confident wrong answer, so
 * the last word is yours.
 */
function confirmRow(turn, r, repaint) {
  return el('div', { class: 'ag-ch-confirm' },
    el('span', { class: 'meta' }, r.what || 'This will change something.'),
    el('div', { class: 'ag-ch-picks' },
      el('button', {
        class: 'btn btn--sm', type: 'button', disabled: state.busy,
        onclick: () => ask(turn.text, { ...(r.payload || {}), confirmed: true }, repaint),
      }, 'Do it'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', disabled: state.busy,
        onclick: () => { turn.res = { ...r, action: 'cancelled', reply: 'Cancelled.' }; repaint?.(); },
      }, 'Cancel')));
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
  // Caching the node kept its value across repaints but not its focus:
  // render() calls replaceChildren(), and detaching a focused element blurs
  // it. On a phone that closes the keyboard mid-sentence. Capture the state
  // here -- askPanel runs BEFORE the swap, so the old node is still active --
  // and put it back once the new tree is attached.
  const hadFocus = document.activeElement === input;
  const caret = hadFocus ? [input.selectionStart, input.selectionEnd] : null;
  const send = el('button', {
    class: 'btn btn--sm ag-ch-send', type: 'button',
    disabled: state.busy || !state.ready,
    onclick: () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      ask(v, null, repaint);
      input.focus();
    },
  }, state.busy ? '…' : 'Send');
  input.disabled = !state.ready;

  // Why you cannot type, said once, attached to the thing that is disabled --
  // not floating above the transcript where it reads as a system message.
  const blocked = !state.ready
    ? (state.enabled ? 'loading the model…' : 'the router is off')
    : null;

  const log = el('div', { class: 'ag-ch-log' },
    state.turns.length
      ? state.turns.map((t) => turnBlock(t, repaint))
      : el('div', { class: 'ag-ch-empty' },
          el('b', {}, blocked ? 'not ready' : 'ask it something'),
          el('p', { class: 'meta' }, blocked
            ? (state.enabled
                ? 'The language model is loading. This takes about 40 seconds the first time.'
                : 'Turn the router on with the switch above, then ask away.')
            : '"how is loq doing" · "whats the weather in cairo" · '
              + '"what can you do" · "is couchdb up"')));

  // A conversation reads downward, so the newest line sits at the bottom and
  // the view follows it.
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
    if (hadFocus && !input.disabled) {
      input.focus({ preventScroll: true });
      if (caret) { try { input.setSelectionRange(caret[0], caret[1]); } catch { /* not selectable */ } }
    }
  });

  const chat = state.chat;
  return el('section', { class: 'panel stack ag-ch' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Chat'),
      el('span', { class: 'ag-rt-head-side' },
        chat ? el('span', { class: 'meta' },
          `${chat.model}${chat.loaded ? '' : (warmed ? ' · warming' : ' · cold')}`) : null,
        state.turns.length ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onclick: () => resetChat(repaint),
        }, 'Clear') : null)),
    log,
    el('div', { class: 'ag-ch-composer' },
      el('div', { class: 'ag-ch-row' }, input, send),
      blocked ? el('span', { class: 'ag-ch-blocked meta' }, blocked) : null));
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
