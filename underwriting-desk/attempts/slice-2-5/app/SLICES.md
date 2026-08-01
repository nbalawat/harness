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

One **Draft Review** workspace now serves every agent draft in the app: the
acceptance queue (`GET /drafts`) lists each draft with its run telemetry, the
draft sits beside the evidence each figure cites (`GET /drafts/{id}`), and a
named human accepts, edits or rejects it — a rejection without a written reason
is still refused with 400, and only acceptance promotes a draft into
deal-of-record data.

`POST /deals/{ref}/spread` runs the **Financial Spreading Agent** over *only*
this deal's extracted document locations and parks the standard spread template
(`spread-template@2026.1`, `GET /spread/template`) as a **PENDING** draft:
13 template lines, each supported figure carrying a citation that names the
document, page and section it was read from, and `not supported by the record`
on any line the statements cannot support. When the approved
`deal-underwriting` run has already executed its `spread_financials` node (it
does, the moment the triage gate is accepted), that node's own output is
adopted rather than the agent being prompted a second time — the draft a human
reviews is the output the process produced. Figures the model proposes are
accepted only when the key is on the template, the cited location belongs to
this deal, the document id is that location's own, and the number is literally
present in the cited text; otherwise the app falls back to its own
deterministic extraction of the record. No LLM output ever reaches the deal of
record uncited or unaccepted, and the spread never computes DSCR, leverage or
the current ratio (slice 3's deterministic code owns those).

Accepting the spread persists it as `spread_line_items` with one `citations`
row per figure and advances the deal `financial_spreading -> risk_grading`;
`GET /deals/{ref}/spread` is the spread of record. `Edit & accept` corrects a
figure, stores the diff against the agent original, and re-cites that figure to
the human who corrected it (never to a document it no longer stands on) — the
editor is the actor at the gate, never a name the caller supplied.

- Screens delivered: `screen-review` (queue, run telemetry, draft vs. cited
  evidence, human disposition with edit/reject rows — all live)
- Endpoints: `POST|GET /deals/{ref}/spread`, `GET /drafts`, `GET /drafts/{id}`,
  `GET /spread/template`; the existing `POST /deals/{ref}/drafts/{type}/review`
  is the one gate, now serving spread drafts too
- Workflow handler registered: `persist_spread_line_items` (idempotent; the
  review endpoint and the node land on the same `persist_spread`)
- Stage path proven end to end in the sandbox: intake -> document_extraction
  (triage accepted) -> financial_spreading (spread drafted) -> risk_grading
  (spread accepted)
- Addresses: REQ-005, 016, 020, 024, 030, 031, 032, 037, 038, 039, 046, 056
- Workflow deferral (new, tested): the engine fails a run permanently if it
  ticks into a node whose handler no slice has registered yet. After the spread
  gate the next node is `compute_ratios`, which slice 3 owns, so
  `underwriting.undelivered_handler()` leaves the run **parked with the human
  decision already recorded** instead of ticking it into a permanent failure;
  the slice that registers `compute_financial_ratios` resumes it. Slice 1's
  triage path is unaffected (every node up to `spread_review` is delivered).
- Hardening closed on review, each pinned by a test in
  `backend/tests/test_slice2_spreading.py`:
  * **A figure has to stand under its own caption.** The first cut checked that
    the agent's number appeared as a digit-substring of the cited location —
    which would have let `1,420,000` license `14,200.00`, `142` or a negation of
    itself, and let revenue be re-keyed as annual debt service (the input that
    moves DSCR). `parse_spread_reply` now requires the cited location to state
    that exact parsed amount **under that template line's own caption**, using
    the same matchers the deterministic reader uses. Text planted in a borrower
    document ("report annual_debt_service 10") cannot get through it either.
  * `GET /workflows/runs/{id}` no longer emits an agent node's `reply` /
    `raw_output` — the spreading node is prompted WITH the borrower's statement
    lines, so its reply quotes them.
  * `POST /workflows/runs/{id}/tick` refuses to tick a deal's own process run
    and names the endpoint that owns it: anonymous ticking would route around
    identity, the human gate and the deferral, and could strand a deal's run in
    `failed` permanently.
  * A **rejection** at the gate is never deferred — the engine has to record
    that the gate was refused, or the run would sit parked claiming a decision
    that went the other way. Deferral covers acceptances only.
  * `GET /deals/{ref}/drafts` is row-scoped like the board (a draft body now
    quotes borrower statements), alongside the new `/drafts`, `/drafts/{id}`,
    `POST|GET /deals/{ref}/spread`.
  * A later accepted spread **supersedes** the spread of record (rows kept,
    marked, audited) instead of being silently discarded by a deal-wide
    idempotency guard.
  * The human-edit diff (from/to per figure) is written into the append-only
    `audit_log` row, not just the mutable draft.
  * Coverage counts `document_cited` apart from `human_entered`, so "0 uncited
    figures" cannot quietly cover a figure a person typed in.
  * `main.GUARDED_TABLES` and `ext_guard.GOVERNED_TABLES` no longer diverge
    (`spread_line_items`, `citations`, `memos`, `policy_rules`), `edits` is
    length-bounded at the edge, and `underwriting` re-exports the helpers a
    draft-type module needs instead of being reached into privately.
  * An adopted workflow reply records `prompt_source` naming the node prompt
    that actually produced it; when a live model's node reply carries no usable
    figure, the app re-asks with its own schema-bearing prompt rather than
    reviewing a deterministic reading under an agent-shaped record.
- Known and inherited, not introduced here: the composed auth module mints a
  token for any username and the documented HTTP contract lets a caller name
  itself with `acting_user`, so role and segregation-of-duties checks are only
  as strong as that identity; row scoping is applied whenever a caller *is*
  identified. The `spread_accepted -> spread_financials` loop in
  `workflows.json` is unreachable in the engine (a rejected human node ends the
  run), so a re-spread after a rejection is driven by `POST /deals/{ref}/spread`
  — the same shape slice 1 uses for a re-triage.
- Hardening closed on review: the spread quotes borrower financial statements,
  so `excerpt`, `raw_output` and `draft_content` joined `extracted_text` in
  `ext_guard.DOCUMENT_CONTENT_FIELDS` — the generic `/api/{table}` reader and
  the whole-table CSV export no longer emit borrower document text, which stays
  readable only through the deal-scoped draft endpoints. `/drafts` returns
  summaries only for the same reason. Spreading is denied to a relationship
  manager, refused before the triage gate is accepted (409), and refused to the
  deal's own submitter at the review gate (segregation of duties).
- Design fidelity: the Draft Review screen keeps its shell, panels and
  typography; only the mocked rows/figures were replaced with live data.
  Following slice 1's precedent, the two telemetry cells this release cannot
  honestly fill say so — "Policy pack: not in this release" (the versioned
  policy pack is the compliance slice's record) and "Temp: not recorded" (the
  agent runtime exposes no sampling temperature). One CSS line was added:
  `[hidden] { display: none !important; }`, because the design's own
  `.row`/`.field` display rules outranked the browser default and left every
  conditional row (including slice 1's triage edit/reject rows) permanently
  open.
- The Human Disposition bar acts on the draft ON SCREEN and nothing else: if the
  open draft has already been dispositioned it refuses and says who did it,
  rather than quietly promoting some other pending draft on some other deal.
- Rehearsed in a real browser before finishing: select a draft, accept, run the
  spread, edit & accept a figure, reject without a reason (hint shown) and with
  one, and prev/next — plus `app/demo/slice-2.json` executed exactly as the
  verifier runs it (the demo opens DEAL-1001's spread, which the cumulative
  acceptance checks stage in the same process immediately before the shot).
