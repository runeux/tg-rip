export type TelegramLink =
  | { kind: "story"; peer: string; id: number; url: string }
  | {
      kind: "post";
      peer: string | number;
      id: number;
      comment?: number;
      url: string;
    };

export function singleMediaUrl(
  link: Extract<TelegramLink, { kind: "post" }>,
  id: number,
): string {
  const url = new URL(link.url);
  if (link.comment) url.searchParams.set("comment", String(id));
  else url.pathname = url.pathname.replace(/\/\d+\/?$/, `/${id}`);
  url.searchParams.delete("single");
  const query = url.searchParams.toString();
  url.search = query ? `single&${query}` : "single";
  return url.href;
}

const username = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;

function positiveId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return;
  const id = Number(value);
  if (Number.isSafeInteger(id) && id > 0) return id;
}

export function parseChatId(text: string): number | undefined {
  if (!/^-?\d+$/.test(text)) return;
  const id = Number(text);
  if (Number.isSafeInteger(id) && id !== 0) return id;
}

export function parseWebUrl(text: string): URL | undefined {
  const url = URL.parse(text);
  if (
    url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.port
  )
    return url;
}

export function parseTelegramLink(text: string): TelegramLink | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["t.me", "telegram.me"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    return;

  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (parts[0] === "s" && parts.length >= 3) parts.shift();

  const [name, second, third] = parts;
  const source = url.href;
  if (second === "s" && parts.length === 3 && username.test(name)) {
    const id = positiveId(third);
    if (id && id <= 2147483647)
      return { kind: "story", peer: name, id, url: source };
    return;
  }

  const isPrivate = name === "c";
  if (
    isPrivate
      ? parts.length < 3 || parts.length > 4
      : parts.length < 2 || parts.length > 3
  )
    return;
  const peer =
    isPrivate && positiveId(second) ? parseChatId(`-100${second}`) : undefined;
  if (isPrivate ? peer === undefined : !username.test(name)) return;
  const id = positiveId(parts.at(-1));
  const rawComment = url.searchParams.get("comment");
  const comment = positiveId(rawComment ?? undefined);
  if (
    !id ||
    id > 2147483647 ||
    (rawComment !== null && (!comment || comment > 2147483647))
  )
    return;
  if (parts.length === (isPrivate ? 4 : 3) && !positiveId(parts.at(-2))) return;
  return { kind: "post", peer: peer ?? name, id, comment, url: source };
}
