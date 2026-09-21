/**
 * The classifier against the shapes real transcripts contain. Each fixture is
 * a line Claude Code wrote (2.1.233–2.1.278), trimmed to the fields that
 * matter and with paths and ids replaced.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, retryAt, family } = require('../src/limits');

const synthetic = (text, extra) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  timestamp: '2026-09-21T14:06:23.823Z',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});

test('Fable limit is a model limit, not an account limit', () => {
  const c = classify(synthetic(
    "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
    { error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429 },
  ));
  assert.equal(c.kind, 'model-limit');
  assert.equal(c.family, 'fable');
  assert.equal(c.resetsAt, null);
});

test('session (five-hour) limit is an account limit with its reset time', () => {
  const c = classify(synthetic("You've hit your session limit · resets 7pm (Africa/Cairo)", {
    error: 'rate_limit',
    apiErrorStatus: 429,
    quotaLimits: { status: 'rejected', resetsAt: 1789401600, rateLimitType: 'five_hour' },
  }));
  assert.equal(c.kind, 'account-limit');
  assert.equal(c.window, 'five_hour');
  assert.equal(c.resetsAt, 1789401600 * 1000);
});

test('weekly limit is an account limit', () => {
  const c = classify(synthetic("You've hit your weekly limit · resets Sep 26, 2am (Africa/Cairo)", {
    error: 'rate_limit',
    quotaLimits: { status: 'rejected', resetsAt: 1790377200, rateLimitType: 'seven_day' },
  }));
  assert.equal(c.kind, 'account-limit');
  assert.equal(c.window, 'seven_day');
});

test('monthly spend limit is an account limit', () => {
  const c = classify(synthetic(
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 4:50pm (Africa/Cairo)",
    { error: 'rate_limit', quotaLimits: { status: 'rejected', resetsAt: 1788702600, rateLimitType: 'five_hour' } },
  ));
  assert.equal(c.kind, 'account-limit');
});

test('logged out and expired login are auth failures', () => {
  assert.equal(classify(synthetic('Not logged in · Please run /login', { error: 'authentication_failed' })).kind, 'auth');
  assert.equal(classify(synthetic('Login expired · Please run /login', { error: 'authentication_failed' })).kind, 'auth');
});

test('server errors are transient', () => {
  for (const t of [
    'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
    'API Error: Connection lost mid-response. The response above may be incomplete.',
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
  ]) {
    assert.equal(classify(synthetic(t, { error: 'server_error' })).kind, 'transient', t);
  }
  assert.equal(classify(synthetic('Could not refresh your login because another Claude Code process is refreshing it (or exited while doing so).', { error: 'server_error' })).kind, 'transient');
});

test('a bare 429 without a named allowance is throttling, not a spent account', () => {
  assert.equal(classify(synthetic('API Error: 429 rate limited', { error: 'rate_limit' })).kind, 'throttled');
});

test('output limit and unknown errors are reported, not retried', () => {
  assert.equal(classify(synthetic("API Error: Claude's response exceeded the 64000 output token maximum.", { error: 'max_output_tokens' })).kind, 'output');
  assert.equal(classify(synthetic('API Error: Output blocked by content filtering policy', { error: 'unknown' })).kind, 'transient');
});

test('ordinary messages are not errors', () => {
  assert.equal(classify({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'hello' }] } }), null);
  assert.equal(classify({ type: 'user', message: { content: 'hi' } }), null);
});

test('retryAt prefers the server reset, then the window', () => {
  const now = 1_000_000;
  assert.equal(retryAt({ kind: 'account-limit', resetsAt: now + 5000 }, { now }), now + 5000);
  assert.equal(retryAt({ kind: 'model-limit', resetsAt: null }, { now, modelRetryHours: 2 }), now + 2 * 3600_000);
  assert.equal(retryAt({ kind: 'account-limit', window: 'five_hour', resetsAt: null }, { now }), now + 5 * 3600_000);
});

test('family', () => {
  assert.equal(family('claude-fable-5-1'), 'fable');
  assert.equal(family('claude-opus-5'), 'opus');
  assert.equal(family('Fable'), 'fable');
  assert.equal(family(null), null);
});
