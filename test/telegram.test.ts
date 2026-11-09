import { expect, spyOn, test } from "bun:test";
import {
  Chat,
  Long,
  Message,
  PeersIndex,
  TelegramClient,
  User,
} from "@mtcute/bun";
import { parseTelegramLink } from "../src/links";
import { TelegramSource } from "../src/telegram";

function albumPhoto(id: number, channelId: number) {
  return new Message(
    {
      _: "message",
      id,
      peerId: { _: "peerChannel", channelId },
      date: 0,
      message: "",
      groupedId: Long.ONE,
      media: {
        _: "messageMediaPhoto",
        photo: {
          _: "photo",
          id: Long.fromNumber(id),
          accessHash: Long.ONE,
          fileReference: new Uint8Array(),
          date: 0,
          sizes: [{ _: "photoSize", type: "x", w: 1, h: 1, size: id }],
          dcId: 1,
        },
      },
    },
    new PeersIndex(),
  );
}

test("single links resolve one album item while regular links resolve the album", async () => {
  const chat = new Chat({
    _: "channel",
    id: 2557209455,
    accessHash: Long.ONE,
    title: "fixture",
    photo: { _: "chatPhotoEmpty" },
    date: 0,
  });
  const selected = albumPhoto(5959, chat.raw.id);
  const other = albumPhoto(5958, chat.raw.id);
  const client = TelegramClient.prototype;
  const connect = spyOn(client, "connect").mockResolvedValue(undefined);
  const getMe = spyOn(client, "getMe").mockResolvedValue(
    new User({ _: "user", id: 1 }),
  );
  const getPeer = spyOn(client, "getPeer").mockResolvedValue(chat);
  const getMessages = spyOn(client, "getMessages").mockResolvedValue([
    selected,
  ]);
  const getGroup = spyOn(client, "getMessageGroup").mockResolvedValue([
    selected,
    other,
  ]);
  const source = new TelegramSource({
    TG_API_ID: 1,
    TG_API_HASH: "0".repeat(32),
    OWNER_ID: 1,
    SESSION_PATH: ":memory:",
  });
  try {
    const base = "https://t.me/c/2557209455/5959";
    const single = parseTelegramLink(`${base}?single&thread=5952`);
    const album = parseTelegramLink(`${base}?thread=5952`);
    if (!single || !album) throw new Error("invalid fixture links");

    expect(
      (await source.fromLink(single)).map((item) => item.fileSize),
    ).toEqual([5959]);
    expect(getMessages).toHaveBeenCalledWith(chat.inputPeer, 5959);
    expect(getGroup).not.toHaveBeenCalled();

    expect((await source.fromLink(album)).map((item) => item.fileSize)).toEqual(
      [5958, 5959],
    );
    expect(getGroup).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [connect, getMe, getPeer, getMessages, getGroup]) {
      spy.mockRestore();
    }
    await source.close();
  }
});
