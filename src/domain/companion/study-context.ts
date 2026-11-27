export type CompanionQuestionKind = "free" | "single" | "multiple" | "cloze" | "matching" | "ordering";
export interface CompanionSourceContext { excerpt?: string; page?: number; timeSeconds?: number; }
import type { Reminder } from "../review/types";
import type { CardLearningState } from "../stats/analytics-core";
import { topicPath, type TopicNode } from "../library/topic-core";
import { tagKey } from "../library/tag-key";
import { MAX_SELF_CHECK_CRITERIA, MAX_SELF_CHECK_CRITERION_LENGTH } from "../cards/recall-test-core";
export type CompanionKnowledgeState = CardLearningState;
export const COMPANION_KNOWLEDGE_STATES: readonly CompanionKnowledgeState[] = ["new", "learning", "needs-attention", "weak", "stable", "strong"];
export interface CompanionStudyMetadata {
  id: string; kind: CompanionQuestionKind; group?: string; sections?: string[]; source?: CompanionSourceContext;
  topics?: string[]; tags?: string[];
  /** Native Obsidian metric at the last successful synchronization, not a live FSRS estimate. */
  knowledgeState?: CompanionKnowledgeState;
  /** Negotiated separately so older strict version-one services keep their payload. */
  selfCheckCriteria?: string[];
}
export interface CompanionStudyContext {
  version: 1; sourceConsent: boolean;
  defaults: { core: { cardLimit: number; timeLimitMinutes: number }; bank: { cardLimit: number; timeLimitMinutes: number } };
  cards: CompanionStudyMetadata[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every(key => names.includes(key));
const integer = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
const label = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const topicLabel = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const invalid = (): never => { throw new Error("Invalid companion study context"); };
export function validateCompanionStudyContext(value: unknown): asserts value is CompanionStudyContext {
  if (!object(value) || !only(value, ["version", "sourceConsent", "defaults", "cards"]) || value.version !== 1 || typeof value.sourceConsent !== "boolean"
    || !object(value.defaults) || !only(value.defaults, ["core", "bank"]) || !Array.isArray(value.cards)) return invalid();
  for (const mode of ["core", "bank"]) {
    const limits = value.defaults[mode];
    if (!object(limits) || !only(limits, ["cardLimit", "timeLimitMinutes"]) || !integer(limits.cardLimit, 1, 1000) || !integer(limits.timeLimitMinutes, 1, 180)) return invalid();
  }
  const ids = new Set<string>();
  for (const row of value.cards) {
    if (!object(row) || !only(row, ["id", "kind", "group", "sections", "source", "topics", "tags", "knowledgeState", "selfCheckCriteria"]) || typeof row.id !== "string" || row.id.length < 1 || row.id.length > 128
      || /[^a-zA-Z0-9._:-]/.test(row.id) || ids.has(row.id) || !["free", "single", "multiple", "cloze", "matching", "ordering"].includes(String(row.kind))
      || row.group !== undefined && !label(row.group)
      || row.sections !== undefined && (!Array.isArray(row.sections) || row.sections.length > 100 || !row.sections.every(label) || new Set(row.sections).size !== row.sections.length)
      || row.topics !== undefined && (!Array.isArray(row.topics) || row.topics.length > 100 || !row.topics.every(topicLabel) || new Set(row.topics).size !== row.topics.length)
      || row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.length > 100 || !row.tags.every(label) || new Set(row.tags.map(tagKey)).size !== row.tags.length)
      || row.knowledgeState !== undefined && !COMPANION_KNOWLEDGE_STATES.includes(row.knowledgeState as CompanionKnowledgeState)
      || row.selfCheckCriteria !== undefined && (row.kind !== "free" || !Array.isArray(row.selfCheckCriteria) || row.selfCheckCriteria.length > MAX_SELF_CHECK_CRITERIA
        || !row.selfCheckCriteria.every(value => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_SELF_CHECK_CRITERION_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)))) return invalid();
    ids.add(row.id);
    if (row.source !== undefined) {
      const source = row.source;
      if (!value.sourceConsent || !object(source) || !only(source, ["excerpt", "page", "timeSeconds"]) || !Object.keys(source).length
        || source.excerpt !== undefined && (typeof source.excerpt !== "string" || !source.excerpt.trim() || source.excerpt.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(source.excerpt))
        || source.page !== undefined && !integer(source.page, 1, 1_000_000)
        || source.timeSeconds !== undefined && !integer(source.timeSeconds, 0, 31_536_000)) return invalid();
    }
  }
}
/** Old version-one services reject these fields; keep their existing context payload unchanged. */
export function withoutCompanionStudyFilters(context: CompanionStudyContext): CompanionStudyContext {
  return { ...context, cards: context.cards.map(card => { const { topics, tags, knowledgeState, ...legacy } = card; return legacy; }) };
}
export function withoutCompanionWrittenRecall(context: CompanionStudyContext): CompanionStudyContext {
  return { ...context, cards: context.cards.map(card => { const { selfCheckCriteria, ...legacy } = card; return legacy; }) };
}
/** Only already selected cards and their saved anchor excerpts; never reads source files. */
export function projectCompanionStudyContext(input: {
  ids: readonly string[]; cards: readonly Reminder[]; units: readonly { id: string; title: string }[]; sourceConsent: boolean;
  topics?: readonly TopicNode[]; knowledgeStates?: ReadonlyMap<string, CompanionKnowledgeState>;
  coreCardLimit: number; coreMinutes: number; bankCardLimit: number; bankMinutes: number;
}): CompanionStudyContext {
  const clamp = (value: number, fallback: number, max: number): number => Number.isFinite(value) ? Math.max(1, Math.min(max, Math.round(value))) : fallback;
  const units = new Map(input.units.map(unit => [unit.id, unit.title])), wanted = new Set(input.ids);
  const topics = [...(input.topics ?? [])], branches = new Map(topics.map(node => [node.id, topicPath(topics, node.id)]));
  const paths = new Map([...branches].map(([id, branch]) => [id, branch.map(node => node.name).join(" / ")]));
  const pathCounts = new Map<string, number>(); paths.forEach(value => pathCounts.set(value, (pathCounts.get(value) ?? 0) + 1));
  const topicLabels = new Map(topics.map(node => { const path = paths.get(node.id)!; return [node.id, pathCounts.get(path)! > 1 ? `${path} [${node.id}]` : path]; }));
  const branchLabels = new Map([...branches].map(([id, branch]) => [id, branch.map(node => topicLabels.get(node.id)).filter(topicLabel)]));
  const tagLabels = new Map<string, string>();
  for (const card of input.cards) if (wanted.has(card.id) && card.test && card.tags?.length) {
    for (const tag of card.tags) if (label(tag)) {
      const key = tagKey(tag);
      if (!tagLabels.has(key)) tagLabels.set(key, tag);
    }
  }
  const context: CompanionStudyContext = { version: 1, sourceConsent: input.sourceConsent,
    defaults: { core: { cardLimit: clamp(input.coreCardLimit, 20, 1000), timeLimitMinutes: clamp(input.coreMinutes, 20, 180) },
      bank: { cardLimit: clamp(input.bankCardLimit, 10, 1000), timeLimitMinutes: clamp(input.bankMinutes, 20, 180) } }, cards: [] };
  for (const card of input.cards) {
    if (!wanted.has(card.id) || !card.test) continue;
    const row: CompanionStudyMetadata = { id: card.id, kind: card.test.kind };
    if (card.test.kind === "free" && card.test.evaluationMode === "self" && card.test.selfCheckCriteria?.length)
      row.selfCheckCriteria = [...card.test.selfCheckCriteria];
    if (label(card.test.knowledgeGroup)) row.group = card.test.knowledgeGroup;
    if (card.unitIds?.length || card.unitId) {
      const sections = [...new Set([...(card.unitIds ?? []), ...(card.unitId ? [card.unitId] : [])].map(id => units.get(id)).filter(label))].slice(0, 100);
      if (sections.length) row.sections = sections;
    }
    if (card.topicIds?.length) {
      const cardTopics = [...new Set(card.topicIds.flatMap(id => branchLabels.get(id) ?? []))].slice(0, 100);
      if (cardTopics.length) row.topics = cardTopics;
    }
    if (card.tags?.length) {
      const tags = [...new Set(card.tags.filter(label).map(tagKey))].map(key => tagLabels.get(key)!).slice(0, 100);
      if (tags.length) row.tags = tags;
    }
    const state = input.knowledgeStates?.get(card.id); if (state !== undefined) row.knowledgeState = state;
    if (input.sourceConsent) {
      const source: CompanionSourceContext = {}, raw = card.mdSelection ?? card.textSelection ?? card.fragmentText;
      if (typeof raw === "string" && raw.trim()) {
        const clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").trim();
        if (clean) source.excerpt = clean.length > 2000 ? clean.slice(0, 1999) + "…" : clean;
      }
      const page = card.page ?? card.docxPage ?? card.pptxSlide;
      if (integer(page, 1, 1_000_000)) source.page = page;
      if (typeof card.mediaTime === "number" && Number.isFinite(card.mediaTime) && card.mediaTime >= 0 && card.mediaTime <= 31_536_000) source.timeSeconds = Math.floor(card.mediaTime);
      if (Object.keys(source).length) row.source = source;
    }
    context.cards.push(row);
  }
  validateCompanionStudyContext(context); return context;
}
