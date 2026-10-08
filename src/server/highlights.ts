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
  taken?: { start: number; end: number; text: string }[];
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
    lines.push(`Already reviewed by a person, don't pick again or overlap: ${c.taken.map((t) => `[${stamp(t.start)}-${stamp(t.end)}] ${t.text.slice(0, 80)}`).join("; ")}`);
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

export function highlightsPrompt(brief: string, clips: HighlightClip[]): string {
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

How many: as many as are worth an editor's look. A 5-second shot has none or one. A long interview or talk: read it all, start to finish, and pick every strong soundbite, roughly one for every two or three minutes of talk and more where it is strong; a 45-minute interview usually gives fifteen or more. The logger's picks are a hint: include the strong ones, and find the others they missed.

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

/** One model call over one batch of clips. */
export async function findHighlights(
  key: string | undefined,
  brief: string,
  clips: HighlightClip[],
): Promise<{ verdicts: ClipVerdict[] } | { failure: HighlightsFailure }> {
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
        messages: [{ role: "user", content: highlightsPrompt(brief, clips) }],
        max_tokens: 24_000,
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: "highlights", strict: true, schema: HIGHLIGHTS_SCHEMA } },
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
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body?.choices?.[0]?.message?.content ?? "");
  } catch {
    parsed = null;
  }
  const verdicts = readHighlights(parsed, clips);
  if (!verdicts.length) {
    return { failure: { error: "highlights_failed", detail: "the model's answer could not be read", retry: true } };
  }
  return { verdicts };
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
 * that died goes back in line.
 */
export async function stepHighlights(cfg: MediaConfig, key: string | undefined, projectId: string): Promise<HighlightsOutcome> {
  const project = await get<{ brief: string; highlights_at: string | null }>(
    "SELECT brief, highlights_at FROM edit_projects WHERE id = ?",
    [projectId],
  );
  if (!project?.highlights_at) return { pending: 0, moving: false, blocked: null };
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
  const taken = new Map<string, { start: number; end: number; text: string }[]>();
  if (rows.length) {
    const reviewed = await query<{ footage_id: string; src_in: number; src_out: number; text: string }>(
      "SELECT footage_id, src_in, src_out, text FROM footage_highlights WHERE project_id = ? AND pick IS NOT NULL",
      [projectId],
    );
    for (const r of reviewed) taken.set(r.footage_id, [...(taken.get(r.footage_id) ?? []), { start: r.src_in, end: r.src_out, text: r.text }]);
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
  await Promise.all(
    batches.map(async (b) => {
      const found = await findHighlights(key, project.brief, b);
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
      for (const c of b) {
        if (!answered.has(c.id)) await setClip(c.id, { highlights_status: "failed", highlights_error: "the model gave no answer for this clip" });
      }
    }),
  );
  const pending = await highlightsPending(projectId);
  return { pending, moving: pending > 0 && !blocked, blocked };
}
