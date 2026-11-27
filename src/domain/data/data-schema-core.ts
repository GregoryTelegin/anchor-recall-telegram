import { normalizeExternalReviews, type ExternalReviews } from "../review/external-review";
import { normalizeRecallTest } from "../cards/recall-test-core";
import { normalizeStudyRange } from "../anchors/study-range-core";
import { validateCardAttachments } from "../cards/card-attachments";
import { validateMediaRange } from "../media/media-range";
import { validateBookmarkExportedClip } from "../anchors/bookmark-clip";
import type { CardAttachment } from "../cards/card-attachments";
import { validateLearningLibrary, validateCardLearningFields, type LearningLibraryState } from "../library/learning-library-core";
import { validUnitBindings } from "../library/unit-bindings";
import { compactImportSourceReference } from "../cards/import-source-identity";
import type { PackageQuestionRef } from "../library/learning-library-core";
import { isSourceFileId, validateSourceCatalog, type SourceFileRecord } from "../anchors/source-catalog";
import { isValidCardClarification, normalizeCardClarification } from "../cards/card-clarification";
import { normalizeDailyWorkloadSettings, normalizeWorkloadDay, type DailyWorkloadSettings, type WorkloadDay } from "../review/daily-workload";
import { normalizeStudyTasks, type StudyTask } from "../planning/study-task";
import { normalizeStudyTaskSeries, validateStudyTaskSeriesLinks, type StudyTaskSeries } from "../planning/study-task-recurrence";
import { normalizeStudyAutoplanState, type StudyAutoplanState } from "../planning/study-autoplan";

export const CURRENT_DATA_SCHEMA_VERSION = 1 as const;

export type JsonRecord = Record<string, unknown>;

export interface PersistedMaterialV1 {
  sourceId?: string;
  id: string;
  anchorId: string;
  filePath: string;
  title: string;
  tags: string[];
  topicIds: string[];
  relatedMaterialIds: string[];
  createdAt: number;
  importKey?: string;
  anchor: JsonRecord;
}

export interface PersistedCardV1 extends JsonRecord {
  id: string;
  materialId: string;
  title?: string;
  tags?: string[];
  topicIds?: string[];
  createdAt: number;
  dueAt: number;
  offsetsMinutes: number[];
  deliveredSteps: number[];
  repeatCount: number;
  repeatLast: boolean;
  status: "active" | "completed" | "paused";
  cycleIndex: number;
}

export interface PersistedReviewEventV1 extends JsonRecord {
  id: string;
  cardId: string;
  reviewedAt: number;
  previousDueAt: number;
  cycle: number;
}

export interface PersistedBookmarkV1 {
  sourceId?: string;
  id: string;
  anchorId: string;
  filePath: string;
  title: string;
  note: string;
  tags: string[];
  topicIds: string[];
  hiddenFromLibrary?: boolean;
  unitId?: string;
  unitIds?: string[];
  createdAt: number;
  updatedAt: number;
  anchor: JsonRecord;
  exportedClip?: CardAttachment;
}

export interface PersistedDataV1 {
  studyTasks?: StudyTask[];
  studyTaskSeries?: StudyTaskSeries[];
  studyAutoplan?: StudyAutoplanState;
  externalReviews?: ExternalReviews;
  externalReviewsSecondary?: ExternalReviews;
  workloadDay?: WorkloadDay;
  sourceCatalog?: SourceFileRecord[];
  learningLibrary?: LearningLibraryState;
  schemaVersion: typeof CURRENT_DATA_SCHEMA_VERSION;
  dataRevision: number;
  savedAt: number;
  settings: JsonRecord;
  topics: unknown[];
  materials: PersistedMaterialV1[];
  cards: PersistedCardV1[];
  reviewEvents: PersistedReviewEventV1[];
  bookmarks: PersistedBookmarkV1[];
}

export interface DataValidationResult {
  valid: boolean;
  errors: string[];
  data?: PersistedDataV1;
}

const ANCHOR_FIELDS = [
  "studyRange",
  "anchorType", "page", "pageY", "scrollRatio", "fragmentText", "line", "ch", "scrollTop", "mdOffset", "mdBefore", "mdAfter", "mdSelection",
  "pdfLeft", "pdfTop", "pdfZoom", "embeddedPdfPath", "embeddedPdfIndex", "embeddedPdfLine",
  "canvasX", "canvasY", "canvasZoom", "canvasNodeIds", "canvasFilePaths", "canvasPdfPath", "canvasDocxPath", "canvasPptxPath", "canvasXlsxPath", "canvasImagePath",
  "canvasMediaPath", "embeddedMediaPath", "embeddedMediaIndex", "embeddedMediaLine",
  "epubLocation", "epubChapter", "epubPercentage", "epubScrollX", "epubScrollY", "epubStorageKey", "epubStorageValue",
  "imageX", "imageY", "imageNaturalWidth", "imageNaturalHeight",
  "docxPage", "docxPageY", "docxScrollX", "docxScrollY", "docxZoom", "docxTextOffset", "docxBefore", "docxAfter",
  "pptxSlide", "pptxX", "pptxY", "pptxZoom",
  "xlsxSheetIndex", "xlsxSheetName", "xlsxStartRow", "xlsxStartColumn", "xlsxEndRow", "xlsxEndColumn", "xlsxScrollLeft", "xlsxScrollTop", "xlsxZoom",
  "excalidrawElementIds", "excalidrawScrollX", "excalidrawScrollY", "excalidrawZoom",
  "mediaTime", "mediaDuration", "mediaProgress", "mediaKind", "mediaRange", "mediaSourceVersion",
  "textLine", "textColumn", "textOffset", "textBefore", "textAfter", "textSelection", "textKind", "canvasTextPath"
] as const;

const CARD_FIELDS = [
  "id", "materialId", "title", "tags", "topicIds", "createdAt", "dueAt", "offsetsMinutes", "deliveredSteps", "repeatCount", "repeatLast", "status", "cycleIndex", "lastReviewedAt",
  "intervalPresetName", "test", "schedulerMode", "fsrsCard", "sm2State", "leitnerState", "needsClarification", "clarification",
  "cardRole", "unitId", "unitIds", "ruleIds", "linkedMaterialIds", "detachedMaterialId", "practiceHistory", "archivedLegacySchedule", "packageQuestionRef"
] as const;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isNumberArray = (value: unknown): value is number[] => Array.isArray(value) && value.every(isFiniteNumber);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const validMaterialLinks = (value: unknown, known: ReadonlySet<string>): value is string[] => Array.isArray(value)
  && value.length <= 10_000 && new Set(value).size === value.length
  && Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index)
    && typeof value[index] === "string" && value[index] === value[index].trim() && known.has(value[index])).every(Boolean);

const mediaAnchorMetadataError = (anchor: JsonRecord): string | undefined => {
  if (anchor.mediaRange === undefined && anchor.mediaSourceVersion === undefined) return undefined;
  if (!["media", "media-embed", "canvas-media"].includes(String(anchor.anchorType))) return "временной фрагмент допустим только для медиа-якоря.";
  if (anchor.mediaRange !== undefined) {
    const checked = validateMediaRange(anchor.mediaRange); if (!checked.valid) return checked.error;
    if (anchor.mediaDuration !== undefined && (!isFiniteNumber(anchor.mediaDuration) || checked.range.end > anchor.mediaDuration))
      return "конец фрагмента выходит за длительность медиафайла.";
  }
  if (anchor.mediaSourceVersion !== undefined) {
    const version = anchor.mediaSourceVersion;
    if (!isRecord(version) || Object.keys(version).some(key => key !== "size" && key !== "mtime")
      || !isFiniteNumber(version.size) || !Number.isInteger(version.size) || version.size < 0
      || !isFiniteNumber(version.mtime) || version.mtime < 0) return "повреждена версия исходного медиафайла.";
  }
  return undefined;
};

const pickFields = (source: JsonRecord, fields: readonly string[]): JsonRecord => {
  const result: JsonRecord = {};
  fields.forEach((field) => { if (source[field] !== undefined) result[field] = source[field]; });
  return result;
};

const copyLearningCardFields = (source: JsonRecord): JsonRecord => ({
  ...(source.clarification !== undefined ? { clarification: normalizeCardClarification(source.clarification) } : {}),
  ...(Array.isArray(source.unitIds) ? { unitIds: [...source.unitIds] } : {}),
  ...(Array.isArray(source.ruleIds) ? { ruleIds: [...source.ruleIds] } : {}),
  ...(Array.isArray(source.linkedMaterialIds) ? { linkedMaterialIds: [...source.linkedMaterialIds] } : {}),
  ...(Array.isArray(source.practiceHistory) ? { practiceHistory: source.practiceHistory.map(item => ({ ...item })) } : {}),
  ...(isRecord(source.packageQuestionRef) ? { packageQuestionRef: compactImportSourceReference(source.packageQuestionRef as unknown as PackageQuestionRef) } : {}),
  ...(source.archivedLegacySchedule !== undefined ? { archivedLegacySchedule: JSON.parse(JSON.stringify(source.archivedLegacySchedule)) } : {})
});

const copyCardMetadataFields = (source: JsonRecord): JsonRecord => ({
  ...(isStringArray(source.tags) ? { tags: [...source.tags] } : {}),
  ...(isStringArray(source.topicIds) ? { topicIds: [...source.topicIds] } : {})
});

function normalizeExternalReviewAuthorities(value: JsonRecord): Pick<PersistedDataV1, "externalReviews" | "externalReviewsSecondary"> {
  const externalReviews = normalizeExternalReviews(value.externalReviews);
  const externalReviewsSecondary = normalizeExternalReviews(value.externalReviewsSecondary);
  if (externalReviews && externalReviewsSecondary?.scope === externalReviews.scope)
    throw new Error("Повторяющийся идентификатор подключения Telegram.");
  return {
    ...(externalReviews !== undefined ? { externalReviews } : {}),
    ...(externalReviewsSecondary !== undefined ? { externalReviewsSecondary } : {})
  };
}

export const createPersistedDataV1 = (value: unknown, now = Date.now(), dataRevision = 1, materialBaseline?: PersistedDataV1 | null): PersistedDataV1 | undefined => {
  if (!isRecord(value) || !isRecord(value.settings) || !Array.isArray(value.reminders) || !Array.isArray(value.topics)) return undefined;
  let authorities: ReturnType<typeof normalizeExternalReviewAuthorities>;
  let sourceCatalog: SourceFileRecord[] | undefined;
  let workloadDay: WorkloadDay | undefined, dailyWorkload: DailyWorkloadSettings | undefined;
  try { authorities = normalizeExternalReviewAuthorities(value); workloadDay = normalizeWorkloadDay(value.workloadDay); dailyWorkload = normalizeDailyWorkloadSettings(value.settings.dailyWorkload); }
  catch { return undefined; }
  try { if (value.sourceCatalog !== undefined) sourceCatalog = validateSourceCatalog(value.sourceCatalog); }
  catch { return undefined; }
  const sources = new Map((sourceCatalog ?? []).map(source => [source.id, source]));
  const validSource = (owner: JsonRecord): boolean => owner.sourceId === undefined
    || isSourceFileId(owner.sourceId) && sources.get(owner.sourceId)?.path === owner.filePath;
  const reminders = value.reminders.filter(isRecord);
  if (reminders.length !== value.reminders.length) return undefined;
  const topicIds = new Set(value.topics.filter(isRecord).map(topic => String(topic.id)));
  const library = validateLearningLibrary(value.learningLibrary, topicIds);
  if (!library.valid || reminders.some(reminder => validateCardLearningFields(reminder, library.library).length)) return undefined;
  const bookmarkSources = value.bookmarks === undefined ? [] : Array.isArray(value.bookmarks) ? value.bookmarks.filter(isRecord) : [];
  if ((value.bookmarks !== undefined && !Array.isArray(value.bookmarks))
    || (Array.isArray(value.bookmarks) && bookmarkSources.length !== value.bookmarks.length)) return undefined;
  const savedMaterialIds = new Set(bookmarkSources.map(bookmark => String(bookmark.id)));
  if (reminders.some(card => card.linkedMaterialIds !== undefined && !validMaterialLinks(card.linkedMaterialIds, savedMaterialIds))
    || library.library.rules.some(rule => rule.materialIds !== undefined && !validMaterialLinks(rule.materialIds, savedMaterialIds))) return undefined;
  const flatShapeIsValid = reminders.every((reminder) => nonEmptyString(reminder.id)
    && (reminder.detachedMaterialId === undefined || nonEmptyString(reminder.materialId) && reminder.detachedMaterialId === reminder.materialId)
    && typeof reminder.filePath === "string" && typeof reminder.title === "string" && validSource(reminder)
    && (reminder.tags === undefined || isStringArray(reminder.tags))
    && (reminder.topicIds === undefined || (isStringArray(reminder.topicIds) && reminder.topicIds.every(id => topicIds.has(id))))
    && isFiniteNumber(reminder.createdAt) && isFiniteNumber(reminder.dueAt)
    && nonEmptyString(reminder.anchorType) && isNumberArray(reminder.offsetsMinutes)
    && isNumberArray(reminder.deliveredSteps) && isFiniteNumber(reminder.repeatCount)
    && typeof reminder.repeatLast === "boolean" && ["active", "completed", "paused"].includes(String(reminder.status))
    && isValidCardClarification(reminder.clarification)
    && isFiniteNumber(reminder.cycleIndex) && Array.isArray(reminder.reviewHistory)
    && (!isRecord(reminder.test) || validateCardAttachments(reminder.test.attachments).valid)
    && !mediaAnchorMetadataError(reminder)
    && reminder.reviewHistory.every((entry) => isRecord(entry) && nonEmptyString(entry.id)
      && isFiniteNumber(entry.reviewedAt) && isFiniteNumber(entry.previousDueAt) && isFiniteNumber(entry.cycle)));
  if (!flatShapeIsValid) return undefined;
  if (bookmarkSources.some(bookmark => !validSource(bookmark) || mediaAnchorMetadataError(isRecord(bookmark.anchor) ? bookmark.anchor : bookmark)
    || !validateBookmarkExportedClip(bookmark.exportedClip).valid
    || (bookmark.hiddenFromLibrary !== undefined && typeof bookmark.hiddenFromLibrary !== "boolean")
    || (isRecord(bookmark.anchor) && bookmark.anchor.hiddenFromLibrary !== undefined)
    || (isRecord(bookmark.anchor) && bookmark.anchor.exportedClip !== undefined)
    || (isRecord(bookmark.anchor) && bookmark.anchor.sourceId !== undefined)
    || !validUnitBindings(bookmark, new Set(library.library.units.map(unit => unit.id))))) return undefined;
  const materialRepresentatives = new Map<string, JsonRecord>();
  const materialSources = new Map<string, unknown>();
  for (const reminder of reminders) {
    const materialId = nonEmptyString(reminder.materialId) ? reminder.materialId : String(reminder.id);
    if (materialSources.has(materialId) && materialSources.get(materialId) !== reminder.sourceId) return undefined;
    materialSources.set(materialId, reminder.sourceId);
  }
  reminders.forEach((reminder) => {
    const id = nonEmptyString(reminder.id) ? reminder.id : "";
    const materialId = nonEmptyString(reminder.materialId) ? reminder.materialId : id;
    const current = materialRepresentatives.get(materialId);
    if (!current || Number(reminder.createdAt) < Number(current.createdAt)) materialRepresentatives.set(materialId, reminder);
  });
  const materials: PersistedMaterialV1[] = [...materialRepresentatives.entries()].map(([materialId, reminder]) => ({
    id: materialId,
    anchorId: nonEmptyString(reminder.anchorId) ? reminder.anchorId : materialId,
    filePath: typeof reminder.filePath === "string" ? reminder.filePath : "",
    ...(reminder.sourceId !== undefined ? { sourceId: reminder.sourceId as string } : {}),
    title: typeof reminder.title === "string" ? reminder.title : "Напоминание",
    tags: isStringArray(reminder.tags) ? [...reminder.tags] : [],
    topicIds: isStringArray(reminder.topicIds) ? [...reminder.topicIds] : [],
    relatedMaterialIds: isStringArray(reminder.relatedMaterialIds) ? [...reminder.relatedMaterialIds] : [],
    createdAt: isFiniteNumber(reminder.createdAt) ? reminder.createdAt : now,
    ...(nonEmptyString(reminder.importKey) ? { importKey: reminder.importKey } : {}),
    anchor: pickFields(reminder, ANCHOR_FIELDS)
  }));
  const reviewEvents: PersistedReviewEventV1[] = [];
  const cards = reminders.map((reminder, reminderIndex): PersistedCardV1 => {
    const id = nonEmptyString(reminder.id) ? reminder.id : `card:${reminderIndex}`;
    const materialId = nonEmptyString(reminder.materialId) ? reminder.materialId : id;
    const history = reminder.reviewHistory as JsonRecord[];
    history.forEach((entry) => {
      reviewEvents.push({
        ...entry,
        id: entry.id as string,
        cardId: id,
        reviewedAt: entry.reviewedAt as number,
        previousDueAt: entry.previousDueAt as number,
        cycle: entry.cycle as number
      });
    });
    const picked = pickFields(reminder, CARD_FIELDS);
    Object.assign(picked, copyCardMetadataFields(reminder), copyLearningCardFields(reminder));
    return {
      ...picked,
      id,
      materialId,
      createdAt: isFiniteNumber(reminder.createdAt) ? reminder.createdAt : now,
      dueAt: isFiniteNumber(reminder.dueAt) ? reminder.dueAt : now,
      offsetsMinutes: isNumberArray(reminder.offsetsMinutes) ? [...reminder.offsetsMinutes] : [],
      deliveredSteps: isNumberArray(reminder.deliveredSteps) ? [...reminder.deliveredSteps] : [],
      repeatCount: isFiniteNumber(reminder.repeatCount) ? reminder.repeatCount : 0,
      repeatLast: reminder.repeatLast !== false,
      status: reminder.status === "completed" || reminder.status === "paused" ? reminder.status : "active",
      cycleIndex: isFiniteNumber(reminder.cycleIndex) ? reminder.cycleIndex : 0
    };
  });
  const bookmarks: PersistedBookmarkV1[] = bookmarkSources.map((bookmark, index) => {
    const anchorSource = isRecord(bookmark.anchor) ? bookmark.anchor : bookmark;
    const clip = validateBookmarkExportedClip(bookmark.exportedClip);
    return {
      id: nonEmptyString(bookmark.id) ? bookmark.id : `bookmark:${index}`,
      anchorId: nonEmptyString(bookmark.anchorId) ? bookmark.anchorId : nonEmptyString(bookmark.id) ? bookmark.id : `bookmark:${index}`,
      filePath: typeof bookmark.filePath === "string" ? bookmark.filePath : "",
      ...(bookmark.sourceId !== undefined ? { sourceId: bookmark.sourceId as string } : {}),
      title: typeof bookmark.title === "string" ? bookmark.title : "Закладка",
      note: typeof bookmark.note === "string" ? bookmark.note : "",
      tags: isStringArray(bookmark.tags) ? [...bookmark.tags] : [],
      topicIds: isStringArray(bookmark.topicIds) ? [...bookmark.topicIds] : [],
      ...(bookmark.hiddenFromLibrary !== undefined ? { hiddenFromLibrary: bookmark.hiddenFromLibrary as boolean } : {}),
      ...(bookmark.unitId !== undefined ? { unitId: bookmark.unitId as string } : {}),
      ...(Array.isArray(bookmark.unitIds) ? { unitIds: [...bookmark.unitIds] as string[] } : {}),
      createdAt: isFiniteNumber(bookmark.createdAt) ? bookmark.createdAt : now,
      updatedAt: isFiniteNumber(bookmark.updatedAt) ? bookmark.updatedAt : isFiniteNumber(bookmark.createdAt) ? bookmark.createdAt : now,
      anchor: pickFields(anchorSource, ANCHOR_FIELDS),
      ...(clip.valid && clip.attachment ? { exportedClip: clip.attachment } : {})
    };
  });
  let studyTasks: StudyTask[] | undefined;
  let studyTaskSeries: StudyTaskSeries[] | undefined;
  let studyAutoplan: StudyAutoplanState | undefined;
  try {
    studyAutoplan = normalizeStudyAutoplanState(value.studyAutoplan);
    if (value.studyTasks !== undefined) studyTasks = normalizeStudyTasks(value.studyTasks,
      new Set([...materials, ...bookmarks].map(material => material.id)));
    if (value.studyTaskSeries !== undefined) studyTaskSeries = normalizeStudyTaskSeries(value.studyTaskSeries,
      new Set([...materials, ...bookmarks].map(material => material.id)));
    validateStudyTaskSeriesLinks(studyTasks ?? [], studyTaskSeries ?? []);
  } catch { return undefined; }
  const data: PersistedDataV1 = {
    schemaVersion: CURRENT_DATA_SCHEMA_VERSION,
    dataRevision: Math.max(1, Math.trunc(dataRevision)),
    savedAt: now,
    settings: { ...value.settings, ...(dailyWorkload !== undefined ? { dailyWorkload } : {}) },
    topics: [...value.topics],
    materials,
    cards,
    reviewEvents,
    bookmarks,
    ...(studyTasks !== undefined ? { studyTasks } : {}),
    ...(studyTaskSeries !== undefined ? { studyTaskSeries } : {}),
    ...(studyAutoplan !== undefined ? { studyAutoplan } : {}),
    ...(sourceCatalog !== undefined ? { sourceCatalog } : {}),
    ...(workloadDay !== undefined ? { workloadDay } : {}),
    ...authorities,
    ...(value.learningLibrary !== undefined ? { learningLibrary: library.library } : {})
  };
  if (materialBaseline) {
    // Runtime reminders flatten independently stored material/card metadata.
    // Preserve the canonical material value only while its flat projection is
    // unchanged. An explicit edit of the oldest card still updates that field,
    // as in the original serializer; ordinary saves do not erase distinctions.
    // Compare the surviving representative with its own previous projection, so
    // removing an older sibling is not mistaken for a source metadata edit.
    const survivingIds = new Set(data.cards.map(card => card.id));
    const projected = createPersistedDataV1({ settings: materialBaseline.settings,
      reminders: composeFlatReminders(materialBaseline).filter(card => survivingIds.has(String(card.id))), bookmarks: materialBaseline.bookmarks,
      topics: materialBaseline.topics, learningLibrary: materialBaseline.learningLibrary,
      sourceCatalog: materialBaseline.sourceCatalog }, materialBaseline.savedAt, materialBaseline.dataRevision);
    if (!projected) return undefined;
    const originals = new Map(materialBaseline.materials.map(material => [material.id, material]));
    const projections = new Map(projected.materials.map(material => [material.id, material]));
    data.materials = data.materials.map(material => {
      const original = originals.get(material.id), projection = projections.get(material.id);
      if (!original || !projection) return material;
      const result = { ...material } as unknown as JsonRecord;
      const source = original as unknown as JsonRecord, prior = projection as unknown as JsonRecord;
      for (const key of new Set([...Object.keys(source), ...Object.keys(prior), ...Object.keys(result)])) {
        if (key === "id" || JSON.stringify(result[key]) !== JSON.stringify(prior[key])) continue;
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) result[key] = JSON.parse(JSON.stringify(source[key]));
        else delete result[key];
      }
      // A topic removed from the current catalogue is an explicit graph change,
      // even if every card had an independent empty topic override already.
      result.topicIds = (result.topicIds as string[]).filter(id => topicIds.has(id));
      return result as unknown as PersistedMaterialV1;
    });
  }
  return data;
};

export const composeFlatReminders = (data: PersistedDataV1): JsonRecord[] => {
  const materials = new Map(data.materials.map((material) => [material.id, material]));
  const events = new Map<string, JsonRecord[]>();
  data.reviewEvents.forEach((event) => {
    const { cardId: _cardId, ...entry } = event;
    const list = events.get(event.cardId) ?? []; list.push(entry); events.set(event.cardId, list);
  });
  events.forEach((list) => list.sort((a, b) => Number(a.reviewedAt) - Number(b.reviewedAt)));
  return data.cards.map((card) => {
    const material = materials.get(card.materialId);
    if (!material) throw new Error(`Card ${card.id} references missing material ${card.materialId}`);
    return {
      ...material.anchor,
      ...card,
      ...copyLearningCardFields(card),
      anchorId: material.anchorId,
      filePath: material.filePath,
      ...(material.sourceId !== undefined ? { sourceId: material.sourceId } : {}),
      title: card.title === undefined ? material.title : card.title,
      tags: [...(card.tags === undefined ? material.tags : card.tags)],
      topicIds: [...(card.topicIds === undefined ? material.topicIds : card.topicIds)],
      relatedMaterialIds: [...material.relatedMaterialIds],
      ...(material.importKey ? { importKey: material.importKey } : {}),
      reviewHistory: (events.get(card.id) ?? []).map((entry) => ({ ...entry }))
    };
  });
};

export const validatePersistedDataV1 = (value: unknown): DataValidationResult => {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["Корень данных должен быть объектом."] };
  if (value.schemaVersion !== CURRENT_DATA_SCHEMA_VERSION) errors.push(`Ожидалась схема ${CURRENT_DATA_SCHEMA_VERSION}.`);
  if (!isFiniteNumber(value.dataRevision) || value.dataRevision < 1) errors.push("Некорректная ревизия данных.");
  if (!isFiniteNumber(value.savedAt)) errors.push("Некорректное время сохранения.");
  if (!isRecord(value.settings)) errors.push("Настройки отсутствуют или повреждены.");
  const activeSession = isRecord(value.settings) ? value.settings.activeReviewSession : undefined;
  if (isRecord(activeSession) && activeSession.generation !== undefined && (typeof activeSession.generation !== "number"
    || !Number.isSafeInteger(activeSession.generation) || activeSession.generation < 0)) errors.push("Повреждён номер попытки сохранённой сессии.");
  if (!Array.isArray(value.topics)) errors.push("Список тем отсутствует или повреждён.");
  if (!Array.isArray(value.materials) || !Array.isArray(value.cards) || !Array.isArray(value.reviewEvents)) {
    errors.push("Отсутствуют материалы, карточки или журнал повторений."); return { valid: false, errors };
  }
  const topics: unknown[] = Array.isArray(value.topics) ? value.topics : [];
  let authorities: ReturnType<typeof normalizeExternalReviewAuthorities> = {};
  let sourceCatalog: SourceFileRecord[] | undefined;
  let workloadDay: WorkloadDay | undefined, dailyWorkload: DailyWorkloadSettings | undefined;
  try { authorities = normalizeExternalReviewAuthorities(value); workloadDay = normalizeWorkloadDay(value.workloadDay);
    if (isRecord(value.settings)) dailyWorkload = normalizeDailyWorkloadSettings(value.settings.dailyWorkload); }
  catch (error) { errors.push(error instanceof Error ? error.message : "Повреждён учёт дневной нагрузки."); }
  try { if (value.sourceCatalog !== undefined) sourceCatalog = validateSourceCatalog(value.sourceCatalog); }
  catch (error) { errors.push(error instanceof Error ? error.message : "Каталог источников повреждён."); }
  const sources = new Map((sourceCatalog ?? []).map(source => [source.id, source]));
  const sourceError = (owner: JsonRecord): boolean => owner.sourceId !== undefined
    && (!isSourceFileId(owner.sourceId) || sources.get(owner.sourceId)?.path !== owner.filePath);
  const bookmarks: unknown[] = value.bookmarks === undefined ? [] : Array.isArray(value.bookmarks) ? value.bookmarks : [];
  if (value.bookmarks !== undefined && !Array.isArray(value.bookmarks)) errors.push("Список закладок повреждён.");
  const topicIds = new Set<string>();
  topics.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.id) || !nonEmptyString(item.name)
      || !isFiniteNumber(item.createdAt) || !isFiniteNumber(item.sortOrder)) return void errors.push(`Тема ${index + 1}: повреждены обязательные поля.`);
    if (topicIds.has(item.id)) errors.push(`Тема ${item.id}: повторяющийся ID.`);
    topicIds.add(item.id);
  });
  topics.forEach((item) => {
    if (!isRecord(item) || !nonEmptyString(item.id)) return;
    if (item.parentId !== undefined && (!nonEmptyString(item.parentId) || !topicIds.has(item.parentId) || item.parentId === item.id)) {
      errors.push(`Тема ${item.id}: некорректная родительская тема.`); return;
    }
    const visited = new Set([item.id]); let parentId = typeof item.parentId === "string" ? item.parentId : undefined;
    while (parentId) {
      if (visited.has(parentId)) { errors.push(`Тема ${item.id}: циклическая вложенность.`); break; }
      visited.add(parentId);
      const parent = topics.find((candidate) => isRecord(candidate) && candidate.id === parentId);
      parentId = isRecord(parent) && typeof parent.parentId === "string" ? parent.parentId : undefined;
    }
  });
  const library = validateLearningLibrary(value.learningLibrary, topicIds);
  if (!library.valid) errors.push(...library.errors);
  const knownUnitIds = library.valid ? new Set(library.library.units.map(unit => unit.id)) : undefined;
  const bookmarkIds = new Set<string>();
  bookmarks.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.id)) return void errors.push(`Закладка ${index + 1}: отсутствует ID.`);
    if (bookmarkIds.has(item.id)) errors.push(`Закладка ${item.id}: повторяющийся ID.`); bookmarkIds.add(item.id);
    if (sourceError(item)) errors.push(`Закладка ${item.id}: повреждена связь с файлом источника.`);
    if (isRecord(item.anchor) && item.anchor.sourceId !== undefined) errors.push(`Закладка ${item.id}: ID файла должен находиться рядом с anchor.`);
    const clip = validateBookmarkExportedClip(item.exportedClip);
    if (!clip.valid) errors.push(`Закладка ${item.id}: ${clip.error}`);
    if (isRecord(item.anchor) && item.anchor.exportedClip !== undefined)
      errors.push(`Закладка ${item.id}: сохранённый клип должен быть рядом с anchor, а не внутри него.`);
    if (item.hiddenFromLibrary !== undefined && typeof item.hiddenFromLibrary !== "boolean")
      errors.push(`Закладка ${item.id}: повреждено состояние видимости.`);
    if (isRecord(item.anchor) && item.anchor.hiddenFromLibrary !== undefined)
      errors.push(`Закладка ${item.id}: состояние видимости не должно находиться внутри anchor.`);
    if (isRecord(item.anchor)) { const issue = mediaAnchorMetadataError(item.anchor); if (issue) errors.push(`Закладка ${item.id}: ${issue}`); }
    if (isRecord(item.anchor) && item.anchor.studyRange !== undefined && (!normalizeStudyRange(item.anchor.studyRange)
      || (item.anchor.studyRange as JsonRecord).kind !== item.anchor.anchorType)) errors.push(`Закладка ${item.id}: повреждены границы материала.`);
    if (!nonEmptyString(item.anchorId) || typeof item.filePath !== "string" || typeof item.title !== "string" || typeof item.note !== "string"
      || !isStringArray(item.tags) || !isStringArray(item.topicIds) || !isFiniteNumber(item.createdAt) || !isFiniteNumber(item.updatedAt)
      || !isRecord(item.anchor) || !nonEmptyString(item.anchor.anchorType)) {
      errors.push(`Закладка ${item.id}: повреждены обязательные поля или якорь.`);
    }
    if (isStringArray(item.topicIds)) item.topicIds.forEach((topicId) => {
      if (!topicIds.has(topicId)) errors.push(`Закладка ${item.id}: указана отсутствующая тема ${topicId}.`);
    });
    if (!validUnitBindings(item, knownUnitIds))
      errors.push(`Закладка ${item.id}: указан отсутствующий или повреждённый раздел.`);
  });
  if (library.valid) library.library.rules.forEach(rule => {
    if (rule.materialIds !== undefined && !validMaterialLinks(rule.materialIds, bookmarkIds))
      errors.push(`Правило ${rule.id}: связь указывает на отсутствующий материал.`);
  });
  const materialIds = new Set<string>();
  value.materials.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.id)) return void errors.push(`Материал ${index + 1}: отсутствует ID.`);
    if (materialIds.has(item.id)) errors.push(`Материал ${item.id}: повторяющийся ID.`); materialIds.add(item.id);
    if (sourceError(item)) errors.push(`Материал ${item.id}: повреждена связь с файлом источника.`);
    if (isRecord(item.anchor) && item.anchor.sourceId !== undefined) errors.push(`Материал ${item.id}: ID файла должен находиться рядом с anchor.`);
    if (isRecord(item.anchor)) { const issue = mediaAnchorMetadataError(item.anchor); if (issue) errors.push(`Материал ${item.id}: ${issue}`); }
    if (isRecord(item.anchor) && item.anchor.studyRange !== undefined && (!normalizeStudyRange(item.anchor.studyRange)
      || (item.anchor.studyRange as JsonRecord).kind !== item.anchor.anchorType)) errors.push(`Материал ${item.id}: повреждены границы материала.`);
    if (!nonEmptyString(item.anchorId) || typeof item.filePath !== "string" || typeof item.title !== "string" || !isFiniteNumber(item.createdAt)
      || !isStringArray(item.tags) || !isStringArray(item.topicIds) || !isStringArray(item.relatedMaterialIds) || !isRecord(item.anchor)
      || !nonEmptyString(item.anchor.anchorType)) errors.push(`Материал ${item.id}: повреждены обязательные поля или якорь.`);
    if (isStringArray(item.topicIds)) item.topicIds.forEach((topicId) => {
      if (!topicIds.has(topicId)) errors.push(`Материал ${item.id}: указана отсутствующая тема ${topicId}.`);
    });
  });
  let studyTasks: StudyTask[] | undefined;
  let studyTaskSeries: StudyTaskSeries[] | undefined;
  let studyAutoplan: StudyAutoplanState | undefined;
  try {
    studyAutoplan = normalizeStudyAutoplanState(value.studyAutoplan);
    if (value.studyTasks !== undefined) studyTasks = normalizeStudyTasks(value.studyTasks, new Set([...materialIds, ...bookmarkIds]));
    if (value.studyTaskSeries !== undefined) studyTaskSeries = normalizeStudyTaskSeries(value.studyTaskSeries, new Set([...materialIds, ...bookmarkIds]));
    validateStudyTaskSeriesLinks(studyTasks ?? [], studyTaskSeries ?? []);
  } catch (error) { errors.push(error instanceof Error ? error.message : "Список учебных задач повреждён."); }
  const cardIds = new Set<string>();
  value.cards.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.id)) return void errors.push(`Карточка ${index + 1}: отсутствует ID.`);
    if (cardIds.has(item.id)) errors.push(`Карточка ${item.id}: повторяющийся ID.`); cardIds.add(item.id);
    if (item.sourceId !== undefined) errors.push(`Карточка ${item.id}: ID файла хранится в материале.`);
    if (!isValidCardClarification(item.clarification)) errors.push(`Карточка ${item.id}: повреждено пояснение к отметке уточнения.`);
    if (library.valid) validateCardLearningFields(item, library.library).forEach(issue => errors.push(`Карточка ${item.id}: ${issue}`));
    if (item.linkedMaterialIds !== undefined && !validMaterialLinks(item.linkedMaterialIds, bookmarkIds))
      errors.push(`Карточка ${item.id}: связь указывает на отсутствующий материал.`);
    if ((item.title !== undefined && typeof item.title !== "string")
      || (item.tags !== undefined && !isStringArray(item.tags)) || (item.topicIds !== undefined && !isStringArray(item.topicIds))) {
      errors.push(`Карточка ${item.id}: повреждены название, теги или темы.`);
    }
    if (isStringArray(item.topicIds)) item.topicIds.forEach((topicId) => {
      if (!topicIds.has(topicId)) errors.push(`Карточка ${item.id}: указана отсутствующая тема ${topicId}.`);
    });
    if (!nonEmptyString(item.materialId) || !materialIds.has(item.materialId) || !isFiniteNumber(item.createdAt) || !isFiniteNumber(item.dueAt)
      || !isNumberArray(item.offsetsMinutes) || !isNumberArray(item.deliveredSteps) || !isFiniteNumber(item.repeatCount)
      || typeof item.repeatLast !== "boolean" || !["active", "completed", "paused"].includes(String(item.status)) || !isFiniteNumber(item.cycleIndex)) {
      errors.push(`Карточка ${item.id}: повреждены обязательные поля или связь с материалом.`);
    }
    if (item.detachedMaterialId !== undefined && (!nonEmptyString(item.materialId) || item.detachedMaterialId !== item.materialId))
      errors.push(`Карточка ${item.id}: повреждена связь открепления от материала.`);
    if (item.test !== undefined && (!isRecord(item.test) || !normalizeRecallTest(item.test))) errors.push(`Карточка ${item.id}: повреждён тест.`);
    if (isRecord(item.test)) {
      const attachments = validateCardAttachments(item.test.attachments);
      if (!attachments.valid) errors.push(`Карточка ${item.id}: ${attachments.error}`);
    }
    if (item.schedulerMode !== undefined && (typeof item.schedulerMode !== "string" || !["manual", "fsrs", "sm2", "leitner"].includes(item.schedulerMode))) {
      errors.push(`Карточка ${item.id}: неизвестный алгоритм планирования.`);
    }
    const fsrsCard = item.fsrsCard;
    if (fsrsCard !== undefined && (!isRecord(fsrsCard)
      || !["due", "stability", "difficulty", "elapsedDays", "scheduledDays", "learningSteps", "reps", "lapses", "state"]
        .every((field) => isFiniteNumber(fsrsCard[field])))) errors.push(`Карточка ${item.id}: повреждено состояние FSRS.`);
    const sm2State = item.sm2State;
    if (sm2State !== undefined && (!isRecord(sm2State)
      || !["repetitions", "intervalDays", "easeFactor"].every((field) => isFiniteNumber(sm2State[field])))) {
      errors.push(`Карточка ${item.id}: повреждено состояние SM-2.`);
    }
    if (item.leitnerState !== undefined && (!isRecord(item.leitnerState) || !isFiniteNumber(item.leitnerState.box))) {
      errors.push(`Карточка ${item.id}: повреждено состояние Лейтнера.`);
    }
  });
  const eventIds = new Set<string>();
  value.reviewEvents.forEach((item, index) => {
    if (!isRecord(item) || !nonEmptyString(item.id)) return void errors.push(`Повторение ${index + 1}: отсутствует ID.`);
    if (eventIds.has(item.id)) errors.push(`Повторение ${item.id}: повторяющийся ID.`); eventIds.add(item.id);
    if (!nonEmptyString(item.cardId) || !cardIds.has(item.cardId) || !isFiniteNumber(item.reviewedAt)
      || !isFiniteNumber(item.previousDueAt) || !isFiniteNumber(item.cycle)
      || (item.rating !== undefined && ![1, 2, 3, 4].includes(Number(item.rating)))
      || (item.correct !== undefined && typeof item.correct !== "boolean")
      || (item.answerDurationMs !== undefined && (!isFiniteNumber(item.answerDurationMs) || item.answerDurationMs < 0))
      || (item.hintsUsed !== undefined && (!isFiniteNumber(item.hintsUsed) || item.hintsUsed < 0))
      || (item.hintsAvailable !== undefined && (!isFiniteNumber(item.hintsAvailable) || item.hintsAvailable < 0))
      || (isFiniteNumber(item.hintsUsed) && isFiniteNumber(item.hintsAvailable) && item.hintsUsed > item.hintsAvailable)
      || (item.sessionId !== undefined && !nonEmptyString(item.sessionId))) errors.push(`Повторение ${item.id}: повреждены поля или связь с карточкой.`);
  });
  value.materials.forEach((item) => {
    if (!isRecord(item) || !isStringArray(item.relatedMaterialIds)) return;
    item.relatedMaterialIds.forEach((id) => { if (!materialIds.has(id)) errors.push(`Материал ${String(item.id)}: связь указывает на отсутствующий материал ${id}.`); });
  });
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], data: { ...value, cards: value.cards.map(item => ({ ...item, ...copyCardMetadataFields(item), ...copyLearningCardFields(item) })),
    ...(studyTasks !== undefined ? { studyTasks } : {}),
    ...(studyTaskSeries !== undefined ? { studyTaskSeries } : {}),
    ...(studyAutoplan !== undefined ? { studyAutoplan } : {}),
    ...(dailyWorkload !== undefined && isRecord(value.settings) ? { settings: { ...value.settings, dailyWorkload } } : {}),
    ...(sourceCatalog !== undefined ? { sourceCatalog } : {}),
    ...(workloadDay !== undefined ? { workloadDay } : {}),
    ...authorities,
    ...(value.learningLibrary !== undefined && library.valid ? { learningLibrary: library.library } : {}), bookmarks: bookmarks.map((item) => {
    const bookmark = item as JsonRecord, clip = validateBookmarkExportedClip(bookmark.exportedClip);
    return { ...bookmark, ...(Array.isArray(bookmark.unitIds) ? { unitIds: [...bookmark.unitIds] } : {}),
      ...(clip.valid && clip.attachment ? { exportedClip: clip.attachment } : {}) };
  }) } as unknown as PersistedDataV1 };
};
