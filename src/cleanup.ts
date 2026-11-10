import { Queue, Worker } from "bullmq";
import { type Api, GrammyError } from "grammy";
import type { Redis } from "ioredis";

type Message = { chat: number; message: number };
export type ExpireMessage = (chat: number, message: number) => Promise<void>;

const queueName = "tg-rip-cleanup";
export const messageTtl = 5 * 60;
const lifetime = messageTtl * 1_000;

async function remove(api: Api, { chat, message }: Message) {
  try {
    await api.deleteMessage(chat, message);
  } catch (error) {
    if (
      error instanceof GrammyError &&
      error.error_code === 400 &&
      error.description.includes("message to delete not found")
    )
      return;
    throw error;
  }
}

function logCleanupError(error: unknown) {
  console.warn(
    "message cleanup failed",
    error instanceof Error ? error.name : "unknown",
  );
}

export async function discardMessage(
  api: Api,
  chat: number,
  message: number,
  retry?: ExpireMessage,
) {
  try {
    await remove(api, { chat, message });
  } catch (error) {
    logCleanupError(error);
    await retry?.(chat, message);
  }
}

export function messageCleanup(
  connection: Redis,
  workerRedis: Redis,
  api: Api,
) {
  const queue = new Queue<Message>(queueName, { connection });
  const worker = new Worker<Message>(
    queueName,
    ({ data }) => remove(api, data),
    { connection: workerRedis },
  );
  worker.on("error", logCleanupError);
  worker.on("failed", (_job, error) => logCleanupError(error));

  const expire: ExpireMessage = async (chat, message) => {
    try {
      await queue.add(
        "delete",
        { chat, message },
        {
          jobId: `${chat}-${message}`,
          delay: lifetime,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: { age: 86_400, count: 1_000 },
        },
      );
    } catch (error) {
      logCleanupError(error);
      setTimeout(
        () => void discardMessage(api, chat, message),
        lifetime,
      ).unref();
    }
  };

  return { queue, worker, expire };
}
