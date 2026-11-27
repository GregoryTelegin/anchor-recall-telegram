export interface TextBoundary { offset: number; before: string; after: string; }
export interface PdfBoundary { page: number; y: number; }
export type StudyRange =
  | { version: 1; kind: "markdown"; start: TextBoundary; end: TextBoundary }
  | { version: 1; kind: "pdf"; start: PdfBoundary; end: PdfBoundary; fileSize: number; modifiedAt: number };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const textPoint = (value: unknown): value is TextBoundary => record(value) && natural(value.offset)
  && typeof value.before === "string" && typeof value.after === "string" && value.before.length <= 160 && value.after.length <= 160
  && Boolean(value.before || value.after);
const pdfPoint = (value: unknown): value is PdfBoundary => record(value) && natural(value.page) && value.page > 0
  && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
export function normalizeStudyRange(value: unknown): StudyRange | undefined {
  if (!record(value) || value.version !== 1) return undefined;
  if (value.kind === "markdown" && textPoint(value.start) && textPoint(value.end) && value.end.offset > value.start.offset)
    return { version: 1, kind: "markdown", start: { ...value.start }, end: { ...value.end } };
  if (value.kind === "pdf" && pdfPoint(value.start) && pdfPoint(value.end) && natural(value.fileSize)
    && typeof value.modifiedAt === "number" && Number.isFinite(value.modifiedAt) && value.modifiedAt >= 0
    && (value.end.page > value.start.page || (value.end.page === value.start.page && value.end.y > value.start.y)))
    return { version: 1, kind: "pdf", start: { ...value.start }, end: { ...value.end }, fileSize: value.fileSize, modifiedAt: value.modifiedAt };
  return undefined;
}
export function captureTextBoundary(content: string, offset: number): TextBoundary {
  const position = Math.max(0, Math.min(content.length, Math.trunc(offset)));
  return { offset: position, before: content.slice(Math.max(0, position - 160), position), after: content.slice(position, position + 160) };
}
/** Never fall back to a raw offset for an end marker: a wrong end misstates the assignment. */
export function resolveTextBoundary(content: string, point: TextBoundary): number | null {
  const needle = point.before + point.after;
  if (!needle) return null;
  const first = content.indexOf(needle);
  if (first < 0 || content.indexOf(needle, first + 1) >= 0) return null;
  return first + point.before.length;
}
export function resolveStudyTextRange(content: string, range: StudyRange): { start: number; end: number } | null {
  if (range.kind !== "markdown") return null;
  const start = resolveTextBoundary(content, range.start); const end = resolveTextBoundary(content, range.end);
  return start !== null && end !== null && end > start ? { start, end } : null;
}
export function captureStudyTextRange(content: string, start: number, end: number): StudyRange | undefined {
  return normalizeStudyRange({ version: 1, kind: "markdown", start: captureTextBoundary(content, Math.min(start, end)), end: captureTextBoundary(content, Math.max(start, end)) });
}
export function studyRangeLabel(range: StudyRange): string {
  return range.kind === "pdf" ? `Фрагмент · стр. ${range.start.page}–${range.end.page}` : "Границы материала";
}
export function pdfStudyRangeIsCurrent(range: StudyRange, stat: { size: number; mtime: number }): boolean {
  return range.kind === "pdf" && range.fileSize === stat.size && range.modifiedAt === stat.mtime;
}
