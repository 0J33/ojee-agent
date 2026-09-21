const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../src/guard');

const home = '/home/ojee';
const stackDir = '/home/ojee/stack';
const run = (command, cwd = '/home/ojee/projects/app') => check({ command, cwd, home, stackDir });

test('ordinary work is allowed', () => {
  for (const c of [
    'npm test', 'git push origin feature', 'git commit -m "x; y"', 'docker compose up -d',
    'docker build -t app .', 'docker ps', 'rm -rf node_modules', 'rm -rf ./dist build',
    'systemctl --user status ojee-claude', 'ls ~/stackoverflow-notes',
  ]) assert.equal(run(c), null, c);
});

test('sudo is refused', () => {
  assert.match(run('sudo apt install jq'), /sudo/);
  assert.match(run('cd x && sudo make install'), /sudo/);
});

test('force pushes are refused', () => {
  for (const c of ['git push --force', 'git push -f origin main', 'git push --force-with-lease', 'git push origin +main']) {
    assert.ok(run(c), c);
  }
});

test('the stack folder is off limits from elsewhere, but not from inside it', () => {
  assert.ok(run('cat ~/stack/.env'));
  assert.ok(run('cd /home/ojee/stack && docker compose down'));
  assert.ok(run('ls $HOME/stack'));
  assert.equal(run('docker compose build console', '/home/ojee/stack'), null);
});

test('stopping the console stack containers is refused', () => {
  assert.ok(run('docker stop caddy'));
  assert.ok(run('docker restart ojee-console'));
  assert.ok(run('docker rm -f n8n'));
  assert.equal(run('docker stop my-test-db'), null);
  assert.ok(run('docker system prune -af'));
});

test('stopping the runner itself is refused', () => {
  assert.ok(run('systemctl --user stop ojee-claude'));
  assert.ok(run('systemctl --user restart ojee-claude-tmux.service'));
  assert.ok(run('systemctl --user stop ojee-remote-agent'));
});

test('deleting home or root is refused', () => {
  assert.ok(run('rm -rf ~'));
  assert.ok(run('rm -rf /'));
  assert.ok(run('rm -fr $HOME'));
  assert.ok(run('rm -rf /home/ojee/'));
});
