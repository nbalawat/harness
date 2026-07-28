# Reference: CLI, environment, layout, glossary, FAQ

## CLI

| Command | What it does |
|---|---|
| `harness setup [--install-sdk]` | Preflight: node/git/uv/docker, the Claude Agent SDK (execution engine), agent auth. `--install-sdk` provisions the engine into `$HARNESS_HOME/runtime`. |
| `harness install <name>@<version> --registry <git-url>` | Installs a certified project type from a registry tag; refuses tampered/uncertified packages. |
| `harness list` | Installed project types with certification digests. |
| `harness run <path\|name@version> [--workspace dir] [--answers file] [--mock-agents] [--accept-defaults]` | Starts a run. A path = authoring mode; `name@version` = from the store. Parks at the first unanswered gate. |
| `harness resume <workspace> [--answers file] [--accept-defaults]` | Continues a parked/failed run (failed nodes reopen automatically). |
| `harness revise <workspace> <nodeId> --feedback "..." [--resume]` | Reopens a step + everything downstream with your feedback; unchanged steps re-use cached results. |
| `harness status <workspace>` | One-screen node states + spend. |
| `harness ui <dir> [--port n]` | Dashboard. Pass a folder of runs → storefront; a single workspace → straight into it. |
| `harness certify <project-type-dir> [--update-golden]` | Certification: static checks, golden replays, digest diffs, cost gates, revision drill. Green writes `certification.json`. |
| `harness certify-mcp [mcp-dir]` | Certifies every MCP server: manifest, protocol probe (initialize + tools/list), contract tests. |
| `harness new-mcp <name>` | Scaffolds a certifiable MCP server (working ping tool, protocol loop, contract test). |
| `harness telemetry` | Aggregates your local run summaries. |
| `harness self-update --registry <git-url> [--ref x]` | Rebuilds the bundle from the registry and swaps itself (keeps a `.bak`). |

## Environment variables

| Variable | Effect |
|---|---|
| `HARNESS_HOME` | Root for the store, runtime engine, and telemetry (default `~/.harness`). |
| `HARNESS_SDK_DIR` | Pin the Claude Agent SDK location (checked before normal module lookup — for firms that manage the engine centrally). |
| `HARNESS_TELEMETRY=0` | Opt out of local telemetry. |
| `HARNESS_SMOKE_DOCKER=1` | Enables the full container boot smoke during integration (builds images; certification runs enable it). |
| `ANTHROPIC_API_KEY` | Agent auth for live runs (alternative: a logged-in Claude Code CLI). |

Generated apps additionally use `HARNESS_AGENT_MODE` (`live-api` / `live-cli` /
`stub`) — their tests and evals pin `stub` for determinism; the running app
shows its mode in the UI badge and at `/agent/mode`.

## Workspace layout (what a run leaves on disk)

```
my-app/
  run.json            # how the run was configured
  dag.snapshot.yaml   # pinned pipeline (immutable for this run's lifetime)
  journal.jsonl       # append-only event ledger — state is a pure fold of this
  attempts/<node>-<n>/  # every attempt's staging dir (inputs.json, feedback.md, outputs)
  artifacts/<node>/     # committed, validated outputs only
  revisions/            # user feedback files (consumed on the next attempt)
  change-requests/      # CR-n records from "new requirement" feedback
  ui-answers.json       # answers given through the dashboard
```

## Glossary

- **Gate** — a step that parks the run for human answers; defaults are
  confirmed, not silently applied (unless `--accept-defaults`).
- **Park / resume** — a run stops durably (journal intact) and continues later;
  resume never re-runs committed steps.
- **Artifact contract** — every step's outputs are declared and JSON-Schema
  validated before commit; the next step consumes only committed artifacts.
- **Verify (exit criteria)** — a command that must pass inside the step's retry
  loop before commit. Proof by execution, not model judgment.
- **Retry with feedback / escalation** — failed validation feeds `feedback.md`
  into the next attempt, optionally on a stronger model.
- **Revision / cascade** — user feedback reopens a step and its downstream
  closure; the DAG re-derives; the journal keeps the full history.
- **Memoization** — a reopened step whose inputs hash identically re-commits
  its previous result at $0.
- **Golden scenario** — a recorded answers file replayed with mocks during
  certification; artifact digests must match byte-for-byte.
- **Compose ratio** — how much of a generated app is certified modules/templates
  vs. agent-generated code. Higher is better.
- **RTM** — requirements traceability matrix; an unaddressed requirement blocks
  the pipeline.

## FAQ

**Why did my run stop?** It parked at a gate — open the dashboard; the waiting
panel is at the top of Overview. Runs also stop on budget breach (visible in the
journal as `budget.exceeded`) or when a step fails all retries.

**Can I edit an artifact by hand?** No — edit through `revise` so downstream
artifacts re-derive and stay consistent. Hand edits are exactly the drift the
factory exists to prevent.

**Why do screenshots/design options cost real money but tests don't?** Agent
steps run live model sessions; verifiers/deterministic steps and the generated
app's own tests run code. The dashboard's per-step cost shows the split.

**Mock vs live?** Mocks are certification machinery (deterministic replay).
Real builds run the Claude Agent SDK — the run-mode pill on the dashboard tells
you which one you're looking at.

**Where's my data?** Everything stays on your machine: workspaces, telemetry,
the store. Cloud is a deploy *target* only.
