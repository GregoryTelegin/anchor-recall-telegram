/** Closure-free: the Mini App embeds this validator without runtime module imports. */
export function readMiniAppVaultAuth(value: unknown): { token: string; expiresAt: number; storageScope?: string; vaultId?: string; vaults: { id: string; name: string }[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.token !== "string" || !data.token || data.token.length > 512 || /[\u0000-\u001f\u007f]/.test(data.token)
    || !Number.isSafeInteger(data.expiresAt) || Number(data.expiresAt) <= 0) return null;
  const legacy = data.vaultId === undefined && data.vaults === undefined;
  if (legacy) return { token: data.token, expiresAt: Number(data.expiresAt), ...(typeof data.storageScope === "string" ? { storageScope: data.storageScope } : {}), vaults: [] };
  if (typeof data.vaultId !== "string" || !/^[a-f0-9]{48}$/.test(data.vaultId)
    || typeof data.storageScope !== "string" || !/^[a-f0-9]{64}$/.test(data.storageScope)
    || !Array.isArray(data.vaults) || !data.vaults.length) return null;
  const vaults: { id: string; name: string }[] = [], ids = new Set<string>();
  for (const row of data.vaults) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !/^[a-f0-9]{48}$/.test(row.id)
      || ids.has(row.id) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 || /[\u0000-\u001f\u007f]/.test(row.name)) return null;
    ids.add(row.id); vaults.push({ id: row.id, name: row.name });
  }
  if (!ids.has(data.vaultId)) return null;
  return { token: data.token, expiresAt: Number(data.expiresAt), storageScope: data.storageScope, vaultId: data.vaultId, vaults };
}
