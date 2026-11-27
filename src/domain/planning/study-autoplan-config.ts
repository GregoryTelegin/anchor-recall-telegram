import { compactSourceFingerprint } from "../cards/import-source-identity";
import { isStudyTaskDate, type StudyTask } from "./study-task";
import type { StudyTaskSeries } from "./study-task-recurrence";

export interface StudyAutoplanWindow {
  id: string;
  name: string;
  /** Monday is 0, Sunday is 6. */
  weekdays: number[];
  startTime: string;
  endTime: string;
}
export interface StudyAutoplanConfig {
  mode: "off" | "suggest" | "auto";
  dailyMinutes: number;
  horizonDays: 3 | 7 | 14;
  windows: StudyAutoplanWindow[];
  includeCore: boolean;
  coreMinutes: number;
  materialIds: string[];
  materialUnitIds: string[];
  materialAction: "study" | "prepareCards";
  materialMinutes: number;
  includeQueuedTasks: boolean;
  maxTasksPerDay: number;
  maxMaterialsPerDay: number;
  breakMinutes: number;
  missed: "spread" | "keep" | "ask";
  googleCalendar: boolean;
}
export interface StudyAutoplanEntry {
  origin: string;
  taskId: string;
  hash: string;
  status: "active" | "completed" | "deleted" | "skipped";
  locked?: boolean;
}
export interface StudyAutoplanCoreBlock { id: string; plannedDate: string; startTime: string; durationMinutes: number; }
export interface StudyAutoplanDailyCoreBlock extends StudyAutoplanCoreBlock {
  startAt: number;
  endAt: number;
  completed?: boolean;
}
export interface StudyAutoplanState {
  config: StudyAutoplanConfig;
  entries: StudyAutoplanEntry[];
  coreBlocks?: StudyAutoplanCoreBlock[];
}
export interface StudyAutoplanMaterial { id: string; title: string; unitIds?: readonly string[]; }
export interface StudyAutoplanReason { origin: string; title: string; code: "manual" | "completed" | "deleted" | "skipped" | "opted-out" | "missing-material" | "recurring" | "no-space" | "missed-keep" | "missed-ask"; message: string; }
export interface StudyAutoplanInput {
  state?: StudyAutoplanState;
  tasks: readonly StudyTask[];
  series?: readonly StudyTaskSeries[];
  materials: readonly StudyAutoplanMaterial[];
  now: number;
  coreAvailableToday: number;
  timeZone?: string;
  materialReminderIds?: readonly string[];
  /** The shared daily calendar projection owns these fixed blocks; [] disables legacy Core reservations. */
  dailyCoreBlocks?: readonly StudyAutoplanDailyCoreBlock[];
}
export interface StudyAutoplanPlan {
  tasks: StudyTask[];
  entries: StudyAutoplanEntry[];
  coreBlocks: StudyAutoplanCoreBlock[];
  reasons: StudyAutoplanReason[];
  proposedTasks: StudyTask[];
  changed: boolean;
  fingerprint: string;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const time = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minute = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const fields = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every(key => names.includes(key));

export function defaultStudyAutoplanConfig(): StudyAutoplanConfig {
  return { mode: "off", dailyMinutes: 45, horizonDays: 7, windows: [], includeCore: true, coreMinutes: 15,
    materialIds: [], materialUnitIds: [], materialAction: "study", materialMinutes: 25, includeQueuedTasks: true, maxTasksPerDay: 3,
    maxMaterialsPerDay: 1, breakMinutes: 5, missed: "spread", googleCalendar: false };
}

export function normalizeStudyAutoplanConfig(value: unknown): StudyAutoplanConfig {
  if (record(value) && value.materialUnitIds === undefined) value = { ...value, materialUnitIds: [] };
  const keys = Object.keys(defaultStudyAutoplanConfig());
  if (!record(value) || !fields(value, keys) || keys.some(key => value[key] === undefined)
    || typeof value.mode !== "string" || !["off", "suggest", "auto"].includes(value.mode) || !integer(value.dailyMinutes, 1, 1440)
    || ![3, 7, 14].includes(value.horizonDays as number) || !Array.isArray(value.windows) || value.windows.length > 28
    || typeof value.includeCore !== "boolean" || !integer(value.coreMinutes, 1, 1440)
    || !Array.isArray(value.materialIds) || value.materialIds.length > 10_000 || !Array.from(value.materialIds).every(id) || new Set(value.materialIds).size !== value.materialIds.length
    || !Array.isArray(value.materialUnitIds) || value.materialUnitIds.length > 10_000 || !Array.from(value.materialUnitIds).every(id) || new Set(value.materialUnitIds).size !== value.materialUnitIds.length
    || typeof value.materialAction !== "string" || !["study", "prepareCards"].includes(value.materialAction) || !integer(value.materialMinutes, 1, 1440)
    || typeof value.includeQueuedTasks !== "boolean" || !integer(value.maxTasksPerDay, 1, 100) || !integer(value.maxMaterialsPerDay, 1, 100)
    || !integer(value.breakMinutes, 0, 120) || typeof value.missed !== "string" || !["spread", "keep", "ask"].includes(value.missed) || typeof value.googleCalendar !== "boolean")
    throw new Error("Настройки автоматического плана повреждены. Проверьте режим, источники и ограничения.");
  const ids = new Set<string>();
  const windows = Array.from(value.windows).map(window => {
    if (!record(window) || !fields(window, ["id", "name", "weekdays", "startTime", "endTime"])
      || !id(window.id) || ids.has(window.id) || typeof window.name !== "string" || !window.name.trim() || window.name.length > 80
      || !Array.isArray(window.weekdays) || !window.weekdays.length || Array.from(window.weekdays).some(day => !integer(day, 0, 6)) || new Set(window.weekdays).size !== window.weekdays.length
      || !time(window.startTime) || !time(window.endTime)) throw new Error("Укажите название, дни недели и время каждого окна.");
    if (window.startTime >= window.endTime) throw new Error("Окно должно заканчиваться в тот же день после начала. Разделите ночное окно на два.");
    ids.add(window.id);
    return { id: window.id, name: window.name, weekdays: [...window.weekdays].sort((a, b) => a - b), startTime: window.startTime, endTime: window.endTime } as StudyAutoplanWindow;
  });
  for (let index = 0; index < windows.length; index++) for (let next = index + 1; next < windows.length; next++) {
    const first = windows[index], second = windows[next];
    if (first.weekdays.some(day => second.weekdays.includes(day)) && minute(first.startTime) < minute(second.endTime) && minute(second.startTime) < minute(first.endTime))
      throw new Error(`Окна «${first.name}» и «${second.name}» пересекаются. Измените время или дни недели.`);
  }
  return { ...(value as unknown as StudyAutoplanConfig), windows, materialIds: [...value.materialIds] as string[], materialUnitIds: [...value.materialUnitIds] as string[] };
}

export function normalizeStudyAutoplanState(value: unknown): StudyAutoplanState | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !fields(value, ["config", "entries", "coreBlocks"]) || !Array.isArray(value.entries)
    || value.coreBlocks !== undefined && !Array.isArray(value.coreBlocks)) throw new Error("Данные автоматического плана повреждены.");
  const origins = new Set<string>(), taskIds = new Set<string>();
  const entries = Array.from(value.entries).map(entry => {
    if (!record(entry) || !fields(entry, ["origin", "taskId", "hash", "status", "locked"]) || !id(entry.origin) || origins.has(entry.origin)
      || !id(entry.taskId) || taskIds.has(entry.taskId) || typeof entry.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.hash)
      || typeof entry.status !== "string" || !["active", "completed", "deleted", "skipped"].includes(entry.status) || entry.locked !== undefined && typeof entry.locked !== "boolean")
      throw new Error("Журнал автоматических задач повреждён.");
    origins.add(entry.origin); taskIds.add(entry.taskId); return { ...entry } as unknown as StudyAutoplanEntry;
  });
  const blockIds = new Set<string>();
  const coreBlocks = value.coreBlocks === undefined ? undefined : Array.from(value.coreBlocks as unknown[]).map(block => {
    if (!record(block) || !fields(block, ["id", "plannedDate", "startTime", "durationMinutes"]) || !id(block.id) || blockIds.has(block.id)
      || typeof block.plannedDate !== "string" || !isStudyTaskDate(block.plannedDate) || !time(block.startTime) || !integer(block.durationMinutes, 1, 1440))
      throw new Error("Позиции повторений Core повреждены.");
    blockIds.add(block.id); return { ...block } as unknown as StudyAutoplanCoreBlock;
  });
  return { config: normalizeStudyAutoplanConfig(value.config), entries, ...(coreBlocks !== undefined ? { coreBlocks } : {}) };
}

/** Content and schedule fields only: timestamps never turn an automatic retry into a manual edit. */
export function studyAutoplanTaskHash(task: StudyTask): string {
  return compactSourceFingerprint(JSON.stringify([task.id, task.title, task.note, task.materialId, task.plannedDate, task.startTime,
    task.durationMinutes, task.calendarSync, task.autoplanEnabled, task.recurrence, task.seriesId, task.occurrenceDate,
    ...(task.repeatDays ? [task.repeatDays] : []), ...(task.repeatTimes ? [task.repeatTimes] : [])]));
}
