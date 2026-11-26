/**
 * The live channel: one session, pushed as it happens.
 *
 * The console used to poll the transcript every two to four seconds and read
 * the screen for everything else. Now a session being watched has one feed,
 * shared by every tab watching it:
 *
 *   hello     on connect: the session, the last 2 MB of its transcript as
 *             messages, and the byte offset they end at
 *   messages  new transcript lines, as they are written (fs.watch, with a
 *             one-second poll behind it), parsed the same way
 *   session   the session's state changed (a hook fired: a prompt was
 *             submitted, a question asked, permission wanted, a turn ended),
 *             with the structured prompt, the open tool call and the queue
 *   screen    the little the transcript and hooks cannot say, read off the
 *             terminal: the permission mode, Claude Code's suggested next
 *             message, words typed in its box but not sent, and a menu that
 *             no hook described (a plan or permission dialog's options, /model,
 *             a notice). Read every 1.5 s only while someone watches, and sent
 *             only when it changes.
 *   reset     the conversation moved to another file (a resume forked it)
 *   ping      every 20 s, so a page can tell a dead stream from a quiet one
 *
 * A subagent's transcript is served the same way, read only.
 */

const fs = require('fs');
const { Tail, toMessages, readRange } = require('./transcript');
const { parseScreen } = require('./screen');

const SNAPSHOT = 2 * 1024 * 1024;

class LiveFeeds {
  constructor({ sessions, tmux, log = () => {}, screenMs = 1500, pollMs = 1000 }) {
    this.sessions = sessions;
    this.tmux = tmux;
    this.log = log;
    this.screenMs = screenMs;
    this.pollMs = pollMs;
    this.feeds = new Map(); // key -> feed
    sessions.on('change', (s) => {
      const v = sessions.view(s);
      for (const f of this.feeds.values()) {
        if (f.sid !== s.id) continue;
        f.send('session', v);
        // A resume can fork the conversation into a new file.
        if (!f.agent && s.transcript && f.file && s.transcript !== f.file) this.rebase(f);
      }
    });
    sessions.on('removed', (id) => {
      for (const f of [...this.feeds.values()]) if (f.sid === id) { f.send('removed', { id }); this.close(f); }
    });
  }

  /** The transcript file a feed reads, or null while there is none yet. */
  fileOf(f) {
    const s = this.sessions.get(f.sid);
    if (!s || !this.sessions.hasTranscript(s)) return null;
    if (!f.agent) return s.transcript;
    return require('./transcript').subagentFile(s.transcript, f.agent);
  }

  /**
   * Subscribe a response to a session's feed. Sends `hello` with the tail of
   * the conversation up to exactly where the feed is, so nothing is drawn
   * twice or missed between the snapshot and the first `messages`.
   */
  attach(s, req, res, { agent = null } = {}) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);
    const key = `${s.id}:${agent || ''}`;
    let f = this.feeds.get(key);
    if (!f) { f = this.open(s, agent, key); this.feeds.set(key, f); }
    this.read(f); // catch up first, so the snapshot ends where the feed is
    const hello = { session: this.sessions.view(s), agent, file: !!f.file, cursor: 0, start: 0, truncated: false, messages: [] };
    if (f.file && f.tail) {
      const end = f.tail.offset - Buffer.byteLength(f.tail.partial);
      const r = readRange(f.file, Math.max(0, end - SNAPSHOT), end);
      hello.messages = toMessages(r.entries, { detail: true, sidechain: !!agent });
      hello.cursor = r.end;
      hello.start = r.start;
      hello.truncated = r.start > 0;
    }
    if (f.screen) hello.screen = f.screen;
    write(res, 'hello', hello);
    f.subs.add(res);
    const ping = setInterval(() => write(res, 'ping', Date.now()), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      f.subs.delete(res);
      if (!f.subs.size) this.close(f);
    });
  }

  open(s, agent, key) {
    const f = {
      key, sid: s.id, agent, file: null, tail: null, subs: new Set(), watcher: null, timer: null, screenTimer: null,
      screen: null, screenSig: '', reading: false, debounce: null,
      send: (event, data) => { for (const r of f.subs) write(r, event, data); },
    };
    this.bind(f);
    f.timer = setInterval(() => this.read(f), this.pollMs);
    if (!agent) this.watchScreen(f);
    return f;
  }

  /** Point the feed at its file, from its current end (hello covers what came before). */
  bind(f) {
    try { f.watcher?.close(); } catch { /* closed */ }
    f.watcher = null;
    f.file = this.fileOf(f);
    if (!f.file) { f.tail = null; return; }
    let size = 0;
    try { size = fs.statSync(f.file).size; } catch { /* just created */ }
    f.tail = new Tail(f.file, size);
    try {
      f.watcher = fs.watch(f.file, () => {
        clearTimeout(f.debounce);
        f.debounce = setTimeout(() => this.read(f), 30);
      });
      f.watcher.on('error', () => { /* the poll carries on */ });
    } catch { /* the poll carries on */ }
  }

  /** The conversation is in another file now: start over from it. */
  rebase(f) {
    this.bind(f);
    f.send('reset', { reason: 'The conversation moved to a new file (resumed or forked).' });
  }

  read(f) {
    if (f.reading) return;
    f.reading = true;
    try {
      if (!f.file) {
        // A new session writes its file at the first prompt.
        const file = this.fileOf(f);
        if (!file) return;
        f.file = file;
        f.tail = new Tail(file, 0);
        try { f.watcher = fs.watch(file, () => { clearTimeout(f.debounce); f.debounce = setTimeout(() => this.read(f), 30); }); } catch { /* poll */ }
      }
      const entries = f.tail.read();
      if (!entries.length) return;
      const messages = toMessages(entries, { detail: true, sidechain: !!f.agent });
      const cursor = f.tail.offset - Buffer.byteLength(f.tail.partial);
      // The session's own state (queue, open tools, errors, the model that
      // answered) follows the same lines, now rather than at the next tick.
      if (!f.agent) {
        const s = this.sessions.get(f.sid);
        if (s) { try { this.sessions.readTranscript(s); } catch (e) { this.log('live', e.message); } }
      }
      if (messages.length) f.send('messages', { messages, cursor });
      else f.send('cursor', { cursor });
    } catch (e) {
      this.log('live', `${f.key}: ${e.message}`);
    } finally {
      f.reading = false;
    }
  }

  /**
   * The screen, only for what nothing structured says. Skipped while the
   * runner itself is typing into the session (a queued message being taken
   * back), when the screen is mid-change.
   */
  watchScreen(f) {
    const run = async () => {
      const s = this.sessions.get(f.sid);
      if (!s || !f.subs.size) return;
      if (this.sessions.screenLocks?.has?.(s.id)) return;
      if (!this.sessions.alive.get(s.id)) {
        if (f.screen) { f.screen = null; f.screenSig = ''; f.send('screen', null); }
        return;
      }
      let scr;
      try { scr = parseScreen(await this.tmux.capture(s.tmux, { ansi: true })); } catch { return; }
      const next = {
        mode: scr.mode || null,
        suggestion: scr.suggestion || null,
        draft: scr.draft ? (scr.input || scr.draft) : null,
        // A menu only matters when no hook described what is being asked,
        // or a hook did but not its options (a plan or permission dialog).
        menu: scr.menu && s.prompt?.kind !== 'question' ? scr.menu : null,
      };
      const sig = JSON.stringify(next);
      if (sig === f.screenSig) return;
      f.screenSig = sig;
      f.screen = next;
      f.send('screen', next);
    };
    f.screenTimer = setInterval(() => { run().catch(() => {}); }, this.screenMs);
    run().catch(() => {});
  }

  close(f) {
    clearInterval(f.timer);
    clearInterval(f.screenTimer);
    clearTimeout(f.debounce);
    try { f.watcher?.close(); } catch { /* closed */ }
    for (const r of f.subs) { try { r.end(); } catch { /* gone */ } }
    f.subs.clear();
    this.feeds.delete(f.key);
  }

  closeAll() { for (const f of [...this.feeds.values()]) this.close(f); }

  /** How many feeds and subscribers, for /api/health. */
  stats() { return { feeds: this.feeds.size, watchers: [...this.feeds.values()].reduce((n, f) => n + f.subs.size, 0) }; }
}

function write(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}

module.exports = { LiveFeeds };
