# KYC Review Desk — slices


- **Slice 1 — Case intake and deterministic completeness check** (`case-intake-completeness`).
  A client submission opens a case and runs the approved `case-intake-and-risk-scoring`
  workflow end to end: `POST /cases` starts the run, whose deterministic handlers
  (`open_case_from_submission`, `run_document_completeness_check`, `mark_case_ready`,
  `compute_risk_score_from_matrix`, `start_sla_clock`, `return_case_with_missing_documents`)
  are registered in `backend/ext_kyc_cases.py`. A complete package is marked **ready** with a
  case-ready timestamp; an incomplete one is **returned** with the itemised missing-document
  list (base checklist v2.0 items plus the conditional triggers: chain depth > 1 → structure
  chart, regulated industry → operating license, cross-border expected → expected-activity
  questionnaire). `POST /cases/{ref}/waive-document` is refused 403 for every role — completeness
  is mechanical and only a recorded compliance-officer policy exception can vary it.
  Also serves `GET /checklist`, `GET /cases`, `GET /cases/{ref}`, `GET /cases/{ref}/documents`;
  cases are addressed by their submission reference. Policy constants live in
  `backend/kyc_policy.py`, all state access in `backend/kyc_store.py` (db.store only).
  UI: the Dossier design's Worklist folio gains a live submission form and live worklist ledger,
  and the Case File folio a live case file with its checklist result and outstanding items —
  both inside the existing screen containers, in the design's own idiom.
  Housekeeping: `backend/ext_conversations.py` registers the chat shell's `conversations` table
  (addressed by `app.js` and the seed fixtures) without hand-editing the generated `models.py`.
