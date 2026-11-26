/* ============================================================
   New session, Accounts and Settings: the three places that are
   forms. Each is per device (its folders, its logins, its
   settings); with more than one device, a switch at the top.
   ============================================================ */

import { h, icon, swap, clip, clock, ago, pref, tailPath } from './dom.js';
import { S, api, post, put, patch, upsert, online, multi, devOf, devLabel, dataOf, offWhy, models, shortPath, act, go, toast, curDev, setDev, ask, dialog } from './state.js';
import { startTerminal } from './term.js';

const sel = (opts, value, attrs = {}) => { const x = h('select', { class: 'select', ...attrs }, opts.map(([v, l]) => h('option', { value: v }, l))); x.value = value ?? ''; return x; };
const field = (label, ctl, help, attrs = {}) => h('div', { class: 'field', ...attrs }, h('label', {}, label), ctl, help ? h('span', { class: 'help dim' }, help) : null);
const sw = (on, onchange, label) => {
  const b = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label });
  b.addEventListener('click', () => { const next = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(next)); onchange(next); });
  return b;
};

/** Which device a form is for: a segmented switch, only with more than one. */
function devSwitch(value, onpick, { needData = true } = {}) {
  if (!multi()) return null;
  return h('div', { class: 'cl-filter', role: 'group', 'aria-label': 'Device' }, S.devs.map((d) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(value === d.id), disabled: (needData && (!d.online || !d.data)) || null,
    title: offWhy(d) || `On ${d.label}`, onclick: () => onpick(d.id),
  }, h('span', { class: 'dot', style: `--c:var(--${d.online ? 'ok' : 'fg-3'})` }), d.label)));
}

const formHead = (title, sub, onBack) => h('header', { class: 'cl-fh' },
  h('button', { class: 'ib back', type: 'button', 'aria-label': 'Back', onclick: onBack }, icon('back', 'l')),
  h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'dim' }, sub) : null));

const offline = (d) => h('div', { class: 'empty' }, icon('cloud'), h('b', {}, d ? (d.sleeps ? `${d.label} is offline` : `${d.label} is not answering`) : 'No device'), h('p', {}, offWhy(d) || ''),
  h('button', { class: 'btn sm', type: 'button', onclick: () => S.reload?.() }, icon('refresh', 's'), 'Check again'));

/* ── new session ──────────────────────────────────────────────────── */

export function createNewSession({ onBack }) {
  const usable = (id) => online(id) && dataOf(id);
  const last = pref('cl-newdev');
  let dev = last && usable(last) ? last : (S.devs.find((d) => usable(d.id)) || S.devs.find((d) => d.data) || S.devs[0])?.id;
  const F = { prompt: '', title: '', notifyDone: 'default', autoContinue: 0, unattended: null, cwd: '', model: null, fallback: null, account: null };
  let fs = null;
  let hidden = false;
  let busy = false;
  const el = h('section', { class: 'cl-form-page cl-new' });

  const resetDev = () => {
    const x = dataOf(dev) || {};
    const set = x.settings || {};
    F.cwd = x.runner?.defaultCwd || '';
    F.model = set.defaultModel; F.fallback = set.fallbackModel || ''; F.account = set.activeAccount;
    if (F.unattended == null) F.unattended = set.unattended !== false;
    fs = null;
  };

  async function browse(p) {
    const q = new URLSearchParams();
    if (p) q.set('path', p);
    if (hidden) q.set('hidden', '1');
    const want = dev;
    let next;
    try { next = await api(dev, `/fs?${q}`); } catch (e) { next = { ...(fs || {}), error: e.message }; }
    if (want !== dev) return;
    fs = next;
    if (fs.path && !fs.error) F.cwd = fs.path;
    paintBrowser();
  }

  const cwdIn = h('input', { class: 'input m cl-cwd', placeholder: '/path/to/project', spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off', enterkeyhint: 'go' });
  cwdIn.addEventListener('input', () => { F.cwd = cwdIn.value; });
  cwdIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); browse(cwdIn.value); } });
  const browser = h('div', { class: 'cl-browser' });

  function paintBrowser() {
    if (!fs) { browser.replaceChildren(h('div', { class: 'sk', style: 'height:180px' })); return; }
    if (fs.path && document.activeElement !== cwdIn) cwdIn.value = fs.path;
    const parts = (fs.path || '').split('/').filter(Boolean);
    const crumbs = [h('button', { class: 'crumb', type: 'button', onclick: () => browse('/') }, '/')];
    let acc = '';
    parts.forEach((p, i) => { acc += `/${p}`; const t = acc; crumbs.push(h('button', { class: 'crumb', type: 'button', 'aria-current': i === parts.length - 1 ? 'location' : null, onclick: () => browse(t) }, p)); });
    browser.replaceChildren(...[
      h('div', { class: 'cl-crumbs m' }, crumbs),
      h('div', { class: 'cl-bbar' },
        h('button', { class: 'btn ghost sm', type: 'button', disabled: !fs.parent || null, onclick: () => browse(fs.parent) }, icon('up', 's'), 'Up'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => browse(fs.home) }, icon('house', 's'), 'Home'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => mkdir() }, icon('plus', 's'), 'New folder'),
        h('label', { class: 'cl-check' }, h('input', { type: 'checkbox', checked: hidden, onchange: (e) => { hidden = e.target.checked; browse(fs.path); } }), h('span', {}, 'Hidden'))),
      fs.error ? h('p', { class: 'err' }, fs.error) : null,
      h('div', { class: 'cl-dirs' }, (fs.entries || []).length
        ? fs.entries.map((d) => h('button', { class: 'dir', type: 'button', title: d.path, onclick: () => browse(d.path) }, icon('folder', 's'), h('span', {}, d.name), d.git ? h('span', { class: 'tag' }, 'git') : null))
        : h('p', { class: 'dim' }, 'No folders here. Start the session here, or make one.')),
      (fs.recent || []).length ? h('div', { class: 'cl-recent' }, h('span', { class: 'dim' }, 'Recent'), fs.recent.map((r) => h('button', { class: 'chip', type: 'button', title: r, onclick: () => browse(r) }, tailPath(shortPath(r, dev), 32)))) : null].filter(Boolean));
  }

  async function mkdir() {
    const input = h('input', { class: 'input', placeholder: 'folder name', autocapitalize: 'none' });
    const ok = await ask({ title: `New folder in ${shortPath(fs.path, dev)}`, body: field('Name', input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Create', value: true, variant: 'primary' }] });
    const name = input.value.trim();
    if (!ok || !name) return;
    const r = await act('mkdir', () => post(dev, '/fs/mkdir', { path: name.startsWith('/') ? name : `${fs.path.replace(/\/$/, '')}/${name}` }));
    if (r) browse(r.path);
  }

  async function create() {
    if (!F.cwd) { toast('warn', 'Pick a folder first'); return; }
    if (!online(dev)) { toast('warn', `${devLabel(dev)} is offline`, 'Pick another device.'); return; }
    busy = true; paint();
    const v = await act('create', () => post(dev, '/sessions', {
      cwd: F.cwd, prompt: F.prompt, title: F.title, model: F.model, fallback: F.fallback || null, account: F.account,
      unattended: F.unattended, autoContinue: Number(F.autoContinue) || 0, notifyDone: F.notifyDone === 'on' ? true : F.notifyDone === 'off' ? false : null,
    }));
    busy = false;
    if (v) { pref('cl-newdev', dev); upsert(dev, v); pref('cl-pane', 'terminal'); go(v.id); } else paint();
  }

  function paint() {
    if (!dev || !dataOf(dev)) { el.replaceChildren(formHead('New session', null, onBack), offline(devOf(dev))); return; }
    const set = dataOf(dev).settings || {};
    const prompt = h('textarea', { class: 'textarea cl-prompt', rows: '6', placeholder: 'What should Claude do? It runs unattended: say what done looks like.' });
    prompt.value = F.prompt;
    prompt.addEventListener('input', () => { F.prompt = prompt.value; });
    prompt.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); } });
    const title = h('input', { class: 'input', value: F.title, maxlength: '70', placeholder: 'Named after the prompt if empty' });
    title.addEventListener('input', () => { F.title = title.value; });
    const ms = models(dev).map((m) => [m.id, m.label]);
    const bind = (k) => (e) => { F[k] = e.target.value; };
    const opts = h('details', { class: 'cl-opts' },
      h('summary', {}, icon('sliders', 's'), 'Model, account and options', h('span', { class: 'dim m' }, `${ms.find(([v]) => v === F.model)?.[1] || ''} · ${(dataOf(dev).accounts || []).find((a) => a.id === F.account)?.label || ''}`)),
      h('div', { class: 'cl-grid2' },
        field('Model', sel(ms, F.model, { onchange: bind('model') })),
        field('Fallback when it runs out', sel([['', 'None'], ...ms], F.fallback, { onchange: bind('fallback') })),
        field('Account', sel((dataOf(dev).accounts || []).filter((a) => a.status !== 'off' || a.id === F.account).map((a) => [a.id, `${a.label}${a.status !== 'ok' ? ` (${a.status === 'limited' ? `out until ${clock(a.limitedUntil)}` : a.status === 'needs-login' ? 'needs login' : a.status})` : ''}`]), F.account, { onchange: bind('account') })),
        field('Ping when done', sel([['default', `As in settings (${set.notify?.done ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']], F.notifyDone, { onchange: bind('notifyDone') })),
        field('Nudge to continue', h('div', { class: 'cl-inline' }, h('input', { class: 'input num', type: 'number', min: '0', max: '10', value: String(F.autoContinue), inputmode: 'numeric', oninput: bind('autoContinue') }), h('span', { class: 'unit' }, 'times without DONE/BLOCKED')))),
      h('div', { class: 'set' }, h('div', { class: 't' }, 'Unattended instructions'), h('div', { class: 'd' }, 'Decide instead of asking, and end with DONE: or BLOCKED:'), h('div', { class: 'ctrl' }, sw(F.unattended, (v) => { F.unattended = v; }, 'Unattended instructions'))));
    el.replaceChildren(
      formHead('New session', multi() ? 'Where it runs decides its folders, accounts and settings.' : 'Runs unattended with bypass permissions, in any folder.', onBack),
      h('div', { class: 'cl-form-body' },
        devSwitch(dev, (id) => { if (id === dev) return; dev = id; resetDev(); paint(); browse(F.cwd || undefined); }),
        field('Task', prompt, 'Leave it empty to open an idle session and work in its terminal.'),
        h('div', { class: 'field' }, h('label', {}, multi() ? `Folder on ${devLabel(dev)}` : 'Folder'), h('div', { class: 'cl-inline' }, cwdIn, h('button', { class: 'btn sm', type: 'button', onclick: () => browse(cwdIn.value) }, 'Go')), browser),
        field('Title', title),
        opts),
      h('footer', { class: 'cl-form-foot' },
        h('span', { class: 'dim' }, 'It asks you through the console when it needs you.'),
        h('button', { class: 'btn pri', type: 'button', disabled: busy || null, onclick: create }, busy ? h('span', { class: 'spin' }) : icon('play', 's'), busy ? 'Starting…' : 'Start session')));
    cwdIn.value = F.cwd;
    paintBrowser();
    requestAnimationFrame(() => { if (window.matchMedia('(pointer: fine)').matches) prompt.focus(); });
  }

  resetDev();
  paint();
  browse(F.cwd || undefined);
  return {
    el,
    update(reason) { if (reason === 'device' && (!dev || !dataOf(dev))) { resetDev(); paint(); browse(); } },
    destroy() {},
  };
}

/* ── accounts ─────────────────────────────────────────────────────── */

export function createAccounts({ dev: dev0, acct, onBack }) {
  let dev = dev0 && devOf(dev0) ? dev0 : curDev();
  let login = null; // { id, state, timer, term, showTerm, codeEl }
  const el = h('section', { class: 'cl-form-page cl-accounts' });
  const listHost = h('div', { class: 'rows' });
  const loginHost = h('div', { class: 'cl-login-host' });

  const status = (a) => (a.status === 'off' ? [null, 'Off · not used, not checked']
    : a.status === 'needs-login' ? ['err', a.limitText ? `Needs login: ${a.limitText}` : 'Needs login']
    : a.status === 'limited' ? ['warn', `Limited until ${clock(a.limitedUntil)}${a.limitWindow === 'five_hour' ? ' (5-hour)' : a.limitWindow === 'seven_day' ? ' (weekly)' : ''}`]
      : a.status === 'unknown' ? [null, a.authError || 'Not checked yet'] : ['ok', 'Available']);

  function row(a) {
    const [tone, text] = status(a);
    const models2 = Object.entries(a.modelLimits || {});
    const off = a.status === 'off';
    return h('div', { class: `row cl-arow${a.active ? ' active' : ''}${off ? ' off' : ''}` },
      h('span', { class: 'dot', style: `--c:${tone ? `var(--${tone})` : 'var(--fg-3)'}` }),
      h('div', { class: 'grow' },
        h('div', { class: 't' }, h('span', { class: 'm' }, a.label), a.active ? h('span', { class: 'tag acc' }, 'active') : null, off ? h('span', { class: 'tag' }, 'Off') : null),
        h('div', { class: 'd' }, text, !off && models2.length ? ` · ${models2.map(([f, u]) => `${f[0].toUpperCase()}${f.slice(1)} out until ${clock(u)}`).join(', ')}` : ''),
        h('div', { class: 'd m' }, [a.email, a.plan ? a.plan.toUpperCase() : null, a.main ? '~/.claude' : tailPath(shortPath(a.dir, dev), 36)].filter(Boolean).join(' · '))),
      h('div', { class: 'btns' },
        !a.active && !off ? h('button', { class: 'btn sm', type: 'button', onclick: () => activate(a) }, 'Make active') : null,
        !off ? h('button', { class: `btn sm${a.status === 'needs-login' ? ' pri' : ' ghost'}`, type: 'button', onclick: () => startLogin(a) }, icon('login', 's'), a.loggedIn ? 'Log in again' : 'Log in') : null,
        h('button', { class: 'ib sm', type: 'button', 'aria-label': `More for ${a.label}`, onclick: () => more(a) }, icon('more', 's')),
        h('label', { class: 'cl-acct-on', title: off ? 'Turn on: used and checked again' : 'Turn off: kept, but never used or checked' },
          h('span', { class: 'lb' }, 'Enabled'), sw(!off, (v) => setEnabled(a, v), `${a.label} enabled`))));
  }

  /**
   * Turn an account on or off. Off: it stays listed, nothing uses it, it is
   * not checked and raises no alerts; its sessions move to the active account.
   * Turning off the active one first asks which account takes over.
   */
  async function setEnabled(a, on) {
    const accts = dataOf(dev)?.accounts || [];
    const repaint = () => paint();
    if (on) {
      const r = await act(`en:${a.id}`, () => post(dev, `/accounts/${a.id}/enabled`, { enabled: true }));
      if (r) { upsertAcct(r.account); toast('ok', `${a.label} is on`, 'Checking its login'); }
      return repaint();
    }
    const others = accts.filter((x) => x.id !== a.id && x.status !== 'off');
    if (!others.length) { toast('warn', 'At least one account has to stay on'); return repaint(); }
    const using = (dataOf(dev)?.sessions || []).filter((s) => s.account === a.id && !['stopped', 'done'].includes(s.state)).length;
    let switchTo;
    if (a.active) {
      const best = others.find((x) => x.status === 'ok') || others[0];
      const pickEl = h('select', { class: 'select' }, others.map((x) => h('option', { value: x.id }, `${x.label}${x.status !== 'ok' ? ` (${x.status === 'limited' ? `out until ${clock(x.limitedUntil)}` : x.status === 'needs-login' ? 'needs login' : x.status})` : ''}`)));
      pickEl.value = best.id;
      const ok = await ask({
        title: `Turn off ${a.label}?`,
        body: h('div', { class: 'stack' },
          h('p', {}, `${a.label} is the active account. Pick the one new sessions start on instead.`),
          field('Make active', pickEl),
          h('p', { class: 'dim' }, using ? `${using} session${using === 1 ? '' : 's'} on ${a.label} move there too: idle ones now, working ones when their turn ends.` : 'It stays in the list, is never used and is not checked until you turn it back on.')),
        actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Turn off', value: true, variant: 'primary' }],
      });
      if (!ok) return repaint();
      switchTo = pickEl.value;
    } else if (using) {
      const act0 = accts.find((x) => x.active);
      const ok = await ask({
        title: `Turn off ${a.label}?`,
        body: h('p', {}, `${using} session${using === 1 ? '' : 's'} on it move to ${act0?.label || 'the active account'}: idle ones now, working ones when their turn ends.`),
        actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Turn off', value: true, variant: 'primary' }],
      });
      if (!ok) return repaint();
    }
    const r = await act(`en:${a.id}`, () => post(dev, `/accounts/${a.id}/enabled`, { enabled: false, ...(switchTo ? { switchTo } : {}) }));
    if (r) {
      upsertAcct(r.account);
      if (r.active) for (const x of dataOf(dev)?.accounts || []) x.active = x.id === r.active;
      toast('ok', `${a.label} is off`, r.moved ? `${r.moved} session${r.moved === 1 ? '' : 's'} moving` : '');
    }
    repaint();
  }
  function upsertAcct(x) {
    const d = dataOf(dev);
    if (!x || !d?.accounts) return;
    d.accounts = d.accounts.map((y) => (y.id === x.id ? { ...y, ...x } : y));
  }

  function paint(reason) {
    const d = devOf(dev);
    if (!d?.online || !d.data) {
      if (reason) return;
      el.replaceChildren(formHead('Accounts', null, onBack), h('div', { class: 'cl-form-body' }, devSwitch(dev, pick), offline(d)));
      return;
    }
    const { accounts = [], settings = {} } = d.data;
    listHost.replaceChildren(...accounts.map(row));
    if (reason && el.contains(listHost)) { el.querySelector('.cl-autosw')?.setAttribute('aria-checked', String(!!settings.autoSwitchAccounts)); return; }
    const label = h('input', { class: 'input', placeholder: 'A name, e.g. Second', maxlength: '40' });
    label.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const add = async () => {
      const name = label.value.trim();
      if (!name) return;
      const a = await act('add-acct', () => post(dev, '/accounts', { label: name }));
      if (a) { d.data.accounts = [...d.data.accounts.filter((x) => x.id !== a.id), a]; label.value = ''; paint(); startLogin(a); }
    };
    el.replaceChildren(
      formHead(multi() ? `Accounts on ${d.label}` : 'Accounts', 'Claude subscription logins. No API keys.', onBack),
      h('div', { class: 'cl-form-body' },
        devSwitch(dev, pick),
        h('div', { class: 'panel clip' }, listHost),
        loginHost,
        h('div', { class: 'panel clip' },
          h('div', { class: 'set' }, h('div', { class: 't' }, 'Auto-switch accounts'), h('div', { class: 'd' }, 'When one runs out, sessions move to the next available account in this order and carry on. Off, they pause until it resets.'),
            h('div', { class: 'ctrl' }, (() => { const b = sw(settings.autoSwitchAccounts, (v) => saveSettings(dev, { autoSwitchAccounts: v })); b.classList.add('cl-autosw'); return b; })())),
          accounts.some((x) => x.main) ? null : h('div', { class: 'set' }, h('div', { class: 't' }, 'This machine\'s own login'), h('div', { class: 'd' }, 'The ~/.claude login was removed from this list. Add it back to use it again.'),
            h('div', { class: 'ctrl' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              const m = await act('add-main', () => post(dev, '/accounts', { main: true }));
              if (m) { d.data.accounts = [...d.data.accounts.filter((x) => x.id !== m.id), m]; paint(); }
            } }, 'Add this machine\'s own login'))),
          h('div', { class: 'set cl-addacct' }, h('div', { class: 't' }, 'Add an account'), h('div', { class: 'd' }, 'Gets its own login folder; history, settings and CLAUDE.md stay shared, so any session can continue on it.'),
            h('div', { class: 'cl-inline' }, label, h('button', { class: 'btn sm', type: 'button', onclick: add }, 'Add and log in'))))));
    paintLogin();
  }
  function pick(id) { dev = id; setDev(id); stopLogin(); go('accounts', id); }

  async function activate(a) {
    const move = h('input', { type: 'checkbox', checked: a.status === 'ok' });
    const ok = await ask({
      title: `Make ${a.label} active?`,
      body: h('div', { class: 'stack' }, h('p', {}, 'New sessions start on it.'),
        a.status !== 'ok' ? h('p', { class: 'err' }, a.status === 'needs-login' ? `${a.label} is not logged in: sessions on it will stop until it is. Log it in first.` : `${a.label} is out until ${clock(a.limitedUntil)}.`) : null,
        h('label', { class: 'cl-check' }, move, h('span', {}, 'Move the others too: idle ones now, working ones when their turn ends'))),
      actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Make active', value: true, variant: 'primary' }],
    });
    if (!ok) return;
    const r = await act(`activate:${a.id}`, () => post(dev, `/accounts/${a.id}/activate`, { move: move.checked }));
    if (r) toast('ok', `${a.label} is active`, r.moved ? `${r.moved} session${r.moved === 1 ? '' : 's'} moving` : '');
  }

  async function more(a) {
    const choice = await ask({
      title: a.label,
      body: h('p', {}, a.main ? `${multi() ? devLabel(dev) : 'This machine'}'s own ~/.claude login.` : `Login folder: ${a.dir}`),
      actions: [{ label: 'Check login', value: 'refresh', variant: 'ghost' }, { label: 'Forget limits', value: 'clear', variant: 'ghost' }, { label: 'Rename', value: 'rename', variant: 'ghost' }, { label: 'Remove', value: 'remove', variant: 'danger' }],
    });
    if (choice === 'refresh') await act(`r:${a.id}`, () => post(dev, `/accounts/${a.id}/refresh`), 'Checked');
    else if (choice === 'clear') await act(`c:${a.id}`, () => post(dev, `/accounts/${a.id}/clear-limits`), 'Limits forgotten');
    else if (choice === 'rename') {
      const input = h('input', { class: 'input', value: a.label, maxlength: '40' });
      if (await ask({ title: 'Rename account', body: field('Name', input), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Save', value: true, variant: 'primary' }] })) await act(`n:${a.id}`, () => patch(dev, `/accounts/${a.id}`, { label: input.value }));
    } else if (choice === 'remove') {
      const why = a.main
        ? `This is ${multi() ? devLabel(dev) : 'this machine'}'s own ~/.claude login. Removing it only takes it out of this list: the login stays in ~/.claude, and "Add this machine's own login" below brings it back.`
        : `Its login folder stays on disk (${a.dir}); delete it by hand to remove the login itself.`;
      if (await ask({ title: `Remove ${a.label}?`, body: h('p', {}, why), actions: [{ label: 'Cancel', value: false, variant: 'ghost' }, { label: 'Remove', value: true, variant: 'danger solid' }] })) {
        const r = await act(`rm:${a.id}`, () => api(dev, `/accounts/${a.id}`, { method: 'DELETE' }), 'Removed');
        if (r) { const x = dataOf(dev); if (x) x.accounts = x.accounts.filter((y) => y.id !== a.id); paint(); }
      }
    }
  }

  /* logging in: the sign-in link and a box for the code, the terminal one tap away */
  async function startLogin(a) {
    const r = await act(`login:${a.id}`, () => post(dev, `/accounts/${a.id}/login`));
    if (!r) return;
    stopLogin();
    login = { id: a.id, dev, state: null, timer: null, term: null, showTerm: false, codeEl: null };
    paintLogin();
    poll();
    loginHost.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  function stopLogin() { if (!login) return; clearTimeout(login.timer); login.term?.teardown(); login = null; loginHost.replaceChildren(); }
  async function poll() {
    if (!login) return;
    const L = login;
    try { L.state = await api(L.dev, `/accounts/${L.id}/login`); } catch (e) { L.state = { error: e.message }; }
    if (login !== L) return;
    paintLogin(true);
    if (L.state?.running && !L.state?.finished) L.timer = setTimeout(poll, 2000);
  }
  function paintLogin(update) {
    if (!login) { loginHost.replaceChildren(); return; }
    const L = login;
    const a = dataOf(L.dev)?.accounts?.find((x) => x.id === L.id);
    const st = L.state || {};
    if (!L.codeEl) {
      L.codeEl = h('input', { class: 'input m', placeholder: 'Paste the code from the sign-in page', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off' });
      L.codeEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    }
    const submit = async () => {
      if (!L.codeEl.value.trim()) return;
      const ok = await act('code', () => post(L.dev, `/accounts/${L.id}/login/code`, { code: L.codeEl.value.trim() }), 'Code sent');
      if (ok) { L.codeEl.value = ''; poll(); }
    };
    const status = !L.state ? 'Starting the login…' : st.finished ? 'Logged in.' : st.failed ? `Login failed: ${st.error}. Start again and paste the whole code (with the part after #).`
      : st.error ? `Could not read the login: ${st.error}` : !st.running ? 'The login window has closed.'
        : st.url ? (st.wantsCode ? 'Open the sign-in page, approve, then paste the whole code it shows.' : 'Open the sign-in page and approve.') : 'Waiting for the sign-in link…';
    const hadFocus = document.activeElement === L.codeEl;
    const termHost = update && L.term ? loginHost.querySelector('.cl-login-term') : h('div', { class: 'cl-login-term' });
    loginHost.replaceChildren(h('div', { class: 'panel cl-login' },
      h('div', { class: 'sh' }, h('h2', {}, `Log in · ${a?.label || L.id}`), h('div', { class: 'r' },
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { await post(L.dev, `/accounts/${L.id}/login`, {}).catch(() => {}); clearTimeout(L.timer); L.state = null; paintLogin(); poll(); } }, st.failed || (L.state && !st.running && !st.finished) ? 'Try again' : 'Restart'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { const { id, dev: d2 } = L; stopLogin(); await api(d2, `/accounts/${id}/login`, { method: 'DELETE' }).catch(() => {}); } }, st.finished || !st.running ? 'Close' : 'Cancel'))),
      h('p', { class: st.failed ? 'err' : st.finished ? 'ok' : 'dim' }, status),
      st.url ? h('a', { class: 'btn pri sm', href: st.url, target: '_blank', rel: 'noreferrer noopener' }, icon('external', 's'), 'Open the sign-in page') : null,
      st.running && !st.finished ? h('div', { class: 'cl-inline' }, L.codeEl, h('button', { class: 'btn sm', type: 'button', onclick: submit }, 'Submit')) : null,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { L.showTerm = !L.showTerm; L.term?.teardown(); L.term = null; paintLogin(); } }, icon('term', 's'), L.showTerm ? 'Hide the terminal' : 'Show the terminal'),
      termHost));
    if (hadFocus) L.codeEl.focus();
    if (L.showTerm && st.running && !L.term) L.term = startTerminal({ host: termHost, ctx: S.ctx, path: `/d/${encodeURIComponent(L.dev)}/accounts/${L.id}/terminal` });
  }

  paint();
  if (acct) { const a = dataOf(dev)?.accounts?.find((x) => x.id === acct); if (a && a.status === 'needs-login') startLogin(a); }
  return {
    el,
    update(reason) { if (reason === 'accounts' || reason === 'device') paint(reason === 'device' ? null : 'accounts'); },
    destroy() { stopLogin(); },
  };
}

async function saveSettings(dev, body, what = 'Saved') {
  const r = await act('settings', async () => {
    const next = await put(dev, '/settings', body);
    const x = dataOf(dev);
    if (x) x.settings = next;
    return next;
  });
  if (r) toast('ok', what);
  return r;
}

/* ── settings ─────────────────────────────────────────────────────── */

export function createSettings({ dev: dev0, onBack }) {
  let dev = dev0 && devOf(dev0) ? dev0 : curDev();
  const el = h('section', { class: 'cl-form-page cl-settings' });
  let govTimer = null;
  const govLine = (g) => (!g ? '' : !g.active ? `Off${g.reason ? `: ${g.reason}` : ''}` : [g.temp != null ? `${g.temp} °C` : null, `sessions ${g.usagePct}% of a ${g.capPct}% cap`, g.frozenPct ? `pausing ${g.frozenPct}%` : null, g.hot ? 'backing off (hot)' : null].filter(Boolean).join(' · '));

  function paint() {
    const d = devOf(dev);
    if (!d?.online || !d.data) { el.replaceChildren(formHead('Settings', null, onBack), h('div', { class: 'cl-form-body' }, devSwitch(dev, pick), offline(d))); return; }
    const { settings: set = {}, notify, runner, governor } = d.data;
    const ms = models(dev).map((m) => [m.id, m.label]);
    const save = (body, what) => saveSettings(dev, body, what);
    const num = (key, min, max, unit) => {
      const i = h('input', { class: 'input num', type: 'number', min: String(min), max: String(max), value: String(set[key] ?? ''), inputmode: 'numeric' });
      i.addEventListener('change', () => save({ [key]: Number(i.value) }));
      i.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div', { class: 'cl-inline' }, i, unit ? h('span', { class: 'unit' }, unit) : null);
    };
    const row = (t, d2, ctrl) => h('div', { class: 'set' }, h('div', { class: 't' }, t), d2 ? h('div', { class: 'd' }, d2) : null, h('div', { class: 'ctrl' }, ctrl));
    const toggle = (k, t, d2) => row(t, d2, sw(set[k], (v) => save({ [k]: v }), t));
    const thermal = governor?.thermal !== false;
    const group = (title, note, ...rows) => h('section', { class: 'sec' }, h('div', { class: 'sh' }, h('h2', {}, title), note ? h('span', { class: 'note' }, note) : null), h('div', { class: 'panel clip' }, ...rows.filter(Boolean)));
    el.replaceChildren(
      formHead(multi() ? `Settings on ${d.label}` : 'Settings', 'Each machine keeps its own.', onBack),
      h('div', { class: 'cl-form-body' },
        devSwitch(dev, pick),
        group('Models', null,
          row('Default model', 'New sessions start on it', sel(ms, set.defaultModel, { onchange: (e) => save({ defaultModel: e.target.value }, 'Default model saved') })),
          row('Fallback model', 'Used when the default runs out on an account', sel([['', 'None'], ...ms], set.fallbackModel || '', { onchange: (e) => save({ fallbackModel: e.target.value || null }, 'Fallback saved') })),
          row('Try the default again after', 'A model limit gives no reset time', num('modelRetryHours', 1, 168, 'hours'))),
        group('Sessions', null,
          row('Working at once', 'More wait in a queue', num('maxRunning', 1, 10)),
          row('Gone quiet after', 'Nothing written for this long while working, with no tool running and nothing in the background', num('stallMinutes', 5, 240, 'min')),
          toggle('unattended', 'Unattended', 'New sessions decide instead of asking, and end with DONE: or BLOCKED:'),
          toggle('autoSwitchAccounts', 'Auto-switch accounts', 'When one runs out, sessions move to the next available'),
          toggle('guard', 'Guard the machine', 'Block sudo, force-push, and stopping or touching the console stack'),
          toggle('resumeInterrupted', 'Resume after a restart', 'Sessions a reboot interrupted carry on by themselves')),
        group('CPU and heat', h('span', { class: 'cl-gov' }, govLine(governor)),
          toggle('governor', 'CPU governor', thermal ? 'Hold the sessions’ CPU under the cap, and lower it while the CPU is hotter than the target' : 'Hold the sessions’ CPU under the cap'),
          toggle('lightFootprint', 'Light footprint', 'Low priority; test runners and bundlers default to two workers (new launches)'),
          row('CPU cap', `What all sessions together may use${governor?.threads ? `, of ${governor.threads} threads` : ''}`, num('cpuCapPct', 10, 100, '%')),
          thermal ? row('Temperature target', 'Above it the cap comes down', num('tempTarget', 60, 95, '°C')) : null),
        group('Pings', notify?.console ? `rules from the console, received ${clock(notify.console.at)}` : 'console rules not received yet',
          row('Which alerts go where', 'Every alert kind, its channel and threshold, is in the console', h('a', { class: 'btn sm', href: '#/settings/notifications' }, 'Notifications', icon('chev', 's'))),
          h('div', { class: 'set' }, h('div', { class: 't' }, 'Include what Claude said'), h('div', { class: 'd' }, 'An excerpt in each Discord ping'), h('div', { class: 'ctrl' }, sw(set.notify?.excerpts !== false, (v) => save({ notify: { excerpts: v } }), 'Excerpts'))),
          row('Discord', notify?.enabled ? 'This runner sends its own pings, so they arrive when HP is down' : 'No webhook: set CLAUDE_DISCORD_WEBHOOK in ~/.config/ojee-claude/env', h('button', { class: 'btn sm', type: 'button', disabled: !notify?.enabled || null, onclick: () => act('test', () => S.ctx.api('/notify/test', { method: 'POST', body: '{}' }), 'Test ping sent') }, 'Send a test')),
          (notify?.recent || []).length ? h('details', { class: 'cl-recentpings' }, h('summary', {}, `Recent pings (${notify.recent.length})`),
            h('div', { class: 'rows' }, notify.recent.map((n) => h('div', { class: 'row' }, h('span', { class: 'm dim' }, clock(n.at)), h('span', { class: 'grow' }, clip(n.title, 90)), h('span', { class: 'dim' }, n.sent ? 'sent' : 'app only'))))) : null),
        group('Runner', null,
          ...[['Device', d.data.device ? `${d.data.device.label} (${d.data.device.id})` : d.label], ['Claude Code', runner?.claude || 'not found'], ['tmux', runner?.tmux || 'not found'],
            ['Listening on', runner?.port ? `${runner.host}:${runner.port}` : runner?.host], ['Protected stack folder', runner?.stackDir]]
            .map(([k, v]) => h('div', { class: 'set' }, h('div', { class: 't' }, k), h('div', { class: 'ctrl m dim' }, v || '—'))))));
  }
  function pick(id) { dev = id; setDev(id); go('settings', id); }
  govTimer = setInterval(async () => {
    if (!online(dev) || document.hidden) return;
    try {
      const g = await api(dev, '/governor');
      const x = dataOf(dev);
      if (x) x.governor = g;
      const note = el.querySelector('.cl-gov');
      if (note) note.textContent = govLine(g);
    } catch { /* restarting */ }
  }, 3000);
  paint();
  return { el, update(reason) { if (reason === 'device') paint(); }, destroy() { clearInterval(govTimer); } };
}
