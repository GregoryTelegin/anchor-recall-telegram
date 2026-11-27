import { sha256TextChunks } from "./sha256";

const normalized = (value: unknown, key: string): unknown => {
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { toJSON?: unknown }).toJSON === "function")
    return (value as { toJSON(key: string): unknown }).toJSON(key);
  return value;
};
const omitted = (value: unknown): boolean => value === undefined || typeof value === "function" || typeof value === "symbol";
type JsonFrame = { kind: "value"; value: unknown; key: string; array?: boolean; ready?: boolean }
  | { kind: "array"; value: unknown[]; index: number; length: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number; separator: boolean };

/** Same canonical JSON as jsonFingerprint, emitted without a whole-library string. */
export function* jsonFingerprintChunks(source: unknown): IterableIterator<string> {
  const parents = new Set<object>(), stack: JsonFrame[] = [{ kind: "value", value: source, key: "" }];
  let chunk = "";
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.length) { parents.delete(frame.value); chunk += "]"; }
      else {
        if (frame.index) chunk += ",";
        stack.push({ ...frame, index: frame.index + 1 }, { kind: "value", value: frame.value[frame.index], key: String(frame.index), array: true });
      }
    } else if (frame.kind === "object") {
      let name: string | undefined, item: unknown;
      while (frame.index < frame.keys.length) {
        const key = frame.keys[frame.index++], value = normalized(frame.value[key], key);
        if (!omitted(value)) { name = key; item = value; break; }
      }
      if (name === undefined) { parents.delete(frame.value); chunk += "}"; }
      else {
        if (frame.separator) chunk += ",";
        chunk += JSON.stringify(name) + ":"; frame.separator = true;
        stack.push(frame, { kind: "value", value: item, key: name, ready: true });
      }
    } else {
      const value = frame.ready ? frame.value : normalized(frame.value, frame.key);
      if (omitted(value)) { if (frame.array) chunk += "null"; }
      else if (!value || typeof value !== "object") chunk += JSON.stringify(value);
      else {
        if (parents.has(value)) throw new TypeError("Converting circular structure to JSON");
        parents.add(value);
        if (Array.isArray(value)) { chunk += "["; stack.push({ kind: "array", value, index: 0, length: value.length }); }
        else {
          chunk += "{";
          // Native property enumeration keeps integer keys numeric even after sorting/insertion.
          const keys = Object.keys(Object.fromEntries(Object.keys(value).sort().map(name => [name, null])));
          stack.push({ kind: "object", value: value as Record<string, unknown>, keys, index: 0, separator: false });
        }
      }
    }
    // Deterministic boundaries preserve exact equality and UTF-8 hashing by each consumer.
    while (chunk.length >= 16384) {
      const last = chunk.charCodeAt(16383), width = last >= 0xd800 && last <= 0xdbff ? 16383 : 16384;
      yield chunk.slice(0, width); chunk = chunk.slice(width);
    }
  }
  if (chunk) yield chunk;
}

/** Legacy checksum bytes are unchanged; only the allocation strategy differs. */
export function jsonFingerprintDigest(value: unknown): string | undefined {
  const iterator = jsonFingerprintChunks(value), first = iterator.next();
  if (first.done) return undefined;
  function* pieces(): IterableIterator<string> { yield first.value; yield* iterator; }
  return "sha256:" + sha256TextChunks(pieces());
}

/** Exact token comparison, without replacing equality with a probabilistic hash match. */
export function jsonFingerprintEqual(a: unknown, b: unknown): boolean {
  const left = jsonFingerprintChunks(a), right = jsonFingerprintChunks(b);
  while (true) { const x = left.next(), y = right.next(); if (x.done || y.done) return x.done === y.done; if (x.value !== y.value) return false; }
}

/** JSON-only state clone; never joins a whole library into a single string. */
export function cloneJsonValue<T>(source: T): T {
  const parents = new Set<object>();
  const copy = (input: unknown, key: string, array = false): unknown => {
    const item = normalized(input, key), value = item instanceof Number || item instanceof String || item instanceof Boolean ? item.valueOf() : item;
    if (omitted(value)) return array ? null : undefined;
    if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
    if (!value || typeof value !== "object") return typeof value === "number" ? !Number.isFinite(value) ? null : value === 0 ? 0 : value : value;
    if (parents.has(value)) throw new TypeError("Converting circular structure to JSON"); parents.add(value);
    try {
      if (Array.isArray(value)) {
        const length = value.length, result = new Array<unknown>(length);
        for (let index = 0; index < length; index++) {
          const next = copy(value[index], String(index), true);
          if (index in Array.prototype) Object.defineProperty(result, index, { value: next, enumerable: true, writable: true, configurable: true });
          else result[index] = next;
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        const next = copy((value as Record<string, unknown>)[name], name); if (next === undefined) continue;
        if (name in Object.prototype) Object.defineProperty(result, name, { value: next, enumerable: true, writable: true, configurable: true });
        else result[name] = next;
      }
      return result;
    } finally { parents.delete(value); }
  };
  const result = copy(source, ""); if (result === undefined) throw new SyntaxError("Value is not JSON"); return result as T;
}
