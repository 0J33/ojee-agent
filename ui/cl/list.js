/* ============================================================
   The left column: sessions grouped by what they need (needs you,
   working, idle, ended), the accounts and their standing, and —
   only when something is wrong — the stack's health in one line.
   ============================================================ */

import { h, icon, swap, ago, clip, clock, pref, menu } from './dom.js';
import { S, allSessions, online, multi, devOf, devLabel, dataOf, offWhy, stateOf, acctLabel, modelLabel, go, api, post, act, upsert, curDev, setDev, toast, ask, dialog } from './state.js';

const GROUPS = [['needs', 'Needs you'], ['working', 'Working'], ['idle', 'Idle'], ['ended', 'Ended']];

/** What a session's second line says: where, then what it is doing or asked. */
function line(s) {
  const st = stateOf(s);
  const where = [multi() ? devLabel(s.device) : null, acctLabel(s.account, s.device)].filter(Boolean).join(' · ');
  let what = '';
  if (st.off) what = 'offline';
  else if (s.state === 'waiting') what = s.prompt?.kind === 'question' ? `Asking: ${s.prompt.questions?.[0]?.question || ''}` : s.prompt?.kind === 'permission' ? `Wants ${s.prompt.tool || 'a tool'}` : s.prompt?.kind === 'plan' ? 'Wants a plan approved' : s.question?.text || 'Waiting for you';
  else if (s.state === 'running') what = s.activity ? `${s.activity.tool}: ${s.activity.text?.replace(/^[^:]+: ?/, '') || ''}` : s.background ? 'Background work' : 'Thinking';
  else if (s.state === 'paused') what = s.detail || 'Paused';
  else if (['blocked', 'error', 'done', 'starting', 'queued'].includes(s.state)) what = s.detail || st.label;
  else if (s.state === 'stopped') what = s.detail || 'Ended';
  else what = s.lastAssistant ? clip(s.lastAssistant.split('\n').filter(Boolean).pop().replace(/\*\*|`+|^#+\s*/g, ''), 120) : 'Idle';
  return `${where}${what ? ` · ${what}` : ''}`;
}

export function sessionRow(s, current) {
  const st = stateOf(s);
  return h('a', {
    class: `sess${s.id === current ? ' cur' : ''}${st.off ? ' off' : ''}`,
    href: `#${location.hash.replace(/^#/, '').split('/claude')[0]}/claude/${s.id}`,
    'aria-current': s.id === current ? 'true' : null,
    onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(s.id); },
  },
  h('span', { class: `dot${st.live ? ' live' : ''}`, style: `--c:${st.tone ? `var(--${st.tone})` : 'var(--fg-3)'}` }),
  h('span', { class: 'nm' }, s.title || s.id.slice(0, 8)),
  h('span', { class: 'ctx m' }, ago(s.lastActivityAt)),
  h('span', { class: 'ds' }, clip(line(s), 140)));
}

export function sessionsPanel(current) {
  const all = allSessions();
  if (S.filter !== 'all' && !devOf(S.filter)) S.filter = 'all';
  const shown = multi() && S.filter !== 'all' ? all.filter((s) => s.device === S.filter) : all;
  const groups = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const s of shown) groups[stateOf(s).group].push(s);
  const endedOpen = pref('cl-ended') === '1';
  const box = h('div', { class: 'panel clip cl-list' });
  if (multi()) {
    box.append(h('div', { class: 'cl-filter', role: 'group', 'aria-label': 'Show sessions on' },
      [['all', 'All'], ...S.devs.map((d) => [d.id, d.label])].map(([id, label]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(S.filter === id),
        title: id !== 'all' ? offWhy(devOf(id)) || `Only ${label}` : null,
        onclick: () => { S.filter = id; pref('cl-filter', id); S.paint(); },
      }, id !== 'all' ? h('span', { class: 'dot', style: `--c:var(--${online(id) ? 'ok' : 'fg-3'})` }) : null, label))));
  }
  let any = false;
  for (const [k, label] of GROUPS) {
    const list = groups[k];
    if (!list.length) continue;
    any = true;
    if (k === 'ended') {
      box.append(h('button', { class: 'grp fold', type: 'button', 'aria-expanded': String(endedOpen), onclick: () => { pref('cl-ended', endedOpen ? '0' : '1'); S.paint(); } },
        icon(endedOpen ? 'chevdown' : 'chev', 's'), label, h('span', { class: 'm' }, String(list.length))));
      if (endedOpen) box.append(...list.slice(0, 40).map((s) => sessionRow(s, current)));
      continue;
    }
    box.append(h('div', { class: `grp${k === 'needs' ? ' needs' : ''}` }, label, h('span', { class: 'm' }, String(list.length))), ...list.map((s) => sessionRow(s, current)));
  }
  if (!any) {
    box.append(h('div', { class: 'empty' }, icon('term'), h('b', {}, 'No sessions yet'),
      h('p', {}, `Start one in any folder on ${S.devs?.filter((d) => d.data).map((d) => d.label).join(' or ') || 'this machine'}. It runs unattended and asks you when it needs you.`),
      h('button', { class: 'btn sm pri', type: 'button', onclick: () => go('new') }, icon('plus', 's'), 'New session')));
  }
  const off = (S.devs || []).filter((d) => !d.online);
  if (off.length) box.append(h('div', { class: 'cl-offline' }, off.map((d) => h('span', {}, h('span', { class: 'dot' }), offWhy(d)))));
  const hs = historyScope();
  box.append(h('button', { class: 'grp fold cl-history', type: 'button', onclick: () => historySheet() }, icon('history', 's'), `Other conversations on ${!multi() ? 'this machine' : hs === 'all' ? 'all devices' : devLabel(hs)}`));
  return box;
}

/** Accounts at a glance: standing, active, and a way to log one in. */
export function accountsPanel() {
  const dev = curDev();
  const accts = dataOf(dev)?.accounts || [];
  if (!accts.length) return null;
  const status = (a) => (a.status === 'off' ? [null, 'Off']
    : a.status === 'needs-login' ? ['err', 'Needs login']
    : a.status === 'limited' ? ['warn', `Limited until ${clock(a.limitedUntil)}`]
      : a.status === 'unknown' ? [null, 'Not checked'] : ['ok', 'OK']);
  return h('section', { class: 'sec cl-accts' },
    h('div', { class: 'sh' }, h('h2', {}, 'Accounts'), h('span', { class: 'note' }, multi() ? devLabel(dev) : 'auto-switch ' + (dataOf(dev)?.settings?.autoSwitchAccounts ? 'on' : 'off')),
      h('div', { class: 'r' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('accounts', dev) }, 'Manage'))),
    h('div', { class: 'panel clip' }, accts.map((a) => {
      const [tone, text] = status(a);
      const models = Object.entries(a.modelLimits || {});
      return h('div', { class: `acct${a.active ? ' active' : ''}${a.status === 'off' ? ' off' : ''}` },
        h('div', { class: 'nm m' }, a.label, a.active ? h('span', { class: 'tag acc', title: 'New sessions start on it' }, 'active') : null),
        a.status === 'needs-login'
          ? h('button', { class: 'btn sm', type: 'button', onclick: () => go('accounts', dev, a.id) }, icon('login', 's'), 'Log in')
          : h('span', { class: 'st' }, h('span', { class: 'dot', style: `--c:${tone ? `var(--${tone})` : 'var(--fg-3)'}` }), h('span', {}, text)),
        a.status !== 'off' && (a.email || models.length) ? h('div', { class: 'sub' }, [a.email, ...models.map(([f, u]) => `${f[0].toUpperCase()}${f.slice(1)} out until ${clock(u)}`)].filter(Boolean).join(' · ')) : null);
    })));
}

/** The stack's containers, only when one is down: one line, a quiet Restart. */
export function stackLine() {
  const down = S.stack?.down || [];
  if (!down.length) return null;
  return h('div', { class: 'cl-stack', role: 'status' }, down.map((sv) => h('div', { class: 'ln' },
    h('span', { class: 'dot', style: '--c:var(--err)' }),
    h('span', { class: 'tx' }, h('b', {}, sv.name), ` stopped${sv.since ? ` · ${ago(sv.since)}` : ''}`),
    h('button', {
      class: 'btn ghost sm', type: 'button', disabled: S.busy.has(`svc:${sv.id}`) || null,
      onclick: async () => {
        const r = await act(`svc:${sv.id}`, () => S.ctx.api(`/services/${sv.id}/restart`, { method: 'POST' }), `${sv.name} restarted`);
        if (r) S.stack = await S.ctx.api('/stack').catch(() => S.stack);
        S.paint();
      },
    }, 'Restart'))));
}

/** Where "Other conversations" looks: the list's device filter, or all of them. */
function historyScope() {
  if (!multi()) return curDev();
  return S.filter !== 'all' && devOf(S.filter) ? S.filter : 'all';
}

/** "Deleted" with Undo: a toast that stays a little longer than a plain one. */
function undoToast(title, detail, onUndo) {
  const node = toast('info', title, detail, { ms: 8000 });
  if (!(node instanceof Element)) return;
  const btn = h('button', { class: 'btn sm', type: 'button' }, 'Undo');
  btn.addEventListener('click', () => { node.classList.add('out'); setTimeout(() => node.remove(), 200); onUndo(); }, { once: true });
  (node.querySelector('.toast-txt') || node).append(h('div', { class: 'a' }, btn));
}

/** The confirm, over the sheet: the console's modal when there is one, else a sheet. */
async function confirmDelete({ x, dev }) {
  const body = h('div', { class: 'cl-del' },
    h('b', { class: 't' }, clip(x.title || x.firstPrompt || x.id.slice(0, 8), 120)),
    x.title && x.firstPrompt ? h('p', { class: 'q' }, clip(x.firstPrompt, 160)) : null,
    h('p', { class: 'd m' }, [multi() ? devLabel(dev) : null, shortHome(x.cwd, dev), ago(x.modified)].filter(Boolean).join(' · ')),
    h('p', { class: 'dim' }, `Its transcript${x.size ? ` (${size(x.size)})` : ''} and any subagent logs go to the trash on ${devLabel(dev) || 'this machine'} for 7 days.`));
  const actions = [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Delete', value: true, variant: 'danger solid' }];
  if (S.ctx.modal) return !!(await S.ctx.modal({ title: 'Delete this conversation?', body, actions }));
  return !!(await ask({ title: 'Delete this conversation?', body, actions }));
}

const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const shortHome = (p, dev) => (p ? p.replace(dataOf(dev)?.runner?.home || '\u0000', '~') : '?');

/**
 * Every other conversation on a machine — or, with the list showing every
 * device, on all of them, merged newest first — to open (adopt) here or
 * delete. A device that is away is said so, and never holds up the others.
 */
async function historySheet() {
  let scope = historyScope();
  let items = [];        // [{ dev, x }] newest first
  let away = [];         // [{ dev, why }]
  let sheet = null;
  let gen = 0;
  const bodyEl = h('div', { class: 'cl-hist' });
  const chipsEl = h('div', { class: 'cl-filter', role: 'group', 'aria-label': 'Conversations on' });
  const noteEl = h('div', { class: 'cl-hist-away' });
  const listEl = h('div');

  const paintChips = () => chipsEl.replaceChildren(...[['all', 'All'], ...S.devs.map((d) => [d.id, d.label])].map(([id, label]) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(scope === id),
    title: id !== 'all' ? offWhy(devOf(id)) || `Only ${label}` : null,
    onclick: () => { if (scope === id) return; scope = id; if (id !== 'all') setDev(id); load(); },
  }, id !== 'all' ? h('span', { class: 'dot', style: `--c:var(--${online(id) ? 'ok' : 'fg-3'})` }) : null, label)));

  const paintAway = () => noteEl.replaceChildren(...away.map((a) => h('div', { class: 'ln' }, h('span', { class: 'dot', style: '--c:var(--fg-3)' }), h('span', {}, a.why))));

  const row = ({ dev, x }) => {
    const running = x.runningElsewhere;
    const meta = [shortHome(x.cwd, dev), ago(x.modified), running ? 'open in a terminal there' : null].filter(Boolean).join(' · ');
    return h('div', { class: 'row', dataset: { key: `${dev}:${x.id}` } },
      h('div', { class: 'grow' },
        h('div', { class: 't' }, clip(x.title || x.firstPrompt || x.id.slice(0, 8), 80)),
        h('div', { class: 'd m' }, multi() && scope === 'all' ? h('span', { class: 'tag' }, devLabel(dev)) : null, meta)),
      h('div', { class: 'acts' },
        h('button', {
          class: 'btn ghost sm cl-hist-del', type: 'button', disabled: running || null,
          title: running ? 'Running in a terminal on that machine. Close it there first.' : `Delete it from ${devLabel(dev) || 'this machine'} (kept in the trash for 7 days)`,
          'aria-label': 'Delete', onclick: () => remove({ dev, x }),
        }, icon('trash', 's'), h('span', { class: 'lbl' }, 'Delete')),
        h('button', {
          class: 'btn sm', type: 'button', disabled: running || null, title: running ? 'Running in a terminal on that machine. Close it there first.' : 'Open it here: the same conversation, not a copy',
          onclick: async () => {
            const v = await act(`adopt:${x.id}`, () => post(dev, `/history/${x.id}/adopt`, {}));
            if (v) { upsert(dev, v); sheet?.close(); go(v.id); }
          },
        }, 'Open')));
  };

  const paintList = () => {
    if (!items.length) {
      listEl.replaceChildren(...(away.length && scope !== 'all' ? [] : [h('p', { class: 'dim' }, `Every conversation on ${scope === 'all' ? 'these machines' : 'this machine'} is already in the list.`)]));
      return;
    }
    listEl.replaceChildren(h('div', { class: 'rows panel clip' }, items.map(row)));
  };

  const load = async () => {
    const my = ++gen;
    paintChips();
    away = [];
    paintAway();
    listEl.replaceChildren(h('div', { class: 'sk', style: 'height:160px' }));
    const devs = scope === 'all' ? S.devs.map((d) => d.id) : [scope];
    const got = await Promise.all(devs.map(async (dev) => {
      if (!online(dev)) return { dev, why: offWhy(devOf(dev)) };
      try { return { dev, list: (await api(dev, '/history')).sessions || [] }; } catch (e) { return { dev, why: `${devLabel(dev)}: ${e.message}` }; }
    }));
    if (my !== gen) return;
    away = got.filter((g) => g.why).map((g) => ({ dev: g.dev, why: g.why }));
    items = got.filter((g) => g.list).flatMap((g) => g.list.filter((x) => !x.managed).map((x) => ({ dev: g.dev, x })))
      .sort((a, b) => (b.x.modified || 0) - (a.x.modified || 0));
    paintAway();
    paintList();
  };

  /** Optimistic: the row goes now, comes back if the runner says no. */
  async function remove(it) {
    if (!(await confirmDelete(it))) return;
    const key = `${it.dev}:${it.x.id}`;
    const same = (y) => y.dev === it.dev && y.x.id === it.x.id;
    const at = items.findIndex(same);
    const el = listEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
    items = items.filter((y) => !same(y));
    const settle = () => paintList();
    if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) { el.classList.add('gone'); setTimeout(settle, 160); } else settle();
    const name = clip(it.x.title || it.x.firstPrompt || it.x.id.slice(0, 8), 60);
    try {
      await api(it.dev, `/history/${encodeURIComponent(it.x.id)}${it.x.project ? `?project=${encodeURIComponent(it.x.project)}` : ''}`, { method: 'DELETE' });
    } catch (e) {
      putBack(it, at);
      toast('err', 'Not deleted', e.message);
      return;
    }
    undoToast('Conversation deleted', multi() ? `${name} · ${devLabel(it.dev)}` : name, async () => {
      try {
        await post(it.dev, `/history/${encodeURIComponent(it.x.id)}/restore`, {});
        putBack(it, at);
        toast('ok', 'Restored', name);
      } catch (e) { toast('err', 'Could not restore it', e.message); }
    });
  }

  function putBack(it, at) {
    if (items.some((y) => y.dev === it.dev && y.x.id === it.x.id)) return;
    items.splice(Math.min(Math.max(at, 0), items.length), 0, it);
    items.sort((a, b) => (b.x.modified || 0) - (a.x.modified || 0));
    paintList();
  }

  if (multi()) bodyEl.append(chipsEl);
  bodyEl.append(noteEl, listEl);
  sheet = await dialog({ title: 'Other conversations', sub: 'Open one here to resume it: the same conversation, not a copy', body: bodyEl, width: 640 });
  load();
  await sheet.done;
  gen++;
}
