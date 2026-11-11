// Uploads from this device, with the progress of each file.
//
// A video goes straight to the media service, resumably (tus): the bytes never
// pass through this app, so a clip of several gigabytes uploads like a short
// one, and arrives with the same playback, frames and transcript as footage
// imported from Drive. Stills and sound are small and are posted to the app.
//
// A video above 1080p takes another road to the same place: the service's
// playable copies stop at 1080p, so the file goes in parts to the service's
// own storage, which keeps it as sent for exports above 1080p.
//
// The queue lives here, outside the editor, so leaving the editor does not
// lose an upload in flight: it carries on, and reopening the editor shows it.

import { useSyncExternalStore } from "react";
import * as tus from "tus-js-client";
import type { Asset } from "./edit";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  /** `finishing`: the bytes are in, the library entry is being made. */
  status: "uploading" | "finishing" | "failed";
  error?: string;
}

interface Job extends UploadItem {
  file: File;
  duration: number | null;
  /** The picture's size, read from the file; null when the browser cannot read it. */
  shape?: { width: number; height: number } | null;
  /** An upload of the file as sent (a video above 1080p), kept so a retry resumes it. */
  original?: { id: string; uploadId: string; partSize: number; parts: number; done: Map<number, string> };
  /** The open upload on the media service, kept so a retry resumes it. */
  uid?: string;
  uploadUrl?: string;
  tus?: tus.Upload;
  xhr?: XMLHttpRequest;
}

let jobs: Job[] = [];
let snapshot: UploadItem[] = [];
const listeners = new Set<() => void>();
const arrivals = new Set<(a: Asset) => void>();

function emit() {
  snapshot = jobs.map(({ id, name, size, sent, status, error }) => ({ id, name, size, sent, status, error }));
  for (const fn of listeners) fn();
}

// Closing the tab ends an upload, so the browser asks first while one runs.
window.addEventListener("beforeunload", (e) => {
  if (jobs.some((j) => j.status !== "failed")) e.preventDefault();
});

function patch(id: string, fields: Partial<Job>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...fields } : j));
  emit();
}

function find(id: string): Job | undefined {
  return jobs.find((j) => j.id === id);
}

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
  );
}

/** Called with each upload once it is in the library. */
export function onUploaded(fn: (a: Asset) => void): () => void {
  arrivals.add(fn);
  return () => arrivals.delete(fn);
}

const VIDEO_NAME = /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|3gp)$/i;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || (!file.type && VIDEO_NAME.test(file.name));
}

/**
 * The media length, read from the file on this device: instant, and it does
 * not depend on how the file is laid out the way a probe over the network does.
 */
export function probeDuration(file: File): Promise<number | null> {
  return probe(file).then((p) => p.duration);
}

interface Probe {
  duration: number | null;
  shape: { width: number; height: number } | null;
}

function probe(file: File): Promise<Probe> {
  return new Promise((res) => {
    if (!/^(video|audio)\//.test(file.type) && !isVideoFile(file)) return res({ duration: null, shape: null });
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    media.preload = "metadata";
    media.src = url;
    let settled = false;
    const done = (found: boolean) => {
      if (settled) return;
      settled = true;
      const v = media as HTMLVideoElement;
      const result: Probe = {
        duration: found && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null,
        shape: found && v.videoWidth > 0 && v.videoHeight > 0 ? { width: v.videoWidth, height: v.videoHeight } : null,
      };
      URL.revokeObjectURL(url);
      res(result);
    };
    media.onloadedmetadata = () => done(true);
    media.onerror = () => done(false);
    setTimeout(() => done(false), 3_000);
  });
}

async function failure(r: Response): Promise<{ error?: string; detail?: string }> {
  return (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
}

function arrived(id: string, asset: Asset) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
  for (const fn of arrivals) fn(asset);
}

function fail(id: string, error: string) {
  if (!find(id)) return; // cancelled meanwhile
  patch(id, { status: "failed", error, tus: undefined, xhr: undefined });
}

export function startUpload(file: File) {
  const job: Job = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    sent: 0,
    status: "uploading",
    file,
    duration: null,
  };
  jobs = [...jobs, job];
  emit();
  run(job.id);
}

async function run(id: string) {
  const job = find(id);
  if (!job) return;
  patch(id, { status: "uploading", error: undefined });
  if (job.shape === undefined) {
    const found = await probe(job.file);
    if (!find(id)) return;
    patch(id, found);
  }
  if (isVideoFile(job.file)) {
    const ok = (await asOriginal(id)) || (await toMediaService(id));
    if (ok) return;
    // No media service (local dev): fall through to the app's own storage.
    if (!find(id) || find(id)!.status === "failed") return;
  }
  toAppStorage(id);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** PUT one part; resolves with the ETag the storage answers, or null when it did not land. */
function putPart(id: string, url: string, part: Blob, before: number): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => find(id) && patch(id, { sent: before + e.loaded });
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? xhr.getResponseHeader("ETag") : null);
    xhr.onerror = xhr.onabort = () => resolve(null);
    patch(id, { xhr });
    xhr.send(part);
  });
}

/**
 * Upload a video above 1080p as its original. True when this road took the
 * file (it arrived, failed, or was cancelled); false when the file should go
 * the usual way: at or below 1080p, no room for originals, or no service.
 */
async function asOriginal(id: string): Promise<boolean> {
  let job = find(id)!;
  if (job.uploadUrl) return false; // already on the usual road
  if (!job.original) {
    const s = job.shape;
    if (!s || Math.min(s.width, s.height) <= 1080) return false;
    const r = await fetch("/api/assets/originals", json({ name: job.name, size: job.size, width: s.width, height: s.height })).catch(() => null);
    if (!find(id)) return true;
    if (!r?.ok) return false;
    const o = (await r.json()) as { id: string; upload_id: string; part_size: number; parts: number };
    patch(id, { original: { id: o.id, uploadId: o.upload_id, partSize: o.part_size, parts: o.parts, done: new Map() } });
    job = find(id)!;
  }
  const o = job.original!;
  const base = `/api/assets/originals/${o.id}`;
  for (let n = 1; n <= o.parts; n++) {
    if (o.done.has(n)) continue;
    const before = (n - 1) * o.partSize;
    let etag: string | null = null;
    // A fresh link each try: one that failed may have run out.
    for (const wait of [0, 2000, 5000, 15000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!find(id)) return true;
      const links = await fetch(`${base}/parts`, json({ upload_id: o.uploadId, part_numbers: [n] })).catch(() => null);
      const url = links?.ok ? ((await links.json()) as { urls: Record<string, string> }).urls[n] : null;
      if (!url) continue;
      etag = await putPart(id, url, job.file.slice(before, before + o.partSize), before);
      if (etag || !find(id)) break;
    }
    if (!find(id)) return true;
    if (!etag) {
      if (o.done.size === 0) {
        // Not one part landed: the storage is not taking this upload at all, so
        // send the file the usual way. Its exports stay at 1080p.
        fetch(`${base}?upload_id=${encodeURIComponent(o.uploadId)}`, { method: "DELETE" }).catch(() => {});
        patch(id, { original: undefined, sent: 0, xhr: undefined });
        return false;
      }
      fail(id, "The connection dropped. Retry picks up where it stopped.");
      return true;
    }
    o.done.set(n, etag);
  }
  patch(id, { status: "finishing", sent: job.size, xhr: undefined });
  const parts = [...o.done].map(([part_number, etag]) => ({ part_number, etag }));
  const r = await fetch(`${base}/complete`, json({ upload_id: o.uploadId, parts, name: job.name, type: job.file.type, size: job.size, duration: job.duration })).catch(() => null);
  if (!find(id)) return true;
  if (!r?.ok) {
    fail(id, (r && (await failure(r)).detail) || "Uploaded, but not added to the library yet. Retry adds it.");
    return true;
  }
  arrived(id, (await r.json()) as Asset);
  return true;
}

/** False when the media service is not available here; the caller falls back. */
async function toMediaService(id: string): Promise<boolean> {
  let job = find(id)!;
  if (!job.uploadUrl) {
    const r = await fetch("/api/assets/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: job.name, type: job.file.type, size: job.size, duration: job.duration }),
    }).catch(() => null);
    if (!find(id)) return true;
    if (r?.status === 503) return false;
    if (!r?.ok) {
      fail(id, r ? (await failure(r)).detail || "Could not start the upload." : "Could not reach the app.");
      return true;
    }
    const opened = (await r.json()) as { uid: string; upload_url: string };
    patch(id, { uid: opened.uid, uploadUrl: opened.upload_url });
    const current = find(id);
    if (!current) return true;
    job = current;
  }

  const sent = await new Promise<boolean>((resolve) => {
    const upload = new tus.Upload(job.file, {
      uploadUrl: job.uploadUrl,
      // Stream takes chunks of whole 256 KiB blocks, at least 5 MB.
      chunkSize: 50 * 1024 * 1024,
      retryDelays: [0, 2000, 5000, 10000, 20000, 30000],
      onProgress: (bytes) => find(id) && patch(id, { sent: bytes }),
      onSuccess: () => resolve(true),
      // The raw error names the upload link, which is a capability: never show it.
      onError: () => {
        fail(id, "The connection dropped. Retry picks up where it stopped.");
        resolve(false);
      },
    });
    patch(id, { tus: upload });
    upload.start();
  });
  if (!sent || !find(id)) return true;

  patch(id, { status: "finishing", sent: job.size, tus: undefined });
  const r = await fetch("/api/assets/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: job.uid }),
  }).catch(() => null);
  if (!r?.ok) {
    fail(id, "Uploaded, but not added to the library yet. Retry adds it.");
    return true;
  }
  arrived(id, (await r.json()) as Asset);
  return true;
}

function toAppStorage(id: string) {
  const job = find(id)!;
  const form = new FormData();
  form.append("file", job.file);
  if (job.duration) form.append("duration", String(job.duration));
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/assets");
  xhr.upload.onprogress = (e) => find(id) && patch(id, { sent: e.loaded });
  xhr.onload = () => {
    if (xhr.status === 201) {
      try {
        arrived(id, JSON.parse(xhr.responseText) as Asset);
        return;
      } catch {
        /* fall through to the failure below */
      }
    }
    let detail = "";
    try {
      const body = JSON.parse(xhr.responseText) as { error?: string; detail?: string };
      detail = body.detail || body.error || "";
    } catch {
      /* not JSON: a proxy refused it, most often for size */
    }
    fail(id, detail || (xhr.status === 413 ? "This file is too large to upload here." : `Upload failed (${xhr.status}).`));
  };
  xhr.onerror = () => fail(id, "The connection dropped. Retry sends it again.");
  patch(id, { xhr });
  xhr.send(form);
}

export function retryUpload(id: string) {
  const job = find(id);
  if (!job || job.status !== "failed") return;
  run(id);
}

/**
 * Stop an upload and forget it. One opened on the media service is deleted
 * there, even if its bytes are all in: discarding means not keeping it.
 */
export function cancelUpload(id: string) {
  const job = find(id);
  if (!job) return;
  jobs = jobs.filter((j) => j.id !== id);
  emit();
  job.xhr?.abort();
  if (job.tus) job.tus.abort().catch(() => {});
  if (job.uid) fetch(`/api/assets/uploads/${job.uid}`, { method: "DELETE" }).catch(() => {});
  if (job.original) {
    fetch(`/api/assets/originals/${job.original.id}?upload_id=${encodeURIComponent(job.original.uploadId)}`, { method: "DELETE" }).catch(() => {});
  }
}
