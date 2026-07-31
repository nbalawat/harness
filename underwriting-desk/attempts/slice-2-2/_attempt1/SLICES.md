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

## Slice 2 — Financial spreading agent and the draft review workspace

Accepting the intake triage draft (previous slice) assigns the analyst queue
and, inside the same workflow tick, the approved `deal-underwriting` process
runs `route_to_queue` and then the **financial spreading agent** node itself —
the deal's stage moves `document_extraction -> financial_spreading` the
moment that output is materialised. `POST /deals/{ref}/spread` adopts the
workflow's own `spread_financials` reply (or, if none is available, runs the
agent directly) and parks it as a **PENDING** `agent_drafts` row: every one of
the ten standard spread-template lines (`revenue`, `cogs`,
`operating_expenses`, `ebitda`, `interest_expense`, `current_assets`,
`current_liabilities`, `total_debt`, `tangible_net_worth`,
`annual_debt_service` — `spread-template@2026.1`), each figure carrying a
citation naming the exact `document_id` + `document_location_id` it came
from, or the literal phrase `"not supported by the record"` where the
extracted document locations for the deal cannot support that line. The
agent's structured JSON is accepted only if every citation resolves to a real
location on the deal; otherwise the app falls back to a deterministic
label-match extraction over the same locations — never a guess, never a
figure carried over from another deal.

The **Draft Review workspace** (`screen-review`) is now the single accept /
edit / reject seat for *every* agent draft type the app produces, not just
triage: `GET /drafts` lists the cross-deal acceptance queue (deal, borrower,
artifact, agent, state, model, latency, cost, age); `GET /drafts/{id}` loads
one draft's full content plus its resolved evidence (the actual document +
location text behind each citation) for the side-by-side panels; the existing
`POST /deals/{ref}/drafts/{type}/review` — already generic from slice 1 — is
the same guarded endpoint every draft type disposes through. A rejection
without a written reason is refused with 400 (unchanged contract, now proven
against the spread draft too). Accepting (or editing) the spread persists it
as structured `spread_line_items` rows with their `citations` rows — the act
of acceptance is what turns drafted figures into deal-of-record data — and
advances the deal `financial_spreading -> risk_grading`. Editing a spread
line item records a `human_override` citation (no document/location id, an
explicit "human-edited override" source reference) so the traceability chain
never silently loses its "who changed this and to what" trail. Every agent
run still records model id, prompt version, inputs, raw output, latency and
token cost on `agent_runs`, exactly like triage.

The `persist_spread_line_items` workflow node handler is registered so the
`deal-underwriting` definition's own march through that node is idempotent —
it confirms the same rows the HTTP accept path already wrote rather than
double-inserting, whichever path reaches it first.

- Screens delivered: `screen-review` (serves triage drafts from slice 1 too —
  that screen keeps working, now through the same generic queue)
- Endpoints: `POST /deals/{ref}/spread`, `GET /drafts`, `GET /drafts/{id}`
- Workflow handlers registered: `persist_spread_line_items`
- Addresses: REQ-005, 016, 020, 024, 030..032, 037..039, 046, 056
