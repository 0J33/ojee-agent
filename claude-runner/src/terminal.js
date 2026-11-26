/**
 * The browser's terminal: a WebSocket bridged to `tmux attach` in a PTY.
 *
 * Same wire protocol as ojee-remote's shell, so the two terminals behave the
 * same way:
 *
 *   binary frames   terminal bytes, both directions, untouched
 *   text frames     JSON control — client {t:'resize',cols,rows},
 *                   {t:'ping',n} (answered {t:'pong',n}, so a browser can
 *                   tell a stalled socket from a quiet one);
 *                   server {t:'status',state,detail}
 *
 * The server pings too (WebSocket ping frames): a viewer that went away
 * without closing (a phone asleep, a dropped network) is cut after a
 * missed pong, which ends its `tmux attach` instead of leaving it behind.
 *
 * Closing the tab detaches; it never stops the session. Several viewers can
 * attach at once (a phone and a laptop); tmux sizes the window to whichever
 * was active last.
 */

const { cleanEnv } = require('./accounts');

const MAX_COLS = 500;
const MAX_ROWS = 300;
/** How often a viewer is pinged; one missed pong and it is gone. */
const PING_MS = 25_000;
const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

let pty = null;
function loadPty() {
  if (pty) return pty;
  // Required lazily: a missing native build should break the terminal, not
  // the whole runner.
  pty = require('node-pty');
  return pty;
}

function status(ws, state, detail) {
  try { ws.send(JSON.stringify({ t: 'status', state, detail: detail || null })); } catch { /* closed */ }
}

/**
 * @param {WebSocket} ws
 * @param {object} o
 * @param {string[]} o.argv   the attach command (from Tmux.attachArgv)
 * @param {number} o.cols
 * @param {number} o.rows
 * @param {string} o.cwd
 */
function bridge(ws, { argv, cols, rows, cwd }) {
  let term;
  try {
    const env = cleanEnv(process.env);
    delete env.TMUX;
    delete env.TMUX_PANE;
    term = loadPty().spawn(argv[0], argv.slice(1), {
      name: 'xterm-256color',
      cols: clamp(cols, 20, MAX_COLS, 120),
      rows: clamp(rows, 5, MAX_ROWS, 32),
      cwd,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env.LANG || 'C.UTF-8' },
    });
  } catch (e) {
    status(ws, 'error', `terminal unavailable: ${e.message}`);
    ws.close();
    return;
  }

  status(ws, 'ready');
  term.onData((d) => { try { ws.send(Buffer.from(d, 'utf8')); } catch { /* closed */ } });
  term.onExit(({ exitCode }) => {
    status(ws, 'closed', exitCode ? `exit ${exitCode}` : null);
    try { ws.close(); } catch { /* already */ }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) { try { term.write(data.toString('utf8')); } catch { /* exited */ } return; }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', n: msg.n ?? null })); } catch { /* closed */ }
      return;
    }
    if (msg.t === 'resize') {
      try { term.resize(clamp(msg.cols, 20, MAX_COLS, 120), clamp(msg.rows, 5, MAX_ROWS, 32)); } catch { /* exited */ }
    }
  });
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch { /* gone */ } return; }
    alive = false;
    try { ws.ping(); } catch { /* closed */ }
  }, PING_MS);
  ping.unref?.();
  ws.on('close', () => { clearInterval(ping); try { term.kill(); } catch { /* already gone */ } });
}

module.exports = { bridge, PING_MS };
