import { invalid, keys, record, timestamp, token } from "./protocol";
import type { ExternalCoreStatus } from "../review/external-review";

/** A correction names one already-applied review; it is never another review attempt. */
export interface CompanionGradeCorrection {
  id: string; scope: string; epoch: string; attemptId: string; cardId: string; revision: string;
  expectedReviewEventId: string; rating: 1 | 2 | 3 | 4; correct: boolean; requestedAt: number;
}
export interface CompanionGradeCorrectionReceipt {
  correction: CompanionGradeCorrection; status: ExternalCoreStatus; reviewEventId?: string; nextDueAt?: number;
}
export function validateCompanionGradeCorrection(value: unknown): asserts value is CompanionGradeCorrection {
  record(value); keys(value, ["id", "scope", "epoch", "attemptId", "cardId", "revision", "expectedReviewEventId", "rating", "correct", "requestedAt"]);
  for (const field of ["id", "scope", "epoch", "attemptId", "cardId", "revision", "expectedReviewEventId"]) token(value[field]);
  timestamp(value.requestedAt); invalid([1, 2, 3, 4].includes(value.rating as number) && value.correct === (value.rating !== 1));
}
export function sameCompanionGradeCorrection(a: CompanionGradeCorrection, b: CompanionGradeCorrection): boolean {
  return Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof CompanionGradeCorrection)[]).every(key => a[key] === b[key]);
}
export function validateCompanionGradeCorrectionReceipt(value: unknown, expected?: CompanionGradeCorrection): asserts value is CompanionGradeCorrectionReceipt {
  record(value); keys(value, ["correction", "status", "reviewEventId", "nextDueAt"]); validateCompanionGradeCorrection(value.correction);
  invalid(!expected || sameCompanionGradeCorrection(value.correction, expected), "Correction receipt differs from request");
  invalid(typeof value.status === "string" && ["applied", "stale", "missing", "epoch-mismatch", "ineligible", "local-session-active", "expired", "clock-mismatch"].includes(value.status));
  if (value.status === "applied") { token(value.reviewEventId); timestamp(value.nextDueAt); }
  else invalid(value.reviewEventId === undefined && value.nextDueAt === undefined);
}
