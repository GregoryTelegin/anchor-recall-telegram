import { companionSnapshotIsCurrent, invalid, keys, record, timestamp } from "../../../domain/companion/protocol";
import type { CompanionStudyPlan } from "../../../domain/companion/study-plan";
import { studyDay, validateTimeZone } from "./reminders";
import { canonical } from "./bridge-contract";
import type { ServerState } from "./runtime";

export type StudyPlanEntry = CompanionStudyPlan["entries"][number];
/** Journal-only ownership; never a Telegram payload field. */
export interface StudyPlanDelivery {
  id: string; notifyAt: number; startAt: number; title: string; timeZone: string; miniAppUrl: string;
}
export function validateMiniAppUrl(value: unknown): asserts value is string {
  invalid(typeof value === "string" && value.length <= 2048);
  const url = new URL(value);
  invalid(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === "/miniapp/" && url.href === value, "invalid Mini App URL");
}
export function miniAppLaunchUrl(base: string, planId?: string, vaultId?: string): string {
  validateMiniAppUrl(base);
  invalid(planId === undefined || /^[a-f0-9]{64}$/.test(planId));
  invalid(vaultId === undefined || /^[a-f0-9]{48}$/.test(vaultId));
  return base + (planId === undefined ? "" : "?plan=" + planId) + (vaultId === undefined ? "" : "#vault=" + vaultId);
}
export const DAILY_REMINDER_TEXT = "Пора повторять. Напишите go и выберите материал.";
/** Render at delivery so queued reminders remain compatible with the durable callback-only journal. */
export function reminderMiniAppPayload(payload: Record<string, unknown>, miniAppUrl: string, vaultId?: string): Record<string, unknown> {
  const launchUrl = miniAppLaunchUrl(miniAppUrl, undefined, vaultId);
  keys(payload, ["chat_id", "text", "disable_notification", "link_preview_options", "reply_markup"]);
  invalid(Number.isSafeInteger(payload.chat_id) && Number(payload.chat_id) > 0 && payload.text === DAILY_REMINDER_TEXT && payload.disable_notification === false);
  record(payload.link_preview_options); keys(payload.link_preview_options, ["is_disabled"]); invalid(payload.link_preview_options.is_disabled === true);
  record(payload.reply_markup); keys(payload.reply_markup, ["inline_keyboard"]);
  const rows = payload.reply_markup.inline_keyboard;
  const labels = ["Через 12 часов", "Через 24 часа", "До следующей сессии", "Пропустить учебный день"];
  invalid(Array.isArray(rows) && rows.length === labels.length);
  rows.forEach((row, index) => {
    invalid(Array.isArray(row) && row.length === 1); record(row[0]); keys(row[0], ["text", "callback_data"]);
    invalid(row[0].text === labels[index] && typeof row[0].callback_data === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row[0].callback_data));
  });
  return { ...payload, text: "Пора повторять. Начните занятие или перенесите напоминание.",
    reply_markup: { inline_keyboard: [...rows, [{ text: "Начать занятие", web_app: { url: launchUrl } }]] } };
}
export function validateReminderMiniAppPayload(payload: Record<string, unknown>, miniAppUrl: string, vaultId?: string): void {
  record(payload.reply_markup); const rows = payload.reply_markup.inline_keyboard;
  invalid(Array.isArray(rows) && rows.length === 5);
  const legacy = { ...payload, text: DAILY_REMINDER_TEXT, reply_markup: { inline_keyboard: rows.slice(0, -1) } };
  invalid(canonical(payload) === canonical(reminderMiniAppPayload(legacy, miniAppUrl, vaultId)), "unowned reminder launch");
}
export function studyPlanPayload(chatId: number, delivery: StudyPlanDelivery, vaultId?: string): Record<string, unknown> {
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: delivery.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(delivery.startAt);
  return { chat_id: chatId, text: `${delivery.title}\n${time}`, disable_notification: false, link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "Открыть занятие", web_app: { url: miniAppLaunchUrl(delivery.miniAppUrl, delivery.id, vaultId) } }]] } };
}
export function validateStudyPlanDelivery(value: unknown): asserts value is StudyPlanDelivery {
  record(value); keys(value, ["id", "notifyAt", "startAt", "title", "timeZone", "miniAppUrl"]);
  invalid(typeof value.id === "string" && value.id.length === 64 && /^[a-f0-9]{64}$/.test(value.id));
  timestamp(value.notifyAt); timestamp(value.startAt); invalid(value.notifyAt <= value.startAt);
  invalid(typeof value.title === "string" && value.title.length > 0 && value.title.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.title));
  validateTimeZone(value.timeZone as string); validateMiniAppUrl(value.miniAppUrl);
}
export function validateStudyPlanPayload(payload: Record<string, unknown>, delivery: StudyPlanDelivery, vaultId?: string): void {
  validateStudyPlanDelivery(delivery);
  invalid(Number.isSafeInteger(payload.chat_id) && Number(payload.chat_id) > 0);
  invalid(canonical(payload) === canonical(studyPlanPayload(Number(payload.chat_id), delivery, vaultId)), "unowned plan message");
}
export function activeStudyPlanEntry(s: ServerState, id: string, now: number): StudyPlanEntry | undefined {
  const plan = s.studyPlan;
  if (!plan?.enabled || s.domain.revoked || now < plan.generatedAt || now >= plan.expiresAt
    || !s.domain.snapshot || !companionSnapshotIsCurrent(s.domain.snapshot, now)) return;
  const entry = plan.entries.find(row => row.id === id);
  if (!entry || (entry.materialIds.length ? !entry.materialIds.every(materialId => s.materialConsentIds?.includes(materialId)) : !s.materialConsentIds?.length)) return;
  return entry;
}
export function planNotificationsAllowed(s: ServerState, now: number, timeZone: string): boolean {
  return s.domain.reminders.enabled && now >= s.mutedUntil && now >= s.domain.reminders.mutedUntil
    && s.domain.reminders.skippedDay !== studyDay(now, timeZone);
}
