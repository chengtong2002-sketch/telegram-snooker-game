/**
 * Browser side of skins.js: bundles the cosmetics SVGs and hands the chosen
 * ones to the renderer.
 *
 * Which skins are drawn is decided per turn (skinIdsForTurn): the shooter's
 * equipped cue and cue ball, or the player's own in practice. Under
 * `npm run dev:game` a URL switch previews any item on the player's own turns:
 * ?cue=crimson-crown&ball=gold-band. Production builds ignore the parameters.
 */
import catalog from '@snooker/cosmetics/cosmetics.json';
import { parseCueSvg, prepareBallSvg, pickSkins } from './skins.js';
import { equippedSkins } from './settings.js';

// Bundled as text: no request at play time, and nothing to fail to load.
const cueSvgs = import.meta.glob('../../shared/cosmetics/cues/*.svg', { query: '?raw', import: 'default', eager: true });
const ballSvgs = import.meta.glob('../../shared/cosmetics/balls/*.svg', { query: '?raw', import: 'default', eager: true });

const devSearch = () => (import.meta.env.DEV ? window.location.search : '');

/** The SVG text of a catalog item, or null. */
export function itemSvg(item) {
  const table = catalog.cues.includes(item) ? cueSvgs : ballSvgs;
  return table[`../../shared/cosmetics/${item.file}`] ?? null;
}

/** An SVG as an <img> source. An <img> keeps each SVG's gradient ids to itself. */
export const svgDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Decode a ball SVG into an image the renderer can draw from. */
function loadImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = svgDataUrl(svg);
  });
}

// Parsed once per item: a turn change should cost nothing.
const cueModels = new Map();
const ballImages = new Map();

function cueModel(item) {
  if (!cueModels.has(item.id)) {
    const svg = itemSvg(item);
    cueModels.set(item.id, svg ? parseCueSvg(svg) : null);
  }
  return cueModels.get(item.id);
}

function ballImage(item) {
  if (!ballImages.has(item.id)) {
    const svg = itemSvg(item);
    ballImages.set(item.id, svg ? loadImage(prepareBallSvg(svg)).catch(() => null) : Promise.resolve(null));
  }
  return ballImages.get(item.id);
}

/**
 * The player's own skins: the dev URL switch, else what they equipped (the
 * copy kept on this device, so practice offline still draws it), else the
 * defaults. Always item objects, never ids.
 */
export const mySkinItems = () => pickSkins(devSearch(), catalog, equippedSkins());

/** Ids for mySkinItems, in the shape skinIdsForTurn and the server use. */
export function mySkinIds() {
  const { cue, ball } = mySkinItems();
  return { cue: cue?.id, ball: ball?.id };
}

/**
 * Something that puts a pair of skins on the renderer. Calls with the same
 * ids do nothing, so it can be called at every turn start. A ball image still
 * decoding when the next call arrives is dropped, so a slow decode can never
 * put the previous shooter's cue ball back on the table.
 */
export function createSkinSwitcher(renderer) {
  const shown = { cue: null, ball: null };
  let ballRequest = 0;

  return {
    /** @param {{cue?: string, ball?: string}} ids  unknown or missing ids get the defaults */
    show(ids) {
      const { cue, ball } = pickSkins('', catalog, ids);
      if (cue && cue.id !== shown.cue) {
        shown.cue = cue.id;
        renderer.setCueSkin(cueModel(cue));
      }
      if (ball && ball.id !== shown.ball) {
        shown.ball = ball.id;
        const request = ++ballRequest;
        // The previous cue ball stays until this decodes (a frame or two, once).
        ballImage(ball).then((image) => {
          if (request === ballRequest && image) renderer.setBallSkin(image);
        });
      }
    },
    /** Decode ahead, e.g. both seats' cue balls as a match loads. */
    preload(list = []) {
      for (const ids of list) {
        const { ball } = pickSkins('', catalog, ids);
        if (ball) ballImage(ball);
      }
    },
  };
}
