# runtime-compose

The local-first **runtime base** for a produced process app. Overlaying this
module drops a `Dockerfile` and `docker-compose.yml` at the app root so the app
runs as a real stack, not just a dev server:

```bash
docker compose up --build   # → http://localhost:8080
```

## What it composes

- **`app`** — the produced FastAPI app. The image is multi-stage: a pinned
  `python:3.12.8-slim` with the pinned Node binary copied in, because the
  simulated enterprise MCP servers are zero-dependency Node ESM (the binary is
  all they need — no npm, no `node_modules`). Runs non-root.
- **`db`** — `postgres:16.4-alpine`. State is durable because compose sets
  `DATABASE_URL`; the `persistence-core` store detects it and serves the same
  `insert/list` contract via `postgres-adapter`'s `PgStore`.
- **`redis`** — `redis:7.4-alpine` for the scheduler/cache.

## The local → production promise

The store swap is a **compose choice, not a rewrite**. With no `DATABASE_URL`
(bare `uvicorn`, tests, certification) the app runs in-memory; with it, the same
app is on Postgres. The image is a standard container, so the same `Dockerfile`
deploys to any container host (see `cloud-run-deploy`).

## Requires

- `postgres-adapter` — provides `pg_store.PgStore`.
- `persistence-core` — its `store` is `DATABASE_URL`-aware.
- The app's `requirements.txt` must include `psycopg[binary]` (the scaffold adds
  it when this runtime is composed).

## Do not

- Do not add `:latest` image tags or a root `USER` — the image is intentionally
  pinned and non-root.
- Do not hand-roll a second storage path; everything goes through `db.store`.
