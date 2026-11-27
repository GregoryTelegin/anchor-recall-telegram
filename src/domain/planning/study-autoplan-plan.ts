import { compactSourceFingerprint } from "../cards/import-source-identity";
import { isStudyTaskDate, type StudyTask } from "./study-task";
import { projectStudyTaskOccurrences, shiftStudyTaskDate } from "./study-task-recurrence";
import { defaultStudyAutoplanConfig, normalizeStudyAutoplanState, studyAutoplanTaskHash,
  type StudyAutoplanEntry, type StudyAutoplanInput, type StudyAutoplanPlan, type StudyAutoplanReason } from "./study-autoplan-config";

const minute = 60_000;
/** Maximum changed tasks in one proposal; accumulated saved tasks are unrestricted. */
export const MAX_STUDY_AUTOPLAN_PROPOSALS = 100_000;
const clockMinutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const clock = (value: number): string => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const originForQueue = (id: string): string => JSON.stringify(["task", id]);
const originForMaterial = (id: string, action: string): string => JSON.stringify(["material", id, action]);
const automaticTaskId = (origin: string): string => `autoplan-${compactSourceFingerprint(origin).slice(7)}`;
interface Candidate { origin: string; task: StudyTask; entry?: StudyAutoplanEntry; material: boolean; }
interface Interval { start: number; end: number; taskId?: string; }
interface Day { key: string; start?: number; end?: number; windows: Interval[]; used: number; tasks: number; materials: Map<string, number>; }

export function zonedClock(zone: string): { parts(time: number): number[]; instant(key: string, minutes: number): number | undefined } {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new Error("Не удалось определить часовой пояс автоматического плана."); }
  const parts = (time: number): number[] => {
    const values = formatter.formatToParts(time);
    return ["year", "month", "day", "hour", "minute", "second"].map(type => Number(values.find(value => value.type === type)?.value));
  };
  const utc = (y: number, m: number, d: number, h = 0, n = 0): number => { const value = new Date(0); value.setUTCFullYear(y, m - 1, d); value.setUTCHours(h, n, 0, 0); return value.getTime(); };
  const cache = new Map<string, number | undefined>();
  const instant = (key: string, minutes: number): number | undefined => {
    const cacheKey = `${key}/${minutes}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const [y, m, d] = key.split("-").map(Number), h = Math.floor(minutes / 60), n = minutes % 60;
    const wall = utc(y, m, d, h, n), matches: number[] = [];
    for (const offset of [-2, -1, 0, 1, 2]) {
      const sample = wall + offset * 86_400_000, shown = parts(sample);
      const difference = utc(shown[0], shown[1], shown[2], shown[3], shown[4]) - sample;
      const candidate = wall - difference, actual = parts(candidate);
      if (actual.slice(0, 5).every((value, index) => value === [y, m, d, h, n][index])) matches.push(candidate);
    }
    const result = matches.length ? Math.min(...matches) : undefined; cache.set(cacheKey, result); return result;
  };
  return { parts, instant };
}

/** Deterministic proposals only. The coordinator owns validation, consent and the atomic write. */
export function buildStudyAutoplanPlan(input: StudyAutoplanInput): StudyAutoplanPlan {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isFinite(new Date(input.now).getTime())
    || !Number.isInteger(input.coreAvailableToday) || input.coreAvailableToday < 0) throw new Error("Не удалось подготовить автоматический план.");
  const state = normalizeStudyAutoplanState(input.state), config = state?.config ?? defaultStudyAutoplanConfig();
  const zone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC", zoned = zonedClock(zone);
  const keyAt = (time: number): string => { const [y, m, d] = zoned.parts(time); return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; };
  const timeAt = (time: number): string => { const values = zoned.parts(time); return clock(values[3] * 60 + values[4]); };
  const dailyCoreBlocks = input.dailyCoreBlocks;
  if (dailyCoreBlocks !== undefined) {
    if (!Array.isArray(dailyCoreBlocks)) throw new Error("Ежедневные блоки Core повреждены.");
    const ids = new Set<string>();
    for (const block of Array.from(dailyCoreBlocks)) {
      if (!block || typeof block.id !== "string" || !block.id || block.id.length > 1024 || /[\u0000-\u001f\u007f]/.test(block.id) || ids.has(block.id)
        || typeof block.plannedDate !== "string" || !isStudyTaskDate(block.plannedDate)
        || typeof block.startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(block.startTime)
        || !Number.isInteger(block.durationMinutes) || block.durationMinutes < 1 || block.durationMinutes > 1440
        || !Number.isSafeInteger(block.startAt) || !Number.isFinite(new Date(block.startAt).getTime())
        || !Number.isSafeInteger(block.endAt) || block.endAt !== block.startAt + block.durationMinutes * minute
        || block.completed !== undefined && typeof block.completed !== "boolean"
        || keyAt(block.startAt) !== block.plannedDate || timeAt(block.startAt) !== block.startTime)
        throw new Error("Ежедневные блоки Core повреждены.");
      ids.add(block.id);
    }
  }
  const today = keyAt(input.now);
  if (!isStudyTaskDate(today)) throw new Error("Не удалось определить текущую дату автоматического плана.");
  const fingerprint = compactSourceFingerprint(JSON.stringify([state ?? null,
    input.tasks.map(task => [studyAutoplanTaskHash(task), task.completedAt, task.skippedAt, task.updatedAt]), input.series ?? [], input.materials,
    Math.floor(input.now / minute), input.coreAvailableToday, zone, input.materialReminderIds ?? [], dailyCoreBlocks ?? null]));
  const originalTasks = [...input.tasks], entries = (state?.entries ?? []).map(entry => ({ ...entry })), reasons: StudyAutoplanReason[] = [];
  const originalBlocks = state?.coreBlocks ?? [];
  if (config.mode === "off") return { tasks: originalTasks, entries, coreBlocks: [...originalBlocks], reasons, proposedTasks: [], changed: false, fingerprint };
  const fromNow = Math.ceil(input.now / minute) * minute, through = shiftStudyTaskDate(today, config.horizonDays - 1);
  const occupancyFrom = today > "0001-01-02" ? shiftStudyTaskDate(today, -2) : "0001-01-01";
  const allTasks = projectStudyTaskOccurrences(input.tasks, input.series ?? [], occupancyFrom, through);
  const taskById = new Map(allTasks.map(task => [task.id, task])), entryByOrigin = new Map(entries.map(entry => [entry.origin, entry]));
  const entryByTask = new Map(entries.map(entry => [entry.taskId, entry])), materialById = new Map(input.materials.map(material => [material.id, material]));
  const candidates: Candidate[] = [];
  const reason = (origin: string, title: string, code: StudyAutoplanReason["code"], message: string): void => { reasons.push({ origin, title, code, message }); };
  for (const entry of entries) {
    const task = taskById.get(entry.taskId);
    if (entry.status !== "active") continue;
    if (!task) { entry.status = "deleted"; reason(entry.origin, "Удалённая задача", "deleted", "Удалённая задача не будет создана заново."); continue; }
    if (task.skippedAt !== undefined) { entry.status = "skipped"; reason(entry.origin, task.title, "skipped", "Пропущенная задача не будет создана заново."); continue; }
    if (task.completedAt !== undefined) { entry.status = "completed"; reason(entry.origin, task.title, "completed", "Выполненная задача сохранена."); continue; }
    if (task.autoplanEnabled === false) { entry.locked = true; reason(entry.origin, task.title, "opted-out", "Участие этой задачи в автоплане выключено."); continue; }
    if (entry.locked || studyAutoplanTaskHash(task) !== entry.hash) { entry.locked = true; reason(entry.origin, task.title, "manual", "Сохранены ручные изменения задачи."); }
  }
  const enqueue = (candidate: Candidate): void => {
    const task = candidate.task;
    if (candidate.entry?.status !== undefined && candidate.entry.status !== "active" || candidate.entry?.locked) return;
    if (task.completedAt !== undefined || task.skippedAt !== undefined) return;
    if (task.recurrence || task.seriesId) { reason(candidate.origin, task.title, "recurring", "У повторяющейся задачи уже есть своё расписание."); return; }
    if (task.plannedDate !== undefined && task.plannedDate > through) return;
    const start = task.plannedDate && task.startTime ? zoned.instant(task.plannedDate, clockMinutes(task.startTime)) : undefined;
    const end = start === undefined ? undefined : start + (task.durationMinutes ?? config.materialMinutes) * minute;
    if (start !== undefined && end !== undefined && start <= input.now && input.now < end) {
      reason(candidate.origin, task.title, "manual", "Начатая задача остаётся на своём месте."); return;
    }
    const past = task.plannedDate !== undefined && (task.plannedDate < today || task.plannedDate === today && end !== undefined && end <= input.now);
    if (past && candidate.entry && config.missed !== "spread") {
      reason(candidate.origin, task.title, config.missed === "keep" ? "missed-keep" : "missed-ask",
        config.missed === "keep" ? "Просроченная задача остаётся на прежнем месте." : "Нужно решить, переносить ли просроченную задачу."); return;
    }
    candidates.push(candidate);
  };
  if (config.includeQueuedTasks) for (const task of input.tasks) {
    const entry = entryByTask.get(task.id);
    if (task.autoplanEnabled !== true || entry && entry.origin !== originForQueue(task.id)) continue;
    enqueue({ origin: originForQueue(task.id), task, entry, material: false });
  }
  const selectedMaterials = [...config.materialIds], selectedIds = new Set(selectedMaterials);
  for (const unitId of config.materialUnitIds) for (const material of input.materials) {
    if (!material.unitIds?.includes(unitId) || selectedIds.has(material.id)) continue;
    selectedIds.add(material.id); selectedMaterials.push(material.id);
  }
  for (const materialId of selectedMaterials) {
    const origin = originForMaterial(materialId, config.materialAction), entry = entryByOrigin.get(origin), material = materialById.get(materialId);
    if (!material) { reason(origin, "Материал недоступен", "missing-material", "Выбранный материал уже удалён или недоступен."); continue; }
    if (config.materialAction === "study" && input.materialReminderIds?.includes(materialId)) {
      reason(origin, material.title, "manual", "У материала уже есть напоминание; оно остаётся отдельным пунктом плана."); continue;
    }
    if (entry && entry.status !== "active" || entry?.locked) continue;
    const existing = entry ? taskById.get(entry.taskId) : undefined;
    const rawTitle = `${config.materialAction === "study" ? "Изучить" : "Подготовить карточки"}: ${material.title.replace(/\0/g, "").trim() || "Материал"}`;
    const title = rawTitle.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "").trim();
    const task: StudyTask = existing ?? { id: automaticTaskId(origin), title,
      materialId, durationMinutes: config.materialMinutes, autoplanEnabled: true, calendarSync: config.googleCalendar, createdAt: input.now, updatedAt: input.now };
    if (!entry && taskById.has(task.id)) { reason(origin, task.title, "manual", "ID автоматической задачи уже занят; существующая задача сохранена."); continue; }
    enqueue({ origin, task, entry, material: true });
  }
  const occupied: Interval[] = [];
  const days: Day[] = [];
  const firstInstant = (key: string): number | undefined => {
    for (let value = 0; value < 1440; value++) { const time = zoned.instant(key, value); if (time !== undefined) return time; }
    return undefined;
  };
  for (let offset = 0; offset < config.horizonDays; offset++) {
    const key = shiftStudyTaskDate(today, offset), [y, m, d] = key.split("-").map(Number), noon = new Date(0);
    noon.setUTCFullYear(y, m - 1, d); noon.setUTCHours(12, 0, 0, 0);
    const weekday = (noon.getUTCDay() + 6) % 7;
    const windows: Interval[] = [];
    for (const window of config.windows.filter(window => window.weekdays.includes(weekday))) {
      let start: number | undefined, end: number | undefined;
      for (let value = clockMinutes(window.startTime); value < clockMinutes(window.endTime) && start === undefined; value++) start = zoned.instant(key, value);
      for (let value = clockMinutes(window.endTime); value > clockMinutes(window.startTime) && end === undefined; value--) end = zoned.instant(key, value);
      if (start !== undefined && end !== undefined && end > start && end > fromNow) windows.push({ start: Math.max(start, fromNow), end });
    }
    days.push({ key, start: firstInstant(key), end: firstInstant(shiftStudyTaskDate(key, 1)),
      windows: windows.sort((first, second) => first.start - second.start), used: 0, tasks: 0, materials: new Map() });
  }
  const dayByKey = new Map(days.map(day => [day.key, day]));
  const charges = new Map<string, Array<{ target: Day; minutes: number }>>();
  const charge = (target: Day, minutes: number, materialId: string | undefined, direction: 1 | -1): void => {
    target.used += direction * minutes; target.tasks += direction;
    if (materialId) {
      const count = (target.materials.get(materialId) ?? 0) + direction;
      if (count > 0) target.materials.set(materialId, count); else target.materials.delete(materialId);
    }
  };
  for (const task of allTasks) {
    if (task.skippedAt !== undefined || !task.plannedDate) continue;
    const duration = task.durationMinutes ?? 30, target = dayByKey.get(task.plannedDate);
    const start = task.startTime ? zoned.instant(task.plannedDate, clockMinutes(task.startTime)) : undefined;
    const portions: Array<{ target: Day; minutes: number }> = [];
    if (start !== undefined) {
      const end = start + duration * minute;
      for (const day of days) if (day.start !== undefined && day.end !== undefined) {
        const minutes = Math.max(0, Math.min(end, day.end) - Math.max(start, day.start)) / minute;
        if (minutes > 0) portions.push({ target: day, minutes: 0 });
      }
      occupied.push({ start, end, taskId: task.id });
    } else if (target) portions.push({ target, minutes: duration });
    for (const portion of portions) charge(portion.target, portion.minutes, task.materialId, 1);
    if (portions.length) charges.set(task.id, portions);
  }
  for (const block of dailyCoreBlocks ?? []) occupied.push({ start: block.startAt, end: block.endAt });
  // A minute shared by fixed tasks and Core consumes the daily time budget once.
  // Untimed work remains an additional duration charge because its overlap is unknown.
  const usedMinutes = (target: Day): number => {
    if (target.start === undefined || target.end === undefined) return target.used;
    const intervals = occupied.map(interval => ({ start: Math.max(interval.start, target.start!), end: Math.min(interval.end, target.end!) }))
      .filter(interval => interval.end > interval.start).sort((first, second) => first.start - second.start);
    let used = target.used, through = Number.NEGATIVE_INFINITY;
    for (const interval of intervals) {
      used += Math.max(0, interval.end - Math.max(interval.start, through)) / minute;
      through = Math.max(through, interval.end);
    }
    return used;
  };
  const fits = (target: Day, start: number, duration: number, materialId?: string, isCore = false): boolean => {
    const end = start + duration * minute;
    if (start < fromNow || keyAt(start) !== target.key || usedMinutes(target) + duration > config.dailyMinutes
      || !isCore && target.tasks >= config.maxTasksPerDay || materialId && !target.materials.has(materialId) && target.materials.size >= config.maxMaterialsPerDay
      || !target.windows.some(window => start >= window.start && end <= window.end)) return false;
    const wall = clockMinutes(timeAt(start));
    if (zoned.instant(target.key, wall) !== start) return false;
    return occupied.every(interval => end + config.breakMinutes * minute <= interval.start || start >= interval.end + config.breakMinutes * minute);
  };
  const place = (duration: number, materialId?: string, preferredDate?: string, preferredTime?: string, isCore = false): { target: Day; start: number } | undefined => {
    const preferred = preferredDate ? dayByKey.get(preferredDate) : undefined;
    const instant = preferred && preferredTime ? zoned.instant(preferred.key, clockMinutes(preferredTime)) : undefined;
    if (preferred && instant !== undefined && fits(preferred, instant, duration, materialId, isCore)) return { target: preferred, start: instant };
    for (const target of days) {
      if (usedMinutes(target) + duration > config.dailyMinutes || !isCore && target.tasks >= config.maxTasksPerDay
        || materialId && !target.materials.has(materialId) && target.materials.size >= config.maxMaterialsPerDay) continue;
      for (const window of target.windows) {
      let cursor = Math.ceil(window.start / minute) * minute;
      while (cursor + duration * minute <= window.end) {
        const collision = occupied.find(interval => cursor < interval.end + config.breakMinutes * minute && cursor + duration * minute + config.breakMinutes * minute > interval.start);
        if (collision) { cursor = Math.ceil((collision.end + config.breakMinutes * minute) / minute) * minute; continue; }
        if (fits(target, cursor, duration, materialId, isCore)) return { target, start: cursor };
        cursor += minute;
      }
    }
    }
    return undefined;
  };
  const reserve = (target: Day, start: number, duration: number, materialId?: string, isCore = false, taskId?: string): void => {
    if (!isCore) target.tasks++; if (materialId) target.materials.set(materialId, (target.materials.get(materialId) ?? 0) + 1);
    occupied.push({ start, end: start + duration * minute, ...(taskId ? { taskId } : {}) }); occupied.sort((first, second) => first.start - second.start);
  };
  const coreBlocks = dailyCoreBlocks === undefined
    ? originalBlocks.filter(block => block.plannedDate < today || block.plannedDate > through).map(block => ({ ...block }))
    : dailyCoreBlocks.map(({ id, plannedDate, startTime, durationMinutes }) => ({ id, plannedDate, startTime, durationMinutes }));
  if (dailyCoreBlocks === undefined) for (const block of originalBlocks.filter(block => block.plannedDate === today)) {
    const start = zoned.instant(block.plannedDate, clockMinutes(block.startTime));
    if (start === undefined || start > input.now || start + block.durationMinutes * minute <= input.now) continue;
    coreBlocks.push({ ...block });
    const target = dayByKey.get(today); if (target) reserve(target, start, block.durationMinutes, undefined, true);
  }
  if (dailyCoreBlocks === undefined && config.includeCore) for (const target of days) {
    if (coreBlocks.some(block => block.plannedDate === target.key)) continue;
    if (target.key === today && input.coreAvailableToday <= 0) continue;
    const previous = originalBlocks.find(block => block.plannedDate === target.key);
    const otherDays = days.filter(day => day !== target); // Core reserves only its own day.
    const held = otherDays.map(day => day.windows); otherDays.forEach(day => { day.windows = []; });
    const slot = place(config.coreMinutes, undefined, previous?.plannedDate ?? target.key, previous?.startTime, true);
    otherDays.forEach((day, index) => { day.windows = held[index]; });
    if (!slot) { reason(`core:${target.key}`, "Повторения Core", "no-space", "Для повторений Core не хватило окна или дневного бюджета."); continue; }
    reserve(slot.target, slot.start, config.coreMinutes, undefined, true);
    coreBlocks.push({ id: `autoplan-core-${target.key}`, plannedDate: target.key, startTime: timeAt(slot.start), durationMinutes: config.coreMinutes });
  }
  const nextTasks = [...input.tasks], proposedTasks: StudyTask[] = [];
  // Preserve already placed future automatic tasks before filling gaps with new work.
  candidates.sort((first, second) => Number(Boolean(second.entry)) - Number(Boolean(first.entry))
    || (first.entry && second.entry ? (first.task.plannedDate ?? "9999").localeCompare(second.task.plannedDate ?? "9999") : 0));
  for (const candidate of candidates) {
    const task = candidate.task, duration = task.durationMinutes ?? config.materialMinutes;
    const existing = input.tasks.find(item => item.id === task.id);
    const oldCharges = charges.get(task.id) ?? [];
    const oldIntervals = occupied.filter(interval => interval.taskId === task.id);
    for (const portion of oldCharges) charge(portion.target, portion.minutes, existing?.materialId, -1);
    for (let index = occupied.length - 1; index >= 0; index--) if (occupied[index].taskId === task.id) occupied.splice(index, 1);
    const slot = place(duration, task.materialId, candidate.entry ? task.plannedDate : undefined, candidate.entry ? task.startTime : undefined);
    if (!slot) {
      for (const portion of oldCharges) charge(portion.target, portion.minutes, existing?.materialId, 1);
      occupied.push(...oldIntervals);
      const overlapsDaily = oldIntervals.some(interval => dailyCoreBlocks?.some(block => interval.start < block.endAt && interval.end > block.startAt));
      reason(candidate.origin, task.title, "no-space", overlapsDaily
        ? "Не удалось найти новое время. Прежнее время сохранено; пересечение с ежедневным окном осталось. Измените окно или задачу."
        : "Не хватило окна, дневного бюджета или лимита задач/материалов."); continue;
    }
    reserve(slot.target, slot.start, duration, task.materialId, false, task.id);
    const scheduled: StudyTask = { ...task, plannedDate: slot.target.key, startTime: timeAt(slot.start), durationMinutes: duration,
      calendarSync: task.calendarSync ?? config.googleCalendar, autoplanEnabled: true };
    const hash = studyAutoplanTaskHash(scheduled), previousHash = studyAutoplanTaskHash(task);
    if (hash !== previousHash) scheduled.updatedAt = Math.max(input.now, task.updatedAt + 1);
    const index = nextTasks.findIndex(item => item.id === scheduled.id);
    if ((index < 0 || hash !== previousHash) && proposedTasks.length >= MAX_STUDY_AUTOPLAN_PROPOSALS)
      throw new Error("За один запуск изменяется слишком много задач. Разделите планирование на несколько запусков. Сохранённые задачи не изменены.");
    if (index >= 0) nextTasks[index] = scheduled; else {
      nextTasks.push(scheduled);
    }
    if (index < 0 || hash !== previousHash) proposedTasks.push(scheduled);
    const entry = candidate.entry ?? { origin: candidate.origin, taskId: task.id, hash, status: "active" as const };
    entry.hash = hash; entry.locked = false;
    if (!candidate.entry) { entries.push(entry); entryByOrigin.set(entry.origin, entry); }
  }
  const changed = JSON.stringify(nextTasks) !== JSON.stringify(input.tasks) || JSON.stringify(entries) !== JSON.stringify(state?.entries ?? [])
    || JSON.stringify(coreBlocks) !== JSON.stringify(originalBlocks);
  return { tasks: nextTasks, entries, coreBlocks, reasons, proposedTasks, changed, fingerprint };
}
