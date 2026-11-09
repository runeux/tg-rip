import { expect, mock, test } from "bun:test";
import { Long, Photo } from "@mtcute/bun";
import { Api } from "grammy";
import { copy, UserError } from "../src/copy";
import { type BotUploader, deliver } from "../src/delivery";
import { TransferStatus } from "../src/progress";
import type { SourceAttachment } from "../src/telegram";

const sourceUrl = "https://t.me/c/1234567890/50?thread=48";
const attachments: SourceAttachment[] = [50, 51, 52].map((id) => ({
  url: `https://t.me/c/1234567890/${id}?single&thread=48`,
  media: new Photo({
    _: "photo",
    id: Long.fromNumber(id),
    accessHash: Long.ONE,
    fileReference: new Uint8Array(),
    date: 0,
    sizes: [{ _: "photoSize", type: "x", w: 1, h: 1, size: 3 }],
    dcId: 1,
  }),
}));

test("sends the rest of an album with a link to the failed item", async () => {
  const source = {
    async download(path: string, media: SourceAttachment["media"]) {
      if (media === attachments[0].media)
        throw new UserError(copy.downloadTimeout);
      await Bun.write(path, new Uint8Array(3));
    },
  };
  const send = mock<BotUploader["send"]>(async () => {});
  const status = new TransferStatus(new Api("123:fixture"), 42);

  expect(
    await deliver({ send }, source, status, 42, attachments, sourceUrl),
  ).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  const [, files, sizes] = send.mock.calls[0];
  expect(sizes).toEqual([3, 3]);
  expect(files[0].caption).toMatchObject({
    text: "source\n\n1 media download failed",
    entities: expect.arrayContaining([
      expect.objectContaining({ url: sourceUrl }),
      expect.objectContaining({ url: attachments[0].url }),
    ]),
  });
  expect(files[1].caption).toBeUndefined();
});

test("reports each failed item when no album media can be sent", async () => {
  const send = mock<BotUploader["send"]>(async () => {});
  const source = {
    async download() {
      throw new UserError(copy.downloadTimeout);
    },
  };
  const status = new TransferStatus(new Api("123:fixture"), 42);

  await expect(
    deliver({ send }, source, status, 42, attachments, sourceUrl),
  ).rejects.toMatchObject({
    parseMode: "HTML",
    message: expect.stringContaining("3 media downloads failed"),
  });
  expect(send).not.toHaveBeenCalled();
});
