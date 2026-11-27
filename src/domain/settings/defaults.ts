import type { Settings } from "./types";
import { DEFAULT_RECALL_HINT_LIMIT } from "../cards/recall-test-core";
import { DEFAULT_UI_ICON_SCALE, DEFAULT_UI_FONT_SCALE } from "../../shared/constants";
import { DEFAULT_VAULT_SNAPSHOT_PATH } from "../data/snapshot-core";
import { DEFAULT_MEDIA_CLIP_FOLDER } from "../media/clip-destination";
import { DEFAULT_SIDEBAR_CARDS_PER_PAGE } from "./sidebar-pagination";
import { DEFAULT_LIBRARY_NAVIGATION_POSITION } from "./library-navigation";
export { DEFAULT_DAILY_WORKLOAD_SETTINGS } from "../review/daily-workload";


export const DEFAULT_SETTINGS: Settings = {
  showAnchors: true, defaultOffsets: "1h, 1d, 3d, 1w, 1mo",
  studyRangeAppearance: "rope",
  repeatLast: true, channels: ["obsidian", "windows"],
  noticeDurationSeconds: 12, noticePosition: "top-right", defaultIntervalPresetId: null, tagFocus: null, topicFocusId: null, customTags: [], customIntervalPresets: [],
  metadataTopicOrder: {}, metadataTagOrder: [], metadataSets: [],
  defaultTestEnabled: false, lastCardCreationMode: "single", lastBatchTemplateId: "choices",
  mediaFfmpegPath: "ffmpeg", mediaFfprobePath: "", mediaClipLastFolder: DEFAULT_MEDIA_CLIP_FOLDER,
  maxRecallHints: DEFAULT_RECALL_HINT_LIMIT, showCardHintGuides: true, uiIconScale: DEFAULT_UI_ICON_SCALE,
  hideImportedMarkdownCardBanner: true,
  uiIconStyle: "simple",
  uiCustomIcons: {},
  uiFontScale: DEFAULT_UI_FONT_SCALE, uiDensity: "auto", wrapLongUiText: true,
  sidebarCardsPerPage: DEFAULT_SIDEBAR_CARDS_PER_PAGE,
  libraryNavigationPosition: DEFAULT_LIBRARY_NAVIGATION_POSITION,
  libraryCardLayout: "comfortable",
  libraryMaterialLayout: "comfortable",
  libraryRuleLayout: "comfortable",
  libraryCardFolders: true,
  libraryMaterialFolders: true,
  libraryRuleFolders: true,
  uiAppearance: { base: "obsidian", overrides: {} },
  warnOnRepeatedBatchAnswers: true, defaultFreeAnswerEvaluation: "self", defaultTestScheduler: "fsrs",
  answerRetention: { enabled: false, changedAt: 0 },
  skipReviewResultScreen: true, ratingKeyboardShortcuts: true, allowTestBypass: false,
  fsrsDesiredRetention: 0.9,
  fsrsShortTermEnabled: true, fsrsLearningSteps: "1m, 10m", fsrsRelearningSteps: "10m",
  fsrsParameters: null, fsrsParametersOptimizedAt: 0, fsrsParametersReviewCount: 0, dailyReviewLimit: 20,
  dailySessionMinutes: 20, refillSessionAfterBreak: false, sessionBreakMinutes: 5, sessionOrderMode: "balanced", relatedRoundSettleRating: 3,
  siblingSpacingEnabled: false, siblingSpacingMode: "study-day", siblingSpacingMinutes: 1440,
  shuffleSessionOnStart: false, showSessionKeyboardGuide: true, activeReviewSession: null,
  practiceSessionLimit: 10, practiceSessionMinutes: 20, practiceSessionOrder: "balanced",
  practiceSessionShuffle: false, practiceSessionShowRules: false, practiceSessionIncludeCore: false,
  snapshotStorageLocation: "plugin", snapshotVaultPath: DEFAULT_VAULT_SNAPSHOT_PATH, snapshotExternalPath: "",
  reviewRatingLabels: { 1: "Не вспомнил", 2: "Трудно", 3: "Нормально", 4: "Легко" },
  googleCalendarEnabled: false, googleCalendarId: "", googleCalendarSourceId: "", googleCalendarName: "Anchor Recall",
  googleCalendarDailyEnabled: true, googleCalendarDailyTime: "19:00", googleCalendarDailyDurationMinutes: 30, googleCalendarDailyTitle: "Повторение", googleCalendarDailyIncludeEmptyDays: true, googleCalendarReminderMinutes: 15, googleCalendarReminderChannel: "both", googleCalendarHorizonDays: 14, googleCalendarLastSyncAt: 0
};
