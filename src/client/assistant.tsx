// The editor's one way into AI: a conversation beside the cut.
//
// Ask what you want in your own words; the editor works out the steps and
// applies them as one undo step. It remembers the conversation, so a
// follow-up ("shorter", "a square one too") knows what it refers to, and it
// asks back instead of guessing. A request that would watch a lot of footage
// says so first and, on a yes, runs in the background (src/server/ask-jobs.ts):
// the editor keeps working, the tab can close, and the result never lands on
// top of a change made meanwhile.
//
// Inside Clawnify the conversation is the dashboard's chat, which calls the
// same /instruct: the editor then shows only the background work in a strip
// (JobStrip). This panel is the chat when the app runs on its own.

import { useCallback, useEffect, useRef, useState } from "react";
import { Crop, Film, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { api, type Edl } from "./edit";
import { btnGhost, btnIcon, btnPrimary, btnSecondary } from "./ui";

export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  author: string | null;
  applied: string[];
  asked: boolean;
  failed: boolean;
  job_id?: string | null;
  /** Projects it made: clips cut from a long video. */
  made?: Made[];
}

export interface Made {
  id: string;
  name: string;
}

export type AskJobStatus = "proposed" | "queued" | "running" | "applied" | "stale" | "failed" | "cancelled";

export interface AskJob {
  id: string;
  status: AskJobStatus;
  instruction: string;
  applied: string[];
  /** What it is doing now, while it runs. */
  doing?: string | null;
  error: string | null;
  /** Clip projects made so far, while it runs. */
  made?: Made[];
  /** An applied change that can still be put back. */
  revertible?: boolean;
  reverted_at?: string | null;
}

const ACTIVE: AskJobStatus[] = ["queued", "running"];

/** Requests that show what it can do, sent as written. */
const SUGGESTIONS = [
  "Make a 30 second video from my clips",
  "Make 5 vertical clips with a strong hook from my talk",
  "Remove the pauses and dead air from every clip",
  "Frame it for vertical, keeping the speaker in frame",
  "Add a title for the first 3 seconds",
];

/** JSON with keys in order: the server stores a cut with its keys in another order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The project's conversation and its background jobs. Lives in the editor,
 * not the panel, so a job that finishes while the panel is closed still lands:
 * its result becomes an undo step when the cut on screen is the one it started
 * from, and otherwise waits for the person ("Apply anyway").
 */
export function useAsk(projectId: string, getEdl: () => Edl, onApplied: (edl: Edl) => void) {
  const [messages, setMessages] = useState<AskMessage[] | null>(null);
  const [jobs, setJobs] = useState<AskJob[]>([]);
  const [loadErr, setLoadErr] = useState("");
  /** Jobs whose result the editor did not take, because the cut changed first. */
  const [notTaken, setNotTaken] = useState<Set<string>>(new Set());
  const seenActive = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  const latest = useRef({ getEdl, onApplied });
  latest.current = { getEdl, onApplied };

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ messages: AskMessage[]; jobs: AskJob[] }>(`/api/projects/${projectId}/ask`);
      setMessages(r.messages);
      setJobs(r.jobs);
      setLoadErr("");
      for (const j of r.jobs) {
        if (ACTIVE.includes(j.status)) seenActive.current.add(j.id);
        // Finished while this editor was open: take the result into the cut on screen.
        if (j.status === "applied" && j.applied.length > 0 && seenActive.current.has(j.id) && !handled.current.has(j.id)) {
          handled.current.add(j.id);
          const detail = await api.get<{ base_edl: Edl | null; result_edl: Edl | null }>(`/api/projects/${projectId}/ask/jobs/${j.id}`);
          if (detail.result_edl && detail.base_edl && canonical(latest.current.getEdl()) === canonical(detail.base_edl)) {
            latest.current.onApplied(detail.result_edl);
          } else if (detail.result_edl) {
            // An edit made here got to the server after the job wrote: it kept
            // the person's version. Offer the job's.
            setNotTaken((s) => new Set(s).add(j.id));
          }
        }
      }
    } catch (e) {
      setLoadErr(String((e as Error).message));
      setMessages((m) => m ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = jobs.some((j) => ACTIVE.includes(j.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const act = useCallback(
    async (jobId: string, action: "run" | "cancel" | "apply" | "revert") => {
      const out = await api.send<{ result_edl?: Edl | null; base_edl?: Edl | null }>("POST", `/api/projects/${projectId}/ask/jobs/${jobId}/${action}`);
      // Put back: the cut before the change returns, as one undo step here too.
      if (action === "revert" && out.base_edl && canonical(latest.current.getEdl()) !== canonical(out.base_edl)) {
        latest.current.onApplied(out.base_edl);
      }
      if (action === "run") seenActive.current.add(jobId);
      if (action === "apply" && out.result_edl) {
        handled.current.add(jobId);
        latest.current.onApplied(out.result_edl);
        setNotTaken((s) => {
          const n = new Set(s);
          n.delete(jobId);
          return n;
        });
      }
      await refresh();
    },
    [projectId, refresh],
  );

  return { messages, setMessages, jobs, active, notTaken, loadErr, refresh, act };
}

export type Ask = ReturnType<typeof useAsk>;

/** Links to the projects a request made. */
function MadeLinks({ made, onOpen }: { made: Made[]; onOpen: (id: string) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {made.map((p) => (
        <button key={p.id} onClick={() => onOpen(p.id)} className={`${btnGhost} justify-start text-fine min-w-0`}>
          <Film className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The background work, when the conversation is the dashboard's chat: what a
 * job is doing, its controls, and the clips it made. Nothing shows while
 * nothing needs the person.
 */
export function JobStrip({ ask, onOpen }: { ask: Ask; onOpen: (id: string) => void }) {
  const { jobs, messages, notTaken, act } = ask;
  const [acting, setActing] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const doAct = async (id: string, action: "run" | "cancel" | "apply") => {
    setActing(`${id}:${action}`);
    setErr("");
    try {
      await act(id, action);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setActing(null);
    }
  };
  // The newest message of each finished job that made clips, until dismissed.
  const madeBy = new Map<string, Made[]>();
  for (const m of messages ?? []) if (m.job_id && m.made?.length) madeBy.set(m.job_id, m.made);
  const shown = jobs.filter(
    (j) =>
      !dismissed.has(j.id) &&
      (j.status === "proposed" || ACTIVE.includes(j.status) || j.status === "stale" || notTaken.has(j.id) || (j.status === "applied" && madeBy.has(j.id))),
  );
  if (!shown.length && !err) return null;
  const close = (id: string) => setDismissed((d) => new Set(d).add(id));
  return (
    <div className="border-b border-border bg-surface px-3 py-2 space-y-2" aria-live="polite">
      {shown.map((j) => {
        const busy = acting !== null;
        return (
          <div key={j.id} className="text-fine">
            <div className="flex items-center gap-2 min-w-0">
              {ACTIVE.includes(j.status) ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Sparkles className="w-3.5 h-3.5 shrink-0 text-muted" />}
              <span className="flex-1 min-w-0 truncate" title={j.instruction}>
                {j.status === "proposed"
                  ? `Waiting for a yes: ${j.instruction}`
                  : j.status === "queued"
                    ? "Starting in the background…"
                    : j.status === "running"
                      ? `${j.doing ?? "Working"}…`
                      : j.status === "applied"
                        ? `Made ${madeBy.get(j.id)!.length} clips`
                        : "A change from the chat is waiting: the cut changed while it ran"}
              </span>
              {j.status === "proposed" && (
                <>
                  <button onClick={() => doAct(j.id, "run")} disabled={busy} className={`${btnPrimary} h-7 text-fine`}>Run</button>
                  <button onClick={() => doAct(j.id, "cancel")} disabled={busy} className={`${btnGhost} h-7 text-fine`}>Not now</button>
                </>
              )}
              {ACTIVE.includes(j.status) && (
                <button onClick={() => doAct(j.id, "cancel")} disabled={busy} className={`${btnGhost} h-7 text-fine`}>Cancel</button>
              )}
              {(j.status === "stale" || notTaken.has(j.id)) && (
                <>
                  <button onClick={() => doAct(j.id, "apply")} disabled={busy} className={`${btnSecondary} h-7 text-fine`}>Apply anyway</button>
                  {j.status === "stale" && (
                    <button onClick={() => doAct(j.id, "cancel")} disabled={busy} className={`${btnGhost} h-7 text-fine`}>Discard</button>
                  )}
                </>
              )}
              {j.status === "applied" && (
                <button onClick={() => close(j.id)} className={btnIcon} aria-label="Dismiss">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {(j.status === "applied" ? madeBy.get(j.id) : j.made)?.length ? (
              <MadeLinks made={(j.status === "applied" ? madeBy.get(j.id) : j.made)!} onOpen={onOpen} />
            ) : null}
          </div>
        );
      })}
      {err && <p className="text-fine text-danger break-words">{err}</p>}
    </div>
  );
}

export function AssistantPanel({
  projectId,
  ask,
  pane,
  saving,
  canReframe,
  onApplied,
  onAutocut,
  onReframe,
  onClose,
  onOpenProject,
}: {
  projectId: string;
  ask: Ask;
  pane: "library" | "canvas" | "inspector";
  /** A change is still on its way to the server: the request would read the cut before it. */
  saving: boolean;
  canReframe: boolean;
  onApplied: (edl: Edl) => void;
  onAutocut: () => void;
  onReframe: () => void;
  onClose: () => void;
  onOpenProject: (id: string) => void;
}) {
  const { messages, setMessages, jobs, notTaken, loadErr, refresh, act } = ask;
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [actErr, setActErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, running, jobs]);

  const send = async (text: string) => {
    const instruction = text.trim();
    if (!instruction || running || saving) return;
    setDraft("");
    setRunning(true);
    setActErr("");
    const mine: AskMessage = { id: `local-${Date.now()}`, role: "user", text: instruction, author: null, applied: [], asked: false, failed: false };
    setMessages((m) => [...(m ?? []), mine]);
    try {
      const out = await api.send<{ edl: Edl; said: string; applied: string[]; asked: boolean }>(
        "POST",
        `/api/projects/${projectId}/instruct`,
        { instruction },
      );
      // Only a request that changed something becomes an undo step.
      if (out.applied.length > 0) onApplied(out.edl);
    } catch {
      /* the failure is in the conversation, read back below */
    } finally {
      await refresh();
      setRunning(false);
      input.current?.focus();
    }
  };

  const doAct = async (jobId: string, action: "run" | "cancel" | "apply" | "revert") => {
    setActing(`${jobId}:${action}`);
    setActErr("");
    try {
      await act(jobId, action);
    } catch (e) {
      setActErr(String((e as Error).message));
    } finally {
      setActing(null);
    }
  };

  const startOver = async () => {
    await api.send("DELETE", `/api/projects/${projectId}/ask`).catch(() => {});
    await refresh();
    input.current?.focus();
  };

  const empty = messages !== null && messages.length === 0;
  // A job's controls go under the last message about it.
  const lastOfJob = new Map<string, string>();
  for (const m of messages ?? []) if (m.job_id) lastOfJob.set(m.job_id, m.id);
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const controls = (job: AskJob) => {
    const busy = (a: string) => acting === `${job.id}:${a}`;
    if (job.status === "proposed") {
      return (
        <div className="mt-2 flex gap-1.5">
          <button onClick={() => doAct(job.id, "run")} disabled={acting !== null} className={btnPrimary}>
            {busy("run") ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Run in background
          </button>
          <button onClick={() => doAct(job.id, "cancel")} disabled={acting !== null} className={btnGhost}>
            Not now
          </button>
        </div>
      );
    }
    if (ACTIVE.includes(job.status)) {
      return (
        <div className="mt-2 rounded-sm bg-surface-sunken px-3 py-2 text-fine text-muted">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="flex-1" aria-live="polite">
              {job.status === "queued" ? "Starting in the background…" : `${job.doing ?? "Working"}…`}
            </span>
            <button onClick={() => doAct(job.id, "cancel")} disabled={acting !== null} className={`${btnGhost} h-6 text-fine`}>
              Cancel
            </button>
          </div>
          {job.made?.length ? <MadeLinks made={job.made} onOpen={onOpenProject} /> : null}
          {job.applied.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-faint">
              {job.applied.map((a, i) => (
                <li key={i}>✓ {a}</li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-faint">Keep editing if you like: your changes stay, and this then waits for you to apply it.</p>
        </div>
      );
    }
    if (job.revertible && !saving) {
      return (
        <button onClick={() => doAct(job.id, "revert")} disabled={acting !== null} className={`${btnGhost} mt-1 h-7 text-fine`} title="Put the cut back as it was before this change">
          {busy("revert") ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Put back
        </button>
      );
    }
    if (job.reverted_at) return <p className="mt-1 text-fine text-faint">Put back.</p>;
    if (job.status === "stale" || notTaken.has(job.id)) {
      return (
        <div className="mt-2 flex gap-1.5">
          <button onClick={() => doAct(job.id, "apply")} disabled={acting !== null} className={btnSecondary}>
            {busy("apply") && <Loader2 className="w-4 h-4 animate-spin" />} Apply anyway
          </button>
          {job.status === "stale" && (
            <button onClick={() => doAct(job.id, "cancel")} disabled={acting !== null} className={btnGhost}>
              Discard
            </button>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <aside
      aria-label="AI"
      className={`${pane === "inspector" ? "flex" : "hidden"} lg:flex flex-col w-full lg:w-80 shrink-0 border-l border-border bg-surface min-h-0`}
    >
      <div className="flex items-center gap-2 px-4 h-11 border-b border-border shrink-0">
        <Sparkles className="w-4 h-4 text-muted" />
        <h2 className="text-heading-3 flex-1">AI</h2>
        {!empty && messages !== null && (
          <button onClick={startOver} disabled={running} className={btnIcon} title="Start a new conversation" aria-label="Start a new conversation">
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
        <button onClick={onClose} className={btnIcon} title="Close" aria-label="Close AI">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div ref={list} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">
        {messages === null && (
          <div className="flex items-center gap-2 text-fine text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the conversation…
          </div>
        )}
        {loadErr && <div className="text-fine text-danger break-words">{loadErr}</div>}
        {empty && (
          <div>
            <p className="text-body-sm text-muted">
              Add your clips, then say what you want in your own words: it can build the cut from them, or change the
              one you have. Every request is one step you can undo.
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={running || saving}
                  className="w-full rounded-sm bg-surface px-2.5 py-1.5 text-left text-button text-foreground shadow-raised hover:bg-surface-sunken disabled:opacity-50 disabled:pointer-events-none"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages?.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex flex-col items-end">
                {m.author && <span className="text-fine text-faint mb-0.5">{m.author}</span>}
                <div className="max-w-[90%] rounded-md bg-surface-sunken px-3 py-2 text-body-sm whitespace-pre-wrap break-words">{m.text}</div>
              </div>
            );
          }
          const job = m.job_id && lastOfJob.get(m.job_id) === m.id ? jobById.get(m.job_id) : undefined;
          return (
            <div key={m.id} className="text-body-sm">
              <p className={`whitespace-pre-wrap break-words ${m.failed ? "text-danger" : ""}`}>{m.text}</p>
              {m.applied.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-fine text-faint">
                  {m.applied.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
              {m.made?.length ? <MadeLinks made={m.made} onOpen={onOpenProject} /> : null}
              {job && controls(job)}
            </div>
          );
        })}
        {running && (
          <div className="flex items-center gap-2 text-fine text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Working through the cut…
          </div>
        )}
        {actErr && <div className="text-fine text-danger break-words">{actErr}</div>}
      </div>

      <div className="border-t border-border p-3 shrink-0">
        <div className="flex gap-1.5 mb-2">
          <button onClick={onAutocut} className={`${btnGhost} text-fine`} title="Assemble a cut from several clips">
            <Sparkles className="w-3.5 h-3.5" /> Auto-cut
          </button>
          <button onClick={onReframe} disabled={!canReframe} className={`${btnGhost} text-fine`} title="Frame each shot for the format">
            <Crop className="w-3.5 h-3.5" /> AI reframe
          </button>
        </div>
        <form
          className="flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={input}
            className="field min-h-10 max-h-40 flex-1 resize-none"
            rows={2}
            placeholder="e.g. put the demo first and make it 45 seconds"
            aria-label="What to change"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <button type="submit" disabled={running || saving || !draft.trim()} className={btnPrimary} aria-label="Send">
            <Send className="w-4 h-4" />
          </button>
        </form>
        {saving && !running && <p className="mt-1.5 text-fine text-faint">Saving your last change first…</p>}
      </div>
    </aside>
  );
}
