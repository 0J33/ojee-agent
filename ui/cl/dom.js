/* ============================================================
   Small DOM helpers for the Claude view. Everything here builds
   nodes, never HTML strings: every word on screen is whatever a
   model, a tool or a terminal wrote.
   ============================================================ */

/** h('div', { class: 'x', onclick }, child, [children], 'text') */
export function h(tag, attrs = {}, ...kids) {
  const n = tag === 'svg' || tag === 'use' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  append(n, kids);
  return n;
}

function append(n, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) append(n, kid);
    else n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

/** A line icon from the v3 sprite (icons3.svg). */
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `i${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Replace a node's children only when what they show changed (keeps taps and focus alive). */
export function swap(host, sig, build) {
  if (!host) return false;
  if (host.dataset.sig === sig && host.firstChild) return false;
  host.dataset.sig = sig;
  host.replaceChildren(...[].concat(build()).filter(Boolean));
  return true;
}

export const clip = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

/** "now", "4m", "2h", "3d" — the list's time column. */
export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60); if (hr < 36) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** 16:40, or "Thu 26 Nov 16:40" when not today. */
export function clock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
}

export function dur(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** "…/forsa-work/team": a long path cut at the front, keeping its last folders. */
export function tailPath(p, max = 40) {
  const t = String(p || '');
  if (t.length <= max) return t;
  const parts = t.split('/');
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max - 2) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

export const touch = () => window.matchMedia('(pointer: coarse)').matches;
export const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Text to the clipboard from inside the click that asked: the async API on a
 * secure page, else the old copy command (plain http over the tailnet).
 */
export async function copyText(text) {
  if (!text) return false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* refused */ }
  const ta = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px' });
  ta.value = text;
  const prev = document.activeElement;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ }
  return ok;
}

/** localStorage, never throwing (private windows, blocked storage). */
export function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* the default it is */ }
  return null;
}

/**
 * A small menu anchored to a button: opens under it (or above, near the
 * bottom), scales in from the trigger, closes on a pick, Esc or a tap outside.
 * items: [{ label, icon, meta, danger, disabled, current, run }] — null skipped.
 */
let openMenu = null;
export function menu(anchor, items, { label = 'Menu', align = 'end' } = {}) {
  if (openMenu?.anchor === anchor) { openMenu.close(); return; }
  openMenu?.close();
  const list = items.filter(Boolean);
  const box = h('div', { class: 'cl-menu', role: 'menu', 'aria-label': label },
    list.map((it) => (it.sep ? h('div', { class: 'cl-menu-sep', role: 'separator' })
      : h('button', {
        class: `cl-menu-it${it.danger ? ' danger' : ''}${it.current ? ' cur' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: it.disabled || null,
        'aria-current': it.current ? 'true' : null,
        onclick: () => { close(); it.run?.(); },
      }, it.lead || (it.icon ? icon(it.icon) : null), h('span', { class: 'lbl' }, it.label), it.meta ? h('span', { class: 'meta' }, it.meta) : null))));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport?.height || innerHeight;
  const w = Math.min(300, vw - 16);
  box.style.width = `${Math.max(200, Math.min(w, box.offsetWidth))}px`;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  const below = r.bottom + 6 + bh < vh - 8 || r.top - 6 - bh < 8;
  const left = align === 'start' ? r.left : r.right - bw;
  box.style.left = `${Math.max(8, Math.min(vw - bw - 8, left))}px`;
  box.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - bh)}px`;
  box.style.transformOrigin = `${align === 'start' ? 'left' : 'right'} ${below ? 'top' : 'bottom'}`;
  box.classList.add('in');
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...box.querySelectorAll('button:not([disabled])')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };
  function close() {
    if (openMenu?.box !== box) return;
    openMenu = null;
    box.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', close);
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  openMenu = { anchor, box, close };
  if (!touch()) box.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}
export const closeMenu = () => openMenu?.close();
export const menuOpen = () => !!openMenu;
