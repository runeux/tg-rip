import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  type Audio,
  type Document,
  type Message,
  MtPeerNotFoundError,
  MtTimeoutError,
  type Photo,
  TelegramClient,
  tl,
  type Video,
  type Voice,
} from "@mtcute/bun";
import type { TelegramConfig } from "./config";
import { copy, UserError } from "./copy";
import { resumeDownload } from "./download";
import type { TelegramLink } from "./links";

export type Attachment = Photo | Video | Audio | Voice | Document;

const downloadStallTimeout = 60_000;

export function userClient(config: TelegramConfig): TelegramClient {
  return new TelegramClient({
    apiId: config.TG_API_ID,
    apiHash: config.TG_API_HASH,
    storage: config.SESSION_PATH,
    disableUpdates: true,
    network: { connectionCount: (kind) => (kind === "main" ? 0 : 1) },
  });
}

export function attachment(message: Message): Attachment | undefined {
  const media = message.media;
  if (
    media &&
    (media.type === "photo" ||
      media.type === "video" ||
      media.type === "audio" ||
      media.type === "voice" ||
      media.type === "document")
  ) {
    return media;
  }
}

export function timedAttachment(message: Message): Attachment | undefined {
  const media = message.raw._ === "message" ? message.raw.media : undefined;
  if (
    (media?._ === "messageMediaPhoto" || media?._ === "messageMediaDocument") &&
    (media.ttlSeconds ?? 0) > 0
  )
    return attachment(message);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof MtPeerNotFoundError ||
    (error instanceof tl.RpcError &&
      [
        "CHANNEL_INVALID",
        "CHANNEL_PRIVATE",
        "PEER_ID_INVALID",
        "MSG_ID_INVALID",
        "MESSAGE_ID_INVALID",
        "USERNAME_INVALID",
        "USERNAME_NOT_OCCUPIED",
        "USER_ID_INVALID",
        "CHAT_ID_INVALID",
        "STORIES_NEVER_CREATED",
      ].includes(error.text))
  );
}

export class TelegramSource {
  readonly #client: TelegramClient;
  readonly #owner: number;
  #authorized = false;

  constructor(config: TelegramConfig) {
    this.#client = userClient(config);
    this.#owner = config.OWNER_ID;
  }

  async #connect() {
    if (this.#authorized) return;
    await this.#client.connect();
    try {
      const self = await this.#client.getMe();
      if (self.id !== this.#owner || self.isBot)
        throw new UserError(copy.signIn);
      this.#authorized = true;
    } catch (error) {
      if (error instanceof tl.RpcError && error.code === 401)
        throw new UserError(copy.signIn);
      throw error;
    }
  }

  async #peer(id: string | number) {
    try {
      return await this.#client.getPeer(id);
    } catch (error) {
      if (!(error instanceof MtPeerNotFoundError) || typeof id !== "number")
        throw error;
      for await (const dialog of this.#client.iterDialogs()) {
        if (dialog.peer.id === id) return dialog.peer;
      }
      throw error;
    }
  }

  async fromLink(link: TelegramLink): Promise<Attachment[]> {
    await this.#connect();
    try {
      const peer = await this.#peer(link.peer);
      if (link.kind === "story") {
        const [story] = await this.#client.getStoriesById(
          peer.inputPeer,
          link.id,
        );
        if (!story) throw new UserError(copy.inaccessible);
        return [story.media];
      }

      let chat = peer.inputPeer;
      let id = link.id;
      if (link.comment) {
        const discussion = await this.#client.getDiscussionMessage({
          chatId: chat,
          message: id,
        });
        if (!discussion) throw new UserError(copy.inaccessible);
        chat = discussion.chat.inputPeer;
        id = link.comment;
      }
      const [message] = await this.#client.getMessages(chat, id);
      if (!message) throw new UserError(copy.inaccessible);
      const messages =
        message.groupedId && !new URL(link.url).searchParams.has("single")
          ? await this.#client.getMessageGroup({ chatId: chat, message: id })
          : [message];
      return messages
        .sort((a, b) => a.id - b.id)
        .flatMap((item) => {
          const media = attachment(item);
          return media ? [media] : [];
        });
    } catch (error) {
      if (isMissing(error)) throw new UserError(copy.inaccessible);
      throw error;
    }
  }

  async listTimed(chatId: number) {
    await this.#connect();
    try {
      const peer = await this.#peer(chatId);
      const items: { id: number; date: number }[] = [];
      for await (const message of this.#client.iterHistory(peer.inputPeer)) {
        if (timedAttachment(message))
          items.push({ id: message.id, date: message.date.getTime() });
      }
      return { name: peer.displayName, items };
    } catch (error) {
      if (isMissing(error)) throw new UserError(copy.chatNotFound);
      throw error;
    }
  }

  async getTimed(chatId: number, id: number): Promise<Attachment> {
    await this.#connect();
    try {
      const peer = await this.#peer(chatId);
      const [message] = await this.#client.getMessages(peer.inputPeer, id);
      const media = message && timedAttachment(message);
      if (!media) throw new UserError(copy.unavailable);
      return media;
    } catch (error) {
      if (isMissing(error)) throw new UserError(copy.unavailable);
      throw error;
    }
  }

  async download(
    file: string,
    media: Attachment,
    progressCallback: (downloaded: number, total: number) => void,
  ): Promise<void> {
    const signal = AbortSignal.timeout(60 * 60_000);
    const stalled = new AbortController();
    const resetStallTimer = () =>
      setTimeout(
        () => stalled.abort(new MtTimeoutError(downloadStallTimeout)),
        downloadStallTimeout,
      );
    try {
      let stallTimer = resetStallTimer();
      const chunks = this.#client.downloadAsIterable(media, {
        progressCallback(done, total) {
          clearTimeout(stallTimer);
          stallTimer = resetStallTimer();
          progressCallback(done, total);
        },
        partSize: (media.fileSize ?? 0) > 5_000_000 ? 512 : undefined,
        abortSignal: AbortSignal.any([signal, stalled.signal]),
      });
      try {
        await pipeline(
          chunks,
          createWriteStream(file, { flags: "wx" }),
        ).finally(() => clearTimeout(stallTimer));
      } catch (error) {
        const failure: unknown = stalled.signal.aborted
          ? stalled.signal.reason
          : error;
        const total = media.fileSize;
        if (
          !(failure instanceof MtTimeoutError) ||
          media.type === "photo" ||
          !total
        )
          throw failure;
        const { size: offset } = await stat(file);
        if (offset >= total) throw failure;

        console.info("resuming stalled download", { offset, total });
        const location: tl.RawInputDocumentFileLocation = {
          _: "inputDocumentFileLocation",
          id: media.raw.id,
          accessHash: media.raw.accessHash,
          fileReference: media.raw.fileReference,
          thumbSize: "",
        };
        const resumed = resumeDownload(
          async (offset, limit, abortSignal) => {
            const result = await this.#client.call(
              { _: "upload.getFile", location, offset, limit, precise: true },
              {
                kind: "download",
                dcId: media.dcId,
                maxRetryCount: 0,
                floodSleepThreshold: 0,
                abortSignal,
              },
            );
            if (result._ !== "upload.file")
              throw new UserError(copy.unavailable);
            return result.bytes;
          },
          offset,
          total,
          signal,
          progressCallback,
        );
        await pipeline(resumed, createWriteStream(file, { flags: "a" }));
      }
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof MtTimeoutError ||
        (error instanceof Error && error.name === "TimeoutError")
      ) {
        throw new UserError(copy.downloadTimeout);
      }
      if (
        error instanceof tl.RpcError &&
        (/^FILE_REFERENCE/.test(error.text) ||
          error.text === "LOCATION_INVALID")
      ) {
        throw new UserError(copy.unavailable);
      }
      throw error;
    }
  }

  async close() {
    await this.#client.destroy();
  }
}
