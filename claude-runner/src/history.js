/**
 * Deleting a past conversation, recoverably.
 *
 * A conversation is `<projects>/<project>/<id>.jsonl`, plus a sidecar folder
 * `<projects>/<project>/<id>/` when it ran subagents. Deleting moves both into
 * the runner's trash (`<STATE_DIR>/trash/<stamp>-<id>/`) with a manifest of
 * where they came from, so a mistake is one restore away. Entries older than
 * the keep period are purged when the runner starts.
 *
 * Path safety: the id and the project are names, never paths; every file is
 * resolved through realpath and must sit inside one of the known projects
 * dirs (also resolved). Anything else is refused, whatever the request says.
 */

const fs = require('fs');
const path = require('path');

const KEEP_MS = 7 * 24 * 3600 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const PROJECT_RE = /^[A-Za-z0-9._-]{1,255}$/;

const err = (status, message, reason) => Object.assign(new Error(message), { status, reason });

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (child, parent) => !!child && !!parent && child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const roots = (projectDirs) => projectDirs.map(real).filter(Boolean);

function checkId(id) {
  if (!ID_RE.test(String(id || ''))) throw err(400, 'Not a conversation id', 'bad-id');
}
function checkProject(project) {
  if (project == null || project === '') return;
  const p = String(project);
  if (!PROJECT_RE.test(p) || p === '.' || p === '..') throw err(400, 'Not a project folder name', 'bad-project');
}

/**
 * The transcript and its sidecar for `id`, inside the known projects dirs.
 * `project` (the encoded folder name) narrows it; without it, the first match.
 * Returns { root, project, file, sidecar|null } with real paths, or throws.
 */
function locate(projectDirs, id, project) {
  checkId(id);
  checkProject(project);
  for (const root of roots(projectDirs)) {
    let dirs;
    if (project) dirs = [project];
    else {
      try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    }
    for (const name of dirs) {
      const p = path.join(root, name, `${id}.jsonl`);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isFile()) throw err(400, 'That conversation is not a plain file; not touching it', 'not-a-file');
      const file = real(p);
      const projDir = real(path.join(root, name));
      if (!inside(file, root) || !inside(projDir, root) || path.dirname(file) !== projDir) throw err(400, 'That file is outside the projects folders', 'outside');
      let sidecar = null;
      const sp = path.join(root, name, id);
      try {
        const sst = fs.lstatSync(sp);
        if (sst.isDirectory()) {
          const r = real(sp);
          if (!inside(r, projDir)) throw err(400, 'Its subagent folder is outside the projects folders', 'outside');
          sidecar = r;
        }
      } catch (e) { if (e.status) throw e; }
      return { root, project: name, file, sidecar };
    }
  }
  throw err(404, 'No conversation with that id', 'not-found');
}

/** Move, across filesystems if needed. */
function move(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Move a conversation into the trash. Returns the manifest. */
function trash({ projectDirs, trashDir, id, project, now = Date.now() }) {
  const loc = locate(projectDirs, id, project);
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const entry = path.join(trashDir, `${now}-${id}`);
  fs.mkdirSync(entry, { mode: 0o700 });
  const manifest = { id, project: loc.project, root: loc.root, deletedAt: now, files: [] };
  move(loc.file, path.join(entry, `${id}.jsonl`));
  manifest.files.push({ name: `${id}.jsonl`, to: loc.file });
  if (loc.sidecar) {
    move(loc.sidecar, path.join(entry, id));
    manifest.files.push({ name: id, to: loc.sidecar });
  }
  fs.writeFileSync(path.join(entry, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ...manifest, entry };
}

/** Trash entries, newest first: { dir, manifest }. Unreadable ones skipped. */
function entries(trashDir) {
  let names;
  try { names = fs.readdirSync(trashDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(trashDir, n);
    try { out.push({ dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) }); } catch { /* not one of ours, or half-written */ }
  }
  return out.sort((a, b) => (b.manifest.deletedAt || 0) - (a.manifest.deletedAt || 0));
}

/**
 * Put the newest trashed copy of `id` back where it was. Refuses when its
 * old place is no longer inside a known projects dir, or something is there.
 */
function restore({ projectDirs, trashDir, id }) {
  checkId(id);
  const e = entries(trashDir).find((x) => x.manifest.id === id);
  if (!e) throw err(404, 'That conversation is not in the trash (kept 7 days)', 'not-in-trash');
  const rs = roots(projectDirs);
  const m = e.manifest;
  for (const f of m.files) {
    const parent = real(path.dirname(f.to));
    const name = path.basename(f.to);
    if (!(name === `${id}.jsonl` || name === id) || f.name !== name) throw err(400, 'The trash entry is malformed', 'bad-manifest');
    if (!parent || !rs.some((r) => inside(parent, r))) throw err(409, 'Its folder is gone or outside the projects folders', 'outside');
    if (fs.existsSync(f.to)) throw err(409, 'A conversation with that id is already there', 'exists');
  }
  for (const f of m.files) move(path.join(e.dir, f.name), f.to);
  fs.rmSync(e.dir, { recursive: true, force: true });
  return { id, project: m.project, restored: m.files.map((f) => f.to) };
}

/** Delete trash entries older than `keepMs`. Returns how many went. */
function purge(trashDir, { keepMs = KEEP_MS, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(trashDir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const dir = path.join(trashDir, name);
    let at = Number(/^(\d+)-/.exec(name)?.[1]);
    try { at = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).deletedAt || at; } catch { /* by name */ }
    if (!Number.isFinite(at)) { try { at = fs.statSync(dir).mtimeMs; } catch { continue; } }
    if (now - at > keepMs) { fs.rmSync(dir, { recursive: true, force: true }); n++; }
  }
  return n;
}

/** Pids whose command line names `id` (a `claude --resume <id>` in some terminal). */
function processesNaming(id, { procDir = '/proc', self = process.pid } = {}) {
  checkId(id);
  let pids;
  try { pids = fs.readdirSync(procDir).filter((p) => /^\d+$/.test(p)); } catch { return []; }
  const out = [];
  for (const p of pids) {
    if (Number(p) === self) continue;
    let cmd;
    try { cmd = fs.readFileSync(path.join(procDir, p, 'cmdline'), 'utf8'); } catch { continue; }
    if (cmd.split('\0').includes(id)) out.push(Number(p));
  }
  return out;
}

module.exports = { KEEP_MS, locate, trash, restore, purge, entries, processesNaming };
