import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { encodeQR } from "qr";
import { type TelegramConfig, telegramConfig } from "./config";
import { userClient } from "./telegram";

async function readPassword() {
  const terminal = createInterface({
    input: process.stdin,
    output: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    terminal: true,
  });
  const input = new AbortController();
  terminal.once("close", () => input.abort());
  process.stdout.write("telegram 2fa password: ");
  try {
    return await terminal.question("", { signal: input.signal });
  } finally {
    terminal.close();
    process.stdout.write("\n");
  }
}

export async function login(config: TelegramConfig, imageMode: boolean) {
  await mkdir(dirname(config.SESSION_PATH), { recursive: true, mode: 0o700 });
  const client = userClient(config);
  const imageDirectory = imageMode
    ? await mkdtemp(join(tmpdir(), "tg-rip-qr-"))
    : undefined;

  try {
    const user = await client.start({
      qrCodeHandler(url, expires) {
        if (imageDirectory) {
          const image = join(imageDirectory, "telegram-qr.gif");
          const pending = `${image}.tmp`;
          writeFileSync(pending, encodeQR(url, "gif", { scale: 8 }), {
            mode: 0o600,
          });
          renameSync(pending, image);
          console.log(
            `telegram login qr: ${image} (expires ${expires.toISOString()})`,
          );
          return;
        }

        console.clear();
        console.log("telegram → settings → devices → link desktop device");
        console.log(encodeQR(url, "ascii"));
      },
      password: readPassword,
      invalidCodeCallback: () => console.log("invalid password, try again"),
    });
    if (user.id !== config.OWNER_ID || user.isBot) {
      await client.logOut();
      throw new Error("sign in with the owner account");
    }
  } finally {
    try {
      await client.destroy();
    } finally {
      if (imageDirectory)
        await rm(imageDirectory, { recursive: true, force: true });
    }
  }

  console.log(`telegram connected · session saved to ${config.SESSION_PATH}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "qr-image": { type: "boolean" } },
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("telegram login requires an interactive terminal");
  }
  process.umask(0o077);
  await login(telegramConfig(), values["qr-image"] ?? false);
}
