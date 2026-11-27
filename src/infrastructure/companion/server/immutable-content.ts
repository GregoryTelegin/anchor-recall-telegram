import { validateSnapshot, type CompanionSnapshot, type SelectedCard } from "../../../domain/companion/protocol";
import { validateCompanionStudyContext, type CompanionStudyContext } from "../../../domain/companion/study-context";
import type { ServerState } from "./server-state";
import { createHash } from "node:crypto";
import { decodeOfflineSeed, type OfflineSeed } from "../../../domain/companion/offline-fsrs";
import { cloneJsonValue, jsonFingerprintChunks } from "../../../shared/json-digest";

const snapshots = new WeakSet<object>(), contexts = new WeakSet<object>();
const cardIndexes = new WeakMap<CompanionSnapshot, Map<string, SelectedCard>>();
const metadataIndexes = new WeakMap<CompanionStudyContext, Map<string, CompanionStudyContext["cards"][number]>>();
const contextTokens = new WeakMap<CompanionStudyContext, string>();
const rootSeeds = new WeakMap<CompanionSnapshot, Map<string, OfflineSeed>>();
function freeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  if (!Object.isFrozen(value)) Object.freeze(value);
}
/** Only fully validated, deeply immutable content can skip repeated validation. */
export function validateImmutableSnapshot(value: unknown): asserts value is CompanionSnapshot {
  if (value && typeof value === "object" && snapshots.has(value)) return;
  validateSnapshot(value);
  freeze(value); snapshots.add(value);
}
export function validateImmutableStudyContext(value: unknown): asserts value is CompanionStudyContext {
  if (value && typeof value === "object" && contexts.has(value)) return;
  validateCompanionStudyContext(value);
  freeze(value); contexts.add(value);
}
export function snapshotCardMap(value: CompanionSnapshot): Map<string, SelectedCard> {
  // Mutable projected session copies are indexed only for the duration of one call.
  if (!snapshots.has(value)) return new Map(value.cards.map(card => [card.id, card]));
  let index = cardIndexes.get(value); if (!index) { index = new Map(value.cards.map(card => [card.id, card])); cardIndexes.set(value, index); }
  return index;
}
export function studyContextCardMap(value: CompanionStudyContext): Map<string, CompanionStudyContext["cards"][number]> {
  if (!contexts.has(value)) return new Map(value.cards.map(card => [card.id, card]));
  let index = metadataIndexes.get(value); if (!index) { index = new Map(value.cards.map(card => [card.id, card])); metadataIndexes.set(value, index); }
  return index;
}
export function studyContextToken(value: CompanionStudyContext): string {
  const old = contexts.has(value) && contextTokens.get(value); if (old) return old;
  const digest = createHash("sha256"); let pending = "";
  for (const chunk of jsonFingerprintChunks(value)) {
    if (pending.length + chunk.length > 65536 && pending) { digest.update(pending); pending = ""; }
    if (chunk.length > 65536) digest.update(chunk); else pending += chunk;
  }
  if (pending) digest.update(pending); const token = digest.digest("hex");
  if (contexts.has(value)) contextTokens.set(value, token); return token;
}
export function snapshotOfflineSeed(snapshot: CompanionSnapshot, id: string): OfflineSeed | undefined {
  const card = snapshotCardMap(snapshot).get(id); if (!card?.offline) return;
  if (!snapshots.has(snapshot)) return decodeOfflineSeed(card.offline);
  let seeds = rootSeeds.get(snapshot); if (!seeds) { seeds = new Map(); rootSeeds.set(snapshot, seeds); }
  let seed = seeds.get(id); if (!seed) { seed = decodeOfflineSeed(card.offline); freeze(seed); seeds.set(id, seed); } return seed;
}
/** Immutable authored content is stored separately from the mutable review journal. */
export function mutableServerState(state: ServerState): Omit<ServerState, "studyContext"> {
  const { studyContext: _context, domain, ...mutable } = state, { snapshot: _snapshot, ...mutableDomain } = domain;
  return { ...mutable, domain: mutableDomain };
}
export function cloneServerState(state: ServerState): ServerState {
  if (state.domain.snapshot) validateImmutableSnapshot(state.domain.snapshot);
  if (state.studyContext) validateImmutableStudyContext(state.studyContext);
  const copy = cloneJsonValue(mutableServerState(state)) as ServerState;
  if (state.domain.snapshot) copy.domain.snapshot = state.domain.snapshot;
  if (state.studyContext) copy.studyContext = state.studyContext;
  return copy;
}
