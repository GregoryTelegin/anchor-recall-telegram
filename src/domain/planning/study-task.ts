export type StudyTaskRecurrence = "weekdays" | "weekly" | "monthly";
export type StudyTaskRepeatTimes = Record<number, string | null>;

/** A learner-owned task, independent from material reminders and review schedules. */
export interface StudyTaskInput {
  title: string;
  note?: string;
  materialId?: string;
  plannedDate?: string;
  startTime?: string;
  durationMinutes?: number;
  calendarSync?: boolean;
  recurrence?: StudyTaskRecurrence;
  /** Custom weekly days, in order from Monday (0) to Sunday (6). */
  repeatDays?: number[];
  /** A time for each selected day, with null for all day. */
  repeatTimes?: StudyTaskRepeatTimes;
  autoplanEnabled?: boolean;
}

export interface StudyTask extends StudyTaskInput {
  id: string;
  calendarGeneration?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  seriesId?: string;
  occurrenceDate?: string;
  skippedAt?: number;
}

const inputKeys = ["title", "note", "materialId", "plannedDate", "startTime", "durationMinutes", "calendarSync", "recurrence", "repeatDays", "repeatTimes", "autoplanEnabled"];
const taskKeys = [...inputKeys, "id", "calendarGeneration", "completedAt", "createdAt", "updatedAt", "seriesId", "occurrenceDate", "skippedAt"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && Number.isFinite(new Date(value).getTime());
const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value)
  && value === value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;

const optionalText = (value: unknown, maximum: number, label: string): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0"))
    throw new Error(`${label}: укажите текст до ${maximum} символов.`);
  return value.trim() || undefined;
};

export function isStudyTaskDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function normalizeStudyTaskRepeatDays(value: unknown, recurrence: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (recurrence !== "weekly" || !Array.isArray(value) || !value.length || value.length > 7
    || Array.from(value).some(day => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)
    || new Set(value).size !== value.length) throw new Error("Выберите хотя бы один день недели для повторения задачи.");
  return [...value].sort((a, b) => a - b);
}

export function studyTaskRepeatDaysEqual(first?: readonly number[], second?: readonly number[]): boolean {
  return first === second || first !== undefined && second !== undefined
    && first.length === second.length && first.every((day, index) => day === second[index]);
}

function normalizeStudyTaskRepeatTimes(value: unknown, days: readonly number[] | undefined): StudyTaskRepeatTimes | undefined {
  if (value === undefined) return undefined;
  if (!days || !record(value) || Object.keys(value).length !== days.length)
    throw new Error("Укажите время или «Весь день» для каждого выбранного дня недели.");
  const times: StudyTaskRepeatTimes = {};
  for (const day of days) {
    const time = value[day];
    if (!Object.prototype.hasOwnProperty.call(value, day) || time !== null && (typeof time !== "string" || !validTime.test(time)))
      throw new Error("Укажите время ЧЧ:ММ или «Весь день» для каждого выбранного дня недели.");
    times[day] = time;
  }
  return times;
}

export function studyTaskRepeatTimesEqual(first?: StudyTaskRepeatTimes, second?: StudyTaskRepeatTimes): boolean {
  return first === second || first !== undefined && second !== undefined
    && Object.keys(first).length === Object.keys(second).length && Object.entries(first).every(([day, time]) => second[Number(day)] === time);
}

/** Form normalization; persisted records below must already use this canonical shape. */
export function normalizeStudyTaskInput(value: unknown): StudyTaskInput {
  if (!record(value) || Object.keys(value).some(key => !inputKeys.includes(key)))
    throw new Error("Поля учебной задачи повреждены.");
  const title = optionalText(value.title, 200, "Название задачи");
  if (!title) throw new Error("Укажите название задачи.");
  const note = optionalText(value.note, 5000, "Заметка");
  // Existing material IDs are opaque v1 identifiers; do not trim or constrain them to the new task-ID format.
  if (value.materialId !== undefined && typeof value.materialId !== "string") throw new Error("Повреждена связь задачи с материалом.");
  const materialId = value.materialId === "" ? undefined : value.materialId;
  const plannedDate = optionalText(value.plannedDate, 10, "Дата");
  if (plannedDate !== undefined && !isStudyTaskDate(plannedDate)) throw new Error("Укажите существующую дату задачи.");
  const startTime = optionalText(value.startTime, 5, "Время");
  if (startTime !== undefined && (!plannedDate || !validTime.test(startTime)))
    throw new Error("Для времени задачи укажите дату и время в формате ЧЧ:ММ.");
  const durationMinutes = value.durationMinutes;
  if (durationMinutes !== undefined && (typeof durationMinutes !== "number" || !Number.isInteger(durationMinutes)
    || durationMinutes < 1 || durationMinutes > 1440)) throw new Error("Длительность задачи должна быть от 1 до 1440 минут.");
  const calendarSync = value.calendarSync;
  if (calendarSync !== undefined && typeof calendarSync !== "boolean") throw new Error("Повреждён выбор Google Calendar для задачи.");
  if (calendarSync === true && !plannedDate) throw new Error("Для Google Calendar укажите дату задачи.");
  const recurrence = value.recurrence;
  if (recurrence !== undefined && (!plannedDate || typeof recurrence !== "string" || !["weekdays", "weekly", "monthly"].includes(recurrence)))
    throw new Error("Для повторяющейся задачи укажите дату и допустимое повторение.");
  const repeatDays = normalizeStudyTaskRepeatDays(value.repeatDays, recurrence);
  const repeatTimes = normalizeStudyTaskRepeatTimes(value.repeatTimes, repeatDays);
  const autoplanEnabled = value.autoplanEnabled;
  if (autoplanEnabled !== undefined && typeof autoplanEnabled !== "boolean") throw new Error("Повреждён выбор автоматического планирования задачи.");
  return { title, ...(note !== undefined ? { note } : {}), ...(materialId !== undefined ? { materialId } : {}),
    ...(plannedDate !== undefined ? { plannedDate } : {}), ...(startTime !== undefined ? { startTime } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}), ...(calendarSync !== undefined ? { calendarSync } : {}),
    ...(recurrence !== undefined ? { recurrence: recurrence as StudyTaskRecurrence } : {}),
    ...(repeatDays ? { repeatDays } : {}),
    ...(repeatTimes ? { repeatTimes } : {}),
    ...(autoplanEnabled !== undefined ? { autoplanEnabled } : {}) };
}

/** Reject the whole collection rather than losing malformed tasks during load or save. */
export function normalizeStudyTasks(value: unknown, materialIds?: ReadonlySet<string>): StudyTask[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Список учебных задач повреждён.");
  const ids = new Set<string>(), tasks: StudyTask[] = [];
  for (let index = 0; index < value.length; index++) {
    const task: unknown = value[index];
    if (!Object.prototype.hasOwnProperty.call(value, index) || !record(task)
      || Object.keys(task).some(key => !taskKeys.includes(key)) || !validId(task.id) || ids.has(task.id)
      || !timestamp(task.createdAt) || !timestamp(task.updatedAt) || task.updatedAt < task.createdAt
      || task.calendarGeneration !== undefined && (typeof task.calendarGeneration !== "number" || !Number.isSafeInteger(task.calendarGeneration) || task.calendarGeneration < 0)
      || task.completedAt !== undefined && (!timestamp(task.completedAt) || task.completedAt < task.createdAt || task.completedAt > task.updatedAt))
      throw new Error(`Учебная задача ${index + 1}: повреждены ID или даты изменения.`);
    if ((task.seriesId !== undefined || task.occurrenceDate !== undefined)
      && (!validId(task.seriesId) || typeof task.occurrenceDate !== "string" || !isStudyTaskDate(task.occurrenceDate))
      || task.skippedAt !== undefined && (!timestamp(task.skippedAt) || task.skippedAt < task.createdAt || task.skippedAt > task.updatedAt
        || task.seriesId === undefined))
      throw new Error(`Учебная задача ${index + 1}: повреждена связь повторения.`);
    const input = normalizeStudyTaskInput(Object.fromEntries(inputKeys.filter(key => task[key] !== undefined).map(key => [key, task[key]])));
    if (!studyTaskRepeatDaysEqual(task.repeatDays as number[] | undefined, input.repeatDays)
      || !studyTaskRepeatTimesEqual(task.repeatTimes as StudyTaskRepeatTimes | undefined, input.repeatTimes)
      || inputKeys.some(key => key !== "repeatDays" && key !== "repeatTimes" && task[key] !== input[key as keyof StudyTaskInput]))
      throw new Error(`Учебная задача ${index + 1}: поля не прошли проверку.`);
    if (input.materialId !== undefined && materialIds && !materialIds.has(input.materialId))
      throw new Error(`Учебная задача «${input.title}»: указан отсутствующий материал.`);
    ids.add(task.id);
    tasks.push({ ...input, id: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt,
      ...(task.calendarGeneration !== undefined ? { calendarGeneration: task.calendarGeneration } : {}),
      ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
      ...(task.seriesId !== undefined ? { seriesId: task.seriesId as string, occurrenceDate: task.occurrenceDate as string } : {}),
      ...(task.skippedAt !== undefined ? { skippedAt: task.skippedAt as number } : {}) });
  }
  return tasks;
}

/** Calendar date only: task dates do not use the Core study-day boundary at 04:00. */
export function studyTaskDayKey(now: number): string {
  const date = new Date(now), year = date.getFullYear();
  if (!Number.isFinite(now) || !Number.isFinite(date.getTime()) || year < 1 || year > 9999)
    throw new Error("Не удалось определить дату учебного плана.");
  return `${String(year).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
