import { type CompanionCardReport, type CompanionCardReportReceipt } from "../../../domain/companion/card-reports";
import { validateCompanionGradeCorrection, validateCompanionGradeCorrectionReceipt, type CompanionGradeCorrection, type CompanionGradeCorrectionReceipt } from "../../../domain/companion/corrections";
import { feedbackMatchesAnswer, validateCompanionExerciseFeedback, type CompanionExerciseFeedback } from "../../../domain/companion/exercise-feedback";
import { validateCompanionMediaIdentity, type CompanionMediaAttachment, type CompanionMediaIdentity } from "../../../domain/companion/media";
import { advanceOfflineFsrs, decodeOfflineSeed, decodeOfflineStep, offlineReviewTimeAllowed, offlineStateDue } from "../../../domain/companion/offline-fsrs";
import {
invalid, keys, record, timestamp, token, validateAttempt, validateSnapshot, validateState, type CompanionSnapshot, type CompanionState, type ImportStatus, type ReviewAttempt, type SelectedCard
} from "../../../domain/companion/protocol";
import type { CompanionStudyContext } from "../../../domain/companion/study-context";
import { validateCompanionStudyPlan, type CompanionStudyPlan } from "../../../domain/companion/study-plan";
import { type CompanionPlanCommand, type CompanionPlanCommandReceipt } from "../../../domain/companion/study-plan-actions";
import type { CompanionWrittenRecall, CompanionWrittenRecallReceipt } from "../../../domain/companion/written-recall";
import { validNativePollId, validateNativePollPayload } from "../../../features/companion/native-poll";
import { GRADE_PROMPT, choiceButtonLayout, combinedGradeText, hintPanelView, renderCard, validateCompanionSpoilers, validateGradePanelEdit, validateHintPanelEdit, validateQuestionPanelEdit, validateSessionPanelEdit } from "../../../features/companion/presentation";
import { validateRichCheckboxDemoMessage } from "../../../features/companion/rich-checkbox-demo";
import { validateAnswerHistoryState, type CompanionAnswerHistoryState } from "./answer-history";
import { canonical } from "./bridge-contract";
import { validateCompanionCardReportState } from "./card-reports";
import { validateMiniAppState, type MiniAppStudy } from "./miniapp-study";
import { validateStoredPoll } from "./native-poll-state";
import { validateOfflineHeads, validateSessionFrame, type OfflineHead } from "./offline-session";
import { validateTimeZone } from "./reminders";
import { validateStoredRichDemo, validateStoredRichDemoEdit } from "./rich-checkbox-demo-state";
import { validateCompanionPlanCommandState } from "./study-plan-actions";
import { validateMiniAppUrl, validateStudyPlanPayload, type StudyPlanDelivery } from "./study-plan-reminders";
import { validateCompanionWrittenRecallState } from "./written-recall";
import type { ServerReplayArchive } from "./replay-archive";
import { snapshotCardMap, validateImmutableSnapshot, validateImmutableStudyContext } from "./immutable-content";
import { validateResultLedger, type ServerResultLedger } from "./result-lifecycle";
import type { ServerResultArchive } from "./result-archive";
import { catalogRootRevision, validateCatalogRoot, type CatalogPageStorage, type CatalogRoot } from "../catalog-pages";

/** Persisted server model and strict recovery validation, independent of the command runtime. */
export interface ServerConfig {
  enabled?: boolean; scope: string; epoch: string; enrollment: string;
  ownerUserId: number; ownerChatId: number; webhookSecret: string; bridgeSecret: string;
  host?: string; port?: number; externalTlsProxy?: boolean;
  /** Local wall-clock minutes after midnight in the explicit vault-paired IANA zone. */
  timeZone: string; sessionsLocal: number[]; quietUpdates?: boolean; miniAppUrl?: string; botUsername?: string; miniAppVaultId?: string;
}
export function validateConfig(c: ServerConfig): void {
  invalid(c.enabled === true, "server disabled");
  for (const v of [c.scope, c.epoch, c.enrollment]) token(v);
  invalid([c.ownerChatId, c.ownerUserId].every(v => Number.isSafeInteger(v) && v > 0));
  invalid(typeof c.webhookSecret === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(c.webhookSecret));
  invalid(typeof c.bridgeSecret === "string" && c.bridgeSecret.length >= 32 && c.bridgeSecret.length <= 256);
  invalid(c.webhookSecret !== c.bridgeSecret, "separate secrets required");
  invalid(c.port === undefined || Number.isInteger(c.port) && c.port > 0 && c.port <= 65535);
  invalid(c.host === undefined || ["127.0.0.1", "::1", "localhost"].includes(c.host) || c.externalTlsProxy === true, "external bind requires TLS proxy declaration");
  invalid(c.quietUpdates === undefined || typeof c.quietUpdates === "boolean");
  if (c.miniAppUrl !== undefined) validateMiniAppUrl(c.miniAppUrl);
  invalid(c.miniAppVaultId === undefined || typeof c.miniAppVaultId === "string" && /^[a-f0-9]{48}$/.test(c.miniAppVaultId) && c.miniAppVaultId === c.enrollment);
  invalid(c.botUsername === undefined || typeof c.botUsername === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c.botUsername));
  validateTimeZone(c.timeZone);
  invalid(Array.isArray(c.sessionsLocal) && c.sessionsLocal.length > 0 && c.sessionsLocal.length <= 24 && c.sessionsLocal.every(v => Number.isInteger(v) && v >= 0 && v < 1440));
}
export type Action = Record<string, string | number | boolean>;
interface Handle { id: string; epoch: string; sequence: number; expiresAt: number; action: Action; }
export interface Outbound { id: string; method: "sendMessage" | "answerCallbackQuery" | "sendPhoto" | "sendAudio" | "sendVideo" | "sendDocument" | "editMessageMedia" | "editMessageText" | "sendPoll" | "stopPoll" | "sendRichMessage"; payload: Record<string, unknown>; status: "queued" | "unknown" | "sent"; snapshotSequence?: number;
  /** Private reply binding and confirmed delivery ID; only a durably confirmed prompt is answerable. */
  answerHandle?: string; messageId?: number; after?: string; target?: string; mediaPlaceholder?: true; failureHandled?: true;
  /** Explicit ownership for hint bodies without a next button; never a public payload field. */
  hintLease?: { cardId: string; revision: string; index: number; expiresAt: number };
  hintPanel?: { cardId: string; revision: string; sessionId: string; count: number; index: number; collapsed: boolean; expiresAt: number; readOnly?: true };
  ratingPanel?: { cardId: string; revision: string; attemptId?: string; answerMatch?: boolean; answerText?: string; exerciseFeedback?: CompanionExerciseFeedback };
  sessionPanel?: { sessionId: string };
  sessionContent?: { sessionId: string; cardId?: string; revision?: string };
  questionPanel?: { cardId: string; revision: string; selectedOptionIndexes: number[]; expiresAt: number; choiceLayout?: "adaptive" | "checkboxes" };
  pollPanel?: { cardId: string; revision: string; sessionId: string; expiresAt: number; pollId?: string; sealed?: true; selection?: number[] };
  richDemoPanel?: { selectedOptionIndexes: number[]; checked: boolean; expiresAt: number };
  studyPlanEntry?: StudyPlanDelivery;
  /** Private launch context, rechecked against the live consented plan at delivery. */
  miniAppPlan?: string;
}
export interface CompanionStudySession {
  id: string; snapshot: CompanionSnapshot; status: "active" | "paused" | "finished";
  results: { cardId: string; attemptId: string; card?: SelectedCard }[]; skipped: string[]; deferred?: string[];
  current?: SelectedCard; frames?: SelectedCard[]; waitUntil?: number; mode?: "core" | "bank";
}
export const sessionCards = (session: CompanionStudySession): SelectedCard[] => [...(session.current ? [session.current] : []), ...(session.frames ?? []), ...session.results.flatMap(row => row.card ? [row.card] : []), ...session.snapshot.cards];
interface EditableGrade { attemptId: string; materialId: string; withAttachments: boolean; reviewEventId: string; rating: ReviewAttempt["rating"]; expiresAt: number; answerMatch?: boolean; }
export interface ServerState extends CompanionAnswerHistoryState {
  version: 1; binding: string; domain: CompanionState;
  handles: Handle[]; updates: { id: number; hash: string }[]; callbackIds: { id: string; hash: string }[];
  replayArchived?: true;
  nonces: { nonce: string; time: number; hash: string; response: unknown }[]; bridgeTimeFloor: number;
  receipts: { id: string; hash: string }[]; outbox: Outbound[]; lastSession: number; mutedUntil: number;
  /** Once returned to a desktop, a review remains immutable until its receipt arrives. */
  claimedAttempts?: string[];
  studySession?: CompanionStudySession;
  editableGrades?: EditableGrade[];
  gradeCorrections?: { correction: CompanionGradeCorrection; receipt?: CompanionGradeCorrectionReceipt }[];
  materialConsentIds?: string[];
  attachmentConsent?: boolean;
  offlineConsent?: boolean;
  offlineHeads?: OfflineHead[];
  /** Frozen prompt ancestry only; superseded grades never enter live queues or heads. */
  supersededOfflineReviews?: { attempt: ReviewAttempt; seed: string }[];
  miniApp?: MiniAppStudy;
  miniAppReceipts?: { id: string; hash: string }[];
  miniAppAttempts?: { id: string; answerMatch?: boolean }[];
  /** Presence permanently selects local-plan reminders, including an explicit disabled plan. */
  studyPlan?: CompanionStudyPlan;
  studyPlanSent?: { id: string; notifyAt: number }[];
  studyContext?: CompanionStudyContext;
  planCommands?: CompanionPlanCommand[];
  planCommandReceipts?: CompanionPlanCommandReceipt[];
  cardReportsEnabled?: boolean;
  cardReports?: CompanionCardReport[];
  cardReportReceipts?: CompanionCardReportReceipt[];
  writtenRecalls?: CompanionWrittenRecall[];
  writtenRecallReceipts?: CompanionWrittenRecallReceipt[];
  retainAnswers?: boolean; retainAnswersChangedAt?: number; answerHistoryFull?: boolean;
  resultLedger?: ServerResultLedger;
  /** Private publication fence for the complete paged snapshot/context/consent pair. */
  catalogRevision?: string; catalogRoot?: CatalogRoot;
}
export interface Journal { load(): Promise<ServerState | undefined>; save(state: ServerState): Promise<void>; validateAndSave?(state: ServerState, ownerChatId: number): Promise<void>; results?: ServerResultArchive; replay?: ServerReplayArchive; catalog?: CatalogPageStorage; }
function ratingSources(s: ServerState, panel: Outbound): { card: SelectedCard; snapshot: CompanionSnapshot }[] {
  const p = panel.ratingPanel; if (!p) return [];
  const sources: { card: SelectedCard; snapshot: CompanionSnapshot }[] = [];
  if (s.domain.snapshot) for (const card of s.domain.snapshot.cards) if (card.id === p.cardId && card.revision === p.revision) sources.push({ card, snapshot: s.domain.snapshot });
  if (s.studySession && (!panel.sessionContent || panel.sessionContent.sessionId === s.studySession.id)) {
    for (const card of sessionCards(s.studySession)) if (card.id === p.cardId && card.revision === p.revision) sources.push({ card, snapshot: s.studySession.snapshot });
  }
  return sources;
}
function ratingFeedbackMatches(card: SelectedCard, panel: NonNullable<Outbound["ratingPanel"]>): boolean {
  if (panel.exerciseFeedback === undefined) return true;
  try { return !!card.exercise && typeof panel.answerMatch === "boolean" && feedbackMatchesAnswer(card.exercise, panel.exerciseFeedback) === panel.answerMatch; }
  catch { return false; }
}
function ratingAnswerSource(s: ServerState, panel: Outbound): { card: SelectedCard; snapshot: CompanionSnapshot } | undefined {
  const p = panel.ratingPanel; if (p?.answerText === undefined) return;
  return ratingSources(s, panel).find(({ card, snapshot }) => ratingFeedbackMatches(card, p) && [true, false].some(guidance => renderCard(card, snapshot, true, p.answerMatch, guidance, [], false, true, p.exerciseFeedback).text === p.answerText
    || p.exerciseFeedback === undefined && p.attemptId !== undefined && renderCard(card, snapshot, true, undefined, guidance).text === p.answerText));
}
export function ratingAnswerAllowed(s: ServerState, panel: Outbound, now: number): boolean {
  const source = ratingAnswerSource(s, panel); if (!source) return false;
  const { card, snapshot } = source;
  return now < snapshot.expiresAt && (s.materialConsentIds?.includes(card.materialId) ?? true)
    && (s.attachmentConsent !== false || !card.hints?.length && !card.media?.length)
    && (!card.offline || s.offlineConsent === true && now < decodeOfflineSeed(card.offline).expiresAt);
}
export function carriesGradeAnswer(text: unknown, panel: Outbound): boolean {
  return panel.ratingPanel?.answerText !== undefined && typeof text === "string" && text.startsWith(panel.ratingPanel.answerText + "\n\n");
}
export type TransportResult = number | void | { messageId: number; pollId: string };
export type OwnedDelivery = ({ studyPlan: StudyPlanDelivery } | { miniAppUrl: string; planId?: string }) & { vaultId?: string };
export interface Transport { ready?(): boolean; supportsNativePolls?(): boolean; cachedMedia?(enrollment: string, asset: CompanionMediaIdentity): boolean; call(method: Outbound["method"], payload: Record<string, unknown>, authorize?: () => boolean | void, owned?: OwnedDelivery): Promise<TransportResult>; }
export function mediaMethod(asset: { kind: string; format: string; bytes: number }): Outbound["method"] {
  return asset.kind === "image" && ["png", "jpg", "jpeg"].includes(asset.format) && asset.bytes <= 10_000_000 ? "sendPhoto"
    : asset.kind === "audio" && ["mp3", "m4a"].includes(asset.format) ? "sendAudio"
    : asset.kind === "video" && asset.format === "mp4" ? "sendVideo" : "sendDocument";
}
export const isMediaMethod = (method: Outbound["method"]): boolean => ["sendPhoto", "sendAudio", "sendVideo", "sendDocument", "editMessageMedia"].includes(method);
export const isEditMethod = (method: Outbound["method"]): boolean => method === "editMessageMedia" || method === "editMessageText";
export const MEDIA_LOADING_ERROR = "Не удалось загрузить вложение. Напишите /go, чтобы открыть карточку снова.";
export const MINI_APP_LAUNCH_TEXT = "Занятия проходят в Mini App. Откройте приложение, чтобы продолжить.";
export const GRADE_SAVED_NOTICE = "Оценка сохранена в боте.";
export const loadingText = (kind: string): string => kind === "image" ? "Загружаем изображение…" : kind === "audio" ? "Загружаем аудио…" : "Загружаем видео…";
export const statuses: ImportStatus[] = ["applied", "stale", "epoch-mismatch", "missing", "ineligible", "local-session-active", "expired", "clock-mismatch"];
export function validateServerState(s: ServerState, ownerChatId?: number, results?: ServerResultArchive): void {
  record(s); keys(s, ["version", "binding", "domain", "handles", "updates", "callbackIds", "replayArchived", "nonces", "bridgeTimeFloor", "outbox", "receipts", "lastSession", "mutedUntil", "claimedAttempts", "studySession", "editableGrades", "gradeCorrections", "materialConsentIds", "attachmentConsent", "offlineConsent", "offlineHeads", "supersededOfflineReviews", "miniApp", "miniAppReceipts", "miniAppAttempts", "studyPlan", "studyPlanSent", "studyContext", "planCommands", "planCommandReceipts", "cardReportsEnabled", "cardReports", "cardReportReceipts", "writtenRecalls", "writtenRecallReceipts", "retainAnswers", "retainAnswersChangedAt", "answerHistoryFull", "answerHistory", "answerHistoryReferences", "answerHistoryReceipts", "resultLedger", "catalogRevision", "catalogRoot"]);
  invalid(s.replayArchived === undefined || s.replayArchived === true);
  invalid((s.catalogRevision === undefined) === (s.catalogRoot === undefined), "incomplete catalog publication fence");
  if (s.catalogRoot !== undefined) { validateCatalogRoot(s.catalogRoot); invalid(s.catalogRevision === catalogRootRevision(s.catalogRoot) && s.domain.snapshot !== undefined, "catalog publication differs"); }
  invalid(s.retainAnswers === undefined || typeof s.retainAnswers === "boolean");
  invalid(s.answerHistoryFull === undefined || typeof s.answerHistoryFull === "boolean");
  if (s.retainAnswersChangedAt !== undefined) timestamp(s.retainAnswersChangedAt);
  invalid(s.cardReportsEnabled === undefined || typeof s.cardReportsEnabled === "boolean");
  invalid(s.offlineConsent === undefined || typeof s.offlineConsent === "boolean");
  invalid(s.attachmentConsent === undefined || typeof s.attachmentConsent === "boolean");
  invalid(s.version === 1 && typeof s.binding === "string" && /^[a-f0-9]{64}$/.test(s.binding));
  record(s.domain);
  if (s.domain.snapshot !== undefined) validateImmutableSnapshot(s.domain.snapshot);
  validateState({ ...s.domain, snapshot: undefined });
  validateResultLedger(s);
  for (const rows of [s.handles, s.updates, s.callbackIds, s.outbox, s.receipts]) invalid(Array.isArray(rows));
  invalid(Array.isArray(s.nonces) && s.nonces.length <= 10000, "nonce window limit");
  timestamp(s.lastSession); timestamp(s.mutedUntil); timestamp(s.bridgeTimeFloor);
  const unique = (ids: unknown[]) => invalid(new Set(ids).size === ids.length);
  if (s.studyPlan !== undefined) validateCompanionStudyPlan(s.studyPlan);
  if (s.studyContext !== undefined) {
    validateImmutableStudyContext(s.studyContext);
    const cards = s.domain.snapshot && snapshotCardMap(s.domain.snapshot), permitted = new Set(s.materialConsentIds);
    invalid(cards && s.studyContext.cards.every(row => { const card = cards.get(row.id); return card && permitted.has(card.materialId); }), "study metadata source differs");
  }
  if (s.studyPlanSent !== undefined) {
    invalid(s.studyPlan !== undefined && Array.isArray(s.studyPlanSent));
    unique(s.studyPlanSent.map(row => row.id + ":" + row.notifyAt));
    for (const row of s.studyPlanSent) { record(row); keys(row, ["id", "notifyAt"]); invalid(typeof row.id === "string" && row.id.length === 64 && /^[a-f0-9]{64}$/.test(row.id)); timestamp(row.notifyAt); }
  }
  if (s.supersededOfflineReviews !== undefined) {
    invalid(Array.isArray(s.supersededOfflineReviews));
    const attempts = [...s.domain.pending, ...s.domain.outcomes.map(row => row.attempt), ...s.supersededOfflineReviews.map(row => row.attempt)];
    const ancestors = new Map(attempts.map(row => [row.id, row]));
    invalid(ancestors.size === attempts.length);
    for (const row of s.supersededOfflineReviews) {
      record(row); keys(row, ["attempt", "seed"]); validateAttempt(row.attempt); invalid(row.attempt.offline !== undefined && row.attempt.correct === (row.attempt.rating !== 1));
      const seed = decodeOfflineSeed(row.seed), step = decodeOfflineStep(row.attempt.offline);
      const parent = step.parentId && ancestors.get(step.parentId);
      invalid(step.rootRevision === seed.rootRevision && offlineReviewTimeAllowed(step, row.attempt.occurredAt)
        && step.after === advanceOfflineFsrs(seed, step.before, row.attempt.correct ? row.attempt.rating : 1, row.attempt.occurredAt), "superseded review differs");
      invalid(step.index === 1 ? step.before === seed.state : parent && parent.cardId === row.attempt.cardId && parent.offline && decodeOfflineStep(parent.offline).rootRevision === seed.rootRevision
        && decodeOfflineStep(parent.offline).index + 1 === step.index && decodeOfflineStep(parent.offline).after === step.before
        && parent.scope === row.attempt.scope && parent.epoch === row.attempt.epoch && parent.occurredAt <= row.attempt.occurredAt, "superseded ancestry differs");
    }
  }
  if (s.materialConsentIds !== undefined) { invalid(Array.isArray(s.materialConsentIds)); unique(s.materialConsentIds); s.materialConsentIds.forEach(token); }
  validateMiniAppState(s); validateCompanionPlanCommandState(s); validateCompanionCardReportState(s);
  const textAttempts = [...s.domain.pending, ...s.domain.outcomes.map(row => row.attempt)], knownText = new Set(textAttempts.map(row => row.id));
  const acknowledgedTextIds = new Set([...(s.writtenRecallReceipts ?? []).map(row => row.recall.attempt.id), ...(s.answerHistoryReceipts ?? []).map(row => row.attemptId)]);
  const coldText = [...acknowledgedTextIds].filter(id => !knownText.has(id));
  if (coldText.length) {
    invalid(s.resultLedger?.archiveUsed && results, "Retained answer result archive unavailable");
    const groups = new Map<string, ReviewAttempt[]>();
    for (const row of [...(s.writtenRecallReceipts ?? []).map(row => row.recall.attempt), ...(s.answerHistory ?? []).map(row => row.attempt)]) {
      if (knownText.has(row.id) || !acknowledgedTextIds.has(row.id)) continue;
      const key = JSON.stringify([row.scope, row.epoch]), group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const found = results.getMany(group[0].scope, group[0].epoch, group.map(row => row.id));
      for (const row of group) { const archived = found.get(row.id); invalid(archived, "Retained answer result missing"); textAttempts.push(archived.outcome.attempt); }
    }
  }
  validateCompanionWrittenRecallState(s, textAttempts);
  validateAnswerHistoryState(s, textAttempts);
  if (s.miniAppAttempts !== undefined) {
    invalid(Array.isArray(s.miniAppAttempts)); unique(s.miniAppAttempts.map(row => row.id));
    for (const row of s.miniAppAttempts) { record(row); keys(row, ["id", "answerMatch"]); token(row.id); invalid(row.answerMatch === undefined || typeof row.answerMatch === "boolean");
      invalid(knownText.has(row.id)); }
  }
  if (s.studySession !== undefined) {
    const session = s.studySession; record(session); keys(session, ["id", "snapshot", "status", "results", "skipped", "deferred", "current", "frames", "waitUntil", "mode"]); token(session.id); validateSnapshot(session.snapshot); invalid(session.snapshot.cards.length <= 1000, "session card limit");
    invalid(session.mode === undefined || (session.mode === "core" || session.mode === "bank") && session.snapshot.cards.every(card => card.mode === session.mode));
    const sessionAttempts = [...s.domain.pending, ...s.domain.outcomes.map(row => row.attempt)];
    const frozenAncestors = [...sessionAttempts, ...(s.supersededOfflineReviews ?? []).map(row => row.attempt)];
    const validateFrame = (card: SelectedCard): string | undefined => {
      validateSessionFrame(card, session.snapshot);
      if (!card.offline) return;
      const seed = decodeOfflineSeed(card.offline);
      const parent = frozenAncestors.find(attempt => attempt.id === card.revision && attempt.cardId === card.id && attempt.offline);
      const previous = parent && decodeOfflineStep(parent.offline!);
      const state = card.revision === seed.rootRevision ? seed.state : previous?.rootRevision === seed.rootRevision ? previous.after : undefined;
      invalid(state && card.dueAt === offlineStateDue(state), "offline occurrence differs"); return state;
    };
    invalid(["active", "paused", "finished"].includes(session.status) && Array.isArray(session.results) && session.results.length <= 1000 && Array.isArray(session.skipped));
    invalid(session.deferred === undefined || Array.isArray(session.deferred));
    unique(session.results.map(row => row.attemptId)); unique([...session.skipped, ...(session.deferred ?? [])]);
    unique(session.results.filter(row => !row.card?.offline).map(row => row.cardId));
    for (const row of session.results) { record(row); keys(row, ["cardId", "attemptId", "card"]); token(row.cardId); token(row.attemptId); invalid(session.snapshot.cards.some(card => card.id === row.cardId));
      if (row.card) { const before = validateFrame(row.card); invalid(row.card.id === row.cardId);
        if (row.card.offline) { const attempt = sessionAttempts.find(attempt => attempt.id === row.attemptId); invalid(attempt?.offline && attempt.cardId === row.cardId && attempt.revision === row.card.revision && decodeOfflineStep(attempt.offline).before === before, "offline result differs"); }
      } }
    if (session.current !== undefined) validateFrame(session.current);
    if (session.frames !== undefined) { invalid(Array.isArray(session.frames) && session.frames.length <= 1001); for (const card of session.frames) validateFrame(card); }
    if (session.waitUntil !== undefined) timestamp(session.waitUntil);
    for (const id of [...session.skipped, ...(session.deferred ?? [])]) { token(id); invalid(session.snapshot.cards.some(card => card.id === id)); }
  }
  invalid(s.offlineConsent === true || !s.offlineHeads?.length);
  if (s.offlineHeads !== undefined) validateOfflineHeads(s.offlineHeads, s.domain.snapshot, [...s.domain.pending, ...s.domain.outcomes.filter(row => row.status === "applied").map(row => row.attempt)]);
  if (s.editableGrades !== undefined) {
    invalid(Array.isArray(s.editableGrades)); unique(s.editableGrades.map(row => row.attemptId));
    const applied = new Set(s.domain.outcomes.filter(row => row.status === "applied").map(row => row.attempt.id));
    for (const row of s.editableGrades) { record(row); keys(row, ["attemptId", "materialId", "withAttachments", "reviewEventId", "rating", "expiresAt", "answerMatch"]); token(row.attemptId); token(row.materialId); token(row.reviewEventId); timestamp(row.expiresAt); invalid(typeof row.withAttachments === "boolean");
      invalid([1, 2, 3, 4].includes(row.rating) && (row.answerMatch === undefined || typeof row.answerMatch === "boolean") && applied.has(row.attemptId)); }
  }
  if (s.gradeCorrections !== undefined) {
    invalid(Array.isArray(s.gradeCorrections)); unique(s.gradeCorrections.map(row => row.correction.id));
    for (const row of s.gradeCorrections) { record(row); keys(row, ["correction", "receipt"]); validateCompanionGradeCorrection(row.correction); if (row.receipt !== undefined) validateCompanionGradeCorrectionReceipt(row.receipt, row.correction); }
  }
  if (s.claimedAttempts !== undefined) {
    invalid(Array.isArray(s.claimedAttempts)); unique(s.claimedAttempts);
    const pending = new Set(s.domain.pending.map(row => row.id));
    for (const id of s.claimedAttempts) { token(id); invalid(pending.has(id)); }
  }
  unique(s.handles.map(h => h.id)); unique(s.updates.map(u => u.id)); unique(s.callbackIds.map(c => c.id)); unique(s.nonces.map(n => n.nonce)); unique(s.outbox.map(o => o.id)); unique(s.receipts.map(r => r.id));
  for (const r of s.receipts) { record(r); keys(r, ["id", "hash"]); token(r.id); invalid(typeof r.hash === "string" && /^[a-f0-9]{64}$/.test(r.hash)); }
  for (const h of s.handles) { record(h); keys(h, ["id", "epoch", "sequence", "expiresAt", "action"]); token(h.id); token(h.epoch); timestamp(h.sequence); timestamp(h.expiresAt); record(h.action); invalid(Buffer.byteLength(canonical(h.action)) <= 8192);
    if (h.action.kind === "rich-demo") {
      keys(h.action, ["kind", "panelId", "operation", "index"]); token(h.action.panelId); invalid(h.sequence === 0 && ["toggle", "check", "reset"].includes(String(h.action.operation)));
      invalid(h.action.operation === "toggle" ? Number.isSafeInteger(h.action.index) && Number(h.action.index) >= 0 && Number(h.action.index) < 4 : h.action.index === undefined);
    }
    if (["select-option", "toggle-option", "submit-options", "skip-card"].includes(String(h.action.kind))) {
      keys(h.action, ["kind", "scope", "epoch", "sequence", "cardId", "revision", "index"]);
      for (const field of [h.action.scope, h.action.epoch, h.action.cardId, h.action.revision]) token(field);
      invalid(h.sequence > 0 && h.action.sequence === h.sequence && h.action.epoch === h.epoch);
      invalid(["select-option", "toggle-option"].includes(String(h.action.kind))
        ? Number.isSafeInteger(h.action.index) && Number(h.action.index) >= 0 && Number(h.action.index) < 12 : h.action.index === undefined);
    }
    if (h.action.kind === "answer") {
      keys(h.action, ["kind", "scope", "epoch", "sequence", "cardId", "revision"]);
      for (const field of [h.action.scope, h.action.epoch, h.action.cardId, h.action.revision]) token(field);
      invalid(h.sequence > 0 && h.action.sequence === h.sequence && h.action.epoch === h.epoch);
    }
    if (h.action.kind === "hint") {
      keys(h.action, ["kind", "scope", "epoch", "sequence", "cardId", "revision", "index"]);
      for (const field of [h.action.scope, h.action.epoch, h.action.cardId, h.action.revision]) token(field);
      invalid(h.sequence > 0 && h.action.sequence === h.sequence && h.action.epoch === h.epoch && Number.isSafeInteger(h.action.index) && Number(h.action.index) >= 0 && Number(h.action.index) < 10);
    }
    if (h.action.kind === "hint-panel") {
      keys(h.action, ["kind", "panelId", "index", "collapsed"]); token(h.action.panelId);
      invalid(h.sequence === 0 && Number.isSafeInteger(h.action.index) && Number(h.action.index) >= 0 && Number(h.action.index) < 10 && typeof h.action.collapsed === "boolean");
    }
    if (["change-saved-grade", "replace-saved-grade"].includes(String(h.action.kind))) {
      keys(h.action, ["kind", "attemptId", "expectedReviewEventId", "rating", "correct"]); token(h.action.attemptId); token(h.action.expectedReviewEventId); invalid(h.sequence === 0);
      if (h.action.kind === "replace-saved-grade") invalid([1, 2, 3, 4].includes(Number(h.action.rating)) && h.action.correct === (h.action.rating !== 1));
      else invalid(h.action.rating === undefined && h.action.correct === undefined);
    }
    if (String(h.action.kind).startsWith("session-")) {
      keys(h.action, ["kind", "sessionId", "cardId", "offset", "attemptId"]); token(h.action.sessionId); invalid(h.sequence === 0 && ["session-history", "session-result", "session-pause", "session-resume", "session-finish", "session-new"].includes(String(h.action.kind)));
      if (h.action.attemptId !== undefined) token(h.action.attemptId);
      if (h.action.cardId !== undefined) token(h.action.cardId); if (h.action.offset !== undefined) timestamp(h.action.offset);
    }
    if (["change-grade", "replace-grade"].includes(String(h.action.kind))) {
      keys(h.action, ["kind", "attemptId", "rating", "correct", "answerMatch"]); token(h.action.attemptId); invalid(h.sequence === 0);
      if (h.action.kind === "replace-grade") invalid([1, 2, 3, 4].includes(Number(h.action.rating)) && h.action.correct === (h.action.rating !== 1) && !(h.action.answerMatch === true && h.action.rating === 1));
      else invalid(h.action.rating === undefined && h.action.correct === undefined);
    }
    if (h.action.answerMatch !== undefined) invalid(["review", "change-grade", "replace-grade"].includes(String(h.action.kind)) && typeof h.action.answerMatch === "boolean");
  }
  for (const u of s.updates) { record(u); keys(u, ["id", "hash"]); timestamp(u.id); invalid(typeof u.hash === "string" && /^[a-f0-9]{64}$/.test(u.hash)); }
  for (const c of s.callbackIds) { record(c); keys(c, ["id", "hash"]); invalid(typeof c.id === "string" && c.id.length > 0 && c.id.length <= 128 && typeof c.hash === "string" && /^[a-f0-9]{64}$/.test(c.hash)); }
  for (const n of s.nonces) { record(n); keys(n, ["nonce", "time", "hash", "response"]); token(n.nonce); timestamp(n.time); invalid(typeof n.hash === "string" && /^[a-f0-9]{64}$/.test(n.hash)); canonical(n.response); }
  const handles = new Map(s.handles.map(h => [h.id, h]));
  const outbox = new Map(s.outbox.map(row => [row.id, row]));
  const planDeliveries = new Set(s.studyPlanSent?.map(row => row.id + ":" + row.notifyAt));
  const hintBodies = new Map<string, Set<string>>();
  const hintContent = (panel: Outbound, text: unknown): void => {
    const p = panel.hintPanel!, session = s.studySession;
    if (session?.id !== p.sessionId) return;
    const card = sessionCards(session).find(card => card.id === p.cardId && card.revision === p.revision);
    invalid(card?.hints?.length && p.count <= card.hints.length && p.expiresAt <= session.snapshot.expiresAt, "hint source differs");
    let allowed = hintBodies.get(panel.id);
    if (!allowed) {
      allowed = new Set<string>(); hintBodies.set(panel.id, allowed);
      for (let count = 1; count <= p.count; count++) {
        allowed.add(hintPanelView(card.hints, count, 0, true).text);
        for (let index = 0; index < count; index++) allowed.add(hintPanelView(card.hints, count, index, false).text);
      }
    }
    invalid(typeof text === "string" && allowed.has(text), "hint content differs");
  };
  const questionContent = (panel: Outbound, text: unknown, replyMarkup: unknown, status: Outbound["status"]): void => {
    const p = panel.questionPanel!, session = s.studySession;
    if (!session || session.id !== panel.sessionContent?.sessionId) return;
    const card = sessionCards(session).find(card => card.id === p.cardId && card.revision === p.revision);
    invalid(card && (card.exercise || card.offline) && p.expiresAt <= session.snapshot.expiresAt, "question source differs");
    const choice = card.exercise?.kind === "single" || card.exercise?.kind === "multiple" ? card.exercise : undefined;
    invalid(p.selectedOptionIndexes.every(index => choice && index < choice.options.length)
      && (choice?.kind === "multiple" || p.selectedOptionIndexes.length <= (choice ? 1 : 0)), "question selection differs");
    const adaptive = p.choiceLayout !== undefined, checkboxes = p.choiceLayout === "checkboxes";
    invalid(!adaptive || choice, "question layout differs"); invalid(!checkboxes || choice?.kind === "multiple", "checkbox layout differs");
    invalid([true, false].some(guidance => renderCard(card, session.snapshot, false, undefined, guidance, p.selectedOptionIndexes, !adaptive, checkboxes).text === text), "question content differs");
    const markup = replyMarkup as { inline_keyboard: { text: string; callback_data: string; style?: string }[][]; force_reply?: true };
    const exact = card.exercise?.kind === "cloze" || !card.exercise && card.evaluationMode === "exact";
    invalid(markup.force_reply === (exact ? true : undefined), "question reply mode differs");
    invalid(exact ? typeof panel.answerHandle === "string" : panel.answerHandle === undefined, "question reply binding differs");
    const answer = panel.answerHandle === undefined ? undefined : handles.get(panel.answerHandle);
    if (answer) invalid(answer.action.kind === "answer" && answer.action.cardId === card.id && answer.action.revision === card.revision
      && answer.action.scope === session.snapshot.scope && answer.action.epoch === session.snapshot.epoch && answer.action.sequence === panel.snapshotSequence
      && answer.expiresAt <= p.expiresAt, "question answer source differs");
    const layout = choice ? adaptive ? choiceButtonLayout(choice) : { columns: 1, labels: choice.options.map((_, i) => String(i + 1)) } : undefined;
    const optionRows = layout ? Math.ceil(layout.labels.length / layout.columns) : 0;
    for (const [rowIndex, row] of markup.inline_keyboard.entries()) {
      const optionRow = layout && rowIndex < optionRows;
      invalid(row.length === (optionRow ? Math.min(layout.columns, layout.labels.length - rowIndex * layout.columns) : 1), "question row differs");
      for (const [column, button] of row.entries()) {
        const index = optionRow ? rowIndex * layout.columns + column : undefined;
        if (index !== undefined) {
          const label = layout!.labels[index], mark = adaptive && !checkboxes ? "✓" : "☑", selected = choice!.kind === "multiple" && button.text === `${mark} ${label}`;
          invalid(button.text === (selected ? `${mark} ${label}` : choice!.kind === "multiple" && (!adaptive || checkboxes) ? `☐ ${label}` : label)
            && button.style === (adaptive && selected ? "primary" : undefined), "question option differs");
        } else invalid(button.style === undefined, "question control style differs");
        const handle = handles.get(button.callback_data);
        // Previously delivered controls may have been revoked; queued edits must own every live action.
        if (!handle) { invalid(status !== "queued", "question control missing"); continue; }
        const action = handle.action;
        if (index !== undefined) {
          invalid(action.kind === (choice!.kind === "single" ? "select-option" : "toggle-option") && action.index === index, "question option differs");
        } else if (button.text === "Подсказки") {
          const hint = (typeof action.panelId === "string" ? outbox.get(action.panelId) : undefined)?.hintPanel;
          invalid(action.kind === "hint-panel" && hint?.cardId === card.id && hint.revision === card.revision && hint.sessionId === session.id, "question hint differs"); continue;
        } else {
          const kind = { "Показать ответ": "reveal", "Подсказка": "hint", "Пропустить сейчас": "skip-card", "Проверить ответ": "submit-options" }[button.text];
          invalid(kind && action.kind === kind && (kind !== "submit-options" || choice?.kind === "multiple"), "question action differs");
        }
        invalid(action.cardId === card.id && action.revision === card.revision && action.scope === session.snapshot.scope && action.epoch === session.snapshot.epoch && action.sequence === panel.snapshotSequence, "question binding differs");
      }
    }
  };
  unique(s.outbox.filter(o => o.messageId !== undefined).map(o => o.messageId));
  unique(s.outbox.filter(o => o.answerHandle !== undefined).map(o => o.answerHandle));
  unique(s.outbox.filter(o => o.studyPlanEntry !== undefined).map(o => o.studyPlanEntry!.id + ":" + o.studyPlanEntry!.notifyAt));
  const preceding = new Map<string, Outbound>();
  const pollIds = new Set<string>(), pollStops = new Set<string>();
  for (const o of s.outbox) { record(o); keys(o, ["id", "method", "payload", "status", "snapshotSequence", "answerHandle", "messageId", "after", "target", "mediaPlaceholder", "failureHandled", "hintLease", "hintPanel", "ratingPanel", "sessionPanel", "sessionContent", "questionPanel", "pollPanel", "richDemoPanel", "studyPlanEntry", "miniAppPlan"]); token(o.id); if (o.snapshotSequence !== undefined) timestamp(o.snapshotSequence); invalid(["sendMessage", "answerCallbackQuery", "sendPhoto", "sendAudio", "sendVideo", "sendDocument", "editMessageMedia", "editMessageText", "sendPoll", "stopPoll", "sendRichMessage"].includes(o.method) && ["queued", "unknown", "sent"].includes(o.status)); record(o.payload);
    if (o.miniAppPlan !== undefined) { invalid(o.method === "sendMessage" && o.payload.text === MINI_APP_LAUNCH_TEXT && typeof o.miniAppPlan === "string" && /^[a-f0-9]{64}$/.test(o.miniAppPlan)); }
    if (o.studyPlanEntry !== undefined) {
      invalid(o.method === "sendMessage" && Object.keys(o).every(key => ["id", "method", "payload", "status", "messageId", "studyPlanEntry"].includes(key)));
      validateStudyPlanPayload(o.payload, o.studyPlanEntry);
      invalid(planDeliveries.has(o.studyPlanEntry.id + ":" + o.studyPlanEntry.notifyAt), "missing plan delivery marker");
    }
    if (o.richDemoPanel !== undefined) validateStoredRichDemo(s, o);
    invalid(o.method !== "sendRichMessage" || o.richDemoPanel !== undefined);
    if (o.pollPanel !== undefined) {
      validateStoredPoll(s, o);
      if (o.pollPanel.pollId !== undefined) { invalid(!pollIds.has(o.pollPanel.pollId), "duplicate poll binding"); pollIds.add(o.pollPanel.pollId); }
    }
    invalid(o.method !== "sendPoll" || o.pollPanel !== undefined);
    if (o.sessionContent !== undefined) { record(o.sessionContent); keys(o.sessionContent, ["sessionId", "cardId", "revision"]); token(o.sessionContent.sessionId); invalid(o.method !== "answerCallbackQuery" && (o.answerHandle === undefined || o.questionPanel !== undefined) && o.sessionPanel === undefined);
      invalid((o.sessionContent.cardId === undefined) === (o.sessionContent.revision === undefined)); if (o.sessionContent.cardId !== undefined) { token(o.sessionContent.cardId); token(o.sessionContent.revision); } }
    if (o.questionPanel !== undefined) {
      const p = o.questionPanel; record(p); keys(p, ["cardId", "revision", "selectedOptionIndexes", "expiresAt", "choiceLayout"]); token(p.cardId); token(p.revision); timestamp(p.expiresAt);
      invalid(p.choiceLayout === undefined || p.choiceLayout === "adaptive" || p.choiceLayout === "checkboxes");
      invalid(o.method === "sendMessage" && o.sessionContent && !o.ratingPanel && !o.hintPanel && !o.hintLease && !o.mediaPlaceholder && !o.sessionPanel && o.snapshotSequence !== undefined && o.payload.entities === undefined
        && Array.isArray(p.selectedOptionIndexes) && p.selectedOptionIndexes.length <= 12 && p.selectedOptionIndexes.every((index, i) => Number.isSafeInteger(index) && index >= 0 && index < 12 && (i === 0 || p.selectedOptionIndexes[i - 1] < index)));
      validateQuestionPanelEdit(o.payload.text, o.payload.reply_markup); questionContent(o, o.payload.text, o.payload.reply_markup, o.status);
    }
    if (o.sessionPanel !== undefined) { record(o.sessionPanel); keys(o.sessionPanel, ["sessionId"]); token(o.sessionPanel.sessionId); invalid(o.method === "sendMessage" && !o.ratingPanel && !o.answerHandle && !o.mediaPlaceholder); validateSessionPanelEdit(o.payload.text, o.payload.reply_markup); }
    if (o.ratingPanel !== undefined) {
      record(o.ratingPanel); keys(o.ratingPanel, ["cardId", "revision", "attemptId", "answerMatch", "answerText", "exerciseFeedback"]); token(o.ratingPanel.cardId); token(o.ratingPanel.revision);
      invalid(o.ratingPanel.answerMatch === undefined || typeof o.ratingPanel.answerMatch === "boolean");
      if (o.ratingPanel.exerciseFeedback !== undefined) {
        validateCompanionExerciseFeedback(o.ratingPanel.exerciseFeedback); invalid(typeof o.ratingPanel.answerMatch === "boolean");
        if (o.ratingPanel.exerciseFeedback.kind === "cloze") invalid(o.ratingPanel.answerMatch === o.ratingPanel.exerciseFeedback.matchedBlanks.every(Boolean));
        else if (o.ratingPanel.exerciseFeedback.kind === "choice" && !o.ratingPanel.exerciseFeedback.selectedOptionIndexes.length) invalid(o.ratingPanel.answerMatch === false);
        const sources = ratingSources(s, o); if (sources.length) invalid(sources.some(({ card }) => ratingFeedbackMatches(card, o.ratingPanel!)), "exercise feedback source differs");
      }
      if (o.ratingPanel.attemptId !== undefined) token(o.ratingPanel.attemptId);
      invalid(o.method === "sendMessage" && o.answerHandle === undefined && o.mediaPlaceholder === undefined && o.payload.entities === undefined);
      const answerText = o.ratingPanel.answerText;
      invalid(answerText === undefined || typeof answerText === "string" && combinedGradeText(answerText, GRADE_PROMPT) !== undefined);
      if (answerText !== undefined && o.status === "queued" && carriesGradeAnswer(o.payload.text, o)) invalid(ratingAnswerSource(s, o), "rating answer source differs");
      if (o.payload.text !== GRADE_PROMPT && o.payload.text !== "Оцените воспроизведение:" && (answerText === undefined || o.payload.text !== combinedGradeText(answerText, GRADE_PROMPT))) validateGradePanelEdit(o.payload.text, o.payload.reply_markup, answerText);
    }
    if (o.hintLease !== undefined) {
      record(o.hintLease); keys(o.hintLease, ["cardId", "revision", "index", "expiresAt"]); token(o.hintLease.cardId); token(o.hintLease.revision); timestamp(o.hintLease.expiresAt);
      invalid(o.method === "sendMessage" && o.snapshotSequence !== undefined && o.answerHandle === undefined && o.mediaPlaceholder === undefined && o.payload.entities !== undefined
        && Number.isSafeInteger(o.hintLease.index) && o.hintLease.index >= 0 && o.hintLease.index < 10 && o.hintLease.expiresAt > 0);
    }
    if (o.hintPanel !== undefined) {
      const panel = o.hintPanel; record(panel); keys(panel, ["cardId", "revision", "sessionId", "count", "index", "collapsed", "expiresAt", "readOnly"]);
      token(panel.cardId); token(panel.revision); token(panel.sessionId); timestamp(panel.expiresAt);
      invalid(o.method === "sendMessage" && !o.answerHandle && !o.mediaPlaceholder && !o.ratingPanel && !o.sessionPanel && !o.hintLease && o.payload.entities === undefined
        && o.sessionContent?.sessionId === panel.sessionId && Number.isSafeInteger(panel.count) && panel.count > 0 && panel.count <= 10
        && Number.isSafeInteger(panel.index) && panel.index >= 0 && panel.index < panel.count && typeof panel.collapsed === "boolean" && (panel.readOnly === undefined || panel.readOnly === true));
      validateHintPanelEdit(o.payload.text, o.payload.reply_markup);
      hintContent(o, o.payload.text);
    }
    if (o.after !== undefined) { token(o.after); invalid(preceding.has(o.after), "delivery dependency missing"); }
    if (o.method === "stopPoll") {
      token(o.target); const target = preceding.get(o.target);
      invalid(target?.method === "sendPoll" && target.status === "sent" && target.pollPanel !== undefined && target.pollPanel.pollId === o.payload.pollId && target.pollPanel.sealed === true
        && target.payload.chat_id === o.payload.chat_id && o.after === o.target && !pollStops.has(o.target), "unowned poll target"); pollStops.add(o.target!);
    } else if (isEditMethod(o.method)) {
      if (o.method === "editMessageText" && o.payload.rich_message !== undefined) {
        token(o.target); const target = preceding.get(o.target); invalid(target?.method === "sendRichMessage" && target.richDemoPanel && target.status === "sent" && target.messageId !== undefined
          && target.payload.chat_id === o.payload.chat_id && o.after === o.target, "unowned rich demo target");
        validateStoredRichDemoEdit(s, o, target);
      } else {
      token(o.target); const target = preceding.get(o.target); invalid(target?.method === "sendMessage" && target.payload.chat_id === o.payload.chat_id && o.after === o.target
        && (o.method === "editMessageText" && o.payload.reply_markup !== undefined ? target.ratingPanel !== undefined || target.sessionPanel !== undefined || target.hintPanel !== undefined || target.questionPanel !== undefined : target.mediaPlaceholder === true), "unowned edit target");
      if (o.method === "editMessageText" && target.questionPanel) {
        invalid(o.sessionContent?.sessionId === target.sessionContent?.sessionId && o.snapshotSequence === target.snapshotSequence);
        validateQuestionPanelEdit(o.payload.text, o.payload.reply_markup); questionContent(target, o.payload.text, o.payload.reply_markup, o.status);
      }
      if (o.method === "editMessageText" && o.payload.reply_markup !== undefined && target.sessionPanel) validateSessionPanelEdit(o.payload.text, o.payload.reply_markup);
      if (o.method === "editMessageText" && o.payload.reply_markup !== undefined && target.ratingPanel) {
        validateGradePanelEdit(o.payload.text, o.payload.reply_markup, target.ratingPanel.answerText);
        if (o.status === "queued" && carriesGradeAnswer(o.payload.text, target)) invalid(ratingAnswerSource(s, target), "rating answer source differs");
      }
      if (o.method === "editMessageText" && target.hintPanel) {
        invalid(o.sessionContent?.sessionId === target.hintPanel.sessionId);
        validateHintPanelEdit(o.payload.text, o.payload.reply_markup);
        hintContent(target, o.payload.text);
      }
      if (o.method === "editMessageMedia") invalid(o.snapshotSequence === target.snapshotSequence && target.payload.text === loadingText(String(o.payload.kind)), "media target differs");
      }
    } else invalid(o.target === undefined);
    if (o.mediaPlaceholder !== undefined) invalid(o.mediaPlaceholder === true && o.method === "sendMessage" && o.answerHandle === undefined && o.snapshotSequence !== undefined && o.payload.entities === undefined && [loadingText("image"), loadingText("audio"), loadingText("video")].includes(String(o.payload.text)));
    if (o.failureHandled !== undefined) invalid(o.failureHandled === true && o.status === "unknown" && (isMediaMethod(o.method) || o.mediaPlaceholder === true || o.hintPanel !== undefined || o.questionPanel !== undefined || o.method === "editMessageText" || o.method === "sendPoll" || o.method === "stopPoll" || o.method === "sendRichMessage"));
    preceding.set(o.id, o);
    if (o.answerHandle !== undefined) { token(o.answerHandle); invalid(o.method === "sendMessage" && o.snapshotSequence !== undefined);
      const h = handles.get(o.answerHandle); invalid(!h || h.action.kind === "answer" && h.sequence === o.snapshotSequence);
    }
    if (o.messageId !== undefined) invalid(o.method !== "answerCallbackQuery" && o.method !== "stopPoll" && !isEditMethod(o.method) && o.status === "sent" && Number.isSafeInteger(o.messageId) && o.messageId > 0);
    if (o.method === "answerCallbackQuery") { keys(o.payload, ["callback_query_id", "text"]); invalid(typeof o.payload.callback_query_id === "string" && o.payload.callback_query_id.length > 0 && o.payload.callback_query_id.length <= 128);
      invalid(o.payload.text === undefined || o.payload.text === GRADE_SAVED_NOTICE); }
    else if (o.method === "sendRichMessage") {
      keys(o.payload, ["chat_id", "rich_message", "disable_notification"]); validateRichCheckboxDemoMessage(o.payload.rich_message);
      invalid(Number.isSafeInteger(o.payload.chat_id) && Number(o.payload.chat_id) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId) && o.payload.disable_notification === true);
    } else if (o.method === "editMessageText" && o.payload.rich_message !== undefined) {
      keys(o.payload, ["chat_id", "rich_message"]); validateRichCheckboxDemoMessage(o.payload.rich_message);
      invalid(Number.isSafeInteger(o.payload.chat_id) && Number(o.payload.chat_id) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId));
    }
    else if (o.method === "sendPoll") {
      validateNativePollPayload(o.payload); invalid(ownerChatId === undefined || o.payload.chat_id === ownerChatId);
    } else if (o.method === "stopPoll") {
      keys(o.payload, ["chat_id", "pollId"]); invalid(validNativePollId(o.payload.pollId) && Number.isSafeInteger(o.payload.chat_id) && Number(o.payload.chat_id) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId));
    } else if (o.method === "editMessageText") {
      keys(o.payload, ["chat_id", "text", "link_preview_options", "reply_markup"]);
      if (o.payload.reply_markup === undefined) invalid(o.payload.text === MEDIA_LOADING_ERROR);
      else if (preceding.get(o.target!)?.questionPanel) validateQuestionPanelEdit(o.payload.text, o.payload.reply_markup);
      else if (preceding.get(o.target!)?.ratingPanel) validateGradePanelEdit(o.payload.text, o.payload.reply_markup, preceding.get(o.target!)!.ratingPanel!.answerText);
      else if (String(o.payload.text).startsWith("Занятие · ")) validateSessionPanelEdit(o.payload.text, o.payload.reply_markup);
      else if (String(o.payload.text).startsWith("Подсказк")) validateHintPanelEdit(o.payload.text, o.payload.reply_markup);
      else validateGradePanelEdit(o.payload.text, o.payload.reply_markup);
      invalid(Number.isSafeInteger(o.payload.chat_id) && Number(o.payload.chat_id) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId));
      record(o.payload.link_preview_options); keys(o.payload.link_preview_options, ["is_disabled"]); invalid(o.payload.link_preview_options.is_disabled === true);
    } else if (isMediaMethod(o.method)) {
      keys(o.payload, ["chat_id", "assetId", "kind", "format", "bytes", "side", "caption", "disable_notification"]);
      invalid(Number.isSafeInteger(o.payload.chat_id) && Number(o.payload.chat_id) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId));
      validateCompanionMediaIdentity({ id: o.payload.assetId, kind: o.payload.kind, format: o.payload.format, bytes: o.payload.bytes });
      invalid(o.payload.side === "question" || o.payload.side === "answer");
      invalid(o.payload.caption === undefined || typeof o.payload.caption === "string" && o.payload.caption.length <= 500);
      invalid(typeof o.payload.disable_notification === "boolean" && (o.method === "editMessageMedia" || o.method === mediaMethod(o.payload as unknown as CompanionMediaAttachment)) && o.snapshotSequence !== undefined);
    } else {
      keys(o.payload, ["chat_id", "text", "disable_notification", "link_preview_options", "reply_markup", "entities"]);
      invalid(Number.isSafeInteger(o.payload.chat_id) && (o.payload.chat_id as number) > 0 && (ownerChatId === undefined || o.payload.chat_id === ownerChatId));
      invalid(typeof o.payload.text === "string" && o.payload.text.length > 0 && o.payload.text.length <= 4096 && typeof o.payload.disable_notification === "boolean");
      if (o.payload.entities !== undefined) validateCompanionSpoilers(o.payload.text as string, o.payload.entities);
      record(o.payload.link_preview_options); keys(o.payload.link_preview_options, ["is_disabled"]); invalid(o.payload.link_preview_options.is_disabled === true);
      record(o.payload.reply_markup);
      if (o.answerHandle !== undefined && o.payload.reply_markup.inline_keyboard === undefined) {
        keys(o.payload.reply_markup, ["force_reply", "selective"]); invalid(o.payload.reply_markup.force_reply === true && o.payload.reply_markup.selective === true);
      } else {
        keys(o.payload.reply_markup, o.answerHandle === undefined ? ["inline_keyboard"] : ["inline_keyboard", "force_reply"]);
        invalid(o.answerHandle === undefined || o.payload.reply_markup.force_reply === true);
        const keyboard = o.payload.reply_markup.inline_keyboard;
        invalid(Array.isArray(keyboard) && keyboard.length <= 100);
        for (const row of o.studyPlanEntry ? [] : keyboard) {
          const adaptive = o.questionPanel?.choiceLayout !== undefined;
          invalid(Array.isArray(row) && row.length > 0 && row.length <= (adaptive ? 3 : 1));
          for (const button of row) {
            record(button); keys(button, adaptive ? ["text", "callback_data", "style"] : ["text", "callback_data"]);
            invalid(typeof button.text === "string" && button.text.length > 0 && button.text.length <= 120 && typeof button.callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(button.callback_data)
              && (button.style === undefined || adaptive && button.style === "primary"));
          }
        }
      }
    }
  }
  // Mutable state is published as independently bounded pages; there is no whole-library JSON string.
}
