/* ============================================================
   The Claude terminal: xterm.js over the runner's WebSocket,
   which is `tmux attach` to the session's real terminal.

   Deliberately the same as ojee-remote's Shell view — same wire
   protocol (binary bytes both ways, JSON {t:'resize'} up and
   {t:'status'} down), same key row for phones, same xterm build
   loaded from /vendor as classic scripts — so a terminal in the
   console behaves one way whichever module it is in.

   Closing it detaches. The session keeps running.
   ============================================================ */

let loading = null;

function loadXterm(base) {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (loading) return loading;
  if (!document.getElementById('xterm-css')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.id = 'xterm-css';
    css.href = `${base}/vendor/xterm.css`;
    document.head.appendChild(css);
  }
  const script = (src) => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
  loading = script(`${base}/vendor/xterm.js`)
    .then(() => script(`${base}/vendor/addon-fit.js`))
    .catch((e) => { loading = null; throw e; });
  return loading;
}

function themeFromCss() {
  const v = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
  return {
    background: v('--bg-0', '#0b0d10'),
    foreground: v('--ink', '#e6e8ea'),
    cursor: v('--accent', '#7cc4ff'),
    cursorAccent: v('--bg-0', '#0b0d10'),
    selectionBackground: v('--accent-08', 'rgba(124,196,255,0.22)'),
  };
}

/** Only what a touchscreen cannot send. Esc is Claude Code's "stop". */
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['Enter', '\r'], ['^C', '\x03'],
  ['S-Tab', '\x1b[Z'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
];

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {object} o.ctx       module context
 * @param {string} o.path      runner path under /api/claude, e.g. /sessions/<id>/terminal
 * @param {Function} [o.onState]  (state, detail) for the caller's status line
 * @returns {{ teardown: Function, focus: Function, reconnect: Function }}
 */
export function startTerminal({ host, ctx, path, onState }) {
  host.replaceChildren();
  const keys = document.createElement('div');
  keys.className = 'ag-cl-keys';
  keys.hidden = true;
  KEYS.forEach(([label], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost btn--sm';
    b.dataset.key = String(i);
    b.textContent = label;
    keys.appendChild(b);
  });
  const termEl = document.createElement('div');
  termEl.className = 'ag-cl-term';
  host.append(keys, termEl);

  let term = null;
  let fit = null;
  let ws = null;
  let ro = null;
  let disposed = false;
  let state = 'connecting';

  const set = (s, detail) => { state = s; onState?.(s, detail); };

  const sendSize = () => {
    if (!term || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${ctx.base}/api/claude${path}?cols=${term.cols}&rows=${term.rows}`;
    set('connecting');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => sendSize();
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t !== 'status') return;
        if (msg.state === 'ready') { set('connected'); }
        else if (msg.state === 'error') {
          set('error', msg.detail);
          term.writeln(`\r\n\x1b[31m${msg.detail || 'connection failed'}\x1b[0m`);
        } else set(msg.state, msg.detail);
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (disposed) return;
      if (state !== 'closed' && state !== 'error') {
        set('disconnected');
        term.writeln('\r\n\x1b[33mdisconnected — press Reconnect\x1b[0m');
      }
    };
    ws.onerror = () => set('error', 'websocket');
  }

  (async () => {
    try { await loadXterm(ctx.base); } catch (e) {
      set('error', e.message);
      return;
    }
    if (disposed) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
    term = new window.Terminal({
      fontFamily: mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: window.matchMedia('(max-width: 560px)').matches ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromCss(),
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    fit.fit();
    term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d)); });
    ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch { /* not laid out */ } });
    ro.observe(termEl);
    connect();
  })();

  keys.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]');
    if (!k) return;
    const [, seq] = KEYS[Number(k.dataset.key)] || [];
    if (seq && ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(seq));
    term?.focus();
  });

  return {
    teardown() {
      disposed = true;
      try { ro?.disconnect(); } catch { /* never observed */ }
      try { ws?.close(); } catch { /* gone */ }
      try { term?.dispose(); } catch { /* never opened */ }
      ws = null; term = null; fit = null;
    },
    focus() { term?.focus(); },
    toggleKeys() { keys.hidden = !keys.hidden; try { fit?.fit(); } catch { /* */ } },
    reconnect() {
      try { ws?.close(); } catch { /* gone */ }
      term?.reset();
      if (term) connect();
    },
  };
}
