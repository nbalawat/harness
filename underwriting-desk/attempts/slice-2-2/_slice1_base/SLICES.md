# Underwriting Command Center — slices

## Slice 1 — Deal intake, triage draft, and the pipeline board

A relationship manager submits a borrower's loan request with its documents on
the **Deal Intake** screen (`POST /deals`). The submission runs the approved
`deal-underwriting` workflow: `create_deal_at_intake` registers the deal at the
canonical `intake` stage with its exposure (the requested facility amount alone)
and its deterministically derived `approval_tier` (`<= $250k` analyst,
`<= $1M` officer, above that committee — `tier-rules@2026.1`);
`store_borrower_documents` persists each document through `blob_store`; and
`extract_document_locations` parses them into citable page/section locations.
The run then executes the intake-triage agent node and **parks on the
`triage_review` human node** — nothing advances itself.

`POST /deals/{deal_reference}/triage` materialises that triage as a **PENDING**
`agent_drafts` row: a request classification, the missing-document list for the
request type, and a proposed analyst queue, with the run's model id, prompt
version, inputs, raw output, latency and token cost recorded on `agent_runs`.
The agent's structured proposal is accepted only if it validates against the
configured vocabularies; otherwise the app falls back to a deterministic
derivation from the record. `POST /deals/{ref}/drafts/{type}/review` is the
human gate — acceptance (or an edit) assigns the analyst queue and advances the
deal `intake -> document_extraction`; a rejection without a written reason is
refused with 400. `GET /deals` and `GET /pipeline` back the **Pipeline Board**
with every active deal, its current stage, tier, track and business-day idle
time. Every create, route and transition appends an `audit_log` row naming the
actor and their role.

- Screens delivered: `screen-intake`, `screen-pipeline`
- Endpoints: `POST/GET /deals`, `GET /deals/export.csv`, `GET /deals/{ref}`,
  `POST /deals/{ref}/triage`, `GET /deals/{ref}/drafts`,
  `POST /deals/{ref}/drafts/{type}/review`, `GET /pipeline`,
  `GET /intake/config`, `POST /intake/preflight`, `POST|GET /intake/drafts`
- Workflow handlers registered: `create_deal_at_intake`,
  `store_borrower_documents`, `extract_document_locations`,
  `assign_deal_to_analyst_queue`
- Seeded actors: `rm.rivera` (relationship manager), `an.chen` (credit analyst),
  `co.brennan` (credit officer); HTTP callers name themselves with
  `submitted_by` / `acting_user`, the UI uses the signed-in identity
- Addresses: REQ-001..004, 016, 018, 019, 027..030, 033, 037, 041..043, 054, 056
- Revision applied: the previous attempt's demo could not execute because it
  targeted a `<select>` with a `fill` action; `app/demo/slice-1.json` now drives
  only text inputs and buttons and was rehearsed against the running app.
- Revision applied (this attempt): boot no longer races the demo — the console
  routes to the requested screen synchronously before its first `await`, and it
  never overwrites a deal reference the operator has already typed (previously a
  late boot write replaced it with an existing reference and the submit 409'd).
- Hardening closed on review, each pinned by a test in
  `backend/tests/test_slice1_hardening.py`:
  `ext_guard.py` (new) refuses generic `/api/{table}` writes to the deal of
  record and audits the refusal, and scrubs credential fields from generic
  reads; `/export/{table}.csv` drops sensitive columns and neutralises
  spreadsheet formulas; the raw approval-flow API refuses to disposition a
  governed human gate, so the draft-review endpoint is its only door; a full
  TIN never reaches the workflow-run record or a saved intake draft; the
  workflow-run read no longer doubles as a borrower-document dump;
  `borrower_industry`/`borrower_state`/`reason` are length-bounded; the
  segregation-of-duties refusal names the rule; `visible_deals()` applies the
  composed `rls` module so a signed-in relationship manager sees only the deals
  they submitted (REQ-019), scoping `/deals`, `/pipeline` and the board export
  and their headline totals; non-utf-8 uploads (PDF/DOCX) now go through the
  composed `doc-extract` module instead of landing with no content.
- Honesty sweep on the covered screens: the Deal Intake form no longer ships
  the design's example borrower as live input (it carried a name, address and a
  fabricated TIN that Submit would have turned into a deal of record) — it now
  opens blank like the screen's other panels; the screens later slices deliver
  carry a "DESIGN PREVIEW — not delivered in this release" banner, so a live
  deal id on the board can no longer lead to an invented borrower's record
  presented as that deal; and "deals in view" reuses the board's own filter.
- Row scoping also holds on `GET /deals/{ref}`, so naming a reference cannot
  walk around the scoping applied to the board.
- Covered-screen liveness: the left-rail counts, "deals in view" and role scope
  are driven from the board (screens later slices deliver read `—` rather than a
  fabricated number), the pipeline row actions carry the selected deal, the
  triage banner tracks the gate instead of asserting PENDING forever, the
  design's OFAC row is kept and told the truth, and the five-agent switch and
  session clock are live.
