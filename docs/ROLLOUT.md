# Rolling the harness out to 50,000 people

A phased plan for firm-wide deployment built on four commitments:

1. **Extremely safe infrastructure** — nothing runs that wasn't certified; nothing leaves that wasn't approved.
2. **Cost minimized by construction** — the platform's cheapest run is its default run.
3. **Showcase by default** — every person and team can show working software, not slideware.
4. **Extreme observability** — builders work freely; the platform team and the firm see everything.

The plan deliberately reuses what already exists and works (certification digests,
the event-sourced journal, budget envelopes, memoization, the npm/git distribution
paths, local telemetry) and adds the *smallest* central services needed at each
scale step. Nothing here requires re-architecting the harness.

---

## 1. The foundation we're scaling (already shipped)

| Mechanism | What it gives the rollout |
|---|---|
| Certified project types (immutable, versioned, digest-checked) | The safety unit: 50k people can only run pipelines a small team proved. Install refuses tampered packages. |
| The node envelope + budget envelope | Spend is bounded *per certified type*, enforced at attempt start; finished work always commits — no money shredded. |
| Event-sourced `journal.jsonl` per run | The observability unit: every state change, cost record, agent message, human decision, and assumption — replayable, auditable, already structured. |
| Memoization + revision cascade | The cost lever: re-derives re-use unchanged work at $0. |
| Mock/certification replay | The training lever: the full experience at $0 for onboarding and demos. |
| npm package (`npm install -g` + `harness ui`) & git registry | Two distribution planes, both content-addressed. |
| Local telemetry (`~/.harness/telemetry.jsonl`, `harness telemetry`) | The per-machine seed of the fleet view. |
| Dashboard storefront + per-run evidence (screenshots, objectives ledger, RTM, governance pack) | The showcase unit: every build already produces its own demo. |

## 2. Target architecture — four planes

```
┌─ Distribution plane ─────────────────────────────────────────────┐
│ Internal npm registry (Artifactory mirror)                       │
│   @firm/harness  — engine + certified catalog, channels:         │
│   latest / next / pinned versions. Content digests verified      │
│   at install AND at run start.                                   │
└──────────────────────────────────────────────────────────────────┘
┌─ Execution plane ────────────────────────────────────────────────┐
│ Tier 1: laptops (default) — zero infra cost, harness ui local    │
│ Tier 2: hosted builders — firm-managed containers for regulated  │
│         desks / thin clients; same engine, same journal          │
│ LLM access ONLY via the firm's model gateway (no direct keys)    │
└──────────────────────────────────────────────────────────────────┘
┌─ Evidence & observability plane ─────────────────────────────────┐
│ Telemetry collector (one HTTPS endpoint) ← journal-derived       │
│ events from every run. Fleet dashboards for the platform team;   │
│ cost attribution to person/team/cost-center; quality metrics.    │
└──────────────────────────────────────────────────────────────────┘
┌─ Showcase plane ─────────────────────────────────────────────────┐
│ App registry + firm gallery: every completed build publishable   │
│ with one click — live preview, evidence pack, screenshots,       │
│ owner, team. Browsable/searchable firm-wide.                     │
└──────────────────────────────────────────────────────────────────┘
```

## 3. Extremely safe infrastructure

**Principle: users never author what runs — they parameterize it.** The attack
surface of 50k builders is the attack surface of the certified catalog, which a
small team controls.

- **Immutable certified types.** Users cannot alter DAGs; `name@version` is
  content-addressed and the runner refuses digest mismatches. Releases are
  signed git tags mirrored into the internal npm registry — no direct-from-
  internet installs.
- **One choke point for models.** All agent traffic goes through the firm's LLM
  gateway (`ANTHROPIC_BASE_URL` to the proxy; no personal API keys). The
  gateway enforces authn (SSO), data-loss prevention, model allow-lists,
  per-user rate limits, and full prompt/response logging for regulated desks.
- **Hermetic agent sessions.** Agent nodes already run with empty
  `settingSources`, explicit tool allow-lists, and certified skills staged from
  the package — no user dotfiles, no ambient MCP servers, no un-certified
  tools. MCP servers are certified artifacts (`certify-mcp`) shipped in the
  catalog, stdio-only.
- **Sandboxed generated apps.** Built apps run under the app-sandbox contract
  (local) or in the hosted tier inside network-restricted containers: egress
  limited to the model gateway and internal package mirrors (npm/PyPI via
  Artifactory). `uv` and `npm` resolve only from the mirrors.
- **Tiered execution for sensitive desks.** Tier 2 hosted builders are
  firm-managed containers (scale-to-zero) with no local disk persistence
  beyond the workspace volume; journals stream out continuously, so even a
  destroyed builder loses nothing auditable.
- **Supply chain.** The engine bundle is a single reviewed artifact (SBOM
  attached at pack time); modules and MCP servers are certified individually;
  CI re-certifies the whole catalog on every change (goldens are
  byte-deterministic, so drift is detectable, not debatable).
- **Security is a pipeline stage, not a policy doc.** Every build already runs
  the security scan and produces a governance evidence pack; the RTM blocks
  uncovered requirements. Firm-specific policy packs (auth, logging, data
  handling) are modules — certified once, composed into every app.

## 4. Cost minimized by construction

**Principle: the expensive path must be opt-in; every default is the cheap path.**

- **Certified budget envelopes.** Every type ships hard per-node and per-run
  caps (~3× observed p95). A runaway build cannot exist: budgets gate the
  start of attempts. Cost data from certification sets expectations *before*
  anyone runs anything.
- **Memoization everywhere.** Revisions re-derive only what changed —
  the certification revision drill proves it per release. Teaching "revise,
  don't rebuild" is the single biggest cost saver at scale.
- **$0 onboarding.** Training, demos, and experimentation use certification
  replay (`--mock-agents`): the full 34-node experience, byte-identical
  artifacts, zero model spend. The default tutorial never touches the gateway.
- **Model tiering is certified, not chosen.** Types pin haiku/sonnet/opus per
  node with escalate-on-retry; users can't accidentally run everything on the
  most expensive model.
- **Prompt-cache-friendly execution.** Slices continue from prior attempt
  trees (retry continuity), keeping context stable and cache hit-rates high at
  the gateway.
- **Quotas + chargeback, not gate-keeping.** Per-person monthly build
  allowances (e.g. 3 live builds ≈ $350 at observed ~$110/complex app) with
  team-level pooling; telemetry attributes every dollar to person/team/
  cost-center automatically from journal cost records. Overage needs a manager
  click, not a platform ticket.
- **Infra near-zero by default.** Tier 1 (laptops) costs the firm nothing;
  Tier 2 builders scale to zero; the gallery serves static evidence packs +
  on-demand previews (apps sleep when idle, wake on first request).

**Cost model at steady state (planning numbers, revisit quarterly):** if 20% of
users run one live build/month at ~$110 p50 → ~$1.1M/yr model spend across
10k monthly builds; collector + gallery + Tier 2 fleet ≈ low six figures.
Certification replay, memoized revisions, and tiering are what hold the p50 down.

## 5. Showcase by default

**Principle: the artifact of a build is a demo, not a zip file.**

- **App registry.** `harness publish <workspace>` (new, small: POST of the
  workspace's evidence — screenshots, objectives ledger, RTM, governance pack,
  design provenance, cost) registers the app under its owner + team with a
  stable URL.
- **Firm gallery.** The storefront, firm-wide: browse/search every published
  app by team, domain, module, framework; each card shows the latest
  screenshot, owner, and "proven" badges (tests green, security clean, RTM
  covered) derived from evidence, not self-reporting. This is the storefront
  UI we already have, fed by the registry instead of a local directory scan.
- **Live previews on demand.** Published apps can be launched in the hosted
  tier (sleep-when-idle) so a reviewer clicks a link and *uses* the app —
  the same preview contract the local dashboard uses today.
- **Team spaces.** Teams get a namespace (gallery shelf + shared quota +
  shared visibility into each other's runs). Managers see their team's shelf;
  demo days become "open the shelf".
- **Recognition loops.** Monthly firm-wide highlights auto-derived from the
  registry (most-used app, best evidence pack, first app on a new module) —
  cheap to run because every metric already exists in the journals.

## 6. Extreme observability (freedom with full visibility)

**Principle: builders are never blocked by observation — everything is
observable because the journal already records it, not because users file
reports.**

- **Telemetry collector.** One HTTPS endpoint. The CLI ships journal-derived
  events (run started/parked/completed, per-node cost, gate answers latency,
  revisions, failures with node id + error class) — batched, async, never
  blocking a build. Local `telemetry.jsonl` remains the offline buffer and
  syncs when connected. `HARNESS_TELEMETRY_URL` is set by the installed
  config; opt-out is a policy decision, not a user toggle.
- **Fleet dashboards (platform team).**
  - *Reliability:* completion rate by type@version, failure Pareto by node,
    retry/escalation rates, park durations — the certification feedback loop
    at fleet scale.
  - *Cost:* spend by type/node/model/team; p50/p95 per build; budget-block
    events (a spike = a mis-sized envelope, fix the type, not the users).
  - *Adoption:* installs, first-build funnel, time-to-first-app, revision vs
    rebuild ratio, supervision-mode mix, checkpoint answer rates.
  - *Quality:* test pass rates, security findings per build, RTM coverage,
    eval scores — trend per type version to catch regressions certification
    missed.
- **Firm visibility.** Every published app carries its full evidence pack and
  journal-derived decision log: who approved which gate, what assumptions were
  recorded, what the security scan found, what it cost. Audit and risk teams
  get read access to the registry — visibility without a new reporting burden
  on builders.
- **Version-cohort rollbacks.** Because telemetry keys on `type@version`, a bad
  release shows up as a cohort within hours; the registry's channel model
  (`latest`/`next`) lets the platform team hold or roll back a version without
  touching user machines.
- **Support built on evidence.** A bug report is a journal (already our
  policy). The collector means the platform team usually has the journal
  before the ticket arrives.

## 7. Phased rollout

Each phase has entry gates (what must be true to start) and exit metrics
(what must be true to scale further). Do not skip gates.

### Phase A — Pilot (50 users, 4–6 weeks)
- **Ship:** internal npm mirror of `@firm/harness`; LLM gateway integration
  (`ANTHROPIC_BASE_URL`); telemetry collector v1 (append-only store + one
  Grafana board); office hours.
- **Users:** hand-picked mix — 2–3 friendly teams, at least one regulated desk
  (to surface Tier 2 needs early), at least 10 people with no dev tooling.
- **Exit metrics:** ≥70% reach a completed app; p95 cost within envelope;
  zero digest/gateway security exceptions; time-to-first-app < 1 day;
  qualitative: 10 users demo their app to their own manager.

### Phase B — Early adopters (500 users, ~1 quarter)
- **Ship:** app registry + firm gallery v1; `harness publish`; team
  namespaces + quotas/chargeback; Tier 2 hosted builders (pilot); registry
  channels (`latest`/`next`) with cohort dashboards; self-serve onboarding
  (the $0 replay tutorial).
- **Exit metrics:** ≥60% monthly active of installed; ≥100 published gallery
  apps; support tickets < 1 per 20 builds; platform team operates releases
  weekly with zero manual user-machine touches; cost/build p50 stable or
  falling.

### Phase C — Scale (5,000 users, ~2 quarters)
- **Ship:** hardened collector (multi-region, retention policy); gallery live
  previews (sleep/wake); manager/team dashboards; second certified project
  type (proves the factory, spreads load); policy-pack modules for the major
  desks; deprecation machinery exercised end-to-end (retire a version, watch
  cohorts migrate).
- **Exit metrics:** reliability ≥85% completion; revision:rebuild ≥ 3:1;
  >30% of builds from outside engineering; audit/risk sign-off on the
  evidence-pack model as an approved control.

### Phase D — Firm-wide (50,000 seats, ongoing)
- **Ship:** seat-wide install via standard software distribution; gallery on
  the intranet home; quarterly certified-catalog releases with published
  cost/reliability notes; community module contribution path (rule of three +
  central certification stays the gate).
- **Steady state:** platform team ≈ 6–10 people: 2–3 certifying types/modules,
  2 on collector/gallery/infra, 2 on support + enablement, 1 product owner.

## 8. What we explicitly are NOT building

- **No per-user cloud dev environments by default.** Laptops + the local
  dashboard already work; hosted builders are for desks that need them.
- **No user-authored pipelines.** Freedom lives in *what* you build
  (requirements, designs, revisions), never in *how the factory runs*.
- **No parallel reporting system.** If a metric isn't derivable from journals,
  evidence packs, or the registry, we change the pipeline to record it rather
  than asking 50k people to report it.
- **No big-bang migration.** Every phase is additive; the laptop-only flow from
  Phase A still works at Phase D.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model gateway becomes a bottleneck/outage point | Local queue + resume (runs park cleanly; journal loses nothing); publish gateway SLOs; replay mode unaffected. |
| Cost surprise at scale | Budgets are certified ceilings; quotas + chargeback from day one of Phase B; weekly cost cohort review. |
| Shadow usage (personal API keys) | Engine only ships gateway-configured from the internal registry; direct-key path disabled in the firm build; telemetry flags gateway-bypass attempts. |
| Gallery becomes stale slideware | Gallery entries are generated evidence, not uploads; "proven" badges expire when the app's type version is deprecated — republish = re-verify. |
| Support load overwhelms the platform team | $0 replay tutorial, evidence-first bug policy, failure-Pareto dashboards to fix the type once instead of answering the same ticket 50 times. |
| A bad certified release lands on thousands | Channels + cohort telemetry + rollback; goldens make regressions byte-visible before release; revision drill certifies the fix path. |

---

*Companion docs: [DESIGN.md](DESIGN.md) (architecture), 
[guides/versioning-and-releases.md](guides/versioning-and-releases.md) (release
mechanics this plan leans on), [CAPABILITIES.md](CAPABILITIES.md) (today's
proven inventory).*
