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
import type { Config } from "./config";
import { copy, UserError } from "./copy";
import type { Task } from "./jobs";
import { parseChatId, parseTelegramLink } from "./links";
import { type Picker, pickerTtl } from "./picker";

type BotContext = ConversationFlavor<Context>;
const action = /^rip:(\d+):(get|page):(\d+)$/;

export function createBot(
  config: Config,
  redis: Redis,
  queue: Queue<Task>,
  picker: Picker,
) {
  const bot = new Bot<BotContext>(config.BOT_TOKEN, {
    client: { timeoutSeconds: 600 },
  });
  const enqueue = (task: Task, updateId: number) =>
    queue.add(task.kind, task, { jobId: `update-${updateId}` });

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
          await bot.api.sendMessage(config.OWNER_ID, error.message);
        }
      });
    }
  }

  bot.use(createConversation(chatMedia));
  bot.command("start", (ctx) => ctx.reply(copy.start));
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const chat = parseChatId(text);
    if (chat !== undefined) {
      await ctx.conversation.exitAll();
      await ctx.conversation.enter("chatMedia", chat);
      return;
    }
    const link = parseTelegramLink(text);
    if (!link) {
      await ctx.reply(copy.start);
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
  return bot;
}
