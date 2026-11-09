// What one answer about a clip's playback means to an editor waiting on it.

/** An answer from GET /api/assets/:id/playback, or the error it was thrown as. */
export type PlaybackAnswer = { ready: boolean; state?: string } | { status?: number; code?: string };

/**
 * ready: it plays. failed: it never will (the media service gave up on it, or
 * the clip or its video is gone), so stop asking. waiting: still being
 * prepared. retry: a hiccup, asked again on the next pass.
 */
export function playbackVerdict(answer: PlaybackAnswer): "ready" | "failed" | "waiting" | "retry" {
  if ("ready" in answer) return answer.ready ? "ready" : answer.state === "error" ? "failed" : "waiting";
  return answer.status === 404 || answer.code === "not_found" ? "failed" : "retry";
}
