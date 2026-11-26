/* ============================================================
   One session: its head (name, where it runs, what it is doing,
   what can be done to it) over its real terminal or its chat.

   Terminal-first: the terminal is the session itself (tmux,
   attached over a WebSocket); the chat is the same conversation
   read from its transcript and pushed live. Either is one tap
   away, and the choice is remembered.
   ============================================================ */

import { h, icon, swap, clip, clock, ago, tailPath, fine, touch, menu, closeMenu, pref, copyText, fmtSize, dur } from './dom.js';
import { S, api, post, patch, upsert, online, multi, devOf, devLabel, dataOf, offWhy, stateOf, models, modelLabel, acctLabel, shortPath, act, go, toast, allSessions, ask, dialog } from './state.js';
import { startTerminal } from './term.js';
import { createChat } from './chat.js';

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function createSessionView(s0, { onBack }) {
  let s = s0;
  const dev = s.device;
  const id = s.id;
  let pane = pref('cl-pane') === 'chat' ? 'chat' : 'terminal';
  // The key row: on a touch screen the terminal has it by default; the chat
  // has its cards and buttons, so it only shows when asked for. Remembered per view.
  const keysFor = (p) => { const v = pref(`cl-keys-${p}`); return v === null ? (p === 'terminal' && !fine()) : v === '1'; };
  let keysOn = keysFor(pane);
  let term = null;
  let termState = null;
  let termGen = 0;   // a new terminal: the head picks up its status line
  let chat = null;

  const head = h('header', { class: 'cl-svh' });
  const banner = h('div', { class: 'cl-banner', hidden: true });
  const body = h('div', { class: 'cl-body' });
  const el = h('section', { class: 'panel cl-sv', 'aria-label': s.title || 'Session', dataset: { session: id } }, head, banner, body);

  /* ── head ─────────────────────────────────────────────────────── */

  const alive = () => s.alive && online(dev);
  function primary() {
    const off = !online(dev);
    // In the chat the line above the box has Stop, where the eyes are.
    if (s.state === 'running' && !off && pane === 'chat') return null;
    if (s.state === 'running' && !off) return h('button', { class: 'btn sm', type: 'button', title: 'Stop this turn (Esc)', onclick: () => post(dev, `/sessions/${id}/interrupt`).catch((e) => toast('err', 'Could not stop it', e.message)) }, icon('pause', 's'), h('span', { class: 'lbl' }, 'Stop'));
    if ((!s.alive || s.state === 'paused') && s.state !== 'queued') {
      return h('button', { class: 'btn sm pri', type: 'button', disabled: off || S.busy.has(`resume:${id}`) || null, title: off ? offWhy(devOf(dev)) : 'Start Claude again in this conversation', onclick: () => resume() }, icon('play', 's'), h('span', { class: 'lbl' }, s.state === 'paused' ? 'Resume now' : 'Resume'));
    }
    return null;
  }
  function moreMenu(e) {
    const off = !online(dev);
    menu(e.currentTarget, [
      { label: 'Rename', icon: 'edit', run: () => rename() },
      { label: 'Model, account and pings', icon: 'sliders', disabled: off, run: () => change() },
      { label: 'Agents and background work', icon: 'layers', run: () => agentsDialog() },
      { sep: true },
      pane === 'terminal' ? { label: 'Copy from the terminal', icon: 'copy', disabled: !alive(), run: () => pickText() } : null,
      pane === 'terminal' ? { label: 'Reconnect the terminal', icon: 'refresh', disabled: !alive(), run: () => term?.reconnect() } : null,
      { label: keysOn ? 'Hide the key row' : 'Show the key row', icon: 'keyboard', run: () => setKeys(!keysOn) },
      fine() ? { label: S.root.classList.contains('max') ? 'Restore the layout' : 'Fill the window', icon: S.root.classList.contains('max') ? 'unfull' : 'full', run: () => setMax(!S.root.classList.contains('max')) } : null,
      { label: 'Open its folder', icon: 'folder', disabled: off, run: () => explore(dev, s.cwd, s.cwd) },
      { sep: true },
      alive() ? { label: 'End the session', icon: 'power', run: () => end() } : null,
      { label: 'Delete', icon: 'trash', danger: true, disabled: off, run: () => del() },
    ], { label: 'Session actions' });
  }
  function paintHead() {
    const st = stateOf(s);
    const fell = s.model?.current && s.model.preferred && s.model.current !== s.model.preferred;
    const sig = JSON.stringify([s.title, s.state, s.alive, online(dev), s.model, s.account, s.cwd, pane, S.busy.has(`resume:${id}`), multi(), termGen]);
    swap(head, sig, () => [
      h('button', { class: 'ib back', type: 'button', 'aria-label': 'All sessions', onclick: onBack }, icon('back', 'l')),
      h('div', { class: 'id' },
        h('button', { class: 'ttl', type: 'button', title: 'Rename', onclick: () => rename() }, h('span', { class: `dot${st.live ? ' live' : ''}`, style: `--c:${st.tone ? `var(--${st.tone})` : 'var(--fg-3)'}` }), h('span', { class: 'nm' }, s.title || id.slice(0, 8))),
        h('div', { class: 'meta m' },
          multi() ? h('span', {}, devLabel(dev)) : null,
          h('span', { title: 'Account' }, acctLabel(s.account, dev)),
          h('span', { title: fell ? `Fallback: ${modelLabel(s.model?.preferred)} ran out` : 'Model' }, modelLabel(s.model?.current), fell ? '*' : ''),
          h('a', { class: 'path', href: '#', title: `${s.cwd}\nOpen the folder`, onclick: (e) => { e.preventDefault(); explore(dev, s.cwd, s.cwd); } }, tailPath(shortPath(s.cwd, dev), 34)))),
      h('div', { class: 'r' },
        h('span', { class: `tag c st-word`, style: `--c:${st.tone ? `var(--${st.tone})` : 'var(--fg-3)'}` }, st.label),
        // The terminal not attached: Reconnecting… / Disconnected, with its
        // Reconnect button (term.js keeps it up to date; hidden when attached).
        pane === 'terminal' ? term?.statusEl : null,
        primary(),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
          h('button', { type: 'button', 'aria-pressed': String(pane === 'terminal'), title: 'Terminal', onclick: () => setPane('terminal') }, icon('term', 's'), h('span', { class: 'lbl' }, 'Terminal')),
          h('button', { type: 'button', 'aria-pressed': String(pane === 'chat'), title: 'Chat', onclick: () => setPane('chat') }, icon('msg', 's'), h('span', { class: 'lbl' }, 'Chat'))),
        h('button', { class: 'ib', type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: moreMenu }, icon('more'))),
    ]);
  }

  /** One line for what the terminal does not say itself: paused, blocked, an error, offline. */
  function paintBanner() {
    let tone = null; let text = null; let action = null;
    if (!online(dev)) { text = `${offWhy(devOf(dev))}. Shown as last seen; it carries on when the machine is back.`; }
    else if (pane === 'terminal') {
      if (s.state === 'paused') { tone = 'warn'; text = `${s.detail || 'Paused'}`; }
      else if (s.state === 'blocked') { tone = 'warn'; text = `Blocked: ${s.detail || ''}`; }
      else if (s.state === 'error') { tone = 'err'; text = s.detail || s.lastError?.text || 'Error'; }
      else if (s.state === 'waiting' && s.prompt) { tone = 'err'; text = s.prompt.kind === 'question' ? `Asking: ${s.prompt.questions?.[0]?.question || ''}` : s.prompt.kind === 'plan' ? 'Wants a plan approved' : `Wants to use ${s.prompt.tool || 'a tool'}`; action = h('button', { class: 'btn sm', type: 'button', onclick: () => setPane('chat') }, 'Answer in chat'); }
      else if (s.state === 'queued') { text = s.detail || 'Queued for a free slot'; }
    }
    banner.hidden = !text;
    swap(banner, JSON.stringify([tone, text]), () => (text ? [h('span', { class: 'dot', style: `--c:${tone ? `var(--${tone})` : 'var(--fg-3)'}` }), h('span', { class: 'tx' }, clip(text, 240)), action] : []));
  }

  /* ── panes ────────────────────────────────────────────────────── */

  function stopPane() {
    term?.teardown(); term = null;
    chat?.destroy(); chat = null;
  }
  function mountPane() {
    stopPane();
    el.classList.toggle('is-term', pane === 'terminal');
    el.classList.toggle('is-chat', pane === 'chat');
    if (pane === 'chat') {
      chat = createChat({
        session: s,
        keys: keysOn,
        onPath: (p) => explore(dev, p, s.cwd),
        onAgent: (toolUseId) => chat?.openAgentFor(toolUseId),
        onOpenAgents: () => agentsDialog(),
      });
      body.replaceChildren(chat.el);
      chat.focus();
      return;
    }
    if (!online(dev) || !s.alive) {
      body.replaceChildren(h('div', { class: 'empty cl-noterm' }, icon('term'),
        h('b', {}, !online(dev) ? `${devLabel(dev)} is offline` : s.state === 'paused' ? 'Paused' : 'Not running'),
        h('p', {}, !online(dev) ? 'The terminal comes back with the machine. Nothing is lost.'
          : s.state === 'paused' ? `It resumes on its own${s.pausedUntil ? ` at ${clock(s.pausedUntil)}` : ''}. Resume now tries sooner.`
            : 'The conversation is kept. Resume it to get the terminal back, or read it in Chat.'),
        online(dev) ? h('div', { class: 'btns' },
          h('button', { class: 'btn sm pri', type: 'button', onclick: () => resume() }, icon('play', 's'), s.state === 'paused' ? 'Resume now' : 'Resume'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => setPane('chat') }, icon('msg', 's'), 'Read it')) : null));
      return;
    }
    const host = h('div', { class: 'cl-termhost' });
    body.replaceChildren(host);
    termState = 'connecting';
    term = startTerminal({
      host,
      ctx: S.ctx,
      path: `/d/${encodeURIComponent(dev)}/sessions/${id}/terminal`,
      keys: keysOn,
      onImage: (file) => sendFiles([file]),
      onPick: () => pickText(),
      statusInHead: true,
      onState: (st) => { termState = st; el.dataset.term = st; if (st === 'connected' && fine()) term?.focus(); },
    });
    termGen++;
    paintHead();
  }
  function setPane(p) {
    if (p === pane) return;
    pane = p;
    pref('cl-pane', p);
    keysOn = keysFor(p);
    paintHead();
    paintBanner();
    mountPane();
  }
  function setKeys(on) {
    keysOn = on;
    pref(`cl-keys-${pane}`, on ? '1' : '0');
    if (term) term.toggleKeys(on);
    chat?.setKeys(on);
  }
  function setMax(on) {
    S.root.classList.toggle('max', on);
    pref('cl-max', on ? '1' : '0');
    paintHead();
  }

  async function sendFiles(files) {
    let done = 0;
    for (const file of files.filter(Boolean)) {
      const image = IMAGE_MIME.includes(file.type);
      try {
        await S.ctx.api(`/claude/d/${encodeURIComponent(dev)}/sessions/${id}/${image ? 'image' : 'file'}`, {
          method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', ...(image ? {} : { 'x-file-name': encodeURIComponent(file.name || '') }) }, body: file,
        });
        done++;
      } catch (e) { toast('err', `Could not attach ${file.name || 'the file'}`, e.message); }
    }
    if (done) toast('ok', done === 1 ? 'Attached' : `${done} files attached`, 'Add your message in the terminal and press Enter.');
    term?.focus();
  }

  /* ── actions ──────────────────────────────────────────────────── */

  async function resume() {
    const v = await act(`resume:${id}`, () => post(dev, `/sessions/${id}/resume`, {}), 'Resuming');
    if (v) { upsert(dev, v); update(v); }
  }

  async function rename() {
    const input = h('input', { class: 'input', value: s.title || '', maxlength: '70', 'aria-label': 'Title' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.closest('.sheet, .modal')?.querySelector('.sheet-f .btn:last-child, .modal-foot .btn:last-child')?.click(); } });
    const ok = await ask({ title: 'Rename session', body: h('div', { class: 'field' }, input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Rename', value: true, variant: 'primary' }] });
    if (!ok || !input.value.trim()) return;
    const v = await act(`rename:${id}`, () => patch(dev, `/sessions/${id}`, { title: input.value.trim() }));
    if (v) { upsert(dev, v); update(v); S.paint('session'); }
  }

  async function end() {
    const ok = await ask({ title: 'End this session?', body: h('p', {}, 'Claude stops. The conversation is kept and can be resumed.'), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'End session', value: true, variant: 'primary' }] });
    if (!ok) return;
    const v = await act(`end:${id}`, () => post(dev, `/sessions/${id}/end`));
    if (v) { upsert(dev, v); update(v); S.paint('session'); }
  }

  async function del() {
    const purge = h('input', { type: 'checkbox' });
    const ok = await ask({
      title: 'Delete this session?',
      body: h('div', { class: 'stack' }, h('p', {}, 'It is ended and removed from the list.'),
        h('label', { class: 'cl-check' }, purge, h('span', {}, 'Also delete the conversation itself. This cannot be undone.'))),
      actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Delete', value: true, variant: 'danger solid' }],
    });
    if (!ok) return;
    const r = await act(`del:${id}`, () => api(dev, `/sessions/${id}${purge.checked ? '?purge=1' : ''}`, { method: 'DELETE' }), 'Deleted');
    if (r) { const x = dataOf(dev); if (x) x.sessions = x.sessions.filter((y) => y.id !== id); go(); }
  }

  async function change() {
    const sel = (opts, value) => { const x = h('select', { class: 'select' }, opts.map(([v, l]) => h('option', { value: v }, l))); x.value = value ?? ''; return x; };
    const ms = models(dev).map((m) => [m.id, m.label]);
    const model = sel(ms, s.model?.preferred);
    const fallback = sel([['', 'None'], ...ms], s.model?.fallback || '');
    const account = sel((dataOf(dev)?.accounts || []).filter((a) => a.status !== 'off' || a.id === s.account).map((a) => [a.id, `${a.label}${a.status !== 'ok' ? ` (${a.status === 'limited' ? `out until ${clock(a.limitedUntil)}` : a.status === 'needs-login' ? 'needs login' : a.status})` : ''}`]), s.account);
    const doneSet = dataOf(dev)?.settings?.notify?.done;
    const done = sel([['default', `As in settings (${doneSet ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']], s.notifyDone === true ? 'on' : s.notifyDone === false ? 'off' : 'default');
    const nudges = h('input', { class: 'input num', type: 'number', min: '0', max: '10', value: String(s.autoContinue || 0), inputmode: 'numeric' });
    const ok = await ask({
      title: 'Model, account and pings',
      body: h('div', { class: 'cl-form' },
        h('div', { class: 'field' }, h('label', {}, 'Model'), model),
        h('div', { class: 'field' }, h('label', {}, 'Fallback when it runs out'), fallback),
        h('div', { class: 'field' }, h('label', {}, 'Account'), account),
        h('div', { class: 'field' }, h('label', {}, 'Ping when done'), done),
        h('div', { class: 'field' }, h('label', {}, 'Nudge to continue'), h('div', { class: 'cl-inline' }, nudges, h('span', { class: 'unit' }, 'times, when a turn ends without DONE or BLOCKED'))),
        s.alive ? h('p', { class: 'dim' }, 'A different model or account restarts Claude and resumes this conversation.') : null),
      actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true, variant: 'primary' }],
    });
    if (!ok) return;
    await act(`change:${id}`, async () => {
      const body2 = { model: { preferred: model.value, fallback: fallback.value || null }, notifyDone: done.value === 'on' ? true : done.value === 'off' ? false : null, autoContinue: Number(nudges.value) || 0 };
      const moveModel = model.value !== s.model?.current;
      const moveAcct = account.value !== s.account;
      if (!s.alive && moveAcct) body2.account = account.value;
      let v = await patch(dev, `/sessions/${id}`, body2);
      if ((moveModel || moveAcct) && s.alive) v = await post(dev, `/sessions/${id}/relaunch`, { model: moveModel ? model.value : undefined, account: moveAcct ? account.value : undefined });
      upsert(dev, v); update(v); S.paint('session');
    }, 'Saved');
  }

  /** Sessions to hop to, then this one's subagents, background commands and schedules. */
  async function agentsDialog() {
    const bodyEl = h('div', { class: 'cl-bg' });
    let closeIt = null;
    const draw = () => {
      const work = (chat?.backgroundWork?.() || []).slice().reverse();
      const others = allSessions().filter((x) => x.state !== 'stopped');
      const row = (w) => h('div', { class: 'row' },
        h('span', { class: `dot${w.status === 'running' ? ' live' : ''}`, style: `--c:var(--${w.status === 'running' ? 'ok' : w.status === 'failed' ? 'err' : 'fg-3'})` }),
        h('div', { class: 'grow' }, h('div', { class: 't' }, clip(w.name, 90)),
          h('div', { class: 'd' }, [{ agent: 'Subagent', shell: 'Command', monitor: 'Monitor', schedule: 'Schedule' }[w.kind], w.status, w.started ? `started ${clock(w.started)}` : null,
            w.status === 'running' && w.started ? `for ${dur(Date.now() - w.started)}` : w.ended && w.started ? `took ${dur(w.ended - w.started)}` : null].filter(Boolean).join(' · ')),
          w.summary && w.status !== 'running' ? h('div', { class: 'd' }, clip(w.summary, 200)) : null),
        h('div', { class: 'btns' },
          w.kind === 'agent' && w.agentId ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { closeIt(); if (pane !== 'chat') setPane('chat'); setTimeout(() => chat?.viewAgent(w.agentId), 50); } }, 'Read') : null,
          w.outputFile ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => explore(dev, w.outputFile, s.cwd) }, 'Output') : null,
          pane === 'chat' ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { closeIt(); chat?.reveal(w.id); } }, 'In chat') : null));
      bodyEl.replaceChildren(
        h('div', { class: 'sh' }, h('h2', {}, 'Sessions'), h('span', { class: 'cnt' }, String(others.length))),
        h('div', { class: 'rows panel clip' }, others.map((x) => {
          const st = stateOf(x);
          return h('button', { class: `row${x.id === id ? ' cur' : ''}`, type: 'button', onclick: () => { closeIt(); if (x.id !== id) go(x.id); } },
            h('span', { class: `dot${st.live ? ' live' : ''}`, style: `--c:${st.tone ? `var(--${st.tone})` : 'var(--fg-3)'}` }),
            h('div', { class: 'grow' }, h('div', { class: 't' }, x.title), h('div', { class: 'd' }, [multi() ? devLabel(x.device) : null, st.label, x.lastActivityAt ? ago(x.lastActivityAt) : null].filter(Boolean).join(' · '))),
            x.id === id ? h('span', { class: 'dim' }, 'open') : icon('chev', 's'));
        })),
        h('div', { class: 'sh' }, h('h2', {}, 'This session’s background work')),
        pane !== 'chat' || !chat ? h('p', { class: 'dim' }, 'Open Chat to list its subagents, background commands and schedules.')
          : work.length ? h('div', { class: 'rows panel clip' }, work.map(row)) : h('p', { class: 'dim' }, 'Nothing ran in the background in the loaded part of the conversation.'));
    };
    draw();
    const t = setInterval(draw, 3000);
    const sh = await dialog({ title: 'Agents and background work', body: bodyEl, width: 560 });
    closeIt = () => sh.close();
    await sh.done;
    clearInterval(t);
  }

  /** The terminal as text in a sheet, where a phone's own selection handles work. */
  async function pickText() {
    const preEl = h('pre', { class: 'cl-picktext m', tabindex: '0' }, 'Loading…');
    const note = h('span', { class: 'dim' }, 'Select, then copy. Links open on a tap.');
    let text = '';
    const keepSel = (e) => e.preventDefault();
    const copyBtn = (label, get) => h('button', { class: 'btn sm', type: 'button', onpointerdown: keepSel, onmousedown: keepSel, onclick: async () => { const t = get(); if (!t) { note.textContent = 'Nothing selected yet.'; return; } note.textContent = (await copyText(t)) ? `Copied ${t.length} characters.` : 'The browser refused the clipboard.'; } }, icon('copy', 's'), label);
    const bodyEl = h('div', { class: 'stack' }, preEl, h('div', { class: 'btns' },
      copyBtn('Copy selection', () => { const sel = window.getSelection(); return sel && preEl.contains(sel.anchorNode) ? sel.toString() : ''; }),
      copyBtn('Copy all', () => text), note));
    const p = ask({ title: 'Copy from the terminal', body: bodyEl, width: 720 });
    try { text = String((await api(dev, `/sessions/${id}/screen?history=3000`)).screen || ''); } catch { text = term?.bufferText() || ''; }
    text = text.replace(/\s+$/, '');
    const URLS = /https?:\/\/[^\s<>"'`│┃]+[^\s<>"'`│┃.,;:!?)\]]/g;
    const parts = []; let last = 0;
    for (const m of text.matchAll(URLS)) { if (m.index > last) parts.push(text.slice(last, m.index)); parts.push(h('a', { href: m[0], target: '_blank', rel: 'noreferrer noopener' }, m[0])); last = m.index + m[0].length; }
    parts.push(text.slice(last));
    preEl.replaceChildren(...(text ? parts : ['(the terminal is empty)']));
    requestAnimationFrame(() => { preEl.scrollTop = preEl.scrollHeight; });
    await p;
  }

  /* ── typing anywhere goes to the session ──────────────────────── */

  const typeAnywhere = (e) => {
    if (!el.isConnected || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.key.length !== 1) return;
    const a = document.activeElement;
    if (a && a !== document.body && (a.closest('input, textarea, select, [contenteditable]') || a.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop, .sheet.on, .cmdk-bg, .cl-menu')) return;
    if (!fine()) return;
    if (pane === 'terminal' && term) term.focus();
    else if (pane === 'chat' && chat) chat.input.focus();
  };
  window.addEventListener('keydown', typeAnywhere, true);

  /* ── lifecycle ────────────────────────────────────────────────── */

  function update(next) {
    if (!next || next.id !== id) return;
    const was = `${s.alive}:${online(dev)}`;
    s = next;
    el.setAttribute('aria-label', s.title || 'Session');
    paintHead();
    paintBanner();
    chat?.update(s);
    // Came back (resumed, relaunched, its machine woke): the terminal
    // returns; gone: the card says why.
    if (pane === 'terminal' && was !== `${s.alive}:${online(dev)}`) mountPane();
  }

  if (pref('cl-max') === '1' && fine()) S.root.classList.add('max');
  paintHead();
  paintBanner();
  mountPane();

  return {
    el,
    id,
    update,
    destroy() {
      window.removeEventListener('keydown', typeAnywhere, true);
      closeMenu();
      stopPane();
      S.root?.classList.remove('max');
    },
  };
}

/**
 * The explorer: a folder or file on the session's machine, opened from any
 * path in the view. Folders list and open; a text file shows its first 512 KB;
 * an image shows itself. Read only; every path can be copied.
 */
export async function explore(dev, p, cwd) {
  const home = dataOf(dev)?.runner?.home;
  let start = String(p || '').trim().replace(/[),.;:'"`]+$/, '');
  const at = /^(.*?):(\d+)(?::\d+)?$/.exec(start);
  let line = null;
  if (at && !/^[a-z]+$/i.test(at[1])) { start = at[1]; line = Number(at[2]); }
  if (start.startsWith('~') && home) start = home + start.slice(1);
  if (!start.startsWith('/') && cwd) start = `${cwd.replace(/\/$/, '')}/${start.replace(/^\.\//, '')}`;
  const headEl = h('div', { class: 'cl-ex-h' });
  const bodyEl = h('div', { class: 'cl-ex-b' });
  let blobUrl = null;
  const parentOf = (x) => (x === '/' ? null : x.replace(/\/[^/]*\/?$/, '') || '/');
  const rawUrl = (x) => `${S.ctx.base}/api/claude/d/${encodeURIComponent(dev)}/fs/file?raw=1&path=${encodeURIComponent(x)}`;
  const header = (x, isFile) => {
    const up = parentOf(x);
    headEl.replaceChildren(h('div', { class: 'm path', title: x }, x), h('div', { class: 'btns' },
      h('button', { class: 'btn ghost sm', type: 'button', onclick: async (e) => { e.currentTarget.textContent = (await copyText(x)) ? 'Copied' : 'Copy failed'; } }, icon('copy', 's'), 'Copy path'),
      up ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => open(up) }, icon('up', 's'), isFile ? 'Its folder' : 'Up') : null,
      isFile ? h('a', { class: 'btn ghost sm', href: rawUrl(x), target: '_blank', rel: 'noopener' }, icon('external', 's'), 'Raw') : null));
  };
  const fail = (x, msg) => { header(x, false); bodyEl.replaceChildren(h('div', { class: 'empty' }, icon('warn'), h('b', {}, 'Cannot open this'), h('p', {}, msg))); };
  async function listDir(x) {
    let r;
    try { r = await api(dev, `/fs?files=1&hidden=1&path=${encodeURIComponent(x)}`); } catch (e) { fail(x, e.message); return; }
    header(r.path, false);
    bodyEl.replaceChildren((r.entries || []).length
      ? h('div', { class: 'rows' }, r.entries.map((e) => h('button', { class: `row cl-ex-row${e.hidden ? ' dimmed' : ''}`, type: 'button', onclick: () => open(e.path) },
        icon(e.file ? 'file' : 'folder', 's'), h('span', { class: 'grow' }, e.name), h('span', { class: 'm dim' }, e.file ? (e.size != null ? fmtSize(e.size) : '') : e.git ? 'git' : ''))))
      : h('p', { class: 'dim' }, 'An empty folder.'));
  }
  async function open(x) {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    bodyEl.replaceChildren(h('div', { class: 'sk', style: 'height:120px' }));
    let r;
    try { r = await api(dev, `/fs/file?path=${encodeURIComponent(x)}`); } catch (e) { fail(x, e.message); return; }
    if (r.dir) { await listDir(r.path); return; }
    header(r.path, true);
    const meta = h('p', { class: 'dim' }, [fmtSize(r.size || 0), r.mtime ? `changed ${ago(r.mtime)} ago` : null, r.truncated ? 'first 512 KB shown' : null].filter(Boolean).join(' · '));
    if (r.kind === 'image') {
      const img = h('img', { class: 'cl-ex-img', alt: r.path });
      bodyEl.replaceChildren(meta, img);
      try { const res = await fetch(rawUrl(r.path), { credentials: 'same-origin' }); blobUrl = URL.createObjectURL(await res.blob()); img.src = blobUrl; } catch (e) { bodyEl.append(h('p', { class: 'dim' }, e.message)); }
      return;
    }
    if (r.kind !== 'text') { bodyEl.replaceChildren(meta, h('p', { class: 'dim' }, 'Not text: open it raw.')); return; }
    const ls = String(r.text || '').split('\n');
    const preEl = h('pre', { class: 'cl-ex-pre m' }, ls.map((l, i) => h('span', { class: `ln${line === i + 1 ? ' hit' : ''}` }, h('span', { class: 'no' }, String(i + 1)), `${l}\n`)));
    bodyEl.replaceChildren(meta, preEl);
    if (line) requestAnimationFrame(() => preEl.querySelector('.hit')?.scrollIntoView({ block: 'center' }));
  }
  const p2 = ask({ title: 'Files', body: h('div', { class: 'cl-ex' }, headEl, bodyEl), width: 720 });
  open(start);
  await p2;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
}
