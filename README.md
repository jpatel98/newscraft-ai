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

For normal app code updates after cutover, use the faster reload path:

```sh
pnpm reload:agent
```

That builds, restarts `hermes-ui.service`, and verifies `/api/health` on `127.0.0.1:3001`.

Required `.env` values:

```sh
HERMES_API_KEY=
APP_SESSION_SECRET=
```

`APP_PASSWORD_HASH` is now optional. When present and no accounts exist yet, the
first-account setup page requires that legacy password before creating the first
email/password account.

For a production build without cutover:

```sh
pnpm build
pnpm start
```
