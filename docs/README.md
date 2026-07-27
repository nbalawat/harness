# Harness documentation

The harness is a **factory**: a small central team certifies SDLC workflow
types as deterministic pipelines; everyone else uses them to build applications
that work every time. Start with the guide that matches your role:

| Guide | For | Answers |
|---|---|---|
| [Building an agentic app](guides/building-an-app.md) | App builders (the 50k) | Setup, the intake → Q&A → design → build → UAT journey, watching the build, giving feedback, cost |
| [Authoring project types](guides/authoring-project-types.md) | Platform / certifiers | Package anatomy, node kinds, the envelope, design rules, the certification workflow |
| [Authoring modules](guides/authoring-modules.md) | Platform / contributors | Module anatomy, **how a run composes and uses modules**, the rule of three |
| [Versioning & releases](guides/versioning-and-releases.md) | Everyone | What `name@version` promises, semver rules, immutability, the release checklist |
| [Reporting bugs](guides/reporting-bugs.md) | Everyone | What to attach (the journal!), triage, when feedback beats a bug report |
| [Reference](guides/reference.md) | Everyone | CLI, environment variables, workspace layout, glossary, FAQ |

Architecture and rationale live in [DESIGN.md](DESIGN.md) — the three planes,
reliability mechanisms, the six hard problems and where each is solved, cost
and observability, and the roadmap.
