#!/usr/bin/env node
/**
 * A stand-in for `claude` that honours the parts of its contract the runner
 * depends on — and nothing else:
 *
 *   - the flags the runner passes (--session-id/--resume, --model,
 *     --fallback-model, --settings, --append-system-prompt, --name, a prompt)
 *   - a transcript under $CLAUDE_CONFIG_DIR/projects/…/<id>.jsonl, in the
 *     shapes real transcripts use (including the synthetic error lines)
 *   - the hooks from --settings, fired with the payloads real ones carry
 *   - typed input: one line = one prompt
 *   - `auth status --json`
 *
 * Its behaviour is steered by marker files in the account's config dir, so a
 * test can make one account "run out" without touching the other:
 *   FAKE_EXHAUSTED   every request fails with the five-hour session limit
 *   FAKE_NO_FABLE    requests on a Fable model fail with the Fable limit
 *   FAKE_FABLE_WEEKLY  Fable's WEEKLY allowance is spent — worded and shaped
 *                      exactly like the account's own weekly limit, which is
 *                      how Claude Code reports it
 *   FAKE_LOGGED_OUT  `auth status` says logged out
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

if (argv[0] === '--version') { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
if (argv[0] === 'agents') { console.log('[]'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  const out = fs.existsSync(path.join(configDir, 'FAKE_LOGGED_OUT'))
    ? { loggedIn: false, authMethod: 'none' }
    : { loggedIn: true, authMethod: 'claude.ai', email: `${path.basename(configDir)}@example.com`, subscriptionType: 'max' };
  console.log(JSON.stringify(out));
  process.exit(0);
}

const opts = { prompt: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--session-id' || a === '--resume') { opts.id = argv[++i]; opts.resume = a === '--resume'; }
  else if (a === '--model') opts.model = argv[++i];
  else if (a === '--fallback-model') opts.fallback = argv[++i];
  else if (a === '--settings') opts.settings = argv[++i];
  else if (a === '--append-system-prompt') opts.system = argv[++i];
  else if (a === '--name') opts.name = argv[++i];
  else if (a.startsWith('--')) { /* a flag with no value */ }
  else opts.prompt = a;
}

const cwd = process.cwd();
const projDir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });
const transcript = path.join(projDir, `${opts.id}.jsonl`);
const settings = opts.settings ? JSON.parse(fs.readFileSync(opts.settings, 'utf8')) : { hooks: {} };

const write = (e) => fs.appendFileSync(transcript, `${JSON.stringify({ ...e, sessionId: opts.id, cwd, timestamp: new Date().toISOString(), uuid: `${Date.now()}-${Math.random()}` })}\n`);

function fire(event, extra = {}) {
  for (const group of settings.hooks?.[event] || []) {
    if (group.matcher && extra.tool_name && !new RegExp(`^(${group.matcher})$`).test(extra.tool_name)) continue;
    if (group.matcher && !extra.tool_name) continue;
    for (const h of group.hooks || []) {
      spawnSync('/bin/sh', ['-c', h.command], {
        input: JSON.stringify({ session_id: opts.id, transcript_path: transcript, cwd, hook_event_name: event, ...extra }),
        env: process.env,
        timeout: 5000,
      });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (f) => fs.existsSync(path.join(configDir, f));

console.log(`fake claude · ${opts.model} · ${opts.resume ? 'resume' : 'new'} ${opts.id} · ${path.basename(configDir)}`);
write({ type: 'system', subtype: 'informational', content: `started with ${opts.model}` });
fire('SessionStart', { source: opts.resume ? 'resume' : 'startup', model: opts.model });

async function turn(prompt) {
  console.log(`> ${prompt}`);
  write({ type: 'user', message: { role: 'user', content: prompt }, promptSource: 'typed' });
  fire('UserPromptSubmit', { prompt });
  await sleep(150);

  if (has('FAKE_EXHAUSTED')) {
    const text = "You've hit your session limit · resets 7pm (Africa/Cairo)";
    write({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' }, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } });
    console.log(text);
    fire('Stop', { last_assistant_message: text });
    return;
  }
  if (has('FAKE_NO_FABLE') && /fable/.test(opts.model)) {
    const text = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    write({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } });
    console.log(text);
    fire('Stop', { last_assistant_message: text });
    return;
  }
  if (has('FAKE_FABLE_WEEKLY') && /fable/.test(opts.model)) {
    // 2.1.267, Fable's weekly allowance spent: nothing in the line or the
    // quota block says which model it is about.
    const text = "You've hit your weekly limit · resets Sep 26, 2am (Africa/Cairo)";
    write({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400, rateLimitType: 'seven_day' }, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } });
    console.log(text);
    fire('Stop', { last_assistant_message: text });
    return;
  }
  if (/slow/i.test(prompt)) await sleep(2500);
  if (/ask me/i.test(prompt)) {
    fire('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } });
    console.log('[question dialog]');
    return;
  }
  if (/background/i.test(prompt)) {
    // What 2.1.278 reported: the main turn ends while a subagent runs, the
    // subagent's end arrives, then a notification turn wraps up.
    const reply = 'Started a subagent in the background.';
    write({ type: 'assistant', message: { model: opts.model, role: 'assistant', content: [{ type: 'text', text: reply }] } });
    fire('SubagentStart', { agent_id: 'agent-bg-1', agent_type: 'general-purpose' });
    const watch = { id: 'watch-1', type: 'shell', status: 'running', description: 'live updates for artifact https://claude.ai/artifact/X (re-armed on session resume)' };
    fire('Stop', { last_assistant_message: reply, background_tasks: [{ id: 'agent-bg-1', type: 'subagent', status: 'running', description: 'dig through the logs' }, watch] });
    await sleep(2000);
    fire('SubagentStop', { agent_id: 'agent-bg-1', background_tasks: [] });
    fire('UserPromptSubmit', { prompt: '<task-notification>agent-bg-1 completed</task-notification>' });
    const fin = 'The subagent finished.\n\nDONE: background work';
    write({ type: 'assistant', message: { model: opts.model, role: 'assistant', content: [{ type: 'text', text: fin }] } });
    // The watcher is still there: it runs for as long as the session does.
    fire('Stop', { last_assistant_message: fin, background_tasks: [watch] });
    return;
  }
  const renamed = /^rename to (.+)$/i.exec(prompt);
  if (renamed) {
    // What /rename writes: a custom-title entry, no timestamp.
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'custom-title', customTitle: renamed[1], sessionId: opts.id })}\n`);
    fire('Stop', { last_assistant_message: 'Renamed.' });
    return;
  }
  if (/copy me/i.test(prompt)) {
    // What Claude's fullscreen view does when you select text: OSC 52.
    process.stdout.write(`\x1b]52;c;${Buffer.from('copied-by-claude').toString('base64')}\x07`);
    const reply = 'Copied.';
    write({ type: 'assistant', message: { model: opts.model, role: 'assistant', content: [{ type: 'text', text: reply }] } });
    fire('Stop', { last_assistant_message: reply });
    return;
  }
  if (/upsell/i.test(prompt)) {
    // What 2.1.267 printed after a turn, in the same shape.
    const reply = 'Here you go.';
    write({ type: 'assistant', message: { model: opts.model, role: 'assistant', content: [{ type: 'text', text: reply }] } });
    console.log(reply);
    fire('Stop', { last_assistant_message: reply });
    console.log('  Try the new fullscreen renderer?\n  ❯ 1. Yes, try it\n    2. Not now\n  Enter to confirm · Esc to cancel');
    menu = true;
    return;
  }
  const reply = /finish/i.test(prompt) ? `All done.\n\nDONE: ${prompt}`
    : /block/i.test(prompt) ? 'I cannot get further.\n\nBLOCKED: needs the production password'
      : /question/i.test(prompt) ? 'I found two configs.\n\nShould I use the staging one?'
        : `Working on: ${prompt}`;
  write({ type: 'assistant', message: { model: opts.model, role: 'assistant', content: [{ type: 'text', text: reply }] } });
  console.log(reply);
  fire('Stop', { last_assistant_message: reply });
}

// While the menu is up, a line is an answer to it: Down then Enter is "Not now".
let menu = false;
function answerMenu(line) {
  menu = false;
  const choice = line.includes('\x1b[B') ? 'not now' : 'yes, try it';
  write({ type: 'system', subtype: 'informational', content: `menu: ${choice}` });
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`(menu answered: ${choice})`);
}

let chain = Promise.resolve();
if (opts.prompt) chain = chain.then(() => turn(opts.prompt));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (menu) { answerMenu(line); return; }
  if (line.trim()) chain = chain.then(() => turn(line.trim()));
});
process.on('SIGTERM', () => { fire('SessionEnd', { reason: 'other' }); process.exit(143); });
setInterval(() => {}, 1 << 30);
