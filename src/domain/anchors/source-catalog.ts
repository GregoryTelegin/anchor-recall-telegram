/** File identity is independent from its path and from material/fragment IDs. */
export interface SourceFileRecord {
  id: string;
  path: string;
  sha256?: string;
  size?: number;
  mtime?: number;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const isSourceFileId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const isSourceFileHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** The catalogue also retains a known file after its extension becomes unsupported. */
export function isSourceCatalogPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value !== value.trim() || /[\\:\u0000-\u001f\u007f]/u.test(value)) return false;
  return value.split("/").every(part => Boolean(part) && part !== "." && part !== ".."
    && ![".obsidian", ".git"].includes(part.toLowerCase()));
}

/** Rejects malformed persisted metadata rather than silently discarding identity. */
export function validateSourceCatalog(value: unknown): SourceFileRecord[] {
  if (!Array.isArray(value)) throw new Error("Каталог источников должен быть массивом.");
  const ids = new Set<string>(), paths = new Set<string>(), result: SourceFileRecord[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (!Object.prototype.hasOwnProperty.call(value, index) || !record(item)
      || Object.keys(item).some(key => !["id", "path", "sha256", "size", "mtime"].includes(key))
      || !isSourceFileId(item.id) || !isSourceCatalogPath(item.path)
      || item.sha256 !== undefined && !isSourceFileHash(item.sha256)
      || item.size !== undefined && (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0)
      || item.mtime !== undefined && (typeof item.mtime !== "number" || !Number.isFinite(item.mtime) || item.mtime < 0))
      throw new Error(`Источник ${index + 1}: повреждены ID, путь или отпечаток файла.`);
    if (ids.has(item.id) || paths.has(item.path)) throw new Error("Каталог источников содержит повторяющийся ID или путь.");
    ids.add(item.id); paths.add(item.path);
    result.push({ id: item.id, path: item.path,
      ...(item.sha256 !== undefined ? { sha256: item.sha256 as string } : {}),
      ...(item.size !== undefined ? { size: item.size as number } : {}),
      ...(item.mtime !== undefined ? { mtime: item.mtime as number } : {}) });
  }
  return result;
}

/** Rename only: one event may move an entire directory without changing file IDs. */
export function planSourceCatalogRename(catalog: readonly SourceFileRecord[], oldPath: string, newPath: string): SourceFileRecord[] {
  const current = validateSourceCatalog(catalog);
  if (!isSourceCatalogPath(oldPath) || !isSourceCatalogPath(newPath)) throw new Error("Некорректный путь переноса источника.");
  if (oldPath === newPath) return current;
  return validateSourceCatalog(current.map(item => ({ ...item, path: item.path === oldPath ? newPath
    : item.path.startsWith(`${oldPath}/`) ? newPath + item.path.slice(oldPath.length) : item.path })));
}

