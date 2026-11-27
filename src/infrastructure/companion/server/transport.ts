import { createHash } from "node:crypto";
import { invalid, keys, record } from "../../../domain/companion/protocol";
import { validateCompanionMediaIdentity, type CompanionMediaIdentity } from "../../../domain/companion/media";
import type { TelegramHttp } from "../telegram-api";
import { validateGradePanelEdit, validateHintPanelEdit, validateQuestionPanelEdit, validateSessionPanelEdit } from "../../../features/companion/presentation";
import { validateNativePollPayload, validNativePollId, type NativePollPayload } from "../../../features/companion/native-poll";
import { validateRichCheckboxDemoPayload } from "../../../features/companion/rich-checkbox-demo";
import { isMediaMethod, mediaMethod, MEDIA_LOADING_ERROR, GRADE_SAVED_NOTICE, type Transport, type TransportResult, type Outbound, type OwnedDelivery } from "./runtime";
import { miniAppLaunchUrl, validateReminderMiniAppPayload, validateStudyPlanPayload } from "./study-plan-reminders";
import { TelegramMediaFileCache, validTelegramFileId, type TelegramMediaMethod } from "./telegram-media-cache";
import { recordPerformance, type PerformanceObserver } from "./metrics";

function staleFileResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return response.ok === false && response.error_code === 400 && typeof response.description === "string"
    && /^(?:Bad Request: )?(?:wrong file identifier\/HTTP URL specified$|wrong remote file identifier specified(?:$|:)|file reference (?:expired|invalid)$|FILE_REFERENCE_(?:EXPIRED|INVALID)$)/i.test(response.description);
}
function returnedFileId(result: Record<string, unknown>, method: TelegramMediaMethod): string | undefined {
  let file: unknown = result[method.slice(4).toLowerCase()];
  if (method === "sendPhoto") file = Array.isArray(file) ? file[file.length - 1] : undefined;
  const id = file && typeof file === "object" ? (file as Record<string, unknown>).file_id : undefined;
  return validTelegramFileId(id) ? id : undefined;
}
/** Inert unless both operator opt-in and injected HTTP implementation are supplied. */
export class BotTransport implements Transport {
  constructor(private readonly options: { enabled?: boolean; token?: string; http?: TelegramHttp;
    loadMedia?(enrollment: string, id: string): Promise<{ asset: CompanionMediaIdentity; bytes: Uint8Array }>;
    mediaCache?: TelegramMediaFileCache; observe?: PerformanceObserver;
  }) {}
  ready(): boolean { return this.options.enabled === true && !!this.options.http && !!this.options.token; }
  supportsNativePolls(): boolean { return this.ready(); }
  cachedMedia(enrollment: string, asset: CompanionMediaIdentity): boolean {
    try { return this.ready() && this.options.mediaCache?.matchesBot(this.options.token!) === true && this.options.mediaCache.has(enrollment, asset, mediaMethod(asset) as TelegramMediaMethod); }
    catch { return false; }
  }
  async call(method: Outbound["method"], payload: Record<string, unknown>, authorize?: () => boolean | void, owned?: OwnedDelivery): Promise<TransportResult> {
    invalid(this.options.enabled === true && this.options.http && this.options.token && /^\d+:[A-Za-z0-9_-]+$/.test(this.options.token), "transport disabled");
    invalid(["sendMessage", "sendRichMessage", "answerCallbackQuery", "sendPhoto", "sendAudio", "sendVideo", "sendDocument", "editMessageMedia", "editMessageText", "sendPoll", "stopPoll"].includes(method));
    try {
      invalid(authorize?.() !== false, "delivery revoked");
      const keyboard = (payload.reply_markup as { inline_keyboard?: Record<string, unknown>[][] } | undefined)?.inline_keyboard;
      const webApps = Array.isArray(keyboard) ? keyboard.flatMap(row => Array.isArray(row) ? row.filter(button => button && button.web_app !== undefined) : []) : [];
      if (owned && "studyPlan" in owned) { invalid(method === "sendMessage"); validateStudyPlanPayload(payload, owned.studyPlan, owned.vaultId); }
      else if (webApps.length) {
        invalid(method === "sendMessage" && owned && "miniAppUrl" in owned && webApps.length === 1);
        if (keyboard?.length === 5) validateReminderMiniAppPayload(payload, owned.miniAppUrl, owned.vaultId);
        else {
          invalid(keyboard?.length === 1 && keyboard[0].length === 1);
          const button = webApps[0]; keys(button, ["text", "web_app"]); record(button.web_app); keys(button.web_app, ["url"]);
          invalid(owned.planId === undefined || typeof owned.planId === "string" && /^[a-f0-9]{64}$/.test(owned.planId));
          invalid(button.text === "Открыть занятие" && button.web_app.url === miniAppLaunchUrl(owned.miniAppUrl, owned.planId, owned.vaultId));
        }
      }
      invalid(payload.gradeAnswer === undefined || method === "editMessageText");
      invalid(payload.pollId === undefined || method === "stopPoll");
      invalid(payload.rich_message === undefined || method === "sendRichMessage" || method === "editMessageText");
      let body: string | FormData = JSON.stringify(payload), headers: Record<string, string> = { "Content-Type": "application/json" };
      const media = isMediaMethod(method), editing = method === "editMessageMedia" || method === "editMessageText";
      let identity: CompanionMediaIdentity | undefined, nativeMethod: TelegramMediaMethod | undefined, cached: string | undefined;
      let pollRequest: NativePollPayload | undefined;
      const cache = this.options.mediaCache?.matchesBot(this.options.token) ? this.options.mediaCache : undefined;
      if (method === "answerCallbackQuery") {
        keys(payload, ["callback_query_id", "text"]);
        invalid(typeof payload.callback_query_id === "string" && payload.callback_query_id.length > 0 && payload.callback_query_id.length <= 128);
        invalid(payload.text === undefined || payload.text === GRADE_SAVED_NOTICE);
      }
      if (method === "sendPoll") { validateNativePollPayload(payload); pollRequest = payload; }
      if (method === "sendRichMessage") validateRichCheckboxDemoPayload(payload);
      if (method === "stopPoll") {
        keys(payload, ["chat_id", "message_id", "pollId"]);
        invalid(Number.isSafeInteger(payload.chat_id) && Number(payload.chat_id) > 0 && validNativePollId(payload.pollId));
        body = JSON.stringify({ chat_id: payload.chat_id, message_id: payload.message_id });
      }
      if (editing || method === "stopPoll") invalid(Number.isSafeInteger(payload.message_id) && Number(payload.message_id) > 0);
      if (method === "editMessageText" && payload.rich_message !== undefined) validateRichCheckboxDemoPayload(payload, true);
      else if (method === "editMessageText") {
        keys(payload, ["chat_id", "message_id", "text", "link_preview_options", "reply_markup", "gradeAnswer"]);
        invalid(Number.isSafeInteger(payload.chat_id) && Number(payload.chat_id) > 0);
        const question = (payload.reply_markup as { inline_keyboard?: { text?: unknown }[][] } | undefined)?.inline_keyboard;
        if (payload.gradeAnswer !== undefined) validateGradePanelEdit(payload.text, payload.reply_markup, payload.gradeAnswer);
        else if (payload.reply_markup === undefined) invalid(payload.text === MEDIA_LOADING_ERROR);
        else if (Array.isArray(question) && question.some(row => Array.isArray(row) && row.some(button => button?.text === "Пропустить сейчас"))) validateQuestionPanelEdit(payload.text, payload.reply_markup);
        else if (typeof payload.text === "string" && payload.text.startsWith("Занятие · ")) validateSessionPanelEdit(payload.text, payload.reply_markup);
        else if (typeof payload.text === "string" && payload.text.startsWith("Подсказк")) validateHintPanelEdit(payload.text, payload.reply_markup);
        else validateGradePanelEdit(payload.text, payload.reply_markup);
        record(payload.link_preview_options); keys(payload.link_preview_options, ["is_disabled"]); invalid(payload.link_preview_options.is_disabled === true);
        const { gradeAnswer: _privateAnswer, ...publicPayload } = payload; body = JSON.stringify(publicPayload);
      }
      if (media) {
        keys(payload, ["chat_id", "assetId", "kind", "format", "bytes", "side", "caption", "disable_notification", "enrollment", ...(method === "editMessageMedia" ? ["message_id"] : [])]);
        invalid(Number.isSafeInteger(payload.chat_id) && Number(payload.chat_id) > 0 && typeof payload.enrollment === "string" && /^[a-f0-9]{48}$/.test(payload.enrollment));
        const asset = { id: payload.assetId, kind: payload.kind, format: payload.format, bytes: payload.bytes }; validateCompanionMediaIdentity(asset); identity = asset;
        invalid(payload.side === "question" || payload.side === "answer"); invalid(typeof payload.disable_notification === "boolean");
        invalid(payload.caption === undefined || typeof payload.caption === "string" && payload.caption.length <= 500);
        nativeMethod = mediaMethod(identity) as TelegramMediaMethod;
        invalid(method === "editMessageMedia" || method === nativeMethod, "media unavailable");
        cached = cache?.get(payload.enrollment, identity, nativeMethod);
        recordPerformance(this.options.observe, cached ? "media.cache.hit" : "media.cache.miss", 0);
        if (cached) {
          body = JSON.stringify(method === "editMessageMedia"
            ? { chat_id: payload.chat_id, message_id: payload.message_id, media: { type: nativeMethod.slice(4).toLowerCase(), media: cached, ...(typeof payload.caption === "string" ? { caption: payload.caption } : {}) } }
            : { chat_id: payload.chat_id, [nativeMethod.slice(4).toLowerCase()]: cached, disable_notification: payload.disable_notification, ...(typeof payload.caption === "string" ? { caption: payload.caption } : {}) });
        } else { body = await this.multipart(method, payload, identity, nativeMethod); headers = {}; }
      }
      let response = await this.request(method, body, headers, media, authorize);
      if (cached && identity && nativeMethod && cache && staleFileResponse(response)) {
        recordPerformance(this.options.observe, "media.cache.invalid", 0);
        await cache.invalidate(payload.enrollment as string, identity, nativeMethod);
        invalid(authorize?.() !== false, "delivery revoked");
        body = await this.multipart(method, payload, identity, nativeMethod);
        response = await this.request(method, body, {}, true, authorize);
      }
      record(response); invalid(response.ok === true);
      if (method === "answerCallbackQuery") invalid(response.result === true);
      else if (method === "stopPoll") {
        record(response.result); invalid(response.result.id === payload.pollId && response.result.is_closed === true); return;
      }
      else {
        record(response.result); invalid(Number.isSafeInteger(response.result.message_id) && Number(response.result.message_id) > 0 && (!editing || response.result.message_id === payload.message_id));
        if (method === "sendRichMessage") {
          record(response.result.chat); invalid(response.result.chat.id === payload.chat_id && response.result.chat.type === "private");
        }
        if (method === "sendPoll") {
          invalid(pollRequest); record(response.result.poll); record(response.result.chat);
          const poll = response.result.poll;
          invalid(validNativePollId(poll.id) && response.result.chat.id === pollRequest.chat_id && response.result.chat.type === "private"
            && poll.type === "regular" && poll.is_anonymous === false && poll.is_closed === false && poll.allows_revoting === false
            && poll.allows_multiple_answers === pollRequest.allows_multiple_answers && poll.question === pollRequest.question
            && Array.isArray(poll.options) && poll.options.length === pollRequest.options.length);
          for (let index = 0; index < pollRequest.options.length; index++) { record(poll.options[index]); invalid(poll.options[index].text === pollRequest.options[index].text); }
          return { messageId: response.result.message_id as number, pollId: poll.id };
        }
        const fileId = nativeMethod ? returnedFileId(response.result, nativeMethod) : undefined;
        if (fileId && identity && nativeMethod && cache) await cache.set(payload.enrollment as string, identity, nativeMethod, fileId).catch(() => undefined);
        return response.result.message_id as number;
      }
    } catch { throw new Error("Telegram delivery unconfirmed"); }
  }
  private async multipart(method: Outbound["method"], payload: Record<string, unknown>, identity: CompanionMediaIdentity, nativeMethod: TelegramMediaMethod): Promise<FormData> {
    invalid(this.options.loadMedia, "media unavailable");
    let start = performance.now();
    const loaded = await this.options.loadMedia(payload.enrollment as string, identity.id);
    recordPerformance(this.options.observe, "media.read", performance.now() - start); validateCompanionMediaIdentity(loaded.asset);
    invalid(loaded.asset.id === identity.id && loaded.asset.kind === identity.kind && loaded.asset.format === identity.format && loaded.asset.bytes === identity.bytes && loaded.bytes instanceof Uint8Array && loaded.bytes.byteLength === identity.bytes);
    start = performance.now(); const hash = createHash("sha256").update(loaded.bytes).digest("hex");
    recordPerformance(this.options.observe, "media.hash", performance.now() - start); invalid(hash === identity.id, "media unavailable");
    const type = nativeMethod === "sendPhoto" ? identity.format === "png" ? "image/png" : "image/jpeg" : nativeMethod === "sendAudio" ? identity.format === "mp3" ? "audio/mpeg" : "audio/mp4" : nativeMethod === "sendVideo" ? "video/mp4" : "application/octet-stream";
    const form = new FormData(); form.set("chat_id", String(payload.chat_id));
    if (method === "editMessageMedia") {
      form.set("message_id", String(payload.message_id));
      form.set("media", JSON.stringify({ type: nativeMethod.slice(4).toLowerCase(), media: "attach://asset", ...(typeof payload.caption === "string" ? { caption: payload.caption } : {}) }));
    } else {
      form.set("disable_notification", String(payload.disable_notification)); if (typeof payload.caption === "string") form.set("caption", payload.caption);
    }
    form.set(method === "editMessageMedia" ? "asset" : method.slice(4).toLowerCase(), new Blob([new Uint8Array(loaded.bytes).buffer], { type }), "media." + identity.format);
    return form;
  }
  private async request(method: Outbound["method"], body: string | FormData, headers: Record<string, string>, media: boolean, authorize?: () => boolean | void): Promise<unknown> {
    const controller = new AbortController(), start = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Every asynchronous cache/file boundary must still respect revocation immediately before HTTP.
      invalid(authorize?.() !== false, "delivery revoked"); invalid(this.options.http);
      const request = this.options.http(`https://api.telegram.org/bot${this.options.token}/${method}`, { method: "POST", headers, body, signal: controller.signal });
      return await Promise.race([request.then(async r => {
        const value: unknown = await r.json();
        if (r.ok) { record(value); invalid(value.ok === true); }
        else invalid(r.status === 400 && staleFileResponse(value));
        return value;
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, media ? 60000 : 10000);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      recordPerformance(this.options.observe, "telegram.api", performance.now() - start);
      if (body instanceof FormData) recordPerformance(this.options.observe, "telegram.upload", performance.now() - start);
    }
  }
}
