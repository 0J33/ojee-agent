const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScreen } = require('../src/screen');
const { toMessages, readRange } = require('../src/transcript');

const RULE = '─'.repeat(60);

test('an AskUserQuestion menu is read with its options, descriptions and footer', () => {
  const screen = [
    '● Ran 1 shell command',
    RULE,
    ' ☐ Colour',
    'Which colour do you prefer?',
    '❯ 1. Red',
    '     Warm, bold, energetic',
    '  2. Blue',
    '     Cool, calm, serene',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const { menu } = parseScreen(screen);
  assert.ok(menu, 'menu found');
  assert.deepEqual(menu.options.map((o) => o.label), ['Red', 'Blue', 'Type something.', 'Chat about this']);
  assert.equal(menu.options[0].selected, true);
  assert.equal(menu.options[0].desc, 'Warm, bold, energetic');
  assert.match(menu.title, /Which colour/);
});

test('the /model menu: columns split, scroll marker noted, letter keys read from the footer', () => {
  const screen = [
    '   Select model',
    '     1.  Default (recommended)  Opus 5.5 · Best for everyday',
    '     2.  Opus 5.5               For complex work',
    '   ❯ 3.  Haiku 4.5 ✔            Fastest',
    '   ↓ 4.  Sonnet 5               Efficient',
    '      … +6 models',
    '   Enter to set as default · s to use this session only · Esc to cancel',
  ].join('\n');
  const { menu } = parseScreen(screen);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.options[0].label, 'Default (recommended)');
  assert.equal(menu.options[0].desc, 'Opus 5.5 · Best for everyday');
  assert.equal(menu.options[2].desc, 'Fastest');
  assert.equal(menu.more, true);
  assert.deepEqual(menu.hotkeys, [{ key: 's', label: 'use this session only' }]);
});

test('a numbered list in a reply is not a menu; spinner, mode, agents and draft are read', () => {
  const screen = [
    'Steps:',
    '  1. build',
    '  2. test',
    '✻ Cogitating… (12s · ↓ 1.2k tokens)',
    '',
    `${RULE} Conductor ─`,
    '❯ half typed',
    RULE,
    '  ⏵⏵ bypass permissions on · 2 shells',
    '  ● main',
    '  ◯ general-purpose  Running the suite                 4m 1s · ↓ 20k tokens',
  ].join('\n');
  const r = parseScreen(screen);
  assert.equal(r.menu, null);
  assert.equal(r.activity, 'Cogitating… (12s · ↓ 1.2k tokens)');
  assert.equal(r.mode, 'bypass permissions');
  assert.equal(r.draft, 'half typed');
  assert.deepEqual(r.agents.map((a) => a.name), ['general-purpose']);
});

test('detail mode adds thinking, ids, inputs and turn length; plain mode is unchanged', () => {
  const entries = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'system', subtype: 'turn_duration', durationMs: 5000 },
    { type: 'user', message: { content: '<task-notification><status>completed</status><summary>Agent done</summary></task-notification>' } },
  ];
  assert.deepEqual(toMessages(entries).map((m) => m.role), ['user', 'tool', 'result', 'user']);
  const d = toMessages(entries, { detail: true });
  assert.deepEqual(d.map((m) => m.role), ['user', 'thinking', 'tool', 'result', 'turn', 'note']);
  assert.equal(d[2].id, 't1');
  assert.equal(d[2].input.new_string, 'y');
  assert.equal(d[3].toolUseId, 't1');
  assert.equal(d[5].text, 'Agent done');
});

test('readRange returns whole lines and pages back without losing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojee-claude-range-'));
  const f = path.join(dir, 's.jsonl');
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(i % 7) }));
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  const size = fs.statSync(f).size;
  const seen = [];
  let end = size;
  while (end > 0) {
    const r = readRange(f, Math.max(0, end - 200), end);
    seen.unshift(...r.entries.map((e) => e.n));
    assert.equal(r.end, end);
    end = r.start;
  }
  assert.deepEqual(seen, lines.map((_, i) => i));
  fs.rmSync(dir, { recursive: true, force: true });
});
