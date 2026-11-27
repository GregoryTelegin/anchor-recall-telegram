import { compactSourceFingerprint } from "../cards/import-source-identity";
import { isStudyTaskDate, normalizeStudyTaskInput, normalizeStudyTaskRepeatDays, studyTaskRepeatDaysEqual, studyTaskRepeatTimesEqual,
  type StudyTask, type StudyTaskInput, type StudyTaskRecurrence, type StudyTaskRepeatTimes } from "./study-task";

export interface StudyTaskSeries {
  id: string;
  recurrence: StudyTaskRecurrence;
  repeatDays?: number[];
  repeatTimes?: StudyTaskRepeatTimes;
  anchorDate: string;
  template: Omit<StudyTaskInput, "plannedDate" | "recurrence" | "repeatDays" | "repeatTimes">;
  stopDate?: string;
  createdAt: number;
  updatedAt: number;
}

const day = 86_400_000;
/** Bounds generated work in one projection, never the stored task/series catalogue. */
export const MAX_STUDY_TASK_PROJECTED_OCCURRENCES = 100_000;
const stamp = (key: string): number => { const [y, m, d] = key.split("-").map(Number), date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0); return date.getTime(); };
const keyOf = (time: number): string => new Date(time).toISOString().slice(0, 10);
const weekday = (key: string): number => (new Date(stamp(key)).getUTCDay() + 6) % 7;
const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value) && value === value.trim()
  && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && Number.isFinite(new Date(value).getTime());

export function shiftStudyTaskDate(key: string, days = 0, months = 0): string {
  if (!isStudyTaskDate(key) || !Number.isInteger(days) || !Number.isInteger(months)) throw new Error("Недопустимая дата учебного плана.");
  const value = new Date(stamp(key)), anchorDay = value.getUTCDate();
  if (months) {
    value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + months);
    const last = new Date(value.getTime()); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
    value.setUTCDate(Math.min(anchorDay, last.getUTCDate()));
  }
  value.setUTCDate(value.getUTCDate() + days);
  if (value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) throw new Error("Дата выходит за допустимый диапазон.");
  return keyOf(value.getTime());
}

export function firstStudyTaskOccurrenceDate(anchorDate: string, repeatDays: readonly number[]): string {
  const days = normalizeStudyTaskRepeatDays(repeatDays, "weekly");
  if (!days || !isStudyTaskDate(anchorDate)) throw new Error("Недопустимое повторение задачи.");
  const anchorWeekday = weekday(anchorDate);
  return shiftStudyTaskDate(anchorDate, Math.min(...days.map(day => (day - anchorWeekday + 7) % 7)));
}

export function studyTaskStartTimeForDate(value: Pick<StudyTaskInput, "startTime" | "repeatTimes">, date: string): string | undefined {
  return value.repeatTimes ? value.repeatTimes[weekday(date)] ?? undefined : value.startTime;
}

const seriesStartTime = (series: StudyTaskSeries, date: string): string | undefined =>
  studyTaskStartTimeForDate({ startTime: series.template.startTime, repeatTimes: series.repeatTimes }, date);

/** Month dates always derive from the original anchor, never the previous short month. */
export function nextStudyTaskOccurrenceDates(anchorDate: string, recurrence: StudyTaskRecurrence, count = 3, repeatDays?: readonly number[]): string[] {
  if (!isStudyTaskDate(anchorDate) || !["weekdays", "weekly", "monthly"].includes(recurrence)
    || !Number.isInteger(count) || count < 0 || count > 12) throw new Error("Недопустимое повторение задачи.");
  const days = normalizeStudyTaskRepeatDays(repeatDays, recurrence);
  const result: string[] = []; let cursor = anchorDate;
  for (let index = 1; result.length < count; index++) {
    try {
      cursor = recurrence === "monthly" ? shiftStudyTaskDate(anchorDate, 0, index)
        : shiftStudyTaskDate(cursor, recurrence === "weekly" && !days ? 7 : 1);
    } catch { break; }
    if (days ? days.includes(weekday(cursor)) : recurrence !== "weekdays" || weekday(cursor) < 5) result.push(cursor);
  }
  return result;
}

function occurrenceMatches(series: StudyTaskSeries, key: string): boolean {
  if (!isStudyTaskDate(key) || key < series.anchorDate) return false;
  if (series.repeatDays) return series.repeatDays.includes(weekday(key));
  if (key === series.anchorDate) return true;
  if (series.recurrence === "weekdays") return weekday(key) < 5;
  if (series.recurrence === "weekly") return (stamp(key) - stamp(series.anchorDate)) % (7 * day) === 0;
  const [year, month] = key.split("-").map(Number), [anchorYear, anchorMonth] = series.anchorDate.split("-").map(Number);
  return shiftStudyTaskDate(series.anchorDate, 0, (year - anchorYear) * 12 + month - anchorMonth) === key;
}

export function normalizeStudyTaskSeries(value: unknown, materialIds?: ReadonlySet<string>): StudyTaskSeries[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Список повторяющихся задач повреждён.");
  const ids = new Set<string>();
  return Array.from(value).map(item => {
    if (!record(item) || Object.keys(item).some(key => !["id", "recurrence", "repeatDays", "repeatTimes", "anchorDate", "template", "stopDate", "createdAt", "updatedAt"].includes(key))
      || !validId(item.id) || ids.has(item.id) || typeof item.anchorDate !== "string" || !isStudyTaskDate(item.anchorDate)
      || typeof item.recurrence !== "string" || !["weekdays", "weekly", "monthly"].includes(item.recurrence)
      || !record(item.template) || item.template.plannedDate !== undefined || item.template.recurrence !== undefined
      || item.template.repeatDays !== undefined || item.template.repeatTimes !== undefined
      || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) || item.updatedAt < item.createdAt
      || item.stopDate !== undefined && (typeof item.stopDate !== "string" || !isStudyTaskDate(item.stopDate)))
      throw new Error("Повреждено расписание повторяющейся задачи.");
    const rawTemplate = item.template;
    const { plannedDate: _date, recurrence: _rule, repeatDays, repeatTimes, ...template } = normalizeStudyTaskInput({
      ...rawTemplate, plannedDate: item.anchorDate, recurrence: item.recurrence, repeatDays: item.repeatDays, repeatTimes: item.repeatTimes });
    if (!studyTaskRepeatDaysEqual(item.repeatDays as number[] | undefined, repeatDays) || repeatDays && !repeatDays.includes(weekday(item.anchorDate)))
      throw new Error("Дни повторяющейся задачи не прошли проверку.");
    if (repeatTimes && template.startTime !== undefined || Object.keys(rawTemplate).length !== Object.keys(template).length
      || Object.keys(template).some(key => rawTemplate[key] !== template[key as keyof typeof template]))
      throw new Error("Поля повторяющейся задачи не прошли проверку.");
    if (template.materialId !== undefined && materialIds && !materialIds.has(template.materialId)) throw new Error("Повторяющаяся задача ссылается на отсутствующий материал.");
    ids.add(item.id);
    return { id: item.id, recurrence: item.recurrence as StudyTaskRecurrence, anchorDate: item.anchorDate,
      ...(repeatDays ? { repeatDays } : {}), ...(repeatTimes ? { repeatTimes } : {}),
      template, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.stopDate !== undefined ? { stopDate: item.stopDate as string } : {}) };
  });
}

export function validateStudyTaskSeriesLinks(tasks: readonly StudyTask[], series: readonly StudyTaskSeries[]): void {
  const byId = new Map(series.map(item => [item.id, item])), seen = new Set<string>();
  for (const task of tasks) {
    if (task.recurrence !== undefined && task.seriesId === undefined) throw new Error("Повторяющаяся задача не связана с расписанием.");
    if (!task.seriesId) continue;
    const owner = byId.get(task.seriesId), key = JSON.stringify([task.seriesId, task.occurrenceDate]);
    const detached = owner && task.recurrence === undefined && task.occurrenceDate !== undefined
      && owner.stopDate !== undefined && task.occurrenceDate >= owner.stopDate;
    if (!owner || !detached && (task.recurrence !== owner.recurrence || !studyTaskRepeatDaysEqual(task.repeatDays, owner.repeatDays)
      || !studyTaskRepeatTimesEqual(task.repeatTimes, owner.repeatTimes))
      || !task.occurrenceDate || !occurrenceMatches(owner, task.occurrenceDate) || seen.has(key))
      throw new Error("Связь отдельного повторения повреждена.");
    seen.add(key);
  }
}

export const studyTaskOccurrenceId = (seriesId: string, occurrenceDate: string): string =>
  `study-occurrence-${compactSourceFingerprint(JSON.stringify([seriesId, occurrenceDate])).slice(7)}`;

export function createStudyTaskOccurrence(series: StudyTaskSeries, occurrenceDate: string): StudyTask | undefined {
  if (!occurrenceMatches(series, occurrenceDate) || series.stopDate !== undefined && occurrenceDate >= series.stopDate) return undefined;
  const startTime = series.repeatTimes ? seriesStartTime(series, occurrenceDate) : undefined;
  return { ...series.template, ...(startTime !== undefined ? { startTime } : {}), id: studyTaskOccurrenceId(series.id, occurrenceDate), plannedDate: occurrenceDate,
    recurrence: series.recurrence, ...(series.repeatDays ? { repeatDays: [...series.repeatDays] } : {}),
    ...(series.repeatTimes ? { repeatTimes: { ...series.repeatTimes } } : {}),
    seriesId: series.id, occurrenceDate, createdAt: series.createdAt, updatedAt: series.updatedAt,
    ...(series.template.calendarSync === true ? { calendarGeneration: 0 } : {}) };
}

/** Read-only projection; only edited/completed/skipped occurrences are stored as exceptions. */
export function projectStudyTaskOccurrences(tasks: readonly StudyTask[], series: readonly StudyTaskSeries[], from: string, through: string): StudyTask[] {
  if (!isStudyTaskDate(from) || !isStudyTaskDate(through) || from > through || stamp(through) - stamp(from) > 90 * day)
    throw new Error("Для повторений выберите период не больше 90 дней.");
  const result = [...tasks], occupied = new Set(tasks.filter(task => task.seriesId).map(task => JSON.stringify([task.seriesId, task.occurrenceDate]))), ids = new Set(tasks.map(task => task.id));
  let generated = 0;
  for (const owner of series) {
    if (owner.stopDate !== undefined && owner.stopDate <= from) continue;
    const start = from > owner.anchorDate ? from : owner.anchorDate;
    const end = owner.stopDate !== undefined && owner.stopDate <= through ? shiftStudyTaskDate(owner.stopDate, -1) : through;
    for (let time = stamp(start); time <= stamp(end); time += day) {
      const key = keyOf(time), identity = JSON.stringify([owner.id, key]);
      if (occupied.has(identity)) continue;
      const task = createStudyTaskOccurrence(owner, key);
      if (!task) continue;
      if (generated >= MAX_STUDY_TASK_PROJECTED_OCCURRENCES) throw new Error("За один просмотр создано слишком много повторений. Выберите более короткий период или меньше повторяющихся задач. Сохранённые задачи не изменены.");
      if (ids.has(task.id)) throw new Error("Повторяющиеся задачи имеют совпадающий ID.");
      ids.add(task.id); result.push(task); generated++;
    }
  }
  return result;
}

export function findStudyTaskOccurrence(tasks: readonly StudyTask[], series: readonly StudyTaskSeries[], expected: StudyTask): StudyTask | undefined {
  const stored = tasks.find(task => task.id === expected.id);
  if (stored) return stored;
  const owner = series.find(item => item.id === expected.seriesId);
  if (!owner || !expected.occurrenceDate) return undefined;
  const task = createStudyTaskOccurrence(owner, expected.occurrenceDate);
  if (!task || task.id !== expected.id || tasks.some(item => item.seriesId === task.seriesId && item.occurrenceDate === task.occurrenceDate)) return undefined;
  return task;
}

export function studyTaskRuleChanged(current: StudyTaskInput | undefined,
  value: Pick<StudyTaskInput, "recurrence" | "repeatDays" | "repeatTimes" | "startTime">): boolean {
  return current?.recurrence !== value.recurrence || !studyTaskRepeatDaysEqual(current?.repeatDays, value.repeatDays)
    || !studyTaskRepeatTimesEqual(current?.repeatTimes, value.repeatTimes)
    || current !== undefined && value.repeatDays !== undefined && value.repeatTimes === undefined && current.startTime !== value.startTime;
}

/** Recurrence changes affect the future rule; ordinary edits remain one occurrence. */
export function planStudyTaskSave(tasks: readonly StudyTask[], series: readonly StudyTaskSeries[], value: StudyTaskInput,
  current: StudyTask | undefined, newId: () => string, now: number): { tasks: StudyTask[]; series: StudyTaskSeries[]; saved: StudyTask } {
  let nextTasks = [...tasks], nextSeries = [...series];
  const changedRule = studyTaskRuleChanged(current, value), custom = current?.repeatDays !== undefined || value.repeatDays !== undefined;
  if (changedRule && custom && (current?.completedAt !== undefined || current?.skippedAt !== undefined))
    throw new Error("Чтобы изменить расписание, откройте невыполненное повторение задачи.");
  let seriesId = current?.seriesId, occurrenceDate = current?.occurrenceDate;
  let nextOwner: StudyTaskSeries | undefined;
  if (value.recurrence && (!seriesId || changedRule)) {
    const { plannedDate, recurrence: _rule, repeatDays, repeatTimes, ...template } = value;
    const anchorDate = repeatDays ? firstStudyTaskOccurrenceDate(plannedDate!, repeatDays) : plannedDate!;
    if (repeatTimes) delete template.startTime;
    nextOwner = { id: newId(), anchorDate, recurrence: value.recurrence, ...(repeatDays ? { repeatDays: [...repeatDays] } : {}),
      ...(repeatTimes ? { repeatTimes: { ...repeatTimes } } : {}),
      template, createdAt: now, updatedAt: now };
  }
  if (changedRule && seriesId && occurrenceDate) {
    const oldSeriesId = seriesId;
    const oldOwner = series.find(owner => owner.id === oldSeriesId);
    const stopDate = custom && nextOwner && nextOwner.anchorDate < occurrenceDate ? nextOwner.anchorDate : occurrenceDate;
    nextSeries = nextSeries.map(owner => owner.id !== oldSeriesId ? owner : { ...owner,
      stopDate: owner.stopDate !== undefined && owner.stopDate < stopDate ? owner.stopDate : stopDate, updatedAt: Math.max(now, owner.updatedAt + 1) });
    nextTasks = nextTasks.map(task => {
      if (task.id === current?.id || task.seriesId !== oldSeriesId || !task.occurrenceDate || task.occurrenceDate < stopDate) return task;
      if (custom && nextOwner && task.recurrence && occurrenceMatches(nextOwner, task.occurrenceDate)) {
        if (task.occurrenceDate === nextOwner.anchorDate)
          throw new Error("На эту дату уже есть сохранённое повторение. Для нового расписания выберите другую дату начала.");
        const { repeatDays: _days, repeatTimes: _times, startTime: originalTime, ...exception } = task;
        // Plain text edits use the new time. A moved or recorded occurrence keeps its actual date and time.
        const followsSeriesTime = oldOwner && (oldOwner.repeatTimes || nextOwner.repeatTimes)
          && task.completedAt === undefined && task.skippedAt === undefined && task.plannedDate === task.occurrenceDate
          && originalTime === seriesStartTime(oldOwner, task.occurrenceDate);
        const startTime = followsSeriesTime ? seriesStartTime(nextOwner, task.occurrenceDate) : originalTime;
        return { ...exception, recurrence: nextOwner.recurrence, ...(nextOwner.repeatDays ? { repeatDays: [...nextOwner.repeatDays] } : {}),
          ...(nextOwner.repeatTimes ? { repeatTimes: { ...nextOwner.repeatTimes } } : {}), ...(startTime !== undefined ? { startTime } : {}),
          seriesId: nextOwner.id, updatedAt: Math.max(now, task.updatedAt + 1) };
      }
      if (task.completedAt !== undefined || task.skippedAt !== undefined) return task;
      // User-authored future exceptions survive as independent tasks.
      const { recurrence: _rule, repeatDays: _days, repeatTimes: _times, ...standalone } = task;
      return { ...standalone, updatedAt: Math.max(now, task.updatedAt + 1) };
    });
    // Keep the origin even after stopping, so a later explicit deletion can remove its old Calendar event.
  }
  if (nextOwner) {
    nextSeries.push(nextOwner); seriesId = nextOwner.id; occurrenceDate = nextOwner.anchorDate;
  }
  const previousGeneration = current?.calendarGeneration ?? (current?.calendarSync === true ? 0 : undefined);
  const calendarGeneration = value.calendarSync === true
    ? current && current.calendarSync !== true && previousGeneration !== undefined ? previousGeneration + 1 : previousGeneration ?? 0 : previousGeneration;
  if (calendarGeneration !== undefined && !Number.isSafeInteger(calendarGeneration)) throw new Error("Не удалось создать новую связь с Google Calendar.");
  const occurrence = { ...value };
  if (value.repeatTimes) {
    const startTime = nextOwner ? seriesStartTime(nextOwner, nextOwner.anchorDate) : current?.startTime;
    if (startTime === undefined) delete occurrence.startTime;
    else occurrence.startTime = startTime;
  }
  const saved: StudyTask = { ...occurrence, ...(nextOwner?.repeatDays ? { plannedDate: nextOwner.anchorDate } : {}),
    id: current?.id ?? (seriesId && occurrenceDate ? studyTaskOccurrenceId(seriesId, occurrenceDate) : newId()),
    createdAt: current?.createdAt ?? now, updatedAt: now,
    ...(seriesId && occurrenceDate ? { seriesId, occurrenceDate } : {}),
    ...(calendarGeneration !== undefined ? { calendarGeneration } : {}),
    ...(current?.completedAt !== undefined ? { completedAt: current.completedAt } : {}),
    ...(current?.skippedAt !== undefined ? { skippedAt: current.skippedAt } : {}) };
  const index = nextTasks.findIndex(task => task.id === saved.id);
  if (index >= 0) nextTasks[index] = saved; else nextTasks.push(saved);
  validateStudyTaskSeriesLinks(nextTasks, nextSeries);
  return { tasks: nextTasks, series: nextSeries, saved };
}

export function replaceStudyTaskOccurrence(tasks: readonly StudyTask[], task: StudyTask): StudyTask[] {
  return tasks.some(item => item.id === task.id) ? tasks.map(item => item.id === task.id ? task : item) : [...tasks, task];
}

/** A projection window is not a request to erase previously published occurrences. */
export function preserveUnprojectedStudyTask(tasks: readonly StudyTask[], series: readonly StudyTaskSeries[], from: string, through: string,
  taskId: string, metadata: Readonly<Record<string, unknown>>): boolean {
  if (tasks.some(task => task.id === taskId)) return false;
  const seriesId = metadata.anchorRecallTaskSeries, occurrenceDate = metadata.anchorRecallOccurrenceDate;
  if (typeof seriesId !== "string" || typeof occurrenceDate !== "string" || !isStudyTaskDate(occurrenceDate)) return false;
  const owner = series.find(item => item.id === seriesId);
  if (!owner || owner.template.calendarSync !== true || occurrenceDate >= from && occurrenceDate <= through) return false;
  // Stopping a series removes future events; its past Calendar history remains.
  const occurrence = createStudyTaskOccurrence(occurrenceDate < from ? { ...owner, stopDate: undefined } : owner, occurrenceDate);
  return occurrence?.id === taskId;
}
