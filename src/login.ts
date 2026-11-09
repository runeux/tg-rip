import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeQR } from "qr";
import { telegramConfig } from "./config";
import { userClient } from "./telegram";

const config = telegramConfig();
process.umask(0o077);
await mkdir(dirname(config.SESSION_PATH), { recursive: true, mode: 0o700 });
const client = userClient(config);
try {
  const user = await client.start({
    qrCodeHandler(url) {
      console.clear();
      console.log("telegram → settings → devices → link desktop device");
      console.log(encodeQR(url, "ascii"));
    },
  });
  if (user.id !== config.OWNER_ID || user.isBot) {
    await client.logOut();
    throw new Error("sign in with the owner account");
  }
  console.log("telegram connected");
} finally {
  await client.destroy();
}
