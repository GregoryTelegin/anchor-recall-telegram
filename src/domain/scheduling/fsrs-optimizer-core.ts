export type FsrsOptimizerRating = 1 | 2 | 3 | 4;

export interface FsrsOptimizerHistoryEntry {
  reviewedAt: number;
  rating?: number;
  schedulerMode?: string;
}

export interface FsrsOptimizerCardSource {
  id: string;
  reviewHistory: FsrsOptimizerHistoryEntry[];
}

export interface FsrsOptimizerReview {
  rating: FsrsOptimizerRating;
  deltaDays: number;
  reviewedAt: number;
}

export interface FsrsOptimizerItem {
  id: string;
  cardId: string;
  reviews: FsrsOptimizerReview[];
}

export interface FsrsOptimizerDataset {
  items: FsrsOptimizerItem[];
  totalReviews: number;
  cardsWithHistory: number;
  excludedShortRuns: number;
  ratings: Record<FsrsOptimizerRating, number>;
}

export interface FsrsOptimizerDatasetOptions {
  dayCutoffHour?: number;
  minimumReviewsPerItem?: number;
}

const DAY = 86_400_000;

const isRating = (value: number | undefined): value is FsrsOptimizerRating =>
  value === 1 || value === 2 || value === 3 || value === 4;

/** Converts a timestamp into a local calendar-day index after the study-day cutoff.
 * Calendar components are used instead of dividing timestamps directly, so DST days
 * do not accidentally become zero- or two-day review gaps.
 */
export const fsrsStudyDay = (timestamp: number, dayCutoffHour = 4): number => {
  const cutoff = Math.max(0, Math.min(23, Math.trunc(dayCutoffHour)));
  const shifted = new Date(timestamp); shifted.setHours(shifted.getHours() - cutoff);
  return Math.trunc(Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) / DAY);
};

export const buildFsrsOptimizerDataset = (
  cards: FsrsOptimizerCardSource[],
  options: FsrsOptimizerDatasetOptions = {}
): FsrsOptimizerDataset => {
  const cutoff = options.dayCutoffHour ?? 4;
  const minimumReviews = Math.max(2, Math.trunc(options.minimumReviewsPerItem ?? 2));
  const items: FsrsOptimizerItem[] = [];
  let excludedShortRuns = 0;
  let totalReviews = 0;
  const ratings: Record<FsrsOptimizerRating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  cards.forEach((card) => {
    const history = [...card.reviewHistory]
      .filter((entry) => Number.isFinite(entry.reviewedAt))
      .sort((a, b) => a.reviewedAt - b.reviewedAt);
    let run: FsrsOptimizerHistoryEntry[] = [];
    let runIndex = 0;
    const flush = (): void => {
      if (!run.length) return;
      if (run.length < minimumReviews) excludedShortRuns += 1;
      else {
        let previousDay: number | undefined;
        const reviews = run.map((entry) => {
          const day = fsrsStudyDay(entry.reviewedAt, cutoff);
          const review: FsrsOptimizerReview = {
            rating: entry.rating as FsrsOptimizerRating,
            deltaDays: previousDay === undefined ? 0 : Math.max(0, day - previousDay),
            reviewedAt: entry.reviewedAt
          };
          previousDay = day; return review;
        });
        totalReviews += reviews.length;
        reviews.forEach((review) => { ratings[review.rating] += 1; });
        // The official binding expects one training item per target review. Each
        // item contains that review and every earlier review of the same run.
        for (let length = minimumReviews; length <= reviews.length; length += 1) {
          items.push({ id: `${card.id}:${runIndex}:${length}`, cardId: card.id, reviews: reviews.slice(0, length) });
        }
      }
      run = []; runIndex += 1;
    };
    history.forEach((entry) => {
      if (entry.schedulerMode === "fsrs" && isRating(entry.rating)) run.push(entry);
      else flush();
    });
    flush();
  });

  return {
    items,
    totalReviews,
    cardsWithHistory: new Set(items.map((item) => item.cardId)).size,
    excludedShortRuns,
    ratings
  };
};

export const toFsrsBindingPayload = (dataset: FsrsOptimizerDataset): Array<Array<[FsrsOptimizerRating, number]>> =>
  dataset.items.map((item) => item.reviews.map((review) => [review.rating, review.deltaDays]));
