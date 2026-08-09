# Running this app

This app is local-first: one command brings up the whole stack with real
components (FastAPI app, Postgres, Redis).

```bash
docker compose up --build
```

Then open http://localhost:8080 — the process console.

## What's running

| Service | Image | Role |
|---|---|---|
| `app`   | built from `Dockerfile` | the process app: workflow engine, agent orchestration, console |
| `db`    | `postgres:16.4-alpine`  | durable state (event-sourced runs, approvals, audit) |
| `redis` | `redis:7.4-alpine`      | scheduler / cache |

State lives in Postgres because `DATABASE_URL` is set; with no `DATABASE_URL`
(e.g. `uvicorn` straight off the source) the same app runs on an in-memory
store — nothing else changes.

## Live agents

Agents run in a deterministic **stub** by default (offline, no key). For real
agents:

```bash
HARNESS_AGENT_MODE=live-api ANTHROPIC_API_KEY=sk-... docker compose up --build
```

## Going live on integrations

The enterprise systems (CRM/ERP/service-desk) are simulated MCP servers. To use
a real system, edit `integrations.registry.json` and point the connector at a
real MCP server — no application code changes.

## To the cloud

The image is a standard container; the same `Dockerfile` deploys to any
container host. The `cloud-run-deploy` module scripts one such path.
