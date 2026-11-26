const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { toMessages, imageAt, fullResult } = require('../src/transcript');
const { Sessions, cleanQuestions } = require('../src/sessions');
const { LiveFeeds } = require('../src/live');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

// Shapes as Claude Code 2.1.332 writes them (read from real transcripts, 26 Nov).
const entries = [
  { type: 'user', uuid: U1, timestamp: '2026-11-26T08:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-11-26T08:00:01Z', message: { model: 'm', content: [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: { file_path: '/x/a.js', old_string: 'a', new_string: 'b' } }, { type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'false' } }] } },
  { type: 'user', uuid: U2, timestamp: '2026-11-26T08:00:02Z', toolUseResult: { filePath: '/x/a.js', type: 'update', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_edit1', content: 'ok' }] } },
  { type: 'user', uuid: 'r2', timestamp: '2026-11-26T08:00:03Z', toolUseResult: 'Error: Exit code 1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', is_error: true, content: 'Exit code 1\nnope' }] } },
  { type: 'attachment', uuid: 'h1', timestamp: '2026-11-26T08:00:04Z', attachment: { type: 'hook_system_message', content: 'Tip: run the tests', hookName: 'PostToolUse:Bash', toolUseID: 'toolu_bash1' } },
  { type: 'system', subtype: 'stop_hook_summary', uuid: 'h2', timestamp: '2026-11-26T08:00:05Z', hookCount: 1, hookErrors: ['lint failed'], preventedContinuation: false },
];

test('the live messages keep images, structured edits, exit codes and hook output', () => {
  const m = toMessages(entries, { detail: true });
  const user = m.find((x) => x.role === 'user');
  assert.equal(user.images, 1);
  assert.equal(user.media[0].id, `${U1}~u1`);
  const edit = m.find((x) => x.toolUseId === 'toolu_edit1');
  assert.deepEqual(edit.patch[0].lines, ['-a', '+b']);
  assert.equal(edit.change, 'update');
  const bash = m.find((x) => x.toolUseId === 'toolu_bash1');
  assert.equal(bash.exitCode, 1);
  const hooks = m.filter((x) => x.role === 'hook');
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].text, 'Tip: run the tests');
  assert.equal(hooks[1].error, true);
});

test('an image and a whole output come back out of the file by id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-live-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const img = imageAt(file, `${U1}~u1`);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(img.data, PNG);
  assert.equal(imageAt(file, `${U1}~u0`), null, 'a text block is not an image');
  assert.equal(fullResult(file, 'toolu_bash1').text, 'Exit code 1\nnope');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the queue follows the transcript: enqueue, remove, dequeue, popAll', () => {
  const ctx = { };
  const op = Sessions.prototype.queueOp.bind(ctx);
  const s = {};
  const e = (operation, content, t) => ({ type: 'queue-operation', operation, content, timestamp: `2026-11-26T08:00:0${t}Z` });
  op(s, e('enqueue', 'one', 1));
  op(s, e('enqueue', '<task-notification>\n<task-id>x</task-id>', 2));
  op(s, e('enqueue', 'two', 3));
  assert.deepEqual(s.ccQueue.filter((m) => !m.sys).map((m) => m.text), ['one', 'two']);
  op(s, e('remove', 'one', 4));
  assert.deepEqual(s.ccQueue.map((m) => m.text), ['<task-notification>\n<task-id>x</task-id>', 'two']);
  op(s, e('dequeue', undefined, 5));
  assert.deepEqual(s.ccQueue.map((m) => m.text), ['two']);
  op(s, e('popAll', 'two', 6));
  assert.deepEqual(s.ccQueue, []);
  assert.equal(s.lastPopAll.items[0].text, 'two');
  assert.equal(s.queuePops, 1);
});

test('a question is kept as the hook described it, clipped', () => {
  const q = cleanQuestions([{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }]);
  assert.deepEqual(q, [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B', description: null }] }]);
});

test('answering a question presses what Claude Code 2.1.332 takes: digits, Tab after a multi-choice, 1 to submit', async () => {
  const pressed = [];
  const s = { id: 's', tmux: 'p', prompt: null };
  const ctx = {
    isAlive: async () => true,
    tmux: { keys: async (_n, ...k) => { pressed.push(...k); if (k[0] === '1' && pressed.includes('Tab')) s.prompt = null; }, type: async (_n, t) => pressed.push(`type:${t}`) },
    touch() {},
    view: (x) => ({ id: x.id }),
  };
  ctx.withScreenLock = Sessions.prototype.withScreenLock.bind(ctx);
  const answer = Sessions.prototype.answer.bind(ctx);
  s.prompt = { kind: 'question', questions: cleanQuestions([
    { question: 'Fruit?', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }] },
    { question: 'Size?', options: [{ label: 'Small' }, { label: 'Large' }] },
  ]) };
  await answer(s, { kind: 'question', answers: [{ pick: [0, 2] }, { pick: [1] }] });
  assert.deepEqual(pressed, ['1', '3', 'Tab', '2', '1']);
  await assert.rejects(answer(s, { kind: 'question', answers: [] }), /no longer open/);
});

test('a watched session streams new transcript lines and its state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-feed-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(entries[0])}\n`);
  const sess = { id: 's1', tmux: 'p', transcript: file };
  const sessions = Object.assign(new EventEmitter(), {
    get: () => sess, hasTranscript: () => true, view: (s) => ({ id: s.id, state: s.state }), readTranscript() {}, alive: new Map(), screenLocks: new Map(),
  });
  const live = new LiveFeeds({ sessions, tmux: { capture: async () => '' }, pollMs: 50, screenMs: 60_000 });
  const frames = [];
  const res = Object.assign(new EventEmitter(), { setHeader() {}, flushHeaders() {}, write: (t) => frames.push(t), end() {} });
  live.attach(sess, {}, res);
  const hello = JSON.parse(frames[0].split('\ndata: ')[1]);
  assert.equal(hello.messages[0].role, 'user');
  fs.appendFileSync(file, `${JSON.stringify(entries[1])}\n`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = frames.find((f) => f.startsWith('event: messages'));
  assert.ok(msg, 'new lines were pushed');
  assert.equal(JSON.parse(msg.split('\ndata: ')[1]).messages[0].tool, 'Edit');
  sess.state = 'running';
  sessions.emit('change', sess);
  assert.ok(frames.some((f) => f.startsWith('event: session') && f.includes('running')));
  res.emit('close');
  assert.equal(live.stats().feeds, 0, 'the last watcher leaving closes the feed');
  fs.rmSync(dir, { recursive: true, force: true });
});
