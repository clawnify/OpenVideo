// The editor's one way into AI: a conversation beside the cut.
//
// Ask what you want in your own words; the editor works out the steps and
// applies them as one undo step. It remembers the conversation, so a
// follow-up ("shorter", "a square one too") knows what it refers to, and it
// asks back instead of guessing. Auto-cut and AI reframe still run in their
// own dialogs, opened from here, until the conversation can run them itself.

import { useEffect, useRef, useState } from "react";
import { Crop, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { api, type Edl } from "./edit";
import { btnGhost, btnIcon, btnPrimary } from "./ui";

export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  author: string | null;
  applied: string[];
  asked: boolean;
  failed: boolean;
}

/** Requests that show what it can do, sent as written. */
const SUGGESTIONS = [
  "Remove the pauses and dead air from every clip",
  "Make a 60 second cut from the best moments",
  "Add a vertical 9:16 version for Reels",
  "Add a title for the first 3 seconds",
];

export function AssistantPanel({
  projectId,
  pane,
  saving,
  canReframe,
  onApplied,
  onAutocut,
  onReframe,
  onClose,
}: {
  projectId: string;
  pane: "library" | "canvas" | "inspector";
  /** A change is still on its way to the server: the request would read the cut before it. */
  saving: boolean;
  canReframe: boolean;
  onApplied: (edl: Edl) => void;
  onAutocut: () => void;
  onReframe: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<AskMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    api
      .get<{ messages: AskMessage[] }>(`/api/projects/${projectId}/ask`)
      .then((r) => live && setMessages(r.messages))
      .catch((e) => live && (setLoadErr(String((e as Error).message)), setMessages([])));
    input.current?.focus();
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, running]);

  const send = async (text: string) => {
    const instruction = text.trim();
    if (!instruction || running || saving) return;
    setDraft("");
    setRunning(true);
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
      setMessages((m) => [
        ...(m ?? []),
        { id: `local-${Date.now()}-a`, role: "assistant", text: out.said, author: null, applied: out.applied, asked: out.asked, failed: false },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...(m ?? []),
        { id: `local-${Date.now()}-f`, role: "assistant", text: String((e as Error).message), author: null, applied: [], asked: false, failed: true },
      ]);
    } finally {
      setRunning(false);
      input.current?.focus();
    }
  };

  const startOver = async () => {
    await api.send("DELETE", `/api/projects/${projectId}/ask`).catch(() => {});
    setMessages([]);
    input.current?.focus();
  };

  const empty = messages !== null && messages.length === 0;

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
              Say what you want in your own words. It edits the cut you have, and every request is one step you can
              undo.
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={running || saving} className="w-full rounded-sm bg-surface px-2.5 py-1.5 text-left text-button text-foreground shadow-raised hover:bg-surface-sunken disabled:opacity-50 disabled:pointer-events-none">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages?.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              {m.author && <span className="text-fine text-faint mb-0.5">{m.author}</span>}
              <div className="max-w-[90%] rounded-md bg-surface-sunken px-3 py-2 text-body-sm whitespace-pre-wrap break-words">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className="text-body-sm">
              <p className={`whitespace-pre-wrap break-words ${m.failed ? "text-danger" : ""}`}>{m.text}</p>
              {m.applied.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-fine text-faint">
                  {m.applied.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
        {running && (
          <div className="flex items-center gap-2 text-fine text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Working through the cut…
          </div>
        )}
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
