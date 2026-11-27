import type { ServerReplayArchive } from "./replay-archive";
import type { ServerState } from "./server-state";

const HOT_ROWS = 1024;

function retiredRows<T extends { id: string | number; hash: string }>(rows: T[], committed: T[]): T[] {
  if (rows.length <= HOT_ROWS * 2) return [];
  const known = new Map(committed.map(row => [row.id, row.hash]));
  return rows.filter(row => known.get(row.id) === row.hash).slice(0, rows.length - HOT_ROWS);
}

export function compactServerReplay(state: ServerState, committed: ServerState | undefined, archive?: ServerReplayArchive): void {
  if (!archive || !committed) return;
  const updates = retiredRows(state.updates, committed.updates);
  const callbacks = retiredRows(state.callbackIds, committed.callbackIds);
  const miniApp = retiredRows(state.miniAppReceipts ?? [], committed.miniAppReceipts ?? []);
  if (!updates.length && !callbacks.length && !miniApp.length) return;
  // Only archive committed events. An interrupted journal save must leave new events retryable.
  archive.putMany(state.binding, [
    ...updates.map(row => ({ kind: "update" as const, id: String(row.id), hash: row.hash })),
    ...callbacks.map(row => ({ kind: "callback" as const, id: row.id, hash: row.hash })),
    ...miniApp.map(row => ({ kind: "miniapp" as const, id: row.id, hash: row.hash }))
  ]);
  const updateIds = new Set(updates.map(row => row.id)), callbackIds = new Set(callbacks.map(row => row.id));
  state.updates = state.updates.filter(row => !updateIds.has(row.id));
  state.callbackIds = state.callbackIds.filter(row => !callbackIds.has(row.id));
  if (miniApp.length) {
    const requestIds = new Set(miniApp.map(row => row.id));
    state.miniAppReceipts = state.miniAppReceipts!.filter(row => !requestIds.has(row.id));
  }
  state.replayArchived = true;
}
