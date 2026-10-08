// Fades, as the edit service compiles them (on the element's own clock), so
// the preview's gain and opacity follow the export's envelope exactly: afade
// on sound, fade to black on a main-track clip, alpha on an overlay.

/** The longest fade the edit service accepts, in or out. */
export const MAX_FADE_SECONDS = 30;

/**
 * How long a clip on an audio or overlay track is heard or seen: its own
 * length, or up to the end of the cut when it runs past it. A fade-out ends
 * here, so a song longer than the video fades out with the video instead of
 * stopping dead.
 */
export function heardFor(startTime: number, duration: number, total: number): number {
  return Math.max(0, Math.min(duration, total - startTime));
}

/**
 * Gain (0..1) at `t` seconds into the clip. A fade longer than what is heard
 * is shortened to fit, and an in and an out that overlap multiply, as afade
 * does.
 */
export function fadeGain(fade: { fadeIn?: number; fadeOut?: number }, heard: number, t: number): number {
  const fin = Math.min(fade.fadeIn ?? 0, heard);
  const fout = Math.min(fade.fadeOut ?? 0, heard);
  const up = fin > 0 ? clamp01(t / fin) : 1;
  const down = fout > 0 ? clamp01((heard - t) / fout) : 1;
  return up * down;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
