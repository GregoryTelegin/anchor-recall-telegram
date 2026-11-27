export type LibraryNavigationPosition = "left" | "right" | "top" | "bottom";

export const DEFAULT_LIBRARY_NAVIGATION_POSITION: LibraryNavigationPosition = "top";

export const isLibraryNavigationPosition = (value: unknown): value is LibraryNavigationPosition =>
  value === "left" || value === "right" || value === "top" || value === "bottom";

export const normalizeLibraryNavigationPosition = (value: unknown): LibraryNavigationPosition =>
  isLibraryNavigationPosition(value) ? value : DEFAULT_LIBRARY_NAVIGATION_POSITION;
