import { fsrs, State, type FSRSParameters } from "ts-fsrs";
import { compactSourceFingerprint } from "../cards/import-source-identity";
import { isStudyTaskDate } from "./study-task";
import { createFsrsScheduler, nextFsrsCard, type FsrsSchedulerSettings, type FsrsSchedulingSource } from "../scheduling/fsrs-scheduler";
import { deserializeFsrsCard } from "../scheduling/fsrs-card";
import type { ReviewRating, StoredFsrsCard } from "../review/types";

const DAY = 86_400_000;
export const STUDY_TARGET_TRANSITION_MS = 7 * DAY;
export const STUDY_TARGET_RETENTION = 0.95;
export const MAX_STUDY_TARGET_FORECAST_STEPS = 1000;

export interface StudyTargetConfig { enabled: boolean; targetDate: string; materialIds: string[]; timeZone: string; }
export interface StudyTargetSchedulePolicy { from: number; until?: number; reviewByAt?: number; examEndAt: number; transitionEndAt: number; }
export interface StudyTargetPolicy extends StudyTargetSchedulePolicy { materialIds: string[]; }
export interface StudyTargetAdjustment { cardId: string; beforeDueAt: number; dueAt: number; memory: string; }
export interface StudyTargetState { version: 1; config: StudyTargetConfig; policies: StudyTargetPolicy[]; adjustments?: StudyTargetAdjustment[]; }
export interface StudyTargetCardSource extends FsrsSchedulingSource { id?: string; materialId: string; cardRole?: "core" | "bank"; schedulerMode?: string; }
export interface StudyTargetForecastStep { reviewedAt: number; nextDueAt: number; rating: ReviewRating; state: StoredFsrsCard; }
export interface StudyTargetForecast { steps: StudyTargetForecastStep[]; nextDueAt: number; retentionAtTarget?: number; }

const fail = (): never => { throw new Error("Настройки подготовки к дате повреждены. Проверьте дату, материалы и часовой пояс."); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const ids = (value: unknown): value is string[] => Array.isArray(value) && new Set(value).size === value.length
  && Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index) && typeof value[index] === "string"
    && value[index].length > 0 && value[index].length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value[index])).every(Boolean);

/** Civil boundaries include zones whose clock jumps at midnight or skips a whole date. */
function studyTargetCivilBoundaryAt(targetDate: string, timeZone: string, end: boolean): number {
  if (!isStudyTaskDate(targetDate)) return fail();
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { return fail(); }
  const [year, month, day] = targetDate.split("-").map(Number), next = new Date(0);
  next.setUTCFullYear(year, month - 1, day + (end ? 1 : 0)); next.setUTCHours(0, 0, 0, 0);
  const ordinal = (at: number): number => {
    const parts = formatter.formatToParts(at), part = (key: string): number => Number(parts.find(value => value.type === key)?.value);
    return part("year") * 10000 + part("month") * 100 + part("day");
  };
  const expected = year * 10000 + month * 100 + day;
  const boundary = next.getUTCFullYear() * 10000 + (next.getUTCMonth() + 1) * 100 + next.getUTCDate();
  let low = Math.max(0, next.getTime() - 2 * DAY), high = next.getTime() + 2 * DAY;
  if (!time(low) || !time(high) || ordinal(low) >= boundary || ordinal(high) < boundary) return fail();
  while (low + 1 < high) { const middle = low + Math.floor((high - low) / 2); if (ordinal(middle) < boundary) low = middle; else high = middle; }
  if ((end ? ordinal(high - 1) : ordinal(high)) !== expected || !time(high + STUDY_TARGET_TRANSITION_MS)) return fail();
  return high;
}

/** First instant of the selected civil day, including a missing local midnight. */
export function studyTargetExamStartAt(targetDate: string, timeZone: string): number { return studyTargetCivilBoundaryAt(targetDate, timeZone, false); }
/** The target date remains inclusive. */
export function studyTargetExamEndAt(targetDate: string, timeZone: string): number { return studyTargetCivilBoundaryAt(targetDate, timeZone, true); }

/** Use the preceding local calendar day even if an offset change shortened or lengthened it. */
export function studyTargetCheckpointAt(targetDate: string, timeZone: string): number {
  const examAt = studyTargetExamStartAt(targetDate, timeZone);
  const portions = new Intl.DateTimeFormat("en-CA", { timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(examAt - 1);
  const previousDate = ["year", "month", "day"].map(part => portions.find(value => value.type === part)!.value).join("-");
  return studyTargetExamStartAt(previousDate, timeZone);
}

export function validateStudyTargetConfig(value: unknown): StudyTargetConfig {
  if (!object(value) || !exact(value, ["enabled", "targetDate", "materialIds", "timeZone"]) || typeof value.enabled !== "boolean"
    || typeof value.targetDate !== "string" || value.targetDate !== "" && !isStudyTaskDate(value.targetDate)
    || !ids(value.materialIds) || value.enabled && (!value.targetDate || !value.materialIds.length)
    || typeof value.timeZone !== "string" || !value.timeZone || value.timeZone.length > 100) return fail();
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(0); } catch { return fail(); }
  if (value.targetDate) studyTargetExamEndAt(value.targetDate, value.timeZone);
  return { enabled: value.enabled, targetDate: value.targetDate, materialIds: [...value.materialIds], timeZone: value.timeZone };
}

export function validateStudyTargetSchedulePolicy(value: unknown): StudyTargetSchedulePolicy {
  if (!object(value) || !exact(value, ["from", "examEndAt", "transitionEndAt"], ["until", "reviewByAt"]) || !time(value.from)
    || !time(value.examEndAt) || !time(value.transitionEndAt) || value.transitionEndAt !== value.examEndAt + STUDY_TARGET_TRANSITION_MS
    || value.reviewByAt !== undefined && (!time(value.reviewByAt) || value.reviewByAt >= value.examEndAt || value.examEndAt - value.reviewByAt >= 3 * DAY)
    || value.until !== undefined && (!time(value.until) || value.until < value.from)) return fail();
  return { from: value.from, ...(value.until === undefined ? {} : { until: value.until }), ...(value.reviewByAt === undefined ? {} : { reviewByAt: value.reviewByAt }), examEndAt: value.examEndAt, transitionEndAt: value.transitionEndAt };
}

export function validateStudyTargetState(value: unknown): StudyTargetState {
  if (!object(value) || !exact(value, ["version", "config", "policies"], ["adjustments"]) || value.version !== 1 || !Array.isArray(value.policies)) return fail();
  const config = validateStudyTargetConfig(value.config);
  const policies = Array.from(value.policies, policy => {
    if (!object(policy) || !exact(policy, ["from", "examEndAt", "transitionEndAt", "materialIds"], ["until", "reviewByAt"]) || !ids(policy.materialIds) || !policy.materialIds.length) return fail();
    const { materialIds, ...window } = policy;
    return { ...validateStudyTargetSchedulePolicy(window), materialIds: [...materialIds] };
  });
  policies.forEach((policy, index) => {
    const next = policies[index + 1];
    if (next && (policy.until === undefined || policy.until > next.from || policy.from > next.from)) fail();
  });
  const last = policies.at(-1);
  if (config.enabled ? !last || last.until !== undefined || last.examEndAt !== studyTargetExamEndAt(config.targetDate, config.timeZone)
    || last.reviewByAt !== undefined && last.reviewByAt !== studyTargetExamStartAt(config.targetDate, config.timeZone)
      && last.reviewByAt !== studyTargetCheckpointAt(config.targetDate, config.timeZone)
    || JSON.stringify([...last.materialIds].sort()) !== JSON.stringify([...config.materialIds].sort()) : last?.until === undefined && Boolean(last)) return fail();
  let adjustments: StudyTargetAdjustment[] | undefined;
  if (value.adjustments !== undefined) {
    if (!Array.isArray(value.adjustments)) return fail();
    const seen = new Set<string>();
    adjustments = Array.from(value.adjustments, adjustment => {
      if (!object(adjustment) || !exact(adjustment, ["cardId", "beforeDueAt", "dueAt", "memory"]) || !ids([adjustment.cardId])
        || seen.has(adjustment.cardId as string) || !time(adjustment.beforeDueAt) || !time(adjustment.dueAt)
        || typeof adjustment.memory !== "string" || !adjustment.memory || adjustment.memory.length > 2000 || /[\u0000-\u001f\u007f]/.test(adjustment.memory)) return fail();
      seen.add(adjustment.cardId as string);
      return { cardId: adjustment.cardId as string, beforeDueAt: adjustment.beforeDueAt, dueAt: adjustment.dueAt, memory: adjustment.memory };
    });
  }
  return { version: 1, config, policies, ...(adjustments === undefined ? {} : { adjustments }) };
}

export function studyTargetConfigFingerprint(value: StudyTargetConfig): string {
  const config = validateStudyTargetConfig(value);
  return compactSourceFingerprint(JSON.stringify([config.enabled, config.targetDate, config.timeZone, [...config.materialIds].sort()]));
}

/** Give the new checkpoint its own window so past answers retain their original policy. */
export function refreshStudyTargetCheckpoint(state: StudyTargetState, now: number): StudyTargetState {
  if (!time(now)) return fail();
  const last = state.policies.at(-1);
  if (!state.config.enabled || !last || now < last.from || now >= last.examEndAt) return state;
  const reviewByAt = studyTargetCheckpointAt(state.config.targetDate, state.config.timeZone);
  if (last.reviewByAt === reviewByAt) return state;
  return { ...state, policies: [...state.policies.slice(0, -1), { ...last, until: now }, { ...last, from: now, reviewByAt }] };
}

/** Keep old policy windows so regrading a real past answer uses its original context. */
export function updateStudyTargetState(previous: StudyTargetState | undefined, value: StudyTargetConfig, now: number): StudyTargetState {
  if (!time(now)) return fail();
  const before = previous && validateStudyTargetState(previous), config = validateStudyTargetConfig(value);
  if (before && studyTargetConfigFingerprint(before.config) === studyTargetConfigFingerprint(config)) return refreshStudyTargetCheckpoint(before, now);
  if (before?.policies.at(-1) && now < before.policies.at(-1)!.from) return fail();
  const examEndAt = config.enabled ? studyTargetExamEndAt(config.targetDate, config.timeZone) : undefined;
  if (examEndAt !== undefined && now >= examEndAt) throw new Error("Для подготовки выберите сегодняшнюю или будущую дату.");
  const policies = before?.policies.map(policy => ({ ...policy, materialIds: [...policy.materialIds] })) ?? [];
  const last = policies.at(-1); if (last && last.until === undefined) last.until = now;
  if (examEndAt !== undefined) {
    policies.push({ from: now, reviewByAt: studyTargetCheckpointAt(config.targetDate, config.timeZone), examEndAt, transitionEndAt: examEndAt + STUDY_TARGET_TRANSITION_MS, materialIds: [...config.materialIds] });
  }
  return validateStudyTargetState({ version: 1, config, policies, ...(before?.adjustments === undefined ? {} : { adjustments: before.adjustments }) });
}

/** The transition length is a product policy; the FSRS memory model itself stays unchanged. */
export function studyTargetRetention(base: number, policy: StudyTargetSchedulePolicy | undefined, at: number): number {
  if (!Number.isFinite(base) || base <= 0 || base >= 1 || !time(at)) return fail();
  if (!policy || at < policy.from || policy.until !== undefined && at >= policy.until || at >= policy.transitionEndAt) return base;
  const target = Math.max(base, STUDY_TARGET_RETENTION);
  return at < policy.examEndAt ? target : base + (target - base) * (policy.transitionEndAt - at) / STUDY_TARGET_TRANSITION_MS;
}

export function policyForStudyTargetCard(state: StudyTargetState | undefined, source: StudyTargetCardSource, at: number): StudyTargetPolicy | undefined {
  if (!state || source.cardRole === "bank" || source.schedulerMode !== undefined && source.schedulerMode !== "fsrs" || !time(at)) return undefined;
  for (let index = state.policies.length - 1; index >= 0; index--) {
    const policy = state.policies[index];
    if (at >= policy.from && (policy.until === undefined || at < policy.until) && policy.materialIds.includes(source.materialId)) return policy;
  }
  return undefined;
}

/** A final checkpoint before the target day is a due-only policy, never a fabricated review. */
export function applyStudyTargetDue(next: StoredFsrsCard, policy: StudyTargetSchedulePolicy | undefined, at: number): StoredFsrsCard {
  return policy && at >= policy.from && (policy.until === undefined || at < policy.until) && next.state === State.Review
    && at < policy.examEndAt && policy.reviewByAt !== undefined && (policy.reviewByAt > at || next.lastReview !== undefined && next.lastReview < policy.reviewByAt)
    && next.due > policy.reviewByAt ? { ...next, due: policy.reviewByAt } : next;
}

/** Recalculate only an already learned card's interval; no grade or memory state is invented. */
export function studyTargetDueAt(source: FsrsSchedulingSource, parameters: FSRSParameters, policy?: StudyTargetSchedulePolicy, at = Date.now()): number {
  const card = source.fsrsCard;
  if (!card || card.state !== State.Review || card.lastReview === undefined || !time(card.lastReview) || card.stability <= 0) return source.dueAt;
  const retention = studyTargetRetention(parameters.request_retention, policy, at);
  const scheduler = fsrs({ ...parameters, request_retention: retention, enable_fuzz: false });
  const due = card.lastReview + scheduler.next_interval(card.stability, 0) * DAY;
  return time(due) ? applyStudyTargetDue({ ...card, due }, policy, at).due : source.dueAt;
}

/** Scenario grades operate on detached states, never on the learner's answers or history. */
export function forecastStudyTargetCard(input: { source: StudyTargetCardSource; settings: FsrsSchedulerSettings; state?: StudyTargetState; ratings: readonly ReviewRating[]; now: number }): StudyTargetForecast {
  const { source, settings, now } = input;
  if (source.cardRole === "bank" || source.schedulerMode !== undefined && source.schedulerMode !== "fsrs")
    throw new Error("Прогноз к дате доступен для карточек Core с FSRS.");
  if (!time(now) || !time(source.dueAt) || !time(source.createdAt) || !Array.isArray(input.ratings) || !input.ratings.length
    || input.ratings.length > MAX_STUDY_TARGET_FORECAST_STEPS || !Array.from({ length: input.ratings.length }, (_, index) => Object.prototype.hasOwnProperty.call(input.ratings, index) && [1, 2, 3, 4].includes(input.ratings[index])).every(Boolean)) return fail();
  const state = input.state && validateStudyTargetState(input.state), parameters = createFsrsScheduler(settings).parameters;
  const steps: StudyTargetForecastStep[] = [];
  let draft: FsrsSchedulingSource = { createdAt: source.createdAt, dueAt: source.dueAt, ...(source.fsrsCard ? { fsrsCard: { ...source.fsrsCard } } : {}) };
  let reviewedAt = Math.max(now, source.dueAt), atTarget = draft.fsrsCard ? { ...draft.fsrsCard } : undefined;
  const target = state?.config.targetDate ? studyTargetExamEndAt(state.config.targetDate, state.config.timeZone) - 1 : undefined;
  for (const rating of input.ratings) {
    const policy = policyForStudyTargetCard(state, source, reviewedAt);
    const next = applyStudyTargetDue(nextFsrsCard(draft, rating, reviewedAt, { ...parameters, request_retention: studyTargetRetention(parameters.request_retention, policy, reviewedAt), enable_fuzz: false }), policy, reviewedAt);
    if (!time(next.due) || next.due < reviewedAt) throw new Error("Прогноз вышел за доступный диапазон дат.");
    steps.push({ reviewedAt, nextDueAt: next.due, rating, state: { ...next } });
    if (target !== undefined && reviewedAt <= target) atTarget = { ...next };
    draft = { ...draft, dueAt: next.due, fsrsCard: next }; reviewedAt = next.due;
  }
  const retentionAtTarget = target !== undefined && atTarget?.lastReview !== undefined && atTarget.lastReview <= target
    ? fsrs(parameters).get_retrievability(deserializeFsrsCard(atTarget), target, false) : undefined;
  return { steps, nextDueAt: source.dueAt, ...(retentionAtTarget === undefined ? {} : { retentionAtTarget }) };
}
