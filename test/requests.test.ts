import { expect, mock, test } from "bun:test";
import { Api } from "grammy";
import Redis from "ioredis";
import { copy } from "../src/copy";
import { reportFailure } from "../src/jobs";
import { parseTelegramLink } from "../src/links";
import { Picker } from "../src/picker";
import { TransferStatus } from "../src/progress";

test("a link timeout edits the status into an expiring hyperlink", async () => {
  const link = parseTelegramLink(
    "https://t.me/c/1234567890/50?thread=48&single",
  );
  if (!link) throw new Error("invalid fixture link");

  const api = new Api("123:fixture");
  const edit = mock(async () => true as const);
  api.editMessageText = edit;
  const expire = mock(async () => {});
  await reportFailure(
    new TransferStatus(api, 42, 50),
    expire,
    { kind: "link", chat: 42, message: 49, link },
    copy.downloadTimeout,
  );

  expect(edit).toHaveBeenCalledWith(
    42,
    50,
    '<a href="https://t.me/c/1234567890/50?thread=48&amp;single">media</a> download timed out',
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
  expect(expire).toHaveBeenCalledWith(42, 50);
});

test("all picker pages include the submitted chat id", () => {
  const redis = new Redis({ lazyConnect: true });
  try {
    const picker = new Picker(redis, "UTC");
    const data = {
      chat: 1234567890,
      name: "sample <chat>",
      items: Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        date: 0,
      })),
    };

    for (const page of [0, 1]) {
      const view = picker.render("42", data, page);
      expect(view.text).toBe(
        '<code>1234567890</code>\n\n<b>found chat "sample &lt;chat&gt;"</b> – 11 media available',
      );
      expect(view.options.parse_mode).toBe("HTML");
    }
  } finally {
    redis.disconnect();
  }
});
