export interface MiniAppLocalStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Kept closure-free because its compiled function is embedded in the isolated client script. */
export function createMiniAppLocalState(store: MiniAppLocalStore | null, failed: () => void, now = () => Date.now()) {
  type Draft = { key: string; selected: number[]; text: string; blanks: string[]; matches: number[]; order: number[] };
  type Preset = { id: string; name: string; mode: "core" | "bank"; materials: string[]; filters: Record<string, string>; cardLimit: string; timeLimitMinutes: string; shuffle: boolean };
  let scope = "", generation = 0, ready = false, answer: { savedAt: number; value: Draft } | null = null, presets: Preset[] = [];
  let tail = Promise.resolve(), writing = false, presetWrite: Promise<boolean> | undefined;
  const writes = new Map<string, { bytes: string | null; generation: number; done: ((success: boolean) => void)[] }>();
  const fields = ["learningGroup", "questionKind", "section", "topic", "tag", "knowledgeState"];
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
  const indexes = (value: unknown, partial = false): value is number[] => Array.isArray(value) && value.length <= 12 && value.every(index => Number.isSafeInteger(index) && index >= (partial ? -1 : 0) && index < 12);
  const validDraft = (value: unknown): value is Draft => plain(value) && Object.keys(value).length === 6 && ["key", "selected", "text", "blanks", "matches", "order"].every(key => Object.prototype.hasOwnProperty.call(value, key)) && text(value.key, 600) && !!value.key && indexes(value.selected) && new Set(value.selected).size === value.selected.length && text(value.text, 4000) && Array.isArray(value.blanks) && value.blanks.length <= 12 && value.blanks.every(item => text(item, 2000)) && indexes(value.matches, true) && indexes(value.order);
  const validLimit = (value: unknown, max: number): value is string => text(value, 4) && (!value || /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max);
  const validPreset = (value: unknown): value is Preset => plain(value) && Object.keys(value).length === 8 && ["id", "name", "mode", "materials", "filters", "cardLimit", "timeLimitMinutes", "shuffle"].every(key => Object.prototype.hasOwnProperty.call(value, key)) && typeof value.id === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.id) && text(value.name, 60) && !!value.name.trim() && ["core", "bank"].includes(value.mode) && Array.isArray(value.materials) && value.materials.length > 0 && value.materials.length <= 100 && value.materials.every(id => text(id, 128) && !!id) && new Set(value.materials).size === value.materials.length && plain(value.filters) && Object.keys(value.filters).length === fields.length && fields.every(key => text(value.filters[key], 1024)) && validLimit(value.cardLimit, 1000) && validLimit(value.timeLimitMinutes, 180) && typeof value.shuffle === "boolean";
  const key = (slot: string, owner = scope) => "ar_v1_" + owner + "_" + slot;
  function write(slot: string, value: unknown): Promise<boolean> {
    if (!scope || !store || !ready) return Promise.resolve(false);
    const name = key(slot), bytes = value === null ? null : JSON.stringify(value);
    return new Promise(resolve => { const waiting = writes.get(name); writes.set(name, { bytes, generation, done: [...(waiting?.done ?? []), resolve] }); drain(); });
  }
  function drain(): void {
    if (writing || !store) return;
    writing = true;
    tail = (async () => { while (writes.size) { const entry = writes.entries().next(); if (entry.done) break; const [name, task] = entry.value; writes.delete(name); let success = true;
      try { if (task.bytes === null) await store.remove(name); else await store.set(name, task.bytes); }
      catch (_) { success = false; if (generation === task.generation) { try { failed(); } catch (_) {} } }
      task.done.forEach(done => done(success));
    } })().finally(() => { writing = false; if (writes.size) drain(); });
  }
  async function bind(value: unknown): Promise<void> {
    const ownedGeneration = ++generation;
    scope = typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : ""; ready = false; answer = null; presets = [];
    if (!scope) return;
    if (!store) { try { failed(); } catch (_) {} return; }
    const owner = scope;
    try {
      const bytes = await Promise.all([store.get(key("draft", owner)), store.get(key("presets", owner))]);
      if (ownedGeneration !== generation) return;
      ready = true;
      // JSON may expand each validated character to six escaped characters; reads must cover valid writes.
      if (bytes[0]) { let candidate: unknown; try { candidate = bytes[0].length <= 200000 ? JSON.parse(bytes[0]) : null; } catch (_) { candidate = null; }
        if (plain(candidate) && Number.isSafeInteger(candidate.savedAt) && candidate.savedAt >= now() - 7 * 86400000 && candidate.savedAt <= now() + 60000 && validDraft(candidate.value)) answer = { savedAt: candidate.savedAt, value: copy(candidate.value) };
        else void write("draft", null);
      }
      if (bytes[1] !== null) {
        const candidate: unknown = JSON.parse(bytes[1]);
        if (!Array.isArray(candidate) || !candidate.every(validPreset) || new Set(candidate.map(item => item.id)).size !== candidate.length) throw new Error("invalid saved presets");
        presets = candidate;
      }
    } catch (_) { if (ownedGeneration === generation) { ready = false; try { failed(); } catch (_) {} } }
  }
  function saveDraft(value: Draft): Promise<boolean> { if (!validDraft(value)) return Promise.resolve(false); answer = { savedAt: now(), value: copy(value) }; return write("draft", answer); }
  function clearDraft(): Promise<boolean> { answer = null; return write("draft", null); }
  function restoreDraft(frame: { key: string; kind: string; options?: unknown[]; blankCount?: number; matching?: { left: unknown[] }; orderItems?: unknown[] }): Draft | null {
    if (!answer) return null;
    const value = answer.value;
    const permutation = (items: number[], size: number) => items.length === size && items.every(index => index >= 0 && index < size) && new Set(items).size === size;
    const matches = frame.kind === "matching" && frame.matching ? value.matches.length === frame.matching.left.length && value.matches.every(index => index >= -1 && index < frame.matching!.left.length) && new Set(value.matches.filter(index => index >= 0)).size === value.matches.filter(index => index >= 0).length : !value.matches.length;
    const valid = frame.key === value.key && (frame.kind === "single" || frame.kind === "multiple" ? value.selected.every(index => index < (frame.options?.length ?? 0)) && (frame.kind !== "single" || value.selected.length <= 1) : !value.selected.length)
      && (frame.kind === "cloze" ? value.blanks.length <= (frame.blankCount ?? 0) : !value.blanks.length) && matches
      && (frame.kind === "ordering" ? !!frame.orderItems && permutation(value.order, frame.orderItems.length) : !value.order.length) && (frame.kind === "self" || frame.kind === "exact" && value.text.length <= 2000 || !value.text);
    if (!valid) { void clearDraft(); return null; }
    return copy(value);
  }
  function changePresets(update: (current: Preset[]) => Preset[]): Promise<boolean> {
    const ownedGeneration = generation;
    const persist = async () => {
      if (ownedGeneration !== generation) return false;
      const next = update(presets);
      if (!await write("presets", next) || ownedGeneration !== generation) return false;
      presets = next; return true;
    };
    const next = presetWrite ? presetWrite.then(persist) : persist();
    presetWrite = next;
    const clear = () => { if (presetWrite === next) presetWrite = undefined; };
    void next.then(clear, clear);
    return next;
  }
  function savePreset(value: Preset): Promise<boolean> {
    if (!validPreset(value)) return Promise.resolve(false);
    const saved = copy(value);
    return changePresets(current => [...current.filter(item => item.id !== saved.id), saved]);
  }
  function deletePreset(id: string): Promise<boolean> { return changePresets(current => current.filter(item => item.id !== id)); }
  return { bind, saveDraft, clearDraft, restoreDraft, savePreset, deletePreset, presets: () => copy(presets), available: () => ready && !!scope && !!store, flush: async () => {
    while (writing || writes.size || presetWrite) await (presetWrite ?? tail);
  } };
}
