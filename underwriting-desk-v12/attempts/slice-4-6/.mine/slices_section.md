## Slice 4 — Tiered human approval, adverse action, and the idle register (`tiered-approval-and-sla`)

A credit officer decides a deal from the Idle Register screen's **Credit
Decision Desk**: `POST /api/deals/{code}/approve`, `POST
/api/deals/{code}/decline`, `POST /api/deals/{code}/return`. Approval
authority is a function of exposure and is enforced SERVER-SIDE by the ladder
in `ext_tiered_approval_and_sla.APPROVAL_TIERS` — at or below
`identity.MAX_APPROVAL_EXPOSURE` ($250,000) a credit analyst holds authority;
above it only a senior credit officer or admin does, so an analyst approving
DEAL-1004 at $900,000 gets a 403 naming the authority it lacks while
officer@bank.test gets a recorded `senior_credit_officer` approval. Decisions
are idempotent on (deal, decision, decider) — a double submit replays the
same `approvals` row rather than writing a second one — and go through
`approval_flow`, never an ad-hoc status field. A decline is an adverse action:
it must carry a `reason_code` from the controlled `adverse_action_reasons`
register plus written detail, or it is refused with the list of valid codes.
A return records a `deal_returns` row with the written reason and moves the
deal back a stage.

`GET /api/sla/idle` is the service line: idle time per deal is measured in
BUSINESS days (weekends plus the seeded 2026 bank-holiday `business_calendar`
excluded) from `last_activity_timestamp`, in deterministic Python — no LLM
touches a date or an amount anywhere in this slice. Everything past five
business days is listed worst-first with its exposure, blocking work,
owning desk and `escalation_owner`. `POST /api/sla/{code}/escalate` drives the
whole `sla-idle-escalation` workflow end to end through `workflow_engine`
(measure → breached? → blockers → human park in approval-flow → apply), and
`POST /api/deals/{code}/reassign` hands a stalled deal to another desk.

Workflow handlers registered: `determine_approval_tier`,
`record_approval_decision`, `record_adverse_action_or_return`,
`close_approved_deal` (deal-underwriting-lifecycle) and
`compute_business_day_idle_time`, `collect_stage_blockers`,
`apply_sla_escalation_action` (sla-idle-escalation). Also here:
`GET /api/deals/{code}/decisions` (the decision record, permission-scoped)
and `GET /api/approval-tiers` (the published ladder, the adverse-action
register, the returnable stages and the deals awaiting a decision).

Fixtures for this desk (DEAL-1004 Ironvale Fabrication, DEAL-1005 Vellum
Bookbinding, DEAL-1006 Quarry Road Concrete, plus three more idle/approaching
deals) are inserted at import with explicit deal codes. Because
`deals_repo.next_deal_code()` counts from DEAL-1001 and cannot see explicitly
coded rows, this module wraps that allocator once (`_reserve_fixture_deal_codes`)
so the intake sequence steps over codes already taken — the first filed deal
is still DEAL-1001, and a fixture can never be silently overwritten by a newly
filed borrower. The shared `deals_repo.py` file itself is untouched.

Frontend: `screen-sla-dashboard` only. The Credit Decision Desk (approve /
decline / return with a live authority read-out, an adverse-action code list
and a decision receipt showing the authority exercised and the idempotency
key), the four service-line plates, the idle register table (live, worst
first, rows click to select), the Idle-by-Stage and Idle-by-Desk panels, and
the "Act on the Register" console (reassign / acknowledge, which run the
escalation workflow) all read and write real endpoints. No other screen, no
shared chrome, and no shared CSS was touched. Backend: new
`backend/ext_tiered_approval_and_sla.py` (auto-mounted by main.py's ext loop,
so it is registered before the `/api/{table}` catch-all and nothing is
shadowed). Covered by `backend/tests/test_tiered_approval_and_sla.py`.
