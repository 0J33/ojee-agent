#!/usr/bin/env node
/**
 * PreToolUse hook for Bash in runner-started sessions. Hooks still run under
 * bypass-permissions, which is the point: exit code 2 blocks the call and
 * the text on stderr goes back to Claude as the reason. Anything unexpected
 * (bad input, a bug here) allows the call — a guard that fails closed would
 * stop every session over its own mistake.
 *
 * The rules are in src/guard.js; OJEE_CLAUDE_GUARD=0 (the Settings toggle)
 * turns them off.
 */
const os = require('os');
const path = require('path');

if (process.env.OJEE_CLAUDE_GUARD === '0') process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const evt = JSON.parse(raw || '{}');
    if (evt.tool_name !== 'Bash') process.exit(0);
    const { check } = require(path.join(__dirname, '..', 'src', 'guard.js'));
    const reason = check({
      command: evt.tool_input?.command,
      cwd: evt.cwd || process.cwd(),
      home: os.homedir(),
      stackDir: process.env.OJEE_CLAUDE_STACK_DIR || path.join(os.homedir(), 'stack'),
    });
    if (reason) {
      process.stderr.write(`Blocked by the ojee-claude guard: ${reason}`);
      process.exit(2);
    }
  } catch { /* allow */ }
  process.exit(0);
});
