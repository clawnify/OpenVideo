// A clip's colour adjustment, in the edit service's own maths (its schema.ts
// `adjust`), so the preview's SVG filter draws what the export renders.
//
// On gamma-encoded RGB in 0..1, two steps, each clamped to 0..1:
//   1. y = k * g * S * x + (1 - k) / 2, where S is the saturation matrix with
//      BT.709 weights (0.2126 / 0.7152 / 0.0722) and s = 1 + saturation (0 is
//      greyscale), g = 2^brightness, k = 2^contrast (pivot: mid grey);
//   2. temperature t scales red by 1 + 0.2 t and blue by 1 - 0.2 t (warm
//      above 0).
// The service renders step 1 in YUV, where it is a line per plane, and goes
// to RGB only for step 2. Each field runs -1..1 and 0 leaves the picture
// alone; people see -100..100.

export interface Adjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
}

export const ADJUST_KEYS = ["brightness", "contrast", "saturation", "temperature"] as const;
export type AdjustKey = (typeof ADJUST_KEYS)[number];

/**
 * The adjustment as it should be stored: each field in -1..1 to two places,
 * zeros dropped, and nothing at all when every field is 0.
 */
export function cleanAdjust(a: Adjust | undefined): Adjust | undefined {
  if (!a) return undefined;
  const out: Adjust = {};
  for (const k of ADJUST_KEYS) {
    const v = a[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const r = Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100;
    if (r !== 0) out[k] = r;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The two steps as filter values: step 1 as a 3x3 matrix and one offset
 *  (null when it changes nothing), step 2 as red and blue gains (null
 *  without temperature). */
export function adjustSteps(a: Adjust): {
  matrix: number[][] | null;
  offset: number;
  warmth: [number, number] | null;
} {
  const s = 1 + (a.saturation ?? 0);
  const k = 2 ** (a.contrast ?? 0);
  const g = 2 ** (a.brightness ?? 0);
  const t = a.temperature ?? 0;
  const w = [0.2126, 0.7152, 0.0722];
  const matrix =
    s === 1 && k === 1 && g === 1
      ? null
      : [0, 1, 2].map((c) => w.map((wi, j) => k * g * (j === c ? wi + (1 - wi) * s : wi - wi * s)));
  return { matrix, offset: (1 - k) / 2, warmth: t === 0 ? null : [1 + 0.2 * t, 1 - 0.2 * t] };
}

/** One pixel (RGB 0..1) through the adjustment: the reference both the
 *  preview and the export are held to. */
export function adjustPixel(a: Adjust, rgb: [number, number, number]): [number, number, number] {
  const { matrix, offset, warmth } = adjustSteps(a);
  const c01 = (x: number) => Math.max(0, Math.min(1, x));
  const one = matrix ? matrix.map((row) => c01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + offset)) : rgb;
  return warmth ? [c01(one[0] * warmth[0]), one[1], c01(one[2] * warmth[1])] : ([...one] as [number, number, number]);
}

/** "contrast +30, saturation -20", or "" when nothing is adjusted. */
export function describeAdjust(a: Adjust | undefined): string {
  const c = cleanAdjust(a);
  if (!c) return "";
  return ADJUST_KEYS.filter((k) => c[k] !== undefined)
    .map((k) => {
      const v = Math.round(c[k]! * 100);
      return `${k} ${v > 0 ? "+" : ""}${v}`;
    })
    .join(", ");
}
