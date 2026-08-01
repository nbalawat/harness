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

A credit analyst works one **Draft Review** workspace (`screen-review`) that
serves every agent draft in the app: the queue lists each artefact with its run
telemetry, the draft sits beside the evidence each figure cites, and the
accept / edit / reject gate below it is the only door into the deal of record.
Accepting the triage draft assigns the analyst queue and advances the deal
`intake -> document_extraction` (slice 1's gate, now reachable from this
screen). `POST /deals/{ref}/spread` then runs the **Financial Spreading Agent**:
the approved `deal-underwriting` process already executed its `spread_financials`
node when the triage was accepted, so that node's own output is adopted and
recorded as the agent run (model id, prompt version, inputs, raw output,
latency, estimated tokens, cost) rather than the agent being prompted twice.

The agent's structured spread is accepted **only if every part of it verifies**:
each standard-template line exactly once, every figure carrying a document id
AND a document-location id belonging to this deal, and the figure's digits
actually present in that location's stored text — a citation the record cannot
confirm is a hallucinated citation, so the whole reply is refused and the
deterministic derivation from the stored document locations is used instead
(`source` is shown in the run telemetry either way). Template lines the
documents do not state read **"not supported by the record"** and carry no
figure. Human acceptance is the act that writes `spread_line_items` and their
`citations`; a figure with no citation is refused with 422 rather than stored,
a rejection without a written reason is refused with 400, a reviewer's
correction replaces the agent's citation with `human_correction` provenance
naming them, and acceptance advances the deal `financial_spreading ->
risk_grading`. No ratio, grade or tier is produced anywhere on this path — the
template deliberately carries no derived line (REQ-009).

- Screens delivered: `screen-review` (its DESIGN PREVIEW banner is gone — the
  queue, the telemetry strip, the draft panel, the evidence panel, the
  disposition bar and the Prev/Next and A/E/R keys are all driven by the app;
  the design's "View trail entries for this run" button still does what the
  design gave it — it navigates to the Audit Trail screen, which a later slice
  delivers, and its tooltip says so rather than implying a filtered view)
- Rehearsed against the running app: `app/demo/slice-2.json` was executed in
  the browser in verifier order (cumulative acceptance first, then the demo
  steps) and the resulting shot is committed as `app/screenshots/slice-2.png`
- Endpoints: `POST|GET /deals/{ref}/spread`, `GET /drafts`, `GET /drafts/{id}`
  (the existing `POST /deals/{ref}/drafts/{type}/review` is the gate for both
  artefacts and now promotes spreads too)
- Workflow handler registered: `persist_spread_line_items` (idempotent — it
  names the rows the acceptance already wrote rather than doubling them)
- `resume_workflow` now defers instead of ticking into a deterministic node no
  shipped slice registers yet (`compute_financial_ratios` and its successors):
  the human decision is recorded on the approval item and the run stays parked
  at its gate, so a partially delivered process can no longer turn a good
  decision into a permanently failed run.
- Addresses: REQ-005, 016, 020, 024, 030, 031, 032, 037, 038, 039, 046, 056
- Design fidelity notes: the review screen's shell, layout and tokens are
  untouched; two telemetry cells the app cannot honestly fill were re-labelled
  rather than left lying — "Policy pack" is now "Template" (the spread template
  version) and "Temp" is now "Source" (agent / deterministic-fallback /
  human-edited) — and the queue's Tokens column shows an explicit `≈` estimate
  because this runtime reports no usage figures.
- Hardening, each pinned by a test in `backend/tests/test_slice2_spread.py`:
  the governed-table list has one definition again (`main.py` now reuses
  `ext_guard.GOVERNED_TABLES`, which already covered `spread_line_items`,
  `citations`, `memos` and `policy_rules`); borrower document text is scrubbed
  from generic reads and CSV exports wherever this slice copied it (a draft's
  citation `excerpt`, its `draft_content`, and an agent run's `inputs` /
  `raw_output` — reading the copy was a way around the slice-1 control on the
  original); the workspace reads are row-scoped exactly like the board (a
  relationship manager sees only their own deals' drafts, by queue and by draft
  id); running the spread is denied to any role without the grant and to a deal
  that has not passed its triage gate; and the submitter of a deal still may
  not disposition its drafts.
- Hardening closed on review:
  * an agent citation is only accepted if the cited location **states that
    template line at that figure** (read back with the same deterministic rule
    the fallback uses) — a digits-appear-somewhere test would have let
    `EBITDA 400,000` cite a location that says `Revenue 12,400,000`;
  * a reviewer's edit is validated in full before any of it is applied and the
    draft is deep-copied first, so a batch with one bad line can no longer
    leave an unrecorded human change on a PENDING draft;
  * correcting a figure now requires a written reason of its own — the number
    is leaving the evidence that cited it, so the record says why;
  * the workflow reply is adopted exactly once: a re-draft after a rejection is
    a new agent call that carries the reviewer's reason into the prompt, rather
    than replaying the rejected draft and booking a second run for a call that
    never happened;
  * a rejection is ticked into the process immediately (only an **approved**
    gate is ever deferred), so a run can no longer sit parked on a decided item
    that a later slice's first tick would resolve as a failure;
  * the adopted run's `latency_ms` carries a `latency_basis` saying it is the
    engine tick's wall clock (an upper bound), surfaced as the tooltip on the
    telemetry cell rather than posing as a measured call duration.
