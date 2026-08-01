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

### Revision — fail-closed identity across the foundation (audit HIGHs)

The governance `code_audit` raised four HIGH findings against the foundation
this slice laid down; all four are closed here. No feature behaviour changed:
all four of this slice's recorded acceptance checks still pass exactly as
written, all five screens still work, and the backend suite is green (32
tests).

1. **`identity.py` is the single fail-closed guard, and it is now called
   unconditionally.** `require_actor(acting_user_email)` — the contract every
   later slice builds on — returns the stored user row or raises: **401** when
   no identity is supplied at all (empty and whitespace-only emails included),
   **403** when the email resolves to no stored, active user or to a role
   without the required permission. It never returns `None`, so callers use
   the result directly instead of writing `if user else None` fallbacks (those
   are all gone from `ext_deal_intake.py`). Alongside it, `require_reader` is
   the new guard for **reads**, and `can_view_deal` / `visible_deals` are the
   exported scoping helpers every deal-returning endpoint runs its rows
   through.
2. **The deal book and the pipeline board are no longer opt-out.** `GET
   /api/deals` and `GET /api/pipeline` used to scope only `if
   acting_user_email:` — dropping the parameter bought the whole book. Both now
   call `require_reader` unconditionally (identity may arrive as the
   `acting_user_email` query parameter or an `x-user-email` header) and return
   `identity.visible_deals(...)`. An identity that resolves to no stored user
   is a **403**, never a silent downgrade to wider access. An *unidentified*
   caller is not trusted either: it reads as the least-privilege
   `ANONYMOUS_VIEWER` principal and gets the **redacted board projection** —
   deal code, borrower name, industry, stage, status and timestamps only, with
   requested/exposure amounts, risk grade, owner, borrower entity id and
   adverse-action reasons stripped (`identity.BOARD_SAFE_FIELDS`). The board
   therefore cannot be used as a way around the deal book's access control.
   `frontend/app.js` gained a matching pure-append block: the desk states who
   it is (`X-User-Email`, from the analyst/RM email on the board) on every
   same-origin `/api/` **GET**, so the UI keeps its full view — convenience
   only, since the server still resolves that email and refuses an unknown one.
3. **Approval decisions require a resolvable actor.** `POST
   /workflow/submissions/{id}/approve` and `/reject` (and `/submissions`
   itself) did no identity check at all — any caller could decide any
   submission under any name. Each now resolves its actor through
   `identity.require_actor` **before** touching `approval_flow`: 401 with no
   actor, 403 for an unknown or deactivated one, and the *resolved* email (not
   the caller-supplied string) is what gets recorded as `decided_by`.
4. **`POST /chat` bounds its input** — `ChatRequest.message` is
   `1..MAX_CHAT_MESSAGE_CHARS` (4000), so an unbounded prompt is a 422 at the
   edge rather than a denial-of-service or injection surface reaching the
   model.
5. **`ext_audit.record()` no longer swallows a failed audit write.** The bare
   `except: pass` around the durable `audit_log` insert is gone: a store
   failure now propagates and fails the mutation that caused it, because a
   state change whose audit row silently vanished is an unauditable action.

Nine new tests in `backend/tests/test_deal_intake_and_triage.py` cover the
redacted anonymous projection, unredacted identified reads (header and query),
403 on a forged reader, RM scoping on the board, the approval-decision identity
guard, the chat bound, and the fail-loud audit write.

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

**Revision (slice 5, attempt 7) — security remediation, re-based on the revised
foundation.** No feature behaviour was removed and every recorded acceptance
check still passes exactly as written (slice 1's four and this slice's three);
the tree was first re-taken from the current foundation (which added
`identity.require_reader`/`visible_deals` redaction, the fail-loud audit write
and the desk-identity read header) and only this slice's own files re-applied on
top — `backend/ext_grounded_portfolio_qa.py`,
`backend/tests/test_grounded_portfolio_qa.py`, `demo/slice-5.json`, and pure
appends to `frontend/app.js` and this file.

1. *Identity is now unconditional and fail-closed on every surface of the desk
   (HIGH: default-deny).* No guard in this module sits behind an
   `if acting_user_email:` any more. `POST /api/qa/ask` and
   `GET /api/qa/book-summary` take identity as optional in the schema **only so
   that the identity guard answers**, not FastAPI: an anonymous or blank caller
   now gets **401 "identify yourself"** from `identity.require_actor` (a forged
   or deactivated one still 403, a role without `portfolio.query` still 403).
   `GET /api/qa/sessions` runs through the foundation's `identity.require_reader`
   (query parameter or `x-user-email` header, same contract as `GET /api/deals`):
   an unknown identity is a 403, an identified caller is scoped — desk roles read
   the whole log, a relationship manager only its own sessions and only the deal
   ids `identity.visible_deals` grants it — and an **unidentified caller now
   reads a redacted projection**: row id and timestamp only, with question,
   answer, asker and deal ids withheld, mirroring the foundation's redacted board
   projection. Scope itself is always resolved through `identity.visible_deals`
   rather than a role list this module kept for itself. On top of that the
   roster's read tools are structurally scope-guarded: `permitted_scope()` binds
   the resolved scope for a retrieval and every `read_*` tool refuses a deal
   outside it — or any read with no scope bound at all — so a future caller
   cannot reach deal data through the tool registry by skipping the endpoint.
2. *The model can no longer put a figure or a citation into an answer (MEDIUM:
   llm-math / grounding).* The narrative from `agent_runtime.respond()` is now a
   **candidate, never the answer**. `_verify_narrative()` serves it only when it
   is verifiably grounded — it names a retrieved record, names no deal outside
   the caller's scope, and **every numeral in it is one this module computed**
   (`_system_computed_numbers`, drawn from the stored records and
   `_portfolio_facts`). Anything else — an empty reply, a refusal, an echo of the
   prompt, an out-of-scope deal id, an invented figure — falls back to the
   deterministic, records-derived digest; the raw reply and the rejection reason
   are kept in the session trace for audit and returned as `narrative_source`.
   The citable-ids honesty guard is unchanged: a "none match" answer still cites
   the deals actually read to reach it. `QaAskRequest.question` is bounded at the
   edge (1–2000 characters, 422 outside it), matching the foundation's chat bound.
3. *Negative acceptance.* `test_anonymous_ask_is_401_not_an_answer` asserts an
   unidentified `POST /api/qa/ask` is 401 and leaks no deal id, alongside new
   tests for the 401 book summary, the redacted anonymous session log, header
   identity, RM session scoping, the scope-guarded read tools, the question
   length bound, and the figure-verification fallback. Backend suite green
   (49 tests).
