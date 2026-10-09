// Playback speed of a main-track video clip, as the edit service compiles it.
//
// A clip's trims and `duration` measure its source, at any speed: changing the
// speed plays the same footage faster or slower and never changes which
// footage is used. On the finished video the clip lasts (source seconds) /
// speed, so every conversion between the two clocks goes through here. Sound
// keeps its pitch, in the export (atempo) and in the preview (playbackRate).

/** The range the edit service accepts. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

/** The speeds the editor offers in one click. */
export const SPEED_CHOICES = [0.25, 0.5, 1, 1.5, 2, 4] as const;

/** A clip's speed; images and unset clips play at 1. */
export function speedOf(el: { type: string; speed?: number }): number {
  return el.type === "video" && el.speed ? el.speed : 1;
}

/** A speed as the clip's pill and the Ask replies show it: "2x", "0.25x". */
export function speedLabel(speed: number): string {
  return `${Math.round(speed * 100) / 100}x`;
}

/** Clamped to the service's range and rounded to a hundredth; 1 means none. */
export function cleanSpeed(speed: number): number | undefined {
  if (!Number.isFinite(speed)) return undefined;
  const s = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
  return s === 1 ? undefined : s;
}
