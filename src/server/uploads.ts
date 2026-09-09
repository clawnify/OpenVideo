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
  const obj = await _bucket.get(key, { range: { offset, ...(length !== undefined ? { length } : {}) } });
  if (!obj) return null;
  return {
    data: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    size: obj.size,
  };
}

export async function getUploadBytes(key: string): Promise<ArrayBuffer | null> {
  const obj = await _bucket.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

export async function deleteUpload(key: string): Promise<void> {
  await _bucket.delete(key);
}

/** Filesystem-safe, collision-resistant key from an original filename. */
export function makeKey(filename: string): string {
  const clean = filename.toLowerCase().replace(/[^a-z0-9.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "file";
}
