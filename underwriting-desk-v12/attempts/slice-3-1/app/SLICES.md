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

## Slice 3 — Credit memo, policy exceptions, and the per-deal chronicle (`memo-policy-and-audit-trail`)

Once a deal has an accepted spread, computed ratios, and an assigned risk
grade, the Credit Memo Agent (`POST
/api/deals/{deal_code}/agents/credit-memo/run`) drafts the underwriting memo,
citing the ratio, spread-line, and risk-grade references behind every
assertion; an analyst accepts it (`POST /api/deals/{deal_code}/memo/accept`),
which advances the deal to `policy_compliance`. The Policy Compliance Agent
(`POST /api/deals/{deal_code}/agents/policy-compliance/run`) then tests the
deal, in deterministic code, against the active lending ruleset
(`lending_policy`, versioned) — prohibited industries, portfolio
concentration, and an LTV cap it reports `unevaluated` rather than "passed"
when no appraisal is on file — and writes a formal, open exception
(`policy_exceptions`, readable via `GET
/api/deals/{deal_code}/policy-exceptions`) for every breach; the agent's own
tool set denies it the ability to persist or waive one itself. Every one of
these steps lands a normalized row in `audit_log`, and `GET
/api/deals/{deal_code}/audit` reads a deal's whole history back in
chronological order — state changes, deterministic calculations, agent
drafts, and human acceptances alike. Backend: new `ext_memo_policy.py`,
registering the `deal-underwriting-lifecycle` workflow's `persist_accepted_memo`
(node `savememo`) and `record_policy_exceptions` (node `exceptions`) handlers.
Built in parallel off the foundation app, this slice's acceptance drives
`DEAL-1003` directly; `ext_memo_policy._ensure_fixture_deal` seeds that deal
(a deliberately prohibited-industry cannabis-dispensary fixture, complete
with an accepted spread, computed ratios and a risk grade) the first time it
is addressed if no sibling slice has created it yet, and backfills only the
missing underwriting inputs onto it if one already has. Frontend: the Audit
Timeline screen (`screen-audit-timeline`) gained a Credit Memo & Policy
Compliance desk (run memo, accept it, run policy compliance) and the
Chronicle itself now renders live from `/api/deals/{deal_code}/audit`, with
its filter counts, actor names, and "Export for audit" download all reading
real data instead of the static mockup.
