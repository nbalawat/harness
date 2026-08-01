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

### Revision — upload identity brought to the hardened module standard

Both upload writes now declare identity in the handler signature rather than
sniffing it off the request, which is the standard the security scan reads:

- `backend/ext_blobs.py` `PUT /files/{name}` and `backend/ext_uploads.py`
  `PUT /uploads/{name}` each take
  `x_user_email: str | None = Header(default=None)` and return **401
  `"x-user-email header required for uploads"`** when it is absent. The
  `acting_user_email` query-parameter fallback (unused by any caller) is gone,
  so the header is the single, explicit identity channel.
- On success each response now carries `"uploaded_by": x_user_email` alongside
  `name`/`bytes`, so the writer is visible in the response as well as in the
  audit row.
- Unknown/deactivated callers are still 403 via `identity.require_actor`, the
  upload extension allowlist still applies, and
  `test_blob_and_upload_writes_require_a_known_identity` now asserts the 401
  detail and the `uploaded_by` echo. No other behavior changed; no frontend
  caller PUTs to these endpoints.

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

Backend: `backend/ext_memo_policy_audit.py` (new file; no shared module
rewritten). Frontend: the Audit Timeline screen (`screen-audit-timeline`)
only. Tests: `backend/tests/test_memo_policy_audit.py` (20 tests; suite green
at 44).

**Credit memo.** `POST /api/deals/{code}/agents/credit-memo/run` drafts the
underwriting memo in six sections — borrower and request, financial position,
ratio analysis, assigned risk grade, policy context, agent commentary — each
carrying at least one citation that resolves to a stored ratio id, spread
line-item key, risk-grade row, or policy rule reference. Every figure is
*copied* from a record that already exists: the agent recomputes nothing, and
the only free prose it produces is the commentary section. The draft is a
proposal; `POST /api/deals/{code}/memo/accept` (accept / accept_with_edits /
reject) is what persists it, writes its citation rows, records the
`human_reviews` row, and moves the deal to `policy_compliance`.
`GET /api/deals/{code}/memo` reads back draft and accepted versions.

**Policy compliance.** `POST /api/deals/{code}/agents/policy-compliance/run`
tests the deal against the *active* lending ruleset (`lending_policy` v4.2:
prohibited industries, single-obligor concentration, LTV cap, DSCR floor).
The rule arithmetic is deterministic Python — no financial or policy maths is
delegated to a model; the agent supplies the written commentary only. Each
rule returns `passed`, `breached` or `unevaluated` (a rule whose input is
missing is never reported as passed), and every breach becomes an exception
carrying `rule_reference`, `violation_detail`, a written `rationale` and a
`status`. Breaches are *proposed* until a human accepts the review at `POST
/api/deals/{code}/policy-review/accept`, which writes them as `open`
exceptions. `GET /api/deals/{code}/policy-exceptions` returns the recorded
exceptions plus, clearly marked `pending_human_review`, anything the latest
run proposed. `POST /api/deals/{code}/policy-exceptions/resolve` lets a
credit officer — and only an officer, since the roster denies every agent the
waiver tool — waive or uphold an exception, and refuses a blank rationale.

**The chronicle.** `GET /api/deals/{code}/audit` reads the append-only
`audit_log` back in order, resolves each actor to a named user and role, and
classifies every entry as a `state_change`, a deterministic `calculation`, an
`agent_draft`, or a `human_decision`, with per-kind counts and an optional
`?kind=` filter. There is no update or delete path for an audit row anywhere
in the API. Identified callers are scoped through `identity.can_view_deal`
before a single entry is returned.

**Workflow handlers.** Three `deal-underwriting-lifecycle` deterministic
nodes are now real, registered functions: `persist_accepted_memo` (node
`savememo`), `record_policy_exceptions` (node `exceptions`) and
`resolve_policy_exceptions` (node `resolve`). Each re-checks the acting
user's authority at the point of the state change, because each is also
reachable through `workflow_engine.start()`.

**Screen.** `screen-audit-timeline` is now fully live inside the approved
design shell: a Memo & Policy Desk (deal picker, analyst and officer identity,
run/accept for both agents, the memo rendered section-by-section with its
citations, the ruleset findings with passed/breached/unevaluated flags, and
the exception register with per-exception waive/uphold controls) sits above
the chronicle itself, which renders live entries in the design's human/agent/
system marks with before→after deltas. The marginalia filter is live (each
kind narrows the list and shows its real count) and "Export for audit"
downloads the deal's entries as JSON. Only markup inside
`#screen-audit-timeline` was touched; `app.js` gained one appended block.

**Foundation fix (shared, one function).** `deals_repo.next_deal_code()` now
SKIPS a code already carried by a stored row instead of handing it out again.
Slices seed fixture deals by inserting a row with an explicit `deal_code`, and
without this guard the DEAL-1001+ sequence eventually hands a freshly filed
deal the same code as a fixture — two borrowers answering to one deal_code,
which silently corrupts every read that resolves "the latest row for a code"
(it did, reproducibly, once the test suite filed its third deal). The first
filed deal is still DEAL-1001, so slice 1's acceptance is unchanged.

Fixture: `DEAL-1003` (Calder & Vance Millworks, $1.2M against $1.463M
collateral) ships already spread, calculated and graded — accepted spread
v3 with a document-and-cell citation per line, DSCR 1.24 / leverage 3.10 /
current ratio 1.42, grade 4 band `band_4_watch` — so the memo has real cited
inputs and the chronicle has history from boot. It breaches LTV-CAP-01
(82.02% against a 75% cap) and DSCR-FLOOR-01 (1.24 against a 1.25 floor).

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

**Revision (slice 5, attempt 5) — grounding made robust to the merged book.**
On the merged app (which seeds many more deals than this slice's own tree) the
test `test_answer_is_grounded_in_live_deal_records` failed: it asked "which
deals await tiered approval" and asserted the intake deal it had just filed
appeared in `source_deal_ids`, but with sibling slices' deals genuinely parked
at tiered approval the desk correctly grounded that answer in exactly those
deals instead. The desk's behaviour was right and the assertion was wrong, so
the fix is on the test — plus an explicit guarantee on the feature. Retrieval
carries **no top-k**: `retrieve_grounded_deal_context` returns every record in
the caller's permission scope that bears on the question, however large the
book grows, and the only truncation in the module is a display one in
`_deterministic_digest` ("+N more") applied AFTER relevance filtering and never
applied to `source_deal_ids`, so a relevant deal is never silently dropped from
an answer's sources. The test now asserts grounding on a stage the fixture deal
genuinely occupies (intake), and checks the desk's sources against the live
pipeline board — `set(source_deal_ids) == the deals actually at that stage` —
rather than against a fixed list; the tiered-approval question is still
exercised, asserting the honest outcome either way (exactly the deals at that
stage when some exist, otherwise the "none match" answer grounded in the book
actually read). Verified against a simulated merged book (16 deals, three at
tiered approval, twelve-plus at intake): sources came back as the exact
relevant set with nothing dropped. No behaviour change to any endpoint; all
three recorded acceptance checks pass exactly as written, the backend suite is
green (33 tests), and `frontend/app.js` remains an untouched pure append.

**Rebase (attempt 6) — no behaviour change.** The foundation advanced again
(the "upload identity brought to the hardened module standard" revision to
`backend/ext_blobs.py`, `backend/ext_uploads.py` and
`backend/tests/test_deal_intake_and_triage.py`), so this slice was re-based onto
the current foundation: every shared file was re-taken from the foundation input
and only this slice's own work re-applied on top —
`backend/ext_grounded_portfolio_qa.py`,
`backend/tests/test_grounded_portfolio_qa.py`, `demo/slice-5.json`, and pure
appends to `frontend/app.js` (after the foundation module's closing `})();`) and
to this file. Nothing in the foundation tree is modified by this slice. Re-probed
against the booted app: slice 1's four acceptance checks and this slice's three
all pass exactly as recorded, and the backend suite is green (33 tests).
