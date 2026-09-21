/**
 * What a failed turn means.
 *
 * Claude Code writes a request that failed into the session transcript as a
 * synthetic assistant message — `isApiErrorMessage: true`, model
 * `<synthetic>` — with a coarse `error` code and, for usage limits, a
 * `quotaLimits` block carrying the reset time. The shapes below were read off
 * real transcripts written by 2.1.233 – 2.1.278, not guessed:
 *
 *   "You've reached your Fable limit. Run /usage-credits to continue or
 *    switch models with /model."
 *       error rate_limit · apiError model_requires_usage_credits · no reset
 *   "You've hit your session limit · resets 7pm (Africa/Cairo)"
 *       error rate_limit · quotaLimits { rateLimitType five_hour, resetsAt }
 *   "You've hit your weekly limit · resets Sep 26, 2am (Africa/Cairo)"
 *       error rate_limit · quotaLimits { rateLimitType seven_day, resetsAt }
 *   "You've hit your monthly spend limit · … · your session limit resets 4:50pm"
 *       error rate_limit · quotaLimits { five_hour, resetsAt }
 *   "Not logged in · Please run /login" · "Login expired · Please run /login"
 *       error authentication_failed
 *   "API Error: 529 Overloaded …" · "API Error: Connection lost mid-response …"
 *       error server_error
 *
 * The distinction that drives everything downstream: a MODEL limit is fixed by
 * changing model on the same account; an ACCOUNT limit is fixed only by
 * another account or by waiting. Getting those two confused either burns the
 * second account for no reason or parks a session that could have kept going.
 */

/** Model family from an id or a display name: claude-fable-5-1 → fable. */
function family(model) {
  const m = /fable|opus|sonnet|haiku/i.exec(String(model || ''));
  return m ? m[0].toLowerCase() : null;
}

/** The text of a message, whichever shape its content arrived in. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

const HOUR = 3600_000;

/**
 * Classify one transcript entry. Returns null for anything that is not an API
 * error, so a caller can run every line through it.
 *
 * @returns {null | {
 *   kind: 'model-limit'|'account-limit'|'auth'|'throttled'|'transient'|'output'|'other',
 *   family: string|null,     // for model-limit: which model ran out
 *   window: string|null,     // for account-limit: five_hour | seven_day | …
 *   resetsAt: number|null,   // ms epoch, when the source says so
 *   text: string,
 *   at: number,
 * }}
 */
function classify(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.isApiErrorMessage) return null;
  const text = textOf(entry.message).trim();
  const at = Date.parse(entry.timestamp) || Date.now();
  const q = entry.quotaLimits || null;
  const base = { family: null, window: null, resetsAt: null, text, at };

  if (entry.error === 'authentication_failed' || /please run \/login|login expired|not logged in/i.test(text)) {
    return { ...base, kind: 'auth' };
  }

  if (entry.error === 'rate_limit') {
    // A model-specific allowance: the account still works, that model does not.
    const named = /reached your ([a-z][\w .-]*?) limit/i.exec(text);
    if (entry.apiError === 'model_requires_usage_credits' || (named && !/session|weekly|spend|usage/i.test(named[1]))) {
      return { ...base, kind: 'model-limit', family: family(named?.[1]) };
    }
    if ((q && q.status === 'rejected') || /session limit|weekly limit|spend limit|usage limit/i.test(text)) {
      return {
        ...base,
        kind: 'account-limit',
        window: q?.rateLimitType || (/weekly/i.test(text) ? 'seven_day' : /session/i.test(text) ? 'five_hour' : null),
        resetsAt: Number.isFinite(q?.resetsAt) ? q.resetsAt * 1000 : null,
      };
    }
    // A bare 429 with nothing saying which allowance: back off and retry
    // before concluding the account is spent.
    return { ...base, kind: 'throttled' };
  }

  if (entry.error === 'max_output_tokens') return { ...base, kind: 'output' };
  if (entry.error === 'server_error' || /^API Error:/i.test(text) || /another Claude Code process is refreshing/i.test(text)) {
    return { ...base, kind: 'transient' };
  }
  return { ...base, kind: 'other' };
}

/**
 * When an exhausted allowance is worth trying again. A reset time from the
 * server wins; otherwise a window's length is the honest upper bound, and a
 * model limit — which carries no reset at all — gets the configured retry.
 */
function retryAt(c, { modelRetryHours = 5, now = Date.now() } = {}) {
  if (c.resetsAt && c.resetsAt > now) return c.resetsAt;
  if (c.kind === 'model-limit') return now + modelRetryHours * HOUR;
  if (c.window === 'seven_day') return now + 24 * HOUR;
  if (c.window === 'five_hour') return now + 5 * HOUR;
  return now + HOUR;
}

module.exports = { classify, retryAt, family, textOf };
