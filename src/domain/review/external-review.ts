import { cloneJsonValue } from "../../shared/json-digest";
import { compactSourceFingerprint, isCompactSourceFingerprint } from "../cards/import-source-identity";
import type { SourceFileRecord } from "../anchors/source-catalog";
import { SOURCE_REPAIR_ANCHOR_FIELDS } from "../anchors/source-anchor-fields";
import type { Reminder, ReviewRating } from "./types";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import type { DailyWorkloadKind } from "./daily-workload";
import { getRecallReferenceAnswer } from "../cards/recall-test-core";
import { normalizeTestAnswer, type AnswerMatchMode } from "../cards/recall-core";
import { validateCardAttachments } from "../cards/card-attachments";
import type { CompanionMediaAttachment } from "../companion/media";
import { projectCompanionExercise, companionExerciseQuestion, companionExerciseReference, type CompanionExercise } from "../companion/exercises";
import { COMPANION_STUDY_COPY_TTL } from "../companion/capacity";

export const EXTERNAL_CLOCK_SKEW = 5 * 60000;
/** Authorization identifiers must never use the general ID helper's weak fallback. */
export function createExternalReviewToken(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure randomness is unavailable; external reviews are disabled");
  return globalThis.crypto.randomUUID();
}
export const EXTERNAL_OFFER_TTL = COMPANION_STUDY_COPY_TTL;
/** Working set only; committed older receipts remain in the device-local archive. */
export const MAX_EXTERNAL_RECEIPTS = 10000;
export interface ExternalCoreAttempt {
  id: string; scope: string; epoch: string; cardId: string; revision: string; sequence: number;
  mode: "core"; occurredAt: number; receivedAt: number; rating: ReviewRating; correct: boolean;
}
export type ExternalCoreStatus = "applied" | "stale" | "missing" | "epoch-mismatch" | "ineligible" | "local-session-active" | "expired" | "clock-mismatch";
export interface ExternalCoreReceipt {
  attempt: ExternalCoreAttempt; status: ExternalCoreStatus;
  reviewEventId?: string; nextDueAt?: number; charge?: { day: number; kind: DailyWorkloadKind };
}
/** Self-evaluation must retain every author-specified evaluation criterion. */
export function externalCoreReference(card: Reminder): string {
  const test = card.test;
  if (!test) return "";
  if (test.kind !== "free") { const exercise = projectCompanionExercise(test); return exercise ? companionExerciseReference(exercise) : ""; }
  if (test.evaluationMode === "exact") return getRecallReferenceAnswer(test);
  return test.expectedAnswer + (test.selfCheckCriteria?.length ? "\n\nРљСЂРёС‚РµСЂРёРё СЃР°РјРѕРїСЂРѕРІРµСЂРєРё:\n" + test.selfCheckCriteria.map(c => "вЂў " + c).join("\n") : "");
}
/** Conservative text-only boundary: never invite a grade without authored media/hints. */
export function externalCoreTextSupported(card: Reminder, includeAttachments = false): boolean {
  const t = card.test;
  if (!t || !["self", "exact"].includes(t.evaluationMode)) return false;
  const exercise = t.kind === "free" ? undefined : projectCompanionExercise(t);
  if (t.kind !== "free" && (!exercise || t.evaluationMode !== "exact" || t.acceptedAnswers !== undefined || t.selfCheckCriteria !== undefined)) return false;
  if (!includeAttachments && (t.attachments?.length || t.hints?.length)) return false;
  if (includeAttachments) {
    const attachments = validateCardAttachments(t.attachments);
    if (!attachments.valid || attachments.attachments?.some(item => item.clip)) return false;
    if (t.hints !== undefined && (!Array.isArray(t.hints) || t.hints.length > 10
      || Array.from(t.hints).some(hint => typeof hint !== "string" || !hint.trim() || hint.length > 2000))) return false;
  }
  const reference = externalCoreReference(card);
  if (t.kind === "free" && t.evaluationMode === "exact") {
    if (t.answerMatchMode !== undefined && t.answerMatchMode !== "text" && t.answerMatchMode !== "literal") return false;
    if (t.acceptedAnswers !== undefined) {
      if (!Array.isArray(t.acceptedAnswers) || !t.acceptedAnswers.length || t.acceptedAnswers.length > 12
        || Array.from(t.acceptedAnswers).some(answer => typeof answer !== "string" || !answer.trim() || answer.length > 2000
          || t.answerMatchMode !== "literal" && !normalizeTestAnswer(answer))) return false;
    } else if (t.answerMatchMode === "literal" ? !reference.trim() : !reference.split(/[\n|]+/).some(answer => !!normalizeTestAnswer(answer))) return false;
  }
  const question = exercise ? companionExerciseQuestion(exercise, t.prompt) : t.prompt;
  return !!t.prompt && !!reference && question.length <= 1800 && reference.length <= 1800
    && !/!\[|<(?:img|audio|video|iframe|object|embed|svg|picture|canvas)\b/i.test(t.prompt + "\n" + reference + "\n" + (t.evaluationMode === "exact" ? t.acceptedAnswers?.join("\n") ?? "" : "") + "\n" + (t.hints?.join("\n") ?? ""));
}
export interface ExternalCoreOfferBatch {
  scope: string; epoch: string; timeZone: string; issuedAt: number; expiresAt: number;
  cards: { cardId: string; revision: string; materialId: string; materialTitle: string; question: string; reference: string; dueAt: number; eligible: true;
    evaluationMode?: "exact"; acceptedAnswers?: string[]; answerMatchMode?: AnswerMatchMode; hints?: string[]; media?: CompanionMediaAttachment[]; exercise?: CompanionExercise; offline?: string }[];
}
export interface ExternalCoreOffer { token: string; cardId: string; fingerprint: string; issuedAt: number; expiresAt: number; }
export interface ExternalReviews {
  version: 1; scope: string; epoch: string; timeZone: string;
  offers: ExternalCoreOffer[]; receipts: ExternalCoreReceipt[];
}
/** Reopening the bridge must not spend another capability for an unchanged card.
 * Terminal receipts require a fresh token; existing offers stay valid for delayed uploads. */
export function findReusableExternalCoreOffer(state: ExternalReviews, cardId: string, fingerprint: string, now: number): ExternalCoreOffer | undefined {
  const answered = new Set(state.receipts.map(receipt => receipt.attempt.revision));
  let reusable: ExternalCoreOffer | undefined;
  for (const offer of state.offers) {
    if (offer.cardId !== cardId || offer.fingerprint !== fingerprint || offer.issuedAt > now
      || offer.expiresAt <= now + 60_000 || answered.has(offer.token)) continue;
    if (!reusable || offer.expiresAt > reusable.expiresAt) reusable = offer;
  }
  return reusable ? { ...reusable } : undefined;
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const check: (v: unknown) => asserts v = v => { if (!v) throw new Error("Invalid external review state"); };
const keys = (v: Record<string, unknown>, allowed: string[]) => check(Object.keys(v).every(k => allowed.includes(k)));
const token = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && Number.isFinite(new Date(v).getTime());
export function validateExternalCoreAttempt(v: unknown): asserts v is ExternalCoreAttempt {
  check(obj(v)); keys(v, ["id", "scope", "epoch", "cardId", "revision", "sequence", "mode", "occurredAt", "receivedAt", "rating", "correct"]);
  check([v.id, v.scope, v.epoch, v.cardId, v.revision].every(token));
  check(v.mode === "core" && time(v.sequence) && v.sequence > 0 && time(v.occurredAt) && time(v.receivedAt));
  check(v.occurredAt === v.receivedAt && [1, 2, 3, 4].includes(v.rating as number) && typeof v.correct === "boolean");
}
export function validateExternalCoreReceipt(r: unknown, scope: string, epoch: string): asserts r is ExternalCoreReceipt {
  check(obj(r)); keys(r, ["attempt", "status", "reviewEventId", "nextDueAt", "charge"]); validateExternalCoreAttempt(r.attempt);
  check(r.attempt.scope === scope && r.attempt.epoch === epoch);
  check(["applied", "stale", "missing", "epoch-mismatch", "ineligible", "local-session-active", "expired", "clock-mismatch"].includes(r.status as string));
  if (r.status === "applied") { check(token(r.reviewEventId) && time(r.nextDueAt) && obj(r.charge)); keys(r.charge, ["day", "kind"]); check(Number.isSafeInteger(r.charge.day) && ["new", "review", "step"].includes(r.charge.kind as string)); }
  else check(r.reviewEventId === undefined && r.nextDueAt === undefined && r.charge === undefined);
}
export function normalizeExternalReviews(value: unknown): ExternalReviews | undefined {
  if (value === undefined) return undefined;
  check(obj(value)); keys(value, ["version", "scope", "epoch", "timeZone", "offers", "receipts"]);
  check(value.version === 1 && token(value.scope) && token(value.epoch) && typeof value.timeZone === "string");
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(); } catch { throw new Error("Invalid external review timezone"); }
  check(Array.isArray(value.offers) && Array.isArray(value.receipts) && value.receipts.length <= MAX_EXTERNAL_RECEIPTS);
  const offers = new Set<string>(), receipts = new Set<string>();
  for (const o of value.offers) {
    check(obj(o)); keys(o, ["token", "cardId", "fingerprint", "issuedAt", "expiresAt"]);
    check(token(o.token) && token(o.cardId) && isCompactSourceFingerprint(o.fingerprint));
    check(time(o.issuedAt) && time(o.expiresAt) && o.expiresAt > o.issuedAt && o.expiresAt - o.issuedAt <= EXTERNAL_OFFER_TTL);
    check(!offers.has(o.token as string)); offers.add(o.token as string);
  }
  for (const r of value.receipts) {
    validateExternalCoreReceipt(r, value.scope as string, value.epoch as string);
    check(!receipts.has(r.attempt.id)); receipts.add(r.attempt.id);
  }
  return cloneJsonValue(value) as unknown as ExternalReviews;
}
const fingerprintFields = ["id", "materialId", "anchorId", "sourceId", "filePath", "title", "createdAt", "test", "cardRole", "detachedMaterialId", "status", "dueAt", "cycleIndex", "schedulerMode", "fsrsCard", "sm2State", "leitnerState", "lastReviewedAt", "reviewHistory", "practiceHistory", "offsetsMinutes", "repeatLast", "anchorType", "studyRange", "page", "pageY", "fragmentText", "line", "ch", "mdOffset", "mdBefore", "mdAfter", "mdSelection", "mediaRange", "mediaSourceVersion", "epubLocation", "imageX", "imageY", "canvasNodeIds", "textOffset", "textSelection"] as const;

/** Deliberately excludes tags/topics, notification delivery counters and unrelated cards.
 * Include complete authored question, source identity/context and scheduling history.
 */
export function externalCardFingerprint(card: Reminder, catalog?: readonly SourceFileRecord[],
  digest: (canonical: string) => string = compactSourceFingerprint): string {
  const fields: Record<string, unknown> = {};
  for (const key of fingerprintFields) {
    const value = card[key];
    if (value !== undefined) fields[key] = value;
  }
  const source = catalog?.find(s => s.id === card.sourceId);
  const sourceVersion = source ? { id: source.id, path: source.path, ...(source.sha256 ? { sha256: source.sha256 } : { size: source.size, mtime: source.mtime }) } : undefined;
  return digest(jsonFingerprint({ sourceVersion, fields, source: [card.anchorId, card.filePath, ...SOURCE_REPAIR_ANCHOR_FIELDS.map(key => card[key])] })!);
}
/** Applied to EVERY canonical capture. Persisted baseline is the sole authority,
 * so a later edit back to old content cannot resurrect a revoked offer. */
export function retainExternalOffers(state: ExternalReviews | undefined, cards: readonly Reminder[], catalog?: readonly SourceFileRecord[],
  digest?: (canonical: string) => string): ExternalReviews | undefined {
  if (!state) return undefined;
  const byId = new Map(cards.map(c => [c.id, c])), fingerprints = new Map<string, string>();
  return { ...state, offers: state.offers.filter(o => {
    const c = byId.get(o.cardId); if (!c) return false;
    if (!fingerprints.has(c.id)) fingerprints.set(c.id, externalCardFingerprint(c, catalog, digest));
    return fingerprints.get(c.id) === o.fingerprint;
  }) };
}
export function rotateExternalReviewEpoch(state: ExternalReviews | undefined, epoch: string): ExternalReviews | undefined {
  return state ? { ...state, epoch, offers: [], receipts: [] } : undefined;
}
