/** Closure-free: embedded in the Mini App. Every reuse is authorized again before returning a blob. */
export function createMiniAppMediaCache(maxBytes = 64 * 1024 * 1024, maxEntries = 128) {
  type Asset = { id: string; bytes: number; kind: string };
  const entries = new Map<string, Blob>();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("invalid media cache budget");
  let bytes = 0, owner = "", generation = 0;
  const failure = (status = 0): Error & { status: number } => Object.assign(new Error("media unavailable"), { status });
  function clear(): void { entries.clear(); bytes = 0; owner = ""; generation++; }
  function forget(id: string): void { const value = entries.get(id); if (value) { entries.delete(id); bytes -= value.size; } }
  function remember(id: string, blob: Blob): void {
    forget(id);
    if (blob.size > maxBytes) return;
    while (entries.size && (bytes + blob.size > maxBytes || entries.size >= maxEntries)) forget(entries.keys().next().value!);
    entries.set(id, blob); bytes += blob.size;
  }
  async function load(asset: Asset, bearer: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
    if (!/^[a-f0-9]{64}$/.test(asset.id) || typeof bearer !== "string" || !bearer || bearer.length > 512 || /[\u0000-\u001f\u007f]/.test(bearer)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 50000000 || !["image", "audio", "video"].includes(asset.kind)) throw failure();
    if (owner !== bearer) { clear(); owner = bearer; }
    const started = generation, cached = entries.get(asset.id), etag = '"' + asset.id + '"';
    const response = await fetcher("/miniapp/media/" + asset.id, { method: "GET", headers: { Authorization: "Bearer " + bearer,
      ...(cached ? { "If-None-Match": etag } : {}) }, signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    if (response.status === 401 || response.status === 403) { clear(); throw failure(response.status); }
    if (generation !== started || signal.aborted) throw failure();
    if (response.headers.get("etag") !== etag) throw failure();
    let blob: Blob;
    if (response.status === 304) { if (!cached) throw failure(); blob = cached; }
    else {
      if (!response.ok) throw failure(response.status);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== asset.bytes) throw failure();
      blob = await response.blob();
    }
    if (generation !== started || signal.aborted || blob.size !== asset.bytes || !blob.type.startsWith(asset.kind + "/")) throw failure();
    remember(asset.id, blob); return blob;
  }
  return { load, clear, forget, stats: () => ({ bytes, entries: entries.size }) };
}
