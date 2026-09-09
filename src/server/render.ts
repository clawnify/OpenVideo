import { getUploadBytes } from "./uploads";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

interface Asset {
  key: string;
}

interface RenderArgs {
  html: string;
  fps: number;
  assets: Asset[];
  filename: string;
  servicesUrl?: string;
  token: string;
}

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
 * Render a composition to MP4 via the managed Clawnify render service
 * (services.clawnify.com/video/render — a Cloudflare Sandbox running
 * HyperFrames). Only the assets actually referenced by the HTML are shipped,
 * inline as base64 (the app's R2 uploads sit behind perimeter auth, so we
 * can't hand the service a fetchable URL).
 *
 * Returns the MP4 bytes. Throws with the service's error detail on failure.
 */
export async function renderComposition(args: RenderArgs): Promise<ArrayBuffer> {
  const referenced = args.assets.filter((a) => args.html.includes(`assets/${a.key}`));

  const assetPayload = [];
  for (const a of referenced) {
    const bytes = await getUploadBytes(a.key);
    if (!bytes) continue;
    assetPayload.push({ path: a.key, data_base64: bytesToBase64(bytes) });
  }

  const base = args.servicesUrl || DEFAULT_SERVICES_URL;
  const res = await fetch(`${base}/video/render`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      html: args.html,
      fps: args.fps,
      format: "mp4",
      filename: args.filename,
      assets: assetPayload,
    }),
  });

  if (!res.ok) {
    let detail = `render service returned ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      detail = j.detail || j.error || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  return res.arrayBuffer();
}
