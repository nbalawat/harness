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

## Slice 2 — Cited financial spread, deterministic ratios, and risk grade (`spread-ratios-and-risk-grade`)

An analyst opens a deal dossier and runs the Financial Spreading Agent (`POST
/api/deals/{deal_code}/agents/financial-spreading/run`), which transcribes the
bank's standard spread template — one row per line item, period, value and
unit — from the attached documents. **Every figure carries a structured
citation** (document id plus page, section and cell locator); a line the agent
cannot read is reported under `unextractable` and is never given a number. The
draft is checked before a human ever sees it: `validate_spread_citations`
rejects the run outright (422) if any row arrived without a document + locator.
Nothing reaches `financial_spread_template` until a named analyst accepts,
edits-then-accepts, or rejects the draft (`POST
/api/deals/{deal_code}/spread/accept`) — a rejection needs a written reason and
writes no figures, and an edited line item must still resolve to a cited
source. Acceptance then triggers, in deterministic Python and never an LLM,
DSCR, leverage and the current ratio (`GET /api/deals/{deal_code}/ratios`,
each row storing its numerator, denominator, `half_up_2dp` rounding and
`undefined_when_denominator_zero` handling) and the risk grade from the
versioned rubric (`GET /api/deals/{deal_code}/risk-grade`, returning the grade,
`rubric-v2.1`, the exact band struck and the whole inspectable rubric).
Supporting endpoints: `POST /api/deals/{deal_code}/documents` attaches a
borrower document with its digitised extract sheet (held in blob-store — the
only thing the agent may transcribe from, which is what makes "every figure is
cited" enforceable), `GET /api/deals/{deal_code}/spread` returns the accepted
spread with its citations, and `GET /api/deals/{deal_code}/dossier` assembles
the whole screen in one read. All reads are scoped through
`identity.can_view_deal`; every mutation is guarded by
`identity.require_actor(…, "deal.spread")` and writes an audit row
(`deal.document_attached`, `spread.agent_run`, `spread.citations_validated`,
`spread.accepted`/`spread.rejected`, `ratio.computed`, `risk_grade.assigned`).

Backend: one new file, `ext_spread_ratios_and_risk_grade.py`, which also
registers five of the `deal-underwriting-lifecycle` workflow's deterministic
handlers — `verify_required_documents`, `validate_spread_citations`,
`persist_accepted_spread`, `compute_financial_ratios` and `assign_risk_grade` —
and calls exactly those functions from its REST endpoints, so the workflow
contract and the shipped behaviour cannot drift apart. It also installs a
composable wrapper around `deals_repo.next_deal_code` that skips the deal codes
it reserves, honouring that module's documented promise that the counter is
independent of fixture deals inserted with an explicit code (no shared module
is edited). A worked demonstration dossier, `DEAL-1002` — Verrazano Dental
Group, LLC, $640,000, with its three-document financial pack — is materialised
once at import under that reserved code so the screen has a real spread to
draft on a fresh boot.

Frontend: the Deal Dossier screen (`screen-deal-detail`) is now live end to
end inside the design's shell. An "open dossier" find-bar loads any deal from
the board; the head, document docket (with an attach-a-document form that
takes the extract sheet), spread table, unextractable list, citation rail,
deterministic-ratio table and rubric strip all render from
`/api/deals/{code}/dossier`; and the spread desk's run / accept / edit /
reject controls drive the endpoints above, with "edit before accepting"
turning the drafted values into editable fields. The memo, policy-exception
and decision desks on the same screen drive the endpoints the later slices of
this lifecycle own and report plainly when the step they need has not been
reached yet. No shared chrome, other screen, or shared CSS was restructured.

Covered by `backend/tests/test_spread_ratios_and_risk_grade.py` (20 tests
green; 44 across the suite).
