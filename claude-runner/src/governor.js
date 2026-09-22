/**
 * Keeps the sessions from cooking the box.
 *
 * The HP box is a laptop running a docker stack, and unattended sessions run
 * test suites and builds that take every core for as long as they run —
 * 100% CPU sustained, and the package into the high 80s. The kernel's own CPU
 * controller would be the clean tool, but this systemd (249) delegates only
 * `memory pids` to user services, so CPUQuota and CPUWeight on the tmux unit
 * are silently ignored without root.
 *
 * What a user CAN do is freeze its own cgroup: cgroup v2's `cgroup.freeze` is
 * core cgroup functionality, not a delegated controller. So this is a duty
 * cycle: every PERIOD, the sessions' cgroup (the tmux unit — every claude and
 * everything it spawned) runs for part of it and is frozen for the rest. The
 * frozen share is steered so the measured CPU use sits at a cap, and the cap
 * itself comes down while the package is hotter than a target.
 *
 * Frozen slices are tens of milliseconds: a terminal may stutter while it is
 * working hard, and Claude's API streams wait a moment. Nothing is lost.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PERIOD_MS = 200;        // one run+freeze cycle
const CONTROL_MS = 1000;      // how often the frozen share is re-steered
const MAX_FROZEN = 0.85;      // never freeze more than this share

/** The hottest CPU package temperature, °C, or null if none is readable. */
function readTemp() {
  let best = null;
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const dir = path.join('/sys/class/thermal', z);
      let type = '';
      try { type = fs.readFileSync(path.join(dir, 'type'), 'utf8').trim(); } catch { continue; }
      if (!/x86_pkg_temp|cpu|coretemp|k10temp|acpitz/i.test(type)) continue;
      const t = Number(fs.readFileSync(path.join(dir, 'temp'), 'utf8')) / 1000;
      if (Number.isFinite(t) && t > 0 && t < 130 && (best === null || t > best)) best = t;
    }
  } catch { /* no thermal zones (containers, VMs) */ }
  return best;
}

/** Where systemd put a user unit's cgroup. */
function unitCgroup(unit) {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'], { timeout: 5000 }, (err, out) => {
      const p = String(out || '').trim();
      resolve(!err && p ? path.join('/sys/fs/cgroup', p) : null);
    });
  });
}

class Governor {
  /**
   * @param {object} o
   * @param {string} o.unit          the user unit whose cgroup holds the sessions
   * @param {Function} o.settings    () => current settings
   * @param {Function} [o.log]
   */
  constructor({ unit, settings, log = () => {} }) {
    this.unit = unit;
    this.settings = settings;
    this.log = log;
    this.ncpu = os.cpus().length || 1;
    this.cgroup = null;
    this.frozenShare = 0;       // 0..MAX_FROZEN, steered each CONTROL_MS
    this.thermalScale = 1;      // multiplies the cap while running hot
    this.usage = 0;             // cores, last control interval
    this.temp = null;
    this.lastUsage = null;
    this.timers = [];
    this.running = false;
    this.frozen = false;
    this.reason = null;         // why it is not governing, if it is not
  }

  async start() {
    this.cgroup = await unitCgroup(this.unit);
    if (!this.cgroup || !fs.existsSync(path.join(this.cgroup, 'cgroup.freeze'))) {
      this.reason = `no freezable cgroup for ${this.unit}`;
      this.log('governor', this.reason);
      return false;
    }
    this.write(0); // whatever a crashed predecessor left, thaw it
    this.running = true;
    this.cycle();
    this.timers.push(setInterval(() => this.control(), CONTROL_MS));
    this.log('governor', `governing ${this.cgroup} (${this.ncpu} threads)`);
    return true;
  }

  stop() {
    this.running = false;
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    this.write(0);
  }

  write(v) {
    if (!this.cgroup) return;
    try {
      fs.writeFileSync(path.join(this.cgroup, 'cgroup.freeze'), v ? '1' : '0');
      this.frozen = !!v;
    } catch (e) {
      // The unit restarted (new cgroup) or went away: find it again later.
      if (e.code === 'ENOENT') unitCgroup(this.unit).then((p) => { this.cgroup = p; });
    }
  }

  /** One period: run, then (if steering says so) freeze for the rest. */
  cycle() {
    if (!this.running) return;
    const s = this.settings();
    const share = s.governor === false ? 0 : this.frozenShare;
    const off = Math.round(PERIOD_MS * share);
    if (off >= 5) {
      const t1 = setTimeout(() => {
        this.write(1);
        const t2 = setTimeout(() => { this.write(0); this.cycle(); }, off);
        this.timers.push(t2);
      }, PERIOD_MS - off);
      this.timers.push(t1);
    } else {
      if (this.frozen) this.write(0);
      this.timers.push(setTimeout(() => this.cycle(), PERIOD_MS));
    }
    // Keep the timer list from growing without bound.
    if (this.timers.length > 64) this.timers = this.timers.slice(-8);
  }

  /** Measure, then steer the frozen share toward the cap. */
  control() {
    const s = this.settings();
    this.temp = readTemp();

    let usec = null;
    try {
      const m = /usage_usec (\d+)/.exec(fs.readFileSync(path.join(this.cgroup, 'cpu.stat'), 'utf8'));
      usec = m ? Number(m[1]) : null;
    } catch { /* unit restarting */ }
    const now = Date.now();
    if (usec !== null && this.lastUsage) {
      const dt = (now - this.lastUsage.at) * 1000;
      this.usage = dt > 0 ? Math.max(0, (usec - this.lastUsage.usec) / dt) : 0;
    }
    if (usec !== null) this.lastUsage = { usec, at: now };

    if (s.governor === false) { this.frozenShare = 0; this.thermalScale = 1; return; }

    // Heat first: above the target the cap shrinks a little every second;
    // well below it, it grows back.
    const target = Number(s.tempTarget) || 80;
    if (this.temp !== null) {
      if (this.temp >= target) this.thermalScale = Math.max(0.15, this.thermalScale * 0.92);
      else if (this.temp <= target - 4) this.thermalScale = Math.min(1, this.thermalScale * 1.04);
    }

    const cap = this.cap();
    // Integral steering on the frozen share. The usage measured already
    // includes the freezing, so the share settles where usage meets the cap.
    const err = (this.usage - cap) / Math.max(cap, 0.5);
    this.frozenShare = Math.min(MAX_FROZEN, Math.max(0, this.frozenShare + 0.25 * err));
    if (this.usage < 0.2) this.frozenShare = Math.max(0, this.frozenShare - 0.1);
  }

  /** The CPU the sessions may use right now, in cores. */
  cap() {
    const s = this.settings();
    const pct = Math.max(10, Math.min(100, Number(s.cpuCapPct) || 60));
    return (pct / 100) * this.ncpu * this.thermalScale;
  }

  view() {
    return {
      active: this.running && this.settings().governor !== false,
      reason: this.running ? null : this.reason,
      threads: this.ncpu,
      usagePct: Math.round((this.usage / this.ncpu) * 100),
      capPct: Math.round((this.cap() / this.ncpu) * 100),
      frozenPct: Math.round(this.frozenShare * 100),
      temp: this.temp === null ? null : Math.round(this.temp),
      hot: this.thermalScale < 0.999,
    };
  }
}

module.exports = { Governor, readTemp };
