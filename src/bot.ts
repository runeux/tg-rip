import {
  type Conversation,
  type ConversationData,
  type ConversationFlavor,
  conversations,
  createConversation,
  type VersionedState,
} from "@grammyjs/conversations";
import { RedisAdapter } from "@grammyjs/storage-redis";
import type { Queue } from "bullmq";
import { Bot, type Context } from "grammy";
import type { Redis } from "ioredis";
import { discardMessage, type ExpireMessage } from "./cleanup";
import type { Config } from "./config";
import { copy, UserError } from "./copy";
import { reportFailure, type Task } from "./jobs";
import { parseChatId, parseTelegramLink, parseWebUrl } from "./links";
import { type Picker, pickerTtl } from "./picker";
import { TransferStatus } from "./progress";
import { type WebPicker, webAction } from "./web-picker";

type BotContext = ConversationFlavor<Context>;
const action = /^rip:(\d+):(get|page):(\d+)$/;

export function createBot(
  config: Config,
  redis: Redis,
  queue: Queue<Task>,
  picker: Picker,
  webPicker: WebPicker,
  expire: ExpireMessage,
) {
  const bot = new Bot<BotContext>(config.BOT_TOKEN, {
    client: { timeoutSeconds: 8 },
  });
  async function enqueue(task: Task, updateId: number) {
    const jobId = `update-${updateId}`;
    let statusMessage: number | undefined;
    try {
      if (await queue.getJob(jobId)) return;
      try {
        statusMessage = (await bot.api.sendMessage(task.chat, "queued…"))
          .message_id;
      } catch (error) {
        console.warn(
          "status unavailable",
          error instanceof Error ? error.name : "unknown",
        );
      }

      await queue.add(task.kind, { ...task, statusMessage }, { jobId });
    } catch (error) {
      console.warn(
        "queue unavailable",
        error instanceof Error ? error.name : "unknown",
      );
      await reportFailure(
        new TransferStatus(bot.api, task.chat, statusMessage, expire),
        expire,
        task,
        copy.queueFailed,
      );
      if ("message" in task && task.message !== undefined)
        await discardMessage(bot.api, task.chat, task.message, expire);
    }
  }

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private" && ctx.from?.id === config.OWNER_ID)
      await next();
  });
  bot.use(
    conversations<BotContext, Context>({
      storage: {
        type: "key",
        prefix: "tg-rip:conversation:",
        version: 0,
        adapter: new RedisAdapter<VersionedState<ConversationData>>({
          instance: redis,
          ttl: pickerTtl,
        }),
      },
    }),
  );

  async function chatMedia(
    conversation: Conversation<BotContext, Context>,
    ctx: Context,
    sourceChat: number,
  ) {
    const key = String(ctx.update.update_id);
    await conversation.external(() =>
      enqueue(
        {
          kind: "browse",
          chat: config.OWNER_ID,
          message: ctx.message?.message_id,
          sourceChat,
          key,
        },
        ctx.update.update_id,
      ).then(() => undefined),
    );

    for (;;) {
      const selected = await conversation.waitUntil(
        (event) => action.exec(event.callbackQuery?.data ?? "")?.[1] === key,
        { next: true, maxMilliseconds: pickerTtl * 1000 },
      );
      const query = selected.callbackQuery;
      const parsed = action.exec(query?.data ?? "");
      if (!query?.message || !parsed) continue;
      const messageId = query.message.message_id;
      await conversation.external(async () => {
        await bot.api.answerCallbackQuery(query.id);
        try {
          const value = Number(parsed[3]);
          if (parsed[2] === "page") {
            await picker.showPage(
              bot.api,
              config.OWNER_ID,
              messageId,
              key,
              value,
            );
          } else {
            await enqueue(
              { kind: "pick", chat: config.OWNER_ID, key, id: value },
              selected.update.update_id,
            );
          }
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          const { message_id } = await bot.api.sendMessage(
            config.OWNER_ID,
            error.message,
          );
          await expire(config.OWNER_ID, message_id);
        }
      });
    }
  }

  bot.use(createConversation(chatMedia));
  async function replyWithHelp(ctx: BotContext) {
    const { message_id } = await ctx.reply(copy.start);
    if (ctx.message)
      await discardMessage(
        bot.api,
        ctx.message.chat.id,
        ctx.message.message_id,
        expire,
      );
    await expire(config.OWNER_ID, message_id);
  }

  bot.command("start", replyWithHelp);
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const chat = parseChatId(text);
    if (chat !== undefined) {
      await ctx.conversation.exitAll();
      await ctx.conversation.enter("chatMedia", chat);
      return;
    }
    const entity = ctx.entities(["url", "text_link"])[0];
    const rawUrl =
      entity?.type === "text_link" ? entity.url : (entity?.text ?? text);
    const target =
      entity?.type === "url" && !rawUrl.includes("://")
        ? `https://${rawUrl}`
        : rawUrl;
    const link = parseTelegramLink(target);
    if (!link) {
      const url = parseWebUrl(target);
      if (!url) {
        await replyWithHelp(ctx);
        return;
      }
      await enqueue(
        {
          kind: "web",
          chat: ctx.chat.id,
          message: ctx.message.message_id,
          url: url.href,
          key: String(ctx.update.update_id),
        },
        ctx.update.update_id,
      );
      return;
    }
    await enqueue(
      {
        kind: "link",
        chat: ctx.chat.id,
        message: ctx.message.message_id,
        link,
      },
      ctx.update.update_id,
    );
  });
  bot.callbackQuery(action, (ctx) =>
    ctx.answerCallbackQuery({ text: copy.expired, show_alert: true }),
  );
  bot.callbackQuery(webAction, async (ctx) => {
    const { message } = ctx.callbackQuery;
    if (!message) return;
    const [, key, index] = ctx.match;
    const selection = await webPicker.take(key, Number(index));
    if (!selection) {
      await ctx.answerCallbackQuery({ text: copy.expired, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await enqueue(
      { kind: "web", chat: message.chat.id, key, ...selection },
      ctx.update.update_id,
    );
    await discardMessage(bot.api, message.chat.id, message.message_id, expire);
  });
  return bot;
}
