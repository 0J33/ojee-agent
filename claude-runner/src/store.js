/**
 * The runner's own state: settings, accounts, and the sessions it manages.
 *
 * One JSON file, written atomically (temp + rename) and debounced, because
 * the runner is restarted on every deploy and must pick up exactly where it
 * was — which sessions exist, which are paused until when, which account is
 * spent. The old code-agent kept this in memory and forgot every session on
 * restart; that is the failure this file exists to prevent.
 *
 * Nothing secret lives here. Logins stay in each account's own config dir,
 * where `claude` keeps them.
 */

const fs = require('fs');
const path = require('path');

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Deep-merge `patch` into `base` for plain objects; arrays and scalars replace. */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out;
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.timer = null;
    let loaded = {};
    try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    this.data = {
      version: 1,
      settings: merge(clone(defaults.settings), loaded.settings || {}),
      accounts: loaded.accounts?.length ? loaded.accounts : clone(defaults.accounts),
      sessions: loaded.sessions || {},
    };
  }

  get settings() { return this.data.settings; }
  get accounts() { return this.data.accounts; }
  get sessions() { return this.data.sessions; }

  updateSettings(patch) {
    this.data.settings = merge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  /** Coalesce bursts (a hook storm) into one write. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, merge };
