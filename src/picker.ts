import { type } from "arktype";
import { type Api, InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { copy, escapeHtml, UserError } from "./copy";

export const pickerTtl = 900;
const pageSize = 10;

const snapshotSchema = type({
  chat: "number",
  name: "string",
  items: type({ id: "number", date: "number" }).array(),
});
type Snapshot = typeof snapshotSchema.infer;

export class Picker {
  readonly #dates: Intl.DateTimeFormat;

  constructor(
    private readonly redis: Redis,
    timeZone: string,
  ) {
    this.#dates = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  async save(key: string, data: Snapshot) {
    await this.redis.set(
      `tg-rip:picker:${key}`,
      JSON.stringify(data),
      "EX",
      pickerTtl,
    );
    return this.render(key, data, 0);
  }

  async load(key: string): Promise<Snapshot> {
    const value = await this.redis.get(`tg-rip:picker:${key}`);
    if (!value) throw new UserError(copy.expired);
    return snapshotSchema.assert(JSON.parse(value));
  }

  render(key: string, data: Snapshot, page: number) {
    const pages = Math.ceil(data.items.length / pageSize);
    if (!Number.isInteger(page) || page < 0 || page >= pages)
      throw new UserError(copy.expired);
    const buttons = new InlineKeyboard();
    for (const item of data.items.slice(
      page * pageSize,
      (page + 1) * pageSize,
    )) {
      const date = this.#dates
        .format(item.date)
        .replace(" at ", ", ")
        .toLowerCase();
      buttons.text(date, `rip:${key}:get:${item.id}`).row();
    }
    if (page > 0) buttons.text("previous", `rip:${key}:page:${page - 1}`);
    if (page + 1 < pages) buttons.text("next", `rip:${key}:page:${page + 1}`);
    return {
      text: `<b>found chat "${escapeHtml(data.name)}"</b> – ${data.items.length} media available`,
      options: { parse_mode: "HTML", reply_markup: buttons } as const,
    };
  }

  async showPage(
    api: Api,
    chat: number,
    message: number,
    key: string,
    page: number,
  ) {
    const view = this.render(key, await this.load(key), page);
    await api.editMessageText(chat, message, view.text, view.options);
  }
}
