// A clip's colour adjustment, in the edit service's own maths (its schema.ts
// `adjust`), so the preview's SVG filter draws what the export renders.
//
// On gamma-encoded RGB in 0..1, each step clamped to 0..1:
//   1. saturation: s = 1 + saturation (0 is greyscale), the CSS saturate()
//      matrix with weights 0.213 / 0.715 / 0.072;
//   2. per channel, x -> k * (gain_c * x - 0.5) + 0.5, where
//      gain_c = 2^brightness * white_c, k = 2^contrast, and white is
//      (1 + 0.2 t, 1, 1 - 0.2 t) for t = temperature (warm above 0).
// Each field runs -1..1 and 0 leaves the picture alone; people see -100..100.

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

/** The two filter steps: a 3x3 saturation matrix (null when s is 1) and a
 *  slope per channel with one intercept (null when every line is x -> x). */
export function adjustSteps(a: Adjust): {
  matrix: number[][] | null;
  slopes: [number, number, number];
  intercept: number;
  lines: boolean;
} {
  const s = 1 + (a.saturation ?? 0);
  const k = 2 ** (a.contrast ?? 0);
  const gain = 2 ** (a.brightness ?? 0);
  const t = a.temperature ?? 0;
  const w = [0.213, 0.715, 0.072];
  const matrix = s === 1 ? null : [0, 1, 2].map((c) => w.map((wi, j) => (j === c ? wi + (1 - wi) * s : wi - wi * s)));
  const slopes = [gain * (1 + 0.2 * t), gain, gain * (1 - 0.2 * t)].map((g) => k * g) as [number, number, number];
  const intercept = 0.5 * (1 - k);
  return { matrix, slopes, intercept, lines: slopes.some((m) => m !== 1) || intercept !== 0 };
}

/** One pixel (RGB 0..1) through the adjustment: the reference both the
 *  preview and the export are held to. */
export function adjustPixel(a: Adjust, rgb: [number, number, number]): [number, number, number] {
  const { matrix, slopes, intercept } = adjustSteps(a);
  const c01 = (x: number) => Math.max(0, Math.min(1, x));
  const sat = matrix ? matrix.map((row) => c01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) : rgb;
  return [0, 1, 2].map((c) => c01(slopes[c] * sat[c] + intercept)) as [number, number, number];
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
