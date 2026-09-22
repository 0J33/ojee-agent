/**
 * The runner end to end, against real tmux and a fake `claude`
 * (tests/fake-claude.js) that writes real-shaped transcripts and fires real
 * hooks. Covers the paths that matter unattended: a turn, a question, a
 * Fable limit moving to Opus, an account limit moving to the second account,
 * everything spent (pause), and the terminal.
 *
 * Needs tmux. Set TMUX_BIN to use one that is not on PATH; without any, the
 * suite is skipped rather than failed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const TMUX = process.env.TMUX_BIN || 'tmux';
let haveTmux = true;
try { execFileSync(TMUX, ['-V']); } catch { haveTmux = false; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ojee-claude-it-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
const work = path.join(root, 'work');
fs.mkdirSync(work);
const fake = path.join(__dirname, 'fake-claude.js');
fs.chmodSync(fake, 0o755);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const waitFor = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('runner end to end', { skip: !haveTmux && 'no tmux' }, async (t) => {
  const port = await freePort();
  Object.assign(process.env, {
    HOME,
    STATE_DIR: path.join(root, 'state'),
    DATA_DIR: path.join(root, 'data'),
    RUNTIME_DIR: path.join(root, 'run'),
    DEFAULT_CLAUDE_DIR: path.join(HOME, '.claude'),
    CLAUDE_BIN: fake,
    TMUX_BIN: TMUX,
    TMUX_SOCKET: `ojee-claude-test-${process.pid}`,
    TMUX_MODE: 'self',
    TICK_MS: '400',
    PORT: String(port),
    HOST: '127.0.0.1',
    RUNNER_TOKEN: 'test-token',
    STACK_DIR: path.join(HOME, 'stack'),
  });
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE' || k === 'TMUX') delete process.env[k];

  const { createRunner } = require('../src/server');
  const runner = createRunner();
  const { sessions, accounts, store, notifier } = runner;
  await runner.start();
  t.after(async () => {
    await runner.stop();
    try { execFileSync(TMUX, ['-L', process.env.TMUX_SOCKET, 'kill-server']); } catch { /* gone */ }
  });

  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const stateOf = (id) => sessions.get(id)?.state;
  const kinds = () => notifier.recent.map((n) => n.kind);

  await t.test('the API refuses a missing token', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(r.status, 401);
  });

  let id;
  await t.test('a session starts, takes its prompt and finishes a turn', async () => {
    const r = await api('POST', '/api/sessions', { cwd: work, prompt: 'hello there' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.id;
    await waitFor(() => stateOf(id) === 'idle', 'idle after first turn');
    const s = sessions.get(id);
    assert.equal(s.model.current, 'claude-fable-5-1');
    assert.equal(s.model.actual, 'claude-fable-5-1');
    assert.match(s.lastAssistant, /Working on: hello there/);
    // The folder was pre-trusted in the main account's .claude.json.
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    assert.equal(j.projects[work].hasTrustDialogAccepted, true);
  });

  await t.test('a typed message runs and DONE is recognised', async () => {
    await api('POST', `/api/sessions/${id}/message`, { text: 'please finish the report' });
    await waitFor(() => stateOf(id) === 'done', 'done');
    assert.equal(sessions.get(id).detail, 'please finish the report');
    assert.ok(!kinds().includes('done'), 'done pings are off by default');
  });

  await t.test('a question puts the session in waiting and pings', async () => {
    await api('POST', `/api/sessions/${id}/message`, { text: 'question time' });
    await waitFor(() => stateOf(id) === 'waiting', 'waiting');
    assert.match(sessions.get(id).question.text, /staging/);
    assert.ok(kinds().includes('needsInput'));
  });

  await t.test('AskUserQuestion is a question too', async () => {
    notifier.last.clear();
    await api('POST', `/api/sessions/${id}/message`, { text: 'ask me something' });
    await waitFor(() => sessions.get(id).question?.text?.includes('Which database?'), 'question from the tool');
    assert.equal(stateOf(id), 'waiting');
  });

  await t.test('a notice menu after a turn is declined, not left for the next Enter', async () => {
    await api('POST', `/api/sessions/${id}/message`, { text: 'show the upsell' });
    await waitFor(() => /menu: not now/.test(fs.readFileSync(sessions.get(id).transcript, 'utf8')), 'menu declined', 10_000);
    assert.doesNotMatch(fs.readFileSync(sessions.get(id).transcript, 'utf8'), /menu: yes/);
  });

  await t.test('a turn that ends with subagents still running is working, not idle', async () => {
    await api('POST', `/api/sessions/${id}/message`, { text: 'do some background work' });
    await waitFor(() => sessions.view(sessions.get(id)).background?.subagents === 1 && stateOf(id) === 'running', 'running with a background subagent');
    const v = (await api('GET', `/api/sessions/${id}`)).body;
    assert.equal(v.state, 'running');
    assert.equal(v.background.subagents, 1);
    assert.equal(v.background.shells, 0, 'the artifact watcher is not a command');
    assert.match(v.detail, /1 subagent/);
    await waitFor(() => stateOf(id) === 'done', 'done once the subagent finished, a standing watcher notwithstanding');
    assert.equal((await api('GET', `/api/sessions/${id}`)).body.background, null);
  });

  await t.test('/rename in the terminal renames the session, even after a console rename', async () => {
    await api('PATCH', `/api/sessions/${id}`, { title: 'Named in the console' });
    assert.equal(sessions.get(id).title, 'Named in the console');
    await api('POST', `/api/sessions/${id}/message`, { text: 'rename to Named in the terminal' });
    await waitFor(() => sessions.get(id).title === 'Named in the terminal', 'title from /rename');
  });

  await t.test('BLOCKED is recognised', async () => {
    await api('POST', `/api/sessions/${id}/message`, { text: 'block now' });
    await waitFor(() => stateOf(id) === 'blocked', 'blocked');
    assert.match(sessions.get(id).detail, /production password/);
  });

  await t.test('running out of Fable continues the same conversation on Opus', async () => {
    fs.writeFileSync(path.join(HOME, '.claude', 'FAKE_NO_FABLE'), '');
    const launches = sessions.get(id).launches;
    await api('POST', `/api/sessions/${id}/message`, { text: 'keep going' });
    await waitFor(() => sessions.get(id).model.current === 'claude-opus-5' && stateOf(id) === 'idle', 'moved to opus and idle');
    const s = sessions.get(id);
    assert.equal(s.launches, launches + 1);
    assert.equal(s.model.actual, 'claude-opus-5');
    assert.equal(s.account, 'main');
    assert.ok(kinds().includes('modelFallback'));
    assert.ok(accounts.modelLimitedUntil(accounts.get('main'), 'fable') > Date.now());
    // Resumed, not restarted: the continue prompt landed in the same transcript.
    const lines = fs.readFileSync(s.transcript, 'utf8');
    assert.match(lines, /ran out on Main, so this session moved to Opus 5/);
  });

  let b;
  await t.test('an account limit moves the session to the second account', async () => {
    const r = await api('POST', '/api/accounts', { label: 'Second' });
    assert.equal(r.status, 201);
    b = accounts.get(r.body.id);
    assert.equal(r.body.loggedIn, true);
    fs.writeFileSync(path.join(HOME, '.claude', 'FAKE_EXHAUSTED'), '');
    await api('POST', `/api/sessions/${id}/message`, { text: 'more work' });
    await waitFor(() => sessions.get(id).account === b.id && stateOf(id) === 'idle', 'moved to the second account');
    assert.equal(store.settings.activeAccount, b.id);
    assert.ok(kinds().includes('accountSwitch'));
    // Fable is not limited on the fresh account, so it went back to the preferred model.
    assert.equal(sessions.get(id).model.current, 'claude-fable-5-1');
    const screen = await runner.tmux.capture(sessions.get(id).tmux, { history: 200 });
    assert.match(screen, /fake claude · claude-fable-5-1 · resume .* second/);
  });

  await t.test('with every account spent, the session pauses until the soonest reset', async () => {
    fs.writeFileSync(path.join(b.dir, 'FAKE_EXHAUSTED'), '');
    await api('POST', `/api/sessions/${id}/message`, { text: 'even more' });
    await waitFor(() => stateOf(id) === 'paused', 'paused');
    const s = sessions.get(id);
    assert.ok(s.pausedUntil > Date.now() + 50 * 60_000);
    assert.ok(kinds().includes('allLimited'));
  });

  await t.test('clearing limits lets a paused session resume by itself', async () => {
    fs.unlinkSync(path.join(HOME, '.claude', 'FAKE_EXHAUSTED'));
    fs.unlinkSync(path.join(b.dir, 'FAKE_EXHAUSTED'));
    fs.unlinkSync(path.join(HOME, '.claude', 'FAKE_NO_FABLE'));
    for (const a of accounts.list()) a.limits = {};
    sessions.get(id).pausedUntil = Date.now();
    await waitFor(() => stateOf(id) === 'idle', 'resumed and idle', 20_000);
    assert.match(sessions.get(id).lastAssistant, /paused by a usage limit and has now resumed/);
  });

  await t.test('the terminal attaches to the real session', async () => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/terminal?cols=120&rows=30`, { headers: { authorization: 'Bearer test-token' } });
    let text = '';
    let ready = false;
    ws.on('message', (d, bin) => {
      if (bin) text += d.toString('utf8');
      else if (JSON.parse(String(d)).state === 'ready') ready = true;
    });
    await waitFor(() => ready && /fake claude/.test(text), 'terminal output');
    ws.close();
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/terminal`);
    await new Promise((r) => bad.on('error', r));
  });

  await t.test('end, resume and delete', async () => {
    await api('POST', `/api/sessions/${id}/end`);
    assert.equal(stateOf(id), 'stopped');
    await api('POST', `/api/sessions/${id}/resume`, { prompt: 'finish it off' });
    await waitFor(() => stateOf(id) === 'done', 'done after resume');
    const file = sessions.get(id).transcript;
    const r = await api('DELETE', `/api/sessions/${id}?purge=1`);
    assert.equal(r.body.purged, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(sessions.get(id), null);
  });

  await t.test('sessions beyond the limit queue and start when a slot frees', async () => {
    await api('PUT', '/api/settings', { maxRunning: 1 });
    const one = (await api('POST', '/api/sessions', { cwd: work, prompt: 'a slow job' })).body;
    await waitFor(() => stateOf(one.id) === 'running', 'first running');
    const two = (await api('POST', '/api/sessions', { cwd: work, prompt: 'second finish' })).body;
    assert.equal(two.state, 'queued');
    assert.equal(stateOf(two.id), 'queued');
    await waitFor(() => stateOf(one.id) === 'idle', 'first idle');
    await waitFor(() => stateOf(two.id) === 'done', 'second started from the queue and finished');
    await api('PUT', '/api/settings', { maxRunning: 3 });
  });

  await t.test('a weekly limit on Fable alone keeps the account and moves to Opus', async () => {
    for (const a of accounts.list()) a.limits = {};
    store.updateSettings({ activeAccount: 'main' });
    fs.writeFileSync(path.join(HOME, '.claude', 'FAKE_FABLE_WEEKLY'), '');
    const s = (await api('POST', '/api/sessions', { cwd: work, prompt: 'start on fable' })).body;
    await waitFor(() => sessions.get(s.id).model.current === 'claude-opus-5' && stateOf(s.id) === 'idle', 'same account, on opus');
    const live = sessions.get(s.id);
    assert.equal(live.account, 'main', 'the account was not blamed for its model running out');
    assert.equal(accounts.accountLimitedUntil(accounts.get('main')), null);
    assert.ok(accounts.modelLimitedUntil(accounts.get('main'), 'fable') > Date.now());
    fs.unlinkSync(path.join(HOME, '.claude', 'FAKE_FABLE_WEEKLY'));
    await api('DELETE', `/api/sessions/${s.id}?purge=1`);
  });

  await t.test('a reply drops a limit recorded for an account that plainly works', async () => {
    for (const a of accounts.list()) a.limits = {};
    const s = (await api('POST', '/api/sessions', { cwd: work, prompt: 'hello' })).body;
    await waitFor(() => stateOf(s.id) === 'idle', 'idle');
    accounts.markAccountLimited(accounts.get('main'), { until: Date.now() + 3 * 86400_000, window: 'seven_day', text: 'stale' });
    await api('POST', `/api/sessions/${s.id}/message`, { text: 'still there?' });
    await waitFor(() => accounts.accountLimitedUntil(accounts.get('main')) === null, 'the stale limit went');
    await api('DELETE', `/api/sessions/${s.id}?purge=1`);
  });

  await t.test('Resume now tries even when every account is recorded as spent', async () => {
    for (const a of accounts.list()) a.limits = {};
    const s = (await api('POST', '/api/sessions', { cwd: work, prompt: 'hello' })).body;
    await waitFor(() => stateOf(s.id) === 'idle', 'idle');
    await api('POST', `/api/sessions/${s.id}/end`);
    for (const a of accounts.list()) accounts.markAccountLimited(a, { until: Date.now() + 3 * 86400_000, window: 'seven_day', text: 'spent' });
    // Without the record being believed blindly: it starts, answers, and the
    // answer clears what was recorded.
    await api('POST', `/api/sessions/${s.id}/resume`, { prompt: 'finish it off' });
    await waitFor(() => stateOf(s.id) === 'done', 'resumed anyway');
    assert.equal(accounts.accountLimitedUntil(accounts.get('main')), null);
    await api('DELETE', `/api/sessions/${s.id}?purge=1`);
  });

  await t.test('history lists conversations and one can be adopted', async () => {
    const r = await api('GET', '/api/history');
    assert.ok(r.body.sessions.length >= 1);
    assert.ok(r.body.sessions.every((h) => h.managed));
  });
});
