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
 * @returns {{ menu, activity, agents, mode, draft }}
 */
function parseScreen(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
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
  let mode = null;
  const agents = [];
  if (box > 0) {
    const d = lines[box].replace(/^\s*❯\s?/, '').trimEnd();
    // A placeholder is drawn dim, which capture-pane cannot tell apart; the
    // ones Claude Code shows start with "Try" in quotes.
    if (d.trim() && !/^Try "/.test(d.trim())) draft = d.trim();
    for (let i = box + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      const mm = MODE.exec(t);
      if (mm && !mode) mode = (mm[1] || mm[2]).trim();
      const a = AGENT.exec(t);
      if (a && a[1] !== 'main') agents.push({ name: a[1], doing: a[2].trim(), meta: a[3] ? a[3].trim() : null });
    }
  }
  return { menu, activity, agents, mode, draft };
}

module.exports = { parseScreen, parseMenu };
