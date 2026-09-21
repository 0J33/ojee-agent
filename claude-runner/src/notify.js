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
  constructor({ webhook, consoleUrl = '', settings, fetchImpl = fetch, now = Date.now, cooldownMs = 10 * 60_000, log = () => {} }) {
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
  async send(kind, { session = null, text = '', title = null, tag = null, force = false } = {}) {
    const s = this.settings();
    if (!force && s.notify && s.notify[kind] === false) return false;
    const key = tag || `${kind}:${session?.id || '-'}`;
    const last = this.last.get(key) || 0;
    if (!force && this.now() - last < this.cooldownMs) return false;
    this.last.set(key, this.now());

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

    this.recent.unshift({ kind, title: heading, text: detail, session: session?.id || null, at: this.now(), sent: this.enabled });
    this.recent.length = Math.min(this.recent.length, 50);
    if (!this.enabled) return false;

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

module.exports = { Notifier, TITLES };
