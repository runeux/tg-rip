import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { maxMediaBytes } from "./config";
import { copy, UserError } from "./copy";
import { formatArgs, type WebChoice, webChoices } from "./web-formats";

const probeTimeout = 60_000;
const downloadTimeout = 30 * 60_000;
type Tool = "yt-dlp" | "gallery-dl";

async function run(
  tool: Tool,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<string | undefined> {
  const signal = AbortSignal.timeout(timeout);
  const subprocess = Bun.spawn({
    cmd: [tool, ...args],
    cwd,
    env: { PATH: process.env.PATH, PYTHONUTF8: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (signal.aborted) throw new UserError(copy.downloadTimeout);
  if (!exitCode) return stdout;
  if (/Unsupported URL|No suitable extractor found/i.test(stderr))
    return undefined;
  if (
    /login required|log.?in to|redirect to login|requires (?:a login|authentication)|sign in to|cookies.*required/i.test(
      stderr,
    )
  )
    throw new UserError(copy.webSignIn);
  if (/larger than max-filesize|exceeds maximum file size/i.test(stderr))
    throw new UserError(copy.tooLarge);
  if (/timed? out|timeout/i.test(stderr))
    throw new UserError(copy.downloadTimeout);
  throw new UserError(copy.unavailable);
}

export function preferGallery(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, "");
  return (
    (host === "instagram.com" &&
      /^\/(?:p|stories|s|share\/p)\//.test(url.pathname)) ||
    (host === "tiktok.com" && /^\/@[^/]+\/photo\//.test(url.pathname))
  );
}

function outputFiles(stdout: string, output: string): string[] {
  const paths = stdout
    .split(/\r?\n/)
    .filter((path) => dirname(path) === output);
  if (!paths.length) throw new UserError(copy.noMedia);
  return [...new Set(paths)];
}

export async function downloadWebMedia(
  url: string,
  cookieFile: string | undefined,
  choice: WebChoice | undefined,
  onDownload: () => Promise<void>,
  send: (paths: string[]) => Promise<void>,
): Promise<WebChoice[] | undefined> {
  const target = new URL(url);
  if (
    !cookieFile &&
    ["instagram.com", "www.instagram.com"].includes(target.hostname) &&
    /^\/(?:stories|s)\//.test(target.pathname)
  )
    throw new UserError(copy.webSignIn);

  const directory = await mkdtemp(join(tmpdir(), "tg-rip-web-"));
  const output = join(directory, "media");
  try {
    await mkdir(output);
    const cookies = cookieFile ? join(directory, "cookies.txt") : undefined;
    if (cookies && cookieFile) await copyFile(cookieFile, cookies);

    const yt = [
      "--ignore-config",
      "--no-plugin-dirs",
      "--use-extractors",
      "default,-generic",
      "--no-playlist",
      "--playlist-items",
      "1",
      "--socket-timeout",
      "20",
      "--retries",
      "2",
      "--no-cache-dir",
      ...(cookies ? ["--cookies", cookies] : []),
    ];
    const gallery = [
      "--config-ignore",
      "--cache-file",
      join(directory, "gallery-cache.sqlite"),
      "--quiet",
      "--no-colors",
      "--http-timeout",
      "20",
      "--retries",
      "2",
      "--range",
      "1-100",
      "--child-range",
      "1",
      "--filesize-max",
      String(maxMediaBytes),
      "--windows-filenames",
      "-o",
      "extractor.tiktok.audio=false",
      "--directory",
      output,
      "--Print",
      "after:{_path}",
      ...(cookies ? ["--cookies", cookies] : []),
    ];

    let probeError: UserError | undefined;
    if (!choice && !preferGallery(target)) {
      try {
        const data = await run(
          "yt-dlp",
          [...yt, "--dump-json", "--", url],
          directory,
          probeTimeout,
        );
        if (data !== undefined) {
          const choices = webChoices(JSON.parse(data));
          if (choices.length > 1) return choices;
          choice = choices[0];
        }
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        probeError = error;
      }
    }

    await onDownload();
    if (!choice) {
      const result = await run(
        "gallery-dl",
        [...gallery, "--", url],
        directory,
        downloadTimeout,
      );
      if (result === undefined)
        throw probeError ?? new UserError(copy.unsupported);
      await send(outputFiles(result, output));
      return;
    }

    const result = await run(
      "yt-dlp",
      [
        ...yt,
        ...formatArgs(choice),
        "--max-filesize",
        String(maxMediaBytes),
        "--output",
        join(output, "%(title).160B [%(id)s].%(ext)s"),
        "--restrict-filenames",
        "--print",
        "after_move:filepath",
        "--no-simulate",
        "--",
        url,
      ],
      directory,
      downloadTimeout,
    );
    if (result === undefined) throw new UserError(copy.unsupported);
    await send(outputFiles(result, output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
