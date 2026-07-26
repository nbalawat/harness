# Harness — Certified SDLC Workflow Factory

Deterministic DAG runner + certified project types. A small team certifies
workflow types; consumers run them and get working applications. Design:
[docs/DESIGN.md](docs/DESIGN.md).

## Setup (once)

```sh
npm install && npm run build
npm test                # full regression suite (44 tests)
```

Requires: Node 22+, python3, [uv](https://docs.astral.sh/uv/). Optional: Docker
(compose validation + boot smoke).

## Experience the agentic-app factory

### 1. Certified replay — watch the whole factory run

```sh
node packages/cli/dist/index.js run project-types/agentic-app \
  --workspace my-run \
  --answers project-types/agentic-app/fixtures/answers.json \
  --mock-agents
```

21 nodes: documents → evidence corpus → requirements with provenance → budgeted
questions → architecture + build-budget check → 3 comparable design options →
module composition → build → real tests/evals → security scan → governance
evidence pack. Add `HARNESS_SMOKE_DOCKER=1` before the command to also build +
boot the containers and smoke-test /chat through nginx.

### 2. Answer the gates yourself (interactive)

```sh
node packages/cli/dist/index.js run project-types/agentic-app \
  --workspace my-interactive-run --mock-agents
```

You'll be prompted for the intake questions in the terminal (point
`documents_dir` at `project-types/agentic-app/fixtures/sample-docs`, or your own
folder of .md/.html docs). Gap questions auto-answer from defaults — that's the
no-nagging policy. Kill it mid-run and `resume` to see durable parking:

```sh
node packages/cli/dist/index.js resume my-interactive-run
node packages/cli/dist/index.js status my-interactive-run
```

### 2b. Watch it in the browser

```sh
node packages/cli/dist/index.js ui my-run --port 4400
# open http://localhost:4400
```

Live DAG progress with per-node cost, event feed, artifact browser, the design
gallery rendered inline, and gate forms — a parked run can be answered and
resumed from the browser.

### 3. Explore what it produced

```sh
cat my-run/journal.jsonl | head -40      # the event-sourced ledger (every state change + cost)
open my-run/artifacts/design-options/designs/option-2/index.html   # clickable design previews
cat my-run/artifacts/requirements-synthesis/requirements.json      # provenance per requirement
cat my-run/artifacts/security-scan/security_report.json
cat my-run/artifacts/governance-report/governance.json             # the evidence pack
```

### 4. Run the generated application

No Docker (single process):

```sh
cd my-run/artifacts/build-frontend/app/backend
uv run --with fastapi --with uvicorn uvicorn dev:app --port 8000
# open http://localhost:8000 — chat with the composed agent
```

Full stack with Docker:

```sh
cd my-run/artifacts/build-frontend/app
docker compose up --build
# frontend http://localhost:8080, backend http://localhost:8000/health
```

### 5. Real agents instead of mocks

Drop `--mock-agents` (needs `@anthropic-ai/claude-agent-sdk`, installed in this
repo, and Claude credentials). Agent nodes run real hermetic Claude sessions;
cost is captured per node in the journal and enforced against the envelope in
`project-types/agentic-app/dag.yaml`.

### 6. Cloud deploy path

```sh
node packages/cli/dist/index.js run project-types/agentic-app \
  --workspace my-cr-run \
  --answers project-types/agentic-app/fixtures/answers-cloudrun.json --mock-agents
cat my-cr-run/artifacts/deploy/deploy/plan.md
```

## Layout

```
packages/spec      shared types (contracts, ledger events, cost envelope)
packages/runner    scheduler, journal, node envelope, budget enforcement
packages/cli       harness run | resume | status
modules/           certified capability modules composed into generated apps
project-types/     demo (4-node) and agentic-app (21-node) certified DAGs
```
