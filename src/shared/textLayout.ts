// How on-screen text breaks into lines, shared by the preview and the export.
//
// The render service draws text with ffmpeg's drawtext, which never wraps: a
// caption longer than the frame ran off both edges. So the break happens here,
// once, and both sides draw the same lines. The export sends each line as its
// own centred element (multi-line drawtext would left-align the lines inside
// their block), and the preview draws each line the same way.

/** Rough average glyph width as a share of the font size, per family. */
const GLYPH_WIDTH = { sans: 0.52, serif: 0.5, mono: 0.6 } as const;

/** Share of the frame's width a line may use, leaving room for its box. */
const USABLE_WIDTH = 0.88;

export type FontFamily = keyof typeof GLYPH_WIDTH;

/** Break text into lines that fit the frame. Explicit line breaks are kept. */
export function wrapLines(text: string, fontSize: number, frameWidth: number, family: FontFamily = "sans"): string[] {
  const perLine = Math.max(8, Math.floor((frameWidth * USABLE_WIDTH) / (fontSize * GLYPH_WIDTH[family])));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    // As many lines as the width needs, then lines of even length: filling
    // each line to the edge left a two-word orphan at the bottom.
    const count = Math.max(1, Math.ceil(paragraph.trim().length / perLine));
    const target = Math.min(perLine, Math.ceil(paragraph.trim().length / count));
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= target || (line.length < target * 0.6 && line.length + 1 + word.length <= perLine)) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Distance between the tops of consecutive lines, in frame pixels. */
export function lineStep(fontSize: number, boxed: boolean): number {
  // A boxed line carries its padding above and below; boxes must not overlap.
  return fontSize * (boxed ? 1.7 : 1.25);
}

/** Height of a text block in frame pixels, from the top of its first line. */
export function blockHeight(
  text: string,
  fontSize: number,
  frameWidth: number,
  family: FontFamily = "sans",
  boxed = false,
): number {
  const lines = wrapLines(text, fontSize, frameWidth, family).length;
  return (lines - 1) * lineStep(fontSize, boxed) + fontSize * (boxed ? 1.6 : 1.2);
}

/** Space kept clear at the frame's bottom edge, as a share of its height. */
const BOTTOM_MARGIN = 0.03;

/**
 * Where a text block's first line goes so the whole block stays in frame. A
 * caption placed low grows upwards as it wraps instead of running off the
 * bottom. `y` and the result are shares of the frame's height.
 */
export function fitTop(y: number, height: number, frameHeight: number): number {
  const h = height / frameHeight;
  return Math.max(0, Math.min(y, 1 - BOTTOM_MARGIN - h));
}
