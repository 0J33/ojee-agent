/**
 * Parts of this module that can be switched off without removing any code.
 *
 * AGENT_DISABLE is a comma-separated list of: assistant, workflows, odysseus.
 * Unset, it is the default below — the Assistant, the Workflows view and
 * Odysseus were switched off on 2026-11-26 ahead of a redesign. Set it to an
 * empty string (AGENT_DISABLE=) to bring all three back, or list only the
 * ones that should stay off.
 *
 *   assistant  no OpenCode connection, no Assistant view, no `assistant` in
 *              the manifest (so the console offers no Assistant button)
 *   workflows  no Workflows view, no n8n facts or alerts on the overview
 *              (n8n itself keeps running and stays in Services)
 *   odysseus   no Odysseus view or probe, and its containers (Odysseus,
 *              ChromaDB, SearXNG, ntfy) leave Services, so stopping them
 *              raises no alerts
 */
const DEFAULT_OFF = 'assistant,workflows,odysseus';

const OFF = new Set(String(process.env.AGENT_DISABLE ?? DEFAULT_OFF)
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

module.exports = { off: (name) => OFF.has(name), list: () => [...OFF] };
