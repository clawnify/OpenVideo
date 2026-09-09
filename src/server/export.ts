// Export pipeline for footage edit projects.
//
// An export resolves the EDL's "asset:<id>" references to staged sources on
// the managed edit service, runs the edit there, and copies the MP4 back into
// this app's storage. Staging is a cache: each library asset is uploaded to
// the service once and reused across exports; staged copies expire after ~30
// days and are re-staged transparently. All media moves as fixed-length
// streams — nothing is buffered in the worker.

import { get, run } from "./db";
import { getUpload, getUploadBytes, putUpload } from "./uploads";
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
  const staged = new Map<string, string>();
  for (const assetId of collectAssetIds(edl)) {
    const res = await ensureStagedSrc(assetId, cfg);
    if ("failure" in res) return res;
    staged.set(assetId, res.src);
  }
  return { edl: substituteAssetSrcs(edl, (id) => staged.get(id)!) };
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

  const json = (await res.json().catch(() => null)) as
    | { key?: string; expires_at?: string; error?: string; detail?: string }
    | null;
  if (res.status !== 201 || !json?.key) {
    return {
      failure: {
        error: json?.error ?? "staging_failed",
        detail: `could not stage "${asset.name}": ${json?.detail ?? `service returned ${res.status}`}`,
      },
    };
  }

  await run(
    "UPDATE assets SET service_key = ?, service_key_expires_at = ? WHERE id = ?",
    [json.key, json.expires_at ?? null, asset.id],
  );
  return { key: json.key };
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
  const json = (await res.json().catch(() => null)) as
    | (Partial<EditResult> & Partial<EdlInvalid> & { error?: string })
    | null;

  if (res.status !== 200 || !json?.url) {
    return {
      failure: {
        error: json?.error ?? "edit_failed",
        detail: json?.detail ?? `edit service returned ${res.status}`,
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

function analysisPrompt(mode: string, brief?: string): string {
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
    `${wants}${brief ? ` Context from the editor (the clip may sit inside a larger project): ${brief}` : ""}`
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
export async function analyzeAsset(
  assetId: string,
  opts: { mode?: string; prompt?: string },
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

  const media = await analysisDataUrl(assetId, cfg);
  if ("failure" in media) return media;

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
            { type: "text", text: analysisPrompt(mode, opts.prompt) },
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
  return { result: { ...(parsed as AnalyzeResult), model: ANALYSIS_MODEL } };
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
): Promise<{ bytes: ArrayBuffer } | { failure: ExportFailure }> {
  if (asset.size <= DIRECT_ANALYSIS_BYTES && DIRECT_TYPES.has(asset.content_type)) {
    const bytes = await getUploadBytes(asset.key);
    if (bytes) return { bytes };
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
  return { bytes };
}

async function analysisDataUrl(
  assetId: string,
  cfg: ExportConfig,
): Promise<{ dataUrl: string; byteLength: number } | { failure: ExportFailure }> {
  const asset = await get<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    return { failure: { error: "asset_not_found", detail: `no media-library asset with id "${assetId}"` } };
  }
  const res = await analysisBytes(asset, cfg);
  if ("failure" in res) return res;
  return { dataUrl: `data:video/mp4;base64,${bytesToBase64(res.bytes)}`, byteLength: res.bytes.byteLength };
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
    `optional short on-screen caption (empty string for none). Keep the total under 240 seconds ` +
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
  const res = await fetch(result.url);
  if (!res.ok || !res.body) throw new Error(`output download failed (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? result.size);
  const fixed = new FixedLengthStream(size);
  const pipe = res.body.pipeTo(fixed.writable);
  await putUpload(key, fixed.readable, "video/mp4");
  await pipe;
}
