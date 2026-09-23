// The video's shape (its format), decided in one place for the picker, the
// preview, the export and Ask.
//
// OpenScreen hit the failure this prevents: three places each worked out the
// output shape on their own, and old projects previewed 16:9 while the export
// rendered portrait. Here the picker and Ask both change the format through
// `reshape`, and everything else reads the document's output size.
//
// The shape is always chosen, never inferred from the clips: following the
// biggest clip flips the whole project's shape the moment a clip is added or
// removed. Clips' own shapes are only offered as choices ("Original").

import { blockWidth, type FontFamily } from "./textLayout";

export interface FormatPreset {
  ratio: string;
  name: string;
  /** Where the shape is used, for the picker. */
  hint: string;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { ratio: "16:9", name: "Landscape", hint: "YouTube, websites" },
  { ratio: "9:16", name: "Vertical", hint: "Reels, TikTok, Shorts" },
  { ratio: "1:1", name: "Square", hint: "Feed posts" },
  { ratio: "4:5", name: "Portrait", hint: "Instagram feed" },
  { ratio: "4:3", name: "Classic", hint: "Presentations" },
];

/** What the render service accepts (src/server/edl.ts). */
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MIN_SIDE = 16;

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** Pixel dimensions → the reduced "W:H" that names their shape. 1920x1080 and 3840x2160 are both "16:9". */
export function ratioOf(width: number, height: number): string {
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

export function parseRatio(ratio: string): { w: number; h: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

const even = (n: number) => Math.max(MIN_SIDE, 2 * Math.round(n / 2));

/**
 * The frame for a shape, keeping the current long side so a format change
 * never changes the resolution class. Sides are even (H.264's colour planes
 * are half-resolution) and within what the render service accepts.
 */
export function sizeFor(ratio: string, longSide: number): { width: number; height: number } | null {
  const r = parseRatio(ratio);
  if (!r) return null;
  let width = r.w >= r.h ? longSide : (longSide * r.w) / r.h;
  let height = r.w >= r.h ? (longSide * r.h) / r.w : longSide;
  const shrink = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  width *= shrink;
  height *= shrink;
  return { width: even(width), height: even(height) };
}

/**
 * Whether two frames have the same shape. Sides are rounded to even pixels,
 * so 16:9 at 1080 wide is 1080x608, a hair off the exact ratio.
 */
export function sameShape(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs((a.width * b.height) / (a.height * b.width) - 1) < 0.01;
}

/** The preset a frame matches, if any. */
export function presetFor(width: number, height: number): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => {
    const r = parseRatio(p.ratio)!;
    return sameShape({ width, height }, { width: r.w, height: r.h });
  });
}

/** How a shape reads: "16:9", or "2.39:1" for one with no short ratio. */
export function ratioLabel(width: number, height: number): string {
  const ratio = ratioOf(width, height);
  const [w, h] = ratio.split(":").map(Number);
  if (w <= 32 && h <= 32) return ratio;
  return width >= height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
}

/** Only the parts of a document a format change touches. */
interface ReshapeText {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily?: FontFamily;
  background?: string;
  align?: "left" | "center" | "right";
  x: number;
}

interface ReshapeMedia {
  type: "video" | "image";
  /** Share of the frame's width. */
  width: number;
  x: number;
}

interface Reshapeable {
  output: { width: number; height: number };
  overlays?: { elements: (ReshapeText | ReshapeMedia)[] }[];
}

type Frame = { width: number; height: number };

const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** A bound rounded towards the frame's inside, so rounding never pushes past it. */
const inward = (n: number, dir: "up" | "down") => (dir === "up" ? Math.ceil(n * 1000) : Math.floor(n * 1000)) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Change the frame to `width` x `height`. Positions are shares of the frame,
 * so everything stays where it was; sizes are kept relative to the frame's
 * short side, so a title fills as much of a vertical video as it did of the
 * landscape one. Clips are not touched: each keeps its fit (letterbox or
 * fill). Captions need nothing: their size is already a share of the frame.
 */
export function reshape<E extends Reshapeable>(edl: E, width: number, height: number): E {
  const before = edl.output;
  const after = { width, height };
  const scale = Math.min(width, height) / Math.min(before.width, before.height);
  return {
    ...edl,
    output: { ...edl.output, width, height },
    overlays: edl.overlays?.map((track) => ({
      ...track,
      elements: track.elements.map((el) =>
        el.type === "text" ? reshapeText(el, before, after, scale) : reshapeMedia(el, before, after, scale),
      ),
    })),
  };
}

/**
 * A title keeps its alignment point. When the frame narrows it takes up more
 * of the width, so one that was fully in frame is moved just enough to stay
 * in it; one placed partly outside on purpose is left alone.
 */
function reshapeText<T extends ReshapeText>(el: T, before: Frame, after: Frame, scale: number): T {
  const fontSize = clamp(Math.round(el.fontSize * scale), 8, 400);
  const family = el.fontFamily ?? "sans";
  const boxed = !!el.background;
  // Share of the block left of its x: none when left-aligned, half when centred.
  const lead = el.align === "center" ? 0.5 : el.align === "right" ? 1 : 0;
  const was = blockWidth(el.text, el.fontSize, before.width, family, boxed) / before.width;
  const now = blockWidth(el.text, fontSize, after.width, family, boxed) / after.width;
  const inside = el.x - lead * was >= -0.001 && el.x + (1 - lead) * was <= 1.001;
  const x = inside ? clamp(el.x, inward(lead * now, "up"), inward(1 - (1 - lead) * now, "down")) : el.x;
  return { ...el, fontSize, x: clamp(round3(x), 0, 1) };
}

/**
 * An image or video keeps the side of the frame it sits on: one in the right
 * half keeps its right edge, so a logo in a corner stays in that corner
 * instead of growing off the edge of a narrower frame.
 */
function reshapeMedia<T extends ReshapeMedia>(el: T, before: Frame, after: Frame, scale: number): T {
  const w = clamp(round3((el.width * before.width * scale) / after.width), 0.01, 1);
  const centre = el.x + el.width / 2;
  const x = Math.abs(centre - 0.5) < 0.01 ? centre - w / 2 : centre > 0.5 ? el.x + el.width - w : el.x;
  const inside = el.x + el.width <= 1.001;
  return { ...el, width: w, x: clamp(round3(x), 0, inside ? inward(1 - w, "down") : 1) };
}
