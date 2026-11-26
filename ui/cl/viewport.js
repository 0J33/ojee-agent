/* ============================================================
   The visible part of the screen, from the VisualViewport API.

   A phone's keyboard covers the page instead of shrinking it (iOS,
   and Android without interactive-widget=resizes-content), and the
   message box and the terminal's input line are exactly what it
   covers. The visual viewport is what is left above the keyboard:
   its height and offset go into CSS variables on one element, and
   the session view, fixed to them on a phone, always ends on top
   of the keyboard.

   Event-driven only: the viewport's own resize and scroll events
   (fired while the keyboard animates and once it settles), one
   frame per burst. No timers guessing when the keyboard is done.
   ============================================================ */

export function watchViewport(el, onChange = () => {}) {
  const vv = window.visualViewport;
  let raf = 0;
  let last = '';
  const run = () => {
    raf = 0;
    const height = vv ? vv.height : innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const layout = document.documentElement.clientHeight;
    // A keyboard: the visible part is much shorter than the layout, and it is
    // not a pinch-zoom (scale stays at 1).
    const keyboard = !!vv && vv.scale < 1.05 && layout - height > 120;
    const sig = `${Math.round(height)}:${Math.round(top)}:${keyboard}`;
    if (sig === last) return;
    last = sig;
    el.style.setProperty('--vv-h', `${Math.round(height)}px`);
    el.style.setProperty('--vv-top', `${Math.round(top)}px`);
    el.classList.toggle('kb', keyboard);
    onChange({ height, top, keyboard });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  // Focus moving into or out of a field is when a keyboard comes or goes;
  // the viewport events that follow carry the numbers.
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  run();
  return () => {
    cancelAnimationFrame(raf);
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
  };
}

/**
 * The height left for the view inside its scrolling ancestor (the console's
 * main area, or a standalone page), measured from where the view starts:
 * the desktop layout fits one screen without the page scrolling.
 */
export function watchFit(el, scroller, onFit) {
  const measure = () => {
    const box = scroller.getBoundingClientRect();
    const top = el.getBoundingClientRect().top;
    const padBottom = parseFloat(getComputedStyle(el.parentElement || el).paddingBottom) || 0;
    const avail = Math.floor(box.bottom - top - Math.max(16, Math.min(padBottom, 28)));
    onFit(avail);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(scroller);
  measure();
  return () => ro.disconnect();
}

/** The nearest ancestor that scrolls (the console's .main), or the document. */
export function scrollerOf(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return document.documentElement;
}
