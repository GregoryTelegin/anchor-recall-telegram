/** Side-effect-free canonical v1 wire contract shared by local Obsidian and companion. */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { invalid, record, validateAttempt, type ReviewAttempt } from "../../../domain/companion/protocol";
import { validateCompanionGradeCorrection, type CompanionGradeCorrection } from "../../../domain/companion/corrections";
import { validateCompanionPlanCommand, type CompanionPlanCommand } from "../../../domain/companion/study-plan-actions";
import { validateCompanionCardReport, type CompanionCardReport } from "../../../domain/companion/card-reports";
import { validateCompanionWrittenRecall, type CompanionWrittenRecall } from "../../../domain/companion/written-recall";
import { validateCompanionAnswerHistory, type CompanionAnswerHistory } from "../../../domain/companion/answer-history";
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { invalid(Number.isSafeInteger(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  record(value); return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const sign = (secret: string, value: unknown): string => createHmac("sha256", secret).update(canonical(value)).digest("hex");
export function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export interface BridgeEnvelope { version: 1; method: "POST"; path: string; scope: string; epoch: string; enrollment: string; time: number; nonce: string; payload: unknown; }
export function pendingCapability(secret: string, enrollment: string, attempt: ReviewAttempt): string {
  return sign(secret, { purpose: "ack-v1", enrollment, attempt });
}
export function verifyPendingCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, attempt: unknown, capability: unknown): attempt is ReviewAttempt {
  try {
    validateAttempt(attempt);
    return attempt.scope === binding.scope && attempt.epoch === binding.epoch && typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability) && equal(capability, pendingCapability(secret, binding.enrollment, attempt));
  } catch { return false; }
}
export function correctionCapability(secret: string, enrollment: string, correction: CompanionGradeCorrection): string {
  return sign(secret, { purpose: "grade-correction-v1", enrollment, correction });
}
export function verifyCorrectionCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, correction: unknown, capability: unknown): correction is CompanionGradeCorrection {
  try {
    validateCompanionGradeCorrection(correction);
    return correction.scope === binding.scope && correction.epoch === binding.epoch && typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability)
      && equal(capability, correctionCapability(secret, binding.enrollment, correction));
  } catch { return false; }
}
export function planCommandCapability(secret: string, enrollment: string, command: CompanionPlanCommand): string {
  return sign(secret, { purpose: "plan-command-v1", enrollment, command });
}
export function verifyPlanCommandCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, command: unknown, capability: unknown): command is CompanionPlanCommand {
  try {
    validateCompanionPlanCommand(command);
    return command.scope === binding.scope && command.epoch === binding.epoch && typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability)
      && equal(capability, planCommandCapability(secret, binding.enrollment, command));
  } catch { return false; }
}
export function cardReportCapability(secret: string, enrollment: string, report: CompanionCardReport): string {
  return sign(secret, { purpose: "card-report-v1", enrollment, report });
}
export function verifyCardReportCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, report: unknown, capability: unknown): report is CompanionCardReport {
  try {
    validateCompanionCardReport(report);
    return report.scope === binding.scope && report.epoch === binding.epoch && typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability)
      && equal(capability, cardReportCapability(secret, binding.enrollment, report));
  } catch { return false; }
}
export function writtenRecallCapability(secret: string, enrollment: string, recall: CompanionWrittenRecall): string {
  return sign(secret, { purpose: "written-recall-v1", enrollment, recall });
}
export function answerHistoryCapability(secret: string, enrollment: string, value: CompanionAnswerHistory): string {
  return sign(secret, { purpose: "answer-history-v1", enrollment, record: value });
}
export function verifyAnswerHistoryCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, value: unknown, capability: unknown): boolean {
  try { validateCompanionAnswerHistory(value); return value.attempt.scope === binding.scope && value.attempt.epoch === binding.epoch && typeof capability === "string"
    && equal(capability, answerHistoryCapability(secret, binding.enrollment, value)); } catch { return false; }
}
export function verifyWrittenRecallCapability(secret: string, binding: { scope: string; epoch: string; enrollment: string }, recall: unknown, capability: unknown): recall is CompanionWrittenRecall {
  try {
    validateCompanionWrittenRecall(recall);
    return recall.attempt.scope === binding.scope && recall.attempt.epoch === binding.epoch && typeof capability === "string" && /^[a-f0-9]{64}$/.test(capability)
      && equal(capability, writtenRecallCapability(secret, binding.enrollment, recall));
  } catch { return false; }
}
