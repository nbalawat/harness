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

## Slice 4 — Tiered human approval, adverse action, and the idle register (`tiered-approval-and-sla`)

A credit officer decides a deal from its dossier: `POST
/api/deals/{deal_code}/approve` enforces approval authority by exposure tier
server-side (`determine_approval_tier` — analyst up to $250,000, senior
credit officer up to $1,000,000, credit committee above), returning 403 with
"authority" in the detail when the acting user's role is under-ranked for
the deal's exposure, and 200 (with the deciding role/email and the closed
stage) when it is not. `POST /api/deals/{deal_code}/decline` requires a
reason code drawn from the controlled `adverse_action_reasons` list plus a
written detail (R-063), and `POST /api/deals/{deal_code}/return` sends a
deal back to an earlier stage with a written reason and reassigns it to the
analyst queue. Every decision is guarded against being re-decided and is
recorded through `record_approval_decision` / `record_adverse_action_or_return`
/ `close_approved_deal` — the deterministic handlers for the
`deal-underwriting-lifecycle` workflow's `tier`/`record`/`outcome`/`close`
nodes, invoked directly the same way `ext_deal_intake.py` invokes its own
nodes, since the nodes upstream of `tier` belong to sibling slices. The SLA
idle register (`GET /api/sla/idle`) measures every open deal's idle time in
business days — weekends and any `business_calendar` holiday excluded — from
its last meaningful activity, and `POST /api/deals/{deal_code}/sla-escalate`
lets a credit officer reassign, return, or acknowledge a stuck deal
(`compute_business_day_idle_time` / `collect_stage_blockers` /
`apply_sla_escalation_action`, the `sla-idle-escalation` workflow's
handlers — no agent participates, per that workflow's own design). Backend:
new `ext_tiered_approval_and_sla.py`; it also seeds its own fixture deals
(`DEAL-1004`..`DEAL-1007`) directly with an explicit `deal_code`, exactly as
`deals_repo.py` describes, so the tier/decline/idle acceptance paths have
known state to act on. Frontend: the SLA Dashboard screen
(`screen-sla-dashboard`) now renders its plates, idle register, and "Idle by
Stage"/"Idle by Desk" tallies live from `/api/sla/idle`, and its "Reassign
selected" / "Nudge owners" controls act on the checked rows.

**Revision (attempt 2, merge-safety only — no behaviour change):** this
slice's `frontend/app.js` block was already appended after the foundation's
last byte, but its boundary lines (`(function () {`, a `// =====` banner, and
a closing `})();`) were textually identical to the foundation's own last
lines, so a line-level union merge aligned the block *before* the
foundation's final line and conflicted with sibling slices appending the
same generic boundary. The module is now delimited by unique lines — it
opens `(function sliceTieredApprovalAndSlaModule() {` under a
`// --- begin slice tiered-approval-and-sla ... ---` comment and closes
`})(); // --- end slice tiered-approval-and-sla ---` — so `diff` reports one
pure trailing-append hunk with zero deletions and the first 403 lines of
`app.js` remain byte-identical to the foundation. No backend, HTML, or
behavioural change; all acceptance checks still pass.

**Revision (attempt 3) — slice-audit findings.** Three hardening changes in
`ext_tiered_approval_and_sla.py`; every recorded acceptance check still passes
exactly as written, `app.js` is still a pure trailing append, and the SLA
Dashboard screen is unchanged.

1. *An open policy exception now blocks approval (HIGH).* `approve_deal`
   refuses with 409 while the deal carries any unwaived `policy_exceptions`
   row, naming the offending `rule_reference`s and telling the officer to
   waive each with a written rationale or return the deal for rework. The
   check fails CLOSED — a row with a missing or unrecognised status counts as
   open. The remedy is real, not advice: the new officer-only
   `POST /api/deals/{deal_code}/policy-exceptions/waive` carries the
   exception forward on a fresh `status: "waived"` row (append-only, the same
   event-sourced pattern `deals_repo.update_deal` uses) with the deciding
   human and their rationale recorded and audited. Because
   `policy_exceptions` is append-only, "open" is computed by folding to the
   latest row per `(deal_id, rule_reference)`, which `collect_stage_blockers`
   now shares. The DEAL-1004..1007 fixtures carry no exception (a test
   asserts it), so the recorded approve/decline acceptance paths are
   untouched.
2. *`return_deal` uses the same `_already_decided` guard* as `approve_deal`
   and `decline_deal`, so an approved, declined or closed deal can no longer
   be reopened by a return.
3. *Approval authority is resolved server-side, default-deny.* All five
   mutating endpoints (approve, decline, return, waive, sla-escalate) now go
   through the foundation guard `identity.require_actor(...)` instead of
   `identity.resolve_user(...)`, which is documented as provisioning-only and
   would have minted a `credit_analyst` for any unknown email. The exposure
   tier (analyst to $250k, senior credit officer to $1M, credit committee
   above) is applied to the role read off the stored `users` row, never off
   anything in the request body. `credit_committee` is passed through
   `require_actor`'s `roles=` parameter rather than `ROLE_PERMISSIONS`
   because it is a tier authority this slice introduces and the shared
   identity module is being built on concurrently by sibling slices.
