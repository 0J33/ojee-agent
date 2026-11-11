/**
 * Every slash command a session can take, for the console's "/" list:
 * Claude Code's own commands, then custom commands and skills from the
 * account's config dir, the session's project (.claude/ in its folder and
 * its parents) and installed plugins. Read from disk on each call, so a
 * skill added a minute ago shows up; a few hundred small files at most.
 *
 * The console types whatever is picked into the terminal as it is, so a
 * command missing from here can still be typed in full.
 */

const fs = require('fs');
const path = require('path');

/** [name, what it does, takes words after it] */
const BUILTIN = [
  ['/add-dir', 'Add a working folder', true],
  ['/agents', 'Manage subagents'],
  ['/bashes', 'Background shells'],
  ['/bug', 'Report a bug to Anthropic'],
  ['/clear', 'Start a fresh conversation in this session'],
  ['/compact', 'Summarise the conversation to free context; words after it say what to keep', true],
  ['/config', 'Settings'],
  ['/context', 'How full the context window is'],
  ['/cost', 'Tokens and cost so far'],
  ['/doctor', 'Check the installation'],
  ['/exit', 'Quit Claude Code'],
  ['/export', 'Export the conversation', true],
  ['/help', 'Every command'],
  ['/hooks', 'Hooks'],
  ['/ide', 'IDE integrations'],
  ['/init', 'Write a CLAUDE.md for this folder'],
  ['/install-github-app', 'Set up the GitHub app'],
  ['/login', 'Log in to an account'],
  ['/logout', 'Log out'],
  ['/mcp', 'MCP servers'],
  ['/memory', 'Memory files'],
  ['/model', 'Pick the model (opens a menu)', true],
  ['/output-style', 'Output style', true],
  ['/permissions', 'Allow and deny rules'],
  ['/plugin', 'Plugins', true],
  ['/pr-comments', 'Comments on a pull request', true],
  ['/release-notes', 'What changed in Claude Code'],
  ['/resume', 'Resume an earlier conversation', true],
  ['/review', 'Review a pull request', true],
  ['/rewind', 'Go back to an earlier point'],
  ['/security-review', 'Security review of the pending changes'],
  ['/status', 'Version, model, account'],
  ['/statusline', 'Set up the status line'],
  ['/tasks', 'Background tasks and shells'],
  ['/terminal-setup', 'Terminal key setup'],
  ['/todos', 'The current to-do list'],
  ['/usage', 'Plan usage and when limits reset'],
  ['/vim', 'Vim editing mode'],
];

/** The front matter's name and description, if it has any. */
function front(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString('utf8');
  } catch { return {}; }
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
      if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  if (!out.description) {
    const body = m ? text.slice(m[0].length) : text;
    const first = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    if (first) out.description = first;
  }
  return out;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const list = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

/** commands/**.md: a file in a subfolder is "folder:name". */
function commandsIn(dir, prefix, source, out, depth = 0) {
  if (depth > 3) return;
  for (const e of list(dir)) {
    const p = path.join(dir, e.name);
    if ((e.isDirectory() || (e.isSymbolicLink() && isDir(p))) && !e.name.startsWith('.')) {
      commandsIn(p, `${prefix}${e.name}:`, source, out, depth + 1);
    } else if (/\.md$/i.test(e.name)) {
      const f = front(p);
      out.push({ name: `/${prefix}${e.name.replace(/\.md$/i, '')}`, desc: String(f.description || '').slice(0, 160), args: !!f['argument-hint'], source });
    }
  }
}

/** skills/<name>/SKILL.md */
function skillsIn(dir, prefix, source, out) {
  for (const e of list(dir)) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(p))) continue;
    const file = path.join(p, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const f = front(file);
    out.push({ name: `/${prefix}${f.name || e.name}`, desc: String(f.description || '').slice(0, 160), args: true, source, skill: true });
  }
}

/** Installed plugins: <config>/plugins/**: any folder holding commands/ or skills/. */
function pluginsIn(root, out) {
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of list(dir)) {
      // A marketplace holds plugins that are offered, not installed.
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'marketplaces') continue;
      const p = path.join(dir, e.name);
      const manifest = path.join(p, '.claude-plugin', 'plugin.json');
      if (fs.existsSync(manifest)) {
        let name = e.name;
        try { name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name || name; } catch { /* folder name */ }
        if (seen.has(name)) continue;
        seen.add(name);
        commandsIn(path.join(p, 'commands'), `${name}:`, `plugin ${name}`, out);
        skillsIn(path.join(p, 'skills'), `${name}:`, `plugin ${name}`, out);
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
}

/**
 * @param {string} configDir  the account's Claude config dir (~/.claude for the main one)
 * @param {string} cwd        the session's folder
 * @param {string} home       for ~/.claude when the account has its own dir
 */
function catalogue({ configDir, cwd, home }) {
  const out = BUILTIN.map(([name, desc, args]) => ({ name, desc, args: !!args, source: 'Claude Code' }));
  const user = [];
  for (const dir of [...new Set([configDir, home && path.join(home, '.claude')].filter(Boolean))]) {
    commandsIn(path.join(dir, 'commands'), '', 'yours', user);
    skillsIn(path.join(dir, 'skills'), '', 'your skill', user);
  }
  // The project and the folders above it, as Claude Code reads them.
  const proj = [];
  let d = cwd ? path.resolve(cwd) : null;
  for (let i = 0; d && i < 8; i++) {
    if (home && d === home) break; // ~/.claude is the user's, read above
    commandsIn(path.join(d, '.claude', 'commands'), '', 'project', proj);
    skillsIn(path.join(d, '.claude', 'skills'), '', 'project skill', proj);
    const up = path.dirname(d);
    if (up === d || (home && d === home)) break;
    d = up;
  }
  const plug = [];
  if (configDir) pluginsIn(path.join(configDir, 'plugins'), plug);
  const seen = new Set(out.map((c) => c.name));
  for (const c of [...proj, ...user, ...plug]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

module.exports = { catalogue, BUILTIN };
