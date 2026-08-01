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
