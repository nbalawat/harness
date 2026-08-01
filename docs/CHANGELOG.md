# Changelog — what was developed, in order, and why

The development record of the platform and the first certified project type.
Dates are build dates; every entry shipped with its tests green and was pushed
to https://github.com/nbalawat/harness.

## Platform

### Parallel slice builds + deterministic merge — engine concurrency, agentic-app 0.12.0 (2026-08-01)
Why: journal analysis of the live underwriting build showed a clean slice
takes ~25-30 min but slices ran strictly sequentially, review windows burned
a fixed 5 minutes each even when nobody intervened, and one oversized slice
predictably died of turn exhaustion twice. Wall-clock is now max(slice), not
sum(slices):
- **Engine concurrency** — the frontier loop executes all dependency-ready
  non-gate nodes in parallel (bounded pool; `concurrency:` in the DAG,
  `HARNESS_CONCURRENCY` override; gates stay sequential). Deterministic
  because every node's inputs are sealed before its round; a failing sibling
  never strands the others (finished work still commits). `runCommand` is
  async now — a 10-minute verify no longer freezes concurrent agent sessions.
- **Parallel slices** — slice-1 is the foundation; slices 2..6 depend only on
  it, build concurrently in isolated attempt trees, and verify foundation +
  self. `merge-slices` (deterministic) unions the trees: line-level three-way
  merge against the foundation (git merge-file), SLICES.md append-only
  concatenation, binary/delete/same-line collisions FAIL LOUDLY with
  repartition guidance — never LLM-resolved. `verify-merged` then re-proves
  EVERY slice's acceptance + the full test suite against the union.
- **Slice sizing enforced at plan time** — `check-slice-plan` rejects a slice
  covering >3 screens or >40 interactive elements before any build spend
  (the $41 slice-1 failure mode, killed at the source).
- **Design options in parallel** — `screen-inventory` (haiku) derives the
  shared screen list once; three `design-option-N` nodes (opus, distinct
  committed directions) run concurrently; `design-assemble` (deterministic)
  collects them into the comparable set design-check always enforced. ~24 min
  → roughly the cost of one option.
- **One post-merge audit instead of 2 reviewers × N slices** — `slice-audit`
  (read-only sonnet) sweeps the merged app for contract + FSI-hardening
  violations once; findings land in governance (`code_audit`). Slice agents
  lose the Task tool and the in-session review mandate.
- **Windows that don't waste time** — review windows 300s → 90s; `when.all`
  conjunctions kill phantom checkpoints (a review gate now requires its slice
  to exist in the plan, not just every-slice supervision); the auto-driver
  resumes detached instead of spawnSync (which had blocked its own polling
  loop — the reason a live window once expired unanswered).
42 nodes; goldens re-certified byte-deterministic (three scenarios + revision
drill, 5 cached re-uses); 136/136 tests including engine-concurrency,
merge-conflict, ledger-rewrite, and oversized-slice negatives.

### Design delivery is now an enforced promise — agentic-app 0.10.0 (2026-07-30)
The gap: users approved a rich multi-screen design, then couldn't tell how
much of it actually got built; slice screenshots looked identical. Now the
chosen design is an enforceable contract: `design-contract` (deterministic)
inventories every screen + interactive element of the approved option; the
slice plan must assign every screen to a slice (`covers`, rejected otherwise);
each slice's demo is REQUIRED, must target a screen the slice covers, and its
screenshot must differ from every previous slice's (byte-identical = failed
slice, no composite fallback); covered screens can never disappear from the
shell; and a final `design-coverage` node boots the finished app, verifies
every promised screen + element is live, and screenshots each screen — any
missing screen fails the build before UAT. Dashboard: "Design delivery" panel
(promised vs live, per-screen chips, delivered-in-slice attribution, live
shots). 36 nodes; goldens re-certified byte-deterministic.


### Review windows, intake uploads, npm distribution (2026-07-28)
**Review windows** — the middle band between "waits for everything" and
"waits for nothing": a gate with `window: <seconds>` and all-defaulted
questions doesn't park; the run waits in-process, polling the dashboard's
answer file, then proceeds on defaults with provenance `"window"`
(`gate.window_open` journal event; countdown banner + decide-now form in the
dashboard; `/api/answer` no longer spawns a second runner while the run is
live). `every-slice` supervision checkpoints now carry `window: 300`.
**Intake uploads** — documents are uploaded in the intake form itself
(`/api/upload`, stored under the run's `inputs/`, path auto-filled;
traversal-safe). **npm distribution** — `npm run pack` assembles
`@nbalawat/harness`: the engine bundle plus the certified catalog
(project-types, modules, mcp) in repo layout, so onboarding is
`npm install -g` + `harness ui` from any folder (packaged-catalog discovery
in the storefront; `harness ui` defaults to the current directory). Dashboard
content column centered. agentic-app re-certified at 0.9.0.


### Phase 0 — the execution core (2026-07-26)
TypeScript monorepo (`spec` / `runner` / `cli`). Deterministic frontier
scheduler; event-sourced JSONL journal with park/resume; the node envelope
(inputs → attempt → validate → verify → commit) with retry-with-feedback and
model escalation; ajv artifact contracts; per-attempt cost attribution and
budget enforcement; 4-node demo project type; CI.

### Phase 1 — agentic-app end to end (2026-07-26)
The 27-node pipeline: evidence-tracked ingest, requirements with provenance
(stated/inferred/unknown), budgeted gap questions, module-composing
architecture, comparable design options, RTM traceability that blocks
uncovered requirements, vertical slices with cumulative acceptance, real
verifiers (pytest, agent evals, docker smoke), language-aware security scan,
governance evidence, conditional Cloud Run deploy. Wave-1 modules
(persistence-core, agent-runtime, chat-shell). Dashboard v1–v5 grew here:
storefront, tabs, step inspector, decisions, documents, watch-it-grow
screenshots, AskUserQuestion bridge, run-mode pill.

### Revision machinery (2026-07-26)
`node.reopened` cascade (forgets committed/skipped state downstream),
`harness revise` + dashboard "Request changes" with impact preview, slice
feedback triage (fix-slice vs new-requirement change requests with
provenance), input-hash **memoization** (unchanged steps re-commit at $0),
per-incarnation node budgets.

### Phase 2 — certification pipeline (2026-07-27)
`harness certify`: static completeness, golden-scenario replays with
**byte-level per-file artifact digests** (caught real nondeterminism on first
use — pytest timings), cost-envelope enforcement, revision drill,
`certification.json` release records with package digests.

### Phase 3 — registry, distribution, pilot (2026-07-27)
Registry v1 (git tags + digest tamper-check on install; `run name@version`
from the store), per-run DAG snapshot pinning, single-file bundle (esbuild,
~650 KB), `self-update`, local-first telemetry, `harness setup` preflight with
layered engine resolution (`HARNESS_SDK_DIR` → module lookup →
`$HARNESS_HOME/runtime`).

### The module program (2026-07-27)
The catalog defined (docs/MODULES.md, ~100 modules with per-module rationale),
then **fully built: 101/101 certified** across 12 domains. `ext_*.py`
auto-mount extension point; three module kinds (app/tool/pack);
`harness certify-modules` (per-module tests against a real composed app,
transitive dep composition); the **mega-compose proof** (all app modules in
one booted application); `catalog.json` for the architecture agent;
`module-sdk` scaffolder; compat-matrix; deprecation path. Module tests caught
three real bugs during the build.

### SDK depth (2026-07-27)
**Subagent teams** declared in the certified DAG (validated: `Task` tool
required, well-formed definitions). **Certified skills** staged from the
package into session project settings (`Skill` tool required) — hermeticity
holds because the bytes are in the package digest. **MCP capability layer**:
declared instances + per-tool allowlists + stdio-only launch + config schema
validation; `@harness/app-sandbox` platform server; `new-mcp`/`certify-mcp`
authoring loop. Each proven live for pennies before shipping.

### Documentation (2026-07-27)
Role-based guides (building an app, authoring project types, authoring
modules, versioning & releases, reporting bugs, reference), MODULES.md,
CAPABILITIES.md, this changelog.

## agentic-app (the first certified project type)

| Version | What it added | Why |
|---|---|---|
| **0.3.0** | Vertical slices, per-slice screenshots, model tiering, question budgets | "see the app evolving, not horizontals" |
| **0.4.0** | **Design sanctity**: options are buildable shells; the chosen one ships verbatim as the frontend; `/agents` roster endpoint + in-app agents panel; revision machinery wired; design-options budget recalibrated ($4→$12 — real run data) | "the design chosen and the screenshots don't resemble"; "what agents are configured is not clear" |
| **0.5.0** | Module extension point (`ext_*.py`); architecture selects from the certified Wave-2 catalog; template `/agents` test | the module program begins |
| **0.6.0** | Full catalog via `catalog.json` (88 app modules + 6 packs) with selection rules (packs first, deps must be selected) | catalog scale outgrew inline prompt lists |
| **0.7.0** | Subagent teams (4 parallel design directors; read-only slice-reviewer) + certified `app-conventions` skill | independent design aesthetics; cheap review before expensive verification |
| **0.9.x** | **Framework adapters**: agent-runtime-langgraph, agent-runtime-adk, and agent-runtime-strands (same contract, real framework execution, behavioral-parity evals, conflict-enforced single runtime); framework mandates flow from the problem statement through architecture to a certified golden (LangGraph) and pipeline test (ADK); module `app_deps` join the app's requirements; dependency-resolution honesty fixes (ranged base pins, framework floors — caught google-adk 0.0.1 placeholder fallback) | "enable LangGraph and ADK and test in detail" |
| **0.9.0** | **The app-workflow layer**: new `workflow-design` node (agent, verified by check-workflows, traced into the RTM, user-approved at design review) + the `workflow-engine` module (event-sourced deterministic workflows with agent/human/condition nodes, park/resume via approval-flow, contracts, audit) composed into apps; architecture schema enum now generated from the catalog | "apps will have a deterministic workflow layer, just like the DAG — some nodes agentic" |
| **0.8.0** | `app-sandbox` MCP instance on all slice nodes; build prompt mandates structured probes over hand-rolled shell | a probe costs nothing; a failed verification costs a boot cycle and a retry |

Each version was re-certified (byte-deterministic goldens, cost envelope,
revision drill) before the number existed. Live validation runs:
live-copilot (0.3.0, $16.45), live-copilot-2 (0.4.0, $22.78 + $1.04 live
revision). 0.5.0–0.8.0 carry the same golden digests for unchanged artifacts —
their changes are capability, not behavior drift.

## Lessons the code now enforces (learned the hard way)

1. **Template-literal escaping** broke the dashboard three times → the served
   page's scripts are now syntax-checked by a regression test.
2. **Artifacts must be byte-deterministic** → the digest check exists because
   pytest timings leaked into a report on certification's first run.
3. **Budgets are per-scope-of-work** → a legitimate revision busted an
   all-time node budget; budgets are now per incarnation.
4. **Capability follows scope** → the $4 design budget was right for sketches
   and wrong for buildable shells; budgets are recalibrated from run data.
5. **"Optional" framing hides product gaps** → the SDK is the engine;
   `harness setup` provisions and verifies it instead of failing mid-run.
6. **Screenshots must show state, not structure** → slice screenshots
   exercise the app and reveal all screens before capture.
7. **Hermeticity is about *sources*, not features** → skills/subagents/MCP
   are all fine when their bytes ship inside the certified digest.
