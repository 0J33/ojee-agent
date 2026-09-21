const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Accounts, cleanEnv } = require('../src/accounts');
const { Store } = require('../src/store');

// Every temp dir this file makes, removed when it finishes.
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = tmp('ojee-claude-acct-');
  const HOME = path.join(root, 'home');
  const main = path.join(HOME, '.claude');
  fs.mkdirSync(path.join(main, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(main, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(main, '.credentials.json'), '{"secret":true}');
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    oauthAccount: { emailAddress: 'someone@example.com' },
    userID: 'abc',
    mcpServers: { x: { command: 'y' } },
    projects: { '/srv/app': { hasTrustDialogAccepted: true, lastCost: 3 }, '/tmp/no': { hasTrustDialogAccepted: false } },
  }));
  const config = { HOME, DEFAULT_CLAUDE_DIR: main, ACCOUNTS_DIR: path.join(root, 'accounts'), CLAUDE_BIN: '/bin/false' };
  const store = new Store(path.join(root, 'state.json'), {
    settings: { activeAccount: 'main' },
    accounts: [{ id: 'main', label: 'Main', dir: null, limits: {} }],
  });
  return { root, HOME, main, accounts: new Accounts({ config, store }), store };
}

test('a second account shares history and settings but never the login', () => {
  const { accounts, main } = setup();
  const b = accounts.add('Work account');
  assert.equal(b.id, 'work-account');
  assert.ok(fs.lstatSync(path.join(b.dir, 'projects')).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(b.dir, 'projects')), fs.realpathSync(path.join(main, 'projects')));
  assert.ok(fs.lstatSync(path.join(b.dir, 'settings.json')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(b.dir, '.credentials.json')), false);

  const seeded = JSON.parse(fs.readFileSync(path.join(b.dir, '.claude.json'), 'utf8'));
  assert.equal(seeded.oauthAccount, undefined);
  assert.equal(seeded.userID, undefined);
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.deepEqual(seeded.mcpServers, { x: { command: 'y' } });
  assert.deepEqual(seeded.projects, { '/srv/app': { hasTrustDialogAccepted: true } });

  // One projects dir after deduplication, whatever the number of accounts.
  assert.equal(accounts.projectDirs().length, 1);
  assert.deepEqual(accounts.env(b), { CLAUDE_CONFIG_DIR: b.dir });
  assert.deepEqual(accounts.env(accounts.get('main')), {});
});

test('prepare is idempotent and never replaces a real file with a link', () => {
  const { accounts } = setup();
  const b = accounts.add('B');
  fs.unlinkSync(path.join(b.dir, 'settings.json'));
  fs.writeFileSync(path.join(b.dir, 'settings.json'), '{"mine":1}');
  accounts.prepare(b);
  accounts.prepare(b);
  assert.equal(fs.lstatSync(path.join(b.dir, 'settings.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(b.dir, 'settings.json'), 'utf8'), '{"mine":1}');
});

test('trust marks a folder in the right .claude.json and keeps what was there', async () => {
  const { accounts, HOME } = setup();
  const main = accounts.get('main');
  const dir = tmp('ojee-claude-work-');
  assert.equal(await accounts.trust(main, dir), true);
  const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
  assert.equal(j.projects[dir].hasTrustDialogAccepted, true);
  assert.equal(j.projects['/srv/app'].lastCost, 3);
  assert.equal(j.oauthAccount.emailAddress, 'someone@example.com');
  assert.equal(fs.existsSync(path.join(HOME, '.claude.json.lock')), false);

  const b = accounts.add('B');
  assert.equal(await accounts.trust(b, dir), true);
  const jb = JSON.parse(fs.readFileSync(path.join(b.dir, '.claude.json'), 'utf8'));
  assert.equal(jb.projects[dir].hasTrustDialogAccepted, true);
});

test('trust waits out a held lock and clears a stale one', async () => {
  const { accounts, HOME } = setup();
  const main = accounts.get('main');
  const lock = path.join(HOME, '.claude.json.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await accounts.trust(main, '/srv/other'), true);
});

test('limits: usable, alternative and earliest return', () => {
  const { accounts } = setup();
  const main = accounts.get('main');
  const b = accounts.add('B');
  const now = Date.now();
  accounts.markModelLimited(main, 'fable', { until: now + 60_000 });
  assert.equal(accounts.usable(main, 'fable'), false);
  assert.equal(accounts.usable(main, 'opus'), true);
  accounts.markAccountLimited(main, { until: now + 120_000, window: 'five_hour' });
  assert.equal(accounts.usable(main), false);
  assert.equal(accounts.alternative('main', 'fable').id, b.id);
  accounts.markNeedsLogin(b, 'Login expired');
  assert.equal(accounts.alternative('main', 'fable'), null);
  assert.equal(accounts.earliestReturn(), now + 120_000);
  assert.equal(accounts.describe(b).status, 'needs-login');
  assert.equal(accounts.describe(main).status, 'limited');
  accounts.expire(now + 200_000);
  assert.equal(accounts.describe(main).limitedUntil, null);
});

test('cleanEnv strips anything that would bill per token or change the account', () => {
  const env = cleanEnv({
    PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CONFIG_DIR: '/x', ANTHROPIC_BASE_URL: 'u',
  });
  assert.deepEqual(env, { PATH: '/bin' });
});
