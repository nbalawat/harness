# Capability modules: authoring them, and how runs use them

> The full target catalog (~100 modules, with the reason each must exist) lives
> in [docs/MODULES.md](../MODULES.md). Every module — shipped or future — must
> pass `harness certify-modules`: manifest contract, agent guide, clean
> composition onto the substrate, and its own tests against a real composed app.

Modules are the reuse layer — certified building blocks (persistence, agent
runtime, chat shell, later auth/RAG/doc-extraction) that project types compose
instead of letting agents reinvent them per app. They are why two apps built a
month apart behave the same.

## Module anatomy

```
modules/<name>/
  manifest.yaml     # identity + contract
  agent-guide.md    # instructions FOR THE BUILD AGENTS working on a composed app
  compose/          # overlay tree, copied verbatim onto the app
```

`manifest.yaml`:

```yaml
name: persistence-core
version: 0.1.0
description: Data layer with table registry...
provides:
  - python: db.store (insert/list keyed by table registry)
requires:
  - backend/models.py defining TABLES (generated from data_model.json)
compose:
  overlay: compose/
```

- **`provides`** — the interface downstream code may rely on.
- **`requires`** — what must exist in the app for the module to function.
  Scaffold generates these (e.g. `models.py` comes from the approved data model).
- **`compose/`** — real files. `compose/backend/db.py` lands at `app/backend/db.py`.

`agent-guide.md` is the module's law for build agents: e.g. agent-runtime's
guide says *"all agent invocations go through `agent_runtime.respond`; never
call an LLM API directly; `agents/roster.json` is the contract."* Slice agents
are pointed at these guides, and verifiers/evals enforce the consequences.

## How a run uses modules (the full path)

1. **Architecture node** (agent): reads requirements + clarifications and picks
   modules from the certified catalog only — the artifact schema requires each
   entry to carry `addresses` (the requirement IDs it serves), and the scaffold
   refuses any module name that doesn't exist in the catalog.
2. **Traceability node**: joins those `addresses` into the RTM — a requirement
   no module/table/agent/design element addresses **blocks the pipeline**.
3. **Scaffold node** (deterministic, zero LLM calls): copies the base template,
   then overlays each chosen module's `compose/` tree, then the chosen design's
   shell, then writes generated glue (`models.py`, `roster.json`, eval cases).
   It records `composed_modules.json` in the app — the bill of materials.
4. **Build slices** (agents): work *within* the composed skeleton. Prompts point
   them at the module agent-guides; the design-fidelity and route-shadowing
   rules keep them inside the rails.
5. **Verifiers**: the app's own test harness (shipped in the template *before*
   any agent builds), per-slice cumulative acceptance, agent evals against the
   roster, security scan, and the compose boot smoke all run against the
   composed result.

The consequence: an app is mostly **composed** (deterministic, certified) and
only partly **generated** (agent work inside validated contracts). Raising that
compose ratio is the standing direction of the module program.

## Authoring rules

1. **Rule of three**: a capability becomes a module after it has been needed by
   three real apps — harvest from generated code, don't speculate.
2. **Self-describing**: everything a build agent must know goes in
   `agent-guide.md`; everything a machine must know goes in `manifest.yaml`.
3. **Deterministic overlay**: `compose/` files are copied verbatim. No
   templating language; generated glue belongs in the project type's scaffold
   script where it's derived from approved artifacts.
4. **Test the consequences**: modules travel inside the repo, so the project
   type's certification (golden digests + verifiers + evals) is what certifies
   them. If your module has behavior worth promising, encode it in a verifier
   or an eval case the composed app must pass.
5. **Version with the repo**: modules ship with the registry tag the consumer
   installs, so a certified project-type version pins its module set implicitly.
   Breaking a module's `provides` interface is a breaking change for every
   project type that composes it — bump accordingly and re-certify all of them.
