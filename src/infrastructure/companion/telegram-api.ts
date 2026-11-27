import { timingSafeEqual } from "node:crypto";
import { invalid, record } from "../../domain/companion/protocol";
import { groupCompanionButtons, validateCompanionSpoilers, type CompanionMessage } from "../../features/companion/presentation";
import { validNativePollId } from "../../features/companion/native-poll";
export interface TelegramHttp {
  (url: string, options: { method: "POST"; headers: Record<string, string>; body: string | FormData; signal: AbortSignal }): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}
export interface TelegramSenderConfig {
  enabled?: boolean; token?: string; privateChatId: number;
  /** Persist principal/epoch-bound, unguessable <=64-byte callback handles BEFORE sending. */
  bindAction(action: Record<string, string | number | boolean>): Promise<string>;
  http?: TelegramHttp;
}
/** Optional Bot API outbound adapter. No default fetch, env lookup, polling, signup or activation. */
export class TelegramSender {
  constructor(private readonly config: TelegramSenderConfig) {}
  async send(message: CompanionMessage): Promise<number> {
    invalid(this.config.enabled === true && this.config.http && this.config.token, "Telegram transport disabled");
    invalid(Number.isSafeInteger(this.config.privateChatId) && this.config.privateChatId > 0, "private chat required");
    invalid(/^\d+:[A-Za-z0-9_-]+$/.test(this.config.token), "invalid bot token");
    invalid(message.text.length > 0 && message.text.length <= 4096 && message.buttons.length <= 100, "invalid Telegram message size");
    invalid(message.answerAction === undefined, "exact answers require the durable server reply binding");
    if (message.entities !== undefined) validateCompanionSpoilers(message.text, message.entities);
    const prepared: { text: string; callback_data: string; row?: number; style?: "primary" }[] = [];
    try {
      for (const button of message.buttons) {
        const handle = await this.config.bindAction(button.action);
        invalid(/^[a-zA-Z0-9_-]{1,64}$/.test(handle), "invalid callback handle");
        prepared.push({ text: button.text, callback_data: handle, ...(button.row === undefined ? {} : { row: button.row }), ...(button.style ? { style: button.style } : {}) });
      }
    } catch { throw new Error("Telegram callback preparation failed; message not sent"); }
    const keyboard = groupCompanionButtons(prepared, button => ({ text: button.text, callback_data: button.callback_data, ...(button.style ? { style: button.style } : {}) }));
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.config.http(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ chat_id: this.config.privateChatId, text: message.text, ...(message.entities === undefined ? {} : { entities: message.entities }), disable_notification: message.disableNotification ?? false,
          link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } })
      });
      const parsed = request.then(async response => { invalid(response.ok); return response.json(); });
      const value = await Promise.race([parsed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 10000);
      })]);
      record(value); invalid(value.ok === true); record(value.result);
      invalid(Number.isSafeInteger(value.result.message_id) && Number(value.result.message_id) > 0); return value.result.message_id as number;
    } catch {
      // Never surface token-bearing URLs, request bodies, remote error messages or learned content.
      throw new Error("Telegram delivery unconfirmed; inspect delivery before retrying");
    } finally { if (timer) clearTimeout(timer); }
  }
}
/** Gate for a future HTTPS webhook host. A chat ID alone is NOT authentication.
 * Host must obtain the header from the actual TLS request, never from JSON input. */
export function verifyPrivateTelegramUpdate(raw: string, secretHeader: string, config: {
  enabled?: boolean; webhookSecret: string; userId: number; chatId: number;
}): { updateId: number; text?: string; replyToMessageId?: number; callbackId?: string; handle?: string; pollId?: string; optionIds?: number[] } {
  invalid(config.enabled === true, "Telegram transport disabled");
  invalid(raw.length <= 65536 && secretHeader.length <= 256 && config.webhookSecret.length >= 32, "unauthorized Telegram update");
  const supplied = Buffer.from(secretHeader), expected = Buffer.from(config.webhookSecret);
  invalid(supplied.length === expected.length && timingSafeEqual(supplied, expected), "unauthorized Telegram update");
  const update: unknown = JSON.parse(raw); record(update); invalid(Number.isSafeInteger(update.update_id) && Number(update.update_id) >= 0);
  invalid([update.message, update.callback_query, update.poll_answer].filter(value => value !== undefined).length === 1, "ambiguous Telegram update");
  if (update.poll_answer !== undefined) {
    const answer = update.poll_answer; record(answer); record(answer.user);
    invalid(answer.voter_chat === undefined && Number.isSafeInteger(answer.user.id) && Number(answer.user.id) > 0
      && answer.user.id === config.userId && answer.user.is_bot !== true, "unauthorized Telegram principal");
    invalid(validNativePollId(answer.poll_id) && Array.isArray(answer.option_ids) && answer.option_ids.length <= 12
      && Array.from(answer.option_ids).every(option => Number.isSafeInteger(option) && Number(option) >= 0 && Number(option) < 12)
      && new Set(answer.option_ids).size === answer.option_ids.length, "invalid Telegram poll answer");
    return { updateId: update.update_id as number, pollId: answer.poll_id as string, optionIds: [...answer.option_ids as number[]].sort((a, b) => a - b) };
  }
  let callback: Record<string, unknown> | undefined;
  if (update.callback_query !== undefined) { record(update.callback_query); callback = update.callback_query; }
  const message = callback ? callback.message : update.message;
  record(message); record(message.chat); const from = callback ? callback.from : message.from; record(from);
  invalid(message.chat.type === "private" && message.chat.id === config.chatId && from.id === config.userId && from.is_bot !== true, "unauthorized Telegram principal");
  if (callback) {
    invalid(typeof callback.id === "string" && callback.id.length <= 128 && typeof callback.data === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(callback.data));
    return { updateId: update.update_id as number, callbackId: callback.id, handle: callback.data };
  }
  invalid(typeof message.text === "string" && message.text.length <= 4096);
  let replyToMessageId: number | undefined;
  if (message.reply_to_message !== undefined) {
    record(message.reply_to_message); invalid(Number.isSafeInteger(message.reply_to_message.message_id) && Number(message.reply_to_message.message_id) > 0);
    replyToMessageId = message.reply_to_message.message_id as number;
  }
  return { updateId: update.update_id as number, text: message.text, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) };
}
