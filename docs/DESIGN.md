# Harness — Certified SDLC Workflow Factory

**Status:** v0 design, consolidated 2026-07-26. All decisions below are locked unless marked open.

## 1. Vision

A platform where a small central team defines and **certifies SDLC workflow types as deterministic DAGs**, and ~50,000 firm users consume them to build thousands of applications. The platform team certifies one project type at a time and releases it; every consumer run inherits the certification guarantee.

**The core promise: "Every time I build it, things should work."** Reliability lives in the certified process, not in each user's prompting skill.

### Project types (current and planned)
1. **agentic-app** (first, laser focus): problem statement → working agentic AI application (UI + backend + agents + data + governance/evals)
2. Data modernization (Medallion / Databricks forward-engineering)
3. App migration (legacy → modern stack)
4. Microservices engagements (GCP)
5. Reverse/forward engineering of data pipelines

## 2. The three planes

| Plane | Who | What |
|---|---|---|
| **Authoring & certification** | Platform team | Author project types + modules; certify via golden runs; publish signed versions |
| **Distribution** | Git registry (v1) | Versioned, immutable, signed packages; runner pulls `name@version` |
| **Execution** | 50k user machines | Runner enforces the DAG deterministically; agents work inside nodes; humans answer typed gates |

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Execution engine | Claude Agent SDK only (v1); spec kept engine-agnostic for later adapters |
| Harness language | **TypeScript monorepo** — one type system from ledger to dashboard |
| HITL surface | Terminal + local web dashboard (DAG progress, question queue, artifact viewer) |
| Cloud | Deploy target only (GCP); harness always runs locally |
| Generated stack (agentic-app) | Next.js/React + FastAPI + Claude Agent SDK agents + Postgres; Docker Compose local; Cloud Run deploy |
| Execution plane | User machines with firm Claude access |
| Trust model | Certified project types are **immutable + parameterized** (consumers supply inputs/answers only) |
| Registry v1 | Internal git repo, signed version tags |
| Distribution | Self-contained binary + self-update (launcher + version manifest); content pulled on demand |
| Near-term milestone | Prove it: one certified project type, 5–20 pilot users |

## 4. Reliability mechanisms (how "works every time" is engineered)

1. **Contracts at every edge** — every node declares input/output artifact contracts (JSON Schema + file manifests). Contract failure → bounded retry with the error fed back → escalate to human. Nothing silently passes.
2. **Executable exit criteria** — a node completes when its *verifier* (tests, boot check, schema validation, eval thresholds) passes. Never model self-assessment.
3. **Templates over generation** — skeletons and module composition are deterministic; agents only fill bounded holes. Less generation = less variance = certifiable.
4. **Pinned everything** — models, prompts, skills, templates, module versions pinned per package version. Certification is against exact pins.
5. **Event-sourced run ledger** — every run is a JSONL journal; state is a pure fold over it. Resume, audit, replay, support-debugging all fall out of one mechanism.

## 5. Runner architecture

**Agent proposes, runner disposes.** The DAG is interpreted by a deterministic scheduler; agents exist only inside node payloads.

### Scheduler (frontier loop)
```
loop:
  ready = nodes whose upstream artifacts are COMMITTED and whose enablement condition is true
  dispatch ready nodes
  await events → append journal → recompute state
until all terminal nodes committed, or run parked on a human gate
```
Node states: `pending → ready → running → validating → verifying → committed`, side exits `retrying`, `escalated`, `failed`, `parked`.

### Node envelope (identical wrapper for every kind)
1. Collect inputs (validated upstream artifacts)
2. Stage fresh `attempts/<node>-<n>/` dir (idempotent, atomic commit)
3. Execute payload (differs by kind — see below)
4. Validate outputs against contract (JSON Schema)
5. Run verifier (executable exit criteria)
6. Commit artifacts + append event

### Node kinds
- **agent** — one hermetic Claude Agent SDK `query()` session: `cwd` = attempt dir, pinned model, allowlisted tools, `settingSources: []`, hooks enforcing workspace boundary. The agent's *only* output channel is writing declared artifacts; final text is a log. Retry-with-feedback via `resume: sessionId`.
- **deterministic** — template render / script / module composition. Zero LLM calls.
- **gate** — typed Q&A or approval. Run parks durably until answered (terminal, web UI, or recorded-answer replay).
- **verifier** — child process; exit code decides completion.

### Dynamic-but-deterministic flow
- **Conditional enablement**: declared predicates over committed artifact fields (evaluated by the runner, never a model).
- **Declared fan-out**: `for_each` over a list in a committed artifact → N instances of a certified node.
- **Iteration**: only bounded retry inside the envelope, or explicit declared revision edges with max-K. Guaranteed termination.

Flow is a pure function of committed data → certification transfers to every run.

## 6. Capability modules (the reuse layer)

**Generated app = certified skeleton + composed certified modules + agent-generated glue.**
Track compose-ratio (% of app from certified modules) as the north-star metric — "compose in minutes" is that ratio approaching the ceiling.

### Module anatomy
```
module/
├── manifest.yaml    # provides / requires / config schema / compat matrix
├── src/             # packaged code
├── compose/         # deterministic integration recipe (never agent-improvised)
├── verify/          # tests that run INSIDE the composed app
└── agent-guide.md   # how build agents USE it (prevents reinvention)
```

### Catalog (28 modules, built in waves — harvest from real apps, rule of three)
- **Wave 1** (with first project type): auth-identity, agent-runtime, chat-shell, rag-pipeline, evals-harness, persistence-core, secrets-config, deploy-gcp
- **Wave 2** (pilot feedback): doc-ingestion, hitl-approvals, guardrails, llm-observability, tool-gateway, forms-intake, jobs-scheduler, file-storage
- **Wave 3** (scale-out): data-connectors, kb-management, structured-data-access, multi-agent-orchestrator, prompt-registry, feedback-capture, governance-reporting, notifications, app-shell-ui, artifact-viewer, caching-rate-limits, audit-log, rbac-permissions

### Crowdsourcing maturity
- **Phase A** (now): platform-team authored only; discover the contract spec from reality
- **Phase B**: contribution funnel; tiers `experimental → community → certified`; only certified modules in certified menus; named owners
- **Phase C**: automated module certification (same golden-run machinery + security scan); platform team approves reports, not code. Curation over accumulation: one blessed default per category.

## 7. First project type: agentic-app v1 (14 nodes)

| # | Node | Kind | Exit criteria |
|---|---|---|---|
| 1 | intake | gate | Problem statement + constraints match input schema |
| 2 | process-analysis | agent → gate | Current/future-state process maps; human approves |
| 3 | requirements | agent → gate | PRD passes contract; human approves |
| 4 | architecture | agent → gate | Module bill-of-materials from certified catalog (constrained menu) |
| 5 | data-design | agent | Schema + seed data validate |
| 6 | agent-design | agent → gate | Agent roster: tools, prompts, HITL points, eval criteria |
| 7 | scaffold | deterministic | Skeleton render + module composition; builds & boots empty |
| 8 | build-backend | agent + verifier | FastAPI tests pass, boots |
| 9 | build-agents | agent + verifier | Eval suite passes thresholds |
| 10 | build-frontend | agent + verifier | Build + Playwright smoke green |
| 11 | integrate | verifier | docker compose up + e2e smoke green |
| 12 | governance-report | deterministic | Eval report, guardrail config, audit summary |
| 13 | uat | gate | User exercises app, approves |
| 14 | deploy (optional) | deterministic + verifier | Containerize → Terraform → Cloud Run → smoke |

## 8. Cost & observability (first-class, enforced)

- **CostRecord per SDK session**: run/node/attempt/session/model + tokens (incl. cache) + `costUsd` computed from a pricing table pinned in the runner release + wall clock + turns. Zero-LLM nodes record `costUsd: 0` explicitly.
- **Budgets enforced in the spec**: manifest carries `run_budget_usd` and per-node budgets; runner interrupts on breach → `escalated` + `BudgetExceeded` event.
- **Three layers, one event stream**: run ledger (per-run truth, powers dashboard/resume/replay) → OpenTelemetry traces (run→node→attempt→session spans, GenAI semconv, OTLP export optional) → fleet telemetry (cost per node, retry rates, gate dwell, escalation reasons — the feedback loop that improves certified workflows).
- **Cost as certification gate**: golden runs record cost envelopes; regressions beyond threshold fail certification in CI.

## 9. Certification pipeline

1. Fixtures: canned problem statements + **recorded human answers** (gate replay)
2. Full unattended DAG runs in CI (replayed gates, real or recorded agents)
3. Per-node contract tests with fixture inputs
4. Artifact diff vs certified golden outputs (structure + key artifacts)
5. Cost envelope check
6. Green → sign + tag → published. Release = git push a signed tag.

## 10. Packaging & distribution

- **One self-contained binary** per platform (bundled Node runtime; contains runner + CLI + dashboard assets + Agent SDK runtime). Internal registry + firm software catalog. `harness login` (SSO → Claude credentials), `harness doctor` (Docker, git checks).
- **Two update planes**: platform (binary, weekly, careful) vs content (project types/modules, as fast as certification allows, pulled at `harness new` — publishing requires shipping nothing).
- **Self-update**: launcher checks a static version-manifest JSON (channels, `rollout_pct`, `min_version`, `killed` list) → background download → signature verify → atomic swap. Staged rollouts watched via fleet telemetry; kill switch heals bad releases.
- **Invariants**: ledger format versioned + migratable (new runner resumes old runs — CI-tested); everything signed (binaries and content).
- v1 distribution plane is entirely static files — no services to operate.

## 11. Roadmap

- **Phase 0 — runner skeleton** *(in progress)*: spec v0, DAG interpreter, journal/resume, node envelope (agent/deterministic/gate/verifier), CLI, 3–4-node demo project type proving the loop end to end. Gate replay via answers file (doubles as certification replay).
- **Phase 1 — agentic-app end-to-end**: 14 nodes, Wave-1 modules, generated-stack templates, web dashboard (read-only → interactive gates), cost metering + budgets.
- **Phase 2 — certification pipeline**: fixtures, replay, golden diffs, cost gates, CI.
- **Phase 3 — registry + pilot**: signed publish, `harness new agentic-app@1.0`, 5–20 pilot users, telemetry phone-home, binary packaging + self-update.

### Deliberate v1 non-goals
Multi-runtime adapters (Codex etc.), module contribution tooling, central execution service, `for_each` fan-out (Phase 1), Temporal-style engine (file/SQLite ledger suffices).

## 12. Repo layout

```
harness/
├── docs/DESIGN.md
├── packages/
│   ├── spec/        # shared types: project-type def, contracts, ledger events, cost records
│   ├── runner/      # scheduler, journal, node envelope, executors, artifact validation
│   ├── cli/         # harness run | resume | status (later: new, login, doctor, publish)
│   └── ui/          # local web dashboard (Phase 1)
├── project-types/
│   └── demo/        # Phase 0 proof: gate → agent → deterministic → verifier
└── modules/         # capability modules (Phase 1+)
```
