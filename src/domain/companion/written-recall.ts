import { MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH } from "../cards/recall-test-core";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import { invalid, keys, record, validateAttempt, type ReviewAttempt } from "./protocol";

export const MAX_COMPANION_WRITTEN_ANSWER_LENGTH = 4000;
/** Learner-authored evidence, separate from the card and from automatic answer checking. */
export interface CompanionWrittenRecall {
  attempt: ReviewAttempt; answer: string; question: string; reference: string;
  criteria?: string[]; checkedCriteria?: number[];
}
export type CompanionWrittenRecallStatus = "applied" | "conflict" | "missing" | "revoked" | "expired";
export interface CompanionWrittenRecallReceipt { recall: CompanionWrittenRecall; status: CompanionWrittenRecallStatus; }
export function validateCompanionWrittenAnswer(value: unknown): asserts value is string {
  invalid(typeof value === "string" && value.length <= MAX_COMPANION_WRITTEN_ANSWER_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value));
}
export function validateCompanionSelfCheckCriteria(value: unknown): asserts value is string[] {
  invalid(Array.isArray(value) && value.length <= MAX_SELF_CHECK_CRITERIA && value.every(row => typeof row === "string" && !!row.trim() && row.length <= MAX_SELF_CHECK_CRITERION_LENGTH
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(row)));
}
export function validateCompanionCheckedCriteria(value: unknown, count = MAX_SELF_CHECK_CRITERIA): asserts value is number[] {
  invalid(Array.isArray(value) && value.length <= count && value.every((index, position, rows) => Number.isSafeInteger(index) && index >= 0 && index < count && (position === 0 || rows[position - 1] < index)));
}
export function validateCompanionWrittenRecall(value: unknown): asserts value is CompanionWrittenRecall {
  record(value); keys(value, ["attempt", "answer", "question", "reference", "criteria", "checkedCriteria"]); validateAttempt(value.attempt);
  validateCompanionWrittenAnswer(value.answer);
  for (const field of [value.question, value.reference]) invalid(typeof field === "string" && field.length > 0 && field.length <= 1800);
  if (value.criteria !== undefined) validateCompanionSelfCheckCriteria(value.criteria);
  if (value.checkedCriteria !== undefined) validateCompanionCheckedCriteria(value.checkedCriteria, value.criteria?.length ?? 0);
}
export function sameCompanionWrittenRecall(a: CompanionWrittenRecall, b: CompanionWrittenRecall): boolean { return jsonFingerprint(a) === jsonFingerprint(b); }
export function validateCompanionWrittenRecallReceipt(value: unknown, expected?: CompanionWrittenRecall): asserts value is CompanionWrittenRecallReceipt {
  record(value); keys(value, ["recall", "status"]); validateCompanionWrittenRecall(value.recall);
  invalid(!expected || sameCompanionWrittenRecall(value.recall, expected));
  invalid(["applied", "conflict", "missing", "revoked", "expired"].includes(String(value.status)));
}
