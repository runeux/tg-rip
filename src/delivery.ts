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
  type InputText,
  MtTimeoutError,
  TelegramClient,
} from "@mtcute/bun";
import type { Config } from "./config";
import { copy, sourceCaption, UserError } from "./copy";
import type { TransferStatus } from "./progress";
import type { Attachment, TelegramSource } from "./telegram";

const maxBytes = 2_000_000_000;

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

function outgoingMedia(
  media: Attachment,
  path: string,
  size: number,
  caption?: InputText,
): Media {
  const base = {
    file: Bun.file(path).stream(),
    fileSize: size,
    fileName: filename(media),
    fileMime: media.type === "photo" ? "image/jpeg" : media.mimeType,
    caption,
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

export async function deliver(
  uploader: BotUploader,
  source: TelegramSource,
  status: TransferStatus,
  chat: number,
  attachments: Attachment[],
  link?: string,
) {
  if (!attachments.length) throw new UserError(copy.noMedia);
  if (attachments.some((media) => (media.fileSize ?? 0) > maxBytes)) {
    throw new UserError(copy.tooLarge);
  }

  const caption = link ? html(sourceCaption(link)) : undefined;
  const directory = await mkdtemp(join(tmpdir(), "tg-rip-"));
  const downloadTotal = attachments.every((media) => media.fileSize)
    ? attachments.reduce((sum, media) => sum + (media.fileSize ?? 0), 0)
    : Infinity;
  let downloaded = 0;

  try {
    const files: Media[] = [];
    const sizes: number[] = [];
    await status.stage("downloading…");

    for (const [index, media] of attachments.entries()) {
      const path = join(directory, String(index));
      await source.download(path, media, (done, total) => {
        status.progress(
          "downloading",
          downloaded + done,
          attachments.length === 1 ? total : downloadTotal,
        );
      });
      const { size } = await stat(path);
      if (size === 0) throw new UserError(copy.unavailable);
      if (size > maxBytes) throw new UserError(copy.tooLarge);
      downloaded += size;
      sizes.push(size);
      files.push(
        outgoingMedia(media, path, size, index === 0 ? caption : undefined),
      );
    }

    await uploader.send(chat, album(files), sizes, status);
    console.info("media delivered", { files: files.length, bytes: downloaded });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
