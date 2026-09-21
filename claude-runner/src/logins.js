/**
 * Logging an account in from the browser.
 *
 * It is the ordinary `claude auth login --claudeai` — a subscription login,
 * never the Console/API one — run in its own tmux session with that account's
 * CLAUDE_CONFIG_DIR, so the browser can show it in a terminal like any other
 * session. DISPLAY is removed first: on this box a desktop session is logged
 * in, and without that the login would open a browser on the HP's own screen
 * instead of printing the link.
 *
 * The screen is also read for the sign-in link and the "paste code" prompt,
 * so the Accounts view can offer the link as a button and a box for the code
 * — easier on a phone than selecting text in a terminal.
 */

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const name = (acct) => `login-${acct.id}`;

async function start({ tmux, accounts, config }, acct) {
  const n = name(acct);
  if (await tmux.has(n)) await tmux.kill(n);
  const env = accounts.env(acct);
  const script = [
    'env -u DISPLAY -u WAYLAND_DISPLAY -u BROWSER',
    ...Object.entries(env).map(([k, v]) => `${k}=${q(v)}`),
    q(config.CLAUDE_BIN), 'auth login --claudeai',
  ].join(' ');
  await tmux.create({
    name: n,
    cwd: config.HOME,
    argv: ['/bin/sh', '-c', `${script}; code=$?; echo; if [ $code -eq 0 ]; then echo "Login finished. This window closes in a minute."; else echo "Login exited with code $code."; fi; sleep 60`],
    cols: 120,
    rows: 34,
  });
  return n;
}

async function state({ tmux }, acct) {
  const n = name(acct);
  const pane = (await tmux.list()).find((p) => p.name === n);
  if (!pane) return { running: false };
  const screen = await tmux.capture(n, { join: true, history: 200 });
  const url = (screen.match(/https:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com|platform\.claude\.com)\/\S+/g) || []).pop() || null;
  const failed = /Login failed:?\s*(.*)/i.exec(screen) || (/Login exited with code [1-9]/.test(screen) ? [null, 'the login exited with an error'] : null);
  const finished = !failed && /Login finished|Login successful|logged in as/i.test(screen);
  // The claude process is gone once it prints its verdict; the pane lingers
  // for a minute so the text can be read.
  const done = pane.dead || /Login finished|Login exited with code/.test(screen);
  return {
    running: !done,
    url: done ? null : url,
    wantsCode: !done && /paste (?:the )?code|code here|authorization code/i.test(screen),
    finished,
    failed: !!failed,
    error: failed ? (failed[1] || '').trim().slice(0, 200) || 'login failed' : null,
    screen: screen.trim().split('\n').slice(-14).join('\n'),
  };
}

async function submitCode({ tmux }, acct, code) {
  const n = name(acct);
  if (!(await tmux.has(n))) throw Object.assign(new Error('No login in progress'), { status: 409 });
  await tmux.type(n, String(code).trim());
  await new Promise((r) => setTimeout(r, 150));
  await tmux.keys(n, 'Enter');
}

async function cancel({ tmux }, acct) {
  return tmux.kill(name(acct));
}

module.exports = { start, state, submitCode, cancel, name };
