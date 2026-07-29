# Building an agentic app (user guide)

You describe a problem and hand over your documents; the harness runs a certified
pipeline of AI agents and deterministic checks that ends in a working, tested,
security-scanned application you watched being built. You make five decisions
along the way — everything else is done and *proven* for you.

## 1. One-time setup (two commands)

```bash
npm install -g @valueaddwithai/harness   # ships the engine + the certified catalog
harness ui                          # storefront on http://localhost:4400
```

No GitHub, no checkout, no build step: the npm package carries the certified
project types, the module catalog, and the MCP servers. `harness ui` from any
folder shows the storefront; that folder becomes where your app builds live.
Build as many apps in parallel as you like — one browser tab per build.

Before your first **live** build, run the preflight once:

```bash
harness setup --install-sdk
```

This is the preflight. It verifies Node (>= 20), git, uv, docker (optional), the
**Claude Agent SDK — the harness's execution engine** — and your agent
authentication (an `ANTHROPIC_API_KEY`, or a logged-in Claude Code CLI). Every
required row must be green before a live build. `--install-sdk` provisions the
engine into `~/.harness/runtime` if it's missing.

Firms distributing their own certified types can also push them through the
git registry (`harness install agentic-app@0.9.0 --registry <git-url>`); the
install is tamper-proof — the package's content digest must match its
certification record or the install is refused. The npm package is simply the
same catalog, pre-installed.

## 2. Start a build

Two equivalent ways:

- **Dashboard (recommended):** `harness ui` → open http://localhost:4400
  → **Start building** → name it → answer intake.
- **CLI:** `harness run agentic-app@0.9.0 --workspace my-app`, then open
  the dashboard.

Either way the run immediately **parks at intake** — nothing runs and nothing is
spent until you answer.

## 3. The journey — where you come in

The pipeline pauses at *gates*; the dashboard shows each one at the top of the
Overview tab as "Waiting on you". Your five decision points:

| Stage | What you do |
|---|---|
| **Intake** | Name the app, describe the problem, and hand over supporting documents (PDF/docx/HTML/notes) — **upload them right in the intake form** (they're stored with the run) or point at a folder path. Pick deploy target (local / cloud-run) and how closely you want to supervise. |
| **Clarify** | Agents read every document first, then ask **only the questions the documents couldn't answer** (hard cap: 6, each with a default and a "why"). |
| **Design select** | 3–4 genuinely different, fully rendered design directions. **The one you pick ships verbatim as your app's frontend** — layout, typography, everything. It is then locked. |
| **Design review** | The requirements-traceability matrix: every requirement mapped to the module/table/agent/design element that addresses it, plus every assumption made on your behalf. Approve before any build spend. |
| **UAT** | Final sign-off with the full evidence pack (tests, evals, security scan, coverage) in front of you. |

**Supervision is a dial, not a burden.** At intake you choose:

- `gates-only` (default) — you're only asked at the five decision points above.
- `every-slice` — after each delivered feature slice the run adds a
  **checkpoint**: it pauses up to 5 minutes with the slice's evidence
  (screenshot, objectives ledger) so you can look before it continues. Answer
  in the window and your verdict applies immediately; walk away and it
  proceeds on approval-by-default, recorded as an assumption in the Decisions
  tab. You get an intervention *window*, never an obligation — and a cheap
  revision (`Request changes` on any slice) remains available afterwards
  because unchanged steps re-use their previous results at no cost.

Between gates, real agent sessions do the work. If an agent hits genuine
ambiguity mid-step, its question appears at the top of Overview — answer within
15 minutes and the answer flows into the running session; otherwise it proceeds
on a recorded assumption (visible in the Decisions tab).

## 4. Watching the build

- **Watch it grow** — one full-page screenshot per delivered slice, showing the
  app's real data and UI state at that point. Click to zoom.
- **Your application** — launch the actual app at any committed slice and click
  around it. The in-app badge always tells you whether a live agent or the
  offline demo responder is answering.
- **Your app's agents** — the roster your app runs: each agent's role, allowed
  tools, denied tools ("never"), covered requirements, and the eval criteria it
  is held to. The app itself also exposes this at `/agents`.
- **Pipeline tab** — click any step: what it does, what it ran, its exit
  criteria, what it produced and found, the prompt used, cost and tokens.
- **Quality & test results** — backend tests, agent evals, security findings,
  requirement coverage, slices delivered. Green means *executed and passed*,
  never "an agent said so".

## What's working under the hood

Each build step is a hermetic Claude agent session with exactly the
capabilities its certified definition grants: some run **subagent teams**
(four design directors create your options in parallel; a read-only reviewer
checks every slice before verification), all slice builders load the
**app-conventions skill** (the codebase's law) and drive your app through the
**app-sandbox tools** (boot/probe/test with structured results) instead of
raw shell. You can see all of it: any step's drawer lists its session
capabilities, subagents, and every tool call it made.

## 5. Changing your mind

Feedback never edits the app directly — it re-enters the pipeline at the right
artifact and everything downstream re-derives, so all artifacts stay consistent.

- **Fix a slice** (the build doesn't match what was agreed): under the slice
  screenshots → "Request a change to the app" → *Fix a slice*. The slice re-runs
  with your correction; requirements are untouched.
- **New or changed requirement**: same form → *New or changed requirement*. It
  is recorded as a change request, appended to requirements with provenance
  (`user-feedback`, CR-n), coverage is re-verified, and the plan/build re-derive.
- **Any step**: open its drawer → "Request changes". You get an impact preview
  ("this will re-run 7 steps") before confirming.
- CLI equivalent: `node harness.cjs revise my-app slice-2 --feedback "..." --resume`

Steps whose inputs didn't change are **re-used from cache at $0** — a revision
costs its blast radius, not the whole pipeline.

## 6. Cost

Every run has a certified cost envelope (agentic-app@0.9.0: **$40**, which
includes revision headroom; a typical full build lands at $20–25). Each step has
its own budget; a step that would exceed it is stopped, not committed. Spend,
tokens, and per-step cost are live on the dashboard. `node harness.cjs telemetry`
summarizes all your runs.
