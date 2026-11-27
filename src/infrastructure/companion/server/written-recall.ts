import { invalid, sameAttempt, type ReviewAttempt } from "../../../domain/companion/protocol";
import { sameCompanionWrittenRecall, validateCompanionWrittenRecall, validateCompanionWrittenRecallReceipt,
  type CompanionWrittenRecall, type CompanionWrittenRecallReceipt } from "../../../domain/companion/written-recall";

export interface CompanionWrittenRecallState { writtenRecalls?: CompanionWrittenRecall[]; writtenRecallReceipts?: CompanionWrittenRecallReceipt[]; }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function writtenRecallForAttempt(state: CompanionWrittenRecallState, id: string): CompanionWrittenRecall | undefined {
  return state.writtenRecalls?.find(row => row.attempt.id === id) ?? state.writtenRecallReceipts?.find(row => row.recall.attempt.id === id)?.recall;
}
export function validateCompanionWrittenRecallState(state: CompanionWrittenRecallState, attempts: ReviewAttempt[]): void {
  invalid((state.writtenRecalls === undefined || Array.isArray(state.writtenRecalls))
    && (state.writtenRecallReceipts === undefined || Array.isArray(state.writtenRecallReceipts)));
  const ids = new Set<string>();
  const known = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const verifyAttempt = (row: CompanionWrittenRecall): void => {
    invalid(!ids.has(row.attempt.id)); ids.add(row.attempt.id);
    const attempt = known.get(row.attempt.id); invalid(attempt && sameAttempt(attempt, row.attempt), "written recall attempt differs");
  };
  for (const row of state.writtenRecalls ?? []) { validateCompanionWrittenRecall(row); verifyAttempt(row); }
  for (const row of state.writtenRecallReceipts ?? []) { validateCompanionWrittenRecallReceipt(row); verifyAttempt(row.recall); }
}
export function enqueueCompanionWrittenRecall(state: CompanionWrittenRecallState, recall: CompanionWrittenRecall): void {
  validateCompanionWrittenRecall(recall);
  const prior = writtenRecallForAttempt(state, recall.attempt.id);
  if (prior) { invalid(sameCompanionWrittenRecall(prior, recall), "written recall ID collision"); return; }
  (state.writtenRecalls ??= []).push(copy(recall));
}
export function acknowledgeCompanionWrittenRecall(state: CompanionWrittenRecallState, recall: CompanionWrittenRecall, receipt: CompanionWrittenRecallReceipt): void {
  validateCompanionWrittenRecallReceipt(receipt, recall);
  const previous = state.writtenRecallReceipts?.find(row => row.recall.attempt.id === recall.attempt.id);
  if (previous) { invalid(previous.status === receipt.status && sameCompanionWrittenRecall(previous.recall, recall), "written recall receipt collision"); return; }
  const pending = state.writtenRecalls?.find(row => row.attempt.id === recall.attempt.id);
  invalid(pending && sameCompanionWrittenRecall(pending, recall), "unknown written recall");
  state.writtenRecalls = state.writtenRecalls!.filter(row => row.attempt.id !== recall.attempt.id);
  (state.writtenRecallReceipts ??= []).push(copy(receipt));
}
