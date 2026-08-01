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

## Slice 5 — Grounded, permission-scoped portfolio Q&A desk (`grounded-portfolio-qa`)

A credit officer asks the portfolio desk a question in plain English (`POST
/api/qa/ask`) and gets back an answer drawn only from the deal records the
asking user's role is entitled to see. Retrieval scope is resolved
server-side from the caller's role before the Portfolio Q&A Agent ever sees a
row (`resolve_qa_permission_scope`): relationship managers see only deals
they created, analysts/officers/admins see the active book. A deterministic
filter (`retrieve_grounded_deal_context`) narrows further to the deals that
actually bear on the question (e.g. "lacks an accepted spread" checks each
deal's `financial_spread_template` rows) using the roster's declared read
tools (`read_deal`, `read_spread`, `read_risk_grade`, `read_policy_exceptions`,
`search_deals_in_scope`, …), enforced through `tools.invoke()` so the agent's
allow/deny list is structural, not documentation. The agent's narrative
(`agent_runtime.respond(..., agent_name="Portfolio Q&A Agent")`) is wrapped
through the citation-tracker module (`citations.attach`/`render`) so every
answer prints the deal ids it actually read; `verify_answer_grounding` then
mechanically checks that every cited id came from the resolved scope before
anything is trusted. Identity questions ("who are you") and any attempt to
get the agent to approve/decline/advance a deal are refused deterministically
before retrieval ever runs. Every exchange — question, grounded answer,
source deal ids, and the full scope/retrieve/groundcheck trace — is recorded
to the immutable `portfolio_qa_sessions` table (`GET /api/qa/sessions`) for
audit, implementing all four deterministic nodes of the `portfolio-qa`
workflow (`workflows/workflows.json`). Backend: new `ext_grounded_portfolio_qa.py`.
Frontend: the Portfolio Desk screen (`screen-chat`) — previously wired to the
scaffold's generic, design-mismatched `/chat` endpoint — now submits through
`/api/qa/ask` and renders real answers and their deal-id sources in the
design's own manuscript markup (`from-user`/`from-agent`, `msg-sources`); the
"Standing Questions" shortcuts in the marginalia ask the same way, and the
"Book at a Glance" tallies (active deals, exposure in flight, open
exceptions) now read live from `/api/pipeline` and `/api/policy_exceptions`.

Revision (slice 5, grounded-portfolio-qa): restored `frontend/app.js` so the
foundation module is present byte-for-byte at the top of the file, and moved
the Portfolio Desk block to a single self-contained IIFE appended after it.
The block re-mounts the `#composer` node at runtime to take over submit
handling from the scaffold's `/chat` binding, leaving the foundation source
untouched for the line-level merge. No behavior change; all acceptance paths
unchanged.
