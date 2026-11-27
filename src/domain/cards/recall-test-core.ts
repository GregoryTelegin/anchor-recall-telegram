import { isExactTestAnswerCorrect, isExplicitTestAnswerCorrect, normalizeTestAnswer, type AnswerMatchMode } from "./recall-core";
import { normalizeKnowledgeGroup } from "../knowledge/knowledge-core";
import { normalizeSiblingGroupId } from "../review/sibling-spacing";
import { validateCardAttachments, type CardAttachment } from "./card-attachments";

export type TestEvaluationMode = "self" | "exact";
export type RecallTestKind = "free" | "single" | "multiple" | "cloze" | "matching" | "ordering";

export interface RecallMatchPair { left: string; right: string; }

export interface RecallTestDefinition {
  attachments?: CardAttachment[];
  answerMatchMode?: AnswerMatchMode;
  knowledgeGroup?: string;
  siblingGroupId?: string;
  siblingEnabled?: boolean;
  kind: RecallTestKind;
  prompt: string;
  evaluationMode: TestEvaluationMode;
  expectedAnswer: string;
  /** Absence retains the legacy expectedAnswer comparison, including its separators. */
  acceptedAnswers?: string[];
  /** Author-defined manual points, never an automatic correctness or rating rule. */
  selfCheckCriteria?: string[];
  hints: string[];
  options: string[];
  correctOptionIndexes: number[];
  clozeTemplate: string;
  pairs: RecallMatchPair[];
  orderItems: string[];
}

export interface RecallTestResponse {
  text: string;
  selectedOptionIndexes: number[];
  clozeAnswers: string[];
  matches: number[];
  order: number[];
}

export const MAX_STRUCTURED_TEST_ITEMS = 12;
export const DEFAULT_RECALL_HINT_LIMIT = 3;
export const MAX_RECALL_HINTS = 10;
export const MAX_ACCEPTED_ANSWERS = 12;
export const MAX_ACCEPTED_ANSWER_LENGTH = 2000;
export const MAX_SELF_CHECK_CRITERIA = 12;
export const MAX_SELF_CHECK_CRITERION_LENGTH = 500;
export const DEFAULT_CLOZE_PROMPT = "Заполните пропуски";
export const OVERVIEW_RECALL_PROMPT = "Восстановите основные идеи и структуру материала.";

export const getRecallReferenceAnswer = (test: Pick<RecallTestDefinition, "expectedAnswer" | "acceptedAnswers" | "evaluationMode">): string =>
  test.expectedAnswer || (test.evaluationMode === "exact" ? test.acceptedAnswers?.[0] : undefined) || "";

/** Call only for an explicit edit: loading an old card must not add new fields. */
export const getRecallAcceptedAnswersForEditing = (test: Pick<RecallTestDefinition, "acceptedAnswers" | "expectedAnswer" | "answerMatchMode">): string[] =>
  test.acceptedAnswers !== undefined ? [...test.acceptedAnswers] : test.answerMatchMode === "literal"
    ? test.expectedAnswer.trim() ? [test.expectedAnswer.trim()] : []
    : test.expectedAnswer.split(/[\n|]+/).map(value => value.trim()).filter(Boolean);

const normalizeAnswerList = (value: unknown, count: number, length: number): string[] | undefined => {
  if (!Array.isArray(value) || value.length > count || Array.from(value).some(item => typeof item !== "string" || !item.trim() || item.trim().length > length)) return undefined;
  return value.map(item => item.trim());
};

const TEST_KINDS = new Set<RecallTestKind>(["free", "single", "multiple", "cloze", "matching", "ordering"]);
const cleanItems = (values: unknown, limit = MAX_STRUCTURED_TEST_ITEMS): string[] =>
  (Array.isArray(values) ? values : []).filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, 500)).filter(Boolean).slice(0, limit);

export const normalizeRecallHints = (values: unknown): string[] => {
  const result: string[] = []; const seen = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    if (result.length >= MAX_RECALL_HINTS) break;
    if (typeof raw !== "string") continue;
    const value = raw.trim().slice(0, 300); const key = normalizeTestAnswer(value);
    if (!key || seen.has(key)) continue;
    seen.add(key); result.push(value);
  }
  return result;
};

export const recallTestKindLabel = (kind: RecallTestKind): string => ({
  free: "Свободный ответ", single: "Один вариант", multiple: "Несколько вариантов",
  cloze: "Пропуски", matching: "Сопоставление", ordering: "Порядок"
})[kind];

export const recallTestListTitle = (test: RecallTestDefinition | undefined, limit = 120): string => {
  if (!test) return "Вопрос не указан";
  const genericClozePrompt = test.kind === "cloze" && (!test.prompt.trim() || test.prompt.trim() === DEFAULT_CLOZE_PROMPT);
  const source = genericClozePrompt ? test.clozeTemplate.replace(/\{\{[^{}]+\}\}/g, "_____") : test.prompt;
  const title = (source || recallTestKindLabel(test.kind)).replace(/\s+/g, " ").trim();
  const safeLimit = Math.max(24, Math.min(300, Math.trunc(limit) || 120));
  if (title.length <= safeLimit) return title;
  const head = title.slice(0, safeLimit - 1).trimEnd();
  const lastSpace = head.lastIndexOf(" ");
  const clipped = lastSpace >= Math.floor(safeLimit * 0.65) ? head.slice(0, lastSpace) : head;
  return `${clipped.trimEnd()}…`;
};

export const parseMarkedChoices = (value: string): { options: string[]; correctOptionIndexes: number[] } => {
  const options: string[] = []; const correctOptionIndexes: number[] = [];
  value.split(/\r?\n/).forEach((rawLine) => {
    if (options.length >= MAX_STRUCTURED_TEST_ITEMS) return;
    const trimmed = rawLine.trim(); if (!trimmed) return;
    const marked = /^(?:\*|\[x\])\s*/i.test(trimmed);
    const option = trimmed.replace(/^(?:\*|\[x\])\s*/i, "").trim().slice(0, 500); if (!option) return;
    if (marked) correctOptionIndexes.push(options.length);
    options.push(option);
  });
  return { options, correctOptionIndexes };
};

export const formatMarkedChoices = (test?: Partial<RecallTestDefinition>): string =>
  (test?.options ?? []).map((option, index) => `${test?.correctOptionIndexes?.includes(index) ? "*" : ""}${option}`).join("\n");

export const parseMatchingPairs = (value: string): RecallMatchPair[] => {
  const pairs: RecallMatchPair[] = [];
  value.split(/\r?\n/).forEach((rawLine) => {
    if (pairs.length >= MAX_STRUCTURED_TEST_ITEMS) return;
    const line = rawLine.trim(); if (!line) return;
    const match = line.match(/^(.+?)\s*(?:=>|→|=)\s*(.+)$/); if (!match) return;
    const left = match[1].trim().slice(0, 500); const right = match[2].trim().slice(0, 500);
    if (left && right) pairs.push({ left, right });
  });
  return pairs;
};

export const formatMatchingPairs = (pairs: RecallMatchPair[] = []): string => pairs.map((pair) => `${pair.left} = ${pair.right}`).join("\n");
export const parseOrderedItems = (value: string): string[] => cleanItems(value.split(/\r?\n/));

export const extractClozeAnswers = (template: string): string[] => {
  const answers: string[] = []; const expression = /\{\{([^{}]+)\}\}/g; let match: RegExpExecArray | null;
  while ((match = expression.exec(template)) && answers.length < MAX_STRUCTURED_TEST_ITEMS) {
    const answer = match[1].trim().slice(0, 500); if (answer) answers.push(answer);
  }
  return answers;
};

export const normalizeRecallTest = (value: Partial<RecallTestDefinition> | undefined): RecallTestDefinition | undefined => {
  if (!value) return undefined;
  const attachments = validateCardAttachments(value.attachments);
  if (!attachments.valid) return undefined;
  if (value.answerMatchMode !== undefined && value.answerMatchMode !== "text" && value.answerMatchMode !== "literal") return undefined;
  if (value.siblingGroupId !== undefined && (typeof value.siblingGroupId !== "string"
    || value.siblingGroupId.normalize("NFKC").replace(/\s+/gu, " ").trim().length > 512)) return undefined;
  if (value.siblingEnabled !== undefined && typeof value.siblingEnabled !== "boolean") return undefined;
  const siblingGroupId = normalizeSiblingGroupId(value.siblingGroupId);
  if (value.siblingEnabled !== undefined && !siblingGroupId) return undefined;
  const kind = TEST_KINDS.has(value.kind as RecallTestKind) ? value.kind as RecallTestKind : "free";
  if (kind !== "free" && (value.acceptedAnswers !== undefined || value.selfCheckCriteria !== undefined)) return undefined;
  const enteredPrompt = typeof value.prompt === "string" ? value.prompt.trim().slice(0, 500) : "";
  const prompt = enteredPrompt || (kind === "cloze" ? DEFAULT_CLOZE_PROMPT : ""); if (!prompt) return undefined;
  const knowledgeGroup = normalizeKnowledgeGroup(value.knowledgeGroup);
  const comparison = value.answerMatchMode === "literal" && (kind === "free" || kind === "cloze") ? { answerMatchMode: "literal" as const } : {};
  const empty = { ...(attachments.attachments !== undefined ? { attachments: attachments.attachments } : {}), ...(knowledgeGroup ? { knowledgeGroup } : {}),
    ...(siblingGroupId ? { siblingGroupId, ...(value.siblingEnabled !== undefined ? { siblingEnabled: value.siblingEnabled } : {}) } : {}),
    hints: normalizeRecallHints(value.hints), options: [] as string[], correctOptionIndexes: [] as number[], clozeTemplate: "", pairs: [] as RecallMatchPair[], orderItems: [] as string[] };
  if (kind === "free") {
    const evaluationMode: TestEvaluationMode = value.evaluationMode === "exact" ? "exact" : "self";
    const expectedAnswer = typeof value.expectedAnswer === "string" ? value.expectedAnswer.trim().slice(0, 2000) : "";
    const acceptedAnswers = value.acceptedAnswers === undefined ? undefined : normalizeAnswerList(value.acceptedAnswers, MAX_ACCEPTED_ANSWERS, MAX_ACCEPTED_ANSWER_LENGTH);
    const selfCheckCriteria = value.selfCheckCriteria === undefined ? undefined : normalizeAnswerList(value.selfCheckCriteria, MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH);
    if (value.acceptedAnswers !== undefined && acceptedAnswers === undefined || value.selfCheckCriteria !== undefined && selfCheckCriteria === undefined) return undefined;
    if (evaluationMode === "exact" && (acceptedAnswers === undefined ? !expectedAnswer : !acceptedAnswers.length
      || value.answerMatchMode !== "literal" && acceptedAnswers.some(answer => !normalizeTestAnswer(answer)))) return undefined;
    return { kind, prompt, evaluationMode, expectedAnswer, ...empty, ...comparison,
      ...(acceptedAnswers !== undefined ? { acceptedAnswers } : {}), ...(selfCheckCriteria !== undefined ? { selfCheckCriteria } : {}) };
  }
  if (kind === "single" || kind === "multiple") {
    const options = cleanItems(value.options);
    const correctOptionIndexes = [...new Set(Array.isArray(value.correctOptionIndexes) ? value.correctOptionIndexes : [])]
      .filter((index): index is number => Number.isInteger(index) && index >= 0 && index < options.length).slice(0, options.length);
    if (options.length < 2 || !correctOptionIndexes.length || (kind === "single" && correctOptionIndexes.length !== 1)) return undefined;
    return { kind, prompt, evaluationMode: "exact", expectedAnswer: "", ...empty, options, correctOptionIndexes };
  }
  if (kind === "cloze") {
    const clozeTemplate = typeof value.clozeTemplate === "string" ? value.clozeTemplate.trim().slice(0, 4000) : "";
    if (!clozeTemplate || !extractClozeAnswers(clozeTemplate).length) return undefined;
    return { kind, prompt, evaluationMode: "exact", expectedAnswer: "", ...empty, clozeTemplate, ...comparison };
  }
  if (kind === "matching") {
    const pairs = (Array.isArray(value.pairs) ? value.pairs : []).filter((pair): pair is RecallMatchPair => Boolean(pair) && typeof pair.left === "string" && typeof pair.right === "string")
      .map((pair) => ({ left: pair.left.trim().slice(0, 500), right: pair.right.trim().slice(0, 500) })).filter((pair) => pair.left && pair.right).slice(0, MAX_STRUCTURED_TEST_ITEMS);
    const uniqueLeft = new Set(pairs.map((pair) => normalizeTestAnswer(pair.left))).size === pairs.length;
    const uniqueRight = new Set(pairs.map((pair) => normalizeTestAnswer(pair.right))).size === pairs.length;
    if (pairs.length < 2 || !uniqueLeft || !uniqueRight) return undefined;
    return { kind, prompt, evaluationMode: "exact", expectedAnswer: "", ...empty, pairs };
  }
  const orderItems = cleanItems(value.orderItems);
  if (orderItems.length < 2 || new Set(orderItems.map(normalizeTestAnswer)).size !== orderItems.length) return undefined;
  return { kind, prompt, evaluationMode: "exact", expectedAnswer: "", ...empty, orderItems };
};

const sameIndexes = (actual: number[], expected: number[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

export const evaluateRecallTest = (test: RecallTestDefinition, response: RecallTestResponse): boolean | null => {
  if (test.kind === "free") return test.evaluationMode === "self" ? null : test.acceptedAnswers !== undefined
    ? isExplicitTestAnswerCorrect(response.text, test.acceptedAnswers, test.answerMatchMode)
    : isExactTestAnswerCorrect(response.text, test.expectedAnswer, test.answerMatchMode);
  if (test.kind === "single" || test.kind === "multiple") {
    const actual = [...new Set(response.selectedOptionIndexes)].sort((a, b) => a - b);
    const expected = [...test.correctOptionIndexes].sort((a, b) => a - b);
    return sameIndexes(actual, expected);
  }
  if (test.kind === "cloze") {
    const expected = extractClozeAnswers(test.clozeTemplate);
    return response.clozeAnswers.length === expected.length && expected.every((answer, index) => isExactTestAnswerCorrect(response.clozeAnswers[index] ?? "", answer, test.answerMatchMode));
  }
  if (test.kind === "matching") return sameIndexes(response.matches, test.pairs.map((_, index) => index));
  return sameIndexes(response.order, test.orderItems.map((_, index) => index));
};

export const shuffledIndexes = (length: number, random: () => number = Math.random): number[] => {
  const result = Array.from({ length }, (_, index) => index);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  if (length > 1 && result.every((value, index) => value === index)) result.push(result.shift() as number);
  return result;
};

export const moveOrderItem = <T>(values: T[], fromIndex: number, toIndex: number): T[] => {
  if (fromIndex < 0 || fromIndex >= values.length || toIndex < 0 || toIndex >= values.length || fromIndex === toIndex) return [...values];
  const result = [...values];
  const [item] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, item);
  return result;
};
