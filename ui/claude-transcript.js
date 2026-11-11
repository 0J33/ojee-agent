/* ============================================================
   The Claude view's transcript: the session's own record, drawn
   to read. Turns, Markdown, code with a copy button, thinking
   folded away, and each tool call as one row that opens to its
   input (a diff for an edit) and its output.

   Long sessions stay quick: the runner sends the last 2 MB of
   the file, only the newest rows are drawn, and earlier ones are
   drawn (then fetched) as the reader scrolls up to them.

   Built from DOM nodes, never innerHTML: every word here is
   whatever the model or a tool wrote.
   ============================================================ */

import { copyText } from './claude-term.js';

const STEP = 120;

export function createTranscript({ el, svg, modelLabel, toast, onEarlier, onAgent, onPath }) {
  /* ── paths: every absolute or ~ path is a link that opens the explorer ── */

  const PATH = /(?<![\w:/.~-])((?:~\/|\/)(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-](?::\d+(?::\d+)?)?)/g;
  const pathLink = (p) => el('a', {
    class: 'ag-cl-path', href: '#', title: `Open ${p} in the explorer`,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onPath?.(p); },
  }, p);
  /** Text with its paths as links (only paths with a folder in them: "/" alone is not one). */
  function withPaths(text) {
    const t = String(text ?? '');
    if (!onPath) return [t];
    const out = [];
    let last = 0;
    for (const m of t.matchAll(PATH)) {
      const p = m[1];
      if (!/\/[^/]/.test(p.replace(/^~/, '')) || p.length < 3) continue;
      if (m.index > last) out.push(t.slice(last, m.index));
      out.push(pathLink(p));
      last = m.index + p.length;
    }
    if (last < t.length) out.push(t.slice(last));
    return out;
  }
  // A big output is linked only up to here: past it, plain text.
  const LINK_MAX = 200_000;

  /* ── Markdown ─────────────────────────────────────────────── */

  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])/g;
  function inline(text) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(INLINE)) {
      if (m.index > last) out.push(...withPaths(text.slice(last, m.index)));
      if (m[1] != null) out.push(el('code', { class: 'ag-cl-md-c' }, ...withPaths(m[1])));
      else if (m[2] != null) out.push(el('strong', { class: 'ag-cl-md-b' }, ...inline(m[2])));
      else if (m[3] != null) out.push(el('em', { class: 'ag-cl-md-i' }, ...inline(m[3])));
      else {
        const href = m[5] || m[6];
        out.push(el('a', { class: 'ag-cl-md-a', href, target: '_blank', rel: 'noreferrer noopener' }, m[4] || m[6]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(...withPaths(text.slice(last)));
    return out;
  }

  const copyBtn = (get, label = 'Copy') => el('button', {
    class: 'ag-cl-copy',
    type: 'button',
    title: label,
    'aria-label': label,
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = e.currentTarget;
      const ok = await copyText(get());
      b.classList.toggle('is-done', ok);
      b.replaceChildren(svg(ok ? 'check' : 'copy'));
      setTimeout(() => { b.classList.remove('is-done'); b.replaceChildren(svg('copy')); }, 1400);
      if (!ok) toast?.('err', 'Could not copy', 'The browser refused the clipboard.');
    },
  }, svg('copy'));

  const codeBlock = (code, lang) => el('div', { class: 'ag-cl-md-codewrap' },
    el('div', { class: 'ag-cl-md-codebar' }, el('span', {}, lang || 'text'), copyBtn(() => code, 'Copy code')),
    el('pre', { class: 'ag-cl-md-code' }, code));

  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function md(src) {
    const out = el('div', { class: 'ag-cl-md' });
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p', { class: 'ag-cl-md-p' });
      para.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l)); });
      out.append(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^\s*```\s*([\w+#.-]*)/.exec(line))) {
        flush();
        const code = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
        out.append(codeBlock(code.join('\n'), m[1]));
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
        const [head, ...rest] = body;
        out.append(el('div', { class: 'ag-cl-md-tablewrap' }, el('table', { class: 'ag-cl-md-table' },
          head ? el('tr', {}, head.map((c) => el('th', { class: 'ag-cl-md-th' }, ...inline(c)))) : null,
          rest.map((r) => el('tr', {}, r.map((c) => el('td', { class: 'ag-cl-md-td' }, ...inline(c))))))));
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        out.append(el('div', { class: `ag-cl-md-h ag-cl-md-h${Math.min(m[1].length, 3)}` }, ...inline(m[2])));
      } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
        flush();
        const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
        const mark = m[3] != null ? (m[3] === ' ' ? '☐' : '☑') : /\d/.test(m[2]) ? m[2] : '•';
        out.append(el('div', { class: 'ag-cl-md-li', style: `--d:${depth}` },
          el('span', { class: 'ag-cl-md-mark' }, mark), el('span', {}, ...inline(m[4]))));
      } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flush();
        out.append(el('div', { class: 'ag-cl-md-quote' }, ...inline(m[1])));
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        out.append(el('div', { class: 'ag-cl-md-hr' }));
      } else if (!line.trim()) {
        flush();
      } else {
        para.push(line);
      }
    }
    flush();
    return out;
  }

  /* ── pieces ───────────────────────────────────────────────── */

  const time = (at) => (at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  const dur = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const lineCount = (t) => (t ? String(t).split('\n').length : 0);
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p || '';
  const dir = (p) => { const a = String(p || '').split('/'); a.pop(); return a.join('/'); };

  /** A long block, cut to its first lines with a way to see all of it. */
  function clamp(node, lines, max = 14) {
    if (lines <= max) return node;
    node.classList.add('is-clamped');
    const more = el('button', { class: 'ag-cl-more', type: 'button' }, `Show all ${lines} lines`);
    more.addEventListener('click', () => {
      const open = node.classList.toggle('is-clamped');
      more.textContent = open ? `Show all ${lines} lines` : 'Show less';
    });
    return el('div', { class: 'ag-cl-clampwrap' }, node, more);
  }
  /**
   * What you wrote. A long paste reads like Claude Code's own
   * "[Pasted text #1 +N lines]": the words around it as written, the paste
   * as one chip that opens to the text in a bounded, scrolling block, so a
   * thousand-line paste never stretches the page.
   */
  function userText(text) {
    const t = String(text ?? '');
    const lines = t.split('\n');
    if (lines.length <= 12 && t.length <= 1500) return el('div', { class: 'ag-cl-t-text' }, ...withPaths(t));
    // The paste is the longest run of lines; a short note before it stays as text.
    let head = '';
    let body = t;
    const firstBreak = t.indexOf('\n\n');
    if (firstBreak > 0 && firstBreak < 400 && lines.length > 14) { head = t.slice(0, firstBreak); body = t.slice(firstBreak + 2); }
    const n = body.split('\n').length;
    const full = el('pre', { class: 'ag-cl-t-paste-body', hidden: true }, body);
    const chip = el('button', { class: 'ag-cl-t-paste', type: 'button', 'aria-expanded': 'false', title: 'Show the pasted text' },
      el('span', { class: 'ag-cl-t-chev' }, svg('chevron')),
      el('span', { class: 'ag-cl-t-paste-k' }, 'Pasted text'),
      el('span', { class: 'ag-cl-t-paste-n' }, `${n} line${n === 1 ? '' : 's'} · ${body.length.toLocaleString('en-GB')} characters`),
      el('span', { class: 'ag-cl-t-paste-prev' }, body.replace(/\s+/g, ' ').slice(0, 120)));
    chip.addEventListener('click', () => {
      const open = full.hidden;
      full.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
      chip.classList.toggle('is-open', open);
    });
    return el('div', { class: 'ag-cl-t-text' }, head ? el('div', {}, ...withPaths(head)) : null, chip, full);
  }

  const pre = (text, cls = '') => el('pre', { class: `ag-cl-t-pre ${cls}`.trim() }, ...(String(text ?? '').length <= LINK_MAX ? withPaths(text) : [text]));
  const pathDiv = (p, ...rest) => el('div', { class: 'ag-cl-t-path' }, onPath && p ? pathLink(p) : p, ...rest);

  /**
   * A line diff of an edit: the lines the edit kept are context, the rest
   * are removed or added. Small edits get a real LCS; a huge one is shown as
   * the old block then the new.
   */
  function diff(a, b) {
    const A = String(a ?? '').split('\n');
    const B = String(b ?? '').split('\n');
    const rows = [];
    if (A.length * B.length > 90000) {
      A.forEach((l) => rows.push(['-', l]));
      B.forEach((l) => rows.push(['+', l]));
    } else {
      const n = A.length; const m = B.length;
      const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0; let j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { rows.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) rows.push(['-', A[i++]]); else rows.push(['+', B[j++]]);
      }
      while (i < n) rows.push(['-', A[i++]]);
      while (j < m) rows.push(['+', B[j++]]);
    }
    const box = el('div', { class: 'ag-cl-diff' }, rows.map(([k, l]) => el('div', { class: `ag-cl-diff-l${k === '-' ? ' is-del' : k === '+' ? ' is-add' : ''}` },
      el('span', { class: 'ag-cl-diff-k' }, k), el('span', {}, l || ' '))));
    return clamp(box, rows.length, 40);
  }

  const TODO = { completed: '☑', in_progress: '◐', pending: '☐' };

  /** What a call was given, drawn for its tool. */
  function toolInput(m) {
    const i = m.input;
    if (!i) return m.text ? pre(m.text) : null;
    switch (m.tool) {
      case 'Bash': return el('div', { class: 'ag-cl-t-in' },
        i.background ? el('div', { class: 'ag-cl-t-desc' }, 'Runs in the background') : null,
        el('div', { class: 'ag-cl-t-cmd' }, el('span', { class: 'ag-cl-t-prompt' }, '$'), pre(i.command || ''), copyBtn(() => i.command || '', 'Copy command')));
      case 'Edit': return el('div', { class: 'ag-cl-t-in' }, pathDiv(i.file_path, i.replace_all ? ' (every match)' : ''), diff(i.old_string, i.new_string));
      case 'MultiEdit': return el('div', { class: 'ag-cl-t-in' }, pathDiv(i.file_path), (i.edits || []).map((e) => diff(e.old_string, e.new_string)));
      case 'Write': return el('div', { class: 'ag-cl-t-in' }, pathDiv(i.file_path, ` (${lineCount(i.content)} lines)`), clamp(el('pre', { class: 'ag-cl-t-pre' }, i.content || ''), lineCount(i.content), 30));
      case 'Read': return el('div', { class: 'ag-cl-t-in' }, pathDiv(i.file_path, i.offset || i.limit ? ` (lines ${i.offset || 1} to ${(i.offset || 1) + (i.limit || 0)})` : ''));
      case 'Glob': case 'Grep': return el('div', { class: 'ag-cl-t-in' }, el('div', { class: 'ag-cl-t-desc' }, [i.pattern ? `pattern ${i.pattern}` : null, i.glob ? `files ${i.glob}` : null].filter(Boolean).join(' · ')), i.path ? pathDiv(i.path) : null);
      case 'TodoWrite': return el('div', { class: 'ag-cl-t-in ag-cl-todos' }, (i.todos || []).map((t) => el('div', { class: `ag-cl-todo is-${t.status}` }, el('span', {}, TODO[t.status] || '☐'), el('span', {}, t.content))));
      case 'Task': case 'Agent': return el('div', { class: 'ag-cl-t-in' },
        onAgent && m.id ? el('button', { class: 'btn btn--ghost btn--sm ag-cl-t-agentbtn', type: 'button', onclick: (e) => { e.preventDefault(); onAgent(m.id); } }, svg('log'), 'Open its transcript') : null,
        el('div', { class: 'ag-cl-t-desc' }, [i.subagent_type, i.description].filter(Boolean).join(': ')),
        i.prompt ? clamp(el('div', { class: 'ag-cl-t-prose' }, md(i.prompt)), lineCount(i.prompt), 12) : null);
      default: return i.json && i.json !== '{}' ? el('div', { class: 'ag-cl-t-in' }, clamp(pre(i.json), lineCount(i.json), 20)) : null;
    }
  }

  /** One line saying what a call did, before it is opened. */
  function toolLine(m) {
    const i = m.input || {};
    if (['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(m.tool) && i.file_path) {
      return [el('span', { class: 'ag-cl-t-file' }, base(i.file_path)), el('span', { class: 'ag-cl-t-dir' }, dir(i.file_path))];
    }
    if (m.tool === 'Bash' && i.description) return [el('span', {}, i.description)];
    if (m.tool === 'TodoWrite' && i.todos) {
      const done = i.todos.filter((t) => t.status === 'completed').length;
      return [el('span', {}, `${done} of ${i.todos.length} done`)];
    }
    return [el('span', {}, m.text || '')];
  }

  // A summary's content sits in a span: Safari does not lay out a <summary>
  // itself as grid or flex, and the row then ran past the edge.
  const sum = (...kids) => el('summary', { class: 'ag-cl-t-sum' }, el('span', { class: 'ag-cl-t-sumrow' }, ...kids));

  function toolMeta(m) {
    const r = m.result;
    // An older runner sends calls without ids: their results are rows of
    // their own, and the call itself has no state to show.
    if (!r && !m.id) return el('span', { class: 'ag-cl-t-st' });
    if (!r) return el('span', { class: `ag-cl-t-st${m.stale ? '' : ' is-run'}` }, m.stale ? 'no result' : 'running');
    if (r.error) return el('span', { class: 'ag-cl-t-st is-err' }, 'error');
    const n = lineCount(r.text);
    if (m.tool === 'Edit' || m.tool === 'MultiEdit' || m.tool === 'Write') return el('span', { class: 'ag-cl-t-st is-ok' }, 'done');
    return el('span', { class: 'ag-cl-t-st is-ok' }, r.text?.trim() ? `${n} line${n === 1 ? '' : 's'}` : 'done');
  }

  function toolRow(m) {
    const live = () => !m.result && !m.stale && !!m.id;
    const d = el('details', { class: `ag-cl-t-tool${m.result?.error ? ' is-bad' : ''}${live() ? ' is-live' : ''}` });
    const fill = () => {
      const r = m.result;
      const out = r ? el('div', { class: 'ag-cl-t-out' },
        el('div', { class: 'ag-cl-t-outbar' }, el('span', {}, r.error ? 'Error' : 'Output'),
          r.size && r.size > (r.text || '').length ? el('span', { class: 'ag-cl-t-dim' }, `first ${r.text.length} of ${r.size} characters`) : null,
          r.text ? copyBtn(() => r.text, 'Copy output') : null),
        r.text?.trim() ? clamp(pre(r.text, r.error ? 'is-err' : ''), lineCount(r.text), 24) : el('div', { class: 'ag-cl-t-dim' }, '(no output)')) : null;
      d.replaceChildren(
        sum(
          el('span', { class: 'ag-cl-t-chev' }, svg('chevron')),
          el('span', { class: 'ag-cl-t-name' }, m.tool),
          el('span', { class: 'ag-cl-t-what' }, ...toolLine(m)),
          toolMeta(m)),
        el('div', { class: 'ag-cl-t-body' }, toolInput(m), out));
      d.classList.toggle('is-bad', !!m.result?.error);
      d.classList.toggle('is-live', live());
    };
    // The body is built the first time it is opened: most never are.
    let built = false;
    const lazy = () => {
      if (built) return;
      built = true;
      fill();
      d.open = true;
    };
    d.replaceChildren(sum(
      el('span', { class: 'ag-cl-t-chev' }, svg('chevron')),
      el('span', { class: 'ag-cl-t-name' }, m.tool),
      el('span', { class: 'ag-cl-t-what' }, ...toolLine(m)),
      toolMeta(m)));
    d.addEventListener('toggle', () => { if (d.open && !built) lazy(); });
    d._update = () => {
      if (built) { const o = d.open; fill(); d.open = o; } else {
        d.querySelector('.ag-cl-t-st')?.replaceWith(toolMeta(m));
        d.classList.toggle('is-bad', !!m.result?.error);
        d.classList.toggle('is-live', live());
      }
    };
    return d;
  }

  function render(m) {
    switch (m.role) {
      case 'user': {
        const n = lineCount(m.text);
        return el('div', { class: 'ag-cl-t-user' },
          el('div', { class: 'ag-cl-t-head' }, el('span', { class: 'ag-cl-t-who' }, 'You'), el('span', { class: 'ag-cl-t-time' }, time(m.at)),
            m.images ? el('span', { class: 'ag-cl-t-dim' }, `${m.images} image${m.images === 1 ? '' : 's'}`) : null,
            copyBtn(() => m.text, 'Copy message')),
          n > 12 || String(m.text || '').length > 1500 ? userText(m.text) : clamp(el('div', { class: 'ag-cl-t-text' }, ...withPaths(m.text)), n, 16));
      }
      case 'assistant':
        return el('div', { class: 'ag-cl-t-asst' },
          el('div', { class: 'ag-cl-t-head' }, el('span', { class: 'ag-cl-t-who' }, modelLabel(m.model) || 'Claude'), el('span', { class: 'ag-cl-t-time' }, time(m.at)),
            copyBtn(() => m.text, 'Copy reply')),
          md(m.text));
      case 'thinking': {
        // A button, not a <summary>: Safari did not open a summary laid out
        // as a block, so thinking could not be expanded on the phone.
        const empty = !m.text?.trim();
        const box = el('div', { class: `ag-cl-t-think${empty ? ' is-empty' : ''}` });
        const bodyEl = el('div', { class: 'ag-cl-t-thinkbody', hidden: true });
        const btn = el('button', { class: 'ag-cl-t-thinksum', type: 'button', 'aria-expanded': 'false' },
          el('span', { class: 'ag-cl-t-thinkrow' }, el('span', { class: 'ag-cl-t-chev' }, svg('chevron')), el('span', { class: 'ag-cl-t-thinkmark' }, '∴'), el('span', {}, empty ? 'Thought' : 'Thinking'),
            el('span', { class: 'ag-cl-t-thinkprev' }, empty ? 'not saved' : m.text.replace(/\s+/g, ' ').slice(0, 140))));
        btn.addEventListener('click', () => {
          const open = bodyEl.hidden;
          if (open && !bodyEl.firstChild) {
            bodyEl.append(empty
              ? el('p', { class: 'ag-cl-t-dim' }, 'The model thought here, but this thinking was not written to the conversation file (the API returns it summarised or encrypted, and Claude Code keeps only a signature). Claude Code cannot show it either once the turn is over.')
              : md(m.text));
          }
          bodyEl.hidden = !open;
          box.classList.toggle('is-open', open);
          btn.setAttribute('aria-expanded', String(open));
        });
        box.append(btn, bodyEl);
        return box;
      }
      case 'tool': return toolRow(m);
      case 'result': {
        const first = String(m.text || '').split('\n')[0];
        return el('details', { class: `ag-cl-t-tool${m.error ? ' is-bad' : ''}` },
          sum( el('span', { class: 'ag-cl-t-chev' }, svg('chevron')), el('span', { class: 'ag-cl-t-name' }, 'Output'), el('span', { class: 'ag-cl-t-what' }, first || '(no output)')),
          el('div', { class: 'ag-cl-t-body' }, pre(m.text || '')));
      }
      case 'command':
        return el('div', { class: 'ag-cl-t-slash' }, el('span', { class: 'ag-cl-t-slashname' }, m.text.startsWith('/') ? m.text : `/${m.text}`), m.args ? el('span', {}, m.args) : null, el('span', { class: 'ag-cl-t-time' }, time(m.at)));
      case 'command-out':
        return el('div', { class: 'ag-cl-t-cmdout' }, clamp(pre(m.text), lineCount(m.text), 20));
      case 'turn':
        return el('div', { class: 'ag-cl-t-turn' }, `Turn took ${dur(m.ms)}`);
      case 'error':
        return el('div', { class: 'ag-cl-t-err' }, el('div', { class: 'ag-cl-t-head' }, el('span', { class: 'ag-cl-t-who' }, `Request failed · ${m.kind}`), el('span', { class: 'ag-cl-t-time' }, time(m.at))), el('div', { class: 'ag-cl-t-text' }, m.text));
      case 'note':
      default:
        return el('div', { class: `ag-cl-t-note${m.kind === 'warning' ? ' is-warn' : ''}` }, el('span', {}, m.kind === 'task' ? `Background task: ${m.text}` : m.text));
    }
  }

  /* ── the list ─────────────────────────────────────────────── */

  const scroll = el('div', { class: 'ag-cl-transcript', tabindex: '0', 'aria-label': 'Transcript' });
  const top = el('div', { class: 'ag-cl-t-top' });
  const list = el('div', { class: 'ag-cl-t-list' });
  const jump = el('button', { class: 'ag-cl-jump', type: 'button', hidden: true, onclick: () => toBottom(true) }, svg('arrow'), 'Latest');
  // Quick jumps: top, previous message, next message, bottom. A message is
  // one of your turns or one of Claude's replies; tool rows are skipped.
  const msgs = () => [...list.querySelectorAll('.ag-cl-t-user, .ag-cl-t-asst')];
  const goTo = (node) => { if (!node) return; scroll.scrollTop = Math.max(0, node.offsetTop - list.offsetTop - 6); follow = nearBottom(); };
  const stepMsg = (dir) => {
    const at = scroll.scrollTop + list.offsetTop;
    const all = msgs();
    if (dir > 0) {
      const next = all.find((n) => n.offsetTop > at + 10);
      if (next) goTo(next); else toBottom(true);
    } else {
      const prev = all.filter((n) => n.offsetTop < at - 10).pop();
      if (prev) goTo(prev); else toTop();
    }
  };
  const toTop = () => { scroll.scrollTop = 0; follow = false; };
  const jumpBtn = (label, glyph, fn) => el('button', { class: 'ag-cl-tjump-b', type: 'button', title: label, 'aria-label': label, onpointerdown: (e) => e.preventDefault(), onclick: fn }, glyph);
  const jumps = el('div', { class: 'ag-cl-tjump', role: 'toolbar', 'aria-label': 'Move through the chat' },
    jumpBtn('Top of the chat', '⤒', toTop),
    jumpBtn('Previous message', '↑', () => stepMsg(-1)),
    jumpBtn('Next message', '↓', () => stepMsg(1)),
    jumpBtn('Bottom of the chat', '⤓', () => toBottom(true)));
  scroll.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); stepMsg(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepMsg(1); }
    else if (e.key === 'Home') { e.preventDefault(); toTop(); }
    else if (e.key === 'End') { e.preventDefault(); toBottom(true); }
  });
  const wrap = el('div', { class: 'ag-cl-txwrap' }, scroll, jumps, jump);
  // Messages sent while Claude was mid-turn: shown faded at the end until
  // they turn up in the conversation as real turns.
  const pendingBox = el('div', { class: 'ag-cl-t-pending' });
  scroll.append(top, list, pendingBox);

  // items: every message loaded, tool results folded into their call.
  // first: the index of the oldest item drawn.
  let items = [];
  let first = 0;
  let start = 0;
  let truncated = false;
  let loading = false;
  let older = false;
  let byTool = new Map();
  let orphans = new Map();

  /** Results go into the call they answer; a call without one stays live. */
  function fold(msgs, into) {
    const added = [];
    const touched = [];
    for (const m of msgs) {
      if (m.role === 'result' && m.toolUseId) {
        const t = byTool.get(m.toolUseId);
        if (t) { t.result = m; touched.push(t); continue; }
        orphans.set(m.toolUseId, m);
      }
      if (m.role === 'tool' && m.id) {
        byTool.set(m.id, m);
        // Paging back: this call's result is already drawn, as a row of its
        // own, from the later page. It moves into the call.
        const o = orphans.get(m.id);
        if (o) {
          orphans.delete(m.id);
          m.result = o;
          o._node?.remove();
          const k = items.indexOf(o);
          if (k >= 0) { items.splice(k, 1); if (k < first) first -= 1; }
        }
      }
      // A result can come before its call was seen (it was cut off the top of
      // the first page): it stays a row of its own.
      added.push(m);
    }
    if (into === 'end') items.push(...added); else items.unshift(...added);
    return { added, touched };
  }

  /** Calls that never got a result, before a later turn: not "running". */
  function settle() {
    let seenUser = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m.role === 'user' || m.role === 'turn') seenUser = true;
      if (m.role === 'tool' && !m.result && seenUser && !m.stale) { m.stale = true; m._node?._update?.(); }
    }
  }

  const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  function toBottom(force) {
    if (force || nearBottom()) { scroll.scrollTop = scroll.scrollHeight; follow = true; }
    jump.hidden = true;
  }

  function node(m) {
    if (!m._node) m._node = render(m);
    return m._node;
  }

  function drawTop() {
    const left = first;
    top.replaceChildren(...[
      left > 0 ? el('button', { class: 'ag-cl-t-earlier', type: 'button', onclick: () => earlier() }, `Show ${Math.min(STEP, left)} earlier`)
        : truncated ? el('button', { class: 'ag-cl-t-earlier', type: 'button', disabled: loading, onclick: () => earlier() }, loading ? 'Loading earlier messages…' : 'Load earlier messages')
          : items.length ? el('div', { class: 'ag-cl-t-start' }, older ? 'Earlier messages are in the file (this runner cannot page back)' : 'Start of the conversation') : null,
    ].filter(Boolean));
  }

  function drawAll() {
    first = Math.max(0, items.length - STEP);
    list.replaceChildren(...items.slice(first).map(node));
    if (!items.length) list.append(el('div', { class: 'ag-cl-t-empty' }, 'Nothing here yet.'));
    drawTop();
  }

  /** Draw earlier rows above, keeping what is on screen where it is. */
  async function earlier() {
    if (first > 0) {
      const from = Math.max(0, first - STEP);
      const h = scroll.scrollHeight;
      list.prepend(...items.slice(from, first).map(node));
      first = from;
      drawTop();
      scroll.scrollTop += scroll.scrollHeight - h;
      return;
    }
    if (!truncated || loading || !onEarlier) return;
    loading = true;
    drawTop();
    try {
      const r = await onEarlier(start);
      if (r) {
        const h = scroll.scrollHeight;
        const { added } = fold(r.messages || [], 'start');
        settle();
        start = r.start ?? 0;
        truncated = !!r.truncated;
        // `first` was 0; the new rows sit above it, drawn a page at a time.
        first = added.length;
        loading = false;
        const from = Math.max(0, first - STEP);
        list.prepend(...items.slice(from, first).map(node));
        first = from;
        drawTop();
        scroll.scrollTop += scroll.scrollHeight - h;
      }
    } catch (e) {
      toast?.('err', 'Could not load earlier messages', e.message);
    } finally {
      loading = false;
      drawTop();
    }
  }

  // Scrolled to the top, the next page comes without a click. Armed only once
  // the reader has scrolled, so the first draw does not page back by itself.
  // Following: the reader is at the bottom, so new rows (and the box
  // shrinking as a menu opens under it) keep the bottom in view.
  let armed = false;
  let follow = true;
  scroll.addEventListener('scroll', () => {
    armed = true;
    follow = nearBottom();
    if (follow) jump.hidden = true;
  }, { passive: true });
  const ro = new ResizeObserver(() => { if (follow) scroll.scrollTop = scroll.scrollHeight; });
  ro.observe(scroll);
  const io = new IntersectionObserver((entries) => {
    if (armed && entries.some((e) => e.isIntersecting) && (first > 0 || truncated) && !loading) earlier();
  }, { root: scroll, rootMargin: '200px 0px 0px 0px' });
  io.observe(top);

  return {
    el: wrap,
    scroll,
    md,
    /** The first page: replaces everything. */
    reset(msgs, info = {}) {
      items = [];
      byTool = new Map();
      orphans = new Map();
      fold(msgs, 'end');
      settle();
      start = info.start ?? 0;
      truncated = !!info.truncated;
      older = !!info.older;
      drawAll();
      requestAnimationFrame(() => toBottom(true));
    },
    /** New messages at the end, from the poll. */
    append(msgs) {
      if (!msgs.length) return;
      const stick = follow || nearBottom();
      const empty = list.querySelector('.ag-cl-t-empty');
      const { added, touched } = fold(msgs, 'end');
      empty?.remove();
      for (const t of touched) t._node?._update?.();
      list.append(...added.map(node));
      settle();
      // A long-open tab trims what it draws back to a few pages.
      if (items.length - first > STEP * 4 && stick) {
        const keep = items.length - STEP * 2;
        for (let i = first; i < keep; i++) items[i]._node?.remove();
        first = keep;
        drawTop();
      }
      if (stick) toBottom(true); else if (added.length) jump.hidden = false;
    },
    error(msg) {
      list.querySelector('.ag-cl-t-errnote')?.remove();
      if (msg) list.append(el('div', { class: 'ag-cl-t-note is-warn ag-cl-t-errnote' }, el('span', {}, msg)));
    },
    /** The last call still waiting on its result: what is running now. */
    running() {
      for (let i = items.length - 1; i >= 0 && i >= items.length - 30; i--) {
        const m = items[i];
        if (m.role === 'tool' && !m.result && !m.stale && m.id) return m;
        if (m.role === 'user') return null;
      }
      return null;
    },
    count: () => items.length,
    /** Whether a turn of yours with this text has arrived since `since` (ms). */
    hasUserText(text, since) {
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const want = norm(text);
      return items.some((m) => {
        if (m.role !== 'user' || norm(m.text) !== want) return false;
        const at = typeof m.at === 'number' ? m.at : Date.parse(m.at);
        return !Number.isFinite(at) || at >= since - 120000;
      });
    },
    /** Draw the queued messages (newest last), or none. */
    /**
     * Messages not in the conversation yet, at the end: each { text, at,
     * label, warn, actions: [{ label, title, run, primary }] }.
     */
    setPending(queued) {
      const stick = follow || nearBottom();
      pendingBox.replaceChildren(...(queued || []).map((q) => el('div', { class: `ag-cl-t-user is-pending${q.warn ? ' is-stuck' : ''}` },
        el('div', { class: 'ag-cl-t-head' }, el('span', { class: 'ag-cl-t-who' }, 'You'),
          el('span', { class: 'ag-cl-t-queued' }, q.label || 'Queued'),
          el('span', { class: 'ag-cl-t-time' }, time(q.at))),
        userText(q.text),
        (q.actions || []).length ? el('div', { class: 'ag-cl-t-pendacts' }, q.actions.map((x) => el('button', {
          class: `btn ${x.primary ? '' : 'btn--ghost'} btn--sm`, type: 'button', title: x.title || null, onclick: x.run,
        }, x.label))) : null)));
      if (stick) toBottom(true);
    },
    /** Whether this conversation launched any subagents. */
    hasAgents: () => items.some((m) => m.role === 'tool' && (m.tool === 'Agent' || m.tool === 'Task')),
    /** What the reader sent goes to the bottom with them. */
    follow() { follow = true; toBottom(true); },
    destroy() { io.disconnect(); ro.disconnect(); },
  };
}
