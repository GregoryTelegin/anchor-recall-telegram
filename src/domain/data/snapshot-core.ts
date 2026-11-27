import { isAbsolute, normalize, parse } from "path";

export type SnapshotStorageLocation = "plugin" | "vault" | "external";

export const DEFAULT_VAULT_SNAPSHOT_PATH = "Anchor Recall/Snapshots";

export const normalizeSnapshotVaultPath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!path || path.length > 240 || path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (segments[0]?.toLowerCase() === ".obsidian" && segments[1]?.toLowerCase() === "plugins") return null;
  return segments.join("/");
};

export const normalizeSnapshotExternalPath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > 1024 || input.includes("\0") || !isAbsolute(input)) return null;
  const path = normalize(input);
  if (!path || path === parse(path).root) return null;
  return path;
};

export const automaticSnapshotFilesToRemove = (files: string[], keep = 10): string[] => {
  const safeKeep = Math.max(0, Math.trunc(keep));
  return files.filter((path) => /(?:^|[\\/])auto-[^\\/]+\.json$/i.test(path)).sort().reverse().slice(safeKeep).sort();
};
