/* ============================================================
   The Claude terminal: xterm.js over the runner's WebSocket,
   which is `tmux attach` to the session's real terminal.

   Deliberately the same as ojee-remote's Shell view - same wire
   protocol (binary bytes both ways, JSON {t:'resize'} up and
   {t:'status'} down), same key row for phones, same xterm build
   loaded from /vendor as classic scripts - so a terminal in the
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
    background: v('--bg-0', '#000000'),
    foreground: v('--ink', '#ffffff'),
    cursor: v('--accent', '#ffffff'),
    cursorAccent: v('--bg-0', '#000000'),
    // Not --accent-08: on a white accent that is an 8% wash and a selection
    // nobody can see. A fixed grey that reads on the black ground.
    selectionBackground: 'rgba(255,255,255,0.28)',
  };
}

/**
 * What a phone keyboard cannot send, grouped the way they are used. Each key
 * is [label, bytes for the terminal, tmux key name for the runner, title].
 * Esc is Claude Code's "stop"; Shift+Tab cycles its permission modes; Ctrl+O
 * shows the detail view (thinking, full tool output).
 */
export const KEY_GROUPS = [
  ['Stop', [
    ['Esc', '\x1b', 'Escape', 'Esc: stop the turn, close a menu, back out'],
    ['Ctrl+C', '\x03', 'C-c', 'Ctrl+C: clear the input (twice quickly exits Claude)'],
  ]],
  ['Move', [
    ['←', '\x1b[D', 'Left', 'Left'], ['↑', '\x1b[A', 'Up', 'Up: previous option, or the last message'],
    ['↓', '\x1b[B', 'Down', 'Down: next option'], ['→', '\x1b[C', 'Right', 'Right'],
    ['PgUp', '\x1b[5~', 'PPage', 'Page up'], ['PgDn', '\x1b[6~', 'NPage', 'Page down'],
  ]],
  ['Answer', [
    ['Enter', '\r', 'Enter', 'Enter: pick, confirm, send'],
    ['y', 'y', 'y', 'y'], ['n', 'n', 'n', 'n'],
    ['1', '1', '1', 'Option 1'], ['2', '2', '2', 'Option 2'], ['3', '3', '3', 'Option 3'],
  ]],
  ['Mode', [
    ['Tab', '\t', 'Tab', 'Tab: complete'],
    ['⇧Tab', '\x1b[Z', 'BTab', 'Shift+Tab: switch mode (accept edits, plan)'],
    ['Ctrl+O', '\x0f', 'C-o', 'Ctrl+O: detail view (thinking, full output)'],
    ['New line', '\n', 'C-j', 'A new line in the input, without sending'],
  ]],
];

/**
 * The key row: every key one tap away, in groups. Buttons never take focus
 * (pointerdown is cancelled), so a phone keyboard that is up stays up and the
 * key goes where the typing was.
 * @param {(key: string[]) => void} onKey  called with [label, bytes, tmuxName, title]
 */
export function keyStrip(onKey, cls = '') {
  const strip = document.createElement('div');
  strip.className = `ag-cl-keys ${cls}`.trim();
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Special keys');
  KEY_GROUPS.forEach(([name, keys], g) => {
    const group = document.createElement('div');
    group.className = 'ag-cl-kgroup';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    const label = document.createElement('span');
    label.className = 'ag-cl-klabel';
    label.textContent = name;
    group.appendChild(label);
    keys.forEach((k, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ag-cl-key${k[0].length > 2 ? ' ag-cl-key--wide' : ''}`;
      b.dataset.key = `${g}:${i}`;
      b.title = k[3];
      b.setAttribute('aria-label', k[3]);
      b.textContent = k[0];
      group.appendChild(b);
    });
    strip.appendChild(group);
  });
  strip.addEventListener('pointerdown', (e) => { if (e.target.closest('.ag-cl-key')) e.preventDefault(); });
  strip.addEventListener('mousedown', (e) => { if (e.target.closest('.ag-cl-key')) e.preventDefault(); });
  strip.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    const [g, i] = b.dataset.key.split(':').map(Number);
    const k = KEY_GROUPS[g]?.[1]?.[i];
    if (k) onKey(k);
  });
  return strip;
}

/**
 * Text to the clipboard, from inside the click or key that asked for it.
 * The async API first (a secure page); else the old copy command, which
 * works over plain http and in browsers that refuse the async one.
 */
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* refused: try the old way */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  const prev = document.activeElement;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ }
  return ok;
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
export function startTerminal({ host, ctx, path, onState, onImage, onPick, onCopied, keys: keysOn = false }) {
  host.replaceChildren();
  const send = (seq) => { if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(seq)); };
  const keys = keyStrip((k) => send(k[1]), 'ag-cl-keys--term');
  keys.hidden = !keysOn;
  const termEl = document.createElement('div');
  termEl.className = 'ag-cl-term';
  // A copy that could not go to the clipboard by itself (no click to ride
  // on): one tap here finishes it.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ag-cl-copychip';
  chip.hidden = true;
  termEl.appendChild(chip);
  host.append(keys, termEl);
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
  // The last thing selected: xterm's own selection, or what tmux or Claude
  // sent with OSC 52 when a drag ended. Kept so Copy and Ctrl+Shift+C can
  // put it on the clipboard from inside a key press or a click.
  let lastCopy = { text: '', at: 0 };
  let chipTimer = 0;

  const set = (s, detail) => { state = s; onState?.(s, detail); };

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
        term.writeln('\r\n\x1b[33mdisconnected. Press Reconnect\x1b[0m');
      }
    };
    ws.onerror = () => set('error', 'websocket');
  }

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
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
    term = new window.Terminal({
      fontFamily: mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: window.matchMedia('(max-width: 560px)').matches ? 12 : 13,
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
      if (e.target.closest('.ag-cl-copychip')) return;
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
    term.open(termEl);
    touchScroll(termEl, term);
    fit.fit();
    term.onData((d) => send(d));
    ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch { /* not laid out */ } });
    ro.observe(termEl);
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
      try { ws?.close(); } catch { /* gone */ }
      // xterm queues its viewport sync for the next frame; disposed before
      // that frame (a quick Terminal to Transcript), the sync throws on the
      // renderer it just released. Two frames later the queue has drained.
      const t = term;
      if (t) requestAnimationFrame(() => requestAnimationFrame(() => { try { t.dispose(); } catch { /* never opened */ } }));
      ws = null; term = null; fit = null;
    },
    focus() { term?.focus(); },
    keysShown() { return !keys.hidden; },
    toggleKeys(on = keys.hidden) { keys.hidden = !on; try { fit?.fit(); } catch { /* */ } return on; },
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
    reconnect() {
      try { ws?.close(); } catch { /* gone */ }
      term?.reset();
      if (term) connect();
    },
  };
}
