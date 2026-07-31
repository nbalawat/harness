# Underwriting Command Center — slices

## Slice 1 — deal-intake-and-pipeline: Submit a deal and see it on the pipeline board

The walking skeleton: one login, one form, one persisted Deal, one board.

- **Identity (REQ-001, REQ-018/019)**: `ext_auth.py` extends auth-basic with
  password-checked, role-assigned demo accounts backed by the certified
  `users` table (the module's default password-less v0 doesn't fit a
  regulated-lending login requirement). Seeded idempotently on import:
  `rm1` / `analyst1` / `officer1`, all password `demo1234`, roles
  `relationship_manager` / `credit_analyst` / `senior_credit_officer`, ids
  `user-rm1` / `user-analyst1` / `user-officer1`. `POST /api/auth/login`
  returns `{token, username, user_id, role}`; roles are also granted through
  `rbac.grant()` so `rbac.require()` works for later slices.
- **Deals + pipeline (REQ-002, REQ-020/021, REQ-026-028, REQ-041/042,
  REQ-051)**: new `ext_deals.py` registers `POST/GET /api/deals` and
  `GET /api/pipeline` as explicit routes (they resolve ahead of main.py's
  generic `/api/{table}` catch-all because ext_*.py routers are included
  before that catch-all is even declared). `POST /api/deals` validates via
  `forms.validate`, requires the submitting user to exist and hold
  `relationship_manager` (403 otherwise — REQ-020), creates the deal at
  `stages.machine.initial` ("intake"), derives `approval_tier` deterministically
  via the new `tiering.py` (REQ-043/054 ceilings: ≤$250k analyst, ≤$1M senior
  officer, else committee), writes a `stage_transitions` row, and audits
  `deal.created`. `GET /api/deals?as_user_id=...` applies `rls.scope()` so a
  known relationship manager only sees deals they submitted; unscoped calls
  (the board) see all active deals. `GET /api/pipeline` groups active deals
  into the 8 canonical stages defined in the new shared `stages.py` (single
  source of truth other slices should import rather than redeclare).
- **Audit trail (REQ-018)**: `ext_audit.py`'s `record()` now persists into
  the certified `audit_log` table via `db.store` (it previously wrote to a
  private in-memory list that didn't match the data model at all — fixed
  here since REQ-018/041/042 and later REQ-047/050 all depend on a real,
  per-deal-filterable audit table). `mod_auditview.js`'s formatter was
  updated to match the new row shape.
- **Frontend (screen-pipeline, screen-intake)**: `mod_router.js` was fixed
  to actually drive this design's screen switching (it shipped unwired —
  no script tag referenced it, and its class-vs-inline-style toggle didn't
  match this shell's `.screen.active` CSS); it now toggles the `active`
  class, updates nav highlighting/breadcrumb, and translates this design's
  `data-screen`/`data-goto` button clicks into hash navigation. Added a
  login overlay (REQ-001) gating the shell until `/api/auth/login`
  succeeds. The Pipeline Board's stage rail, deal register table, header
  counts, nav badge, and status-strip counters this slice can honestly
  derive (Queue, Exposure live) now render real `/api/pipeline` data instead
  of the mock rows; counters this slice has no data for yet (SLA breach,
  Awaiting accept, Approvals due) show `0` rather than stale fake numbers.
  The Intake form's borrower/facility fields post to `POST /api/deals`
  (added an Industry field and facility-type option values the API needs);
  the exposure-vs-tier gauge and duplicate-request check now compute live
  from the typed amount and existing deals. The Documents / Intake Triage
  Agent / Preflight panels — out of this slice's REQs (triage is
  REQ-004/030/033, slice 2) — were changed from fabricated "pending" mock
  content to an honest not-yet-run state with disabled actions, rather than
  either faking agent output or shipping dead buttons.
- Backend tests: fixed a pre-existing failure (`test_table_crud` posted to
  `/api/conversations`, a table this domain's data model doesn't have) and
  added coverage for login, deal creation/RBAC, and the pipeline board.
