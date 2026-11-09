import { setTimeout as sleep } from "node:timers/promises";
import { MtTimeoutError, tl } from "@mtcute/bun";
import { copy, UserError } from "./copy";

const partSize = 1024 * 1024;
const partTimeout = 180_000;

export async function* resumeDownload(
  read: (
    offset: number,
    limit: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>,
  offset: number,
  total: number,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
) {
  while (offset < total) {
    const start = offset - (offset % partSize);
    const deadline = performance.now() + partTimeout;
    let delay = 3;

    for (;;) {
      try {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(0, Math.ceil(deadline - performance.now())),
          ),
        ]);
        const bytes = await read(start, partSize, requestSignal);
        if (bytes.length !== Math.min(partSize, total - start))
          throw new UserError(copy.unavailable);

        const remaining = bytes.subarray(offset - start);
        offset += remaining.length;
        yield remaining;
        progress(offset, total);
        break;
      } catch (error) {
        if (
          !(error instanceof tl.RpcError) ||
          !(error.is("FLOOD_WAIT_%d") || error.is("FLOOD_PREMIUM_WAIT_%d"))
        )
          throw error;

        const wait = Math.max(error.seconds + 1, delay) * 1000;
        if (performance.now() + wait >= deadline)
          throw new MtTimeoutError(partTimeout);
        await sleep(wait, undefined, { signal });
        delay = Math.min(delay * 2, 25);
      }
    }

    if (offset < total) await sleep(1000, undefined, { signal });
  }
}
