/* ============================================================
   The left column: sessions grouped by what they need (needs you,
   working, idle, ended), the accounts and their standing, and —
   only when something is wrong — the stack's health in one line.
   ============================================================ */

import { h, icon, swap, ago, clip, clock, pref, menu } from './dom.js';
import { S, allSessions, online, multi, devOf, devLabel, dataOf, offWhy, stateOf, acctLabel, modelLabel, go, api, post, act, upsert, curDev, setDev, toast } from './state.js';

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
  box.append(h('button', { class: 'grp fold cl-history', type: 'button', onclick: () => historySheet() }, icon('history', 's'), `Other conversations on ${multi() ? devLabel(curDev()) : 'this machine'}`));
  return box;
}

/** Accounts at a glance: standing, active, and a way to log one in. */
export function accountsPanel() {
  const dev = curDev();
  const accts = dataOf(dev)?.accounts || [];
  if (!accts.length) return null;
  const status = (a) => (a.status === 'needs-login' ? ['err', 'Needs login']
    : a.status === 'limited' ? ['warn', `Limited until ${clock(a.limitedUntil)}`]
      : a.status === 'unknown' ? [null, 'Not checked'] : ['ok', 'OK']);
  return h('section', { class: 'sec cl-accts' },
    h('div', { class: 'sh' }, h('h2', {}, 'Accounts'), h('span', { class: 'note' }, multi() ? devLabel(dev) : 'auto-switch ' + (dataOf(dev)?.settings?.autoSwitchAccounts ? 'on' : 'off')),
      h('div', { class: 'r' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => go('accounts', dev) }, 'Manage'))),
    h('div', { class: 'panel clip' }, accts.map((a) => {
      const [tone, text] = status(a);
      const models = Object.entries(a.modelLimits || {});
      return h('div', { class: `acct${a.active ? ' active' : ''}` },
        h('div', { class: 'nm m' }, a.label, a.active ? h('span', { class: 'tag acc', title: 'New sessions start on it' }, 'active') : null),
        a.status === 'needs-login'
          ? h('button', { class: 'btn sm', type: 'button', onclick: () => go('accounts', dev, a.id) }, icon('login', 's'), 'Log in')
          : h('span', { class: 'st' }, h('span', { class: 'dot', style: `--c:${tone ? `var(--${tone})` : 'var(--fg-3)'}` }), h('span', {}, text)),
        a.email || models.length ? h('div', { class: 'sub' }, [a.email, ...models.map(([f, u]) => `${f[0].toUpperCase()}${f.slice(1)} out until ${clock(u)}`)].filter(Boolean).join(' · ')) : null);
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

/** Every other conversation on a machine, to open (adopt) here. */
async function historySheet() {
  let dev = curDev();
  const bodyEl = h('div', { class: 'cl-hist' });
  const draw = async () => {
    bodyEl.replaceChildren(
      multi() ? h('div', { class: 'cl-filter' }, S.devs.map((d) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(d.id === dev), disabled: !d.online || null, onclick: () => { dev = d.id; setDev(d.id); draw(); } }, d.label))) : null,
      h('div', { class: 'sk', style: 'height:160px' }));
    if (!online(dev)) { bodyEl.lastChild.replaceWith(h('p', { class: 'dim' }, offWhy(devOf(dev)))); return; }
    let r;
    try { r = await api(dev, '/history'); } catch (e) { bodyEl.lastChild.replaceWith(h('p', { class: 'dim' }, e.message)); return; }
    const others = (r.sessions || []).filter((x) => !x.managed);
    bodyEl.lastChild.replaceWith(others.length ? h('div', { class: 'rows panel clip' }, others.map((x) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 't' }, clip(x.title || x.firstPrompt || x.id.slice(0, 8), 80)),
        h('div', { class: 'd m' }, [x.cwd ? x.cwd.replace(dataOf(dev)?.runner?.home || '\u0000', '~') : '?', ago(x.modified), x.runningElsewhere ? 'open in a terminal there' : null].filter(Boolean).join(' · '))),
      h('button', {
        class: 'btn sm', type: 'button', disabled: x.runningElsewhere || null, title: x.runningElsewhere ? 'Running in a terminal on that machine. Close it there first.' : 'Open it here: the same conversation, not a copy',
        onclick: async () => {
          const v = await act(`adopt:${x.id}`, () => post(dev, `/history/${x.id}/adopt`, {}));
          if (v) { upsert(dev, v); document.querySelector('#modal-root .modal-foot .btn')?.click(); go(v.id); }
        },
      }, 'Open')))) : h('p', { class: 'dim' }, 'Every conversation on this machine is already in the list.'));
  };
  const p = S.ctx.modal({ title: 'Other conversations', body: bodyEl, actions: [{ label: 'Close', value: false, variant: 'ghost' }] });
  document.querySelector('#modal-root .modal')?.classList.add('wide');
  draw();
  await p;
}
