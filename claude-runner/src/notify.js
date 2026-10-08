/**
 * Discord pings for sessions nobody is watching.
 *
 * Its own webhook (CLAUDE_DISCORD_WEBHOOK) — not fleet's, not Odysseus's —
 * so these can be muted, routed or read on their own.
 *
 * The rule is the same one fleet follows: say something when a person has a
 * reason to act, and never twice for the same thing inside a cooldown. The
 * default set is "it needs you" and "it broke"; a finished session is off
 * unless you turn it on, because unattended work finishing is the normal case.
 */

const { inQuiet } = require('./notify-policy');

/** The id each kind has in the console's catalogue (Settings → Notifications). */
const typeId = (kind) => `agent.claude-${String(kind).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const SEVERITY = { needsInput: 'warn', blocked: 'warn', error: 'warn', stalled: 'warn', allLimited: 'warn', needsLogin: 'warn', modelFallback: 'info', accountSwitch: 'info', done: 'info' };

const COLORS = {
  needsInput: 0x4f8cff,
  blocked: 0xffb020,
  error: 0xff4444,
  stalled: 0xffb020,
  modelFallback: 0x8b8b9a,
  accountSwitch: 0x8b8b9a,
  allLimited: 0xffb020,
  needsLogin: 0xff4444,
  done: 0x00c980,
};

const TITLES = {
  needsInput: 'needs your input',
  blocked: 'is blocked',
  error: 'hit an error',
  stalled: 'has gone quiet',
  modelFallback: 'switched model',
  accountSwitch: 'switched account',
  allLimited: 'is paused — every account is out',
  needsLogin: 'lost its login',
  done: 'is done',
};

class Notifier {
  /**
   * @param {Function} o.emit          (event) => void — the `notify` event on /api/events,
   *                                   which the Agent module relays to the console
   * @param {Function} o.consolePrefs  () => { quiet, tz, types } pushed from the console, or null
   */
  constructor({ webhook, consoleUrl = '', settings, fetchImpl = fetch, now = Date.now, cooldownMs = 10 * 60_000, log = () => {}, emit = () => {}, consolePrefs = () => null, deviceLabel = '' }) {
    this.emit = emit;
    this.consolePrefs = consolePrefs;
    this.deviceLabel = deviceLabel;
    this.webhook = webhook || '';
    this.consoleUrl = consoleUrl;
    this.settings = settings; // () => current settings
    this.fetch = fetchImpl;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.log = log;
    this.last = new Map();
    this.recent = []; // what was sent, for the UI
  }

  get enabled() { return !!this.webhook; }

  link(session) {
    if (!this.consoleUrl) return null;
    return session ? `${this.consoleUrl}/#/agent/claude/${session.id}` : `${this.consoleUrl}/#/agent/claude`;
  }

  /**
   * @param {string} kind     one of the keys of settings.notify
   * @param {object} o
   * @param {object} [o.session]
   * @param {string} [o.text]   the detail — a question, an error, a reason
   * @param {string} [o.title]  overrides the generated title
   * @param {string} [o.tag]    dedupe key; defaults to kind + session
   */
  async send(kind, { session = null, text = '', title = null, tag = null, force = false, test = false } = {}) {
    const s = this.settings();
    // The console's choices win once it has sent any; until then, the old
    // per-kind switches in the runner's own settings.
    const cp = this.consolePrefs();
    const t = cp && cp.types ? cp.types[typeId(kind)] : null;
    let discordOn = true;
    let cooldown = this.cooldownMs;
    if (t) {
      if (!force && !t.app && !t.discord) return false;
      discordOn = force || !!t.discord;
      if (Number.isFinite(t.cooldownMin)) cooldown = t.cooldownMin * 60_000;
    } else if (!force && s.notify && s.notify[kind] === false) return false;
    const key = tag || `${kind}:${session?.id || '-'}`;
    const last = this.last.get(key) || 0;
    if (!force && this.now() - last < cooldown) return false;
    this.last.set(key, this.now());
    const severity = SEVERITY[kind] || 'info';
    const quiet = !force && cp && inQuiet(cp.quiet, this.now(), cp.tz) && !(severity === 'critical' && cp.quiet.critical);

    const name = session ? (session.title || session.id.slice(0, 8)) : 'Claude';
    const heading = title || `${name} ${TITLES[kind] || kind}`;
    const detail = s.notify?.excerpts === false ? '' : String(text || '').slice(0, 1500);
    const fields = [];
    if (session) {
      fields.push({ name: 'Folder', value: `\`${String(session.cwd).slice(0, 200)}\``, inline: false });
      if (session.model?.current) fields.push({ name: 'Model', value: session.model.current, inline: true });
      if (session.account) fields.push({ name: 'Account', value: session.account, inline: true });
    }
    const url = this.link(session);

    const sending = this.enabled && discordOn && !quiet;
    this.recent.unshift({ kind, title: heading, text: detail, session: session?.id || null, at: this.now(), sent: sending });
    this.recent.length = Math.min(this.recent.length, 50);
    // The app channel: the console decides (and applies quiet hours itself).
    if (!test) {
      try {
        this.emit({
          id: typeId(kind),
          title: this.deviceLabel ? `${heading} (${this.deviceLabel})` : heading,
          body: detail.slice(0, 600),
          tag: key,
          severity,
          route: session ? `#/agent/claude/${session.id}` : '#/agent/claude',
          at: this.now(),
        });
      } catch { /* a stream that broke must not stop the ping */ }
    }
    if (!sending) return false;

    try {
      const res = await this.fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'claude',
          embeds: [{
            title: heading.slice(0, 250),
            description: [detail, url ? `[Open in console](${url})` : ''].filter(Boolean).join('\n\n').slice(0, 3900),
            url: url || undefined,
            color: COLORS[kind] ?? 0x8b8b9a,
            fields,
            timestamp: new Date(this.now()).toISOString(),
          }],
        }),
      });
      return res.ok;
    } catch (e) {
      // A webhook that is down must never take the runner with it.
      this.log('notify', e.message);
      return false;
    }
  }
}

module.exports = { Notifier, TITLES, typeId, SEVERITY };
