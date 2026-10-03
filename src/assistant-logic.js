/**
 * The Assistant's decisions, without any I/O — so they can be tested.
 *
 *   which model a turn tries, and in what order
 *   whether a failed turn is the model refusing (walk on) or the turn failing
 *   which permission rules a session carries, from the settings
 *   what the settings look like when a field is missing or wrong
 */

/** `provider/id` — the one string the UI stores, sends and reads back. */
const key = (m) => `${m.provider}/${m.id}`;

/**
 * Resolve what the reader sent. A pair (`opencode-go/qwen3.8-max`) is taken
 * literally, and passed through even when the catalog has not listed it — an
 * operator pinning a model must not have it silently dropped. A bare id is
 * matched against the catalog, because only the server knows which provider a
 * given id lives under, and naming the wrong one is a 500 that reads like an
 * outage.
 */
function resolve(order, wanted) {
  if (!wanted) return null;
  const s = String(wanted).trim();
  if (!s) return null;
  if (s.includes('/')) {
    const at = s.indexOf('/');
    const provider = s.slice(0, at);
    const id = s.slice(at + 1);
    return order.find((m) => m.provider === provider && m.id === id) || { provider, id, name: id };
  }
  return order.find((m) => m.id === s) || null;
}

/** The free tier lives under the `opencode` provider; the subscription under `opencode-go`. */
const isFree = (m) => m?.provider === 'opencode';

/**
 * The models one turn may try, first to last.
 *
 * `first` is where the walk starts — the reader's pick, the session's last
 * model, or the default. Then the settings' fallback list, then the rest of
 * the catalog. With fallback off it is `first` alone. When a tool group is
 * switched off the free tier refuses every request (it fingerprints the tool
 * set), so free models are left out rather than tried and failed one by one.
 */
function candidates(order, { first, fallbacks = [], fallback = true, freeOk = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (m) => {
    if (!m || seen.has(key(m))) return;
    if (!freeOk && isFree(m)) return;
    seen.add(key(m));
    out.push(m);
  };
  add(first);
  if (!fallback) return out.length ? out : order.filter((m) => freeOk || !isFree(m)).slice(0, 1);
  for (const f of fallbacks) add(resolve(order, f));
  for (const m of order) add(m);
  return out;
}

/**
 * A failed turn: is it this model refusing, or would every model fail it?
 *
 * Quota, rate limits, an upstream that gave up, a model withdrawn from the
 * catalog, the free tier turning a request away, and a reply that came back
 * with nothing in it: another model may well answer. A context overflow, an
 * output-length cap, a content filter or the reader pressing Stop: it would
 * fail the same way anywhere, and walking the whole catalog only delays it.
 */
function isRefusal(error) {
  if (!error) return true; // finished with nothing said: the empty reply
  const name = error.name || '';
  if (['MessageAbortedError', 'ContextOverflowError', 'MessageOutputLengthError', 'ContentFilterError', 'StructuredOutputError'].includes(name)) return false;
  if (name === 'ProviderAuthError') return true;
  const status = error.data?.statusCode;
  if (status === 429 || status === 402 || status === 403 || (status >= 500 && status < 600)) return true;
  const s = JSON.stringify(error).toLowerCase();
  return /rate.?limit|quota|capacity|out of|exceeded|too many|temporarily unavailable|no available|credit|global regions|upstream|region not|free tier|model not found|modelnotfound|overloaded|unavailable|timeout|timed out|insufficient/.test(s);
}

/** A short, human line for an opencode error object. */
function errorText(error) {
  if (!error) return 'The model finished without saying anything.';
  const msg = error.data?.message || error.message || error.name || 'Unknown error';
  return String(msg).split('\n')[0]
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .replace(/^Error from provider \([^)]*\):\s*/i, '')
    .replace(/\s*Did you mean:.*$/, '')
    .slice(0, 300);
}

/* ── settings ─────────────────────────────────────────────────────────── */

/**
 * Tool groups, each with the opencode permission names it covers. `console`
 * is only the console tools that CHANGE something — reading the fleet or the
 * home devices never asks.
 */
const GROUPS = {
  shell: ['bash'],
  edit: ['edit', 'write', 'apply_patch'],
  console: ['ojee_ac_command', 'ojee_agent_restart_service', 'ojee_ssh_run'],
  web: ['webfetch', 'websearch'],
};

const DEFAULTS = {
  defaultModel: null,       // null: the head of the catalog order
  fallback: true,           // walk on when a model refuses
  fallbacks: [],            // keys tried before the rest of the catalog
  agent: 'build',           // build | plan
  quickPath: null,          // null: OPENCODE_PATH
  tools: { shell: 'ask', edit: 'ask', console: 'ask', web: 'allow' },
  notify: { done: false, needsYou: true, errors: true },
};

const TOOL_VALUES = ['allow', 'ask', 'off'];

/** Whatever was stored or sent, made into a complete, valid settings object. */
function normalizeSettings(raw = {}, base = DEFAULTS) {
  const s = JSON.parse(JSON.stringify(base));
  if (!raw || typeof raw !== 'object') return s;
  if ('defaultModel' in raw) s.defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.includes('/') ? raw.defaultModel : null;
  if ('fallback' in raw) s.fallback = !!raw.fallback;
  if (Array.isArray(raw.fallbacks)) s.fallbacks = raw.fallbacks.filter((k) => typeof k === 'string' && k.includes('/')).slice(0, 8);
  if (['build', 'plan'].includes(raw.agent)) s.agent = raw.agent;
  if ('quickPath' in raw) s.quickPath = typeof raw.quickPath === 'string' && raw.quickPath.startsWith('/') ? raw.quickPath : null;
  if (raw.tools && typeof raw.tools === 'object') {
    for (const g of Object.keys(GROUPS)) if (TOOL_VALUES.includes(raw.tools[g])) s.tools[g] = raw.tools[g];
  }
  if (raw.notify && typeof raw.notify === 'object') {
    for (const k of Object.keys(DEFAULTS.notify)) if (k in raw.notify) s.notify[k] = !!raw.notify[k];
  }
  return s;
}

/** Merge a partial update into settings (nested objects merge, not replace). */
function patchSettings(current, patch = {}) {
  const next = { ...current, ...patch };
  if (patch.tools) next.tools = { ...current.tools, ...patch.tools };
  if (patch.notify) next.notify = { ...current.notify, ...patch.notify };
  return normalizeSettings(next, current);
}

/** The permission rules a session carries for these settings. */
function rulesFor(settings) {
  const rules = [];
  for (const [g, names] of Object.entries(GROUPS)) {
    const v = settings.tools?.[g] || 'allow';
    for (const permission of names) {
      rules.push({ permission, pattern: '*', action: v === 'off' ? 'deny' : v === 'ask' ? 'ask' : 'allow' });
    }
  }
  return rules;
}

/** Whether every model can be used: any tool off and the free tier says no. */
const freeOk = (settings) => !Object.values(settings.tools || {}).includes('off');

module.exports = {
  key, resolve, isFree, candidates, isRefusal, errorText,
  GROUPS, DEFAULTS, normalizeSettings, patchSettings, rulesFor, freeOk,
};
