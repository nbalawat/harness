# Reporting bugs

Every run is event-sourced, so a bug report can carry *exactly* what happened —
please use that. File issues at https://github.com/nbalawat/harness/issues.

## What to include

From the run's workspace directory (`my-app/`):

| Item | Why it matters |
|---|---|
| `journal.jsonl` | The complete event ledger: every attempt, error, cost, question, answer, revision. This is the single most useful file. |
| `dag.snapshot.yaml` | The exact pipeline version your run executed (may differ from what's currently released). |
| `attempts/<node>-<n>/` for the failing step | The step's inputs (`inputs.json`), any `feedback.md`, and what the payload produced. |
| `run.json` | How the run was configured (mock vs live, answers file, defaults). |
| Output of `node harness.cjs setup` | Toolchain/engine/auth state — most "agent node failed instantly" reports are a red preflight row. |
| Output of `node harness.cjs status <workspace>` | One-screen summary of node states and spend. |
| Dashboard screenshot | If the bug is a dashboard bug. |

**Redact before sending**: your documents folder contents and `artifacts/` may
contain your business material. The journal contains message *previews* from
agent transcripts — skim it. Telemetry (`~/.harness/telemetry.jsonl`) contains
no payloads, only run summaries.

## Triage: whose bug is it?

- **Platform (runner/CLI/dashboard)** — scheduling, parking/resume, revision
  cascade, budgets, the dashboard UI, install/setup. Anything reproducible with
  the `demo` project type is platform.
- **Project type** — a prompt producing bad output, a verifier that's wrong, a
  schema too loose/tight, a mock diverging from live behavior, cost budgets
  miscalibrated. Include the project type name@version (it's in the journal's
  `run.created` event and `dag.snapshot.yaml`).
- **Module** — a composed file (`db.py`, `agent_runtime.py`, `app.js`...)
  misbehaving inside the generated app. Name the module; `composed_modules.json`
  in the app lists what was composed.
- **Generated app** — if the built app doesn't do what was agreed, prefer the
  **feedback flow** over a bug report: "Request a change to the app" on the
  dashboard (or `harness revise`). That's not a workaround — it *is* the
  designed correction path, and it keeps requirements/RTM/tests consistent.

## Reproducing

Mention whether it reproduces with `--mock-agents` (deterministic replay):

```bash
node harness.cjs run project-types/<name> --workspace repro \
  --answers project-types/<name>/fixtures/answers.json --mock-agents
```

A mock-mode reproduction is gold: it's deterministic, free, and can usually be
turned directly into a regression test or a certification golden.
