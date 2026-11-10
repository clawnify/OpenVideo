// AI requests that run in the background, a few steps per queue delivery.
//
// A quick request is answered inline (/instruct). One that would watch more
// footage than that allows (QUICK_WATCH_SECONDS) changes nothing and becomes a
// job: first `proposed`, saying what it would watch, then on a yes `queued` for
// the platform queue, which calls /api/ask/step.
//
// A delivery never runs the whole request. The platform queue delivers a few
// jobs at a time for every app on it, and a delivery may not outlive the
// queue's own run (15 minutes), so a delivery takes a lease on the job, runs
// steps of the request (instruct.ts instructStep: one model call, or one of the
// operations it asked for) until STEP_BUDGET_MS has passed or it is about to
// make a model call past MODEL_CALLS_PER_DELIVERY, saves where it got to, and
// books the next delivery. The saved state says what it is doing, so the editor
// can show it.
//
// Why a time budget and not "one slow step per delivery": the queue starts a
// booked delivery only on its per-minute clock, so every extra delivery costs
// up to a minute of waiting. Two minutes of work per delivery keeps a delivery
// far inside the 15-minute limit (one step that starts late can add a few
// minutes) while a request that watches four clips still finishes in one or two.
//
// The result is applied only over the cut the job started from; if a person
// changed the cut meanwhile it is kept aside (`stale`) for them to apply or
// drop. Nothing an AI job does ever overwrites a person's edit.

import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import { get, query, run } from "./db";
import type { Edl } from "./edl";
import {
  instructStep,
  startInstruction,
  type AppliedOp,
  type InstructContext,
  type InstructDone,
  type InstructHighlight,
  type InstructState,
  type InstructTurn,
  type InstructVideo,
  type NeedsBackground,
} from "./instruct";

export type AskJobStatus = "proposed" | "queued" | "running" | "applied" | "stale" | "failed" | "cancelled";

export interface AskJobRow {
  id: string;
  project_id: string;
  instruction: string;
  status: AskJobStatus;
  clips: number;
  seconds: number | null;
  base_edl: string | null;
  result_edl: string | null;
  said: string | null;
  applied: string | null;
  error: string | null;
  author: string | null;
  state: string | null;
  doing: string | null;
  leased_until: string | null;
  step_booked_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** How long a delivery may hold a job before another may take it over. */
const LEASE_MINUTES = 10;
/** A delivery stops starting new steps after this long. */
export const STEP_BUDGET_MS = 120_000;
/** Model calls a delivery makes at most; then it books the next. */
const MODEL_CALLS_PER_DELIVERY = 4;
/** A job with no step booked this long ago (and no delivery on it) is booked again. */
const REBOOK_AFTER_MINUTES = 3;
/** A job that has not moved for this long stopped: it is marked failed. */
const STOPPED_AFTER_MINUTES = 20;

const ACTIVE = "('queued', 'running')";

/** What every reader of a job sees; the documents themselves only from jobView(…, true). */
export function jobView(j: AskJobRow, withDocs = false) {
  return {
    id: j.id,
    status: j.status,
    instruction: j.instruction,
    clips: j.clips,
    seconds: j.seconds,
    said: j.said,
    applied: j.applied ? (JSON.parse(j.applied) as string[]) : [],
    doing: j.status === "queued" || j.status === "running" ? j.doing : null,
    error: j.error,
    started_at: j.started_at,
    finished_at: j.finished_at,
    created_at: j.created_at,
    ...(withDocs
      ? {
          base_edl: j.base_edl ? (JSON.parse(j.base_edl) as Edl) : null,
          result_edl: j.result_edl ? (JSON.parse(j.result_edl) as Edl) : null,
          // The cut as the job has it so far, while it runs: what a preview shows.
          draft_edl: j.state ? (JSON.parse(j.state) as InstructState).draft : null,
        }
      : {}),
  };
}

/** How the proposal reads: what it would watch, and that it runs in the background. */
export function proposalText(need: NeedsBackground): string {
  const clips = need.clips === 1 ? "a clip" : `${need.clips} clips`;
  const minutes = Number.isFinite(need.seconds) ? Math.max(1, Math.round(need.seconds / 60)) : null;
  const amount = minutes ? `, about ${minutes} minute${minutes === 1 ? "" : "s"} of footage` : "";
  return (
    `This needs to watch ${clips}${amount}, so it runs in the background: you can keep working or close the tab. ` +
    "It applies as one step you can undo, and never over a change you make meanwhile. Run it?"
  );
}

/** A newer request replaces a proposal nobody answered. */
export async function dropProposals(projectId: string): Promise<void> {
  await run(
    "UPDATE ask_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE project_id = ? AND status = 'proposed'",
    [projectId],
  );
}

export async function createJob(
  projectId: string,
  instruction: string,
  author: string | null,
  status: "proposed" | "queued",
  need: NeedsBackground | null,
): Promise<AskJobRow> {
  const row = await get<AskJobRow>(
    "INSERT INTO ask_jobs (project_id, instruction, status, clips, seconds, author) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
    [projectId, instruction, status, need?.clips ?? 0, need && Number.isFinite(need.seconds) ? need.seconds : null, author],
  );
  return row!;
}

/** Book the job's next delivery. False when the queue could not take it. */
export async function bookJob(env: QueueEnv, origin: string, job: { id: string }): Promise<boolean> {
  const at = new Date();
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/ask/step`,
      payload: { job_id: job.id },
      runAt: at,
      // Per job and per booking: every step is a booking of its own.
      idempotencyKey: `ask-${new URL(origin).host}-${job.id}-${at.toISOString()}`,
      maxAttempts: 3,
    });
  } catch {
    return false;
  }
  await run("UPDATE ask_jobs SET step_booked_at = datetime('now') WHERE id = ?", [job.id]);
  return true;
}

/** What a job needs from the app to run a step: the model, footage, highlights. */
export interface JobDeps {
  context(projectId: string): Promise<InstructContext & { assetNames: Map<string, string> }>;
  highlights(projectId: string): Promise<InstructHighlight[]>;
  videos(projectId: string): Promise<InstructVideo[]>;
  history(projectId: string, before: string): Promise<InstructTurn[]>;
  /** Book the next delivery; false when the queue could not take it. */
  book(job: { id: string }): Promise<boolean>;
}

/**
 * Run one delivery's worth of a job. Safe to call more than once at a time
 * (the queue delivers at least once): only the call holding the lease runs
 * steps, and the others answer at once.
 */
export async function runJobStep(
  jobId: string,
  deps: JobDeps,
  budgetMs = STEP_BUDGET_MS,
): Promise<{ status: AskJobStatus | "busy" | "gone" }> {
  const job = await get<AskJobRow>(
    `UPDATE ask_jobs SET status = 'running', leased_until = datetime('now', '+${LEASE_MINUTES} minutes'),
        started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND status IN ${ACTIVE} AND (leased_until IS NULL OR leased_until < datetime('now'))
      RETURNING *`,
    [jobId],
  );
  if (!job) {
    const now = await get<{ status: AskJobStatus }>("SELECT status FROM ask_jobs WHERE id = ?", [jobId]);
    return { status: !now ? "gone" : now.status === "queued" || now.status === "running" ? "busy" : now.status };
  }

  const ctx = await deps.context(job.project_id);
  ctx.highlights = await deps.highlights(job.project_id);
  let state: InstructState;
  if (job.state) {
    state = JSON.parse(job.state) as InstructState;
  } else {
    const project = await get<{ edl: string }>("SELECT edl FROM edit_projects WHERE id = ?", [job.project_id]);
    if (!project) {
      await finish(job, "cancelled", { error: "The project was deleted." });
      return { status: "cancelled" };
    }
    state = startInstruction(
      JSON.parse(project.edl) as Edl,
      job.instruction,
      ctx.assetNames,
      ctx.highlights,
      await deps.history(job.project_id, job.created_at),
      await deps.videos(job.project_id),
    );
    await run("UPDATE ask_jobs SET base_edl = ? WHERE id = ?", [project.edl, job.id]);
    job.base_edl = project.edl;
  }

  const began = Date.now();
  let modelCalls = 0;
  let done: InstructDone | null = null;
  for (;;) {
    // Cancelled from the editor: stop where it is; nothing is applied.
    const now = await get<{ status: AskJobStatus }>("SELECT status FROM ask_jobs WHERE id = ?", [job.id]);
    if (now?.status !== "running") return { status: now?.status ?? "gone" };
    const modelCall = state.pending.length === 0;
    const out = await instructStep(state, ctx).catch(
      (e: unknown) => ({ done: { failure: { error: "ai_failed", detail: String((e as Error).message ?? e) } } }) as { done: InstructDone },
    );
    if ("done" in out) {
      done = out.done;
      break;
    }
    state = out.state;
    if (modelCall) modelCalls++;
    await run("UPDATE ask_jobs SET state = ?, doing = ?, applied = ?, updated_at = datetime('now') WHERE id = ?", [
      JSON.stringify(state),
      state.doing,
      JSON.stringify(state.applied),
      job.id,
    ]);
    // Stop before a model call past the limit, or when the time is up; a model
    // call's operations run in the same delivery while time allows.
    const nextIsModelCall = state.pending.length === 0;
    if ((nextIsModelCall && modelCalls >= MODEL_CALLS_PER_DELIVERY) || Date.now() - began > budgetMs) break;
  }

  if (!done) {
    // More to do: hand the job to the next delivery.
    await run("UPDATE ask_jobs SET leased_until = NULL WHERE id = ? AND status = 'running'", [job.id]);
    await deps.book(job);
    return { status: "running" };
  }

  const cancelled = await get<{ status: AskJobStatus }>("SELECT status FROM ask_jobs WHERE id = ?", [job.id]);
  if (cancelled?.status !== "running") return { status: cancelled?.status ?? "gone" };
  return { status: await conclude(job, done) };
}

/** Record how a job ended, and apply its result over the cut it started from. */
async function conclude(job: AskJobRow, out: InstructDone): Promise<AskJobStatus> {
  if ("failure" in out) {
    await finish(job, "failed", { error: out.failure.detail });
    await say(job, out.failure.detail, [], { failed: true });
    return "failed";
  }
  if ("background" in out) {
    // Cannot happen without a watching limit; reported, never looped.
    await finish(job, "failed", { error: "the request asked to run in the background again" });
    await say(job, "This could not run in the background.", [], { failed: true });
    return "failed";
  }
  if (out.asked || out.applied.length === 0) {
    // A question back, or nothing to change: the cut stays as it is.
    await finish(job, "applied", { said: out.said, applied: [] });
    await say(job, out.said, [], { asked: !!out.asked });
    return "applied";
  }
  const result = JSON.stringify(out.edl);
  // Applied only over the cut it started from, in one statement, so an edit
  // saved meanwhile is never overwritten.
  const written = await get<{ id: string }>(
    "UPDATE edit_projects SET edl = ?, updated_at = datetime('now') WHERE id = ? AND edl = ? RETURNING id",
    [result, job.project_id, job.base_edl],
  );
  const status: AskJobStatus = written ? "applied" : "stale";
  await finish(job, status, { said: out.said, applied: out.applied, result });
  await say(job, written ? out.said : `${out.said} The cut changed while this ran, so it was kept aside instead of applied.`, out.applied);
  return status;
}

async function finish(
  job: AskJobRow,
  status: AskJobStatus,
  f: { said?: string; applied?: AppliedOp[]; result?: string; error?: string },
): Promise<void> {
  await run(
    `UPDATE ask_jobs SET status = ?, said = ?, applied = ?, result_edl = ?, error = ?, state = NULL, doing = NULL, leased_until = NULL,
        finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    [status, f.said ?? null, f.applied ? JSON.stringify(f.applied) : null, f.result ?? null, f.error ?? null, job.id],
  );
}

async function say(job: AskJobRow, text: string, applied: AppliedOp[], o: { asked?: boolean; failed?: boolean } = {}): Promise<void> {
  await run(
    "INSERT INTO ask_messages (project_id, role, text, applied, asked, failed, job_id) VALUES (?, 'assistant', ?, ?, ?, ?, ?)",
    [job.project_id, text, JSON.stringify(applied), o.asked ? 1 : 0, o.failed ? 1 : 0, job.id],
  );
}

/**
 * Read-side care for a project's running jobs: a job whose next delivery was
 * lost is booked again, and one that has not moved for STOPPED_AFTER_MINUTES is
 * marked failed, so nothing shows "working" forever.
 */
export async function reviveJobs(projectId: string, book: (job: { id: string }) => Promise<boolean>): Promise<void> {
  const stuck = await query<AskJobRow>(
    `SELECT * FROM ask_jobs WHERE project_id = ? AND status IN ${ACTIVE}
       AND updated_at < datetime('now', '-${STOPPED_AFTER_MINUTES} minutes')
       AND (leased_until IS NULL OR leased_until < datetime('now'))`,
    [projectId],
  );
  for (const job of stuck) {
    const stopped = await get<{ id: string }>(
      `UPDATE ask_jobs SET status = 'failed', error = 'stopped without finishing', state = NULL, doing = NULL, leased_until = NULL,
          finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status IN ${ACTIVE} RETURNING id`,
      [job.id],
    );
    if (stopped) await say(job, "This stopped without finishing. Nothing was changed: ask again to try once more.", [], { failed: true });
  }
  const lost = await query<{ id: string }>(
    `SELECT id FROM ask_jobs WHERE project_id = ? AND status IN ${ACTIVE}
       AND (leased_until IS NULL OR leased_until < datetime('now'))
       AND (step_booked_at IS NULL OR step_booked_at < datetime('now', '-${REBOOK_AFTER_MINUTES} minutes'))`,
    [projectId],
  );
  for (const job of lost) await book(job);
}

/** Apply a result kept aside, over whatever the cut is now: the person chose to. */
export async function applyKept(projectId: string, jobId: string): Promise<{ job: AskJobRow } | { refused: "not_found" | "not_kept" }> {
  const job = await get<AskJobRow>("SELECT * FROM ask_jobs WHERE id = ? AND project_id = ?", [jobId, projectId]);
  if (!job) return { refused: "not_found" };
  // Kept aside, or applied and then saved over by an edit that was on its way.
  if ((job.status !== "stale" && job.status !== "applied") || !job.result_edl) return { refused: "not_kept" };
  await run("UPDATE edit_projects SET edl = ?, updated_at = datetime('now') WHERE id = ?", [job.result_edl, projectId]);
  await run("UPDATE ask_jobs SET status = 'applied', updated_at = datetime('now') WHERE id = ?", [jobId]);
  return { job: (await get<AskJobRow>("SELECT * FROM ask_jobs WHERE id = ?", [jobId]))! };
}

export async function listJobs(projectId: string): Promise<AskJobRow[]> {
  return query<AskJobRow>("SELECT * FROM ask_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20", [projectId]);
}
