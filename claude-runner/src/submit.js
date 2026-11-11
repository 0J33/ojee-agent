/**
 * Press Enter only once the typed text is in Claude Code's input box.
 *
 * Claude Code shows a faint suggested next message in an empty input box,
 * and Enter on that box sends the suggestion. Typed text can take a moment
 * to land (a long message is read as a paste), so an Enter sent on a fixed
 * delay could reach an empty box and send the suggestion instead of the
 * message. Owner hit this on 5 Nov.
 */
const { parseScreen } = require('./screen');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns true when Enter was pressed. Returns false, without pressing it,
 * when the box still shows only Claude Code's suggestion at the deadline.
 * With no input box on screen (another view is open) it falls back to
 * pressing Enter at the deadline, as before.
 */
/**
 * Typed text that landed but is drawn faint all the same: a long message
 * Claude Code folds into "[Pasted text #1 +12 lines]", or an image path it
 * turned into "[Image #1]". Read as a suggestion, it once left a message in
 * the box forever, unsent (owner, 11 Nov).
 */
const FOLDED = /\[(?:Pasted text|Image|File) #\d+/;

/**
 * @param {object} [o.before]  parseScreen() of the screen before typing: a
 *   faint box whose text changed since then holds what was typed.
 */
async function enterWhenTyped(tmux, name, { timeout = 4000, step = 120, first = 150, before = null } = {}) {
  const until = Date.now() + timeout;
  await delay(first);
  for (;;) {
    const scr = parseScreen(await tmux.capture(name, { ansi: true }));
    if (scr.draft && !scr.suggestion) break;
    if (FOLDED.test(scr.draft || scr.suggestion || '')) break;
    if (scr.suggestion && before && before.suggestion !== scr.suggestion && (before.draft || '') !== scr.suggestion) break;
    if (Date.now() >= until) {
      if (scr.suggestion) return false;
      break;
    }
    await delay(step);
  }
  await tmux.keys(name, 'Enter');
  return true;
}

module.exports = { enterWhenTyped };
