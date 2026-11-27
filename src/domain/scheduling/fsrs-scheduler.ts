import { createEmptyCard, fsrs, type Card, type FSRSParameters, type Grade } from "ts-fsrs";
import type { Settings } from "../settings/types";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { normalizeFsrsSteps } from "./intervals";
import { deserializeFsrsCard, serializeFsrsCard } from "./fsrs-card";
import type { ReviewRating, StoredFsrsCard } from "../review/types";

export type FsrsSchedulerSettings = Pick<Settings, "fsrsParameters" | "fsrsDesiredRetention" | "fsrsShortTermEnabled" | "fsrsLearningSteps" | "fsrsRelearningSteps">;
export type FsrsSchedulingSource = { createdAt: number; dueAt: number; fsrsCard?: StoredFsrsCard };

/** One settings projection for local reviews and explicitly authorized companion copies. */
export function createFsrsScheduler(settings: FsrsSchedulerSettings): ReturnType<typeof fsrs> {
  return fsrs({ w: settings.fsrsParameters ?? undefined, request_retention: settings.fsrsDesiredRetention,
    enable_short_term: settings.fsrsShortTermEnabled,
    learning_steps: normalizeFsrsSteps(settings.fsrsLearningSteps, 2, DEFAULT_SETTINGS.fsrsLearningSteps),
    relearning_steps: normalizeFsrsSteps(settings.fsrsRelearningSteps, 1, DEFAULT_SETTINGS.fsrsRelearningSteps) });
}

export function createInitialFsrsCard(source: Pick<FsrsSchedulingSource, "createdAt" | "dueAt">): Card {
  const card = createEmptyCard(new Date(source.createdAt)); card.due = new Date(source.dueAt); return card;
}

export function nextFsrsCard(source: FsrsSchedulingSource, rating: ReviewRating, reviewedAt: number, parameters: FSRSParameters): StoredFsrsCard {
  const card = source.fsrsCard ? deserializeFsrsCard(source.fsrsCard) : createInitialFsrsCard(source);
  return serializeFsrsCard(fsrs(parameters).next(card, new Date(reviewedAt), rating as Grade).card);
}
