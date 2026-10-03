const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/assistant-logic');

const order = [
  { provider: 'opencode', id: 'a-free', name: 'A' },
  { provider: 'opencode', id: 'b-free', name: 'B' },
  { provider: 'opencode-go', id: 'c', name: 'C' },
];

test('candidates start at the pick, then fallbacks, then the catalog, once each', () => {
  const list = L.candidates(order, { first: order[1], fallbacks: ['opencode-go/c'] }).map(L.key);
  assert.deepEqual(list, ['opencode/b-free', 'opencode-go/c', 'opencode/a-free']);
});

test('fallback off is the pick alone', () => {
  assert.deepEqual(L.candidates(order, { first: order[2], fallback: false }).map(L.key), ['opencode-go/c']);
});

test('with a tool off the free tier is left out of the walk', () => {
  assert.deepEqual(L.candidates(order, { first: order[0], freeOk: false }).map(L.key), ['opencode-go/c']);
});

test('refusals walk on; failures every model would share do not', () => {
  assert.equal(L.isRefusal(null), true, 'an empty reply is a refusal');
  assert.equal(L.isRefusal({ name: 'APIError', data: { statusCode: 429, message: 'slow down' } }), true);
  assert.equal(L.isRefusal({ name: 'APIError', data: { statusCode: 403, message: "OpenCode's free tier can only be used from within OpenCode" } }), true);
  assert.equal(L.isRefusal({ name: 'UnknownError', data: { message: 'ProviderModelNotFoundError: Model not found: x' } }), true);
  assert.equal(L.isRefusal({ name: 'MessageAbortedError', data: { message: 'Aborted' } }), false);
  assert.equal(L.isRefusal({ name: 'ContextOverflowError', data: { message: 'too long' } }), false);
});

test('error text drops the provider prefix and the stack', () => {
  assert.equal(L.errorText({ data: { message: 'Error from provider (Console): quota gone\n at x' } }), 'quota gone');
});

test('settings normalise and merge without losing nested fields', () => {
  const s = L.normalizeSettings({ tools: { shell: 'nope', edit: 'off' }, agent: 'weird', fallbacks: ['x', 'p/m'] });
  assert.equal(s.tools.shell, 'ask');
  assert.equal(s.tools.edit, 'off');
  assert.equal(s.agent, 'build');
  assert.deepEqual(s.fallbacks, ['p/m']);
  const n = L.patchSettings(s, { notify: { done: true } });
  assert.equal(n.notify.done, true);
  assert.equal(n.notify.needsYou, true);
  assert.equal(n.tools.edit, 'off');
});

test('rules: ask asks, off denies, and every group is covered', () => {
  const rules = L.rulesFor(L.normalizeSettings({ tools: { shell: 'off', web: 'allow' } }));
  assert.ok(rules.some((r) => r.permission === 'bash' && r.action === 'deny'));
  assert.ok(rules.some((r) => r.permission === 'ojee_ac_command' && r.action === 'ask'));
  assert.ok(rules.some((r) => r.permission === 'webfetch' && r.action === 'allow'));
  assert.equal(L.freeOk(L.normalizeSettings({ tools: { shell: 'off' } })), false);
  assert.equal(L.freeOk(L.normalizeSettings({})), true);
});
