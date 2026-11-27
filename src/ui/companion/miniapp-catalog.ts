export type MiniAppCatalogMode = "core" | "bank";

export interface MiniAppCatalogMaterial {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly mode?: MiniAppCatalogMode;
}

export interface MiniAppCatalogCard {
  readonly materialId: string;
  readonly mode?: MiniAppCatalogMode;
  readonly kind: string;
  readonly count?: number;
  readonly group?: string;
  readonly sections?: readonly string[];
  readonly topics?: readonly string[];
  readonly tags?: readonly string[];
  readonly knowledgeState?: string;
  readonly recallPrompt?: string;
}

export interface MiniAppStudyFilters {
  readonly learningGroup?: string;
  readonly questionKind?: string;
  readonly section?: string;
  readonly topic?: string;
  readonly tag?: string;
  readonly knowledgeState?: string;
}

export interface MiniAppCatalogView {
  readonly materials: readonly MiniAppCatalogMaterial[];
  readonly catalog?: readonly MiniAppCatalogCard[];
}

export interface MiniAppCatalogPlan {
  readonly available: boolean;
  readonly mode?: MiniAppCatalogMode;
  readonly materialIds: readonly string[];
}

/** Closure-free so its compiled function can be embedded in the isolated browser client. */
export function createMiniAppCatalog() {
  type Model = {
    modeMaterials: readonly MiniAppCatalogMaterial[];
    materials: readonly MiniAppCatalogMaterial[];
    cards: readonly MiniAppCatalogCard[];
    filtered: (filter: MiniAppStudyFilters) => readonly MiniAppCatalogMaterial[];
  };
  let materialFrame: MiniAppCatalogView["materials"] | undefined, cardFrame: MiniAppCatalogView["catalog"], scope: MiniAppCatalogPlan | null | undefined;
  const models = new Map<MiniAppCatalogMode, Model>();
  const modeOf = (row: { readonly mode?: MiniAppCatalogMode }): MiniAppCatalogMode => row.mode || "core";

  function matches(card: MiniAppCatalogCard, filter: MiniAppStudyFilters): boolean {
    return (!filter.learningGroup || card.group === filter.learningGroup)
      && (!filter.questionKind || card.kind === filter.questionKind)
      && (!filter.section || Array.isArray(card.sections) && card.sections.includes(filter.section))
      && (!filter.topic || Array.isArray(card.topics) && card.topics.includes(filter.topic))
      && (!filter.tag || Array.isArray(card.tags) && card.tags.some(tag => tag.toLocaleLowerCase() === filter.tag!.toLocaleLowerCase()))
      && (!filter.knowledgeState || card.knowledgeState === filter.knowledgeState);
  }

  function forView(view: MiniAppCatalogView, mode: MiniAppCatalogMode, plan?: MiniAppCatalogPlan | null): Model {
    // Cache only immutable catalog metadata, never the full view containing learner answers.
    const catalog = view.catalog;
    if (materialFrame !== view.materials || cardFrame !== catalog || scope !== plan) {
      materialFrame = view.materials; cardFrame = catalog; scope = plan; models.clear();
    }
    const cached = models.get(mode);
    if (cached) return cached;
    const modeMaterials = view.materials.filter(row => modeOf(row) === mode);
    const planIds = new Set(plan?.materialIds ?? []);
    const materials = plan === undefined ? modeMaterials
      : !plan || !plan.available || plan.mode && plan.mode !== mode ? []
      : modeMaterials.filter(row => planIds.has(row.id) || !planIds.size && mode === "core");
    const materialIds = new Set(materials.map(row => row.id));
    const cards = (catalog || []).filter(card => modeOf(card) === mode && materialIds.has(card.materialId));
    const model: Model = {
      modeMaterials, materials, cards,
      filtered(filter) {
        if (!Array.isArray(catalog) || !Object.values(filter).some(Boolean)) return materials;
        const counts = new Map<string, number>();
        for (const card of cards) if (matches(card, filter)) {
          const id = card.materialId;
          const count = Number.isSafeInteger(card.count) && card.count! > 0 ? card.count! : 1;
          counts.set(id, (counts.get(id) ?? 0) + count);
        }
        return materials.map(row => ({ ...row, count: counts.get(row.id) ?? 0 }));
      }
    };
    models.set(mode, model);
    return model;
  }

  function tagLabels(cards: readonly MiniAppCatalogCard[]): string[] {
    const labels = new Map<string, string>();
    for (const card of cards) for (const value of card.tags || []) if (typeof value === "string" && value) {
      const key = value.toLocaleLowerCase(), previous = labels.get(key);
      // Keep the same spelling as sorting all tags first, without sorting duplicates.
      if (previous === undefined || value < previous) labels.set(key, value);
    }
    return Array.from(labels.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, label]) => label);
  }

  return { forView, matches, tagLabels };
}
