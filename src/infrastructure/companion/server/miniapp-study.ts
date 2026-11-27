import { randomBytes, randomInt } from "node:crypto";
import { MINIAPP_FINISH_GRACE_MS, MINIAPP_SESSION_TTL_MS } from "./miniapp-auth";
import { canonical, digest } from "./bridge-contract";
import { companionSnapshotIsCurrent, invalid, keys, queryCards, record, token, timestamp, validateAttempt, validateSnapshot,
  type CompanionSnapshot, type ReviewAttempt, type SelectedCard } from "../../../domain/companion/protocol";
import { companionExerciseBlankCount, companionExerciseQuestion, evaluateCompanionExercise } from "../../../domain/companion/exercises";
import { createCompanionExerciseFeedback, feedbackMatchesAnswer, validateCompanionExerciseFeedback, type CompanionExerciseFeedback } from "../../../domain/companion/exercise-feedback";
import { isExactTestAnswerCorrect, isExplicitTestAnswerCorrect } from "../../../domain/cards/recall-core";
import { extractClozeAnswers } from "../../../domain/cards/recall-test-core";
import { advanceOfflineFsrs, decodeOfflineSeed, decodeOfflineStep, encodeOfflineStep, offlineReviewTimeAllowed, offlineStateDue, stateIsShortStep } from "../../../domain/companion/offline-fsrs";
import { ensureOfflineHead, projectOfflineCard, validateSessionFrame } from "./offline-session";
import { snapshotCardMap, snapshotOfflineSeed, studyContextCardMap, studyContextToken } from "./immutable-content";
import type { CompanionMediaAttachment } from "../../../domain/companion/media";
import type { CompanionStudySession, ServerState } from "./runtime";
import { COMPANION_KNOWLEDGE_STATES, type CompanionKnowledgeState, type CompanionQuestionKind, type CompanionSourceContext, type CompanionStudyContext } from "../../../domain/companion/study-context";
import { validateCompanionPlanCommand, type CompanionPlanActionOptions, type CompanionPlanCommand } from "../../../domain/companion/study-plan-actions";
import { companionPlanCommandViews } from "./study-plan-actions";
import { tagKey } from "../../../domain/library/tag-key";
import { normalizeCardClarification, type CardClarificationReason } from "../../../domain/cards/card-clarification";
import { companionCardReportViews } from "./card-reports";
import type { CompanionStudyPlanOverviewEntry } from "../../../domain/companion/study-plan";
import { validateCompanionWrittenAnswer, validateCompanionSelfCheckCriteria, validateCompanionCheckedCriteria } from "../../../domain/companion/written-recall";
import { enqueueCompanionWrittenRecall, writtenRecallForAttempt } from "./written-recall";
import { aggregateWrongAnswerEvidence, answerHistoryReferenceId, createAnswerHistoryEvidence, type AnswerHistoryEvidence } from "../../../domain/review/answer-history";
import { answerHistoryForAttempt, answerHistoryRecords, enqueueAnswerHistory, replacePendingAnswerHistoryAttempt } from "./answer-history";

export type MiniAppRequest = { kind: "report-card"; requestId: string; viewToken: string; reason?: CardClarificationReason; note?: string } | { kind: "plan-action"; requestId: string; viewToken: string; id: string; revision: string; action: CompanionPlanCommand["action"]; date?: string; time?: string; durationMinutes?: number } | { kind: "view"; answerHistoryVersion?: 1 } | { kind: "today"; answerHistoryVersion?: 1 } | { kind: "plan"; id: string; answerHistoryVersion?: 1 } | {
  kind: "finish-chat"; requestId: string; viewToken: string; chatSessionId: string;
} | {
  kind: "start" | "hint" | "check" | "reveal" | "self-recall" | "grade" | "next" | "skip" | "finish" | "change-grade" | "pause" | "resume" | "answer-retention";
  requestId: string; viewToken: string; materialId?: string; materialIds?: string[]; allMaterials?: true; shuffle?: boolean; mode?: "core" | "bank"; rating?: 1 | 2 | 3 | 4; attemptId?: string; advance?: boolean; early?: true;
  response?: { text?: string; selectedOptionIndexes?: number[]; clozeAnswers?: string[]; matches?: number[]; order?: number[] };
  cardLimit?: number; timeLimitMinutes?: number; retryWeak?: true; learningGroup?: string; questionKind?: CompanionQuestionKind; section?: string;
  planId?: string;
  topic?: string; tag?: string; knowledgeState?: CompanionKnowledgeState;
  text?: string; checkedCriteria?: number[]; topicRecallCardId?: string; enabled?: boolean;
};
export interface MiniAppView {
  status: "materials" | "question" | "result" | "waiting" | "finished" | "unavailable" | "chat-active" | "paused";
  serverNow: number;
  connectionExpiresAt?: number;
  viewToken: string;
  chatSessionId?: string;
  planActions?: boolean;
  planCommands?: ReturnType<typeof companionPlanCommandViews>;
  sync?: { generatedAt: number; pendingAnswers: number };
  studyTarget?: { id: string; targetDate: string; timeZone: string; status: "active" | "transition" | "completed" | "disabled" | "stale";
    available: number; total: number; syncedAt: number; expiresAt: number; nextDueAt?: number };
  cardReportsSupported?: boolean;
  topicRecallSupported?: boolean;
  answerHistorySupported?: boolean; retainAnswers?: boolean; retainAnswersChangedAt?: number;
  answerHistoryWarning?: string;
  answerMistakes?: { cardId: string; question: string; answer: string; count: number; total: number }[];
  cardReports?: ReturnType<typeof companionCardReportViews>;
  launch?: { id: string; title: string; materialIds: string[]; mode?: "core" | "bank"; available: boolean; action?: CompanionPlanActionOptions; completed?: boolean; skipped?: boolean };
  defaults?: CompanionStudyContext["defaults"];
  catalog?: { id: string; materialId: string; mode: "core" | "bank"; kind: CompanionQuestionKind; count?: number; group?: string; sections?: string[];
    topics?: string[]; tags?: string[]; knowledgeState?: CompanionKnowledgeState; recallPrompt?: string }[];
  today?: { timeZone: string; generatedAt: number; expiresAt: number; rows: { id: string; title: string; startAt: number; completed: boolean; skipped: boolean; available: boolean; materialIds: string[]; mode?: "core" | "bank"; action?: CompanionPlanActionOptions; calendar?: CompanionStudyPlanOverviewEntry["calendar"] }[] };
  week?: MiniAppView["today"];
  summary?: { elapsedSeconds: number; completed: number; total: number; answers: number; skipped: number; unavailable: number;
    grades: { again: number; hard: number; good: number; easy: number }; correctness: { correct: number; incorrect: number; unchecked: number }; reason?: "completed" | "time-limit" | "manual" | "inactive" | "expired" };
  weakRetry?: { available: boolean; cardCount: number; materialIds: string[] };
  materials: { id: string; title: string; count: number; mode?: "core" | "bank" }[];
  session?: { id: string; completed: number; total: number; answers: number; skipped: number; waitUntil?: number; canContinueEarly?: boolean; idleExpiresAt?: number; mode?: "core" | "bank"; startedAt?: number; deadlineAt?: number; pausedAt?: number; pausedDurationMs?: number; cardLimit?: number; timeLimitMinutes?: number };
  nextStep?: { kind: "card" | "material" | "waiting" | "finished"; materialTitle?: string };
  card?: {
    id: string; revision: string; materialTitle: string; question: string; kind: "single" | "multiple" | "cloze" | "matching" | "ordering" | "exact" | "self";
    options?: string[]; blankCount?: number; matching?: { left: string[]; right: string[] }; orderItems?: string[]; questionMedia: CompanionMediaAttachment[];
    hints: string[]; totalHints: number;
    result?: { reference: string; matched?: boolean; feedback?: CompanionExerciseFeedback; correctOptionIndexes?: number[]; expectedBlanks?: string[]; correctMatches?: number[]; correctOrder?: number[]; answerMedia: CompanionMediaAttachment[];
      recalledText?: string; selfCheckCriteria?: string[]; checkedCriteria?: number[] };
    allowedRatings: (1 | 2 | 3 | 4)[]; selectedRating?: 1 | 2 | 3 | 4; attemptId?: string; canChangeGrade: boolean;
    source?: CompanionSourceContext;
  };
  history: { attemptId: string; cardId: string; question: string; rating: 1 | 2 | 3 | 4; syncStatus: string; canChangeGrade: boolean; allowedRatings: (1 | 2 | 3 | 4)[];
    recall?: { answer: string; reference: string; criteria?: string[]; checkedCriteria?: number[] }; answerEvidence?: AnswerHistoryEvidence }[];
}
export interface MiniAppStudy {
  session: CompanionStudySession; revision: number; revealed: boolean; hintCount: number;
  answerMatch?: boolean; feedback?: CompanionExerciseFeedback; currentAttemptId?: string;
  selfRecall?: { answer: string; criteria?: string[] };
  retainedAnswer?: string; answerDigest?: string;
  earlyRepeat?: true;
  /** Private occurrence presentation; never send canonical indexes to the browser. */
  arrangement?: { kind: "matching" | "ordering"; positions: number[] };
  startedAt?: number; lastActivityAt?: number; deadlineAt?: number; pausedAt?: number; pausedDurationMs?: number; finishedAt?: number; finishReason?: "completed" | "time-limit" | "manual" | "inactive" | "expired"; skipCount?: number;
  options?: { cardLimit?: number; timeLimitMinutes?: number; shuffle?: boolean; learningGroup?: string; questionKind?: CompanionQuestionKind; section?: string;
    topic?: string; tag?: string; knowledgeState?: CompanionKnowledgeState };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const opaque = (): string => randomBytes(24).toString("base64url");
const ratings = [1, 2, 3, 4] as const;
export const MINIAPP_STUDY_IDLE_MS = 30 * 60000;
const idleExpiresAt = (app: MiniAppStudy): number => (app.lastActivityAt ?? app.startedAt ?? app.session.snapshot.generatedAt) + MINIAPP_STUDY_IDLE_MS;
const attempts = (s: ServerState): ReviewAttempt[] => [...s.domain.pending, ...s.domain.outcomes.map(row => row.attempt)];
const authored = (card: SelectedCard): string => canonical(Object.fromEntries(Object.entries(card).filter(([key]) => !["revision", "dueAt", "offline", "eligible"].includes(key))));
const cardSourceMatches = (s: ServerState, card: SelectedCard): boolean => {
  const source = s.domain.snapshot && snapshotCardMap(s.domain.snapshot).get(card.id);
  if (source) return source.eligible && (source === card || authored(source) === authored(card)) && (card.offline !== undefined || source.revision === card.revision);
  return !!s.miniApp?.session.results.some(row => row.card?.id === card.id && row.card.revision === card.revision && authored(row.card) === authored(card));
};
const cardSourceAllowed = (s: ServerState, card: SelectedCard, now: number, permitted?: ReadonlySet<string>): boolean => {
  return !s.domain.revoked && !!s.domain.snapshot && companionSnapshotIsCurrent(s.domain.snapshot, now) && cardSourceMatches(s, card)
    && (permitted ? permitted.has(card.materialId) : s.materialConsentIds?.includes(card.materialId) ?? false)
    && (s.attachmentConsent !== false || !card.hints?.length && !card.media?.length)
    && (!card.offline || s.offlineConsent === true && now < (snapshotCardMap(s.domain.snapshot).get(card.id)?.offline === card.offline
      ? snapshotOfflineSeed(s.domain.snapshot, card.id)! : decodeOfflineSeed(card.offline)).expiresAt);
};
const cardIsDue = (card: SelectedCard, now: number): boolean => card.mode !== "core" || card.dueAt === undefined || card.dueAt <= now;
export function miniAppSessionAllowed(s: ServerState, now: number): boolean {
  const app = s.miniApp;
  return !!app && (!app.earlyRepeat || s.domain.snapshot?.earlyShortRepeats === true) && now < app.session.snapshot.expiresAt && app.session.snapshot.cards.every(card => cardSourceAllowed(s, card, now));
}
export function miniAppViewToken(s: ServerState): string {
  const app = s.miniApp, snapshot = s.domain.snapshot;
  const head = app?.session.current?.offline ? s.offlineHeads?.find(row => row.cardId === app.session.current!.id) : undefined;
  // A renewed catalog or an acknowledged past answer does not change the active question.
  const source = app && ["active", "paused"].includes(app.session.status)
    ? { cards: app.session.snapshot.cards.map(card => [card.id, cardSourceMatches(s, card)]),
      currentOffline: head ? [head.seed, head.state, head.lastAttemptId ?? null] : null }
    : { sequence: snapshot?.sequence, filters: s.studyContext ? studyContextToken(s.studyContext) : null,
      ...(snapshot?.studyTarget ? { studyTarget: snapshot.studyTarget } : {}) };
  return digest({ snapshot: snapshot ? [snapshot.scope, snapshot.epoch, source] : null,
    app: app ? [app.session.id, app.revision] : null, revoked: s.domain.revoked,
    chat: s.studySession && s.studySession.status !== "finished" ? [s.studySession.id, s.studySession.status, s.studySession.current?.id ?? null,
      s.studySession.waitUntil ?? null, s.studySession.results.map(row => row.attemptId)] : null,
    consent: [s.materialConsentIds ?? null, s.attachmentConsent ?? null, s.offlineConsent ?? null, snapshot?.earlyShortRepeats ?? null], retention: [s.retainAnswers ?? null, s.retainAnswersChangedAt ?? 0] });
}
function validateStartSelection(request: { materialId?: unknown; materialIds?: unknown; allMaterials?: unknown; retryWeak?: unknown; mode?: unknown; topicRecallCardId?: unknown }): void {
  if (request.topicRecallCardId !== undefined) {
    token(request.topicRecallCardId);
    invalid(request.mode === "bank" && request.retryWeak === undefined && request.allMaterials === undefined
      && (request.materialId !== undefined || Array.isArray(request.materialIds) && request.materialIds.length === 1), "Choose one material for topic recall");
  }
  if (request.retryWeak !== undefined) { invalid(request.retryWeak === true && request.mode === "bank" && [request.materialId, request.materialIds, request.allMaterials].every(value => value === undefined), "Weak retry must stay inside the previous Bank session"); return; }
  invalid([request.materialId, request.materialIds, request.allMaterials].filter(value => value !== undefined).length === 1, "Choose materials or explicitly choose all materials");
  if (request.materialId !== undefined) token(request.materialId);
  if (request.materialIds !== undefined) {
    invalid(Array.isArray(request.materialIds) && request.materialIds.length > 0 && new Set(request.materialIds).size === request.materialIds.length);
    request.materialIds.forEach(token);
  }
  if (request.allMaterials !== undefined) invalid(request.allMaterials === true);
}
function validateSessionOptions(value: { cardLimit?: unknown; timeLimitMinutes?: unknown; shuffle?: unknown; learningGroup?: unknown; questionKind?: unknown; section?: unknown;
  topic?: unknown; tag?: unknown; knowledgeState?: unknown }, maximumMinutes = 180): void {
  for (const [limit, max] of [[value.cardLimit, 1000], [value.timeLimitMinutes, maximumMinutes]]) invalid(limit === undefined || Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= Number(max));
  invalid(value.shuffle === undefined || typeof value.shuffle === "boolean");
  for (const label of [value.learningGroup, value.section, value.tag]) invalid(label === undefined || typeof label === "string" && !!label.trim() && label.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(label));
  invalid(value.topic === undefined || typeof value.topic === "string" && !!value.topic.trim() && value.topic.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(value.topic));
  invalid(value.questionKind === undefined || ["free", "single", "multiple", "cloze", "matching", "ordering"].includes(String(value.questionKind)));
  invalid(value.knowledgeState === undefined || COMPANION_KNOWLEDGE_STATES.includes(value.knowledgeState as CompanionKnowledgeState));
}
function arrangeCard(card: SelectedCard): MiniAppStudy["arrangement"] {
  const exercise = card.exercise;
  if (!exercise || exercise.kind !== "matching" && exercise.kind !== "ordering") return;
  const positions = Array.from({ length: exercise.kind === "matching" ? exercise.pairs.length : exercise.orderItems.length }, (_, index) => index);
  for (let index = positions.length - 1; index > 0; index--) { const target = randomInt(index + 1); [positions[index], positions[target]] = [positions[target], positions[index]]; }
  if (positions.every((value, index) => value === index)) positions.push(positions.shift()!);
  return { kind: exercise.kind, positions };
}
export function validateMiniAppRequest(value: unknown): asserts value is MiniAppRequest {
  record(value);
  if (value.kind === "view" || value.kind === "today") { keys(value, ["kind", "answerHistoryVersion"]); invalid(value.answerHistoryVersion === undefined || value.answerHistoryVersion === 1); return; }
  if (value.kind === "report-card") {
    keys(value, ["kind", "requestId", "viewToken", "reason", "note"]); token(value.requestId);
    invalid(typeof value.viewToken === "string" && /^[a-f0-9]{64}$/.test(value.viewToken));
    normalizeCardClarification({ ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.note === undefined ? {} : { note: value.note }) }); return;
  }
  if (value.kind === "plan") { keys(value, ["kind", "id", "answerHistoryVersion"]); invalid(value.answerHistoryVersion === undefined || value.answerHistoryVersion === 1); invalid(typeof value.id === "string" && value.id.length === 64 && /^[a-f0-9]{64}$/.test(value.id)); return; }
  if (value.kind === "plan-action") {
    keys(value, ["kind", "requestId", "viewToken", "id", "revision", "action", "date", "time", "durationMinutes"]);
    invalid(typeof value.viewToken === "string" && /^[a-f0-9]{64}$/.test(value.viewToken));
    const { kind: _kind, requestId, viewToken: _viewToken, id, ...fields } = value;
    validateCompanionPlanCommand({ ...fields, id: requestId, entryId: id, scope: "request", epoch: "request", requestedAt: 0 }); return;
  }
  if (value.kind === "finish-chat") {
    keys(value, ["kind", "requestId", "viewToken", "chatSessionId"]); token(value.requestId); token(value.chatSessionId);
    invalid(typeof value.viewToken === "string" && /^[a-f0-9]{64}$/.test(value.viewToken)); return;
  }
  invalid(["start", "hint", "check", "reveal", "self-recall", "grade", "next", "skip", "finish", "change-grade", "pause", "resume", "answer-retention"].includes(String(value.kind)));
  const fields = value.kind === "start" ? ["materialId", "materialIds", "allMaterials", "shuffle", "mode", "cardLimit", "timeLimitMinutes", "retryWeak", "learningGroup", "questionKind", "section", "topic", "tag", "knowledgeState", "topicRecallCardId", "planId"] : value.kind === "check" ? ["response"] : value.kind === "self-recall" ? ["text"] : value.kind === "grade" ? ["rating", "advance", "checkedCriteria", "text", "response"] : value.kind === "next" ? ["early"] : value.kind === "change-grade" ? ["rating", "attemptId"] : value.kind === "answer-retention" ? ["enabled"] : [];
  keys(value, ["kind", "requestId", "viewToken", ...fields]); token(value.requestId);
  invalid(typeof value.viewToken === "string" && /^[a-f0-9]{64}$/.test(value.viewToken));
  if (value.kind === "start") { validateStartSelection(value); validateSessionOptions(value, 90); }
  if (value.planId !== undefined) invalid(typeof value.planId === "string" && /^[a-f0-9]{64}$/.test(value.planId));
  if (value.shuffle !== undefined) invalid(typeof value.shuffle === "boolean");
  if (value.mode !== undefined) invalid(value.mode === "core" || value.mode === "bank");
  if (value.advance !== undefined) invalid(typeof value.advance === "boolean");
  if (value.early !== undefined) invalid(value.early === true);
  if (value.kind === "answer-retention") invalid(typeof value.enabled === "boolean");
  if (value.kind === "grade" || value.kind === "change-grade") invalid(ratings.includes(value.rating as 1));
  if (value.kind === "change-grade") token(value.attemptId);
  if ((value.kind === "self-recall" || value.kind === "grade") && value.text !== undefined) validateCompanionWrittenAnswer(value.text);
  if (value.kind === "grade" && value.checkedCriteria !== undefined) validateCompanionCheckedCriteria(value.checkedCriteria);
  if (value.kind === "check" || value.kind === "grade" && value.response !== undefined) {
    record(value.response); keys(value.response, ["text", "selectedOptionIndexes", "clozeAnswers", "matches", "order"]);
    const r = value.response;
    if (r.text !== undefined) invalid(typeof r.text === "string" && r.text.length <= 2000);
    if (r.selectedOptionIndexes !== undefined) invalid(Array.isArray(r.selectedOptionIndexes) && (value.kind === "grade" || r.selectedOptionIndexes.length > 0) && r.selectedOptionIndexes.length <= 12
      && r.selectedOptionIndexes.every((index, i, rows) => Number.isSafeInteger(index) && index >= 0 && index < 12 && (i === 0 || rows[i - 1] < index)));
    if (r.clozeAnswers !== undefined) invalid(Array.isArray(r.clozeAnswers) && (value.kind === "grade" || r.clozeAnswers.length > 0) && r.clozeAnswers.length <= 12 && r.clozeAnswers.every(answer => typeof answer === "string" && answer.length <= 2000));
    for (const [key, indexes] of [["matches", r.matches], ["order", r.order]] as const) if (indexes !== undefined) invalid(Array.isArray(indexes) && indexes.length >= 2 && indexes.length <= 12
      && indexes.every(index => Number.isSafeInteger(index) && index >= (value.kind === "grade" && key === "matches" ? -1 : 0) && index < indexes.length)
      && (value.kind === "grade" && key === "matches" || new Set(indexes).size === indexes.length));
  }
}
export function validateMiniAppState(s: ServerState): void {
  if (s.miniAppReceipts !== undefined) {
    invalid(Array.isArray(s.miniAppReceipts) && new Set(s.miniAppReceipts.map(row => row.id)).size === s.miniAppReceipts.length);
    for (const row of s.miniAppReceipts) { record(row); keys(row, ["id", "hash"]); token(row.id); invalid(typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash)); }
  }
  if (!s.miniApp) return;
  const app = s.miniApp; record(app); keys(app, ["session", "revision", "revealed", "hintCount", "answerMatch", "feedback", "currentAttemptId", "selfRecall", "retainedAnswer", "answerDigest", "earlyRepeat", "arrangement", "startedAt", "lastActivityAt", "deadlineAt", "pausedAt", "pausedDurationMs", "finishedAt", "finishReason", "skipCount", "options"]);
  if (app.retainedAnswer !== undefined) invalid(s.retainAnswers === true && typeof app.retainedAnswer === "string" && app.retainedAnswer.length <= 30000 && app.answerMatch === false
    && app.answerDigest === digest({ answer: app.retainedAnswer }));
  if (app.answerDigest !== undefined) invalid(typeof app.answerDigest === "string" && /^[a-f0-9]{64}$/.test(app.answerDigest) && app.revealed);
  if (app.startedAt !== undefined) timestamp(app.startedAt);
  if (app.lastActivityAt !== undefined) { timestamp(app.lastActivityAt); invalid(app.startedAt !== undefined && app.lastActivityAt >= app.startedAt && (app.finishedAt === undefined || app.lastActivityAt <= app.finishedAt)); }
  if (app.pausedDurationMs !== undefined) invalid(Number.isSafeInteger(app.pausedDurationMs) && app.pausedDurationMs >= 0 && app.startedAt !== undefined);
  if (app.pausedAt !== undefined) { timestamp(app.pausedAt); invalid(app.startedAt !== undefined && app.pausedAt >= app.startedAt && app.session.status === "paused"); }
  invalid(app.session.status !== "paused" || app.pausedAt !== undefined);
  if (app.options !== undefined) { record(app.options); keys(app.options, ["cardLimit", "timeLimitMinutes", "shuffle", "learningGroup", "questionKind", "section", "topic", "tag", "knowledgeState"]); validateSessionOptions(app.options); invalid(app.startedAt !== undefined); }
  if (app.deadlineAt !== undefined) { timestamp(app.deadlineAt); invalid(app.startedAt !== undefined && app.options?.timeLimitMinutes !== undefined && app.deadlineAt === app.startedAt + app.options.timeLimitMinutes * 60000 + (app.pausedDurationMs ?? 0)); }
  invalid(app.options?.timeLimitMinutes === undefined || app.deadlineAt !== undefined);
  if (app.finishedAt !== undefined) { timestamp(app.finishedAt); invalid(app.startedAt !== undefined && app.finishedAt >= app.startedAt && app.session.status === "finished"); }
  invalid(app.finishReason === undefined || app.finishedAt !== undefined && ["completed", "time-limit", "manual", "inactive", "expired"].includes(app.finishReason));
  if (app.skipCount !== undefined) invalid(Number.isSafeInteger(app.skipCount) && app.skipCount >= (app.session.deferred?.length ?? 0));
  timestamp(app.revision); invalid(typeof app.revealed === "boolean" && Number.isSafeInteger(app.hintCount) && app.hintCount >= 0 && app.hintCount <= 10);
  invalid(app.answerMatch === undefined || typeof app.answerMatch === "boolean");
  const session = app.session; record(session); keys(session, ["id", "snapshot", "status", "results", "skipped", "deferred", "current", "frames", "waitUntil", "mode"]);
  token(session.id); validateSnapshot(session.snapshot); invalid(session.snapshot.cards.length <= 1000, "session card limit"); invalid(session.snapshot.scope === s.domain.snapshot?.scope && session.snapshot.epoch === s.domain.snapshot?.epoch);
  invalid(session.mode === undefined || (session.mode === "core" || session.mode === "bank") && session.snapshot.cards.every(card => card.mode === session.mode));
  invalid(["active", "paused", "finished"].includes(session.status) && Array.isArray(session.results) && session.results.length <= 1000 && Array.isArray(session.skipped));
  invalid(session.deferred === undefined || Array.isArray(session.deferred));
  invalid(app.options?.cardLimit === undefined || session.snapshot.cards.length <= app.options.cardLimit);
  invalid(new Set(session.results.map(row => row.attemptId)).size === session.results.length && new Set([...session.skipped, ...(session.deferred ?? [])]).size === session.skipped.length + (session.deferred?.length ?? 0));
  const history = attempts(s);
  const ancestors = [...history, ...(s.supersededOfflineReviews ?? []).map(row => row.attempt)];
  const validateFrame = (card: SelectedCard): string | undefined => {
    validateSessionFrame(card, session.snapshot); if (!card.offline) return;
    const seed = decodeOfflineSeed(card.offline), parent = ancestors.find(row => row.id === card.revision && row.cardId === card.id && row.offline);
    const previous = parent?.offline && decodeOfflineStep(parent.offline);
    const state = card.revision === seed.rootRevision ? seed.state : previous && previous.rootRevision === seed.rootRevision ? previous.after : undefined;
    invalid(state && card.dueAt === offlineStateDue(state), "Mini App offline occurrence differs"); return state;
  };
  invalid(new Set(session.results.filter(row => !row.card?.offline).map(row => row.cardId)).size === session.results.filter(row => !row.card?.offline).length);
  for (const row of session.results) { record(row); keys(row, ["cardId", "attemptId", "card"]); token(row.cardId); token(row.attemptId);
    invalid(row.card && row.card.id === row.cardId); const before = validateFrame(row.card);
    const attempt = history.find(attempt => attempt.id === row.attemptId && attempt.cardId === row.cardId && attempt.revision === row.card!.revision); invalid(attempt);
    if (row.card.offline) invalid(attempt.offline && decodeOfflineStep(attempt.offline).before === before); }
  const currentState = session.current && validateFrame(session.current);
  if (session.current) invalid(app.hintCount <= (session.current.hints?.length ?? 0));
  if (app.earlyRepeat !== undefined) invalid(app.earlyRepeat === true && session.current?.offline && currentState && stateIsShortStep(currentState)
    && session.current.revision !== decodeOfflineSeed(session.current.offline).rootRevision, "Early repeat needs an in-session short step");
  const exercise = session.current?.exercise;
  if (exercise?.kind === "matching" || exercise?.kind === "ordering") {
    record(app.arrangement); keys(app.arrangement, ["kind", "positions"]);
    const count = exercise.kind === "matching" ? exercise.pairs.length : exercise.orderItems.length, positions = app.arrangement.positions;
    invalid(app.arrangement.kind === exercise.kind && Array.isArray(positions) && positions.length === count
      && Array.from(positions).every(value => Number.isSafeInteger(value) && value >= 0 && value < count) && new Set(positions).size === count);
  } else invalid(app.arrangement === undefined);
  if (session.frames !== undefined) { invalid(Array.isArray(session.frames) && session.frames.length <= 1001); session.frames.forEach(validateFrame); }
  for (const id of [...session.skipped, ...(session.deferred ?? [])]) { token(id); invalid(session.snapshot.cards.some(card => card.id === id)); }
  if (session.waitUntil !== undefined) timestamp(session.waitUntil);
  if (app.currentAttemptId !== undefined) { token(app.currentAttemptId); invalid(app.revealed && session.current && session.results.some(row => row.attemptId === app.currentAttemptId && row.cardId === session.current!.id && row.card!.revision === session.current!.revision)); }
  if (app.selfRecall !== undefined) {
    record(app.selfRecall); keys(app.selfRecall, ["answer", "criteria"]); validateCompanionWrittenAnswer(app.selfRecall.answer);
    if (app.selfRecall.criteria !== undefined) validateCompanionSelfCheckCriteria(app.selfRecall.criteria);
    invalid(app.revealed && session.current && !session.current.exercise && session.current.evaluationMode === undefined && app.answerMatch === undefined);
    if (app.currentAttemptId) { const saved = writtenRecallForAttempt(s, app.currentAttemptId); invalid(!app.selfRecall.answer.trim() || saved || answerHistoryForAttempt(s, app.currentAttemptId));
      if (saved) invalid(saved.answer === app.selfRecall.answer && canonical(saved.criteria ?? []) === canonical(app.selfRecall.criteria ?? [])); }
  }
  invalid(app.revealed || app.answerMatch === undefined && app.feedback === undefined && app.currentAttemptId === undefined);
  if (app.feedback !== undefined) { invalid(session.current?.exercise && typeof app.answerMatch === "boolean"); validateCompanionExerciseFeedback(app.feedback, session.current.exercise); invalid(feedbackMatchesAnswer(session.current.exercise, app.feedback) === app.answerMatch); }
}

/** One event path for chat and Mini App; presentation must not change review semantics. */
export function appendCompanionReview(s: ServerState, card: SelectedCard, id: string, rating: ReviewAttempt["rating"], correct: boolean, now: number, early = false): ReviewAttempt {
  const snapshot = s.domain.snapshot; invalid(snapshot && companionSnapshotIsCurrent(snapshot, now));
  invalid(!attempts(s).some(row => row.id === id));
  const attempt: ReviewAttempt = { id, scope: snapshot.scope, epoch: snapshot.epoch, sequence: snapshot.sequence, cardId: card.id, revision: card.revision, mode: card.mode, occurredAt: now, rating, correct };
  if (card.offline) {
    const head = ensureOfflineHead(s.offlineHeads ??= [], snapshot, card.id);
    invalid(head && s.offlineConsent === true && card.revision === (head.lastAttemptId ?? decodeOfflineSeed(head.seed).rootRevision) && now < decodeOfflineSeed(head.seed).expiresAt);
    const earlyStep = early && card.dueAt! > now;
    const after = advanceOfflineFsrs(head.seed, head.state, correct ? rating : 1, now);
    const step = { version: 1 as const, rootRevision: decodeOfflineSeed(head.seed).rootRevision, index: head.index + 1,
      ...(head.lastAttemptId ? { parentId: head.lastAttemptId } : {}), before: head.state, after, ...(earlyStep ? { early: true as const } : {}) };
    invalid(offlineReviewTimeAllowed(step, now), "Offline review is not due"); attempt.offline = encodeOfflineStep(step);
    head.state = after; head.index++; head.lastAttemptId = attempt.id;
  }
  validateAttempt(attempt); s.domain.pending.push(attempt); return attempt;
}

function resultAttempt(s: ServerState, id: string): ReviewAttempt | undefined {
  const attempt = attempts(s).find(row => row.id === id); if (!attempt) return;
  const correction = [...(s.gradeCorrections ?? [])].reverse().find(row => row.correction.attemptId === id && row.receipt?.status === "applied");
  return correction ? { ...attempt, rating: correction.correction.rating, correct: correction.correction.correct } : attempt;
}
function visibleResult(s: ServerState, id: string): { attempt: ReviewAttempt; syncStatus: string } {
  const attempt = resultAttempt(s, id); invalid(attempt);
  const latest = [...(s.gradeCorrections ?? [])].reverse().find(row => row.correction.attemptId === id);
  if (latest && !latest.receipt) return { attempt: { ...attempt, rating: latest.correction.rating, correct: latest.correction.correct }, syncStatus: "correcting" };
  if (latest && latest.receipt?.status !== "applied") return { attempt, syncStatus: "correction-rejected" };
  return { attempt, syncStatus: s.domain.pending.some(row => row.id === id) ? s.claimedAttempts?.includes(id) ? "syncing" : "pending"
    : s.domain.outcomes.find(row => row.attempt.id === id)?.status ?? "missing" };
}
function canChangeGrade(s: ServerState, id: string, now: number): boolean {
  if (s.miniApp?.session.status === "paused") return false;
  const attempt = resultAttempt(s, id); if (!attempt || s.gradeCorrections?.some(row => row.correction.attemptId === id && !row.receipt)) return false;
  if (attempt.offline && s.offlineHeads?.find(head => head.cardId === attempt.cardId)?.lastAttemptId !== id) return false;
  return s.domain.pending.some(row => row.id === id) ? !s.claimedAttempts?.includes(id) : !!s.editableGrades?.some(row => row.attemptId === id && now < row.expiresAt);
}
function weakBankCards(s: ServerState, effective: CompanionSnapshot, now: number): SelectedCard[] {
  const session = s.miniApp?.session;
  if (!session || session.status !== "finished" || !session.snapshot.cards.length || session.snapshot.cards.some(card => card.mode !== "bank")) return [];
  const weak = new Set(session.results.filter(row => visibleResult(s, row.attemptId).attempt.rating <= 2).map(row => row.cardId));
  const cards = snapshotCardMap(effective);
  return session.snapshot.cards.flatMap(original => {
    const current = cards.get(original.id);
    return weak.has(original.id) && current?.mode === "bank" && current.eligible && authored(current) === authored(original) && cardSourceAllowed(s, current, now) ? [current] : [];
  });
}
function sessionSummary(s: ServerState, now: number): MiniAppView["summary"] {
  const app = s.miniApp!; if (app.startedAt === undefined) return;
  const session = app.session, grades = { again: 0, hard: 0, good: 0, easy: 0 }, correctness = { correct: 0, incorrect: 0, unchecked: 0 };
  for (const row of session.results) {
    const rating = visibleResult(s, row.attemptId).attempt.rating; grades[(["again", "hard", "good", "easy"] as const)[rating - 1]]++;
    const checked = s.miniAppAttempts?.find(attempt => attempt.id === row.attemptId)?.answerMatch;
    correctness[checked === true ? "correct" : checked === false ? "incorrect" : "unchecked"]++;
  }
  return { elapsedSeconds: Math.max(0, Math.floor(((app.finishedAt ?? app.pausedAt ?? now) - app.startedAt - (app.pausedDurationMs ?? 0)) / 1000)), completed: new Set(session.results.map(row => row.cardId)).size,
    total: session.snapshot.cards.length, answers: session.results.length, skipped: app.skipCount ?? session.deferred?.length ?? 0, unavailable: session.skipped.length,
    grades, correctness, ...(app.finishReason ? { reason: app.finishReason } : {}) };
}
function finishedSessionView(view: MiniAppView, s: ServerState, now: number): MiniAppView {
  const app = s.miniApp!, session = app.session;
  view.status = "finished"; view.summary = sessionSummary(s, now);
  view.session = { id: session.id, completed: new Set(session.results.map(row => row.cardId)).size, total: session.snapshot.cards.length,
    answers: session.results.length, skipped: (session.deferred?.length ?? 0) + session.skipped.length, ...(session.mode ? { mode: session.mode } : {}) };
  return view;
}
/** Goal counts use the current permitted learning copy, including projected offline review heads. */
export function miniAppStudyTargetCards(s: ServerState, effective: CompanionSnapshot | undefined, now: number): SelectedCard[] {
  const target = s.domain.snapshot?.studyTarget;
  if (!target || !effective || s.domain.revoked || !companionSnapshotIsCurrent(effective, now)) return [];
  const ids = new Set(target.cardIds), permitted = new Set(s.materialConsentIds);
  return effective.cards.filter(card => ids.has(card.id) && card.mode === "core" && card.eligible && cardSourceAllowed(s, card, now, permitted));
}
export function miniAppStudyTargetView(s: ServerState, effective: CompanionSnapshot | undefined, suppressed: ReviewAttempt[], now: number): MiniAppView["studyTarget"] {
  const snapshot = s.domain.snapshot, target = snapshot?.studyTarget;
  if (!snapshot || !target || s.domain.revoked) return;
  const status: NonNullable<MiniAppView["studyTarget"]>["status"] = !effective || !companionSnapshotIsCurrent(snapshot, now) ? "stale"
    : !target.enabled ? "disabled" : now < target.examEndAt ? "active" : now < target.transitionEndAt ? "transition" : "completed";
  const cards = miniAppStudyTargetCards(s, effective, now), active = status === "active" || status === "transition";
  const blocked = new Set(suppressed.filter(row => row.mode === "core").map(row => row.cardId));
  const nextDueAt = cards.reduce<number | undefined>((next, card) => card.dueAt !== undefined && card.dueAt > now
    ? Math.min(next ?? card.dueAt, card.dueAt) : next, undefined);
  return { id: target.id, targetDate: target.targetDate, timeZone: target.timeZone, status,
    available: active ? cards.filter(card => cardIsDue(card, now) && !blocked.has(card.id)).length : 0, total: cards.length,
    syncedAt: snapshot.generatedAt, expiresAt: snapshot.expiresAt,
    ...(active && nextDueAt !== undefined ? { nextDueAt } : {}) };
}
export function miniAppView(s: ServerState, effective: CompanionSnapshot | undefined, suppressed: ReviewAttempt[], now: number): MiniAppView {
  const effectiveCards = effective && snapshotCardMap(effective);
  suppressed = suppressed.filter(attempt => attempt.mode === "core" && effectiveCards?.get(attempt.cardId)?.mode === "core");
  const view: MiniAppView = { status: "unavailable", serverNow: now, viewToken: miniAppViewToken(s), materials: [], history: [], answerHistorySupported: true,
    retainAnswers: s.retainAnswers === true, retainAnswersChangedAt: s.retainAnswersChangedAt ?? 0 };
  const studyTarget = miniAppStudyTargetView(s, effective, suppressed, now); if (studyTarget) view.studyTarget = studyTarget;
  if (s.domain.revoked || !effective || !companionSnapshotIsCurrent(effective, now)) return s.miniApp?.session.status === "finished" ? finishedSessionView(view, s, now) : view;
  view.sync = { generatedAt: effective.generatedAt, pendingAnswers: s.domain.pending.length }; view.topicRecallSupported = true;
  if (s.cardReportsEnabled) { view.cardReportsSupported = true; view.cardReports = companionCardReportViews(s, effective.cards); }
  const permittedMaterials = new Set(s.materialConsentIds);
  const available = effective.cards.filter(card => cardSourceAllowed(s, card, now, permittedMaterials) && cardIsDue(card, now));
  const page = queryCards({ ...effective, cards: available }, suppressed, { now, all: true });
  const materialCounts = new Map<string, MiniAppView["materials"][number]>();
  for (const card of page.cards) {
    const key = `${card.materialId}:${card.mode}`, row = materialCounts.get(key);
    if (row) row.count++; else materialCounts.set(key, { id: card.materialId, title: card.materialTitle, count: 1, mode: card.mode });
  }
  view.materials = page.materials.flatMap(id => (["core", "bank"] as const).flatMap(mode => { const row = materialCounts.get(`${id}:${mode}`); return row ? [row] : []; }));
  if (s.studyContext) view.defaults = copy(s.studyContext.defaults);
  const includeTopicPrompts = !s.miniApp || s.miniApp.session.status === "finished" || !miniAppSessionAllowed(s, now);
  const sessionAttempts = includeTopicPrompts ? undefined : new Set(s.miniApp!.session.results.map(row => row.attemptId));
  const historyRecords = new Map(answerHistoryRecords(s, sessionAttempts).map(row => [row.attempt.id, row]));
  if (includeTopicPrompts) {
    const allowedMaterials = new Set(s.materialConsentIds), materialIds = new Map(effective.cards.map(card => [card.id, card.materialId]));
    const evidence = [...historyRecords.values()].filter(row => allowedMaterials.has(materialIds.get(row.evidence.cardId) ?? "")).map(row => row.evidence);
    view.answerMistakes = aggregateWrongAnswerEvidence(evidence).filter(row => row.count > 1).slice(0, 10).map(row => ({ cardId: row.cardId,
      question: row.question.slice(0, 300), answer: row.answer.slice(0, 300), count: row.count,
      total: evidence.filter(item => item.cardId === row.cardId && item.answerMatch !== null && answerHistoryReferenceId(item) === row.referenceId).length }));
  }
  const metadataById = s.studyContext && studyContextCardMap(s.studyContext), catalog = new Map<string, NonNullable<MiniAppView["catalog"]>[number]>();
  for (const card of page.cards) { const metadata = metadataById?.get(card.id);
    const row: NonNullable<MiniAppView["catalog"]>[number] = { id: card.id, materialId: card.materialId, mode: card.mode, kind: metadata?.kind ?? card.exercise?.kind ?? "free", ...(metadata?.group ? { group: metadata.group } : {}), ...(metadata?.sections ? { sections: [...metadata.sections] } : {}),
      ...(metadata?.topics ? { topics: [...metadata.topics] } : {}), ...(metadata?.tags ? { tags: [...metadata.tags] } : {}),
      ...(metadata?.knowledgeState ? { knowledgeState: metadata.knowledgeState } : {}),
      ...(includeTopicPrompts && card.mode === "bank" && !card.exercise && card.evaluationMode === undefined ? { recallPrompt: card.question } : {}) };
    const { id: _id, ...group } = row, key = page.cards.length > 1000 && row.recallPrompt === undefined ? JSON.stringify(group) : card.id;
    const previous = catalog.get(key); if (previous) previous.count = (previous.count ?? 1) + 1; else catalog.set(key, row);
  }
  view.catalog = [...catalog.values()];
  if (s.studySession && s.studySession.status !== "finished" && now < s.studySession.snapshot.expiresAt) { view.status = "chat-active"; view.chatSessionId = s.studySession.id; return view; }
  const app = s.miniApp;
  if (!app) { view.status = "materials"; return view; }
  if (!miniAppSessionAllowed(s, now)) return app.session.status === "finished" ? finishedSessionView(view, s, now) : view;
  const session = app.session;
  view.session = { id: session.id, completed: new Set(session.results.map(row => row.cardId)).size, total: session.snapshot.cards.length, answers: session.results.length,
    skipped: (session.deferred?.length ?? 0) + session.skipped.length, ...(session.waitUntil === undefined ? {} : { waitUntil: session.waitUntil }), ...(session.mode === undefined ? {} : { mode: session.mode }),
    startedAt: app.startedAt ?? session.snapshot.generatedAt, ...(app.deadlineAt === undefined ? {} : { deadlineAt: app.deadlineAt }),
    ...(session.status === "finished" || session.status === "paused" ? {} : { idleExpiresAt: idleExpiresAt(app) }),
    ...(app.pausedAt === undefined ? {} : { pausedAt: app.pausedAt }), ...(app.pausedDurationMs === undefined ? {} : { pausedDurationMs: app.pausedDurationMs }),
    ...(app.options?.cardLimit === undefined ? {} : { cardLimit: app.options.cardLimit }), ...(app.options?.timeLimitMinutes === undefined ? {} : { timeLimitMinutes: app.options.timeLimitMinutes }) };
  view.history = session.results.map(row => { const { attempt: a, syncStatus } = visibleResult(s, row.attemptId), recall = writtenRecallForAttempt(s, a.id); return { attemptId: a.id, cardId: row.cardId, question: row.card!.question, rating: a.rating,
    syncStatus, canChangeGrade: canChangeGrade(s, a.id, now),
    allowedRatings: s.miniAppAttempts?.find(row => row.id === a.id)?.answerMatch === true ? [2, 3, 4] : [...ratings],
    ...(recall ? { recall: { answer: recall.answer, reference: recall.reference, ...(recall.criteria === undefined ? {} : { criteria: [...recall.criteria] }), ...(recall.checkedCriteria === undefined ? {} : { checkedCriteria: [...recall.checkedCriteria] }) } } : {}),
    ...(historyRecords.has(a.id) ? { answerEvidence: copy(historyRecords.get(a.id)!.evidence) } : {}) }; });
  view.summary = sessionSummary(s, now);
  if (session.status === "finished") { view.status = "finished";
    if (session.snapshot.cards.every(card => card.mode === "bank")) { const weak = weakBankCards(s, effective, now); view.weakRetry = { available: weak.length > 0, cardCount: weak.length, materialIds: [...new Set(weak.map(card => card.materialId))] }; }
    return view; }
  const card = session.current;
  if (!card) {
    view.status = app.pausedAt === undefined ? "waiting" : "paused";
    if (view.status === "waiting") { const next = nextSessionCard(s, effective, suppressed, now);
      view.session.waitUntil = next.waitUntil ?? now; view.session.canContinueEarly = next.waitUntil !== undefined && next.waitUntil > now
        && effective.earlyShortRepeats === true; }
    return view;
  }
  view.status = app.pausedAt !== undefined ? "paused" : app.revealed ? "result" : "question";
  const exercise = card.exercise, a = app.currentAttemptId ? visibleResult(s, app.currentAttemptId).attempt : undefined;
  const positions = app.arrangement?.positions;
  const feedback = app.feedback?.kind === "matching" ? { kind: "matching" as const, matches: app.feedback.matches.map(index => positions!.indexOf(index)) }
    : app.feedback?.kind === "ordering" ? { kind: "ordering" as const, order: app.feedback.order.map(index => positions!.indexOf(index)) } : app.feedback;
  view.card = { id: card.id, revision: card.revision, materialTitle: card.materialTitle,
    question: exercise?.kind === "cloze" ? companionExerciseQuestion(exercise, card.question) : card.question,
    kind: exercise?.kind ?? (card.evaluationMode === "exact" ? "exact" : "self"),
    ...(exercise?.kind === "single" || exercise?.kind === "multiple" ? { options: [...exercise.options] } : {}), ...(exercise?.kind === "cloze" ? { blankCount: companionExerciseBlankCount(exercise) } : {}),
    ...(exercise?.kind === "matching" ? { matching: { left: exercise.pairs.map(pair => pair.left), right: positions!.map(index => exercise.pairs[index].right) } } : {}),
    ...(exercise?.kind === "ordering" ? { orderItems: positions!.map(index => exercise.orderItems[index]) } : {}),
    questionMedia: copy((card.media ?? []).filter(asset => asset.side === "question")), hints: (card.hints ?? []).slice(0, app.hintCount), totalHints: card.hints?.length ?? 0,
    ...(app.revealed ? { result: { reference: card.reference, ...(app.answerMatch === undefined ? {} : { matched: app.answerMatch }), ...(feedback ? { feedback: copy(feedback) } : {}),
      ...(app.selfRecall ? { ...(s.retainAnswers === false ? {} : { recalledText: app.selfRecall.answer }), ...(app.selfRecall.criteria === undefined ? {} : { selfCheckCriteria: [...app.selfRecall.criteria] }),
        ...(a && writtenRecallForAttempt(s, a.id)?.checkedCriteria !== undefined ? { checkedCriteria: [...writtenRecallForAttempt(s, a.id)!.checkedCriteria!] } : {}) } : {}),
      ...(exercise?.kind === "cloze" ? { expectedBlanks: extractClozeAnswers(exercise.clozeTemplate) } : {}),
      ...(exercise?.kind === "single" || exercise?.kind === "multiple" ? { correctOptionIndexes: [...exercise.correctOptionIndexes] } : {}),
      ...(exercise?.kind === "matching" ? { correctMatches: exercise.pairs.map((_, index) => positions!.indexOf(index)) } : {}),
      ...(exercise?.kind === "ordering" ? { correctOrder: exercise.orderItems.map((_, index) => positions!.indexOf(index)) } : {}),
      answerMedia: copy((card.media ?? []).filter(asset => asset.side === "answer")) } } : {}),
    allowedRatings: app.revealed ? (app.answerMatch === true ? [2, 3, 4] : [...ratings]) : [], ...(a ? { selectedRating: a.rating, attemptId: a.id } : {}), canChangeGrade: !!a && canChangeGrade(s, a.id, now) };
  const source = app.revealed && s.studyContext?.sourceConsent && s.studyContext.cards.find(row => row.id === card.id)?.source;
  if (source) view.card.source = copy(source);
  if (a) {
    const next = nextSessionCard(s, effective, suppressed, now);
    view.nextStep = next.card ? next.card.materialId === card.materialId ? { kind: "card" } : { kind: "material", materialTitle: next.card.materialTitle }
      : { kind: next.waitUntil === undefined ? "finished" : "waiting" };
  }
  return view;
}

function nextSessionCard(s: ServerState, effective: CompanionSnapshot, suppressed: ReviewAttempt[], now: number, early = false): { card?: SelectedCard; early?: true; waitUntil?: number; skipped: string[] } {
  const session = s.miniApp!.session, available: SelectedCard[] = [], skipped: string[] = []; let waitingCard: SelectedCard | undefined;
  const byId = snapshotCardMap(effective), heads = new Map((s.offlineHeads ?? []).map(head => [head.cardId, head]));
  if (s.miniApp!.pausedAt === undefined && s.miniApp!.deadlineAt !== undefined && now >= s.miniApp!.deadlineAt!) return { skipped };
  for (const original of session.snapshot.cards) {
    const answered = session.results.some(row => row.cardId === original.id);
    if (!original.offline && answered || session.skipped.includes(original.id) || session.deferred?.includes(original.id)) continue;
    const candidate = byId.get(original.id), card = candidate?.eligible ? candidate : undefined, head = heads.get(original.id);
    if (!card || !cardSourceAllowed(s, card, now) || (!original.offline && canonical(original) !== canonical(card)) || original.offline && (!head || head.seed !== original.offline)
      || suppressed.some(row => row.cardId === original.id)) { skipped.push(original.id); continue; }
    if (head && answered && !stateIsShortStep(head.state)) continue;
    if (card.offline && card.dueAt! > now) {
      if (answered && head && head.index > 0 && stateIsShortStep(head.state) && (!waitingCard || card.dueAt! < waitingCard.dueAt!)) waitingCard = card;
      continue;
    }
    available.push(card);
  }
  available.sort((a, b) => Number(!!s.offlineHeads?.some(head => head.cardId === b.id && head.index > 0 && stateIsShortStep(head.state))) - Number(!!s.offlineHeads?.some(head => head.cardId === a.id && head.index > 0 && stateIsShortStep(head.state))));
  return session.results.length >= 1000 ? { skipped } : available.length ? { card: available[0], skipped }
    : waitingCard ? early ? { card: waitingCard, early: true, skipped } : { waitUntil: waitingCard.dueAt!, skipped } : { skipped };
}
function resumeClock(app: MiniAppStudy, now: number): void {
  if (app.pausedAt === undefined) return;
  const duration = Math.max(0, now - app.pausedAt); app.pausedDurationMs = (app.pausedDurationMs ?? 0) + duration;
  if (app.deadlineAt !== undefined) app.deadlineAt += duration;
  delete app.pausedAt;
}
function finishSession(app: MiniAppStudy, now: number, reason: NonNullable<MiniAppStudy["finishReason"]>): void {
  app.startedAt ??= Math.min(now, app.session.snapshot.generatedAt);
  resumeClock(app, now);
  app.session.status = "finished"; delete app.session.waitUntil;
  if (app.startedAt !== undefined && app.finishedAt === undefined) { app.finishedAt = Math.max(now, app.startedAt); app.finishReason = reason; }
}
/** Retire only the presentation session; queued reviews and FSRS ancestry remain intact. */
export function finishMiniAppSession(s: ServerState, now: number, reason: NonNullable<MiniAppStudy["finishReason"]> = "manual"): boolean {
  const app = s.miniApp; if (!app || app.session.status === "finished") return false;
  finishSession(app, now, reason); app.revision++; return true;
}
export function expireMiniAppSession(s: ServerState, now: number): boolean {
  const app = s.miniApp; if (!app || app.session.status === "finished") return false;
  const hardLimit = (app.startedAt ?? app.session.snapshot.generatedAt) + MINIAPP_SESSION_TTL_MS;
  const lessonLimit = app.pausedAt === undefined && app.deadlineAt !== undefined ? app.deadlineAt + MINIAPP_FINISH_GRACE_MS : hardLimit;
  const idleLimit = app.pausedAt === undefined ? idleExpiresAt(app) : Infinity, expiry = Math.min(hardLimit, lessonLimit, idleLimit);
  const allowed = miniAppSessionAllowed(s, now); if (allowed && now < expiry) return false;
  // Legacy sessions could already contain accepted actions after the new hard limit.
  let activityAt = Math.max(app.lastActivityAt ?? app.startedAt ?? 0, app.pausedAt ?? 0);
  const resultIds = new Set(app.session.results.map(row => row.attemptId));
  for (const attempt of attempts(s)) if (resultIds.has(attempt.id)) activityAt = Math.max(activityAt, attempt.occurredAt);
  const endedAt = Math.max(Math.min(now, expiry), activityAt);
  return finishMiniAppSession(s, endedAt, !allowed ? "expired" : expiry === idleLimit ? "inactive" : "time-limit");
}
export function finishMiniAppRequest(s: ServerState, request: { requestId: string; viewToken: string }, now: number): void {
  const hash = digest(request), prior = s.miniAppReceipts?.find(row => row.id === request.requestId);
  if (prior) { invalid(prior.hash === hash, "Mini App request collision"); return; }
  invalid(request.viewToken === miniAppViewToken(s), "stale Mini App view");
  invalid(s.miniApp, "Mini App session unavailable"); finishMiniAppSession(s, now);
  (s.miniAppReceipts ??= []).push({ id: request.requestId, hash });
}
function nextCard(s: ServerState, effective: CompanionSnapshot, suppressed: ReviewAttempt[], now: number, early = false): void {
  const app = s.miniApp!, session = app.session, next = nextSessionCard(s, effective, suppressed, now, early);
  delete session.current; delete session.waitUntil;
  app.revealed = false; app.hintCount = 0; delete app.answerMatch; delete app.feedback; delete app.currentAttemptId; delete app.arrangement; delete app.selfRecall; delete app.retainedAnswer; delete app.answerDigest; delete app.earlyRepeat;
  session.skipped.push(...next.skipped);
  if (next.card) { session.current = copy(next.card); if (next.early) app.earlyRepeat = true; const arrangement = arrangeCard(next.card); if (arrangement) app.arrangement = arrangement; }
  else if (next.waitUntil !== undefined) session.waitUntil = next.waitUntil;
  else finishSession(app, now, app.deadlineAt !== undefined && now >= app.deadlineAt ? "time-limit" : "completed");
}

/** Only private, server-owned state is mutated. No Telegram messages, handles or delivery receipts. */
function checkedResponse(card: SelectedCard, response: NonNullable<Extract<MiniAppRequest, { response?: unknown }>["response"]>, arrangement: MiniAppStudy["arrangement"]): { response: typeof response; answer: string } {
  const exercise = card.exercise;
  if (!exercise) { invalid(typeof response.text === "string" && !!response.text.trim() && response.selectedOptionIndexes === undefined && response.clozeAnswers === undefined && response.matches === undefined && response.order === undefined); return { response, answer: response.text }; }
  invalid(response.text === undefined);
  if (exercise.kind === "cloze") {
    invalid(response.selectedOptionIndexes === undefined && response.matches === undefined && response.order === undefined && response.clozeAnswers?.length === companionExerciseBlankCount(exercise) && response.clozeAnswers.every(text => !!text.trim()));
    return { response, answer: response.clozeAnswers.map((answer, index) => `${index + 1}. ${answer}`).join("\n") };
  }
  if (exercise.kind === "single" || exercise.kind === "multiple") {
    invalid(response.clozeAnswers === undefined && response.matches === undefined && response.order === undefined && response.selectedOptionIndexes && (exercise.kind !== "single" || response.selectedOptionIndexes.length === 1));
    evaluateCompanionExercise(exercise, response); return { response, answer: response.selectedOptionIndexes.map(index => exercise.options[index]).join("\n") };
  }
  invalid(response.clozeAnswers === undefined && response.selectedOptionIndexes === undefined && arrangement && arrangement.kind === exercise.kind);
  if (exercise.kind === "matching") {
    invalid(response.order === undefined && response.matches?.length === exercise.pairs.length);
    const canonicalResponse = { matches: response.matches.map(index => arrangement.positions[index]) }; evaluateCompanionExercise(exercise, canonicalResponse);
    return { response: canonicalResponse, answer: exercise.pairs.map((pair, index) => `${pair.left} → ${exercise.pairs[canonicalResponse.matches[index]].right}`).join("\n") };
  }
  invalid(response.matches === undefined && response.order?.length === exercise.orderItems.length);
  const canonicalResponse = { order: response.order.map(index => arrangement.positions[index]) }; evaluateCompanionExercise(exercise, canonicalResponse);
  return { response: canonicalResponse, answer: canonicalResponse.order.map((index, position) => `${position + 1}. ${exercise.orderItems[index]}`).join("\n") };
}
/** A revealed draft is evidence of what was entered, not an automatically checked answer. */
function uncheckedResponseAnswer(card: SelectedCard, response: NonNullable<Extract<MiniAppRequest, { response?: unknown }>["response"]>, arrangement: MiniAppStudy["arrangement"]): string | undefined {
  const exercise = card.exercise; invalid(exercise && response.text === undefined);
  if (exercise.kind === "cloze") {
    invalid(response.selectedOptionIndexes === undefined && response.matches === undefined && response.order === undefined && response.clozeAnswers
      && (response.clozeAnswers.length === 0 || response.clozeAnswers.length === companionExerciseBlankCount(exercise)));
    return response.clozeAnswers.some(answer => !!answer.trim()) ? response.clozeAnswers.map((answer, index) => `${index + 1}. ${answer || "—"}`).join("\n") : undefined;
  }
  if (exercise.kind === "single" || exercise.kind === "multiple") {
    invalid(response.clozeAnswers === undefined && response.matches === undefined && response.order === undefined && response.selectedOptionIndexes
      && response.selectedOptionIndexes.every(index => index < exercise.options.length) && (exercise.kind !== "single" || response.selectedOptionIndexes.length <= 1));
    return response.selectedOptionIndexes.length ? response.selectedOptionIndexes.map(index => exercise.options[index]).join("\n") : undefined;
  }
  invalid(response.clozeAnswers === undefined && response.selectedOptionIndexes === undefined && arrangement && arrangement.kind === exercise.kind);
  if (exercise.kind === "matching") {
    invalid(response.order === undefined && response.matches?.length === exercise.pairs.length && response.matches.every(index => index >= -1 && index < exercise.pairs.length));
    return response.matches.some(index => index >= 0) ? exercise.pairs.map((pair, index) => `${pair.left} → ${response.matches![index] < 0 ? "—" : exercise.pairs[arrangement.positions[response.matches![index]]].right}`).join("\n") : undefined;
  }
  invalid(response.matches === undefined && response.order?.length === exercise.orderItems.length);
  return response.order.map((index, position) => `${position + 1}. ${exercise.orderItems[arrangement.positions[index]]}`).join("\n");
}
export function applyMiniAppRequest(s: ServerState, request: Exclude<MiniAppRequest, { kind: "view" | "today" | "plan" | "finish-chat" | "plan-action" | "report-card" }>, effective: CompanionSnapshot, suppressed: ReviewAttempt[], now: number): void {
  const effectiveCards = snapshotCardMap(effective);
  suppressed = suppressed.filter(attempt => attempt.mode === "core" && effectiveCards.get(attempt.cardId)?.mode === "core");
  const hash = digest(request), prior = s.miniAppReceipts?.find(row => row.id === request.requestId);
  if (prior) { invalid(prior.hash === hash, "Mini App request collision"); return; }
  invalid(request.viewToken === miniAppViewToken(s), "stale Mini App view");
  invalid(!s.domain.revoked && companionSnapshotIsCurrent(effective, now));
  invalid(!s.studySession || s.studySession.status === "finished" || now >= s.studySession.snapshot.expiresAt, "Continue or finish the chat session first");
  if (request.kind === "answer-retention") {
    invalid(typeof request.enabled === "boolean"); s.retainAnswers = request.enabled; s.retainAnswersChangedAt = Math.max(now, (s.retainAnswersChangedAt ?? 0) + 1);
    if (!request.enabled && s.miniApp) { delete s.miniApp.retainedAnswer; if (s.miniApp.selfRecall && !s.miniApp.currentAttemptId) s.miniApp.selfRecall.answer = ""; }
  } else if (request.kind === "start") {
    validateStartSelection(request);
    validateSessionOptions(request, 90);
    invalid(request.shuffle === undefined || typeof request.shuffle === "boolean");
    invalid(request.mode === undefined || request.mode === "core" || request.mode === "bank");
    invalid(!s.miniApp || s.miniApp.session.status === "finished" || !miniAppSessionAllowed(s, now), "Mini App session already active");
    const base = request.retryWeak ? weakBankCards(s, effective, now) : queryCards(effective, suppressed, { now, all: true }).cards;
    const permittedMaterials = new Set(s.materialConsentIds);
    const available = base.filter(card => cardSourceAllowed(s, card, now, permittedMaterials) && cardIsDue(card, now) && (request.mode === undefined || card.mode === request.mode));
    const selectedIds = request.materialIds ?? (request.materialId === undefined ? undefined : [request.materialId]);
    const materialCards = new Map<string, SelectedCard[]>();
    for (const card of available) { const rows = materialCards.get(card.materialId) ?? []; rows.push(card); materialCards.set(card.materialId, rows); }
    if (selectedIds) invalid(selectedIds.every(id => materialCards.has(id)), "A selected material is unavailable");
    const cards = (selectedIds ? selectedIds.flatMap(id => materialCards.get(id)!) : available).filter(card => {
      const metadata = (s.studyContext && studyContextCardMap(s.studyContext).get(card.id));
      return (request.topicRecallCardId === undefined || card.id === request.topicRecallCardId && card.mode === "bank" && !card.exercise && card.evaluationMode === undefined)
        && (request.learningGroup === undefined || metadata?.group === request.learningGroup) && (request.section === undefined || metadata?.sections?.includes(request.section))
        && (request.questionKind === undefined || (metadata?.kind ?? card.exercise?.kind ?? "free") === request.questionKind)
        && (request.topic === undefined || metadata?.topics?.includes(request.topic)) && (request.tag === undefined || metadata?.tags?.some(tag => tagKey(tag) === tagKey(request.tag!)))
        && (request.knowledgeState === undefined || metadata?.knowledgeState === request.knowledgeState);
    });
    invalid(cards.length > 0, "No cards available");
    if (request.shuffle) for (let i = cards.length - 1; i > 0; i--) { const j = randomInt(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    const originals = cards.slice(0, request.cardLimit ?? 1000).map(card => card.offline ? ensureOfflineHead(s.offlineHeads ??= [], s.domain.snapshot!, card.id)!.baseCard : card);
    const options = Object.fromEntries((["cardLimit", "timeLimitMinutes", "shuffle", "learningGroup", "questionKind", "section", "topic", "tag", "knowledgeState"] as const).filter(key => request[key] !== undefined).map(key => [key, request[key]]));
    const { studyTarget: _studyTarget, cards: _cards, ...sessionSnapshot } = effective;
    s.miniApp = { session: { id: opaque(), snapshot: { ...sessionSnapshot, expiresAt: Math.min(effective.expiresAt, ...originals.map(card => card.offline ? decodeOfflineSeed(card.offline).expiresAt : effective.expiresAt)), cards: copy(originals) }, status: "active", results: [], skipped: [], deferred: [], ...(request.mode === undefined ? {} : { mode: request.mode }) }, revision: 0, revealed: false, hintCount: 0,
      startedAt: now, lastActivityAt: now, skipCount: 0, options, ...(request.timeLimitMinutes === undefined ? {} : { deadlineAt: now + request.timeLimitMinutes * 60000 }) };
    nextCard(s, effective, suppressed, now);
  } else {
    invalid(miniAppSessionAllowed(s, now), "Mini App session expired or selection changed");
    const app = s.miniApp!, session = app.session, card = session.current;
    if (request.kind === "finish") finishSession(app, now, "manual");
    else if (request.kind === "pause") { invalid(session.status === "active" && app.startedAt !== undefined && (app.deadlineAt === undefined || now < app.deadlineAt)); app.pausedAt = now; session.status = "paused"; }
    else if (request.kind === "resume") { invalid(session.status === "paused" && app.pausedAt !== undefined); resumeClock(app, now); session.status = "active"; }
    else if (request.kind === "change-grade") { invalid(session.status !== "paused"); replaceMiniAppGrade(s, request.attemptId!, request.rating!, effective, suppressed, now); }
    else {
      invalid(session.status === "active");
      if (request.kind === "next") {
        invalid(!card || app.currentAttemptId, "Grade or skip the current card first");
        if (request.early) invalid(!card && effective.earlyShortRepeats === true, "Early continue needs a compatible waiting session");
        nextCard(s, effective, suppressed, now, request.early === true);
      }
      else {
        invalid(card && cardSourceAllowed(s, card, now));
        if (request.kind === "hint") { invalid(!app.revealed && app.hintCount < (card.hints?.length ?? 0)); app.hintCount++; }
        else if (request.kind === "skip") { invalid(!app.currentAttemptId); const skipped = app.skipCount ?? session.deferred?.length ?? 0; (session.deferred ??= []).push(card.id); app.skipCount = skipped + 1; nextCard(s, effective, suppressed, now); }
        else if (request.kind === "reveal" || request.kind === "self-recall") {
          invalid(!app.revealed);
          if (request.kind === "self-recall") invalid(!card.exercise && card.evaluationMode === undefined, "Written recall needs a self-check card");
          if (!card.exercise && card.evaluationMode === undefined) {
            const criteria = (s.studyContext && studyContextCardMap(s.studyContext).get(card.id))?.selfCheckCriteria;
            const answer = request.kind === "self-recall" ? request.text ?? "" : "";
            app.answerDigest = digest({ answer }); app.selfRecall = { answer: s.retainAnswers === false ? "" : answer, ...(criteria === undefined ? {} : { criteria: [...criteria] }) };
          }
          app.revealed = true;
        }
        else if (request.kind === "check") {
          invalid(!app.revealed && card.evaluationMode === "exact"); const response = request.response!, checked = checkedResponse(card, response, app.arrangement);
          if (card.exercise) {
            invalid(response.text === undefined);
            let canonicalResponse = response;
            if (card.exercise.kind === "cloze") invalid(response.selectedOptionIndexes === undefined && response.matches === undefined && response.order === undefined
              && response.clozeAnswers?.length === companionExerciseBlankCount(card.exercise) && response.clozeAnswers.every(text => !!text.trim()));
            else if (card.exercise.kind === "single" || card.exercise.kind === "multiple") invalid(response.clozeAnswers === undefined && response.matches === undefined && response.order === undefined
              && response.selectedOptionIndexes && (card.exercise.kind !== "single" || response.selectedOptionIndexes.length === 1));
            else {
              invalid(response.clozeAnswers === undefined && response.selectedOptionIndexes === undefined);
              const arrangement = app.arrangement; invalid(arrangement && arrangement.kind === card.exercise.kind);
              if (card.exercise.kind === "matching") { invalid(response.order === undefined && response.matches?.length === card.exercise.pairs.length); canonicalResponse = { matches: response.matches.map(index => arrangement.positions[index]) }; }
              else { invalid(response.matches === undefined && response.order?.length === card.exercise.orderItems.length); canonicalResponse = { order: response.order.map(index => arrangement.positions[index]) }; }
            }
            app.answerMatch = evaluateCompanionExercise(card.exercise, canonicalResponse); app.feedback = createCompanionExerciseFeedback(card.exercise, canonicalResponse);
          } else {
            invalid(typeof response.text === "string" && !!response.text.trim() && response.selectedOptionIndexes === undefined && response.clozeAnswers === undefined && response.matches === undefined && response.order === undefined);
            app.answerMatch = card.acceptedAnswers === undefined ? isExactTestAnswerCorrect(response.text, card.reference, card.answerMatchMode) : isExplicitTestAnswerCorrect(response.text, card.acceptedAnswers, card.answerMatchMode);
          }
          app.answerDigest = digest({ answer: checked.answer });
          if (s.retainAnswers === true && app.answerMatch === false) app.retainedAnswer = checked.answer;
          app.revealed = true;
        } else if (request.kind === "grade") {
          invalid(app.revealed && !app.currentAttemptId && !(app.answerMatch === true && request.rating === 1));
          invalid(effective.cards.some(row => row.id === card.id && row.revision === card.revision) && !suppressed.some(row => row.cardId === card.id));
          invalid(request.checkedCriteria === undefined || app.selfRecall !== undefined, "Checklist needs a self-check card");
          if (request.checkedCriteria !== undefined) validateCompanionCheckedCriteria(request.checkedCriteria, app.selfRecall?.criteria?.length ?? 0);
          const selfRecall = app.selfRecall, hasWrittenEvidence = s.retainAnswers === undefined && selfRecall && (!!selfRecall.answer.trim() || !!request.checkedCriteria?.length);
          const attempt = appendCompanionReview(s, card, opaque(), request.rating!, request.rating !== 1, now, app.earlyRepeat === true);
          if (hasWrittenEvidence) enqueueCompanionWrittenRecall(s, { attempt: copy(attempt), answer: selfRecall!.answer, question: card.question, reference: card.reference,
            ...(selfRecall!.criteria === undefined ? {} : { criteria: [...selfRecall!.criteria] }), ...(request.checkedCriteria === undefined ? {} : { checkedCriteria: [...request.checkedCriteria] }) });
          if (s.retainAnswers === true) {
            let answer = app.retainedAnswer ?? selfRecall?.answer;
            if (request.text !== undefined) { invalid(!card.exercise); answer = request.text; }
            if (request.response !== undefined) { invalid(card.exercise); answer = app.answerMatch === undefined
              ? uncheckedResponseAnswer(card, request.response, app.arrangement) : checkedResponse(card, request.response, app.arrangement).answer; }
            if (app.answerDigest !== undefined && (selfRecall || app.answerMatch === false)) invalid(typeof answer === "string" && digest({ answer }) === app.answerDigest, "Original answer differs from the checked response");
            if (!selfRecall || !!answer?.trim() || !!request.checkedCriteria?.length) {
              const evidence = createAnswerHistoryEvidence({ attemptId: attempt.id, cardId: card.id, mode: card.mode, occurredAt: now,
                kind: card.exercise?.kind ?? (card.evaluationMode === "exact" ? "exact" : "self"), question: card.question, reference: card.reference, answerMatch: app.answerMatch ?? null,
                ...(answer === undefined ? {} : { answer }), ...(card.answerMatchMode !== undefined && !card.exercise ? { answerMatchMode: card.answerMatchMode } : {}),
                ...(card.exercise?.kind === "cloze" && card.exercise.answerMatchMode !== undefined ? { answerMatchMode: card.exercise.answerMatchMode } : {}),
                ...(selfRecall?.criteria === undefined ? {} : { criteria: [...selfRecall.criteria] }), ...(request.checkedCriteria === undefined ? {} : { checkedCriteria: [...request.checkedCriteria] }) });
              enqueueAnswerHistory(s, { attempt: copy(attempt), evidence });
            }
          }
          app.currentAttemptId = attempt.id; session.results.push({ cardId: card.id, attemptId: attempt.id, card: copy(card) });
          (s.miniAppAttempts ??= []).push({ id: attempt.id, ...(app.answerMatch === undefined ? {} : { answerMatch: app.answerMatch }) });
          if (request.advance) {
            const head = card.offline && s.offlineHeads?.find(row => row.cardId === card.id);
            const updated = head ? { ...effective, cards: effective.cards.map(row => row.id === card.id ? projectOfflineCard(head) : row) } : effective;
            nextCard(s, updated, suppressed, now);
          }
        }
      }
    }
    if (request.kind !== "finish" && session.status !== "finished") { app.startedAt ??= Math.min(now, session.snapshot.generatedAt); app.lastActivityAt = now; }
    app.revision++;
  }
  (s.miniAppReceipts ??= []).push({ id: request.requestId, hash });
}

function replaceMiniAppGrade(s: ServerState, id: string, rating: ReviewAttempt["rating"], effective: CompanionSnapshot, suppressed: ReviewAttempt[], now: number): void {
  const app = s.miniApp!, result = app.session.results.find(row => row.attemptId === id); invalid(result && canChangeGrade(s, id, now));
  invalid(!(s.miniAppAttempts?.find(row => row.id === id)?.answerMatch === true && rating === 1));
  const pending = s.domain.pending.find(row => row.id === id);
  if (!pending) {
    const attempt = resultAttempt(s, id)!, editable = s.editableGrades!.find(row => row.attemptId === id)!;
    invalid(!(editable.answerMatch === true && rating === 1)); if (editable.rating === rating) return;
    const correction = { id: opaque(), scope: attempt.scope, epoch: attempt.epoch, attemptId: id, cardId: attempt.cardId, revision: attempt.revision,
      expectedReviewEventId: editable.reviewEventId, rating, correct: rating !== 1, requestedAt: now };
    (s.gradeCorrections ??= []).push({ correction }); return;
  }
  if (pending.rating === rating) return;
  const replacement = { ...pending, id: opaque(), rating, correct: rating !== 1 };
  const head = pending.offline && s.offlineHeads?.find(head => head.cardId === pending.cardId);
  if (head) {
    (s.supersededOfflineReviews ??= []).push({ attempt: copy(pending), seed: head.seed });
    const step = decodeOfflineStep(pending.offline!); step.after = advanceOfflineFsrs(head.seed, step.before, replacement.correct ? replacement.rating : 1, replacement.occurredAt);
    replacement.offline = encodeOfflineStep(step); head.state = step.after; head.lastAttemptId = replacement.id;
  }
  validateAttempt(replacement); s.domain.pending = s.domain.pending.map(row => row.id === id ? replacement : row);
  const written = s.writtenRecalls?.find(row => row.attempt.id === id); if (written) written.attempt = copy(replacement);
  replacePendingAnswerHistoryAttempt(s, id, replacement);
  const origin = s.miniAppAttempts?.find(row => row.id === id); if (origin) origin.id = replacement.id;
  result.attemptId = replacement.id; if (app.currentAttemptId === id) app.currentAttemptId = replacement.id;
  if (head && (app.session.current?.revision === id || app.session.waitUntil !== undefined)) {
    nextCard(s, { ...effective, cards: effective.cards.map(card => card.id === head.cardId ? projectOfflineCard(head) : card) }, suppressed, now);
  }
}

export function miniAppMediaAsset(s: ServerState, id: string, now: number): CompanionMediaAttachment {
  invalid(miniAppSessionAllowed(s, now) && s.attachmentConsent === true, "Mini App media unavailable");
  const app = s.miniApp!, card = app.session.current; invalid((app.pausedAt !== undefined || now < idleExpiresAt(app))
    && now < (app.startedAt ?? app.session.snapshot.generatedAt) + MINIAPP_SESSION_TTL_MS
    && ["active", "paused"].includes(app.session.status) && card && cardSourceAllowed(s, card, now));
  const asset = card.media?.find(row => row.id === id && (row.side === "question" || app.revealed)); invalid(asset, "Mini App media unavailable"); return copy(asset);
}
