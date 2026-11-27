/** Passive legacy metadata only. No grouping, queue filtering or shared memory. */
export const normalizeKnowledgeGroup = (value: unknown): string => typeof value === "string"
  ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120) : "";
export const knowledgeGroupKey = (value: unknown): string => normalizeKnowledgeGroup(value).toLocaleLowerCase("ru-RU");

export const cardKnowledgeGroup = (card: { test?: unknown }): string => {
  const test = card.test && typeof card.test === "object" ? card.test as Record<string, unknown> : {};
  return normalizeKnowledgeGroup(test.knowledgeGroup);
};
