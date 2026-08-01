# Underwriting Command Center — slices

## Slice 1 — Deal intake, triage agent, and pipeline board (`deal-intake-and-triage`)

An RM files an SMB loan request (`POST /api/deals`) and it becomes a tracked
deal in stage `intake`. The Intake Triage Agent (`POST
/api/deals/{deal_code}/agents/intake-triage/run`) classifies the request,
lists required document types still missing, and recommends an analyst
queue — deterministically, with the LLM narrative kept as advisory context so
the roster's confidence/queue guarantees always hold. Only after an analyst
explicitly accepts the proposal (`POST
/api/deals/{deal_code}/triage/accept`) is the deal assigned to a queue and
routed into `document_extraction`. Every deal is visible on the pipeline
board (`GET /api/pipeline`), grouped by its current stage. Backend:
`ext_deal_intake.py`, plus new shared helpers `deals_repo.py` (event-sourced
deal reads over db.store) and `identity.py` (acting_user_email → users row).
`ext_audit.py`'s `record()` now also persists a normalized row into the
`audit_log` table for every mutation, and `agent_runtime.respond()` takes an
optional `agent_name` so slices after this one can address the roster's other
agents by name. Frontend: the Pipeline Board screen (`screen-pipeline-board`)
gained a "File a New Deal" intake form and an "Intake Triage" proposal panel
(run + accept), and its eight columns now render live from `/api/pipeline`.

**Revision (attempt 2):** the design's Section Index nav was inert, so no
screen but the chat desk could ever be reached (and the slice demo could not
reach its own board). `app.js` now wires the header nav
(`[data-screen="…"]` → `#screen-…`, foundation behaviour every later slice
inherits) and emits a `screen:shown` event the board uses to re-read
`/api/pipeline` when it is brought to the front. The Pipeline Board's find-bar
is now live too: search, stage, owner, risk grade, exposure, and age narrow
the server-loaded deals and report how many of the book is showing. Backend
behaviour is unchanged.

**Revision (attempt 3) — foundation security hardening** from the governance
`code_audit` findings. No feature behaviour changed; every recorded acceptance
check still passes exactly as written and all five screens still work.

1. *The generic `/api/{table}` passthrough is no longer an open door.* Generic
   WRITE access is removed entirely — `POST/PUT/PATCH/DELETE /api/{table}` now
   returns 405, and `main.py` no longer reaches `store.insert` at all; every
   mutation goes through an explicit endpoint that checks role authority and
   records an audit row. Generic READ is restricted to
   `main.GENERIC_READ_TABLES` — `lending_policy`, `adverse_action_reasons` and
   `business_calendar`, the non-sensitive reference/lookup data the UI reads
   directly. Borrower records, spreads, ratios, grades, memos, exceptions,
   approvals, agent outputs, human reviews, Q&A sessions, the audit log and
   the `users` table return 403 there and are served only by their
   access-controlled feature endpoints.
2. *Central server-side role enforcement lives in the identity layer.*
   `identity.py` now carries `ROLE_PERMISSIONS` (relationship_manager submits
   and views its own; credit_analyst spreads/grades/drafts/recommends;
   senior_credit_officer adds approve/decline/return/reassign; admin
   unrestricted) plus the exported guards every ext module should use:
   `require_actor(email, permission, action)` — DEFAULT-DENY, so an email that
   resolves to no stored user can mutate nothing — and `has_permission`,
   `can_view_deal`, `visible_deals` for read scoping. `resolve_user` is now
   documented as provisioning only, never authorization. `ext_deal_intake.py`
   guards all three of its mutations through `require_actor`, including inside
   the two workflow handlers (which are independently reachable through
   `workflow_engine.start()`), and `GET /api/deals` scopes the book to the
   caller when one identifies itself.
3. *Route ordering is enforced, not assumed.* `ext_workflow_runs.py`'s
   `/workflows…` routes (and every other ext router) are mounted by the loop
   at the top of `main.py`, strictly before the `/api/{table}` catch-all is
   declared. `main._assert_route_ordering()` now runs at import time and
   raises on boot if any later slice registers an `/api/…` route after the
   catch-all, so a shadowed endpoint can never ship silently.

### Revision — module hardening to the certified catalog 0.12.1

The five composed module files below predated the hardened module catalog and
were brought up to standard. No feature behavior changed: all four recorded
acceptance checks for this slice still pass exactly as written, every screen
still works, and `frontend/app.js` and `frontend/index.html` were not touched.

1. `backend/ext_audit.py` — an audit entry with no attributable actor is not an
   audit entry. `record(event, detail, actor="system")` now stamps `actor` on
   every entry (machine-driven events default to `"system"`), and
   `AuditRequest` makes `actor` a **required** field, so `POST /audit` without
   one is a 422. `POST /audit` passes `req.actor` through.
2. `backend/ext_workflow_runs.py` — workflow runs now record who drove them.
   `StartRequest` gains `acting_user_email` (default `"system"`), which
   `start()` threads into the run inputs as `_started_by`; a new `TickRequest`
   lets `POST /workflows/runs/{id}/tick` accept an optional body naming the
   actor, and each tick writes a `workflow.ticked` audit entry attributed to
   them. Ticking with no body remains valid for machine-driven advances.
3. `backend/ext_seed.py` — the `@router.post("/admin/seed")` decorator carries
   the `# public-endpoint: dev-only fixture load, hard-gated by
   APP_ALLOW_SEED=1` annotation; the endpoint stays 403 unless that env var
   is set.
4. `backend/ext_blobs.py` (`PUT /files/{name}`) and 5. `backend/ext_uploads.py`
   (`PUT /uploads/{name}`) — these are mutations and are now identity-guarded
   like every other mutation in the app. The caller identifies itself with an
   `x-user-email` header or an `acting_user_email` query parameter (the body is
   raw bytes, so identity cannot ride in it), resolved through
   `identity.require_actor`: anonymous → 401, unknown user → 403, known active
   user → stored, with an audit row written for the write. The upload
   extension allowlist still applies on top for identified callers.

Covered by `backend/tests/test_deal_intake_and_triage.py` (24 tests green).
## Slice 5 — Grounded, permission-scoped portfolio Q&A desk (`grounded-portfolio-qa`)

A credit officer asks the portfolio desk a question in plain English (`POST
/api/qa/ask`) and gets back an answer drawn only from the deal records the
asking user's role is entitled to see. Retrieval scope is resolved
server-side from the caller's role before the Portfolio Q&A Agent ever sees a
row (`resolve_qa_permission_scope`, guarded by `identity.require_actor` with
the `portfolio.query` permission, so an unknown caller reads nothing):
relationship managers see only the deals they filed or hold, analysts and
officers see the active book. A deterministic router
(`_select_records`) narrows further to the deals that actually bear on the
question — no accepted spread, open policy exceptions, a named borrower, or
any of the eight pipeline stages in plain English ("which deals await tiered
approval") — reading each deal only through the roster's declared read tools
(`read_deal`, `read_spread`, `read_ratios`, `read_risk_grade`,
`read_policy_exceptions`, `search_deals_in_scope`, …) enforced through
`tools.invoke()`, so the agent's allow/deny list is structural rather than
documentation. The agent's narrative
(`agent_runtime.respond(..., agent_name="Portfolio Q&A Agent")`) is wrapped
through the citation-tracker module (`citations.attach`/`render`) so every
answer prints the deal ids it actually read; `verify_answer_grounding` then
mechanically checks that every cited id came from the resolved scope before
anything is trusted. Identity questions ("who are you") and any attempt to
get the agent to approve/decline/advance a deal are refused deterministically
before retrieval ever runs. Every exchange — question, grounded answer,
source deal ids, and the full scope/retrieve/groundcheck trace — is recorded
to the immutable `portfolio_qa_sessions` table (`GET /api/qa/sessions`) for
audit, implementing all four deterministic nodes of the `portfolio-qa`
workflow (`workflows/workflows.json`). Backend: new
`ext_grounded_portfolio_qa.py`. Frontend: the Portfolio Desk screen
(`screen-chat`) — previously wired to the scaffold's generic,
design-mismatched `/chat` endpoint — now submits through `/api/qa/ask` and
renders real answers and their deal-id sources in the design's own manuscript
markup (`from-user`/`from-agent`, `msg-sources`); the "Standing Questions"
shortcuts in the marginalia ask the same way, and the "Book at a Glance"
tallies read live from `GET /api/qa/book-summary`.

**Revision (slice 5) — the desk is now wired to live deal data.** The agent
previously refused portfolio questions such as "which deals await tiered
approval" because the records it was handed were not presented as its
knowledge, so it fell back on "not covered — hand off to a human". Fixed:
`retrieve_grounded_deal_context` now builds the agent's context at question
time from the STORED deal records — stage, status, requested and exposure
amounts, risk grade, whether a spread has been accepted, open policy
exceptions and their rule references, computed ratios, owner and idle days —
for exactly the deals the asker's role may see, and hands that record set to
`agent_runtime.respond()` as the question's provided knowledge together with
system-computed totals. Every figure the desk quotes is computed in
deterministic code (`_portfolio_facts`); no arithmetic is delegated to the
model. Safety is unchanged and enforced in code: answers stay framed as an
automated draft pending analyst approval, decision requests are still
refused, an asker with nothing in scope is still told there is nothing to
ground an answer in rather than being given invented figures, and a model
reply that ignores the records it was given is replaced by the deterministic
digest of those records (the raw reply is kept in the session trace for
audit). New `GET /api/qa/book-summary` serves the desk's tallies from the
same permission-scoped records. Every recorded acceptance check passes
exactly as written; `frontend/app.js` changes remain a pure append.
