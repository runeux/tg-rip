import { expect, spyOn, test } from "bun:test";
import { Api } from "grammy";
import { TransferStatus } from "../src/progress";

test("progress edits one message, then removes it after delivery", async () => {
  const actions: { method: string; text?: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
      const { text } = await request.json();
      actions.push({ method, text });
      return Response.json({ ok: true, result: true });
    },
  });
  const time = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const api = new Api("123:fixture", { apiRoot: server.url.origin });
    const status = new TransferStatus(api, 101, 202);
    await status.stage("uploading…");
    status.progress("uploading", 30, 100);
    time.mockReturnValue(3_001);
    status.progress("uploading", 45, 100);
    status.progress("uploading", 60, 100);
    await status.finish();
    expect(actions).toEqual([
      { method: "editMessageText", text: "uploading…" },
      { method: "editMessageText", text: "uploading… 45%" },
      { method: "deleteMessage" },
    ]);
  } finally {
    time.mockRestore();
    server.stop(true);
  }
});
