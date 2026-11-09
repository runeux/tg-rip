import { expect, test } from "bun:test";
import { MtTimeoutError, tl } from "@mtcute/bun";
import { resumeDownload } from "../src/download";

test("resumes from a partial file without yielding the bytes already written", async () => {
  const partSize = 1024 * 1024;
  const written = partSize + 2;
  const data = Uint8Array.of(1, 2, 3, 4);
  const progress: number[] = [];
  const parts = resumeDownload(
    async (offset, limit) => {
      expect(offset).toBe(partSize);
      expect(limit).toBe(partSize);
      return data;
    },
    written,
    partSize + data.length,
    new AbortController().signal,
    (done) => progress.push(done),
  );

  expect(await Array.fromAsync(parts)).toEqual([Uint8Array.of(3, 4)]);
  expect(progress).toEqual([partSize + data.length]);
});

test("rejects a truncated part", async () => {
  const parts = resumeDownload(
    async () => Uint8Array.of(1),
    0,
    2,
    new AbortController().signal,
    () => {},
  );
  await expect(Array.fromAsync(parts)).rejects.toThrow("media unavailable");
});

test("stops when telegram's retry delay exceeds the part deadline", async () => {
  const parts = resumeDownload(
    async () => {
      throw tl.RpcError.fromTl({
        errorCode: 420,
        errorMessage: "FLOOD_WAIT_180",
      });
    },
    0,
    2,
    new AbortController().signal,
    () => {},
  );
  await expect(Array.fromAsync(parts)).rejects.toBeInstanceOf(MtTimeoutError);
});
