import {
  type Audio,
  type Document,
  type Message,
  MtPeerNotFoundError,
  type Photo,
  TelegramClient,
  tl,
  type Video,
  type Voice,
} from "@mtcute/bun";
import type { TelegramConfig } from "./config";
import { copy, UserError } from "./copy";
import type { TelegramLink } from "./links";

export type Attachment = Photo | Video | Audio | Voice | Document;

export function userClient(config: TelegramConfig): TelegramClient {
  return new TelegramClient({
    apiId: config.TG_API_ID,
    apiHash: config.TG_API_HASH,
    storage: config.SESSION_PATH,
    disableUpdates: true,
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
      const messages = message.groupedId
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

  async download(file: string, media: Attachment): Promise<void> {
    try {
      await this.#client.downloadToFile(file, media, {
        abortSignal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
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
