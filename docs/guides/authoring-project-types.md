# Authoring a project type (platform guide)

A project type is a **certified, immutable, parameterized pipeline**: a DAG the
central team proves once and 50k consumers replay safely. Consumers supply
inputs and answers; they can never alter the DAG. This guide is the certifier's
manual.

## Package layout

```
project-types/<name>/
  dag.yaml            # the pipeline definition (see below)
  prompts/*.md        # one per agent node — the agent's instructions
  mocks/*.cjs         # one per agent node — deterministic stand-in for certification replay
  schemas/*.json      # JSON Schema contract for every structured artifact
  scripts/*.cjs       # deterministic/verifier node commands
  templates/          # files copied verbatim (e.g. the app skeleton + its test harness)
  fixtures/answers*.json  # recorded gate answers = golden scenarios (one file per scenario)
  goldens/*.digest.json   # recorded artifact digests (written by certify --update-golden)
  certification.json      # release record (written by a green certify; never hand-edit)
```

## dag.yaml essentials

```yaml
name: my-type
version: 0.1.0            # see versioning-and-releases.md
description: ...           # shown to users on the dashboard
cost:
  run_budget_usd: 40.00    # hard envelope, includes revision headroom
  nodes: { my-node: { budget_usd: 3.00 } }   # per-step caps (per incarnation)
interaction:
  max_questions_per_gate: 6   # user attention is budgeted like dollars
preview:                      # how the dashboard launches the built product
  artifact: app
  command: uv run ... --port $PORT
  cwd: backend
certification:
  revision_drill: { node: <id>, feedback: "..." }   # certify the feedback loop too
nodes: [...]
```

### Node kinds

| Kind | Executes | Required fields |
|---|---|---|
| `agent` | A live Claude Agent SDK session in a hermetic sandbox (cwd = attempt dir, no user settings, tools you allow) | `prompt`, `mock`, `outputs` |
| `deterministic` | A shell command | `command` |
| `verifier` | A shell command whose exit code is the verdict | `command` |
| `gate` | Questions to the human; parks the run until answered | `questions` or `questionsFrom`, exactly one output |

Common fields: `id`, `phase` (dashboard grouping), `description` (plain language,
user-facing), `deps`, `outputs` (name/file/schema or `dir: true`), `retries`,
`model` + `escalateModel` (retry runs one tier up), `maxTurns`, `verify`
(per-node executable exit criteria), `when` (conditional skip on artifact data),
`params` (static inputs, e.g. a slice index), `agents` (a **subagent team**).

### Subagent teams

An agent node may declare a team: `agents: {name: {description, prompt, tools,
model}}`. Definitions are certified data — they live in the DAG, count into the
package digest, and never come from user settings (hermeticity holds). The
node's `allowedTools` MUST include `Task` or loading fails (an unreachable team
is a packaging bug). Patterns proven in agentic-app: parallel creators
(design-options' four directors, one per aesthetic) and a read-only reviewer
(slice-reviewer runs before the verifier spends a boot). Keep subagent tools
minimal; reviewers get `[Read, Glob, Grep]` only.

### Certified skills

An agent node may declare `skills: [name, ...]` — each is a
`skills/<name>/SKILL.md` directory **inside the project-type package**. The
envelope stages them into the session's project settings dir (the attempt dir
it fully controls) and enables `settingSources: ["project"]` for that session
only. The node's `allowedTools` must include `Skill` (validated at load).

Why this design: skills from a user's machine would make certified runs behave
differently per machine — the opposite of "works every time". Skills from the
package are just more certified data: versioned, digested, identical
everywhere. Use them for deep reference material agents load on demand
(agentic-app's `app-conventions` is the model), keeping prompts short.

### The envelope — what you get for free

Every node runs inside the same wrapper: inputs collected from dependency
artifacts → attempt dir staged → payload runs → **schema validation** → your
`verify` command → commit. Failures feed `feedback.md` into the retry (with
model escalation if declared). Nothing non-deterministic leaks past validation.
Cost is attributed per attempt via the `cost.json` channel; budgets are enforced
before commit.

## Design rules that make certification possible

1. **Determinism is quarantined inside nodes.** Every edge is a schema-validated
   artifact. If an agent can express it, a schema must constrain it.
2. **Executable exit criteria.** A step is done when a command proves it —
   never when a model says so. Put real tests in `verify`.
3. **Templates over generation.** Anything that can be a file copy should be —
   scaffold composes templates and modules; agents only fill the gaps.
4. **Mocks are high-fidelity.** They exist solely so certification replay is
   deterministic. A mock must produce artifacts of the same shape and honor the
   same feedback contracts (e.g. incorporate `feedback.md` change requests) as
   the live agent. The Claude Agent SDK remains the execution engine.
5. **Budget every step** from real run data, with headroom for what the step
   actually produces (we learned this: a design step producing buildable shells
   costs ~4x one producing sketches).
6. **Ask only what documents can't answer**, always with defaults and a "why" —
   the interaction budget fails the gate loudly if it over-asks.

## Certification workflow

```bash
# 1. Develop with the regression suite green
npm test

# 2. Record goldens: run every fixtures/answers*.json scenario, store artifact digests
node packages/cli/dist/index.js certify project-types/<name> --update-golden

# 3. Prove determinism + drift-freedom (this is what CI runs on every push)
node packages/cli/dist/index.js certify project-types/<name>
```

`certify` checks, in order: static completeness (every mock/prompt/schema/script
referenced actually exists and compiles) → each golden scenario replays to
completion → simulated spend stays inside the envelope → **per-file artifact
digests match the goldens byte-for-byte** (workspace paths normalized; renderer
output like .png excluded) → the revision drill re-derives to green with
memoization. A green run writes `certification.json` including the package
digest — the registry refuses to install any tag whose content doesn't match it.

**Artifacts must be byte-deterministic.** No timestamps, no durations, no
absolute paths, no randomness in anything a node commits. The digest check will
catch you (it caught pytest timings on its first run).

## Releasing

Tag the repo `<name>@<version>` and push. Consumers install exactly that tag.
See [versioning-and-releases.md](versioning-and-releases.md).
