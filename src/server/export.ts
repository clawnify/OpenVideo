// Export pipeline for footage edit projects.
//
// An export resolves the EDL's "asset:<id>" references to staged sources on
// the managed edit service, runs the edit there, and copies the MP4 back into
// this app's storage. Staging is a cache: each library asset is uploaded to
// the service once and reused across exports; staged copies expire after ~30
// days and are re-staged transparently. All media moves as fixed-length
// streams — nothing is buffered in the worker.

import { get, run } from "./db";
import { getUpload, getUploadBytes, putUploadFromUrl } from "./uploads";
import { mediaState, prepareMedia } from "./media";
import { blockHeight, fitTop, lineStep, wrapLines } from "../shared/textLayout";
import { captionText, captionTimeline, type PlacedClip } from "../shared/captions";
import { parseVtt, type Cue } from "../shared/transcript";
import { collectAssetIds, substituteAssetSrcs, type Edl, type EdlInvalid } from "./edl";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";
// Re-stage when the staged copy expires within this window — an export must
// never race the expiry.
const RESTAGE_MARGIN_MS = 6 * 60 * 60 * 1000;

export interface ExportConfig {
  servicesUrl?: string;
  token: string;
  /** The org's OpenRouter key (injected at deploy) — powers footage analysis. */
  openrouterKey?: string;
}

interface AssetRow {
  id: string;
  key: string;
  media_uid?: string | null;
  name: string;
  content_type: string;
  size: number;
  service_key: string | null;
  service_key_expires_at: string | null;
  proxy_key: string | null;
}

export interface ExportFailure {
  error: string;
  detail: string;
  path?: string;
}

/**
 * Ensure one media-library asset has a fresh staged copy on the edit service;
 * returns its "file:…" src. Used by exports (every referenced asset) and by
 * footage analysis (one asset at a time).
 */
/** What the edit service accepts for one staged file (services/staging.ts). */
const MAX_STAGE_BYTES = 500 * 1024 * 1024;

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

export async function ensureStagedSrc(
  assetId: string,
  cfg: ExportConfig,
): Promise<{ src: string } | { failure: ExportFailure }> {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    return {
      failure: {
        error: "asset_not_found",
        detail: `no media-library asset with id "${assetId}" — list assets with GET /api/assets`,
      },
    };
  }

  // Footage on the media service is cut where it lies: the edit service reads
  // only the seconds the cut needs, so nothing is staged and no size applies.
  if (asset.media_uid) {
    let prepared = await prepareMedia(cfg, asset.media_uid);
    if ("failure" in prepared) {
      return { failure: { error: prepared.failure.error, detail: prepared.failure.detail } };
    }
    // The MP4 may still be generating. Wait a little rather than failing the
    // request and making the person press the button again.
    for (let i = 0; i < 12 && prepared.media.download?.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const state = await mediaState(cfg, asset.media_uid);
      if ("failure" in state) break;
      prepared = state;
    }
    if (prepared.media.download?.status !== "ready") {
      return {
        failure: {
          error: "source_not_ready",
          detail: `"${asset.name}" is still being prepared for editing — try again in a moment`,
        },
      };
    }
    return { src: `media:${asset.media_uid}` };
  }

  // The edit service accepts a staged file up to this size. Without the check
  // the upload dies part-way and the runtime reports a lost connection, which
  // tells the user nothing about the actual problem.
  if (asset.size > MAX_STAGE_BYTES) {
    return {
      failure: {
        error: "clip_too_large",
        detail: `"${asset.name}" is ${mb(asset.size)}; a clip has to be ${mb(MAX_STAGE_BYTES)} or smaller to export or analyse. Trim it, or import a smaller version.`,
      },
    };
  }

  const fresh =
    asset.service_key &&
    asset.service_key_expires_at &&
    Date.parse(asset.service_key_expires_at) > Date.now() + RESTAGE_MARGIN_MS;

  let key = asset.service_key;
  if (!fresh) {
    const stagedFile = await stageAsset(asset, cfg);
    if ("failure" in stagedFile) return stagedFile;
    key = stagedFile.key;
  }
  return { src: `file:${key}` };
}

/**
 * Resolve every "asset:<id>" in the EDL to a fresh staged source, re-staging
 * from this app's storage where needed. Returns the resolved document or a
 * failure the caller can surface directly.
 */
export async function resolveEdlSources(
  edl: Edl,
  cfg: ExportConfig,
): Promise<{ edl: Edl } | { failure: ExportFailure }> {
  edl = await expandCaptions(edl);
  const staged = new Map<string, string>();
  for (const assetId of collectAssetIds(edl)) {
    const res = await ensureStagedSrc(assetId, cfg);
    if ("failure" in res) return res;
    staged.set(assetId, res.src);
  }
  return { edl: layoutText(substituteAssetSrcs(edl, (id) => staged.get(id)!)) };
}

/**
 * Turn project captions into ordinary text on their own track, and drop the
 * `captions` block the render service does not know. Captions are worked out
 * from each clip's stored transcript and the part of it the clip plays, the
 * same way the preview works them out.
 */
async function expandCaptions(edl: Edl): Promise<Edl> {
  const { captions, ...rest } = edl;
  if (!captions?.enabled) return rest as Edl;

  const placed: PlacedClip[] = [];
  const cues = new Map<string, Cue[]>();
  let at = 0;
  for (const el of edl.main.elements) {
    let plays = el.duration;
    if (plays === undefined && el.src.startsWith("asset:")) {
      const row = await get<{ duration: number | null }>("SELECT duration FROM assets WHERE id = ?", [el.src.slice(6)]);
      plays = row?.duration ? row.duration - (el.trimStart ?? 0) - (el.trimEnd ?? 0) : 0;
    }
    plays = Math.max(0, plays ?? 0);
    if (el.type === "video" && el.src.startsWith("asset:")) {
      placed.push({ src: el.src, start: at, dur: plays, trimStart: el.trimStart ?? 0 });
      if (!cues.has(el.src)) {
        const row = await get<{ transcript: string | null; transcript_lang: string | null }>(
          "SELECT transcript, transcript_lang FROM assets WHERE id = ?",
          [el.src.slice(6)],
        );
        if (row?.transcript && row.transcript_lang === captions.lang) cues.set(el.src, parseVtt(row.transcript));
      }
    }
    at += plays;
  }

  const lines = captionTimeline(placed, cues, captions.style.maxChars);
  if (lines.length === 0) return rest as Edl;
  const track = {
    id: "captions",
    elements: lines.map((line, n) => captionText(line, captions.style, edl.output, `caption-${n}`)),
  };
  return { ...rest, overlays: [...(rest.overlays ?? []), track] } as Edl;
}

/**
 * Send each line of a wrapped caption as its own element. The render service
 * draws text without wrapping, and a multi-line element would left-align its
 * lines; one centred element per line matches what the preview shows, because
 * both break lines with the same function.
 */
type Overlay = NonNullable<Edl["overlays"]>[number]["elements"][number];

function layoutText(edl: Edl): Edl {
  const { width: W, height: H } = edl.output;
  return {
    ...edl,
    overlays: edl.overlays?.map((track) => ({
      ...track,
      elements: track.elements.flatMap((el): Overlay[] => {
        if (el.type !== "text") return [el];
        const family = el.fontFamily ?? "sans";
        const lines = wrapLines(el.text, el.fontSize, W, family);
        const step = lineStep(el.fontSize, !!el.background) / H;
        const top = fitTop(el.y, blockHeight(el.text, el.fontSize, W, family, !!el.background), H);
        return lines
          .map((line, n) => ({ ...el, id: `${el.id}-l${n}`, text: line, y: Math.min(1, top + n * step) }))
          .filter((line) => line.text.trim().length > 0);
      }),
    })),
  };
}

/** Stream one asset from this app's storage to the edit service's staging. */
async function stageAsset(
  asset: AssetRow,
  cfg: ExportConfig,
): Promise<{ key: string } | { failure: ExportFailure }> {
  const obj = await getUpload(asset.key);
  if (!obj) {
    return {
      failure: {
        error: "asset_missing",
        detail: `asset "${asset.name}" (${asset.id}) has no stored file — re-upload it`,
      },
    };
  }

  // Fixed-length stream so the upload carries a Content-Length end to end.
  const fixed = new FixedLengthStream(obj.size);
  const pipe = obj.data.pipeTo(fixed.writable);
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
    },
    body: fixed.readable,
  });
  await pipe;

  const { json, text } = await readServiceResponse<{ key?: string; expires_at?: string; error?: string; detail?: string }>(res);
  if (res.status !== 201 || !json?.key) {
    return {
      failure: {
        error: json?.error ?? "staging_failed",
        detail: `could not stage "${asset.name}": ${json?.detail ?? (text || `service returned ${res.status}`)}`,
      },
    };
  }

  await run(
    "UPDATE assets SET service_key = ?, service_key_expires_at = ? WHERE id = ?",
    [json.key, json.expires_at ?? null, asset.id],
  );
  return { key: json.key };
}

/**
 * A service reply as JSON when it is JSON; otherwise the start of its text, so
 * a plain-text refusal (a proxy or policy message) still reaches the user.
 */
async function readServiceResponse<T>(res: Response): Promise<{ json: T | null; text: string }> {
  const raw = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(raw) as T, text: "" };
  } catch {
    return { json: null, text: raw.trim().slice(0, 300) };
  }
}

export interface EditResult {
  url: string;
  duration: number;
  size: number;
}

/** Run the resolved EDL on the managed edit service. */
export async function runEdit(
  edl: Edl,
  opts: { quality: string; filename: string },
  cfg: ExportConfig,
): Promise<{ result: EditResult } | { failure: ExportFailure }> {
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/video/edit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ edl, quality: opts.quality, filename: opts.filename }),
  });
  const { json, text } = await readServiceResponse<Partial<EditResult> & Partial<EdlInvalid> & { error?: string }>(res);

  if (res.status !== 200 || !json?.url) {
    return {
      failure: {
        error: json?.error ?? "edit_failed",
        detail: json?.detail ?? (text || `edit service returned ${res.status}`),
        ...(json?.path ? { path: json.path } : {}),
      },
    };
  }
  return { result: { url: json.url, duration: json.duration ?? 0, size: json.size ?? 0 } };
}

export interface AnalyzeResult {
  model: string;
  cuts: { start_ms: number; end_ms: number; label: string; keep: boolean }[];
  captions: { start_ms: number; end_ms: number; text: string }[];
  notes: string;
}

// The editorial framing — what to ask and the answer's shape — is THIS app's
// concern; the platform's analysis endpoint is a generic "your prompt, your
// schema" primitive over staged footage.
const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cuts", "captions", "notes"],
  properties: {
    cuts: {
      type: "array",
      description: "Segments of the footage in playback order",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_ms", "end_ms", "label", "keep"],
        properties: {
          start_ms: { type: "integer" },
          end_ms: { type: "integer" },
          label: { type: "string", description: "what happens in this segment" },
          keep: { type: "boolean", description: "true = recommended for the cut" },
        },
      },
    },
    captions: {
      type: "array",
      description: "Short on-screen caption lines with timing",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_ms", "end_ms", "text"],
        properties: {
          start_ms: { type: "integer" },
          end_ms: { type: "integer" },
          text: { type: "string" },
        },
      },
    },
    notes: { type: "string", description: "one short paragraph of editorial observations" },
  },
};

function analysisPrompt(mode: string, brief?: string, window?: SourceWindow): string {
  const wants =
    mode === "cuts"
      ? "Propose cuts only; return an empty captions array."
      : mode === "captions"
        ? "Propose captions only; return an empty cuts array."
        : "Propose both cuts and captions.";
  return (
    "You are a video editor's assistant. Watch the video and propose a CLEAN-UP edit of this " +
    "single clip: keep the good takes, drop dead air, false starts, filler and broken moments. " +
    "Cuts: the segments worth keeping, in playback order, with millisecond start/end timestamps " +
    "(tight in-points and out-points). " +
    "Captions: short on-screen lines matching the spoken content, with millisecond timing. " +
    "If the footage already shows subtitles or captions on screen, return an empty captions array: " +
    "a second set on top would cover the first. " +
    `${wants}${brief ? ` Context from the editor (the clip may sit inside a larger project): ${brief}` : ""}` +
    (window
      ? ` Only the part from ${window.start.toFixed(1)}s to ${window.end.toFixed(1)}s of this video is in the edit; ` +
        "everything outside it has already been cut. Propose segments inside that span only, " +
        "with timestamps measured from the start of the whole video."
      : "")
  );
}

// Flash-class multimodal model with video input; called on the ORG's own
// metered OpenRouter key (injected at deploy), so usage bills the org directly.
const ANALYSIS_MODEL = "google/gemini-3.7-flash";

/**
 * Watch one library asset and propose cuts + captions (millisecond
 * timestamps). Stages the asset if needed, gets a short-lived fetchable URL
 * from the platform, and calls the model directly on the org's OpenRouter key
 * — the model fetches the video itself; no bytes move through this worker.
 */
/** The part of a source a clip currently plays, in seconds into that source. */
export interface SourceWindow {
  start: number;
  end: number;
}

/**
 * Keep an analysis inside the clip's window. The model watches the whole
 * source; without this, a proposal could reach back before a trim the person
 * already made and put that footage back.
 */
/** Move every timestamp by `byMs`: from the analysis copy's clock to the source's. */
export function shiftResult(result: AnalyzeResult, byMs: number): AnalyzeResult {
  if (!byMs) return result;
  return {
    ...result,
    cuts: result.cuts.map((c) => ({ ...c, start_ms: c.start_ms + byMs, end_ms: c.end_ms + byMs })),
    captions: result.captions.map((c) => ({ ...c, start_ms: c.start_ms + byMs, end_ms: c.end_ms + byMs })),
  };
}

export function withinWindow(result: AnalyzeResult, window?: SourceWindow): AnalyzeResult {
  if (!window) return result;
  const lo = window.start * 1000;
  const hi = window.end * 1000;
  return {
    ...result,
    cuts: result.cuts
      .map((c) => ({ ...c, start_ms: Math.max(c.start_ms, lo), end_ms: Math.min(c.end_ms, hi) }))
      .filter((c) => c.end_ms - c.start_ms >= 100),
    captions: result.captions.filter((c) => c.start_ms >= lo && c.start_ms < hi),
  };
}

export async function analyzeAsset(
  assetId: string,
  opts: { mode?: string; prompt?: string; window?: SourceWindow },
  cfg: ExportConfig,
): Promise<{ result: AnalyzeResult } | { failure: ExportFailure }> {
  if (!cfg.openrouterKey) {
    return {
      failure: {
        error: "analysis_unavailable",
        detail: "no OpenRouter key available to this app — add one in the dashboard's API Keys settings",
      },
    };
  }

  const media = await analysisDataUrl(assetId, cfg, opts.window);
  if ("failure" in media) return media;
  // Watching a copy cut to the window, the model's clock starts at the window;
  // watching the whole source, it is told which part is in the edit.
  const cutToWindow = media.cut;

  const mode = ["cuts", "captions", "both"].includes(opts.mode ?? "") ? opts.mode! : "both";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: analysisPrompt(mode, opts.prompt, cutToWindow ? undefined : opts.window) },
            { type: "video_url", video_url: { url: media.dataUrl } },
          ],
        },
      ],
      max_tokens: 6000,
      temperature: 0.2,
      // NB: no provider.require_parameters — the Google endpoint honors
      // response_format in practice but doesn't advertise it, and requiring
      // the advertisement empties the routing pool (404 no endpoints).
      response_format: {
        type: "json_schema",
        json_schema: { name: "edit_analysis", strict: true, schema: ANALYSIS_SCHEMA },
      },
    }),
  });
  if (!res.ok) {
    return {
      failure: { error: "analyze_failed", detail: `model call failed (${res.status}): ${(await res.text()).slice(0, 300)}` },
    };
  }
  const completion = (await res.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  let parsed: Partial<AnalyzeResult> | null = null;
  try {
    parsed = JSON.parse(completion?.choices?.[0]?.message?.content ?? "");
  } catch {
    /* fall through to the failure below */
  }
  if (!parsed || !Array.isArray(parsed.cuts)) {
    return { failure: { error: "analyze_failed", detail: "model returned unparseable output — retry" } };
  }
  const result = shiftResult({ ...(parsed as AnalyzeResult), model: ANALYSIS_MODEL }, media.from * 1000);
  return { result: withinWindow(result, opts.window) };
}

// ── analysis delivery: base64 data URLs over a small proxy ──────────────────
// Models take video as base64 data URLs with a hard per-request cap (direct
// file URLs are NOT supported by the Google providers), so full-res footage
// never fits. Small originals go straight through; everything else gets a
// one-time 360p/24fps "analysis proxy" made by the edit service and cached in
// this app's storage. Timestamps map 1:1 — the proxy is the same timeline.

const DIRECT_ANALYSIS_BYTES = 12 * 1024 * 1024; // originals up to this go as-is
const ANALYSIS_HARD_CAP = 15 * 1024 * 1024; // absolute per-clip payload cap
const AUTOCUT_COMBINED_CAP = 14 * 1024 * 1024; // all clips in one request
const DIRECT_TYPES = new Set(["video/mp4", "video/webm", "video/mpeg", "video/quicktime", "video/mov"]);

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Bytes the model will watch for one asset: the original when it's small and
 * an accepted format, else the cached 360p proxy (made on first use).
 */
async function analysisBytes(
  asset: AssetRow,
  cfg: ExportConfig,
  window?: SourceWindow,
): Promise<{ bytes: ArrayBuffer; from: number; cut: boolean } | { failure: ExportFailure }> {
  if (asset.size > 0 && asset.size <= DIRECT_ANALYSIS_BYTES && DIRECT_TYPES.has(asset.content_type)) {
    const bytes = await getUploadBytes(asset.key);
    if (bytes) return { bytes, from: 0, cut: false };
  }

  // Only the part the clip plays. Rendering the whole source refused anything
  // over 5 minutes, which is every long master on the media service, even
  // when the clip itself was 20 seconds. Cached per window.
  if (window) {
    const key = `proxies/${asset.id}-${Math.round(window.start * 1000)}-${Math.round(window.end * 1000)}.mp4`;
    let bytes = await getUploadBytes(key);
    if (!bytes) {
      const staged = await ensureStagedSrc(asset.id, cfg);
      if ("failure" in staged) return staged;
      const proxied = await runEdit(
        {
          version: 1,
          output: { width: 640, height: 360, fps: 24, background: "#000000" },
          main: {
            elements: [
              { id: "p", type: "video", src: staged.src, trimStart: window.start, duration: window.end - window.start },
            ],
          },
          overlays: [],
          audio: [],
        } as Edl,
        { quality: "draft", filename: `proxy-${asset.id}.mp4` },
        cfg,
      );
      if ("failure" in proxied) {
        const detail = proxied.failure.detail.includes("max is")
          ? "this clip plays for more than 5 minutes — shorten it before analysis"
          : `could not build the analysis copy: ${proxied.failure.detail}`;
        return { failure: { error: "analyze_failed", detail } };
      }
      await copyOutput(proxied.result, key);
      bytes = await getUploadBytes(key);
    }
    if (!bytes) return { failure: { error: "analyze_failed", detail: "analysis copy missing — retry" } };
    if (bytes.byteLength > ANALYSIS_HARD_CAP) {
      return { failure: { error: "analyze_failed", detail: "clip too long for analysis — shorten it first" } };
    }
    return { bytes, from: window.start, cut: true };
  }

  if (!asset.proxy_key) {
    const staged = await ensureStagedSrc(asset.id, cfg);
    if ("failure" in staged) return staged;
    const proxied = await runEdit(
      {
        version: 1,
        output: { width: 640, height: 360, fps: 24, background: "#000000" },
        main: { elements: [{ id: "p", type: "video", src: staged.src }] },
        overlays: [],
        audio: [],
      } as Edl,
      { quality: "draft", filename: `proxy-${asset.id}.mp4` },
      cfg,
    );
    if ("failure" in proxied) {
      const detail = proxied.failure.detail.includes("max is")
        ? "clip is longer than 5 minutes — trim it before analysis"
        : `could not build the analysis proxy: ${proxied.failure.detail}`;
      return { failure: { error: "analyze_failed", detail } };
    }
    const key = `proxies/${asset.id}.mp4`;
    await copyOutput(proxied.result, key);
    await run("UPDATE assets SET proxy_key = ? WHERE id = ?", [key, asset.id]);
    asset.proxy_key = key;
  }

  const bytes = await getUploadBytes(asset.proxy_key);
  if (!bytes) return { failure: { error: "analyze_failed", detail: "analysis proxy missing — retry" } };
  if (bytes.byteLength > ANALYSIS_HARD_CAP) {
    return { failure: { error: "analyze_failed", detail: "clip too long for analysis — trim it first" } };
  }
  return { bytes, from: 0, cut: false };
}

/**
 * The video the model watches, and where in the source it starts: 0 for the
 * whole source, the window's start for a copy cut to the clip.
 */
async function analysisDataUrl(
  assetId: string,
  cfg: ExportConfig,
  window?: SourceWindow,
): Promise<{ dataUrl: string; byteLength: number; from: number; cut: boolean } | { failure: ExportFailure }> {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    return { failure: { error: "asset_not_found", detail: `no media-library asset with id "${assetId}"` } };
  }
  const res = await analysisBytes(asset, cfg, window);
  if ("failure" in res) return res;
  return {
    dataUrl: `data:video/mp4;base64,${bytesToBase64(res.bytes)}`,
    byteLength: res.bytes.byteLength,
    from: res.from,
    cut: res.cut,
  };
}

export interface AutocutSegment {
  clip_index: number;
  start_ms: number;
  end_ms: number;
  label: string;
  caption: string;
}
export interface AutocutResult {
  sequence: AutocutSegment[];
  notes: string;
}

const AUTOCUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sequence", "notes"],
  properties: {
    sequence: {
      type: "array",
      description: "The finished edit: segments across all clips, in output order",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clip_index", "start_ms", "end_ms", "label", "caption"],
        properties: {
          clip_index: { type: "integer", description: "0-based index into the attached clips" },
          start_ms: { type: "integer" },
          end_ms: { type: "integer" },
          label: { type: "string", description: "what this segment contributes" },
          caption: { type: "string", description: "short on-screen line for this segment, or empty" },
        },
      },
    },
    notes: { type: "string", description: "one short paragraph on the editorial choices" },
  },
};

const AUTOCUT_MAX_CLIPS = 8;

/**
 * The whole-project cut: ONE model call watches every clip together (context
 * is the unit of analysis — ordering and redundancy across clips can't be
 * judged one clip at a time) and returns the sequence for the brief. Runs on
 * the org's OpenRouter key; clips reach the model as presigned URLs.
 */
export async function autocutAssets(
  assets: { id: string; name: string }[],
  brief: string,
  cfg: ExportConfig,
): Promise<{ result: AutocutResult } | { failure: ExportFailure }> {
  if (!cfg.openrouterKey) {
    return {
      failure: {
        error: "analysis_unavailable",
        detail: "no OpenRouter key available to this app — add one in the dashboard's API Keys settings",
      },
    };
  }
  if (assets.length === 0 || assets.length > AUTOCUT_MAX_CLIPS) {
    return { failure: { error: "autocut_failed", detail: `select 1–${AUTOCUT_MAX_CLIPS} video clips` } };
  }

  const urls: string[] = [];
  let combined = 0;
  for (const a of assets) {
    const media = await analysisDataUrl(a.id, cfg);
    if ("failure" in media) return media;
    combined += media.byteLength;
    if (combined > AUTOCUT_COMBINED_CAP) {
      return {
        failure: {
          error: "autocut_failed",
          detail: "too much footage for one Auto-cut pass — use fewer or shorter clips (roughly 8 proxy-minutes total)",
        },
      };
    }
    urls.push(media.dataUrl);
  }

  const clipList = assets.map((a, i) => `Clip ${i} — "${a.name}"`).join("; ");
  const prompt =
    `You are a video editor. The attached videos are raw clips, in this order: ${clipList}. ` +
    `Cut them into one video, the most effective way: choose which segments to keep (millisecond ` +
    `start/end within each clip, tight in/out points), drop dead air, false starts, filler and ` +
    `redundancy across clips, and ORDER the segments for the strongest result — the output order ` +
    `is your sequence array, and it does not have to follow the clip order. Give each segment an ` +
    `optional short on-screen caption (empty string for none; always empty if the footage already ` +
    `shows subtitles on screen). Keep the total under 240 seconds ` +
    `unless the brief demands otherwise. ` +
    (brief ? `The video's purpose: ${brief}` : `No brief was given — aim for a tight, watchable cut.`);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...urls.map((url) => ({ type: "video_url", video_url: { url } })),
          ],
        },
      ],
      max_tokens: 6000,
      temperature: 0.3,
      // NB: no provider.require_parameters — the Google endpoint honors
      // response_format in practice but doesn't advertise it, and requiring
      // the advertisement empties the routing pool (404 no endpoints).
      response_format: {
        type: "json_schema",
        json_schema: { name: "autocut", strict: true, schema: AUTOCUT_SCHEMA },
      },
    }),
  });
  if (!res.ok) {
    return { failure: { error: "autocut_failed", detail: `model call failed (${res.status}): ${(await res.text()).slice(0, 300)}` } };
  }
  const completion = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  let parsed: AutocutResult | null = null;
  try {
    parsed = JSON.parse(completion?.choices?.[0]?.message?.content ?? "");
  } catch {
    /* handled below */
  }
  if (!parsed || !Array.isArray(parsed.sequence) || parsed.sequence.length === 0) {
    return { failure: { error: "autocut_failed", detail: "model returned no usable sequence — retry" } };
  }
  const bad = parsed.sequence.find(
    (s) => s.clip_index < 0 || s.clip_index >= assets.length || s.end_ms <= s.start_ms,
  );
  if (bad) {
    return { failure: { error: "autocut_failed", detail: "model returned an out-of-range segment — retry" } };
  }
  return { result: parsed };
}

/** Copy the finished MP4 into this app's storage; returns the storage key. */
export async function copyOutput(result: EditResult, key: string): Promise<void> {
  await putUploadFromUrl(result.url, key, "video/mp4", result.size);
}
