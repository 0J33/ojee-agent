/**
 * Deleting a conversation to the trash: path safety, restore, purge, and
 * spotting a process that has the conversation open.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../src/history');

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ojee-hist-'));
  const projects = path.join(root, 'claude', 'projects');
  const proj = path.join(projects, '-home-me-code');
  fs.mkdirSync(path.join(proj, ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, `${ID}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(proj, ID, 'subagents', 'agent-a.jsonl'), '{}\n');
  const trashDir = path.join(root, 'state', 'trash');
  return { root, projects, proj, trashDir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('locate finds the transcript and its sidecar, with or without the project', () => {
  const t = setup();
  try {
    const a = history.locate([t.projects], ID, '-home-me-code');
    assert.equal(a.file, fs.realpathSync(path.join(t.proj, `${ID}.jsonl`)));
    assert.equal(a.sidecar, fs.realpathSync(path.join(t.proj, ID)));
    assert.equal(history.locate([t.projects], ID).project, '-home-me-code');
  } finally { t.done(); }
});

test('locate refuses ids and projects that are paths', () => {
  const t = setup();
  try {
    for (const id of ['../x', '..', 'a/b', '', '.hidden', 'x'.repeat(81)]) {
      assert.throws(() => history.locate([t.projects], id), (e) => e.status === 400, id);
    }
    for (const p of ['..', '.', '../claude', 'a/b', '/etc', 'a\\b']) {
      assert.throws(() => history.locate([t.projects], ID, p), (e) => e.status === 400, p);
    }
    assert.throws(() => history.locate([t.projects], ID, 'nope'), (e) => e.status === 404);
  } finally { t.done(); }
});

test('locate refuses a transcript or project that symlinks outside the projects dirs', () => {
  const t = setup();
  try {
    const outside = path.join(t.root, 'outside');
    fs.mkdirSync(outside);
    const id2 = 'deadbeef-0000-4000-8000-000000000002';
    fs.writeFileSync(path.join(outside, `${id2}.jsonl`), 'secret\n');
    // A project folder that is a symlink out.
    fs.symlinkSync(outside, path.join(t.projects, 'evil'));
    assert.throws(() => history.locate([t.projects], id2, 'evil'), (e) => e.status === 400 && e.reason === 'outside');
    // A transcript that is itself a symlink.
    fs.symlinkSync(path.join(outside, `${id2}.jsonl`), path.join(t.proj, `${id2}.jsonl`));
    assert.throws(() => history.locate([t.projects], id2, '-home-me-code'), (e) => e.status === 400);
    assert.throws(() => history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: id2, project: '-home-me-code' }));
    assert.ok(fs.existsSync(path.join(outside, `${id2}.jsonl`)), 'the outside file is untouched');
  } finally { t.done(); }
});

test('trash moves both into the trash; restore puts them back', () => {
  const t = setup();
  try {
    const r = history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID, project: '-home-me-code' });
    assert.equal(r.files.length, 2);
    assert.ok(!fs.existsSync(path.join(t.proj, `${ID}.jsonl`)));
    assert.ok(!fs.existsSync(path.join(t.proj, ID)));
    assert.ok(fs.existsSync(path.join(r.entry, `${ID}.jsonl`)));
    assert.ok(fs.existsSync(path.join(r.entry, ID, 'subagents', 'agent-a.jsonl')));
    assert.throws(() => history.locate([t.projects], ID), (e) => e.status === 404);

    const back = history.restore({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID });
    assert.equal(back.restored.length, 2);
    assert.equal(fs.readFileSync(path.join(t.proj, `${ID}.jsonl`), 'utf8'), '{"type":"user"}\n');
    assert.ok(fs.existsSync(path.join(t.proj, ID, 'subagents', 'agent-a.jsonl')));
    assert.equal(history.entries(t.trashDir).length, 0);
    assert.throws(() => history.restore({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID }), (e) => e.status === 404);
  } finally { t.done(); }
});

test('a conversation without subagents trashes just the file', () => {
  const t = setup();
  try {
    fs.rmSync(path.join(t.proj, ID), { recursive: true });
    const r = history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID });
    assert.equal(r.files.length, 1);
  } finally { t.done(); }
});

test('restore refuses to overwrite, and a tampered manifest pointing outside', () => {
  const t = setup();
  try {
    const r = history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID });
    fs.writeFileSync(path.join(t.proj, `${ID}.jsonl`), 'new\n');
    assert.throws(() => history.restore({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID }), (e) => e.status === 409 && e.reason === 'exists');
    assert.equal(fs.readFileSync(path.join(t.proj, `${ID}.jsonl`), 'utf8'), 'new\n');
    fs.rmSync(path.join(t.proj, `${ID}.jsonl`));

    const mf = path.join(r.entry, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.files[0].to = path.join(t.root, `${ID}.jsonl`);
    fs.writeFileSync(mf, JSON.stringify(m));
    assert.throws(() => history.restore({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID }), (e) => e.status === 409 && e.reason === 'outside');
    m.files[0].to = path.join(t.proj, 'other.jsonl');
    fs.writeFileSync(mf, JSON.stringify(m));
    assert.throws(() => history.restore({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID }), (e) => e.status === 400);
    assert.ok(!fs.existsSync(path.join(t.root, `${ID}.jsonl`)));
  } finally { t.done(); }
});

test('purge removes only entries older than the keep period', () => {
  const t = setup();
  try {
    const now = Date.now();
    history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: ID, now: now - 8 * 86_400_000 });
    const id2 = 'abcdefab-0000-4000-8000-000000000003';
    fs.writeFileSync(path.join(t.proj, `${id2}.jsonl`), '{}\n');
    history.trash({ projectDirs: [t.projects], trashDir: t.trashDir, id: id2, now: now - 86_400_000 });
    assert.equal(history.entries(t.trashDir).length, 2);
    assert.equal(history.purge(t.trashDir, { now }), 1);
    assert.deepEqual(history.entries(t.trashDir).map((e) => e.manifest.id), [id2]);
    assert.equal(history.purge(path.join(t.root, 'missing')), 0);
  } finally { t.done(); }
});

test('processesNaming finds a process whose command line names the id', () => {
  const t = setup();
  try {
    const proc = path.join(t.root, 'proc');
    const mk = (pid, args) => { fs.mkdirSync(path.join(proc, String(pid)), { recursive: true }); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), `${args.join('\0')}\0`); };
    mk(100, ['claude', '--resume', ID]);
    mk(101, ['claude', '--resume', `${ID}x`]);
    mk(102, ['vim', 'notes.txt']);
    fs.mkdirSync(path.join(proc, 'self'));
    assert.deepEqual(history.processesNaming(ID, { procDir: proc, self: 0 }), [100]);
    assert.deepEqual(history.processesNaming(ID, { procDir: proc, self: 100 }), []);
    assert.throws(() => history.processesNaming('../x', { procDir: proc }));
  } finally { t.done(); }
});
