import { evaluateRecallTest, extractClozeAnswers, type RecallTestDefinition } from "../cards/recall-test-core";
import { normalizeTestAnswer, type AnswerMatchMode } from "../cards/recall-core";

export type CompanionExercise = { kind: "single" | "multiple"; options: string[]; correctOptionIndexes: number[] }
  | { kind: "cloze"; clozeTemplate: string; answerMatchMode?: AnswerMatchMode }
  | { kind: "matching"; pairs: { left: string; right: string }[] }
  | { kind: "ordering"; orderItems: string[] };
export type CompanionChoiceExercise = Extract<CompanionExercise, { kind: "single" | "multiple" }>;
export interface CompanionExerciseResponse { selectedOptionIndexes?: number[]; clozeAnswers?: string[]; matches?: number[]; order?: number[]; }

const check = (condition: unknown): void => { if (!condition) throw new Error("invalid companion exercise"); };
const embeddedMedia = /!\[|<(?:img|audio|video|iframe|object|embed|svg|picture|canvas)\b/i;
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !embeddedMedia.test(value);
export function validateCompanionPermutation(value: unknown, count?: number): asserts value is number[] {
  check(Array.isArray(value) && value.length >= 2 && value.length <= 12 && (count === undefined || value.length === count)
    && Array.from(value).every(index => Number.isSafeInteger(index) && index >= 0 && index < value.length) && new Set(value).size === value.length);
}

/** Private transfer projection only; never normalize, truncate or reinterpret an authored test. */
export function validateCompanionExercise(value: unknown): asserts value is CompanionExercise {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const ex = value as Record<string, unknown>;
  if (ex.kind === "single" || ex.kind === "multiple") {
    check(Object.keys(ex).every(key => ["kind", "options", "correctOptionIndexes"].includes(key)));
    check(Array.isArray(ex.options) && ex.options.length >= 2 && ex.options.length <= 12 && Array.from(ex.options).every(option => boundedText(option, 500)));
    const options = ex.options as string[], indexes = ex.correctOptionIndexes;
    check(Array.isArray(indexes) && indexes.length > 0 && indexes.length <= options.length
      && (ex.kind !== "single" || indexes.length === 1));
    check(Array.from(indexes as unknown[]).every(index => Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < options.length)
      && new Set(indexes as number[]).size === (indexes as number[]).length);
  } else if (ex.kind === "matching") {
    check(Object.keys(ex).every(key => ["kind", "pairs"].includes(key)) && Array.isArray(ex.pairs) && ex.pairs.length >= 2 && ex.pairs.length <= 12);
    const pairs = ex.pairs as { left: string; right: string }[];
    check(Array.from(pairs).every(pair => pair !== null && typeof pair === "object" && !Array.isArray(pair)
      && Object.keys(pair).every(key => ["left", "right"].includes(key)) && boundedText(pair.left, 500) && boundedText(pair.right, 500)));
    check(new Set(pairs.map(pair => normalizeTestAnswer(pair.left))).size === pairs.length && new Set(pairs.map(pair => normalizeTestAnswer(pair.right))).size === pairs.length);
  } else if (ex.kind === "ordering") {
    check(Object.keys(ex).every(key => ["kind", "orderItems"].includes(key)) && Array.isArray(ex.orderItems) && ex.orderItems.length >= 2 && ex.orderItems.length <= 12);
    const items = ex.orderItems as string[];
    check(Array.from(items).every(item => boundedText(item, 500)) && new Set(items.map(normalizeTestAnswer)).size === items.length);
  } else {
    check(ex.kind === "cloze" && Object.keys(ex).every(key => ["kind", "clozeTemplate", "answerMatchMode"].includes(key)));
    check(boundedText(ex.clozeTemplate, 1800) && (ex.answerMatchMode === undefined || ex.answerMatchMode === "text" || ex.answerMatchMode === "literal"));
    const matches = [...(ex.clozeTemplate as string).matchAll(/\{\{([^{}]+)\}\}/g)];
    check(matches.length > 0 && matches.length <= 12 && matches.every(match => match[1].trim().length > 0 && match[1].trim().length <= 500));
    // A multi-line literal blank cannot be separated losslessly from the next reply line.
    check(ex.answerMatchMode !== "literal" || matches.length === 1 || matches.every(match => !/[\r\n]/.test(match[1].trim())));
  }
  check(companionExerciseReference(value as CompanionExercise).length <= 1800);
}

export function projectCompanionExercise(test: RecallTestDefinition): CompanionExercise | undefined {
  try {
    const ex = test.kind === "single" || test.kind === "multiple" ? { kind: test.kind, options: [...test.options], correctOptionIndexes: [...test.correctOptionIndexes] }
      : test.kind === "cloze" ? { kind: "cloze" as const, clozeTemplate: test.clozeTemplate, ...(test.answerMatchMode === undefined ? {} : { answerMatchMode: test.answerMatchMode }) }
      : test.kind === "matching" ? { kind: "matching" as const, pairs: test.pairs.map(pair => ({ ...pair })) }
      : test.kind === "ordering" ? { kind: "ordering" as const, orderItems: [...test.orderItems] } : undefined;
    if (!ex) return;
    validateCompanionExercise(ex); return ex;
  } catch { return undefined; }
}

export function companionExerciseReference(ex: CompanionExercise): string {
  return ex.kind === "cloze" ? ex.clozeTemplate.replace(/\{\{([^{}]+)\}\}/g, (_, answer: string) => answer.trim())
    : ex.kind === "matching" ? ex.pairs.map(pair => `${pair.left} → ${pair.right}`).join("\n")
    : ex.kind === "ordering" ? ex.orderItems.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : ex.options.filter((_, index) => ex.correctOptionIndexes.includes(index)).join("\n");
}

export function companionExerciseQuestion(ex: CompanionExercise, prompt: string): string {
  if (ex.kind === "matching" || ex.kind === "ordering") return prompt;
  let index = 0;
  const body = ex.kind === "cloze" ? ex.clozeTemplate.replace(/\{\{([^{}]+)\}\}/g, () => `[${++index}] _____`)
    : ex.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  return `${prompt}\n\n${body}`;
}

export function companionExerciseBlankCount(ex: CompanionExercise): number {
  return ex.kind === "cloze" ? extractClozeAnswers(ex.clozeTemplate).length : 0;
}

export function evaluateCompanionExercise(ex: CompanionExercise, response: CompanionExerciseResponse): boolean {
  validateCompanionExercise(ex);
  const selected = response.selectedOptionIndexes ?? [], answers = response.clozeAnswers ?? [];
  check(Array.isArray(selected) && selected.length <= 12 && Array.from(selected).every(index => Number.isSafeInteger(index) && index >= 0 && (ex.kind === "single" || ex.kind === "multiple") && index < ex.options.length));
  check(Array.isArray(answers) && answers.length <= 12 && Array.from(answers).every(answer => typeof answer === "string" && answer.length <= 2000));
  if (ex.kind === "matching" || ex.kind === "ordering") {
    check(response.selectedOptionIndexes === undefined && response.clozeAnswers === undefined && (ex.kind === "matching" ? response.order === undefined : response.matches === undefined));
    validateCompanionPermutation(ex.kind === "matching" ? response.matches : response.order, ex.kind === "matching" ? ex.pairs.length : ex.orderItems.length);
  } else check(response.matches === undefined && response.order === undefined);
  const choice = ex.kind === "single" || ex.kind === "multiple" ? ex : undefined;
  const definition: RecallTestDefinition = { kind: ex.kind, prompt: "Telegram", evaluationMode: "exact", expectedAnswer: "", hints: [],
    options: choice?.options ?? [], correctOptionIndexes: choice?.correctOptionIndexes ?? [],
    clozeTemplate: ex.kind === "cloze" ? ex.clozeTemplate : "", pairs: ex.kind === "matching" ? ex.pairs : [], orderItems: ex.kind === "ordering" ? ex.orderItems : [],
    ...(ex.kind === "cloze" && ex.answerMatchMode ? { answerMatchMode: ex.answerMatchMode } : {}) };
  return evaluateRecallTest(definition, { text: "", selectedOptionIndexes: selected, clozeAnswers: answers, matches: response.matches ?? [], order: response.order ?? [] }) === true;
}
