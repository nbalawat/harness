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
