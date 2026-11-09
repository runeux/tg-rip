import { expect, test } from "bun:test";
import { sourceCaption } from "../src/copy";
import { parseChatId, parseTelegramLink } from "../src/links";

test("routes a story to its owner and story id", () => {
  expect(parseTelegramLink("https://t.me/example/s/42")).toMatchObject({
    kind: "story",
    peer: "example",
    id: 42,
  });
});

test("uses the post id after a private topic id", () => {
  expect(parseTelegramLink("https://t.me/c/1234567890/50/52")).toMatchObject({
    kind: "post",
    peer: -1001234567890,
    id: 52,
  });
});

test("preserves a comment target and escapes the source link", () => {
  const link = parseTelegramLink(
    "https://t.me/example/52?thread=50&comment=61",
  );
  expect(link).toMatchObject({ kind: "post", id: 52, comment: 61 });
  expect(sourceCaption(link?.url ?? "")).toContain("thread=50&amp;comment=61");
});

test("rejects external urls and unsafe chat ids", () => {
  expect(
    parseTelegramLink("https://t.me.example.com/example/1"),
  ).toBeUndefined();
  expect(parseTelegramLink("https://t.me/+joinhash")).toBeUndefined();
  expect(
    parseTelegramLink("https://t.me/example/42?comment=invalid"),
  ).toBeUndefined();
  expect(parseChatId("9007199254740993")).toBeUndefined();
  expect(parseChatId("-1001234567890")).toBe(-1001234567890);
});
