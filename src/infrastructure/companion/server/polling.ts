import { invalid, record, timestamp } from "../../../domain/companion/protocol";
import type { TelegramHttp } from "../telegram-api";
import type { SharedCompanionGateway } from "./shared-runtime";

const runningBots = new Set<string>();
export class TelegramPollingConfigurationError extends Error {}
/** Single operator-started poller. It never registers/deletes a webhook or changes a bot. */
export class TelegramLongPoller {
  private running = false;
  constructor(private readonly token: string, private readonly gateway: SharedCompanionGateway, private readonly http: TelegramHttp) {
    invalid(/^\d+:[A-Za-z0-9_-]{20,256}$/.test(token));
  }
  private async call(method: "getUpdates" | "getMe" | "getWebhookInfo", payload: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new Error("Telegram polling stopped");
    const controller = new AbortController(); let rejectPending: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectPending = () => reject(new Error("polling interrupted")); });
    const abort = () => { controller.abort(); rejectPending(); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(abort, 35000);
    try {
      const body = await Promise.race([this.http(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal })
        .then(async response => { const value = await response.json(); record(value); if (value.error_code === 409) throw new TelegramPollingConfigurationError("Another poller or webhook is active; inspect bot configuration"); invalid(response.ok); return value; }), interrupted]);
      record(body); invalid(Buffer.byteLength(JSON.stringify(body)) <= 1_000_000); return body;
    } catch (error) {
      if (error instanceof TelegramPollingConfigurationError) throw error;
      throw new Error("Telegram API request unconfirmed");
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  async pollOnce(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const offset = this.gateway.nextUpdateOffset();
      const body = await this.call("getUpdates", { timeout: 20, limit: 100, allowed_updates: ["message", "callback_query", "poll_answer"], ...(offset === undefined ? {} : { offset }) }, signal);
      invalid(body.ok === true && Array.isArray(body.result) && body.result.length <= 100 && Buffer.byteLength(JSON.stringify(body)) <= 1_000_000, "invalid Telegram polling response");
      let previous = -1;
      for (const update of body.result) { record(update); timestamp(update.update_id); invalid(Number(update.update_id) > previous); previous = Number(update.update_id); }
      for (const update of body.result) {
        if (signal.aborted) return;
        // Offset advances only after a private durable inbox accepts this exact update.
        await this.gateway.telegramUpdate(update, Date.now());
      }
      // Delivery can be slow; a guarded singleton flush must not delay receiving answers.
      void this.gateway.flush().catch(() => undefined);
    } catch (error) {
      if (error instanceof TelegramPollingConfigurationError) throw error;
      if (!signal.aborted) throw new Error("Telegram polling unconfirmed; preserve state and retry");
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    const botId = this.token.split(":")[0]; invalid(!this.running && !runningBots.has(botId), "poller already running"); this.running = true; runningBots.add(botId);
    try {
      if (signal.aborted) return;
      const me = await this.call("getMe", {}, signal); record(me.result);
      if (me.ok !== true || String(me.result.id) !== botId || typeof me.result.username !== "string" || me.result.username.toLowerCase() !== this.gateway.config.botUsername.toLowerCase())
        throw new TelegramPollingConfigurationError("Bot identity does not match operator configuration");
      const webhook = await this.call("getWebhookInfo", {}, signal); record(webhook.result);
      if (webhook.ok !== true || webhook.result.url !== "") throw new TelegramPollingConfigurationError("A webhook is configured; remove it explicitly before long polling");
      while (!signal.aborted) {
        try { await this.pollOnce(signal); }
        catch (error) {
          if (error instanceof TelegramPollingConfigurationError) throw error;
          if (!signal.aborted) await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 5000); signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
          });
        }
      }
    } catch (error) { if (!signal.aborted) throw error; }
    finally { this.running = false; runningBots.delete(botId); }
  }
}
