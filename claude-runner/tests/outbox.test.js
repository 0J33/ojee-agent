const test = require('node:test');
const assert = require('node:assert/strict');
const { Sessions } = require('../src/sessions');

/**
 * A fake Claude Code 2.1.325 terminal, as probed on 15 Nov: mid-turn, Enter
 * puts the box into the queue (drawn as `❯` lines over "ctrl+x ctrl+s to
 * send now"); Up in an empty box takes the WHOLE queue into the box, or
 * recalls the last message sent when nothing is queued; Ctrl+U clears the
 * current line and Backspace on an empty line joins the one above; text
 * left in the box when the turn ends stays there, unsent.
 */
function terminal() {
  // ops: what Claude Code writes to its transcript as the queue moves
  // (2.1.332: enqueue as typed, dequeue into a turn, popAll on Up).
  const t = { running: true, queue: [], box: '', sent: [], flushBeforeUp: false, ops: [] };
  let clock = 1000;
  const op = (operation, content) => t.ops.push({ type: 'queue-operation', operation, content, timestamp: new Date(clock++).toISOString() });
  t.enqueue = (text) => { t.queue.push(text); op('enqueue', text); };
  const rule = '─'.repeat(40);
  t.screen = () => {
    const out = [];
    // Sent messages stay on screen above, as `❯` lines with the reply under them.
    for (const m of t.sent) { const [first, ...rest] = m.split('\n'); out.push(`❯ ${first}`, ...rest.map((l) => `  ${l}`), '● reply', ''); }
    out.push('● working on it', '');
    for (const q of t.queue) { const [first, ...rest] = q.split('\n'); out.push(`❯ ${first}`, ...rest.map((l) => `  ${l}`)); }
    if (t.queue.length) out.push('  ctrl+x ctrl+s to send now');
    out.push(rule);
    const shown = t.box || (t.queue.length ? 'Press up to edit queued messages' : '');
    const [first, ...rest] = shown.split('\n');
    out.push(`❯ ${first}`, ...rest.map((l) => `  ${l}`), rule, '  ⏵⏵ auto mode on');
    return out.join('\n');
  };
  t.tmux = {
    capture: async () => t.screen(),
    type: async (_n, text) => { t.box += text; },
    keys: async (_n, ...keys) => {
      for (const k of keys) {
        if (k === 'Enter') { if (t.box) { if (t.running) t.enqueue(t.box); else t.sent.push(t.box); t.box = ''; } }
        else if (k === 'Up' && !t.box) {
          if (t.flushBeforeUp) { t.sent.push(t.queue.join('\n')); for (const _ of t.queue) op('dequeue'); t.queue = []; t.running = false; t.flushBeforeUp = false; }
          if (t.queue.length) { t.box = t.queue.join('\n'); op('popAll', t.box); t.queue = []; } else t.box = t.sent[t.sent.length - 1] || '';
        } else if (k === 'C-u') { const l = t.box.split('\n'); l[l.length - 1] = ''; t.box = l.join('\n'); }
        else if (k === 'BSpace') { const l = t.box.split('\n'); if (l.length > 1 && l[l.length - 1] === '') { l.pop(); t.box = l.join('\n'); } }
        else if (k === 'C-s') { if (t.queue.length) { t.sent.push(t.queue.join('\n')); for (const _ of t.queue) op('dequeue'); t.queue = []; } }
      }
    },
  };
  return t;
}

function rig() {
  const term = terminal();
  const typed = [];
  const ctx = {
    store: { save() {} },
    emit() {},
    log() {},
    busyOps: new Set(),
    isAlive: async () => true,
    accounts: { get: () => null, usable: () => true },
    handleMenu: async () => null,
    tmux: term.tmux,
    // The real type() presses Enter once the text has landed; here at once.
    type: async (s, text) => { typed.push(text); await term.tmux.type(s.tmux, text); await term.tmux.keys(s.tmux, 'Enter'); s.state = 'running'; },
  };
  for (const k of ['send', 'takeOutbox', 'deliverOutbox', 'withScreenLock', 'refreshQueue', 'clearBox', 'takeQueued', 'sendQueueNow', 'queueOp']) {
    ctx[k] = Sessions.prototype[k].bind(ctx);
  }
  // The transcript, read: the queue's operations as they were written.
  ctx.readTranscript = (s) => { while (term.ops.length) ctx.queueOp(s, term.ops.shift()); };
  const s = { id: 's1', tmux: 'p', state: 'running', model: { current: 'm', preferred: 'm' }, outbox: [] };
  return { ctx, s, term, typed };
}

const done = (ctx) => { for (const t of (ctx.queueWatch || new Map()).values()) clearTimeout(t); };

test('a mid-turn message goes into Claude Code\'s own queue, and the console lists that queue (owner, 15 Nov)', async () => {
  const { ctx, s, term } = rig();
  await ctx.send(s, 'first');
  await ctx.send(s, 'second');
  assert.deepEqual(term.queue, ['first', 'second'], 'the terminal shows them queued');
  assert.deepEqual(s.ccQueue.map((m) => m.text), ['first', 'second'], 'the console lists the same queue');
  assert.ok(s.ccQueue.every((m) => /^[0-9a-f]{12}$/.test(m.id)));
  assert.deepEqual(s.outbox, [], 'the runner holds nothing of its own');
  done(ctx);
});

test('a message queued in the terminal tab shows in the console, from the transcript', async () => {
  const { ctx, s, term } = rig();
  term.enqueue('typed in the terminal');
  await ctx.refreshQueue(s);
  assert.deepEqual(s.ccQueue.map((m) => m.text), ['typed in the terminal']);
  done(ctx);
});

test('Edit or Remove takes one message out; the others stay queued in order; nothing is sent', async () => {
  const { ctx, s, term } = rig();
  for (const m of ['one', 'two', 'three']) await ctx.send(s, m);
  const id = s.ccQueue[1].id;
  const ids = [s.ccQueue[0].id, s.ccQueue[2].id];
  const taken = await ctx.takeQueued(s, id);
  assert.equal(taken.text, 'two');
  assert.deepEqual(term.queue, ['one', 'three']);
  assert.deepEqual(term.sent, []);
  assert.equal(term.box, '');
  assert.deepEqual(s.ccQueue.map((m) => m.id), ids, 'the others keep their ids');
  assert.equal(await ctx.takeQueued(s, id), null, 'taken twice: the second finds nothing');
  done(ctx);
});

test('the race the terminal has: the queue went in just before Up, so nothing is taken and nothing goes twice', async () => {
  const { ctx, s, term } = rig();
  await ctx.send(s, 'deploy to dev');
  const id = s.ccQueue[0].id;
  term.flushBeforeUp = true;
  const taken = await ctx.takeQueued(s, id);
  assert.equal(taken, null, 'already sent: the console loads nothing to edit');
  assert.deepEqual(term.sent, ['deploy to dev'], 'sent once');
  assert.equal(term.box, '', 'the recalled history is cleared, not left to be sent again');
  done(ctx);
});

test('what was typed in the terminal box survives a take', async () => {
  const { ctx, s, term } = rig();
  await ctx.send(s, 'queued one');
  term.box = 'half typed\nsecond line';
  const taken = await ctx.takeQueued(s, s.ccQueue[0].id);
  assert.equal(taken.text, 'queued one');
  assert.equal(term.box, 'half typed\nsecond line');
  assert.deepEqual(term.queue, []);
  done(ctx);
});

test('a multi-line message comes back word for word', async () => {
  const { ctx, s, term } = rig();
  await ctx.send(s, 'line a\nline b');
  await ctx.send(s, 'after');
  const taken = await ctx.takeQueued(s, s.ccQueue[0].id);
  assert.equal(taken.text, 'line a\nline b');
  assert.deepEqual(term.queue, ['after']);
  done(ctx);
});

test('Send now is Claude Code\'s own ctrl+x ctrl+s: the whole queue goes now', async () => {
  const { ctx, s, term } = rig();
  await ctx.send(s, 'a');
  await ctx.send(s, 'b');
  assert.equal(await ctx.sendQueueNow(s), true);
  assert.deepEqual(term.sent, ['a\nb']);
  assert.deepEqual(s.ccQueue, []);
  assert.equal(await ctx.sendQueueNow(s), false, 'nothing left to send');
  done(ctx);
});

// Messages an older runner held for the end of the turn (saved before 15 Nov).
test('an older runner\'s held messages still go as one when the turn ends, or come back to edit', async () => {
  const { ctx, s, typed } = rig();
  s.outbox = [{ id: 'a1', text: 'first', at: 1 }, { id: 'a2', text: 'second', at: 2 }];
  assert.equal(ctx.takeOutbox(s, 'a2').text, 'second');
  assert.equal(ctx.takeOutbox(s, 'a2'), null);
  s.state = 'idle';
  await ctx.deliverOutbox(s);
  assert.deepEqual(typed, ['first']);
  assert.deepEqual(s.outbox, []);
  done(ctx);
});
