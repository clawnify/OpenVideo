// AI requests that run in the background.
//
// A quick request is answered inline (/instruct). One that would watch more
// footage than that allows (QUICK_WATCH_SECONDS) changes nothing and becomes a
// job: first `proposed`, saying what it would watch, then on a yes `queued` for
// the platform queue, which calls /api/ask/step. The step runs the whole request
// again from the cut as it is then, with no watching limit, and applies the
// result only if nobody changed the cut meanwhile; otherwise it keeps the
// result aside (`stale`) for the person to apply or drop. Nothing an AI job
// does ever overwrites a person's edit.

import { enqueueJob, type QueueEnv } from "@clawnify/queue";
import { get, query, run } from "./db";
import type { Edl, EdlInvalid } from "./edl";
import type { AppliedOp, InstructFailure, InstructTurn, NeedsBackground } from "./instruct";

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
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A job that has been running this long without finishing died: it may be claimed again. */
const RUNNING_EXPIRES_MINUTES = 30;

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
    error: j.error,
    started_at: j.started_at,
    finished_at: j.finished_at,
    created_at: j.created_at,
    ...(withDocs
      ? { base_edl: j.base_edl ? (JSON.parse(j.base_edl) as Edl) : null, result_edl: j.result_edl ? (JSON.parse(j.result_edl) as Edl) : null }
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

/** Book the step that runs the job. False when the queue could not take it. */
export async function bookJob(env: QueueEnv, origin: string, job: AskJobRow): Promise<boolean> {
  try {
    await enqueueJob(env, {
      targetUrl: `${origin}/api/ask/step`,
      payload: { job_id: job.id },
      runAt: new Date(),
      // Per job and per booking: a job queued again after a failure is a new booking.
      idempotencyKey: `ask-${new URL(origin).host}-${job.id}-${job.updated_at}`,
      maxAttempts: 3,
    });
    return true;
  } catch {
    return false;
  }
}

/** The request as a job runs it: the model, the footage, the conversation. */
export type RunInstruction = (
  edl: Edl,
  instruction: string,
  history: InstructTurn[],
) => Promise<{ edl: Edl; said: string; applied: AppliedOp[]; asked?: true } | { background: NeedsBackground } | { failure: InstructFailure | EdlInvalid }>;

/**
 * Run one job to its end. Safe to call more than once for the same job (the
 * queue delivers at least once): only the call that claims it does the work.
 */
export async function runJob(jobId: string, runInstruction: RunInstruction, historyBefore: (projectId: string, at: string) => Promise<InstructTurn[]>): Promise<AskJobRow | null | undefined> {
  const claimed = await get<AskJobRow>(
    `UPDATE ask_jobs SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND (status = 'queued' OR (status = 'running' AND started_at < datetime('now', '-${RUNNING_EXPIRES_MINUTES} minutes')))
      RETURNING *`,
    [jobId],
  );
  if (!claimed) return null;
  const project = await get<{ edl: string }>("SELECT edl FROM edit_projects WHERE id = ?", [claimed.project_id]);
  if (!project) {
    await finish(claimed.id, "cancelled", { error: "The project was deleted." });
    return null;
  }
  await run("UPDATE ask_jobs SET base_edl = ? WHERE id = ?", [project.edl, claimed.id]);

  const out = await runInstruction(JSON.parse(project.edl) as Edl, claimed.instruction, await historyBefore(claimed.project_id, claimed.created_at)).catch(
    (e: unknown) => ({ failure: { error: "ai_failed", detail: String((e as Error).message ?? e) } as InstructFailure }),
  );

  // Cancelled while it ran: the result is dropped.
  const now = await get<{ status: AskJobStatus }>("SELECT status FROM ask_jobs WHERE id = ?", [claimed.id]);
  if (now?.status !== "running") return get<AskJobRow>("SELECT * FROM ask_jobs WHERE id = ?", [claimed.id]);

  if ("failure" in out) {
    await finish(claimed.id, "failed", { error: out.failure.detail });
    await say(claimed, out.failure.detail, [], { failed: true });
  } else if ("background" in out) {
    // Cannot happen without a watching limit; reported, never looped.
    await finish(claimed.id, "failed", { error: "the request asked to run in the background again" });
    await say(claimed, "This could not run in the background.", [], { failed: true });
  } else if (out.asked || out.applied.length === 0) {
    // A question back, or nothing to change: the cut stays as it is.
    await finish(claimed.id, "applied", { said: out.said, applied: [] });
    await say(claimed, out.said, [], { asked: !!out.asked });
  } else {
    const result = JSON.stringify(out.edl);
    // Applied only over the cut it started from, in one statement, so an edit
    // saved meanwhile is never overwritten.
    const written = await get<{ id: string }>(
      "UPDATE edit_projects SET edl = ?, updated_at = datetime('now') WHERE id = ? AND edl = ? RETURNING id",
      [result, claimed.project_id, project.edl],
    );
    await finish(claimed.id, written ? "applied" : "stale", { said: out.said, applied: out.applied, result });
    await say(
      claimed,
      written ? out.said : `${out.said} The cut changed while this ran, so it was kept aside instead of applied.`,
      out.applied,
    );
  }
  return get<AskJobRow>("SELECT * FROM ask_jobs WHERE id = ?", [claimed.id]);
}

async function finish(
  id: string,
  status: AskJobStatus,
  f: { said?: string; applied?: AppliedOp[]; result?: string; error?: string },
): Promise<void> {
  await run(
    `UPDATE ask_jobs SET status = ?, said = ?, applied = ?, result_edl = ?, error = ?, finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    [status, f.said ?? null, f.applied ? JSON.stringify(f.applied) : null, f.result ?? null, f.error ?? null, id],
  );
}

async function say(job: AskJobRow, text: string, applied: AppliedOp[], o: { asked?: boolean; failed?: boolean } = {}): Promise<void> {
  await run(
    "INSERT INTO ask_messages (project_id, role, text, applied, asked, failed, job_id) VALUES (?, 'assistant', ?, ?, ?, ?, ?)",
    [job.project_id, text, JSON.stringify(applied), o.asked ? 1 : 0, o.failed ? 1 : 0, job.id],
  );
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
