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

**Revision (attempt 2, audit findings):** two governance fixes, no change to
any acceptance path. (1) The DEAL-1003 fixture no longer writes a risk grade
down as a literal. `ext_memo_policy` now carries the deterministic
calculation chain explicitly — `compute_ratio` (fixed rounding, declared
divide-by-zero rule) and `grade_from_rubric` (ordered, versioned
`RUBRIC_BANDS`, first band wins, always total) — and the fixture is seeded by
walking the real flow: `_seed_accepted_spread` → `_compute_and_store_ratios` →
`_assign_risk_grade`. `_assign_risk_grade` is the only path by which a grade
reaches a deal: it persists the rubric's output as a `risk_grades` row and
then syncs `deals.risk_grade` FROM that row, deferring to a sibling slice's
rubric row when one already exists. (2) Every mutating route here now resolves
authority server-side through the foundation's default-deny guard,
`identity.require_actor(email, "deal.memo" | "deal.policy_check", …)`, in
place of the local role-set check — so an unknown email, a deactivated user,
or a relationship manager is refused by the same rules the rest of the app
uses. The two read routes take an optional `acting_user_email` and scope the
answer with `identity.can_view_deal` when the caller identifies itself, and
`GET /api/deals/{deal_code}/audit` now resolves each entry's `actor_name`
server-side so the Chronicle no longer reads the `users` table.

**Revision (attempt 3, rebase):** this slice was rebuilt on the CURRENT
foundation after the foundation's own security-hardening revision landed. Every
foundation and shared file (including this ledger, `frontend/app.js`'s base
portion, `identity.py`, and `main.py`) is taken verbatim from the revised
foundation; the only things re-applied on top are this slice's own additions —
`backend/ext_memo_policy.py`, `backend/tests/test_memo_policy_and_audit_trail.py`,
`demo/slice-3.json`, an append-only block at the end of `frontend/app.js`, and
markup confined to the `screen-audit-timeline` container. No feature behaviour
changed; Slice 1's and this slice's acceptance checks all still pass and the
backend suite is green.

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

## Slice 5 — Grounded, permission-scoped portfolio Q&A desk (`grounded-portfolio-qa`)

A credit officer asks the portfolio desk a question in plain English (`POST
/api/qa/ask`) and gets back an answer drawn only from the deal records the
asking user's role is entitled to see. Retrieval scope is resolved
server-side from the caller's role before the Portfolio Q&A Agent ever sees a
row (`resolve_qa_permission_scope`, guarded by `identity.require_actor` with
the `portfolio.query` permission, so an unknown caller reads nothing):
relationship managers see only the deals they filed or hold, analysts and
officers see the active book. A deterministic router
(`_select_records`) narrows further to the deals that actually bear on the
question — no accepted spread, open policy exceptions, a named borrower, or
any of the eight pipeline stages in plain English ("which deals await tiered
approval") — reading each deal only through the roster's declared read tools
(`read_deal`, `read_spread`, `read_ratios`, `read_risk_grade`,
`read_policy_exceptions`, `search_deals_in_scope`, …) enforced through
`tools.invoke()`, so the agent's allow/deny list is structural rather than
documentation. The agent's narrative
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
workflow (`workflows/workflows.json`). Backend: new
`ext_grounded_portfolio_qa.py`. Frontend: the Portfolio Desk screen
(`screen-chat`) — previously wired to the scaffold's generic,
design-mismatched `/chat` endpoint — now submits through `/api/qa/ask` and
renders real answers and their deal-id sources in the design's own manuscript
markup (`from-user`/`from-agent`, `msg-sources`); the "Standing Questions"
shortcuts in the marginalia ask the same way, and the "Book at a Glance"
tallies read live from `GET /api/qa/book-summary`.

**Revision (slice 5) — the desk is now wired to live deal data.** The agent
previously refused portfolio questions such as "which deals await tiered
approval" because the records it was handed were not presented as its
knowledge, so it fell back on "not covered — hand off to a human". Fixed:
`retrieve_grounded_deal_context` now builds the agent's context at question
time from the STORED deal records — stage, status, requested and exposure
amounts, risk grade, whether a spread has been accepted, open policy
exceptions and their rule references, computed ratios, owner and idle days —
for exactly the deals the asker's role may see, and hands that record set to
`agent_runtime.respond()` as the question's provided knowledge together with
system-computed totals. Every figure the desk quotes is computed in
deterministic code (`_portfolio_facts`); no arithmetic is delegated to the
model. Safety is unchanged and enforced in code: answers stay framed as an
automated draft pending analyst approval, decision requests are still
refused, an asker with nothing in scope is still told there is nothing to
ground an answer in rather than being given invented figures, and a model
reply that ignores the records it was given is replaced by the deterministic
digest of those records (the raw reply is kept in the session trace for
audit). New `GET /api/qa/book-summary` serves the desk's tallies from the
same permission-scoped records. Every recorded acceptance check passes
exactly as written; `frontend/app.js` changes remain a pure append.
