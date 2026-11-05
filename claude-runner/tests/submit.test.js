const test = require('node:test');
const assert = require('node:assert');
const { enterWhenTyped } = require('../src/submit');

const G = '\x1b[38;2;153;153;153m'; const R = '\x1b[39m';
const frame = (inputLine) => ['', '  Some output', '─'.repeat(40), inputLine, '─'.repeat(40), '  ⏵⏵ bypass permissions on'].join('\n');
const SUG = frame(`${G}❯ ${R}${G}go with the bigger box${R}`);
const TYPED = frame(`${G}❯ ${R}my own message`);


test('Enter waits until the typed text has replaced the suggestion', async () => {
  const sent = [];
  const t = { capture: (() => { let i = 0; const s = [SUG, SUG, TYPED]; return async () => s[Math.min(i++, 2)]; })(), keys: async (_n, ...k) => { sent.push(...k); } };
  assert.equal(await enterWhenTyped(t, 'x', { first: 0, step: 1, timeout: 1000 }), true);
  assert.deepEqual(sent, ['Enter']);
});

test('Enter is never pressed while only the suggestion shows', async () => {
  const sent = [];
  const t = { capture: async () => SUG, keys: async (_n, ...k) => { sent.push(...k); } };
  assert.equal(await enterWhenTyped(t, 'x', { first: 0, step: 5, timeout: 40 }), false);
  assert.deepEqual(sent, [], 'the suggestion must not be sent in place of the message');
});

test('no input box on screen falls back to Enter at the deadline', async () => {
  const sent = [];
  const t = { capture: async () => 'a dialog\nwith no box', keys: async (_n, ...k) => { sent.push(...k); } };
  assert.equal(await enterWhenTyped(t, 'x', { first: 0, step: 5, timeout: 20 }), true);
  assert.deepEqual(sent, ['Enter']);
});
