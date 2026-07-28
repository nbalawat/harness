---
name: app-conventions
description: The laws of a harness-composed app — storage, agents, identity, routing, frontend fidelity. Load BEFORE writing any slice code.
---

# App conventions (certified)

Everything below is enforced by verifiers, evals, or the security scan —
violating a rule costs a failed boot cycle, not a style point.

## Backend
- **Storage**: every read/write goes through `db.store` (`insert`/`list`). No
  dicts-as-databases, no files, no SQL. Tables must exist in `models.TABLES`.
- **LLM calls**: only via `agent_runtime.respond()`. The roster
  (`agents/roster.json`) is the contract — never bypass it, never call a
  provider SDK directly. Evals run against `respond()` and gate the build.
- **Identity**: read the caller via `ext_auth.current_user(authorization)`
  when auth-basic is composed. Never invent tokens or sessions.
- **New endpoints**: prefer an `ext_<feature>.py` with an APIRouter (auto-
  mounted); if you edit `main.py`, remember it ENDS with the `/api/{table}`
  catch-all — any `/api/...` route registered after it is dead. Register
  specific routes outside `/api/` (e.g. `/approvals`).
- **State changes**: call `ext_audit.record(event, detail)` when audit-log is
  composed; approvals go through `approval_flow`, never ad-hoc status fields.
- **Files**: through `blob_store` only — never `open()` a request-derived path.

## Frontend
- `frontend/index.html` IS the user's chosen design (provenance in
  `app/design.json`). Extend inside existing `id="screen-*"` containers using
  `tokens.css` variables. NEVER remove canonical mount points (`agent-mode`,
  `screen-chat`, `messages`, `composer`, `input`) or drop the `app.js` tag —
  the verifier fails the slice.
- DOM updates use `textContent` (never `innerHTML` with data) — the security
  scan flags it.
- Reusable UI: `HarnessTable` (tables), `HarnessDetail` (record views),
  `HarnessChart` (charts — bar axes include zero), `HarnessNotify`
  (notifications), when those modules are composed.

## Tests & acceptance
- The backend suite (`backend/tests/`) must stay green; add tests for new
  endpoints in the same style (stub mode pinned).
- Earlier slices' acceptance checks re-run cumulatively — never regress a
  path another slice's acceptance hits. Check the slice plan before renaming
  or restructuring anything.
