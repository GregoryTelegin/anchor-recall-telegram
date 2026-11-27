import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_COMPANION_BRIDGE_BYTES, invalid, keys, record } from "../../../domain/companion/protocol";
import type { SharedCompanionGateway } from "./shared-runtime";
import { miniAppHtml, miniAppClientScript } from "../../../ui/companion/miniapp-page";
import { miniAppCss } from "../../../styles/features/companion/miniapp-style";
import { COMPANION_MEDIA_BINARY_CONTENT_TYPE, MAX_COMPANION_MEDIA_FRAME_BYTES, decodeCompanionMediaFrame } from "../media-binary";
import { sendCompanionText } from "./http-content";

function mediaType(asset: { kind: string; format: string }): string {
  const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav", mp4: "video/mp4", m4v: "video/mp4", webm: asset.kind === "audio" ? "audio/webm" : "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska" };
  invalid(mime[asset.format], "media unavailable"); return mime[asset.format];
}

async function readBody(request: IncomingMessage, limit: number, allowBinary = false): Promise<string> {
  const binary = request.headers["content-type"] === COMPANION_MEDIA_BINARY_CONTENT_TYPE;
  invalid(binary ? allowBinary && request.rawHeaders.filter((key, index) => index % 2 === 0 && key.toLowerCase() === "content-type").length === 1
    : request.headers["content-type"] === "application/json");
  invalid(request.headers["content-encoding"] === undefined);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; invalid(size <= (binary ? MAX_COMPANION_MEDIA_FRAME_BYTES : limit), "request too large"); chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks); return binary ? decodeCompanionMediaFrame(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Public pairing carries no operator secret; tenant authentication remains in the gateway. */
export function sharedCompanionHandler(gateway: SharedCompanionGateway, now = Date.now) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
    if (request.url === "/bridge/snapshot") response.setTimeout?.(120000);
    response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (request.url?.startsWith("/miniapp")) {
        invalid(gateway.config.miniAppUrl, "Mini App unavailable");
        const mediaGet = request.method === "GET" && /^\/miniapp\/media\/[a-f0-9]{64}$/.test(request.url);
        if (request.method === "GET" && !mediaGet) {
          const page = request.url === "/miniapp/" || request.url.length === "/miniapp/?plan=".length + 64 && /^\/miniapp\/\?plan=[a-f0-9]{64}$/.test(request.url) ? { type: "text/html", body: miniAppHtml }
            : request.url === "/miniapp/app.js" ? { type: "text/javascript", body: miniAppClientScript }
            : request.url === "/miniapp/app.css" ? { type: "text/css", body: miniAppCss } : undefined;
          invalid(page);
          response.setHeader("Content-Type", page.type + "; charset=utf-8");
          response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org https://telegram.org https://t.me https://*.t.me");
          response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
          await sendCompanionText(request, response, page.body); return;
        }
        invalid(mediaGet || request.method === "POST" && ["/miniapp/auth", "/miniapp/study", "/miniapp/media", "/miniapp/vault"].includes(request.url));
        invalid(mediaGet && request.headers.origin === undefined && request.rawHeaders.every((v, i) => i % 2 !== 0 || v.toLowerCase() !== "origin") || request.headers.origin === new URL(gateway.config.miniAppUrl).origin
          && request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "origin").length === 1);
        invalid(request.headers["sec-fetch-site"] === undefined || ["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])));
        if (mediaGet) {
          invalid(request.headers["content-encoding"] === undefined && request.headers["transfer-encoding"] === undefined
            && (request.headers["content-length"] === undefined || request.headers["content-length"] === "0"));
          for await (const chunk of request) invalid(Buffer.from(chunk as Uint8Array).length === 0);
        }
        const bodyLimit = request.url === "/miniapp/study" ? 128000 : request.url === "/miniapp/auth" ? 16384 : 1024;
        const payload: unknown = mediaGet ? { id: request.url.slice("/miniapp/media/".length) }
          : JSON.parse(await readBody(request, bodyLimit));
        if (request.url === "/miniapp/auth") {
          try { response.end(JSON.stringify(await gateway.miniAppAuthenticate(payload, now()))); }
          catch { response.statusCode = 401; response.end('{"error":"unauthorized"}'); }
          return;
        }
        const authorization = request.headers.authorization;
        invalid(typeof authorization === "string" && /^Bearer [a-f0-9]{64}$/.test(authorization)
          && request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "authorization").length === 1, "Mini App unauthorized");
        const sessionToken = authorization.slice(7);
        if (request.url === "/miniapp/study") await sendCompanionText(request, response, JSON.stringify(await gateway.miniAppStudy(sessionToken, payload, now())));
        else if (request.url === "/miniapp/vault") response.end(JSON.stringify(await gateway.miniAppSwitchVault(sessionToken, payload, now())));
        else {
          record(payload); keys(payload, ["id"]); invalid(typeof payload.id === "string" && /^[a-f0-9]{64}$/.test(payload.id));
          const loaded = await gateway.miniAppMedia(sessionToken, payload.id, now());
          const type = mediaType(loaded.asset), etag = `"${payload.id}"`;
          response.setHeader("Content-Type", type); response.setHeader("ETag", etag);
          if (mediaGet) response.setHeader("Vary", "Authorization");
          if (mediaGet && request.headers["if-none-match"] !== undefined) {
            invalid(typeof request.headers["if-none-match"] === "string" && /^"[a-f0-9]{64}"$/.test(request.headers["if-none-match"])
              && request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "if-none-match").length === 1);
            // Authorization and immutable content integrity are checked even when the device has a cached copy.
            if (request.headers["if-none-match"] === etag) { response.statusCode = 304; response.end(); return; }
          }
          response.setHeader("Content-Length", loaded.bytes.byteLength);
          response.end(loaded.bytes);
        }
        return;
      }
      invalid(request.method === "POST"); let result: unknown;
      if (["/pair/start", "/pair/status", "/pair/confirm"].includes(request.url ?? "")) {
        const payload: unknown = JSON.parse(await readBody(request, 16384));
        result = request.url === "/pair/start" ? await gateway.pairStart(payload, now())
          : request.url === "/pair/status" ? await gateway.pairStatus(payload, now()) : await gateway.pairConfirm(payload, now());
      } else {
        invalid(["/bridge/snapshot", "/bridge/pending", "/bridge/ack"].includes(request.url ?? ""));
        const signature = request.headers["x-anchor-signature"];
        invalid(typeof signature === "string" && request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "x-anchor-signature").length === 1);
        result = await gateway.bridge(request.url!, await readBody(request, request.url === "/bridge/snapshot" ? MAX_COMPANION_BRIDGE_BYTES : 512000, request.url === "/bridge/snapshot"),
          signature, now(), request.headers["content-type"] === COMPANION_MEDIA_BINARY_CONTENT_TYPE);
      }
      response.statusCode = 200; response.end(JSON.stringify(result));
      void gateway.flush().catch(() => undefined);
    } catch (error) {
      const miniApp = request.url?.startsWith("/miniapp"), message = error instanceof Error ? error.message : "";
      response.statusCode = miniApp && message === "Mini App unauthorized" ? 401 : miniApp && message === "stale Mini App view" ? 409 : 400;
      response.end(JSON.stringify({ error: miniApp ? response.statusCode === 401 ? "unauthorized" : response.statusCode === 409 ? "view-changed" : "request-rejected" : "request rejected" }));
    }
  };
}

/** Construction is inert: only the explicit shared CLI starts listening. */
export function createSharedCompanionHttpServer(gateway: SharedCompanionGateway) {
  const server = createServer(sharedCompanionHandler(gateway));
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 30; server.timeout = 15000;
  return server;
}
