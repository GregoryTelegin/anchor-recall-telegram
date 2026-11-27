import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";

const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;

function acceptsGzip(header: IncomingMessage["headers"]["accept-encoding"]): boolean {
  if (typeof header !== "string") return false;
  const qualities = new Map<string, number>();
  for (const part of header.split(",")) {
    const match = /^\s*([a-z*]+)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    if (!match) return false;
    const name = match[1].toLowerCase(), value = match[2] === undefined ? 1 : Number(match[2]);
    qualities.set(name, Math.min(qualities.get(name) ?? 1, value));
  }
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}

/** Negotiated text compression is decoded by the browser; private responses stay non-cacheable. */
export async function sendCompanionText(request: IncomingMessage, response: ServerResponse, text: string): Promise<void> {
  response.setHeader("Vary", "Accept-Encoding");
  const raw = Buffer.from(text);
  if (raw.length >= 1024 && raw.length <= MAX_COMPRESS_BYTES && acceptsGzip(request.headers["accept-encoding"])) {
    const compressed = await new Promise<Buffer>((resolve, reject) => gzip(raw, { level: 6 }, (error, value) => error ? reject(error) : resolve(value)));
    if (compressed.length < raw.length) {
      response.setHeader("Content-Encoding", "gzip"); response.setHeader("Content-Length", compressed.length);
      response.end(compressed); return;
    }
  }
  response.setHeader("Content-Length", raw.length); response.end(raw);
}
