/* ============================================================
   ojee-agent — the quick chat.

   What the console's Assistant button (and its `a` key) opens over
   the overview or the idle screen. The whole point is to be quicker
   than going anywhere: the box is focused the moment it appears,
   nothing has to be chosen first, Enter sends, and the answer
   streams in place.

     no conversation  a box, three things to ask, and the most
                      recent conversations to pick up again
     a conversation   the transcript — the same one the full view
                      draws — and the box under it

   Closing does not stop anything: the reply keeps going on HP, and
   reopening within a while lands back in the same conversation,
   still streaming if it still is. "Open in Assistant" takes the
   very same conversation into Agent → Assistant.

   The console keeps this mounted while it is hidden, and calls
   show() / hide() on what mountAssistantModal returns. A console
   that predates that contract calls the return value to stop it.
   ============================================================ */

import {
  el, pref, svg, mark, relTime, shortPath,
  S, on, connect, disconnect, loadConv,
  liveState, busy, dot, stateTag, sessionsSorted, titleOf, untitled,
  createSession, sendMessage, transcript, composer, modelMenu,
} from './assistant-core.js';

const RESUME_MS = 30 * 60 * 1000;

export async function mountAssistantModal(host, context) {
  connect(context);
  const ctx = context;
  let sid = null;
  let T = null;
  let off = null;

  const remember = (id) => { pref('ag-qc-sid', id ? JSON.stringify({ id, at: Date.now() }) : null); };
  const remembered = () => { try { return JSON.parse(pref('ag-qc-sid') || 'null'); } catch { return null; } };

  const title = el('span', { class: 'ag-qc-title' }, 'Assistant');
  const sub = el('span', { class: 'ag-qc-sub' });
  const btnNew = el('button', { class: 'iconbtn ag-qc-btn', type: 'button', title: 'New chat', 'aria-label': 'New chat', onclick: () => { setSession(null); C.focus(); } }, svg('plus'));
  const btnRecent = el('button', { class: 'iconbtn ag-qc-btn', type: 'button', title: 'Recent chats', 'aria-label': 'Recent chats', 'aria-expanded': 'false', onclick: () => toggleRecent() }, svg('list'));
  const btnOpen = el('button', { class: 'iconbtn ag-qc-btn', type: 'button', title: 'Open in Assistant', 'aria-label': 'Open in Assistant', onclick: () => openFull() }, svg('full'));
  const btnClose = el('button', { class: 'iconbtn ag-qc-btn', type: 'button', title: 'Close (Esc) — a reply keeps going', 'aria-label': 'Close', onclick: () => ctx.close?.() }, svg('close'));
  const head = el('header', { class: 'ag-qc-head' },
    el('span', { class: 'ag-qc-mark' }, mark('ic')),
    el('div', { class: 'ag-qc-names' }, title, sub),
    el('div', { class: 'ag-qc-actions' }, btnRecent, btnNew, btnOpen, btnClose));
  const body = el('div', { class: 'ag-qc-body' });
  const recentBox = el('div', { class: 'ag-qc-recent', hidden: true });

  const C = composer({
    sid: () => sid,
    placeholder: 'Ask the Assistant',
    escStops: false,
    storeKey: 'ag-qc-draft',
    onSend: async ({ text, model, agent }) => {
      if (!sid) {
        const s = await createSession({ source: 'quick', text, model: model || undefined, agent });
        if (s.sent && !s.sent.ok) throw new Error(s.sent.error);
        setSession(s.id);
        return;
      }
      await sendMessage(sid, { text, model, agent });
      remember(sid);
    },
  });

  const wrap = el('div', { class: 'ag-qc', role: 'document' }, head, recentBox, body, C.el);
  host.replaceChildren(wrap);

  /* ── the two states ─────────────────────────────────────────────── */

  function recentList(limit = 6) {
    const list = sessionsSorted().slice(0, limit);
    if (!list.length) return null;
    return el('div', { class: 'ag-qc-list' }, list.map((s) => {
      const st = liveState(s.id);
      return el('button', { class: 'ag-qc-item', type: 'button', onclick: () => { setSession(s.id); C.focus(); } },
        dot(st),
        el('span', { class: 'ag-qc-item-main' },
          el('span', { class: `ag-qc-item-t${untitled(s) ? ' is-untitled' : ''}` }, titleOf(s)),
          el('span', { class: 'ag-qc-item-s' }, [shortPath(s.directory), s.metadata?.source === 'quick' ? 'quick chat' : null].filter(Boolean).join(' · '))),
        st !== 'idle' ? stateTag(st) : null,
        el('span', { class: 'ag-qc-item-w' }, relTime(s.time?.updated)));
    }));
  }

  function hero() {
    const ask = (t) => { C.input.value = t; C.input.dispatchEvent(new Event('input')); C.focus(); };
    const recent = recentList();
    return el('div', { class: 'ag-qc-hero' },
      el('div', { class: 'ag-qc-sugg' }, ['CPU temps across the fleet?', 'What is the AC set to?', 'Is anything in the stack down?']
        .map((t) => el('button', { class: 'ag-as-chip ag-as-chip--btn', type: 'button', onclick: () => ask(t) }, t))),
      recent ? el('div', { class: 'ag-qc-recentwrap' }, el('div', { class: 'ag-qc-label' }, 'Pick up where you left off'), recent) : null);
  }

  function paintHead() {
    const s = sid ? S.sessions.get(sid) : null;
    title.textContent = s ? titleOf(s) : 'Assistant';
    title.classList.toggle('is-untitled', !!s && untitled(s));
    const st = s ? liveState(s.id) : null;
    sub.replaceChildren(...(s
      ? [st !== 'idle' ? stateTag(st) : null, el('span', {}, `on HP · ${shortPath(s.directory)}`)]
      : [el('span', {}, S.online === false ? 'OpenCode is not answering' : 'on HP · Enter sends · Esc closes')]).filter(Boolean));
    btnOpen.title = s ? 'Open this conversation in Agent → Assistant' : 'Open Agent → Assistant';
    btnNew.hidden = !s;
    wrap.classList.toggle('is-convo', !!s);
  }

  function setSession(id, { keepText = false } = {}) {
    T?.destroy(); T = null;
    sid = id;
    remember(id);
    hideRecent();
    if (id) {
      T = transcript(id, {
        empty: () => el('div', { class: 'ag-as-empty' }, el('p', {}, 'Nothing in this conversation yet.')),
        onPickModel: (anchor, pick) => modelMenu(anchor, null, pick),
      });
      body.replaceChildren(T.el);
      if (S.convs.get(id)?.loadedAt) loadConv(id, { quiet: true });
    } else {
      body.replaceChildren(hero());
    }
    if (keepText) { const t = C.input.value; C.reload(); if (t) { C.input.value = t; C.input.dispatchEvent(new Event('input')); } }
    else C.reload();
    paintHead();
  }

  /** A remembered chat that no longer exists (deleted elsewhere) gives way to a new one. */
  function dropIfGone() {
    if (sid && S.listed && !S.sessions.has(sid)) { setSession(null, { keepText: true }); return true; }
    return false;
  }

  function hideRecent() { recentBox.hidden = true; btnRecent.setAttribute('aria-expanded', 'false'); }
  function toggleRecent() {
    if (!recentBox.hidden) { hideRecent(); return; }
    recentBox.replaceChildren(el('div', { class: 'ag-qc-label' }, 'Recent'), recentList(12) || el('p', { class: 'meta' }, 'No conversations yet.'));
    recentBox.hidden = false;
    btnRecent.setAttribute('aria-expanded', 'true');
  }

  function openFull() {
    ctx.close?.();
    location.hash = `#/agent/assistant${sid ? `/${encodeURIComponent(sid)}` : ''}`;
  }

  off = on((what, id) => {
    if (what === 'removed' && id === sid) { setSession(null); return; }
    if (what === 'conv' && id === sid && S.convs.get(id)?.error && /no such/i.test(S.convs.get(id).error)) { S.sessions.delete(id); setSession(null, { keepText: true }); return; }
    if (what === 'sessions' && dropIfGone()) return;
    if (what === 'sessions' || what === 'upstream' || (what === 'session' && id === sid)) {
      paintHead();
      if (!sid && body.querySelector('.ag-qc-hero') && !body.contains(document.activeElement)) body.replaceChildren(hero());
    }
  });

  /** Where to land on opening: the last quick chat if it is live or recent. */
  function resumeTarget() {
    const r = remembered();
    if (!r?.id) return null;
    const s = S.sessions.get(r.id);
    if (S.listed && !s) return null;
    if (busy(r.id)) return r.id;
    const last = Math.max(r.at || 0, s?.time?.updated || 0);
    return Date.now() - last < RESUME_MS ? r.id : null;
  }

  setSession(resumeTarget());
  // The list may arrive after the first paint; a remembered chat that turns
  // out to be live then takes over the blank box, unless typing has begun.
  const once = on((what) => {
    if (what !== 'sessions' || !S.listed) return;
    once();
    if (dropIfGone()) return;
    if (!sid && !C.input.value) { const id = resumeTarget(); if (id) setSession(id); }
    else paintHead();
  });

  requestAnimationFrame(() => C.focus());

  const stop = () => { once(); off?.(); T?.destroy(); C.destroy(); disconnect(); };
  stop.show = () => {
    if (sid && dropIfGone()) { /* gone: a new chat */ }
    else if (!sid) { const id = resumeTarget(); if (id) setSession(id); else body.replaceChildren(hero()); }
    else { T?.toEnd(); paintHead(); }
    requestAnimationFrame(() => C.focus());
  };
  stop.hide = () => { hideRecent(); };
  stop.focus = () => C.focus();
  return stop;
}
