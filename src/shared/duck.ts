// Ducking: music dips while someone on the main track speaks, and comes back
// up in the pauses.
//
// Not a compressor. A browser cannot reproduce one sample for sample, so what
// you heard while editing would not be what exports. Instead the dips are
// placed from the transcripts' timing and handed to the edit service as a
// volume envelope (keyframes, linear between them), which the preview
// evaluates with the same function. Like captions, nothing is stored but the
// setting: the dips are worked out again every time, so they follow every
// trim, split and reorder.

import type { PlacedClip } from "./captions";
import type { Cue } from "./transcript";

/** How far a ducked clip goes down, in dB, as offered in the editor. */
export const DUCK_CHOICES = [6, 12, 18] as const;
export const DEFAULT_DUCK_DB = 12;
export const MAX_DUCK_DB = 40;

/** Seconds the dip starts before speech, so the first word is already clear. */
export const DUCK_ATTACK = 0.15;
/** Seconds the music takes to come back up after speech. */
export const DUCK_RELEASE = 0.5;
/** A pause shorter than this keeps the music down, instead of pumping between phrases. */
export const DUCK_HOLD = 1;
/** The most keyframes the edit service takes on one clip. */
export const MAX_ENVELOPE_POINTS = 200;

export interface Span {
  /** Seconds on the finished video. */
  start: number;
  end: number;
}

export interface EnvelopePoint {
  /** Seconds on the clip's own clock: 0 is when it starts playing. */
  time: number;
  gain: number;
}

/**
 * Where speech is heard on the finished video: each clip's cues, cut to the
 * part of the source it plays, moved to its place on the cut, and merged
 * across pauses shorter than DUCK_HOLD. Pass only clips whose sound is heard.
 */
export function speechSpans(clips: PlacedClip[], cuesBySrc: Map<string, Cue[]>): Span[] {
  const raw: Span[] = [];
  for (const clip of clips) {
    const cues = cuesBySrc.get(clip.src);
    if (!cues || clip.dur <= 0) continue;
    const from = clip.trimStart;
    const to = clip.trimStart + clip.dur;
    for (const cue of cues) {
      const start = Math.max(cue.start, from);
      const end = Math.min(cue.end, to);
      if (end > start) raw.push({ start: clip.start + start - from, end: clip.start + end - from });
    }
  }
  return mergeGaps(raw, DUCK_HOLD);
}

function mergeGaps(spans: Span[], hold: number): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < hold) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** dB down → the gain the edit service is sent (it reads three decimals). */
export function duckLevel(db: number): number {
  return round3(10 ** (-Math.min(Math.max(db, 0), MAX_DUCK_DB) / 20));
}

/**
 * The envelope that ducks one audio clip by `db` under `spans`. The clip
 * starts at `startTime` on the cut and is heard for `heard` seconds
 * (shared/fade.ts heardFor). Empty when no speech falls inside it.
 */
export function duckEnvelope(spans: Span[], clip: { startTime: number; heard: number }, db: number): EnvelopePoint[] {
  const lo = clip.startTime;
  const hi = clip.startTime + clip.heard;
  let near = spans.filter((s) => s.end + DUCK_RELEASE > lo && s.start - DUCK_ATTACK < hi);
  // Four points a span, plus the two ends. Over the service's cap, the
  // shortest pauses stay down first: a long video with constant talk loses
  // its smallest lifts, never its dips.
  while (near.length * 4 + 2 > MAX_ENVELOPE_POINTS) near = mergeShortestGap(near);
  if (near.length === 0) return [];

  const level = duckLevel(db);
  const knots: EnvelopePoint[] = [];
  for (const s of near) {
    knots.push(
      { time: s.start - DUCK_ATTACK - lo, gain: 1 },
      { time: s.start - lo, gain: level },
      { time: s.end - lo, gain: level },
      { time: s.end + DUCK_RELEASE - lo, gain: 1 },
    );
  }
  const inside = knots.filter((k) => k.time > 0 && k.time < clip.heard);
  const points = [
    { time: 0, gain: envelopeGain(knots, 0) },
    ...inside,
    { time: clip.heard, gain: envelopeGain(knots, clip.heard) },
  ].map((p) => ({ time: round3(p.time), gain: round3(p.gain) }));
  return simplify(points);
}

function mergeShortestGap(spans: Span[]): Span[] {
  let at = 1;
  for (let i = 2; i < spans.length; i++) {
    if (spans[i].start - spans[i - 1].end < spans[at].start - spans[at - 1].end) at = i;
  }
  const out = spans.slice();
  out.splice(at - 1, 2, { start: spans[at - 1].start, end: spans[at].end });
  return out;
}

/** Drop points that collide at millisecond precision, and the ones a line already passes through. */
function simplify(points: EnvelopePoint[]): EnvelopePoint[] {
  const out: EnvelopePoint[] = [];
  for (const p of points) {
    if (out.length && p.time <= out[out.length - 1].time) continue;
    // The middle of a flat run adds nothing: replace it with this point.
    const n = out.length;
    if (n >= 2 && out[n - 2].gain === p.gain && out[n - 1].gain === p.gain) out[n - 1] = p;
    else out.push(p);
  }
  // The first and last values are held anyway, so flat ends need one point.
  while (out.length > 1 && out[0].gain === out[1].gain) out.shift();
  while (out.length > 1 && out[out.length - 1].gain === out[out.length - 2].gain) out.pop();
  return out.every((p) => p.gain === 1) ? [] : out;
}

/**
 * Gain at `t` seconds on the clip's clock: linear between points, held
 * before the first and after the last, 1 with no points. The edit service
 * renders the same function.
 */
export function envelopeGain(points: EnvelopePoint[], t: number): number {
  if (points.length === 0) return 1;
  if (t < points[0].time) return points[0].gain;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.time && t < b.time) return a.gain + ((t - a.time) * (b.gain - a.gain)) / (b.time - a.time);
  }
  return points[points.length - 1].gain;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
