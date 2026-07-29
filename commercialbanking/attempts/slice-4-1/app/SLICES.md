# Commercial Banking Underwriting — slices

## Slice 1 — Intake, agent triage, and the pipeline board (`intake-triage-pipeline`)

A relationship manager submits a loan application (email export + a financials
spreadsheet) via `POST /deals/intake`; artifacts are stored through
`blob_store` and the deal is created at stage `intake` with a human-readable
id (`DEAL-001`, ...). `POST /deals/{id}/triage/run` runs the Intake Triage
Agent: the structured proposal (request type, product type, underwriting
suitability, missing documents against the published checklist, recommended
analyst queue) is computed deterministically from the deal's own stored
artifacts, and the agent's `agent_runtime.respond()` reply is folded in as
advisory rationale narrative only — never the source of a routing decision,
matching the citation/provenance pattern used elsewhere in this codebase.
`POST /deals/{id}/triage/accept` records the named analyst's decision, routes
the deal into the confirmed (or overridden) analyst queue via the
`assignment` module, and advances `current_stage` through `deal_state`'s
state machine (`intake` -> `financial_spreading`). `GET /deals` powers the
pipeline board — every active deal with its real `current_stage`. Every step
writes to the domain `audit_trail` table plus the generic audit log.

The four deterministic workflow nodes this slice owns
(`record_intake`, `persist_triage_draft`, `apply_triage_decision`,
`route_to_queue` in `workflows/deal-underwriting`) are registered as real
`workflow_engine` handlers, so driving the workflow generically through
`POST /workflows/deal-underwriting/start` also runs intake through the
triage draft and parks correctly at the `review_triage` human gate — the REST
endpoints call the same handler functions directly to give the three-step
submit / propose / accept contract the acceptance criteria require.

Frontend: the Intake screen gained a real "Submit new application" form and a
"Live triage queue" lane showing the agent's proposal with an "Accept &
route" action; the Pipeline board screen gained a "Live deals" lane showing
every real deal and its current stage. Both render into the locked Pipeline
Atlas design's existing lane/card/chip markup (`frontend/deals.js`) — no
shell elements were changed.

## Slice 2 — Financial spreading with provenance, ratios, and risk grade (`spread-ratios-grade`)

`POST /deals/{id}/spread/run` runs the Financial Spreading Agent against a
routed deal: every line item of the fixed `spread_template.STANDARD_SPREAD_TEMPLATE`
schema is extracted deterministically from the deal's stored spreadsheet
artifact (parsed with the `spreadsheet_io` module, never a hand-rolled CSV
reader), and for every figure the exact source artifact id, its row location,
and the verbatim raw text it was read from are stored alongside it in
`spread_line_items` — never inferred or invented; unmapped template keys are
reported back as `unextractable_line_item_keys`. As with the intake triage
agent, `agent_runtime.respond()`'s reply is folded in as advisory rationale
only, never the source of a figure. `POST /deals/{id}/spread/accept` lets the
analyst accept every figure as extracted or supply per-line `edits`, records
who accepted what and when, and advances `current_stage` through
`deal_state` (`financial_spreading` -> `credit_memo_review`) — then
deterministically computes DSCR (`ebitda / annual_debt_service`), leverage
(`total_debt / ebitda`) and current ratio (`current_assets /
current_liabilities`) from the *accepted* figures only, storing each ratio
with its formula string and numeric inputs in `credit_ratios`
(`GET /deals/{id}/ratios`), and assigns a risk grade from a fixed, ordered,
inspectable rubric table (`RISK_GRADE_RUBRIC` in `backend/ext_spread.py`),
storing the exact rule text applied in `risk_grades` (`GET
/deals/{id}/risk-grade`) — nothing here is agent-authored; the rubric and
formulas are code, reproducible from the stored inputs alone.

The four nodes this slice owns in `workflows/deal-underwriting`
(`spread_financials` agent node, `persist_spread_draft`,
`apply_spread_decision` -> handler `apply_spread_review_decision`,
`compute_ratios` -> handler `compute_credit_ratios`, `assign_risk_grade`) are
registered as real `workflow_engine` handlers, so driving the workflow
generically continues seamlessly from slice 1's `review_triage` gate through
this slice's `review_spread` gate. The REST endpoints call the same handler
functions directly for the same reason slice 1's did: the acceptance contract
needs distinct propose / human-reviews-beside-source / accept-or-edit steps.

Frontend: the Spread screen gained a "Live spread workspace" panel — a deal
id field, a "Run spreading agent" action that renders every extracted line
item in the design's own ledger markup with its source artifact, row
location and raw text plus an editable accepted-value field, and an "Accept
spread" action that renders the real computed ratios (formula + inputs) in
the design's `ratio-card` markup and the real risk grade in its `grade` chip
(`frontend/spread.js`) — no shell elements were changed.

## Slice 3 — Cited credit memo and policy compliance exceptions (`memo-policy-compliance`)

`POST /deals/{id}/memo/run` runs the Credit Memo Agent against a deal that
already has an accepted spread, computed ratios and an assigned risk grade:
the memo's citations (`cited_ratios`, `cited_spread_items`,
`cited_policy_rules`) are resolved deterministically against the deal's own
stored `credit_ratios`, accepted `spread_line_items`, and the applicable
`loan_to_value` policy rule — never invented by the model — with
`citations_resolvable` confirming every cited id actually exists. As in
every prior slice, `agent_runtime.respond()`'s reply (the Credit Memo
Agent persona) is folded into the draft as narrative only.
`POST /deals/{id}/memo/accept` records the named analyst's decision in
`credit_memo_drafts` and advances `current_stage` through `deal_state`
(`credit_memo_review` -> `policy_compliance_review`).

`POST /deals/{id}/policy-review/run` requires an accepted memo, then
deterministically aggregates portfolio exposure by industry across every
active deal (`portfolio_exposures`, REQ-023 — not just the deal under
review) before running the Policy Compliance Agent for narrative only.
Concentration limits, the prohibited-industries list and loan-to-value caps
are evaluated by code against the versioned, configurable rule rows in
`policy_rules` (`GET /policy-rules`; a documented default rule set ships
since no bank policy document was supplied — see `DEFAULT_POLICY_RULES` in
`backend/ext_policy.py`). Every breach is persisted as an open, disposable
`policy_exceptions` row naming the exact policy rule id and describing the
breach. `POST /deals/{id}/policy-review/accept` lets a named human
waive/resolve every open exception with a reason; once none remain open the
deal advances (`policy_compliance_review` -> `approval_pending`), matching
the workflow's `check_exceptions_cleared` gate and setting up slice 4's
tiered approval to run against a deal whose exceptions are already
dispositioned.

The five nodes this slice owns in `workflows/deal-underwriting`
(`draft_memo` agent node, `persist_memo_draft`, `apply_memo_decision` ->
handler `apply_memo_review_decision`, `aggregate_exposure` -> handler
`aggregate_portfolio_exposure`, `policy_review` agent node,
`persist_exceptions` -> handler `persist_policy_exceptions`,
`apply_exception_dispositions`) are registered as real `workflow_engine`
handlers, continuing seamlessly from slice 2's `review_spread` gate through
this slice's `review_memo` and `review_exceptions` gates. The REST endpoints
call the same handler functions directly for the same reason every prior
slice's did: the acceptance contract needs distinct propose /
human-reviews-beside-citations / accept-or-disposition steps.

Frontend: the Credit memo screen gained a "Live memo & policy workspace"
panel — a deal id field, a "Run memo agent" action rendering the real draft
and its citation counts in the design's own `memo-sec` markup, an "Accept
memo" action, a "Run policy compliance review" action rendering the real
portfolio exposure and every raised exception in the design's `cite-card`
markup, and a "Waive all & clear exceptions" action that dispositions every
open exception and shows the deal's stage advance to `approval_pending`
(`frontend/memo.js`) — no shell elements were changed.

## Slice 4 — Role-scoped tiered approval, decline, and rework (`tiered-approval-decisions`)

`GET /deals/{id}/approval-tier` deterministically derives the authority tier
a deal's exposure requires from a fixed, inspectable rubric
(`AUTHORITY_TIERS` in `backend/ext_approvals.py`, REQ-031/032/033: credit
analyst up to $250k, senior credit officer up to $1M, credit committee
above $1M) — never an agent judgment call. `POST /approvals` records a named
human's decision (REQ-036/037): the decider's own authority tier, looked up
from this build's documented user directory (`USER_AUTHORITY`, seeded into
the `users` table), is checked against the deal's required tier *before*
anything is written, and an under-authority attempt is refused outright with
an HTTP 403 (REQ-034) — an analyst cannot approve Northwind's $750,000 deal,
only a senior-credit-officer-tier user can. A successful approval advances
`current_stage` through `deal_state` straight to `closing` (extending
`TRANSITIONS` so `approve` is valid from `policy_compliance_review` as well
as `approval_pending`, since a sufficiently authorized officer's approval is
itself the named human disposition of any still-open policy exception —
REQ-024 — rather than requiring the separate `/policy-review/accept` step
first); re-approving an already-closed deal is a safe no-op, matching every
other accept endpoint's tolerance for being re-run. `POST /deals/{id}/decline`
requires a documented adverse-action reason (REQ-040) and is available from
any active stage, not only `approval_pending` — an officer can decline for
cause at any point in underwriting. `POST /deals/{id}/rework` returns a deal
to a genuinely earlier stage with a reason and a named assignee (REQ-041),
guarded against terminal (`declined`/`closing`) deals.

Because no acceptance path in this build's script ever submits a second
loan application, `_ensure_demo_second_deal()` lazily seeds exactly one
second deal (`DEAL-002`) — and only once the real `DEAL-001` is already the
store's sole deal, so it can never shift `DEAL-001`'s own sequential id —
so the decline path has a real second application to demonstrate against,
same as every other slice's live workspace operates on real stored data.

Role-based access control (REQ-045/046/047) is seeded declaratively
(`rbac.grant`) for this build's user directory, and `GET /deals` /
`GET /deals/{id}` (`backend/ext_deals.py`) now apply row-level scoping
(REQ-048) whenever a caller presents a session for a relationship-manager-only
user — restricting them to deals they themselves submitted — while remaining
fully unscoped (every earlier slice's own acceptance behavior) when no
session is presented at all.

The five nodes this slice owns in `workflows/deal-underwriting`
(`derive_approval_tier`, `approval_decision` human gate ->
`record_approval_decision`, `advance_to_closing` -> handler
`advance_deal_to_closing`, `record_adverse_action`, and the
`record_rework_return` handler shared by every earlier check_*_accepted /
check_exceptions_cleared condition's `on_false` branch) are registered as
real `workflow_engine` handlers, so driving the workflow generically
continues seamlessly from slice 3's `review_exceptions` gate all the way
through to a completed run at stage `closing`. The REST endpoints call the
same handler functions directly, for the same reason every prior slice's
did: an unauthorized approval attempt must surface as an HTTP 403, not a
silently failed workflow run. (This slice also closes two latent gaps in
`ext_policy.py`'s `apply_exception_dispositions` the generic engine could
already reach: it had no fallback for being driven by a blanket
approve/reject from the generic human node, and it hard-failed a deal with
zero raised exceptions instead of treating a clean policy review as already
cleared.)

Frontend: the Approvals screen gained a "Live approval workspace" panel — a
deal id field, a "Check approval tier" action showing the real derived tier
and rule text, a named-decider selector matching the design's own tier
lanes, and Approve / Decline / Return-for-rework actions that call the real
endpoints and render the real outcome — refusal, adverse-action reason, or
reassigned stage — in place (`frontend/approvals.js`) — no shell elements
were changed.
