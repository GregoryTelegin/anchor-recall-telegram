import { canonical } from "./bridge-contract";
import { invalid, record, sameAttempt, type ReviewAttempt, type ImportStatus } from "../../../domain/companion/protocol";
import { decodeOfflineStep } from "../../../domain/companion/offline-fsrs";
import type { ServerState } from "./server-state";
import type { ServerArchivedResult, ServerResultArchive } from "./result-archive";

const TARGET = 1000, COMPACT_AT = 2000;
export interface ServerResultLedger {
  total: number; applied: number; rejected: number; archiveUsed: boolean; archiveRevision: number;
  entries: { id: string; ordinal: number }[];
}
export function resultCounts(state: ServerState): { total: number; applied: number; rejected: number } {
  if (state.resultLedger) { const { total, applied, rejected } = state.resultLedger; return { total, applied, rejected }; }
  const applied = state.domain.outcomes.filter(row => row.status === "applied").length;
  return { total: state.domain.outcomes.length, applied, rejected: state.domain.outcomes.length - applied };
}
function ledger(state: ServerState): ServerResultLedger {
  return state.resultLedger ??= { ...resultCounts(state), archiveUsed: false, archiveRevision: 0,
    entries: state.domain.outcomes.map((row, index) => ({ id: row.attempt.id, ordinal: index + 1 })) };
}
export function addResultOrdinal(state: ServerState, id: string, status: ImportStatus): void {
  const value = state.resultLedger; if (!value) return;
  invalid(!value.entries.some(row => row.id === id)); value.total++;
  if (status === "applied") value.applied++; else value.rejected++;
  value.entries.push({ id, ordinal: value.total });
}
export function hydrateResult(state: ServerState, archive: ServerResultArchive | undefined, scope: string, epoch: string, id: string, now: number): void {
  if (state.domain.outcomes.some(row => row.attempt.id === id) || !state.resultLedger?.archiveUsed) return;
  invalid(archive, "Result archive unavailable"); const row = archive.get(scope, epoch, id); if (!row) return;
  state.domain.outcomes.push(row.outcome); state.receipts.push({ id, hash: row.receiptHash });
  state.resultLedger.entries.push({ id, ordinal: row.ordinal });
  if (row.miniAppAttempt && !state.miniAppAttempts?.some(value => value.id === id)) (state.miniAppAttempts ??= []).push(row.miniAppAttempt);
  const editable = row.editableGrade;
  if (editable && editable.expiresAt > now && (state.materialConsentIds?.includes(editable.materialId) ?? true)
    && (state.attachmentConsent !== false || !editable.withAttachments) && !state.editableGrades?.some(value => value.attemptId === id)) (state.editableGrades ??= []).push(editable);
  for (const correction of row.corrections ?? []) if (!state.gradeCorrections?.some(value => value.correction.id === correction.correction.id)) (state.gradeCorrections ??= []).push(correction);
}
function pinnedResults(state: ServerState): Set<string> {
  const pinned = new Set<string>(), attempts = new Map([...state.domain.pending, ...state.domain.outcomes.map(row => row.attempt)].map(row => [row.id, row]));
  for (const head of state.offlineHeads ?? []) if (head.lastAttemptId) pinned.add(head.lastAttemptId);
  for (const attempt of state.domain.pending) if (attempt.offline) { const parent = decodeOfflineStep(attempt.offline).parentId; if (parent) pinned.add(parent); }
  for (const session of [state.studySession, state.miniApp?.session]) if (session) {
    for (const result of session.results) pinned.add(result.attemptId);
    for (const card of [...(session.current ? [session.current] : []), ...(session.frames ?? []), ...session.results.flatMap(row => row.card ? [row.card] : [])])
      if (card.offline && attempts.has(card.revision)) pinned.add(card.revision);
  }
  if (state.miniApp?.currentAttemptId) pinned.add(state.miniApp.currentAttemptId);
  for (const row of state.gradeCorrections ?? []) if (!row.receipt) pinned.add(row.correction.attemptId);
  for (const row of state.writtenRecalls ?? []) pinned.add(row.attempt.id);
  const acknowledgedText = new Set(state.answerHistoryReceipts?.map(row => row.attemptId));
  for (const row of state.answerHistory ?? []) if (!acknowledgedText.has(row.attempt.id)) pinned.add(row.attempt.id);
  for (const row of state.supersededOfflineReviews ?? []) if (row.attempt.offline) { const parent = decodeOfflineStep(row.attempt.offline).parentId; if (parent) pinned.add(parent); }
  const queue = [...pinned];
  for (let index = 0; index < queue.length; index++) {
    const attempt = attempts.get(queue[index]); if (!attempt?.offline) continue;
    const parent = decodeOfflineStep(attempt.offline).parentId;
    if (parent && !pinned.has(parent)) { pinned.add(parent); queue.push(parent); }
  }
  return pinned;
}
/** Archive only receipts already present in the previous successful journal commit. */
export function compactResults(state: ServerState, committed: ServerState | undefined, archive: ServerResultArchive | undefined): void {
  if (!archive || !committed || state.domain.outcomes.length <= COMPACT_AT) return;
  const value = ledger(state), pinned = pinnedResults(state), previous = new Map(committed.domain.outcomes.map(row => [row.attempt.id, row]));
  const hashes = new Map(state.receipts.map(row => [row.id, row.hash])), oldHashes = new Map(committed.receipts.map(row => [row.id, row.hash]));
  const ordinals = new Map(value.entries.map(row => [row.id, row.ordinal]));
  const metadata = (source: ServerState): Map<string, string> => {
    const mini = new Map(source.miniAppAttempts?.map(row => [row.id, row])), editable = new Map(source.editableGrades?.map(row => [row.attemptId, row]));
    const corrections = new Map<string, NonNullable<ServerState["gradeCorrections"]>>();
    for (const row of source.gradeCorrections ?? []) { const group = corrections.get(row.correction.attemptId) ?? []; group.push(row); corrections.set(row.correction.attemptId, group); }
    return new Map(source.domain.outcomes.map(row => [row.attempt.id, canonical([mini.get(row.attempt.id) ?? null, editable.get(row.attempt.id) ?? null, corrections.get(row.attempt.id) ?? []])]));
  };
  const currentMetadata = metadata(state), oldMetadata = metadata(committed);
  const candidates = state.domain.outcomes.filter(row => {
    const old = previous.get(row.attempt.id);
    return !pinned.has(row.attempt.id) && old && old.status === row.status && sameAttempt(old.attempt, row.attempt)
      && hashes.get(row.attempt.id) === oldHashes.get(row.attempt.id) && currentMetadata.get(row.attempt.id) === oldMetadata.get(row.attempt.id);
  }).sort((a, b) => ordinals.get(a.attempt.id)! - ordinals.get(b.attempt.id)!);
  const retiring = candidates.slice(0, Math.max(0, state.domain.outcomes.length - Math.max(TARGET, pinned.size)));
  if (!retiring.length) return;
  const mini = new Map(state.miniAppAttempts?.map(row => [row.id, row])), editable = new Map(state.editableGrades?.map(row => [row.attemptId, row]));
  const rows: ServerArchivedResult[] = retiring.map(outcome => {
    const id = outcome.attempt.id, receiptHash = hashes.get(id), ordinal = ordinals.get(id); invalid(receiptHash && ordinal, "Missing committed result identity");
    const corrections = state.gradeCorrections?.filter(row => row.correction.attemptId === id); invalid(!corrections?.some(row => !row.receipt));
    return { version: 1, outcome, receiptHash, ordinal, ...(mini.has(id) ? { miniAppAttempt: mini.get(id)! } : {}),
      ...(editable.has(id) ? { editableGrade: editable.get(id)! } : {}), ...(corrections?.length ? { corrections } : {}) };
  });
  archive.putMany(rows, () => {});
  const removed = new Set(retiring.map(row => row.attempt.id));
  state.domain.outcomes = state.domain.outcomes.filter(row => !removed.has(row.attempt.id)); state.receipts = state.receipts.filter(row => !removed.has(row.id));
  state.miniAppAttempts = state.miniAppAttempts?.filter(row => !removed.has(row.id)); state.editableGrades = state.editableGrades?.filter(row => !removed.has(row.attemptId));
  state.gradeCorrections = state.gradeCorrections?.filter(row => !removed.has(row.correction.attemptId)); value.entries = value.entries.filter(row => !removed.has(row.id));
  value.archiveUsed = true; value.archiveRevision++;
}
export function validateResultLedger(state: ServerState): void {
  const value = state.resultLedger; if (!value) return;
  record(value);
  invalid(Object.keys(value).every(key => ["total", "applied", "rejected", "archiveUsed", "archiveRevision", "entries"].includes(key)));
  for (const count of [value.total, value.applied, value.rejected, value.archiveRevision]) invalid(Number.isSafeInteger(count) && count >= 0);
  invalid(value.total === value.applied + value.rejected && value.total >= state.domain.outcomes.length && typeof value.archiveUsed === "boolean"
    && Array.isArray(value.entries) && value.entries.length === state.domain.outcomes.length);
  const ids = new Set<string>(), ordinals = new Set<number>(), outcomes = new Map(state.domain.outcomes.map(row => [row.attempt.id, row]));
  for (const row of value.entries) {
    record(row);
    invalid(Object.keys(row).every(key => ["id", "ordinal"].includes(key)) && outcomes.has(row.id) && !ids.has(row.id)
      && Number.isSafeInteger(row.ordinal) && row.ordinal > 0 && row.ordinal <= value.total && !ordinals.has(row.ordinal));
    ids.add(row.id); ordinals.add(row.ordinal);
  }
  if (!value.archiveUsed) invalid(value.total === state.domain.outcomes.length);
  invalid(value.applied >= state.domain.outcomes.filter(row => row.status === "applied").length && value.rejected >= state.domain.outcomes.filter(row => row.status !== "applied").length);
}
export function resultHistory(state: ServerState, archive: ServerResultArchive | undefined, scope: string, epoch: string, offset: number): { attempt: ReviewAttempt; status: ImportStatus }[] {
  const total = resultCounts(state).total, end = Math.max(0, total - offset), start = Math.max(1, end - 19), byOrdinal = new Map<number, { attempt: ReviewAttempt; status: ImportStatus }>();
  const outcomes = new Map(state.domain.outcomes.map(row => [row.attempt.id, row]));
  for (const row of state.resultLedger?.entries ?? state.domain.outcomes.map((row, index) => ({ id: row.attempt.id, ordinal: index + 1 }))) {
    const outcome = outcomes.get(row.id); if (outcome) byOrdinal.set(row.ordinal, outcome);
  }
  const missing = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index).filter(ordinal => !byOrdinal.has(ordinal));
  if (missing.length) { invalid(archive, "Result archive unavailable"); for (const row of archive.page(scope, epoch, missing)) byOrdinal.set(row.ordinal, row.outcome); }
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => { const row = byOrdinal.get(start + index); invalid(row, "Result history incomplete"); return row; });
}
