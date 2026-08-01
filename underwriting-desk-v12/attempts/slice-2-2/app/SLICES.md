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
## Slice 2 — Cited financial spread, deterministic ratios, and risk grade (`spread-ratios-and-risk-grade`)

A credit analyst opens the Deal Dossier (`screen-deal-detail`, now wired end
to end) for a deal, runs the Financial Spreading Agent (`POST
/api/deals/{deal_code}/agents/financial-spreading/run`), which reads the
deal's attached documents and drafts the standard spread template — every
row carries a document-and-locator citation, and a figure no document
supports is reported under `unextractable` rather than guessed. The analyst
accepts, edits, or rejects the draft (`POST
/api/deals/{deal_code}/spread/accept`); acceptance persists the spread and
immediately, in deterministic code, computes DSCR, leverage, and current
ratio (`GET /api/deals/{deal_code}/ratios`, each with numerator, denominator,
rounding method and divide-by-zero handling recorded) and assigns the risk
grade from the versioned rubric (`GET /api/deals/{deal_code}/risk-grade`),
showing the exact band it struck. The deal advances to `memo_drafting` once
graded. Backend: new `ext_financial_spreading.py`, registering the
workflow's `verify_required_documents`, `validate_spread_citations`,
`persist_accepted_spread`, `compute_financial_ratios`, and `assign_risk_grade`
node handlers, plus `GET /api/deals/{deal_code}`, `GET`/`POST
/api/deals/{deal_code}/documents`. A fixture deal (`DEAL-1002`, fully
documented) is seeded at import time — directly into the `deals`/`documents`
tables, bypassing the deal-code sequence — so the dossier has something to
spread the moment the app boots, without disturbing slice
`deal-intake-and-triage`'s hardcoded `DEAL-1001`. Frontend: the Deal Dossier
screen gained a deal-code loader, a live Financial Spread agent panel
(run/accept/edit/reject wired to real endpoints, with citations rendered in
the margin rail and the document docket read from the deal's attached
documents), a live deterministic-ratios table, and a live risk-grade rubric
strip. The memo, policy-exception, and approval controls on this screen
belong to later slices in the lifecycle; until those ship, this slice leaves
them visibly disabled with an explanatory note rather than wired to nothing.

**Revision (attempt 2, audit findings):** this slice's mutating endpoints now
use the foundation's server-side guard, `identity.require_actor(email,
"deal.spread", …)`, instead of a local role set — the acting user's role is
resolved server-side and an email that is not a stored, active user may mutate
nothing (default-deny), so running the Financial Spreading Agent, accepting a
spread, and attaching a document are all analyst-or-above. The `savespread`
workflow node re-verifies the same authority at the point of persistence,
since it is also reachable through a workflow run. `DocumentAttachRequest`'s
`document_type` is now a controlled vocabulary (`balance_sheet`,
`income_statement`, `tax_return`, `bank_statement`,
`accounts_receivable_aging`, `debt_schedule`,
`personal_financial_statement`, `entity_formation`) rather than free text, so
an unrecognised type is rejected with a 422 before it can silently fail the
required-document check. No endpoint paths, payloads, or UI behaviour changed.
