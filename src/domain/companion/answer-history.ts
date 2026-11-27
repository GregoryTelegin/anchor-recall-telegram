import { invalid, keys, record, sameAttempt, validateAttempt, type ReviewAttempt } from "./protocol";
import { sameAnswerHistoryEvidence, validateAnswerHistoryEvidence, type AnswerHistoryEvidence } from "../review/answer-history";

export interface CompanionAnswerHistory { attempt: ReviewAttempt; evidence: AnswerHistoryEvidence; }
export type CompanionAnswerHistoryStatus = "applied" | "conflict" | "missing" | "revoked" | "expired";
export interface CompanionAnswerHistoryReceipt { record: CompanionAnswerHistory; status: CompanionAnswerHistoryStatus; }
export function validateCompanionAnswerHistory(value: unknown): asserts value is CompanionAnswerHistory {
  record(value); keys(value, ["attempt", "evidence"]); validateAttempt(value.attempt); validateAnswerHistoryEvidence(value.evidence);
  const attempt = value.attempt, evidence = value.evidence;
  invalid(attempt.id === evidence.attemptId && attempt.cardId === evidence.cardId && attempt.mode === evidence.mode && attempt.occurredAt === evidence.occurredAt,
    "Answer evidence differs from its grade identity");
}
export function sameCompanionAnswerHistory(a: CompanionAnswerHistory, b: CompanionAnswerHistory): boolean {
  return sameAttempt(a.attempt, b.attempt) && sameAnswerHistoryEvidence(a.evidence, b.evidence);
}
export function validateCompanionAnswerHistoryReceipt(value: unknown, expected?: CompanionAnswerHistory): asserts value is CompanionAnswerHistoryReceipt {
  record(value); keys(value, ["record", "status"]); validateCompanionAnswerHistory(value.record);
  invalid(!expected || sameCompanionAnswerHistory(value.record, expected));
  invalid(["applied", "conflict", "missing", "revoked", "expired"].includes(String(value.status)));
}
