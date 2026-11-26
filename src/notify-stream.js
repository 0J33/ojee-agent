/**
 * The module's notification stream: GET /api/events, which the console (and
 * its phone app) subscribes to and turns `notify` events into inbox items,
 * toasts and pushes.
 *
 * It used to live inside src/assistant.js, so switching the Assistant off
 * would have taken Claude's alerts with it. Every sender now writes here:
 * the Claude runners (relayed by server.js), the Forsa work messages
 * (src/work-legacy.js) and the Assistant when it is on.
 *
 * Each event: { id: '<alert kind>', key: '<stable key>', title, body,
 * severity, blocking, route, at }. `key` names the thing the alert is about
 * (module + kind + subject: `agent.claude-needs-input:hp:<session>`), never
 * its words, so a number that changes updates the same inbox item instead
 * of raising a new one. `tag` is kept as an alias for older consoles.
 *
 * Kept for half an hour so a console that reconnects with ?since= catches up
 * on what it missed, and nothing older replays.
 */

const RECENT_MS = 30 * 60_000;
const recent = [];
const streams = new Set();
const routers = new Set();
let routerGoneAt = Date.now();
const extras = [];

function emit(n) {
  const ev = { ...n };
  if (!ev.key && ev.tag) ev.key = ev.tag;
  if (!ev.tag && ev.key) ev.tag = ev.key;
  ev.at = ev.at || Date.now();
  recent.push(ev);
  while (recent.length > 100 || (recent.length && Date.now() - recent[0].at > RECENT_MS)) recent.shift();
  const frame = `event: notify\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of streams) { try { res.write(frame); } catch { /* closed */ } }
  return ev;
}

/** A console has been listening within the last two minutes (it routes Discord itself). */
const routed = () => routers.size > 0 || Date.now() - routerGoneAt < 120_000;

/** Called when a stream connects, e.g. to start an upstream it relays. */
const onConnect = (fn) => extras.push(fn);

function mount(app, auth) {
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    const since = Number(req.query.since);
    if (since > 0) {
      for (const n of recent) if (n.at > since && Date.now() - n.at < RECENT_MS) res.write(`event: notify\ndata: ${JSON.stringify(n)}\n\n`);
    }
    streams.add(res);
    if (req.query.router === '1') routers.add(res);
    for (const fn of extras) { try { fn(); } catch { /* a relay that cannot start must not break the stream */ } }
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      streams.delete(res);
      if (routers.delete(res) && !routers.size) routerGoneAt = Date.now();
    });
  });
}

module.exports = { emit, mount, routed, onConnect, recent: () => recent.slice() };
