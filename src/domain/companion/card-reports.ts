import { normalizeCardClarification, type CardClarificationReason } from "../cards/card-clarification";
import { compactSourceFingerprint } from "../cards/import-source-identity";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import { invalid, keys, record, timestamp, token, type SelectedCard } from "./protocol";

export const COMPANION_CARD_REPORT_TTL = 7 * 86_400_000;
export interface CompanionCardReport {
  id: string; scope: string; epoch: string; cardId: string; materialId: string; contentHash: string; requestedAt: number;
  reason?: CardClarificationReason; note?: string;
}
export type CompanionCardReportStatus = "applied" | "conflict" | "missing" | "revoked" | "expired";
export interface CompanionCardReportReceipt { report: CompanionCardReport; status: CompanionCardReportStatus; }
/** A clarification follows authored text, not the schedule changed by the preceding answer. */
export function companionCardReportContentHash(card: Pick<SelectedCard, "question" | "reference" | "exercise" | "evaluationMode" | "acceptedAnswers" | "answerMatchMode">): string {
  return compactSourceFingerprint(jsonFingerprint([card.question, card.reference, card.exercise ?? null, card.evaluationMode ?? null,
    card.acceptedAnswers ?? null, card.answerMatchMode ?? null])!).slice(7);
}
export function validateCompanionCardReport(value: unknown): asserts value is CompanionCardReport {
  record(value); keys(value, ["id", "scope", "epoch", "cardId", "materialId", "contentHash", "requestedAt", "reason", "note"]);
  for (const field of ["id", "scope", "epoch", "cardId", "materialId"]) token(value[field]);
  timestamp(value.requestedAt); invalid(typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash));
  normalizeCardClarification({ ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.note === undefined ? {} : { note: value.note }) });
}
export function sameCompanionCardReport(a: CompanionCardReport, b: CompanionCardReport): boolean { return jsonFingerprint(a) === jsonFingerprint(b); }
export function validateCompanionCardReportReceipt(value: unknown, expected?: CompanionCardReport): asserts value is CompanionCardReportReceipt {
  record(value); keys(value, ["report", "status"]); validateCompanionCardReport(value.report);
  invalid(!expected || sameCompanionCardReport(value.report, expected));
  invalid(["applied", "conflict", "missing", "revoked", "expired"].includes(String(value.status)));
}
