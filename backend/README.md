# cardrails-api

Rust/Axum API for Card Rails. It serves auth, inventory and catalog endpoints and
applies its SQL migrations itself at start-up.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection string. |
| `CARDRAILS_BIND` | no | `0.0.0.0:8080` | Listen address. |
| `CARDRAILS_ALLOWED_ORIGINS` | no | `https://cardrails.vercel.app` | Comma-separated allowed CORS origins. |
| `CARDRAILS_COOKIE_SECURE` | no | `1` | Set `0` to allow insecure cookies locally. |
| `CARDRAILS_CATALOG_DIR` | no | — | Directory served under `/v1/catalogs`. |
| `RUST_LOG` | no | `info` | `tracing` env filter. |

## Local tests

Tests need a Postgres database. Start the test container:

```sh
docker run -d --name cardrails-postgres-test \
  -e POSTGRES_USER=cardrails_test -e POSTGRES_PASSWORD=cardrails_test \
  -e POSTGRES_DB=cardrails_test -p 127.0.0.1:25437:5432 postgres:17-alpine
```

Then run the suite (override the URL with `TEST_DATABASE_URL` if needed):

```sh
TEST_DATABASE_URL=postgres://cardrails_test:cardrails_test@127.0.0.1:25437/cardrails_test \
  cargo test
```

## Migrations

The API applies migrations on start-up. To apply them by hand against the
running Postgres container, use `scripts/migrate.sh`.

## Deploy

From this directory on nezopt:

```sh
docker build -t cardrails-api:latest .
docker compose -p cardrails -f deploy/compose.yml up -d --force-recreate cardrails-api
```

`scripts/deploy.sh` builds with the current git short SHA, recreates the
service, waits up to 30 s for `http://127.0.0.1:18200/healthz`, and rolls back
to the previous image on failure.

The API is published at <https://cardrails-api.pokoin.com> via the Cloudflare
tunnel `cardrails-api-nez`, which forwards to `127.0.0.1:18200`.
