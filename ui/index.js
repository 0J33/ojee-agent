/* ============================================================
   ojee-agent, in the console as Claude.

   The module is one view now: Claude Code sessions on every
   machine that runs them (cl/app.js). The Assistant is off by
   default (AGENT_DISABLE); switched on, its old view still mounts
   from assistant.js.
   ============================================================ */

import { mountClaude, routeClaude, unmountClaude } from './cl/app.js';

let ctx = null;
let root = null;
let current = null;

async function show(view) {
  if (view === 'assistant') {
    if (current === 'claude') unmountClaude();
    const m = await import('./assistant.js');
    if (current !== 'assistant') { current = 'assistant'; await m.mountAssistant(root, ctx); } else m.routeAssistant();
    return;
  }
  if (current === 'assistant') { (await import('./assistant.js')).unmountAssistant(); current = null; }
  if (current === 'claude') { routeClaude(); return; }
  current = 'claude';
  await mountClaude(root, ctx);
}

export default {
  async mount(el, context) {
    root = el;
    ctx = context;
    // iOS enlarges text it judges too small, differently per view.
    document.documentElement.style.setProperty('-webkit-text-size-adjust', '100%');
    await show(context.view === 'assistant' ? 'assistant' : 'claude');
  },
  async setView(view) { await show(view === 'assistant' ? 'assistant' : 'claude'); },
  async unmount() {
    if (current === 'claude') unmountClaude();
    if (current === 'assistant') (await import('./assistant.js')).unmountAssistant();
    current = null; root = null; ctx = null;
  },
};
