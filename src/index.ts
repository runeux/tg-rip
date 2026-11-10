import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { webhookCallback } from "grammy";
import Redis from "ioredis";
import { createBot } from "./bot";
import { messageCleanup } from "./cleanup";
import { appConfig } from "./config";
import { BotUploader } from "./delivery";
import { taskQueue, worker } from "./jobs";
import { Picker } from "./picker";
import { TelegramSource } from "./telegram";
import { WebPicker } from "./web-picker";

const config = appConfig();
process.umask(0o077);
await mkdir(dirname(config.SESSION_PATH), { recursive: true, mode: 0o700 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const workerRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = taskQueue(redis);
const source = new TelegramSource(config);
const uploader = new BotUploader(config);
const picker = new Picker(redis, config.TIME_ZONE);
const webPicker = new WebPicker(redis);
const bot = createBot(config, redis, queue, picker, webPicker, expireMessage);
const cleanup = messageCleanup(redis, workerRedis, bot.api);
function expireMessage(chat: number, message: number) {
  return cleanup.expire(chat, message);
}
await bot.init();

const jobs = worker(
  workerRedis,
  bot.api,
  source,
  picker,
  uploader,
  expireMessage,
  { picker: webPicker, cookies: config.WEB_COOKIES_PATH },
);
jobs.on("error", (error) => console.error("worker error", error.name));
jobs.on("failed", (_job, error) =>
  console.error("job delivery error", error.name),
);
await Promise.all([jobs.waitUntilReady(), cleanup.worker.waitUntilReady()]);

const path = new URL(config.WEBHOOK_URL).pathname;
const expected = Buffer.from(config.WEBHOOK_SECRET);
const webhook = webhookCallback(bot, "bun", { timeoutMilliseconds: 10_000 });
let lastUpdate: Promise<unknown> = Promise.resolve();
const server = Bun.serve({
  hostname: config.LISTEN_HOST ?? "0.0.0.0",
  port: config.LISTEN_PORT ?? 8080,
  maxRequestBodySize: 1024 * 1024,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz" && request.method === "GET") {
      return redis.ping().then(
        () => new Response("ok"),
        () => new Response("unavailable", { status: 503 }),
      );
    }
    if (request.method !== "POST" || pathname !== path)
      return new Response(null, { status: 404 });
    const actual = Buffer.from(
      request.headers.get("x-telegram-bot-api-secret-token") ?? "",
    );
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return new Response(null, { status: 401 });
    }
    const update = lastUpdate
      .then(() => webhook(request))
      .catch((error: unknown) => {
        console.error(
          "webhook error",
          error instanceof Error ? error.name : "unknown",
        );
        return new Response(null, { status: 500 });
      });
    lastUpdate = update;
    return update;
  },
});

try {
  await bot.api.setWebhook(config.WEBHOOK_URL, {
    secret_token: config.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    max_connections: 1,
  });
  console.log("webhook ready");
} catch (error) {
  server.stop(true);
  throw error;
}

async function shutdown() {
  server.stop();
  await jobs.close();
  await Promise.all([
    queue.close(),
    cleanup.worker.close(),
    cleanup.queue.close(),
  ]);
  await Promise.all([source.close(), uploader.close()]);
  redis.disconnect();
  workerRedis.disconnect();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      console.error("shutdown failed");
      process.exitCode = 1;
    });
  });
}
