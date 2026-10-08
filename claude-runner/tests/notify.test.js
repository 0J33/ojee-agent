const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier } = require('../src/notify');

function make(settings = {}) {
  const sent = [];
  const n = new Notifier({
    webhook: 'https://discord.invalid/hook',
    consoleUrl: 'https://console.example',
    settings: () => ({ notify: { needsInput: true, done: false, excerpts: true, ...settings } }),
    fetchImpl: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
  });
  return { n, sent };
}

const session = { id: '0123abcd-0000-0000-0000-000000000000', title: 'Port the parser', cwd: '/srv/app', model: { current: 'claude-opus-5' }, account: 'second' };

test('a ping names the session, links to it, and carries the detail', async () => {
  const { n, sent } = make();
  assert.equal(await n.send('needsInput', { session, text: 'Which database?' }), true);
  const e = sent[0].body.embeds[0];
  assert.equal(sent[0].body.username, 'claude');
  assert.equal(e.title, 'Port the parser needs your input');
  assert.match(e.description, /Which database\?/);
  assert.equal(e.url, 'https://console.example/#/agent/claude/0123abcd-0000-0000-0000-000000000000');
  assert.deepEqual(e.fields.map((f) => f.name), ['Folder', 'Model', 'Account']);
});

test('a kind that is switched off is not sent, unless forced', async () => {
  const { n, sent } = make();
  assert.equal(await n.send('done', { session, text: 'x' }), false);
  assert.equal(sent.length, 0);
  await n.send('done', { session, text: 'x', force: true });
  assert.equal(sent.length, 1);
});

test('the same thing is not sent twice inside the cooldown', async () => {
  const { n, sent } = make();
  await n.send('needsInput', { session, text: 'a' });
  await n.send('needsInput', { session, text: 'b' });
  assert.equal(sent.length, 1);
  await n.send('needsInput', { session: { ...session, id: 'other' }, text: 'c' });
  assert.equal(sent.length, 2);
});

test('excerpts can be left out', async () => {
  const { n, sent } = make({ excerpts: false });
  await n.send('needsInput', { session, text: 'secret-ish output' });
  assert.doesNotMatch(sent[0].body.embeds[0].description, /secret-ish/);
});

test('no webhook: recorded for the UI, nothing sent, never throws', async () => {
  const n = new Notifier({ webhook: '', settings: () => ({ notify: {} }), fetchImpl: () => { throw new Error('should not be called'); } });
  assert.equal(await n.send('error', { text: 'boom' }), false);
  assert.equal(n.recent.length, 1);
  assert.equal(n.recent[0].sent, false);
});

test('a webhook that is down never throws', async () => {
  const n = new Notifier({ webhook: 'https://x.invalid', settings: () => ({ notify: {} }), fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await n.send('error', { text: 'boom' }), false);
});

test('console prefs: a type off is off, Discord off still tells the app, quiet hours hold Discord back', async () => {
  const sent = []; const events = [];
  let prefs = { quiet: { on: false }, tz: 'UTC', types: { 'agent.claude-needs-input': { app: true, discord: false, cooldownMin: 10 }, 'agent.claude-error': { app: false, discord: false } } };
  const n = new Notifier({
    webhook: 'https://discord.invalid/hook', deviceLabel: 'LOQ',
    settings: () => ({ notify: { needsInput: true, error: true } }),
    consolePrefs: () => prefs,
    emit: (e) => events.push(e),
    fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; },
    now: () => Date.parse('2026-10-08T23:30:00Z'),
  });
  assert.equal(await n.send('needsInput', { session, text: 'Which?' }), false);
  assert.equal(sent.length, 0);
  assert.equal(events[0].id, 'agent.claude-needs-input');
  assert.equal(events[0].title, 'Port the parser needs your input (LOQ)');
  assert.equal(events[0].route, '#/agent/claude/0123abcd-0000-0000-0000-000000000000');
  assert.equal(await n.send('error', { session, text: 'boom' }), false);
  assert.equal(events.length, 1, 'a type switched off says nothing at all');
  prefs = { quiet: { on: true, from: '23:00', to: '07:00' }, tz: 'UTC', types: { 'agent.claude-blocked': { app: true, discord: true } } };
  assert.equal(await n.send('blocked', { session, text: 'x' }), false, 'quiet hours: no Discord');
  assert.equal(events.length, 2, 'the console still hears it (and applies quiet hours itself)');
  prefs = { quiet: { on: false }, tz: 'UTC', types: { 'agent.claude-stalled': { app: false, discord: true } } };
  assert.equal(await n.send('stalled', { session, text: 'x' }), true);
  assert.equal(sent.length, 1);
});

test('the test ping is not relayed to the app', async () => {
  const events = [];
  const n = new Notifier({ webhook: 'https://x.invalid', settings: () => ({ notify: {} }), emit: (e) => events.push(e), fetchImpl: async () => ({ ok: true }) });
  assert.equal(await n.send('done', { title: 'Test', force: true, test: true }), true);
  assert.equal(events.length, 0);
});
