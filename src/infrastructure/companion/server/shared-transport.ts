import type { Outbound, Transport, TransportResult, OwnedDelivery } from "./runtime";
import type { SharedTransport } from "./shared-runtime";
import type { CompanionMediaIdentity } from "../../../domain/companion/media";
import { recordPerformance, type PerformanceObserver } from "./metrics";

const deliveryError = "Telegram delivery unconfirmed";
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });
interface Started { delivery: Promise<TransportResult>; }
/** Pace request starts only; slow HTTP cannot hold the shared start gate. */
export class PacedBotTransport implements SharedTransport {
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private nextGlobal = Number.NEGATIVE_INFINITY;
  private lastClock = Number.NEGATIVE_INFINITY;
  private readonly nextChat = new Map<number, number>();
  constructor(private readonly base: Transport, private readonly clock: () => number = () => performance.now(),
    private readonly wait: (milliseconds: number) => Promise<void> = sleep, private readonly observe?: PerformanceObserver) {}
  ready(): boolean { return this.base.ready?.() !== false; }
  supportsNativePolls(): boolean { return this.base.supportsNativePolls?.() === true; }
  cachedMedia(enrollment: string, asset: CompanionMediaIdentity): boolean { return this.base.cachedMedia?.(enrollment, asset) === true; }
  private authorize(check?: () => boolean | void): void { if (check?.() === false) throw new Error(deliveryError); }
  private time(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.lastClock) throw new Error(deliveryError);
    this.lastClock = now; return now;
  }
  private gate<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.then(() => undefined, () => undefined); return next;
  }
  private async start(method: Outbound["method"], payload: Record<string, unknown>, chat: number | undefined, authorize?: () => boolean | void, owned?: OwnedDelivery): Promise<Started> {
    for (;;) {
      this.authorize(authorize);
      const next = await this.gate(async (): Promise<Started | { delay: number }> => {
        this.authorize(authorize); let now = this.time();
        const chatDelay = chat === undefined ? 0 : (this.nextChat.get(chat) ?? now) - now;
        // Keep a busy chat's wait outside the shared start gate.
        if (chatDelay > 0) return { delay: chatDelay };
        while (this.nextGlobal > now) { await this.wait(Math.ceil(this.nextGlobal - now)); this.authorize(authorize); now = this.time(); }
        this.authorize(authorize);
        this.nextGlobal = now + 50;
        for (const [id, until] of this.nextChat) if (until <= now) this.nextChat.delete(id);
        if (chat !== undefined) this.nextChat.set(chat, now + 1000);
        return { delivery: this.base.call(method, payload, authorize, owned) };
      });
      if ("delivery" in next) return next;
      this.authorize(authorize); await this.wait(Math.ceil(next.delay)); this.authorize(authorize);
    }
  }
  async call(method: Outbound["method"], payload: Record<string, unknown>, authorize?: () => boolean | void, owned?: OwnedDelivery): Promise<TransportResult> {
    const queued = performance.now();
    let counted = false;
    try {
      this.authorize(authorize);
      if (!this.ready() || this.outstanding >= 128 || !["sendMessage", "sendRichMessage", "answerCallbackQuery", "sendPhoto", "sendAudio", "sendVideo", "sendDocument", "editMessageMedia", "editMessageText", "sendPoll", "stopPoll"].includes(method)) throw new Error(deliveryError);
      const captured = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      const chat = method !== "answerCallbackQuery" ? captured.chat_id : undefined;
      if (method !== "answerCallbackQuery" && (!Number.isSafeInteger(chat) || Number(chat) <= 0)) throw new Error(deliveryError);
      this.outstanding++; counted = true;
      const capturedOwner = owned === undefined ? undefined : JSON.parse(JSON.stringify(owned)) as OwnedDelivery;
      const started = await this.start(method, captured, chat as number | undefined, authorize, capturedOwner);
      recordPerformance(this.observe, "transport.wait", performance.now() - queued);
      return await started.delivery;
    } catch { throw new Error(deliveryError); }
    finally { if (counted) this.outstanding--; }
  }
}
