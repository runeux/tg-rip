export const copy = {
  start: "send a telegram link or chat id",
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

export class UserError extends Error {}

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
