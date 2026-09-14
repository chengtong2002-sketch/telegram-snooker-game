/**
 * Pin #app to the part of the screen the player can actually see.
 *
 * `100vh` is the viewport with the browser's address bar and toolbar hidden,
 * so on a phone the bottom of the layout — where SHOOT lives — sits under the
 * toolbar. `100dvh` is meant to fix that but is missing or wrong in older
 * mobile browsers. visualViewport reports the visible rectangle after browser
 * chrome, and fires when the bars slide in or out, so it is the reliable source.
 *
 * The CSS falls back to 100dvh when this API is absent.
 */
export function trackVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;

  const root = document.documentElement.style;
  let frame = 0;

  const apply = () => {
    frame = 0;
    root.setProperty('--app-h', `${vv.height}px`);
    root.setProperty('--app-w', `${vv.width}px`);
    // #app is position: fixed, i.e. relative to the layout viewport. When the
    // visible area is offset inside it (iOS Safari with its bars showing),
    // follow the offset so the top edge does not slide under the address bar.
    root.setProperty('--app-top', `${vv.offsetTop}px`);
    root.setProperty('--app-left', `${vv.offsetLeft}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  apply();
}
