const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { marker, asksSomething } = require('../src/sessions');
const { toMessages, Tail, describe } = require('../src/transcript');

const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('markers are read from the end of a reply only', () => {
  assert.equal(marker('Did the thing.\n\nDONE: migrated 14 tables', 'DONE'), 'migrated 14 tables');
  assert.equal(marker('**BLOCKED:** needs the prod DB password', 'BLOCKED'), 'needs the prod DB password');
  assert.equal(marker('DONE: early\n' + 'x\n'.repeat(20), 'DONE'), null);
  assert.equal(marker('nothing here', 'DONE'), null);
});

test('a reply ending in a question is a question', () => {
  assert.equal(asksSomething('I found two configs.\n\nWhich one should I use?'), true);
  assert.equal(asksSomething('Should I **proceed?**'), true);
  assert.equal(asksSomething('Done. Is it worth it? Yes, and here is why.'), false);
  assert.equal(asksSomething(''), false);
});

test('toMessages keeps the conversation and drops the bookkeeping', () => {
  const msgs = toMessages([
    { type: 'user', message: { content: 'fix the tests' }, timestamp: 't1' },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '3 passing', is_error: false }] } },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'file-history-snapshot' },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiError: 'model_requires_usage_credits', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've reached your Fable limit." }] } },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'result', 'error']);
  assert.equal(msgs[1].model, 'claude-opus-5');
  assert.equal(msgs[2].text, 'npm test');
  assert.equal(msgs[4].kind, 'model-limit');
});

test('Tail returns only complete new lines', () => {
  const f = path.join(tmp('ojee-claude-tail-'), 's.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  const t = new Tail(f, 0);
  assert.deepEqual(t.read(), [{ a: 1 }]);
  fs.appendFileSync(f, '2}\n');
  assert.deepEqual(t.read(), [{ b: 2 }]);
  assert.deepEqual(t.read(), []);
});

test('describe reads cwd, title and first prompt', () => {
  const f = path.join(tmp('ojee-claude-desc-'), '11111111-1111-1111-1111-111111111111.jsonl');
  fs.writeFileSync(f, [
    { type: 'user', cwd: '/srv/app', message: { content: 'refactor the parser' } },
    { type: 'ai-title', aiTitle: 'Parser refactor' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const d = describe(f);
  assert.equal(d.cwd, '/srv/app');
  assert.equal(d.title, 'Parser refactor');
  assert.equal(d.firstPrompt, 'refactor the parser');
});
