import { invalid, keys, record, type SelectedCard } from "../../domain/companion/protocol";
import { validateCompanionExercise } from "../../domain/companion/exercises";

export interface NativePollView {
  question: string; options: { text: string }[]; type: "regular"; is_anonymous: false;
  allows_multiple_answers: boolean; allows_revoting: false; shuffle_options: false;
  allow_adding_options: false; hide_results_until_closes: true;
}
export interface NativePollPayload extends NativePollView {
  chat_id: number; disable_notification: boolean; close_date?: number;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}
export function validNativePollId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function boundedText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
/** Keep authored text and option order intact; unsupported sizes use the existing exercise controls. */
export function nativePollView(card: SelectedCard): NativePollView | undefined {
  const exercise = card.exercise;
  if (!exercise || exercise.kind !== "single" && exercise.kind !== "multiple" || !boundedText(card.question, 300)) return;
  try { validateCompanionExercise(exercise); } catch { return; }
  if (!exercise.options.every(option => boundedText(option, 100)) || new Set(exercise.options.map(option => option.trim())).size !== exercise.options.length) return;
  return { question: card.question, options: exercise.options.map(text => ({ text })), type: "regular", is_anonymous: false,
    allows_multiple_answers: exercise.kind === "multiple", allows_revoting: false, shuffle_options: false,
    allow_adding_options: false, hide_results_until_closes: true };
}
/** No correct answers, formatting, added choices, URLs or anonymous voting cross this boundary. */
export function validateNativePollPayload(value: unknown): asserts value is NativePollPayload {
  record(value); keys(value, ["chat_id", "question", "options", "type", "is_anonymous", "allows_multiple_answers", "allows_revoting", "shuffle_options", "allow_adding_options", "hide_results_until_closes", "disable_notification", "close_date", "reply_markup"]);
  invalid(Number.isSafeInteger(value.chat_id) && Number(value.chat_id) > 0 && typeof value.disable_notification === "boolean");
  invalid(value.close_date === undefined || Number.isSafeInteger(value.close_date) && Number(value.close_date) > 0);
  invalid(boundedText(value.question, 300) && Array.isArray(value.options) && value.options.length >= 1 && value.options.length <= 12);
  for (const option of value.options) { record(option); keys(option, ["text"]); invalid(boundedText(option.text, 100)); }
  invalid(value.type === "regular" && value.is_anonymous === false && typeof value.allows_multiple_answers === "boolean"
    && value.allows_revoting === false && value.shuffle_options === false && value.allow_adding_options === false && value.hide_results_until_closes === true);
  if (value.reply_markup !== undefined) {
    record(value.reply_markup); keys(value.reply_markup, ["inline_keyboard"]);
    invalid(Array.isArray(value.reply_markup.inline_keyboard) && value.reply_markup.inline_keyboard.length <= 3);
    const used = new Set<string>();
    for (const row of value.reply_markup.inline_keyboard) {
      invalid(Array.isArray(row) && row.length === 1); record(row[0]); keys(row[0], ["text", "callback_data"]);
      invalid(typeof row[0].text === "string" && ["Показать ответ", "Подсказка", "Подсказки", "Пропустить сейчас"].includes(row[0].text) && !used.has(row[0].text)
        && typeof row[0].callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row[0].callback_data));
      used.add(row[0].text);
    }
  }
}
