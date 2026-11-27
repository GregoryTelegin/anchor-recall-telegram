export const CARD_CLARIFICATION_REASONS = [
  { value: "unclear-question", label: "Неясный вопрос" },
  { value: "disputed-answer", label: "Спорный ответ" },
  { value: "too-much-information", label: "Слишком много информации" },
  { value: "missing-context", label: "Не хватает контекста" },
  { value: "other", label: "Другая причина" }
] as const;
export type CardClarificationReason = typeof CARD_CLARIFICATION_REASONS[number]["value"];
export interface CardClarification { reason?: CardClarificationReason; note?: string; }
export const MAX_CLARIFICATION_NOTE_LENGTH = 4000;

/** Empty text clears an annotation; nonempty text retains the learner's formatting. */
export function normalizeCardClarification(value: unknown): CardClarification | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => key !== "reason" && key !== "note"))
    throw new Error("Повреждено пояснение к карточке.");
  const raw = value as Record<string, unknown>;
  if (raw.reason !== undefined && !CARD_CLARIFICATION_REASONS.some(reason => reason.value === raw.reason))
    throw new Error("Выберите допустимую причину уточнения.");
  if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > MAX_CLARIFICATION_NOTE_LENGTH))
    throw new Error(`Заметка: не более ${MAX_CLARIFICATION_NOTE_LENGTH} символов.`);
  const reason = raw.reason as CardClarificationReason | undefined;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note : undefined;
  return reason === undefined && note === undefined ? undefined : { ...(reason !== undefined ? { reason } : {}), ...(note !== undefined ? { note } : {}) };
}

export function isValidCardClarification(value: unknown): boolean {
  try { normalizeCardClarification(value); return true; } catch { return false; }
}

/** Notes and the manual flag have their own optimistic-concurrency scope. */
export function cardClarificationFingerprint(card: { needsClarification?: boolean; clarification?: unknown }): string {
  if (card.needsClarification !== undefined && typeof card.needsClarification !== "boolean")
    throw new Error("Повреждена отметка уточнения.");
  return JSON.stringify([card.needsClarification === true, normalizeCardClarification(card.clarification) ?? null]);
}
