/* ============================================================
   ojee-agent — module UI.

   A PORT of the standalone dashboard, not a rewrite. Everything it
   could do before it still does: live host stats with sparklines,
   container control, whitelisted actions, and the full Claude Code
   agent surface — directory picker, session list, streaming chat,
   history browser with tool collapsing, rename, delete and resume.

   Only what the console now owns was removed:
     - the password login and its JWT (three auth gates upstream)
     - the header, HUD bar, title block and bottom tabs (shell chrome)
     - hash routing (the shell routes; we get ctx.view)
     - the Inter webfont (ojee-ui is all-mono by design)

   Kept deliberately even though this deployment does not use it: the
   local-agent setup flow. It is the most useful part of this repo to
   anyone else, and deleting working code because *we* stopped using it
   is how a public repo becomes a private one with extra steps.
   ============================================================ */

// ─── DOM helper + utils ────────────────────────────────────────────────
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === false || v == null) return;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach(c => {
    if (c == null || c === false) return;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
};
const svg = (inner, attrs = {}) => {
  const w = el('span', { class: attrs.class || 'icon-wrap', html: `<svg viewBox="${attrs.viewBox || '0 0 24 24'}" width="${attrs.size || 16}" height="${attrs.size || 16}" fill="none">${inner}</svg>` });
  return w;
};

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};
const fmtUp = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ─── Transport ─────────────────────────────────────────────────────────
// Set on mount. api() is scoped by the host, so the same call resolves at
// /agent/api/... when mounted and /api/... when standalone.
let ctx = null;
let root = null;
let pollTimer = null;
let keyHandler = null;

/** Mirrors the old api(): null on 401/404 or a non-JSON body, never throws. */
const api = async (path, opts = {}) => {
  try {
    return await ctx.api(path.replace(/^\/api/, ''), opts);
  } catch {
    return null;
  }
};

/* Interpolated into html: strings below. It lived in the markdown renderer
   the code panel needed; it outlives it because every readout that builds
   markup from a server-supplied name still has to escape it. */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Icons ─────────────────────────────────────────────────────────────
const brandIcon = (cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', cls || 'brand-icon');
  s.innerHTML = '<path fill="#00aaaa" d="m11 14.5c0 .828-.672 1.5-1.5 1.5s-1.5-.672-1.5-1.5.672-1.5 1.5-1.5 1.5.672 1.5 1.5zm3.5-1.5c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5 1.5-.672 1.5-1.5-.672-1.5-1.5-1.5zm5.5 0v3c.008.585-.55 1.108-1.134.973-.438 1.735-1.998 3.027-3.866 3.027h-6c-1.868 0-3.429-1.292-3.866-3.027-.583.135-1.141-.388-1.134-.973v-3c-.008-.585.55-1.108 1.134-.973.438-1.734 1.998-3.027 3.866-3.027h2v-1c0-.553.448-1 1-1s1 .447 1 1v1h2c1.868 0 3.429 1.292 3.866 3.027.583-.135 1.141.388 1.134.973zm-3 0c0-1.103-.897-2-2-2h-6c-1.103 0-2 .897-2 2v3c0 1.103.897 2 2 2h6c1.103 0 2-.897 2-2zm7-3.276v9.276c0 2.757-2.243 5-5 5h-14c-2.757 0-5-2.243-5-5v-9.276c0-1.665.824-3.214 2.204-4.145l6.999-4.724c1.699-1.146 3.895-1.146 5.594 0l7 4.724c1.379.931 2.203 2.479 2.203 4.145zm-2 0c0-.999-.494-1.928-1.322-2.486l-7-4.724c-.509-.345-1.094-.517-1.678-.517s-1.168.172-1.678.517l-7 4.723c-.828.559-1.322 1.487-1.322 2.486v9.276c0 1.654 1.346 3 3 3h14c1.654 0 3-1.346 3-3z"/>';
  return s;
};

const ICONS = {
  cpu:      '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="9" y="9" width="6" height="6" stroke="currentColor" stroke-width="1.6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  ram:      '<rect x="2" y="7" width="20" height="10" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M6 7v10M10 7v10M14 7v10M18 7v10" stroke="currentColor" stroke-width="1.2"/>',
  disk:     '<ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  gpu:      '<rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="12" r="2.5" stroke="currentColor" stroke-width="1.4"/><circle cx="16" cy="12" r="2.5" stroke="currentColor" stroke-width="1.4"/>',
  net:      '<path d="M2 12c5-7 15-7 20 0M5 16c3-4 11-4 14 0M9 19c1-1 5-1 6 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  temp:     '<path d="M14 14V5a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="17" r="1" fill="currentColor"/>',
  reload:   '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  power:    '<path d="M12 2v10M5 6.3a9 9 0 1 0 14 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  arrow:    '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  arrow_left: '<path d="M19 12H5M11 18l-6-6 6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevron_down: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  x:        '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  plus:     '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  trash:    '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  pencil:   '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  send:     '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  stop:     '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  spark:    '<path d="M12 2l2.39 7.36H22l-6.18 4.49L18.21 21 12 16.51 5.79 21l2.39-7.15L2 9.36h7.61L12 2z" fill="currentColor"/>',
  model:    '<path fill="currentColor" d="M9 3h6v2h2a2 2 0 0 1 2 2v2h2v2h-2v2h2v2h-2v2a2 2 0 0 1-2 2h-2v2H9v-2H7a2 2 0 0 1-2-2v-2H3v-2h2v-2H3v-2h2V7a2 2 0 0 1 2-2h2V3zm0 6v6h6V9H9z"/>',
  message:  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  code:     '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  folder:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  history:  '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  list:     '<path d="M8 6h13M8 12h13M8 18h13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>',
  search:   '<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  globe:    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  file:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6"/>',
  workflow: '<circle cx="5" cy="5" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><circle cx="19" cy="19" r="2.5" fill="currentColor"/><path d="M7 6l4 5M17 7l-4 4M14 13l4 5" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  spinner:  '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" stroke-dasharray="12 6" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.2s" repeatCount="indefinite"/></circle>',
  chart:    '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  tools:    '<path d="M14.7 6.3a4 4 0 0 1-5.7 5.7L3 18l3 3 6-6a4 4 0 0 1 5.7-5.7l-3-3z M5 21l7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  link:     '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  copy:     '<rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  archive:  '<rect x="2" y="4" width="20" height="5" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M10 13h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
};
const ico = (name, size = 16) => svg(ICONS[name] || '', { size });

// Tool name → icon mapping for chat chips
const TOOL_ICON = {
  web_search: 'search', web_fetch: 'globe',
  get_stats: 'chart', get_services: 'list', list_models: 'list',
  read_file: 'file', list_dir: 'folder',
};
const TOOL_LABELS = {
  web_search: 'Web search', web_fetch: 'Web page',
  get_stats: 'System stats', get_services: 'Services', list_models: 'Models',
  read_file: 'File read', list_dir: 'Directory',
  n8n_list_workflows: 'List workflows', n8n_get_workflow: 'Read workflow',
  n8n_create_workflow: 'New workflow', n8n_update_workflow: 'Update workflow',
  n8n_activate_workflow: 'Activate workflow', n8n_deactivate_workflow: 'Deactivate workflow',
  n8n_quick_workflow: 'Build workflow',
};
const toolIcon = (name) => name && name.startsWith('n8n_') ? 'workflow' : (TOOL_ICON[name] || 'tools');
const toolLabel = (name) => TOOL_LABELS[name] || name.replace(/_/g, ' ');


// ─── State ─────────────────────────────────────────────────────────────
const HISTORY_LEN = 60;
let state = {
  view: 'dashboard',          // replaced by ctx.view on mount
  config: { dashboardBaseUrl: '', openwebuiDomain: '', n8nDomain: '', couchdbDomain: '' },
  stats: null, services: null,
  history: { cpu: [], ram: [], swap: [], net_in: [], net_out: [], disk_read: [], disk_write: [] },
  actionMsg: '',
  toasts: [],
};

// ─── Persistence ───────────────────────────────────────────────────────

// Navigation goes through the shell so the nav highlight stays in sync.
const setMobileView = (v) => {
  state.view = v;
  ctx?.navigate?.('agent', v);
  render();
};

// ─── Toasts ────────────────────────────────────────────────────────────
const toast = (msg, kind = 'info', dur = 3500) => {
  const id = randId();
  state.toasts.push({ id, msg, kind });
  renderToasts();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    renderToasts();
  }, dur);
};
const renderToasts = () => {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack' });
    document.body.appendChild(stack);
  }
  stack.innerHTML = '';
  for (const t of state.toasts) {
    stack.appendChild(el('div', { class: `toast ${t.kind}` }, t.msg));
  }
};

// ─── Header ────────────────────────────────────────────────────────────

// ─── Bottom-tab nav (mobile) ───────────────────────────────────────────

/**
 * Home opens every view with an indexed section header — `A / STATS` in
 * accent mono, the title beside it, optional meta pushed right. Agent opened
 * with a bordered box whose header was small grey text, so the two modules
 * did not even start the page the same way. Same markup now.
 */
const section = (idx, title, right = null) => el('div', { class: 'section-head' },
  el('span', { class: 'idx' }, idx),
  el('h2', { class: 'h2' }, title),
  el('span', { class: 'spacer' }),
  right,
);

// ─── SVG primitives: sparkline ─────────────────────────────────────────
/**
 * A readout tile. This is HOME's tile markup, not an approximation of it:
 * `.panel.corners` + `<i class="c">` for the four bracket marks, then
 * `.stat` > `.label` / `.value` / `.meta`. Agent had grown its own
 * `.ag-stat-*` set that looked nearly the same and drifted independently —
 * which is exactly why this module read as a different product inside the
 * same frame. Sharing the classes means it cannot drift again.
 */
const gauge = (label, pct, sub, opts = {}) => {
  const t = opts.temp;
  const tHot = t != null && t > 85;
  const tWarm = t != null && t > 70;
  // The percentage is coloured by the PERCENTAGE and the temperature by the
  // TEMPERATURE. Folding them together made a CPU at 15% render in warning
  // yellow because the die was at 72°C — the number and its colour disagreed,
  // which is worse than not colouring at all.
  const level = pct > 90 ? 'err' : pct > 75 ? 'warn' : '';
  const tLevel = tHot ? 'err' : tWarm ? 'warn' : '';
  const v = Math.round(pct);
  return el('div', {
    class: 'panel corners' + (level ? ` is-${level}` : ''),
    html: `<i class="c"></i>
      <div class="stat">
        <span class="label">${escapeHtml(label)}</span>
        <span class="value">${v}<sup style="font-size:0.9rem">%</sup>${
          t != null ? `<span class="ag-temp${tLevel ? ` is-${tLevel}` : ''}">${Math.round(t)}°C</span>` : ''}</span>
        <span class="bar"><span class="fill${level ? ` fill--${level}` : ''}"
          style="width:${Math.max(0, Math.min(100, v))}%"></span></span>
        ${sub ? `<span class="meta">${escapeHtml(sub)}</span>` : ''}
      </div>`,
  });
};

// Sparkline SVG from values array (auto-scaled)
const sparkSvg = (values, color = 'var(--accent)') => {
  if (!values.length) return '<svg viewBox="0 0 100 32" width="100%" height="32"></svg>';
  const w = 100, h = 32, pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${pts.join(' L')}`;
  const fill = `${line} L${(pad + (values.length - 1) * step).toFixed(2)},${h - pad} L${pad},${h - pad} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <path d="${fill}" class="sparkline-fill"/>
    <path d="${line}" class="sparkline-line" style="stroke:${color}"/>
  </svg>`;
};
const sparklineCard = (label, value, values, color) =>
  el('div', { class: 'sparkline-card', html: `
    <div class="sparkline-card-head"><span>${escapeHtml(label)}</span><span class="sparkline-card-val">${escapeHtml(value)}</span></div>
    ${sparkSvg(values, color)}
  ` });

// Dual-line sparkline (e.g. read↑/write↓, in↑/out↓) sharing a common Y axis
const sparkSvg2 = (vals1, vals2, color1 = 'var(--accent)', color2 = 'var(--accent-dark)') => {
  const w = 100, h = 32, pad = 2;
  const all = [...vals1, ...vals2];
  if (!all.length) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"></svg>`;
  const max = Math.max(...all, 1);
  const make = (vals) => {
    if (!vals.length) return '';
    const step = (w - pad * 2) / Math.max(vals.length - 1, 1);
    return vals.map((v, i) => `${(pad + i * step).toFixed(2)},${(pad + (h - pad * 2) * (1 - v / max)).toFixed(2)}`).join(' L');
  };
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <path d="M${make(vals1)}" stroke="${color1}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M${make(vals2)}" stroke="${color2}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
};
/* Disk I/O and Network. `.panel` + `.label` + `.value` + `.meta`: the same
 * four parts as a stat tile, so a chart reads as a readout that happens to
 * have a graph rather than as a different kind of box. It was `.sparkline-card`
 * with `.sparkline-card-head` / `.sparkline-card-val` / `.spark-legend`, a
 * private set that matched nothing else. */
const sparklineCard2 = (label, val1, val2, lbl1, lbl2, vals1, vals2,
                        c1 = 'var(--accent)', c2 = 'var(--accent-dark)') =>
  el('div', { class: 'panel ag-chart', html: `
    <span class="label">${escapeHtml(label)}</span>
    <span class="value">${escapeHtml(val1)}<span class="ag-chart-sep">/</span>${escapeHtml(val2)}</span>
    ${sparkSvg2(vals1, vals2, c1, c2)}
    <span class="meta">
      <span class="dot" style="background:${c1}"></span>${escapeHtml(lbl1)}
      <span class="dot" style="background:${c2}"></span>${escapeHtml(lbl2)}
    </span>
  ` });

// ─── Panels ────────────────────────────────────────────────────────────
const panelSystem = () => {
  const s = state.stats;
  if (!s) {
    return el('div', { class: 'stack-lg', 'data-panel': 'dashboard' },
      section('A / STATS', 'System'),
      el('div', { class: 'tiles' },
        el('div', { class: 'skel' }), el('div', { class: 'skel' }),
        el('div', { class: 'skel' }), el('div', { class: 'skel' }),
      ),
      el('div', { class: 'skel' }),
      el('div', { class: 'skel' }),
    );
  }

  const cpuTemp = (s.temps || []).find(t => t.label === 'CPU Package');
  const g = s.gpu;
  const truncate = (str, n) => !str ? '' : (str.length <= n ? str : str.slice(0, n - 1) + '…');
  const cpuShort = truncate(s.cpu.model || '', 24);
  // Some lspci entries already include the vendor in the model string (e.g.
  // "NVIDIA GeForce MX250") so don't prepend it again.
  const gpuName = g ? (g.model || '') : '';
  const gpuVendor = g && g.vendor && !gpuName.toLowerCase().includes(g.vendor.toLowerCase())
    ? g.vendor + ' ' : '';
  const gpuShort = truncate(gpuVendor + gpuName, 24);

  const swapPct = s.swap?.total ? Math.round((s.swap.used / s.swap.total) * 100) : 0;

  // The machine's facts as a key/value block — the same `.titleblock`/`.tb`
  // component home uses under the AC panel. It was a bespoke `.sys-banner`
  // with its own icons and spacing, which is one more thing to keep in sync
  // with a component that already existed.
  const banner = el('div', { class: 'titleblock' },
    el('div', { class: 'tb' }, el('span', { class: 'tb-k' }, 'Up'),
      el('span', { class: 'tb-v tb-v--accent' }, fmtUp(s.uptime))),
    el('div', { class: 'tb' }, el('span', { class: 'tb-k' }, 'OS'),
      el('span', { class: 'tb-v' }, s.os || '—')),
    s.hostname ? el('div', { class: 'tb' }, el('span', { class: 'tb-k' }, 'Host'),
      el('span', { class: 'tb-v' }, s.hostname)) : null,
  );

  const gauges = el('div', { class: 'tiles' },
    gauge('CPU', s.cpu.avg, cpuShort, { temp: cpuTemp ? cpuTemp.current : null }),
    g && g.util != null
      ? gauge('GPU', g.util, `${gpuShort}${g.vram_mb ? ' · ' + (g.vram_mb / 1024).toFixed(1) + 'G' : ''}`, { temp: g.temp })
      : null,
    gauge('RAM', s.memory.percent, `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}`),
    s.swap && s.swap.total ? gauge('Swap', swapPct, `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}`) : null,
    gauge('Disk /', s.disk.percent, `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}`),
    s.home ? gauge('Disk /home', s.home.percent, `${fmtBytes(s.home.used)} / ${fmtBytes(s.home.total)}`) : null,
  );

  const sparks = el('div', { class: 'tiles' },
    sparklineCard2('Disk I/O',
      `↓${fmtBytes(s.disk?.read_per_s || 0)}/s`, `↑${fmtBytes(s.disk?.write_per_s || 0)}/s`,
      'read', 'write',
      state.history.disk_read, state.history.disk_write),
    sparklineCard2('Network',
      `↓${fmtBytes(s.network?.recv_per_s || 0)}/s`, `↑${fmtBytes(s.network?.sent_per_s || 0)}/s`,
      'in', 'out',
      state.history.net_in, state.history.net_out),
  );

  // No outer panel. Home lays sections directly on the page background and
  // reserves `.panel` for the things inside them; agent wrapped a panel round
  // every view and then put panels inside it, so everything sat one border
  // deeper than the same content does in home.
  return el('div', { class: 'stack-lg', 'data-panel': 'dashboard' },
    section('A / STATS', 'System', el('span', { class: 'meta' }, s.hostname || '')),
    banner,
    gauges,
    sparks,
  );
};

const panelServices = () => {
  const sv = state.services;
  if (!sv) {
    // `.skel` is the design system's own loading placeholder — home uses it
    // in three places. Agent had `.skeleton.skeleton-row`, a private one.
    return el('div', { class: 'stack-lg', 'data-panel': 'services' },
      section('B / SERVICES', 'Services'),
      el('div', { class: 'panel' },
        el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' })),
    );
  }
  const rows = Object.entries(sv);
  if (!rows.length) {
    return el('div', { class: 'stack-lg', 'data-panel': 'services' },
      section('B / SERVICES', 'Services'),
      el('div', { class: 'empty', html: `<b>No services reported</b>
        <span>The agent could not read the container list.</span>` }),
    );
  }
  // One panel, rows inside — the same shape as Quick links and as home's
  // activity log. Each row was its own bordered panel before, which is a
  // shape nothing else in the console uses for a list.
  return el('div', { class: 'stack-lg', 'data-panel': 'services' },
    section('B / SERVICES', 'Services',
      el('span', { class: 'meta' }, `${rows.filter(([, x]) => x.active).length}/${rows.length} up`)),
    el('div', { class: 'panel' },
      ...rows.map(([name, x]) => row(
        el('span', { class: `dot ${x.active ? 'dot--ok' : ''}` }),
        x.desc || name,
        x.status || (x.active ? 'Running' : 'Stopped'),
      )),
    ),
  );
};

const doAction = async (action, label) => {
  const tid = randId();
  state.toasts.push({ id: tid, msg: el('span', { class: 'mono' }, ico('spinner', 14), ' ', label || action), kind: 'info' });
  renderToasts();
  const d = await api('/api/action', { method: 'POST', body: JSON.stringify({ action }) });
  state.toasts = state.toasts.filter(t => t.id !== tid);
  if (d?.ok) toast(`${label || action}: OK`, 'success');
  else toast(`${label || action}: ${d?.stderr || d?.error || 'failed'}`, 'danger', 6000);
};

/* A row in a list. Home renders lists as ONE `.panel` containing rows
 * separated by a hairline — the activity log is exactly this — not as a
 * panel per row. `.logline` is that row, so links, services and anything
 * else that lists share one shape. */
const row = (icon, name, sub, opts = {}) => el(opts.href ? 'a' : 'div', {
  class: 'logline ag-row' + (opts.href || opts.onclick ? ' ag-row--go' : ''),
  ...(opts.href ? { href: opts.href, target: '_blank', rel: 'noreferrer' } : {}),
  ...(opts.onclick ? { onclick: opts.onclick, style: 'cursor:pointer' } : {}),
},
  icon ? el('span', { class: 'ag-row-ic' }, icon) : null,
  el('span', { class: 'ag-row-body' },
    el('span', { class: 'ag-row-name' }, name),
    sub ? el('span', { class: 'meta' }, sub) : null,
  ),
  opts.trail || null,
);

const quickLinks = () => {
  const c = state.config;
  const items = [
    c.n8nDomain && row(ico('reload', 16), 'n8n', 'Workflow automation',
      { href: `https://${c.n8nDomain}`, trail: ico('arrow', 16) }),
    c.odysseusDomain && row(ico('cpu', 16), 'Odysseus', 'Self-hosted AI workspace',
      { href: `https://${c.odysseusDomain}`, trail: ico('arrow', 16) }),
    c.loqSftpUrl && row(ico('net', 16), 'Loq files (SFTP)', `Tap to copy ${c.loqSftpUrl}`, {
      trail: ico('copy', 16),
      onclick: async (e) => {
        e.preventDefault();
        try { await navigator.clipboard.writeText(c.loqSftpUrl); toast('SFTP URL copied', 'success'); }
        catch { toast(c.loqSftpUrl, 'info', 8000); }
      },
    }),
  ].filter(Boolean);
  if (!items.length) return null;
  return el('div', {},
    el('div', { class: 'section-head' },
      el('span', { class: 'idx' }, 'C.1'), el('h3', { class: 'h2' }, 'Quick links')),
    el('div', { class: 'panel' }, ...items),
  );
};

const panelActions = () => el('div', { class: 'stack-lg', 'data-panel': 'actions' },
  section('C / ACTIONS', 'Actions'),
  el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn--ghost', onclick: () => doAction('restart-n8n', 'Restart n8n') }, ico('reload'), ' n8n'),
    el('button', { class: 'btn btn--ghost', onclick: () => doAction('restart-dashboard', 'Restart Dashboard') }, ico('reload'), ' Dashboard'),
    el('button', { class: 'btn btn--ghost', onclick: () => doAction('restart-couchdb', 'Restart CouchDB') }, ico('reload'), ' CouchDB'),
    el('button', { class: 'btn btn--ghost', onclick: () => doAction('restart-odysseus', 'Restart Odysseus') }, ico('reload'), ' Odysseus'),
    el('button', { class: 'btn btn--ghost', onclick: () => doAction('compose-up', 'Compose Up') }, ico('power'), ' Up'),
    el('button', { class: 'btn btn--danger', onclick: () => { if (confirm('Bring stack down?')) doAction('compose-down', 'Compose Down'); } }, ico('power'), ' Down'),
  ),
  quickLinks(),
);

// ─── Render ────────────────────────────────────────────────────────────
const render = () => {
  // Preserve input value/focus across re-renders
  const oldInput = document.querySelector('.chat-input');
  const active = document.activeElement;
  const preserved = oldInput ? {
    value: oldInput.value,
    start: oldInput.selectionStart,
    end: oldInput.selectionEnd,
    focused: oldInput === active,
  } : null;

  if (document.activeElement?.tagName === 'SELECT') return;

  // Save scroll positions
  const SCROLL = ['.panel', '.chat-log', '.ca-hist-list', '.ca-dir-list', '.ca-sess-list', '.saved-list'];
  const saved = {};
  for (const sel of SCROLL) saved[sel] = Array.from(document.querySelectorAll(sel)).map(p => ({ top: p.scrollTop, left: p.scrollLeft }));

  const oldLog = document.querySelector('.chat-log');
  const stickToBottom = oldLog ? (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 60) : true;
  const pageY = window.scrollY || document.documentElement.scrollTop || 0;

  // Preserve toast stack across rebuilds
  const toastStack = document.querySelector('.toast-stack');
  if (toastStack) toastStack.remove();

  root.innerHTML = '';
  // One panel per view, on EVERY viewport.
  //
  // This used to render all four panels and then mark one `mobile-active` —
  // a class that only does anything inside a mobile media query. So on a
  // desktop, Stats, Services, Actions and Code all showed the identical page
  // and three of the four nav entries did nothing at all. Rendering only the
  // active panel makes every entry mean something and makes the desktop and
  // the phone agree, which is why the LOQ module stopped diverging too.
  const activePanel = state.view === 'services' ? 'services'
    : state.view === 'actions' ? 'actions'
    : 'dashboard';
  const build = { dashboard: panelSystem, services: panelServices,
                  actions: panelActions }[activePanel];
  const grid = el('div', { class: 'ag-grid' }, build());
  grid.dataset.view = activePanel;
  // Kept: the mobile rules that bound the chat log key off this class.
  for (const p of grid.children) p.classList.add('mobile-active');

  // The shell owns the HUD, nav, tab bar and status bar. A module that
  // rendered its own would end up with two of each.
  root.append(grid);
  if (toastStack) document.body.appendChild(toastStack);

  if (preserved) {
    const newInput = document.querySelector('.chat-input');
    if (newInput) {
      newInput.value = preserved.value;
      if (preserved.focused) {
        newInput.focus();
        try { newInput.setSelectionRange(preserved.start, preserved.end); } catch {}
      }
      newInput.style.height = 'auto';
      newInput.style.height = Math.min(newInput.scrollHeight, 200) + 'px';
    }
  }

  for (const sel of SCROLL) {
    const arr = saved[sel] || [];
    Array.from(document.querySelectorAll(sel)).forEach((e, i) => {
      const s = arr[i]; if (!s) return;
      if (sel === '.chat-log' && i === 0 && stickToBottom) e.scrollTop = e.scrollHeight;
      else { e.scrollTop = s.top; e.scrollLeft = s.left; }
    });
  }
  if (pageY) window.scrollTo(0, pageY);

};

// ─── Polling ───────────────────────────────────────────────────────────
const pushHistory = (key, value) => {
  if (value == null || isNaN(value)) return;
  const arr = state.history[key];
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.shift();
};
// Targeted in-place swap of the two stat panels only — leaves the chat
// panel, its input element and the actions panel untouched.  Critical for
// mobile: a full DOM rebuild every 5s would dismiss + re-show the keyboard.
const refreshStatsPanels = () => {
  const oldSys = document.querySelector('.panel[data-panel="dashboard"]');
  const oldSvc = document.querySelector('.panel[data-panel="services"]');
  if (!oldSys || !oldSvc) { render(); return; }
  const newSys = panelSystem();
  const newSvc = panelServices();
  if (oldSys.classList.contains('mobile-active')) newSys.classList.add('mobile-active');
  if (oldSvc.classList.contains('mobile-active')) newSvc.classList.add('mobile-active');
  // Status pill in the header reflects state.stats, so swap that too
  const pill = document.querySelector('.header-right .status-pill');
  if (pill) pill.className = state.stats ? 'status-pill' : 'status-pill offline';
  if (pill) pill.textContent = state.stats ? 'Online' : 'Offline';
  oldSys.replaceWith(newSys);
  oldSvc.replaceWith(newSvc);
};

const refresh = async () => {
  const [stats, services] = await Promise.all([
    api('/api/stats'),
    api('/api/services'),
  ]);
  if (stats) {
    state.stats = stats;
    pushHistory('cpu', stats.cpu?.avg);
    pushHistory('ram', stats.memory?.percent);
    pushHistory('swap', stats.swap?.total ? (stats.swap.used / stats.swap.total) * 100 : 0);
    pushHistory('net_in', stats.network?.recv_per_s || 0);
    pushHistory('net_out', stats.network?.sent_per_s || 0);
    pushHistory('disk_read', stats.disk?.read_per_s || 0);
    pushHistory('disk_write', stats.disk?.write_per_s || 0);
  }
  if (services) state.services = services;

  // Only swap the stat panels in place — full render() would dismiss the
  // mobile keyboard each tick.
  refreshStatsPanels();
};

// ─── Boot ──────────────────────────────────────────────────────────────
const boot = async () => {
  // Load server-side config (domain names, timezone) so the SPA can use
  // them without hardcoding the operator's specific deployment URLs.
  // Through ctx.api, not fetch: a bare /api/config would hit the SHELL's
  // config endpoint when mounted, not this module's.
  const cfg = await api('/api/config');
  if (cfg) state.config = cfg;
  render();
  refresh();
  // Tracked so unmount() can stop it. An untracked interval keeps polling —
  // and keeps re-rendering into a detached root — after the module is gone.
  pollTimer = setInterval(refresh, 5000);

  // Esc closes the saved-actions list. Cmd/Ctrl+K used to open a new chat
  // and is left to the shell, whose palette owns that chord console-wide.
  keyHandler = (e) => {
    if (e.key === 'Escape' && state.showSavedList) {
      state.showSavedList = false; render();
    }
  };
  document.addEventListener('keydown', keyHandler);
};



/* ── module contract ─────────────────────────────────────────────────── */

export default {
  async mount(mountEl, context) {
    root = mountEl;
    ctx = context;
    state.view = context.view || 'dashboard';

    // The module ships its own CSS and injects it once, from ctx.base so it
    // resolves whether mounted or standalone.
    if (!document.getElementById('ag-css')) {
      const link = document.createElement('link');
      link.id = 'ag-css';
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/agent.css`;
      document.head.appendChild(link);
    }

    await boot();
  },

  async setView(view) {
    // Re-render in place rather than remounting: a remount would drop the
    // chat stream and lose the draft sitting in the input.
    state.view = view || 'dashboard';
    render();
  },

  async unmount() {
    if (pollTimer) clearInterval(pollTimer);
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    pollTimer = keyHandler = null;
    root = null;
    ctx = null;
  },
};
