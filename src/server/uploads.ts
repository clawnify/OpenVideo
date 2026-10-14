let _bucket: R2Bucket;

export function initUploads(bucket: R2Bucket) {
  _bucket = bucket;
}

export async function putUpload(
  key: string,
  data: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
): Promise<void> {
  await _bucket.put(key, data, { httpMetadata: { contentType } });
}

/**
 * Stream a file from a URL straight into storage, never holding it in memory.
 * A streamed put needs its length up front, so it comes from the response's
 * Content-Length, or from `sizeHint` when the server leaves that out.
 */
export async function putUploadFromUrl(
  url: string,
  key: string,
  contentType?: string,
  sizeHint?: number,
): Promise<{ size: number; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? sizeHint);
  if (!Number.isFinite(size) || size <= 0) throw new Error("download has no length");
  const type = contentType || res.headers.get("content-type") || "application/octet-stream";
  const fixed = new FixedLengthStream(size);
  const pipe = res.body.pipeTo(fixed.writable);
  await putUpload(key, fixed.readable, type);
  await pipe;
  return { size, contentType: type };
}

export async function getUpload(
  key: string,
): Promise<{ data: ReadableStream; contentType: string; size: number } | null> {
  const obj = await _bucket.get(key);
  if (!obj) return null;
  return {
    data: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    size: obj.size,
  };
}

/** Byte-range read — media seeking / metadata probing need 206 responses. */
export async function getUploadRange(
  key: string,
  offset: number,
  length?: number,
): Promise<{ data: ReadableStream; contentType: string; size: number } | null> {
  let obj: R2ObjectBody | null;
  try {
    obj = await _bucket.get(key, { range: { offset, ...(length !== undefined ? { length } : {}) } });
  } catch {
    // Storage without ranged reads (e.g. a sandboxed preview) — slice the whole
    // object instead. Those stores cap file size, so reading it all is bounded.
    const whole = await _bucket.get(key);
    if (!whole) return null;
    const bytes = await whole.arrayBuffer();
    const end = length !== undefined ? Math.min(offset + length, bytes.byteLength) : bytes.byteLength;
    return {
      data: new Response(bytes.slice(offset, end)).body!,
      contentType: whole.httpMetadata?.contentType || "application/octet-stream",
      size: whole.size,
    };
  }
  if (!obj) return null;
  return {
    data: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    size: obj.size,
  };
}

/**
 * A stored object as an HTTP response, honouring a `Range: bytes=a-b` header:
 * media elements seek with byte ranges, and metadata probing of moov-at-end
 * files is unusably slow without 206 responses. `headers` adds to (and can
 * override) the defaults, e.g. caching or a download filename.
 */
export async function serveUpload(
  key: string,
  range: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : undefined;
    const obj = await getUploadRange(key, start, end !== undefined ? end - start + 1 : undefined);
    if (!obj) return null;
    const last = end !== undefined ? Math.min(end, obj.size - 1) : obj.size - 1;
    return new Response(obj.data, {
      status: 206,
      headers: {
        "Content-Type": obj.contentType,
        "Content-Range": `bytes ${start}-${last}/${obj.size}`,
        "Content-Length": String(last - start + 1),
        "Accept-Ranges": "bytes",
        ...headers,
      },
    });
  }

  const obj = await getUpload(key);
  if (!obj) return null;
  return new Response(obj.data, {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
      "Accept-Ranges": "bytes",
      ...headers,
    },
  });
}

export async function hasUpload(key: string): Promise<boolean> {
  return (await _bucket.head(key)) !== null;
}

export async function getUploadBytes(key: string): Promise<ArrayBuffer | null> {
  const obj = await _bucket.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

// R2 deletes one key or a batch in a single request (up to 1000 keys), so a
// caller cleaning up several objects passes the whole array, not a call each.
export async function deleteUpload(key: string | string[]): Promise<void> {
  await _bucket.delete(key);
}

/** Filesystem-safe, collision-resistant key from an original filename. */
export function makeKey(filename: string): string {
  const clean = filename.toLowerCase().replace(/[^a-z0-9.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "file";
}
