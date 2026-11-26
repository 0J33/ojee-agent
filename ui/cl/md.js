/* ============================================================
   Markdown, diffs and path links for the chat — built as nodes.
   The subset Claude writes: paragraphs, headings, lists (with
   task boxes), quotes, rules, tables, fenced code, inline code,
   bold, italics, links. Absolute and ~ paths become links that
   open the explorer.
   ============================================================ */

import { h, icon, copyText } from './dom.js';

const PATH = /(?<![\w:/.~-])((?:~\/|\/)(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-](?::\d+(?::\d+)?)?)/g;
const LINK_MAX = 200_000;

export function makeMd({ onPath, toast } = {}) {
  const pathLink = (p) => h('a', {
    class: 'cl-path', href: '#', title: `Open ${p}`,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onPath?.(p); },
  }, p);

  function withPaths(text) {
    const t = String(text ?? '');
    if (!onPath || t.length > LINK_MAX) return [t];
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

  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])/g;
  function inline(text) {
    const out = [];
    let last = 0;
    const t = String(text);
    for (const m of t.matchAll(INLINE)) {
      if (m.index > last) out.push(...withPaths(t.slice(last, m.index)));
      if (m[1] != null) out.push(h('code', {}, ...withPaths(m[1])));
      else if (m[2] != null) out.push(h('strong', {}, ...inline(m[2])));
      else if (m[3] != null) out.push(h('em', {}, ...inline(m[3])));
      else { const href = m[5] || m[6]; out.push(h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, m[4] || m[6])); }
      last = m.index + m[0].length;
    }
    if (last < t.length) out.push(...withPaths(t.slice(last)));
    return out;
  }

  const copyBtn = (get, label = 'Copy') => h('button', {
    class: 'ib sm cl-copy', type: 'button', title: label, 'aria-label': label,
    onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      const b = e.currentTarget;
      const ok = await copyText(get());
      b.replaceChildren(icon(ok ? 'check' : 'copy', 's'));
      setTimeout(() => b.replaceChildren(icon('copy', 's')), 1400);
      if (!ok) toast?.('err', 'Could not copy', 'The browser refused the clipboard.');
    },
  }, icon('copy', 's'));

  const codeBlock = (code, lang) => h('figure', { class: 'cl-code' },
    h('figcaption', {}, h('span', { class: 'm' }, lang || 'text'), copyBtn(() => code, 'Copy code')),
    h('pre', {}, code));

  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function md(src) {
    const out = h('div', { class: 'cl-md' });
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let para = [];
    let list = null;
    const flush = () => {
      if (para.length) {
        const p = h('p');
        para.forEach((l, i) => { if (i) p.append(h('br')); p.append(...inline(l)); });
        out.append(p);
        para = [];
      }
    };
    const endList = () => { list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^\s*```\s*([\w+#.-]*)/.exec(line))) {
        flush(); endList();
        const code = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
        out.append(codeBlock(code.join('\n'), m[1]));
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        flush(); endList();
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
        const [head, ...rest] = body;
        out.append(h('div', { class: 'cl-table' }, h('table', {},
          head ? h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, ...inline(c))))) : null,
          h('tbody', {}, rest.map((r) => h('tr', {}, r.map((c) => h('td', {}, ...inline(c)))))))));
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush(); endList();
        out.append(h(`h${Math.min(m[1].length + 2, 6)}`, {}, ...inline(m[2])));
      } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
        flush();
        const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
        const task = m[3] != null;
        const ordered = /\d/.test(m[2]);
        if (!list) { list = h('div', { class: 'cl-ul' }); out.append(list); }
        list.append(h('div', { class: `cl-li${task ? ' task' : ''}${task && m[3] !== ' ' ? ' done' : ''}`, style: `--d:${depth}` },
          h('span', { class: `mk${ordered ? ' m' : ''}` }, task ? icon(m[3] === ' ' ? 'dot' : 'check', 's') : ordered ? m[2] : '•'),
          h('span', {}, ...inline(m[4]))));
      } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flush(); endList();
        out.append(h('blockquote', {}, ...inline(m[1])));
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush(); endList();
        out.append(h('hr'));
      } else if (!line.trim()) {
        flush(); endList();
      } else {
        endList();
        para.push(line);
      }
    }
    flush();
    return out;
  }

  /** A pre block with its paths linked, unless it is huge. */
  const pre = (text, cls = '') => h('pre', { class: `cl-pre ${cls}`.trim() }, ...withPaths(text));

  return { md, inline, withPaths, pre, copyBtn, pathLink };
}

/**
 * A diff, from the edit's own hunks (line numbers, as Claude Code recorded
 * them) when there are some, else worked out from old and new text.
 */
export function diffView({ patch, oldText, newText }) {
  const rows = [];
  if (Array.isArray(patch) && patch.length) {
    for (const hk of patch) {
      rows.push({ k: '@', t: `@@ −${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@` });
      let o = hk.oldStart; let n = hk.newStart;
      for (const l of hk.lines) {
        const k = l[0] === '-' ? '-' : l[0] === '+' ? '+' : ' ';
        rows.push({ k, t: l.slice(1), o: k === '+' ? '' : o, n: k === '-' ? '' : n });
        if (k !== '+') o++;
        if (k !== '-') n++;
      }
      if (hk.cut) rows.push({ k: '@', t: '… more lines in this hunk' });
    }
  } else {
    const A = String(oldText ?? '').split('\n');
    const B = String(newText ?? '').split('\n');
    if (A.length * B.length > 90000) {
      A.forEach((l) => rows.push({ k: '-', t: l }));
      B.forEach((l) => rows.push({ k: '+', t: l }));
    } else {
      const n = A.length; const m = B.length;
      const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0; let j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { rows.push({ k: ' ', t: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) rows.push({ k: '-', t: A[i++] }); else rows.push({ k: '+', t: B[j++] });
      }
      while (i < n) rows.push({ k: '-', t: A[i++] });
      while (j < m) rows.push({ k: '+', t: B[j++] });
    }
  }
  const add = rows.filter((r) => r.k === '+').length;
  const del = rows.filter((r) => r.k === '-').length;
  const box = h('div', { class: 'cl-diff m', role: 'table', 'aria-label': `${add} lines added, ${del} removed` },
    rows.map((r) => (r.k === '@'
      ? h('div', { class: 'hunk' }, r.t)
      : h('div', { class: `ln${r.k === '-' ? ' del' : r.k === '+' ? ' add' : ''}` },
        h('span', { class: 'no' }, r.o ?? ''), h('span', { class: 'no' }, r.n ?? ''),
        h('span', { class: 'k' }, r.k === ' ' ? '' : r.k), h('span', { class: 'tx' }, r.t || ' ')))));
  return { el: box, add, del, rows: rows.length };
}
