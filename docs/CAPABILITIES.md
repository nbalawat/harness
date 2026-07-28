# Capabilities inventory — everything the harness does today

One page, current as of 2026-07-27. Each claim here is backed by the 94-test
regression suite, per-layer certification in CI, or a recorded live proof.
Role-specific how-tos live in [guides/](README.md); rationale in [DESIGN.md](DESIGN.md).

## 1. The execution core (runner)

- **Deterministic frontier scheduler** over a certified DAG — no model
  anywhere in the control plane. Four node kinds: `agent`, `deterministic`,
  `verifier`, `gate`.
- **Node envelope**, identical for every node: inputs from dependency
  artifacts → staged attempt dir → payload → **JSON-Schema contract
  validation** → per-node `verify` command (executable exit criteria) →
  commit. Retry-with-feedback (`feedback.md`) with **model escalation**.
- **Event-sourced journal** (`journal.jsonl`): state is a pure fold; park at
  gates and resume anywhere; failed nodes reopen on resume; attempt numbering
  survives reopens.
- **Conditional flow**: `when` clauses (equals/exists over artifact data)
  drive skipping and data-driven fan-out (the slice nodes).
- **Cost discipline**: per-attempt cost records (tokens + USD from the
  engine), per-node budgets enforced **per incarnation**, a run envelope
  enforced pre-dispatch, question budgets on gates (user attention is
  budgeted like dollars).

## 2. The engine and its depth (Claude Agent SDK)

- The SDK is the **execution engine** — every agent node is a hermetic
  `query()` session (cwd = attempt dir, `settingSources` never includes user
  machines, explicit tool allowlists). Layered resolution:
  `HARNESS_SDK_DIR` pin → module lookup → `$HARNESS_HOME/runtime`
  (provisioned by `harness setup --install-sdk`).
- **Subagent teams** — declared per node in the DAG (`agents:`), certified
  data. In use: design-options runs four parallel *design directors* (one per
  aesthetic); every slice node carries a read-only *slice-reviewer*. A team
  without the `Task` tool is a load error.
- **Certified skills** — `skills/<name>/SKILL.md` in the package, staged by
  the envelope into the session's project settings. In use: `app-conventions`
  (the composed-app law) is every slice builder's first load. Skills without
  the `Skill` tool: load error.
- **MCP capability servers** — package-level instances (`mcp:` = server ref +
  type config), node-level attachment with per-tool allowlists
  (`mcp__<name>__<tool>`). Stdio-only, harness-launched, config validated
  against the server's schema at certification. In use:
  `@harness/app-sandbox` (start_app / request / logs / run_tests / stop_app)
  on all slice nodes. Authoring: `harness new-mcp` scaffolds a server that
  passes `harness certify-mcp` immediately.
- **AskUserQuestion bridge** — mid-step agent questions surface in the
  dashboard, answers flow back into the running session; unattended runs
  proceed on recorded assumptions. All journaled.

## 3. Human interaction

- **Gates** park runs durably; defaults are *confirmed*, not silently
  applied (`--accept-defaults` for unattended runs); answers recorded with
  provenance (recorded / default / human).
- **Dashboard** (`harness ui`): storefront of all built apps + one-click
  "Build a new app" (parks at intake, Q&A in the browser); phase-grouped
  pipeline; per-step drawer (what it runs, exit criteria, results parsed from
  its artifacts, prompt, transcript, tool counts, session capabilities incl.
  subagents); documents with in-modal raw view; decisions & assumptions;
  quality card (tests/evals/security/coverage/slices); per-slice full-page
  screenshots showing real data state; design gallery with locked choice;
  "Your app's agents" roster card; live-vs-replay pill; launch-the-app panel.

## 4. Revision & feedback (change without drift)

- `harness revise <ws> <node> --feedback "..."` and the dashboard's
  "Request changes" (with impact preview): reopens the node + downstream
  closure; feedback delivered via the same `feedback.md` channel; revised
  gates re-ask; journal keeps full history.
- **Slice feedback triage**: *fix a slice* (requirements untouched) vs *new
  requirement* (recorded as CR-n, appended to requirements with provenance,
  RTM re-verified, plan/build re-derived).
- **Memoization**: commits record an inputs hash (inputs + file/dir bytes +
  prompt + params + model + commands); cascaded reopens with unchanged inputs
  re-commit from cache at $0 — revision cost ∝ blast radius. Proven live:
  a real revision cycle cost $1.04 with the UAT step served from cache.

## 5. The module catalog (the reuse layer)

**101 certified modules** across 12 domains — persistence (10), identity (7),
agent-runtime plumbing (12), ingestion (8), workflow (10), integration (10),
frontend (10), observability (8), security (7), deployment (6), 6 domain
packs, 3 meta modules. Full list with per-module rationale:
[MODULES.md](MODULES.md).

- Three kinds: **app** (compose overlay + `ext_*.py` auto-mount extension
  point), **tool** (checkers/generators), **pack** (curated bundles).
- **Per-module certification** (`harness certify-modules`): each module's own
  tests run against a real composed app (substrate + declared module deps);
  no tests → rejected. **Mega-compose proof**: all app modules coexist in one
  booted application with cross-module journeys green.
- `catalog.json` (generated from manifests) is what the architecture agent
  reads; `module-sdk` scaffolds new modules; `compat-matrix` validates
  selections; `deprecation` manages sunset.

## 6. Certification (four layers, all in CI on every push)

| Layer | Command | Proves |
|---|---|---|
| Modules | `certify-modules` | each module's contract, in isolation, on a real composed app |
| MCP servers | `certify-mcp` | protocol compliance + each server's contract tests |
| Project types | `certify <dir>` | static completeness, golden scenarios replay **byte-deterministically** (per-file artifact digests), cost envelope, revision drill |
| Platform | `npm test` (94 tests) | runner semantics, CLI, dashboard, distribution, combination proofs |

A green `certify` writes `certification.json` with the package digest — the
release record.

## 7. Distribution & operations

- **Registry v1**: release = git tag `<name>@<version>`; `harness install`
  clones the tag, recomputes the digest against the certification record, and
  **refuses tampered or uncertified packages**; `harness run name@version`
  resolves from the local store. Modules and platform MCP servers travel with
  the tag.
- **Run pinning**: every run snapshots its DAG (`dag.snapshot.yaml`) — it
  keeps behaving as the version it started from.
- **Single-file bundle** (`npm run bundle` → `harness.cjs`, ~650 KB,
  node ≥ 20); `harness self-update` rebuilds from the registry and swaps
  itself; `harness setup` is the pilot preflight (toolchain, engine, auth).
- **Local-first telemetry**: per-run summaries in
  `$HARNESS_HOME/telemetry.jsonl`; `harness telemetry` aggregates;
  `HARNESS_TELEMETRY=0` opts out. No payloads, no network.

## 8. The generated app (agentic-app@0.8.0 output)

React-free vanilla frontend that **is the design the user chose** (the full
shell ships verbatim; slices extend within it — a verifier enforces the mount
points), FastAPI backend composed from certified modules, live Claude agents
via agent-runtime (live-api / live-cli / stub, mode always disclosed, roster
at `/agents`), its own test suite + agent evals + security scan + governance
evidence pack, Docker/Cloud Run deployment path.

## 9. Recorded proofs (live, no mocks)

| Proof | Result |
|---|---|
| Full live build (live-copilot-2) | 27 nodes, $22.78, all verifiers green, design pixel-identical to the chosen option |
| Live revision cycle | "button should say Draft reply" → applied by a real agent, $1.04, UAT cached |
| Subagent delegation | DAG-declared subagent wrote the artifact, $0.08 |
| Certified skill load | agent reproduced a nonce that exists only in the staged SKILL.md, $0.07 |
| MCP tools | agent drove start_app/request/stop_app over real stdio MCP, $0.05 |
