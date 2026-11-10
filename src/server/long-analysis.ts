// Reading footage longer than five minutes.
//
// The short path (export.ts) sends the model a small copy of the clip, made by
// the render service. The service makes such a copy only up to five minutes,
// and the model takes it whole in one request. A longer clip on the media
// service is read there instead: the platform's video analysis watches the
// stream itself, up to 45 minutes per pass (services /video/analyze).

import { getVideoAnalysis, startVideoAnalysis } from "@clawnify/services";
import { get, run } from "./db";
import { mediaState, prepareMedia } from "./media";

/** Longest clip the short path can read. */
export const SHORT_ANALYSIS_SECONDS = 300;
/** Longest stretch the platform's analysis reads in one pass. */
export const LONG_ANALYSIS_SECONDS = 45 * 60;
/** What the result says read it, without naming a model. */
export const LONG_ANALYSIS_MODEL = "clawnify-video-analysis";

const POLL_MS = 5000;
// The request waits this long for the analysis. Each job is kept in
// `video_analyses`, so asking again for the same clip and question collects a
// job still running (or one already answered) instead of paying for another.
const WAIT_MS = 12 * 60 * 1000;
// A job the service has not answered in this long is presumed lost: past its
// own 20-minute limit (services ANALYZE_TIMEOUT_S), with room to spare.
const STALE_MS = 30 * 60 * 1000;

export interface LongFailure {
  error: string;
  detail: string;
}

interface Config {
  servicesUrl?: string;
  token: string;
}

/**
 * Watch `window` of a media-service video with `prompt`, answering in
 * `schema`. Waits for the answer, which takes minutes for a long stretch. A
 * video not yet prepared for analysis is sent to be prepared, and the caller
 * is told to come back.
 */
export async function analyzeLong<T>(
  cfg: Config,
  asset: { id: string; mediaUid: string },
  window: { start: number; end: number },
  prompt: string,
  schema: Record<string, unknown>,
  error: string,
): Promise<{ result: T } | { failure: LongFailure }> {
  const mediaUid = asset.mediaUid;
  if (window.end - window.start > LONG_ANALYSIS_SECONDS) {
    return { failure: { error, detail: "a clip longer than 45 minutes can't be read in one pass: split it first" } };
  }
  const state = await mediaState(cfg, mediaUid);
  if ("failure" in state) return { failure: { error, detail: "could not read the video, try again" } };
  if (state.media.analysis !== "ready") {
    if (state.media.analysis === "failed") {
      return { failure: { error, detail: "this video could not be prepared for analysis: prepare it again from the media library" } };
    }
    await prepareMedia(cfg, mediaUid);
    return { failure: { error: "analysis_preparing", detail: "this video is being prepared for analysis: try again in a few minutes" } };
  }

  const env = { CLAWNIFY_TOKEN: cfg.token, CLAWNIFY_SERVICES_URL: cfg.servicesUrl };
  const question = await digest(`${prompt}\n${JSON.stringify(schema)}`);
  const key = [asset.id, window.start, window.end, question];
  type Row = { id: string; status: string; job_id: string | null; result: string | null; updated_at: number; attempt: string };
  const known = await get<Row>(
    "SELECT * FROM video_analyses WHERE asset_id = ? AND source_start = ? AND source_end = ? AND question = ?",
    key,
  );
  if (known?.status === "done" && known.result) return { result: JSON.parse(known.result) as T };
  const live = known?.status === "running" && known.job_id && Date.now() - known.updated_at < STALE_MS;
  let id = known?.id ?? crypto.randomUUID();
  let jobId: string;
  if (live) {
    jobId = known.job_id!;
  } else {
    // One request starts the job; another asking at the same moment waits on it.
    const attempt = crypto.randomUUID();
    await run(
      `INSERT INTO video_analyses (id, asset_id, source_start, source_end, question, status, attempt, updated_at)
       VALUES (?, ?, ?, ?, ?, 'starting', ?, ?)
       ON CONFLICT(asset_id, source_start, source_end, question) DO UPDATE SET status = 'starting', attempt = excluded.attempt,
         job_id = NULL, result = NULL, updated_at = excluded.updated_at
       WHERE video_analyses.status IN ('failed') OR video_analyses.updated_at < ?`,
      [id, ...key, attempt, Date.now(), Date.now() - STALE_MS],
    );
    const row = await get<Row>("SELECT * FROM video_analyses WHERE asset_id = ? AND source_start = ? AND source_end = ? AND question = ?", key);
    if (!row) return { failure: { error, detail: "the source video was removed" } };
    id = row.id;
    if (row.attempt !== attempt) return waitOn<T>(row.id, error);
    try {
    const job = await startVideoAnalysis(env, {
      source: `media:${mediaUid}`,
      window,
      fps: 1,
      max_output_tokens: 32000,
      schema,
      prompt,
    });
      jobId = job.job_id;
      await run("UPDATE video_analyses SET status = 'running', job_id = ?, updated_at = ? WHERE id = ? AND attempt = ?", [jobId, Date.now(), id, attempt]);
    } catch (e) {
      await run("UPDATE video_analyses SET status = 'failed', updated_at = ? WHERE id = ? AND attempt = ?", [Date.now(), id, attempt]);
      return { failure: { error, detail: `the analysis could not start: ${(e as Error).message}`.slice(0, 300) } };
    }
  }

  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const job = await getVideoAnalysis(env, jobId).catch(() => null);
    if (!job) continue;
    if (job.status === "done") {
      await run("UPDATE video_analyses SET status = 'done', result = ?, updated_at = ? WHERE id = ?", [JSON.stringify(job.result), Date.now(), id]);
      return { result: job.result as T };
    }
    if (job.status === "failed") {
      await run("UPDATE video_analyses SET status = 'failed', updated_at = ? WHERE id = ?", [Date.now(), id]);
      return { failure: { error, detail: `the analysis failed (${job.detail})` } };
    }
  }
  return { failure: { error, detail: "the analysis is taking longer than expected: ask again in a few minutes, and the answer is collected" } };
}

/** Wait for a job another request started for the same clip and question. */
async function waitOn<T>(id: string, error: string): Promise<{ result: T } | { failure: LongFailure }> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const row = await get<{ status: string; result: string | null }>("SELECT status, result FROM video_analyses WHERE id = ?", [id]);
    if (!row) return { failure: { error, detail: "the source video was removed" } };
    if (row.status === "done" && row.result) return { result: JSON.parse(row.result) as T };
    if (row.status === "failed") return { failure: { error, detail: "the analysis failed: try again" } };
  }
  return { failure: { error, detail: "the analysis is taking longer than expected: ask again in a few minutes, and the answer is collected" } };
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How far to move an answer's timestamps (ms) onto the whole video's clock.
 * Asked for whole-video times, the model sometimes counts from the start of
 * the stretch it watched instead. When no time falls inside the stretch and
 * every one fits within its length, the answer is shifted by the stretch's
 * start; a mixed answer is left as it is.
 */
export function shiftToSource(times: number[], window: { start: number; end: number }): number {
  const lo = window.start * 1000;
  const hi = window.end * 1000;
  if (lo < 100 || times.length === 0) return 0;
  const inside = times.some((t) => t >= lo - 100 && t <= hi + 100);
  const relative = !inside && times.every((t) => t >= -100 && t <= hi - lo + 100);
  return relative ? lo : 0;
}
