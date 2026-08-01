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

## Slice 4 — Tiered human approval, adverse action, and the idle register (`tiered-approval-and-sla`)

A credit officer approves (`POST /api/deals/{code}/approve`), declines with a
controlled adverse-action reason (`POST /api/deals/{code}/decline`), or returns
a deal to an earlier stage with a written reason and a re-assignment (`POST
/api/deals/{code}/return`) — and the desk watches the SLA idle register (`GET
/api/sla/idle`) for deals that have not moved in more than five **business**
days, acting on them through `POST /api/sla/escalate`. Supporting reads: `GET
/api/deals/{code}/approval-tier` (who may decide this deal, and why) and `GET
/api/approvals/queue` (everything sitting at the approval step). All backend
code is new and lives in `backend/ext_tiered_approval_and_sla.py`; no shared
module was rewritten.

**Authority is the server's decision, tiered on exposure (R-020/R-021/R-022).**
`tier_for()` is pure arithmetic: up to $250,000 a credit analyst may approve,
up to $1,000,000 a senior credit officer, above that only the credit
committee. `_require_decision_authority` resolves the caller through
`identity.require_actor` (default-deny: anonymous → 401, unknown or
deactivated → 403) and then checks the tier, so an analyst approving a
$750,000 deal is refused before anything is written. Declines and returns
additionally require the officer-only `deal.decline` / `deal.return`
permissions (R-033). **No agent is involved anywhere in this path (R-023):**
the module never imports `agent_runtime` at all — a system guardrail rather
than a prompt instruction — and a test asserts that stays true.

**Every decision is a named human's and is recorded once (R-024/R-030/R-062).**
An `approvals` row stores the deciding user, the authority level verified, the
exposure and the notes, and `ext_audit.record` writes an audit row for the
decision, the outcome and the close. Replaying the *same* decision returns the
stored record (`replayed: true`) instead of approving twice; a *conflicting*
second decision is a 409. Stage moves go through the `state-machine` module, so
approving a deal that is not at the approval step is a 409 rather than a silent
jump. A decline needs a `reason_code` from the active `adverse_action_reasons`
list plus free-text detail, both validated before any write (R-026/R-063).

**Idle time is counted in business days from the last meaningful activity
(R-034/R-057).** `business_days_between()` walks the calendar excluding
weekends and any `business_calendar` date flagged non-business (the configured
bank-holiday list is seeded and reported by the register). Acknowledging a deal
deliberately does *not* reset the idle clock — only real work (reassignment,
return) does — so a deal cannot be nursed off the register. `POST
/api/sla/escalate` runs the approved `sla-idle-escalation` workflow end to end
(measure → breached? → blockers → human park in approval-flow → apply) rather
than re-implementing it. `GET /api/sla/idle` withholds borrower names from an
unidentified caller and scopes rows to what an identified one may see.

**Workflow handlers registered** (contracts from `workflows/workflows.json`):
`determine_approval_tier`, `record_approval_decision`,
`record_adverse_action_or_return`, `close_approved_deal` on
deal-underwriting-lifecycle, and `compute_business_day_idle_time`,
`collect_stage_blockers`, `apply_sla_escalation_action` on
sla-idle-escalation.

**Frontend — `screen-sla-dashboard` only.** Inside the design's existing shell:
a "Decision Desk — Tiered Approval" manuscript (approval queue, live tier
explanation, approve / decline-with-reason-code / return-for-rework), live
plates, a live idle register whose rows are selectable, live "Idle by Stage" /
"Idle by Desk" / bank-holiday panels, and the design's own "Reassign selected"
and "Nudge owners" buttons wired to the escalation workflow. No other screen,
shared CSS or chrome was touched.

**Desk fixtures.** `install_desk_fixtures()` seeds the controlled reason-code
vocabulary, the bank-holiday calendar, and four reference deals (DEAL-1004
$750k awaiting decision, DEAL-1005 long idle, DEAL-1006 declinable, DEAL-1007
$1.25M committee-tier) so the register and decision desk open on real data.
Fixture deals use explicit codes and do **not** consume the deal-code sequence,
so a deal filed through intake is still DEAL-1001; a small additive guard wraps
`deals_repo.next_deal_code` so the allocator skips forward past any code a
fixture already holds instead of issuing a duplicate `deal_code`.

**Open questions carried forward, not silently decided:** R-069 (exposure basis)
— the deal's own `exposure_amount` is used and named in `exposure_basis` on
every tier response; R-068 (committee mechanics above $1M) — the build requires
an explicit committee role and records one decision, and says so in
`committee_mechanics_open_question`.

Covered by `backend/tests/test_tiered_approval_and_sla.py` (26 tests; 51 green
across the suite).
