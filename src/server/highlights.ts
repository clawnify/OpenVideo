// Highlights: the selects an editor looks at first. For every logged clip of
// a project's footage, whether it is worth an editor's time and, if it is,
// the parts to cut from: soundbites (speech that stands on its own) and
// b-roll (picture worth cutting to), each with a score and the reason.
//
// They are read from what the project already has, not by watching again:
// each clip's log (made by the platform's video analysis, which watched and
// listened to it) and its transcript. A text model judges them against the
// project's brief, a few neighbouring clips of a folder at a time, so it can
// compare similar shots and keep the better one. Watching every clip a second
// time would cost the org a video unit and credits per clip for little more.
//
// A person reviews them (keep / drop); the kept ones go to an editor's own
// software (see nle.ts) or to this app's AI editor. Finding again only adds:
// what a person kept or dropped is passed as taken, and is never replaced.
//
// The prompt, the answer and the call are pure and unit-tested; the step at
// the end moves a project's clips through it in the background, like the log.

import { parseVtt, type Cue } from "../shared/transcript";
import { query, get, run } from "./db";
import { parseClock, type ClipLog } from "./footage";
import { mediaFacts, mediaTranscript, type MediaConfig } from "./media";

const MODEL = "google/gemini-3.7-flash";

export const HIGHLIGHTS_NO_KEY = "finding highlights needs an OpenRouter key: add one in the dashboard's API Keys settings";

export type HighlightKind = "soundbite" | "broll";

export interface Highlight {
  kind: HighlightKind;
  /** Seconds into the clip. */
  start: number;
  end: number;
  /** A soundbite's words, verbatim; what a b-roll shot shows. */
  text: string;
  speaker: string;
  /** 1 (weak) to 5 (could open the video), against the brief. */
  score: number;
  reason: string;
}

/** One clip as the model reads it. */
export interface HighlightClip {
  id: string;
  name: string;
  folder: string;
  duration: number;
  log: ClipLog;
  /** WebVTT, or null when there is none (no speech, or not made). */
  transcript: string | null;
  /** Stretches a person already kept or dropped: never picked again. */
  taken?: Reviewed[];
}

/** A stretch of a clip a person already kept or dropped. */
export interface Reviewed {
  start: number;
  end: number;
  text: string;
  pick: "keep" | "drop";
}

/**
 * What a person has kept and dropped across the project, latest first: the
 * taste a reading learns from, beside the brief.
 */
export interface Taste {
  kept: TasteExample[];
  dropped: TasteExample[];
}

export interface TasteExample {
  kind: HighlightKind;
  text: string;
  speaker: string;
  /** The score it had when it was proposed. */
  score: number;
  /** A pick the person added themselves. */
  own: boolean;
}

/** How many of each a prompt carries: enough to show a taste, bounded however long the review. */
export const TASTE_EXAMPLES = 15;

/** A reviewed pick as the database holds it. */
export interface ReviewedPick {
  pick: "keep" | "drop";
  kind: HighlightKind;
  text: string;
  speaker: string;
  score: number;
  origin: string;
}

/** The words of a pick, without case or punctuation: what two takes of one line share. */
function sameWords(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The taste a reading learns from, `reviewed` latest first. A dropped pick
 * that says what a kept one says is left out: it is another camera's take of
 * a line the person kept, not a line they didn't want.
 */
export function tasteFrom(reviewed: ReviewedPick[]): Taste {
  const example = (r: ReviewedPick): TasteExample => ({ kind: r.kind, text: r.text, speaker: r.speaker, score: r.score, own: r.origin === "person" });
  const kept = reviewed.filter((r) => r.pick === "keep");
  const keptWords = new Set(kept.map((r) => sameWords(r.text)).filter(Boolean));
  return {
    kept: kept.slice(0, TASTE_EXAMPLES).map(example),
    dropped: reviewed
      .filter((r) => r.pick === "drop" && !keptWords.has(sameWords(r.text)))
      .slice(0, TASTE_EXAMPLES)
      .map(example),
  };
}

export interface ClipVerdict {
  id: string;
  /** Null when the clip is worth using; why not, otherwise. */
  skip: string | null;
  highlights: Highlight[];
}

/** How many clips one model call reads, and roughly how much text. */
export const BATCH = { clips: 12, chars: 40_000 };
/** A soundbite or shot shorter than this is a fragment, not a pick. */
const MIN_SECONDS = { soundbite: 1.5, broll: 1 };
const MAX_PER_CLIP = 25;

const TIME = { type: "string", description: "position in this clip, M:SS with tenths, e.g. 0:42.5 (H:MM:SS.s past an hour)" };

export const HIGHLIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clip", "use", "skip_reason", "highlights"],
        properties: {
          clip: { type: "integer", description: "the clip's number in the list" },
          use: { type: "boolean", description: "false when nothing in the clip is worth an editor's time" },
          skip_reason: { type: "string", description: "when use is false: why, in a few words. Empty otherwise" },
          highlights: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "start", "end", "text", "speaker", "score", "reason"],
              properties: {
                kind: { type: "string", enum: ["soundbite", "broll"] },
                start: TIME,
                end: TIME,
                text: {
                  type: "string",
                  description: "soundbite: the words, verbatim from the transcript. broll: what it shows, in a few words",
                },
                speaker: {
                  type: "string",
                  description: "soundbite: who says it, as the log describes them; a name only when the clip says or shows it. Empty for broll",
                },
                score: { type: "integer", minimum: 1, maximum: 5 },
                reason: { type: "string", description: "one short sentence: why an editor would use it" },
              },
            },
          },
        },
      },
    },
  },
};

/** Seconds → "M:SS.s" (or "H:MM:SS.s"), as the model reads and writes times. */
export function stamp(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10) / 10);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function clipBlock(n: number, c: HighlightClip): string {
  const log = c.log;
  const lines = [
    `CLIP ${n}: "${c.name.slice(0, 200)}"${c.folder ? ` in "${c.folder.slice(0, 200)}"` : ""}, ${c.duration.toFixed(1)} s`,
    `Log: ${log.kind}, ${log.quality}. ${log.summary}`,
  ];
  if (log.issues) lines.push(`Issues: ${log.issues}`);
  if (log.moments.length) {
    lines.push(`Shots: ${log.moments.map((m) => `[${stamp(m.start)}-${stamp(m.end)}] ${m.description}`).join("; ")}`);
  }
  if (log.visible_text.length) lines.push(`On screen: ${log.visible_text.join(", ")}`);
  const cues = c.transcript ? parseVtt(c.transcript) : [];
  if (cues.length) {
    // The logger's picks are a hint, not the list: a long talk holds more.
    if (log.quotes.length) {
      lines.push(`Logger's picks: ${log.quotes.map((q) => `[${stamp(q.start)}] ${q.speaker ? `${q.speaker}: ` : ""}"${q.text}"`).join(" ")}`);
    }
    lines.push("Transcript:");
    for (const cue of cues) lines.push(`[${stamp(cue.start)}-${stamp(cue.end)}] ${cue.text}`);
  } else if (log.quotes.length) {
    // No transcript: the log's quotes are all there is of the speech.
    lines.push(`Said (no transcript): ${log.quotes.map((q) => `[${stamp(q.start)}-${stamp(q.end)}] ${q.speaker ? `${q.speaker}: ` : ""}"${q.text}"`).join(" ")}`);
  } else {
    lines.push("No speech.");
  }
  if (c.taken?.length) {
    lines.push(
      `Already reviewed by a person, don't pick again or overlap: ${c.taken.map((t) => `[${stamp(t.start)}-${stamp(t.end)}] ${t.pick === "keep" ? "kept" : "dropped"}: ${t.text.slice(0, 80)}`).join("; ")}`,
    );
  }
  return lines.join("\n");
}

/** Characters a clip adds to a prompt, for batching. */
export function clipSize(c: HighlightClip): number {
  return (c.transcript?.length ?? 0) + JSON.stringify(c.log).length + 200;
}

/**
 * Clips in folder order → batches for one call each: neighbours from the same
 * folder together, so similar shots are judged side by side, and a long
 * interview on its own.
 */
export function batchClips<T extends HighlightClip>(clips: T[], limits = BATCH): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const c of clips) {
    const s = clipSize(c);
    const full = cur.length >= limits.clips || (cur.length > 0 && size + s > limits.chars);
    if (cur.length && (full || cur[0].folder !== c.folder)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

function tasteBlock(taste: Taste | undefined): string {
  if (!taste || (!taste.kept.length && !taste.dropped.length)) return "";
  const line = (e: TasteExample) =>
    `- ${e.kind === "soundbite" ? "soundbite" : "b-roll"}${e.speaker ? `, ${e.speaker.slice(0, 60)}` : ""}: "${e.text.slice(0, 160)}" (${e.own ? "added by them" : `scored ${e.score} when proposed`})`;
  const parts = [
    "The person reviewing these picks has already kept and dropped some in this project, latest first. Learn their taste from it: score picks like the kept ones higher, and leave out or mark down picks like the ones they drop. Where this and the brief above disagree, the brief wins.",
  ];
  if (taste.kept.length) parts.push(`Kept:\n${taste.kept.map(line).join("\n")}`);
  if (taste.dropped.length) parts.push(`Dropped:\n${taste.dropped.map(line).join("\n")}`);
  return `\n\n${parts.join("\n")}`;
}

export function highlightsPrompt(brief: string, clips: HighlightClip[], taste?: Taste): string {
  const goal = brief.trim() ? brief.trim().slice(0, 2000) : "a short highlight video of this shoot";
  return `You are the assistant editor making selects for: ${goal}

Below are clips from the shoot. Each was logged by someone who watched and listened to it, and most have a transcript. For every clip, decide whether it is worth an editor's time, and pick the parts to cut from. An editor will review your list, drop what they don't want and cut from the rest: be generous with good material and strict with bad.

Skip a clip (use false, and say why in a few words) when nothing in it is worth an editor's time: a camera pointed at the floor or ceiling, shaking or hunting for focus the whole way, a test shot, an accidental recording, a few seconds where nothing happens. Flat or log colour is how cameras record for grading, and room sound under b-roll is normal: neither is a reason to skip or to mark down.

Two kinds of pick:
- soundbite: speech that works on its own. A complete thought from its first word to its last: start on the point, never on "so", "um", "yeah", a greeting or the question, and end on a finished sentence. Use the transcript lines' times so no word is cut. Usually 3 to 25 seconds. An interviewer's question is not a soundbite. An interview usually holds several: pick every strong one.
- broll: a stretch worth cutting to without its sound: something happening, people, the place, the brand on show, a detail. Steady and in focus. Usually 2 to 10 seconds. Leave out camera moves to nowhere, bumps and focus hunts.

Score each pick 1 to 5 against the goal above: 5 could open the video, 4 strong, 3 solid and usable, 2 filler, 1 only if nothing else. Use the whole range; most picks are 3. The reason says in one short sentence what an editor gains: what is said or shown, and why it works (clear sound, energy, emotion, the brand in shot).

A soundbite's speaker is who says it as the log describes them ("man in a red shirt"). Name a person only when the log, the transcript or the screen names them; never guess a name from what someone talks about or who they seem to be.

Picks in a clip never overlap, and the same moment is never picked twice. When two clips show the same moment (two cameras, or a retake), pick from the better one and say so in the other's reason or skip reason.

How many: as many as are worth an editor's look. A 5-second shot has none or one. A long interview or talk: read it all, start to finish, and pick every strong soundbite, roughly one for every two or three minutes of talk and more where it is strong; a 45-minute interview usually gives fifteen or more. The logger's picks are a hint: include the strong ones, and find the others they missed.${tasteBlock(taste)}

${clips.map((c, i) => clipBlock(i + 1, c)).join("\n\n")}`;
}

/**
 * Snap a soundbite to whole transcript lines, so it starts on its first word
 * and ends after its last, with a breath either side.
 */
export function snapToCues(start: number, end: number, cues: Cue[], duration: number): { start: number; end: number } {
  const inside = cues.filter((c) => c.end > start + 0.05 && c.start < end - 0.05);
  if (!inside.length) return { start, end };
  const s = Math.max(0, inside[0].start - 0.15);
  const e = Math.min(duration, inside[inside.length - 1].end + 0.25);
  return e > s ? { start: round1(s), end: round1(e) } : { start, end };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Who says a soundbite. A model that cannot see will put a famous name on a
 * stranger from what they talk about, so a name stands only when the clip
 * itself bears it out (said in the transcript, shown on screen, or in the
 * log); a guess gives way to the logger's description of whoever says those
 * words, since the logger watched the clip. A description without a name
 * gives way to the logger's too, for the same reason. Names match as whole
 * words: "Ho" is not borne out by "who".
 */
export function vetSpeaker(said: string, start: number, end: number, clip: HighlightClip): string {
  const logged =
    clip.log.quotes.find((q) => q.speaker && q.start < end && start < q.end)?.speaker ??
    clip.log.quotes.find((q) => q.speaker)?.speaker ??
    "";
  const material = [clip.log.summary, ...clip.log.visible_text, ...clip.log.quotes.map((q) => q.speaker), clip.transcript ?? ""].join(" ");
  const words = said.match(/\p{Lu}[\p{L}'.-]*/gu) ?? [];
  const bornOut = (w: string) => new RegExp(`(?<!\\p{L})${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\p{L})`, "iu").test(material);
  if (!words.every(bornOut)) return logged;
  // A name is a capitalised word anywhere but the start of a description
  // ("Ada Lovelace", "man with a NightForce badge"), or one standing alone.
  const parts = said.trim().split(/\s+/);
  const named = parts.length === 1 ? words.length === 1 : words.some((w) => w !== parts[0]);
  return named ? said : logged || said;
}

/** The model's answer → a verdict per clip. Clips it left out get none. */
export function readHighlights(raw: unknown, clips: HighlightClip[]): ClipVerdict[] {
  const answer = (raw ?? {}) as { clips?: unknown };
  const out: ClipVerdict[] = [];
  const seen = new Set<number>();
  for (const v of Array.isArray(answer.clips) ? answer.clips : []) {
    const r = (v ?? {}) as Record<string, unknown>;
    const n = Number(r.clip);
    if (!Number.isInteger(n) || n < 1 || n > clips.length || seen.has(n)) continue;
    seen.add(n);
    const clip = clips[n - 1];
    const cues = clip.transcript ? parseVtt(clip.transcript) : [];
    const picks: Highlight[] = [];
    for (const h of Array.isArray(r.highlights) ? (r.highlights as Record<string, unknown>[]) : []) {
      const kind: HighlightKind | null = h?.kind === "soundbite" || h?.kind === "broll" ? h.kind : null;
      let start = parseClock(String(h?.start ?? ""));
      let end = parseClock(String(h?.end ?? ""));
      const text = str(h?.text, 1000);
      if (!kind || !text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      start = Math.max(0, Math.min(start, clip.duration));
      end = Math.min(end, clip.duration);
      if (kind === "soundbite") ({ start, end } = snapToCues(start, end, cues, clip.duration));
      if (end - start < MIN_SECONDS[kind]) continue;
      if (picks.some((p) => p.start < end - 0.3 && start < p.end - 0.3)) continue;
      if (clip.taken?.some((t) => t.start < end - 0.3 && start < t.end - 0.3)) continue;
      const score = Math.min(5, Math.max(1, Math.round(Number(h?.score) || 3)));
      picks.push({
        kind,
        start: round1(start),
        end: round1(end),
        text,
        speaker: kind === "soundbite" ? vetSpeaker(str(h?.speaker, 120), start, end, clip) : "",
        score,
        reason: str(h?.reason, 300),
      });
    }
    picks.sort((a, b) => a.start - b.start);
    const use = r.use !== false && picks.length > 0;
    out.push({
      id: clip.id,
      skip: use ? null : str(r.skip_reason, 300) || (r.use === false ? "not worth using" : "nothing worth picking"),
      highlights: use ? picks.slice(0, MAX_PER_CLIP) : [],
    });
  }
  return out;
}

export interface HighlightsFailure {
  error: string;
  detail: string;
  /** Worth asking again later: the model was busy or unreachable. */
  retry: boolean;
}

/** One structured call to the model: its answer as JSON, or why there is none. */
async function askModel(
  key: string | undefined,
  prompt: string,
  schema: { name: string; schema: object; maxTokens: number },
): Promise<{ parsed: unknown } | { failure: HighlightsFailure }> {
  if (!key) {
    return {
      failure: {
        error: "highlights_unavailable",
        detail: HIGHLIGHTS_NO_KEY,
        retry: false,
      },
    };
  }
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: schema.maxTokens,
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } },
      }),
    });
  } catch (err) {
    return { failure: { error: "highlights_failed", detail: `the model could not be reached: ${String(err)}`, retry: true } };
  }
  if (!res.ok) {
    const detail = `model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
    return { failure: { error: "highlights_failed", detail, retry: res.status === 429 || res.status >= 500 } };
  }
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  try {
    return { parsed: JSON.parse(body?.choices?.[0]?.message?.content ?? "") };
  } catch {
    return { parsed: null };
  }
}

/** One model call over one batch of clips. */
export async function findHighlights(
  key: string | undefined,
  brief: string,
  clips: HighlightClip[],
  taste?: Taste,
): Promise<{ verdicts: ClipVerdict[] } | { failure: HighlightsFailure }> {
  const answer = await askModel(key, highlightsPrompt(brief, clips, taste), { name: "highlights", schema: HIGHLIGHTS_SCHEMA, maxTokens: 24_000 });
  if ("failure" in answer) return answer;
  const verdicts = readHighlights(answer.parsed, clips);
  if (!verdicts.length) {
    return { failure: { error: "highlights_failed", detail: "the model's answer could not be read", retry: true } };
  }
  return { verdicts };
}

// ── the best of them ────────────────────────────────────────────────────────
// A project can ask for a number of highlights. Each reading sees a dozen
// clips, so a count written in the brief can't hold for the whole project
// (each call took it for its own batch). Instead, once every clip is read,
// one more call reads all the picks found and puts them in order for the
// brief: the best set of that many first, then stand-ins. Every pick not
// dropped gets a place, so changing what is kept or dropped never needs the
// model again: the best are the kept ones, then the first in that order.

/** The most highlights a project can ask for. */
export const MAX_WANTED = 200;
/** Roughly how much of the picks one ordering reads: past it, the lowest scored wait at the end. */
export const RANK_CHARS = 300_000;

/** A pick as the ordering reads it. */
export interface RankCandidate {
  id: string;
  kind: HighlightKind;
  start: number;
  end: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  /** A person kept it: it counts toward the number first. */
  kept: boolean;
  /** Its clip's file name and folder. */
  name: string;
  folder: string;
}

export const RANKING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["best", "reserve"],
  properties: {
    best: { type: "array", items: { type: "integer" }, description: "the chosen picks' numbers, best first" },
    reserve: { type: "array", items: { type: "integer" }, description: "stand-ins' numbers, best first" },
  },
};

const byClip = (a: RankCandidate, b: RankCandidate) =>
  a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name) || a.start - b.start || a.id.localeCompare(b.id);
const byScore = (a: RankCandidate, b: RankCandidate) => b.score - a.score || byClip(a, b);

function pickLine(n: number, p: RankCandidate): string {
  const where = `"${p.name.slice(0, 200)}"${p.folder ? ` in "${p.folder.slice(0, 200)}"` : ""} at ${stamp(p.start)}, ${(p.end - p.start).toFixed(1)} s`;
  const what = p.kind === "soundbite" ? `${p.speaker ? `${p.speaker.slice(0, 80)}: ` : ""}"${p.text.slice(0, 240)}"` : p.text.slice(0, 160);
  return `PICK ${n}: ${p.kind === "soundbite" ? "soundbite" : "b-roll"}, ${p.score}/5${p.kept ? ", KEPT" : ""}, ${where}. ${what}${p.reason ? ` Why: ${p.reason.slice(0, 160)}` : ""}`;
}

/**
 * The picks one ordering reads: the kept ones, then the best scored, up to
 * about `chars` of prompt; listed clip by clip, so the model reads the shoot
 * in order rather than the scores it is meant to look past.
 */
export function rankingPool(candidates: RankCandidate[], chars = RANK_CHARS): RankCandidate[] {
  const ranked = [...candidates].sort((a, b) => Number(b.kept) - Number(a.kept) || byScore(a, b));
  const pool: RankCandidate[] = [];
  let size = 0;
  for (const p of ranked) {
    const s = pickLine(0, p).length + 1;
    if (pool.length && size + s > chars) break;
    pool.push(p);
    size += s;
  }
  return pool.sort(byClip);
}

export function rankingPrompt(brief: string, pool: RankCandidate[], total: number, wanted: number, taste?: Taste): string {
  const goal = brief.trim() ? brief.trim().slice(0, 2000) : "a short highlight video of this shoot";
  const kept = pool.filter((p) => p.kept).length;
  const reserve = Math.min(wanted, Math.max(0, pool.length - wanted));
  const keptRule = !kept
    ? ""
    : kept < wanted
      ? `\n\nThe ${kept} picks marked KEPT were kept by the person reviewing: they are in \`best\`. Choose the other ${wanted - kept} to go with them.`
      : `\n\nThe person reviewing kept ${kept} picks (marked KEPT), ${kept === wanted ? "as many as" : "more than"} the ${wanted} wanted: \`best\` is the best ${wanted} of the kept picks.`;
  return `You are the assistant editor narrowing the selects for: ${goal}

Every clip of the shoot has been read, and these picks were found in it${pool.length < total ? ` (the ${pool.length} best scored of ${total})` : ""}, each with the score it got on its own (1 to 5) and why. Choose the ${wanted} that make the best set for this video, as \`best\`, best first.

A good set:
- does what the goal above asks, first: the mix of soundbites and b-roll it wants, or, when it doesn't say, enough of each to cut a video from. When it centres on one person, talk or clip, most of the set can come from that one clip: nothing has to come from every clip or camera;
- never has the same moment twice: one line said twice (a retake, or two cameras on one answer) or one moment filmed by two cameras. Keep the better one;
- otherwise varies, as far as the goal allows: different moments, people, places, angles and shot sizes, not several shots of the same thing;
- puts what works together ahead of what scored well alone.${keptRule}

Then list up to ${reserve} more as \`reserve\`, best first: they stand in, in that order, when the person drops one from \`best\`.${tasteBlock(taste)}

${pool.map((p, i) => pickLine(i + 1, p)).join("\n")}`;
}

/**
 * The model's answer → every candidate's id, in order: what it chose, then
 * its stand-ins, then the rest by score. A soundbite saying what one placed
 * before it says (a retake, another camera) waits with the rest.
 */
export function readRanking(raw: unknown, pool: RankCandidate[], candidates: RankCandidate[]): string[] {
  const answer = (raw ?? {}) as { best?: unknown; reserve?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const placed: RankCandidate[] = [];
  const seen = new Set<number>();
  const said = new Set<string>();
  for (const v of [...list(answer.best), ...list(answer.reserve)]) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > pool.length || seen.has(n)) continue;
    seen.add(n);
    const p = pool[n - 1];
    const words = p.kind === "soundbite" ? sameWords(p.text) : "";
    if (words && said.has(words)) continue;
    if (words) said.add(words);
    placed.push(p);
  }
  const ids = new Set(placed.map((p) => p.id));
  return [...placed, ...candidates.filter((p) => !ids.has(p.id)).sort(byScore)].map((p) => p.id);
}

/** One model call: every candidate in order, the best `wanted` first. */
export async function rankHighlights(
  key: string | undefined,
  brief: string,
  candidates: RankCandidate[],
  wanted: number,
  taste?: Taste,
): Promise<{ order: string[] } | { failure: HighlightsFailure }> {
  const pool = rankingPool(candidates);
  const answer = await askModel(key, rankingPrompt(brief, pool, candidates.length, wanted, taste), {
    name: "best_highlights",
    schema: RANKING_SCHEMA,
    maxTokens: 8_000,
  });
  if ("failure" in answer) return answer;
  const best = (answer.parsed as { best?: unknown } | null)?.best;
  if (!Array.isArray(best) || !best.length) {
    return { failure: { error: "highlights_failed", detail: "the model's answer could not be read", retry: true } };
  }
  return { order: readRanking(answer.parsed, pool, candidates) };
}

// ── the step ────────────────────────────────────────────────────────────────
// Clips move NULL → waiting → running → done | failed. A step runs only from
// the platform queue's delivery, never on a read: a model call takes up to
// half a minute, and a read must answer at once.

/** Model calls at once per step, per project. */
export const HIGHLIGHT_CALLS = 4;

export interface HighlightsOutcome {
  /** Clips waiting to be read, or being read. */
  pending: number;
  moving: boolean;
  /** Why nothing is being read, when nothing can be. */
  blocked: string | null;
}

interface WaitingRow {
  id: string;
  name: string;
  folder: string;
  language: string;
  log: string;
  asset_id: string;
  duration: number | null;
  media_uid: string | null;
  transcript: string | null;
  transcript_lang: string | null;
  fps: number | null;
}


export async function highlightsPending(projectId: string): Promise<number> {
  const n = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM project_footage WHERE project_id = ? AND status = 'ready' AND highlights_status IN ('waiting', 'running')",
    [projectId],
  );
  return n?.n ?? 0;
}

// The ordering, on the project: NULL (no number asked for) → waiting →
// running → done | failed. Waiting again whenever new picks land, the number
// changes or highlights are asked for again; it runs once nothing is left to
// read, on a delivery like the reading.

/**
 * Whether a project's picks wait to be put in order now (a claim left by a
 * step that died counts). While footage is still coming in, new picks land a
 * few at a time for hours: then the order is made again at most every
 * `RANK_EVERY`, and once more when the last clip is read. A number a person
 * sets clears `highlights_rank_at`, so it never waits.
 */
export async function rankingDue(projectId: string): Promise<boolean> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM edit_projects p
      WHERE p.id = ? AND p.highlights_at IS NOT NULL AND p.highlights_wanted IS NOT NULL
        AND ((p.highlights_rank_status = 'waiting'
              AND (p.highlights_rank_at IS NULL OR p.highlights_rank_at < datetime('now', ?)
                   OR NOT EXISTS (SELECT 1 FROM project_footage f WHERE f.project_id = p.id
                        AND (f.status IN ('waiting', 'importing')
                             OR (f.status = 'ready' AND (f.log_status IS NULL OR f.log_status IN ('preparing', 'running')))))))
             OR (p.highlights_rank_status = 'running' AND p.highlights_rank_at < datetime('now', '-5 minutes')))`,
    [projectId, `-${RANK_EVERY_MINUTES} minutes`],
  );
  return (row?.n ?? 0) > 0;
}

/** How often, at most, the order is made again while footage is still coming in. */
export const RANK_EVERY_MINUTES = 15;

/** Each candidate's place, 1 the best: a JSON list a statement, whatever the project's size. */
async function saveOrder(projectId: string, ids: string[]): Promise<void> {
  // A dropped pick holds no place: undropped later, it waits behind the rest.
  await run("UPDATE footage_highlights SET rank = NULL WHERE project_id = ? AND pick = 'drop' AND rank IS NOT NULL", [projectId]);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = JSON.stringify(ids.slice(i, i + 500));
    await run(
      `UPDATE footage_highlights SET rank = ? + (SELECT key FROM json_each(?) WHERE value = footage_highlights.id)
        WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))`,
      [i + 1, chunk, projectId, chunk],
    );
  }
}

interface RankRow {
  id: string;
  kind: HighlightKind;
  src_in: number;
  src_out: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  pick: string | null;
  name: string;
  folder: string;
}

/** Put a project's picks in order, if they wait for it. */
export async function stepRanking(key: string | undefined, projectId: string): Promise<{ moving: boolean; blocked: string | null }> {
  if (!(await rankingDue(projectId))) return { moving: false, blocked: null };
  if (!key) return { moving: false, blocked: HIGHLIGHTS_NO_KEY };
  const claimed = await run(
    `UPDATE edit_projects SET highlights_rank_status = 'running', highlights_rank_at = datetime('now')
      WHERE id = ? AND (highlights_rank_status = 'waiting' OR (highlights_rank_status = 'running' AND highlights_rank_at < datetime('now', '-5 minutes')))`,
    [projectId],
  );
  if (!claimed.changes) return { moving: false, blocked: null };
  const project = await get<{ brief: string; highlights_wanted: number | null }>("SELECT brief, highlights_wanted FROM edit_projects WHERE id = ?", [
    projectId,
  ]);
  const rows = await query<RankRow>(
    `SELECT h.id, h.kind, h.src_in, h.src_out, h.text, h.speaker, h.score, h.reason, h.pick, f.name, f.folder
       FROM footage_highlights h JOIN project_footage f ON f.id = h.footage_id
      WHERE h.project_id = ? AND f.status != 'removed' AND (h.pick IS NULL OR h.pick = 'keep')`,
    [projectId],
  );
  const candidates: RankCandidate[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    start: r.src_in,
    end: r.src_out,
    text: r.text,
    speaker: r.speaker,
    score: r.score,
    reason: r.reason,
    kept: r.pick === "keep",
    name: r.name,
    folder: r.folder,
  }));
  const wanted = project?.highlights_wanted ?? 0;
  let order: string[];
  if (candidates.length <= wanted) {
    // Every one of them is in: there is nothing to choose.
    order = [...candidates].sort((a, b) => Number(b.kept) - Number(a.kept) || byScore(a, b)).map((p) => p.id);
  } else {
    const reviewed = await query<ReviewedPick>(
      `SELECT text, pick, kind, speaker, score, origin FROM footage_highlights
        WHERE project_id = ? AND pick IS NOT NULL ORDER BY updated_at DESC, id`,
      [projectId],
    );
    const ranked = await rankHighlights(key, project?.brief ?? "", candidates, wanted, tasteFrom(reviewed));
    if ("failure" in ranked) {
      // Busy or unreachable: again on a later step. Anything else would fail
      // the same way again, so it says why and waits for a person.
      const { retry, detail } = ranked.failure;
      await run(
        "UPDATE edit_projects SET highlights_rank_status = ?, highlights_rank_error = ? WHERE id = ? AND highlights_rank_status = 'running'",
        [retry ? "waiting" : "failed", retry ? null : detail, projectId],
      );
      return { moving: retry, blocked: retry ? null : detail };
    }
    order = ranked.order;
  }
  await saveOrder(projectId, order);
  // New picks, a new number or a new ask while this ran leave it waiting.
  const done = await run(
    "UPDATE edit_projects SET highlights_rank_status = 'done', highlights_rank_error = NULL WHERE id = ? AND highlights_rank_status = 'running'",
    [projectId],
  );
  return { moving: done.changes === 0 && (await rankingDue(projectId)), blocked: null };
}

async function setClip(id: string, fields: Record<string, unknown>, where = ""): Promise<boolean> {
  const keys = Object.keys(fields);
  const res = await run(
    `UPDATE project_footage SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?${where}`,
    [...keys.map((k) => fields[k]), id],
  );
  return res.changes > 0;
}

/** Replace a clip's unreviewed picks with a new verdict's. */
export async function saveVerdict(projectId: string, v: ClipVerdict): Promise<void> {
  await run("DELETE FROM footage_highlights WHERE footage_id = ? AND pick IS NULL", [v.id]);
  // Ten values a row, under D1's hundred bound parameters a statement.
  for (let i = 0; i < v.highlights.length; i += 8) {
    const chunk = v.highlights.slice(i, i + 8);
    await run(
      `INSERT INTO footage_highlights (project_id, footage_id, kind, src_in, src_out, text, speaker, score, reason, origin)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')").join(", ")}`,
      chunk.flatMap((h) => [projectId, v.id, h.kind, h.start, h.end, h.text, h.speaker, h.score, h.reason]),
    );
  }
  await setClip(v.id, { highlights_status: "done", highlights_error: null, skip_reason: v.skip });
}

/**
 * Read the next few batches of a project's waiting clips. Clips logged since
 * the project asked for highlights join first, and a claim left by a step
 * that died goes back in line. With nothing left to read, the picks are put
 * in order if the project asked for a number of them.
 */
export async function stepHighlights(cfg: MediaConfig, key: string | undefined, projectId: string): Promise<HighlightsOutcome> {
  const project = await get<{ brief: string; highlights_at: string | null; highlights_stopped_at: string | null }>(
    "SELECT brief, highlights_at, highlights_stopped_at FROM edit_projects WHERE id = ?",
    [projectId],
  );
  if (!project?.highlights_at) return { pending: 0, moving: false, blocked: null };
  // Stopped, nothing more is read, but what was found is still put in order.
  if (project.highlights_stopped_at) return { pending: 0, ...(await stepRanking(key, projectId)) };
  await run(
    `UPDATE project_footage SET highlights_status = 'waiting'
      WHERE project_id = ? AND status = 'ready' AND log_status = 'done' AND highlights_status IS NULL`,
    [projectId],
  );
  await run(
    `UPDATE project_footage SET highlights_status = 'waiting'
      WHERE project_id = ? AND highlights_status = 'running' AND updated_at < datetime('now', '-5 minutes')`,
    [projectId],
  );
  if (!key) return { pending: await highlightsPending(projectId), moving: false, blocked: HIGHLIGHTS_NO_KEY };

  const rows = await query<WaitingRow>(
    `SELECT f.id, f.name, f.folder, f.language, f.log, f.fps, a.id AS asset_id, a.duration, a.media_uid, a.transcript, a.transcript_lang
       FROM project_footage f JOIN assets a ON a.id = f.asset_id
      WHERE f.project_id = ? AND f.status = 'ready' AND f.highlights_status = 'waiting'
      ORDER BY f.folder, f.name
      LIMIT ?`,
    [projectId, HIGHLIGHT_CALLS * BATCH.clips],
  );
  // What a person reviewed, latest first: each clip's own stretches are never
  // picked again, and the latest calls across the project are the taste the
  // reading learns from.
  const taken = new Map<string, Reviewed[]>();
  let taste: Taste | undefined;
  if (rows.length) {
    const reviewed = await query<ReviewedPick & { footage_id: string; src_in: number; src_out: number }>(
      `SELECT footage_id, src_in, src_out, text, pick, kind, speaker, score, origin FROM footage_highlights
        WHERE project_id = ? AND pick IS NOT NULL ORDER BY updated_at DESC, id`,
      [projectId],
    );
    for (const r of reviewed) {
      taken.set(r.footage_id, [...(taken.get(r.footage_id) ?? []), { start: r.src_in, end: r.src_out, text: r.text, pick: r.pick }]);
    }
    taste = tasteFrom(reviewed);
  }

  // The rate and size a timeline for the editor's own software needs, for
  // clips that don't have them yet: fetched together, a few at a time, since
  // one by one they took most of a step.
  const missing = rows.filter((r) => r.fps === null && r.media_uid);
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (r) => {
        const facts = await mediaFacts(cfg, r.media_uid!).catch(() => null);
        if (facts) await setClip(r.id, { fps: facts.fps, width: facts.width, height: facts.height });
      }),
    );
  }

  const clips: HighlightClip[] = [];
  for (const r of rows) {
    let log: ClipLog | null = null;
    try {
      log = JSON.parse(r.log) as ClipLog;
    } catch {
      log = null;
    }
    if (!log || !r.duration) {
      await setClip(r.id, { highlights_status: "failed", highlights_error: "this clip has no log to read" });
      continue;
    }
    let transcript = r.transcript_lang === r.language ? r.transcript : null;
    if (transcript === null && r.media_uid) {
      // Made when the clip was prepared for its log; usually here by now.
      transcript = await mediaTranscript(cfg, r.media_uid, r.language).catch(() => null);
      if (transcript !== null) {
        await run("UPDATE assets SET transcript = ?, transcript_lang = ? WHERE id = ?", [transcript, r.language, r.asset_id]);
      }
    }
    clips.push({ id: r.id, name: r.name, folder: r.folder, duration: r.duration, log, transcript: transcript || null, taken: taken.get(r.id) });
  }

  // Claim each batch's clips; a clip another step claimed first is left to it.
  const batches: HighlightClip[][] = [];
  for (const b of batchClips(clips).slice(0, HIGHLIGHT_CALLS)) {
    const mine: HighlightClip[] = [];
    for (const c of b) {
      if (await setClip(c.id, { highlights_status: "running", highlights_error: null }, " AND highlights_status = 'waiting'")) mine.push(c);
    }
    if (mine.length) batches.push(mine);
  }

  let blocked: string | null = null;
  let saved = false;
  await Promise.all(
    batches.map(async (b) => {
      const found = await findHighlights(key, project.brief, b, taste);
      if ("failure" in found) {
        // Busy or unreachable: back in line for a later step. Anything else
        // would fail the same way again, so the clips say why.
        for (const c of b) {
          await setClip(c.id, found.failure.retry ? { highlights_status: "waiting" } : { highlights_status: "failed", highlights_error: found.failure.detail });
        }
        if (!found.failure.retry) blocked = found.failure.detail;
        return;
      }
      const answered = new Set(found.verdicts.map((v) => v.id));
      for (const v of found.verdicts) await saveVerdict(projectId, v);
      saved ||= found.verdicts.length > 0;
      for (const c of b) {
        if (!answered.has(c.id)) await setClip(c.id, { highlights_status: "failed", highlights_error: "the model gave no answer for this clip" });
      }
    }),
  );
  // New picks: the order has to take them in.
  if (saved) {
    await run(
      "UPDATE edit_projects SET highlights_rank_status = 'waiting', highlights_rank_error = NULL WHERE id = ? AND highlights_wanted IS NOT NULL",
      [projectId],
    );
  }
  const pending = await highlightsPending(projectId);
  if (pending > 0) return { pending, moving: !blocked, blocked };
  const ranking = await stepRanking(key, projectId);
  return { pending, moving: ranking.moving, blocked: blocked ?? ranking.blocked };
}
