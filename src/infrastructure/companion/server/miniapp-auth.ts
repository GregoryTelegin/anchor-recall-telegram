import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { invalid, keys, record, timestamp, token as validateToken } from "../../../domain/companion/protocol";

export const MINIAPP_INIT_DATA_MAX_AGE_MS = 5 * 60000;
export const MINIAPP_SESSION_TTL_MS = 90 * 60000;
export const MINIAPP_FINISH_GRACE_MS = 5 * 60000;
const futureToleranceMs = 30000, maxInitDataBytes = 16384;
export interface MiniAppIdentity { userId: number; chatId: number; authDate: number; }
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Telegram's bot-token HMAC procedure: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export function verifyMiniAppInitData(raw: string, botToken: string, now = Date.now()): MiniAppIdentity {
  try {
    timestamp(now);
    invalid(typeof botToken === "string" && /^\d+:[A-Za-z0-9_-]{20,256}$/.test(botToken));
    invalid(typeof raw === "string" && raw.length > 0 && raw.length <= maxInitDataBytes && Buffer.byteLength(raw, "utf8") <= maxInitDataBytes);
    const fields = new Map<string, string>();
    for (const part of raw.split("&")) {
      const equals = part.indexOf("="); invalid(equals > 0);
      const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
      const key = decode(part.slice(0, equals)), value = decode(part.slice(equals + 1));
      invalid(/^[a-z_]{1,64}$/.test(key) && !fields.has(key) && !/[\u0000-\u001f\u007f]/u.test(value)); fields.set(key, value);
    }
    const hash = fields.get("hash"); invalid(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
    fields.delete("hash");
    // The optional signature field is signed too; only hash is omitted for bot-token verification.
    const dataCheckString = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = createHmac("sha256", secret).update(dataCheckString).digest();
    invalid(timingSafeEqual(expected, Buffer.from(hash, "hex")));
    const authDate = fields.get("auth_date"); invalid(typeof authDate === "string" && /^[1-9]\d{0,12}$/.test(authDate));
    const authenticatedAt = Number(authDate) * 1000;
    invalid(Number.isSafeInteger(authenticatedAt) && authenticatedAt <= now + futureToleranceMs && now - authenticatedAt <= MINIAPP_INIT_DATA_MAX_AGE_MS);
    const user: unknown = JSON.parse(fields.get("user") ?? "null"); record(user);
    invalid(positiveId(user.id) && (user.is_bot === undefined || user.is_bot === false));
    const chatType = fields.get("chat_type"); invalid(chatType === undefined || chatType === "private" || chatType === "sender");
    const chatRaw = fields.get("chat");
    if (chatRaw !== undefined) {
      const chat: unknown = JSON.parse(chatRaw); record(chat); invalid(chat.type === "private" && chat.id === user.id);
    }
    return { userId: user.id, chatId: user.id, authDate: authenticatedAt };
  } catch { throw new Error("Mini App authorization rejected"); }
}

export interface MiniAppSessionBinding { enrollment: string; userId: number; epoch: string; }
interface Session extends MiniAppSessionBinding { expiresAt: number; hardExpiresAt: number; }
function validateBinding(value: MiniAppSessionBinding): void {
  record(value); keys(value, ["enrollment", "userId", "epoch"]);
  invalid(typeof value.enrollment === "string" && /^[a-f0-9]{48}$/.test(value.enrollment) && positiveId(value.userId)); validateToken(value.epoch);
}

/** Bearer credentials live only in memory; callers must recheck the active paired enrollment on every request. */
export class MiniAppSessions {
  private readonly rows = new Map<string, Session>();
  private readonly users = new Map<number, Set<string>>();
  private timeFloor = 0;
  private advance(now: number): void { timestamp(now); invalid(now >= this.timeFloor, "Mini App session clock rollback"); this.timeFloor = now; }
  private remove(token: string): void {
    const row = this.rows.get(token); if (!row) return;
    this.rows.delete(token); const user = this.users.get(row.userId); user?.delete(token); if (!user?.size) this.users.delete(row.userId);
  }
  private prune(now: number): void {
    // Lesson leases may expire out of issuance order; admission reclaims all expired rows.
    for (const [token, row] of this.rows) if (row.expiresAt <= now) this.remove(token);
  }
  private active(token: string, now: number): Session | undefined {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return;
    try { this.advance(now); } catch { return; }
    const row = this.rows.get(token);
    if (row && row.expiresAt <= now) { this.remove(token); return; }
    return row;
  }
  issue(binding: MiniAppSessionBinding, now = Date.now(), previousToken?: string): { token: string; expiresAt: number } {
    validateBinding(binding); this.advance(now); this.prune(now);
    const previous = previousToken === undefined ? undefined : this.rows.get(previousToken);
    invalid(previousToken === undefined || previous?.userId === binding.userId, "Mini App unauthorized");
    invalid(Number.isSafeInteger(now + MINIAPP_SESSION_TTL_MS));
    const user = this.users.get(binding.userId), replace = (user?.size ?? 0) >= 3;
    invalid(this.rows.size < 10000 || replace, "Mini App session capacity reached");
    let token = randomBytes(32).toString("hex");
    while (this.rows.has(token)) token = randomBytes(32).toString("hex");
    if (replace) this.remove([...user!].find(candidate => candidate !== previousToken)!);
    const expiresAt = Math.min(now + MINIAPP_SESSION_TTL_MS, previous?.expiresAt ?? Infinity);
    this.rows.set(token, { ...binding, expiresAt, hardExpiresAt: expiresAt });
    const tokens = this.users.get(binding.userId) ?? new Set<string>(); tokens.add(token); this.users.set(binding.userId, tokens);
    return { token, expiresAt };
  }
  get(token: string, now = Date.now()): MiniAppSessionBinding | undefined {
    const row = this.active(token, now);
    return row ? { enrollment: row.enrollment, userId: row.userId, epoch: row.epoch } : undefined;
  }
  expiresAt(token: string, now = Date.now()): number | undefined { return this.active(token, now)?.expiresAt; }
  /** The current lesson can reshape its lease, never revive or outlive the issued credential. */
  setExpiry(token: string, expiresAt: number | undefined, now = Date.now()): number | undefined {
    if (expiresAt !== undefined) timestamp(expiresAt);
    const row = this.active(token, now); if (!row) return;
    row.expiresAt = Math.min(expiresAt ?? row.hardExpiresAt, row.hardExpiresAt); return row.expiresAt;
  }
  revoke(token: string): void { this.remove(token); }
  revokeEnrollment(enrollment: string): void { for (const [token, row] of this.rows) if (row.enrollment === enrollment) this.remove(token); }
}
