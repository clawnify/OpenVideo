// The media service's transcript (WebVTT, cue-timed) and on-screen caption
// chunks cut from it for one clip window. Pure.
//
// Vendored from clawnify/OpenClipper src/server/transcript.ts (MIT), which
// derives captions the same way: from the source's cues and the clip's
// current window, so captions follow every trim. Keep the two in step.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** "01:02:03.450" | "02:03.450" → seconds. */
function parseTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    const text = lines
      .slice(i + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Seconds → "00:01:02.450", the form WebVTT cue times take. */
function vttTime(t: number): string {
  const ms = Math.round(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/** Cues back to WebVTT, the form a transcript is kept in. */
export function toVtt(cues: Cue[]): string {
  return ["WEBVTT", ...cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`)].join("\n\n") + "\n";
}

/** A transcript to read or hand to someone: one line per cue, each with the time it is said. */
export function transcriptText(cues: Cue[]): string {
  return cues
    .map((c) => {
      const s = Math.floor(c.start);
      const h = Math.floor(s / 3600);
      const mm = Math.floor(s / 60) % 60;
      const ss = String(s % 60).padStart(2, "0");
      return `[${h ? `${h}:${String(mm).padStart(2, "0")}` : mm}:${ss}] ${c.text}`;
    })
    .join("\n");
}

export interface Window {
  start: number;
  end: number;
}

export interface CaptionChunk {
  /** Seconds relative to the clip start. */
  from: number;
  to: number;
  text: string;
}

/**
 * On-screen captions for a clip window: each cue's words regrouped into
 * chunks of at most `maxChars` (one line at caption size on a 1080-wide
 * frame), timed in proportion to their share of the cue's characters.
 */
export function captionChunks(cues: Cue[], w: Window, maxChars = 22): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  for (const cue of cues) {
    if (cue.end <= w.start || cue.start >= w.end) continue;
    const words = cue.text.split(" ").filter(Boolean);
    const groups: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > maxChars) {
        groups.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) groups.push(line);

    const total = groups.reduce((n, g) => n + g.length, 0) || 1;
    let t = cue.start;
    for (const g of groups) {
      const span = ((cue.end - cue.start) * g.length) / total;
      const from = Math.max(t, w.start) - w.start;
      const to = Math.min(t + span, w.end) - w.start;
      if (to - from >= 0.2) out.push({ from: round(from), to: round(to), text: g });
      t += span;
    }
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
