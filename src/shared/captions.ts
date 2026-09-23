// Project captions: one setting for the whole video, with the words coming
// from each clip's transcript.
//
// Text overlays are placed one by one. Captions are not: they are switched on
// for the project, styled once, and worked out from the transcripts every time
// they are shown or exported. Nothing is stored per caption, so trimming,
// splitting or reordering a clip moves its captions with the speech. The
// preview and the export both build captions here, then draw them through the
// shared text layout, so the two agree.

import { captionChunks, type Cue } from "./transcript";
import { blockHeight, fitTop } from "./textLayout";

export interface CaptionStyle {
  /** Font size as a share of the frame's height, so it keeps its size across shapes. */
  size: number;
  position: "bottom" | "top";
  /** Distance from that edge, as a share of the frame's height. */
  margin: number;
  /** A dark box behind the text, for legibility on busy footage. */
  background: boolean;
  color: string;
  /** Longest caption, in characters, before it moves to the next one. */
  maxChars: number;
}

export interface ProjectCaptions {
  enabled: boolean;
  /** Language the transcripts are requested in. */
  lang: string;
  style: CaptionStyle;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: 0.055,
  position: "bottom",
  margin: 0.08,
  background: true,
  color: "#ffffff",
  maxChars: 32,
};

export const DEFAULT_CAPTIONS: ProjectCaptions = { enabled: false, lang: "en", style: DEFAULT_CAPTION_STYLE };

/** A main-track clip as it plays: where it starts on the video, and which part of its source. */
export interface PlacedClip {
  src: string;
  /** Seconds on the finished video. */
  start: number;
  /** Seconds it plays. */
  dur: number;
  /** Seconds into the source where it starts. */
  trimStart: number;
}

export interface CaptionLine {
  /** Seconds on the finished video. */
  from: number;
  to: number;
  text: string;
}

/** Every caption on the finished video: each clip's cues, cut to its window, moved to its place. */
export function captionTimeline(clips: PlacedClip[], cuesBySrc: Map<string, Cue[]>, maxChars: number): CaptionLine[] {
  const out: CaptionLine[] = [];
  for (const clip of clips) {
    const cues = cuesBySrc.get(clip.src);
    if (!cues || cues.length === 0 || clip.dur <= 0) continue;
    const window = { start: clip.trimStart, end: clip.trimStart + clip.dur };
    for (const chunk of captionChunks(cues, window, maxChars)) {
      out.push({ from: clip.start + chunk.from, to: clip.start + chunk.to, text: chunk.text });
    }
  }
  return out;
}

/** The on-screen text a caption line becomes, in the same shape as a text overlay. */
export interface CaptionText {
  id: string;
  type: "text";
  text: string;
  startTime: number;
  duration: number;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  background?: string;
  align: "center";
}

/** The box behind a caption, when the style asks for one. */
const CAPTION_BOX = "#000000a6";

export function captionText(line: CaptionLine, style: CaptionStyle, frame: { width: number; height: number }, id: string): CaptionText {
  const fontSize = Math.max(8, Math.round(style.size * frame.height));
  const height = blockHeight(line.text, fontSize, frame.width, "sans", style.background);
  // Bottom captions keep their bottom edge put and grow upwards as they wrap.
  const wanted = style.position === "top" ? style.margin : 1 - style.margin - height / frame.height;
  return {
    id,
    type: "text",
    text: line.text,
    startTime: Math.round(line.from * 1000) / 1000,
    duration: Math.max(0.05, Math.round((line.to - line.from) * 1000) / 1000),
    x: 0.5,
    y: fitTop(Math.max(0, wanted), height, frame.height),
    fontSize,
    color: style.color,
    ...(style.background ? { background: CAPTION_BOX } : {}),
    align: "center",
  };
}
