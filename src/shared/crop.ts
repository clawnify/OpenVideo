// Cropping a clip: the geometry the crop dialog, the preview and the export
// agree on.
//
// A crop is a rectangle of the SOURCE frame, in shares of its width and
// height, and it is applied before anything else: the render service cuts it
// out first, then fits or fills the frame with what is left (and slides a
// filled clip by its anchor). So a cropped clip behaves exactly like footage
// that was shot at the cropped size, and the preview has to place it that way.

import { CENTRE, type Anchor } from "./format";

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Shape = { width: number; height: number };
export type Fit = "contain" | "cover";

/** A rectangle in shares of whatever contains it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest crop side, as a share of the source (the service's floor). */
export const MIN_CROP = 0.05;

export const FULL: Crop = { x: 0, y: 0, width: 1, height: 1 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The frame a cropped source amounts to, in pixels. */
export function croppedShape(src: Shape, crop: Crop | undefined): Shape {
  const c = crop ?? FULL;
  return { width: src.width * c.width, height: src.height * c.height };
}

/**
 * Where a clip lands in the frame, as shares of the frame: `box` is the
 * visible (cropped) picture, and `source` is the whole uncropped source
 * relative to that box, so the preview can draw the full frame and let the
 * box clip it. Matches the service's chain: crop, then scale to fit or fill,
 * then centre (contain) or slide by the anchor (cover). A filled box spills
 * past the frame's edges; the stage hides that.
 */
export function placeClip(
  src: Shape,
  crop: Crop | undefined,
  frame: Shape,
  fit: Fit,
  anchor: Anchor = CENTRE,
): { box: Rect; source: Rect } {
  const c = crop ?? FULL;
  const shown = croppedShape(src, c);
  const scale =
    fit === "cover"
      ? Math.max(frame.width / shown.width, frame.height / shown.height)
      : Math.min(frame.width / shown.width, frame.height / shown.height);
  const w = (shown.width * scale) / frame.width;
  const h = (shown.height * scale) / frame.height;
  const at = fit === "cover" ? anchor : CENTRE;
  return {
    box: { left: (1 - w) * at.x, top: (1 - h) * at.y, width: w, height: h },
    source: { left: -c.x / c.width, top: -c.y / c.height, width: 1 / c.width, height: 1 / c.height },
  };
}

/** A crop that keeps the whole frame is no crop: store nothing for it. */
export function isFull(crop: Crop | undefined): boolean {
  return !crop || (crop.x <= 0.0005 && crop.y <= 0.0005 && crop.width >= 0.9995 && crop.height >= 0.9995);
}

/** Rounded and pulled inside the source, the way it is saved. */
export function tidyCrop(c: Crop): Crop | undefined {
  const width = clamp(round4(c.width), MIN_CROP, 1);
  const height = clamp(round4(c.height), MIN_CROP, 1);
  const out = {
    x: clamp(round4(c.x), 0, round4(1 - width)),
    y: clamp(round4(c.y), 0, round4(1 - height)),
    width,
    height,
  };
  return isFull(out) ? undefined : out;
}

/**
 * The share-of-source width over height that gives `ratio` (pixels) on a
 * source of shape `src`. A 1:1 crop of a 16:9 source is 0.5625 wide per 1 high.
 */
function shareRatio(ratio: number, src: Shape): number {
  return (ratio * src.height) / src.width;
}

/**
 * The biggest crop of `ratio` (width / height in pixels) that fits the
 * source, centred on `around` (a point in shares of the source) and moved
 * only as far as it has to be to stay inside.
 */
export function cropToRatio(src: Shape, ratio: number, around: { x: number; y: number } = { x: 0.5, y: 0.5 }): Crop {
  const r = shareRatio(ratio, src);
  const width = r >= 1 ? 1 : r;
  const height = r >= 1 ? 1 / r : 1;
  return {
    x: clamp(around.x - width / 2, 0, 1 - width),
    y: clamp(around.y - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/** Slide the crop by `dx`, `dy` (shares of the source), keeping it inside. */
export function moveCrop(c: Crop, dx: number, dy: number): Crop {
  return { ...c, x: clamp(c.x + dx, 0, 1 - c.width), y: clamp(c.y + dy, 0, 1 - c.height) };
}

/** A corner or an edge: which sides of the crop a handle moves. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Drag one handle by `dx`, `dy` (shares of the source). The opposite side
 * stays put. With a `ratio` (pixels, width / height) the crop keeps that
 * shape: an edge handle grows the other axis around its middle, a corner
 * follows whichever axis moved further. The result never leaves the source
 * and never shrinks below MIN_CROP.
 */
export function resizeCrop(c: Crop, handle: Handle, dx: number, dy: number, src: Shape, ratio?: number): Crop {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  // Each side's position, with the moved ones dragged and held inside.
  let l = c.x;
  let r = c.x + c.width;
  let t = c.y;
  let b = c.y + c.height;
  if (west) l = clamp(l + dx, 0, r - MIN_CROP);
  if (east) r = clamp(r + dx, l + MIN_CROP, 1);
  if (north) t = clamp(t + dy, 0, b - MIN_CROP);
  if (south) b = clamp(b + dy, t + MIN_CROP, 1);
  if (!ratio) return { x: l, y: t, width: r - l, height: b - t };

  const k = shareRatio(ratio, src); // width share per unit of height share
  let w = r - l;
  let h = b - t;
  const horizontal = west || east;
  const vertical = north || south;
  // Which axis leads: the one being dragged, or for a corner the one that moved more.
  const widthLeads = horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy) * k);
  if (widthLeads) h = w / k;
  else w = h * k;

  // How much room there is on the sides that may move, for each axis.
  const cx = (c.x * 2 + c.width) / 2;
  const cy = (c.y * 2 + c.height) / 2;
  const roomW = west ? r : east ? 1 - l : 2 * Math.min(cx, 1 - cx);
  const roomH = north ? b : south ? 1 - t : 2 * Math.min(cy, 1 - cy);
  const fit = Math.min(1, roomW / w, roomH / h);
  w *= fit;
  h *= fit;
  // Never below the floor on either side, if the shape allows it at all.
  const grow = Math.max(1, MIN_CROP / w, MIN_CROP / h);
  if (w * grow <= roomW + 1e-9 && h * grow <= roomH + 1e-9) {
    w *= grow;
    h *= grow;
  }

  const x = west ? r - w : east ? l : cx - w / 2;
  const y = north ? b - h : south ? t : cy - h / 2;
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), width: w, height: h };
}

/** The crop's shape in pixels, as width / height. */
export function cropRatio(c: Crop, src: Shape): number {
  return (c.width * src.width) / (c.height * src.height);
}
