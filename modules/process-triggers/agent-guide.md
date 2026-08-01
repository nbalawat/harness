# process-triggers — build guide

Gives a business-process app its enterprise trigger surface: the ways a process
instance starts. Every trigger creates a work item and starts the process via
`workflow_engine.start`, so the same process runs regardless of how it was kicked
off.

## Endpoints
- `GET /api/triggers` — the trigger catalog (which starts are supported).
- `POST /api/triggers/human/internal` — an employee action (body `{inputs, source}`; identity via `x-user-email`).
- `POST /api/triggers/human/external` — an external client submission (unauthenticated by nature; the process gates decisions).
- `POST /api/triggers/event` — a webhook/message from another system.
- `POST /api/triggers/system` — an internal system event.
- `POST /api/triggers/schedule/tick` — a stub scheduler tick; body `{batch: [ {...}, ... ]}` starts one instance per item.

## Wiring
Compose alongside `workflow-engine`; mount `ext_triggers.router`. Each fired
instance carries `_trigger` and `_source` in its inputs so downstream steps and
the audit trail know how it started. Swap the stub scheduler tick for a real
cron/scheduler in production without touching the process.
