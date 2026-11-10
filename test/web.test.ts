import { expect, mock, test } from "bun:test";
import { Api } from "grammy";
import { copy } from "../src/copy";
import { reportFailure } from "../src/jobs";
import { TransferStatus } from "../src/progress";
import { downloadWebMedia, preferGallery } from "../src/web-download";
import { formatArgs, formatLabel, webChoices } from "../src/web-formats";

test("offers actual video resolutions and labels vertical video by its short edge", () => {
  const choices = webChoices({
    formats: [
      { vcodec: "none", acodec: "opus", ext: "webm" },
      { vcodec: "avc1", acodec: "none", width: 720, height: 1280 },
      { vcodec: "av01", acodec: "none", width: 720, height: 1280 },
      { vcodec: "avc1", acodec: "aac", width: 360, height: 640 },
      { vcodec: "none", acodec: "none", ext: "mhtml", width: 1, height: 1 },
    ],
  });
  expect(choices.map(formatLabel)).toEqual([
    "mp3",
    "mp4 · best",
    "mp4 · 720p",
    "mp4 · 360p",
  ]);
  expect(formatArgs(choices[2])[1]).toBe(
    "bv*[width=720][height=1280]+ba/b[width=720][height=1280]/bv[width=720][height=1280]",
  );
});

test("audio-only sources have one option and use the highest-quality MP3 encoding", () => {
  const choices = webChoices({
    formats: [
      { vcodec: "none", acodec: "mp3", ext: "mp3" },
      { vcodec: "none", acodec: "opus", ext: "webm" },
    ],
  });
  expect(choices).toEqual([{ format: "mp3" }]);
  expect(formatArgs(choices[0]).slice(-4)).toEqual([
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
  ]);
});

test("routes photo sets and stories through gallery-dl", () => {
  for (const url of [
    "https://www.tiktok.com/@user/photo/123",
    "https://www.instagram.com/p/abc/",
    "https://www.instagram.com/share/p/abc/",
    "https://www.instagram.com/stories/user/123/",
  ])
    expect(preferGallery(new URL(url))).toBe(true);

  expect(preferGallery(new URL("https://www.instagram.com/reel/abc/"))).toBe(
    false,
  );
});

test("reports the Instagram session requirement before running a downloader", async () => {
  const send = mock(async () => {});
  await expect(
    downloadWebMedia(
      "https://www.instagram.com/stories/user/123/",
      undefined,
      undefined,
      async () => {},
      send,
    ),
  ).rejects.toThrow(copy.webSignIn);
  expect(send).not.toHaveBeenCalled();
});

test("unsupported links become temporary native hyperlinks", async () => {
  const api = new Api("123:fixture");
  const edit = mock(async () => true as const);
  api.editMessageText = edit;
  const expire = mock(async () => {});

  await reportFailure(
    new TransferStatus(api, 42, 50),
    expire,
    { kind: "web", chat: 42, key: "1", url: "https://example.com/?a=1&b=2" },
    copy.unsupported,
  );
  expect(edit).toHaveBeenCalledWith(
    42,
    50,
    '<a href="https://example.com/?a=1&amp;b=2">link</a> is not supported',
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
  expect(expire).toHaveBeenCalledWith(42, 50);
});
