import { invalid, keys, record, sameAttempt, token, type ReviewAttempt } from "../../../domain/companion/protocol";
import { validateCompanionAnswerHistory, validateCompanionAnswerHistoryReceipt, sameCompanionAnswerHistory,
  type CompanionAnswerHistory, type CompanionAnswerHistoryReceipt, type CompanionAnswerHistoryStatus } from "../../../domain/companion/answer-history";
import type { AnswerHistoryEvidence } from "../../../domain/review/answer-history";
import { digest } from "./bridge-contract";
import { cloneJsonValue } from "../../../shared/json-digest";

interface Reference { id: string; question: string; reference: string; criteria?: string[]; }
interface StoredRecord { attempt: ReviewAttempt; evidence: Omit<AnswerHistoryEvidence, "question" | "reference" | "criteria"> & { referenceId: string }; }
export interface CompanionAnswerHistoryState {
  answerHistory?: StoredRecord[]; answerHistoryReferences?: Reference[];
  answerHistoryReceipts?: { attemptId: string; status: CompanionAnswerHistoryStatus }[];
}
const copy = cloneJsonValue;
function unpack(state: CompanionAnswerHistoryState, row: StoredRecord, references?: ReadonlyMap<string, Reference>): CompanionAnswerHistory {
  const reference = references ? references.get(row.evidence.referenceId) : state.answerHistoryReferences?.find(item => item.id === row.evidence.referenceId); invalid(reference, "Answer history reference missing");
  const { referenceId: _id, ...evidence } = row.evidence, { id: _refId, ...context } = reference;
  return { attempt: copy(row.attempt), evidence: { ...copy(evidence), ...copy(context) } };
}
export function answerHistoryForAttempt(state: CompanionAnswerHistoryState, id: string): CompanionAnswerHistory | undefined {
  const row = state.answerHistory?.find(item => item.attempt.id === id); return row && unpack(state, row);
}
export function answerHistoryRecords(state: CompanionAnswerHistoryState, attemptIds?: ReadonlySet<string>): CompanionAnswerHistory[] {
  if (attemptIds?.size === 0) return [];
  const rows = (state.answerHistory ?? []).filter(row => !attemptIds || attemptIds.has(row.attempt.id));
  const references = new Map((state.answerHistoryReferences ?? []).map(row => [row.id, row]));
  return rows.map(row => unpack(state, row, references));
}
export function pendingAnswerHistory(state: CompanionAnswerHistoryState, maximum = Number.MAX_SAFE_INTEGER): CompanionAnswerHistory[] {
  invalid(Number.isSafeInteger(maximum) && maximum > 0);
  const acked = new Set(state.answerHistoryReceipts?.map(row => row.attemptId));
  const references = new Map((state.answerHistoryReferences ?? []).map(row => [row.id, row]));
  const result: CompanionAnswerHistory[] = [];
  for (const row of state.answerHistory ?? []) if (!acked.has(row.attempt.id)) { result.push(unpack(state, row, references)); if (result.length >= maximum) break; }
  return result;
}
export function enqueueAnswerHistory(state: CompanionAnswerHistoryState, value: CompanionAnswerHistory): void {
  validateCompanionAnswerHistory(value); const prior = answerHistoryForAttempt(state, value.attempt.id);
  if (prior) { invalid(sameCompanionAnswerHistory(prior, value), "Answer history ID collision"); return; }
  const { question, reference, criteria, ...evidence } = value.evidence;
  const context = { question, reference, ...(criteria === undefined ? {} : { criteria: [...criteria] }) }, id = digest(context);
  if (!(state.answerHistoryReferences ?? []).some(row => row.id === id)) (state.answerHistoryReferences ??= []).push({ id, ...context });
  (state.answerHistory ??= []).push({ attempt: copy(value.attempt), evidence: { ...copy(evidence), referenceId: id } });
}
export function acknowledgeAnswerHistory(state: CompanionAnswerHistoryState, value: CompanionAnswerHistory, receipt: CompanionAnswerHistoryReceipt): void {
  validateCompanionAnswerHistoryReceipt(receipt, value); const saved = answerHistoryForAttempt(state, value.attempt.id);
  invalid(saved && sameCompanionAnswerHistory(saved, value), "Unknown answer history record");
  const prior = state.answerHistoryReceipts?.find(row => row.attemptId === value.attempt.id);
  if (prior) { invalid(prior.status === receipt.status, "Answer history receipt collision"); return; }
  (state.answerHistoryReceipts ??= []).push({ attemptId: value.attempt.id, status: receipt.status });
}
export function replacePendingAnswerHistoryAttempt(state: CompanionAnswerHistoryState, previousId: string, replacement: ReviewAttempt): void {
  const row = state.answerHistory?.find(item => item.attempt.id === previousId); if (!row) return;
  invalid(!state.answerHistoryReceipts?.some(item => item.attemptId === previousId), "Acknowledged answer history is immutable");
  row.attempt = copy(replacement); row.evidence.attemptId = replacement.id;
}
export function validateAnswerHistoryState(state: CompanionAnswerHistoryState, attempts: ReviewAttempt[]): void {
  for (const rows of [state.answerHistory, state.answerHistoryReferences, state.answerHistoryReceipts])
    invalid(rows === undefined || Array.isArray(rows));
  const ids = new Set<string>(), references = new Map<string, Reference>(), known = new Map(attempts.map(row => [row.id, row]));
  for (const context of state.answerHistoryReferences ?? []) {
    record(context); keys(context, ["id", "question", "reference", "criteria"]); const { id, ...value } = context;
    invalid(typeof id === "string" && id === digest(value) && !references.has(id)); references.set(id, context);
  }
  for (const row of state.answerHistory ?? []) {
    record(row); keys(row, ["attempt", "evidence"]); const value = unpack(state, row, references); validateCompanionAnswerHistory(value);
    invalid(!ids.has(value.attempt.id) && known.has(value.attempt.id) && sameAttempt(known.get(value.attempt.id)!, value.attempt)); ids.add(value.attempt.id);
  }
  const receipts = new Set<string>();
  for (const receipt of state.answerHistoryReceipts ?? []) {
    record(receipt); keys(receipt, ["attemptId", "status"]); token(receipt.attemptId); invalid(ids.has(receipt.attemptId) && !receipts.has(receipt.attemptId));
    invalid(["applied", "conflict", "missing", "revoked", "expired"].includes(receipt.status)); receipts.add(receipt.attemptId);
  }
}
