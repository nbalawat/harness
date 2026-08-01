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

## Slice 2 — Financial spreading agent and the draft review workspace

`POST /deals/{ref}/spread` runs the **Financial Spreading Agent** over nothing
but the deal's extracted document locations and fills the bank's standard
spread template (`spread-template@2026.1`, 14 lines across income statement,
balance sheet and debt service). **Every single figure carries a citation**
naming the document, the document location id, the page and the section it was
read from; a template line the documents cannot support is recorded with the
exact phrase *"not supported by the record"* rather than a guess. The model's
structured output is admitted only if every item validates — a known template
key, a citation into this deal's own locations, and a value the cited location
states **verbatim** — otherwise the app falls back to a deterministic reading of
the record. That verbatim check is what keeps LLM arithmetic out of the deal of
record; nothing in this slice computes DSCR, leverage, a current ratio or a
grade. The run lands on `agent_runs` with its model id, prompt version, inputs,
raw output, latency and token cost (REQ-038).

The spread lands as a **PENDING** `agent_drafts` row behind the workflow's own
`spread_review` human gate. `POST /deals/{ref}/drafts/{type}/review` (slice 1's
single gate implementation) is still the only door: a rejection without a
written reason is refused with 400 and persists nothing; an acceptance — or an
edit, which records a `{from,to}` diff and re-cites the corrected figure to the
named human who typed it — writes `spread_line_items` with one `citations` row
each and advances the deal `financial_spreading -> risk_grading`. Acceptance is
idempotent, so a replay or a later workflow tick confirms rather than doubles
the spread.

The **Draft Review** screen is now live and serves *every* agent draft in the
app, not just spreads: the acceptance queue with each run's model, latency,
tokens, cost and age; the run telemetry strip; the draft side by side with its
cited evidence (click a template line to pin the location that backs it); and
the accept / edit / reject bar with the reason box the audit trail records
verbatim. "Run spreading agent" acts on the deal chosen beside the queue and is
disabled unless that deal has cleared its triage gate.

- Screens delivered: `screen-review` (slice 1's `screen-intake` / `screen-pipeline` unchanged)
- Endpoints: `POST /deals/{ref}/spread`, `GET /deals/{ref}/spread`,
  `GET /review/queue`, `GET /review/drafts/{id}`
- Workflow handler registered: `persist_spread_line_items` (contract-tested
  against the `persist_spread` node's `output_schema`)
- Role gates: running the agent needs `credit_analyst` / `credit_officer`;
  dispositioning keeps slice 1's gate, including the segregation-of-duties rule
  that bars a deal's submitter from accepting its drafts
- Addresses: REQ-005, 016, 020, 024, 030, 031, 032, 037, 038, 039, 046, 056
- Process integrity: the `deal-underwriting` run's next node
  (`compute_ratios`) belongs to the ratio slice. The engine fails a run outright
  at an unregistered handler and an event-sourced run cannot be un-failed, so
  `resume_workflow` now **defers** the tick instead: the run stays parked on its
  already-dispositioned human node and the slice that registers
  `compute_financial_ratios` resumes it from exactly there. A *rejected* gate is
  never deferred: it ends its run at that node, exactly as the engine defines.
- Hardening closed on review, each pinned by a test in
  `backend/tests/test_slice2_spread.py`: a model figure is admitted only if the
  cited location states it as a **whole number token** (not a digit substring),
  **with its sign**, and the deterministic re-read of **that template line's own
  label** in that location must return exactly that number — so a real figure
  cannot be filed under a line it does not belong to, and prose that merely
  mentions a line ("current assets increased … total funded debt of 8,000,000")
  is not evidence for it; the persisted `cited_value` is the
  document's own rendering of the figure, not a re-formatting of the model's;
  citation `excerpt` (borrower document text under another name) is scrubbed
  from the generic reader and the CSV dump exactly like `extracted_text`;
  `GET /deals/{ref}/drafts` and the new `/review` reads are row-scoped, and a
  bearer token minted for a name the app does not know now scopes to **no**
  rows instead of the whole book; `main.py`'s in-route write guard is now the
  same set object as the `ext_guard` middleware's, so the two can never drift;
  the edit diff is taken against a deep copy, so row-history still holds the
  agent's original figure; the citation-integrity counters are recomputed after
  an edit (an analyst-typed figure is cited to the analyst and counted as such);
  and every `agent_runs` insert now appends an audit row naming the human who
  asked for the run rather than whoever submitted the deal.
- Deny-by-default on this slice's reads: `GET /review/queue`,
  `GET /review/drafts/{id}`, `GET /deals/{ref}/spread` and
  `GET /deals/{ref}/drafts` carry drafts, borrower figures and the document
  excerpts behind them, so unlike slice 1's board reads they refuse an unnamed
  caller (401) — the caller signs in or names themselves with `acting_user`,
  exactly as every write on this app does, and the rows are then scoped to that
  person. Identity is resolved *before* the deal is looked up, so a 404 cannot
  be used to learn which references exist. `GET /deals/{ref}` keeps its slice-1
  contract of answering an unnamed caller, but answers *without* the spread
  figures and cited excerpts this slice added to the draft view — the three
  surfaces that serve the same payload now agree.
- Known gap, app-wide and not this slice's to close: the scaffold's generic
  `GET /api/{table}` and `GET /export/{table}.csv` readers have no identity, so
  they have no row-level scoping either. Governed tables (now including
  `spread_line_items` and `citations`) refuse every generic *write* and are
  scrubbed of credential material and borrower document text, but a row policy
  for the generic reader would change a slice-1 contract and belongs with the
  audit/export slice that owns examiner reads.
- Telemetry honesty: the spread adopted from the process run records the
  workflow node's own prompt as its `prompt_template_version` and an *unknown*
  latency (the node ran inside the earlier triage-acceptance tick) rather than a
  zero that would read as a measurement.
- Known engine limit (unchanged from slice 1, now documented): a human
  rejection ends its workflow run — `workflow_engine` writes `run.failed` at the
  gate rather than following the definition's `on_false` loop back to the agent
  node. The re-drafted spread is therefore governed by a fresh approval gate,
  the deal's own stage machine and the audit trail; the dead run is left as
  process evidence rather than being rewritten.
- Honesty sweep: `screen-chat` now carries the same "DESIGN PREVIEW" banner as
  the other screens later slices deliver — it was the last screen still
  presenting the design's example transcript (a named officer, a portfolio
  figure and a policy pack that do not exist) as if it were live.
- Slice-1 defect closed: blob ownership is now decided by the `documents` row
  that names the blob rather than by parsing the deal reference back out of the
  blob name — `<reference>-NN-<file>.txt` is ambiguous whenever a reference
  itself ends in a two-digit group, which both denied such a deal its own
  document text (so nothing could be spread from it), could have admitted a
  neighbouring deal's, and silently dropped an operator upload that merely
  happened to be named that way. The cross-deal refusal is unchanged and still
  tested.
