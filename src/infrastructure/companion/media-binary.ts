import { invalid, keys, record, timestamp, token } from "../../domain/companion/protocol";
import { validateCompanionMediaChunk, validateCompanionMediaIdentity, COMPANION_MEDIA_CHUNK_BYTES,
  MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES } from "../../domain/companion/media";

export const COMPANION_MEDIA_BINARY_CONTENT_TYPE = "application/octet-stream";
export const MAX_COMPANION_MEDIA_FRAME_HEADER_BYTES = 16384;
export const MAX_COMPANION_MEDIA_FRAME_BYTES = 8 + MAX_COMPANION_MEDIA_FRAME_HEADER_BYTES + MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES;
const magic = 0x41524d42; // ARMB; no native allocation while the plugin module loads.

function metadata(value: unknown): asserts value is Record<string, unknown> & { payload: Record<string, unknown> } {
  record(value); keys(value, ["version", "method", "path", "scope", "epoch", "enrollment", "time", "nonce", "payload"]);
  invalid(value.version === 1 && value.method === "POST" && value.path === "/bridge/snapshot");
  token(value.scope); token(value.epoch); token(value.enrollment); token(value.nonce); timestamp(value.time);
  record(value.payload); keys(value.payload, ["operation", "asset", "offset"]);
  invalid(value.payload.operation === "media-chunk"); validateCompanionMediaIdentity(value.payload.asset);
  invalid(Number.isSafeInteger(value.payload.offset) && Number(value.payload.offset) >= 0
    && Number(value.payload.offset) < value.payload.asset.bytes && Number(value.payload.offset) % COMPANION_MEDIA_CHUNK_BYTES === 0);
}

/** The existing HMAC still covers the canonical envelope, including the exact file bytes. */
export function encodeCompanionMediaFrame(rawJSON: string): Uint8Array {
  const envelope: unknown = JSON.parse(rawJSON); record(envelope); record(envelope.payload);
  validateCompanionMediaChunk(envelope.payload, MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES);
  const bytes = Buffer.from(envelope.payload.data, "base64");
  invalid(bytes.toString("base64") === envelope.payload.data);
  const { data: _data, ...payload } = envelope.payload;
  const header = { ...envelope, payload }; metadata(header);
  const encoded = Buffer.from(JSON.stringify(header));
  invalid(encoded.byteLength > 0 && encoded.byteLength <= MAX_COMPANION_MEDIA_FRAME_HEADER_BYTES);
  const prefix = Buffer.alloc(8); prefix.writeUInt32BE(magic, 0); prefix.writeUInt32BE(encoded.byteLength, 4);
  return Buffer.concat([prefix, encoded, bytes]);
}

/** Reconstructs the JSON wire envelope before the unchanged authentication/replay checks. */
export function decodeCompanionMediaFrame(value: Uint8Array): string {
  invalid(value.byteLength >= 9 && value.byteLength <= MAX_COMPANION_MEDIA_FRAME_BYTES);
  const frame = Buffer.from(value); invalid(frame.readUInt32BE(0) === magic);
  const length = frame.readUInt32BE(4);
  invalid(length > 0 && length <= MAX_COMPANION_MEDIA_FRAME_HEADER_BYTES && frame.byteLength > 8 + length);
  const bytes = frame.subarray(8 + length); invalid(bytes.byteLength <= MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES);
  const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(8, 8 + length)));
  metadata(envelope);
  const payload = { ...envelope.payload, data: bytes.toString("base64") }; validateCompanionMediaChunk(payload, MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES);
  return JSON.stringify({ ...envelope, payload });
}
