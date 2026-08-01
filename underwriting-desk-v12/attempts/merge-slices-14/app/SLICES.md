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

### Revision — module hardening to the certified catalog 0.12.1

The five composed module files below predated the hardened module catalog and
were brought up to standard. No feature behavior changed: all four recorded
acceptance checks for this slice still pass exactly as written, every screen
still works, and `frontend/app.js` and `frontend/index.html` were not touched.

1. `backend/ext_audit.py` — an audit entry with no attributable actor is not an
   audit entry. `record(event, detail, actor="system")` now stamps `actor` on
   every entry (machine-driven events default to `"system"`), and
   `AuditRequest` makes `actor` a **required** field, so `POST /audit` without
   one is a 422. `POST /audit` passes `req.actor` through.
2. `backend/ext_workflow_runs.py` — workflow runs now record who drove them.
   `StartRequest` gains `acting_user_email` (default `"system"`), which
   `start()` threads into the run inputs as `_started_by`; a new `TickRequest`
   lets `POST /workflows/runs/{id}/tick` accept an optional body naming the
   actor, and each tick writes a `workflow.ticked` audit entry attributed to
   them. Ticking with no body remains valid for machine-driven advances.
3. `backend/ext_seed.py` — the `@router.post("/admin/seed")` decorator carries
   the `# public-endpoint: dev-only fixture load, hard-gated by
   APP_ALLOW_SEED=1` annotation; the endpoint stays 403 unless that env var
   is set.
4. `backend/ext_blobs.py` (`PUT /files/{name}`) and 5. `backend/ext_uploads.py`
   (`PUT /uploads/{name}`) — these are mutations and are now identity-guarded
   like every other mutation in the app. The caller identifies itself with an
   `x-user-email` header or an `acting_user_email` query parameter (the body is
   raw bytes, so identity cannot ride in it), resolved through
   `identity.require_actor`: anonymous → 401, unknown user → 403, known active
   user → stored, with an audit row written for the write. The upload
   extension allowlist still applies on top for identified callers.

Covered by `backend/tests/test_deal_intake_and_triage.py` (24 tests green).

## Slice 2 — Cited financial spread, deterministic ratios, and risk grade (`spread-ratios-and-risk-grade`)

An analyst opens a deal dossier and runs the Financial Spreading Agent (`POST
/api/deals/{deal_code}/agents/financial-spreading/run`), which transcribes the
bank's standard spread template — one row per line item, period, value and
unit — from the attached documents. **Every figure carries a structured
citation** (document id plus page, section and cell locator); a line the agent
cannot read is reported under `unextractable` and is never given a number. The
draft is checked before a human ever sees it: `validate_spread_citations`
rejects the run outright (422) if any row arrived without a document + locator.
Nothing reaches `financial_spread_template` until a named analyst accepts,
edits-then-accepts, or rejects the draft (`POST
/api/deals/{deal_code}/spread/accept`) — a rejection needs a written reason and
writes no figures, and an edited line item must still resolve to a cited
source. Acceptance then triggers, in deterministic Python and never an LLM,
DSCR, leverage and the current ratio (`GET /api/deals/{deal_code}/ratios`,
each row storing its numerator, denominator, `half_up_2dp` rounding and
`undefined_when_denominator_zero` handling) and the risk grade from the
versioned rubric (`GET /api/deals/{deal_code}/risk-grade`, returning the grade,
`rubric-v2.1`, the exact band struck and the whole inspectable rubric).
Supporting endpoints: `POST /api/deals/{deal_code}/documents` attaches a
borrower document with its digitised extract sheet (held in blob-store — the
only thing the agent may transcribe from, which is what makes "every figure is
cited" enforceable), `GET /api/deals/{deal_code}/spread` returns the accepted
spread with its citations, and `GET /api/deals/{deal_code}/dossier` assembles
the whole screen in one read. All reads are scoped through
`identity.can_view_deal`; every mutation is guarded by
`identity.require_actor(…, "deal.spread")` and writes an audit row
(`deal.document_attached`, `spread.agent_run`, `spread.citations_validated`,
`spread.accepted`/`spread.rejected`, `ratio.computed`, `risk_grade.assigned`).

Backend: one new file, `ext_spread_ratios_and_risk_grade.py`, which also
registers five of the `deal-underwriting-lifecycle` workflow's deterministic
handlers — `verify_required_documents`, `validate_spread_citations`,
`persist_accepted_spread`, `compute_financial_ratios` and `assign_risk_grade` —
and calls exactly those functions from its REST endpoints, so the workflow
contract and the shipped behaviour cannot drift apart. It also installs a
composable wrapper around `deals_repo.next_deal_code` that skips the deal codes
it reserves, honouring that module's documented promise that the counter is
independent of fixture deals inserted with an explicit code (no shared module
is edited). A worked demonstration dossier, `DEAL-1002` — Verrazano Dental
Group, LLC, $640,000, with its three-document financial pack — is materialised
once at import under that reserved code so the screen has a real spread to
draft on a fresh boot.

Frontend: the Deal Dossier screen (`screen-deal-detail`) is now live end to
end inside the design's shell. An "open dossier" find-bar loads any deal from
the board; the head, document docket (with an attach-a-document form that
takes the extract sheet), spread table, unextractable list, citation rail,
deterministic-ratio table and rubric strip all render from
`/api/deals/{code}/dossier`; and the spread desk's run / accept / edit /
reject controls drive the endpoints above, with "edit before accepting"
turning the drafted values into editable fields. The memo, policy-exception
and decision desks on the same screen drive the endpoints the later slices of
this lifecycle own and report plainly when the step they need has not been
reached yet. No shared chrome, other screen, or shared CSS was restructured.

Covered by `backend/tests/test_spread_ratios_and_risk_grade.py` (20 tests
green; 44 across the suite).

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

**Revision (attempt 4, rebase onto module catalog 0.12.1):** rebased again onto
the foundation's module-hardening revision, and adapted to the one shared
contract it changed that this slice depends on. `ext_audit.record()` now takes
an `actor` — an entry with no attributable actor is not an audit entry — so all
nine audit calls in `ext_memo_policy.py` name theirs explicitly instead of
silently defaulting to `"system"`: human acts (`spread.accepted`,
`memo.accepted`, `policy.exception_raised`, `policy.exceptions_recorded`) name
the acting analyst, agent drafts (`credit_memo.agent_draft`,
`policy_compliance.agent_draft`) name whoever ran the agent, the fixture seed
names the RM, and only the two deterministic calculations (`ratios.computed`,
`risk_grade.assigned`) stay attributed to `"system"` — because no human authored
those numbers, which is exactly what that default is for. The acting email is
threaded into the two workflow handlers through their context (`actor_email`),
so `persist_accepted_memo` and `record_policy_exceptions` stay correctly
attributed when driven through `workflow_engine` rather than the REST routes.
The Chronicle now shows that attribution: entries read `Analyst`, `Rm`, or
`system` per act. Everything else — every foundation and shared file, including
`main.py`, `identity.py`, `frontend/index.html`'s shell and `frontend/app.js`'s
base portion — is taken verbatim from the current foundation. Verified in the
sandbox: all four of this slice's acceptance checks pass, Slice 1's four still
pass (in both orders — the `DEAL-1003` fixture uses an explicit `deal_code` and
never shifts Slice 1's `DEAL-1001` sequence), and the backend suite is green at
40 tests.

## Slice 4 — Tiered human approval, adverse action, and the idle register (`tiered-approval-and-sla`)

A credit officer approves (`POST /api/deals/{code}/approve`), declines with a
controlled adverse-action reason (`POST /api/deals/{code}/decline`), or returns
a deal to an earlier stage with a written reason and a re-assignment (`POST
/api/deals/{code}/return`) — and the desk watches the SLA idle register (`GET
/api/sla/idle`) for deals that have not moved in more than five **business**
days, acting on them through `POST /api/sla/escalate`. Supporting reads: `GET
/api/deals/{code}/approval-tier` (who may decide this deal, and why) and `GET
/api/approvals/queue` (everything sitting at the approval step). All backend
code is new and lives in `backend/ext_tiered_approval_and_sla.py`; no shared
module was rewritten.

**Authority is the server's decision, tiered on exposure (R-020/R-021/R-022).**
`tier_for()` is pure arithmetic: up to $250,000 a credit analyst may approve,
up to $1,000,000 a senior credit officer, above that only the credit
committee. `_require_decision_authority` resolves the caller through
`identity.require_actor` (default-deny: anonymous → 401, unknown or
deactivated → 403) and then checks the tier, so an analyst approving a
$750,000 deal is refused before anything is written. Declines and returns
additionally require the officer-only `deal.decline` / `deal.return`
permissions (R-033). **No agent is involved anywhere in this path (R-023):**
the module never imports `agent_runtime` at all — a system guardrail rather
than a prompt instruction — and a test asserts that stays true.

**Every decision is a named human's and is recorded once (R-024/R-030/R-062).**
An `approvals` row stores the deciding user, the authority level verified, the
exposure and the notes, and `ext_audit.record` writes an audit row for the
decision, the outcome and the close. Replaying the *same* decision returns the
stored record (`replayed: true`) instead of approving twice; a *conflicting*
second decision is a 409. Stage moves go through the `state-machine` module, so
approving a deal that is not at the approval step is a 409 rather than a silent
jump. A decline needs a `reason_code` from the active `adverse_action_reasons`
list plus free-text detail, both validated before any write (R-026/R-063).

**Idle time is counted in business days from the last meaningful activity
(R-034/R-057).** `business_days_between()` walks the calendar excluding
weekends and any `business_calendar` date flagged non-business (the configured
bank-holiday list is seeded and reported by the register). Acknowledging a deal
deliberately does *not* reset the idle clock — only real work (reassignment,
return) does — so a deal cannot be nursed off the register. `POST
/api/sla/escalate` runs the approved `sla-idle-escalation` workflow end to end
(measure → breached? → blockers → human park in approval-flow → apply) rather
than re-implementing it. `GET /api/sla/idle` withholds borrower names from an
unidentified caller and scopes rows to what an identified one may see.

**Workflow handlers registered** (contracts from `workflows/workflows.json`):
`determine_approval_tier`, `record_approval_decision`,
`record_adverse_action_or_return`, `close_approved_deal` on
deal-underwriting-lifecycle, and `compute_business_day_idle_time`,
`collect_stage_blockers`, `apply_sla_escalation_action` on
sla-idle-escalation.

**Frontend — `screen-sla-dashboard` only.** Inside the design's existing shell:
a "Decision Desk — Tiered Approval" manuscript (approval queue, live tier
explanation, approve / decline-with-reason-code / return-for-rework), live
plates, a live idle register whose rows are selectable, live "Idle by Stage" /
"Idle by Desk" / bank-holiday panels, and the design's own "Reassign selected"
and "Nudge owners" buttons wired to the escalation workflow. No other screen,
shared CSS or chrome was touched.

**Desk fixtures.** `install_desk_fixtures()` seeds the controlled reason-code
vocabulary, the bank-holiday calendar, and four reference deals (DEAL-1004
$750k awaiting decision, DEAL-1005 long idle, DEAL-1006 declinable, DEAL-1007
$1.25M committee-tier) so the register and decision desk open on real data.
Fixture deals use explicit codes and do **not** consume the deal-code sequence,
so a deal filed through intake is still DEAL-1001; a small additive guard wraps
`deals_repo.next_deal_code` so the allocator skips forward past any code a
fixture already holds instead of issuing a duplicate `deal_code`.

**Open questions carried forward, not silently decided:** R-069 (exposure basis)
— the deal's own `exposure_amount` is used and named in `exposure_basis` on
every tier response; R-068 (committee mechanics above $1M) — the build requires
an explicit committee role and records one decision, and says so in
`committee_mechanics_open_question`.

Covered by `backend/tests/test_tiered_approval_and_sla.py` (26 tests; 51 green
across the suite).
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

**Rebase (attempt 4) — no behaviour change.** This slice was re-based onto the
revised foundation (module hardening to catalog 0.12.1): every shared file was
re-taken from the current foundation and this slice's work re-applied on top —
`backend/ext_grounded_portfolio_qa.py`, `backend/tests/test_grounded_portfolio_qa.py`,
`demo/slice-5.json`, and pure appends to `frontend/app.js` and this file. The one
adaptation to the hardened modules: `record_qa_session` now passes the asking
user's email as `actor` to `ext_audit.record()`, since an audit entry must name
who caused it — a Q&A session is caused by the person who asked, never by
`system`. All three recorded acceptance checks still pass exactly as written and
the backend suite is green (33 tests).
