import { invalid, type SelectedCard } from "../../../domain/companion/protocol";
import { COMPANION_CARD_REPORT_TTL, companionCardReportContentHash, sameCompanionCardReport,
  validateCompanionCardReport, validateCompanionCardReportReceipt, type CompanionCardReport, type CompanionCardReportReceipt } from "../../../domain/companion/card-reports";

export interface CompanionCardReportState { cardReports?: CompanionCardReport[]; cardReportReceipts?: CompanionCardReportReceipt[]; }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function validateCompanionCardReportState(state: CompanionCardReportState): void {
  invalid((state.cardReports === undefined || Array.isArray(state.cardReports))
    && (state.cardReportReceipts === undefined || Array.isArray(state.cardReportReceipts)));
  const ids = new Set<string>();
  for (const row of state.cardReports ?? []) { validateCompanionCardReport(row); invalid(!ids.has(row.id)); ids.add(row.id); }
  for (const row of state.cardReportReceipts ?? []) { validateCompanionCardReportReceipt(row); invalid(!ids.has(row.report.id)); ids.add(row.report.id); }
}
export function enqueueCompanionCardReport(state: CompanionCardReportState, report: CompanionCardReport, card: SelectedCard, now: number): void {
  validateCompanionCardReport(report); validateCompanionCardReportState(state);
  const prior = state.cardReports?.find(row => row.id === report.id) ?? state.cardReportReceipts?.find(row => row.report.id === report.id)?.report;
  if (prior) { invalid(sameCompanionCardReport(prior, report), "card report ID collision"); return; }
  invalid(report.cardId === card.id && report.materialId === card.materialId && report.contentHash === companionCardReportContentHash(card)
    && report.requestedAt <= now + 300000 && now - report.requestedAt <= COMPANION_CARD_REPORT_TTL, "stale card report");
  invalid(!state.cardReports?.some(row => row.cardId === card.id), "card report pending");
  (state.cardReports ??= []).push(copy(report));
}
export function acknowledgeCompanionCardReport(state: CompanionCardReportState, report: CompanionCardReport, receipt: CompanionCardReportReceipt): void {
  validateCompanionCardReportReceipt(receipt, report); validateCompanionCardReportState(state);
  const previous = state.cardReportReceipts?.find(row => row.report.id === report.id);
  if (previous) { invalid(previous.status === receipt.status && sameCompanionCardReport(previous.report, report), "card report receipt collision"); return; }
  const pending = state.cardReports?.find(row => row.id === report.id);
  invalid(pending && sameCompanionCardReport(pending, report), "unknown card report");
  state.cardReports = state.cardReports!.filter(row => row.id !== report.id);
  (state.cardReportReceipts ??= []).push(copy(receipt));
}
export function companionCardReportViews(state: CompanionCardReportState, cards: readonly SelectedCard[]) {
  if (!state.cardReportReceipts?.length && !state.cardReports?.length) return [];
  const available = new Map(cards.map(card => [card.id, card])), hashes = new Map<string, string>();
  return [...(state.cardReportReceipts ?? []), ...(state.cardReports ?? []).map(report => ({ report, status: "pending" as const }))]
    .filter(({ report }) => {
      const card = available.get(report.cardId);
      if (!card) return false;
      let hash = hashes.get(card.id);
      if (hash === undefined) { hash = companionCardReportContentHash(card); hashes.set(card.id, hash); }
      return report.contentHash === hash;
    })
    .sort((a, b) => a.report.requestedAt - b.report.requestedAt).slice(-100)
    .map(({ report, status }) => ({ id: report.id, cardId: report.cardId, status, requestedAt: report.requestedAt }));
}
