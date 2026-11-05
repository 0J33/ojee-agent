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
async function enterWhenTyped(tmux, name, { timeout = 4000, step = 120, first = 150 } = {}) {
  const until = Date.now() + timeout;
  await delay(first);
  for (;;) {
    const scr = parseScreen(await tmux.capture(name, { ansi: true }));
    if (scr.draft && !scr.suggestion) break;
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
