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
to an earlier stage (or, unnamed, one stage back) with a reason and a named
assignee (REQ-041), guarded against terminal (`declined`/`closing`) deals.

Every one of these decisions is checked before any decision is recorded.
`POST /approvals` records approvals only: an under-tier approver is refused
403 before any `approvals` row exists (the refusal itself is written to the
audit trail — a refused approval attempt is exactly the kind of event
REQ-038 wants on the record), an approval the deal's current stage cannot
accept is refused 409 by `deal_state`'s machine before anything at all is
written, and a
decline or rework verb is refused 400 with a pointer to the endpoint that
actually carries it out (`/deals/{id}/decline` needs the adverse-action
reason REQ-040 requires; `/deals/{id}/rework` needs the assignee REQ-041
requires) — so no decision is ever persisted that nothing acts on. The
decision vocabulary is closed, so an unrecognised verb is rejected rather
than stored verbatim as an `approval_status`. `/decline` and `/rework`
additionally refuse any decider who holds no approval authority at all — a
relationship manager cannot decline or regress somebody else's deal.
Authority tiers are resolved from the code-owned `USER_AUTHORITY` directory
rather than from the `users` rows it seeds, deliberately: `users` is in
`models.TABLES` and `main.py`'s generic `POST /api/{table}` takes
unauthenticated writes, so a store-resolved gate could be walked through by
anyone minting themselves a committee tier (the seeded
`users.approval_authority_tier` column mirrors the directory for display —
the Approvals screen lists deciders from it — but the gate itself is code).
All three decision endpoints accept an optional `Authorization` header: when
a session is presented it is authoritative — a signed-in caller may only
record decisions under their own name (REQ-036) — while the unauthenticated,
named-decider-in-the-body contract every acceptance call uses is unchanged.

Rework targets are events on the state machine, not ad-hoc writes:
`deal_state` derives a `return_to_<stage>` event from `STAGE_ORDER` for every
stage at or before each active stage (a same-stage target being the redraft
loop the plain `return_for_rework` event already models), so
`/deals/{id}/rework` moves a deal with `machine.advance()` like every other
transition in this codebase and a "return" that actually points forwards is
an `IllegalTransition` from the machine itself. Row-level scoping is likewise
evaluated by the composed `rls` module against a declared `DEAL_RLS_POLICY`
(`owner_field: submitted_by_id`, bypass roles `credit_analyst` /
`credit_officer` / `admin`) rather than a hand-rolled filter.

Because no acceptance path in this build's script ever submits a second
loan application, `_ensure_demo_second_deal()` lazily seeds exactly one
second deal (`DEAL-002`) — through the intake slice's own
`record_deal_intake` handler, so it is a real application with its artifacts
written through `blob_store` and its own audit trail, never a hand-placed
row — guarded on "no DEAL-002 yet and exactly one deal exists", which is
precisely when the intake handler's next sequential id *is* `DEAL-002`, so it
can never renumber or collide with an organically-created deal.

Role-based access control (REQ-045/046/047) is seeded declaratively
(`rbac.grant`) for this build's user directory, and `GET /deals` /
`GET /deals/{id}` (`backend/ext_deals.py`) now apply row-level scoping
(REQ-048) to any caller presenting a session: portfolio-wide read is a
granted role (`credit_analyst`, `credit_officer`, `admin`), so a
relationship manager — or any session-holder with no grants — sees only the
deals they themselves submitted, while the endpoints remain fully unscoped
(every earlier slice's own acceptance behavior) when no session is presented
at all.

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
and rule text, a named-decider selector populated from the real `users`
directory (so the name picked is exactly the identity the authority gate
reads), and Approve / Decline / Return-for-rework actions that call the real
endpoints and render the real outcome — refusal, adverse-action reason, or
reassigned stage — in place (`frontend/approvals.js`) — no shell elements
were changed. The rework control asks only for a reason and an assignee, so
`returned_to_stage` is optional on the API and the server returns the deal
one stage back when no target is named.

## Slice 5 — Grounded portfolio Q&A, SLA dashboard, and audit history (`portfolio-qa-sla-audit`)

Implements the `portfolio-qa` and `sla-escalation` workflows end to end.
`POST /portfolio/qa` (`backend/ext_portfolio.py`) answers a plain-language
question by first resolving the asking user's row-level visibility scope
through the same composed `rls` module and `DEAL_RLS_POLICY` every earlier
slice scopes deals through (REQ-028/048 — a relationship manager only ever
sees deals they themselves submitted; a credit analyst/officer/admin sees
the book), then extracting the question's filters deterministically — a
regex/keyword parser over amount, DSCR, leverage, current ratio, risk
grade, SLA-breach and stage phrases, exactly the same pattern
`ext_deals.py`'s intake classifier already uses — and running that filter
over the scoped deals joined with their computed ratios, risk grade, open
exception count, and idle time. The Portfolio Query Planner and Portfolio
Answer Agent roster personas are still called via `agent_runtime.respond()`
on every request, but strictly as advisory narrative folded into the stored
answer's `agent_rationale` and the audit-trail description — never the
source of a filter or a figure, matching the triage/spread/memo agents'
role elsewhere in this codebase (REQ-026 requires the answer be grounded
only in retrieved rows, which a model's own text can't be trusted to keep
true). Every question and answer is persisted (`_portfolio_questions` /
`_portfolio_answers`, new tables outside the approved data model, the same
precedent as row-history's `_row_history` and workflow-engine's
`_wf_events`) and additionally written to the approved `audit_trail` table,
so the Q&A screen's own "Logged" guardrail copy is literally true.

`GET /sla/dashboard` (`backend/ext_sla.py`) computes each deal's business
days idle since its own `last_activity_at` (weekends never count, REQ-052)
and flags `is_over_sla` at the fixed 5-business-day threshold (REQ-051) —
deterministic date arithmetic, not agent-estimated, and deliberately
independent from the pre-existing `sla.py` (sla-timers) module, which
measures elapsed fraction of a fixed SLA *window* rather than "how many
business days has this sat untouched." An optional `as_of` query parameter
is an injectable "now" purely for testability/demo (never used to fabricate
a real breach). When any deal is breaching, the SLA Escalation Briefer
agent's `agent_runtime.respond()` reply is folded in as an advisory
`briefing` narrative only (REQ-053 keeps the actual decision — reassign,
return for rework, or acknowledge — with the credit officer); `POST
/sla/escalate` applies that named decision through the same `deal_state`
machine and `assignment` conventions every earlier slice uses, never an
ad-hoc status write.

`GET /deals/{id}/audit` (`backend/ext_deal_audit.py`) is a pure, newest-first
read over the `audit_trail` table every earlier slice's `_audit` helper
already writes to (REQ-042/043/044) — it invents nothing new to log, and is
scoped through the same optional RLS check `ext_deals.py`'s own `GET
/deals/{id}` uses when a caller presents a session.

The eight deterministic nodes this slice owns across `workflows/portfolio-qa`
(`capture_portfolio_question`, `resolve_user_visibility_scope`,
`execute_scoped_deal_query`, `record_qa_answer`, `record_qa_no_results`) and
`workflows/sla-escalation` (`compute_business_days_idle`, `flag_sla_breach`,
`apply_sla_escalation_decision`) are registered as real `workflow_engine`
handlers under the exact names each workflow definition calls out, so
driving either workflow generically (`POST /workflows/portfolio-qa/start`,
`POST /workflows/sla-escalation/start`) runs a full grounded Q&A round trip
to completion, or a full SLA sweep through to the human
`escalation_decision` gate. The REST endpoints call the same handler
functions directly with a hand-built context, for the same reason every
prior slice's did: `execute_scoped_deal_query` and `record_qa_answer`
recompute their result deterministically from stored data rather than
trusting an agent node's `{"reply": ...}` output (which, like every other
agent node driven through the generic engine in stub mode, never actually
satisfies its declared JSON schema) — so both the REST surface and a
generically-driven workflow run always ground the answer the same way.

Frontend: the Portfolio Q&A screen's canonical chat mount points
(`#messages`/`#composer`/`#input`) are taken over by `frontend/qa.js` for
the real endpoint — the composer node is cloned-and-replaced to strip the
design's own inline demo script and the generic chat-shell module's
(`app.js`) listeners from it (no mount-point id changes; the fake/generic
handlers simply no longer see any submissions), an "Asking as" selector
populated from the real `users` directory drives the visibility scope, and
real answers render into the design's own bubble/result-strip/mini-card
markup with a live "visible deals" count and "recent questions" panel.
The Audit trail screen gained a "Live audit history" panel
(`frontend/audit.js`) — a deal id field and a "Load audit history" action
that renders the real `audit_trail` rows into the design's own
timeline/tl-item/delta markup, colored by actor type. The SLA dashboard
screen gained a "Live SLA sweep" panel (`frontend/sladash.js`) — an optional
as-of override (for demoing a breach without waiting real business days)
and a "Refresh dashboard" action that renders every real deal's idle time
into the design's own `sla-card` markup, plus the briefing agent's advisory
note when any deal is breaching. No shell elements were changed in any of
the three screens.
