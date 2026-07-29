# Harness — Certified SDLC Workflow Factory

Build working agentic AI applications from a problem statement and a folder of
documents. A small platform team **certifies** workflow types as deterministic
DAGs; everyone else consumes them and gets the same proven result every time:
requirements with provenance, approvable designs, certified modules,
feature-by-feature builds with tests, security scanning, and a governance
evidence pack.

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
harness run agentic-app@0.9.0 --workspace my-app   # parks at intake
harness ui                                         # answer + watch in the browser
harness status my-app
harness revise my-app slice-2 --feedback "..." --resume
```

## What a build gives you

The `agentic-app` project type is a 34-node certified pipeline:

- **Requirements** — every document read into an evidence corpus; requirements
  carry provenance (stated / inferred / unknown); at most 6 clarifying
  questions, each with a default and a "why".
- **Design** — 3–4 fully rendered, genuinely different design directions; the
  one you pick ships **verbatim** as your app's frontend and is then locked.
- **Architecture** — composed from 105 certified capability modules
  (persistence, agent runtime, RBAC, audit, approvals, …), including your
  choice of agent framework: native, **LangGraph**, **Google ADK**, or
  **AWS Strands**.
- **Workflows** — generated apps get their own deterministic workflow layer
  (pure-Python event-sourced engine) with agentic nodes and mandatory human
  gates where agents feed decisions.
- **Build** — vertical feature slices, each verified against cumulative
  acceptance checks + the full test suite, each demonstrated with a screenshot
  of *its* increment and an objectives ledger.
- **Evidence** — requirements-traceability matrix (uncovered requirements block
  the build), security scan, agent evals, governance report.

**Supervision is a dial:** `gates-only` asks you only at the five decision
points; `every-slice` adds a checkpoint after each slice that pauses up to five
minutes with the evidence — answer to decide, or walk away and it proceeds on
approval-by-default, recorded as an assumption. Revisions are cheap: request a
change on any step and everything downstream re-derives, re-using unchanged
work automatically at no cost.

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
project-types/     demo (4-node) and agentic-app (34-node) certified DAGs
modules/           105 certified capability modules composed into generated apps
mcp/               certified MCP servers (app-sandbox: the app-under-build as a service)
scripts/           bundle.mjs (single-file engine) · pack.mjs (npm package) · catalog-sync.mjs
docs/              design, module catalog, changelog, role guides
```
