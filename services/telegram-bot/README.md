# Raven Telegram bot

"Raven Pack Maker" (`@toravenbot`). People send it Telegram stickers, GIFs and `.gif`
files; `/done` replies with a `.ravenpack` file they import in Raven. It never talks to a
Raven server. The pack format is in `docs/plans/gifs-stickers/README.md`.

Commands: `/start`, `/title <name>`, `/done`, `/cancel`. A sticker from a set offers
"Add this sticker" or "Add the whole pack". Drafts are in memory (24 h idle, or a restart,
clears them). Files are packed as received; the Raven server converts on import.

## Environment

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Bot token. Never logged. |
| `RAVEN_BOT_DATA_DIR` | `/var/lib/raven-bot` | Scratch space for drafts; emptied on start. |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Bot API base URL. |

## Run locally

```
cd services/telegram-bot
TELEGRAM_BOT_TOKEN=... RAVEN_BOT_DATA_DIR=./data go run ./cmd/raven-telegram-bot
go test ./... && go vet ./...
```

The bot long-polls, so it needs no inbound port. Run only one instance per token.

## Deploy (Saye)

The compose file is `infra/homelab/telegram-bot/compose.yaml`; it reads
`TORAVEN_TELEGRAM_BOT_TOKEN` from Saye's environment or `~/services/raven/.env` and maps
it to `TELEGRAM_BOT_TOKEN`.

```
cd ~/services/raven/current/infra/homelab/telegram-bot
docker compose -p raven-telegram-bot --env-file ~/services/raven/.env up -d --build
docker compose -p raven-telegram-bot logs --tail 20
```
