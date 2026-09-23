// Long footage lives on the managed media service, not in this app's storage.
//
// A studio master is gigabytes long. Keeping one here meant the app served
// every byte of playback itself, which measured about 2.5 MB/s against a
// 20 Mbps source, so the picture stalled; the edit service could not stage a
// file over 500 MB at all; and the browser decoded the same file again to
// draw the timeline's frames while it was trying to play it.
//
// The service holds the source instead. It pulls the file itself (nothing
// passes through this app), serves adaptive playback and a frame at any
// second, and the edit service reads only the seconds a cut needs.

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

export interface MediaConfig {
  servicesUrl?: string;
  token?: string;
}

export interface MediaFailure {
  error: string;
  detail: string;
}

/** What the service says about one video. `ready` means it can be played. */
export interface MediaState {
  id: string;
  state: string;
  progress: number | null;
  ready: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  /** Set once `prepare` has been asked for: the MP4 a cut is read from. */
  download?: { status: string; percent: number | null } | null;
  /** Transcripts generated or in progress, one per language. */
  captions?: { language: string; status: string }[];
  /** The video has no sound, so it can have no transcript. */
  no_audio?: boolean;
}

export interface MediaPlayback {
  /** Adaptive playback, signed and short-lived. */
  hls: string;
  /** A frame at any second: put the seconds in place of `{time}`. */
  thumbnail: string;
  download: string;
}

async function call<T>(
  cfg: MediaConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ data: T } | { failure: MediaFailure }> {
  if (!cfg.token) {
    return {
      failure: {
        error: "media_unavailable",
        detail: "long footage needs the managed media service, which deployed apps have and local dev does not",
      },
    };
  }
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/media${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* a proxy or policy message, kept as text below */
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; detail?: string };
    return {
      failure: {
        error: err.error ?? "media_failed",
        detail: err.detail ?? raw.trim().slice(0, 300) ?? `media service returned ${res.status}`,
      },
    };
  }
  return { data: body as T };
}

/**
 * Hand the service a link and let it fetch the file. The link only has to
 * live long enough for that fetch, which is why an import never waits on this
 * app to move bytes.
 */
export async function importMedia(
  cfg: MediaConfig,
  url: string,
  name: string,
): Promise<{ media: MediaState } | { failure: MediaFailure }> {
  const res = await call<MediaState>(cfg, "/import", { method: "POST", body: JSON.stringify({ url, name }) });
  return "failure" in res ? res : { media: res.data };
}

export async function mediaState(cfg: MediaConfig, uid: string): Promise<{ media: MediaState } | { failure: MediaFailure }> {
  const res = await call<MediaState>(cfg, `/${uid}`);
  return "failure" in res ? res : { media: res.data };
}

/**
 * Ask for the MP4 a cut is read from, and a transcript in `lang` (English
 * unless said otherwise). Idempotent; readiness comes from state.
 */
export async function prepareMedia(
  cfg: MediaConfig,
  uid: string,
  lang?: string,
): Promise<{ media: MediaState } | { failure: MediaFailure }> {
  const res = await call<MediaState>(cfg, `/${uid}/prepare`, {
    method: "POST",
    body: JSON.stringify(lang ? { captions: lang } : {}),
  });
  return "failure" in res ? res : { media: res.data };
}

/** The transcript as WebVTT, or null while it is still being made. */
export async function mediaTranscript(cfg: MediaConfig, uid: string, lang: string): Promise<string | null> {
  if (!cfg.token) return null;
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/media/${uid}/captions/${lang}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  return res.ok ? res.text() : null;
}

export async function mediaPlayback(
  cfg: MediaConfig,
  uid: string,
): Promise<{ playback: MediaPlayback } | { failure: MediaFailure }> {
  const res = await call<MediaPlayback>(cfg, `/${uid}/playback`, { method: "POST" });
  return "failure" in res ? res : { playback: res.data };
}

/** A frame at `seconds`, as a URL the browser can load directly. */
export function frameUrl(playback: MediaPlayback, seconds: number): string {
  return playback.thumbnail.replace("{time}", String(Math.max(0, Math.round(seconds * 10) / 10)));
}

export async function deleteMedia(cfg: MediaConfig, uid: string): Promise<void> {
  await call(cfg, `/${uid}`, { method: "DELETE" });
}
