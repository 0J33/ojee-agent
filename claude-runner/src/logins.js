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
  if (!(await tmux.has(n))) return { running: false };
  const screen = await tmux.capture(n, { join: true, history: 200 });
  const url = (screen.match(/https:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com|platform\.claude\.com)\/\S+/g) || []).pop() || null;
  return {
    running: true,
    url,
    wantsCode: /paste (?:the )?code|code here|authorization code/i.test(screen),
    finished: /Login finished|Login successful|logged in as/i.test(screen),
    failed: /Login exited with code|error|failed/i.test(screen) && !/Login finished/i.test(screen),
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
