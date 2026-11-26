/* ============================================================
   The Claude terminal: xterm.js over the runner's WebSocket,
   which is `tmux attach` to the session's real terminal.

   Same wire protocol as ojee-remote's Shell (binary bytes both
   ways, JSON {t:'resize'} up and {t:'status'} down), plus
   {t:'ping'}/{t:'pong'} for a heartbeat. Closing it detaches; the
   session keeps running.

   It stays connected by itself: a dropped or stalled socket is
   re-attached with backoff, and at once when the network comes
   back, the tab becomes visible again or the computer wakes.
   ============================================================ */

import { h, icon, copyText } from './dom.js';

/** Waits between reconnect attempts, then the last one repeats. ±20% jitter. */
const BACKOFF = [500, 1000, 2000, 5000, 10000];
/** Heartbeat: a ping this often while connected... */
const PING_EVERY = 15_000;
/** ...and the socket counts as stalled when nothing comes back in this long. */
const PONG_WAIT = 8_000;
/** A socket that has not opened in this long is given up and retried. */
const OPEN_WAIT = 10_000;
/** After this many failed attempts in a row, "Reconnecting" becomes "Disconnected" (it still retries). */
const QUIET_AFTER = 5;
/** Input typed while disconnected, kept and sent once attached again (bytes). */
const PENDING_MAX = 8192;

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
    background: v('--term', '#080808'),
    foreground: v('--term-fg', '#d8d8dc'),
    cursor: '#2fd8ee',
    cursorAccent: v('--term', '#080808'),
    selectionBackground: 'rgba(47,216,238,0.28)',
  };
}

/**
 * What a phone keyboard cannot send, in the order a thumb reaches for them.
 * Each: [label, bytes for the terminal, tmux key name for the runner, title].
 * Esc is Claude Code's "stop"; Shift+Tab cycles permission modes; Ctrl+O
 * opens the detail view.
 */
export const KEYS = [
  ['Esc', '\x1b', 'Escape', 'Esc: stop the turn, close a menu'],
  ['Tab', '\t', 'Tab', 'Tab: complete'],
  ['⇧Tab', '\x1b[Z', 'BTab', 'Shift+Tab: switch permission mode'],
  ['↑', '\x1b[A', 'Up', 'Up: previous option, or the last message'],
  ['↓', '\x1b[B', 'Down', 'Down: next option'],
  ['←', '\x1b[D', 'Left', 'Left'],
  ['→', '\x1b[C', 'Right', 'Right'],
  ['⏎', '\r', 'Enter', 'Enter: pick, confirm, send'],
  ['^C', '\x03', 'C-c', 'Ctrl+C: clear the input (twice quickly exits Claude)'],
  ['1', '1', '1', 'Option 1'], ['2', '2', '2', 'Option 2'], ['3', '3', '3', 'Option 3'],
  ['y', 'y', 'y', 'y'], ['n', 'n', 'n', 'n'],
  ['/', '/', '/', 'Slash: commands'],
  ['^O', '\x0f', 'C-o', 'Ctrl+O: detail view (thinking, full output)'],
  ['⇧⏎', '\n', 'C-j', 'A new line in the input, without sending'],
  ['PgUp', '\x1b[5~', 'PPage', 'Page up'], ['PgDn', '\x1b[6~', 'NPage', 'Page down'],
];

/**
 * The key row. Keys never take focus (pointerdown is cancelled), so a phone
 * keyboard that is up stays up and the key goes where typing was.
 * @param {(key: string[]) => void} onKey  [label, bytes, tmuxName, title]
 * @param {object} [o] keyboard: () => void puts a "show keyboard" key first
 */
export function keyRow(onKey, { keyboard = null } = {}) {
  const row = h('div', { class: 'keys cl-keys', role: 'toolbar', 'aria-label': 'Special keys' },
    keyboard ? h('button', { class: 'key cl-kb', type: 'button', title: 'Keyboard', 'aria-label': 'Show the keyboard', dataset: { kb: '1' } }, icon('keyboard', 's')) : null,
    KEYS.map((k, i) => h('button', { class: `key${k[0].length > 2 ? ' wide' : ''}`, type: 'button', title: k[3], 'aria-label': k[3], dataset: { key: String(i) } }, k[0])));
  const keep = (e) => { if (e.target.closest('.key')) e.preventDefault(); };
  row.addEventListener('pointerdown', keep);
  row.addEventListener('mousedown', keep);
  row.addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    if (b.dataset.kb) { keyboard?.(); return; }
    const k = KEYS[Number(b.dataset.key)];
    if (k) onKey(k);
  });
  return row;
}

/* ── links ─────────────────────────────────────────────────────────────── */

const URL_RE = /https?:\/\/[^\s<>"'`│┃]+/g;
const URL_CH = /[^\s<>"'`│┃]/;
/** A URL without the punctuation a sentence put after it. Balanced ) stays. */
function trimUrl(u) {
  let t = u;
  for (;;) {
    const last = t.slice(-1);
    if (/[.,;:!?'"\]]/.test(last)) { t = t.slice(0, -1); continue; }
    if (last === ')' && (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length) { t = t.slice(0, -1); continue; }
    return t;
  }
}

/**
 * The URLs on a buffer line, with their cell ranges. A URL Claude printed
 * wider than the terminal comes back over several rows; a row that is full
 * to the edge and ends in a URL character continues on the next one.
 */
function linksAt(term, y) {
  const buf = term.buffer.active;
  const text = (i) => buf.getLine(i)?.translateToString(true) ?? '';
  const full = (i) => { const t = text(i); return t.length >= term.cols - 1 && URL_CH.test(t.slice(-1)); };
  // Row i carries on row i - 1: xterm says so, or row i - 1 is full to the
  // edge and row i starts (after an indent) with more of it.
  const continues = (i) => {
    const line = buf.getLine(i);
    if (!line) return false;
    if (line.isWrapped) return true;
    const t = text(i);
    return full(i - 1) && /^\s{0,4}[^\s│┃]/.test(t) && !/^\s*https?:\/\//.test(t);
  };
  let a = y;
  while (a > 0 && y - a < 6 && continues(a)) a--;
  let b = y;
  while (b < buf.length - 1 && b - y < 6 && continues(b + 1)) b++;
  // The joined text, and where each of its characters sits on screen.
  let joined = '';
  const map = [];
  for (let i = a; i <= b; i++) {
    let t = text(i);
    let x0 = 0;
    if (i > a && !buf.getLine(i)?.isWrapped) { const lead = t.length - t.trimStart().length; t = t.slice(lead); x0 = lead; }
    for (let k = 0; k < t.length; k++) map.push([x0 + k, i]);
    joined += t;
  }
  const out = [];
  for (const m of joined.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length < 10) continue;
    const s = map[m.index];
    const e = map[m.index + url.length - 1];
    if (!s || !e || e[1] < y || s[1] > y) continue;
    out.push({ url, start: { x: s[0] + 1, y: s[1] + 1 }, end: { x: e[0] + 1, y: e[1] + 1 } });
  }
  return out;
}

const openUrl = (url) => { try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* blocked */ } };

/** Finger travel, in rows, per wheel tick sent. tmux and Claude move a few
 *  lines per tick, so one per row would outrun the finger. */
const TOUCH_STEP_ROWS = 2;

/**
 * Drag to scroll on a touchscreen. tmux keeps the mouse on (Claude's
 * fullscreen view wants it too), and xterm ignores touch while an app has
 * the mouse - so on a phone a drag did nothing. This turns the drag, and
 * the fling after it, into the wheel ticks a mouse would send, dispatched
 * through xterm so they are encoded the way the app asked for.
 */
function touchScroll(el, term) {
  const screen = el.querySelector('.xterm-screen') || el;
  const active = () => term.modes.mouseTrackingMode !== 'none';
  const step = () => ((screen.clientHeight / term.rows) || 16) * TOUCH_STEP_ROWS;
  let at = null;     // the finger: start y, last x/y/time
  let dragging = false;
  let acc = 0;       // travel not yet sent as a tick
  let v = 0;         // px/ms, for the fling
  let raf = 0;

  const feed = (dy) => {
    acc += dy;
    const s = step();
    while (Math.abs(acc) >= s) {
      const dir = Math.sign(acc);
      acc -= dir * s;
      screen.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir, deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: at.x, clientY: at.y, bubbles: true, cancelable: true,
      }));
    }
  };
  const fling = () => {
    let prev = performance.now();
    const frame = (now) => {
      const dt = Math.min(64, now - prev);
      prev = now;
      feed(v * dt);
      v *= Math.pow(0.95, dt / 16);
      raf = Math.abs(v) > 0.03 ? requestAnimationFrame(frame) : 0;
    };
    raf = requestAnimationFrame(frame);
  };

  el.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(raf);
    v = 0;
    if (e.touches.length !== 1 || !active()) { at = null; return; }
    const t = e.touches[0];
    at = { y0: t.clientY, x: t.clientX, y: t.clientY, t: e.timeStamp };
    dragging = false;
    acc = 0;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!at || e.touches.length !== 1) return;
    const t = e.touches[0];
    // Under the slop a touch is still a tap (a click for Claude).
    if (!dragging && Math.abs(t.clientY - at.y0) < 8) return;
    dragging = true;
    e.preventDefault();
    const dy = at.y - t.clientY;
    v = 0.7 * (dy / Math.max(1, e.timeStamp - at.t)) + 0.3 * v;
    Object.assign(at, { x: t.clientX, y: t.clientY, t: e.timeStamp });
    feed(dy);
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    if (!at || !dragging) { at = null; return; }
    // A finger held still before lifting is not a fling.
    if (e.timeStamp - at.t > 80) v = 0;
    if (Math.abs(v) > 0.2) fling();
  }, { passive: true });
  el.addEventListener('touchcancel', () => { at = null; v = 0; }, { passive: true });
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {object} o.ctx       module context
 * @param {string} o.path      runner path under /api/claude, e.g. /sessions/<id>/terminal
 * @param {Function} [o.onState]  (state, detail) for the caller's status line
 * @param {Function} [o.onImage]  (File) for an image pasted or dropped on it
 * @param {Function} [o.onPick]   () a long press on a touch screen: open the
 *                                caller's select-to-copy sheet
 * @param {Function} [o.onCopied] (ok, text) after a copy, for a toast
 * @param {boolean}  [o.keys]     show the key row at the start
 */
export function startTerminal({ host, ctx, path, onState, onImage, onPick, onCopied, keys: keysOn = false, statusInHead = false }) {
  host.replaceChildren();
  // Input: straight to the socket when it is attached; otherwise kept (what a
  // person typed, not what xterm answers on its own: mouse reports, focus
  // in/out) and sent once it is attached again.
  let pending = '';
  const send = (seq) => {
    if (ws?.readyState === WebSocket.OPEN && state === 'connected') { ws.send(new TextEncoder().encode(seq)); return; }
    const typed = seq.replace(/\x1b\[<[\d;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]/g, '');
    if (typed && state !== 'ended') pending = (pending + typed).slice(-PENDING_MAX);
  };
  const termEl = document.createElement('div');
  termEl.className = 'cl-xterm';
  // xterm lives in a box with no padding of its own: the fit measures this
  // box, so the padding around it is never counted as room for a row.
  const box = document.createElement('div');
  box.className = 'cl-xterm-box';
  termEl.appendChild(box);
  const keys = keyRow((k) => { send(k[1]); }, { keyboard: () => term?.focus() });
  keys.hidden = !keysOn;
  // A copy that could not go to the clipboard by itself (no click to ride
  // on): one tap here finishes it.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'cl-copychip';
  chip.hidden = true;
  termEl.appendChild(chip);
  // Not attached: a line saying so, with a Reconnect button. In the caller's
  // header when it has one (statusInHead), over the terminal otherwise.
  const statusTx = h('span', { class: 'tx' });
  const statusBtn = h('button', { class: 'btn sm', type: 'button', title: 'Reconnect the terminal now' }, icon('refresh', 's'), h('span', { class: 'lbl' }, 'Reconnect'));
  const statusEl = h('div', { class: `cl-tstat${statusInHead ? '' : ' over'}`, role: 'status', 'aria-live': 'polite', hidden: true }, h('span', { class: 'dot' }), statusTx, statusBtn);
  statusBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  statusBtn.addEventListener('click', (e) => { e.stopPropagation(); reconnectNow('manual'); term?.focus(); });
  if (!statusInHead) termEl.appendChild(statusEl);
  host.append(termEl, keys);
  // Keys typed in the terminal are the terminal's. xterm has already handled
  // them by the time they bubble here; stopping them keeps the console's own
  // shortcuts (/ and Ctrl+K open its jump menu) from firing on top.
  termEl.addEventListener('keydown', (e) => e.stopPropagation());

  // Images pasted or dropped here go to the session as files (the caller
  // uploads them); Claude Code's own Ctrl+V reads the HOST's clipboard,
  // which is not this computer's. Text is left to xterm, which pastes it.
  // Capture phase: this runs before xterm's own paste handling.
  const imageFrom = (list) => [...(list || [])].find((f) => f && f.type && f.type.startsWith('image/'));
  termEl.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item || !onImage) return;
    e.preventDefault();
    e.stopPropagation();
    onImage(item.getAsFile());
  }, true);
  termEl.addEventListener('dragover', (e) => { if (onImage && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  termEl.addEventListener('drop', (e) => {
    const f = imageFrom(e.dataTransfer?.files);
    if (!f || !onImage) return;
    e.preventDefault();
    onImage(f);
  });

  let term = null;
  let fit = null;
  let ws = null;
  let ro = null;
  let disposed = false;
  let state = 'connecting';
  let everReady = false;   // attached at least once: a later attach redraws from clean
  let attempt = 0;         // failed attempts in a row
  let retryTimer = 0;
  let openTimer = 0;
  let pingTimer = 0;
  let pongTimer = 0;
  let pingN = 0;
  let pongs = false;       // the runner answers pings (older runners do not)
  let lastBeat = Date.now();
  let hiddenAt = 0;
  let endedCheck = false;  // tmux attach exited: one look whether the session is gone
  // The last thing selected: xterm's own selection, or what tmux or Claude
  // sent with OSC 52 when a drag ended. Kept so Copy and Ctrl+Shift+C can
  // put it on the clipboard from inside a key press or a click.
  let lastCopy = { text: '', at: 0 };
  let chipTimer = 0;

  const set = (s, detail) => {
    state = s;
    paintStatus(detail);
    onState?.(s, detail);
  };
  function paintStatus(detail) {
    const words = {
      reconnecting: 'Reconnecting…',
      offline: 'Offline — waiting for the network',
      disconnected: 'Disconnected',
      ended: 'Session ended',
      error: detail && typeof detail === 'string' ? detail : 'Could not reach the terminal',
    };
    const text = words[state];
    statusEl.hidden = !text;
    statusEl.dataset.state = state;
    if (text) { statusTx.textContent = text; statusEl.title = text; }
  }

  const flash = (label, offer) => {
    clearTimeout(chipTimer);
    chip.textContent = label;
    chip.classList.toggle('is-offer', !!offer);
    chip.hidden = false;
    chipTimer = setTimeout(() => { chip.hidden = true; }, offer ? 8000 : 1400);
  };
  /** Copy now if the browser lets us; otherwise offer the one-tap chip. */
  const remember = async (text, { gesture = false } = {}) => {
    if (!text) return false;
    lastCopy = { text, at: Date.now() };
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok && gesture) ok = await copyText(text);
    if (ok) flash('Copied');
    else flash('Copy selection', true);
    onCopied?.(ok, text);
    return ok;
  };
  chip.addEventListener('pointerdown', (e) => e.preventDefault());
  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!chip.classList.contains('is-offer')) { chip.hidden = true; return; }
    const ok = await copyText(lastCopy.text);
    flash(ok ? 'Copied' : 'Copy failed');
    onCopied?.(ok, lastCopy.text);
    term?.focus();
  });

  /* ── size ─────────────────────────────────────────────────────── */

  // Whole rows only: rows = floor(the box's height / a cell's height), the
  // remainder left empty under the last row. Refit when the box changes size
  // (pane switch, key row, panel animating, the phone keyboard), when the
  // webfont arrives, and when the visual viewport moves. One frame, then a
  // short settle, so an animation does not resize tmux on every frame.
  let sent = '';
  const sendSize = (force = false) => {
    if (!term || ws?.readyState !== WebSocket.OPEN) return;
    const sig = `${term.cols}x${term.rows}`;
    if (!force && sig === sent) return;
    sent = sig;
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  const fitNow = () => {
    if (!term || !fit || disposed) return;
    if (!box.isConnected || box.clientHeight < 1 || box.clientWidth < 1) return; // hidden: keep the last size
    let d;
    try { d = fit.proposeDimensions(); } catch { return; }
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
    const cols = Math.max(20, d.cols);
    const rows = Math.max(5, d.rows);
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    sendSize();
  };
  let fitRaf = 0;
  let fitTimer = 0;
  const refit = () => {
    if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitNow(); });
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitNow, 120);
  };
  // A webfont that arrives after xterm measured its cells changes their
  // size, and xterm does not look again by itself: nudge the font option
  // (same family, a space more or less) so it re-measures, then refit.
  const remeasure = () => {
    if (!term) return;
    const f = term.options.fontFamily || '';
    term.options.fontFamily = f.endsWith(' ') ? f.trimEnd() : `${f} `;
    refit();
  };

  /* ── connection ───────────────────────────────────────────────── */

  const clearTimers = () => {
    clearTimeout(retryTimer); retryTimer = 0;
    clearTimeout(openTimer); openTimer = 0;
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(pongTimer); pongTimer = 0;
  };
  /** Drop the socket without its handlers firing (a stalled one may never close). */
  const drop = () => {
    const old = ws;
    ws = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch { /* gone */ }
  };
  const ping = (wait = PONG_WAIT) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ t: 'ping', n: ++pingN })); } catch { return; }
    // Only a runner that has answered before is held to it; an older one
    // never answers, and its quiet is not a stall.
    if (pongs && !pongTimer) pongTimer = setTimeout(() => { pongTimer = 0; lost('stalled'); }, wait);
  };

  function connect() {
    if (disposed || !term) return;
    clearTimers();
    drop();
    // Offline: wait for 'online', but look again now and then in case the
    // browser's idea of the network is wrong.
    if (navigator.onLine === false) { set('offline'); retryTimer = setTimeout(connect, BACKOFF[BACKOFF.length - 1]); return; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${ctx.base}/api/claude${path}?cols=${term.cols}&rows=${term.rows}`;
    if (!everReady) set('connecting');
    let sock;
    try { sock = new WebSocket(url); } catch { lost('refused'); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    openTimer = setTimeout(() => { if (ws === sock) lost('timeout'); }, OPEN_WAIT);
    sock.onopen = () => {
      clearTimeout(openTimer); openTimer = 0;
      sent = '';
      sendSize(true);
      pingTimer = setInterval(() => ping(), PING_EVERY);
      ping();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      // Anything arriving proves the socket is alive.
      clearTimeout(pongTimer); pongTimer = 0;
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') { pongs = true; return; }
        if (msg.t !== 'status') return;
        if (msg.state === 'ready') {
          // A re-attach: tmux redraws the whole screen, so start from a clean
          // one instead of drawing it over (or under) the old.
          if (everReady) term.reset();
          everReady = true;
          attempt = 0;
          endedCheck = false;
          set('connected');
          fitNow();
          if (pending) { const p = pending; pending = ''; send(p); }
        } else if (msg.state === 'closed') {
          // tmux attach exited: the session ended, or the runner is stopping.
          // One more attach settles which; it is not retried after that.
          endedCheck = true;
        } else if (msg.state === 'error') {
          const gone = /no running terminal/i.test(msg.detail || '');
          finish(gone ? 'ended' : 'error', msg.detail || 'connection failed');
        } else set(msg.state, msg.detail);
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    sock.onclose = () => { if (ws === sock) lost('closed'); };
    sock.onerror = () => { if (ws === sock) lost('error'); };
  }

  /** Stopped for good (the session ended, or the runner refused): no retries. */
  function finish(s, detail) {
    clearTimers();
    drop();
    pending = '';
    set(s, detail);
  }

  /** The socket is gone or stuck: try again, sooner at first, then every 10 s. */
  function lost(why) {
    if (disposed || state === 'ended' || state === 'error') return;
    clearTimers();
    drop();
    if (endedCheck && why === 'closed' && attempt > 0) { finish('ended'); return; }
    if (navigator.onLine === false) { set('offline'); retryTimer = setTimeout(connect, BACKOFF[BACKOFF.length - 1]); return; }
    // A hidden tab waits: it reconnects the moment it is visible again.
    const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] * (0.8 + Math.random() * 0.4);
    attempt++;
    // After tmux said it closed, the one look is quiet: no "Reconnecting"
    // flash when the session simply ended.
    if (endedCheck && attempt === 1) set('checking', { why, attempt, in: Math.round(wait) });
    else set(attempt > QUIET_AFTER ? 'disconnected' : 'reconnecting', { why, attempt, in: Math.round(wait) });
    if (document.visibilityState === 'hidden') return;
    retryTimer = setTimeout(connect, wait);
  }

  /** Now, not after the backoff: a click, the network back, the tab shown, a wake. */
  function reconnectNow(why) {
    if (disposed || !term) return;
    if (why !== 'manual' && (state === 'ended' || state === 'error')) return;
    if (why === 'manual') { attempt = 0; endedCheck = false; if (state === 'ended' || state === 'error') set('reconnecting'); }
    connect();
  }

  // When to look again without waiting.
  const onOnline = () => { if (state !== 'connected') reconnectNow('online'); else ping(4000); };
  const onOffline = () => { if (state !== 'connected') set('offline'); else ping(3000); };
  const onShown = () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    awake(away);
  };
  /** Back from hidden or asleep: a socket that is not open is replaced now;
   *  an open one is asked for a pong, or (a runner that never answers) is
   *  replaced when it was away long enough to have been dropped. */
  function awake(away) {
    if (state === 'ended' || state === 'error' || disposed) return;
    if (ws?.readyState !== WebSocket.OPEN || state !== 'connected') { reconnectNow('visible'); return; }
    if (pongs) ping(4000);
    else if (away > 60_000) reconnectNow('wake');
    refit();
  }
  const onPageShow = (e) => { if (e.persisted) reconnectNow('pageshow'); else awake(0); };
  const onFocus = () => awake(Date.now() - lastBeat > 30_000 ? Date.now() - lastBeat : 0);
  // A timer that fires far later than asked means the computer slept.
  const beat = setInterval(() => {
    const gap = Date.now() - lastBeat;
    lastBeat = Date.now();
    if (gap > 30_000) awake(gap);
  }, 5000);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onShown);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('focus', onFocus);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', refit);
  window.addEventListener('resize', refit);
  const onFonts = () => remeasure();
  document.fonts?.addEventListener?.('loadingdone', onFonts);

  /** The cell under a point on the screen, as a 0-based buffer row and column. */
  const cellAt = (x, y) => {
    const screen = termEl.querySelector('.xterm-screen');
    if (!screen || !term) return null;
    const r = screen.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const col = Math.floor((x - r.left) / (r.width / term.cols));
    const row = Math.floor((y - r.top) / (r.height / term.rows));
    return { col, y: term.buffer.active.viewportY + row };
  };
  const linkAt = (x, y) => {
    const c = cellAt(x, y);
    if (!c) return null;
    return linksAt(term, c.y).find((l) => {
      const p = [c.y + 1, c.col + 1];
      const after = (a, b) => a[0] > b.y || (a[0] === b.y && a[1] >= b.x);
      const before = (a, b) => a[0] < b.y || (a[0] === b.y && a[1] <= b.x);
      return after(p, l.start) && before(p, l.end);
    }) || null;
  };

  (async () => {
    try { await loadXterm(ctx.base); } catch (e) {
      set('error', e.message);
      return;
    }
    if (disposed) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    const fontSize = window.matchMedia('(max-width: 560px)').matches ? 11.5 : 13;
    // The webfont first (briefly): cells measured on the fallback font are
    // the wrong height once it swaps in, and the last row ends up clipped.
    try {
      await Promise.race([
        Promise.all([document.fonts?.load?.(`${fontSize}px ${mono || 'monospace'}`), document.fonts?.load?.(`bold ${fontSize}px ${mono || 'monospace'}`)]),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch { /* no font loading API */ }
    if (disposed) return;
    term = new window.Terminal({
      fontFamily: mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      // Shift+drag (Option+drag on a Mac) selects in xterm even while an app
      // has the mouse.
      macOptionClickForcesSelection: true,
      theme: themeFromCss(),
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);

    // OSC 52: what a drag selected in tmux (or in Claude's fullscreen view)
    // arrives here as base64 once the mouse is let go. Written to this
    // computer's clipboard; when the browser refuses a write that no click
    // carried, the chip offers it for one tap.
    term.parser.registerOscHandler(52, (data) => {
      const at = data.indexOf(';');
      const b64 = at >= 0 ? data.slice(at + 1) : data;
      if (!b64 || b64 === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        remember(new TextDecoder().decode(bytes));
      } catch { /* not base64: ignore */ }
      return true;
    });
    const copySelection = (gesture) => {
      const t = term.getSelection();
      if (t) remember(t, { gesture });
      return !!t;
    };
    term.onSelectionChange(() => { if (term.hasSelection()) copySelection(false); });

    // Links: underlined under the pointer and opened in a new tab on click
    // or tap. The provider is xterm's hover and click; the click handler
    // below is the same lookup for when the app has the mouse (tmux does)
    // and xterm hands the click to it instead.
    let openedAt = 0;
    term.registerLinkProvider({
      provideLinks(line, cb) {
        const links = linksAt(term, line - 1).map((l) => ({
          range: { start: l.start, end: l.end },
          text: l.url,
          decorations: { underline: true, pointerCursor: true },
          activate: (ev, url) => { if (ev?.button === 0 || ev?.button == null) { openedAt = Date.now(); openUrl(url); } },
        }));
        cb(links.length ? links : undefined);
      },
    });
    let down = null;
    termEl.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; }, true);
    termEl.addEventListener('click', (e) => {
      if (e.target.closest('.cl-copychip')) return;
      if (pressed) { pressed = false; return; }
      // A drag (a selection) is not a click on a link.
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      if (Date.now() - openedAt < 500) return;
      if (term.hasSelection()) return;
      const l = linkAt(e.clientX, e.clientY);
      if (l) { openedAt = Date.now(); openUrl(l.url); }
    }, true);

    // The keys people expect from a desktop app, on top of a terminal.
    // Checked against Claude Code 2.1.278 in tmux: with its own selection,
    // Ctrl+C copies; without one, it clears the input (twice quickly exits).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      // Paste: Ctrl+V, Ctrl+Shift+V, Cmd+V, from THIS computer's clipboard.
      // The browser pastes (xterm makes it a bracketed paste; images are
      // caught above) instead of Claude getting a Ctrl+V, which would read
      // the host's clipboard.
      if (mod && !e.altKey && k === 'v') return false;
      // Ctrl+Shift+C (Cmd+Shift+C): copy the selection, or the last thing a
      // drag selected; never reaches Claude, nor Chrome's inspect shortcut.
      if (mod && e.shiftKey && k === 'c') {
        e.preventDefault();
        if (!copySelection(true) && lastCopy.text) remember(lastCopy.text, { gesture: true });
        return false;
      }
      // Ctrl+C / Cmd+C: copy an xterm selection if there is one; otherwise
      // it is Claude's (its own selection, or clear the input).
      if (mod && !e.shiftKey && k === 'c' && term.hasSelection()) { e.preventDefault(); copySelection(true); term.clearSelection(); return false; }
      // Shift+Enter: a new line in the prompt, not a submit. xterm sends a
      // plain Enter for it; Claude Code takes Ctrl+J (LF) as a new line.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        send('\n');
        return false;
      }
      return true;
    });
    term.open(box);
    touchScroll(termEl, term);
    fitNow();
    term.onData((d) => send(d));
    ro = new ResizeObserver(refit);
    ro.observe(box);
    document.fonts?.ready?.then(() => { if (!disposed) remeasure(); });
    connect();
  })();

  // A long press on a touch screen: the select-to-copy sheet, where the
  // phone's own selection handles work. A drag cancels it; so does lifting.
  let pressTimer = 0;
  let pressed = false;
  let pressAt = null;
  termEl.addEventListener('touchstart', (e) => {
    clearTimeout(pressTimer);
    if (e.touches.length !== 1 || !onPick) return;
    const t = e.touches[0];
    pressAt = { x: t.clientX, y: t.clientY };
    pressTimer = setTimeout(() => {
      pressed = true;
      try { navigator.vibrate?.(12); } catch { /* none */ }
      onPick();
    }, 550);
  }, { passive: true });
  termEl.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (pressAt && t && Math.hypot(t.clientX - pressAt.x, t.clientY - pressAt.y) > 8) clearTimeout(pressTimer);
  }, { passive: true });
  const endPress = () => { clearTimeout(pressTimer); pressAt = null; setTimeout(() => { pressed = false; }, 400); };
  termEl.addEventListener('touchend', endPress, { passive: true });
  termEl.addEventListener('touchcancel', endPress, { passive: true });
  termEl.addEventListener('contextmenu', (e) => { if (pressed) e.preventDefault(); });

  return {
    teardown() {
      disposed = true;
      clearTimeout(chipTimer);
      clearTimeout(pressTimer);
      try { ro?.disconnect(); } catch { /* never observed */ }
      clearTimers();
      clearInterval(beat);
      clearTimeout(fitTimer);
      cancelAnimationFrame(fitRaf);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onShown);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      vv?.removeEventListener('resize', refit);
      window.removeEventListener('resize', refit);
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      statusEl.remove();
      drop();
      // xterm queues its viewport sync for the next frame; disposed before
      // that frame (a quick Terminal to Transcript), the sync throws on the
      // renderer it just released. Two frames later the queue has drained.
      const t = term;
      if (t) requestAnimationFrame(() => requestAnimationFrame(() => { try { t.dispose(); } catch { /* never opened */ } }));
      ws = null; term = null; fit = null;
    },
    focus() { term?.focus(); },
    keysShown() { return !keys.hidden; },
    toggleKeys(on = keys.hidden) { keys.hidden = !on; refit(); return on; },
    /** Not attached: the status line with its Reconnect button (for statusInHead). */
    statusEl,
    state: () => state,
    /** Copy the selection, or what was last selected. False when there is neither. */
    async copy() {
      const t = term?.getSelection() || (Date.now() - lastCopy.at < 120000 ? lastCopy.text : '');
      if (!t) return false;
      const ok = await copyText(t);
      flash(ok ? 'Copied' : 'Copy failed');
      return ok;
    },
    /** What the terminal holds, as text: its scrollback and screen. */
    bufferText() {
      if (!term) return '';
      const b = term.buffer.active;
      const out = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out.join('\n');
    },
    reconnect() { reconnectNow('manual'); },
  };
}
