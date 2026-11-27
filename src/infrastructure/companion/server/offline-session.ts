import { COMPANION_CLOCK_SKEW, LEGACY_COMPANION_STUDY_COPY_TTL, invalid, keys, record, token, validateAttempt, validateSnapshot,
  type CompanionSnapshot, type ReviewAttempt, type SelectedCard } from "../../../domain/companion/protocol";
import { advanceOfflineFsrs, decodeOfflineSeed, decodeOfflineStep, offlineReviewTimeAllowed, offlineStateDue, validateOfflineSeed } from "../../../domain/companion/offline-fsrs";
import { snapshotCardMap } from "./immutable-content";

export interface OfflineHead {
  cardId: string; seed: string; state: string; index: number; lastAttemptId?: string; baseCard: SelectedCard;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value);
}
function authored(card: SelectedCard): string {
  return stable(Object.fromEntries(Object.entries(card).filter(([key]) => !["offline", "revision", "dueAt", "eligible"].includes(key))));
}
const newHead = (card: SelectedCard): OfflineHead => ({ cardId: card.id, seed: card.offline!, state: decodeOfflineSeed(card.offline!).state, index: 0, baseCard: clone(card) });

/** Unanswered roots already exist in the immutable snapshot and need no journal row. */
export function getOfflineHead(heads: readonly OfflineHead[] | undefined, snapshot: CompanionSnapshot | undefined, id: string): OfflineHead | undefined {
  const head = heads?.find(row => row.cardId === id); if (head) return head;
  const card = snapshot && snapshotCardMap(snapshot).get(id); return card?.offline ? newHead(card) : undefined;
}
export function ensureOfflineHead(heads: OfflineHead[], snapshot: CompanionSnapshot, id: string): OfflineHead | undefined {
  const existing = heads.find(row => row.cardId === id); if (existing) return existing;
  const card = snapshotCardMap(snapshot).get(id); if (!card?.offline) return;
  const head = newHead(card); heads.push(head); return head;
}

export function projectOfflineCard(head: OfflineHead): SelectedCard {
  return { ...clone(head.baseCard), offline: head.seed, revision: head.lastAttemptId ?? decodeOfflineSeed(head.seed).rootRevision, dueAt: offlineStateDue(head.state) };
}

/** A refresh cannot erase unsynchronized steps or restart an unchanged learning interval. */
export function reconcileOfflineHeads(previous: readonly OfflineHead[], next: CompanionSnapshot, now: number, pending: readonly ReviewAttempt[] = [], sparse = false): OfflineHead[] {
  const previousById = new Map(previous.map(head => [head.cardId, head])), pendingById = new Map(pending.map(row => [row.id, row]));
  return next.cards.filter(card => card.offline !== undefined && (!sparse || previousById.has(card.id))).map(card => {
    const current = decodeOfflineSeed(card.offline!), old = previousById.get(card.id);
    if (old) {
      const original = decodeOfflineSeed(old.seed), live = original.expiresAt > now && original.issuedAt - now <= COMPANION_CLOCK_SKEW;
      if (authored(old.baseCard) === authored(card) && original.config === current.config) {
        // A grade may arrive while Obsidian uploads media after its last empty queue read.
        // Never replace that advanced head with a newly issued, already outdated baseline.
        if (old.seed !== card.offline && current.state !== old.state) {
          let parent = old.lastAttemptId, after = old.state, index = old.index;
          while (parent !== undefined) {
            const found = pendingById.get(parent), attempt = found?.cardId === old.cardId && found.offline ? found : undefined;
            if (!attempt?.offline) break;
            const step = decodeOfflineStep(attempt.offline);
            if (step.rootRevision !== original.rootRevision || step.index !== index || step.after !== after) break;
            invalid(step.before !== current.state, "Offline queue changed; synchronize pending attempts before replacing baseline");
            parent = step.parentId; after = step.before; index--;
          }
        }
        const sameLifetime = (original.expiresAt - original.issuedAt > LEGACY_COMPANION_STUDY_COPY_TTL)
          === (current.expiresAt - current.issuedAt > LEGACY_COMPANION_STUDY_COPY_TTL);
        if (live && (old.seed === card.offline || sameLifetime && current.state === old.state)) return clone(old);
      }
    }
    return newHead(card);
  });
}

/** Private heads are replayed from signed root state and immutable pending/outcome events. */
export function validateOfflineHeads(heads: unknown, snapshot: CompanionSnapshot | undefined, attempts: readonly ReviewAttempt[]): void {
  if (heads === undefined) return;
  invalid(Array.isArray(heads) && (snapshot !== undefined || heads.length === 0));
  const ids = new Set<string>(), cards = snapshot && snapshotCardMap(snapshot), byAttempt = new Map(attempts.map(row => [row.id, row]));
  for (const value of heads) {
    record(value); keys(value, ["cardId", "seed", "state", "index", "lastAttemptId", "baseCard"]); token(value.cardId);
    invalid(!ids.has(value.cardId)); ids.add(value.cardId);
    validateOfflineSeed(value.seed); const seed = decodeOfflineSeed(value.seed); offlineStateDue(value.state as string);
    invalid(Number.isSafeInteger(value.index) && Number(value.index) >= 0 && Number(value.index) <= 10000
      && (value.index === 0 ? value.lastAttemptId === undefined : typeof value.lastAttemptId === "string"));
    if (value.lastAttemptId !== undefined) token(value.lastAttemptId);
    record(value.baseCard); const base = value.baseCard as unknown as SelectedCard;
    invalid(base.id === value.cardId && base.offline === value.seed);
    validateSnapshot({ version: 1, scope: snapshot!.scope, epoch: snapshot!.epoch, sequence: snapshot!.sequence,
      generatedAt: seed.issuedAt, expiresAt: seed.expiresAt, cards: [base] });
    const current = cards!.get(value.cardId);
    invalid(current?.offline !== undefined && authored(base) === authored(current) && decodeOfflineSeed(current.offline).config === seed.config, "offline source differs");
    const chain: ReviewAttempt[] = []; let cursor = value.lastAttemptId;
    for (let index = Number(value.index); index > 0; index--) {
      const found = byAttempt.get(cursor as string), attempt = found?.scope === snapshot!.scope && found.epoch === snapshot!.epoch && found.cardId === value.cardId ? found : undefined;
      invalid(attempt?.offline !== undefined, "offline parent missing"); const step = decodeOfflineStep(attempt.offline);
      invalid(step.rootRevision === seed.rootRevision && step.index === index, "offline branch differs");
      chain.unshift(attempt); cursor = step.parentId;
    }
    invalid(cursor === undefined, "offline branch differs");
    let state = seed.state, parent: string | undefined; const ancestors = new Set([state]);
    for (let index = 0; index < chain.length; index++) {
      const attempt = chain[index]; validateAttempt(attempt); const step = decodeOfflineStep(attempt.offline!);
      invalid(attempt.scope === snapshot!.scope && attempt.epoch === snapshot!.epoch && step.index === index + 1 && step.parentId === parent
        && step.before === state && attempt.revision === (parent ?? seed.rootRevision) && offlineReviewTimeAllowed(step, attempt.occurredAt), "offline chain differs");
      invalid(step.after === advanceOfflineFsrs(seed, state, attempt.correct ? attempt.rating : 1, attempt.occurredAt), "offline schedule differs");
      state = step.after; parent = attempt.id; ancestors.add(state);
    }
    invalid(state === value.state && parent === value.lastAttemptId && ancestors.has(decodeOfflineSeed(current.offline).state), "offline head differs");
  }
}

/** Frames retain whole authored content; a changed occurrence revision is verified separately at grading. */
export function validateSessionFrame(value: unknown, snapshot: CompanionSnapshot): void {
  record(value); const card = value as unknown as SelectedCard, normal = { ...value }; delete normal.offline;
  validateSnapshot({ ...snapshot, cards: [normal] });
  const base = snapshotCardMap(snapshot).get(card.id); invalid(base, "session card missing");
  if (card.offline === undefined) { invalid(stable(card) === stable(base), "session card differs"); return; }
  const seed = decodeOfflineSeed(card.offline);
  invalid(base.offline === card.offline && base.revision === seed.rootRevision && card.mode === "core" && card.eligible && card.dueAt !== undefined
    && authored(card) === authored(base), "offline session card differs");
}
export const validateOfflineSessionFrame = validateSessionFrame;
