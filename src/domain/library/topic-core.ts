export interface TopicNode {
  id: string;
  name: string;
  parentId?: string;
  createdAt: number;
  sortOrder: number;
}

export const MAX_TOPIC_DEPTH = 6;
export const MAX_MATERIAL_TOPICS = 8;
export const MAX_TOPIC_NAME = 48;

export const normalizeTopicName = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_NAME);

export function parseTopicPath(value: string): string[] {
  return value.split(/\s*(?:\/|>|→)\s*/).map(normalizeTopicName).filter(Boolean).slice(0, MAX_TOPIC_DEPTH);
}

/** Build the whole branch before publishing it; callers commit the completed plan atomically. */
export function planTopicPath(nodes: readonly TopicNode[], value: string, createId: () => string, now = Date.now()): { nodes: TopicNode[]; leafId?: string } {
  const topics = [...nodes];
  let parentId: string | undefined;
  for (const name of parseTopicPath(value)) {
    const existing = topics.find(topic => topic.parentId === parentId && topic.name.localeCompare(name, "ru", { sensitivity: "accent" }) === 0);
    if (existing) { parentId = existing.id; continue; }
    const topic: TopicNode = { id: createId(), name, parentId, createdAt: now, sortOrder: topics.filter(node => node.parentId === parentId).length };
    topics.push(topic); parentId = topic.id;
  }
  return { nodes: topics, leafId: parentId };
}

export function normalizeTopicNodes(value: unknown): TopicNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: TopicNode[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const source = item as Partial<TopicNode>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const name = normalizeTopicName(typeof source.name === "string" ? source.name : "");
    if (!id || !name || ids.has(id)) return;
    ids.add(id);
    nodes.push({ id, name, parentId: typeof source.parentId === "string" && source.parentId ? source.parentId : undefined,
      createdAt: Number.isFinite(source.createdAt) ? Number(source.createdAt) : Date.now() + index,
      sortOrder: Number.isFinite(source.sortOrder) ? Number(source.sortOrder) : index });
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => {
    if (!node.parentId || !byId.has(node.parentId) || node.parentId === node.id) { node.parentId = undefined; return; }
    const visited = new Set([node.id]); let parentId: string | undefined = node.parentId;
    while (parentId) {
      if (visited.has(parentId)) { node.parentId = undefined; break; }
      visited.add(parentId); parentId = byId.get(parentId)?.parentId;
    }
  });
  return nodes;
}

export function topicPath(nodes: TopicNode[], topicId: string): TopicNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: TopicNode[] = []; const visited = new Set<string>(); let current = byId.get(topicId);
  while (current && !visited.has(current.id)) { path.unshift(current); visited.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; }
  return path;
}

export const topicPathLabel = (nodes: TopicNode[], topicId: string): string => topicPath(nodes, topicId).map((node) => node.name).join(" / ");

export function topicDepth(nodes: TopicNode[], topicId: string): number { return Math.max(0, topicPath(nodes, topicId).length - 1); }

export function normalizeMaterialTopicIds(value: unknown, nodes: TopicNode[]): string[] {
  const known = new Set(nodes.map((node) => node.id));
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)))].slice(0, MAX_MATERIAL_TOPICS) : [];
}

export function topicDescendantIds(nodes: TopicNode[], topicId: string): string[] {
  const result = new Set([topicId]); let changed = true;
  while (changed) {
    changed = false;
    nodes.forEach((node) => { if (node.parentId && result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; } });
  }
  return [...result];
}

export interface TopicUpdateResult {
  nodes: TopicNode[];
  error?: "missing" | "empty-name" | "duplicate" | "invalid-parent" | "too-deep";
}

export function updateTopicNode(nodes: TopicNode[], topicId: string, nameValue: string, parentId?: string): TopicUpdateResult {
  const current = nodes.find((node) => node.id === topicId); const name = normalizeTopicName(nameValue);
  if (!current) return { nodes, error: "missing" };
  if (!name) return { nodes, error: "empty-name" };
  const descendants = new Set(topicDescendantIds(nodes, topicId));
  if (parentId && (!nodes.some((node) => node.id === parentId) || descendants.has(parentId))) return { nodes, error: "invalid-parent" };
  const duplicate = nodes.some((node) => node.id !== topicId && node.parentId === parentId
    && node.name.localeCompare(name, "ru", { sensitivity: "accent" }) === 0);
  if (duplicate) return { nodes, error: "duplicate" };

  const relativeDepth = (nodeId: string): number => {
    let maximum = 0; const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 1 }];
    while (queue.length) {
      const item = queue.shift(); if (!item) break; maximum = Math.max(maximum, item.depth);
      nodes.filter((node) => node.parentId === item.id).forEach((node) => queue.push({ id: node.id, depth: item.depth + 1 }));
    }
    return maximum;
  };
  const parentLevels = parentId ? topicPath(nodes, parentId).length : 0;
  if (parentLevels + relativeDepth(topicId) > MAX_TOPIC_DEPTH) return { nodes, error: "too-deep" };

  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== topicId);
  return { nodes: nodes.map((node) => node.id === topicId
    ? { ...node, name, parentId, sortOrder: current.parentId === parentId ? node.sortOrder : siblings.length }
    : { ...node }) };
}
