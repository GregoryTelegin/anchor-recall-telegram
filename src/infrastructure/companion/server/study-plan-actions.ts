import { invalid } from "../../../domain/companion/protocol";
import { validateCompanionStudyPlan, type CompanionStudyPlan, type CompanionCalendarDelivery } from "../../../domain/companion/study-plan";
import { COMPANION_PLAN_ACTION_TTL, sameCompanionPlanCommand, validateCompanionPlanCommand,
  validateCompanionPlanCommandReceipt, type CompanionPlanCommand, type CompanionPlanCommandReceipt } from "../../../domain/companion/study-plan-actions";
import { zonedClock } from "../../../domain/planning/study-autoplan-plan";

export interface CompanionPlanCommandState { planCommands?: CompanionPlanCommand[]; planCommandReceipts?: CompanionPlanCommandReceipt[]; }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function validateCompanionPlanCommandState(state: CompanionPlanCommandState): void {
  const pending = state.planCommands ?? [], receipts = state.planCommandReceipts ?? [];
  invalid(Array.isArray(pending) && Array.isArray(receipts));
  const ids = new Set<string>();
  for (const command of pending) { validateCompanionPlanCommand(command); invalid(!ids.has(command.id)); ids.add(command.id); }
  for (const receipt of receipts) { validateCompanionPlanCommandReceipt(receipt); invalid(!ids.has(receipt.command.id)); ids.add(receipt.command.id); }
}
/** An explicit plan action is separate from learning grades and notification snoozes. */
export function enqueueCompanionPlanCommand(state: CompanionPlanCommandState, plan: CompanionStudyPlan, command: CompanionPlanCommand, now: number): void {
  validateCompanionPlanCommand(command); validateCompanionStudyPlan(plan); validateCompanionPlanCommandState(state);
  const prior = state.planCommands?.find(row => row.id === command.id) ?? state.planCommandReceipts?.find(row => row.command.id === command.id)?.command;
  if (prior) { invalid(sameCompanionPlanCommand(prior, command), "plan command ID collision"); return; }
  invalid(now < plan.expiresAt && plan.generatedAt <= now + 300000 && command.requestedAt <= now + 300000
    && now - command.requestedAt <= COMPANION_PLAN_ACTION_TTL, "expired plan command");
  const entry = (plan.overview ?? plan.entries).find(row => row.id === command.entryId);
  invalid(entry?.action && entry.action.revision === command.revision, "stale plan command");
  invalid(!(state.planCommands ?? []).some(row => row.entryId === command.entryId), "plan command pending");
  if (command.action === "reschedule") {
    invalid(entry.action.canMoveDate || command.date === entry.action.date, "daily block date cannot move");
    const [hour, minute] = command.time!.split(":").map(Number);
    invalid(zonedClock(plan.timeZone).instant(command.date!, hour * 60 + minute) !== undefined, "invalid plan wall time");
  }
  (state.planCommands ??= []).push(copy(command));
}
export function acknowledgeCompanionPlanCommand(state: CompanionPlanCommandState, command: CompanionPlanCommand, receipt: CompanionPlanCommandReceipt): void {
  validateCompanionPlanCommandReceipt(receipt, command); validateCompanionPlanCommandState(state);
  const previous = state.planCommandReceipts?.find(row => row.command.id === command.id);
  if (previous) { invalid(previous.status === receipt.status && sameCompanionPlanCommand(previous.command, receipt.command), "plan command receipt collision"); return; }
  const pending = state.planCommands?.find(row => row.id === command.id);
  invalid(pending && sameCompanionPlanCommand(pending, command), "unknown plan command");
  state.planCommands = state.planCommands!.filter(row => row.id !== command.id);
  (state.planCommandReceipts ??= []).push(copy(receipt));
}
/** Keep the old occurrence quiet until the plugin confirms and publishes a new version. */
export function companionPlanEntryPending(state: CompanionPlanCommandState, entryId: string, revision?: string): boolean {
  if (state.planCommands?.some(row => row.entryId === entryId)) return true;
  return !!state.planCommandReceipts?.some(row => row.status === "applied" && row.command.entryId === entryId && row.command.revision === revision);
}
export function companionPlanCommandViews(state: CompanionPlanCommandState, plan?: CompanionStudyPlan): { id: string; entryId: string; action: CompanionPlanCommand["action"]; status: "pending" | CompanionPlanCommandReceipt["status"]; requestedAt: number; calendar?: CompanionCalendarDelivery }[] {
  const recent = [...(state.planCommandReceipts ?? []), ...(state.planCommands ?? []).map(command => ({ command, status: "pending" as const }))]
    .sort((a, b) => a.command.requestedAt - b.command.requestedAt).slice(-100);
  const entries = new Map(plan?.overview?.map(row => [row.id, row]));
  const delivery = (receipt: CompanionPlanCommandReceipt): CompanionCalendarDelivery | undefined => {
    if (receipt.status !== "applied") return undefined;
    const command = receipt.command, entry = entries.get(command.entryId);
    if (!entry?.action || !entry.calendar) return undefined;
    // The pre-command snapshot may already have a Google success; it cannot confirm this mutation.
    if (entry.action.revision === command.revision) return { state: "waiting" };
    const matches = command.action === "reschedule" ? entry.action.date === command.date && entry.action.time === command.time && entry.action.durationMinutes === command.durationMinutes
      : command.action === "complete" ? entry.completed === true : entry.completed !== true;
    return matches ? { ...entry.calendar } : undefined;
  };
  return recent.map(row => {
    const calendar = row.status === "pending" ? undefined : delivery(row);
    return { id: row.command.id, entryId: row.command.entryId, action: row.command.action, status: row.status,
      requestedAt: row.command.requestedAt, ...(calendar ? { calendar } : {}) };
  });
}
