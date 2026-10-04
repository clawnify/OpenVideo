// How the preview draws a text outline so it matches the export.
//
// The export's drawtext strokes each glyph with FreeType's round joins: the
// outline is the letters grown by `width` in every direction. A browser's
// `-webkit-text-stroke` uses miter joins instead, which put spikes on the
// sharp corners of w, v, M or A, and CSS cannot change that for HTML text.
// So the preview grows the letters itself: copies of the text in the stroke
// colour, shifted to points spread over a disc of the stroke's radius, under
// the text. Their union is the same round outline, to within a fraction of a
// pixel at the edge.

/** Largest distance between neighbouring copies, in screen pixels. Glyph
 *  stems are thicker than this at any readable size, so the copies overlap
 *  and leave no holes. */
const SPACING = 3;
/** Caps, so even the heaviest outline stays cheap to draw. Past them the
 *  inner copies spread out, which only outlines far heavier than the letters
 *  reach. The outer ring is the edge you see, so it gets more copies. */
const MAX_RINGS = 6;
const MAX_RING = 48;
const MAX_EDGE = 160;

/** Offsets [dx, dy] in screen pixels whose copies together draw an outline of radius `r`. */
export function outlineOffsets(r: number): [number, number][] {
  if (!(r > 0)) return [];
  const rings = Math.min(MAX_RINGS, Math.max(1, Math.ceil(r / SPACING)));
  const out: [number, number][] = [];
  for (let k = 1; k <= rings; k++) {
    const radius = (r * k) / rings;
    const n = Math.min(k === rings ? MAX_EDGE : MAX_RING, Math.max(8, Math.ceil((2 * Math.PI * radius) / SPACING)));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push([round2(radius * Math.cos(a)), round2(radius * Math.sin(a))]);
    }
  }
  return out;
}

/** The CSS `text-shadow` that draws an outline of radius `r` px in `color`. */
export function outlineShadow(r: number, color: string): string | undefined {
  const offsets = outlineOffsets(r);
  return offsets.length ? offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(",") : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The widest outline text of this size can have, in px at the video's
 * resolution. Past a fifth of the font size the outline overflows the
 * letters' insides and the export's stroker draws holes in it, so the edit
 * service refuses it.
 */
export function maxStrokeWidth(fontSize: number): number {
  return Math.max(1, Math.floor(fontSize / 5));
}

/**
 * The outline as the preview and the export draw it. A document keeps the
 * width the user set; if the text has since been made smaller, it is drawn
 * at the most that size allows, the way CSS clamps a value, instead of the
 * document turning invalid half-way through typing a new size.
 */
export function drawnStroke<S extends { width: number }>(stroke: S | undefined, fontSize: number): S | undefined {
  return stroke && { ...stroke, width: Math.min(stroke.width, maxStrokeWidth(fontSize)) };
}
