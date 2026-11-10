import { expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { TelegramClient, User } from "@mtcute/bun";
import { login } from "../src/login";

const config = {
  TG_API_ID: 1,
  TG_API_HASH: "0".repeat(32),
  OWNER_ID: 1,
  SESSION_PATH: ":memory:",
};

test("refreshes a private QR image at the same path and removes it after login", async () => {
  let imagePath: string | undefined;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const client = TelegramClient.prototype;
  const destroy = spyOn(client, "destroy").mockResolvedValue(undefined);
  const start = spyOn(client, "start").mockImplementation(async (options) => {
    const qr = options?.qrCodeHandler;
    if (!qr) throw new Error("QR callback missing");
    expect(typeof options.password).toBe("function");
    const expiry = new Date("2026-01-01T00:00:00Z");
    qr("tg://login?token=first", expiry);
    imagePath = /^telegram login qr: (.+) \(expires /.exec(
      String(log.mock.lastCall?.[0]),
    )?.[1];
    if (!imagePath) throw new Error("QR image path missing");
    const first = readFileSync(imagePath);
    expect(first.subarray(0, 3).toString()).toBe("GIF");
    expect(statSync(imagePath).mode & 0o077).toBe(0);
    expect(log.mock.lastCall?.[0]).toContain(expiry.toISOString());

    qr("tg://login?token=second", expiry);
    expect(log.mock.lastCall?.[0]).toContain(imagePath);
    expect(readFileSync(imagePath).equals(first)).toBe(false);
    return new User({ _: "user", id: config.OWNER_ID });
  });
  try {
    await login(config, true);
    expect(imagePath).toBeDefined();
    if (imagePath) expect(await Bun.file(imagePath).exists()).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally {
    start.mockRestore();
    destroy.mockRestore();
    log.mockRestore();
  }
});

test("signs out accounts other than the configured owner", async () => {
  const client = TelegramClient.prototype;
  const start = spyOn(client, "start").mockResolvedValue(
    new User({ _: "user", id: config.OWNER_ID + 1 }),
  );
  const logOut = spyOn(client, "logOut").mockResolvedValue({});
  const destroy = spyOn(client, "destroy").mockResolvedValue(undefined);
  try {
    await expect(login(config, false)).rejects.toThrow(
      "sign in with the owner account",
    );
    expect(logOut).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally {
    start.mockRestore();
    logOut.mockRestore();
    destroy.mockRestore();
  }
});
