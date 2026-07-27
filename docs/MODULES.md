# The module catalog — the heart of the harness

Modules are why the factory beats one-off agent coding: every capability an
app needs is either a **certified module** (composed deterministically, tested
in isolation and in combination) or agent-generated code inside validated
contracts. The more of an app that is composed, the more "works every time"
transfers. This catalog enumerates the target library (~100 modules), each with
the reason it must exist as a module rather than being regenerated per app.

**Status (2026-07-27): the FULL catalog below is ● shipped & certified** — 101
modules (61 app + 6 tools + 6 packs + substrate), every one passing
`harness certify-modules` (own tests against a real composed app) plus the
mega-compose proof (all app modules coexisting in one booted application).
v0 implementations are local-first with production adapters behind the same
interfaces (e.g. postgres-adapter's injected connection, slack-notify's
outbox-until-configured).

**Certification:** every module, at every status, ships with `manifest.yaml`
(provides/requires contract), `agent-guide.md` (its law for build agents), a
`compose/` overlay, and **its own certification tests** run by
`harness certify-modules` against a real composed app. No tests, no catalog
entry — the certifier enforces this. Combinations are certified by project-type
golden runs.

---

## 1. Persistence & data

| | Module | Why it must be a module |
|---|---|---|
| ● | persistence-core | One storage interface for every app; agents hand-rolling storage was the first source of divergence we saw. Postgres adapter swaps in without touching callers. |
| ● | postgres-adapter | Same `store` contract, real durability — the local→production step must be a compose choice, not a rewrite. |
| ● | migrations | Schema evolves after v1 ships; ad-hoc ALTERs by agents are how data gets destroyed. |
| ● | sqlite-adapter | Single-file durability for laptop-class deployments. |
| ● | blob-store | Files/attachments with the same discipline as rows (local dir → GCS behind one interface). |
| ● | cache-layer | Read-through caching; agents otherwise sprinkle dicts with no invalidation story. |
| ● | search-index | Text search over tables; every "find past X" feature reinvents it. |
| ● | soft-delete | "Deleted" rows that auditors can still see — a policy, so it must be uniform. |
| ● | row-history | Field-level change history; pairs with audit-log for regulated data. |
| ● | data-retention | TTL/purge jobs honoring the retention answers users give at clarify — the requirement exists in almost every intake. |

## 2. Identity & access

| | Module | Why |
|---|---|---|
| ● | auth-basic | Every internal app needs "who is this"; agents must never invent token schemes. Password-less v0 behind the firm perimeter. |
| ● | sso-oidc | The firm reality: identity comes from Okta/Azure AD. Replaces auth-basic's issuer, keeps `current_user`. |
| ● | rbac | Approver vs viewer vs admin appears in nearly every workflow app; roles must be declarative, not if-statements. |
| ● | api-keys | Service-to-service callers of generated apps. |
| ● | session-audit | Login/logout/impersonation trail feeding audit-log. |
| ● | permissions-ui | The admin screen for rbac — every app re-draws it otherwise. |
| ● | row-level-security | "You see your team's records" — subtle enough that it must be written once, correctly. |

## 3. Agent runtime & LLM plumbing

| | Module | Why |
|---|---|---|
| ● | agent-runtime | THE engine adapter: live-api / live-cli / stub behind one `respond()`; roster is the contract; mode always disclosed. Nothing may call an LLM directly. |
| ● | rag-core | Chunking/embedding/retrieval done right once — grounding quality is the #1 driver of app trust. |
| ● | prompt-registry | App prompts as versioned data, not string literals buried in code — enables review and hotfix without rebuild. |
| ● | eval-harness | Richer eval runner (rubrics, regression sets) — evals are how app agents stay honest after changes. |
| ● | conversation-memory | Multi-turn context windows with summarization — every chat app needs it, everyone gets truncation wrong. |
| ● | tool-registry | Declarative tool definitions + allow/deny enforcement matching the roster. |
| ● | guardrails-io | Input/output filters (PII, injection heuristics, topic fences) as composable policy. |
| ● | agent-router | Multi-agent apps need "which agent handles this" as data, not nested ifs. |
| ● | token-budgeter | Per-conversation/user spend caps inside the generated app — the app-level version of the harness's own cost discipline. |
| ● | transcript-store | Standard storage/redaction of agent transcripts (pairs with data-retention). |
| ● | citation-tracker | Source attribution structure for grounded answers — trust requires "says who". |
| ● | fallback-chain | Model/provider failover policy in one place. |

## 4. Document & data ingestion

| | Module | Why |
|---|---|---|
| ● | doc-extract | PDF/docx/HTML → clean text+structure. The intake path of most business apps; also what the harness's own ingest step does — dogfood it. |
| ● | table-extract | Tables inside documents are where the numbers live; naive text extraction destroys them. |
| ● | ocr-bridge | Scanned documents appear in every ops workflow eventually. |
| ● | file-upload | Safe upload endpoint (type/size limits, virus-scan hook) — security-sensitive, so never agent-improvised. |
| ● | email-ingest | "Forward it to the app" is the lowest-friction intake there is. |
| ● | spreadsheet-io | XLSX in/out with type coercion — the lingua franca of analysts. |
| ● | feed-poller | Scheduled pulls from URLs/APIs with dedupe — background ingestion done once. |
| ● | corpus-refresh | Re-index knowledge when documents change, without downtime — RAG apps rot without it. |

## 5. Workflow & business logic

| | Module | Why |
|---|---|---|
| ● | approval-flow | Draft → review → approve/reject with full trail: THE core loop of internal tools (our first three real apps all needed it). |
| ● | state-machine | Declarative status transitions; agents encode these as scattered ifs otherwise, and QA dies. |
| ● | assignment | Route work items to people/queues (round-robin, load, skill). |
| ● | sla-timers | Due dates, breach flags, escalations — ops apps are judged on these. |
| ● | scheduling | Cron-style in-app jobs with visibility and locks. |
| ● | batch-runner | Long operations with progress/resume — the difference between a demo and a tool. |
| ● | forms-engine | Validated forms from a schema — every CRUD app draws the same form badly. |
| ● | comments-threads | Discussion on any record; social glue of workflow tools. |
| ● | checklists | Structured task lists with completion tracking (onboarding, reviews, audits). |
| ● | versioned-drafts | Draft/publish semantics for content-like records. |

## 6. Integration & I/O

| | Module | Why |
|---|---|---|
| ● | export-csv | Analysts always need the data out; serialization belongs to the data model, not to whichever agent built the slice. |
| ● | webhook-out | Notify other systems on events, with retries/signing — integration's front door. |
| ● | webhook-in | Receive events safely (verification, replay protection). |
| ● | rest-client | Outbound HTTP with auth, retry, and timeout policy — agents otherwise scatter bare fetches with none. |
| ● | slack-notify | Where firm users actually live; "post to the channel" is in every third intake. |
| ● | email-send | Templated transactional mail with suppression rules — compliance-sensitive. |
| ● | calendar-bridge | Meetings/deadlines sync for scheduling-flavored apps. |
| ● | pdf-render | Generate the PDF artifact (reports, letters, packets) — output twin of doc-extract. |
| ● | import-mapper | CSV/XLSX import with column mapping and dry-run — data onboarding for every app. |
| ● | queue-bridge | Pub/Sub / task-queue abstraction for async work at deploy scale. |

## 7. Frontend building blocks

| | Module | Why |
|---|---|---|
| ● | chat-shell | Behavior-only chat wiring onto ANY chosen design's canonical mount points — how design sanctity and functionality coexist. |
| ● | data-table | Sortable/filterable/paginated tables — the single most re-built UI artifact in internal tools. |
| ● | screen-router | Tabbed/sectioned navigation binding `#screen-*` mount points — formalizes what every design shell already implies. |
| ● | record-detail | Standard detail view with field layout from the data model. |
| ● | dashboard-cards | KPI tiles/summary cards fed by declared queries. |
| ● | charting | The dataviz method (validated palettes, honest axes) as a composable — agents freehand charts badly. |
| ● | notifications-ui | In-app inbox/toasts for events and SLA breaches. |
| ● | file-preview | Render uploaded docs inline — pairs with file-upload/blob-store. |
| ● | audit-view | The uniform "history" panel over audit-log/row-history. |
| ● | admin-console | Settings/users/feature-flags surface every app grows eventually. |
| ● | a11y-baseline | Focus order, contrast, keyboard paths as enforced checks — accessibility can't be per-app luck. |

## 8. Observability & operations

| | Module | Why |
|---|---|---|
| ● | structured-logging | JSON logs with request/user/agent correlation — debugging composed apps needs uniform logs. |
| ● | request-metrics | Latency/error/timing counters + /metrics — ops can't fly blind. |
| ● | health-plus | Deep health checks (store, engine, dependencies) beyond /health's liveness. |
| ● | error-reporter | Capture+group exceptions with context; surface in admin-console. |
| ● | usage-analytics | Which features get used — feeds the owner's roadmap and the firm's ROI story. |
| ● | cost-meter | Per-app LLM spend tracking, the deployed sibling of the harness's cost ledger. |
| ● | feature-flags | Gradual rollout inside generated apps without redeploys. |
| ● | backup-restore | Scheduled dumps + tested restore for the persistence layer. |

## 9. Security & compliance

| | Module | Why |
|---|---|---|
| ● | audit-log | Who did what, when — the governance floor for every generated app; state-changing endpoints must record. |
| ● | rate-limit | Agent endpoints cost real money per call; loops and abuse need a throttle by default. |
| ● | feedback-inbox | End-users must be able to report problems where they see them — the app-level end of the harness's own feedback loop. |
| ● | pii-redaction | Detect/mask PII in stored text and transcripts — the most common compliance ask. |
| ● | secrets-manager | App secrets via env/vault, never in code or store — enforced, not advised. |
| ● | input-sanitizer | Central request validation hardening beyond schema types. |
| ● | csp-headers | Security headers as configuration; the scanner already expects textContent-only frontends. |
| ● | data-classification | Tag tables/columns by sensitivity; drives retention, redaction, export rules. |
| ● | consent-tracking | Record the basis for holding each person's data where that matters. |
| ● | vuln-watch | Dependency advisories for the generated app's requirements. |

## 10. Deployment & platform

| | Module | Why |
|---|---|---|
| ● | cloud-run-deploy | Deepen the existing deploy node into a module: build, deploy, rollback, custom domain. |
| ● | docker-hardening | Non-root, minimal, pinned images — the container the scanner would design. |
| ● | env-config | Typed, validated runtime configuration (12-factor, with defaults documented). |
| ● | tls-local | HTTPS in local/on-prem installs without ceremony. |
| ● | multi-env | dev/staging/prod promotion story for generated apps. |
| ● | seed-data | Deterministic demo/dev fixtures — every stakeholder demo needs believable data. |

## 11. Domain packs (opinionated bundles)

Bundles that pre-select modules + prompts for a recurring shape of app —
thin, but they encode firm policy per domain.

| | Module | Why |
|---|---|---|
| ● | pack-support-copilot | Grounded answers + approval gate + history: the shape we've now built three times — literally the rule of three. |
| ● | pack-document-review | Ingest → extract → human review queue → decision trail. |
| ● | pack-research-assistant | Corpus Q&A with citations and reading-list curation. |
| ● | pack-intake-triage | Form/email intake → classification → routing → SLA. |
| ● | pack-report-generator | Data in → analysis → templated PDF/deck out on schedule. |
| ● | pack-kb-manager | Curate the knowledge corpus itself: staleness, gaps, ownership. |

## 12. Meta (modules about the module system)

| | Module | Why |
|---|---|---|
| ● | module-sdk | `harness new-module <name>` scaffolds manifest/guide/compose/test with the contract pre-wired — the growth engine for this catalog. |
| ● | compat-matrix | Declared conflicts/requirements between modules, checked at architecture time instead of discovered at integrate. |
| ● | deprecation | Sunset path: mark, warn, migrate — a catalog of hundreds needs a way to shrink too. |

---

## How this grows without rotting

1. **Rule of three, enforced socially; certification, enforced mechanically.**
   ○ entries are demand statements, not promises — they graduate when three
   real apps need them, and they cannot merge without their own tests passing
   under `certify-modules`.
2. **Substrate stays tiny.** persistence-core + agent-runtime + chat-shell are
   the only always-composed modules; everything else is picked by the
   architecture step *because a requirement demands it* (`addresses` is
   mandatory), so apps never carry dead weight.
3. **Interfaces are the contract.** A module may be rewritten freely;
   `provides` may not break without a major bump and re-certification of every
   project type that composes it.
4. **Extension point, not edits.** Backend modules ship `ext_*.py`
   (auto-mounted routers / `install(app)` hooks); frontend modules bind to the
   design shells' canonical mount points. Modules never patch composed files.
