import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  html,
  type InputMediaAudio,
  type InputMediaDocument,
  type InputMediaPhoto,
  type InputMediaVideo,
  type InputMediaVoice,
  MtTimeoutError,
  TelegramClient,
} from "@mtcute/bun";
import { type Config, maxMediaBytes } from "./config";
import { copy, downloadFailures, sourceCaption, UserError } from "./copy";
import type { TransferStatus } from "./progress";
import type { Attachment, SourceAttachment, TelegramSource } from "./telegram";

type Media =
  | InputMediaPhoto
  | InputMediaVideo
  | InputMediaAudio
  | InputMediaDocument
  | InputMediaVoice;

export class BotUploader {
  readonly #client: TelegramClient;
  #ready = false;

  constructor(private readonly config: Config) {
    this.#client = new TelegramClient({
      apiId: config.TG_API_ID,
      apiHash: config.TG_API_HASH,
      storage: join(dirname(config.SESSION_PATH), "bot-upload.sqlite"),
      disableUpdates: true,
      network: {
        connectionCount: (kind) =>
          kind === "main" ? 0 : kind === "upload" ? 2 : 1,
      },
    });
  }

  async send(
    chat: number,
    files: Media[],
    sizes: number[],
    status: TransferStatus,
  ) {
    if (!this.#ready) {
      const self = await this.#client.start({
        botToken: this.config.BOT_TOKEN,
        abortSignal: AbortSignal.timeout(30_000),
      });
      if (
        !self.isBot ||
        self.id !== Number(this.config.BOT_TOKEN.split(":")[0])
      ) {
        throw new Error("unexpected upload account");
      }
      this.#ready = true;
    }

    const peer = await this.#client.resolvePeer(chat);
    const abortSignal = AbortSignal.timeout(60 * 60_000);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    let sent = 0;
    await status.stage("uploading…");

    try {
      if (files.length === 1) {
        await this.#client.sendMedia(peer, files[0], {
          abortSignal,
          progressCallback: (uploaded) =>
            status.progress("uploading", uploaded, total),
        });
      } else {
        const uploaded = sizes.map(() => 0);
        await this.#client.sendMediaGroup(peer, files, {
          abortSignal,
          progressCallback: (index, bytes) => {
            const next = Math.min(bytes, sizes[index]);
            sent += next - uploaded[index];
            uploaded[index] = next;
            status.progress("uploading", sent, total);
          },
        });
      }
    } catch (error) {
      if (
        error instanceof MtTimeoutError ||
        (error instanceof Error && error.name === "TimeoutError")
      ) {
        throw new UserError(copy.uploadTimeout);
      }
      throw error;
    }
  }

  async close() {
    await this.#client.destroy();
  }
}

function filename(media: Attachment): string {
  if (media.type === "photo") return "photo.jpg";
  const name = media.fileName && basename(media.fileName.replaceAll("\\", "/"));
  if (name && name !== "." && name !== "..")
    return name.replace(/\p{Cc}/gu, "_");
  switch (media.type) {
    case "video":
      return media.isLegacyGif ? "animation.gif" : "video.mp4";
    case "audio":
      return media.mimeType === "audio/mpeg" ? "audio.mp3" : "audio.m4a";
    case "voice":
      return "voice.ogg";
    case "document":
      return "file";
  }
}

function outgoingMedia(media: Attachment, path: string, size: number): Media {
  const base = {
    file: Bun.file(path).stream(),
    fileSize: size,
    fileName: filename(media),
    fileMime: media.type === "photo" ? "image/jpeg" : media.mimeType,
  };
  switch (media.type) {
    case "photo":
      if (size <= 10_000_000) return { ...base, type: "photo" };
      break;
    case "video":
      if (media.mimeType === "video/mp4") {
        return {
          ...base,
          type: "video",
          supportsStreaming: true,
          width: media.width,
          height: media.height,
          duration: media.duration,
        };
      }
      break;
    case "audio":
      if (media.mimeType === "audio/mpeg" || media.mimeType === "audio/mp4") {
        return {
          ...base,
          type: "audio",
          duration: Math.ceil(media.duration),
          title: media.title ?? undefined,
          performer: media.performer ?? undefined,
        };
      }
      break;
    case "voice":
      return { ...base, type: "voice", duration: Math.ceil(media.duration) };
  }
  return { ...base, type: "document" };
}

function album(files: Media[]): Media[] {
  if (
    files.length === 1 ||
    files.every(({ type }) => type === "photo" || type === "video") ||
    files.every(({ type }) => type === "audio")
  )
    return files;

  return files.map(({ file, fileSize, fileName, fileMime, caption }) => ({
    type: "document",
    file,
    fileSize,
    fileName,
    fileMime,
    caption,
  }));
}

export async function deliverWebFiles(
  uploader: Pick<BotUploader, "send">,
  status: TransferStatus,
  chat: number,
  paths: string[],
  link: string,
) {
  const files: Media[] = [];
  const sizes: number[] = [];
  for (const path of paths) {
    const file = Bun.file(path);
    const { size } = await stat(path);
    if (!size) throw new UserError(copy.unavailable);
    if (size > maxMediaBytes) throw new UserError(copy.tooLarge);
    const base = {
      file: file.stream(),
      fileSize: size,
      fileName: basename(path),
      fileMime: file.type,
    };
    if (file.type === "video/mp4")
      files.push({ ...base, type: "video", supportsStreaming: true });
    else if (file.type === "audio/mpeg") files.push({ ...base, type: "audio" });
    else if (
      size <= 10_000_000 &&
      ["image/jpeg", "image/png"].includes(file.type)
    )
      files.push({ ...base, type: "photo" });
    else files.push({ ...base, type: "document" });
    sizes.push(size);
  }

  const groupType = (file: Media) =>
    file.type === "photo" || file.type === "video" ? "visual" : file.type;
  for (let index = 0; index < files.length; ) {
    const type = groupType(files[index]);
    let end = index + 1;
    while (
      end < files.length &&
      end < index + 10 &&
      groupType(files[end]) === type
    )
      end++;

    const group = files.slice(index, end);
    group[0].caption = html(sourceCaption(link));
    await uploader.send(chat, group, sizes.slice(index, end), status);
    index = end;
  }
}

export async function deliver(
  uploader: Pick<BotUploader, "send">,
  source: Pick<TelegramSource, "download">,
  status: TransferStatus,
  chat: number,
  attachments: SourceAttachment[],
  link?: string,
) {
  if (!attachments.length) throw new UserError(copy.noMedia);
  const directory = await mkdtemp(join(tmpdir(), "tg-rip-"));
  const downloadTotal = attachments.every(({ media }) => media.fileSize)
    ? attachments.reduce((sum, { media }) => sum + (media.fileSize ?? 0), 0)
    : Infinity;
  let processed = 0;

  try {
    const files: Media[] = [];
    const sizes: number[] = [];
    const failures: string[] = [];
    await status.stage("downloading…");

    for (const [index, { media, url }] of attachments.entries()) {
      const path = join(directory, String(index));
      const expected = media.fileSize ?? 0;
      let size: number;
      try {
        if (expected > maxMediaBytes) throw new UserError(copy.tooLarge);
        await source.download(path, media, (done, total) => {
          status.progress(
            "downloading",
            processed + done,
            attachments.length === 1 ? total : downloadTotal,
          );
        });
        ({ size } = await stat(path));
        if (size > maxMediaBytes) throw new UserError(copy.tooLarge);
        if (!size || (expected && size !== expected))
          throw new UserError(copy.unavailable);
      } catch (error) {
        if (attachments.length === 1 || !url) throw error;
        console.warn(
          "album item failed",
          error instanceof UserError ? error.message : "download error",
        );
        failures.push(url);
        processed += expected;
        continue;
      }

      processed += size;
      sizes.push(size);
      files.push(outgoingMedia(media, path, size));
    }

    const notice = failures.length ? downloadFailures(failures) : undefined;
    if (!files.length)
      throw new UserError(notice ?? copy.failed, notice ? "HTML" : undefined);

    const caption = [link ? sourceCaption(link) : undefined, notice]
      .filter(Boolean)
      .join("<br><br>");
    if (caption) files[0].caption = html(caption);
    await uploader.send(chat, album(files), sizes, status);
    console.info("media delivered", {
      files: files.length,
      bytes: sizes.reduce((sum, size) => sum + size, 0),
      failed: failures.length,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
