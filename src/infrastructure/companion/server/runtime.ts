import { randomBytes } from "node:crypto";
import { COMPANION_STUDY_COPY_TTL, MAX_COMPANION_SNAPSHOT_BYTES, MAX_COMPANION_SNAPSHOT_CHUNK_BYTES } from "../../../domain/companion/capacity";
import { LargePayloadAssembler } from "./large-payload";
import { CatalogPageTransfer, type CatalogCommit } from "./catalog-page-storage";
import { CATALOG_PAGE_BYTES, CATALOG_REFERENCE_BATCH } from "../catalog-pages";
import { cloneJsonValue, jsonFingerprintEqual } from "../../../shared/json-digest";
import { isExactTestAnswerCorrect, isExplicitTestAnswerCorrect } from "../../../domain/cards/recall-core";
import type { CompanionAnswerHistory, CompanionAnswerHistoryReceipt } from "../../../domain/companion/answer-history";
import { companionCardReportContentHash, type CompanionCardReport, type CompanionCardReportReceipt } from "../../../domain/companion/card-reports";
import { validateCompanionGradeCorrection, validateCompanionGradeCorrectionReceipt, type CompanionGradeCorrection } from "../../../domain/companion/corrections";
import { createCompanionExerciseFeedback, type CompanionExerciseFeedback } from "../../../domain/companion/exercise-feedback";
import { companionExerciseBlankCount, evaluateCompanionExercise } from "../../../domain/companion/exercises";
import { MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES, MAX_COMPANION_MEDIA_CHUNK_BYTES, MAX_COMPANION_MEDIA_STATUS_ASSETS, validateCompanionMediaAck, validateCompanionMediaChunk, validateCompanionMediaStatusAssets, type CompanionMediaAttachment, type CompanionMediaIdentity, type CompanionMediaStore } from "../../../domain/companion/media";
import { OFFLINE_FSRS_ENGINE, advanceOfflineFsrs, decodeOfflineSeed, decodeOfflineStep, encodeOfflineStep, stateIsShortStep } from "../../../domain/companion/offline-fsrs";
import {
COMPANION_CLOCK_SKEW, MAX_COMPANION_BRIDGE_BYTES, companionSnapshotIsCurrent, emptyState, invalid, keys, queryCards, record, sameAttempt, timestamp, token, validateAttempt, validateSnapshot, type CompanionSnapshot, type ImportStatus, type ReviewAttempt, type SelectedCard
} from "../../../domain/companion/protocol";
import { validateCompanionStudyContext } from "../../../domain/companion/study-context";
import { validateCompanionStudyPlan, type CompanionStudyPlanOverviewEntry } from "../../../domain/companion/study-plan";
import { type CompanionPlanCommand, type CompanionPlanCommandReceipt } from "../../../domain/companion/study-plan-actions";
import { parseStudyPlanStartParameter } from "../../../domain/companion/study-plan-link";
import type { CompanionWrittenRecall, CompanionWrittenRecallReceipt } from "../../../domain/companion/written-recall";
import { nativePollView, validNativePollId } from "../../../features/companion/native-poll";
import { GRADE_LABELS, GRADE_PROMPT, combinedGradeText, gradePanelText, groupCompanionButtons, hintPanelView, renderCard, renderCompanionStatus, renderMaterials, studySessionText, validateCompanionSpoilers, validateGradePanelEdit, validateHintPanelEdit, validateQuestionPanelEdit, validateSessionPanelEdit, type CompanionMessage, type GradePanelStage } from "../../../features/companion/presentation";
import { readRichCheckboxDemoMessage, richCheckboxDemoView } from "../../../features/companion/rich-checkbox-demo";
import { verifyPrivateTelegramUpdate } from "../telegram-api";
import { acknowledgeAnswerHistory, pendingAnswerHistory } from "./answer-history";
import { answerHistoryCapability, canonical, cardReportCapability, correctionCapability, digest, equal, pendingCapability, planCommandCapability, sign, verifyAnswerHistoryCapability, verifyCardReportCapability, verifyPlanCommandCapability, verifyWrittenRecallCapability, writtenRecallCapability } from "./bridge-contract";
import { acknowledgeCompanionCardReport, enqueueCompanionCardReport } from "./card-reports";
import { recordPerformance, type PerformanceObserver } from "./metrics";
import { appendCompanionReview, applyMiniAppRequest, expireMiniAppSession, finishMiniAppRequest, finishMiniAppSession, miniAppMediaAsset, miniAppSessionAllowed, miniAppStudyTargetCards, miniAppView, miniAppViewToken, validateMiniAppRequest, type MiniAppView } from "./miniapp-study";
import { storedPollCard } from "./native-poll-state";
import { ensureOfflineHead, projectOfflineCard, reconcileOfflineHeads, type OfflineHead } from "./offline-session";
import { cloneServerState, snapshotCardMap, snapshotOfflineSeed, validateImmutableSnapshot, validateImmutableStudyContext } from "./immutable-content";
import { addResultOrdinal, compactResults, hydrateResult, resultCounts, resultHistory } from "./result-lifecycle";
import { compactServerReplay } from "./replay-lifecycle";
import { latestSession, nextSession, sessionOrder, studyDay } from "./reminders";
import { acknowledgeCompanionPlanCommand, companionPlanCommandViews, companionPlanEntryPending, enqueueCompanionPlanCommand } from "./study-plan-actions";
import { DAILY_REMINDER_TEXT, activeStudyPlanEntry, miniAppLaunchUrl, planNotificationsAllowed, reminderMiniAppPayload, studyPlanPayload, type StudyPlanDelivery } from "./study-plan-reminders";
import { acknowledgeCompanionWrittenRecall } from "./written-recall";
export { canonical, digest, sign } from "./bridge-contract";
export type { BridgeEnvelope } from "./bridge-contract";
export { GRADE_SAVED_NOTICE, MEDIA_LOADING_ERROR, MINI_APP_LAUNCH_TEXT, isMediaMethod, mediaMethod, validateConfig, validateServerState } from "./server-state";
export type { CompanionStudySession, Journal, Outbound, OwnedDelivery, ServerConfig, ServerState, Transport, TransportResult } from "./server-state";

import { GRADE_SAVED_NOTICE, MEDIA_LOADING_ERROR, MINI_APP_LAUNCH_TEXT, carriesGradeAnswer, isEditMethod, isMediaMethod, loadingText, mediaMethod, ratingAnswerAllowed, sessionCards, statuses, validateConfig, validateServerState, type Action, type Journal, type Outbound, type ServerConfig, type ServerState, type Transport, type TransportResult } from "./server-state";

const clone = cloneJsonValue;
class AlreadyAnswered extends Error {}
/** Single owner / process. Every domain transition and delivery intent commits together.
 * Storage failure poisons this instance: restart and inspect/reload, never continue uncertain state. */
export class CompanionServer {
  private readonly largePayload = new LargePayloadAssembler();
  private readonly catalogTransfer?: CatalogPageTransfer;
  private state!: ServerState;
  private tail: Promise<void> = Promise.resolve();
  private active = false;
  private flushing?: Promise<void>;
  private callbackFlushing?: Promise<void>;
  private readonly queuedAt = new Map<string, number>();
  private coldResults?: { snapshot: CompanionSnapshot; revision: number; value: { attempts: ReviewAttempt[]; offlineRoots: Set<string> } };
  constructor(readonly config: ServerConfig, private readonly journal: Journal, private readonly transport: Transport, private readonly media?: CompanionMediaStore, private readonly observe?: PerformanceObserver) {
    validateConfig(config); if (journal.catalog) this.catalogTransfer = new CatalogPageTransfer(journal.catalog);
  }
  private serial<T>(f: () => Promise<T>): Promise<T> { const p = this.tail.then(f); this.tail = p.then(() => undefined, () => undefined); return p; }
  private async commit(s: ServerState, committed = this.state): Promise<void> {
    const started = performance.now();
    try {
      compactResults(s, committed, this.journal.results);
      compactServerReplay(s, committed, this.journal.replay);
      // A changed grant or source retires unsent answer copies without losing their grade feedback.
      const panels = new Map(s.outbox.filter(row => row.ratingPanel?.answerText !== undefined).map(row => [row.id, row]));
      for (const row of s.outbox) {
        const panel = row.method === "editMessageText" && row.status === "queued" && row.target !== undefined ? panels.get(row.target) : undefined;
        if (panel && carriesGradeAnswer(row.payload.text, panel) && !ratingAnswerAllowed(s, panel, Date.now())) {
          validateGradePanelEdit(row.payload.text, row.payload.reply_markup, panel.ratingPanel!.answerText);
          row.payload.text = (row.payload.text as string).slice(panel.ratingPanel!.answerText!.length + 2);
        }
      }
      const copy = cloneServerState(s);
      if (this.journal.validateAndSave) await this.journal.validateAndSave(copy, this.config.ownerChatId);
      else { validateServerState(s, this.config.ownerChatId, this.journal.results); await this.journal.save(copy); }
    } catch { this.active = false; throw new Error("journal unavailable; restart required"); }
    this.state = s;
    if (this.observe) {
      const queued = new Set(s.outbox.filter(row => row.status === "queued").map(row => row.id)), now = performance.now();
      for (const id of queued) if (!this.queuedAt.has(id)) this.queuedAt.set(id, now);
      for (const id of this.queuedAt.keys()) if (!queued.has(id)) this.queuedAt.delete(id);
    }
    recordPerformance(this.observe, "runtime.commit", performance.now() - started);
  }
  async start(): Promise<void> {
    return this.serial(async () => {
      invalid(!this.active); const binding = digest({ scope: this.config.scope, epoch: this.config.epoch, enrollment: this.config.enrollment, owner: this.config.ownerUserId, chat: this.config.ownerChatId, timeZone: this.config.timeZone });
      const loaded = await this.journal.load();
      const s: ServerState = loaded ?? { version: 1, binding, domain: emptyState(), handles: [], updates: [], callbackIds: [], nonces: [], bridgeTimeFloor: 0, receipts: [], outbox: [], lastSession: 0, mutedUntil: 0, claimedAttempts: [] };
      validateServerState(s, this.config.ownerChatId, this.journal.results); invalid(s.binding === binding, "journal enrollment differs; explicit reconcile/migration required");
      if (s.resultLedger?.archiveUsed) { invalid(this.journal.results, "Result archive unavailable"); this.journal.results.assertPresent(this.config.scope, this.config.epoch); }
      if (s.replayArchived) { invalid(this.journal.replay, "Request replay archive unavailable"); this.journal.replay.assertPresent(s.binding); }
      const committed = loaded && cloneServerState(loaded);
      delete s.answerHistoryFull;
      // An older server may already have handed these attempts to a desktop.
      s.claimedAttempts ??= s.domain.pending.map(attempt => attempt.id);
      s.editableGrades ??= []; s.gradeCorrections ??= [];
      invalid(!s.studySession || s.studySession.snapshot.scope === this.config.scope && s.studySession.snapshot.epoch === this.config.epoch);
      invalid(s.gradeCorrections.every(row => row.correction.scope === this.config.scope && row.correction.epoch === this.config.epoch));
      invalid(!s.domain.snapshot || s.domain.snapshot.scope === this.config.scope && s.domain.snapshot.epoch === this.config.epoch);
      invalid(!s.studyPlan || s.studyPlan.timeZone === this.config.timeZone, "study plan timezone differs");
      invalid([...s.domain.pending, ...s.domain.outcomes.map(o => o.attempt)].every(a => a.scope === this.config.scope && a.epoch === this.config.epoch));
      invalid([...(s.planCommands ?? []), ...(s.planCommandReceipts ?? []).map(row => row.command)].every(row => row.scope === this.config.scope && row.epoch === this.config.epoch));
      invalid([...(s.cardReports ?? []), ...(s.cardReportReceipts ?? []).map(row => row.report)].every(row => row.scope === this.config.scope && row.epoch === this.config.epoch));
      invalid([...(s.writtenRecalls ?? []), ...(s.writtenRecallReceipts ?? []).map(row => row.recall)].every(row => row.attempt.scope === this.config.scope && row.attempt.epoch === this.config.epoch));
      invalid((s.answerHistory ?? []).every(row => row.attempt.scope === this.config.scope && row.attempt.epoch === this.config.epoch));
      invalid((s.supersededOfflineReviews ?? []).every(row => row.attempt.scope === this.config.scope && row.attempt.epoch === this.config.epoch));
      if (this.config.miniAppUrl) this.retireChatStudy(s, Date.now());
      this.reconcileMediaFailures(s); this.retirePolls(s, Date.now()); this.reconcilePlanDeliveries(s, Date.now()); await this.commit(s, committed); this.active = true;
    });
  }
  /** Sanitized operational counts only; never return cached card text or credentials. */
  async drain(): Promise<void> {
    let failed: PromiseRejectedResult | undefined;
    do {
      const results = await Promise.allSettled([this.flushing, this.callbackFlushing]); await this.tail;
      failed ??= results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    } while (this.flushing || this.callbackFlushing);
    if (failed) throw failed.reason;
  }
  async health() { await this.tail; return { active: this.active, pending: this.state?.domain.pending.length ?? 0, unknownDeliveries: this.state?.outbox.filter(o => o.status === "unknown").length ?? 0 }; }
  async miniApp(request: unknown, now = Date.now()): Promise<MiniAppView> {
    validateMiniAppRequest(request); timestamp(now);
    return this.serial(async () => {
      invalid(this.active); let s = cloneServerState(this.state);
      if (expireMiniAppSession(s, now)) { await this.commit(s); s = cloneServerState(s); }
      if ((request.kind === "view" || request.kind === "today" || request.kind === "plan") && request.answerHistoryVersion === 1 && s.retainAnswers === undefined) {
        s.retainAnswers = false; s.retainAnswersChangedAt = 0;
        if (s.miniApp) { delete s.miniApp.retainedAnswer; if (s.miniApp.selfRecall && !s.miniApp.currentAttemptId) s.miniApp.selfRecall.answer = ""; }
        await this.commit(s);
        s = cloneServerState(s);
      }
      if (this.config.miniAppUrl && ["view", "today", "plan"].includes(request.kind) && this.retireChatStudy(s, now)) { await this.commit(s); s = cloneServerState(s); }
      const prior = "requestId" in request
        ? s.miniAppReceipts?.find(row => row.id === request.requestId)?.hash
          ?? (s.replayArchived ? this.journal.replay!.get(s.binding, "miniapp", request.requestId) : undefined)
        : undefined;
      if (prior !== undefined) {
        invalid(prior === digest(request), "Mini App request collision");
      } else if (request.kind === "plan-action") {
        invalid(request.viewToken === miniAppViewToken(s), "stale Mini App view");
        invalid(this.config.miniAppUrl && this.planLaunchEntry(s, request.id, now)?.action, "Study plan entry unavailable");
        const { kind: _kind, requestId, viewToken: _token, id, ...fields } = request;
        enqueueCompanionPlanCommand(s, s.studyPlan!, { ...fields, id: requestId, entryId: id, scope: this.config.scope, epoch: this.config.epoch, requestedAt: now }, now);
        (s.miniAppReceipts ??= []).push({ id: request.requestId, hash: digest(request) });
        this.reconcilePlanDeliveries(s, now); await this.commit(s);
      } else if (request.kind === "report-card") {
        invalid(request.viewToken === miniAppViewToken(s), "stale Mini App view");
        const snapshot = this.effectiveSnapshot(s, now), current = miniAppView(s, snapshot, this.suppressed(s), now).card;
        const card = s.miniApp?.session.current;
        invalid(s.cardReportsEnabled && current && card && current.id === card.id && current.revision === card.revision, "card report unavailable");
        enqueueCompanionCardReport(s, { id: request.requestId, scope: this.config.scope, epoch: this.config.epoch, cardId: card.id,
          materialId: card.materialId, contentHash: companionCardReportContentHash(card), requestedAt: now,
          ...(request.reason === undefined ? {} : { reason: request.reason }), ...(request.note === undefined ? {} : { note: request.note }) }, card, now);
        (s.miniAppReceipts ??= []).push({ id: request.requestId, hash: digest(request) });
        await this.commit(s);
      } else if (request.kind === "finish-chat") {
        invalid(request.viewToken === miniAppViewToken(s), "stale Mini App view");
        const snapshot = this.effectiveSnapshot(s, now), session = s.studySession;
        invalid(!s.domain.revoked && snapshot && companionSnapshotIsCurrent(snapshot, now), "Mini App unavailable");
        invalid(session && session.id === request.chatSessionId && session.status !== "finished" && now < session.snapshot.expiresAt, "stale Mini App view");
        this.finishSession(s, now, !!this.config.miniAppUrl);
        (s.miniAppReceipts ??= []).push({ id: request.requestId, hash: digest(request) });
        await this.commit(s);
      } else if (request.kind === "finish") {
        finishMiniAppRequest(s, request, now); await this.commit(s);
      } else if (request.kind !== "view" && request.kind !== "plan" && request.kind !== "today") {
        this.renewOfflineBaselines(s, now);
        if (request.kind === "start") this.retireSettledOfflineHeads(s, now, true);
        let snapshot = this.effectiveSnapshot(s, now); invalid(snapshot, "Mini App unavailable");
        if (request.kind === "start" && request.planId !== undefined) {
          const entry = this.config.miniAppUrl && this.planLaunchEntry(s, request.planId, now);
          invalid(entry && !(entry.completed || entry.skipped) && (request.mode === undefined || entry.mode === undefined || request.mode === entry.mode), "Study plan entry unavailable");
          const ids = entry.cardIds && new Set(entry.cardIds);
          snapshot = { ...snapshot, cards: snapshot.cards.filter(card => (ids ? ids.has(card.id) : !entry.materialIds.length || entry.materialIds.includes(card.materialId))
            && (entry.mode === undefined || card.mode === entry.mode)) };
        }
        applyMiniAppRequest(s, request, snapshot, this.suppressed(s), now); await this.commit(s);
      }
      const view = miniAppView(s, this.effectiveSnapshot(s, now), this.suppressed(s), now);
      if (request.kind === "plan") {
        const entry = this.config.miniAppUrl ? this.planLaunchEntry(s, request.id, now) : undefined;
        let materials = entry ? view.materials.filter(row => (!entry.materialIds.length || entry.materialIds.includes(row.id)) && (entry.mode === undefined || row.mode === entry.mode)) : [];
        if (entry?.cardIds) {
          const ids = new Set(entry.cardIds), counts = new Map<string, number>();
          view.catalog = view.catalog?.filter(card => ids.has(card.id) && card.mode === "core");
          for (const card of view.catalog ?? []) counts.set(card.materialId, (counts.get(card.materialId) ?? 0) + 1);
          materials = view.materials.filter(row => row.mode === "core" && counts.has(row.id)).map(row => ({ ...row, count: counts.get(row.id)! }));
          view.materials = materials;
        }
        view.launch = entry ? { id: entry.id, title: entry.title, materialIds: !entry.cardIds && entry.materialIds.length ? [...entry.materialIds] : [...new Set(materials.map(row => row.id))], ...(entry.mode ? { mode: entry.mode } : {}), ...(entry.action ? { action: clone(entry.action) } : {}), ...("completed" in entry ? { completed: entry.completed === true } : {}), ...("skipped" in entry ? { skipped: entry.skipped === true } : {}), available: !("completed" in entry && entry.completed || "skipped" in entry && entry.skipped) && materials.length > 0 }
          : { id: request.id, title: "Занятие недоступно", materialIds: [], available: false };
      }
      if (s.studyPlan && this.planWindowAllowed(s, now)) {
        const plan = s.studyPlan, consent = new Set(s.materialConsentIds);
        const entries: CompanionStudyPlanOverviewEntry[] = (plan.overview ?? plan.entries)
          .filter(row => consent.size && row.materialIds.every(id => consent.has(id)));
        const entryIds = new Set(entries.map(row => row.id));
        view.planActions = entries.some(row => row.action);
        view.planCommands = companionPlanCommandViews(s, plan).filter(row => entryIds.has(row.entryId));
        if (request.kind === "today" || request.kind === "plan-action") {
          const materialIds = new Set(view.materials.map(material => material.id));
          const coreIds = new Set(view.materials.filter(material => material.mode === "core").map(material => material.id));
          const bankIds = new Set(view.materials.filter(material => material.mode === "bank").map(material => material.id));
          const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: plan.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
          const dayKey = (time: number): number => {
            const parts = dayFormatter.formatToParts(time);
            const get = (name: string) => Number(parts.find(part => part.type === name)!.value);
            return Date.UTC(get("year"), get("month") - 1, get("day"));
          };
          const today = dayKey(now), summary = { timeZone: plan.timeZone, generatedAt: plan.generatedAt, expiresAt: plan.expiresAt };
          view.today = { ...summary, rows: [] };
          view.week = { ...summary, rows: [] };
          for (const row of entries.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id))) {
            const day = dayKey(row.startAt);
            if (day < today || day >= today + 7 * 86_400_000) continue;
            const eligible = row.mode === "core" ? coreIds : row.mode === "bank" ? bankIds : materialIds;
            const completed = row.completed === true, skipped = row.skipped === true;
            const available = !completed && !skipped && (row.materialIds.length ? row.materialIds.some(id => eligible.has(id)) : eligible.size > 0);
            const item = { id: row.id, title: row.title, startAt: row.startAt, completed, skipped, available,
              materialIds: row.materialIds.length ? [...row.materialIds] : [...eligible], ...(row.mode === undefined ? {} : { mode: row.mode }),
              ...(row.action ? { action: clone(row.action) } : {}), ...(row.calendar ? { calendar: clone(row.calendar) } : {}) };
            if (day === today) view.today.rows.push(item);
            view.week.rows.push(item);
          }
        }
      }
      if (request.kind === "view" || request.kind === "today" || request.kind === "plan") recordPerformance(this.observe, "miniapp.view", 0);
      return view;
    }).catch(error => {
      if (error instanceof Error && error.message === "stale Mini App view") recordPerformance(this.observe, "miniapp.view-conflict", 0);
      throw error;
    });
  }
  private planWindowAllowed(s: ServerState, now: number): boolean {
    return !!s.studyPlan && !s.domain.revoked && now >= s.studyPlan.generatedAt - COMPANION_CLOCK_SKEW && now < s.studyPlan.expiresAt
      && !!s.domain.snapshot && companionSnapshotIsCurrent(s.domain.snapshot, now);
  }
  private planLaunchEntry(s: ServerState, id: string, now: number): (CompanionStudyPlanOverviewEntry & { cardIds?: string[] }) | undefined {
    if (s.domain.snapshot?.studyTarget?.id === id) {
      const target = s.domain.snapshot.studyTarget, effective = this.effectiveSnapshot(s, now);
      if (!target.enabled || now >= target.transitionEndAt || !effective || s.domain.revoked || !companionSnapshotIsCurrent(effective, now)) return;
      const cards = miniAppStudyTargetCards(s, effective, now);
      return { id, title: `Подготовка к ${target.targetDate.split("-").reverse().join(".")}`, mode: "core", startAt: now, notifyAt: now,
        materialIds: [...new Set(cards.map(card => card.materialId))], cardIds: cards.map(card => card.id) };
    }
    if (!this.planWindowAllowed(s, now)) return;
    const entry = (s.studyPlan!.overview ?? s.studyPlan!.entries).find(row => row.id === id);
    return entry && (entry.materialIds.length ? entry.materialIds.every(materialId => s.materialConsentIds?.includes(materialId)) : !!s.materialConsentIds?.length) ? entry : undefined;
  }
  async miniAppMedia(id: string, now = Date.now()): Promise<{ asset: CompanionMediaAttachment; bytes: Uint8Array }> {
    timestamp(now); invalid(typeof id === "string" && /^[a-f0-9]{64}$/.test(id));
    return this.serial(async () => {
      invalid(this.active && this.media); const state = cloneServerState(this.state); if (expireMiniAppSession(state, now)) await this.commit(state);
      const asset = miniAppMediaAsset(this.state, id, now);
      const stored = await this.media.read(id); invalid(canonical(stored.asset) === canonical({ id: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes }));
      invalid(this.active); miniAppMediaAsset(this.state, id, Math.max(now, Date.now()));
      return { asset, bytes: stored.bytes };
    });
  }
  ownsPoll(pollId: string, userId: number): boolean {
    // Ownership survives a failed later commit; webhook still requires an active runtime.
    return userId === this.config.ownerUserId && validNativePollId(pollId)
      && (this.state?.outbox.some(row => row.method === "sendPoll" && row.status === "sent" && row.messageId !== undefined && row.pollPanel?.pollId === pollId) ?? false);
  }
  pollDeliveryPending(): boolean { return !!this.flushing && this.state.outbox.some(row => row.method === "sendPoll" && row.status === "unknown" && row.pollPanel?.pollId === undefined); }
  ownsCallback(handle: string): boolean { return this.state?.handles.some(row => row.id === handle) ?? false; }
  ownsReply(messageId: number): boolean {
    return this.state?.outbox.some(row => row.method === "sendMessage" && row.status === "sent" && row.messageId === messageId && row.answerHandle !== undefined) ?? false;
  }
  replyDeliveryPending(): boolean {
    return !!this.flushing && this.state.outbox.some(row => row.method === "sendMessage" && row.status === "unknown" && row.answerHandle !== undefined);
  }
  ownsPlanLaunch(planId: string, now: number): boolean {
    return !!this.state && !!this.config.miniAppUrl && !!this.planLaunchEntry(this.state, planId, now);
  }
  private sealPoll(s: ServerState, panel: Outbound, now = Date.now()): string | undefined {
    const p = panel.pollPanel; invalid(p); p.sealed = true;
    const existing = s.outbox.find(row => row.method === "stopPoll" && row.target === panel.id); if (existing) return existing.id;
    if (panel.status !== "sent" || panel.messageId === undefined || p.pollId === undefined) return;
    if (typeof panel.payload.close_date === "number" && now >= panel.payload.close_date * 1000) return;
    return this.enqueue(s, "stopPoll", { chat_id: this.config.ownerChatId, pollId: p.pollId }, undefined, undefined, panel.id, panel.id);
  }
  private pollAllowed(s: ServerState, panel: Outbound, now: number): boolean {
    const p = panel.pollPanel, source = p && storedPollCard(s, panel), session = s.studySession;
    if (!p || p.sealed || !source || !session || session.id !== p.sessionId || session.status === "finished" || now >= p.expiresAt || typeof panel.payload.close_date === "number" && now >= panel.payload.close_date * 1000 || now >= source.snapshot.expiresAt
      || !s.domain.snapshot || now >= s.domain.snapshot.expiresAt || !(s.materialConsentIds?.includes(source.card.materialId) ?? true)
      || s.attachmentConsent === false && (!!source.card.hints?.length || !!source.card.media?.length)) return false;
    if (source.card.offline && (s.offlineConsent !== true || now >= decodeOfflineSeed(source.card.offline).expiresAt)) return false;
    const head = source.card.offline && s.offlineHeads?.find(row => row.cardId === p.cardId);
    const live = head ? projectOfflineCard(head) : s.domain.snapshot.cards.find(card => card.id === p.cardId && card.revision === p.revision);
    return !!live && canonical(live) === canonical(source.card) && session.current?.id === p.cardId && session.current.revision === p.revision;
  }
  private pollCard(s: ServerState, panel: Outbound, now: number): SelectedCard {
    invalid(panel.status === "sent" && panel.messageId !== undefined && panel.pollPanel?.pollId !== undefined && this.pollAllowed(s, panel, now), "stale poll");
    const card = this.effectiveSnapshot(s, now)?.cards.find(row => row.id === panel.pollPanel!.cardId && row.revision === panel.pollPanel!.revision);
    invalid(card && !s.studySession?.deferred?.includes(card.id) && !this.suppressed(s).some(row => row.cardId === card.id), "stale poll"); return card;
  }
  private retirePolls(s: ServerState, now: number): boolean {
    let changed = false;
    for (const row of [...s.outbox]) if (row.pollPanel && !row.pollPanel.sealed && !this.pollAllowed(s, row, now)) {
      if (row.status === "queued") this.cancelQueuedContent(s, new Set([row.id]));
      else if (row.status === "sent" && row.payload.close_date !== undefined && now >= row.pollPanel.expiresAt) row.pollPanel.sealed = true;
      else this.sealPoll(s, row, now);
      changed = true;
    }
    return changed;
  }
  private pollAnswer(s: ServerState, pollId: string, optionIds: number[], now: number): void {
    const panel = s.outbox.find(row => row.method === "sendPoll" && row.status === "sent" && row.pollPanel?.pollId === pollId); invalid(panel, "unowned poll");
    if (panel.pollPanel!.sealed || optionIds.length === 0) return;
    const card = this.pollCard(s, panel, now), exercise = card.exercise!; invalid(exercise.kind === "single" || exercise.kind === "multiple");
    invalid(optionIds.every(index => index < exercise.options.length) && (exercise.kind === "multiple" || optionIds.length === 1), "invalid poll selection");
    panel.pollPanel!.selection = [...optionIds];
    const after = this.sealPoll(s, panel, now); invalid(after);
    this.card(s, card, now, true, evaluateCompanionExercise(exercise, { selectedOptionIndexes: optionIds }), panel.pollPanel!.expiresAt, after,
      createCompanionExerciseFeedback(exercise, { selectedOptionIndexes: optionIds }));
  }
  private id(): string { return randomBytes(24).toString("base64url"); }
  private richDemo(s: ServerState, now: number): void {
    invalid(s.handles.length <= 9994);
    const id = this.enqueue(s, "sendRichMessage", {}), panel = s.outbox.find(row => row.id === id)!, expiresAt = now + 30 * 60000;
    const control = (operation: "toggle" | "check" | "reset", index?: number): string => {
      const handle = this.id(); s.handles.push({ id: handle, epoch: this.config.epoch, sequence: 0, expiresAt,
        action: { kind: "rich-demo", panelId: id, operation, ...(index === undefined ? {} : { index }) } }); return handle;
    };
    const toggleHandles = [0, 1, 2, 3].map(index => control("toggle", index)) as [string, string, string, string];
    panel.richDemoPanel = { selectedOptionIndexes: [], checked: false, expiresAt };
    panel.payload = { chat_id: this.config.ownerChatId, disable_notification: true, rich_message: richCheckboxDemoView({
      selectedOptionIndexes: [], checked: false, toggleHandles, checkHandle: control("check"), resetHandle: control("reset") }) };
  }
  private actRichDemo(s: ServerState, action: Action, handleId: string | undefined, now: number): void {
    const panel = s.outbox.find(row => row.id === action.panelId), p = panel?.richDemoPanel;
    invalid(panel?.method === "sendRichMessage" && p && panel.status === "sent" && panel.messageId !== undefined && now < p.expiresAt, "stale rich demo");
    const view = readRichCheckboxDemoMessage(panel.payload.rich_message), index = Number(action.index);
    const expected = action.operation === "toggle" ? view.toggleHandles[index] : action.operation === "check" ? view.checkHandle : action.operation === "reset" ? view.resetHandle : undefined;
    invalid(handleId && expected === handleId, "unowned rich demo control");
    const before = canonical(p);
    if (action.operation === "toggle") { p.selectedOptionIndexes = p.selectedOptionIndexes.includes(index) ? p.selectedOptionIndexes.filter(value => value !== index) : [...p.selectedOptionIndexes, index].sort((a, b) => a - b); p.checked = false; }
    else if (action.operation === "check") p.checked = true;
    else { p.selectedOptionIndexes = []; p.checked = false; }
    if (canonical(p) === before) return;
    // A newer explicit selection replaces only unsent views, never an uncertain HTTP request.
    s.outbox = s.outbox.filter(row => !(row.status === "queued" && row.method === "editMessageText" && row.target === panel.id && row.payload.rich_message !== undefined));
    this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, rich_message: richCheckboxDemoView({ ...view,
      selectedOptionIndexes: p.selectedOptionIndexes, checked: p.checked }) }, undefined, undefined, panel.id, panel.id);
  }
  private enqueue(s: ServerState, method: Outbound["method"], payload: Record<string, unknown>, snapshotSequence?: number, answerHandle?: string, after?: string, target?: string, mediaPlaceholder?: true): string { const id = this.id(); s.outbox.push({ id, method, payload, status: "queued", ...(snapshotSequence === undefined ? {} : { snapshotSequence }), ...(answerHandle === undefined ? {} : { answerHandle }), ...(after === undefined ? {} : { after }), ...(target === undefined ? {} : { target }), ...(mediaPlaceholder === undefined ? {} : { mediaPlaceholder }) }); return id; }
  private keyboard(s: ServerState, buttons: CompanionMessage["buttons"], now: number, deadline?: number, reuse = false) {
    return groupCompanionButtons(buttons, b => {
      const existing = reuse && s.handles.find(h => now < h.expiresAt && h.expiresAt <= (deadline ?? Infinity) && h.sequence === s.domain.snapshot?.sequence && canonical(h.action) === canonical(b.action));
      if (existing) return { text: b.text, callback_data: existing.id, ...(b.style ? { style: b.style } : {}) };
      const id = this.id(), grade = ["change-grade", "replace-grade", "change-saved-grade", "replace-saved-grade", "hint-panel"].includes(String(b.action.kind)) || String(b.action.kind).startsWith("session-"), control = grade || ["status", "snooze", "skip", "notifications"].includes(String(b.action.kind));
      const expiresAt = s.domain.snapshot?.expiresAt ?? now + 86400000;
      s.handles.push({ id, epoch: this.config.epoch, sequence: control ? 0 : s.domain.snapshot?.sequence ?? 0,
        expiresAt: grade ? Math.min(deadline ?? expiresAt, expiresAt) : control ? now + 86400000 : Math.min(expiresAt, deadline ?? expiresAt), action: clone(b.action) });
      return { text: b.text, callback_data: id, ...(b.style ? { style: b.style } : {}) };
    });
  }
  private message(s: ServerState, m: CompanionMessage, now: number, after?: string, contentSequence?: number, deadline?: number): string {
    invalid(m.text.length > 0 && m.text.length <= 4096 && m.buttons.length <= 100);
    if (m.entities !== undefined) validateCompanionSpoilers(m.text, m.entities);
    const entities = m.entities === undefined ? {} : { entities: clone(m.entities) };
    if (m.answerAction) {
      const id = this.id(), snapshot = s.domain.snapshot; invalid(snapshot);
      s.handles.push({ id, epoch: this.config.epoch, sequence: snapshot.sequence, expiresAt: Math.min(snapshot.expiresAt, deadline ?? snapshot.expiresAt), action: clone(m.answerAction) });
      const prompt = this.enqueue(s, "sendMessage", { chat_id: this.config.ownerChatId, text: m.text, ...entities, disable_notification: m.disableNotification ?? false, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: this.keyboard(s, m.buttons, now, deadline), force_reply: true } }, snapshot.sequence, id, after);
      return prompt;
    }
    const inline_keyboard = this.keyboard(s, m.buttons, now, deadline);
    return this.enqueue(s, "sendMessage", { chat_id: this.config.ownerChatId, text: m.text, ...entities, disable_notification: m.disableNotification ?? false, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard } }, contentSequence ?? (m.buttons.some(b => ["material", "reveal", "review", "hint", "more", "all", "search"].includes(String(b.action.kind))) ? s.domain.snapshot?.sequence : undefined), undefined, after);
  }
  private hintCard(s: ServerState, panel: Outbound, now: number): SelectedCard {
    const p = panel.hintPanel, session = s.studySession;
    invalid(p && session?.id === p.sessionId && now < p.expiresAt && now < session.snapshot.expiresAt, "stale hints");
    const card = sessionCards(session).find(card => card.id === p.cardId && card.revision === p.revision);
    invalid(card?.hints?.length && p.count <= card.hints.length && s.materialConsentIds?.includes(card.materialId) && s.attachmentConsent !== false, "hint consent revoked");
    if (!session.results.some(row => row.cardId === card.id && (row.card?.revision ?? card.revision) === p.revision)) {
      const current = this.effectiveSnapshot(s, now)?.cards.find(row => row.id === card.id);
      const superseded = s.supersededOfflineReviews?.some(row => row.attempt.id === p.revision && row.attempt.cardId === card.id);
      const closedSummary = (session.status === "finished" || session.deferred?.includes(card.id) || superseded) && p.readOnly && p.collapsed;
      invalid(closedSummary || session.status !== "finished" && !session.skipped.includes(card.id) && !session.deferred?.includes(card.id) && s.domain.snapshot && now < s.domain.snapshot.expiresAt
        && panel.snapshotSequence === s.domain.snapshot.sequence && current?.eligible && canonical(current) === canonical(card), "stale hints");
    }
    return card;
  }
  private updateHintPanel(s: ServerState, panel: Outbound, now: number): void {
    const p = panel.hintPanel!, card = this.hintCard(s, panel, now), snapshot = s.domain.snapshot!;
    const view = hintPanelView(card.hints!, p.count, p.index, p.collapsed);
    const superseded = s.supersededOfflineReviews?.some(row => row.attempt.id === p.revision && row.attempt.cardId === p.cardId);
    const retired = (s.studySession!.status === "finished" || s.studySession!.deferred?.includes(p.cardId) || superseded)
      && !s.studySession!.results.some(row => row.cardId === p.cardId && (row.card?.revision ?? p.revision) === p.revision);
    const last = [...s.outbox].reverse().find(row => row.method === "editMessageText" && row.target === panel.id)?.payload ?? panel.payload;
    if (retired && last.text === view.text && (last.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length === 0) return;
    s.handles = s.handles.filter(h => !(h.action.kind === "hint-panel" && h.action.panelId === panel.id)
      && !(h.action.kind === "hint" && h.action.cardId === p.cardId));
    const show = (index: number, collapsed = false): Action => ({ kind: "hint-panel", panelId: panel.id, index, collapsed });
    const buttons: CompanionMessage["buttons"] = retired ? [] : p.collapsed ? [{ text: "Показать подсказки", action: show(p.count - 1) }] : [
      ...(view.paged && p.index > 0 ? [{ text: "Предыдущая подсказка", action: show(p.index - 1) }] : []),
      ...(view.paged && p.index + 1 < p.count ? [{ text: "Следующая открытая подсказка", action: show(p.index + 1) }] : []),
      ...(!p.readOnly && p.count < card.hints!.length ? [{ text: "Следующая подсказка", action: { kind: "hint", cardId: card.id, revision: card.revision,
        scope: snapshot.scope, epoch: snapshot.epoch, sequence: snapshot.sequence, index: p.count } }] : []),
      { text: "Свернуть подсказки", action: show(p.index, true) }
    ];
    const reply_markup = { inline_keyboard: this.keyboard(s, buttons, now, p.expiresAt) }; validateHintPanelEdit(view.text, reply_markup);
    // A grade replaces a queued reveal; only already-started HTTP may finish first.
    s.outbox = s.outbox.filter(row => !(row.method === "editMessageText" && row.target === panel.id && row.status === "queued"));
    if (panel.status === "queued") { panel.payload.text = view.text; panel.payload.reply_markup = reply_markup; return; }
    if (panel.status !== "sent" || panel.messageId === undefined) return;
    const id = this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, text: view.text, reply_markup, link_preview_options: { is_disabled: true } }, panel.snapshotSequence, undefined, panel.id, panel.id);
    s.outbox.find(row => row.id === id)!.sessionContent = { sessionId: p.sessionId };
  }
  private freezeHints(s: ServerState, cardId: string, now: number, collapse: boolean, revision?: string): void {
    for (const panel of [...s.outbox]) {
      const p = panel.hintPanel;
      if (!p || p.cardId !== cardId || p.sessionId !== s.studySession?.id || now >= p.expiresAt || revision !== undefined && p.revision !== revision) continue;
      p.readOnly = true;
      if (collapse) {
        p.collapsed = true;
        delete panel.snapshotSequence;
      }
      this.updateHintPanel(s, panel, now);
    }
  }
  private gradePanel(s: ServerState, attempt: ReviewAttempt, now: number, stage: GradePanelStage, answerMatch?: boolean, deadline?: number, original?: Outbound): void {
    if (s.miniAppAttempts?.some(row => row.id === attempt.id)) return;
    const panels = s.outbox.filter(row => row.ratingPanel?.attemptId === attempt.id);
    if (!original && panels.length > 1) { for (const panel of panels) this.gradePanel(s, attempt, now, stage, answerMatch, deadline, panel); return; }
    const binding = { attemptId: attempt.id, ...(answerMatch === undefined ? {} : { answerMatch }) };
    const editable = s.editableGrades?.find(row => row.attemptId === attempt.id && row.expiresAt > now);
    const savedBinding = editable && { attemptId: attempt.id, expectedReviewEventId: editable.reviewEventId };
    const buttons: CompanionMessage["buttons"] = stage === "selected" ? [{ text: "Изменить оценку", action: { kind: "change-grade", ...binding } }]
      : stage === "applied" && savedBinding ? [{ text: "Изменить оценку", action: { kind: "change-saved-grade", ...savedBinding } }]
      : stage === "changing" ? ((editable?.answerMatch ?? answerMatch) === true ? [2, 3, 4] as const : [1, 2, 3, 4] as const).map(rating => ({ text: GRADE_LABELS[rating - 1], action: savedBinding
        ? { kind: "replace-saved-grade", ...savedBinding, rating, correct: rating !== 1 }
        : { kind: "replace-grade", ...binding, rating, correct: rating !== 1 } })) : [];
    const panel = original?.ratingPanel ? original : s.outbox.find(row => row.ratingPanel?.attemptId === attempt.id);
    const answerText = panel?.ratingPanel?.answerText !== undefined && ratingAnswerAllowed(s, panel, now) ? panel.ratingPanel.answerText : undefined;
    const text = gradePanelText(attempt.rating, stage, answerText);
    if (!panel) {
      const id = this.message(s, { text, buttons, disableNotification: true }, now, undefined, undefined, deadline);
      s.outbox.find(row => row.id === id)!.ratingPanel = { cardId: attempt.cardId, revision: attempt.revision, attemptId: attempt.id, ...(answerMatch === undefined ? {} : { answerMatch }) }; return;
    }
    invalid(panel.ratingPanel?.cardId === attempt.cardId && panel.ratingPanel.revision === attempt.revision);
    panel.ratingPanel.attemptId = attempt.id;
    if (answerMatch !== undefined) panel.ratingPanel.answerMatch = answerMatch;
    // Plain feedback can outlive its source; a retained answer keeps its original source lease.
    if (panel.ratingPanel.answerText === undefined) delete panel.snapshotSequence;
    const last = [...s.outbox].reverse().find(row => row.method === "editMessageText" && row.target === panel.id);
    if (!buttons.length && last?.payload.text === text) return;
    const reply_markup = { inline_keyboard: this.keyboard(s, buttons, now, deadline) }; validateGradePanelEdit(text, reply_markup, panel.ratingPanel.answerText);
    if (panel.status === "queued") { panel.payload.text = text; panel.payload.reply_markup = reply_markup; return; }
    // Coalesce unstarted updates; in-flight edits remain ordered by the serialized sender.
    s.outbox = s.outbox.filter(row => !(row.method === "editMessageText" && row.target === panel.id && row.status === "queued"));
    this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, text, link_preview_options: { is_disabled: true }, reply_markup }, undefined, undefined, panel.id, panel.id);
  }
  private resultAttempt(s: ServerState, id: string): ReviewAttempt | undefined {
    hydrateResult(s, this.journal.results, this.config.scope, this.config.epoch, id, Date.now());
    const attempt = s.domain.pending.find(row => row.id === id) ?? s.domain.outcomes.find(row => row.attempt.id === id)?.attempt;
    if (!attempt) return;
    const corrected = [...(s.gradeCorrections ?? [])].reverse().find(row => row.correction.attemptId === id && row.receipt?.status === "applied");
    return corrected ? { ...attempt, rating: corrected.correction.rating, correct: corrected.correction.correct } : attempt;
  }
  private sessionPanel(s: ServerState, now: number): void {
    const session = s.studySession; invalid(session);
    const buttons: CompanionMessage["buttons"] = session.status === "finished" ? [{ text: "История", action: { kind: "session-history", sessionId: session.id } }, { text: "Новое занятие", action: { kind: "session-new", sessionId: session.id } }]
      : [{ text: "История", action: { kind: "session-history", sessionId: session.id } },
        { text: session.status === "paused" || session.waitUntil !== undefined ? "Продолжить" : "Пауза", action: { kind: session.status === "paused" || session.waitUntil !== undefined ? "session-resume" : "session-pause", sessionId: session.id } },
        { text: "Завершить", action: { kind: "session-finish", sessionId: session.id } }];
    const text = studySessionText(new Set(session.results.map(row => row.cardId)).size, session.snapshot.cards.length, session.status, session.deferred?.length ?? 0,
      { answers: session.results.length, waitUntil: session.waitUntil, timeZone: this.config.timeZone });
    const panel = s.outbox.find(row => row.sessionPanel?.sessionId === session.id);
    if (!panel) { const id = this.message(s, { text, buttons, disableNotification: true }, now, undefined, undefined, session.snapshot.expiresAt); s.outbox.find(row => row.id === id)!.sessionPanel = { sessionId: session.id }; return; }
    const last = [...s.outbox].reverse().find(row => row.method === "editMessageText" && row.target === panel.id);
    if ((last?.payload.text ?? panel.payload.text) === text) return;
    const reply_markup = { inline_keyboard: this.keyboard(s, buttons, now, session.snapshot.expiresAt) }; validateSessionPanelEdit(text, reply_markup);
    if (panel.status === "queued") { panel.payload.text = text; panel.payload.reply_markup = reply_markup; return; }
    s.outbox = s.outbox.filter(row => !(row.method === "editMessageText" && row.target === panel.id && row.status === "queued"));
    this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, text, reply_markup, link_preview_options: { is_disabled: true } }, undefined, undefined, panel.id, panel.id);
  }
  private sessionHistory(s: ServerState, now: number, offset = 0): void {
    const session = s.studySession; invalid(session && Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000);
    if (now >= session.snapshot.expiresAt) { this.message(s, { text: "Данные занятия устарели. Начните новое занятие через /go.", buttons: [] }, now); return; }
    const rows = session.results.slice(offset, offset + 15);
    const buttons: CompanionMessage["buttons"] = rows.map((row, index) => {
      const card = row.card ?? session.snapshot.cards.find(card => card.id === row.cardId)!, attempt = this.resultAttempt(s, row.attemptId);
      return { text: `${offset + index + 1}. ${card.question.replace(/\s+/g, " ").slice(0, 60)} · ${attempt ? GRADE_LABELS[attempt.rating - 1] : "нет результата"}`, action: { kind: "session-result", sessionId: session.id, cardId: row.cardId, ...(row.card?.offline ? { attemptId: row.attemptId } : {}) } };
    });
    if (offset > 0) buttons.push({ text: "Предыдущие результаты", action: { kind: "session-history", sessionId: session.id, offset: Math.max(0, offset - 15) } });
    if (offset + 15 < session.results.length) buttons.push({ text: "Следующие результаты", action: { kind: "session-history", sessionId: session.id, offset: offset + 15 } });
    if (session.status !== "finished") buttons.push({ text: "Продолжить занятие", action: { kind: "session-resume", sessionId: session.id } });
    buttons.push(session.status === "finished" ? { text: "Новое занятие", action: { kind: "session-new", sessionId: session.id } } : { text: "Завершить занятие", action: { kind: "session-finish", sessionId: session.id } });
    const completed = new Set(session.results.map(row => row.cardId)).size;
    const id = this.message(s, { text: `История занятия · ${completed} из ${session.snapshot.cards.length}${session.results.length > completed ? `\nОтветов: ${session.results.length}.` : ""}${session.deferred?.length ? `\nПропущено: ${session.deferred.length}.` : ""}${session.skipped.length ? `\nНедоступных карточек: ${session.skipped.length}.` : ""}\n${rows.length ? "Выберите результат для просмотра или изменения оценки." : "Оценок пока нет."}`, buttons, disableNotification: true }, now, undefined, undefined, session.snapshot.expiresAt);
    s.outbox.find(row => row.id === id)!.sessionContent = { sessionId: session.id };
  }
  private sessionResult(s: ServerState, now: number, cardId: string, attemptId?: string): void {
    const session = s.studySession, result = session?.results.find(row => row.cardId === cardId && (attemptId === undefined || row.attemptId === attemptId)), card = result?.card ?? session?.snapshot.cards.find(card => card.id === cardId);
    const attempt = result && this.resultAttempt(s, result.attemptId); invalid(session && card && attempt && now < session.snapshot.expiresAt);
    const content = (id: string): string => { s.outbox.find(row => row.id === id)!.sessionContent = { sessionId: session.id }; return id; };
    const sourcePanel = s.outbox.find(row => row.ratingPanel?.attemptId === attempt.id && row.ratingPanel.cardId === cardId && row.ratingPanel.revision === attempt.revision && row.ratingPanel.answerMatch !== undefined)?.ratingPanel;
    const answerMatch = sourcePanel?.answerMatch, exerciseFeedback = sourcePanel?.exerciseFeedback;
    const rendered = renderCard(card, session.snapshot, true, exerciseFeedback === undefined ? undefined : answerMatch, false, [], false, true, exerciseFeedback);
    const combined = !card.media?.length && combinedGradeText(rendered.text, GRADE_PROMPT) !== undefined;
    let after = combined ? undefined : content(this.message(s, { ...rendered, buttons: [] }, now));
    for (const asset of card.media ?? []) {
      const sequence = s.domain.snapshot?.sequence ?? session.snapshot.sequence;
      const placeholder = content(this.enqueue(s, "sendMessage", { chat_id: this.config.ownerChatId, text: loadingText(asset.kind), disable_notification: true, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } }, sequence, undefined, after, undefined, true));
      after = content(this.enqueue(s, "editMessageMedia", { chat_id: this.config.ownerChatId, assetId: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes, side: asset.side, ...(asset.caption === undefined ? {} : { caption: asset.caption }), disable_notification: true }, sequence, undefined, placeholder, placeholder));
    }
    const pending = s.domain.pending.some(row => row.id === attempt.id), outcome = s.domain.outcomes.find(row => row.attempt.id === attempt.id);
    const stage: GradePanelStage = pending ? s.claimedAttempts?.includes(attempt.id) ? "sent" : "selected" : outcome?.status === "applied" ? "applied" : "rejected";
    const id = content(this.message(s, { text: gradePanelText(attempt.rating, stage, combined ? rendered.text : undefined), buttons: [], disableNotification: true }, now, after, combined ? session.snapshot.sequence : undefined));
    const panel = s.outbox.find(row => row.id === id)!; panel.ratingPanel = { cardId, revision: attempt.revision, attemptId: attempt.id, ...(answerMatch === undefined ? {} : { answerMatch }), ...(combined ? { answerText: rendered.text } : {}),
      ...(exerciseFeedback === undefined ? {} : { exerciseFeedback: clone(exerciseFeedback) }) };
    this.gradePanel(s, attempt, now, stage, answerMatch, session.snapshot.expiresAt, panel);
  }
  private sessionNext(s: ServerState, now: number): void {
    const session = s.studySession; invalid(session);
    if (session.status === "paused") { this.sessionPanel(s, now); return; }
    if (session.status === "finished") { this.sessionPanel(s, now); this.sessionHistory(s, now); return; }
    const effective = this.effectiveSnapshot(s, now), available: SelectedCard[] = []; let waitUntil: number | undefined;
    delete session.waitUntil;
    for (const original of session.snapshot.cards) {
      const answered = session.results.some(row => row.cardId === original.id);
      if (!original.offline && answered || session.skipped.includes(original.id) || session.deferred?.includes(original.id)) continue;
      const card = effective?.cards.find(card => card.id === original.id && card.eligible);
      const head = s.offlineHeads?.find(head => head.cardId === original.id);
      if (!card || now >= session.snapshot.expiresAt || (!original.offline && canonical(card) !== canonical(original))
        || original.offline && (!head || head.seed !== original.offline) || this.suppressed(s).some(attempt => attempt.cardId === original.id)) { session.skipped.push(original.id); continue; }
      if (head && answered && !stateIsShortStep(head.state)) continue;
      if (card.offline && card.dueAt! > now) { if (head && stateIsShortStep(head.state)) waitUntil = Math.min(waitUntil ?? Infinity, card.dueAt!); continue; }
      available.push(card);
    }
    available.sort((a, b) => Number(!!s.offlineHeads?.some(head => head.cardId === b.id && head.index > 0 && stateIsShortStep(head.state))) - Number(!!s.offlineHeads?.some(head => head.cardId === a.id && head.index > 0 && stateIsShortStep(head.state))));
    const next = available[0];
    if (next && session.results.length < 1000) { session.current = clone(next); if (next.offline && !session.frames?.some(card => card.id === next.id && card.revision === next.revision)) (session.frames ??= []).push(clone(next)); this.sessionPanel(s, now); this.card(s, next, now); return; }
    delete session.current;
    if (waitUntil !== undefined && session.results.length < 1000) { session.waitUntil = waitUntil; this.sessionPanel(s, now); return; }
    this.finishSession(s, now);
  }
  private finishSession(s: ServerState, now: number, quiet = false): void {
    const session = s.studySession; invalid(session); session.status = "finished";
    for (const row of s.outbox) if (row.pollPanel?.sessionId === session.id && !row.pollPanel.sealed) this.sealPoll(s, row, now);
    delete session.waitUntil; delete session.current;
    const unfinished = new Set(session.snapshot.cards.filter(card => card.offline || !session.results.some(row => row.cardId === card.id)).map(card => card.id));
    const removed = new Set(s.handles.filter(handle => unfinished.has(String(handle.action.cardId)) && ["answer", "reveal", "hint", "review", "select-option", "toggle-option", "submit-options", "skip-card"].includes(String(handle.action.kind))).map(handle => handle.id));
    s.handles = s.handles.filter(handle => !removed.has(handle.id));
    this.cancelQueuedContent(s, new Set(s.outbox.filter(row => row.status === "queued" && (row.answerHandle && removed.has(row.answerHandle)
      || row.hintLease && unfinished.has(row.hintLease.cardId) || (row.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] })?.inline_keyboard?.some(buttons => buttons.some(button => removed.has(button.callback_data))))).map(row => row.id)));
    for (const cardId of unfinished) this.freezeHints(s, cardId, now, true);
    if (!quiet) { this.sessionPanel(s, now); this.sessionHistory(s, now); }
  }
  private cancelSessionContent(s: ServerState): void {
    this.cancelQueuedContent(s, new Set(s.outbox.filter(row => row.status === "queued" && row.sessionContent && row.sessionContent.sessionId !== s.studySession?.id).map(row => row.id)));
  }
  private card(s: ServerState, card: SelectedCard, now: number, reveal = false, answerMatch?: boolean, deadline?: number, dependency?: string, exerciseFeedback?: CompanionExerciseFeedback): void {
    invalid(card.exercise?.kind !== "matching" && card.exercise?.kind !== "ordering", "This exercise is available in the Mini App");
    if (card.offline) { invalid(s.offlineConsent === true); deadline = Math.min(deadline ?? Infinity, decodeOfflineSeed(card.offline).expiresAt); }
    const previousOutboxIds = new Set(s.outbox.map(row => row.id));
    const replaceControls = card.evaluationMode === "exact" || !!card.media?.length;
    if (replaceControls || card.hints?.length) {
      // A newer prompt, typed answer or reveal replaces all older controls for this card.
      const removed = new Set(s.handles.filter(h => h.action.cardId === card.id && (replaceControls || h.action.kind === "hint")).map(h => h.id));
      s.handles = s.handles.filter(h => !removed.has(h.id));
      const cancelled = new Set(s.outbox.filter(o => o.status === "queued" && ((o.answerHandle !== undefined && removed.has(o.answerHandle)) ||
        (o.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard?.some(row => row.some(button => removed.has(button.callback_data))))).map(o => o.id));
      this.cancelQueuedContent(s, cancelled);
    }
    const showGuidance = s.domain.pending.length + s.domain.outcomes.length < 2;
    const snapshot = s.domain.snapshot!, rendered = renderCard(card, snapshot, reveal, answerMatch, showGuidance, [], false, true, exerciseFeedback);
    const hints = [...s.outbox].reverse().find(row => row.status !== "unknown" && row.hintPanel?.sessionId === s.studySession?.id && row.hintPanel?.cardId === card.id && row.hintPanel?.revision === card.revision);
    if (!reveal && hints?.hintPanel && now < hints.hintPanel.expiresAt) {
      rendered.buttons = rendered.buttons.map(button => button.action.kind !== "hint" ? button : { text: "Подсказки", action: {
        kind: "hint-panel", panelId: hints.id, index: hints.hintPanel!.count - 1, collapsed: false } });
    }
    const attachments = card.media?.filter(asset => asset.side === (reveal ? "answer" : "question")) ?? [];
    const combined = reveal && !attachments.length ? combinedGradeText(rendered.text, GRADE_PROMPT) : undefined;
    let after: string | undefined = dependency;
    if (!reveal) for (const row of s.outbox) if (row.pollPanel && row.pollPanel.sessionId === s.studySession?.id && !row.pollPanel.sealed) this.sealPoll(s, row, now);
    const pollContentStart = s.outbox.length;
    if (reveal && combined === undefined) after = this.message(s, { ...rendered, buttons: [] }, now, after, snapshot.sequence);
    for (const asset of attachments) {
      if (this.transport.cachedMedia?.(this.config.enrollment, asset)) {
        after = this.enqueue(s, mediaMethod(asset), { chat_id: this.config.ownerChatId, assetId: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes, side: asset.side,
          ...(asset.caption === undefined ? {} : { caption: asset.caption }), disable_notification: true }, snapshot.sequence, undefined, after);
        continue;
      }
      const placeholder = this.enqueue(s, "sendMessage", { chat_id: this.config.ownerChatId, text: loadingText(asset.kind), disable_notification: true, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } }, snapshot.sequence, undefined, after, undefined, true);
      after = this.enqueue(s, "editMessageMedia", { chat_id: this.config.ownerChatId, assetId: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes, side: asset.side,
        ...(asset.caption === undefined ? {} : { caption: asset.caption }), disable_notification: true }, snapshot.sequence, undefined, placeholder, placeholder);
    }
    if (reveal) {
      const id = this.message(s, { text: combined ?? GRADE_PROMPT, buttons: rendered.buttons }, now, after, snapshot.sequence, deadline);
      const panel = s.outbox.find(row => row.id === id)!;
      panel.ratingPanel = { cardId: card.id, revision: card.revision, ...(combined === undefined ? {} : { answerText: rendered.text }), ...(answerMatch === undefined ? {} : { answerMatch }),
        ...(exerciseFeedback === undefined ? {} : { exerciseFeedback: clone(exerciseFeedback) }) };
      if (combined !== undefined && s.studySession) panel.sessionContent = { sessionId: s.studySession.id, cardId: card.id, revision: card.revision };
      this.freezeHints(s, card.id, now, false);
    }
    else {
      const expiresAt = Math.min(snapshot.expiresAt, deadline ?? snapshot.expiresAt, s.studySession?.snapshot.expiresAt ?? snapshot.expiresAt);
      const pollExpiresAt = Math.floor(expiresAt / 1000) * 1000;
      const poll = this.transport.supportsNativePolls?.() === true && pollExpiresAt - now >= 10000 ? nativePollView(card) : undefined;
      if (poll && s.studySession) {
        const controls = rendered.buttons.filter(button => !["select-option", "toggle-option", "submit-options"].includes(String(button.action.kind)));
        const id = this.enqueue(s, "sendPoll", { chat_id: this.config.ownerChatId, ...poll, close_date: pollExpiresAt / 1000, disable_notification: false,
          reply_markup: { inline_keyboard: this.keyboard(s, controls, now, pollExpiresAt) } }, snapshot.sequence, undefined, after);
        const row = s.outbox.find(row => row.id === id)!;
        row.pollPanel = { cardId: card.id, revision: card.revision, sessionId: s.studySession.id, expiresAt: pollExpiresAt };
        // Include preceding question media in the same session grant; poll cleanup stays independent.
        for (const content of s.outbox.slice(pollContentStart)) content.sessionContent = { sessionId: s.studySession.id, cardId: card.id, revision: card.revision };
        return;
      }
      const id = this.message(s, rendered, now, after, snapshot.sequence, deadline);
      if (card.exercise || card.offline) {
        const panel = s.outbox.find(row => row.id === id)!; invalid(s.studySession);
        panel.questionPanel = { cardId: card.id, revision: card.revision, selectedOptionIndexes: [], expiresAt: Math.min(snapshot.expiresAt, deadline ?? snapshot.expiresAt),
          ...(card.exercise?.kind === "single" || card.exercise?.kind === "multiple" ? { choiceLayout: card.exercise.kind === "multiple" ? "checkboxes" as const : "adaptive" as const } : {}) };
        panel.sessionContent = { sessionId: s.studySession.id };
      }
    }
    if ((card.offline || exerciseFeedback !== undefined) && s.studySession) for (const row of s.outbox) if (!previousOutboxIds.has(row.id) && !row.ratingPanel && row.method !== "stopPoll") row.sessionContent = { sessionId: s.studySession.id, cardId: card.id, revision: card.revision };
  }
  private answer(s: ServerState, replyMessageId: number, text: string, now: number): void {
    const sent = s.outbox.find(o => o.method === "sendMessage" && o.status === "sent" && o.messageId === replyMessageId && o.answerHandle !== undefined);
    const h = sent && s.handles.find(h => h.id === sent.answerHandle);
    invalid(h && h.action.kind === "answer" && h.epoch === this.config.epoch && now < h.expiresAt, "stale");
    const snapshot = s.domain.snapshot; invalid(snapshot && sent.snapshotSequence === snapshot.sequence && h.sequence === snapshot.sequence && h.action.scope === snapshot.scope && h.action.epoch === snapshot.epoch && h.action.sequence === snapshot.sequence, "stale");
    const card = this.page(s, now, { kind: "answer" }).cards.find(c => c.id === h.action.cardId && c.revision === h.action.revision);
    invalid(card && card.evaluationMode === "exact", "stale");
    if (card.offline) invalid(sent.questionPanel && this.questionCard(s, sent, now).revision === card.revision);
    let matched: boolean, exerciseFeedback: CompanionExerciseFeedback | undefined;
    if (card.exercise) {
      invalid(card.exercise.kind === "cloze" && sent.questionPanel && this.questionCard(s, sent, now).id === card.id);
      const count = companionExerciseBlankCount(card.exercise), answers = count === 1 ? [text] : text.replace(/\r\n?/g, "\n").split("\n");
      if (answers.length !== count || answers.some(answer => !answer.trim())) {
        this.message(s, { text: `Нужно заполнить ${count} пропуска: отправьте каждый ответ с новой строки, без номеров.`, buttons: [] }, now); return;
      }
      matched = evaluateCompanionExercise(card.exercise, { clozeAnswers: answers });
      exerciseFeedback = createCompanionExerciseFeedback(card.exercise, { clozeAnswers: answers });
    } else matched = card.acceptedAnswers === undefined ? isExactTestAnswerCorrect(text, card.reference, card.answerMatchMode) : isExplicitTestAnswerCorrect(text, card.acceptedAnswers, card.answerMatchMode);
    this.card(s, card, now, true, matched, h.expiresAt, undefined, exerciseFeedback);
  }
  private questionCard(s: ServerState, panel: Outbound, now: number, requireDelivery = true): SelectedCard {
    const p = panel.questionPanel, session = s.studySession, snapshot = this.effectiveSnapshot(s, now);
    invalid(p && (!requireDelivery || panel.status === "sent" && panel.messageId !== undefined) && session && session.id === panel.sessionContent?.sessionId && session.status !== "finished"
      && now < p.expiresAt && snapshot && companionSnapshotIsCurrent(snapshot, now) && panel.snapshotSequence === snapshot.sequence, "stale question");
    const card = snapshot.cards.find(card => card.id === p.cardId && card.revision === p.revision && card.eligible);
    invalid(card && (card.exercise || card.offline) && sessionCards(session).some(row => canonical(row) === canonical(card)) && !session.deferred?.includes(card.id) && !session.skipped.includes(card.id)
      && !this.suppressed(s).some(attempt => attempt.cardId === card.id), "stale question");
    const buttons = (panel.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    invalid(s.handles.some(h => h.action.cardId === card.id && h.action.revision === card.revision && now < h.expiresAt
      && (h.id === panel.answerHandle || buttons.some(row => row.some(button => button.callback_data === h.id)))), "replaced question");
    return card;
  }
  private questionView(s: ServerState, panel: Outbound, card: SelectedCard, now: number): CompanionMessage {
    const view = renderCard(card, s.domain.snapshot!, false, undefined, false, panel.questionPanel!.selectedOptionIndexes,
      panel.questionPanel!.choiceLayout === undefined, panel.questionPanel!.choiceLayout === "checkboxes");
    view.text = panel.payload.text as string;
    const hints = [...s.outbox].reverse().find(row => row.status !== "unknown" && row.hintPanel?.sessionId === s.studySession?.id && row.hintPanel?.cardId === card.id && row.hintPanel?.revision === card.revision);
    if (hints?.hintPanel && now < hints.hintPanel.expiresAt) view.buttons = view.buttons.map(button => button.action.kind !== "hint" ? button : {
      text: "Подсказки", action: { kind: "hint-panel", panelId: hints.id, index: hints.hintPanel!.count - 1, collapsed: false } });
    return view;
  }
  private updateQuestionPanel(s: ServerState, panel: Outbound, card: SelectedCard, now: number): void {
    const view = this.questionView(s, panel, card, now);
    const reply_markup = { inline_keyboard: this.keyboard(s, view.buttons, now, panel.questionPanel!.expiresAt, true), ...(view.answerAction ? { force_reply: true } : {}) };
    validateQuestionPanelEdit(view.text, reply_markup);
    s.outbox = s.outbox.filter(row => !(row.method === "editMessageText" && row.target === panel.id && row.status === "queued"));
    const id = this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, text: view.text, reply_markup, link_preview_options: { is_disabled: true } }, panel.snapshotSequence, undefined, panel.id, panel.id);
    s.outbox.find(row => row.id === id)!.sessionContent = { ...panel.sessionContent! };
  }
  private effectiveSnapshot(s: ServerState, now: number, cardIds?: ReadonlySet<string>): CompanionSnapshot | undefined {
    const snapshot = s.domain.snapshot;
    if (!snapshot) return;
    const heads = new Map((s.offlineHeads ?? []).map(head => [head.cardId, head]));
    const knownRoots = new Set([...s.domain.pending, ...s.domain.outcomes.filter(row => row.status === "applied").map(row => row.attempt)]
      .filter(row => row.offline).map(row => `${row.cardId}:${decodeOfflineStep(row.offline!).rootRevision}`));
    for (const root of this.coldResultIndex(s).offlineRoots) knownRoots.add(root);
    const correcting = new Set(s.gradeCorrections?.filter(row => !row.receipt).map(row => row.correction.cardId));
    const { studyTarget: _studyTarget, ...effective } = snapshot;
    const indexed = cardIds && snapshotCardMap(snapshot);
    const cards = cardIds ? [...cardIds].flatMap(id => { const card = indexed!.get(id); return card ? [card] : []; }) : snapshot.cards;
    return { ...effective, cards: cards.flatMap(card => {
      if (!card.offline) return [card];
      const head = heads.get(card.id), seed = head ? decodeOfflineSeed(head.seed) : snapshotOfflineSeed(snapshot, card.id)!;
      if (s.offlineConsent !== true || now >= seed.expiresAt || now + COMPANION_CLOCK_SKEW < seed.issuedAt) return [];
      // Restoring consent cannot turn a known root event back into an unanswered baseline.
      if ((!head || head.index === 0) && knownRoots.has(`${card.id}:${seed.rootRevision}`)) return [];
      if (correcting.has(card.id)) return [];
      return [head ? projectOfflineCard(head) : card];
    }) };
  }
  private renewOfflineBaselines(s: ServerState, now: number): void {
    const snapshot = s.domain.snapshot;
    if (s.offlineConsent !== true || !snapshot || !companionSnapshotIsCurrent(snapshot, now)) return;
    const cards = snapshotCardMap(snapshot);
    s.offlineHeads = s.offlineHeads?.map(head => {
      const old = decodeOfflineSeed(head.seed), card = cards.get(head.cardId), next = card?.offline && decodeOfflineSeed(card.offline);
      // Only an already signed, matching desktop baseline can replace an expired lease.
      // Neither pending answers nor a correction can be rolled back by this renewal.
      if (old.expiresAt > now || !card || !next || next.expiresAt <= now || next.state !== head.state || next.rootRevision === old.rootRevision
        || s.domain.pending.some(attempt => attempt.cardId === head.cardId && attempt.offline) || s.gradeCorrections?.some(row => row.correction.cardId === head.cardId && !row.receipt)) return head;
      const { studyTarget: _studyTarget, ...baseline } = snapshot;
      return reconcileOfflineHeads([head], { ...baseline, cards: [card] }, now)[0];
    });
  }
  /** A new desktop baseline can replace settled ancestry after its presentation lease ends. */
  private retireSettledOfflineHeads(s: ServerState, now: number, replacingMiniApp = false): void {
    const snapshot = s.domain.snapshot; if (!snapshot || !companionSnapshotIsCurrent(snapshot, now)) return;
    const cards = snapshotCardMap(snapshot), protectedIds = new Set(s.domain.pending.map(row => row.cardId));
    for (const session of [s.studySession, ...(!replacingMiniApp || s.miniApp?.session.status !== "finished" ? [s.miniApp?.session] : [])])
      if (session && now < session.snapshot.expiresAt) for (const card of sessionCards(session)) protectedIds.add(card.id);
    for (const row of s.gradeCorrections ?? []) if (!row.receipt) protectedIds.add(row.correction.cardId);
    for (const handle of s.handles) if (handle.expiresAt > now && typeof handle.action.cardId === "string") protectedIds.add(handle.action.cardId);
    for (const row of s.outbox) if (row.ratingPanel && s.editableGrades?.some(grade => grade.attemptId === row.ratingPanel!.attemptId && grade.expiresAt > now)) protectedIds.add(row.ratingPanel.cardId);
    const authored = (card: SelectedCard): string => canonical(Object.fromEntries(Object.entries(card).filter(([key]) => !["offline", "revision", "dueAt", "eligible"].includes(key))));
    s.offlineHeads = s.offlineHeads?.filter(head => {
      if (protectedIds.has(head.cardId)) return true;
      const card = cards.get(head.cardId); if (!card?.offline) return true;
      const old = decodeOfflineSeed(head.seed), next = decodeOfflineSeed(card.offline);
      // Unchanged roots cannot be made unanswered again. Only native signed state is adopted.
      if (head.index > 0 && (old.rootRevision === next.rootRevision || head.state !== next.state)) return true;
      return old.config !== next.config || authored(head.baseCard) !== authored(card);
    });
  }
  private coldResultIndex(s: ServerState): { attempts: ReviewAttempt[]; offlineRoots: Set<string> } {
    const snapshot = s.domain.snapshot;
    if (!snapshot || !s.resultLedger?.archiveUsed) return { attempts: [], offlineRoots: new Set() };
    invalid(this.journal.results, "Result archive unavailable");
    if (this.coldResults?.snapshot !== snapshot || this.coldResults.revision !== s.resultLedger.archiveRevision)
      this.coldResults = { snapshot, revision: s.resultLedger.archiveRevision, value: this.journal.results.suppressed(snapshot) };
    return this.coldResults.value;
  }
  private suppressed(s: ServerState): ReviewAttempt[] {
    const cards = s.domain.snapshot && snapshotCardMap(s.domain.snapshot);
    return [...this.coldResultIndex(s).attempts, ...s.domain.pending.filter(attempt => !attempt.offline),
      ...s.domain.outcomes.filter(row => !row.attempt.offline && cards?.get(row.attempt.cardId)?.revision === row.attempt.revision).map(row => row.attempt)];
  }
  private carryCardControls(s: ServerState, next: CompanionSnapshot, now: number): Set<string> {
    const needed = new Set<string>();
    for (const handle of s.handles) if (typeof handle.action.cardId === "string") needed.add(handle.action.cardId);
    for (const row of s.outbox) for (const id of [row.hintLease?.cardId, row.questionPanel?.cardId, row.hintPanel?.cardId]) if (id) needed.add(id);
    const old = needed.size ? this.effectiveSnapshot(s, now, needed) : undefined, retained = new Set<string>(), deliveries = new Set<string>();
    const unchanged = new Map<string, SelectedCard>();
    if (old && old.scope === next.scope && old.epoch === next.epoch && companionSnapshotIsCurrent(old, now)) {
      const suppressed = new Set(this.suppressed(s).map(attempt => attempt.cardId));
      const nextCards = new Map<string, SelectedCard>(), heads = new Map<string, OfflineHead>();
      for (const card of next.cards) if (needed.has(card.id) && !nextCards.has(card.id)) nextCards.set(card.id, card);
      for (const head of s.offlineHeads ?? []) if (!heads.has(head.cardId)) heads.set(head.cardId, head);
      for (const card of old.cards) {
        const nextBase = nextCards.get(card.id), head = heads.get(card.id);
        const candidateHead = nextBase?.offline && head ? reconcileOfflineHeads([head], { ...next, cards: [nextBase] }, now)[0] : undefined;
        const current = candidateHead ? projectOfflineCard(candidateHead) : nextBase;
        // The capability alone is insufficient: every authored field and scheduling proof must match.
        if (card.eligible && current?.eligible && !suppressed.has(card.id) && canonical(card) === canonical(current)) unchanged.set(card.id, card);
      }
      for (const h of s.handles) {
        const card = typeof h.action.cardId === "string" ? unchanged.get(h.action.cardId) : undefined;
        if (!card || !["answer", "reveal", "hint", "review", "select-option", "toggle-option", "submit-options", "skip-card"].includes(String(h.action.kind)) || h.epoch !== old.epoch || h.sequence !== old.sequence
          || h.action.scope !== old.scope || h.action.epoch !== old.epoch || h.action.sequence !== old.sequence || h.action.revision !== card.revision || now >= h.expiresAt) continue;
        h.sequence = next.sequence; h.action.sequence = next.sequence; h.expiresAt = Math.min(h.expiresAt, next.expiresAt); retained.add(h.id);
      }
      for (const row of s.outbox) if (row.snapshotSequence === old.sequence && (row.answerHandle !== undefined && retained.has(row.answerHandle)
        || (row.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard?.some(buttons => buttons.some(button => retained.has(button.callback_data))))) deliveries.add(row.id);
      for (const row of s.outbox) {
        const lease = row.hintLease, card = lease && unchanged.get(lease.cardId), hint = lease && card?.hints?.[lease.index];
        if (!lease || !card || hint === undefined || row.status !== "queued" || row.snapshotSequence !== old.sequence || lease.revision !== card.revision || now >= lease.expiresAt) continue;
        const header = `Подсказка ${lease.index + 1} из ${card.hints!.length}:\n`;
        if (row.payload.text !== header + hint || canonical(row.payload.entities) !== canonical([{ type: "spoiler", offset: header.length, length: hint.length }])) continue;
        lease.expiresAt = Math.min(lease.expiresAt, next.expiresAt); deliveries.add(row.id);
      }
      for (const row of s.outbox) {
        const p = row.questionPanel, card = p && unchanged.get(p.cardId);
        if (!p || !card || row.sessionContent?.sessionId !== s.studySession?.id || p.revision !== card.revision || now >= p.expiresAt || row.snapshotSequence !== old.sequence) continue;
        p.expiresAt = Math.min(p.expiresAt, next.expiresAt); deliveries.add(row.id);
        for (const edit of s.outbox) if (edit.target === row.id && edit.snapshotSequence === old.sequence) deliveries.add(edit.id);
      }
      for (const row of s.outbox) {
        const p = row.hintPanel, card = p && unchanged.get(p.cardId);
        if (!p || !card || p.sessionId !== s.studySession?.id || p.revision !== card.revision || now >= p.expiresAt || row.snapshotSequence !== old.sequence) continue;
        p.expiresAt = Math.min(p.expiresAt, next.expiresAt); deliveries.add(row.id);
        for (const edit of s.outbox) if (edit.target === row.id && edit.snapshotSequence === old.sequence) deliveries.add(edit.id);
      }
      // A retained control owns its whole prerequisite chain, including loading placeholders and edits.
      for (const row of [...s.outbox].reverse()) if (deliveries.has(row.id) && row.after !== undefined) deliveries.add(row.after);
      for (const row of s.outbox) if (deliveries.has(row.id) && row.snapshotSequence === old.sequence) row.snapshotSequence = next.sequence;
    }
    s.handles = s.handles.filter(h => {
      if (h.action.kind === "hint-panel") {
        const panel = s.outbox.find(row => row.id === h.action.panelId), p = panel?.hintPanel;
        if (!panel || !p || p.sessionId !== s.studySession?.id || now >= p.expiresAt || now >= h.expiresAt) return false;
        return s.studySession!.results.some(row => row.cardId === p.cardId) || unchanged.has(p.cardId);
      }
      if (String(h.action.kind).startsWith("session-")) return s.studySession?.id === h.action.sessionId && now < h.expiresAt;
      if (["change-saved-grade", "replace-saved-grade"].includes(String(h.action.kind))) return s.editableGrades?.some(row => row.attemptId === h.action.attemptId && row.expiresAt > now) && now < h.expiresAt;
      if (["change-grade", "replace-grade"].includes(String(h.action.kind))) {
        const pending = s.domain.pending.find(attempt => attempt.id === h.action.attemptId);
        return pending && (pending.offline || next.cards.some(card => card.id === pending.cardId && card.revision === pending.revision)) && now < h.expiresAt;
      }
      return h.sequence === 0 || retained.has(h.id);
    });
    return deliveries;
  }
  private page(s: ServerState, now: number, action: Action) {
    const snapshot = this.effectiveSnapshot(s, now); invalid(snapshot, "stale");
    const chatSnapshot = { ...snapshot, cards: snapshot.cards.filter(card => card.exercise?.kind !== "matching" && card.exercise?.kind !== "ordering") };
    return queryCards(chatSnapshot, this.suppressed(s), { now, all: ["all", "material", "reveal", "review", "answer", "hint", "select-option", "toggle-option", "submit-options", "skip-card"].includes(String(action.kind)), materialId: typeof action.materialId === "string" ? action.materialId : undefined, search: typeof action.search === "string" ? action.search : undefined, cursor: typeof action.cursor === "string" ? action.cursor : undefined });
  }
  private retireChatStudy(s: ServerState, now: number): boolean {
    const active = !!s.studySession && s.studySession.status !== "finished", count = s.outbox.length;
    if (active) this.finishSession(s, now, true);
    this.cancelQueuedContent(s, new Set(s.outbox.filter(row => row.status === "queued" && (row.sessionContent || row.sessionPanel || row.hintLease || row.hintPanel || row.questionPanel || row.pollPanel || row.richDemoPanel
      || row.snapshotSequence !== undefined && !row.ratingPanel?.attemptId)).map(row => row.id)));
    // Cancelled legacy uploads do not need a new failure notice during the handoff.
    s.outbox = s.outbox.filter(row => row.status !== "queued" || row.payload.text !== MEDIA_LOADING_ERROR);
    return active || s.outbox.length !== count;
  }
  private miniAppLauncher(s: ServerState, now: number, planId?: string): void {
    invalid(this.config.miniAppUrl, "Mini App unavailable");
    if (planId !== undefined) invalid(this.planLaunchEntry(s, planId, now), "Study plan entry unavailable");
    this.retireChatStudy(s, now);
    if (s.outbox.some(row => row.status === "queued" && row.payload.text === MINI_APP_LAUNCH_TEXT && row.miniAppPlan === planId)) return;
    const id = this.message(s, { text: MINI_APP_LAUNCH_TEXT, buttons: [], disableNotification: true }, now);
    if (planId !== undefined) s.outbox.find(row => row.id === id)!.miniAppPlan = planId;
  }
  private act(s: ServerState, action: Action, now: number, handleId?: string, deadline?: number, delivery?: Outbound): void {
    if (this.config.miniAppUrl && !["status", "snooze", "skip", "notifications"].includes(String(action.kind))) { this.miniAppLauncher(s, now); return; }
    if (action.kind === "rich-demo") { this.actRichDemo(s, action, handleId, now); return; }
    if (["go", "material"].includes(String(action.kind)) && s.miniApp?.session.status === "active" && miniAppSessionAllowed(s, now)) {
      this.message(s, { text: "Занятие открыто в приложении. Продолжите или завершите его там, затем напишите /go.", buttons: [] }, now); return;
    }
    if (action.kind === "go") {
      this.renewOfflineBaselines(s, now);
      if (s.studySession && s.studySession.status !== "finished" && now >= s.studySession.snapshot.expiresAt && s.domain.snapshot && companionSnapshotIsCurrent(s.domain.snapshot, now)) this.finishSession(s, now);
    }
    const showGuidance = s.domain.pending.length + s.domain.outcomes.length < 2;
    const clickedPanel = delivery?.target ? s.outbox.find(row => row.id === delivery.target) : delivery;
    if (action.kind === "hint-panel") {
      const panel = s.outbox.find(row => row.id === action.panelId), p = panel?.hintPanel;
      invalid(panel && p && panel.status === "sent" && panel.messageId !== undefined && Number.isSafeInteger(action.index)
        && Number(action.index) >= 0 && Number(action.index) < p.count && typeof action.collapsed === "boolean", "stale hints");
      this.hintCard(s, panel, now);
      p.index = Number(action.index); p.collapsed = action.collapsed;
      this.updateHintPanel(s, panel, now); return;
    }
    if (String(action.kind).startsWith("session-")) {
      const session = s.studySession; invalid(session && session.id === action.sessionId, "stale session");
      if (action.kind === "session-history") { this.sessionHistory(s, now, Number(action.offset ?? 0)); return; }
      if (action.kind === "session-result") { this.sessionResult(s, now, String(action.cardId), action.attemptId === undefined ? undefined : String(action.attemptId)); return; }
      if (action.kind === "session-pause") { if (session.status !== "finished") session.status = "paused"; this.sessionPanel(s, now); return; }
      if (action.kind === "session-finish") { this.finishSession(s, now); return; }
      if (action.kind === "session-new") { invalid(session.status === "finished"); this.act(s, { kind: "go" }, now); return; }
      if (action.kind === "session-resume") { if (session.status !== "finished") session.status = "active"; this.sessionNext(s, now); return; }
    }
    if (action.kind === "go" && s.studySession && s.studySession.status !== "finished") { this.sessionNext(s, now); return; }
    if (action.kind === "change-saved-grade" || action.kind === "replace-saved-grade") {
      const attempt = this.resultAttempt(s, String(action.attemptId)); invalid(attempt);
      if (attempt.offline && s.offlineHeads?.find(head => head.cardId === attempt.cardId)?.lastAttemptId !== attempt.id) { this.gradePanel(s, attempt, now, "correction-rejected", undefined, deadline, clickedPanel); return; }
      const editable = s.editableGrades?.find(row => row.attemptId === attempt.id && row.expiresAt > now);
      const waiting = s.gradeCorrections?.find(row => row.correction.attemptId === attempt.id && !row.receipt);
      if (waiting) { this.gradePanel(s, { ...attempt, rating: waiting.correction.rating, correct: waiting.correction.correct }, now, "correcting", undefined, deadline, clickedPanel); return; }
      if (!editable) { this.gradePanel(s, attempt, now, "correction-rejected", undefined, deadline, clickedPanel); return; }
      if (editable.reviewEventId !== action.expectedReviewEventId) { this.gradePanel(s, attempt, now, "applied", undefined, deadline, clickedPanel); return; }
      if (action.kind === "change-saved-grade") { this.gradePanel(s, attempt, now, "changing", editable.answerMatch, Math.min(editable.expiresAt, deadline ?? editable.expiresAt), clickedPanel); return; }
      invalid(handleId && [1, 2, 3, 4].includes(Number(action.rating)) && action.correct === (action.rating !== 1) && !(editable.answerMatch === true && action.rating === 1));
      if (editable.rating === action.rating) { this.gradePanel(s, attempt, now, "applied", undefined, deadline, clickedPanel); return; }
      const correction: CompanionGradeCorrection = { id: handleId, scope: attempt.scope, epoch: attempt.epoch, attemptId: attempt.id, cardId: attempt.cardId, revision: attempt.revision,
        expectedReviewEventId: editable.reviewEventId, rating: action.rating as ReviewAttempt["rating"], correct: action.correct as boolean, requestedAt: now };
      validateCompanionGradeCorrection(correction);
      (s.gradeCorrections ??= []).push({ correction });
      this.gradePanel(s, { ...attempt, rating: correction.rating, correct: correction.correct }, now, "correcting", undefined, deadline); return;
    }
    if (action.kind === "change-grade" || action.kind === "replace-grade") {
      const pending = s.domain.pending.find(attempt => attempt.id === action.attemptId);
      const outcome = s.domain.outcomes.find(row => row.attempt.id === action.attemptId);
      if (!pending || s.claimedAttempts?.includes(pending.id)) {
        const attempt = pending ?? this.resultAttempt(s, String(action.attemptId)); invalid(attempt, "stale");
        this.gradePanel(s, attempt, now, outcome ? outcome.status === "applied" ? "applied" : "rejected" : "sent"); return;
      }
      const offlineHead = pending.offline && s.offlineHeads?.find(head => head.cardId === pending.cardId);
      if (pending.offline && (!offlineHead || offlineHead.lastAttemptId !== pending.id)) { this.gradePanel(s, pending, now, "correction-rejected", undefined, deadline, clickedPanel); return; }
      if (action.kind === "change-grade") { this.gradePanel(s, pending, now, "changing", action.answerMatch as boolean | undefined, deadline, clickedPanel); return; }
      invalid(handleId && [1, 2, 3, 4].includes(Number(action.rating)) && action.correct === (action.rating !== 1) && !(action.answerMatch === true && action.rating === 1));
      const replacement: ReviewAttempt = { ...pending, id: handleId, rating: action.rating as ReviewAttempt["rating"], correct: action.correct as boolean };
      if (offlineHead) {
        (s.supersededOfflineReviews ??= []).push({ attempt: clone(pending), seed: offlineHead.seed });
        const step = decodeOfflineStep(pending.offline!); step.after = advanceOfflineFsrs(offlineHead.seed, step.before, replacement.correct ? replacement.rating : 1, replacement.occurredAt); replacement.offline = encodeOfflineStep(step); offlineHead.state = step.after; offlineHead.lastAttemptId = replacement.id;
        s.handles = s.handles.filter(handle => !(handle.action.cardId === pending.cardId && handle.action.revision === pending.id));
        this.cancelQueuedContent(s, new Set(s.outbox.filter(row => row.status === "queued" && (row.sessionContent?.cardId === pending.cardId && row.sessionContent.revision === pending.id
          || row.questionPanel?.cardId === pending.cardId && row.questionPanel.revision === pending.id || row.ratingPanel?.cardId === pending.cardId && row.ratingPanel.revision === pending.id && !row.ratingPanel.attemptId)).map(row => row.id)));
        this.freezeHints(s, pending.cardId, now, true, pending.id);
      }
      validateAttempt(replacement); s.domain.pending = s.domain.pending.map(attempt => attempt.id === pending.id ? replacement : attempt);
      for (const result of s.studySession?.results ?? []) if (result.attemptId === pending.id) result.attemptId = replacement.id;
      for (const panel of s.outbox) if (panel.ratingPanel?.attemptId === pending.id) panel.ratingPanel.attemptId = replacement.id;
      this.gradePanel(s, replacement, now, "selected", action.answerMatch as boolean | undefined, deadline);
      if (offlineHead && s.studySession?.status === "active" && (s.studySession.waitUntil !== undefined || s.studySession.current?.id === pending.cardId)) this.sessionNext(s, now);
      return;
    }
    if (action.kind === "snooze") {
      invalid([12, 24, "next"].includes(action.hours as number | string));
      s.mutedUntil = action.hours === "next" ? nextSession(now, this.config.timeZone, this.config.sessionsLocal, s.lastSession) : now + Number(action.hours) * 3600000;
      this.message(s, { text: "Напоминания отложены. Расписание карточек не изменено.", buttons: [] }, now); return;
    }
    if (action.kind === "notifications") { s.domain.reminders.enabled = action.enabled === true; this.message(s, { text: "Настройки напоминаний сохранены. Расписание карточек не изменено.", buttons: [] }, now); return; }
    if (action.kind === "skip") { s.domain.reminders.skippedDay = studyDay(now, this.config.timeZone); this.message(s, { text: "Напоминания пропущены до следующего учебного дня (граница 04:00 по часовому поясу Obsidian). Расписание карточек не изменено.", buttons: [] }, now); return; }
    const snapshot = s.domain.snapshot;
    if (action.kind === "search" && action.search === undefined) { this.message(s, { text: "Введите search и название материала или слова вопроса.", buttons: [] }, now); return; }
    if (action.kind === "status") {
      invalid(action.details === undefined || typeof action.details === "boolean");
      if (action.details !== true && action.offset === undefined) {
        const totals = resultCounts(s);
        this.message(s, renderCompanionStatus({ now, lastContactAt: s.bridgeTimeFloor, pending: s.domain.pending.length, applied: totals.applied,
          rejected: totals.rejected, pendingCorrections: s.gradeCorrections?.filter(row => !row.receipt).length ?? 0,
          ...(snapshot ? { snapshot: { generatedAt: snapshot.generatedAt, expiresAt: snapshot.expiresAt } } : {}) }), now); return;
      }
      const offset = Number(action.offset ?? 0); invalid(Number.isSafeInteger(offset) && offset >= 0);
      const total = resultCounts(s).total, end = Math.max(0, total - offset), rows = resultHistory(s, this.journal.results, this.config.scope, this.config.epoch, offset);
      this.message(s, { text: `Ожидают подтверждения Obsidian: ${s.domain.pending.length}. Результатов: ${total}.\n${rows.map(o => `${o.attempt.cardId}: ${o.status}`).join("\n") || "Подтверждений ещё нет."}`,
        buttons: [...(end > 20 ? [{ text: "Предыдущие результаты", action: { kind: "status", details: true, offset: offset + 20 } }] : []),
          { text: "Краткий статус", action: { kind: "status" } }] }, now); return;
    }
    invalid(snapshot && companionSnapshotIsCurrent(snapshot, now), "stale");
    if (handleId) invalid(action.scope === snapshot.scope && action.epoch === snapshot.epoch && action.sequence === snapshot.sequence, "stale");
    if (["reveal", "hint", "review", "select-option", "toggle-option", "submit-options", "skip-card"].includes(String(action.kind)) && this.suppressed(s).some(attempt => attempt.cardId === action.cardId)) throw new AlreadyAnswered();
    const page = this.page(s, now, action);
    if (clickedPanel?.pollPanel && ["reveal", "hint", "skip-card"].includes(String(action.kind))) {
      const card = this.pollCard(s, clickedPanel, now);
      if (action.kind === "reveal") { const after = this.sealPoll(s, clickedPanel, now); this.card(s, card, now, true, undefined, deadline, after); return; }
      if (action.kind === "skip-card") this.sealPoll(s, clickedPanel, now);
    }
    if (action.kind === "skip-card") {
      const card = page.cards.find(card => card.id === action.cardId && card.revision === action.revision), session = s.studySession;
      invalid(handleId && card && session && session.status !== "finished" && !session.deferred?.includes(card.id) && !session.skipped.includes(card.id)
        && sessionCards(session).some(row => canonical(row) === canonical(card)), "stale session");
      (session.deferred ??= []).push(card.id);
      const removed = new Set(s.handles.filter(h => h.action.cardId === card.id).map(h => h.id));
      s.handles = s.handles.filter(h => !removed.has(h.id));
      this.cancelQueuedContent(s, new Set(s.outbox.filter(row => row.status === "queued" && (row.questionPanel?.cardId === card.id || row.answerHandle && removed.has(row.answerHandle)
        || (row.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] })?.inline_keyboard?.some(buttons => buttons.some(button => removed.has(button.callback_data))))).map(row => row.id)));
      this.freezeHints(s, card.id, now, true); this.sessionNext(s, now); return;
    }
    if (["select-option", "toggle-option", "submit-options"].includes(String(action.kind))) {
      invalid(handleId); const panel = s.outbox.find(row => row.questionPanel?.cardId === action.cardId && row.questionPanel.revision === action.revision
        && row.sessionContent?.sessionId === s.studySession?.id && row.status === "sent" && row.messageId !== undefined
        && (row.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.some(buttons => buttons.some(button => button.callback_data === handleId)));
      // The submit control is introduced by an owned edit rather than the original keyboard.
      const editedPanel = !panel && clickedPanel?.questionPanel ? clickedPanel : panel; invalid(editedPanel);
      const card = this.questionCard(s, editedPanel, now), exercise = card.exercise!; invalid(exercise.kind === "single" || exercise.kind === "multiple");
      if (action.kind === "select-option") {
        invalid(exercise.kind === "single" && Number.isSafeInteger(action.index) && Number(action.index) >= 0 && Number(action.index) < exercise.options.length);
        this.card(s, card, now, true, evaluateCompanionExercise(exercise, { selectedOptionIndexes: [Number(action.index)] }), deadline, undefined,
          createCompanionExerciseFeedback(exercise, { selectedOptionIndexes: [Number(action.index)] })); return;
      }
      invalid(exercise.kind === "multiple"); const selected = editedPanel.questionPanel!.selectedOptionIndexes;
      if (action.kind === "toggle-option") {
        const index = Number(action.index); invalid(Number.isSafeInteger(index) && index >= 0 && index < exercise.options.length);
        editedPanel.questionPanel!.selectedOptionIndexes = selected.includes(index) ? selected.filter(value => value !== index) : [...selected, index].sort((a, b) => a - b);
        this.updateQuestionPanel(s, editedPanel, card, now); return;
      }
      invalid(selected.length > 0); this.card(s, card, now, true, evaluateCompanionExercise(exercise, { selectedOptionIndexes: selected }), deadline, undefined,
        createCompanionExerciseFeedback(exercise, { selectedOptionIndexes: selected })); return;
    }
    if (["hint", "reveal", "review"].includes(String(action.kind))) invalid(!s.studySession?.deferred?.includes(String(action.cardId)), "skipped question");
    if (action.kind === "hint") {
      invalid(handleId); const card = page.cards.find(c => c.id === action.cardId && c.revision === action.revision), index = Number(action.index);
      invalid(card?.hints && Number.isSafeInteger(index) && index >= 0 && index < card.hints.length, "stale");
      const session = s.studySession; invalid(session && session.status !== "finished" && sessionCards(session).some(row => canonical(row) === canonical(card)), "stale session");
      let panel = [...s.outbox].reverse().find(row => row.status !== "unknown" && row.hintPanel?.sessionId === session.id && row.hintPanel.cardId === card.id && row.hintPanel.revision === card.revision);
      if (clickedPanel?.pollPanel && panel?.hintPanel && !panel.hintPanel.readOnly) { panel.hintPanel.collapsed = false; this.updateHintPanel(s, panel, now); return; }
      invalid(index === (panel?.hintPanel?.count ?? 0) && !panel?.hintPanel?.readOnly, "hint order differs");
      if (!panel) {
        const id = this.message(s, { text: hintPanelView(card.hints, 1, 0, false).text, buttons: [], disableNotification: true }, now, undefined, snapshot.sequence, deadline);
        panel = s.outbox.find(row => row.id === id)!;
        panel.hintPanel = { cardId: card.id, revision: card.revision, sessionId: session.id, count: 1, index: 0, collapsed: false, expiresAt: Math.min(snapshot.expiresAt, deadline ?? snapshot.expiresAt) };
        panel.sessionContent = { sessionId: session.id };
      } else { panel.hintPanel!.count = index + 1; panel.hintPanel!.index = index; panel.hintPanel!.collapsed = false; }
      this.updateHintPanel(s, panel, now); return;
    }
    if (action.kind === "review") {
      invalid(handleId); const c = page.cards.find(c => c.id === action.cardId && c.revision === action.revision); invalid(c, "stale");
      invalid([1, 2, 3, 4].includes(Number(action.rating)) && typeof action.correct === "boolean");
      const attempt = appendCompanionReview(s, c, handleId, action.rating as ReviewAttempt["rating"], action.correct, now);
      this.gradePanel(s, attempt, now, "selected", action.answerMatch as boolean | undefined, deadline, delivery);
      const session = s.studySession;
      if (session && session.status !== "finished" && sessionCards(session).some(card => card.id === c.id && card.revision === c.revision)) {
        invalid(c.offline || !session.results.some(row => row.cardId === c.id)); session.results.push({ cardId: c.id, attemptId: attempt.id, ...(c.offline ? { card: clone(c) } : {}) });
      }
      this.freezeHints(s, c.id, now, true);
      if (showGuidance) this.message(s, { text: "Ответ сохранён в очереди бота. Obsidian подтвердит применение; его данные имеют приоритет.", buttons: [] }, now);
      if (session && session.status !== "finished") { this.sessionNext(s, now); return; }
      const next = this.page(s, now, { kind: "material", materialId: c.materialId }).cards[0];
      if (next) this.card(s, next, now); else this.message(s, { text: "В этом материале больше нет доступных карточек. Напишите go.", buttons: [] }, now); return;
    }
    if (action.kind === "material" || action.kind === "reveal") {
      if (action.kind === "material") {
        if (s.studySession && s.studySession.status !== "finished") { this.sessionPanel(s, now); this.sessionHistory(s, now); return; }
        invalid(page.cards.length > 0);
        const originals = page.cards.slice(0, 1000).map(card => card.offline ? ensureOfflineHead(s.offlineHeads ??= [], s.domain.snapshot!, card.id)!.baseCard : card);
        const { studyTarget: _studyTarget, cards: _cards, ...sessionSnapshot } = snapshot;
        s.studySession = { id: this.id(), snapshot: { ...sessionSnapshot, expiresAt: Math.min(snapshot.expiresAt, ...originals.map(card => card.offline ? decodeOfflineSeed(card.offline).expiresAt : snapshot.expiresAt)), cards: clone(originals) }, status: "active", results: [], skipped: [], deferred: [] };
        this.cancelSessionContent(s);
        this.sessionNext(s, now); return;
      }
      const c = action.kind === "reveal" ? page.cards.find(c => c.id === action.cardId && c.revision === action.revision) : page.cards[0]; invalid(c, "stale");
      this.card(s, c, now, action.kind === "reveal", undefined, deadline); return;
    }
    invalid(["go", "more", "all", "search"].includes(String(action.kind)));
    if (!page.totalMaterials && ["go", "all"].includes(String(action.kind)) && queryCards(snapshot, this.suppressed(s), { now, all: true }).cards.some(card => card.exercise?.kind === "matching" || card.exercise?.kind === "ordering")) {
      this.message(s, { text: "Сопоставление и порядок доступны в приложении. Напишите /app, чтобы открыть занятие.", buttons: [] }, now); return;
    }
    if (page.materials.length > 20) {
      for (let i = 0; i < page.materials.length; i += 20) this.message(s, renderMaterials(snapshot, { ...page, materials: page.materials.slice(i, i + 20) }, showGuidance), now);
    } else this.message(s, renderMaterials(snapshot, page, showGuidance), now);
  }
  private unavailableAction(s: ServerState, request: { handle?: string; replyToMessageId?: number; text?: string; pollId?: string }, now: number): string {
    const handle = request.handle ? s.handles.find(row => row.id === request.handle) : undefined;
    if (handle?.action.kind === "rich-demo") return "Пробная карточка недоступна или срок её кнопок истёк. Напишите /checkboxdemo, чтобы открыть новую.";
    const delivery = [...s.outbox].reverse().find(row => row.status === "sent" && (request.pollId ? row.pollPanel?.pollId === request.pollId : request.handle
      ? (row.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] })?.inline_keyboard?.some(buttons => buttons.some(button => button.callback_data === request.handle))
      : request.replyToMessageId !== undefined && row.messageId === request.replyToMessageId && row.answerHandle !== undefined));
    const source = delivery?.target ? s.outbox.find(row => row.id === delivery.target) : delivery;
    const action = handle?.action ?? (source?.answerHandle ? s.handles.find(row => row.id === source.answerHandle)?.action : undefined);
    const kind = String(action?.kind ?? ""), learning = source?.answerHandle !== undefined || ["answer", "reveal", "hint", "hint-panel", "review", "select-option", "toggle-option", "submit-options", "skip-card"].includes(kind);
    let sessionId = typeof action?.sessionId === "string" ? action.sessionId : source?.sessionContent?.sessionId ?? source?.sessionPanel?.sessionId ?? source?.hintPanel?.sessionId ?? source?.pollPanel?.sessionId;
    // Older plain rating prompts have no session field; their preceding owned progress panel supplies it.
    if (!sessionId && source && (source.ratingPanel || learning)) {
      const index = s.outbox.indexOf(source);
      sessionId = s.outbox.slice(0, index).reverse().find(row => row.sessionPanel)?.sessionPanel?.sessionId;
    }
    const session = s.studySession, snapshotExpired = s.domain.snapshot && now >= s.domain.snapshot.expiresAt;
    const command = request.text?.trim().replace(/^\//, "").toLowerCase();
    if (!sessionId && session && !request.handle && request.replyToMessageId === undefined && ["go", "start", "history", "pause", "resume", "finish"].includes(command ?? "")) sessionId = session.id;
    const restart = "Напишите /go, чтобы начать новое занятие.";
    const synchronize = "Синхронизируйте Telegram в Obsidian, затем напишите /go, чтобы начать новое занятие.";
    if (sessionId && sessionId !== session?.id) return (request.replyToMessageId === undefined ? "Эта кнопка относится" : "Этот вопрос относится") + " к предыдущему занятию. Напишите /go, чтобы открыть текущее или начать новое.";
    if (session && sessionId === session.id && now >= session.snapshot.expiresAt) return "Срок этого занятия истёк. " + (snapshotExpired ? synchronize : restart);
    if (session?.status === "finished" && sessionId === session.id && (learning || source?.ratingPanel || source?.questionPanel)) return "Это занятие уже завершено. " + restart;
    const needsSnapshot = learning || ["material", "more", "all", "search"].includes(kind) || sessionId !== undefined || command === "go" || command === "start";
    if (snapshotExpired && needsSnapshot) return "Срок действия копии карточек истёк. " + synchronize;
    if (handle && now >= handle.expiresAt) return "Срок действия этой кнопки истёк. Напишите /go, чтобы открыть актуальные действия.";
    return "Действие недоступно: кнопка или снимок устарели либо запрос некорректен. Напишите go; обновите снимок из Obsidian при необходимости.";
  }
  async webhook(raw: string, secretHeader: string, now: number): Promise<{ ok: true }> {
    invalid(Buffer.byteLength(raw) <= 65536); timestamp(now);
    invalid(secretHeader.length <= 256 && equal(secretHeader, this.config.webhookSecret), "unauthorized");
    const u: unknown = JSON.parse(raw); record(u); keys(u, ["update_id", "message", "callback_query", "poll_answer"]);
    invalid([u.message, u.callback_query, u.poll_answer].filter(value => value !== undefined).length === 1);
    const update = verifyPrivateTelegramUpdate(raw, secretHeader, { enabled: true, webhookSecret: this.config.webhookSecret, userId: this.config.ownerUserId, chatId: this.config.ownerChatId });
    invalid(update.updateId >= 0);
    const result = await this.serial<{ ok: true }>(async () => {
      invalid(this.active); const s = cloneServerState(this.state), hash = digest(u);
      const archive = s.replayArchived ? this.journal.replay! : undefined;
      const previous = s.updates.find(r => r.id === update.updateId)?.hash ?? archive?.get(s.binding, "update", String(update.updateId));
      if (previous !== undefined) { invalid(previous === hash); return { ok: true }; }
      s.updates.push({ id: update.updateId, hash });
      if (update.callbackId) {
        const callbackHash = digest({ handle: update.handle });
        const existing = s.callbackIds.find(c => c.id === update.callbackId)?.hash ?? archive?.get(s.binding, "callback", update.callbackId);
        if (existing !== undefined) { invalid(existing === callbackHash, "callback collision"); await this.commit(s); return { ok: true }; }
        s.callbackIds.push({ id: update.callbackId, hash: callbackHash });
        this.enqueue(s, "answerCallbackQuery", { callback_query_id: update.callbackId });
      }
      // Generate a safe stale message instead of propagating card/secret-bearing errors.
      // Work on a branch so failed actions cannot partially append attempts.
      const working = cloneServerState(s);
      try {
        if (update.pollId !== undefined) { if (this.config.miniAppUrl) this.miniAppLauncher(working, now); else this.pollAnswer(working, update.pollId, update.optionIds!, now); }
        else if (update.handle) {
          const h = working.handles.find(h => h.id === update.handle);
          if (this.config.miniAppUrl && (!h || !["status", "snooze", "skip", "notifications"].includes(String(h.action.kind)))) { this.miniAppLauncher(working, now); await this.commit(working); return { ok: true }; }
          if ([...working.domain.pending, ...working.domain.outcomes.map(outcome => outcome.attempt)].some(attempt => attempt.id === update.handle)
            || h && ["reveal", "hint", "review", "select-option", "toggle-option", "submit-options", "skip-card"].includes(String(h.action.kind)) && this.suppressed(working).some(attempt => attempt.cardId === h.action.cardId)) throw new AlreadyAnswered();
          invalid(h && h.epoch === this.config.epoch && now < h.expiresAt && (h.sequence === 0 || h.sequence === (working.domain.snapshot?.sequence ?? 0)), "stale");
          const deliveries = working.outbox.filter(o => (o.method === "sendMessage" || o.method === "editMessageText" || o.method === "sendPoll") && (o.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] })?.inline_keyboard?.some(row => row.some(button => button.callback_data === h.id)));
          const delivery = h.action.kind === "rich-demo" ? working.outbox.find(row => row.id === h.action.panelId && row.method === "sendRichMessage") : ["select-option", "toggle-option", "submit-options"].includes(String(h.action.kind))
            ? [...deliveries].reverse().find(row => row.status === "sent") : deliveries.at(-1);
          invalid(delivery?.after === undefined || delivery.status === "sent", "delivery incomplete");
          this.act(working, h.action, now, h.id, h.expiresAt, delivery);
          if (h.action.kind === "review" && working.domain.pending.length + working.domain.outcomes.length > 2) {
            invalid(working.domain.pending.some(attempt => attempt.id === h.id));
            const acknowledgement = working.outbox.find(row => row.method === "answerCallbackQuery" && row.payload.callback_query_id === update.callbackId);
            invalid(acknowledgement); acknowledgement.payload.text = GRADE_SAVED_NOTICE;
          }
        } else {
          const text = (update.text ?? "").trim();
          const planParameter = /^\/?start(?:@[A-Za-z0-9_]+)?\s+(\S+)$/i.exec(text)?.[1];
          const planId = planParameter && parseStudyPlanStartParameter(planParameter);
          if (planId && this.config.miniAppUrl) this.miniAppLauncher(working, now, planId);
          else if (/^\/?checkboxdemo$/i.test(text)) { if (this.config.miniAppUrl) this.miniAppLauncher(working, now); else this.richDemo(working, now); }
          else if (update.replyToMessageId !== undefined) { if (this.config.miniAppUrl) this.miniAppLauncher(working, now); else this.answer(working, update.replyToMessageId, update.text ?? "", now); }
          else if (/^\/?(go|start|app)(?:@[A-Za-z0-9_]+)?$/i.test(text)) { if (!this.config.miniAppUrl && /^\/?app/i.test(text)) this.message(working, { text: "Mini App ещё не настроен. Обратитесь к владельцу сервиса.", buttons: [] }, now); else this.act(working, { kind: "go" }, now); }
          else if (/^\/?notifications (on|off)$/i.test(text)) this.act(working, { kind: "notifications", enabled: / on$/i.test(text) }, now);
          else if (/^\/?skip$/i.test(text)) this.act(working, { kind: "skip" }, now);
          else if (/^\/?status$/i.test(text)) this.act(working, { kind: "status" }, now);
          else if (this.config.miniAppUrl && /^\/?finish(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
            finishMiniAppSession(working, now);
            this.message(working, { text: "Занятие завершено. Сохранённые оценки остаются в истории и очереди синхронизации.", buttons: [] }, now);
            this.miniAppLauncher(working, now);
          }
          else if (/^\/?(history|pause|resume|finish)$/i.test(text)) {
            if (this.config.miniAppUrl) this.miniAppLauncher(working, now);
            else if (!working.studySession) this.message(working, { text: "Начните занятие через /go.", buttons: [] }, now);
            else this.act(working, { kind: "session-" + text.replace(/^\//, "").toLowerCase(), sessionId: working.studySession.id }, now);
          }
          else if (/^\/?search(?:\s|$)/i.test(text)) { const q = text.replace(/^\/?search\s*/i, ""); invalid(q.length <= 200); this.act(working, q ? { kind: "search", search: q } : { kind: "search" }, now); }
          else if (this.config.miniAppUrl) this.miniAppLauncher(working, now);
          else this.message(working, { text: "Команды: go — занятие; history — его результаты; pause / resume — пауза и продолжение; finish — завершить; search текст — поиск; status — очередь. Для точного ответа используйте ответ на сообщение с вопросом.", buttons: [] }, now);
        }
      } catch (error) { this.message(s, { text: error instanceof AlreadyAnswered
        ? "Ответ на эту карточку уже сохранён. Повторная оценка не добавлена. Напишите /go, чтобы продолжить."
        : this.unavailableAction(s, update, now), buttons: [] }, now); await this.commit(s); return { ok: true }; }
      await this.commit(working); return { ok: true };
    });
    // Acknowledgements must not wait for this chat's in-flight upload or the gateway's content workers.
    if (update.callbackId && (this.flushing || this.callbackFlushing)) void this.flushCallbacks().catch(() => undefined);
    return result;
  }
  async bridge(path: string, raw: string, signature: string, now: number, binary = false): Promise<unknown> {
    invalid(Buffer.byteLength(raw) <= MAX_COMPANION_BRIDGE_BYTES && /^[a-f0-9]{64}$/.test(signature)); timestamp(now);
    const e: unknown = JSON.parse(raw); record(e); keys(e, ["version", "method", "path", "scope", "epoch", "enrollment", "time", "nonce", "payload"]);
    invalid(e.version === 1 && e.method === "POST" && e.path === path && ["/bridge/snapshot", "/bridge/pending", "/bridge/ack"].includes(path));
    invalid(e.scope === this.config.scope && e.epoch === this.config.epoch && e.enrollment === this.config.enrollment);
    timestamp(e.time); token(e.nonce); invalid(Math.abs(now - e.time) <= COMPANION_CLOCK_SKEW && equal(signature, sign(this.config.bridgeSecret, e)), "unauthorized");
    return this.serial(async () => {
      invalid(this.active); const s = cloneServerState(this.state), hash = digest(e);
      // A persisted monotonic floor makes pruned request windows permanently closed,
      // including after restart. Fail closed on clock rollback; never reopen replay windows.
      invalid(now >= s.bridgeTimeFloor, "server clock rollback; wait for clock recovery");
      s.bridgeTimeFloor = now;
      s.nonces = s.nonces.filter(n => n.time + COMPANION_CLOCK_SKEW >= now);
      const previous = s.nonces.find(n => n.nonce === e.nonce);
      if (previous) { invalid(previous.hash === hash, "nonce collision"); await this.commit(s); return clone(previous.response); }
      invalid(s.nonces.length < 10000); let response: unknown;
      record(e.payload);
      let uploadResponse: { response: unknown } | undefined;
      let uploadStartedAt: number | undefined;
      let catalogCommit: CatalogCommit | undefined;
      if (path === "/bridge/snapshot" && ["catalog-pages-begin", "catalog-pages-missing", "catalog-pages-put", "catalog-pages-put-batch", "catalog-pages-commit"].includes(String(e.payload.operation))) {
        invalid(this.catalogTransfer, "paged catalog storage unavailable; update the server");
        const transfer = await this.catalogTransfer.accept(e.payload, now, s.catalogRevision ?? null, s.domain.snapshot?.sequence);
        if ("response" in transfer) uploadResponse = transfer;
        else {
          catalogCommit = transfer; uploadStartedAt = transfer.startedAt;
          const { context: _context, ...payload } = transfer.payload; e.payload = payload;
        }
      }
      record(e.payload);
      if (path === "/bridge/snapshot" && ["large-payload-begin", "large-payload-chunk", "large-payload-commit"].includes(String(e.payload.operation))) {
        const transfer = this.largePayload.accept(e.payload, now);
        if ("payload" in transfer) { e.payload = transfer.payload; uploadStartedAt = transfer.startedAt; } else uploadResponse = transfer;
      }
      record(e.payload);
      if (uploadResponse) response = uploadResponse.response;
      else if (path === "/bridge/snapshot" && e.payload.operation === "media-chunk") {
        validateCompanionMediaChunk(e.payload, binary ? MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES : MAX_COMPANION_MEDIA_CHUNK_BYTES);
        invalid(this.media, "media storage unavailable");
        response = await this.media.put(e.payload); validateCompanionMediaAck(response, e.payload.asset);
      } else if (path === "/bridge/snapshot" && e.payload.operation === "study-context") {
        keys(e.payload, ["operation", "context"]); validateCompanionStudyContext(e.payload.context);
        const contextCards = s.domain.snapshot ? snapshotCardMap(s.domain.snapshot) : new Map<string, SelectedCard>();
        const contextMaterials = new Set(s.materialConsentIds ?? []);
        invalid(s.domain.snapshot && companionSnapshotIsCurrent(s.domain.snapshot, now)
          && e.payload.context.cards.every(row => { const card = contextCards.get(row.id); return card && contextMaterials.has(card.materialId); }), "study metadata consent differs");
        s.studyContext = clone(e.payload.context); response = { accepted: true };
        delete s.catalogRevision; delete s.catalogRoot;
      } else if (path === "/bridge/snapshot" && e.payload.operation === "study-plan") {
        keys(e.payload, ["operation", "plan"]); validateCompanionStudyPlan(e.payload.plan); const plan = e.payload.plan;
        invalid(plan.timeZone === this.config.timeZone && Math.abs((uploadStartedAt ?? now) - plan.generatedAt) <= COMPANION_CLOCK_SKEW && now < plan.expiresAt, "study plan clock mismatch");
        invalid(!s.studyPlan || plan.generatedAt > s.studyPlan.generatedAt || plan.generatedAt === s.studyPlan.generatedAt && jsonFingerprintEqual(plan, s.studyPlan), "study plan generation differs");
        s.studyPlan = clone(plan); s.studyPlanSent ??= [];
        this.reconcilePlanDeliveries(s, now); response = { accepted: true };
      } else if (path === "/bridge/snapshot") {
        keys(e.payload, ["snapshot", "consentIds", "timeZone", "materialConsentIds", "attachmentConsent", "offlineConsent"]); invalid(e.payload.timeZone === this.config.timeZone, "vault timezone mismatch");
        if (catalogCommit) validateImmutableSnapshot(e.payload.snapshot); else validateSnapshot(e.payload.snapshot); const snapshot = e.payload.snapshot;
        invalid(e.payload.offlineConsent === undefined || typeof e.payload.offlineConsent === "boolean");
        const offlineConsent = e.payload.offlineConsent ?? false;
        invalid(offlineConsent || !snapshot.cards.some(card => card.offline));
        invalid(snapshot.scope === this.config.scope && snapshot.epoch === this.config.epoch);
        invalid(companionSnapshotIsCurrent(snapshot, now) && (uploadStartedAt ?? now) - snapshot.generatedAt <= COMPANION_CLOCK_SKEW);
        invalid(Array.isArray(e.payload.consentIds) && e.payload.consentIds.every(v => typeof v === "string"));
        const consentIds = new Set(e.payload.consentIds); invalid(snapshot.cards.every(c => consentIds.has(c.id)));
        const materialConsentIds = e.payload.materialConsentIds ?? [...new Set(snapshot.cards.map(card => card.materialId))];
        invalid(Array.isArray(materialConsentIds) && new Set(materialConsentIds).size === materialConsentIds.length); materialConsentIds.forEach(token);
        const materialConsent = new Set(materialConsentIds); invalid(snapshot.cards.every(card => materialConsent.has(card.materialId)));
        const attachmentConsent = e.payload.attachmentConsent ?? snapshot.cards.some(card => card.hints?.length || card.media?.length);
        invalid(typeof attachmentConsent === "boolean" && (attachmentConsent || !snapshot.cards.some(card => card.hints?.length || card.media?.length)));
        const checkedMedia = new Map<string, CompanionMediaIdentity>();
        for (const card of snapshot.cards) for (const asset of card.media ?? []) {
          const identity = { id: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes }, checked = checkedMedia.get(asset.id);
          if (checked) invalid(canonical(checked) === canonical(identity), "media identity collision");
          else { invalid(this.media && await this.media.has(identity), "snapshot media incomplete"); checkedMedia.set(asset.id, identity); }
        }
        const old = s.domain.snapshot;
        delete s.studyContext;
        s.materialConsentIds = [...materialConsentIds]; s.attachmentConsent = attachmentConsent;
        if (s.studySession?.snapshot.cards.some(card => !materialConsent.has(card.materialId) || !attachmentConsent && (card.media?.length || card.hints?.length) || card.offline && !offlineConsent)) s.studySession = undefined;
        this.cancelSessionContent(s);
        s.editableGrades = s.editableGrades?.filter(row => materialConsent.has(row.materialId) && (attachmentConsent || !row.withAttachments));
        if (old && snapshot.sequence === old.sequence) {
          invalid(catalogCommit && s.catalogRoot && jsonFingerprintEqual(catalogCommit.root.snapshot, s.catalogRoot.snapshot)
            || jsonFingerprintEqual(snapshot, old), "snapshot collision");
          if (catalogCommit) s.domain.snapshot = snapshot;
        }
        else {
          invalid(!old || snapshot.sequence > old.sequence);
          const activeCards = [...(s.studySession && s.studySession.status !== "finished" ? sessionCards(s.studySession) : []),
            ...(s.miniApp && s.miniApp.session.status !== "finished" ? sessionCards(s.miniApp.session) : [])];
          const retainedIds = new Set(activeCards.map(card => card.id));
          const priorHeads = (s.offlineHeads ?? []).filter(head => head.index > 0 || retainedIds.has(head.cardId));
          if (s.domain.snapshot) for (const card of activeCards) if (card.offline && !priorHeads.some(head => head.cardId === card.id))
            ensureOfflineHead(priorHeads, s.domain.snapshot, card.id);
          const nextHeads = offlineConsent ? reconcileOfflineHeads(priorHeads, snapshot, now, s.domain.pending, true) : [];
          const retainedDeliveries = this.carryCardControls(s, snapshot, now); s.domain.snapshot = catalogCommit ? snapshot : clone(snapshot);
          s.offlineConsent = offlineConsent; s.offlineHeads = nextHeads;
          this.retireSettledOfflineHeads(s, now);
          // Menus/cursors expire globally; only fully proven unchanged active card groups carry forward.
          this.cancelQueuedContent(s, new Set(s.outbox.filter(o => o.status === "queued" && o.snapshotSequence !== undefined && !o.ratingPanel?.attemptId && !retainedDeliveries.has(o.id)).map(o => o.id)));
        }
        if (offlineConsent === false) { s.offlineConsent = false; s.offlineHeads = []; }
        this.retirePolls(s, now); this.reconcilePlanDeliveries(s, now);
        response = { sequence: snapshot.sequence };
        if (!catalogCommit) { delete s.catalogRevision; delete s.catalogRoot; }
      } else if (path === "/bridge/pending" && e.payload.operation === "snapshot-capacity") {
        keys(e.payload, ["operation", "version"]); invalid(e.payload.version === undefined || e.payload.version === 2);
        // Legacy protocol versions retain their declared capacity; the paged protocol has no count quota.
        response = { maxCards: e.payload.version === 2 ? 100_000 : 1000, maxBytes: MAX_COMPANION_BRIDGE_BYTES };
      } else if (path === "/bridge/pending" && e.payload.operation === "catalog-pages-capacity") {
        keys(e.payload, ["operation", "version"]); invalid(e.payload.version === undefined || e.payload.version === 1 || e.payload.version === 2);
        invalid(this.catalogTransfer, "paged catalog storage unavailable");
        response = { version: e.payload.version ?? 1, maxCards: null, maxBytes: MAX_COMPANION_BRIDGE_BYTES, pageBytes: CATALOG_PAGE_BYTES,
          referenceBatch: CATALOG_REFERENCE_BATCH, gzip: true, baseRevision: s.catalogRevision ?? null };
      } else if (path === "/bridge/pending" && e.payload.operation === "large-payload-capacity") {
        keys(e.payload, ["operation"]); response = { version: 1, maxBytes: MAX_COMPANION_SNAPSHOT_BYTES, chunkBytes: MAX_COMPANION_SNAPSHOT_CHUNK_BYTES };
      } else if (path === "/bridge/pending" && e.payload.operation === "media-upload-capacity") {
        keys(e.payload, ["operation", "version"]); invalid(e.payload.version === undefined || e.payload.version === 2 || e.payload.version === 3);
        invalid(this.media?.status, "media status unavailable");
        response = { version: e.payload.version ?? 1, chunkBytes: e.payload.version === 3 ? MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES : MAX_COMPANION_MEDIA_CHUNK_BYTES,
          maxAssets: MAX_COMPANION_MEDIA_STATUS_ASSETS, ...(e.payload.version !== undefined ? { binary: true } : {}) };
      } else if (path === "/bridge/pending" && e.payload.operation === "media-status") {
        keys(e.payload, ["operation", "assets"]); validateCompanionMediaStatusAssets(e.payload.assets); invalid(this.media?.status, "media status unavailable");
        const assets = e.payload.assets, files = await this.media.status(assets);
        invalid(Array.isArray(files) && files.length === assets.length);
        files.forEach((file, index) => validateCompanionMediaAck(file, assets[index])); response = { files };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-context-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-filter-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-plan-action-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1, ...(this.config.botUsername ? { botUsername: this.config.botUsername } : {}) };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-plan-calendar-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1, calendarStatus: true, ...(this.config.botUsername ? { botUsername: this.config.botUsername } : {}) };
      } else if (path === "/bridge/pending" && e.payload.operation === "card-report-capabilities") {
        keys(e.payload, ["operation"]); s.cardReportsEnabled = true; response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "answer-history-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1, retainAnswers: s.retainAnswers === true, retainAnswersChangedAt: s.retainAnswersChangedAt ?? 0 };
      } else if (path === "/bridge/pending" && e.payload.operation === "answer-history") {
        keys(e.payload, ["operation"]); const records: { record: CompanionAnswerHistory; capability: string }[] = [];
        let bytes = Buffer.byteLength('{"records":[]}');
        for (const value of pendingAnswerHistory(s, 50)) {
          const row = { record: value, capability: answerHistoryCapability(this.config.bridgeSecret, this.config.enrollment, value) }, size = Buffer.byteLength(JSON.stringify(row)) + (records.length ? 1 : 0);
          if (bytes + size > 480000) break; records.push(row); bytes += size;
        }
        response = { records };
      } else if (path === "/bridge/pending" && e.payload.operation === "written-recall-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "written-recalls") {
        keys(e.payload, ["operation"]);
        const recalls: { recall: CompanionWrittenRecall; capability: string }[] = [];
        let bytes = Buffer.byteLength('{"recalls":[]}');
        // Leave room for the signed response envelope under the desktop client's 512000-byte limit.
        for (const recall of (s.writtenRecalls ?? []).slice(0, 50)) {
          const row = { recall, capability: writtenRecallCapability(this.config.bridgeSecret, this.config.enrollment, recall) };
          const size = Buffer.byteLength(JSON.stringify(row)) + (recalls.length ? 1 : 0);
          if (bytes + size > 480000) break;
          recalls.push(row); bytes += size;
        }
        response = { recalls };
      } else if (path === "/bridge/pending" && e.payload.operation === "card-reports") {
        keys(e.payload, ["operation"]);
        response = { reports: (s.cardReports ?? []).slice(0, 100).map(report => ({ report, capability: cardReportCapability(this.config.bridgeSecret, this.config.enrollment, report) })) };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-plan-actions") {
        keys(e.payload, ["operation"]);
        response = { commands: (s.planCommands ?? []).slice(0, 100).map(command => ({ command, capability: planCommandCapability(this.config.bridgeSecret, this.config.enrollment, command) })) };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-plan-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "study-target-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "offline-fsrs-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, engine: OFFLINE_FSRS_ENGINE };
      } else if (path === "/bridge/pending" && e.payload.operation === "snapshot-lifetime") {
        keys(e.payload, ["operation"]); response = { version: 1, maxLifetimeMs: COMPANION_STUDY_COPY_TTL };
      } else if (path === "/bridge/pending" && e.payload.operation === "early-short-repeat-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true };
      } else if (path === "/bridge/pending" && e.payload.operation === "bank-practice-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true, version: 1 };
      } else if (path === "/bridge/pending" && e.payload.operation === "correction-capabilities") {
        keys(e.payload, ["operation"]); response = { supported: true };
      } else if (path === "/bridge/pending" && e.payload.operation === "corrections") {
        keys(e.payload, ["operation"]);
        response = { corrections: (s.gradeCorrections ?? []).filter(row => !row.receipt).slice(0, 100).map(row => ({ correction: row.correction, capability: correctionCapability(this.config.bridgeSecret, this.config.enrollment, row.correction) })) };
      } else if (path === "/bridge/pending") {
        keys(e.payload, []);
        const attempts = s.domain.pending.slice(0, 100), claimed = new Set(s.claimedAttempts ?? []);
        for (const attempt of attempts) if (!claimed.has(attempt.id)) { claimed.add(attempt.id); this.gradePanel(s, attempt, now, "sent"); }
        s.claimedAttempts = [...claimed];
        response = { attempts: attempts.map(attempt => ({ attempt, capability: this.capability(attempt) })) };
      } else if (path === "/bridge/ack" && e.payload.operation === "study-plan-action") {
        keys(e.payload, ["operation", "command", "capability", "receipt"]);
        invalid(verifyPlanCommandCapability(this.config.bridgeSecret, this.config, e.payload.command, e.payload.capability), "unauthorized plan command");
        const command = e.payload.command as CompanionPlanCommand;
        acknowledgeCompanionPlanCommand(s, command, e.payload.receipt as CompanionPlanCommandReceipt);
        this.reconcilePlanDeliveries(s, now); response = { id: command.id, status: (e.payload.receipt as CompanionPlanCommandReceipt).status };
      } else if (path === "/bridge/ack" && e.payload.operation === "card-report") {
        keys(e.payload, ["operation", "report", "capability", "receipt"]);
        invalid(verifyCardReportCapability(this.config.bridgeSecret, this.config, e.payload.report, e.payload.capability), "unauthorized card report");
        const report = e.payload.report as CompanionCardReport;
        acknowledgeCompanionCardReport(s, report, e.payload.receipt as CompanionCardReportReceipt);
        response = { id: report.id, status: (e.payload.receipt as CompanionCardReportReceipt).status };
      } else if (path === "/bridge/ack" && e.payload.operation === "answer-retention") {
        keys(e.payload, ["operation", "enabled", "changedAt"]); invalid(typeof e.payload.enabled === "boolean"); timestamp(e.payload.changedAt);
        const changedAt = e.payload.changedAt as number; invalid(changedAt <= now + COMPANION_CLOCK_SKEW, "Answer retention time is ahead of the server clock");
        if (changedAt === (s.retainAnswersChangedAt ?? 0) && s.retainAnswers !== undefined) invalid(s.retainAnswers === e.payload.enabled, "Answer retention timestamp collision");
        if (s.retainAnswers === undefined || changedAt > (s.retainAnswersChangedAt ?? 0)) {
          s.retainAnswers = e.payload.enabled; s.retainAnswersChangedAt = changedAt;
          if (!s.retainAnswers && s.miniApp) { delete s.miniApp.retainedAnswer; if (s.miniApp.selfRecall && !s.miniApp.currentAttemptId) s.miniApp.selfRecall.answer = ""; }
        }
        response = { enabled: s.retainAnswers === true, changedAt: s.retainAnswersChangedAt ?? 0 };
      } else if (path === "/bridge/ack" && e.payload.operation === "answer-history") {
        keys(e.payload, ["operation", "record", "capability", "receipt"]);
        invalid(verifyAnswerHistoryCapability(this.config.bridgeSecret, this.config, e.payload.record, e.payload.capability), "Unauthorized answer history");
        const value = e.payload.record as CompanionAnswerHistory;
        hydrateResult(s, this.journal.results, this.config.scope, this.config.epoch, value.attempt.id, now);
        invalid(s.domain.outcomes.some(row => sameAttempt(row.attempt, value.attempt)), "Answer history grade not acknowledged");
        acknowledgeAnswerHistory(s, value, e.payload.receipt as CompanionAnswerHistoryReceipt);
        response = { id: value.attempt.id, status: (e.payload.receipt as CompanionAnswerHistoryReceipt).status };
      } else if (path === "/bridge/ack" && e.payload.operation === "written-recall") {
        keys(e.payload, ["operation", "recall", "capability", "receipt"]);
        invalid(verifyWrittenRecallCapability(this.config.bridgeSecret, this.config, e.payload.recall, e.payload.capability), "unauthorized written recall");
        const recall = e.payload.recall as CompanionWrittenRecall;
        hydrateResult(s, this.journal.results, this.config.scope, this.config.epoch, recall.attempt.id, now);
        invalid(s.domain.outcomes.some(row => sameAttempt(row.attempt, recall.attempt)), "written recall grade not acknowledged");
        acknowledgeCompanionWrittenRecall(s, recall, e.payload.receipt as CompanionWrittenRecallReceipt);
        response = { id: recall.attempt.id, status: (e.payload.receipt as CompanionWrittenRecallReceipt).status };
      } else if (e.payload.operation === "correction") {
        keys(e.payload, ["operation", "correction", "capability", "receipt"]); validateCompanionGradeCorrection(e.payload.correction); const correction = e.payload.correction;
        hydrateResult(s, this.journal.results, this.config.scope, this.config.epoch, correction.attemptId, now);
        invalid(correction.scope === this.config.scope && correction.epoch === this.config.epoch && typeof e.payload.capability === "string" && equal(e.payload.capability, correctionCapability(this.config.bridgeSecret, this.config.enrollment, correction)));
        const row = s.gradeCorrections?.find(row => row.correction.id === correction.id); invalid(row && canonical(row.correction) === canonical(correction));
        validateCompanionGradeCorrectionReceipt(e.payload.receipt, correction); const receipt = e.payload.receipt;
        if (row.receipt) invalid(canonical(row.receipt) === canonical(receipt), "correction receipt collision");
        else {
          const editable = s.editableGrades?.find(grade => grade.attemptId === correction.attemptId);
          if (receipt.status === "applied") {
            // Revoking selection cannot erase acknowledgement of an already committed correction.
            if (editable) { invalid(editable.reviewEventId === correction.expectedReviewEventId); editable.reviewEventId = receipt.reviewEventId!; editable.rating = correction.rating; }
          } else s.editableGrades = s.editableGrades?.filter(grade => grade.attemptId !== correction.attemptId);
          row.receipt = clone(receipt);
          const attempt = this.resultAttempt(s, correction.attemptId); invalid(attempt);
          if (attempt.offline && receipt.status === "applied") s.offlineHeads = s.offlineHeads?.filter(head => head.cardId !== attempt.cardId);
          this.gradePanel(s, attempt, now, receipt.status === "applied" ? "applied" : "correction-rejected");
        }
        response = { id: correction.id, status: receipt.status };
      } else {
        keys(e.payload, ["attempt", "capability", "receipt", "correctable"]); validateAttempt(e.payload.attempt); const attempt = e.payload.attempt;
        invalid(e.payload.correctable === undefined || typeof e.payload.correctable === "boolean");
        invalid(attempt.scope === this.config.scope && attempt.epoch === this.config.epoch && typeof e.payload.capability === "string" && equal(e.payload.capability, this.capability(attempt)));
        record(e.payload.receipt); const receipt = e.payload.receipt;
        keys(receipt, attempt.mode === "core" ? ["attempt", "status", "reviewEventId", "nextDueAt", "charge"] : ["attempt", "status", "reviewEventId", "nextDueAt"]);
        record(receipt.attempt);
        const { offline: _offline, ...publicAttempt } = attempt;
        invalid(canonical(receipt.attempt) === canonical(attempt.mode === "core" ? { ...publicAttempt, receivedAt: attempt.occurredAt } : publicAttempt));
        invalid(statuses.includes(receipt.status as ImportStatus)); const status = receipt.status as ImportStatus;
        invalid(attempt.mode === "core" || ["applied", "stale", "epoch-mismatch", "missing", "ineligible", "local-session-active", "expired", "clock-mismatch"].includes(status));
        if (attempt.mode === "core" && status === "applied") {
          token(receipt.reviewEventId); timestamp(receipt.nextDueAt); record(receipt.charge); keys(receipt.charge, ["day", "kind"]);
          invalid(Number.isSafeInteger(receipt.charge.day) && ["new", "review", "step"].includes(String(receipt.charge.kind)));
        } else if (attempt.mode === "bank" && status === "applied") {
          invalid(receipt.charge === undefined);
          if (e.payload.correctable === true || receipt.reviewEventId !== undefined || receipt.nextDueAt !== undefined) { token(receipt.reviewEventId); timestamp(receipt.nextDueAt); }
        } else invalid(receipt.reviewEventId === undefined && receipt.nextDueAt === undefined && receipt.charge === undefined);
        hydrateResult(s, this.journal.results, this.config.scope, this.config.epoch, attempt.id, now);
        const outcome = s.domain.outcomes.find(o => o.attempt.id === attempt.id);
        if (outcome) invalid(sameAttempt(outcome.attempt, attempt) && outcome.status === status && s.receipts.find(r => r.id === attempt.id)?.hash === digest(receipt));
        else {
          const pending = s.domain.pending.find(a => a.id === attempt.id); invalid(pending && sameAttempt(pending, attempt));
          s.receipts.push({ id: attempt.id, hash: digest(receipt) });
          s.domain.outcomes.push({ attempt: clone(attempt), status }); s.domain.pending = s.domain.pending.filter(a => a.id !== attempt.id);
          addResultOrdinal(s, attempt.id, status);
          s.claimedAttempts = s.claimedAttempts?.filter(id => id !== attempt.id);
          if (status === "applied" && e.payload.correctable === true) {
            const panel = s.outbox.find(row => row.ratingPanel?.attemptId === attempt.id);
            const miniResult = s.miniApp?.session.results.find(row => row.attemptId === attempt.id);
            const expiresAt = s.handles.find(handle => handle.id === attempt.id)?.expiresAt ?? (miniResult && s.miniApp?.session.snapshot.expiresAt) ?? s.studySession?.snapshot.expiresAt ?? s.domain.snapshot?.expiresAt ?? now;
            const source = miniResult?.card ?? (s.studySession && sessionCards(s.studySession).find(card => card.id === attempt.cardId && card.revision === attempt.revision)) ?? s.domain.snapshot?.cards.find(card => card.id === attempt.cardId && card.revision === attempt.revision);
            const withAttachments = !!(source?.hints?.length || source?.media?.length);
            const answerMatch = s.miniAppAttempts?.find(row => row.id === attempt.id)?.answerMatch ?? panel?.ratingPanel?.answerMatch;
            if (source && (s.materialConsentIds?.includes(source.materialId) ?? true) && (s.attachmentConsent !== false || !withAttachments)) (s.editableGrades ??= []).push({ attemptId: attempt.id, materialId: source.materialId, withAttachments, reviewEventId: receipt.reviewEventId as string, rating: attempt.rating, expiresAt, ...(answerMatch === undefined ? {} : { answerMatch }) });
          }
          this.gradePanel(s, attempt, now, status === "applied" ? "applied" : "rejected");
          if (attempt.offline && status !== "applied") { const root = decodeOfflineStep(attempt.offline).rootRevision;
            s.offlineHeads = s.offlineHeads?.filter(head => head.cardId !== attempt.cardId || decodeOfflineSeed(head.seed).rootRevision !== root); }
        }
        response = { id: attempt.id, status };
      }
      if (catalogCommit) {
        if (catalogCommit.payload.context) {
          const context = catalogCommit.payload.context; validateImmutableStudyContext(context);
          const cards = snapshotCardMap(s.domain.snapshot!), materials = new Set(s.materialConsentIds ?? []);
          invalid(context.cards.every(row => { const card = cards.get(row.id); return card && materials.has(card.materialId); }), "study metadata consent differs");
          s.studyContext = context;
        } else delete s.studyContext;
        s.catalogRoot = clone(catalogCommit.root); s.catalogRevision = catalogCommit.revision;
        response = { sequence: s.domain.snapshot!.sequence, revision: catalogCommit.revision };
      }
      s.nonces.push({ nonce: e.nonce as string, time: e.time as number, hash, response: clone(response) }); await this.commit(s); return clone(response);
    });
  }
  private capability(attempt: ReviewAttempt): string { return pendingCapability(this.config.bridgeSecret, this.config.enrollment, attempt); }
  private mediaErrorEdit(s: ServerState, target: Outbound): void {
    if (s.outbox.some(o => o.method === "editMessageText" && o.target === target.id)) return;
    this.enqueue(s, "editMessageText", { chat_id: this.config.ownerChatId, text: MEDIA_LOADING_ERROR, link_preview_options: { is_disabled: true } }, undefined, undefined, target.id, target.id);
  }
  private reconcileMediaFailures(s: ServerState): boolean {
    let changed = false;
    for (const item of [...s.outbox]) {
      if (item.status !== "unknown" || item.failureHandled || !(isMediaMethod(item.method) || item.mediaPlaceholder || item.hintPanel || item.questionPanel || item.method === "editMessageText" || item.method === "sendPoll" || item.method === "stopPoll" || item.method === "sendRichMessage")) continue;
      item.failureHandled = true; changed = true;
      if (item.richDemoPanel || item.method === "editMessageText" && s.outbox.find(row => row.id === item.target)?.richDemoPanel) {
        this.message(s, { text: "Не удалось подтвердить показ пробной карточки Rich Messages. Напишите /checkboxdemo, чтобы попробовать заново.", buttons: [] }, Date.now()); continue;
      }
      if (item.method === "sendPoll" || item.method === "stopPoll") {
        this.message(s, { text: item.method === "sendPoll" ? "Не удалось показать опрос. Напишите /go, чтобы продолжить." : "Не удалось закрыть опрос. Напишите /go, чтобы продолжить.", buttons: [] }, Date.now()); continue;
      }
      if (item.questionPanel) { this.message(s, { text: "Не удалось показать вопрос. Напишите /go, чтобы продолжить.", buttons: [] }, Date.now()); continue; }
      if (item.hintPanel) { this.message(s, { text: "Не удалось показать подсказки. Напишите /go, чтобы повторить.", buttons: [] }, Date.now()); continue; }
      const target = item.target === undefined ? undefined : s.outbox.find(o => o.id === item.target);
      if (item.method === "editMessageText" && (target?.ratingPanel || target?.sessionPanel || target?.hintPanel || target?.questionPanel)) {
        this.message(s, { text: target.questionPanel ? "Не удалось обновить выбор. Напишите /go, чтобы продолжить." : target.hintPanel ? "Не удалось обновить подсказки. Напишите /go, чтобы продолжить." : target.ratingPanel ? "Не удалось обновить сообщение с оценкой. Проверьте её состояние через /status." : "Не удалось обновить панель занятия. Напишите /go, чтобы продолжить.", buttons: [] }, Date.now()); continue;
      }
      if (item.method === "editMessageMedia" && target?.status === "sent" && target.messageId !== undefined) this.mediaErrorEdit(s, target);
      else this.message(s, { text: MEDIA_LOADING_ERROR, buttons: [] }, Date.now());
    }
    return changed;
  }
  private cancelQueuedContent(s: ServerState, cancelled: Set<string>): void {
    // Remove queued ancestors/descendants as one content group, retaining every started target.
    for (const row of [...s.outbox].reverse()) if (cancelled.has(row.id) && row.after !== undefined && s.outbox.find(o => o.id === row.after)?.status === "queued") cancelled.add(row.after);
    for (const row of s.outbox) if (row.status === "queued" && row.after !== undefined && cancelled.has(row.after)) cancelled.add(row.id);
    const targets = s.outbox.filter(o => cancelled.has(o.id) && o.method === "editMessageMedia").map(o => s.outbox.find(target => target.id === o.target)).filter((o): o is Outbound => o?.status === "sent" && o.messageId !== undefined);
    s.outbox = s.outbox.filter(o => o.status !== "queued" || !cancelled.has(o.id));
    for (const target of targets) this.mediaErrorEdit(s, target);
  }
  private async mediaFailed(): Promise<void> {
    await this.serial(async () => { invalid(this.active); const s = cloneServerState(this.state); if (this.reconcileMediaFailures(s)) await this.commit(s); });
  }
  /** Call periodically; notices never alter Core/Bank scheduling or attempts. */
  async tick(now: number): Promise<void> {
    timestamp(now); return this.serial(async () => {
      invalid(this.active); const s = cloneServerState(this.state), retired = this.retirePolls(s, now);
      if (s.studyPlan !== undefined) {
        if (now < s.lastSession || now < s.bridgeTimeFloor) { if (retired) await this.commit(s); return; }
        this.reconcilePlanDeliveries(s, now);
        if (now >= s.lastSession && now >= s.bridgeTimeFloor) {
          s.lastSession = now;
          const delivered = new Set((s.studyPlanSent ?? []).map(row => row.id + ":" + row.notifyAt));
          const due = s.studyPlan.entries.filter(entry => entry.notifyAt <= now && now - entry.notifyAt < 15 * 60000
            && !delivered.has(entry.id + ":" + entry.notifyAt) && this.planDeliveryAllowed(s, entry.id, entry.notifyAt, now));
          for (const entry of due.sort((a, b) => b.notifyAt - a.notifyAt || a.id.localeCompare(b.id)).slice(0, 3)) {
            (s.studyPlanSent ??= []).push({ id: entry.id, notifyAt: entry.notifyAt });
            const delivery = this.planDelivery(s, entry.id)!;
            const id = this.enqueue(s, "sendMessage", studyPlanPayload(this.config.ownerChatId, delivery));
            s.outbox.find(row => row.id === id)!.studyPlanEntry = delivery;
          }
        }
        await this.commit(s); return;
      }
      const latest = latestSession(now, this.config.timeZone, this.config.sessionsLocal);
      if (!latest || latest <= s.lastSession || s.lastSession && sessionOrder(latest, this.config.timeZone) <= sessionOrder(s.lastSession, this.config.timeZone)) { if (retired) await this.commit(s); return; }
      s.lastSession = latest;
      if (s.domain.reminders.enabled && s.domain.reminders.skippedDay !== studyDay(now, this.config.timeZone) && now >= s.mutedUntil && s.domain.snapshot && companionSnapshotIsCurrent(s.domain.snapshot, now) && this.page(s, now, { kind: "go" }).cards.length) {
        this.message(s, { text: DAILY_REMINDER_TEXT, buttons: [
          { text: "Через 12 часов", action: { kind: "snooze", hours: 12 } }, { text: "Через 24 часа", action: { kind: "snooze", hours: 24 } }, { text: "До следующей сессии", action: { kind: "snooze", hours: "next" } }, { text: "Пропустить учебный день", action: { kind: "skip" } }
        ] }, now);
      }
      await this.commit(s);
    });
  }
  private planDelivery(s: ServerState, id: string): StudyPlanDelivery | undefined {
    const entry = s.studyPlan?.entries.find(row => row.id === id);
    if (!entry || !this.config.miniAppUrl || !s.studyPlan) return;
    return { id: entry.id, notifyAt: entry.notifyAt, startAt: entry.startAt, title: entry.title, timeZone: s.studyPlan.timeZone, miniAppUrl: this.config.miniAppUrl };
  }
  private planDeliveryAllowed(s: ServerState, id: string, notifyAt: number, now: number): boolean {
    const entry = activeStudyPlanEntry(s, id, now);
    return !!this.config.miniAppUrl && !!entry && entry.notifyAt === notifyAt && notifyAt <= now && now - notifyAt < 15 * 60000
      && !companionPlanEntryPending(s, id, entry.action?.revision) && planNotificationsAllowed(s, now, this.config.timeZone);
  }
  private reconcilePlanDeliveries(s: ServerState, now: number): void {
    s.outbox = s.outbox.filter(row => {
      if (s.studyPlan && row.status === "queued" && row.payload.text === DAILY_REMINDER_TEXT) return false;
      if (!row.studyPlanEntry || row.status !== "queued") return true;
      if (!this.planDeliveryAllowed(s, row.studyPlanEntry.id, row.studyPlanEntry.notifyAt, now)) return false;
      row.studyPlanEntry = this.planDelivery(s, row.studyPlanEntry.id)!;
      row.payload = studyPlanPayload(this.config.ownerChatId, row.studyPlanEntry); return true;
    });
    if (s.studyPlanSent) {
      const retained = new Set(s.outbox.flatMap(row => row.studyPlanEntry ? [row.studyPlanEntry.id + ":" + row.studyPlanEntry.notifyAt] : []));
      s.studyPlanSent = s.studyPlanSent.filter(row => retained.has(row.id + ":" + row.notifyAt) || now - row.notifyAt < 8 * 86400000);
    }
  }
  /** Queued intents are safe to start after restart; unknown intents NEVER retry automatically.
   * Persist unknown before crossing the external side-effect boundary. */
  private async flushLane(callbacks: boolean): Promise<void> {
      if (this.transport.ready && !this.transport.ready()) return;
      for (let i = 0; i < 100; i++) {
        const selected = await this.serial(async () => {
          // The private state was validated at its last durable commit; never mutate it while selecting.
          invalid(this.active);
          const byId = new Map(this.state.outbox.map(row => [row.id, row]));
          const queued = this.state.outbox.find(o => o.status === "queued" && (o.method === "answerCallbackQuery") === callbacks
            && (o.after === undefined || byId.get(o.after)?.status === "sent")
            && (o.target === undefined || byId.get(o.target)?.status === "sent" && byId.get(o.target)?.messageId !== undefined)); if (!queued) return undefined;
          const queuedAt = this.queuedAt.get(queued.id);
          if (queuedAt !== undefined) recordPerformance(this.observe, callbacks ? "runtime.callback_queue" : "runtime.queue", performance.now() - queuedAt);
          const targetMessageId = queued.target === undefined ? undefined : byId.get(queued.target)!.messageId;
          const gradeAnswer = queued.method === "editMessageText" && queued.target !== undefined ? byId.get(queued.target)?.ratingPanel?.answerText : undefined;
          const s = cloneServerState(this.state); s.outbox.find(o => o.id === queued.id)!.status = "unknown"; await this.commit(s); return { item: clone(queued), targetMessageId, gradeAnswer };
        });
        if (!selected) return; const { item, targetMessageId, gradeAnswer } = selected;
        let result: TransportResult, superseded = false;
        const authorize = (): boolean => {
          if (!this.active) return false;
          if (this.config.miniAppUrl && (item.sessionContent || item.questionPanel || item.pollPanel || item.richDemoPanel || item.hintLease || item.hintPanel)) return false;
          if (item.miniAppPlan !== undefined && !this.planLaunchEntry(this.state, item.miniAppPlan, Date.now())) return false;
          if (item.studyPlanEntry && (!this.planDeliveryAllowed(this.state, item.studyPlanEntry.id, item.studyPlanEntry.notifyAt, Date.now())
            || canonical(this.planDelivery(this.state, item.studyPlanEntry.id)) !== canonical(item.studyPlanEntry))) return false;
          if (item.method === "sendRichMessage" || item.method === "editMessageText" && item.payload.rich_message !== undefined) {
            const demo = this.state.outbox.find(row => row.id === (item.richDemoPanel ? item.id : item.target)), panel = demo?.richDemoPanel;
            if (!demo || !panel || Date.now() >= panel.expiresAt) return false;
            const expected = richCheckboxDemoView({ ...readRichCheckboxDemoMessage(demo.payload.rich_message), selectedOptionIndexes: panel.selectedOptionIndexes, checked: panel.checked });
            if (canonical(expected) !== canonical(item.payload.rich_message)) { superseded = item.method === "editMessageText"; return false; }
          }
          if (item.method === "sendPoll") {
            const poll = this.state.outbox.find(row => row.id === item.id);
            if (!poll || !this.pollAllowed(this.state, poll, Date.now())) return false;
          }
          const rating = this.state.outbox.find(row => row.id === (item.ratingPanel ? item.id : item.target));
          if (rating?.ratingPanel?.answerText !== undefined && carriesGradeAnswer(item.payload.text, rating) && !ratingAnswerAllowed(this.state, rating, Date.now())) return false;
          if (!item.sessionContent) return true;
          const session = this.state.studySession;
          if (!(session?.id === item.sessionContent.sessionId && Date.now() < session.snapshot.expiresAt
            && session.snapshot.cards.every(card => (this.state.materialConsentIds?.includes(card.materialId) ?? false) && (this.state.attachmentConsent !== false || !card.media?.length && !card.hints?.length)
              && (!card.offline || this.state.offlineConsent === true && Date.now() < decodeOfflineSeed(card.offline).expiresAt)))) return false;
          const hint = this.state.outbox.find(row => row.id === (item.hintPanel ? item.id : item.target));
          try {
            if (item.sessionContent.cardId !== undefined) {
              const cardId = item.sessionContent.cardId, revision = item.sessionContent.revision;
              const historical = session.results.some(row => row.cardId === cardId && row.card?.revision === revision);
              const live = this.effectiveSnapshot(this.state, Date.now())?.cards.find(card => card.id === cardId && card.revision === revision);
              if (!historical && (!live || !session.current || canonical(session.current) !== canonical(live))) return false;
            }
            const question = this.state.outbox.find(row => row.id === (item.questionPanel ? item.id : item.target));
            if (question?.questionPanel) {
              // A new prompt is not confirmed yet; its controls still must be live and its source unchanged.
              const card = this.questionCard(this.state, question, Date.now(), !item.questionPanel), view = this.questionView(this.state, question, card, Date.now());
              const rows = (item.payload.reply_markup as { inline_keyboard: { text: string; style?: string }[][] }).inline_keyboard.map(row => row.map(button => ({ text: button.text, ...(button.style ? { style: button.style } : {}) })));
              const expected = groupCompanionButtons(view.buttons, button => ({ text: button.text, ...(button.style ? { style: button.style } : {}) }));
              if (item.payload.text !== view.text || canonical(rows) !== canonical(expected)) {
                superseded = item.method === "editMessageText" && item.target === question.id; return false;
              }
            }
            if (hint?.hintPanel) {
              const card = this.hintCard(this.state, hint, Date.now()), p = hint.hintPanel;
              if (item.payload.text !== hintPanelView(card.hints!, p.count, p.index, p.collapsed).text) return false;
            }
          } catch { return false; }
          return true;
        };
        try {
          const reminderLaunch = item.method === "sendMessage" && item.payload.text === DAILY_REMINDER_TEXT && this.config.miniAppUrl;
          const appLaunch = item.method === "sendMessage" && item.payload.text === MINI_APP_LAUNCH_TEXT && this.config.miniAppUrl;
          const vaultId = this.config.miniAppVaultId;
          const owned = item.studyPlanEntry ? { studyPlan: clone(item.studyPlanEntry) } : reminderLaunch ? { miniAppUrl: reminderLaunch }
            : appLaunch ? { miniAppUrl: appLaunch, ...(item.miniAppPlan ? { planId: item.miniAppPlan } : {}) } : undefined;
          const payload = { ...(item.studyPlanEntry && vaultId ? studyPlanPayload(this.config.ownerChatId, item.studyPlanEntry, vaultId)
            : reminderLaunch ? reminderMiniAppPayload(clone(item.payload), reminderLaunch, vaultId) : clone(item.payload)),
            ...(appLaunch ? { reply_markup: { inline_keyboard: [[{ text: "Открыть занятие", web_app: { url: miniAppLaunchUrl(appLaunch, item.miniAppPlan, vaultId) } }]] } } : {}),
            ...(targetMessageId === undefined ? {} : { message_id: targetMessageId }), ...(gradeAnswer === undefined ? {} : { gradeAnswer }) };
          result = await this.transport.call(item.method, payload, authorize, owned && vaultId ? { ...owned, vaultId } : owned);
        }
        catch {
          if (superseded) {
            // Authorization ran before HTTP: a newer selection replaces this unsent edit quietly.
            await this.serial(async () => { invalid(this.active); const s = cloneServerState(this.state); invalid(!s.outbox.some(row => row.after === item.id || row.target === item.id)); s.outbox = s.outbox.filter(row => row.id !== item.id); await this.commit(s); });
          } else if (!callbacks) await this.mediaFailed();
          continue;
        }
        const pollResult = typeof result === "object" && result !== null ? result : undefined;
        if (item.method === "sendPoll" ? !pollResult || !validNativePollId(pollResult.pollId) : pollResult !== undefined || item.method === "stopPoll" && result !== undefined) { await this.mediaFailed(); continue; }
        const messageId = pollResult?.messageId ?? (typeof result === "number" ? result : undefined);
        if (((item.answerHandle !== undefined || item.mediaPlaceholder || item.hintPanel || item.questionPanel || item.pollPanel || item.richDemoPanel) && messageId === undefined) || (isEditMethod(item.method) && messageId !== targetMessageId) || (messageId !== undefined && (!Number.isSafeInteger(messageId) || messageId <= 0))) { await this.mediaFailed(); continue; }
        const confirmed = await this.serial(async () => {
          invalid(this.active); const s = cloneServerState(this.state), row = s.outbox.find(o => o.id === item.id)!;
          // A repeated/invalid Bot API ID cannot establish a second reply binding.
          if (!isEditMethod(item.method) && messageId !== undefined && s.outbox.some(o => o.messageId === messageId)) return false;
          if (pollResult && s.outbox.some(o => o.pollPanel?.pollId === pollResult.pollId)) return false;
          row.status = "sent"; if (item.method !== "answerCallbackQuery" && !isEditMethod(item.method) && messageId !== undefined) row.messageId = messageId;
          if (row.pollPanel && pollResult) { row.pollPanel.pollId = pollResult.pollId; if (row.pollPanel.sealed) this.sealPoll(s, row); }
          await this.commit(s); return true;
        });
        if (!confirmed) await this.mediaFailed();
      }
  }
  private flushCallbacks(): Promise<void> {
    return this.callbackFlushing ??= this.flushLane(true).finally(() => { this.callbackFlushing = undefined; });
  }
  flushAcknowledgements(): Promise<void> { return this.flushCallbacks(); }
  async flush(): Promise<void> {
    const callbacks = this.flushCallbacks();
    const content = this.flushing ??= this.flushLane(false).finally(() => { this.flushing = undefined; });
    const results = await Promise.allSettled([callbacks, content]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (failed) throw failed.reason;
  }
}
