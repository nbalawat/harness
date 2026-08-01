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

## Slice 3 — Credit memo, policy exceptions, and the per-deal chronicle (`memo-policy-and-audit-trail`)

Backend: `backend/ext_memo_policy_audit.py` (new file; no shared module
rewritten). Frontend: the Audit Timeline screen (`screen-audit-timeline`)
only. Tests: `backend/tests/test_memo_policy_audit.py` (29 tests; suite green
at 61).

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

**Deal-code collision guard (installed from this file, shared module
untouched).** Fixture deals are inserted with an explicit `deal_code` and
deliberately do not consume the DEAL-1001+ sequence — that is what keeps the
first *filed* deal DEAL-1001 for slice 1. The sequence itself, though, issues
its next number without checking whether a stored row already answers to it,
so on a desk carrying a DEAL-1003 fixture the third deal filed is handed that
same code: two borrowers under one `deal_code`, which silently corrupts every
read that resolves "the latest row for a code" (it did, reproducibly, once the
test suite filed its third deal). `_install_deal_code_collision_guard()` wraps
`deals_repo.next_deal_code` so it SKIPS a code already taken — nothing is
renumbered, reused or issued twice, the first filed deal is still DEAL-1001,
and the guard is idempotent so sibling slices seeding their own fixtures can
install the same thing without stacking wrappers. `deals_repo.py` itself is
byte-identical to the foundation's.

Fixture: `DEAL-1003` (Calder & Vance Millworks, $1.2M against $1.463M
collateral) ships already spread, calculated and graded — accepted spread
v3 with a document-and-cell citation per line, DSCR 1.24 / leverage 3.10 /
current ratio 1.42, grade 4 band `band_4_watch` — so the memo has real cited
inputs and the chronicle has history from boot. It breaches LTV-CAP-01
(82.02% against a 75% cap) and DSCR-FLOOR-01 (1.24 against a 1.25 floor).

### Revision — fail-closed reads, a chronicle that leaks no record bodies

Rebased onto the revised foundation (the fail-closed `identity` contract:
`require_actor` / `require_reader` / `can_view_deal` / `ANONYMOUS_VIEWER`) and
the governance findings against this slice's file are closed. Every recorded
acceptance check — slice 1's four and this slice's four — still passes exactly
as written, and the suite is green at 61.

1. **No read guard is opt-out any more (HIGH).** `_scoped_deal` used to scope
   only `if acting_user_email:` — omitting the parameter skipped the check
   entirely. It now calls the foundation's `identity.require_reader`
   **unconditionally** (identity may arrive as `acting_user_email` or the
   `x-user-email` header), then runs the deal through `identity.can_view_deal`:
   a forged or deactivated identity is a **403**, an RM outside its own book is
   a **403**, and an unidentified caller resolves to the least-privilege
   `ANONYMOUS_VIEWER` and gets a **redacted projection only**. There is no
   remaining `if acting_user_email:` in the file; the same sweep hardened
   `_require`, the handlers' authority check, to 401-on-no-actor and
   403-on-unknown/deactivated/unpermitted.
2. **The memo is 401 to an unidentified caller (negative acceptance).** A memo
   is continuous borrower prose with no board-safe projection, so
   `GET /api/deals/{code}/memo` refuses an anonymous read outright rather than
   redacting it — asserted by
   `test_an_unidentified_read_of_the_memo_is_refused_outright`. The audit and
   exception-register paths cannot join it at 401: their *recorded acceptance
   checks are anonymous GETs expecting 200*, so they take the foundation's
   board pattern instead — unconditional guard, redacted projection.
3. **The chronicle no longer serves raw payload bodies (HIGH).** `GET
   /api/deals/{code}/audit` used to return `before_payload` / `after_payload`
   verbatim, which made the timeline a back door around every endpoint that
   guards those records. Those keys are **gone from the response for every
   caller**. Each entry now carries the event, the resolved actor, the
   timestamp, and a `summary` derived by `summarize_payload()` — a whitelisted,
   scalar-only, length-bounded projection (nested bodies are dropped, not
   passed through) plus `changed_fields` and the `resource_id` needed to fetch
   the record through its own access-controlled endpoint. The memo prose was
   also removed from the audit row at the point of writing, so it is not merely
   filtered on the way out. An unidentified reader is redacted further: kind,
   action and timestamp only — no actor, no resource, no summary. The exception
   register redacts equivalently (rule and status survive; `violation_detail`,
   `rationale` and the people behind them do not).
4. **Medium findings.** `MemoReviewRequest.action` is a
   `Literal["accept","accept_with_edits","reject"]`, so an unrecognised action
   is a 422 instead of falling through to accept; rejecting a draft now
   **requires** a written `rejection_reason` (the `"no reason given"` default is
   gone) and `accept_with_edits` requires the edited text; disposing of a policy
   exception checks its **current** status first and refuses a second
   disposition with a **409**, so a waiver's officer and rationale of record can
   never be overwritten; and the acting user is attributed on the artefacts, not
   just the audit row — the accepted memo carries `accepted_by_email` /
   `accepted_by_role` / `accepted_at`, and the record/resolve responses carry
   `raised_by_email` / `resolved_by_email`.

Nine new tests cover the anonymous 401, the forged-identity 403s on all three
reads, the absence of any raw payload (including that the memo prose appears
nowhere in the timeline), the anonymous redactions, the double-waive 409, the
required rejection reason, the closed action set, memo attribution, and the
deal-code guard.
