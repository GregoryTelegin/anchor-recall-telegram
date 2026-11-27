import { normalizeTestAnswer, type AnswerMatchMode } from "../cards/recall-core";
import { validateCompanionMediaAttachment, type CompanionMediaAttachment } from "./media";
import { validateCompanionExercise, companionExerciseQuestion, companionExerciseReference, type CompanionExercise } from "./exercises";
import { decodeOfflineSeed, decodeOfflineStep, offlineStateDue } from "./offline-fsrs";
import { validateCompanionStudyTarget, type CompanionStudyTarget } from "./study-target";
import { COMPANION_STUDY_COPY_TTL } from "./capacity";
export { LEGACY_COMPANION_SNAPSHOT_CARDS, MAX_COMPANION_SNAPSHOT_CARDS, MAX_COMPANION_MATERIALS,
  MAX_COMPANION_SNAPSHOT_BYTES, MAX_COMPANION_SNAPSHOT_CHUNK_BYTES, MAX_COMPANION_SESSION_CARDS,
  COMPANION_STUDY_COPY_TTL, LEGACY_COMPANION_STUDY_COPY_TTL } from "./capacity";
/** Offline companion protocol v1. No vault paths, source bodies, attachments or learner answer text. */
export interface SelectedCard {
  id: string; revision: string; materialId: string; materialTitle: string;
  mode: "bank" | "core"; question: string; reference: string; eligible: boolean; dueAt?: number;
  /** Absence is the legacy self-evaluation flow. Explicit variants remain whole answers. */
  evaluationMode?: "exact"; acceptedAnswers?: string[]; answerMatchMode?: AnswerMatchMode;
  hints?: string[]; media?: CompanionMediaAttachment[];
  exercise?: CompanionExercise;
  offline?: string;
}
export interface CompanionSnapshot {
  version: 1; scope: string; epoch: string; sequence: number;
  generatedAt: number; expiresAt: number; cards: SelectedCard[]; earlyShortRepeats?: true; studyTarget?: CompanionStudyTarget;
}
export const MAX_COMPANION_BRIDGE_BYTES = 5_000_000;
/** The same bounded device-clock difference accepted by the authenticated bridge envelope. */
export const COMPANION_CLOCK_SKEW = 5 * 60_000;
export function companionSnapshotIsCurrent(snapshot: CompanionSnapshot, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && snapshot.generatedAt - now <= COMPANION_CLOCK_SKEW && now < snapshot.expiresAt;
}
export interface ReviewAttempt {
  id: string; scope: string; epoch: string; cardId: string; revision: string; sequence: number;
  mode: "bank" | "core"; occurredAt: number; rating: 1 | 2 | 3 | 4; correct: boolean;
  offline?: string;
}
export type ImportStatus = "applied" | "stale" | "epoch-mismatch" | "missing" | "ineligible" | "local-session-active" | "expired" | "clock-mismatch" | "core-adapter-unavailable";
export interface ReminderPolicy { mutedUntil: number; skippedDay?: string; enabled: boolean; quietUpdates: boolean; }
export interface CallbackReceipt { id: string; command: string; result: string; }
export interface CompanionState {
  version: 1; revoked: boolean; snapshot?: CompanionSnapshot; pending: ReviewAttempt[];
  outcomes: { attempt: ReviewAttempt; status: ImportStatus }[]; callbacks: CallbackReceipt[]; reminders: ReminderPolicy;
}
export const emptyState = (): CompanionState => ({ version: 1, revoked: false, pending: [], outcomes: [], callbacks: [],
  reminders: { mutedUntil: 0, enabled: true, quietUpdates: false } });
export function invalid(condition: unknown, message = "invalid companion payload"): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): asserts value is Record<string, unknown> {
  invalid(value !== null && typeof value === "object" && !Array.isArray(value));
}
export function keys(value: Record<string, unknown>, allowed: string[]): void { invalid(Object.keys(value).every(key => allowed.includes(key))); }
export function token(value: unknown): asserts value is string { invalid(typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)); }
function text(value: unknown, max: number): asserts value is string { invalid(typeof value === "string" && value.length > 0 && value.length <= max); }
export function timestamp(value: unknown): asserts value is number { invalid(Number.isSafeInteger(value) && (value as number) >= 0); }
export function validateSnapshot(value: unknown): asserts value is CompanionSnapshot {
  record(value); keys(value, ["version", "scope", "epoch", "sequence", "generatedAt", "expiresAt", "cards", "earlyShortRepeats", "studyTarget"]);
  invalid(value.earlyShortRepeats === undefined || value.earlyShortRepeats === true);
  invalid(value.version === 1); token(value.scope); token(value.epoch); timestamp(value.sequence); invalid(value.sequence > 0);
  timestamp(value.generatedAt); timestamp(value.expiresAt); invalid(value.expiresAt > value.generatedAt && value.expiresAt - value.generatedAt <= COMPANION_STUDY_COPY_TTL);
  invalid(Array.isArray(value.cards));
  if (value.studyTarget !== undefined) validateCompanionStudyTarget(value.studyTarget, value.cards as SelectedCard[]);
  const ids = new Set<string>(); const materialTitles = new Map<string, unknown>();
  for (const c of value.cards) {
    record(c); keys(c, ["id", "revision", "materialId", "materialTitle", "mode", "question", "reference", "eligible", "dueAt", "evaluationMode", "acceptedAnswers", "answerMatchMode", "hints", "media", "exercise", "offline"]);
    token(c.id); token(c.revision); token(c.materialId); text(c.materialTitle, 120); text(c.question, 1800); text(c.reference, 1800);
    invalid(c.mode === "bank" || c.mode === "core"); invalid(typeof c.eligible === "boolean"); if (c.dueAt !== undefined) timestamp(c.dueAt);
    if (c.offline !== undefined) {
      const seed = decodeOfflineSeed(c.offline as string);
      invalid(c.mode === "core" && c.eligible === true && c.dueAt === offlineStateDue(seed.state) && seed.rootRevision === c.revision
        && seed.issuedAt - value.generatedAt <= COMPANION_CLOCK_SKEW && seed.expiresAt >= value.expiresAt);
    }
    invalid(c.evaluationMode === undefined || c.evaluationMode === "exact");
    if (c.exercise !== undefined) {
      validateCompanionExercise(c.exercise);
      invalid(c.evaluationMode === "exact" && c.acceptedAnswers === undefined && c.answerMatchMode === undefined);
      invalid(c.reference === companionExerciseReference(c.exercise) && companionExerciseQuestion(c.exercise, c.question).length <= 1800);
    } else if (c.evaluationMode === "exact") {
      invalid(c.answerMatchMode === undefined || c.answerMatchMode === "text" || c.answerMatchMode === "literal");
      if (c.acceptedAnswers !== undefined) {
        invalid(Array.isArray(c.acceptedAnswers) && c.acceptedAnswers.length > 0 && c.acceptedAnswers.length <= 12);
        invalid(Array.from(c.acceptedAnswers).every(answer => typeof answer === "string" && answer.trim().length > 0 && answer.length <= 2000
          && (c.answerMatchMode === "literal" || !!normalizeTestAnswer(answer))));
      } else invalid(c.answerMatchMode === "literal" ? !!c.reference.trim() : c.reference.split(/[\n|]+/).some(answer => !!normalizeTestAnswer(answer)));
    } else invalid(c.acceptedAnswers === undefined && c.answerMatchMode === undefined);
    if (c.hints !== undefined) {
      invalid(Array.isArray(c.hints) && c.hints.length <= 10);
      invalid(Array.from(c.hints).every(hint => typeof hint === "string" && hint.trim().length > 0 && hint.length <= 2000
        && !/!\[|<(?:img|audio|video|iframe|object|embed|svg|picture|canvas)\b/i.test(hint)));
    }
    if (c.media !== undefined) { invalid(Array.isArray(c.media) && c.media.length <= 12); Array.from(c.media).forEach(validateCompanionMediaAttachment); }
    invalid(!ids.has(c.id)); ids.add(c.id);
    invalid(!materialTitles.has(c.materialId) || materialTitles.get(c.materialId) === c.materialTitle); materialTitles.set(c.materialId, c.materialTitle);
  }
}
export function validateAttempt(value: unknown): asserts value is ReviewAttempt {
  record(value); keys(value, ["id", "scope", "epoch", "cardId", "revision", "sequence", "mode", "occurredAt", "rating", "correct", "offline"]);
  for (const key of ["id", "scope", "epoch", "cardId", "revision"]) token(value[key]);
  timestamp(value.sequence); invalid(value.sequence > 0); timestamp(value.occurredAt);
  invalid(value.mode === "bank" || value.mode === "core"); invalid([1, 2, 3, 4].includes(value.rating as number)); invalid(typeof value.correct === "boolean");
  if (value.offline !== undefined) {
    const step = decodeOfflineStep(value.offline as string);
    invalid(value.mode === "core" && value.revision === (step.index === 1 ? step.rootRevision : step.parentId));
  }
}
export function validateState(value: unknown): asserts value is CompanionState {
  record(value); keys(value, ["version", "revoked", "snapshot", "pending", "outcomes", "callbacks", "reminders"]);
  invalid(value.version === 1 && typeof value.revoked === "boolean"); if (value.snapshot !== undefined) validateSnapshot(value.snapshot);
  invalid(Array.isArray(value.pending)); value.pending.forEach(validateAttempt);
  invalid(Array.isArray(value.outcomes));
  for (const outcome of value.outcomes) { record(outcome); keys(outcome, ["attempt", "status"]); validateAttempt(outcome.attempt); invalid(["applied", "stale", "epoch-mismatch", "missing", "ineligible", "local-session-active", "expired", "clock-mismatch", "core-adapter-unavailable"].includes(outcome.status as string)); }
  const attemptIds = new Set<string>();
  for (const a of [...value.pending, ...value.outcomes.map(o => o.attempt)]) { const key = attemptKey(a); invalid(!attemptIds.has(key)); attemptIds.add(key); }
  invalid(Array.isArray(value.callbacks));
  const ids = new Set<string>();
  for (const r of value.callbacks) { record(r); keys(r, ["id", "command", "result"]); token(r.id); text(r.command, 8192); text(r.result, 200); invalid(!ids.has(r.id)); ids.add(r.id); }
  record(value.reminders); keys(value.reminders, ["mutedUntil", "skippedDay", "enabled", "quietUpdates"]); timestamp(value.reminders.mutedUntil);
  invalid(typeof value.reminders.enabled === "boolean" && typeof value.reminders.quietUpdates === "boolean");
  if (value.reminders.skippedDay !== undefined) invalid(typeof value.reminders.skippedDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.reminders.skippedDay));
}
export function sameAttempt(a: ReviewAttempt, b: ReviewAttempt): boolean {
  return (Object.keys(a) as (keyof ReviewAttempt)[]).every(key => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;
}
export function attemptKey(a: ReviewAttempt): string { return JSON.stringify([a.scope, a.epoch, a.id]); }
export function reminderAllowed(policy: ReminderPolicy, now: number, localDay: string): boolean {
  return policy.enabled && now >= policy.mutedUntil && policy.skippedDay !== localDay;
}
export interface QueryOptions { now: number; search?: string; dueOnly?: boolean; all?: boolean; pageSize?: number; cursor?: string; materialId?: string; }
export function queryCards(snapshot: CompanionSnapshot, suppressed: ReviewAttempt[], options: QueryOptions) {
  invalid(companionSnapshotIsCurrent(snapshot, options.now), "snapshot expired or clock moved backwards");
  const size = options.pageSize ?? 4; invalid(Number.isInteger(size) && size >= 1 && size <= 20);
  const search = (options.search ?? "").trim().toLocaleLowerCase(); invalid(search.length <= 200);
  const identity = JSON.stringify([snapshot.epoch, snapshot.sequence, search, !!options.dueOnly, size, options.materialId ?? null]);
  let offset = 0;
  if (options.cursor) { const cursor: unknown = JSON.parse(options.cursor); invalid(Array.isArray(cursor) && cursor.length === 2 && cursor[0] === identity && Number.isInteger(cursor[1]) && cursor[1] >= 0, "stale cursor"); offset = cursor[1]; }
  const suppressedIds = new Set(suppressed.filter(a => a.scope === snapshot.scope && a.epoch === snapshot.epoch).map(a => a.cardId));
  const cards = snapshot.cards.filter(c => c.eligible && (c.offline === undefined || c.dueAt !== undefined && c.dueAt <= options.now) && (!options.materialId || c.materialId === options.materialId) && (!search || `${c.question} ${c.materialTitle}`.toLocaleLowerCase().includes(search))
    && !suppressedIds.has(c.id));
  const materialIds = [...new Set(cards.map(c => c.materialId))]; const materials = options.all ? materialIds : materialIds.slice(offset, offset + size);
  const chosenMaterials = new Set(materials);
  return { cards: cards.filter(c => chosenMaterials.has(c.materialId)), materials, totalMaterials: materialIds.length,
    nextCursor: !options.all && offset + size < materialIds.length ? JSON.stringify([identity, offset + size]) : undefined,
    search, generatedAt: snapshot.generatedAt, expiresAt: snapshot.expiresAt };
}
