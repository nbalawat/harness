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

**[CAPABILITIES.md](CAPABILITIES.md)** is the one-page inventory of everything
the harness does today (with its proof for each claim), and
**[CHANGELOG.md](CHANGELOG.md)** is the development record — platform phases,
agentic-app 0.3.0→0.8.0 version history, and the lessons the code now enforces.

The **module catalog** — the heart of the harness, ~100 modules with per-module rationale and certification rules — is [MODULES.md](MODULES.md).

The **GCP deployment architecture** — project topology, dataflow diagrams,
the network egress matrix, security controls, IaC layout, and sizing — is
[DEPLOYMENT-GCP.md](DEPLOYMENT-GCP.md).

The **50k rollout plan** — safe infra, cost model, firm gallery, fleet
observability, and the phased path from 50 pilots to firm-wide — is
[ROLLOUT.md](ROLLOUT.md).

Architecture and rationale live in [DESIGN.md](DESIGN.md) — the three planes,
reliability mechanisms, the six hard problems and where each is solved, cost
and observability, and the roadmap.
