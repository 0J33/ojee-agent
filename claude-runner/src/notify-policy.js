/**
 * The console's notification policy, the parts the runner needs to apply on
 * its own: a copy of ojee-console src/notify/policy.js (effective + quiet
 * hours), CommonJS. The runner keeps sending its own Discord pings — so they
 * arrive when the console box is down — and these are the choices made in
 * the console's Settings → Notifications, pushed here through the Agent module.
 */

const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};

function localMinutes(now, tz) {
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

function inQuiet(quiet, now, tz) {
  if (!quiet || !quiet.on) return false;
  const a = toMin(quiet.from); const b = toMin(quiet.to);
  if (a === null || b === null || a === b) return false;
  const m = localMinutes(now, tz);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

module.exports = { toMin, inQuiet, localMinutes };
