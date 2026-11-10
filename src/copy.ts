export const copy = {
  start: "send a media link or telegram chat id",
  unsupported: "is not supported",
  webSignIn: "requires a signed-in session",
  chatNotFound: "chat not found",
  noTimedMedia: "no timed media available",
  expired: "selection expired. send the chat id again",
  noMedia: "no media available",
  unavailable: "media unavailable",
  inaccessible: "source unavailable",
  signIn: "telegram sign-in required",
  tooLarge: "file exceeds 2 gb",
  downloadTimeout: "download timed out",
  uploadTimeout: "upload timed out",
  queueFailed: "couldn’t queue request",
  failed: "couldn’t save media",
} as const;

export class UserError extends Error {
  constructor(
    message: string,
    readonly parseMode?: "HTML",
  ) {
    super(message);
  }
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sourceCaption(url: string): string {
  return `<a href="${escapeHtml(url)}"><b>source</b></a>`;
}

export function chatIdHeader(id: number): string {
  return `<code>${id}</code>\n\n`;
}

export function downloadFailures(urls: string[]): string {
  if (urls.length === 1)
    return `1 <a href="${escapeHtml(urls[0])}">media</a> download failed`;

  const links = urls.map(
    (url, index) => `<a href="${escapeHtml(url)}">${index + 1}</a>`,
  );
  return `${urls.length} media downloads failed · ${links.join(", ")}`;
}
