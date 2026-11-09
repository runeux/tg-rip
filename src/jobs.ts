import { Queue, Worker } from "bullmq";
import type { Api } from "grammy";
import type { Redis } from "ioredis";
import { copy, UserError } from "./copy";
import { type BotUploader, deliver } from "./delivery";
import type { TelegramLink } from "./links";
import type { Picker } from "./picker";
import { TransferStatus } from "./progress";
import type { TelegramSource } from "./telegram";

export type Task = (
  | { kind: "link"; chat: number; message: number; link: TelegramLink }
  | { kind: "browse"; chat: number; sourceChat: number; key: string }
  | { kind: "pick"; chat: number; key: string; id: number }
) & { statusMessage?: number };

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
  uploader: BotUploader,
) {
  return new Worker<Task>(
    queueName,
    async ({ data: task }) => {
      let message = task.statusMessage;
      if (message === undefined) {
        try {
          message = (await api.sendMessage(task.chat, "checking…")).message_id;
        } catch (error) {
          console.warn(
            "status unavailable",
            error instanceof Error ? error.name : "unknown",
          );
        }
      }
      const status = new TransferStatus(api, task.chat, message);
      try {
        if (task.statusMessage !== undefined) await status.stage("checking…");
        switch (task.kind) {
          case "link": {
            const files = await source.fromLink(task.link);
            await deliver(
              uploader,
              source,
              status,
              task.chat,
              files,
              task.link.url,
            );
            try {
              await api.deleteMessage(task.chat, task.message);
            } catch (error) {
              console.warn(
                "source message retained",
                error instanceof Error ? error.name : "unknown",
              );
            }
            break;
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
            break;
          }
          case "pick": {
            const snapshot = await picker.load(task.key);
            if (!snapshot.items.some(({ id }) => id === task.id))
              throw new UserError(copy.expired);
            const file = await source.getTimed(snapshot.chat, task.id);
            await deliver(uploader, source, status, task.chat, [file]);
          }
        }
        await status.finish();
      } catch (error) {
        let message: string = copy.failed;
        if (error instanceof UserError) message = error.message;
        else
          console.error(
            "job failed",
            task.kind,
            error instanceof Error ? error.name : "unknown",
          );
        await status.fail(message);
        throw new Error(message);
      }
    },
    { connection, concurrency: 1, maxStalledCount: 0 },
  );
}
