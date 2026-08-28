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
const fmtDur = (ms) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
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
let visHandler = null;

/** Mirrors the old api(): null on 401/404 or a non-JSON body, never throws. */
const api = async (path, opts = {}) => {
  try {
    return await ctx.api(path.replace(/^\/api/, ''), opts);
  } catch {
    return null;
  }
};

// ─── Markdown (sanitized) ──────────────────────────────────────────────
const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderMarkdown(text) {
  if (!text) return '';
  const T_OPEN = '<' + 'thinking>', T_CLOSE = '</' + 'thinking>';
  text = text.split(new RegExp(T_OPEN + '[\\s\\S]*?' + T_CLOSE, 'gi')).join('');
  const oi = text.toLowerCase().indexOf(T_OPEN);
  if (oi !== -1) text = text.slice(0, oi);
  const ci = text.toLowerCase().indexOf(T_CLOSE);
  if (ci !== -1) text = text.slice(ci + T_CLOSE.length);
  text = text.trim();
  if (!text) return '';
  const blocks = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
  });
  src = escapeHtml(src);
  src = src.replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>');
  src = src.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
           .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
           .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
           .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
           .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
           .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
           .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
           .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const safe = /^(https?:|mailto:|\/)/.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  src = src.replace(/(?:^[ \t]*[-*]\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*[-*]\s+/, '')}</li>`).join('');
    return `<ul class="md-ul">${items}</ul>`;
  });
  src = src.replace(/(?:^[ \t]*\d+\.\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
    return `<ol class="md-ol">${items}</ol>`;
  });
  src = src.replace(/(?:^&gt;\s+.+(?:\n|$))+/gm, block => {
    const body = block.trim().split(/\n/).map(l => l.replace(/^&gt;\s+/, '')).join('<br>');
    return `<blockquote class="md-bq">${body}</blockquote>`;
  });
  // GitHub-flavored tables: header row, separator (| --- | --- |), data rows
  src = src.replace(/^\|(.+)\|\s*\n\|([-:\s|]+)\|\s*\n((?:\|.*\|\s*\n?)+)/gm, (_, hdr, sep, body) => {
    const cells = (row) => row.split('|').slice(1, -1).map(c => c.trim());
    const aligns = sep.split('|').slice(1, -1).map(s => {
      const t = s.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      if (t.startsWith(':')) return 'left';
      return '';
    });
    const inlineFmt = (s) => s; // already through escapeHtml + inline replacements
    const th = cells(hdr).map((c, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inlineFmt(c)}</th>`).join('');
    const trs = body.trim().split(/\n/).map(row => {
      const tds = cells(row).map((c, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inlineFmt(c)}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  src = src.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol|pre|blockquote|table|p)/.test(p.trim())) return p;
    return `<p>${p.trim().replace(/\n/g, '<br>')}</p>`;
  }).join('');
  src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => {
    const b = blocks[+i];
    const langAttr = b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : '';
    return `<pre class="md-code"${langAttr}><code>${escapeHtml(b.code)}</code></pre>`;
  });
  return src;
}

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
  codeAgent: {
    enabled: false, checked: false,
    sessions: [], active: null, messages: [],
    busy: false, status: null, startTs: null,
    pickerOpen: false,
    pickerPath: '/home/ojee',
    pickerEntries: [], pickerParent: null,
    historyOpen: false, historyList: [],
    historyView: null, historyMessages: [], historyShowTools: false, historyCwd: null,
  },
};

// ─── Persistence ───────────────────────────────────────────────────────

const persistCode = () => {
  try {
    localStorage.setItem('code_state', JSON.stringify({
      active: state.codeAgent.active,
      messages: state.codeAgent.messages,
      busy: state.codeAgent.busy,
      startTs: state.codeAgent.startTs || null,
    }));
  } catch {}
};
const restoreCode = () => {
  try {
    const s = JSON.parse(localStorage.getItem('code_state'));
    if (s && s.active) {
      state.codeAgent.active = s.active;
      state.codeAgent.messages = s.messages || [];
      if (s.busy) {
        state.codeAgent.busy = true;
        state.codeAgent.startTs = s.startTs || null;
        state.codeAgent.status = 'reconnecting';
      }
    }
  } catch {}
  const defCwd = localStorage.getItem('code_default_cwd');
  if (defCwd) state.codeAgent.pickerPath = defCwd;
};

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

// ─── SVG primitives: gauge + sparkline ─────────────────────────────────
// Returns a circular gauge SVG. Stroke color comes from CSS via the parent's
// .warn/.danger class — don't set inline stroke here or it'd override CSS.
// When temp is provided, render it as a small text inside the ring below the
// percent (no extra DOM, no badge — feels like part of the gauge itself).
const gaugeSvg = (pct, temp) => {
  const r = 30, cx = 38, cy = 38;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * circ;
  const hasTemp = temp != null;
  const tHot = hasTemp && temp > 85;
  const tWarm = hasTemp && temp > 70;
  const tcls = tHot ? ' hot' : tWarm ? ' warm' : '';
  const pctY = hasTemp ? '38%' : '50%';
  const pctCls = hasTemp ? ' with-temp' : '';
  const tempText = hasTemp
    ? `<text class="gauge-temp-text${tcls}" x="50%" y="66%" dominant-baseline="middle" text-anchor="middle">${temp}°C</text>`
    : '';
  return `<svg viewBox="0 0 76 76" width="76" height="76">
    <circle class="gauge-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="6"/>
    <circle class="gauge-fill" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="6"
      stroke-dasharray="${dash} ${circ}" stroke-linecap="butt"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text class="gauge-text${pctCls}" x="50%" y="${pctY}" dominant-baseline="middle" text-anchor="middle">${Math.round(pct)}%</text>
    ${tempText}
  </svg>`;
};
/**
 * A readout tile, in the shape every other module uses: LABEL, a big tabular
 * number, then a thin bar and a sub-line.
 *
 * This used to draw a circular ring gauge. Nothing else in the console has
 * one — LOQ, Home and the launcher all use flat tiles — so this panel read as
 * a different product sitting inside the same frame, which is exactly what it
 * looked like. The donut also spent a 76px square saying what one line of
 * text says better, and put the number at a size no other readout uses.
 *
 * `.stat` and `.bar` are ojee-ui's own components rather than local
 * lookalikes, so this tracks the design system instead of re-approximating it.
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
    class: 'ag-stat' + (level ? ` is-${level}` : ''),
    html: `
      <span class="ag-stat-k">${escapeHtml(label)}</span>
      <span class="ag-stat-v">${v}<span class="ag-stat-u">%</span>${
        t != null ? `<span class="ag-stat-t${tLevel ? ` is-${tLevel}` : ''}">${Math.round(t)}°C</span>` : ''}</span>
      <span class="bar"><span class="fill${level ? ` fill--${level}` : ''}"
        style="width:${Math.max(0, Math.min(100, v))}%"></span></span>
      ${sub ? `<span class="ag-stat-sub">${escapeHtml(sub)}</span>` : ''}`,
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
const sparklineCard2 = (label, val1, val2, lbl1, lbl2, vals1, vals2, c1 = 'var(--accent)', c2 = 'var(--accent-dark)') =>
  el('div', { class: 'sparkline-card', html: `
    <div class="sparkline-card-head"><span>${escapeHtml(label)}</span><span class="sparkline-card-val">${escapeHtml(val1)} / ${escapeHtml(val2)}</span></div>
    ${sparkSvg2(vals1, vals2, c1, c2)}
    <div class="spark-legend">
      <span><span class="dot" style="background:${c1}"></span>${escapeHtml(lbl1)}</span>
      <span><span class="dot" style="background:${c2}"></span>${escapeHtml(lbl2)}</span>
    </div>
  ` });

// ─── Panels ────────────────────────────────────────────────────────────
const panelSystem = () => {
  const s = state.stats;
  if (!s) {
    return el('div', { class: 'panel', 'data-panel': 'dashboard' },
      el('div', { class: 'panel-head' }, el('span', {}, 'System')),
      el('div', { class: 'ag-tiles' },
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
      ),
      el('div', { class: 'skeleton skeleton-row' }),
      el('div', { class: 'skeleton skeleton-row' }),
      el('div', { class: 'skeleton skeleton-row' }),
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

  // Top banner: OS + uptime + hostname
  const banner = el('div', { class: 'sys-banner' },
    el('div', { class: 'sys-banner-item' }, ico('power', 14),
      el('span', { class: 'k' }, 'Up'), el('span', { class: 'v' }, fmtUp(s.uptime))),
    el('div', { class: 'sys-banner-item' }, ico('cpu', 14),
      el('span', { class: 'k' }, 'OS'), el('span', { class: 'v' }, s.os || '—')),
    s.hostname ? el('div', { class: 'sys-banner-item' }, ico('net', 14),
      el('span', { class: 'k' }, 'Host'), el('span', { class: 'v' }, s.hostname)) : null,
  );

  const gauges = el('div', { class: 'gauge-grid' },
    gauge('CPU', s.cpu.avg, cpuShort, { temp: cpuTemp ? cpuTemp.current : null }),
    g && g.util != null
      ? gauge('GPU', g.util, `${gpuShort}${g.vram_mb ? ' · ' + (g.vram_mb / 1024).toFixed(1) + 'G' : ''}`, { temp: g.temp })
      : null,
    gauge('RAM', s.memory.percent, `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}`),
    s.swap && s.swap.total ? gauge('Swap', swapPct, `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}`) : null,
    gauge('Disk /', s.disk.percent, `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}`),
    s.home ? gauge('Disk /home', s.home.percent, `${fmtBytes(s.home.used)} / ${fmtBytes(s.home.total)}`) : null,
  );

  const sparks = el('div', { class: 'sparkline-row' },
    sparklineCard2('Disk I/O',
      `↓${fmtBytes(s.disk?.read_per_s || 0)}/s`, `↑${fmtBytes(s.disk?.write_per_s || 0)}/s`,
      'read', 'write',
      state.history.disk_read, state.history.disk_write),
    sparklineCard2('Network',
      `↓${fmtBytes(s.network?.recv_per_s || 0)}/s`, `↑${fmtBytes(s.network?.sent_per_s || 0)}/s`,
      'in', 'out',
      state.history.net_in, state.history.net_out),
  );

  return el('div', { class: 'panel', 'data-panel': 'dashboard' },
    el('div', { class: 'panel-head' },
      el('span', {}, 'System'),
      el('span', { class: 'head-actions' }, ico('cpu', 14)),
    ),
    banner,
    gauges,
    sparks,
  );
};

const panelServices = () => {
  const sv = state.services;
  if (!sv) {
    return el('div', { class: 'panel', 'data-panel': 'services' },
      el('div', { class: 'panel-head' }, el('span', {}, 'Services')),
      el('div', { class: 'svc-list' },
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' }),
      ),
    );
  }
  return el('div', { class: 'panel', 'data-panel': 'services' },
    el('div', { class: 'panel-head' }, el('span', {}, 'Services')),
    el('div', { class: 'svc-list' },
      ...Object.entries(sv).map(([name, s]) =>
        el('div', { class: 'svc-card' },
          el('span', { class: s.active ? 'svc-dot' : 'svc-dot off' }),
          el('div', { class: 'svc-info' },
            el('div', { class: 'svc-name' }, s.desc || name),
            el('div', { class: 'svc-meta' }, s.status || (s.active ? 'Running' : 'Stopped')),
          ),
        ),
      ),
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

const panelActions = () => el('div', { class: 'panel', 'data-panel': 'actions' },
  el('div', { class: 'panel-head' }, el('span', {}, 'Actions')),
  el('div', { class: 'btn-row' },
    el('button', { class: 'btn', onclick: () => doAction('restart-n8n', 'Restart n8n') }, ico('reload'), ' n8n'),
    el('button', { class: 'btn', onclick: () => doAction('restart-dashboard', 'Restart Dashboard') }, ico('reload'), ' Dashboard'),
    el('button', { class: 'btn', onclick: () => doAction('restart-couchdb', 'Restart CouchDB') }, ico('reload'), ' CouchDB'),
    el('button', { class: 'btn', onclick: () => doAction('restart-odysseus', 'Restart Odysseus') }, ico('reload'), ' Odysseus'),
    el('button', { class: 'btn', onclick: () => doAction('compose-up', 'Compose Up') }, ico('power'), ' Up'),
    el('button', { class: 'btn danger', onclick: () => { if (confirm('Bring stack down?')) doAction('compose-down', 'Compose Down'); } }, ico('power'), ' Down'),
  ),
  el('div', { class: 'panel-section' }, 'Quick links'),
  state.config.n8nDomain ? el('a', { class: 'link-card', href: `https://${state.config.n8nDomain}`, target: '_blank' },
    el('div', { class: 'link-card-title' },
      el('span', {}, 'n8n'),
      el('span', { class: 'link-card-sub' }, 'Workflow automation'),
    ),
    ico('arrow', 16),
  ) : null,
  state.config.odysseusDomain ? el('a', { class: 'link-card', href: `https://${state.config.odysseusDomain}`, target: '_blank' },
    el('div', { class: 'link-card-title' },
      el('span', {}, 'Odysseus'),
      el('span', { class: 'link-card-sub' }, 'Self-hosted AI workspace'),
    ),
    ico('arrow', 16),
  ) : null,
  state.config.loqSftpUrl ? el('div', { class: 'link-card', onclick: async (e) => {
    e.preventDefault();
    try { await navigator.clipboard.writeText(state.config.loqSftpUrl); toast('SFTP URL copied', 'success'); }
    catch { toast(state.config.loqSftpUrl, 'info', 8000); }
  }, style: 'cursor:pointer' },
    el('div', { class: 'link-card-title' },
      el('span', {}, 'Loq files (SFTP)'),
      el('span', { class: 'link-card-sub' }, 'Tap to copy ' + state.config.loqSftpUrl),
    ),
    ico('copy', 16),
  ) : null,
);

// ─── Chat message rendering ────────────────────────────────────────────
const typingDots = () => el('span', { class: 'typing-dots' }, el('span'), el('span'), el('span'));
const chip = (kind, label, iconName) => el('span', { class: `chat-chip chip-${kind}`, title: label },
  ico(iconName, 12), el('span', {}, label));

const renderChatMsg = (m, opts = {}) => {
  const { isLast = false, busy = false, busyStatus = null, busyStart = null } = opts;
  const streaming = isLast && m.role === 'assistant' && busy;

  const body = el('div', { class: 'md-body' });
  if (streaming && !m.content && !m.text) {
    body.appendChild(typingDots());
  } else if (m.role === 'assistant') {
    const txt = m.content || m.text || '';
    body.innerHTML = renderMarkdown(txt) || (streaming ? '' : '<em class="muted">(empty)</em>');
    if (streaming) body.appendChild(el('span', { class: 'typing-cursor' }, '▍'));
  } else {
    body.textContent = m.content || m.text || '';
  }

  if (m.role === 'tool_use') {
    const inputStr = typeof m.input === 'object' ? JSON.stringify(m.input).slice(0, 120) : String(m.input || '').slice(0, 120);
    return el('div', { class: 'ca-tool' }, ico('tools', 12), el('span', {}, `${m.tool}(${inputStr})`));
  }

  if (m.role === 'user') {
    return el('div', { class: 'chat-msg chat-user' },
      el('div', { class: 'chat-label-row' },
        el('div', { class: 'chat-label' }, 'You'),
        m.ts ? el('span', { class: 'chat-time' }, fmtTime(m.ts)) : null,
      ),
      body,
    );
  }

  // Assistant message
  const model = m.model || null;
  const tools = m.tools || [];
  const filesChanged = m.files_changed || [];
  const statusText = streaming
    ? (busyStatus && busyStatus !== 'typing' && busyStatus !== 'reconnecting' ? busyStatus : ((m.content || m.text) ? 'typing' : 'thinking'))
    : null;

  const elapsed = streaming && busyStart ? Date.now() - busyStart : m.elapsed_ms;
  const timeStr = m.ts && !streaming ? fmtTime(m.ts) : '';
  const durStr = elapsed != null ? fmtDur(elapsed) : '';
  const timeDisplay = (timeStr ? timeStr : '') + (durStr ? (timeStr ? ' · ' : '') + durStr : '');

  const chipRow = el('div', { class: 'chat-chips' },
    model ? chip('model', model, 'model') : null,
    ...tools.map(t => chip('tool', toolLabel(t), toolIcon(t))),
    ...filesChanged.map(f => chip('tool', f, 'file')),
    statusText ? chip('status', statusText + '…', 'spinner') : null,
    timeDisplay
      ? el('span', {
          class: 'chat-time' + (streaming ? ' live-timer' : ''),
          'data-start': streaming && busyStart ? String(busyStart) : '',
          'data-prefix': streaming && timeStr ? timeStr : '',
        }, timeDisplay)
      : null,
  );

  return el('div', { class: 'chat-msg chat-assistant' }, chipRow, body);
};

// ─── Chat panel (unified Ollama + Code) ───────────────────────────────

// ─── Code Agent (Claude Code) ──────────────────────────────────────────
const caLoadDir = async (p) => {
  const data = await api('/api/code-agent/dirs' + (p ? '?path=' + encodeURIComponent(p) : ''));
  if (data) {
    state.codeAgent.pickerPath = data.path;
    state.codeAgent.pickerParent = data.parent;
    state.codeAgent.pickerEntries = data.entries || [];
  }
  render();
};
const caRefreshSessions = async () => {
  const data = await api('/api/code-agent/sessions');
  if (data) state.codeAgent.sessions = data.active || [];
  render();
};
const caOpenSessionAt = async (cwd) => {
  if (!cwd) return;
  const d = await api('/api/code-agent/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
  if (d?.id) {
    state.codeAgent.active = d.id;
    state.codeAgent.messages = [];
    state.codeAgent.pickerOpen = false;
    localStorage.setItem('code_default_cwd', cwd);
    persistCode();
    await caRefreshSessions();
  }
};
const caOpenHere = () => caOpenSessionAt(state.codeAgent.pickerPath);
const caNewDefault = () => {
  const def = localStorage.getItem('code_default_cwd');
  if (def) caOpenSessionAt(def);
  else { state.codeAgent.pickerOpen = true; render(); caLoadDir(state.codeAgent.pickerPath); }
};
const caSelect = async (id) => {
  state.codeAgent.active = id;
  state.codeAgent.messages = [];
  persistCode(); render();
  const h = await api(`/api/code-agent/sessions/${id}/history`);
  if (h?.messages) state.codeAgent.messages = h.messages;
  persistCode(); render();
};
const caRename = async (id, e) => {
  e?.stopPropagation();
  const s = state.codeAgent.sessions.find(x => x.id === id);
  const t = prompt('Rename session:', s?.title || '');
  if (!t || t === s?.title) return;
  const r = await api(`/api/code-agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
  if (r && !r.error) await caRefreshSessions();
};
// Archive: ends the running session.  The conversation transcript lives in
// Claude's projects dir on disk, so it stays browsable from the History
// button — "Archive" is the natural label for that, not "Close" or "Delete".
const caClose = async (id, e) => {
  e?.stopPropagation();
  await api(`/api/code-agent/sessions/${id}`, { method: 'DELETE' });
  if (state.codeAgent.active === id) {
    state.codeAgent.active = null; state.codeAgent.messages = [];
    state.codeAgent.busy = false; persistCode();
  }
  toast('Moved to history', 'success');
  await caRefreshSessions();
};

const caReconnect = async (id) => {
  // Snapshot: if reconnect produces nothing, restore what we had.
  const snapshot = state.codeAgent.messages.map(m => ({ ...m }));
  try {
    const r = await fetch(`/api/code-agent/sessions/${id}/stream`, { headers: headers() });
    if (!r.ok) {
      state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (last && last.role === 'assistant') {
        if (last.text) last.text = last.text.replace(/\n?\n?Error: .+$/, '').trim();
        if (!last.text) last.text = '*(session ended while disconnected)*';
      }
      persistCode(); render(); return;
    }
    const lastUserIdx = state.codeAgent.messages.reduce((a, m, i) => m.role === 'user' ? i : a, -1);
    if (lastUserIdx >= 0) state.codeAgent.messages.splice(lastUserIdx + 1);
    render();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotAny = false;
    const ensureLast = () => {
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (!last || last.role !== 'assistant') {
        state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') continue;
        try {
          const e = JSON.parse(p);
          gotAny = true;
          let isTextChunk = false;
          if (e.type === 'text') { ensureLast(); state.codeAgent.messages[state.codeAgent.messages.length - 1].text += e.text; state.codeAgent.status = 'typing'; isTextChunk = true; }
          else if (e.type === 'tool_use') {
            state.codeAgent.messages.push({ role: 'tool_use', tool: e.tool, input: e.input, ts: Date.now() });
            state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
            state.codeAgent.status = `running ${e.tool}`;
          }
          else if (e.type === 'tool_result') state.codeAgent.status = 'thinking';
          else if (e.type === 'result') state.codeAgent.status = e.is_error ? 'error' : null;
          persistCode();
          if (isTextChunk) updateStreamingMessage(); else render();
        } catch {}
      }
    }
    // If we got NOTHING from the stream and our local state is empty/shorter, restore snapshot
    if (!gotAny && snapshot.length > state.codeAgent.messages.length) {
      state.codeAgent.messages = snapshot;
    }
  } catch {}
  while (state.codeAgent.messages.length && state.codeAgent.messages[state.codeAgent.messages.length - 1].role === 'assistant' && !state.codeAgent.messages[state.codeAgent.messages.length - 1].text) {
    state.codeAgent.messages.pop();
  }
  for (let i = state.codeAgent.messages.length - 1; i >= 0; i--) {
    const m = state.codeAgent.messages[i];
    if (m.role === 'assistant' && m.ts && m.elapsed_ms == null) { m.elapsed_ms = Date.now() - m.ts; break; }
  }
  state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
  persistCode(); render();
};

const caSend = async (text) => {
  if (!state.codeAgent.active || !text.trim()) return;
  const now = Date.now();
  state.codeAgent.messages.push({ role: 'user', text, ts: now });
  state.codeAgent.messages.push({ role: 'assistant', text: '', ts: now, elapsed_ms: null });
  state.codeAgent.busy = true; state.codeAgent.status = 'thinking'; state.codeAgent.startTs = now;
  persistCode(); render();
  try {
    const r = await fetch(`/api/code-agent/sessions/${state.codeAgent.active}/messages`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') { gotDone = true; continue; }
        try {
          const e = JSON.parse(p);
          const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
          if (e.type === 'text') { last.text += e.text; state.codeAgent.status = 'typing'; persistCode(); updateStreamingMessage(); }
          else if (e.type === 'tool_use') {
            state.codeAgent.messages.push({ role: 'tool_use', tool: e.tool, input: e.input, ts: Date.now() });
            state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
            state.codeAgent.status = `running ${e.tool}`; persistCode(); render();
          }
          else if (e.type === 'tool_result') { state.codeAgent.status = 'thinking'; render(); }
          else if (e.type === 'result') { state.codeAgent.status = e.is_error ? 'error' : null; }
        } catch {}
      }
    }
    // Stream ended without [DONE] — connection dropped but the session
    // may still be producing output.  Reconnect and replay.
    if (!gotDone && state.codeAgent.active && state.codeAgent.busy) {
      state.codeAgent.status = 'reconnecting'; persistCode(); render();
      caReconnect(state.codeAgent.active);
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') {}
    else if (state.codeAgent.active) {
      state.codeAgent.status = 'reconnecting'; persistCode(); render();
      caReconnect(state.codeAgent.active); return;
    } else {
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (last) last.text = (last.text || '') + `\n\nError: ${e.message}`;
    }
  }
  while (state.codeAgent.messages.length && state.codeAgent.messages[state.codeAgent.messages.length - 1].role === 'assistant' && !state.codeAgent.messages[state.codeAgent.messages.length - 1].text) {
    state.codeAgent.messages.pop();
  }
  for (let i = state.codeAgent.messages.length - 1; i >= 0; i--) {
    const m = state.codeAgent.messages[i];
    if (m.role === 'assistant' && m.ts && m.elapsed_ms == null) { m.elapsed_ms = Date.now() - m.ts; break; }
  }
  state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
  persistCode(); render();
};

// History browser
const caLoadHistory = async () => {
  state.codeAgent.historyOpen = true;
  state.codeAgent.historyView = null;
  state.codeAgent.historyMessages = [];
  render();
  const data = await api('/api/code-agent/history');
  state.codeAgent.historyList = data?.conversations || [];
  render();
};
const caViewHistory = async (conv) => {
  state.codeAgent.historyView = conv;
  state.codeAgent.historyMessages = [];
  state.codeAgent.historyCwd = null;
  render();
  const data = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`);
  state.codeAgent.historyMessages = data?.messages || [];
  state.codeAgent.historyCwd = data?.cwd || null;
  render();
};
const caContinue = async () => {
  const conv = state.codeAgent.historyView;
  const cwd = state.codeAgent.historyCwd;
  if (!conv || !cwd) { toast('Original directory not found', 'warn'); return; }
  const r = await api('/api/code-agent/sessions/resume', {
    method: 'POST',
    body: JSON.stringify({ id: conv.id, cwd, title: conv.title.slice(0, 60) }),
  });
  if (!r || r.error) { toast('Resume failed: ' + (r?.error || 'unknown'), 'danger'); return; }
  state.codeAgent.active = r.id;
  state.codeAgent.messages = state.codeAgent.historyMessages.slice();
  state.codeAgent.historyOpen = false;
  state.codeAgent.historyView = null;
  state.codeAgent.historyMessages = [];
  persistCode();
  await caRefreshSessions();
};
const caRenameHistory = async (conv, e) => {
  e?.stopPropagation();
  const t = prompt('Rename:', conv.title || '');
  if (!t || t === conv.title) return;
  const r = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`, {
    method: 'PATCH', body: JSON.stringify({ title: t }),
  });
  if (r?.ok) {
    conv.title = r.title || t;
    render();
  } else toast('Rename failed', 'danger');
};
const caDeleteHistory = async (conv, e) => {
  e?.stopPropagation();
  if (!confirm(`Delete "${conv.title.slice(0, 60)}${conv.title.length > 60 ? '…' : ''}"?`)) return;
  const r = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
  if (r?.ok) {
    state.codeAgent.historyList = state.codeAgent.historyList.filter(c => !(c.project === conv.project && c.id === conv.id));
    if (state.codeAgent.historyView?.id === conv.id) {
      state.codeAgent.historyView = null;
      state.codeAgent.historyMessages = [];
    }
    render();
  }
};

// Code chat panel (mode = "code")
const panelChatCode = () => {
  const ca = state.codeAgent;
  const activeSession = ca.sessions.find(s => s.id === ca.active);

  // Directory picker
  if (ca.pickerOpen) {
    const rows = [];
    if (ca.pickerParent && ca.pickerParent !== ca.pickerPath) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(ca.pickerParent) }, ico('arrow_left', 14), el('span', {}, 'Up a level')));
    }
    for (const e of ca.pickerEntries.filter(x => x.type === 'dir')) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(e.path) }, ico('folder', 14), el('span', {}, e.name)));
    }
    return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
      el('div', { class: 'panel-head' }, el('span', {}, 'Open Code In…')),
      el('div', { class: 'ca-path' }, ca.pickerPath),
      el('div', { class: 'ca-dir-list' }, ...rows),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn sm', onclick: () => { ca.pickerOpen = false; render(); } }, 'Cancel'),
        el('button', { class: 'btn sm primary', onclick: caOpenHere }, 'Open here'),
      ),
    );
  }

  // History browser
  if (ca.historyOpen) {
    if (ca.historyView) {
      const grouped = [];
      let toolCount = 0;
      for (const m of ca.historyMessages) {
        if (m.role === 'tool_use') { toolCount++; if (!ca.historyShowTools) continue; grouped.push(m); continue; }
        const last = grouped[grouped.length - 1];
        if (last && last.role === m.role && (last.role === 'user' || last.role === 'assistant')) {
          last.text = (last.text || '') + '\n\n' + (m.text || '');
        } else grouped.push({ ...m });
      }
      const msgs = grouped.map(m => renderChatMsg(m));
      return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
        el('div', { class: 'panel-head' }, el('span', {}, 'History')),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn sm', onclick: () => { ca.historyView = null; ca.historyMessages = []; ca.historyCwd = null; render(); } }, ico('arrow_left', 14), ' Back'),
          toolCount > 0 ? el('button', { class: 'btn sm', onclick: () => { ca.historyShowTools = !ca.historyShowTools; render(); } },
            ca.historyShowTools ? `Hide tools (${toolCount})` : `Show tools (${toolCount})`) : null,
          ca.historyCwd ? el('button', { class: 'btn sm primary', onclick: caContinue }, 'Continue ', ico('arrow', 14)) : null,
        ),
        el('div', { class: 'ca-hist-title' }, ca.historyView.title),
        el('div', { class: 'ca-hist-meta' }, `${ca.historyView.project} · ${ca.historyView.messageCount} events${ca.historyCwd ? ' · ' + ca.historyCwd : ''}`),
        el('div', { class: 'chat-wrap' }, el('div', { class: 'chat-log' }, ...msgs)),
      );
    }
    return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
      el('div', { class: 'panel-head' }, el('span', {}, 'History')),
      el('button', { class: 'btn sm', onclick: () => { ca.historyOpen = false; render(); } }, ico('arrow_left', 14), ' Back'),
      ca.historyList.length === 0
        ? el('div', { class: 'muted', style: 'padding:20px;text-align:center;font-size:0.78rem' }, 'no past conversations')
        : el('div', { class: 'ca-hist-list' },
            ...ca.historyList.map(conv =>
              el('div', { class: 'saved-item', onclick: () => caViewHistory(conv) },
                el('div', { class: 'ca-hist-row' },
                  el('div', { class: 'saved-title' }, conv.title),
                  el('div', { class: 'saved-actions' },
                    el('button', { class: 'btn ghost icon', onclick: (e) => caRenameHistory(conv, e), title: 'Rename' }, ico('pencil', 12)),
                    el('button', { class: 'btn ghost icon danger', onclick: (e) => caDeleteHistory(conv, e), title: 'Delete' }, ico('trash', 12)),
                  ),
                ),
                el('div', { class: 'ca-hist-meta-row' },
                  el('span', { class: 'ca-hist-date' }, fmtTime(conv.modified)),
                  conv.messageCount ? el('span', { class: 'ca-hist-count' }, `${conv.messageCount} msgs`) : null,
                ),
              ),
            ),
          ),
    );
  }

  // Build session message log
  const log = el('div', { class: 'chat-log' });
  if (!activeSession) {
    log.appendChild(el('div', { class: 'chat-empty' },
      ico('code', 28),
      el('div', {}, ca.sessions.length ? 'Pick a session above' : 'Open a folder to start'),
    ));
  } else {
    const lastIdx = ca.messages.length - 1;
    ca.messages.forEach((m, i) => {
      // Skip empty assistant placeholders left over from a tool turn that
      // produced no text — they show up as "(empty)" otherwise.  The streaming
      // placeholder (last + busy) stays because it renders the typing dots.
      const isLast = i === lastIdx;
      const empty = m.role === 'assistant' && !(m.text || m.content);
      if (empty && !(isLast && ca.busy)) return;
      log.appendChild(renderChatMsg(m, {
        isLast, busy: ca.busy, busyStatus: ca.status, busyStart: ca.startTs,
      }));
    });
  }

  const input = el('textarea', { class: 'chat-input', rows: '1',
    placeholder: activeSession ? 'Message Claude…' : 'Pick a session' });
  input.value = localStorage.getItem('draft_code') || '';
  const sendCode = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = ''; localStorage.removeItem('draft_code');
    caSend(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCode(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_code', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  const sessionTabs = ca.sessions.length
    ? el('div', { class: 'ca-sess-list' },
        ...ca.sessions.map(s =>
          el('div', { class: 'ca-sess' + (s.id === ca.active ? ' active' : ''), onclick: () => caSelect(s.id) },
            el('span', { class: 'ca-sess-title' }, s.title),
            el('span', { class: 'ca-sess-cwd' }, s.cwd.replace(/^\/media\/ojee\/NVME\/Code\/\[GIT\]\//, '')),
            el('div', { class: 'saved-actions' },
              el('button', { class: 'btn ghost icon', onclick: (e) => caRename(s.id, e), title: 'Rename' }, ico('pencil', 12)),
              el('button', { class: 'btn ghost icon', onclick: (e) => caClose(s.id, e), title: 'Archive — move to history' }, ico('archive', 12)),
            ),
          ),
        ),
      )
    : el('div', { class: 'muted', style: 'padding:8px;font-size:0.78rem' }, 'no active sessions');

  const headerSection = el('div', { class: 'panel-head' },
    el('span', {}, 'Claude Code'),
  );

  const defCwd = localStorage.getItem('code_default_cwd');
  const toolbar = el('div', { class: 'btn-row' },
    el('button', { class: 'btn sm primary', onclick: caNewDefault, title: defCwd ? `New in ${defCwd}` : 'Pick a folder' }, ico('plus', 14), ' New'),
    el('button', { class: 'btn sm', onclick: () => { ca.pickerOpen = true; render(); caLoadDir(ca.pickerPath); }, title: 'Browse for a different folder' }, ico('folder', 14)),
    el('button', { class: 'btn sm', onclick: caRefreshSessions, title: 'Refresh' }, ico('reload', 14)),
    el('button', { class: 'btn sm', onclick: caLoadHistory }, ico('history', 14), ' History'),
  );

  return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
    headerSection,
    toolbar,
    sessionTabs,
    activeSession ? el('div', { class: 'chat-wrap' },
      el('div', { class: 'ca-active-head' },
        el('span', { class: 'ca-active-title' }, activeSession.title),
        el('span', { class: 'ca-active-cwd' }, activeSession.cwd),
        el('button', { class: 'btn ghost icon', onclick: (e) => caRename(activeSession.id, e), title: 'Rename' }, ico('pencil', 12)),
        el('button', { class: 'btn ghost icon', onclick: (e) => caClose(activeSession.id, e), title: 'Archive — move to history' }, ico('archive', 12)),
      ),
      log,
      el('div', { class: 'chat-form' },
        input,
        ca.busy ? el('button', { class: 'btn chat-send chat-stop', title: 'Stop' }, ico('stop', 14)) : null,
        el('button', { class: 'btn primary chat-send', onclick: sendCode, title: 'Send' }, ico('send', 14)),
      ),
    ) : null,
  );
};

// Update only the last assistant message's body during streaming — avoids
// the full DOM rebuild that was making the send button flash on every text
// chunk.  Falls back to render() if we can't find the target node.
const updateStreamingMessage = () => {
  const log = document.querySelector('.chat-log');
  if (!log) return render();
  const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
  if (!last || last.role !== 'assistant') return render();
  const bodies = log.querySelectorAll('.chat-msg.chat-assistant .md-body');
  const body = bodies[bodies.length - 1];
  if (!body) return render();
  const txt = last.content || last.text || '';
  body.innerHTML = renderMarkdown(txt) || '';
  body.appendChild(el('span', { class: 'typing-cursor' }, '▍'));
  // Stick to bottom if we were near it
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 100) {
    log.scrollTop = log.scrollHeight;
  }
};

// ─── Live timer ────────────────────────────────────────────────────────
let liveTimerInterval = null;
const startLiveTimer = () => {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(() => {
    const timers = document.querySelectorAll('.live-timer');
    if (!timers.length) { clearInterval(liveTimerInterval); liveTimerInterval = null; return; }
    for (const t of timers) {
      const start = parseInt(t.dataset.start, 10);
      if (!start) continue;
      const elapsed = Date.now() - start;
      const prefix = t.dataset.prefix || '';
      t.textContent = (prefix ? prefix + ' · ' : '') + fmtDur(elapsed);
    }
  }, 1000);
};

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
  const activePanel = state.view === 'chat' ? 'chat'
    : state.view === 'services' ? 'services'
    : state.view === 'actions' ? 'actions'
    : 'dashboard';
  const build = { dashboard: panelSystem, services: panelServices,
                  actions: panelActions, chat: panelChatCode }[activePanel];
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

  if (state.codeAgent.busy && state.codeAgent.startTs) startLiveTimer();
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

  if (!state.codeAgent.checked) {
    state.codeAgent.checked = true;
    const cfg = await api('/api/code-agent/config');
    state.codeAgent.enabled = !!cfg?.enabled;
  }
  if (state.codeAgent.enabled && !state.codeAgent.busy) {
    const s = await api('/api/code-agent/sessions');
    if (s?.active) state.codeAgent.sessions = s.active;
  }
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
  restoreCode();
  render();
  refresh();
  // Tracked so unmount() can stop it. An untracked interval keeps polling —
  // and keeps re-rendering into a detached root — after the module is gone.
  pollTimer = setInterval(refresh, 5000);

  visHandler = () => {
    if (document.visibilityState !== 'visible') return;
    if (state.codeAgent.busy && state.codeAgent.active) {
      state.codeAgent.status = 'reconnecting'; render();
      caReconnect(state.codeAgent.active);
    }
  };
  document.addEventListener('visibilitychange', visHandler);
  if (state.codeAgent.active) {
    try {
      const h = await api(`/api/code-agent/sessions/${state.codeAgent.active}/history`);
      if (h?.messages && h.messages.length >= state.codeAgent.messages.length) {
        state.codeAgent.messages = h.messages;
        persistCode(); render();
      }
    } catch {}
    if (state.codeAgent.busy) caReconnect(state.codeAgent.active);
  }

  // Keyboard shortcuts: Cmd/Ctrl+K for new chat, Esc to close history/picker
  keyHandler = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') {
      if (state.codeAgent.pickerOpen) { state.codeAgent.pickerOpen = false; render(); }
      else if (state.codeAgent.historyOpen) {
        if (state.codeAgent.historyView) {
          state.codeAgent.historyView = null;
          state.codeAgent.historyMessages = [];
          state.codeAgent.historyCwd = null;
        } else state.codeAgent.historyOpen = false;
        render();
      } else if (state.showSavedList) {
        state.showSavedList = false; render();
      }
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
    if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    pollTimer = keyHandler = visHandler = null;
    root = null;
    ctx = null;
  },
};
