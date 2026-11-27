import type { Card, CardInput } from "ts-fsrs";
import type { StoredFsrsCard } from "../review/types";

export const serializeFsrsCard = (card: Card): StoredFsrsCard => ({
  due: card.due.getTime(), stability: card.stability, difficulty: card.difficulty,
  elapsedDays: card.elapsed_days, scheduledDays: card.scheduled_days, learningSteps: card.learning_steps,
  reps: card.reps, lapses: card.lapses, state: card.state, lastReview: card.last_review?.getTime()
});

export const deserializeFsrsCard = (card: StoredFsrsCard): CardInput => ({
  due: card.due, stability: card.stability, difficulty: card.difficulty,
  elapsed_days: card.elapsedDays, scheduled_days: card.scheduledDays, learning_steps: card.learningSteps,
  reps: card.reps, lapses: card.lapses, state: card.state, last_review: card.lastReview ?? null
});
