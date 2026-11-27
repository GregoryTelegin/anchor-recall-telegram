import { isStudyTaskDate } from "./study-task";

/** A manual calendar-block status is independent from card review results and intervals. */
export interface CalendarDailyBlockState { completedAt?: number; startTime?: string; durationMinutes?: number; }
export interface CalendarDailyBlocksState { version: 1; days: Record<string, CalendarDailyBlockState>; }
export interface CalendarDailyBlockChange { completed?: boolean; startTime?: string | null; durationMinutes?: number | null; }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
const time = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const timestamp = (value: unknown): value is number => integer(value, 0, 8_640_000_000_000_000);
const date = (value: unknown): value is string => typeof value === "string" && isStudyTaskDate(value);
const invalid = (): never => { throw new Error("Повреждены настройки ежедневных блоков календаря. Сохранённые данные не изменены."); };
const checkDay = (dayKey: string): void => { if (!date(dayKey)) throw new Error("Выберите корректную дату ежедневного блока."); };

export function validateCalendarDailyBlocks(value: unknown): CalendarDailyBlocksState {
  if (!record(value) || value.version !== 1 || !record(value.days) || Object.keys(value).some(key => !["version", "days"].includes(key))) return invalid();
  const entries = Object.entries(value.days); if (entries.length > 200000) return invalid();
  const days: Record<string, CalendarDailyBlockState> = {};
  for (const [dayKey, block] of entries) {
    if (!date(dayKey) || !record(block) || Object.keys(block).some(key => !["completedAt", "startTime", "durationMinutes"].includes(key))
      || block.completedAt !== undefined && !timestamp(block.completedAt) || block.startTime !== undefined && !time(block.startTime)
      || block.durationMinutes !== undefined && !integer(block.durationMinutes, 1, 1440)) return invalid();
    days[dayKey] = { ...(block.completedAt !== undefined ? { completedAt: block.completedAt } : {}),
      ...(block.startTime !== undefined ? { startTime: block.startTime } : {}),
      ...(block.durationMinutes !== undefined ? { durationMinutes: block.durationMinutes } : {}) };
  }
  return { version: 1, days };
}

/** Absent state is empty; malformed state is never silently discarded. */
export function readCalendarDailyBlocks(value: unknown): CalendarDailyBlocksState {
  return value === undefined ? { version: 1, days: {} } : validateCalendarDailyBlocks(value);
}

export function getCalendarDailyBlock(value: unknown, dayKey: string): CalendarDailyBlockState {
  checkDay(dayKey); return { ...readCalendarDailyBlocks(value).days[dayKey] };
}

export function calendarDailyBlockFingerprint(value: unknown, dayKey: string): string {
  const block = getCalendarDailyBlock(value, dayKey);
  return JSON.stringify([block.completedAt ?? null, block.startTime ?? null, block.durationMinutes ?? null]);
}

export function calendarDailyBlocksFingerprint(value: unknown): string {
  const state = readCalendarDailyBlocks(value);
  return JSON.stringify(Object.keys(state.days).sort().map(key => [key, state.days[key].completedAt ?? null, state.days[key].startTime ?? null, state.days[key].durationMinutes ?? null]));
}

export function updateCalendarDailyBlock(value: unknown, dayKey: string, change: CalendarDailyBlockChange, now = Date.now()): CalendarDailyBlocksState {
  checkDay(dayKey);
  if (!record(change) || Object.keys(change).some(key => !["completed", "startTime", "durationMinutes"].includes(key))
    || change.completed !== undefined && typeof change.completed !== "boolean"
    || change.startTime !== undefined && change.startTime !== null && !time(change.startTime)
    || change.durationMinutes !== undefined && change.durationMinutes !== null && !integer(change.durationMinutes, 1, 1440)
    || change.completed === true && !timestamp(now)) return invalid();
  const state = readCalendarDailyBlocks(value), block = { ...state.days[dayKey] };
  if (change.completed === true) block.completedAt ??= now;
  else if (change.completed === false) delete block.completedAt;
  if (change.startTime === null) delete block.startTime;
  else if (change.startTime !== undefined) block.startTime = change.startTime;
  if (change.durationMinutes === null) delete block.durationMinutes;
  else if (change.durationMinutes !== undefined) block.durationMinutes = change.durationMinutes;
  state.days[dayKey] = block;
  return state;
}

export function setCalendarDailyBlockCompleted(value: unknown, dayKey: string, completed: boolean, now = Date.now()): CalendarDailyBlocksState {
  return updateCalendarDailyBlock(value, dayKey, { completed }, now);
}
