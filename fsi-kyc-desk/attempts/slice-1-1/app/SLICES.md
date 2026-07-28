# KYC Review Desk — slices

## Slice 1 — Case intake and deterministic completeness check (`case-intake-completeness`)

Implements REQ-001..014, REQ-055, REQ-070, REQ-089, REQ-094.

- New `backend/policy_versions.py`, `backend/document_checklist.py`,
  `backend/case_state.py` and `backend/ext_cases.py`.
- Registers the deterministic handlers `open_case_from_submission`,
  `run_document_completeness_check`, `mark_case_ready` and
  `return_case_with_missing_documents` on the `case-intake-and-risk-scoring`
  workflow (`workflows/workflows.json`). `POST /cases` starts that workflow
  run through `workflow_engine`; later slices register the remaining
  `compute_risk_score_from_matrix` / `start_sla_clock` handlers on the same
  definition — until they do, the run stops there as expected, after this
  slice's own result (ready/returned) is already on the case record.
- Document Checklist is mechanical: 4 base-required documents plus
  `structure_chart` (deep/complex ownership), `operating_license` (regulated
  industry) and `expected_activity_questionnaire` (cross-border expected),
  each keyed off the case's own submitted attributes/risk factors — never an
  analyst's judgment call. No endpoint can waive a required item;
  `POST /cases/{reference}/waive-document` always 403s and points to the
  (future) compliance-officer exception mechanism instead.
- New endpoints (outside `/api/`, so the `/api/{table}` catch-all never
  shadows them): `POST /cases`, `GET /cases`, `GET /cases/{reference}`,
  `POST /cases/{reference}/waive-document`, `GET /checklist`.
- Case status changes go through `case_state.machine` (state-machine module);
  every status change also writes a row to the `audit_trail` table and the
  generic `ext_audit` system trail.
- Frontend: `frontend/case_intake.js` (new script, loaded alongside
  `mod_datatable.js`/`mod_recorddetail.js`) wires the Worklist ledger table
  and a new case-lookup control + live particulars/checklist panel on the
  Case File screen to the real `/cases` API, rendered into the design's own
  markup/classes via `textContent` only. The design's illustrative example
  content elsewhere on the Case File screen is left in place, clearly
  labelled "(illustrative design example)".
- Fixed a pre-existing scaffold gap: `models.TABLES` was missing the
  `conversations` table that `ext_seed.py` and the chat-shell history panel
  already depended on, which was failing `test_table_crud`; added it back.
- Extended `models.TABLES["cases"]` with the columns this slice's case rows
  actually carry (`case_reference`, `client_reference_display`,
  `entity_type`, `submitted_by`, `attributes`, `risk_factors`,
  `documents_submitted`, `returned_at`) — `export-csv`'s generic
  `/export/{table}.csv` derives its column list from `TABLES`, and
  `case_reference` in particular is how every later slice (search, export,
  reproduction) is expected to address a case, so it must not be silently
  dropped from exports.
- Note for later slices: `mark_case_ready`/`return_case_with_missing_documents`
  update a case by mutating the dict returned from `store.list("cases")` in
  place (same convention already used by `approval_flow.py`/`checklists.py`)
  rather than via a store "update" call — `persistence-core` v0 has no update
  API, only `insert`/`list`, and `list()` happens to return the same row
  objects held in memory. This is intentional and consistent with the rest of
  the scaffold today, but it is an in-memory-store-specific aliasing trick:
  if/when `db.store` is switched to the `sqlite-adapter` (which deserializes
  fresh dicts on every `list()`), every one of these in-place mutations
  (across all slices, not just this one) will silently stop persisting and
  need a real update path.
- New tests: `backend/tests/test_cases.py` (mirrors this slice's acceptance
  script exactly: complete/returned/cross-border intake scenarios, worklist +
  case detail reads, the waive-document 403, and the checklist endpoint).

