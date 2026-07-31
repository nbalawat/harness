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
