// Uploads from this device, with the progress of each file.
//
// A video goes straight to the media service, resumably (tus): the bytes never
// pass through this app, so a clip of several gigabytes uploads like a short
// one, and arrives with the same playback, frames and transcript as footage
// imported from Drive. Stills and sound are small and are posted to the app.
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
  return new Promise((res) => {
    if (!/^(video|audio)\//.test(file.type) && !isVideoFile(file)) return res(null);
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    media.preload = "metadata";
    media.src = url;
    let settled = false;
    const done = (d: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      res(d);
    };
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null);
    media.onerror = () => done(null);
    setTimeout(() => done(null), 3_000);
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
  if (job.duration === null) {
    const duration = await probeDuration(job.file);
    if (!find(id)) return;
    patch(id, { duration });
  }
  if (isVideoFile(job.file)) {
    const ok = await toMediaService(id);
    if (ok) return;
    // No media service (local dev): fall through to the app's own storage.
    if (!find(id) || find(id)!.status === "failed") return;
  }
  toAppStorage(id);
}

/** False when the media service is not available here; the caller falls back. */
async function toMediaService(id: string): Promise<boolean> {
  let job = find(id)!;
  if (!job.uploadUrl) {
    const r = await fetch("/api/assets/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: job.name, size: job.size, duration: job.duration }),
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
    body: JSON.stringify({ uid: job.uid, name: job.name, type: job.file.type, size: job.size, duration: job.duration }),
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

/** Stop an upload and forget it. One still open on the media service is dropped there. */
export function cancelUpload(id: string) {
  const job = find(id);
  if (!job) return;
  jobs = jobs.filter((j) => j.id !== id);
  emit();
  job.xhr?.abort();
  if (job.tus) job.tus.abort().catch(() => {});
  if (job.uid) fetch(`/api/assets/uploads/${job.uid}`, { method: "DELETE" }).catch(() => {});
}
