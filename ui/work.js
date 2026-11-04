/* ============================================================
   Work view: who is working on what, and where it is.

   Reads /api/work, the file the host rebuilds every ten minutes from the
   owner's ClickUp scope (Task Planning, the Confidential Sprint, the Sprint
   Folder, Feature Requests and Bug Reports) and the open GitHub PRs.

   A story and its sprint copy are one piece of work: the story is shown,
   with the people taken from the copy, which is where the team is assigned.
   Status is read as a stage of the code, because that is the rule the team
   works to: started = building, pr open = in review, issues found = fixing,
   deployed to dev = on dev, released = live.
   ============================================================ */

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const OWNER = 'Omar Gamal (ojee)';
const DAY = 86400000;
const DONE = new Set(['released', 'closed', 'done', 'complete']);
const PRI = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
const STAGE = {
  'to do': ['Not started', 'idle'],
  started: ['Building', 'build'],
  'pr open': ['In review', 'review'],
  'issues found': ['Fixing', 'fix'],
  'deployed to dev': ['On dev', 'dev'],
  released: ['Live', 'live'],
  'on hold': ['On hold', 'idle'],
  closed: ['Closed', 'live'],
};

let data = null;      // last /api/work answer
let session = null;   // last /api/work/session answer
let loading = false;
let sweepMsg = null;
let filter = 'all';   // a person, or 'all'

// ClickUp gives "deployed to dev" the done status TYPE, so only these names and the closed type count as finished.
const isDone = (t) => DONE.has(String(t.status).toLowerCase()) || t.stype === 'closed';
const short = (p) => String(p).split(' (')[0];
const taskUrl = (id) => `https://app.clickup.com/t/${id}`;
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' });
const agoMs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

function stageChip(status) {
  const [label, kind] = STAGE[String(status).toLowerCase()] || [status, 'idle'];
  return el('span', { class: `wk-stage wk-stage--${kind}` }, label);
}

function dueChip(t, now) {
  if (!t.due) return el('span', { class: 'meta' }, 'no date');
  const left = (t.due - now) / DAY;
  const kind = left < 0 ? 'late' : left < 2 ? 'soon' : 'ok';
  const txt = left < 0 ? `${fmtDay(t.due)} · late ${Math.ceil(-left)}d` : fmtDay(t.due);
  return el('span', { class: `wk-due wk-due--${kind}` }, txt);
}

/** The work model: stories with their copies folded in, team tasks, PRs by task. */
function model(d) {
  const now = d.fetched;
  const notes = d.notes || {};
  const tnotes = notes.tasks || {};
  const pairs = d.pairs || {};
  const copyIds = new Set(Object.values(pairs));
  const prsByTask = {};
  for (const p of d.prs || []) for (const id of p.tasks) (prsByTask[id] ||= []).push(p);

  const items = [];
  const lists = [];
  for (const [lid, src] of Object.entries(d.sources || {})) {
    lists.push({ id: lid, name: src.name, tasks: src.tasks });
    for (const t of src.tasks) {
      const copy = d.copies[pairs[t.id]];
      const people = (copy || t).assignees.filter((a) => a !== OWNER);
      items.push({
        ...t,
        kind: src.name === 'Task Planning' ? 'story' : src.name === 'Bug Reports' ? 'bug' : 'feature',
        where: copy ? copy.list_name : src.name,
        copyId: copy?.id,
        who: tnotes[t.id]?.who || (people.length ? people.map(short).join(', ') : 'Omar / Claude'),
        people: people.length ? people.map(short) : ['Omar / Claude'],
        note: tnotes[t.id],
        prs: [...(prsByTask[t.id] || []), ...(copy ? prsByTask[copy.id] || [] : [])],
      });
    }
  }
  const byList = {};
  for (const t of Object.values(d.copies || {})) {
    (byList[t.list_name] ||= []).push(t);
    if (copyIds.has(t.id)) continue;
    const people = t.assignees.filter((a) => a !== OWNER);
    items.push({
      ...t, kind: 'team', where: t.list_name, who: people.length ? people.map(short).join(', ') : 'Omar / Claude',
      people: people.length ? people.map(short) : ['Omar / Claude'], note: tnotes[t.id], prs: prsByTask[t.id] || [],
    });
  }
  for (const [name, tasks] of Object.entries(byList)) lists.push({ id: name, name, tasks });
  const linked = new Set(items.flatMap((i) => i.prs.map((p) => `${p.repo}#${p.number}`)));
  return { now, notes, items, lists, prs: d.prs || [], loosePrs: (d.prs || []).filter((p) => !linked.has(`${p.repo}#${p.number}`)) };
}

const key = (t) => [(t.priority || 9), (t.due || 9e15)];
const byKey = (a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; };

function prChip(p) {
  return el('a', { class: `wk-pr wk-pr--${p.ci}`, href: p.url, target: '_blank', rel: 'noopener', title: `${p.title} (CI ${p.ci})` },
    `${p.repo}#${p.number}`);
}

function itemRow(i, now) {
  return el('div', { class: 'ag-row wk-item' },
    stageChip(i.status),
    el('a', { class: 'ag-row-name wk-name', href: taskUrl(i.id), target: '_blank', rel: 'noopener', title: i.name }, i.name),
    el('span', { class: 'meta wk-where', title: i.where }, i.where),
    dueChip(i, now),
    el('span', { class: 'wk-prs' }, i.prs.map(prChip)),
    i.note?.next ? el('span', { class: 'wk-next', title: i.note.next }, i.note.next) : null);
}

/* ── panels ─────────────────────────────────────────────────────────── */

function header(m, api, rerender) {
  const s = session && !session.error ? session : null;
  const busy = s && s.alive && s.state === 'running';
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Work'),
      el('div', { class: 'wk-head-side' },
        el('span', { class: 'meta' }, `ClickUp and GitHub, updated ${agoMs(data.fileAgeMs)}`),
        data.doc ? el('a', { class: 'btn btn--ghost btn--sm', href: `https://app.clickup.com/90152575282/v/dc/${data.doc.doc}/${data.doc.page}`, target: '_blank', rel: 'noopener' }, 'Work Plan doc') : null,
        el('button', {
          class: 'btn btn--sm', type: 'button', disabled: !!busy || sweepMsg === '…',
          title: busy ? 'Claude is mid-turn; the hourly loop sends the sweep when it is free' : 'Type the sweep prompt into the Conductor session',
          onclick: async () => {
            sweepMsg = '…'; rerender();
            try {
              const r = await api('/work/sweep', { method: 'POST' });
              sweepMsg = r?.error ? r.error : 'Sweep sent to Claude.';
            } catch (e) { sweepMsg = e.message; }
            await loadSession(api); rerender();
          },
        }, 'Sweep now'))),
    el('div', { class: 'wk-session' },
      el('span', { class: `dot dot--${!s ? 'err' : busy ? 'live' : s.question ? 'warn' : 'ok'}` }),
      el('span', {}, s ? `Claude (${s.title}): ${s.question ? 'waiting on a question' : busy ? 'working' : s.alive ? 'between turns' : 'not running'}` : `Claude session: ${session?.error || 'unknown'}`),
      s?.lastActivityAt ? el('span', { class: 'meta' }, `last activity ${agoMs(Date.now() - s.lastActivityAt)}`) : null,
      sweepMsg && sweepMsg !== '…' ? el('span', { class: 'meta wk-sweepmsg' }, sweepMsg) : null),
    s?.lastAssistant ? el('p', { class: 'meta wk-said' }, s.lastAssistant) : null);
}

function stats(m) {
  const open = m.items.filter((i) => !isDone(i));
  const stories = m.items.filter((i) => i.kind === 'story');
  const late = open.filter((i) => i.due && i.due < m.now);
  const soon = open.filter((i) => i.due && i.due >= m.now && i.due < m.now + 7 * DAY);
  const week = stories.filter((i) => isDone(i) && i.done && i.done > m.now - 7 * DAY);
  const tile = (label, value, warn) => el('div', { class: `panel stat ${warn ? 'is-warn' : ''}` },
    el('span', { class: 'meta' }, label), el('span', { class: 'value wk-value' }, String(value)));
  return el('div', { class: 'grid grid--4 wk-stats' },
    tile('Open stories', `${stories.filter((i) => !isDone(i)).length} of ${stories.length}`),
    tile('Late, all lists', late.length, late.length > 0),
    tile('Due in 7 days', soon.length, false),
    tile('Stories finished, 7 days', week.length, false),
    tile('Open PRs', m.prs.length, m.prs.some((p) => p.ci === 'failing')));
}

const ACTIVE = new Set(['started', 'pr open', 'issues found', 'in progress', 'in review']);
const stageOf = (i) => {
  const st = String(i.status).toLowerCase();
  if (ACTIVE.has(st)) return 'active';
  if (st === 'deployed to dev') return 'dev';
  if (st === 'on hold') return 'held';
  return 'queued';
};

function fold(label, rows, now, open) {
  if (!rows.length) return null;
  return el('details', { class: 'wk-next-up', open: open || false },
    el('summary', { class: 'meta' }, `${label} (${rows.length})`),
    el('div', { class: 'ag-list' }, rows.slice(0, 60).map((i) => itemRow(i, now))),
    rows.length > 60 ? el('p', { class: 'meta' }, `and ${rows.length - 60} more in ClickUp`) : null);
}

function people(m) {
  const open = m.items.filter((i) => !isDone(i));
  const count = (k) => open.filter((i) => stageOf(i) === k).length;
  const names = [...new Set(open.flatMap((i) => i.people))]
    .sort((a, b) => (a === 'Omar / Claude' ? -1 : b === 'Omar / Claude' ? 1 : a.localeCompare(b)));
  const choose = (p) => el('button', {
    class: `tab ${filter === p ? 'active' : ''}`, type: 'button', 'aria-selected': filter === p ? 'true' : 'false',
    onclick: () => { filter = p; rerenderRef(); },
  }, p === 'all' ? 'Everyone' : p);
  const shown = filter === 'all' ? names : names.filter((n) => n === filter);
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, 'Being worked on'),
      el('span', { class: 'meta' }, `${count('active')} in progress · ${count('dev')} on dev waiting for release · ${count('queued')} not started · ${count('held')} on hold`)),
    el('div', { class: 'tabs wk-tabs' }, choose('all'), names.map(choose)),
    shown.map((p) => {
      const mine = open.filter((i) => i.people.includes(p));
      const by = (k) => mine.filter((i) => stageOf(i) === k).sort(byKey);
      const active = by('active');
      const theirPrs = m.loosePrs.filter((x) => (p === 'Omar / Claude' ? x.person === OWNER : short(x.person) === p));
      const nowRows = p === 'Omar / Claude' ? (m.notes.now || []) : (m.notes.now || []).filter((x) => x.who.includes(p));
      return el('div', { class: 'wk-person stack' },
        el('div', { class: 'wk-person-head' },
          el('strong', {}, p),
          el('span', { class: 'meta' }, `${active.length} in progress · ${by('dev').length} on dev · ${by('queued').length} next${by('held').length ? ` · ${by('held').length} on hold` : ''}${theirPrs.length ? ` · ${theirPrs.length} PR without a task` : ''}`)),
        nowRows.length ? el('div', { class: 'ag-list' }, nowRows.map((x) => el('div', { class: 'ag-row wk-now' },
          el('span', { class: 'dot dot--live' }),
          el('span', { class: 'ag-row-name', title: x.what }, x.what),
          el('span', { class: 'meta', title: x.state }, `${x.who}: ${x.state}`)))) : null,
        active.length ? el('div', { class: 'ag-list' }, active.map((i) => itemRow(i, m.now))) : el('p', { class: 'meta' }, 'Nothing in progress.'),
        theirPrs.length ? el('div', { class: 'wk-prs wk-loose' }, el('span', { class: 'meta' }, 'PRs without a task:'), theirPrs.map(prChip)) : null,
        fold('On dev, waiting for release', by('dev'), m.now),
        fold('Next up', by('queued'), m.now),
        fold('On hold', by('held'), m.now));
    }));
}

function owner(m) {
  const rows = m.notes.owner || [];
  if (!rows.length) return null;
  return el('section', { class: 'panel stack is-warn' },
    el('h3', { class: 'h3' }, 'Waiting on you'),
    el('div', { class: 'ag-list' }, rows.map((x) => el('div', { class: 'ag-row wk-owner' },
      el('span', { class: 'dot dot--warn' }),
      el('span', { class: 'ag-row-name', title: x.what }, x.what),
      el('span', { class: 'meta', title: x.why }, x.why)))));
}

function order(m) {
  const byId = Object.fromEntries(m.items.map((i) => [i.id, i]));
  const rows = (m.notes.focus || []).map((id) => byId[id]).filter((i) => i && !isDone(i));
  if (!rows.length) return null;
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' },
      el('h3', { class: 'h3' }, "This week's order"),
      el('span', { class: 'meta' }, 'priority and deadline together, blockers first')),
    el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['#', 'Story', 'Due', 'Stage', 'Who', 'Next step', 'Blocked by'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((i, n) => el('tr', {},
        el('td', { class: 'num' }, String(n + 1)),
        el('td', {}, el('a', { href: taskUrl(i.id), target: '_blank', rel: 'noopener' }, i.name)),
        el('td', {}, dueChip(i, m.now)),
        el('td', {}, stageChip(i.status)),
        el('td', {}, i.who),
        el('td', {}, i.note?.next || ''),
        el('td', {}, i.note?.blocker || '-')))))));
}

function deadlines(m) {
  const rows = m.items.filter((i) => !isDone(i) && i.due && i.due < m.now + 7 * DAY).sort((a, b) => a.due - b.due);
  return el('section', { class: 'panel stack' },
    el('div', { class: 'ag-panel-head' }, el('h3', { class: 'h3' }, 'Deadlines, next 7 days'), el('span', { class: 'meta' }, `${rows.length}`)),
    rows.length ? el('div', { class: 'ag-list' }, rows.map((i) => el('div', { class: 'ag-row wk-dl' },
      dueChip(i, m.now),
      el('a', { class: 'ag-row-name wk-name', href: taskUrl(i.id), target: '_blank', rel: 'noopener', title: i.name }, i.name),
      el('span', { class: 'meta' }, i.who),
      stageChip(i.status)))) : el('p', { class: 'meta' }, 'Nothing due in the next 7 days.'));
}

function listsPanel(m) {
  const ORDER = ['Task Planning', 'Confidential Sprint', 'Bug Reports', 'Feature Requests'];
  const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? (n.startsWith('Sprint ') && n.includes('(') ? 1.5 : 1.7) : i; };
  return el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Lists'),
    el('div', { class: 'ag-list' }, m.lists.slice().sort((a, b) => rank(a.name) - rank(b.name)).map((l) => {
      const by = {};
      for (const t of l.tasks) by[String(t.status).toLowerCase()] = (by[String(t.status).toLowerCase()] || 0) + 1;
      const total = l.tasks.length || 1;
      const order = ['released', 'closed', 'deployed to dev', 'pr open', 'issues found', 'started', 'to do'];
      const keys = [...order.filter((k) => by[k]), ...Object.keys(by).filter((k) => !order.includes(k))];
      return el('div', { class: 'wk-list' },
        el('div', { class: 'wk-list-head' },
          el('span', {}, l.name),
          el('span', { class: 'meta' }, `${l.tasks.filter((t) => !isDone(t)).length} open of ${l.tasks.length}`)),
        el('div', { class: 'wk-bar', role: 'img', 'aria-label': keys.map((k) => `${k} ${by[k]}`).join(', ') },
          keys.map((k) => el('span', {
            class: `wk-seg wk-stage--${(STAGE[k] || [, 'idle'])[1]}`, style: `flex:${by[k] / total}`, title: `${k}: ${by[k]}`,
          }))),
        el('div', { class: 'meta wk-legend' }, keys.map((k) => `${(STAGE[k] || [k])[0]} ${by[k]}`).join(' · ')));
    })));
}

function checks(m) {
  const out = [];
  const open = m.items.filter((i) => !isDone(i));
  const quiet = open.filter((i) => i.kind === 'story' && i.status === 'started' && !i.note?.next);
  if (quiet.length) out.push(['warn', `${quiet.length} started stories have no next step written`, quiet]);
  const stale = open.filter((i) => i.kind === 'team' && i.status !== 'to do' && i.updated && m.now - i.updated > 3 * DAY);
  if (stale.length) out.push(['warn', `${stale.length} team tasks in progress with no update for 3+ days`, stale]);
  const failing = m.prs.filter((p) => p.ci === 'failing');
  if (failing.length) out.push(['err', `${failing.length} open PRs fail CI`, failing]);
  const oldPrs = m.prs.filter((p) => m.now - p.updated > 3 * DAY);
  if (oldPrs.length) out.push(['warn', `${oldPrs.length} PRs untouched for 3+ days`, oldPrs]);
  const fixing = open.filter((i) => i.status === 'issues found');
  if (fixing.length) out.push(['warn', `${fixing.length} items have issues found`, fixing]);
  if (data.errors?.length) out.push(['err', `The last build had ${data.errors.length} errors`, []]);
  return el('section', { class: 'panel stack' },
    el('h3', { class: 'h3' }, 'Checks'),
    out.length ? el('div', { class: 'ag-list' }, out.map(([lvl, title, rows]) => el('details', { class: 'wk-check' },
      el('summary', {}, el('span', { class: `dot dot--${lvl}` }), ' ', title),
      el('div', { class: 'wk-check-body' }, rows.map((r) => (r.repo ? prChip(r)
        : el('a', { class: 'wk-chiplink', href: taskUrl(r.id), target: '_blank', rel: 'noopener' }, r.name)))))))
      : el('p', { class: 'meta' }, 'Nothing to flag.'));
}

/* ── module surface ─────────────────────────────────────────────────── */

let rerenderRef = () => {};

async function loadSession(api) {
  try { session = await api('/work/session'); } catch (e) { session = { error: e.message }; }
}

export async function loadWork(api) {
  if (loading) return;
  loading = true;
  try {
    const [d] = await Promise.all([api('/work'), loadSession(api)]);
    data = d;
  } catch (e) {
    data = { error: e.message };
  } finally {
    loading = false;
  }
}

export function viewWork(api, rerender) {
  rerenderRef = rerender;
  if (!data) {
    loadWork(api).then(rerender);
    return el('div', { class: 'stack-lg' }, el('span', { class: 'skeleton', style: 'height:56px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:240px;display:block' }));
  }
  if (data.error) {
    return el('section', { class: 'panel stack' }, el('h3', { class: 'h3' }, 'Work'),
      el('div', { class: 'ag-problem' }, el('strong', {}, 'The work picture is not available'), el('p', { class: 'meta' }, data.error)));
  }
  const m = model(data);
  return el('div', { class: 'stack-lg wk' },
    header(m, api, rerender), stats(m), owner(m), people(m), order(m),
    el('div', { class: 'grid grid--2' }, deadlines(m), checks(m)), listsPanel(m));
}
