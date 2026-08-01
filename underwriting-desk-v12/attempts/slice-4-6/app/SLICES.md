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
