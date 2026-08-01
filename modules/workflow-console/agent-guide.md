# workflow-console — build guide

This module gives a business-process app its operator + domain surface. It reads
the process the workflow-engine runs and renders it: the step graph, every work
item flowing through it, each step's live state and output, and the decision
panels at human steps. It is generic — it never hard-codes a domain.

## What it provides
- `GET /api/process` — the process definition: steps with `id`, `kind`
  (agent / human / deterministic / condition), label, and `deps`.
- `GET /api/process/runs` — every work item with status + progress counts.
- `POST /api/process/runs` — start a work item: body `{inputs: {...}}`. The
  inputs reach the process's intake step.
- `GET /api/process/runs/{run_id}` — full run: per-step state
  (done / waiting / pending / skipped) and each step's output; advances any
  steps that became ready.
- `POST /api/process/runs/{run_id}/decide` — approve/reject the waiting human
  step: body `{approve: bool, by, reason}`.
- Frontend (`index.html` + `app.js`): the console UI. Serve it from `/` and
  `/app.js`.

## How a slice wires it
1. Compose `workflow-engine` (the process) + `workflow-console` (this).
2. Register the deterministic step handlers with `workflow_engine.register_handler`.
3. Mount `ext_console.router`; serve the frontend files.
The console then runs and displays whatever process `workflow-design` produced —
no per-domain UI code. The domain shows through the process's own step labels
and the agents' outputs.

## Contracts
- Every step's `output` for an agent step is `{reply: ...}`; the console shows
  `reply` (or `summary`). Deterministic steps show their fields.
- Human steps park via approval-flow; the console surfaces the rendered
  `question` and posts the decision back.
