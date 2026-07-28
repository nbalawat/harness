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

## 7. First project type: agentic-app v1.1

| # | Node | Kind | Exit criteria |
|---|---|---|---|
| 1 | intake | gate | Problem statement + **dropped files** (PDF/docx/HTML/images/spreadsheets) captured |
| 2 | ingest | agent | **Evidence corpus**: normalized extraction per source (vision for diagrams) + provenance index |
| 3 | requirements-synthesis | agent | Draft requirements; every item carries provenance + confidence (`stated`/`inferred`/`unknown`) |
| 4 | gap-questions | agent → gate | Only materially-branching gaps become questions; **question budget enforced**; defaults pre-filled |
| 5 | architecture | agent → gate | Module bill-of-materials from certified catalog + **build-budget plan** vs cost envelope |
| 6 | design-options | agent → gate | **3–4 distinct BUILDABLE app shells** (canonical mount points enforced by design-check), identical screen coverage; human picks; the chosen option's full shell ships verbatim as the app frontend (design sanctity) |
| 7 | data-design | agent | Schema + seed data validate |
| 8 | agent-design | agent → gate | Agent roster: tools, prompts, HITL points, eval criteria |
| 8b | traceability | deterministic | **RTM**: every non-unknown requirement joined to the design elements addressing it (`addresses` declarations on modules/tables/agents/design options); unaddressed requirement -> pipeline blocks |
| 8c | design-review | gate | **User confirms the requirements->design mapping + all assumptions (defaulted answers, inferences) before any build spend** |
| 9 | scaffold | deterministic | Skeleton render + module composition + **test harness first**; builds & boots empty |
| 10 | slice-plan | agent | 1–6 **vertical slices** derived from requirements: each an end-to-end user capability with executable HTTP acceptance; every slice traces to requirement IDs |
| 11 | slice-1..N | agent + verify | Each slice delivers its feature across all layers; **cumulative acceptance** (this slice + all prior) + backend tests run inside the retry loop; each commit is a launchable app — the user watches features appear |
| 13 | integrate | verifier | docker compose up + e2e smoke green |
| 14 | security-scan | verifier | Deterministic scanners: semgrep, osv/dep audit, gitleaks, trivy — findings above pinned severity block |
| 15 | governance-report | deterministic | Eval report, guardrail config, **security evidence pack vs pinned standards profile** (e.g. OWASP ASVS L2) |
| 16 | uat | gate | User exercises app, approves |
| 17 | deploy (optional) | deterministic + verifier | Containerize → Terraform → Cloud Run → smoke |

### 7b. The six hard problems (named 2026-07-26) and where they're solved

| Challenge | Design answer |
|---|---|
| **(a) Heterogeneous requirements input** | Nodes 1–3: drop zone → deterministic converters + agent semantic extraction → evidence corpus with provenance index. Contract: no requirement without provenance or an explicit assumption flag. |
| **(b) No superfluous questions** | Node 4: questions only for gaps that materially branch the build. **Question budgets in the spec, enforced by the runner like cost budgets** (max N per gate, max M gates). Every question has a default + "why we ask"; one-click accept-defaults. Consolidated confirmation happens ONCE at design-review (RTM + assumptions), not scattered across stages. Questions-per-run and gate dwell are certified fleet metrics — nagging is a regression. **Mid-node questions are structurally impossible**: the runner's `canUseTool` interceptor denies the Agent SDK's AskUserQuestion tool with "state an assumption" guidance (journaled as `agent.question_denied` for telemetry) — the gap-questions gate is the only question channel. |
| **(c) 3–4 approvable UI designs** | Node 6 (team of 4 design-director subagents in parallel, one per aesthetic; lead verifies + indexes): each option is a buildable application shell (not a mockup) with canonical mount points (`#messages`, `#composer`, `#screen-*`, `#agents-list`) verified by design-check; scaffold copies the CHOSEN shell verbatim into the app and chat-shell wires behavior onto it; verify-slice fails any slice that breaks the shell — what you chose is what ships. |
| **(d) Module mapping + small build budgets** | Node 5: BOM restricted to certified catalog + build-budget plan validated against the envelope. Modules carry glue-cost priors from fleet telemetry. Compose-ratio is the structural budget lever. |
| **(e) Build & validate** | Validation pyramid: contract → unit → module verify-in-situ → integration smoke → eval thresholds → UAT. Test harness generated before agents build. Machine-readable verification reports per build node. |
| **(f) Security to robust standards** | Security-critical code composed from certified modules (never hand-rolled); secure defaults baked into scaffold; node 14 deterministic scanner gate (zero LLM cost); pinned standards profile → auto-generated evidence pack in node 15. Scanners also run against golden outputs in certification. |

### 7c. Revision & feedback loops (2026-07-26)

Artifacts are immutable, but decisions are not final: feedback re-enters the pipeline at the artifact it semantically belongs to, and the dependency closure re-derives everything downstream — never an in-place edit.

- **`harness revise <ws> <node> --feedback "…"`** (or the dashboard drawer's "Request changes"): appends `node.reopened {reason: user_revision}` for the node + its downstream closure; feedback is delivered through the node's `feedback.md` channel with a pointer to the prior committed output ("apply ONLY the requested changes"). A revised gate drops its recorded dashboard answer so it genuinely re-asks.
- **Slice feedback** (dashboard "Request a change to the app"): triaged by the user into (a) *fix a slice* — requirements unchanged, the slice re-runs with the correction; or (b) *new/changed requirement* — recorded as a change request (`change-requests/cr-N.json`), appended to requirements with provenance `{source: user-feedback, claim: CR-n}`, then traceability re-verifies coverage and the plan/build re-derive. Requirements stay the single source of truth.
- **Memoization**: every commit records an `inputsHash` (resolved inputs incl. referenced file/dir bytes + prompt + params + model + commands). A cascaded reopen whose inputs are unchanged re-commits from cache (`cached: true`, $0) — the cost of a revision is proportional to its blast radius, not the DAG size. Direct user-revision targets are never memoized.
- **Budgets under revision**: per-node budgets apply per incarnation (reset at reopen); the run envelope stays the hard total cap and includes revision headroom.

## 8. Cost & observability (first-class, enforced)

- **CostRecord per SDK session**: run/node/attempt/session/model + tokens (incl. cache) + `costUsd` computed from a pricing table pinned in the runner release + wall clock + turns. Zero-LLM nodes record `costUsd: 0` explicitly.
- **Budgets enforced in the spec**: manifest carries `run_budget_usd` and per-node budgets; runner interrupts on breach → `escalated` + `BudgetExceeded` event.
- **Three layers, one event stream**: run ledger (per-run truth, powers dashboard/resume/replay) → OpenTelemetry traces (run→node→attempt→session spans, GenAI semconv, OTLP export optional) → fleet telemetry (cost per node, retry rates, gate dwell, escalation reasons — the feedback loop that improves certified workflows).
- **Cost as certification gate**: golden runs record cost envelopes; regressions beyond threshold fail certification in CI.

## 9. Certification pipeline

**Shipped (2026-07-27): `harness certify <dir> [--update-golden]`** — static completeness (mocks/prompts/schemas/referenced scripts), golden scenario replays (every fixtures/answers*.json) with per-file artifact digests (workspace-normalized, renderer output excluded), cost-envelope enforcement, and a revision drill (declared in dag `certification.revision_drill`) proving feedback→cascade→memoization. Green cert writes `certification.json` (package digest = release record). First use caught real nondeterminism (pytest timing in an artifact).


1. Fixtures: canned problem statements + **recorded human answers** (gate replay)
2. Full unattended DAG runs in CI (replayed gates, real or recorded agents)
3. Per-node contract tests with fixture inputs
4. Artifact diff vs certified golden outputs (structure + key artifacts)
5. Cost envelope check
6. Green → sign + tag → published. Release = git push a signed tag.

## 10. Packaging & distribution

**Shipped (2026-07-27): registry v1** — `harness install <name>@<version> --registry <git-url>` clones the signed tag, recomputes the package digest against certification.json (tamper-proof; uncertified refused), stores the full tree (project type + certified modules) under `~/.harness/store` (HARNESS_HOME override), `harness list` shows installs, `harness run name@version` resolves from the store. **Shipped: distribution + pilot telemetry** — `npm run bundle` produces a single self-contained `dist-bundle/harness.cjs` (~640 KB, node>=20). The Claude Agent SDK is the harness's EXECUTION ENGINE — integral, not optional: it isn't compiled into the bundle (it ships its own runtime assets), so `harness setup --install-sdk` provisions it into `$HARNESS_HOME/runtime`, and engine resolution is pinned+layered (HARNESS_SDK_DIR → module lookup → runtime dir). `harness setup` is the pilot preflight: node/git/uv/docker/engine/auth in one report. Mock mode exists solely so certification replay is deterministic; `harness self-update --registry <git-url>` rebuilds the bundle from the registry and swaps itself (with .bak); local-first telemetry appends per-run summaries (type, status, cost, mock/live) to `$HARNESS_HOME/telemetry.jsonl` (`harness telemetry` aggregates; HARNESS_TELEMETRY=0 opts out). CI re-certifies every project type on every push. Remaining for pilot: distribute the bundle + registry URL to 5-20 users.


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
