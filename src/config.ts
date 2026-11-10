import { type } from "arktype";

export const maxMediaBytes = 2_000_000_000;

const telegramSchema = type({
  TG_API_ID: "string.numeric.parse",
  TG_API_HASH: "/^[0-9a-f]{32}$/",
  OWNER_ID: "string.numeric.parse",
  SESSION_PATH: "string > 0",
});

const appSchema = telegramSchema.and({
  BOT_TOKEN: "/^[0-9]+:[A-Za-z0-9_-]+$/",
  WEBHOOK_SECRET: "/^[A-Za-z0-9_-]{32,256}$/",
  WEBHOOK_URL: "string.url",
  REDIS_URL: "string.url",
  TIME_ZONE: "string > 0",
  "LISTEN_HOST?": "string > 0",
  "LISTEN_PORT?": type("string.integer.parse").to("1 <= number <= 65535"),
  "WEB_COOKIES_PATH?": "string",
});

export type TelegramConfig = typeof telegramSchema.infer;
export type Config = typeof appSchema.infer;

export function telegramConfig(env = Bun.env): TelegramConfig {
  return telegramSchema.assert(env);
}

export function appConfig(env = Bun.env): Config {
  const config = appSchema.assert(env);
  if (new URL(config.WEBHOOK_URL).protocol !== "https:") {
    throw new Error("webhook url must use https");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: config.TIME_ZONE });
  return config;
}
