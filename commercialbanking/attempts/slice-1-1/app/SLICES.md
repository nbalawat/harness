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
