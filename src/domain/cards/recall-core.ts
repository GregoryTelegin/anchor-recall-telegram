export const normalizeTestAnswer = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "");

export type AnswerMatchMode = "text" | "literal";

/** Explicit list entries are whole answers; separators inside them are literal. */
export const isExplicitTestAnswerCorrect = (answer: string, expected: readonly string[], mode: AnswerMatchMode = "text"): boolean => {
  const normalize = mode === "literal" ? (value: string): string => value.replace(/\r\n?/g, "\n").trim() : normalizeTestAnswer;
  const actual = normalize(answer);
  return Boolean(actual) && expected.some(value => actual === normalize(value));
};

/** Literal comparison preserves operators, case, internal whitespace and line breaks.
 * Only platform line endings and whitespace surrounding the whole answer are ignored. */
export const isExactTestAnswerCorrect = (answer: string, expected: string, mode: AnswerMatchMode = "text"): boolean => {
  if (mode === "literal") {
    const normalize = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
    const actual = normalize(answer);
    return Boolean(actual) && actual === normalize(expected);
  }
  const normalized = normalizeTestAnswer(answer);
  return Boolean(normalized) && expected.split(/[\n|]+/).map(normalizeTestAnswer).filter(Boolean).includes(normalized);
};
