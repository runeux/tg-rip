import { type } from "arktype";
import { type Api, InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { type ExpireMessage, messageTtl } from "./cleanup";
import { escapeHtml } from "./copy";
import { formatLabel, type WebChoice, webChoice } from "./web-formats";

export const webAction = /^web:(\d+):(\d+)$/;
const snapshot = type({ url: "string", choices: webChoice.array() });

export class WebPicker {
  constructor(private readonly redis: Redis) {}

  async show(
    api: Api,
    expire: ExpireMessage,
    chat: number,
    key: string,
    url: string,
    choices: WebChoice[],
  ) {
    const buttons = new InlineKeyboard();
    for (const [index, choice] of choices.entries()) {
      buttons.text(formatLabel(choice), `web:${key}:${index}`);
      if (index % 2 === 1) buttons.row();
    }

    const storageKey = `tg-rip:web:${key}`;
    await this.redis.set(
      storageKey,
      JSON.stringify({ url, choices }),
      "EX",
      messageTtl,
    );
    const { message_id } = await api.sendMessage(
      chat,
      `choose a format or video quality for <a href="${escapeHtml(url)}">media</a>`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: buttons,
      },
    );
    await expire(chat, message_id);
  }

  async take(key: string, index: number) {
    const value = await this.redis.getdel(`tg-rip:web:${key}`);
    if (!value) return;
    const { url, choices } = snapshot.assert(JSON.parse(value));
    const choice = choices[index];
    if (choice) return { url, choice };
  }
}
