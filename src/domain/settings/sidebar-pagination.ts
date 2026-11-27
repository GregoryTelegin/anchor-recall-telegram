export const DEFAULT_SIDEBAR_CARDS_PER_PAGE = 50;

export interface SidebarCardsPerPageState { value: number; busy: boolean; error: boolean }

/** A display preference, never a review-session or scheduling limit. */
export const isSidebarCardsPerPage = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const normalizeSidebarCardsPerPage = (value: unknown): number =>
  isSidebarCardsPerPage(value) ? value : DEFAULT_SIDEBAR_CARDS_PER_PAGE;
