import type { CompanionSnapshot, SelectedCard } from "../../domain/companion/protocol";
import { COMPANION_CLOCK_SKEW, COMPANION_STUDY_COPY_TTL, MAX_COMPANION_SESSION_CARDS, invalid, keys, queryCards, record, timestamp } from "../../domain/companion/protocol";
import { companionExerciseBlankCount, companionExerciseQuestion, type CompanionExercise, type CompanionChoiceExercise } from "../../domain/companion/exercises";
import { feedbackMatchesAnswer, validateCompanionExerciseFeedback, type CompanionExerciseFeedback } from "../../domain/companion/exercise-feedback";
import { extractClozeAnswers } from "../../domain/cards/recall-test-core";
export interface CompanionButton { text: string; action: Record<string, string | number | boolean>; style?: "primary"; row?: number; }
const questionControls = ["Проверить ответ", "Показать ответ", "Подсказка", "Подсказки", "Пропустить сейчас"];
const leadingChoiceMark = /^[✓✔☐☑✅❌]/u;
/** Keep complete short options on their buttons; longer or ambiguous options retain numbered context. */
export function choiceButtonLayout(exercise: CompanionChoiceExercise): { textOptions: boolean; columns: 1 | 2 | 3; labels: string[] } {
  const options = exercise.options, lengths = options.map(option => Array.from(option).length);
  const textOptions = new Set(options.map(option => option.trim())).size === options.length
    && options.every((option, index) => option.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(option) && lengths[index] <= 36
      && !questionControls.includes(option.trim()) && !leadingChoiceMark.test(option.trimStart()));
  const longest = Math.max(...lengths);
  return { textOptions, columns: textOptions ? longest <= 8 ? 3 : longest <= 18 ? 2 : 1 : 3,
    labels: options.map((option, index) => textOptions ? option : String(index + 1)) };
}
/** Only adjacent buttons with an explicit matching row share a row. Unmarked controls stay separate. */
export function groupCompanionButtons<B extends { row?: number }, T>(buttons: readonly B[], map: (button: B) => T): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index], value = map(button);
    if (index > 0 && button.row !== undefined && button.row === buttons[index - 1].row) rows[rows.length - 1].push(value);
    else rows.push([value]);
  }
  return rows;
}
export const GRADE_LABELS = ["Ещё раз", "Трудно", "Хорошо", "Легко"] as const;
export const GRADE_PROMPT = "Насколько легко удалось вспомнить ответ?";
export type GradePanelStage = "selected" | "changing" | "sent" | "applied" | "rejected" | "correcting" | "correction-rejected";
export function gradePanelText(rating: 1 | 2 | 3 | 4, stage: GradePanelStage = "selected", answerText?: string): string {
  const suffix = { selected: "", changing: "\nВыберите другую оценку:", sent: "\nПередача в Obsidian начата.", applied: "\n✓ Сохранена в Obsidian.",
    rejected: "\nObsidian не применил оценку. Откройте карточку заново через /go.", correcting: "\nИзменение ожидает Obsidian.",
    "correction-rejected": "\nИзменение не применено: карточка изменилась или была повторена." }[stage];
  const footer = `Ваша оценка: ${GRADE_LABELS[rating - 1]}${suffix}`;
  if (answerText === undefined) return footer;
  const combined = combinedGradeText(answerText, footer); invalid(combined !== undefined); return combined;
}
const gradeStages: GradePanelStage[] = ["selected", "changing", "sent", "applied", "rejected", "correcting", "correction-rejected"];
const maxGradeFooterLength = Math.max(GRADE_PROMPT.length, ...([1, 2, 3, 4] as const).flatMap(rating => gradeStages.map(stage => gradePanelText(rating, stage).length)));
/** Reserve room for every later grade status; long answers retain the existing separate panel. */
export function combinedGradeText(answerText: string, footer: string): string | undefined {
  return answerText.length > 0 && answerText.length + 2 + Math.max(maxGradeFooterLength, footer.length) <= 4096 ? `${answerText}\n\n${footer}` : undefined;
}
/** An authored answer may persist only as the exact prefix supplied by the owned rating message. */
export function validateGradePanelEdit(text: unknown, replyMarkup: unknown, answerText?: unknown): void {
  invalid(answerText === undefined || typeof answerText === "string" && combinedGradeText(answerText, GRADE_PROMPT) !== undefined);
  invalid(([1, 2, 3, 4] as const).some(rating => gradeStages.some(stage => gradePanelText(rating, stage) === text || answerText !== undefined && gradePanelText(rating, stage, answerText as string) === text)));
  record(replyMarkup); keys(replyMarkup, ["inline_keyboard"]);
  invalid(Array.isArray(replyMarkup.inline_keyboard) && replyMarkup.inline_keyboard.length <= 4);
  for (const row of replyMarkup.inline_keyboard) {
    invalid(Array.isArray(row) && row.length === 1); record(row[0]); keys(row[0], ["text", "callback_data"]);
    invalid([...GRADE_LABELS, "Изменить оценку"].includes(row[0].text as typeof GRADE_LABELS[number])
      && typeof row[0].callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row[0].callback_data));
  }
}
export type StudySessionStatus = "active" | "paused" | "finished";
const sessionStatusText: Record<StudySessionStatus, string> = { active: "Продолжаем.", paused: "На паузе.", finished: "Завершено." };
export function studySessionText(completed: number, total: number, status: StudySessionStatus, deferredCount = 0, progress: { answers?: number; waitUntil?: number; timeZone?: string } = {}): string {
  invalid(Number.isSafeInteger(completed) && Number.isSafeInteger(total) && completed >= 0 && completed <= total && total <= MAX_COMPANION_SESSION_CARDS
    && Number.isSafeInteger(deferredCount) && deferredCount >= 0 && deferredCount <= total
    && ["active", "paused", "finished"].includes(status));
  record(progress); keys(progress, ["answers", "waitUntil", "timeZone"]);
  invalid(progress.answers === undefined || Number.isSafeInteger(progress.answers) && progress.answers >= completed && progress.answers <= 1000);
  invalid(progress.timeZone === undefined || typeof progress.timeZone === "string");
  const formatter = new Intl.DateTimeFormat("ru-RU", { timeZone: progress.timeZone ?? "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let waiting = "";
  if (progress.waitUntil !== undefined) {
    timestamp(progress.waitUntil); invalid(Number.isFinite(new Date(progress.waitUntil).getTime()));
    waiting = `\nСледующий повтор: ${formatter.format(new Date(progress.waitUntil))}`;
  }
  return `Занятие · ${completed} из ${total}\n${sessionStatusText[status]}${progress.answers !== undefined && progress.answers > completed ? `\nОтветов: ${progress.answers}.` : ""}${deferredCount ? `\nПропущено: ${deferredCount}.` : ""}${waiting}`;
}
/** Session edits contain bounded progress and fixed controls, never cached card content. */
export function validateSessionPanelEdit(text: unknown, replyMarkup: unknown): void {
  invalid(typeof text === "string");
  const match = /^Занятие · (0|[1-9]\d{0,3}) из (0|[1-9]\d{0,3})\n(Продолжаем\.|На паузе\.|Завершено\.)(?:\nОтветов: ([1-9]\d{0,3})\.)?(?:\nПропущено: ([1-9]\d{0,3})\.)?(?:\nСледующий повтор: ([01]\d|2[0-3]):([0-5]\d))?$/.exec(text);
  invalid(match && Number(match[1]) <= Number(match[2]) && Number(match[2]) <= MAX_COMPANION_SESSION_CARDS
    && (match[4] === undefined || Number(match[4]) > Number(match[1]) && Number(match[4]) <= 1000) && Number(match[5] ?? 0) <= Number(match[2]));
  record(replyMarkup); keys(replyMarkup, ["inline_keyboard"]);
  invalid(Array.isArray(replyMarkup.inline_keyboard) && replyMarkup.inline_keyboard.length <= 4);
  for (const row of replyMarkup.inline_keyboard) {
    invalid(Array.isArray(row) && row.length === 1); record(row[0]); keys(row[0], ["text", "callback_data"]);
    invalid(typeof row[0].text === "string" && ["История", "Пауза", "Продолжить", "Завершить", "Новое занятие"].includes(row[0].text)
      && typeof row[0].callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row[0].callback_data));
  }
}
export function hintPanelView(hints: readonly string[], count: number, index: number, collapsed: boolean): { text: string; paged: boolean } {
  invalid(Array.isArray(hints) && hints.length > 0 && hints.length <= 10
    && Array.from(hints).every(hint => typeof hint === "string" && hint.trim().length > 0 && hint.length <= 2000));
  invalid(Number.isSafeInteger(count) && count >= 1 && count <= hints.length && Number.isSafeInteger(index) && index >= 0 && index < count && typeof collapsed === "boolean");
  const expanded = `Подсказки · ${count} из ${hints.length}\n\n${hints.slice(0, count).map((hint, i) => `${i + 1}. ${hint}`).join("\n\n")}`;
  const paged = expanded.length > 4096;
  return { text: collapsed ? `Подсказки · открыто ${count} из ${hints.length}`
    : paged ? `Подсказка ${index + 1} из ${hints.length}\n\n${hints[index]}` : expanded, paged };
}
/** The runtime additionally binds authored hint text to its owned card and original lease. */
export function validateHintPanelEdit(text: unknown, replyMarkup: unknown): void {
  invalid(typeof text === "string" && text.length <= 4096);
  const collapsed = /^Подсказки · открыто ([1-9]|10) из ([1-9]|10)$/.exec(text);
  const expanded = /^(?:Подсказки · |Подсказка )([1-9]|10) из ([1-9]|10)\n\n([\s\S]+)$/.exec(text);
  const match = collapsed ?? expanded;
  invalid(match && Number(match[1]) <= Number(match[2]) && (collapsed || expanded![3].trim().length > 0));
  record(replyMarkup); keys(replyMarkup, ["inline_keyboard"]);
  invalid(Array.isArray(replyMarkup.inline_keyboard) && replyMarkup.inline_keyboard.length <= (collapsed ? 1 : 4));
  const labels = collapsed ? ["Показать подсказки"] : ["Следующая подсказка", "Предыдущая подсказка", "Следующая открытая подсказка", "Свернуть подсказки"];
  const used = new Set<string>();
  for (const row of replyMarkup.inline_keyboard) {
    invalid(Array.isArray(row) && row.length === 1); record(row[0]); keys(row[0], ["text", "callback_data"]);
    invalid(typeof row[0].text === "string" && labels.includes(row[0].text) && !used.has(row[0].text)
      && typeof row[0].callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row[0].callback_data));
    used.add(row[0].text);
  }
}
export interface CompanionSpoilerEntity { type: "spoiler"; offset: number; length: number; }
/** Telegram offsets use UTF-16 code units, just like JS string indices. No markup parsing. */
export function validateCompanionSpoilers(text: string, entities: unknown): asserts entities is CompanionSpoilerEntity[] {
  invalid(Array.isArray(entities) && entities.length === 1);
  const splitsPair = (position: number): boolean => position > 0 && position < text.length
    && text.charCodeAt(position - 1) >= 0xd800 && text.charCodeAt(position - 1) <= 0xdbff
    && text.charCodeAt(position) >= 0xdc00 && text.charCodeAt(position) <= 0xdfff;
  for (const entity of entities) {
    record(entity); keys(entity, ["type", "offset", "length"]);
    invalid(entity.type === "spoiler" && Number.isSafeInteger(entity.offset) && Number(entity.offset) >= 0 && Number.isSafeInteger(entity.length) && Number(entity.length) > 0);
    const start = Number(entity.offset), end = start + Number(entity.length);
    invalid(end <= text.length && !splitsPair(start) && !splitsPair(end) && text.slice(start, end).trim().length > 0);
  }
}
export interface CompanionMessage { text: string; buttons: CompanionButton[]; disableNotification?: boolean;
  entities?: CompanionSpoilerEntity[];
  /** A transport must durably bind this action to its confirmed ForceReply message ID. */
  answerAction?: Record<string, string | number | boolean>;
}
export interface CompanionStatusSummary {
  now: number; lastContactAt?: number; snapshot?: { generatedAt: number; expiresAt: number };
  pending: number; applied: number; rejected: number; pendingCorrections?: number;
}
/** Aggregate evidence only: a successful earlier exchange does not establish a live connection. */
export function renderCompanionStatus(summary: CompanionStatusSummary): CompanionMessage {
  record(summary); keys(summary, ["now", "lastContactAt", "snapshot", "pending", "applied", "rejected", "pendingCorrections"]); timestamp(summary.now);
  invalid(Number.isSafeInteger(summary.pending) && summary.pending >= 0);
  for (const count of [summary.applied, summary.rejected]) invalid(Number.isSafeInteger(count) && count >= 0);
  if (summary.pendingCorrections !== undefined) invalid(Number.isSafeInteger(summary.pendingCorrections) && summary.pendingCorrections >= 0);
  invalid(Number.isSafeInteger(summary.applied + summary.rejected));
  if (summary.lastContactAt !== undefined) timestamp(summary.lastContactAt);
  if (summary.snapshot !== undefined) {
    record(summary.snapshot); keys(summary.snapshot, ["generatedAt", "expiresAt"]); timestamp(summary.snapshot.generatedAt); timestamp(summary.snapshot.expiresAt);
    invalid(summary.snapshot.expiresAt > summary.snapshot.generatedAt && summary.snapshot.expiresAt - summary.snapshot.generatedAt <= COMPANION_STUDY_COPY_TTL);
  }
  const duration = (milliseconds: number): string => {
    const minutes = Math.floor(milliseconds / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    if (minutes < 1) return "меньше минуты";
    if (hours < 1) return `${minutes} мин`;
    if (days < 1) return `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
    return `${days} дн${hours % 24 ? ` ${hours % 24} ч` : ""}`;
  };
  const contactAge = Math.max(0, summary.now - (summary.lastContactAt ?? 0));
  const contact = !summary.lastContactAt ? "ещё не было" : summary.lastContactAt - summary.now > COMPANION_CLOCK_SKEW ? "время обмена позже текущего; проверьте часы сервера"
    : contactAge < 60000 ? "только что" : `${duration(contactAge)} назад`;
  const offline = !summary.snapshot ? "ещё не получены" : summary.snapshot.generatedAt - summary.now > COMPANION_CLOCK_SKEW ? "отмечены будущим временем; проверьте часы устройств"
    : summary.now >= summary.snapshot.expiresAt ? "срок хранения истёк; синхронизируйте Obsidian" : `действуют ещё ${duration(summary.snapshot.expiresAt - summary.now)}`;
  return { text: `Синхронизация с Obsidian\nОжидают подтверждения: ${summary.pending}${summary.pendingCorrections ? `\nИзменений оценки ожидают подтверждения: ${summary.pendingCorrections}` : ""}\nСохранено в Obsidian: ${summary.applied}\nНе применено: ${summary.rejected}\n\nПоследний обмен с Obsidian: ${contact}.\nОфлайн-данные: ${offline}.`,
    buttons: summary.applied + summary.rejected > 0 ? [{ text: "Технические подробности", action: { kind: "status", details: true } }] : [] };
}
/** Authored question text stays literal; the runtime binds edits to this exact view. */
export function validateQuestionPanelEdit(text: unknown, replyMarkup: unknown): void {
  invalid(typeof text === "string" && text.trim().length > 0 && text.length <= 4096);
  record(replyMarkup); keys(replyMarkup, ["inline_keyboard", "force_reply"]);
  invalid(replyMarkup.force_reply === undefined || replyMarkup.force_reply === true);
  invalid(Array.isArray(replyMarkup.inline_keyboard) && replyMarkup.inline_keyboard.length > 0 && replyMarkup.inline_keyboard.length <= 16);
  const labels = new Set<string>(); let count = 0;
  for (const row of replyMarkup.inline_keyboard) {
    invalid(Array.isArray(row) && row.length >= 1 && row.length <= 3);
    for (const button of row) {
      record(button); keys(button, ["text", "callback_data", "style"]);
      const label = button.text;
      invalid(typeof label === "string" && label.trim().length > 0 && label.length <= 120 && !/[\r\n\u2028\u2029]/u.test(label)
        && typeof button.callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(button.callback_data));
      const control = questionControls.includes(label), selected = label.startsWith("✓ "), checked = label.startsWith("☑ "), checkbox = checked || label.startsWith("☐ ");
      const legacy = /^[☐☑] (?:[1-9]|1[0-2])$/.test(label);
      invalid(button.style === undefined || button.style === "primary" && (selected || checked));
      invalid(!(selected || checked && !legacy) || button.style === "primary");
      const base = (selected || checkbox ? label.slice(2) : label).trim();
      invalid(base.length > 0 && !labels.has(base) && (!control || row.length === 1 && button.style === undefined)
        && (control || !questionControls.includes(base) && !leadingChoiceMark.test(base)));
      labels.add(base); count++;
    }
  }
  invalid(count <= 16 && labels.has("Пропустить сейчас"));
}
/** Plain text only: a transport must NOT enable HTML/Markdown parsing for these strings.
 * Actions are internal structured commands, NOT Telegram callback_data. A transport
 * must bind short opaque callback handles (<=64 bytes) to principal + epoch + action. */
export function renderMaterials(snapshot: CompanionSnapshot, page: ReturnType<typeof queryCards>, showGuidance = true): CompanionMessage {
  const materialTitles = new Map(snapshot.cards.map(card => [card.materialId, card.materialTitle]));
  return {
    text: `Пора повторять\n${page.totalMaterials ? "Выберите материал:" : "Нет доступных карточек в выбранных материалах."}${showGuidance ? "\nОфлайн: актуальность подтвердится при синхронизации с Obsidian." : ""}`,
    buttons: [
      ...page.materials.map(id => ({ text: materialTitles.get(id)!, action: { kind: "material", materialId: id, sequence: snapshot.sequence, scope: snapshot.scope, epoch: snapshot.epoch } })),
      ...(page.nextCursor ? [{ text: "Ещё материалы", action: { kind: "more", cursor: page.nextCursor, search: page.search, sequence: snapshot.sequence, scope: snapshot.scope, epoch: snapshot.epoch } }] : []),
      { text: "Все доступные материалы", action: { kind: "all", sequence: snapshot.sequence, scope: snapshot.scope, epoch: snapshot.epoch } },
      { text: "Поиск", action: { kind: "search", sequence: snapshot.sequence, scope: snapshot.scope, epoch: snapshot.epoch } }
    ]
  };
}
/** Explain a submitted exercise using authored answers and bounded result evidence, never learner text. */
export function exerciseFeedbackText(exercise: CompanionExercise, feedback: CompanionExerciseFeedback): string {
  validateCompanionExerciseFeedback(feedback, exercise);
  if (exercise.kind === "cloze") {
    invalid(feedback.kind === "cloze"); const answers = extractClozeAnswers(exercise.clozeTemplate);
    return feedback.matchedBlanks.map((matched, index) => `${matched ? "✅" : "❌"} Пропуск ${index + 1} — ${answers[index]}`).join("\n");
  }
  if (exercise.kind === "matching") {
    invalid(feedback.kind === "matching");
    return feedback.matches.map((right, index) => `${right === index ? "✅" : "❌"} ${exercise.pairs[index].left} → ${exercise.pairs[right].right}${right === index ? "" : `\nВерно: ${exercise.pairs[index].right}`}`).join("\n\n");
  }
  if (exercise.kind === "ordering") {
    invalid(feedback.kind === "ordering");
    return feedback.order.map((item, index) => `${item === index ? "✅" : "❌"} ${index + 1}. ${exercise.orderItems[item]}${item === index ? "" : `\nВерно: ${exercise.orderItems[index]}`}`).join("\n\n");
  }
  invalid(feedback.kind === "choice");
  const selected = new Set(feedback.selectedOptionIndexes), correct = new Set(exercise.correctOptionIndexes);
  const selectedCorrect: string[] = [], extra: string[] = [], missed: string[] = [];
  exercise.options.forEach((option, index) => {
    const label = `${index + 1}. ${option}`;
    if (selected.has(index)) (correct.has(index) ? selectedCorrect : extra).push(label);
    else if (correct.has(index)) missed.push(label);
  });
  return [!selected.size ? "Ничего не выбрано." : "", selectedCorrect.length ? `✅ Выбрано верно:\n${selectedCorrect.join("\n")}` : "",
    extra.length ? `❌ Лишние варианты:\n${extra.join("\n")}` : "", missed.length ? `⚠️ Пропущены верные варианты:\n${missed.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
export function renderCard(card: SelectedCard, snapshot: CompanionSnapshot, reveal = false, answerMatch?: boolean, showGuidance = true, selectedOptionIndexes: readonly number[] = [], legacyChoices = false, checkboxChoices = true, exerciseFeedback?: CompanionExerciseFeedback): CompanionMessage {
  const exercise = card.exercise, exact = card.evaluationMode === "exact" || exercise !== undefined;
  if (exerciseFeedback !== undefined) {
    invalid(exercise, "exercise feedback requires an exercise");
    const matched = feedbackMatchesAnswer(exercise, exerciseFeedback);
    invalid(answerMatch === undefined || answerMatch === matched, "exercise feedback differs from answer result");
  }
  const binding = { cardId: card.id, revision: card.revision, sequence: snapshot.sequence, scope: snapshot.scope, epoch: snapshot.epoch };
  const choice = exercise && (exercise.kind === "single" || exercise.kind === "multiple") ? exercise : undefined;
  invalid(Array.isArray(selectedOptionIndexes) && new Set(selectedOptionIndexes).size === selectedOptionIndexes.length
    && selectedOptionIndexes.every(index => choice && Number.isSafeInteger(index) && index >= 0 && index < choice.options.length));
  if (!reveal && (exercise?.kind === "matching" || exercise?.kind === "ordering")) return {
    text: `${card.question}\n\nЭтот формат доступен в мини-приложении. Откройте занятие командой /app.`, buttons: [] };
  const layout = choice ? choiceButtonLayout(choice) : undefined;
  const question = exercise && (!choice || reveal || legacyChoices || !layout!.textOptions) ? companionExerciseQuestion(exercise, card.question) : card.question;
  const comparison = reveal && exact && answerMatch !== undefined ? `${exercise ? answerMatch ? "✅ Ответ верный." : "❌ Ответ неверный." : answerMatch ? "✅ Ответ совпал." : "❌ Ответ не совпал."}\n\n` : "";
  const clozeInstruction = !reveal && exercise?.kind === "cloze" ? companionExerciseBlankCount(exercise) === 1
    ? "\n\nВведите пропущенный фрагмент в ответ на это сообщение."
    : "\n\nВведите ответы по порядку: каждый пропуск с новой строки, без номеров." : "";
  const instruction = clozeInstruction || (!exercise && exact && showGuidance ? "\n\nВведите ответ, ответив на это сообщение Telegram. Можно также показать ответ." : "");
  const needsReply = !reveal && (exercise?.kind === "cloze" || !exercise && exact);
  const options: CompanionButton[] = choice ? choice.options.map((_, index) => {
    const selected = selectedOptionIndexes.includes(index), label = legacyChoices ? String(index + 1) : layout!.labels[index];
    const mark = choice.kind !== "multiple" ? "" : legacyChoices || checkboxChoices ? `${selected ? "☑" : "☐"} ` : selected ? "✓ " : "";
    return { text: mark + label,
      ...(!legacyChoices ? { row: Math.floor(index / layout!.columns), ...(choice.kind === "multiple" && selected ? { style: "primary" as const } : {}) } : {}),
      action: { kind: choice.kind === "single" ? "select-option" : "toggle-option", index, ...binding } };
  }) : [];
  const guidance = card.mode === "core" && showGuidance ? "\nCore: оценка применится только после подтверждения Obsidian." : "";
  let text = `${comparison}${question}${reveal ? `\n\nОтвет для самопроверки:\n${card.reference}` : instruction}${guidance}`;
  if (reveal && answerMatch !== undefined && exercise && exerciseFeedback !== undefined) {
    const detailed = `${comparison}${choice ? card.question : question}\n\n${exerciseFeedbackText(exercise, exerciseFeedback)}${guidance}`;
    if (detailed.length <= 4096) text = detailed;
  }
  return { text,
    ...(needsReply ? { answerAction: { kind: "answer", ...binding } } : {}),
    buttons: reveal ? (answerMatch === true ? [2, 3, 4] as const : [1, 2, 3, 4] as const).map(rating => ({
      text: GRADE_LABELS[rating - 1], action: {
        kind: "review", scope: snapshot.scope, epoch: snapshot.epoch, cardId: card.id, revision: card.revision,
        sequence: snapshot.sequence, rating, correct: rating !== 1,
        ...(exact && answerMatch !== undefined ? { answerMatch } : {})
      }
    })) : [...options,
      ...(choice?.kind === "multiple" && selectedOptionIndexes.length ? [{ text: "Проверить ответ", action: { kind: "submit-options", ...binding } }] : []),
      { text: "Показать ответ", action: { kind: "reveal", ...binding } },
      ...(card.hints?.length ? [{ text: "Подсказка", action: { kind: "hint", index: 0, ...binding } }] : []),
      { text: "Пропустить сейчас", action: { kind: "skip-card", ...binding } }] };
}
