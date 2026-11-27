import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { invalid } from "../../../domain/companion/protocol";
import { SharedCompanionGateway, validateSharedConfig, type SharedCompanionConfig } from "./shared-runtime";
import { createSharedCompanionHttpServer } from "./http-shared";
import { TelegramLongPoller } from "./polling";
import { BotTransport } from "./transport";
import { PacedBotTransport } from "./shared-transport";
import { CompanionMediaRoot } from "./media-store";
import { TelegramMediaFileCache } from "./telegram-media-cache";
import { CompanionPerformance } from "./metrics";

const usage = "Anchor Recall shared Telegram companion (Node >=24)\nUse --config /private/config.json to start, or --check --config /private/config.json for offline validation.\nWithout arguments or with --help, no listener, state or Telegram request is started.\n";

async function readConfig(path: string): Promise<SharedCompanionConfig> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(); invalid(info.isFile() && info.size <= 16384 && (info.mode & 0o077) === 0, "private config required");
    const raw = await file.readFile("utf8"); invalid(Buffer.byteLength(raw) <= 16384);
    const value: unknown = JSON.parse(raw); validateSharedConfig(value); return value;
  } finally { await file.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === "--help") { process.stdout.write(usage); return; }
  const check = args.includes("--check"), rest = args.filter(arg => arg !== "--check");
  invalid(args.filter(arg => arg === "--check").length <= 1 && rest.length === 2 && rest[0] === "--config" && rest[1] && !rest[1].startsWith("--"));
  invalid(Number(process.versions.node.split(".")[0]) >= 24, "Node >=24 required");
  const config = await readConfig(rest[1]);
  if (check) { process.stdout.write("Configuration valid. No state, listener or Telegram request was started.\n"); return; }
  const mediaRoot = new CompanionMediaRoot(config.stateDirectory);
  const metrics = new CompanionPerformance(), observe = metrics.observe;
  const mediaCache = await TelegramMediaFileCache.open(config.stateDirectory, { botToken: config.botToken, observe });
  const transport = new PacedBotTransport(new BotTransport({ enabled: true, token: config.botToken, http: fetch, mediaCache, observe, loadMedia: (enrollment, id) => mediaRoot.read(enrollment, id) }), undefined, undefined, observe);
  const gateway = new SharedCompanionGateway(config, transport, { mediaRoot, observe }), http = createSharedCompanionHttpServer(gateway);
  const poller = new TelegramLongPoller(config.botToken, gateway, fetch), abort = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined, metricsTimer: ReturnType<typeof setInterval> | undefined, pollLoop: Promise<void> | undefined;
  const reportPerformance = (): void => {
    const measurements = metrics.snapshot(true);
    if (Object.keys(measurements).length) process.stdout.write(JSON.stringify({ event: "companion.performance", measurements }) + "\n");
  };
  let ticking = Promise.resolve(), tickBusy = false, startup = Promise.resolve(), stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    abort.abort(); if (timer) clearInterval(timer); if (metricsTimer) clearInterval(metricsTimer);
    await startup.catch(() => undefined);
    if (http.listening) await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeIdleConnections(); });
    await Promise.all([pollLoop?.catch(() => undefined), ticking.catch(() => undefined)]);
    try { await gateway.drain(); } finally { await gateway.close(); reportPerformance(); }
  })();
  const fail = (): void => {
    process.exitCode = 1; process.stderr.write("Companion stopped. Inspect the private state before restarting; sensitive details were withheld.\n");
    void stop().catch(() => { process.exitCode = 1; });
  };
  const onSignal = (): void => { void stop().catch(fail); };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  http.on("error", fail);
  startup = (async () => {
    await gateway.start(); if (abort.signal.aborted) return;
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(config.port ?? 8787, config.host ?? "127.0.0.1", resolve); });
  })();
  try {
    await startup; if (abort.signal.aborted) return;
    pollLoop = poller.run(abort.signal); void pollLoop.catch(fail);
    timer = setInterval(() => {
      if (tickBusy || abort.signal.aborted) return; tickBusy = true;
      ticking = gateway.tick(Date.now()).then(() => gateway.flush()).catch(fail).finally(() => { tickBusy = false; });
    }, 30000);
    metricsTimer = setInterval(reportPerformance, 60000);
    process.stdout.write("Shared companion started. Telegram polling and the plugin HTTPS bridge require the configured network access.\n");
  } catch { await stop(); throw new Error("startup failed"); }
}

void main().catch(() => { process.stderr.write("Companion refused to start: invalid arguments/configuration or unavailable private state/listener.\n"); process.exitCode = 1; });
