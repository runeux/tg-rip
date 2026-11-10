# tg-rip

save media from telegram posts, stories, and timed messages through your own bot.

- **post or story:** paste a telegram link. the bot returns the media with a **source** link and removes your original message after delivery. albums stay together. a status message shows transfer progress and disappears after delivery.
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

the bot token receives requests and sends results. the user session reads the original chats. run the sign-in once from an interactive terminal, then scan the qr in **settings → devices → link desktop device**. the qr refreshes when it expires. if telegram asks for 2fa, enter your password at the hidden prompt.

```sh
docker compose stop app
docker compose run --rm --no-deps app bun dist/login.js
docker compose up -d --wait
```

for ssh or agent-assisted login, add `--qr-image`. the command prints the current gif path and expiry each time telegram refreshes the qr. keep the command running while you scan it. with docker, give the login container a name so the agent can copy the current image out with `docker cp` and display it in chat.

```sh
docker compose run --rm --no-deps --name tg-rip-login app bun dist/login.js --qr-image
# in another shell, use the path printed by the login command
docker cp tg-rip-login:/tmp/tg-rip-qr-XXXXXX/telegram-qr.gif ./telegram-qr.gif
```

for a checkout without docker, use `bun run login --qr-image` and copy the printed file directly. the password prompt stays in the login process, and the temporary image is removed when login finishes.

the session lives in `state/`. a copied session grants access to the account, so keep it alongside your private configuration. the bot uploads over mtproto. files up to 2 gb are supported.

## checks

```sh
bun run lint
bun run typecheck
bun test
bun run build
```
