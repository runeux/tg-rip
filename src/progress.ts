import type { Api } from "grammy";
import { discardMessage, type ExpireMessage } from "./cleanup";

const editInterval = 2_000;

export class TransferStatus {
  #text: string | undefined;
  #lastEdit = 0;
  #pending?: Promise<void>;

  constructor(
    private readonly api: Api,
    private readonly chat: number,
    private readonly message?: number,
    private readonly expire?: ExpireMessage,
  ) {}

  async #edit(text: string, parseMode?: "HTML") {
    if (this.message === undefined || text === this.#text) return;
    this.#lastEdit = Date.now();
    try {
      await this.api.editMessageText(this.chat, this.message, text, {
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
      });
      this.#text = text;
    } catch (error) {
      console.warn(
        "status edit failed",
        error instanceof Error ? error.name : "unknown",
      );
    }
  }

  async stage(text: string) {
    await this.#pending;
    await this.#edit(text);
  }

  progress(stage: "downloading" | "uploading", done: number, total: number) {
    if (
      this.message === undefined ||
      this.#pending ||
      Date.now() - this.#lastEdit < editInterval ||
      !Number.isFinite(total) ||
      total <= 0
    )
      return;

    const percent = Math.min(99, Math.floor((done / total) * 100));
    if (percent <= 0) return;
    this.#pending = this.#edit(`${stage}… ${percent}%`).finally(() => {
      this.#pending = undefined;
    });
  }

  async finish() {
    await this.#pending;
    if (this.message !== undefined)
      await discardMessage(this.api, this.chat, this.message, this.expire);
  }

  async fail(text: string, parseMode?: "HTML") {
    await this.#pending;
    await this.#edit(text, parseMode);
    if (this.message !== undefined && this.#text === text) return this.message;
    const { message_id } = await this.api.sendMessage(this.chat, text, {
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    });
    await this.finish();
    return message_id;
  }
}
