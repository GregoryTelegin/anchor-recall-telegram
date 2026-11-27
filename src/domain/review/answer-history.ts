import { MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH } from "../cards/recall-test-core";
import type { AnswerMatchMode } from "../cards/recall-core";
import { compactSourceFingerprint } from "../cards/import-source-identity";
import { jsonFingerprint } from "../../shared/json-fingerprint";

export const MAX_ANSWER_HISTORY_TEXT_LENGTH = 30_000;
export const MAX_ANSWER_HISTORY_CONTEXT_LENGTH = 30_000;
export type AnswerHistoryQuestionKind = "exact" | "self" | "single" | "multiple" | "cloze" | "matching" | "ordering";
export interface AnswerRetentionPolicy { enabled: boolean; changedAt: number; }
export interface AnswerHistoryEvidence {
  attemptId: string; cardId: string; mode: "core" | "bank"; occurredAt: number;
  kind: AnswerHistoryQuestionKind; question: string; reference: string; answerMatch: boolean | null;
  /** Matched answers use the immutable reference; wrong/self/unchecked answers may retain learner text. */
  answer?: string;
  answerMatchMode?: AnswerMatchMode;
  criteria?: string[]; checkedCriteria?: number[];
}
export interface WrongAnswerPattern {
  cardId: string; kind: AnswerHistoryQuestionKind; referenceId: string;
  question: string; reference: string; answer: string; normalizedAnswer: string;
  count: number; firstOccurredAt: number; lastOccurredAt: number;
}

const fields = ["attemptId", "cardId", "mode", "occurredAt", "kind", "question", "reference", "answerMatch", "answer", "answerMatchMode", "criteria", "checkedCriteria"];
const kinds: readonly string[] = ["exact", "self", "single", "multiple", "cloze", "matching", "ordering"];
const fail = (): never => { throw new Error("Некорректная запись истории ответов."); };
const check = (value: unknown): void => { if (!value) fail(); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const dense = (value: unknown[]): boolean => Array.from({ length: value.length }, (_, index) => own(value, String(index))).every(Boolean);
const token = (value: unknown): boolean => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const timestamp = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

export function validateAnswerRetentionPolicy(value: unknown): asserts value is AnswerRetentionPolicy {
  check(object(value) && Object.keys(value).length === 2 && own(value, "enabled") && own(value, "changedAt"));
  const policy = value as AnswerRetentionPolicy;
  check(typeof policy.enabled === "boolean" && timestamp(policy.changedAt));
}

/** Strict storage/transport boundary; do not normalize malformed evidence into apparently valid history. */
export function validateAnswerHistoryEvidence(value: unknown): asserts value is AnswerHistoryEvidence {
  check(object(value) && Object.keys(value).every(key => fields.includes(key)));
  const evidence = value as AnswerHistoryEvidence;
  for (const key of ["attemptId", "cardId", "mode", "occurredAt", "kind", "question", "reference", "answerMatch"]) check(own(evidence, key));
  check(token(evidence.attemptId) && token(evidence.cardId) && ["core", "bank"].includes(evidence.mode) && timestamp(evidence.occurredAt));
  check(kinds.includes(evidence.kind) && text(evidence.question, MAX_ANSWER_HISTORY_CONTEXT_LENGTH) && !!evidence.question.trim()
    && text(evidence.reference, MAX_ANSWER_HISTORY_CONTEXT_LENGTH));
  check(evidence.answerMatch === true || evidence.answerMatch === false || evidence.answerMatch === null);
  if (evidence.kind === "self") check(evidence.answerMatch === null);
  else check(evidence.criteria === undefined && evidence.checkedCriteria === undefined);
  if (evidence.kind === "self" || evidence.answerMatch === false) check(own(evidence, "answer") && text(evidence.answer, MAX_ANSWER_HISTORY_TEXT_LENGTH));
  else if (evidence.answerMatch === true) check(!own(evidence, "answer"));
  else if (own(evidence, "answer")) check(text(evidence.answer, MAX_ANSWER_HISTORY_TEXT_LENGTH));
  if (evidence.answerMatchMode !== undefined) check(["exact", "cloze"].includes(evidence.kind) && ["text", "literal"].includes(evidence.answerMatchMode));
  if (evidence.criteria !== undefined) check(Array.isArray(evidence.criteria) && dense(evidence.criteria) && evidence.criteria.length <= MAX_SELF_CHECK_CRITERIA
    && evidence.criteria.every(row => text(row, MAX_SELF_CHECK_CRITERION_LENGTH) && !!row.trim()));
  if (evidence.checkedCriteria !== undefined) {
    const values = evidence.checkedCriteria, count = evidence.criteria?.length ?? 0;
    check(Array.isArray(values) && dense(values) && values.length <= count && values.every((index, position) => Number.isSafeInteger(index) && index >= 0 && index < count
      && (position === 0 || values[position - 1] < index)));
  }
  // A mental answer may retain a checklist without inventing learner-authored prose.
  if (evidence.kind === "self" && !evidence.answer!.trim()) check(Boolean(evidence.checkedCriteria?.length));
}

/** Used only when the global retention switch is on; callers skip empty mental answers without a checklist. */
export function createAnswerHistoryEvidence(input: AnswerHistoryEvidence): AnswerHistoryEvidence {
  check(object(input) && Object.keys(input).every(key => fields.includes(key)));
  const value: AnswerHistoryEvidence = { ...input };
  if (value.kind !== "self" && (value.answerMatch === true || value.answerMatch === null && value.answer === undefined)) delete value.answer;
  if (input.criteria !== undefined) value.criteria = [...input.criteria];
  if (input.checkedCriteria !== undefined) value.checkedCriteria = [...input.checkedCriteria];
  validateAnswerHistoryEvidence(value); return value;
}

export function sameAnswerHistoryEvidence(left: AnswerHistoryEvidence, right: AnswerHistoryEvidence): boolean {
  return jsonFingerprint(left) === jsonFingerprint(right);
}

/** Key for a shared immutable context table; checked criteria belong to the attempt, not its reference. */
export function answerHistoryReferenceId(evidence: Pick<AnswerHistoryEvidence, "question" | "reference" | "criteria">): string {
  check(text(evidence.question, MAX_ANSWER_HISTORY_CONTEXT_LENGTH) && !!evidence.question.trim() && text(evidence.reference, MAX_ANSWER_HISTORY_CONTEXT_LENGTH));
  if (evidence.criteria !== undefined) check(Array.isArray(evidence.criteria) && dense(evidence.criteria) && evidence.criteria.length <= MAX_SELF_CHECK_CRITERIA
    && evidence.criteria.every(row => text(row, MAX_SELF_CHECK_CRITERION_LENGTH) && !!row.trim()));
  return compactSourceFingerprint(jsonFingerprint({ question: evidence.question, reference: evidence.reference, ...(evidence.criteria === undefined ? {} : { criteria: evidence.criteria }) })!);
}

/** For matched answers this is the historical reference, never a claim about the learner's exact wording. */
export function answerHistoryDisplayAnswer(evidence: AnswerHistoryEvidence): string {
  validateAnswerHistoryEvidence(evidence); return evidence.answerMatch === true ? evidence.reference : evidence.answer ?? "";
}

/** Group surface-equivalent mistakes only; case, punctuation and meaning are not inferred. */
export function normalizeRecurringAnswer(answer: string, matchMode: AnswerMatchMode = "text"): string {
  check(text(answer, MAX_ANSWER_HISTORY_TEXT_LENGTH) && ["text", "literal"].includes(matchMode));
  return matchMode === "literal" ? answer : answer.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function aggregateWrongAnswerEvidence(evidences: readonly AnswerHistoryEvidence[]): WrongAnswerPattern[] {
  const seen = new Map<string, AnswerHistoryEvidence>(), patterns = new Map<string, WrongAnswerPattern>();
  for (const evidence of evidences) {
    validateAnswerHistoryEvidence(evidence);
    const identity = jsonFingerprint([evidence.mode, evidence.cardId, evidence.attemptId])!, prior = seen.get(identity);
    if (prior) { check(sameAnswerHistoryEvidence(prior, evidence)); continue; } seen.set(identity, evidence);
    if (evidence.answerMatch !== false) continue;
    const referenceId = answerHistoryReferenceId(evidence), normalizedAnswer = normalizeRecurringAnswer(evidence.answer!, evidence.answerMatchMode);
    const key = jsonFingerprint([evidence.cardId, evidence.kind, referenceId, evidence.answerMatchMode ?? "text", normalizedAnswer])!, pattern = patterns.get(key);
    if (pattern) { pattern.count++; pattern.firstOccurredAt = Math.min(pattern.firstOccurredAt, evidence.occurredAt);
      if (evidence.occurredAt >= pattern.lastOccurredAt) { pattern.lastOccurredAt = evidence.occurredAt; pattern.answer = evidence.answer!; }
    } else patterns.set(key, { cardId: evidence.cardId, kind: evidence.kind, referenceId, question: evidence.question, reference: evidence.reference,
      answer: evidence.answer!, normalizedAnswer, count: 1, firstOccurredAt: evidence.occurredAt, lastOccurredAt: evidence.occurredAt });
  }
  return [...patterns.values()].sort((a, b) => b.count - a.count || b.lastOccurredAt - a.lastOccurredAt || a.cardId.localeCompare(b.cardId) || a.normalizedAnswer.localeCompare(b.normalizedAnswer));
}
