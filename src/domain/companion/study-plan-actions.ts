import { invalid, keys, record, timestamp, token } from "./protocol";
import { compactSourceFingerprint } from "../cards/import-source-identity";
import { isStudyTaskDate, type StudyTask } from "../planning/study-task";
import { jsonFingerprint } from "../../shared/json-fingerprint";

export const COMPANION_PLAN_ACTION_TTL = 7 * 86_400_000;
export interface CompanionPlanActionOptions {
  revision: string; date: string; time: string; durationMinutes: number; canMoveDate: boolean;
}
export interface CompanionPlanCommand {
  id: string; scope: string; epoch: string; entryId: string; revision: string;
  action: "complete" | "reopen" | "reschedule"; requestedAt: number;
  date?: string; time?: string; durationMinutes?: number;
}
export type CompanionPlanCommandStatus = "applied" | "conflict" | "missing" | "revoked" | "expired";
export interface CompanionPlanCommandReceipt { command: CompanionPlanCommand; status: CompanionPlanCommandStatus; }
export const isCompanionPlanHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validateCompanionPlanActionOptions(value: unknown): asserts value is CompanionPlanActionOptions {
  record(value); keys(value, ["revision", "date", "time", "durationMinutes", "canMoveDate"]);
  invalid(isCompanionPlanHash(value.revision) && typeof value.date === "string" && isStudyTaskDate(value.date)
    && typeof value.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
    && Number.isSafeInteger(value.durationMinutes) && Number(value.durationMinutes) >= 1 && Number(value.durationMinutes) <= 1440
    && typeof value.canMoveDate === "boolean");
}
export function validateCompanionPlanCommand(value: unknown): asserts value is CompanionPlanCommand {
  record(value); keys(value, ["id", "scope", "epoch", "entryId", "revision", "action", "requestedAt", "date", "time", "durationMinutes"]);
  token(value.id); token(value.scope); token(value.epoch); timestamp(value.requestedAt);
  invalid(isCompanionPlanHash(value.entryId) && isCompanionPlanHash(value.revision)
    && ["complete", "reopen", "reschedule"].includes(String(value.action)));
  if (value.action === "reschedule") {
    invalid(typeof value.date === "string" && isStudyTaskDate(value.date) && typeof value.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
      && Number.isSafeInteger(value.durationMinutes) && Number(value.durationMinutes) >= 1 && Number(value.durationMinutes) <= 1440);
  } else invalid(value.date === undefined && value.time === undefined && value.durationMinutes === undefined);
}
export const sameCompanionPlanCommand = (a: CompanionPlanCommand, b: CompanionPlanCommand): boolean => jsonFingerprint(a) === jsonFingerprint(b);
export function validateCompanionPlanCommandReceipt(value: unknown, expected?: CompanionPlanCommand): asserts value is CompanionPlanCommandReceipt {
  record(value); keys(value, ["command", "status"]); validateCompanionPlanCommand(value.command);
  invalid(!expected || sameCompanionPlanCommand(value.command, expected));
  invalid(["applied", "conflict", "missing", "revoked", "expired"].includes(String(value.status)));
}
/** Stable task/occurrence identity; independent from its current time or completion. */
export const companionStudyPlanEntryId = (identity: readonly unknown[]): string => compactSourceFingerprint(JSON.stringify(identity)).slice(7);
export const companionStudyTaskRevision = (task: StudyTask): string => compactSourceFingerprint(jsonFingerprint(task)!).slice(7);
export const companionDailyPlanRevision = (day: string, block: unknown, settings: unknown): string =>
  compactSourceFingerprint(jsonFingerprint([day, block, settings])!).slice(7);
