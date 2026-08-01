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

## Slice 2 — Financial spreading agent and the draft review workspace

A credit analyst works one **Draft Review** workspace that serves every agent
draft in the app: the acceptance queue (`GET /reviews`), the draft beside the
evidence each figure cites (`GET /reviews/{ref}/{draft_type}`), and the human
disposition. Accepting the triage draft there assigns the analyst queue and
advances the deal `intake -> document_extraction` (slice 1's gate, now driven
from this screen too).

`POST /deals/{ref}/spread` runs the **financial spreading agent**. It reads
*only* this deal's extracted `document_locations` and fills the standard spread
template (`spread-template@2026.1`, 14 lines across income statement, balance
sheet and debt service), attaching to **every single figure** a citation naming
the document id, the document location id, the page and the section it was read
from; a template line the documents cannot support carries the exact phrase
"not supported by the record" rather than an estimate. Drafting the spread is
itself a recorded stage move (`document_extraction -> financial_spreading`) and
the draft lands PENDING — `uncited_value_count` is part of the draft contract
and is 0.

`POST /deals/{ref}/drafts/spread/review` is the same human gate slice 1 built:
a rejection without a written reason is refused with 400, and only acceptance
(or an edit) persists the spread as `spread_line_items` + `citations` rows and
advances the deal `financial_spreading -> risk_grading`. Every agent run
records its model id, prompt version, inputs, raw output, latency, token counts
and token cost (`agent_runs`), all of which the workspace's telemetry strip
shows.

- Screens delivered: `screen-review` (its DESIGN PREVIEW banner is gone; the
  queue, telemetry strip, draft panel, evidence panel and disposition bar are
  all live). `screen-intake` gained a "paste the statement text" control, because
  the spreading agent may cite nothing but a stored document.
- Endpoints: `POST|GET /deals/{ref}/spread`, `GET /reviews`,
  `GET /reviews/{ref}/{draft_type}`
- Workflow handler registered: `persist_spread_line_items`
  (`deal-underwriting/persist_spread`), idempotent — human acceptance already
  wrote the spread of record, so the node confirms and names those rows
- Addresses: REQ-005, 016, 020, 024, 030, 031, 032, 037, 038, 039, 046, 056

### Money never passes through the model

REQ-032/FSI rule 7 is enforced two ways. The agent's structured proposal is
admitted **only** if every figure carries a `document_location_id` from this
deal's own catalogue *and* the cited location literally states that number
(`value_supported_by`); one bad figure invalidates the whole proposal. When it
does not validate, the app falls back to a deterministic extractor over the
stored locations — captions are matched anchored-first so "Sales" can never be
harvested out of "Cost of Sales" and "Interest Expense" can never be read off
"Annual Principal and Interest". Both paths are unit-tested in
`backend/tests/test_slice2_spread.py`. An "Edit & accept" correction is recorded
as `source_type: "human_correction"` — a human-corrected figure never keeps
wearing the agent's citation.

### A rejection loops the process back; it does not kill the run

`workflows.json` models a rejected draft as a loop **back** to the drafting node
(`triage_accepted` / `spread_accepted` carry `on_false`), but
`workflow_engine.tick()` marks a run **failed** the moment it resumes past a
rejected human gate — after which no later acceptance can ever resume it. So a
rejection now leaves the run's own human node open: the DRAFT is rejected (the
`agent_drafts` row and the audit row name the human and the mandatory written
reason), the node is satisfied only when a re-drafted artefact is accepted, and
the re-draft reuses that same gate. Ad-hoc (`agent_draft:`) gates with no
workflow behind them are still closed as rejected. Pinned by
`test_rejecting_a_draft_leaves_the_process_gate_open_for_a_redraft` and
`test_rejecting_triage_does_not_kill_the_run_either`.

### Process resumption

Accepting the spread resumes the approved `deal-underwriting` run. Its tail
(`compute_ratios`, `assign_risk_grade`, `advance_to_memo_stage`) belongs to
slice 3, and `tick()` runs until it parks, completes or **fails** — so driving
the run into an unregistered handler would mark it failed and strand the
process. `underwriting.workflow_resume_blocked_by()` names the missing handler
instead and leaves the run parked on its dispositioned gate, resumable the
moment that slice lands. The triage path is unaffected: accepting triage still
drives the run through `route_to_queue` into the `spread_financials` agent node
and parks on `spread_review`, and that node's own output is what the analyst
reviews (adopted, not re-prompted, so the process's output and the reviewed
draft are the same artefact).

### Hardening closed in this slice

- `visible_deals()` denied by default for an authenticated-but-unknown
  identity. `/auth/login` mints a token for any name, so the previous
  "unknown user is unscoped" branch handed the whole book to anyone who asked
  for a token; a header-less HTTP caller (the documented slice contract) is
  unchanged. Pinned by `test_spread_endpoint_honours_row_scoping`.
- `/deals/{ref}/spread` and `/reviews/{ref}/{type}` apply the same row scoping
  as the board, so naming a reference cannot walk around it.
- `spread_line_items` and `citations` are refused through the generic
  `/api/{table}` writer (ext_guard already governs them) — tested.
- Segregation of duties carries over: the deal's submitter may not review its
  spread either.
- Honesty sweep on the covered screen: the design's example drafts, telemetry,
  exception text and evidence list are all replaced with live data on first
  paint, and the intake screen's leftover "queue 3 at capacity" rationale is
  told the truth when no triage run exists.

### Closed on review

- Borrower financial text was reaching `GET /api/citations`, `/api/agent_drafts`
  and `/api/agent_runs` through the new `citation.excerpt` and (in stub mode)
  `agent_runs.raw_output`, defeating the control slice 1 built for
  `extracted_text`. `ext_guard.DOCUMENT_CONTENT_FIELDS` now scrubs all three
  from every generic read and CSV export; the deal-scoped `/reviews` workspace
  still shows the analyst the quoted evidence.
- `GET /deals/{ref}/drafts` was the one deal-addressed read with no row scoping
  — and slice 2 made it carry the whole spread. Scoped now, like every other.
- `main.GUARDED_TABLES` had drifted from `ext_guard.GOVERNED_TABLES` (the new
  tables were in one set and not the other); it is now an alias of the single
  source of truth, pinned by a test.
- `adopt_workflow_spread` recorded `latency_ms: 0` on what is the *default*
  spread path — fabricated telemetry against REQ-038. The wall clock of the
  workflow tick that executed the node is recorded instead (private
  `_wf_tick_timings`), and the test asserts it is non-zero.
- `uncited_value_count` had two divergent definitions (agent path vs edit path)
  and `uncited_figure_count` was a hard-coded `0`. One `uncited_count()` now
  serves all three call sites.
- "View trail entries for this run" navigated to the still-undelivered Audit
  Trail screen. It now reads a real, row-scoped, read-only endpoint —
  `GET /reviews/{ref}/{type}/trail` — and renders the append-only `audit_log`
  entries for that draft in place.
- The spread-correction input used a class the design does not define, and a
  refused spread wrote its error into a node the next render immediately
  overwrote, so the button looked inert on a 403/409.
- `/export/{table}.csv` filtered column NAMES only, so the nested citation
  excerpts inside the `agent_drafts.draft_content` JSON column still put
  borrower statement text into a spreadsheet. Every exported row now goes
  through `ext_guard.scrub()` first.
- `POST /deals/{ref}/triage` was the last deal-addressed route with no row
  scoping — a signed-in caller could run a billable agent on a deal that
  `GET /deals/{ref}` would 404 for them. Scoped.
- Tick timings are held in microseconds, so a fast tick reports 1 ms instead of
  a zero that would read as fabricated telemetry.
- The trail panel is bounded to the window its own draft owned (creation of
  this draft up to creation of the next), so a triage draft's trail no longer
  claims the spread's promotion rows.
- A gate reused after a rejection has its payload rewritten to describe the
  re-draft, so `GET /workflow/submissions/pending` cannot advertise a
  superseded draft.

### Notes for later slices

- Slice 3: add an end-to-end assertion that a run deferred on
  `compute_financial_ratios` resumes *through* `persist_spread` once that
  handler registers — the node's in-situ contract stays unverified until then.
- Slice 4: the Approvals screen must read `agent_drafts` for the review
  history, not `_approvals_queue`. A rejected-then-re-drafted deal carries its
  rejection on the draft row and in `audit_log`; the process gate itself only
  ever records the acceptance that finally satisfied it.
- Covered-screen liveness: the left-rail counts, "deals in view" and role scope
  are driven from the board (screens later slices deliver read `—` rather than a
  fabricated number), the pipeline row actions carry the selected deal, the
  triage banner tracks the gate instead of asserting PENDING forever, the
  design's OFAC row is kept and told the truth, and the five-agent switch and
  session clock are live.
