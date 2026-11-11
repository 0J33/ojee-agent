/* ============================================================
   Work view: who is working on what, and where it is.

   Two levels, so the first screen can be read at a glance:
   1. The glance: one sentence, four numbers (needs you, in progress, due
      soon, problems), one card per person, the next deadlines. Every one
      of them is a button.
   2. The detail: a side panel opened from any of those, listing the tasks
      behind it. Each task is one line until opened; open, it shows where
      it is, its next step, what blocks it and its PRs.

   Data: /api/work, the file the host rebuilds every ten minutes from the
   owner's ClickUp scope (Task Planning, the Confidential Sprint, the Sprint
   Folder, Feature Requests, Bug Reports) and the open GitHub PRs.

   A story and its sprint copy are one piece of work: the story is shown,
   with the people taken from the copy. Status is read as a stage of the
   code: started = building, pr open = in review, issues found = fixing,
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
const ME = 'Omar / Claude';
const DAY = 86400000;
const DONE = new Set(['released', 'closed', 'done', 'complete']);
const STAGE = {
  'issues found': ['Fixing', 'fix'],
  started: ['Building', 'build'],
  'in progress': ['Building', 'build'],
  'pr open': ['In review', 'review'],
  'in review': ['In review', 'review'],
  'deployed to dev': ['On dev', 'dev'],
  'to do': ['Not started', 'idle'],
  'on hold': ['On hold', 'idle'],
  released: ['Live', 'live'],
  closed: ['Closed', 'live'],
};
const ACTIVE = new Set(['started', 'pr open', 'issues found', 'in progress', 'in review']);

let data = null;
let session = null;
let loading = false;
let sweepMsg = null;
let panel = null;          // { title, sub, groups: [{label, items | nodes, hint}] } or null
let rerenderRef = () => {};
let messages = [];        // Claude's messages to the owner, newest first
let activity = [];        // what was sent for the owner, newest first, with replies
let replies = [];         // the owner's answers to "Needs you" items
let refreshing = null;    // { at } while the host rebuilds the picture
let apiRef = null;
let toastRef = null;
const flash = (kind, title, body) => { if (toastRef) toastRef(kind, title, body); else sweepMsg = body ? `${title}: ${body}` : title; };
const SEEN_KEY = 'ojee-work-seen';
const seenAt = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* private window */ } };

// ClickUp gives "deployed to dev" the done status TYPE, so only these names and the closed type count as finished.
const isDone = (t) => DONE.has(String(t.status).toLowerCase()) || t.stype === 'closed';
const stOf = (t) => String(t.status).toLowerCase();
const stageOf = (i) => (ACTIVE.has(stOf(i)) ? 'active' : stOf(i) === 'deployed to dev' ? 'dev' : stOf(i) === 'on hold' ? 'held' : 'queued');
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
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
// "Sprint 6 (11/1 - 11/10)" -> [start, end) in ms, Cairo days (UTC+2).
function sprintSpan(name, now) {
  const m = /Sprint\s+\d+\s*\((\d+)\/(\d+)\s*-\s*(\d+)\/(\d+)\)/.exec(name || '');
  if (!m) return null;
  const y = new Date(now).getUTCFullYear();
  const at = (yy, mo, d) => Date.UTC(yy, mo - 1, d) - 2 * 3600000;
  let a = at(y, +m[1], +m[2]);
  let b = at(y, +m[3], +m[4] + 1);
  if (a - now > 180 * DAY) { a = at(y - 1, +m[1], +m[2]); b = at(y - 1, +m[3], +m[4] + 1); }
  if (b < a) b = at(y + 1, +m[3], +m[4] + 1);
  return [a, b];
}
const byKey = (a, b) => ((a.priority || 9) - (b.priority || 9)) || ((a.due || 9e15) - (b.due || 9e15));
const byDue = (a, b) => (a.due || 9e15) - (b.due || 9e15);

function stageChip(status) {
  const [label, kind] = STAGE[String(status).toLowerCase()] || [status, 'idle'];
  return el('span', { class: `wk-stage wk-stage--${kind}` }, label);
}

function dueText(t, now) {
  if (!t.due) return null;
  const left = (t.due - now) / DAY;
  if (left < 0) return stageOf(t) === 'dev' ? { txt: 'on dev', kind: 'ok' } : { txt: `late ${Math.ceil(-left)}d`, kind: 'late' };
  if (left < 1) return { txt: 'today', kind: 'soon' };
  if (left < 2) return { txt: 'tomorrow', kind: 'soon' };
  return { txt: fmtDay(t.due), kind: 'ok' };
}

/* ── model ──────────────────────────────────────────────────────────── */

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
      const ppl = (copy || t).assignees.filter((a) => a !== OWNER);
      const who = tnotes[t.id]?.who;
      items.push({
        ...t,
        kind: src.name === 'Task Planning' ? 'Story' : src.name === 'Bug Reports' ? 'Bug' : 'Feature request',
        where: copy ? copy.list_name : src.name,
        who: who || (ppl.length ? ppl.map(short).join(', ') : ME),
        people: who && who.startsWith('Claude') ? [ME] : (ppl.length ? ppl.map(short) : [ME]),
        note: tnotes[t.id],
        prs: [...(prsByTask[t.id] || []), ...(copy ? prsByTask[copy.id] || [] : [])],
      });
    }
  }
  const byList = {};
  for (const t of Object.values(d.copies || {})) {
    (byList[t.list_name] ||= []).push(t);
    if (copyIds.has(t.id)) continue;
    const ppl = t.assignees.filter((a) => a !== OWNER);
    items.push({
      ...t, kind: 'Team task', where: t.list_name, who: ppl.length ? ppl.map(short).join(', ') : ME,
      people: ppl.length ? ppl.map(short) : [ME], note: tnotes[t.id], prs: prsByTask[t.id] || [],
    });
  }
  for (const [name, tasks] of Object.entries(byList)) lists.push({ id: name, name, tasks });
  // The roster (team.json on the host): someone who left is not a person card;
  // work still assigned to them is a problem to fix.
  const former = new Set((d.roster?.former || []).map(short));
  for (const i of items) {
    i.former = i.people.filter((p) => former.has(p));
    if (i.former.length) {
      i.people = i.people.filter((p) => !former.has(p));
      if (!i.people.length) i.people = [ME];
    }
  }
  const open = items.filter((i) => !isDone(i));
  const cur = Object.keys(byList).find((nm) => { const sp = sprintSpan(nm, now); return sp && sp[0] <= now && now < sp[1]; }) || null;
  const prs = d.prs || [];
  const problems = {
    failing: prs.filter((p) => p.ci === 'failing'),
    fixing: open.filter((i) => stOf(i) === 'issues found'),
    stale: open.filter((i) => i.kind === 'Team task' && stageOf(i) === 'active' && i.updated && now - i.updated > 3 * DAY),
    // On dev means the work is done and only waits for a release, so it is not late work.
    late: open.filter((i) => i.due && i.due < now && stageOf(i) !== 'dev').sort(byDue),
    oldPrs: prs.filter((p) => now - p.updated > 3 * DAY),
    orphaned: open.filter((i) => i.former?.length).sort(byDue),
  };
  return {
    now, notes, items, open, lists, prs, problems, cur, roster: d.roster || null, teamAlerts: d.teamAlerts || null,
    active: open.filter((i) => stageOf(i) === 'active'),
    soon: open.filter((i) => i.due && i.due < now + 2 * DAY).sort(byDue),
    week: open.filter((i) => i.due && i.due < now + 7 * DAY).sort(byDue),
  };
}

/* ── the detail panel ───────────────────────────────────────────────── */

function openPanel(p) { panel = p; rerenderRef(); }
function closePanel() { panel = null; rerenderRef(); }

function prChip(p) {
  const ci = { passing: 'CI passing', failing: 'CI failing', running: 'CI running', none: 'no CI' }[p.ci] || p.ci;
  return el('a', { class: `wk-pr wk-pr--${p.ci}`, href: p.url, target: '_blank', rel: 'noopener', title: p.title },
    `${p.repo}#${p.number}`, el('span', { class: 'wk-pr-ci' }, ci));
}

const prNote = (p, extra) => el('div', { class: 'wk-note' }, prChip(p), el('p', { class: 'meta' }, [p.title, short(p.person), extra].filter(Boolean).join(' · ')));

/** One line until opened; opened, everything known about the task. */
function taskLine(i, now, open) {
  const due = dueText(i, now);
  return el('details', { class: 'wk-task', open: open || false },
    el('summary', {},
      stageChip(i.status),
      el('span', { class: 'wk-task-name' }, i.name),
      due ? el('span', { class: `wk-due wk-due--${due.kind}` }, due.txt) : null),
    el('div', { class: 'wk-task-body' },
      el('dl', { class: 'wk-facts' },
        el('dt', {}, 'Who'), el('dd', {}, i.who),
        el('dt', {}, 'Where'), el('dd', {}, `${i.where} · ${i.kind}`),
        el('dt', {}, 'Due'), el('dd', {}, i.due ? fmtDay(i.due) : 'no date'),
        i.note?.next ? [el('dt', {}, 'Next step'), el('dd', {}, i.note.next)] : null,
        i.note?.blocker ? [el('dt', {}, 'Blocked by'), el('dd', { class: 'wk-blocker' }, i.note.blocker)] : null),
      i.prs.length ? el('div', { class: 'wk-prs' }, i.prs.map(prChip)) : null,
      el('div', { class: 'wk-acts' },
        el('a', { class: 'btn btn--ghost btn--sm', href: taskUrl(i.id), target: '_blank', rel: 'noopener' }, 'Open in ClickUp'),
        ...taskActions(i, now))));
}

/** "Take action" on a task: one short instruction for Claude, worded for where the task is. */
function taskActions(i, now) {
  const ref = `"${i.name}" (${taskUrl(i.id)})`;
  const late = i.due && i.due < now && stageOf(i) !== 'dev';
  const team = i.people.filter((p) => p !== ME);
  const out = [];
  if (late && team.length) out.push(askBtn('Ask Claude to follow up', `Task ${ref} is late and assigned to ${team.join(', ')}. Read its comments and PRs, then either unblock it or ask them for a date, once, in a comment that starts "Omar's agent (Claude):".`));
  else if (late) out.push(askBtn('Ask Claude to push it', `Task ${ref} is past its due date. Finish it or move the date with a comment, and tell me which.`));
  if (stOf(i) === 'issues found') out.push(askBtn('Ask Claude to fix the issues', `Task ${ref} is in "issues found". Read its comments and fix every issue listed, or say what is blocking.`));
  if (i.prs.some((p) => p.ci === 'failing')) out.push(askBtn('Ask Claude to fix CI', `A PR for task ${ref} is failing CI (${i.prs.filter((p) => p.ci === 'failing').map((p) => p.url).join(', ')}). Find why and fix it if it is ours or small; otherwise comment exactly what to change.`));
  if (i.prs.some((p) => p.ci === 'passing') && ['pr open', 'in review'].includes(stOf(i))) out.push(askBtn('Ask Claude to review and merge', `Review the green PR for task ${ref} against the task and merge it the allowed way if it is right.`));
  if (i.former?.length) out.push(askBtn('Ask Claude to reassign', `Task ${ref} is still assigned to ${i.former.join(', ')}, who left the company. Reassign it to whoever fits (Adam or Ahmed, or me), with a comment.`));
  return out;
}

function askBtn(label, text) {
  return el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await apiRef('/work/ask', { method: 'POST', body: JSON.stringify({ text }) });
        flash('ok', r?.queued ? 'Queued for Claude' : 'Sent to Claude', r?.queued ? 'It reads it when the current turn ends.' : label);
        b.textContent = 'Sent';
      } catch (err) { flash('err', 'Not sent', err.message); b.disabled = false; }
    },
  }, label);
}

function viewPanel(m) {
  if (!panel) return null;
  const groups = panel.groups.filter((g) => (g.items || g.nodes || []).length);
  const single = groups.length === 1 && (groups[0].items || []).length === 1;
  const body = groups.map((g) => el('section', { class: 'wk-group' },
    el('h4', { class: 'wk-group-h' }, g.label, el('span', { class: 'wk-count' }, String((g.items || g.nodes).length))),
    g.hint ? el('p', { class: 'meta wk-hint' }, g.hint) : null,
    g.items ? g.items.map((i) => taskLine(i, m.now, single)) : g.nodes));
  return el('div', { class: 'wk-panel-wrap' },
    el('div', { class: 'wk-scrim', onclick: closePanel }),
    el('aside', { class: 'wk-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': panel.title },
      el('header', { class: 'wk-panel-head' },
        el('div', { class: 'wk-panel-titles' }, el('h3', { class: 'h3' }, panel.title), panel.sub ? el('p', { class: 'meta' }, panel.sub) : null),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: closePanel }, 'Close')),
      el('div', { class: 'wk-panel-body' }, body.length ? body : el('p', { class: 'meta' }, 'Nothing here.'))));
}

/* ── the glance ─────────────────────────────────────────────────────── */

function tile({ label, value, sub, tone, onclick }) {
  return el('button', { class: `wk-tile wk-tile--${tone || 'plain'}`, type: 'button', onclick },
    el('span', { class: 'wk-tile-label' }, label),
    el('span', { class: 'wk-tile-value' }, String(value)),
    el('span', { class: 'wk-tile-sub' }, sub));
}

function tiles(m) {
  const owner = m.notes.owner || [];
  const pr = m.problems;
  const nProblems = pr.failing.length + pr.fixing.length + pr.stale.length + pr.late.length + pr.orphaned.length;
  const onDev = m.open.filter((i) => stageOf(i) === 'dev');
  return el('div', { class: 'wk-tiles' },
    tile({
      label: 'Needs you', value: owner.length, tone: owner.length ? 'warn' : 'ok',
      sub: owner.length ? owner[0].what : 'Nothing waiting',
      onclick: () => openPanel({
        title: 'Needs you', sub: 'Things only you can do or decide.',
        groups: [{ label: 'Waiting on you', nodes: owner.map((x) => el('div', { class: 'wk-note' }, el('strong', {}, x.what), el('p', { class: 'meta' }, x.why))) }],
      }),
    }),
    tile({
      label: 'In progress', value: m.active.length, tone: 'plain',
      sub: `Plus ${onDev.length} on dev, waiting for release`,
      onclick: () => openPanel({
        title: 'In progress', sub: 'Everything being built, reviewed or fixed right now.',
        groups: [
          { label: 'Fixing', items: m.active.filter((i) => stOf(i) === 'issues found').sort(byKey) },
          { label: 'In review', items: m.active.filter((i) => ['pr open', 'in review'].includes(stOf(i))).sort(byKey) },
          { label: 'Building', items: m.active.filter((i) => ['started', 'in progress'].includes(stOf(i))).sort(byKey) },
          { label: 'On dev, waiting for release', items: onDev.sort(byKey) },
        ],
      }),
    }),
    tile({
      label: 'Due in 48 hours', value: m.soon.length, tone: m.soon.length ? 'warn' : 'ok',
      sub: m.soon[0] ? m.soon[0].name : 'Nothing due',
      onclick: () => openPanel({
        title: 'Deadlines', sub: 'Open work by due date.',
        groups: [
          { label: 'Late', items: m.week.filter((i) => i.due < m.now && stageOf(i) !== 'dev') },
          { label: 'Past due date, already on dev', items: m.week.filter((i) => i.due < m.now && stageOf(i) === 'dev') },
          { label: 'Next 48 hours', items: m.soon.filter((i) => i.due >= m.now) },
          { label: 'Rest of the week', items: m.week.filter((i) => i.due >= m.now + 2 * DAY) },
        ],
      }),
    }),
    tile({
      label: 'Problems', value: nProblems, tone: nProblems ? 'err' : 'ok',
      sub: nProblems ? [pr.failing.length && `${pr.failing.length} PRs failing CI`, pr.late.length && `${pr.late.length} late`, pr.fixing.length && `${pr.fixing.length} with issues`, pr.stale.length && `${pr.stale.length} gone quiet`, pr.orphaned.length && `${pr.orphaned.length} with someone who left`].filter(Boolean).join(' · ') : 'None',
      onclick: () => openPanel({
        title: 'Problems', sub: 'What is going wrong and needs a push.',
        groups: [
          { label: 'Late', items: pr.late },
          { label: 'Issues found', hint: 'Testing found problems; the task comments list them.', items: pr.fixing },
          { label: 'PRs failing CI', nodes: pr.failing.map((p) => prNote(p)) },
          { label: 'In progress, no update for 3+ days', items: pr.stale },
          { label: 'PRs untouched for 3+ days', nodes: pr.oldPrs.map((p) => prNote(p, agoMs(m.now - p.updated))) },
          { label: 'Still assigned to people who left', hint: 'Reassign these: the roster no longer has them.', items: pr.orphaned },
        ],
      }),
    }));
}

function personCard(m, name) {
  const mine = m.open.filter((i) => i.people.includes(name));
  // Not started counts only this sprint's work; later sprints and the backlog are shown apart.
  const queuedNow = mine.filter((i) => stageOf(i) === 'queued' && (!m.cur || i.where === m.cur)).sort(byKey);
  const later = mine.filter((i) => stageOf(i) === 'queued' && m.cur && i.where !== m.cur).sort(byKey);
  const n = (k) => (k === 'queued' ? queuedNow.length : mine.filter((i) => stageOf(i) === k).length);
  const active = mine.filter((i) => stageOf(i) === 'active').sort(byKey);
  const top = active[0] || queuedNow[0] || later[0];
  const late = mine.filter((i) => i.due && i.due < m.now && stageOf(i) !== 'dev').length;
  const prs = m.prs.filter((p) => (name === ME ? p.person === OWNER : short(p.person) === name));
  const segs = [['active', 'in progress'], ['dev', 'on dev'], ['queued', 'not started']];
  const total = Math.max(1, n('active') + n('dev') + n('queued'));
  return el('button', {
    class: 'wk-person', type: 'button',
    onclick: () => openPanel({
      title: name, sub: `${plural(mine.length, 'open item')}${prs.length ? ` · ${plural(prs.length, 'open PR')}` : ''}`,
      groups: [
        { label: 'In progress', items: active },
        { label: 'On dev, waiting for release', items: mine.filter((i) => stageOf(i) === 'dev').sort(byKey) },
        { label: 'Open PRs', nodes: prs.map((p) => prNote(p)) },
        { label: m.cur ? `Not started, ${m.cur.split(' (')[0]}` : 'Not started', items: queuedNow },
        { label: 'Later sprints and backlog', items: later },
        { label: 'On hold', items: mine.filter((i) => stageOf(i) === 'held').sort(byKey) },
      ],
    }),
  },
    el('span', { class: 'wk-person-top' },
      el('span', { class: 'wk-avatar', 'aria-hidden': 'true' }, name === ME ? 'C' : name[0]),
      el('span', { class: 'wk-person-name' }, name),
      late ? el('span', { class: 'wk-flag' }, `${late} late`) : null),
    el('span', { class: 'wk-person-count' }, el('strong', {}, String(n('active'))), ' in progress'),
    el('span', { class: 'wk-bar', 'aria-hidden': 'true' },
      segs.map(([k]) => (n(k) ? el('span', { class: `wk-seg wk-seg--${k}`, style: `flex:${n(k) / total}` }) : null))),
    el('span', { class: 'wk-person-legend' }, `${n('dev')} done on dev · ${n('queued')} not started${later.length ? ` · ${later.length} later` : ''}`),
    el('span', { class: 'wk-person-now' }, top ? `${stageOf(top) === 'active' ? 'Now' : 'Next'}: ${top.name}` : 'Nothing assigned'));
}

function people(m) {
  const team = (m.roster?.team || []).map(short);
  let names = [...new Set(m.open.filter((i) => stageOf(i) !== 'held').flatMap((i) => i.people))];
  // With a roster: Claude and the team, every teammate shown even with nothing assigned.
  if (team.length) names = [ME, ...team];
  names.sort((a, b) => (a === ME ? -1 : b === ME ? 1 : a.localeCompare(b)));
  const low = Object.entries(m.teamAlerts?.people || {}).filter(([nm, v]) => v.low && team.includes(short(nm)));
  return el('section', { class: 'wk-section' },
    el('h3', { class: 'wk-h' }, 'Who is on what'),
    low.length ? el('div', { class: 'wk-warn', role: 'status' },
      el('strong', {}, low.length === 1 ? `${short(low[0][0])} is running out of work` : `${low.map(([nm]) => short(nm)).join(' and ')} are running out of work`),
      el('span', { class: 'meta' }, low.map(([nm, v]) => `${short(nm)}: ${v.why}`).join(' · ')),
      askBtn('Ask Claude to assign work', `Team load: ${low.map(([nm, v]) => `${nm} (${v.why})`).join('; ')}. Give each their next fitting task now (sweep step 4d), with a due date in the current sprint and a comment on what to do first.`)) : null,
    el('div', { class: 'wk-people' }, names.map((nm) => personCard(m, nm))));
}

function upcoming(m) {
  const rows = m.week.slice(0, 5);
  return el('section', { class: 'wk-section' },
    el('div', { class: 'wk-h-row' },
      el('h3', { class: 'wk-h' }, 'Coming up'),
      m.week.length > 5 ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onclick: () => openPanel({ title: 'Deadlines', sub: 'Open work due in the next 7 days.', groups: [{ label: 'Next 7 days', items: m.week }] }),
      }, `See all ${m.week.length}`) : null),
    rows.length ? el('div', { class: 'wk-upcoming' }, rows.map((i) => {
      const due = dueText(i, m.now);
      return el('button', {
        class: 'wk-up', type: 'button',
        onclick: () => openPanel({ title: i.name, sub: `${i.kind} · ${i.where}`, groups: [{ label: 'Task', items: [i] }] }),
      },
        el('span', { class: `wk-due wk-due--${due.kind}` }, due.txt),
        el('span', { class: 'wk-up-name' }, i.name),
        el('span', { class: 'wk-up-who' }, i.who));
    })) : el('p', { class: 'meta' }, 'Nothing due in the next 7 days.'));
}

function lists(m) {
  const order = ['Task Planning', 'Confidential Sprint', 'Bug Reports', 'Feature Requests'];
  const rank = (nm) => { const i = order.indexOf(nm); return i < 0 ? (nm.includes('(') ? 1.5 : 1.7) : i; };
  return el('details', { class: 'wk-section wk-lists' },
    el('summary', { class: 'wk-h' }, 'Progress by list'),
    m.lists.slice().sort((a, b) => rank(a.name) - rank(b.name)).map((l) => {
      const total = l.tasks.length || 1;
      const k = { live: 0, dev: 0, active: 0, queued: 0 };
      for (const t of l.tasks) {
        if (isDone(t)) k.live += 1;
        else k[stageOf(t) === 'held' ? 'queued' : stageOf(t)] += 1;
      }
      return el('button', {
        class: 'wk-listrow', type: 'button',
        onclick: () => {
          const ids = new Set(l.tasks.map((t) => t.id));
          const its = m.items.filter((i) => ids.has(i.id) && !isDone(i));
          openPanel({ title: l.name, sub: `${k.live} of ${l.tasks.length} done`, groups: [
            { label: 'In progress', items: its.filter((i) => stageOf(i) === 'active').sort(byKey) },
            { label: 'On dev', items: its.filter((i) => stageOf(i) === 'dev').sort(byKey) },
            { label: 'Not started', items: its.filter((i) => stageOf(i) === 'queued').sort(byKey) },
            { label: 'On hold', items: its.filter((i) => stageOf(i) === 'held').sort(byKey) }] });
        },
      },
        el('span', { class: 'wk-list-name' }, l.name),
        el('span', { class: 'wk-bar' }, ['live', 'dev', 'active', 'queued'].map((s) => (k[s] ? el('span', { class: `wk-seg wk-seg--${s}`, style: `flex:${k[s] / total}` }) : null))),
        el('span', { class: 'wk-list-n' }, `${k.live}/${l.tasks.length} done`));
    }),
    el('p', { class: 'meta wk-legend' },
      el('span', { class: 'wk-key wk-seg--live' }), 'done', el('span', { class: 'wk-key wk-seg--dev' }), 'on dev',
      el('span', { class: 'wk-key wk-seg--active' }), 'in progress', el('span', { class: 'wk-key wk-seg--queued' }), 'not started'));
}

function footer(api) {
  const s = session && !session.error ? session : null;
  const busy = s && s.alive && s.state === 'running';
  const state = !s ? 'not reachable' : s.question ? 'waiting on a question' : busy ? 'working' : s.alive ? 'between turns' : 'not running';
  return el('footer', { class: 'wk-foot' },
    el('span', { class: 'wk-foot-item' }, el('span', { class: `dot dot--${!s ? 'err' : busy ? 'live' : s.question ? 'warn' : 'ok'}` }), `Claude is ${state}`),
    el('span', { class: 'wk-foot-item meta' }, `Updated ${agoMs(data.fileAgeMs)} from ClickUp and GitHub`),
    sweepMsg && sweepMsg !== '…' ? el('span', { class: 'wk-foot-item meta wk-sweepmsg' }, sweepMsg) : null,
    el('span', { class: 'wk-foot-actions', hidden: true },
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', disabled: sweepMsg === '…' || !!s?.question,
        title: s?.question ? 'Claude is waiting on a question: answer it in the Claude view first' : busy ? 'Claude is mid-turn: the sweep is queued and runs when this turn ends' : 'Ask Claude to run the sweep now',
        onclick: async () => {
          sweepMsg = '…'; rerenderRef();
          try { const r = await api('/work/sweep', { method: 'POST' }); sweepMsg = r?.error ? r.error : r?.queued ? 'Sweep queued: Claude runs it after the current turn.' : 'Sweep sent to Claude.'; } catch (e) { sweepMsg = e.message; }
          await loadSession(api); rerenderRef();
        },
      }, 'Sweep now')));
}

function msgLine(x, unread) {
  return el('details', { class: `wk-msg ${unread ? 'is-unread' : ''} ${x.severity === 'warn' ? 'is-warn' : ''}` },
    el('summary', {},
      el('span', { class: 'wk-msg-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'wk-msg-title' }, x.title),
      el('span', { class: 'wk-msg-at' }, agoMs(Date.now() - x.at))),
    el('div', { class: 'wk-msg-body' },
      x.body ? x.body.split(/\n+/).map((line) => el('p', {}, line)) : null,
      x.link ? el('a', { class: 'wk-open', href: x.link, target: '_blank', rel: 'noopener' }, 'Open') : null));
}

function fromClaude() {
  const seen = seenAt();
  const unread = messages.filter((x) => x.at > seen).length;
  return el('section', { class: 'wk-section' },
    el('div', { class: 'wk-h-row' },
      el('h3', { class: 'wk-h' }, 'From Claude', unread ? el('span', { class: 'wk-unread' }, `${unread} new`) : null),
      el('span', { class: 'wk-h-actions' },
        unread ? el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { markSeen(); rerenderRef(); } }, 'Mark all read') : null,
        messages.length > 3 ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onclick: () => openPanel({ title: 'From Claude', sub: `${messages.length} messages, newest first`, groups: [{ label: 'Messages', nodes: messages.map((x) => msgLine(x, x.at > seen)) }] }),
        }, `All ${messages.length}`) : null)),
    messages.length ? el('div', { class: 'wk-msgs' }, messages.slice(0, 3).map((x) => msgLine(x, x.at > seen)))
      : el('p', { class: 'meta' }, 'No messages yet. Releases, moved deadlines and decisions show up here.'));
}

/** CI from the host (ci-watch.json + ci-health.json): one line; click for each PR's state and what the watch did. */
function ciLine() {
  const c = data.ci;
  if (!c) return null;
  const q = Number(c.queue ?? c.queued ?? 0);
  const oldest = Number(c.oldestWaitMin ?? c.oldest_wait_min ?? 0);
  const busy = c.runnersBusy ?? c.runners_busy;
  const total = c.runnersTotal ?? c.runners_total;
  const med = c.medianResultMin ?? c.median_result_min;
  const baseRed = Object.entries(c.baseRed || {});
  const bad = oldest > 30 || q > 3 || baseRed.length > 0;
  const prs = c.prs || [];
  const STATE = { green: ['Green', 'live'], red: ['Red', 'fix'], running: ['Running', 'review'], conflict: ['Conflict', 'fix'], draft: ['Draft', 'idle'] };
  const open = () => openPanel({
    title: 'CI', sub: 'Open PRs, their CI and what the CI watch did. It re-runs infrastructure failures, updates PRs whose failures are not theirs once the base is green, asks teammates to fix their own failing tests, and sends the rest to Claude.',
    groups: [
      { label: 'Base branches that are red', nodes: baseRed.map(([k, v]) => el('div', { class: 'wk-note' }, el('strong', {}, k.replace(':', ' ')), el('p', { class: 'meta' }, `Failing: ${v.join(', ')}. Every PR into it waits until it is fixed.`))) },
      { label: 'Pull requests', nodes: prs.map((r) => {
        const [lab, kind] = STATE[r.state] || [r.state, 'idle'];
        return el('div', { class: 'wk-note' },
          el('span', { class: 'wk-ci-pr' }, el('span', { class: `wk-stage wk-stage--${kind}` }, lab), el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.pr), el('span', { class: 'meta' }, r.author)),
          el('p', { class: 'meta' }, r.title),
          r.action ? el('p', { class: 'meta wk-ci-act' }, r.action) : null);
      }) },
    ],
  });
  const parts = [];
  if (c.green != null) parts.push(`${c.green} green`, `${c.red} red`);
  return el('button', { class: `wk-ci ${bad ? 'is-bad' : ''}`, type: 'button', onclick: open },
    el('span', { class: `dot dot--${bad ? 'err' : q ? 'warn' : 'ok'}` }),
    el('span', { class: 'wk-ci-main' }, baseRed.length ? `CI: ${baseRed.map(([k]) => k.split(':')[1]).join(', ')} is red, PRs wait on it` : q ? `CI: ${plural(q, 'job')} waiting, oldest ${Math.round(oldest)} min` : 'CI: nothing waiting'),
    parts.length ? el('span', { class: 'meta' }, parts.join(' · ')) : null,
    total != null ? el('span', { class: 'meta' }, `runners ${busy ?? 0}/${total} busy`) : null,
    med != null ? el('span', { class: 'meta' }, `median result ${Math.round(med)} min`) : null);
}

/* ── the top bar: Refresh, Run sweep, how fresh the picture is ─────── */

async function doRefresh(api) {
  refreshing = { at: Date.now() };
  rerenderRef();
  try {
    const r = await api('/work/refresh', { method: 'POST' });
    if (r?.error) throw new Error(r.error);
    flash('ok', 'Rebuilding', 'ClickUp and GitHub are being read again; this takes a minute or two.');
  } catch (e) {
    flash('err', 'Could not start a rebuild', `${e.message}. Showing the last picture again.`);
  }
  await loadWork(api);
  rerenderRef();
  // Re-read until the host's tick is done (at most ~6 minutes).
  const started = Date.now();
  const poll = async () => {
    let st = null;
    try { st = await api('/work/refresh'); } catch { /* keep polling */ }
    if (st?.active && Date.now() - started < 6 * 60000) { setTimeout(poll, 8000); return; }
    refreshing = null;
    await loadWork(api);
    rerenderRef();
  };
  setTimeout(poll, 6000);
}

async function doSweep(api) {
  sweepMsg = '…';
  rerenderRef();
  try {
    const r = await api('/work/sweep', { method: 'POST' });
    sweepMsg = r?.error ? r.error : r?.queued ? 'Sweep queued: Claude runs it after the current turn.' : 'Sweep sent to Claude.';
    flash(r?.error ? 'err' : 'ok', r?.error ? 'Sweep not sent' : 'Sweep', sweepMsg);
  } catch (e) { sweepMsg = e.message; flash('err', 'Sweep not sent', e.message); }
  await loadSession(api);
  rerenderRef();
}

function topBar(api) {
  const s = session && !session.error ? session : null;
  const age = data.fileAgeMs || 0;
  const stale = age > 30 * 60000;
  return el('div', { class: 'wk-top' },
    el('span', { class: `wk-top-age${stale ? ' is-stale' : ''}`, title: 'When the host last rebuilt this from ClickUp and GitHub' },
      el('span', { class: `dot dot--${stale ? 'warn' : 'ok'}` }), refreshing ? 'Rebuilding…' : `Updated ${agoMs(age)}`),
    el('span', { class: 'wk-top-acts' },
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: !!refreshing, title: 'Read ClickUp and GitHub again now (the host does this every 10 minutes)', onclick: () => doRefresh(api) }, refreshing ? 'Refreshing…' : 'Refresh'),
      el('button', {
        class: 'btn btn--sm', type: 'button', disabled: sweepMsg === '…' || !!s?.question,
        title: s?.question ? 'Claude is waiting on a question: answer it in the Claude view first' : 'Ask Claude to run the whole sweep now',
        onclick: () => doSweep(api),
      }, sweepMsg === '…' ? 'Sending…' : 'Run sweep')));
}

/* ── Needs you: answer here, the sweep acts on it ───────────────────── */

const drafts = {};       // replies being written, kept across repaints
const replyFor = (id) => replies.find((r) => r.id === id && !r.handled) || null;
const handled = (id) => replies.some((r) => r.id === id && r.handled);

function needsItems(m) {
  const out = [];
  for (const x of m.notes.owner || []) out.push({ id: x.id, source: 'plan', title: x.what, body: x.why });
  for (const x of messages) {
    if (!(x.decision || (x.severity === 'warn' && /\?|decide|approve|needs you|your call/i.test(`${x.title} ${x.body}`)))) continue;
    if (Date.now() - x.at > 14 * DAY) continue;
    out.push({ id: `msg:${x.id}`, source: 'message', title: x.title, body: x.body, link: x.link, at: x.at });
  }
  return out.filter((i) => {
    if (handled(i.id)) return false;
    const r = replyFor(i.id);
    return !(r && r.action === 'snooze' && r.snoozeUntil > Date.now());
  });
}

async function answer(api, item, action, text = '') {
  try {
    await api('/work/replies', { method: 'POST', body: JSON.stringify({ id: item.id, source: item.source, title: item.title, action, text, snoozeHours: 24 }) });
    const r = await api('/work/replies');
    replies = r?.replies || replies;
    delete drafts[item.id];
    flash('ok', action === 'snooze' ? 'Snoozed for a day' : 'Answer saved', action === 'snooze' ? null : 'Claude acts on it in the next sweep.');
  } catch (e) { flash('err', 'Not saved', e.message); }
  rerenderRef();
}

function needsCard(api, item) {
  const r = replyFor(item.id);
  const box = el('textarea', { class: 'textarea wk-reply-in', rows: '2', placeholder: 'Reply to Claude about this', 'aria-label': `Reply about ${item.title}`, oninput: (e) => { drafts[item.id] = e.currentTarget.value; } });
  box.value = drafts[item.id] || '';
  const ACT = { approve: 'Approved', decline: 'Declined', done: 'Done', reply: 'Replied', snooze: 'Snoozed' };
  return el('div', { class: `wk-need${r ? ' is-answered' : ''}` },
    el('div', { class: 'wk-need-main' },
      el('strong', { class: 'wk-need-title' }, item.title),
      item.body ? el('p', { class: 'meta wk-need-body' }, item.body) : null,
      item.link ? el('a', { class: 'wk-open', href: item.link, target: '_blank', rel: 'noopener' }, 'Open') : null),
    r ? el('div', { class: 'wk-need-ans' },
      el('span', { class: 'wk-stage wk-stage--live' }, ACT[r.action] || 'Answered'),
      r.text ? el('span', { class: 'meta' }, `“${r.text}”`) : null,
      el('span', { class: 'meta' }, `${agoMs(Date.now() - r.at)} · waiting for the sweep`),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { try { await api(`/work/replies/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); replies = (await api('/work/replies'))?.replies || []; } catch (e) { flash('err', 'Not changed', e.message); } rerenderRef(); } }, 'Change'))
      : el('div', { class: 'wk-need-form' },
        // The reply box opens on Reply, so a list of decisions stays short.
        (box.hidden = !drafts[item.id], box),
        el('div', { class: 'wk-acts' },
          el('button', { class: 'btn btn--sm', type: 'button', onclick: () => {
            if (box.hidden) { box.hidden = false; box.focus(); return; }
            if (!box.value.trim()) { box.focus(); flash('err', 'Write a reply first', 'Or pick Approve, Decline, Done or Snooze.'); return; }
            answer(api, item, 'reply', box.value.trim());
          } }, 'Reply'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => answer(api, item, 'approve', box.value.trim()) }, 'Approve'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => answer(api, item, 'decline', box.value.trim()) }, 'Decline'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => answer(api, item, 'done', box.value.trim()) }, 'Done'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Hide it for a day', onclick: () => answer(api, item, 'snooze') }, 'Snooze'))));
}

function needsYou(api, m) {
  const items = needsItems(m);
  const open = items.filter((i) => !replyFor(i.id)).length;
  return el('section', { class: 'wk-section wk-needs' },
    el('div', { class: 'wk-h-row' }, el('h3', { class: 'wk-h' }, 'Needs you', open ? el('span', { class: 'wk-unread' }, `${open} open`) : null)),
    items.length ? el('div', { class: 'wk-need-list' }, items.map((i) => needsCard(api, i)))
      : el('p', { class: 'meta' }, 'Nothing waits on you. Decisions Claude needs from you show up here, each with a reply box.'));
}

/* ── Activity: what was sent for you, to whom, and the replies ──────── */

function actLine(a) {
  const where = a.channel === 'clickup' ? 'ClickUp' : a.channel === 'github' ? (a.pr || 'GitHub') : a.channel === 'slack' ? 'Slack' : a.channel === 'console' ? 'to you' : 'elsewhere';
  const link = /^https?:/.test(a.where || '') ? a.where : null;
  return el('div', { class: `wk-act${a.reply ? ' has-reply' : ''}` },
    el('div', { class: 'wk-act-top' },
      el('span', { class: 'wk-act-to' }, a.to || 'someone'),
      el('span', { class: 'meta' }, where),
      el('span', { class: 'wk-act-at meta' }, agoMs(Date.now() - a.at))),
    el('div', { class: 'wk-act-sum' }, link ? el('a', { href: link, target: '_blank', rel: 'noopener' }, a.summary) : a.summary),
    a.reply ? el('div', { class: 'wk-act-reply' },
      el('span', { class: 'wk-act-rk' }, `${a.reply.who} replied ${agoMs(Date.now() - a.reply.at)}`),
      a.reply.url ? el('a', { href: a.reply.url, target: '_blank', rel: 'noopener' }, a.reply.text || '(open)') : el('span', {}, a.reply.text))
      : a.channel !== 'console' ? el('div', { class: 'meta wk-act-none' }, 'No reply yet') : null);
}

function activityPanel() {
  const shown = activity.slice(0, 6);
  const replied = activity.filter((a) => a.reply).length;
  return el('section', { class: 'wk-section' },
    el('div', { class: 'wk-h-row' },
      el('h3', { class: 'wk-h' }, 'Activity', activity.length ? el('span', { class: 'meta' }, ` ${activity.length} sent · ${replied} replied, last 14 days`) : null),
      activity.length > 6 ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onclick: () => openPanel({ title: 'Activity', sub: 'Everything sent for you in the last 14 days, newest first, with the replies found.', groups: [
          { label: 'Waiting for a reply', nodes: activity.filter((a) => !a.reply && a.channel !== 'console').map(actLine) },
          { label: 'Replied', nodes: activity.filter((a) => a.reply).map(actLine) },
          { label: 'To you', nodes: activity.filter((a) => a.channel === 'console').map(actLine) },
        ] }),
      }, `All ${activity.length}`) : null),
    shown.length ? el('div', { class: 'wk-acts-list' }, shown.map(actLine))
      : el('p', { class: 'meta' }, 'Nothing sent yet. Follow-ups, CI comments and messages sent for you show up here with any reply.'));
}

function headline(m) {
  const pr = m.problems;
  const bad = pr.failing.length + pr.late.length + pr.fixing.length;
  const parts = [];
  const nOwner = (m.notes.owner || []).length;
  if (nOwner) parts.push(nOwner === 1 ? '1 thing needs you' : `${nOwner} things need you`);
  const nNew = messages.filter((x) => x.at > seenAt()).length;
  if (nNew) parts.push(nNew === 1 ? '1 new message from Claude' : `${nNew} new messages from Claude`);
  if (m.soon.length) parts.push(`${m.soon.length} due within 48 hours`);
  if (bad) parts.push(plural(bad, 'problem'));
  const text = parts.length ? `${parts.join(', ')}.` : 'All clear: nothing needs you and nothing is late.';
  return el('p', { class: 'wk-headline' }, text.charAt(0).toUpperCase() + text.slice(1));
}

/* ── module surface ─────────────────────────────────────────────────── */

async function loadSession(api) {
  try { session = await api('/work/session'); } catch (e) { session = { error: e.message }; }
}

export async function loadWork(api) {
  if (loading) return;
  loading = true;
  apiRef = api;
  try {
    const [d, msg, act, rep] = await Promise.all([api('/work'), api('/work/messages').catch(() => null),
      api('/work/activity').catch(() => null), api('/work/replies').catch(() => null), loadSession(api)]);
    data = d;
    if (msg && Array.isArray(msg.messages)) messages = msg.messages;
    if (act && Array.isArray(act.activity)) activity = act.activity;
    if (rep && Array.isArray(rep.replies)) replies = rep.replies;
  } catch (e) {
    data = { error: e.message };
  } finally {
    loading = false;
  }
}

/** True while the detail panel is open: a timed refresh then waits, so it does not close what is being read. */
export const workBusy = () => !!panel || !!document.activeElement?.closest?.('.wk-need-form');

function onKey(e) { if (e.key === 'Escape' && panel) closePanel(); }

export function viewWork(api, rerender, toast) {
  rerenderRef = rerender;
  apiRef = api;
  if (toast) toastRef = toast;
  document.removeEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey);
  if (!data) {
    loadWork(api).then(rerender);
    return el('div', { class: 'stack-lg' }, el('span', { class: 'skeleton', style: 'height:120px;display:block' }),
      el('span', { class: 'skeleton', style: 'height:240px;display:block' }));
  }
  if (data.error) {
    return el('section', { class: 'panel stack' }, el('h3', { class: 'h3' }, 'Work'),
      el('div', { class: 'ag-problem' }, el('strong', {}, 'The work picture is not available'), el('p', { class: 'meta' }, data.error)));
  }
  const m = model(data);
  return el('div', { class: 'wk' },
    topBar(api), headline(m), needsYou(api, m), ciLine(), tiles(m), people(m), activityPanel(), fromClaude(), upcoming(m), lists(m), footer(api), viewPanel(m));
}
