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
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
      else {
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
