import { fsrs, State, type FSRSParameters, type StepUnit } from "ts-fsrs";
import type { ReviewRating, StoredFsrsCard } from "../review/types";
import { nextFsrsCard } from "../scheduling/fsrs-scheduler";
import { applyStudyTargetDue, studyTargetRetention, validateStudyTargetSchedulePolicy, type StudyTargetSchedulePolicy } from "../planning/study-target";
import { COMPANION_STUDY_COPY_TTL } from "./capacity";

export const OFFLINE_FSRS_ENGINE = "ts-fsrs-5.4.1" as const;
const MAX_ENCODING = 8192, MAX_TIME = 8_640_000_000_000_000, CLOCK_SKEW = 5 * 60000;
export interface OfflineSeed {
  version: 1; engine: typeof OFFLINE_FSRS_ENGINE; config: string; state: string;
  rootRevision: string; issuedAt: number; expiresAt: number;
  studyTarget?: StudyTargetSchedulePolicy;
}
export interface OfflineStep {
  version: 1; rootRevision: string; index: number; parentId?: string; before: string; after: string; early?: true;
}
const check: (condition: unknown) => asserts condition = condition => { if (!condition) throw new Error("Invalid offline FSRS payload"); };
const record = (value: unknown): Record<string, unknown> => { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  check(required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
};
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIME;
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isSafeInteger(value)); return String(value); }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = record(value);
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
}
function parse(encoded: unknown): Record<string, unknown> {
  check(typeof encoded === "string" && encoded.length >= 2 && encoded.length <= MAX_ENCODING);
  let parsed: unknown; try { parsed = JSON.parse(encoded); } catch { throw new Error("Invalid offline FSRS payload"); }
  const object = record(parsed); check(canonical(object) === encoded); return object;
}
const decimal = (value: unknown, min = 0, max = 1e12): number => {
  check(typeof value === "string" && value.length <= 32);
  const number = Number(value); check(Number.isFinite(number) && String(number) === value && number >= min && number <= max); return number;
};
const nativeDecimal = (value: unknown): string => { check(typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)); return String(value); };
const stateFields = ["due", "stability", "difficulty", "elapsedDays", "scheduledDays", "learningSteps", "reps", "lapses", "state"] as const;

/** Every numeric field is a canonical decimal string inside this private, signed string. */
export function encodeOfflineFsrsState(state: StoredFsrsCard): string {
  const source = record(state); exactKeys(source, stateFields, ["lastReview"]);
  const object: Record<string, unknown> = Object.fromEntries(stateFields.map(key => [key, nativeDecimal(source[key])]));
  if (source.lastReview !== undefined) object.lastReview = nativeDecimal(source.lastReview);
  const encoded = canonical(object); decodeOfflineFsrsState(encoded); return encoded;
}
export function decodeOfflineFsrsState(encoded: string): StoredFsrsCard {
  const object = parse(encoded); exactKeys(object, stateFields, ["lastReview"]);
  const state = Object.fromEntries(stateFields.map(key => [key, decimal(object[key], 0, key === "due" ? MAX_TIME : 1e12)])) as unknown as StoredFsrsCard;
  check(time(state.due) && state.stability <= 1e6 && state.difficulty <= 10 && [0, 1, 2, 3].includes(state.state));
  for (const value of [state.learningSteps, state.reps, state.lapses]) check(Number.isSafeInteger(value));
  if (object.lastReview !== undefined) { state.lastReview = decimal(object.lastReview, 0, MAX_TIME); check(time(state.lastReview)); }
  return state;
}
const configFields = ["request_retention", "maximum_interval", "w", "enable_fuzz", "enable_short_term", "learning_steps", "relearning_steps"] as const;
function encodedConfig(parameters: FSRSParameters): Record<string, unknown> {
  const source = record(parameters); exactKeys(source, configFields);
  check(Array.isArray(parameters.w) && Array.isArray(parameters.learning_steps) && Array.isArray(parameters.relearning_steps));
  return { request_retention: nativeDecimal(parameters.request_retention), maximum_interval: nativeDecimal(parameters.maximum_interval),
    w: parameters.w.map(nativeDecimal), enable_fuzz: parameters.enable_fuzz, enable_short_term: parameters.enable_short_term,
    learning_steps: [...parameters.learning_steps], relearning_steps: [...parameters.relearning_steps] };
}
export function encodeOfflineFsrsConfig(parameters: FSRSParameters): string {
  const encoded = canonical(encodedConfig(parameters)); decodeOfflineFsrsConfig(encoded); return encoded;
}
export function decodeOfflineFsrsConfig(encoded: string): FSRSParameters {
  const object = parse(encoded); exactKeys(object, configFields);
  const steps = (value: unknown): StepUnit[] => {
    check(Array.isArray(value) && value.length <= 16 && value.every(step => typeof step === "string" && step.length <= 32 && /^(?:[1-9]\d{0,8})(?:\.\d+)?[mhd]$/.test(step)));
    return [...value] as StepUnit[];
  };
  check(Array.isArray(object.w) && object.w.length === 21 && typeof object.enable_fuzz === "boolean" && typeof object.enable_short_term === "boolean");
  const config: FSRSParameters = { request_retention: decimal(object.request_retention, 0, 1), maximum_interval: decimal(object.maximum_interval, 1, 1e9),
    w: object.w.map(weight => decimal(weight, -1e6, 1e6)), enable_fuzz: object.enable_fuzz, enable_short_term: object.enable_short_term,
    learning_steps: steps(object.learning_steps), relearning_steps: steps(object.relearning_steps) };
  check(config.request_retention > 0 && config.request_retention < 1 && Number.isSafeInteger(config.maximum_interval));
  // Signed configuration is already fully resolved, never silently migrated or clipped at replay.
  check(canonical(encodedConfig(fsrs(config).parameters)) === encoded); return config;
}
export function createOfflineSeed(input: { rootRevision: string; parameters: FSRSParameters; state: StoredFsrsCard; issuedAt: number; expiresAt: number; studyTarget?: StudyTargetSchedulePolicy }): string {
  return encodeOfflineSeed({ version: 1, engine: OFFLINE_FSRS_ENGINE, config: encodeOfflineFsrsConfig(input.parameters), state: encodeOfflineFsrsState(input.state),
    rootRevision: input.rootRevision, issuedAt: input.issuedAt, expiresAt: input.expiresAt,
    ...(input.studyTarget === undefined ? {} : { studyTarget: input.studyTarget }) });
}
export function encodeOfflineSeed(seed: OfflineSeed): string {
  const { studyTarget, ...required } = seed;
  const encoded = canonical({ ...required, ...(studyTarget === undefined ? {} : { studyTarget: validateStudyTargetSchedulePolicy(studyTarget) }) });
  decodeOfflineSeed(encoded); return encoded;
}
export function decodeOfflineSeed(encoded: string): OfflineSeed {
  const object = parse(encoded); exactKeys(object, ["version", "engine", "config", "state", "rootRevision", "issuedAt", "expiresAt"], ["studyTarget"]);
  check(object.version === 1 && object.engine === OFFLINE_FSRS_ENGINE && token(object.rootRevision) && time(object.issuedAt) && time(object.expiresAt)
    && object.expiresAt > object.issuedAt && object.expiresAt - object.issuedAt <= COMPANION_STUDY_COPY_TTL);
  decodeOfflineFsrsConfig(object.config as string); decodeOfflineFsrsState(object.state as string);
  if (object.studyTarget !== undefined) validateStudyTargetSchedulePolicy(object.studyTarget);
  return object as unknown as OfflineSeed;
}
export function validateOfflineSeed(encoded: unknown): asserts encoded is string { decodeOfflineSeed(encoded as string); }
export function encodeOfflineStep(step: OfflineStep): string {
  exactKeys(record(step), ["version", "rootRevision", "index", "before", "after"], ["parentId", "early"]);
  const { parentId, early, ...required } = step, encoded = canonical({ ...required, ...(parentId === undefined ? {} : { parentId }), ...(early === undefined ? {} : { early }) });
  decodeOfflineStep(encoded); return encoded;
}
export function decodeOfflineStep(encoded: string): OfflineStep {
  const object = parse(encoded); exactKeys(object, ["version", "rootRevision", "index", "before", "after"], ["parentId", "early"]);
  check(object.version === 1 && token(object.rootRevision) && Number.isSafeInteger(object.index) && Number(object.index) >= 1 && Number(object.index) <= 10000);
  check(object.index === 1 ? object.parentId === undefined : token(object.parentId));
  const before = decodeOfflineFsrsState(object.before as string), after = decodeOfflineFsrsState(object.after as string);
  check(after.reps === before.reps + 1 && after.lastReview !== undefined && after.state !== State.New && after.due >= after.lastReview
    && (before.lastReview === undefined || after.lastReview >= before.lastReview) && after.lapses >= before.lapses && after.lapses <= before.lapses + 1);
  check(object.early === undefined || object.early === true && Number(object.index) > 1 && stateIsShortStep(object.before as string) && after.lastReview < before.due);
  return object as unknown as OfflineStep;
}
export function validateOfflineStep(encoded: unknown): asserts encoded is string { decodeOfflineStep(encoded as string); }
/** The caller additionally proves the current head, due boundary, parent chain and consent. */
export function advanceOfflineFsrs(seed: OfflineSeed | string, before: string, rating: ReviewRating, occurredAt: number): string {
  const resolved = typeof seed === "string" ? decodeOfflineSeed(seed) : decodeOfflineSeed(encodeOfflineSeed(seed)), state = decodeOfflineFsrsState(before);
  check([1, 2, 3, 4].includes(rating) && time(occurredAt) && occurredAt >= resolved.issuedAt - CLOCK_SKEW && occurredAt < resolved.expiresAt
    && (state.lastReview === undefined || occurredAt >= state.lastReview));
  const parameters = decodeOfflineFsrsConfig(resolved.config);
  parameters.request_retention = studyTargetRetention(parameters.request_retention, resolved.studyTarget, occurredAt);
  return encodeOfflineFsrsState(applyStudyTargetDue(nextFsrsCard({ createdAt: resolved.issuedAt, dueAt: state.due, fsrsCard: state }, rating, occurredAt, parameters), resolved.studyTarget, occurredAt));
}
export function offlineStateDue(state: string): number { return decodeOfflineFsrsState(state).due; }
export function stateIsShortStep(state: string): boolean {
  const card = decodeOfflineFsrsState(state); return [State.Learning, State.Relearning].includes(card.state) && card.scheduledDays < 1;
}
/** Only an explicitly requested in-session short repeat may precede its scheduled time. */
export function offlineReviewTimeAllowed(step: OfflineStep, occurredAt: number): boolean {
  const before = decodeOfflineFsrsState(step.before);
  return time(occurredAt) && (before.lastReview === undefined || occurredAt >= before.lastReview)
    && (step.early === undefined ? occurredAt >= before.due
      : step.early === true && step.index > 1 && stateIsShortStep(step.before) && occurredAt < before.due);
}
