/**
 * Browser side of skins.js: bundles the cosmetics SVGs and hands the chosen
 * ones to the renderer.
 *
 * Every player gets the catalog defaults (Club Ash cue, Club White cue ball)
 * until there is a store to equip from. Under `npm run dev:game` a URL switch
 * previews any item: ?cue=crimson-crown&ball=gold-band. Production builds
 * ignore the parameters.
 */
import catalog from '@snooker/cosmetics/cosmetics.json';
import { parseCueSvg, prepareBallSvg, pickSkins } from './skins.js';

// Bundled as text: no request at play time, and nothing to fail to load.
const cueSvgs = import.meta.glob('../../shared/cosmetics/cues/*.svg', { query: '?raw', import: 'default', eager: true });
const ballSvgs = import.meta.glob('../../shared/cosmetics/balls/*.svg', { query: '?raw', import: 'default', eager: true });
const svgFor = (table, item) => table[`../../shared/cosmetics/${item.file}`] ?? null;

/** Decode a ball SVG into an image the renderer can draw from. */
function loadImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export async function applySkins(renderer, search = import.meta.env.DEV ? window.location.search : '') {
  const { cue, ball } = pickSkins(search, catalog);
  if (cue) {
    const svg = svgFor(cueSvgs, cue);
    if (svg) renderer.setCueSkin(parseCueSvg(svg));
  }
  if (ball) {
    const svg = svgFor(ballSvgs, ball);
    // The original cue ball is drawn until this decodes (a frame or two).
    if (svg) renderer.setBallSkin(await loadImage(prepareBallSvg(svg)));
  }
}
