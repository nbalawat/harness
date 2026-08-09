# Harness — Certified SDLC Workflow Factory

Build working agentic AI applications from a problem statement and a folder of
documents. A small platform team **certifies** workflow types as deterministic
DAGs; everyone else consumes them and gets the same proven result every time:
requirements with provenance, approvable designs, certified modules,
feature-by-feature builds with tests, security scanning, and a governance
evidence pack.

The factory is built to produce apps that are **sound, not just green**. Non‑
functional requirements (authorization, identity integrity, auditability, PII
protection) are derived up front and become acceptance the slices must pass;
the strict verification gates **self‑heal** — a merge conflict, a dead control,
an unauthenticated route, or a semantic authz defect is *fixed and re‑proven*
rather than stalling the build — and every fix is fed back into the factory's
build‑expertise so the next app ships it right the first time.

## Get started (two commands)

```sh
npm install -g @valueaddwithai/harness
harness ui
```

Open http://localhost:4400 → **Start building** → name your app → answer the
intake form (upload your documents right there). The run parks at intake —
nothing executes or spends until you answer. Build as many apps in parallel as
you like: one browser tab per build.

Before your first **live** build (real Claude agents), run the preflight once
and have an `ANTHROPIC_API_KEY` (or a logged-in Claude Code CLI):

```sh
harness setup --install-sdk
```

Prefer the command line? Everything the dashboard does has a CLI form:

```sh
harness run agentic-app@0.16.0 --workspace my-app   # parks at intake
harness ui                                          # answer + watch in the browser
harness status my-app
harness revise my-app slice-2 --feedback "..." --resume
```

## What a build gives you

The `agentic-app` project type is a 42-node certified pipeline:

- **Requirements** — every document read into an evidence corpus; requirements
  carry provenance (stated / inferred / unknown), and **non-functional
  requirements** (authorization, identity integrity, human-gate parity, PII
  protection, auditability, segregation of duties) are derived first-class, each
  with a testable refusal proof. At most 6 clarifying questions, each with a
  default and a "why".
- **Design** — one enterprise operational-console theme in **two layout
  variants** (left-rail vs master/detail); the one you pick ships **verbatim**
  as your app's frontend and is then locked. Every control must trace to a
  requirement — ungrounded "furniture" is rejected before it can ship dead.
- **Architecture** — composed from 111 certified capability modules
  (persistence, agent runtime, RBAC, audit, approvals, …), including your
  choice of agent framework: native, **LangGraph**, **Google ADK**, or
  **AWS Strands**.
- **Workflows** — generated apps get their own deterministic workflow layer
  (pure-Python event-sourced engine) with agentic nodes and mandatory human
  gates where agents feed decisions — and a human approval gate can never be
  silently skipped by branch pruning.
- **Build** — vertical feature slices built in parallel on a foundation and
  merged deterministically (a genuine conflict self-heals, never stalls); each
  slice is verified against cumulative acceptance checks (including the NFR
  refusal proofs) + the full test suite, each demonstrated with a screenshot of
  *its* increment.
- **Verification (self-healing)** — the merged app is driven to the "done" bar:
  a security scan (fail-open identity, defaulted decisions, unauthenticated
  mutations block deterministically), a usability drive (no dead controls; an
  identity-gated app must ship a persona picker), and a **self-healing semantic
  audit** that audits → fixes every high finding → re-audits to convergence.
- **Evidence** — requirements-traceability matrix (uncovered requirements block
  the build), security report, agent evals, live per-screen coverage
  screenshots, governance report.

**Supervision is a dial:** `gates-only` asks you only at the five decision
points; `every-slice` adds a checkpoint after each slice that pauses up to five
minutes with the evidence — answer to decide, or walk away and it proceeds on
approval-by-default, recorded as an assumption. Revisions are cheap: request a
change on any step and everything downstream re-derives, re-using unchanged
work automatically at no cost.

## Sound by construction: self-healing gates

An app that passes its happy-path tests can still be unsound. The factory's
verification gates don't just report defects — they **fix them and re-prove**,
reusing the same retry/escalation machinery every agent node uses:

- **merge-slices** runs a deterministic union first; only on a genuine conflict
  does an agent resolve the conflicted hunks (both slices preserved).
- **remediate** drives the security scan + usability drive against the merged
  app and fixes unauthenticated mutations, dead controls, and missing persona
  pickers before the app is admitted.
- **slice-audit** is a self-healing semantic audit: it audits the app on the
  FSI-hardening checklist (fail-closed identity, real persistence, human-gate
  parity, no defaulted/coerced decisions, trustworthy audit, prompt-injection
  hygiene, …), **fixes every high finding, and re-audits to convergence** — a
  genuinely-accepted finding needs a named human waiver, never a silent pass.
  The audit's "0 high" is not self-asserted: an **independent deterministic scan
  must agree** before convergence is accepted (self-verification produces
  confident-wrong results on repeat, so the generator and the verifier are kept
  separate).

Two things fall out of this: the strict gates never stall a build on a fixable
defect, and every heal is recorded as a durable lesson in the project type's
`build-expertise.md`, so the failure class stops recurring. The factory gets
more reliable with every app it builds.

## Engineering model: a graph of bounded loops

The industry is moving "from loops to graphs" — a prompt controls one response,
a loop controls one agent, a graph orchestrates many. The harness is both, by
design:

- **The control plane is a graph.** Each project type is a deterministic DAG
  with typed nodes (gate / agent / deterministic / verifier) and explicit
  dependencies. A frontier scheduler runs the ready set in parallel (two design
  options, the feature slices) with **no model anywhere in the control plane** —
  routing, memoization, and merge are pure code. Runs are event-sourced, so
  resume, replay, and cascade-on-revision come for free. The parallel feature
  slices are declared once with a `repeat` template the loader expands, the pool
  is **materialized from the plan** (a slot activates only if the plan declares
  that slice), and the fan-in `merge` declares its **reducer** (`union-slices`)
  so the merge strategy is explicit and load-validated, not implicit.
- **Context stays lean.** Agents work file-first — inputs and feedback are read
  from the working tree on demand, not inlined into the prompt — and a very large
  artifact is *offloaded* (referenced, not inlined) so it never floods the
  context window.
- **The nodes are bounded loops.** Every agent node runs inside a retry loop
  that escalates the model tier (haiku → sonnet → opus) on failure, carries a
  `feedback.md` forward, and continues from the previous working tree — a
  bounded, verifier-gated loop, never an open one.
- **The gates are convergence loops.** merge / remediate / audit apply that same
  loop to *heal to a fixed point* (0 findings), then stop.

Because a loop's real risk is a stop condition that can't tell *done* from
*stalled*, the retry envelope has a **doom-loop guard**: if an attempt repeats
the previous failure signature or leaves the working tree byte-identical (no real
change), it records `node.loop_detected` and injects a break-the-loop directive
so the next attempt changes approach instead of burning budget re-treading.

## Measure what you change

Every run is a journaled trajectory, so the factory is inspectable — and a
factory you can't measure is one you can only guess at.

```sh
harness metrics my-app              # retries, escalation paths, self-heal cycles,
                                    # audit rounds, rework %, cost/tokens/time
harness metrics build-a --compare build-b   # A/B two runs of the same problem:
                                            # did a harness change actually help?
```

Because certification is byte-deterministic, that comparison is honest. Two
guards keep the self-improvement loop from fooling itself: the audit's
convergence is reported as **fixed vs waived** (a plateau can't masquerade as a
pass), and a **held-out golden set** (`fixtures/answers-heldout*.json`) is frozen
— never used to tune prompts or expertise and never refreshed by the routine
`--update-golden`, so the harness can't be silently optimized to pass its own
tests. A held-out drift is a real regression.

## Runs anywhere

Windows, macOS, and Linux. Node commands are shell-agnostic (env vars are
pre-expanded rather than left to `sh` vs `cmd.exe`), process cleanup is
cross-platform (`taskkill /T` on Windows, process-group signal on POSIX), and
Python/`find`/npm shims are resolved per platform. The only prerequisites are
Node 20+, Python 3, and [uv](https://docs.astral.sh/uv/).

## Documentation

Full guides in [docs/](docs/README.md):
[building an app](docs/guides/building-an-app.md) ·
[authoring project types](docs/guides/authoring-project-types.md) ·
[authoring modules](docs/guides/authoring-modules.md) ·
[versioning & releases](docs/guides/versioning-and-releases.md) ·
[reporting bugs](docs/guides/reporting-bugs.md) ·
[reference (CLI/env/glossary/FAQ)](docs/guides/reference.md) ·
[architecture](docs/DESIGN.md) ·
[module catalog](docs/MODULES.md) ·
[changelog](docs/CHANGELOG.md)

## Developing the platform (this repo)

```sh
npm install && npm run build
npm test                 # full regression suite (110+ tests)
```

Requires Node 20+, python3, [uv](https://docs.astral.sh/uv/). Optional: Docker
(compose validation + boot smoke).

Watch the whole factory run deterministically (certification replay, $0):

```sh
node packages/cli/dist/index.js run project-types/agentic-app \
  --workspace my-run \
  --answers project-types/agentic-app/fixtures/answers.json \
  --accept-defaults --mock-agents
node packages/cli/dist/index.js ui .    # inspect it in the dashboard
```

Drop `--mock-agents` for real Claude sessions — cost is captured per node in
the journal and enforced against the certified budget envelope.

### Certifier path

```sh
node packages/cli/dist/index.js certify project-types/agentic-app   # golden scenarios, byte-deterministic
node packages/cli/dist/index.js certify-modules                     # every module against a real composed app
node packages/cli/dist/index.js certify-mcp                         # MCP servers: protocol probe + contract
npm run pack                                                        # publishable npm package (engine + catalog)
```

Certification proves: static completeness, three golden scenarios with
byte-identical artifact digests, cost gates, and a revision drill (feedback →
cascade → re-derive to green with memoization).

## Layout

```
packages/spec      shared types (contracts, ledger events, cost envelope)
packages/runner    scheduler, journal, node envelope, budgets, memoization, MCP/skills/teams
packages/cli       run | resume | revise | status | ui | setup | certify | install | pack
project-types/     demo (4-node) and agentic-app (42-node) certified DAGs
modules/           111 certified capability modules composed into generated apps
mcp/               certified MCP servers (app-sandbox: the app-under-build as a service)
scripts/           bundle.mjs (single-file engine) · pack.mjs (npm package) · catalog-sync.mjs
docs/              design, module catalog, changelog, role guides
```
