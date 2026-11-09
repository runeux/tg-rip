import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Api, InputFile } from "grammy";
import type {
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
} from "grammy/types";
import { copy, sourceCaption, UserError } from "./copy";
import type { Attachment, TelegramSource } from "./telegram";

const maxBytes = 50_000_000;
const captionOptions = { parse_mode: "HTML" } as const;

type AlbumItem =
  | InputMediaPhoto
  | InputMediaVideo
  | InputMediaAudio
  | InputMediaDocument;

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

function albumItem(media: Attachment, file: InputFile): AlbumItem {
  switch (media.type) {
    case "photo":
      return { type: "photo", media: file };
    case "video":
      if (media.mimeType === "video/mp4") {
        return {
          type: "video",
          media: file,
          supports_streaming: true,
          width: media.width,
          height: media.height,
          duration: Math.ceil(media.duration),
        };
      }
      break;
    case "audio":
      if (media.mimeType === "audio/mpeg" || media.mimeType === "audio/mp4") {
        return {
          type: "audio",
          media: file,
          title: media.title ?? undefined,
          performer: media.performer ?? undefined,
        };
      }
      break;
  }
  return { type: "document", media: file };
}

export async function deliver(
  api: Api,
  source: TelegramSource,
  chat: number,
  attachments: Attachment[],
  link?: string,
) {
  if (!attachments.length) throw new UserError(copy.noMedia);
  if (attachments.some((media) => (media.fileSize ?? 0) > maxBytes)) {
    throw new UserError(copy.tooLarge);
  }
  const caption = link && sourceCaption(link);
  const options = { caption, ...captionOptions };
  const directory = await mkdtemp(join(tmpdir(), "tg-rip-"));
  try {
    const files: AlbumItem[] = [];
    for (const [index, media] of attachments.entries()) {
      const path = join(directory, String(index));
      await source.download(path, media);
      const { size } = await stat(path);
      if (size === 0) throw new UserError(copy.unavailable);
      if (size > maxBytes) throw new UserError(copy.tooLarge);
      const file = new InputFile(path, filename(media));
      const photoTooLarge = media.type === "photo" && size > 10_000_000;
      files.push(
        photoTooLarge
          ? { type: "document", media: file }
          : albumItem(media, file),
      );
    }

    const [first] = files;
    if (files.length > 1) {
      const group = files.map((file, index) =>
        index === 0 ? { ...file, ...options } : file,
      );
      if (
        group.every((file) => file.type === "photo" || file.type === "video") ||
        group.every((file) => file.type === "audio") ||
        group.every((file) => file.type === "document")
      ) {
        await api.sendMediaGroup(chat, group);
      } else {
        await api.sendMediaGroup(
          chat,
          group.map(
            (file, index): InputMediaDocument => ({
              type: "document",
              media: file.media,
              ...(index === 0 ? options : {}),
            }),
          ),
        );
      }
      return;
    }
    const file = first.media;
    switch (first.type) {
      case "photo":
        await api.sendPhoto(chat, file, options);
        break;
      case "video":
        await api.sendVideo(chat, file, {
          width: first.width,
          height: first.height,
          duration: first.duration,
          supports_streaming: first.supports_streaming,
          ...options,
        });
        break;
      case "audio":
        await api.sendAudio(chat, file, {
          title: first.title,
          performer: first.performer,
          ...options,
        });
        break;
      case "document":
        if (attachments[0].type === "voice")
          await api.sendVoice(chat, file, options);
        else await api.sendDocument(chat, file, options);
        break;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
