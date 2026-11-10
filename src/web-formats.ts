import { type } from "arktype";
import { copy, UserError } from "./copy";

const resolution = type({
  width: "number.integer > 0",
  height: "number.integer > 0",
});
export const webChoice = type({ format: "'mp3'" }).or({
  format: "'mp4'",
  "resolution?": resolution,
});
export type WebChoice = typeof webChoice.infer;

const format = type({
  "vcodec?": "string | null",
  "acodec?": "string | null",
  "ext?": "string | null",
  "width?": "number | null",
  "height?": "number | null",
});
const info = type({ "formats?": format.array() });
const audioExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
]);

export function webChoices(metadata: unknown): WebChoice[] {
  const result = info(metadata);
  if (result instanceof type.errors || !result.formats?.length)
    throw new UserError(copy.noMedia);

  const formats = result.formats;
  const video = formats.filter(
    ({ vcodec, ext }) =>
      vcodec !== "none" && !audioExtensions.has(ext ?? "") && ext !== "mhtml",
  );
  const choices: WebChoice[] = [];
  if (
    formats.some(({ acodec, ext }) =>
      acodec ? acodec !== "none" : audioExtensions.has(ext ?? ""),
    )
  )
    choices.push({ format: "mp3" });

  if (video.length) choices.push({ format: "mp4" });
  const sizes = new Map<number, typeof resolution.infer>();
  for (const format of video) {
    const size = resolution(format);
    if (size instanceof type.errors) continue;
    const edge = Math.min(size.width, size.height);
    const previous = sizes.get(edge);
    if (
      !previous ||
      size.width * size.height > previous.width * previous.height
    )
      sizes.set(edge, { width: size.width, height: size.height });
  }

  if (sizes.size > 1) {
    for (const [, resolution] of [...sizes]
      .sort(([a], [b]) => b - a)
      .slice(0, 8))
      choices.push({ format: "mp4", resolution });
  }

  if (!choices.length) throw new UserError(copy.noMedia);
  return choices;
}

export function formatLabel(choice: WebChoice): string {
  if (choice.format === "mp3") return "mp3";
  if (!choice.resolution) return "mp4 · best";
  const { width, height } = choice.resolution;
  return `mp4 · ${Math.min(width, height)}p`;
}

export function formatArgs(choice: WebChoice): string[] {
  if (choice.format === "mp3")
    return [
      "-f",
      "ba*",
      "-S",
      "abr,asr",
      "--format-sort-force",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
    ];

  const size = choice.resolution;
  const filter = size ? `[width=${size.width}][height=${size.height}]` : "";
  return [
    "-f",
    `bv*${filter}+ba/b${filter}/bv${filter}`,
    "--merge-output-format",
    "mp4",
    "--remux-video",
    "mp4",
    "-S",
    "res,vcodec:h264,acodec:aac",
  ];
}
