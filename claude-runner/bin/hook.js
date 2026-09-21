#!/usr/bin/env node
/**
 * Claude Code hook → the runner.
 *
 * Claude Code runs this on SessionStart, UserPromptSubmit, Stop, Notification,
 * SessionEnd and around AskUserQuestion, with the event as JSON on stdin. It
 * forwards the event over the runner's Unix socket and gets out of the way:
 * a hook that hangs stalls the session it belongs to, so this gives up after
 * 1.5s and ALWAYS exits 0 — a runner that is down (mid-deploy) must never
 * block or fail a turn.
 */
const http = require('http');

const sock = process.env.OJEE_CLAUDE_HOOK_SOCK;
const done = () => process.exit(0);
setTimeout(done, 2500).unref();
if (!sock) done();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(raw || '{}'); } catch { /* forward what we can */ }
  evt.ojee_session = process.env.OJEE_CLAUDE_SESSION || null;
  const body = JSON.stringify(evt);
  const req = http.request({
    socketPath: sock,
    path: '/hook',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: 1500,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
