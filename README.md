# NewsCraft Agent UI

SvelteKit app for `agent.newscraftai.com`, backed by the local Hermes gateway.

## Local Development

```sh
pnpm install
pnpm dev
```

## Production Deploy

From this repo, run:

```sh
pnpm deploy:agent
```

That command runs `/home/jigar/deploy-hermes-ui.sh --deploy`, which installs dependencies, builds the SvelteKit node server, starts/restarts `hermes-ui.service` on `127.0.0.1:3001`, checks `/api/health`, and then cuts Caddy over to `https://agent.newscraftai.com`.

Required `.env` values:

```sh
HERMES_API_KEY=
APP_PASSWORD_HASH=
APP_SESSION_SECRET=
```

For a production build without cutover:

```sh
pnpm build
pnpm start
```
