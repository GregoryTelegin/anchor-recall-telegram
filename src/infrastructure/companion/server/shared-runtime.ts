import { randomBytes, createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MAX_COMPANION_BRIDGE_BYTES, invalid, keys, record, token, timestamp } from "../../../domain/companion/protocol";
import { verifyPrivateTelegramUpdate } from "../telegram-api";
import { CompanionServer, isMediaMethod, type ServerConfig, type Transport, type TransportResult, type Outbound, type OwnedDelivery } from "./runtime";
import { miniAppLaunchUrl, validateMiniAppUrl } from "./study-plan-reminders";
import { validNativePollId } from "../../../features/companion/native-poll";
import { parseStudyPlanStartParameter } from "../../../domain/companion/study-plan-link";
import { ServerJournal } from "./journal";
import { equal } from "./bridge-contract";
import { SharedFileStore, privateDirectory, type SharedStore } from "./shared-store";
import type { CompanionMediaStore } from "../../../domain/companion/media";
import { CompanionMediaRoot } from "./media-store";
import type { PerformanceObserver } from "./metrics";
import { MiniAppSessions, MINIAPP_SESSION_TTL_MS, MINIAPP_FINISH_GRACE_MS, verifyMiniAppInitData } from "./miniapp-auth";

export interface SharedCompanionConfig {
  version: 1; enabled: true; botUsername: string; botToken: string; stateDirectory: string;
  host?: string; port?: number; externalTlsProxy?: boolean;
  pairingTtlMinutes?: number; maxAccounts?: number; maxPendingPairings?: number;
  sessionsLocal: number[]; quietUpdates?: boolean; miniAppUrl?: string;
}
export function validateSharedConfig(value: unknown): asserts value is SharedCompanionConfig {
  record(value); keys(value, ["version", "enabled", "botUsername", "botToken", "stateDirectory", "host", "port", "externalTlsProxy", "pairingTtlMinutes", "maxAccounts", "maxPendingPairings", "sessionsLocal", "quietUpdates", "miniAppUrl"]);
  invalid(value.version === 1 && value.enabled === true);
  invalid(typeof value.botUsername === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value.botUsername));
  invalid(typeof value.botToken === "string" && /^\d+:[A-Za-z0-9_-]{20,256}$/.test(value.botToken));
  invalid(typeof value.stateDirectory === "string" && isAbsolute(value.stateDirectory));
  invalid(value.host === undefined || typeof value.host === "string" && (["127.0.0.1", "::1", "localhost"].includes(value.host) || value.externalTlsProxy === true));
  invalid(value.externalTlsProxy === undefined || typeof value.externalTlsProxy === "boolean");
  invalid(value.port === undefined || Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535);
  for (const [key, max] of [["pairingTtlMinutes", 10], ["maxPendingPairings", 10000]] as const)
    invalid(value[key] === undefined || Number.isInteger(value[key]) && Number(value[key]) > 0 && Number(value[key]) <= max);
  invalid(value.maxAccounts === undefined || Number.isSafeInteger(value.maxAccounts) && Number(value.maxAccounts) > 0);
  invalid(Array.isArray(value.sessionsLocal) && value.sessionsLocal.length > 0 && value.sessionsLocal.length <= 24 && value.sessionsLocal.every(v => Number.isInteger(v) && Number(v) >= 0 && Number(v) < 1440));
  invalid(value.quietUpdates === undefined || typeof value.quietUpdates === "boolean");
  if (value.miniAppUrl !== undefined) validateMiniAppUrl(value.miniAppUrl);
}
interface Binding { scope: string; epoch: string; timeZone: string; }
interface Pair extends Binding {
  id: string; code: string; pollHash: string; expiresAt: number; state: "pending" | "approved" | "confirmed";
  userId?: number; chatId?: number; enrollment?: string; vaultName?: string; vaultScope?: string;
}
export interface SharedAccount extends Binding {
  enrollment: string; userId: number; chatId: number; bridgeSecret: string; webhookSecret: string; active: boolean;
  vaultName?: string; vaultScope?: string; preferred?: true;
}
interface Inbox { updateId: number; raw: string; receivedAt: number; enrollment?: string; candidates?: string[]; }
interface Notice { id: string; chatId: number; text: string; status: "queued" | "unknown"; confirmation?: string; callbackId?: string; miniAppEnrollment?: string; vaultChoices?: true; }
interface Disconnect { id: string; enrollment: string; userId: number; chatId: number; expiresAt: number; }
export interface SharedGatewayState {
  version: 1; botId: string; pairs: Pair[]; accounts: SharedAccount[]; inbox: Inbox[]; notices: Notice[]; disconnects: Disconnect[];
  cursor: number; lastUpdateAt: number; timeFloor: number; pairStarts: number[];
}
export interface SharedGatewayDependencies {
  observe?: PerformanceObserver;
  store?: SharedStore;
  openAccount?(account: SharedAccount, config: ServerConfig, transport: Transport, media?: CompanionMediaStore): Promise<{ runtime: CompanionServer; close(): Promise<void> }>;
  mediaRoot?: Pick<CompanionMediaRoot, "forAccount">;
}
/** Pacing adapters must recheck authorization after waiting, immediately before HTTP. */
export interface SharedTransport extends Transport {
  call(method: Outbound["method"], payload: Record<string, unknown>, authorize?: () => boolean, owned?: OwnedDelivery): Promise<TransportResult>;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (): string => randomBytes(24).toString("hex");
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{48}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validVaultName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100
  && value.trim() === value && !/[\p{Cc}]/u.test(value);
const ownedVaults = (state: SharedGatewayState, userId: number, chatId: number): SharedAccount[] =>
  state.accounts.filter(a => a.active && a.userId === userId && a.chatId === chatId);
const physicalVault = (source: Pick<SharedAccount, "scope" | "vaultScope">): string => source.vaultScope ?? source.scope;
const preferredVault = (owned: SharedAccount[]): SharedAccount | undefined => owned.find(a => a.preferred) ?? owned[0];
const baseVaultName = (account: SharedAccount, index: number): string => account.vaultName ?? `Хранилище ${index + 1}`;
function vaultName(account: SharedAccount, owned: SharedAccount[]): string {
  const index = owned.indexOf(account), name = baseVaultName(account, index);
  if (!owned.some((entry, i) => entry !== account && baseVaultName(entry, i) === name)) return name;
  const suffix = ` (${index + 1})`;
  return name.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "") + suffix;
}
function selectVault(owned: SharedAccount[], account: SharedAccount): void {
  for (const entry of owned) if (entry !== account) delete entry.preferred;
  account.preferred = true;
}
const planStartId = (text: unknown): string | undefined => typeof text === "string"
  ? parseStudyPlanStartParameter(/^\/start(?:@[A-Za-z0-9_]+)? (\S+)$/.exec(text)?.[1] ?? "") : undefined;
/** Retain command identity, not Telegram profile fields or echoed question/message bodies. */
function normalizedTelegramUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const value = update as Record<string, any>;
  if ([value.message, value.callback_query, value.poll_answer].filter(row => row !== undefined).length !== 1) return { update_id: update.update_id };
  const poll = value.poll_answer;
  if (poll !== undefined) {
    const options = poll?.option_ids;
    if (!validNativePollId(poll?.poll_id) || !positive(poll?.user?.id) || poll?.user?.is_bot === true || poll?.voter_chat !== undefined
      || !Array.isArray(options) || options.length > 12 || new Set(options).size !== options.length
      || !Array.from(options).every(option => Number.isSafeInteger(option) && option >= 0 && option < 12)) return { update_id: update.update_id };
    return { update_id: update.update_id, poll_answer: { poll_id: poll.poll_id, user: { id: poll.user.id }, option_ids: [...options].sort((a, b) => a - b) } };
  }
  const callback = value.callback_query, message = callback?.message ?? value.message;
  const from = callback?.from ?? message?.from, chat = message?.chat;
  if (chat?.type !== "private" || !positive(chat.id) || !positive(from?.id) || chat.id !== from.id || from.is_bot === true) return { update_id: update.update_id };
  const owner = { id: from.id }, target = { id: chat.id, type: "private" };
  if (callback) return typeof callback.id === "string" && callback.id.length > 0 && callback.id.length <= 128 && typeof callback.data === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(callback.data)
    ? { update_id: update.update_id, callback_query: { id: callback.id, from: owner, message: { chat: target }, data: callback.data } } : { update_id: update.update_id };
  if (typeof message?.text !== "string" || message.text.length > 4096) return { update_id: update.update_id };
  // A reply retains only its scalar target; Telegram's echoed body/profile is never journaled.
  if (message.reply_to_message !== undefined && !positive(message.reply_to_message?.message_id)) return { update_id: update.update_id };
  return { update_id: update.update_id, message: { from: owner, chat: target, text: message.text,
    ...(message.reply_to_message === undefined ? {} : { reply_to_message: { message_id: message.reply_to_message.message_id } }) } };
}
type MessageAnchor = { kind: "poll"; id: string; userId: number } | { kind: "reply"; id: number } | { kind: "callback" | "plan"; id: string };
function messageAnchor(update: Record<string, any>): MessageAnchor | undefined {
  if (update.poll_answer) return { kind: "poll", id: update.poll_answer.poll_id, userId: update.poll_answer.user.id };
  if (update.callback_query) {
    const data = update.callback_query.data as string;
    if (!/^(?:disconnect_|vault_)[a-f0-9]{48}$/.test(data)) return { kind: "callback", id: data };
  } else if (update.message?.reply_to_message) return { kind: "reply", id: update.message.reply_to_message.message_id };
  else {
    const planId = planStartId(update.message?.text);
    if (planId) return { kind: "plan", id: planId };
  }
  return undefined;
}
const binding = (value: Record<string, unknown>): void => {
  token(value.scope); token(value.epoch); invalid(typeof value.timeZone === "string" && value.timeZone.length <= 100);
  new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
};
/** One common bot; private enrollment journals retain all existing learning/receipt semantics. */
export class SharedCompanionGateway {
  private state!: SharedGatewayState;
  private active = false;
  private tail: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;
  private flushRequested = false;
  private readonly store: SharedStore;
  private readonly mediaRoot?: Pick<CompanionMediaRoot, "forAccount">;
  private readonly accounts = new Map<string, { runtime: CompanionServer; close(): Promise<void> }>();
  private readonly miniAppSessions = new MiniAppSessions();
  constructor(readonly config: SharedCompanionConfig, private readonly transport: SharedTransport, private readonly dependencies: SharedGatewayDependencies = {}) {
    validateSharedConfig(config); this.store = dependencies.store ?? new SharedFileStore(config.stateDirectory);
    this.mediaRoot = dependencies.mediaRoot ?? (dependencies.store === undefined ? new CompanionMediaRoot(config.stateDirectory) : undefined);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.then(() => undefined, () => undefined); return next; }
  private check(now: number): void { invalid(this.active, "gateway unavailable"); timestamp(now); invalid(now >= this.state.timeFloor, "server clock moved backwards"); }
  private validate(state: SharedGatewayState): void {
    record(state); keys(state, ["version", "botId", "pairs", "accounts", "inbox", "notices", "disconnects", "cursor", "lastUpdateAt", "timeFloor", "pairStarts"]);
    invalid(state.version === 1 && state.botId === this.config.botToken.split(":")[0]);
    timestamp(state.cursor); timestamp(state.lastUpdateAt); timestamp(state.timeFloor);
    invalid(Array.isArray(state.pairs) && state.pairs.length <= (this.config.maxPendingPairings ?? 1000));
    invalid(Array.isArray(state.accounts));
    invalid(this.config.maxAccounts === undefined || state.accounts.filter(account => account.active).length <= this.config.maxAccounts);
    invalid(Array.isArray(state.inbox) && state.inbox.length <= 10000 && Array.isArray(state.notices));
    invalid(state.notices.filter(notice => notice.status === "queued").length <= 1000);
    invalid(Array.isArray(state.disconnects) && state.disconnects.length <= 1000);
    invalid(Array.isArray(state.pairStarts) && state.pairStarts.length <= 60); state.pairStarts.forEach(timestamp);
    const unique = (values: unknown[]): void => invalid(new Set(values).size === values.length);
    unique(state.pairs.map(p => p.id)); unique(state.pairs.map(p => p.code)); unique(state.accounts.map(a => a.enrollment));
    unique(state.accounts.filter(a => a.active).map(a => JSON.stringify([a.userId, a.chatId, a.scope])));
    unique(state.accounts.filter(a => a.active).map(a => JSON.stringify([a.userId, a.chatId, physicalVault(a)])));
    unique(state.accounts.filter(a => a.active && a.preferred).map(a => a.userId));
    unique(state.inbox.map(i => i.updateId)); unique(state.notices.map(n => n.id)); unique(state.disconnects.map(d => d.id));
    for (const pair of state.pairs) {
      record(pair); keys(pair, ["scope", "epoch", "timeZone", "id", "code", "pollHash", "expiresAt", "state", "userId", "chatId", "enrollment", "vaultName", "vaultScope"]); binding(pair);
      invalid(pair.vaultName === undefined || validVaultName(pair.vaultName));
      if (pair.vaultScope !== undefined) token(pair.vaultScope);
      invalid(id(pair.id) && id(pair.code) && typeof pair.pollHash === "string" && /^[a-f0-9]{64}$/.test(pair.pollHash)); timestamp(pair.expiresAt);
      invalid(["pending", "approved", "confirmed"].includes(pair.state));
      invalid(pair.state === "pending" ? pair.userId === undefined && pair.chatId === undefined && pair.enrollment === undefined : positive(pair.userId) && positive(pair.chatId));
      invalid(pair.state !== "confirmed" ? pair.enrollment === undefined : id(pair.enrollment) && state.accounts.some(a => a.enrollment === pair.enrollment && a.userId === pair.userId && a.chatId === pair.chatId && a.scope === pair.scope && a.epoch === pair.epoch && a.timeZone === pair.timeZone));
    }
    for (const account of state.accounts) {
      record(account); keys(account, ["scope", "epoch", "timeZone", "enrollment", "userId", "chatId", "bridgeSecret", "webhookSecret", "active", "vaultName", "vaultScope", "preferred"]); binding(account);
      invalid(id(account.enrollment) && positive(account.userId) && account.chatId === account.userId && id(account.bridgeSecret) && id(account.webhookSecret) && account.bridgeSecret !== account.webhookSecret && typeof account.active === "boolean");
      invalid((account.vaultName === undefined || validVaultName(account.vaultName)) && (account.preferred === undefined || account.active && account.preferred === true));
      if (account.vaultScope !== undefined) token(account.vaultScope);
    }
    for (const item of state.inbox) {
      record(item); keys(item, ["updateId", "raw", "receivedAt", "enrollment", "candidates"]); timestamp(item.updateId); timestamp(item.receivedAt);
      invalid(typeof item.raw === "string" && Buffer.byteLength(item.raw) <= 65536 && (item.enrollment === undefined || id(item.enrollment) && state.accounts.some(a => a.enrollment === item.enrollment)));
      if (item.candidates !== undefined) {
        invalid(item.enrollment === undefined && Array.isArray(item.candidates) && item.candidates.length > 0 && item.candidates.every(candidate => id(candidate) && state.accounts.some(a => a.enrollment === candidate)));
        unique(item.candidates);
      }
      const update: unknown = JSON.parse(item.raw); record(update); invalid(update.update_id === item.updateId);
    }
    for (const item of state.notices) { record(item); keys(item, ["id", "chatId", "text", "status", "confirmation", "callbackId", "miniAppEnrollment", "vaultChoices"]); invalid(id(item.id) && positive(item.chatId) && typeof item.text === "string" && item.text.length <= 500 && ["queued", "unknown"].includes(item.status)); invalid(item.confirmation === undefined || id(item.confirmation)); invalid(item.callbackId === undefined || typeof item.callbackId === "string" && item.callbackId.length > 0 && item.callbackId.length <= 128);
      invalid(item.miniAppEnrollment === undefined || id(item.miniAppEnrollment) && !item.confirmation && !item.callbackId && state.accounts.some(a => a.enrollment === item.miniAppEnrollment && a.chatId === item.chatId));
      invalid(item.vaultChoices === undefined || item.vaultChoices === true && !item.confirmation && !item.callbackId && !item.miniAppEnrollment); }
    for (const item of state.disconnects) { record(item); keys(item, ["id", "enrollment", "userId", "chatId", "expiresAt"]); invalid(id(item.id) && id(item.enrollment) && positive(item.userId) && positive(item.chatId)); timestamp(item.expiresAt); invalid(state.accounts.some(a => a.enrollment === item.enrollment && a.userId === item.userId && a.chatId === item.chatId)); }
    invalid(Buffer.byteLength(JSON.stringify(state)) <= 20_000_000);
  }
  private async commit(state: SharedGatewayState): Promise<void> {
    this.validate(state);
    try { await this.store.save(state); } catch { this.active = false; throw new Error("gateway journal unavailable; restart required"); }
    this.state = state;
  }
  async start(): Promise<void> {
    await this.store.acquire();
    try {
      const loaded = await this.store.load();
      const state: SharedGatewayState = loaded as SharedGatewayState ?? { version: 1, botId: this.config.botToken.split(":")[0], pairs: [], accounts: [], inbox: [], notices: [], disconnects: [], cursor: 0, lastUpdateAt: 0, timeFloor: 0, pairStarts: [] };
      this.validate(state); await this.commit(state); this.active = true;
    } catch { await this.store.close(); throw new Error("gateway startup failed; preserve state for recovery"); }
  }
  private prune(state: SharedGatewayState, now: number): void { state.pairs = state.pairs.filter(pair => pair.expiresAt > now); state.disconnects = state.disconnects.filter(d => d.expiresAt > now); state.pairStarts = state.pairStarts.filter(at => at > now - 60000); state.timeFloor = now; }
  async pairStart(payload: unknown, now = Date.now()) {
    record(payload); keys(payload, ["version", "scope", "epoch", "timeZone", "vaultName", "vaultScope"]); invalid(payload.version === 1); binding(payload);
    const name = payload.vaultName, vaultScope = payload.vaultScope; invalid(name === undefined || validVaultName(name));
    if (vaultScope !== undefined) token(vaultScope);
    return this.serial(async () => {
      this.check(now); const next = clone(this.state); this.prune(next, now);
      invalid(next.pairs.length < (this.config.maxPendingPairings ?? 1000) && next.pairStarts.length < 60, "pairing capacity reached");
      const pollToken = randomBytes(32).toString("hex"), pair: Pair = { id: opaque(), code: opaque(), pollHash: hash(pollToken), expiresAt: now + (this.config.pairingTtlMinutes ?? 10) * 60000,
        scope: payload.scope as string, epoch: payload.epoch as string, timeZone: payload.timeZone as string, state: "pending",
        ...(name === undefined ? {} : { vaultName: name }), ...(vaultScope === undefined ? {} : { vaultScope }) };
      next.pairs.push(pair); next.pairStarts.push(now); await this.commit(next);
      return { pairingId: pair.id, startCode: pair.code, pollToken, expiresAt: pair.expiresAt, botUsername: this.config.botUsername };
    });
  }
  private async pairing(payload: unknown, now: number): Promise<Pair> {
    this.check(now); record(payload); keys(payload, ["pairingId", "pollToken"]);
    invalid(id(payload.pairingId) && typeof payload.pollToken === "string" && /^[a-f0-9]{64}$/.test(payload.pollToken), "invalid pairing");
    const pair = this.state.pairs.find(p => p.id === payload.pairingId);
    invalid(pair && equal(pair.pollHash, hash(payload.pollToken)), "invalid or expired pairing");
    if (pair.expiresAt <= now) { const next = clone(this.state); this.prune(next, now); await this.commit(next); throw new Error("pairing expired"); }
    return pair;
  }
  async pairStatus(payload: unknown, now = Date.now()) {
    return this.serial(async () => { const pair = await this.pairing(payload, now); return { state: pair.state, expiresAt: pair.expiresAt, ...(pair.userId === undefined ? {} : { telegramUserId: pair.userId }) }; });
  }
  async pairConfirm(payload: unknown, now = Date.now()) {
    return this.serial(async () => {
      const pair = await this.pairing(payload, now); invalid(pair.state !== "pending", "approve in Telegram first");
      const next = clone(this.state), current = next.pairs.find(p => p.id === pair.id)!;
      if (pair.state === "confirmed") invalid(next.accounts.some(a => a.enrollment === pair.enrollment && a.active), "pairing revoked");
      const owned = ownedVaults(next, current.userId!, current.chatId!);
      let account = owned.find(a => a.scope === current.scope);
      if (account) invalid(account.epoch === current.epoch && account.timeZone === current.timeZone, "vault already linked; reconcile before changing its enrollment");
      else {
        invalid(this.config.maxAccounts === undefined || next.accounts.filter(account => account.active).length < this.config.maxAccounts, "account capacity reached");
        account = { enrollment: opaque(), scope: current.scope, epoch: current.epoch, timeZone: current.timeZone, userId: current.userId!, chatId: current.chatId!, bridgeSecret: opaque(), webhookSecret: opaque(), active: true };
        next.accounts.push(account);
      }
      const vaultScope = account.vaultScope ?? current.vaultScope;
      invalid(!current.vaultScope || current.vaultScope === vaultScope, "vault already linked with another physical scope");
      invalid(owned.every(a => a === account || physicalVault(a) !== (vaultScope ?? account.scope)), "vault already linked to this Telegram account");
      if (vaultScope !== undefined) account.vaultScope = vaultScope;
      if (current.vaultName && !account.vaultName) account.vaultName = current.vaultName;
      current.state = "confirmed"; current.enrollment = account.enrollment; next.timeFloor = now; await this.commit(next);
      return { version: 1 as const, scope: account.scope, epoch: account.epoch, enrollment: account.enrollment, timeZone: account.timeZone, bridgeSecret: account.bridgeSecret };
    });
  }
  private async accountRuntime(account: SharedAccount) {
    let opened = this.accounts.get(account.enrollment); if (opened) return opened;
    const authorized = () => this.active && this.state.accounts.some(a => a.enrollment === account.enrollment && a.active);
    const target: Transport = { ready: () => authorized() && this.transport.ready?.() !== false,
      supportsNativePolls: () => authorized() && this.transport.supportsNativePolls?.() === true,
      cachedMedia: (enrollment, asset) => authorized() && enrollment === account.enrollment && this.transport.cachedMedia?.(account.enrollment, asset) === true,
      call: (method, payload, authorize, owned) => { const current = () => authorized() && authorize?.() !== false; invalid(current(), "enrollment archived");
        const media = isMediaMethod(method);
        // The authenticated account supplies the media namespace, never snapshot content.
        return this.transport.call(method, media ? { ...payload, enrollment: account.enrollment } : payload, current, owned);
      } };
    const config: ServerConfig = { enabled: true, scope: account.scope, epoch: account.epoch, enrollment: account.enrollment, ownerUserId: account.userId, ownerChatId: account.chatId,
      bridgeSecret: account.bridgeSecret, webhookSecret: account.webhookSecret, timeZone: account.timeZone, sessionsLocal: this.config.sessionsLocal, quietUpdates: this.config.quietUpdates,
      miniAppUrl: this.config.miniAppUrl, botUsername: this.config.botUsername, ...(this.config.miniAppUrl ? { miniAppVaultId: account.enrollment } : {}) };
    const media = this.mediaRoot?.forAccount(account.enrollment);
    if (this.dependencies.openAccount) opened = await this.dependencies.openAccount(account, config, target, media);
    else {
      const accountsRoot = join(this.config.stateDirectory, "accounts"), directory = join(accountsRoot, account.enrollment);
      await mkdir(accountsRoot, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await privateDirectory(accountsRoot);
      await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await privateDirectory(directory);
      const journalPath = join(directory, "journal.json");
      try { const info = await lstat(journalPath); invalid(info.isFile() && !info.isSymbolicLink()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const journal = new ServerJournal(journalPath, this.dependencies.observe); await journal.acquire();
      try { const runtime = new CompanionServer(config, journal, target, media, this.dependencies.observe); await runtime.start(); opened = { runtime, close: () => journal.close() }; }
      catch { await journal.close(); throw new Error("account journal unavailable"); }
    }
    this.accounts.set(account.enrollment, opened); return opened;
  }
  async bridge(path: string, raw: string, signature: string, now = Date.now(), binary = false) {
    invalid(["/bridge/snapshot", "/bridge/pending", "/bridge/ack"].includes(path) && Buffer.byteLength(raw) <= MAX_COMPANION_BRIDGE_BYTES);
    return this.serial(async () => {
      this.check(now); const envelope: unknown = JSON.parse(raw); record(envelope);
      const account = this.state.accounts.find(a => a.enrollment === envelope.enrollment && a.active); invalid(account, "unknown or archived enrollment");
      return (await this.accountRuntime(account)).runtime.bridge(path, raw, signature, now, binary);
    });
  }
  async miniAppAuthenticate(payload: unknown, now = Date.now()) {
    record(payload); keys(payload, ["initData", "vaultId", "planId"]); const planId = payload.planId;
    invalid(typeof payload.initData === "string" && (payload.vaultId === undefined || id(payload.vaultId))
      && (planId === undefined || payload.vaultId === undefined && typeof planId === "string" && /^[a-f0-9]{64}$/.test(planId)));
    return this.serial(async () => {
      this.check(now); invalid(this.config.miniAppUrl, "Mini App unavailable");
      const identity = verifyMiniAppInitData(payload.initData as string, this.config.botToken, now);
      const owned = ownedVaults(this.state, identity.userId, identity.chatId);
      let account = payload.vaultId === undefined ? preferredVault(owned) : owned.find(a => a.enrollment === payload.vaultId);
      if (typeof planId === "string" && owned.length > 1) {
        const target = await this.anchoredTarget(owned, { kind: "plan", id: planId }, false, now);
        account = !target.waiting && target.matches.length === 1 ? target.matches[0] : undefined;
      }
      invalid(account, "Mini App unauthorized");
      return this.miniAppVaultSession(account, owned, now);
    });
  }
  async miniAppSwitchVault(sessionToken: string, payload: unknown, now = Date.now()) {
    record(payload); keys(payload, ["vaultId"]); invalid(id(payload.vaultId), "Mini App unauthorized");
    return this.serial(async () => {
      const previous = this.miniAppAccount(sessionToken, now), next = clone(this.state);
      const owned = ownedVaults(next, previous.userId, previous.chatId);
      const account = owned.find(a => a.enrollment === payload.vaultId); invalid(account, "Mini App unauthorized");
      if (!account.preferred) {
        selectVault(owned, account); next.timeFloor = now; await this.commit(next);
      }
      return this.miniAppVaultSession(account, owned, now, sessionToken);
    });
  }
  private miniAppVaultSession(account: SharedAccount, owned: SharedAccount[], now: number, previousToken?: string) {
    const session = this.miniAppSessions.issue({ enrollment: account.enrollment, userId: account.userId, epoch: account.epoch }, now, previousToken);
    return { ...session, storageScope: hash(JSON.stringify(["miniapp-storage-v1", this.state.botId, account.userId, account.enrollment, account.scope, account.epoch])),
      vaultId: account.enrollment, vaults: owned.map(entry => ({ id: entry.enrollment, name: vaultName(entry, owned) })) };
  }
  private miniAppAccount(sessionToken: string, now: number): SharedAccount {
    this.check(now); invalid(this.config.miniAppUrl, "Mini App unauthorized");
    const binding = this.miniAppSessions.get(sessionToken, now);
    const account = binding && this.state.accounts.find(a => a.active && a.enrollment === binding.enrollment && a.userId === binding.userId && a.epoch === binding.epoch);
    invalid(account, "Mini App unauthorized"); return account;
  }
  async miniAppStudy(sessionToken: string, payload: unknown, now = Date.now()) {
    return this.serial(async () => {
      const account = this.miniAppAccount(sessionToken, now);
      const view = await (await this.accountRuntime(account)).runtime.miniApp(payload, now);
      const active = ["question", "result", "waiting", "paused"].includes(view.status);
      const lessonDeadline = view.status !== "paused" ? view.session?.deadlineAt : undefined;
      const lessonCap = view.session?.startedAt === undefined ? undefined : view.session.startedAt + MINIAPP_SESSION_TTL_MS;
      const deadline = lessonDeadline === undefined ? lessonCap : Math.min(lessonCap ?? Infinity, lessonDeadline + MINIAPP_FINISH_GRACE_MS);
      const expiresAt = active ? this.miniAppSessions.setExpiry(sessionToken, deadline, now)
        : this.miniAppSessions.expiresAt(sessionToken, now);
      invalid(expiresAt !== undefined, "Mini App unauthorized");
      return { ...view, connectionExpiresAt: expiresAt };
    });
  }
  async miniAppMedia(sessionToken: string, assetId: string, now = Date.now()) {
    return this.serial(async () => {
      const account = this.miniAppAccount(sessionToken, now);
      return (await this.accountRuntime(account)).runtime.miniAppMedia(assetId, now);
    });
  }
  nextUpdateOffset(now = Date.now()): number | undefined {
    // Telegram may randomize IDs after a week without updates; its queue lasts only 24h.
    return this.state?.lastUpdateAt > 0 && now - this.state.lastUpdateAt < 6 * 86400000 ? this.state.cursor + 1 : undefined;
  }
  private notice(state: SharedGatewayState, chatId: number, text: string): Notice {
    // Unknown deliveries are durable non-retry evidence, not a lifetime queue quota.
    invalid(state.notices.filter(notice => notice.status === "queued").length < 1000, "notice capacity reached");
    const notice: Notice = { id: opaque(), chatId, text, status: "queued" }; state.notices.push(notice); return notice;
  }
  private async anchoredTarget(accounts: SharedAccount[], anchor: MessageAnchor, waitForDelivery: boolean, now: number) {
    const matches: SharedAccount[] = [];
    let waiting = false;
    for (const account of accounts) {
      try {
        const { runtime } = await this.accountRuntime(account);
        const owned = anchor.kind === "poll" ? runtime.ownsPoll(anchor.id, anchor.userId)
          : anchor.kind === "reply" ? runtime.ownsReply(anchor.id)
            : anchor.kind === "plan" ? runtime.ownsPlanLaunch(anchor.id, now) : runtime.ownsCallback(anchor.id);
        if (owned) matches.push(account);
        else if (account.active && (!(await runtime.health()).active || waitForDelivery && (anchor.kind === "poll" && runtime.pollDeliveryPending()
          || anchor.kind === "reply" && runtime.replyDeliveryPending()))) waiting = true;
      } catch { if (account.active) waiting = true; }
    }
    return { matches, waiting };
  }
  async telegramUpdate(update: unknown, now = Date.now()): Promise<void> {
    record(update); timestamp(update.update_id); invalid(Number(update.update_id) < Number.MAX_SAFE_INTEGER);
    const normalized = normalizedTelegramUpdate(update), raw = JSON.stringify(normalized); invalid(Buffer.byteLength(raw) <= 65536);
    await this.serial(async () => {
      this.check(now); const next = clone(this.state);
      if (next.lastUpdateAt > 0 && update.update_id as number <= next.cursor && now - next.lastUpdateAt < 6 * 86400000) return;
      invalid(next.inbox.length < 10000, "inbox capacity reached");
      const source = normalized as Record<string, any>, message = source.callback_query?.message ?? source.message, from = source.callback_query?.from ?? message?.from;
      const owned = source.poll_answer ? ownedVaults(next, source.poll_answer.user.id, source.poll_answer.user.id)
        : message?.chat?.type === "private" && message.chat.id === from?.id && from?.is_bot !== true ? ownedVaults(next, from.id, message.chat.id) : [];
      const anchor = messageAnchor(source);
      const requireExactTarget = anchor && owned.length > 0
        && next.accounts.filter(a => a.userId === owned[0].userId && a.chatId === owned[0].chatId).length > 1;
      let account = requireExactTarget ? undefined : preferredVault(owned);
      if (source.poll_answer) {
        if (account && anchor) {
          const target = await this.anchoredTarget([account], anchor, true, now);
          if (!target.waiting && !target.matches.length) account = undefined;
        }
      }
      next.inbox.push({ updateId: update.update_id as number, raw, receivedAt: now, ...(account ? { enrollment: account.enrollment } : {}),
        ...(requireExactTarget ? { candidates: owned.map(entry => entry.enrollment) } : {}) });
      next.cursor = update.update_id as number; next.lastUpdateAt = now; next.timeFloor = now; await this.commit(next);
      await this.processInbox(now);
    });
  }
  private async processInbox(now = this.state.timeFloor): Promise<void> {
    for (const item of [...this.state.inbox]) {
      const update = JSON.parse(item.raw) as Record<string, any>, callback = update.callback_query, message = callback?.message ?? update.message;
      const from = callback?.from ?? message?.from, chat = message?.chat;
      const principal = chat?.type === "private" && positive(chat.id) && positive(from?.id) && chat.id === from.id && from.is_bot !== true;
      let next = clone(this.state), enrollment = item.enrollment;
      const anchor = messageAnchor(update);
      if (item.candidates && anchor) {
        const ownerId = update.poll_answer?.user.id ?? (principal ? from.id : undefined);
        const candidates = next.accounts.filter(a => a.userId === ownerId && a.chatId === ownerId && item.candidates!.includes(a.enrollment));
        const target = await this.anchoredTarget(candidates, anchor, item.receivedAt <= now && now - item.receivedAt <= 30000, now);
        if (target.matches.length === 1 && !(anchor.kind === "plan" && target.waiting)) {
          const bound = next.inbox.find(row => row.updateId === item.updateId)!;
          enrollment = target.matches[0].enrollment; bound.enrollment = enrollment; delete bound.candidates;
          await this.commit(next); next = clone(this.state);
        } else if (target.waiting && target.matches.length < 2) continue;
        else if (anchor.kind === "plan" && principal) {
          this.notice(next, chat.id, target.matches.length > 1
            ? "Этот план есть в нескольких хранилищах. Выберите нужное и откройте план в приложении."
            : "Занятие по этой ссылке уже недоступно. Выберите хранилище и откройте план в приложении.").vaultChoices = true;
        }
      }
      if (update.poll_answer) {
        const vote = update.poll_answer, account = next.accounts.find(a => a.enrollment === enrollment && a.userId === vote.user.id);
        if (account && !account.active) continue;
        if (account) {
          try {
            const { runtime } = await this.accountRuntime(account);
            verifyPrivateTelegramUpdate(item.raw, account.webhookSecret, { enabled: true, webhookSecret: account.webhookSecret, userId: account.userId, chatId: account.chatId });
            if (!(await runtime.health()).active) continue;
            if (runtime.ownsPoll(vote.poll_id, vote.user.id)) await runtime.webhook(item.raw, account.webhookSecret, item.receivedAt);
            else if (runtime.pollDeliveryPending() && item.receivedAt <= now && now - item.receivedAt <= 30000) continue;
          } catch { continue; }
        }
      } else if (principal && typeof message?.text === "string" && !callback && message.reply_to_message === undefined && /^\/start(?:@[A-Za-z0-9_]+)? [a-f0-9]{48}$/.test(message.text)) {
        const code = message.text.slice(message.text.lastIndexOf(" ") + 1), pair = next.pairs.find(p => p.code === code);
        if (pair && pair.state === "pending" && pair.expiresAt > item.receivedAt) {
          pair.state = "approved"; pair.userId = from.id; pair.chatId = chat.id;
          this.notice(next, chat.id, "Подтвердите подключение в Obsidian. До подтверждения материалы не передаются.");
        }
      } else if (principal) {
        const owned = ownedVaults(next, from.id, chat.id);
        const account = next.accounts.find(a => a.enrollment === enrollment && a.userId === from.id && a.chatId === chat.id);
        if (!callback && message.reply_to_message === undefined && /^\/vaults(?:@[A-Za-z0-9_]+)?$/i.test(message.text)) {
          if (owned.length) this.notice(next, chat.id, "Выберите хранилище. Оно будет открываться по умолчанию.").vaultChoices = true;
          else this.notice(next, chat.id, "Подключите хранилище в настройках Telegram в Obsidian.");
        } else if (callback && /^vault_[a-f0-9]{48}$/.test(callback.data)) {
          const chosen = owned.find(a => a.enrollment === callback.data.slice(6));
          if (chosen) {
            selectVault(owned, chosen);
            const notice = this.notice(next, chat.id, `Выбрано хранилище «${vaultName(chosen, owned)}».`);
            if (this.config.miniAppUrl) notice.miniAppEnrollment = chosen.enrollment;
          }
          this.notice(next, chat.id, "").callbackId = callback.id;
        } else if (callback && /^disconnect_[a-f0-9]{48}$/.test(callback.data)) {
          const confirmation = next.disconnects.find(d => d.id === callback.data.slice(11) && d.userId === from.id && d.chatId === chat.id && d.expiresAt > item.receivedAt);
          const target = confirmation && owned.find(a => a.enrollment === confirmation.enrollment);
          if (target) {
            target.active = false; delete target.preferred;
            next.disconnects = next.disconnects.filter(d => d.enrollment !== target.enrollment);
            this.miniAppSessions.revokeEnrollment(target.enrollment);
            next.pairs = next.pairs.filter(p => !(p.userId === target.userId && p.chatId === target.chatId
              && (p.enrollment === target.enrollment || physicalVault(p) === physicalVault(target))));
            this.notice(next, chat.id, "Хранилище отключено. Его ответы сохранены в архиве.");
            this.notice(next, chat.id, "").callbackId = callback.id;
          }
        } else if (account && !account.active) continue; // Archived answers stay bound to their original vault.
        else if (account && !callback && message.reply_to_message === undefined && /^\/disconnect(?:@[A-Za-z0-9_]+)?$/i.test(message.text)) {
          next.disconnects = next.disconnects.filter(d => d.expiresAt > item.receivedAt && d.enrollment !== account.enrollment);
          invalid(next.disconnects.length < 1000); const confirmation = opaque();
          next.disconnects.push({ id: confirmation, enrollment: account.enrollment, userId: account.userId, chatId: account.chatId, expiresAt: item.receivedAt + 300000 });
          this.notice(next, chat.id, `Отключить «${vaultName(account, owned)}»? Неподтверждённые ответы сохранятся в архиве. Кнопка действует 5 минут.`).confirmation = confirmation;
        } else if (account) {
          const raw = JSON.stringify({ update_id: update.update_id, ...(callback ? { callback_query: callback } : { message: update.message }) });
          try { verifyPrivateTelegramUpdate(raw, account.webhookSecret, { enabled: true, webhookSecret: account.webhookSecret, userId: account.userId, chatId: account.chatId }); }
          catch { next.inbox = next.inbox.filter(i => i.updateId !== item.updateId); await this.commit(next); continue; }
          try {
            const { runtime } = await this.accountRuntime(account);
            if (anchor?.kind === "reply" && !runtime.ownsReply(anchor.id) && runtime.replyDeliveryPending() && now - item.receivedAt <= 30000) continue;
            await runtime.webhook(raw, account.webhookSecret, item.receivedAt);
            // A full content-worker pool must not hold another chat's button acknowledgement.
            if (callback && this.flushing) void runtime.flushAcknowledgements().catch(() => undefined);
          }
          catch { continue; } // Preserve this user's durable inbox; other accounts keep working.
        } else if (typeof message?.text === "string" && message.text === "/start") {
          this.notice(next, chat.id, "Откройте Telegram в настройках Anchor Recall и нажмите подключение, чтобы получить личную ссылку.");
        }
      }
      next.inbox = next.inbox.filter(i => i.updateId !== item.updateId); await this.commit(next);
    }
  }
  async tick(now = Date.now()): Promise<void> {
    await this.serial(async () => {
      this.check(now); await this.processInbox(now);
      for (const account of this.state.accounts.filter(a => a.active)) { try { await (await this.accountRuntime(account)).runtime.tick(now); } catch { /* One unavailable journal does not impersonate another account. */ } }
    });
  }
  async flush(): Promise<void> {
    if (this.transport.ready?.() === false) return;
    if (this.flushing) { this.flushRequested = true; return this.flushing; }
    this.flushing = (async () => {
      do {
        this.flushRequested = false;
        await this.tail; invalid(this.active);
        const chats = [...new Set([...this.state.notices.filter(n => n.status === "queued").map(n => n.chatId),
          ...this.state.accounts.filter(a => a.active && this.accounts.has(a.enrollment)).map(a => a.chatId)])];
        let cursor = 0;
        // One worker owns a chat's notices and content; slow uploads only occupy one of four slots.
        const worker = async () => {
          while (cursor < chats.length) {
            const chatId = chats[cursor++];
            for (;;) {
              const notice = await this.serial(async () => {
                invalid(this.active); const found = this.state.notices.find(n => n.chatId === chatId && n.status === "queued"); if (!found) return undefined;
                const next = clone(this.state); next.notices.find(n => n.id === found.id)!.status = "unknown"; await this.commit(next); return found;
              });
              if (!notice) break;
              try {
                const owned = notice.vaultChoices ? ownedVaults(this.state, chatId, chatId) : [];
                const launch = notice.miniAppEnrollment && this.config.miniAppUrl
                  ? { miniAppUrl: this.config.miniAppUrl, vaultId: notice.miniAppEnrollment } : undefined;
                const keyboard = notice.confirmation ? [[{ text: "Отключить хранилище", callback_data: "disconnect_" + notice.confirmation }]]
                  : launch ? [[{ text: "Открыть занятие", web_app: { url: miniAppLaunchUrl(launch.miniAppUrl, undefined, launch.vaultId) } }]]
                    : owned.map(account => [{ text: vaultName(account, owned), callback_data: "vault_" + account.enrollment }]);
                const payload = notice.callbackId ? { callback_query_id: notice.callbackId }
                  : { chat_id: notice.chatId, text: notice.text, disable_notification: true, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } };
                await this.transport.call(notice.callbackId ? "answerCallbackQuery" : "sendMessage", payload,
                  () => !launch || this.state.accounts.some(a => a.active && a.enrollment === launch.vaultId && a.chatId === notice.chatId), launch);
              }
              catch { continue; }
              await this.serial(async () => { const next = clone(this.state); next.notices = next.notices.filter(n => n.id !== notice.id); await this.commit(next); });
            }
            for (const account of ownedVaults(this.state, chatId, chatId)) {
              const opened = this.accounts.get(account.enrollment); if (!opened) continue;
              try { await opened.runtime.flush(); } catch { /* Preserve unavailable accounts without starving another user's delivery. */ }
              if (this.state.inbox.some(item => (item.enrollment === account.enrollment || item.candidates?.includes(account.enrollment))
                && ["poll", "reply"].includes(messageAnchor(JSON.parse(item.raw))?.kind ?? ""))) await this.serial(async () => {
                const pending = this.state.inbox.length; await this.processInbox();
                if (this.state.inbox.length < pending) this.flushRequested = true;
              });
            }
          }
        };
        // Drain every worker even if storage fails, so shutdown never abandons an in-flight request.
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, chats.length) }, worker));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      } while (this.flushRequested);
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  async drain(): Promise<void> { await this.flushing; await this.tail; for (const opened of this.accounts.values()) await opened.runtime.drain(); }
  async health() { await this.tail; return { active: this.active, accounts: this.state?.accounts.filter(a => a.active).length ?? 0, archivedAccounts: this.state?.accounts.filter(a => !a.active).length ?? 0, pendingPairings: this.state?.pairs.filter(p => p.state !== "confirmed").length ?? 0, inbox: this.state?.inbox.length ?? 0, unknownDeliveries: this.state?.notices.filter(n => n.status === "unknown").length ?? 0 }; }
  async close(): Promise<void> { await this.drain(); this.active = false; for (const opened of this.accounts.values()) await opened.close(); this.accounts.clear(); await this.store.close(); }
}
