import { decodeOfflineSeed, decodeOfflineStep } from "../../../domain/companion/offline-fsrs";
import { validateCompanionGradeCorrection, validateCompanionGradeCorrectionReceipt, type CompanionGradeCorrection, type CompanionGradeCorrectionReceipt } from "../../../domain/companion/corrections";
import { invalid, keys, record, sameAttempt, timestamp, token, validateAttempt, type CompanionSnapshot, type ImportStatus, type ReviewAttempt } from "../../../domain/companion/protocol";
import { companionArchiveKey, type CompanionArchiveRow } from "../../../features/companion/authority-archive";
import { DesktopCompanionAuthorityArchive } from "../desktop-authority-archive";
import { canonical } from "./bridge-contract";

export interface ServerArchivedEditableGrade {
  attemptId: string; materialId: string; withAttachments: boolean; reviewEventId: string; rating: ReviewAttempt["rating"]; expiresAt: number; answerMatch?: boolean;
}
export interface ServerArchivedResult {
  version: 1; outcome: { attempt: ReviewAttempt; status: ImportStatus }; receiptHash: string; ordinal: number;
  miniAppAttempt?: { id: string; answerMatch?: boolean };
  editableGrade?: ServerArchivedEditableGrade;
  corrections?: { correction: CompanionGradeCorrection; receipt?: CompanionGradeCorrectionReceipt }[];
}
export interface ServerResultArchive {
  get(scope: string, epoch: string, id: string): ServerArchivedResult | undefined;
  getMany(scope: string, epoch: string, ids: readonly string[]): Map<string, ServerArchivedResult>;
  page(scope: string, epoch: string, ordinals: readonly number[]): ServerArchivedResult[];
  putMany(rows: readonly ServerArchivedResult[], current: () => void): void;
  assertPresent(scope: string, epoch: string): void;
  suppressed(snapshot: CompanionSnapshot): { attempts: ReviewAttempt[]; offlineRoots: Set<string> };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const statuses: ImportStatus[] = ["applied", "stale", "epoch-mismatch", "missing", "ineligible", "local-session-active", "expired", "clock-mismatch", "core-adapter-unavailable"];
const resultKey = (scope: string, epoch: string, id: string): string => companionArchiveKey("result", scope, epoch, id);
const ordinalKey = (scope: string, epoch: string, ordinal: number): string => companionArchiveKey("ordinal", scope, epoch, String(ordinal));
const sentinelKey = (scope: string, epoch: string): string => companionArchiveKey("present", scope, epoch);
const ordinal = (value: unknown): void => invalid(Number.isSafeInteger(value) && Number(value) >= 1, "Invalid archived result ordinal");
function validate(value: unknown): asserts value is ServerArchivedResult {
  record(value); keys(value, ["version", "outcome", "receiptHash", "ordinal", "miniAppAttempt", "editableGrade", "corrections"]);
  invalid(value.version === 1); record(value.outcome); keys(value.outcome, ["attempt", "status"]); validateAttempt(value.outcome.attempt);
  const attempt = value.outcome.attempt;
  invalid(statuses.includes(value.outcome.status as ImportStatus) && typeof value.receiptHash === "string" && /^[a-f0-9]{64}$/.test(value.receiptHash)); ordinal(value.ordinal);
  if (value.miniAppAttempt !== undefined) {
    record(value.miniAppAttempt); keys(value.miniAppAttempt, ["id", "answerMatch"]);
    invalid(value.miniAppAttempt.id === attempt.id && (value.miniAppAttempt.answerMatch === undefined || typeof value.miniAppAttempt.answerMatch === "boolean"));
  }
  if (value.editableGrade !== undefined) {
    record(value.editableGrade); keys(value.editableGrade, ["attemptId", "materialId", "withAttachments", "reviewEventId", "rating", "expiresAt", "answerMatch"]);
    const grade = value.editableGrade;
    invalid(value.outcome.status === "applied" && grade.attemptId === attempt.id && typeof grade.withAttachments === "boolean"
      && [1, 2, 3, 4].includes(grade.rating as number) && (grade.answerMatch === undefined || typeof grade.answerMatch === "boolean"));
    token(grade.materialId); token(grade.reviewEventId); timestamp(grade.expiresAt);
  }
  if (value.corrections !== undefined) {
    invalid(Array.isArray(value.corrections)); const ids = new Set<string>();
    for (const row of value.corrections) {
      record(row); keys(row, ["correction", "receipt"]); validateCompanionGradeCorrection(row.correction);
      const correction = row.correction;
      invalid(correction.scope === attempt.scope && correction.epoch === attempt.epoch && correction.attemptId === attempt.id && correction.cardId === attempt.cardId
        && correction.revision === attempt.revision && !ids.has(correction.id)); ids.add(correction.id);
      if (row.receipt !== undefined) validateCompanionGradeCorrectionReceipt(row.receipt, correction);
    }
  }
}
function merge(previous: ServerArchivedResult, incoming: ServerArchivedResult): ServerArchivedResult {
  invalid(sameAttempt(previous.outcome.attempt, incoming.outcome.attempt) && previous.outcome.status === incoming.outcome.status
    && previous.receiptHash === incoming.receiptHash && previous.ordinal === incoming.ordinal, "Archived result identity collision");
  const result = copy(incoming);
  if (previous.miniAppAttempt) {
    invalid(!result.miniAppAttempt || previous.miniAppAttempt.answerMatch === undefined || result.miniAppAttempt.answerMatch === undefined
      || result.miniAppAttempt.answerMatch === previous.miniAppAttempt.answerMatch, "Archived Mini App result collision");
    result.miniAppAttempt = { ...copy(previous.miniAppAttempt), ...result.miniAppAttempt,
      ...(previous.miniAppAttempt.answerMatch === undefined ? {} : { answerMatch: previous.miniAppAttempt.answerMatch }) };
  }
  const corrections = new Map((previous.corrections ?? []).map(row => [row.correction.id, copy(row)]));
  for (const row of incoming.corrections ?? []) {
    const old = corrections.get(row.correction.id);
    if (old) {
      invalid(canonical(old.correction) === canonical(row.correction) && (!old.receipt || !row.receipt || canonical(old.receipt) === canonical(row.receipt)), "Archived correction identity collision");
      corrections.set(row.correction.id, { correction: copy(row.correction), ...(row.receipt || old.receipt ? { receipt: copy(row.receipt ?? old.receipt!) } : {}) });
    } else corrections.set(row.correction.id, copy(row));
  }
  if (corrections.size) result.corrections = [...corrections.values()];
  if (previous.editableGrade) {
    const next = result.editableGrade;
    if (next && canonical(next) !== canonical(previous.editableGrade)) {
      const latest = [...corrections.values()].filter(row => row.receipt?.status === "applied").at(-1);
      invalid(latest?.receipt?.reviewEventId === next.reviewEventId && latest?.correction.rating === next.rating, "Archived grade head lacks its correction receipt");
      invalid(next.materialId === previous.editableGrade.materialId && next.withAttachments === previous.editableGrade.withAttachments
        && next.expiresAt === previous.editableGrade.expiresAt && (previous.editableGrade.answerMatch === undefined || next.answerMatch === previous.editableGrade.answerMatch), "Archived grade metadata collision");
    }
    result.editableGrade ??= copy(previous.editableGrade);
  }
  validate(result); return result;
}
function index(value: unknown): string {
  record(value); keys(value, ["version", "id"]); invalid(value.version === 1); token(value.id); return value.id;
}

/** ACKed results stay exact and pageable while the server journal retains a bounded working set. */
export class DesktopServerResultArchive implements ServerResultArchive {
  private readonly archive: DesktopCompanionAuthorityArchive;
  constructor(directory: string, binding: string) { this.archive = new DesktopCompanionAuthorityArchive(directory, binding); }
  get(scope: string, epoch: string, id: string): ServerArchivedResult | undefined { return this.getMany(scope, epoch, [id]).get(id); }
  getMany(scope: string, epoch: string, ids: readonly string[]): Map<string, ServerArchivedResult> {
    token(scope); token(epoch); for (const id of ids) token(id);
    const values = this.archive.getMany("server-result", ids.map(id => resultKey(scope, epoch, id))), result = new Map<string, ServerArchivedResult>();
    for (const id of ids) {
      const row = values.get(resultKey(scope, epoch, id)); if (row === undefined) continue;
      validate(row); const attempt = row.outcome.attempt;
      invalid(attempt.scope === scope && attempt.epoch === epoch && attempt.id === id, "Archived result identity collision"); result.set(id, copy(row));
    }
    return result;
  }
  assertPresent(scope: string, epoch: string): void {
    token(scope); token(epoch); const value = this.archive.get("server-result", sentinelKey(scope, epoch));
    record(value); keys(value, ["version", "scope", "epoch"]); invalid(value.version === 1 && value.scope === scope && value.epoch === epoch, "Result archive unavailable");
  }
  page(scope: string, epoch: string, ordinals: readonly number[]): ServerArchivedResult[] {
    token(scope); token(epoch); for (const value of ordinals) ordinal(value);
    const positions = this.archive.getMany("server-result", ordinals.map(value => ordinalKey(scope, epoch, value)));
    const ids = ordinals.map(value => index(positions.get(ordinalKey(scope, epoch, value)))), values = this.getMany(scope, epoch, ids);
    return ordinals.map((value, position) => { const row = values.get(ids[position]); invalid(row && row.ordinal === value, "Archived result page unavailable"); return row; });
  }
  putMany(rows: readonly ServerArchivedResult[], current: () => void): void {
    current(); const staged = new Map<string, ServerArchivedResult>();
    for (const row of rows) {
      validate(row); const attempt = row.outcome.attempt, key = resultKey(attempt.scope, attempt.epoch, attempt.id), old = staged.get(key);
      staged.set(key, old ? merge(old, row) : copy(row));
    }
    const previous = this.archive.getMany("server-result", [...staged.keys()]);
    const positions = this.archive.getMany("server-result", [...staged.values()].map(row => ordinalKey(row.outcome.attempt.scope, row.outcome.attempt.epoch, row.ordinal)));
    const writes = new Map<string, CompanionArchiveRow>();
    const write = (key: string, value: unknown): void => { writes.set(key, { key, value }); };
    const assigned = new Map<string, string>();
    for (const [key, incoming] of staged) {
      const prior = previous.get(key); if (prior !== undefined) validate(prior);
      const row = prior === undefined ? incoming : merge(prior, incoming), attempt = row.outcome.attempt, position = ordinalKey(attempt.scope, attempt.epoch, row.ordinal);
      const oldPosition = positions.get(position); invalid(oldPosition === undefined || index(oldPosition) === attempt.id, "Archived result ordinal collision");
      invalid(!assigned.has(position) || assigned.get(position) === attempt.id, "Archived result ordinal collision"); assigned.set(position, attempt.id);
      write(key, row); write(position, { version: 1, id: attempt.id }); write(sentinelKey(attempt.scope, attempt.epoch), { version: 1, scope: attempt.scope, epoch: attempt.epoch });
      if (!attempt.offline) write(companionArchiveKey("suppressed", attempt.scope, attempt.epoch, attempt.cardId, attempt.revision), { version: 1, id: attempt.id });
      else if (row.outcome.status === "applied") write(companionArchiveKey("offline-root", attempt.scope, attempt.epoch, attempt.cardId, decodeOfflineStep(attempt.offline).rootRevision), { version: 1, id: attempt.id });
    }
    this.archive.putMany("server-result", [...writes.values()], current); current();
  }
  suppressed(snapshot: CompanionSnapshot): { attempts: ReviewAttempt[]; offlineRoots: Set<string> } {
    token(snapshot.scope); token(snapshot.epoch);
    const queries = snapshot.cards.flatMap(card => [{ key: companionArchiveKey("suppressed", snapshot.scope, snapshot.epoch, card.id, card.revision), card, offline: false },
      ...(card.offline ? [{ key: companionArchiveKey("offline-root", snapshot.scope, snapshot.epoch, card.id, decodeOfflineSeed(card.offline).rootRevision), card, offline: true }] : [])]);
    const positions = this.archive.getMany("server-result", queries.map(query => query.key));
    const found = queries.flatMap(query => { const value = positions.get(query.key); return value === undefined ? [] : [{ ...query, id: index(value) }]; });
    const results = this.getMany(snapshot.scope, snapshot.epoch, found.map(query => query.id)), attempts: ReviewAttempt[] = [], offlineRoots = new Set<string>();
    for (const query of found) {
      const row = results.get(query.id); invalid(row && row.outcome.attempt.cardId === query.card.id, "Archived suppression evidence unavailable");
      const attempt = row.outcome.attempt;
      if (query.offline) {
        invalid(attempt.offline && row.outcome.status === "applied" && decodeOfflineStep(attempt.offline).rootRevision === decodeOfflineSeed(query.card.offline!).rootRevision, "Archived offline root evidence unavailable");
        offlineRoots.add(`${attempt.cardId}:${decodeOfflineStep(attempt.offline).rootRevision}`);
      } else { invalid(!attempt.offline && attempt.revision === query.card.revision, "Archived revision evidence unavailable"); attempts.push(copy(attempt)); }
    }
    return { attempts, offlineRoots };
  }
}
