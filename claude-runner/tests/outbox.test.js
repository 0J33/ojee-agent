const test = require('node:test');
const assert = require('node:assert/strict');
const { Sessions } = require('../src/sessions');

/**
 * The queue logic of Sessions on a fake session: send() while a turn runs
 * queues, takeOutbox() removes, deliverOutbox() sends what is left. `typed`
 * is what reached Claude Code.
 */
function rig() {
  const typed = [];
  const events = [];
  const ctx = {
    store: { save() {} },
    emit: (e, s) => events.push([e, (s.outbox || []).map((m) => m.text)]),
    log() {},
    busyOps: new Set(),
    isAlive: async () => true,
    accounts: { get: () => null, usable: () => true },
    handleMenu: async () => null,
    tmux: { keys: async () => {} },
    type: async (s, text) => { typed.push(text); s.state = 'running'; },
  };
  for (const k of ['send', 'takeOutbox', 'deliverOutbox']) ctx[k] = Sessions.prototype[k].bind(ctx);
  const s = { id: 's1', state: 'running', model: { current: 'm', preferred: 'm' }, outbox: [] };
  return { ctx, s, typed, events };
}

test('mid-turn messages queue in order, with ids, and go as one message when the turn ends', async () => {
  const { ctx, s, typed } = rig();
  await ctx.send(s, 'first');
  await ctx.send(s, 'second');
  assert.deepEqual(typed, []);
  assert.deepEqual(s.outbox.map((m) => m.text), ['first', 'second']);
  assert.ok(s.outbox.every((m) => typeof m.id === 'string' && m.id));
  s.state = 'idle';
  await ctx.deliverOutbox(s);
  assert.deepEqual(typed, ['first\n\nsecond']);
  assert.deepEqual(s.outbox, []);
});

test('Up, edit, send: the queued original never goes out, only the edit (owner, 11 Nov)', async () => {
  const { ctx, s, typed } = rig();
  await ctx.send(s, 'deploy to dev');
  const id = s.outbox[0].id;
  // Up: the console takes it back first; only then does the text reach the box.
  const taken = ctx.takeOutbox(s, id);
  assert.equal(taken.text, 'deploy to dev');
  assert.deepEqual(s.outbox, []);
  // Edited and sent again while the turn still runs: queued as the new text.
  await ctx.send(s, 'deploy to dev, then tell me');
  // The turn ends: one message, the edited one.
  s.state = 'idle';
  await ctx.deliverOutbox(s);
  assert.deepEqual(typed, ['deploy to dev, then tell me']);
  // A second take of the same id finds nothing: the console then loads nothing.
  assert.equal(ctx.takeOutbox(s, id), null);
});

test('a take that races the end-of-turn flush gets the message or nothing, never both', async () => {
  const { ctx, s, typed } = rig();
  await ctx.send(s, 'one');
  s.state = 'idle';
  // isAlive resolves on a later tick: the take lands while the flush checks.
  let release;
  ctx.isAlive = () => new Promise((r) => { release = () => r(true); });
  const flushing = ctx.deliverOutbox(s);
  const taken = ctx.takeOutbox(s, s.outbox[0].id);
  release();
  await flushing;
  assert.equal(taken.text, 'one');
  assert.deepEqual(typed, [], 'taken back before the flush read the queue: not sent');

  // And the other order: the flush has the queue, the take finds nothing.
  ctx.isAlive = async () => true;
  s.state = 'running';
  await ctx.send(s, 'two');
  s.state = 'idle';
  const id2 = s.outbox[0].id;
  const f2 = ctx.deliverOutbox(s);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ctx.takeOutbox(s, id2), null);
  await f2;
  assert.deepEqual(typed, ['two']);
});
