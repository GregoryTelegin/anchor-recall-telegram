import { readCalendarDailyBlocks } from "../planning/calendar-daily-block";
import { zonedClock } from "../planning/study-autoplan-plan";
import { isStudyTaskDate, type StudyTask } from "../planning/study-task";
import { projectStudyTaskOccurrences, shiftStudyTaskDate, type StudyTaskSeries } from "../planning/study-task-recurrence";
import { companionStudyPlanEntryId, companionStudyTaskRevision, companionDailyPlanRevision, validateCompanionPlanActionOptions, type CompanionPlanActionOptions } from "./study-plan-actions";
export { companionStudyPlanEntryId } from "./study-plan-actions";

export interface CompanionStudyPlanEntry {
  id: string; title: string; startAt: number; notifyAt: number; materialIds: string[]; mode?: "core" | "bank"; action?: CompanionPlanActionOptions;
}
export interface CompanionCalendarDelivery { state: "waiting" | "synced" | "disabled" | "not-routed" | "error" | "conflict"; checkedAt?: number; }
export interface CompanionStudyPlanOverviewEntry extends CompanionStudyPlanEntry { completed?: boolean; skipped?: boolean; calendar?: CompanionCalendarDelivery; }
export interface CompanionStudyPlan {
  version: 1; enabled: boolean; timeZone: string; generatedAt: number; expiresAt: number; entries: CompanionStudyPlanEntry[]; overview?: CompanionStudyPlanOverviewEntry[];
}
export interface CompanionStudyPlanInput {
  enabled: boolean; timeZone: string; now: number; reminderMinutes: number; horizonDays: number;
  tasks: readonly StudyTask[]; series: readonly StudyTaskSeries[];
  selectedMaterialIds: readonly string[]; eligibleMaterialIds: readonly string[];
  /** Only supported, consented, active Core cards contribute to the daily digest. */
  coreDueAt: readonly number[];
  includeOverview?: boolean;
  includeActions?: boolean;
  dailyCore?: { enabled: boolean; time: string; title: string; durationMinutes?: number; includeEmptyDays: boolean; blocks?: unknown };
}

const minute = 60_000, day = 86_400_000;
export const COMPANION_STUDY_PLAN_TTL = 7 * day;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const token = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^a-zA-Z0-9._:-]/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const invalid = (): never => { throw new Error("Invalid companion study plan"); };
const validZone = (value: unknown): value is string => {
  if (typeof value !== "string" || !value || value.length > 100 || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; } catch { return false; }
};

/** Strict shared wire boundary. Titles and consented material IDs are the entire content projection. */
export function validateCompanionStudyPlan(value: unknown): asserts value is CompanionStudyPlan {
  if (!record(value) || !keys(value, ["version", "enabled", "timeZone", "generatedAt", "expiresAt", "entries", "overview"])
    || value.version !== 1 || typeof value.enabled !== "boolean" || !validZone(value.timeZone)
    || !timestamp(value.generatedAt) || !timestamp(value.expiresAt) || value.expiresAt <= value.generatedAt
    || value.expiresAt - value.generatedAt > COMPANION_STUDY_PLAN_TTL
    || !Array.isArray(value.entries) || !value.enabled && value.entries.length) return invalid();
  if (value.overview !== undefined && !Array.isArray(value.overview)) return invalid();
  for (const [index, rows] of [value.entries, value.overview ?? []].entries()) {
  const ids = new Set<string>();
  for (const entry of rows) {
    if (!record(entry) || !keys(entry, ["id", "title", "startAt", "notifyAt", "materialIds", "mode", "action", ...(index ? ["completed", "skipped", "calendar"] : [])])
      || typeof entry.id !== "string" || entry.id.length !== 64 || !/^[a-f0-9]{64}$/.test(entry.id) || ids.has(entry.id) || !text(entry.title)
      || !timestamp(entry.startAt) || !timestamp(entry.notifyAt) || entry.notifyAt > entry.startAt
      || entry.startAt - entry.notifyAt > 1440 * minute || entry.startAt >= value.expiresAt
      || !Array.isArray(entry.materialIds) || entry.materialIds.length > 100 || !Array.from(entry.materialIds).every(token)
      || new Set(entry.materialIds).size !== entry.materialIds.length
      || entry.mode !== undefined && entry.mode !== "core" && entry.mode !== "bank"
      || !entry.materialIds.length && entry.mode !== "core"
      || index && (entry.completed !== undefined && typeof entry.completed !== "boolean" || entry.skipped !== undefined && typeof entry.skipped !== "boolean")) return invalid();
    ids.add(entry.id);
    if (entry.action !== undefined) validateCompanionPlanActionOptions(entry.action);
    if (entry.calendar !== undefined) {
      if (!entry.action || !record(entry.calendar) || !keys(entry.calendar, ["state", "checkedAt"])
        || !["waiting", "synced", "disabled", "not-routed", "error", "conflict"].includes(String(entry.calendar.state))
        || entry.calendar.checkedAt !== undefined && (!timestamp(entry.calendar.checkedAt) || entry.calendar.checkedAt > value.generatedAt + 300000)
        || ["synced", "conflict"].includes(String(entry.calendar.state)) && entry.calendar.checkedAt === undefined) return invalid();
    }
  }
  }
}

/** Saved tasks (including accepted autoplan tasks) only; no previews, notes, paths or Calendar events. */
export function projectCompanionStudyPlan(input: CompanionStudyPlanInput): CompanionStudyPlan {
  if (!timestamp(input.now) || !validZone(input.timeZone) || typeof input.enabled !== "boolean"
    || !Number.isInteger(input.reminderMinutes) || input.reminderMinutes < 0 || input.reminderMinutes > 1440
    || !Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 90) return invalid();
  const zoned = zonedClock(input.timeZone);
  const keyAt = (time: number): string => {
    const [year, month, date] = zoned.parts(time);
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  };
  const today = keyAt(input.now), horizon = Math.min(7, input.horizonDays), through = shiftStudyTaskDate(today, horizon - 1);
  const endKey = shiftStudyTaskDate(today, horizon);
  // Some zones skip midnight or an entire calendar date. Find the first valid following minute.
  let horizonEnd: number | undefined;
  for (let offset = 0; offset <= 1 && horizonEnd === undefined; offset++) {
    const date = shiftStudyTaskDate(endKey, offset);
    for (let clock = 0; clock < 1440 && horizonEnd === undefined; clock++) horizonEnd = zoned.instant(date, clock);
  }
  const expiresAt = Math.min(input.now + COMPANION_STUDY_PLAN_TTL, horizonEnd ?? input.now + COMPANION_STUDY_PLAN_TTL);
  const plan: CompanionStudyPlan = { version: 1, enabled: input.enabled && input.reminderMinutes > 0,
    timeZone: input.timeZone, generatedAt: input.now, expiresAt, entries: [] };
  if (!input.enabled || !plan.enabled && !input.includeOverview) { validateCompanionStudyPlan(plan); return plan; }
  if (input.includeOverview) plan.overview = [];
  const selected = new Set(input.selectedMaterialIds.filter(token)), eligible = new Set(input.eligibleMaterialIds.filter(id => selected.has(id) && token(id)));
  const add = (identity: unknown[], title: string, startAt: number | undefined, materialIds: string[], mode?: "core" | "bank", completed = false, skipped = false, action?: CompanionPlanActionOptions): void => {
    title = title.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
    if (startAt === undefined || startAt >= expiresAt || startAt < input.reminderMinutes * minute || !text(title)) return;
    const entry = { id: companionStudyPlanEntryId(identity), title, startAt,
      notifyAt: startAt - input.reminderMinutes * minute, materialIds, ...(mode ? { mode } : {}), ...(input.includeActions && action ? { action } : {}) };
    if (plan.overview) plan.overview.push({ ...entry, completed, skipped });
    if (plan.enabled && !completed && !skipped) plan.entries.push(entry);
  };
  // The recurrence helper deliberately preserves all stored exceptions, including those outside its window.
  const tasks = projectStudyTaskOccurrences(input.tasks, input.series, today, through);
  for (const task of tasks) {
    if (!task.plannedDate || !isStudyTaskDate(task.plannedDate)
      || task.plannedDate < today || task.plannedDate > through || !task.startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.startTime)
      || !task.materialId || !eligible.has(task.materialId)) continue;
    const [hour, minutes] = task.startTime.split(":").map(Number);
    add(["task", task.seriesId ?? task.id, task.occurrenceDate ?? null], task.title,
      zoned.instant(task.plannedDate, hour * 60 + minutes), [task.materialId], undefined, task.completedAt !== undefined, task.skippedAt !== undefined,
      { revision: companionStudyTaskRevision(task), date: task.plannedDate, time: task.startTime, durationMinutes: task.durationMinutes ?? 30, canMoveDate: true });
  }
  const daily = input.dailyCore;
  if (daily?.enabled && input.coreDueAt.length && /^([01]\d|2[0-3]):[0-5]\d$/.test(daily.time)) {
    const blocks = readCalendarDailyBlocks(daily.blocks), dueDays = new Set(input.coreDueAt.filter(timestamp).map(due => {
      const key = keyAt(due); return key < today ? today : key;
    }));
    for (let offset = 0; offset < horizon; offset++) {
      const key = shiftStudyTaskDate(today, offset);
      if (!daily.includeEmptyDays && !dueDays.has(key) && !Object.prototype.hasOwnProperty.call(blocks.days, key)) continue;
      const [hour, minutes] = (blocks.days[key]?.startTime ?? daily.time).split(":").map(Number);
      add(["core", key], daily.title, zoned.instant(key, hour * 60 + minutes), [], "core", blocks.days[key]?.completedAt !== undefined, false,
        { revision: companionDailyPlanRevision(key, blocks.days[key] ?? {}, { enabled: daily.enabled, time: daily.time, title: daily.title, durationMinutes: daily.durationMinutes ?? 30 }),
          date: key, time: blocks.days[key]?.startTime ?? daily.time, durationMinutes: blocks.days[key]?.durationMinutes ?? daily.durationMinutes ?? 30, canMoveDate: false });
    }
  }
  plan.entries.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  plan.overview?.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  validateCompanionStudyPlan(plan); return plan;
}
