const roundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const rotate = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

/** Incremental SHA-256; text chunk boundaries preserve split UTF-16 surrogate pairs. */
export function sha256TextChunks(chunks: Iterable<string>): string {
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64), pending = new Uint8Array(64), encoder = new TextEncoder();
  let used = 0, total = 0;
  const block = (view: DataView, offset: number): void => {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const first = words[index - 15], second = words[index - 2];
      const sigma0 = rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3);
      const sigma1 = rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10);
      words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const upper = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25), choose = (e & f) ^ (~e & g);
      const first = (h + upper + choose + roundConstants[index] + words[index]) >>> 0;
      const lower = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22), majority = (a & b) ^ (a & c) ^ (b & c);
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + lower + majority) >>> 0;
    }
    const updated = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index++) hash[index] += updated[index];
  };
  const bytes = (value: Uint8Array): void => {
    total += value.length;
    if (!Number.isSafeInteger(total)) throw new Error("SHA-256 input length is not representable");
    let offset = 0;
    if (used) {
      const count = Math.min(64 - used, value.length); pending.set(value.subarray(0, count), used); used += count; offset = count;
      if (used === 64) { block(new DataView(pending.buffer), 0); used = 0; }
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (; offset + 64 <= value.length; offset += 64) block(view, offset);
    if (offset < value.length) { pending.set(value.subarray(offset), 0); used = value.length - offset; }
  };
  let text = "", surrogate = "";
  const flush = (): void => {
    if (!text) return;
    let value = surrogate + text; text = ""; surrogate = "";
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { surrogate = value.slice(-1); value = value.slice(0, -1); }
    if (value) bytes(encoder.encode(value));
  };
  for (const chunk of chunks) {
    if (text.length + chunk.length > 65536) flush();
    text += chunk;
    if (text.length >= 65536) flush();
  }
  flush(); if (surrogate) bytes(encoder.encode(surrogate));
  pending.fill(0, used); pending[used] = 0x80;
  if (used >= 56) { block(new DataView(pending.buffer), 0); pending.fill(0); }
  const tail = new DataView(pending.buffer);
  tail.setUint32(56, Math.floor(total / 0x20000000)); tail.setUint32(60, (total * 8) >>> 0); block(tail, 0);
  return Array.from(hash, word => word.toString(16).padStart(8, "0")).join("");
}
