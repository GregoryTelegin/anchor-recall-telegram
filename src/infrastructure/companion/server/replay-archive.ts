import { invalid } from "../../../domain/companion/protocol";
import { companionArchiveKey } from "../../../features/companion/authority-archive";
import { DesktopCompanionAuthorityArchive } from "../desktop-authority-archive";

export type ServerReplayKind = "update" | "callback" | "miniapp";
export interface ServerReplayRow { kind: ServerReplayKind; id: string; hash: string; }
export interface ServerReplayArchive {
  get(enrollment: string, kind: ServerReplayKind, id: string): string | undefined;
  putMany(enrollment: string, rows: readonly ServerReplayRow[]): void;
  assertPresent(enrollment: string): void;
}

const storageKind = "server-replay";
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function replayKey(enrollment: string, kind: ServerReplayKind, id: string): string {
  invalid(isHash(enrollment), "Invalid replay enrollment");
  invalid(typeof id === "string", "Invalid Telegram replay ID");
  if (kind === "update") {
    const number = Number(id);
    invalid(Number.isSafeInteger(number) && number >= 0 && String(number) === id, "Invalid Telegram update ID");
  } else invalid((kind === "callback" || kind === "miniapp") && id.length > 0 && id.length <= 128, "Invalid request ID");
  return companionArchiveKey(enrollment, kind, id);
}

/** Stores one exact digest per processed Telegram identity. Only archive committed journal rows. */
export class DesktopServerReplayArchive implements ServerReplayArchive {
  private readonly archive: DesktopCompanionAuthorityArchive;
  constructor(directory: string, binding: string) {
    this.archive = new DesktopCompanionAuthorityArchive(directory, binding);
  }

  assertPresent(enrollment: string): void {
    invalid(isHash(enrollment) && this.archive.get(storageKind, companionArchiveKey(enrollment, "present")) === enrollment, "Telegram replay archive unavailable");
  }

  get(enrollment: string, kind: ServerReplayKind, id: string): string | undefined {
    const value = this.archive.get(storageKind, replayKey(enrollment, kind, id));
    if (value === undefined) return undefined;
    invalid(isHash(value), "Invalid Telegram replay digest");
    return value;
  }

  putMany(enrollment: string, rows: readonly ServerReplayRow[]): void {
    if (!rows.length) return;
    const markerKey = companionArchiveKey(enrollment, "present");
    const staged = new Map<string, string>();
    for (const row of rows) {
      const key = replayKey(enrollment, row.kind, row.id), previous = staged.get(key);
      invalid(isHash(row.hash), "Invalid Telegram replay digest");
      invalid(previous === undefined || previous === row.hash, "Telegram replay identity collision");
      staged.set(key, row.hash);
    }
    const existing = this.archive.getMany(storageKind, [markerKey, ...staged.keys()]);
    invalid(!existing.size || existing.get(markerKey) === enrollment, "Telegram replay archive unavailable");
    for (const [key, hash] of staged) {
      const previous = existing.get(key);
      invalid(previous === undefined || previous === hash, "Telegram replay identity collision");
    }
    staged.set(markerKey, enrollment);
    this.archive.putMany(storageKind, [...staged].map(([key, value]) => ({ key, value })), () => undefined);
  }
}
