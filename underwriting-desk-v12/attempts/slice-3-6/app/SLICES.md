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
