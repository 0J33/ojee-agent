/**
 * Reading Claude Code's screen for what the transcript file cannot say: a
 * menu open right now (a permission prompt, an AskUserQuestion, /model), the
 * spinner line ("✻ Cogitating… (12s · esc to interrupt)"), the background
 * agents listed under the input box, the permission mode, and text typed in
 * the input box but not sent.
 *
 * All of it is read from `tmux capture-pane` text, so it is a best effort:
 * every field is null when its shape is not on screen. Nothing here acts.
 */

/** Box-drawing borders Claude Code draws round dialogs. */
const BORDER = /^[\s│┃|╭╮╰╯─━┌┐└┘]+|[\s│┃|╭╮╰╯─━┌┐└┘]+$/g;
const bare = (l) => l.replace(BORDER, '');

/** "❯ 1. Yes" / "  2. No, and tell Claude what to do differently (esc)" */
const OPTION = /^(❯|›|>)?\s*(\d{1,2})[.)]\s+(.+)$/;
const FOOTER = /(Enter to (?:select|confirm|submit|continue)|Esc to (?:cancel|exit|go back)|↑\/↓ to (?:navigate|select)|Tab to)/i;
const SPINNER = /^[✻✶✳✢✽·*⏺∗✦]\s+(\S.*)$/;
const AGENT = /^[◯●○◉◎]\s+(\S+)\s{2,}(.+?)(?:\s{2,}(\S.*))?$/;
const MODE = /⏵⏵\s*(.+?)\s+on\b|⏸\s*(plan mode)\s+on\b/i;

/**
 * The open menu nearest the bottom of the screen, or null. A list counts as
 * a menu only when one of its options carries the selection cursor (❯):
 * Claude's own numbered lists in a reply never do.
 */
function parseMenu(lines) {
  let end = lines.length - 1;
  // Walk up from the bottom to the last option line that has a cursor.
  let cur = -1;
  for (let i = end; i >= 0 && i >= lines.length - 60; i--) {
    const m = OPTION.exec(bare(lines[i]));
    if (m && m[1]) { cur = i; break; }
  }
  if (cur < 0) return null;

  // Grow the group both ways: option lines, and the indented description
  // lines under them.
  const idx = [];
  let first = cur;
  for (let i = cur; i >= 0 && i >= cur - 40; i--) {
    const t = bare(lines[i]);
    if (OPTION.test(t)) { first = i; continue; }
    if (!t.trim()) { if (i < cur - 1 && OPTION.test(bare(lines[i - 1] || ''))) continue; break; }
    // A description line sits under an option and is indented deeper.
    if (/^\s{3,}\S/.test(lines[i].replace(/^[│┃|]/, '')) && i > 0) continue;
    break;
  }
  let last = cur;
  for (let i = cur + 1; i < lines.length && i <= cur + 40; i++) {
    const t = bare(lines[i]);
    if (OPTION.test(t)) { last = i; continue; }
    if (!t.trim() && OPTION.test(bare(lines[i + 1] || ''))) continue;
    if (!t.trim() || FOOTER.test(t)) break;
    if (/^\s{3,}\S/.test(lines[i].replace(/^[│┃|]/, ''))) { last = i; continue; }
    break;
  }

  const options = [];
  let more = false;
  for (let i = first; i <= last; i++) {
    const t = bare(lines[i]);
    const m = OPTION.exec(t);
    if (m) {
      // Columns ("Opus 5.5        For complex work") split into label and note.
      const [label, ...rest] = m[3].trim().split(/\s{2,}/);
      options.push({ n: Number(m[2]), label: label.trim(), selected: !!m[1], line: i, desc: rest.join(' ').trim() });
      idx.push(i);
    } else if (/^\s*([↓↑]\s*\d|…)/.test(t)) {
      more = true;
    } else if (options.length && t.trim()) {
      const o = options[options.length - 1];
      o.desc = `${o.desc ? `${o.desc} ` : ''}${t.trim()}`;
    }
  }
  if (options.length < 2) return null;
  // Numbered 1..n, in order: anything else is not a menu we can drive.
  if (options.some((o, i) => o.n !== options[0].n + i)) return null;

  // The title: the non-empty lines just above the first option (up to three).
  const title = [];
  for (let i = first - 1; i >= 0 && title.length < 3; i--) {
    const t = bare(lines[i]).trim();
    if (!t) { if (title.length) break; continue; }
    if (/^[─━═▔▁_-]+$/.test(t)) break;
    title.unshift(t);
  }
  let footer = null;
  for (let i = last + 1; i < lines.length && i <= last + 4; i++) {
    const t = bare(lines[i]).trim();
    if (FOOTER.test(t)) { footer = t; break; }
  }
  // Letter keys the footer offers ("s to use this session only").
  const hotkeys = [];
  for (const part of String(footer || '').split(/\s+·\s+/)) {
    const h = /^([a-z])\s+to\s+(.+)$/i.exec(part.trim());
    if (h) hotkeys.push({ key: h[1], label: h[2] });
  }
  return {
    title: title.join('\n') || null,
    options: options.map(({ n, label, selected, desc }) => ({ n, label, selected, desc: desc || null })),
    footer,
    hotkeys,
    multi: options.some((o) => /^\[[ x✔✓]\]|^☐|^☒|^◻|^◼/.test(o.label)),
    // More options than fit: the rest are reached with the arrows.
    more,
  };
}

/** Where the input box is: the rule above the ❯ prompt line. */
function inputBox(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]) && /^[\s─━]*─{8,}/.test(lines[i - 1])) return i;
  }
  return -1;
}

/**
 * @param {string} text  a captured screen
 * @returns {{ menu, activity, agents, mode, draft, suggestion }}
 */
const SGR = /\x1b\[([0-9;]*)m/g;

/**
 * Whether every visible character after the input mark is drawn faint (dim,
 * or a grey colour): Claude Code's suggested next message and its
 * placeholders, as opposed to text someone typed. Needs a capture with -e.
 */
function faintInput(rawLine) {
  const at = rawLine.indexOf('❯');
  if (at < 0) return false;
  let dim = false; let grey = false; let seen = false; let faint = true;
  const s = rawLine;
  // Walk the line, tracking the SGR state, judging only characters after the mark.
  let pos = 0;
  const parts = [];
  SGR.lastIndex = 0;
  let m;
  while ((m = SGR.exec(s))) { parts.push([s.slice(pos, m.index), null]); parts.push([null, m[1]]); pos = SGR.lastIndex; }
  parts.push([s.slice(pos), null]);
  let after = false;
  for (const [txt, code] of parts) {
    if (code != null) {
      const c = code === '' ? ['0'] : code.split(';');
      for (let k = 0; k < c.length; k++) {
        const n = Number(c[k]);
        if (n === 0) { dim = false; grey = false; }
        else if (n === 2) dim = true;
        else if (n === 22) dim = false;
        else if (n === 39) grey = false;
        else if (n === 90) grey = true;
        else if ((n >= 30 && n <= 37) || (n >= 91 && n <= 97)) grey = false;
        else if (n === 38 && c[k + 1] === '5') { const v = Number(c[k + 2]); grey = (v >= 238 && v <= 250) || v === 8; k += 2; }
        else if (n === 38 && c[k + 1] === '2') { const [r, g, b] = [c[k + 2], c[k + 3], c[k + 4]].map(Number); grey = Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r < 190; k += 4; }
      }
      continue;
    }
    for (const ch of txt) {
      if (!after) { if (ch === '❯') after = true; continue; }
      if (ch.trim() === '' || ch === '\u00a0') continue;
      seen = true;
      if (!dim && !grey) faint = false;
    }
  }
  return seen && faint;
}

function parseScreen(text) {
  const raw = String(text || '').replace(/\r/g, '').split('\n');
  const lines = raw.map((l) => l.replace(SGR, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const box = inputBox(lines);
  const menu = parseMenu(box > 0 ? lines.slice(0, box - 1).concat(lines.slice(box + 2)) : lines);

  let activity = null;
  const above = box > 0 ? box - 1 : lines.length;
  for (let i = above - 1; i >= 0 && i >= above - 8; i--) {
    const m = SPINNER.exec(lines[i].trim());
    if (m && /…|\.\.\.|\(|esc to interrupt|Waiting|ing\b/i.test(m[1])) { activity = m[1].replace(/\s+/g, ' ').trim(); break; }
  }

  let draft = null;
  let suggestion = null;
  let mode = null;
  const agents = [];
  if (box > 0) {
    const d = lines[box].replace(/^\s*❯\s?/, '').trimEnd();
    // A placeholder is drawn dim, which capture-pane cannot tell apart; the
    // ones Claude Code shows start with "Try" in quotes.
    // With colour codes, faint text is Claude Code's suggestion (Tab takes
    // it), never something typed. Without them, the old guess stands.
    const hasAnsi = raw[box] !== lines[box];
    if (d.trim() && hasAnsi && faintInput(raw[box])) { if (!/^Try "/.test(d.trim())) suggestion = d.trim(); }
    else if (d.trim() && !/^Try "/.test(d.trim())) draft = d.trim();
    for (let i = box + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      const mm = MODE.exec(t);
      if (mm && !mode) mode = (mm[1] || mm[2]).trim();
      const a = AGENT.exec(t);
      if (a && a[1] !== 'main') agents.push({ name: a[1], doing: a[2].trim(), meta: a[3] ? a[3].trim() : null });
    }
  }
  return { menu, activity, agents, mode, draft, suggestion };
}

module.exports = { parseScreen, parseMenu };
