// Splitting a main-track clip, shared by the editor's scissors and by Ask.
//
// Both halves reference the same source; nothing is re-rendered. A clip is
// stored one of two ways: as a play window (`duration`, which is what
// Auto-cut and Ask write) or as trims off both ends (`trimEnd`). A play window
// overrides trimEnd, which is how each copy of this code once went wrong: the
// scissors set trimEnd on a play-window clip and it kept playing its whole
// length; Ask left an untrimmed first half with no duration and it played to
// the end. The first half is therefore always a play window.

export interface SplittableClip {
  id: string;
  trimStart?: number;
  trimEnd?: number;
  duration?: number;
}

/**
 * Cut `clip` at `at` seconds into what it plays now. `playing` is that length
 * when known (the editor always knows it). Returns null when `at` is not
 * strictly inside the clip.
 */
export function splitClip<T extends SplittableClip>(
  clip: T,
  at: number,
  playing: number | undefined,
  newId: string,
): [T, T] | null {
  if (!(at > 0)) return null;
  if (playing !== undefined && at >= playing) return null;

  const start = clip.trimStart ?? 0;
  const first: T = { ...clip, duration: at };
  delete first.trimEnd;

  const second: T = { ...clip, id: newId, trimStart: start + at };
  if (playing !== undefined) {
    second.duration = playing - at;
    delete second.trimEnd;
  }
  // Otherwise the second half keeps the clip's own tail trim and plays on to it.
  return [first, second];
}
