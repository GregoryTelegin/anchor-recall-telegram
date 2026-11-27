import { MAX_ACCEPTED_ANSWERS, MAX_ACCEPTED_ANSWER_LENGTH, MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH, MAX_RECALL_HINTS, MAX_STRUCTURED_TEST_ITEMS, normalizeRecallTest, type RecallTestDefinition } from "../cards/recall-test-core";
import { normalizeTestAnswer } from "../cards/recall-core";
import { validateCardAttachments } from "../cards/card-attachments";

const kinds = new Set(["free", "single", "multiple", "cloze", "matching", "ordering"]);
const fields = new Set(["kind", "prompt", "evaluationMode", "expectedAnswer", "acceptedAnswers", "selfCheckCriteria", "hints", "options", "correctOptionIndexes", "clozeTemplate", "pairs", "orderItems", "knowledgeGroup", "siblingGroupId", "siblingEnabled", "answerMatchMode", "attachments"]);

/** Import/export must report loss before the permissive storage normalizer can trim it. */
export function validateTopicCard(value: unknown, label: string): RecallTestDefinition {
  const fail = (message: string): never => { throw new Error(`${label}: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("неверная структура карточки.");
  const card = value as Record<string, unknown>;
  const attachments = validateCardAttachments(card.attachments);
  if (!attachments.valid) return fail(attachments.error);
  const unknown = Object.keys(card).filter(key => !fields.has(key));
  if (unknown.length) return fail(`неподдерживаемые поля: ${unknown.join(", ")}.`);
  if (typeof card.kind !== "string" || !kinds.has(card.kind)) return fail("укажите поддерживаемый тип карточки.");
  const text = (key: string, limit: number): string => {
    const raw = card[key];
    if (raw === undefined) return "";
    if (typeof raw !== "string") return fail(`поле «${key}» должно быть строкой.`);
    if (raw.trim().length > limit) return fail(`поле «${key}» превышает ${limit} символов.`);
    return raw.trim();
  };
  text("prompt", 500); text("expectedAnswer", 2000); text("clozeTemplate", 4000);
  const group = text("knowledgeGroup", 120).normalize("NFKC").replace(/\s+/gu, " ");
  if (group.length > 120) return fail("группа знания превышает 120 символов после нормализации.");
  const siblings = text("siblingGroupId", 512).normalize("NFKC").replace(/\s+/gu, " ");
  if (card.siblingGroupId !== undefined && (!siblings || siblings.length > 512)) return fail("идентификатор соседних карточек должен содержать от 1 до 512 символов после нормализации.");
  if (card.siblingEnabled !== undefined && (typeof card.siblingEnabled !== "boolean" || !siblings)) return fail("siblingEnabled должен быть логическим значением при заданном siblingGroupId.");
  if (card.evaluationMode !== undefined && card.evaluationMode !== "self" && card.evaluationMode !== "exact") return fail("неизвестный способ проверки ответа.");
  if (card.answerMatchMode !== undefined && card.answerMatchMode !== "text" && card.answerMatchMode !== "literal") return fail("неизвестный способ сравнения записи.");
  const strings = (key: string, count: number, length: number): string[] => {
    const values = card[key]; if (values === undefined) return [];
    if (!Array.isArray(values)) return fail(`поле «${key}» должно быть массивом.`);
    if (values.length > count) return fail(`поле «${key}»: максимум ${count} элементов.`);
    return values.map((item, index) => {
      if (typeof item !== "string" || !item.trim()) return fail(`поле «${key}», элемент ${index + 1}: нужна непустая строка.`);
      if (item.trim().length > length) return fail(`поле «${key}», элемент ${index + 1}: максимум ${length} символов.`);
      return item.trim();
    });
  };
  const hints = strings("hints", MAX_RECALL_HINTS, 300);
  const acceptedAnswers = strings("acceptedAnswers", MAX_ACCEPTED_ANSWERS, MAX_ACCEPTED_ANSWER_LENGTH);
  strings("selfCheckCriteria", MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH);
  if (card.kind !== "free" && (card.acceptedAnswers !== undefined || card.selfCheckCriteria !== undefined)) return fail("отдельные варианты и критерии доступны только для свободного ответа.");
  if (card.kind === "free" && card.evaluationMode === "exact" && card.acceptedAnswers !== undefined
    && (!acceptedAnswers.length || card.answerMatchMode !== "literal" && acceptedAnswers.some(answer => !normalizeTestAnswer(answer)))) return fail("добавьте непустые принимаемые варианты для выбранного способа сравнения.");
  if (hints.some(hint => !normalizeTestAnswer(hint)) || new Set(hints.map(normalizeTestAnswer)).size !== hints.length) return fail("подсказки содержат пустые значения или повторения.");
  strings("options", MAX_STRUCTURED_TEST_ITEMS, 500); strings("orderItems", MAX_STRUCTURED_TEST_ITEMS, 500);
  if (card.pairs !== undefined) {
    if (!Array.isArray(card.pairs) || card.pairs.length > MAX_STRUCTURED_TEST_ITEMS) return fail(`поле «pairs»: нужен массив не более ${MAX_STRUCTURED_TEST_ITEMS} пар.`);
    card.pairs.forEach((pair, index) => {
      if (!pair || typeof pair !== "object" || Array.isArray(pair)) return fail(`пара ${index + 1}: неверная структура.`);
      const data = pair as Record<string, unknown>;
      if (Object.keys(data).some(key => key !== "left" && key !== "right")) return fail(`пара ${index + 1}: поддерживаются только left и right.`);
      for (const key of ["left", "right"]) if (typeof data[key] !== "string" || !data[key].trim() || data[key].trim().length > 500) return fail(`пара ${index + 1}: обе стороны должны содержать от 1 до 500 символов.`);
    });
  }
  if (card.correctOptionIndexes !== undefined) {
    const indexes = card.correctOptionIndexes;
    if (!Array.isArray(indexes) || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= (Array.isArray(card.options) ? card.options.length : 0))) return fail("неверные или повторяющиеся индексы правильных вариантов.");
  }
  if (card.kind === "cloze") {
    const source = text("clozeTemplate", 4000), matches = [...source.matchAll(/\{\{([^{}]+)\}\}/g)];
    if (matches.length > MAX_STRUCTURED_TEST_ITEMS || matches.some(match => !match[1].trim() || match[1].trim().length > 500)) return fail(`максимум ${MAX_STRUCTURED_TEST_ITEMS} непустых пропусков, до 500 символов каждый.`);
    if (/\{\{|\}\}/.test(source.replace(/\{\{([^{}]+)\}\}/g, ""))) return fail("пустой, вложенный или незакрытый пропуск.");
  }
  const normalized = normalizeRecallTest(card as Partial<RecallTestDefinition>);
  if (!normalized) return fail("неполные или неоднозначные данные выбранного типа.");
  for (const key of ["expectedAnswer", "clozeTemplate", "options", "correctOptionIndexes", "pairs", "orderItems"] as const) {
    const raw = card[key];
    const filled = typeof raw === "string" ? Boolean(raw.trim()) : Array.isArray(raw) && raw.length > 0;
    const active = normalized[key];
    if (filled && (typeof active === "string" ? !active : !active.length)) return fail(`поле «${key}» не используется выбранным типом и не будет сохранено.`);
  }
  if (card.evaluationMode !== undefined && card.evaluationMode !== normalized.evaluationMode) return fail("выбранный тип поддерживает только точную проверку.");
  if (card.answerMatchMode === "literal" && normalized.answerMatchMode !== "literal") return fail("строгое сравнение доступно только для свободного ответа и пропусков.");
  return normalized;
}
