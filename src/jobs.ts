import { Queue, Worker } from "bullmq";
import type { Api } from "grammy";
import type { Redis } from "ioredis";
import { discardMessage, type ExpireMessage } from "./cleanup";
import { chatIdHeader, copy, escapeHtml, UserError } from "./copy";
import { type BotUploader, deliver, deliverWebFiles } from "./delivery";
import type { TelegramLink } from "./links";
import type { Picker } from "./picker";
import { TransferStatus } from "./progress";
import type { TelegramSource } from "./telegram";
import { downloadWebMedia } from "./web-download";
import type { WebChoice } from "./web-formats";
import type { WebPicker } from "./web-picker";

export type Task = (
  | { kind: "link"; chat: number; message: number; link: TelegramLink }
  | {
      kind: "browse";
      chat: number;
      message?: number;
      sourceChat: number;
      key: string;
    }
  | { kind: "pick"; chat: number; key: string; id: number }
  | {
      kind: "web";
      chat: number;
      key: string;
      url: string;
      message?: number;
      choice?: WebChoice;
    }
) & { statusMessage?: number };

const queueName = "tg-rip";

export async function reportFailure(
  status: TransferStatus,
  expire: ExpireMessage,
  task: Task,
  message: string,
  parseMode?: "HTML",
) {
  const detail = parseMode === "HTML" ? message : escapeHtml(message);
  if (task.kind === "link" || task.kind === "web") {
    const url = task.kind === "web" ? task.url : task.link.url;
    const label = message === copy.unsupported ? "link" : "media";
    const link = `<a href="${escapeHtml(url)}">${label}</a>`;
    const separator = parseMode === "HTML" ? " · " : " ";
    message = `${link}${separator}${detail}`;
    parseMode = "HTML";
  } else if (task.kind === "browse") {
    message = chatIdHeader(task.sourceChat) + detail;
    parseMode = "HTML";
  }
  await expire(task.chat, await status.fail(message, parseMode));
}

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
  expire: ExpireMessage,
  web: { picker: WebPicker; cookies?: string },
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
      const status = new TransferStatus(api, task.chat, message, expire);
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
            const { message_id } = await api.sendMessage(
              task.chat,
              view.text,
              view.options,
            );
            await expire(task.chat, message_id);
            break;
          }
          case "pick": {
            const snapshot = await picker.load(task.key);
            if (!snapshot.items.some(({ id }) => id === task.id))
              throw new UserError(copy.expired);
            const file = await source.getTimed(snapshot.chat, task.id);
            await deliver(uploader, source, status, task.chat, [
              { media: file },
            ]);
            break;
          }
          case "web": {
            const choices = await downloadWebMedia(
              task.url,
              web.cookies,
              task.choice,
              () => status.stage("downloading…"),
              (paths) =>
                deliverWebFiles(uploader, status, task.chat, paths, task.url),
            );
            if (choices)
              await web.picker.show(
                api,
                expire,
                task.chat,
                task.key,
                task.url,
                choices,
              );
            break;
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
        const parseMode =
          error instanceof UserError ? error.parseMode : undefined;
        await reportFailure(status, expire, task, message, parseMode);
        throw new Error(parseMode ? copy.failed : message);
      } finally {
        if ("message" in task && task.message !== undefined)
          await discardMessage(api, task.chat, task.message, expire);
      }
    },
    { connection, concurrency: 1, maxStalledCount: 0 },
  );
}
