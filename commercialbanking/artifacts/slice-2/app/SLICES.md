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
