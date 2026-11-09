import { Queue, Worker } from "bullmq";
import { type Api, GrammyError } from "grammy";
import type { Redis } from "ioredis";
import { copy, UserError } from "./copy";
import { deliver } from "./delivery";
import type { TelegramLink } from "./links";
import type { Picker } from "./picker";
import type { TelegramSource } from "./telegram";

export type Task =
  | { kind: "link"; chat: number; message: number; link: TelegramLink }
  | { kind: "browse"; chat: number; sourceChat: number; key: string }
  | { kind: "pick"; chat: number; key: string; id: number };

const queueName = "tg-rip";

export function taskQueue(connection: Redis) {
  return new Queue<Task>(queueName, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 86_400, count: 1_000 },
    },
  });
}

export function worker(
  connection: Redis,
  api: Api,
  source: TelegramSource,
  picker: Picker,
) {
  return new Worker<Task>(
    queueName,
    async ({ data: task }) => {
      try {
        switch (task.kind) {
          case "link": {
            const files = await source.fromLink(task.link);
            await deliver(api, source, task.chat, files, task.link.url);
            try {
              await api.deleteMessage(task.chat, task.message);
            } catch (error) {
              console.warn(
                "source message retained",
                error instanceof Error ? error.name : "unknown",
              );
            }
            return;
          }
          case "browse": {
            const { name, items } = await source.listTimed(task.sourceChat);
            if (!items.length) throw new UserError(copy.noTimedMedia);
            const view = await picker.save(task.key, {
              chat: task.sourceChat,
              name,
              items,
            });
            await api.sendMessage(task.chat, view.text, view.options);
            return;
          }
          case "pick": {
            const snapshot = await picker.load(task.key);
            if (!snapshot.items.some(({ id }) => id === task.id))
              throw new UserError(copy.expired);
            const file = await source.getTimed(snapshot.chat, task.id);
            await deliver(api, source, task.chat, [file]);
          }
        }
      } catch (error) {
        let message: string = copy.failed;
        if (error instanceof UserError) message = error.message;
        else if (error instanceof GrammyError && error.error_code === 413)
          message = copy.tooLarge;
        else
          console.error(
            "job failed",
            task.kind,
            error instanceof Error ? error.name : "unknown",
          );
        await api.sendMessage(task.chat, message);
      }
    },
    { connection, concurrency: 1, maxStalledCount: 0 },
  );
}
