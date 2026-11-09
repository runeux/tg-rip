# tg-rip

save media from telegram posts, stories, and timed messages through your own bot.

- **post or story:** paste a telegram link. the bot returns the media with a **source** link and removes your original message after delivery. albums stay together.
- **timed media:** send the chat id. pick an attachment by date. telegram must still expose the original file to your user session. view-once support is experimental.

## setup

1. set the bot token, telegram app credentials, owner user id, and webhook settings in `.env` using [the example](.env.example).
2. route the https webhook path to port `8793` on loopback. keep the webhook secret private.
3. build with bun and start the service with docker compose. on linux, create `state/` writable by the container user (uid 1000).

```sh
bun install --frozen-lockfile
bun run build
docker compose up -d --build --wait
```

## connect your telegram account

the bot token receives requests and sends results. the user session reads the original chats. run the sign-in once from an interactive terminal, then scan the qr in **settings → devices → link desktop device**.

```sh
docker compose stop app
docker compose run --rm --no-deps app bun dist/login.js
docker compose up -d --wait
```

the session lives in `state/`. a copied session grants access to the account, so keep it alongside your private configuration. the hosted bot api accepts uploads up to 50 mb per file.

## checks

```sh
bun run lint
bun run typecheck
bun test
bun run build
```
