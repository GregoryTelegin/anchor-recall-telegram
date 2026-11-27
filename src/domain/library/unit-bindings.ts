export interface UnitBindings { unitId?: string; unitIds?: readonly string[]; }

/** Validate untrusted imports/drafts before the read helper removes duplicates. */
export function validUnitBindings(value: { unitId?: unknown; unitIds?: unknown }, knownIds?: ReadonlySet<string>): boolean {
  const validId = (id: unknown): id is string => typeof id === "string" && Boolean(id.trim()) && id.length <= 500 && (!knownIds || knownIds.has(id));
  if (value.unitId !== undefined && !validId(value.unitId)) return false;
  if (value.unitIds === undefined) return true;
  if (!Array.isArray(value.unitIds) || value.unitIds.length > 10_000) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.unitIds.length; index++) {
    const id = value.unitIds[index];
    if (!Object.prototype.hasOwnProperty.call(value.unitIds, index) || !validId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return value.unitId === undefined || value.unitId === value.unitIds[0];
}

/** An explicit list is authoritative, including an empty list. Legacy records
 * keep their single binding until the user actually edits their sections. */
export function unitIdsOf(value?: UnitBindings | null): string[] {
  if (Array.isArray(value?.unitIds)) return [...new Set(value.unitIds.filter(id => typeof id === "string" && Boolean(id)))];
  return value?.unitId ? [value.unitId] : [];
}

/** The first ID keeps older single-section integrations usable; new readers use
 * the full list. Removing the last checkbox also clears that legacy alias. */
export function unitBindingPatch(ids: readonly string[]): { unitIds: string[]; unitId: string | undefined } {
  const unitIds = [...new Set(ids.filter(id => typeof id === "string" && Boolean(id)))];
  return { unitIds, unitId: unitIds[0] };
}
