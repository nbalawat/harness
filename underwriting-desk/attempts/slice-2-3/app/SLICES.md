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
agent's structured JSON is accepted only if every cited figure clears three
independent checks — money is never taken on an LLM's word alone: the cited
location is one **this** deal owns on the document claimed; the cited text is
actually **about that template line** (the same label binding the
deterministic extraction uses, so a real citation offered against the wrong
line — "Current Liabilities" as `total_debt` — is refused); and the asserted
number is **the number that cited text says**. A reply that fails any of the
three is discarded whole and the app falls back to a deterministic
label-match extraction over the same locations: never a guess, never a figure
carried over from another deal.

The **Draft Review workspace** (`screen-review`) is now the single accept /
edit / reject seat for *every* agent draft type the app produces, not just
triage: `GET /drafts` lists the cross-deal acceptance queue (deal, borrower,
artifact, agent, state, model, latency, cost, age); `GET /drafts/{id}` loads
one draft's full content plus its resolved evidence (the actual document +
location text behind each citation) for the side-by-side panels. Both deny by
default — this queue enumerates the whole deal book, so only a signed-in or
explicitly named known, active internal seat may read it, and rows are
row-scoped exactly like the pipeline board (a relationship manager sees only
drafts on the deals they submitted). Rows sort newest-first by
`(created_at, id)` so the queue is deterministic even when several drafts land
in the same second. The existing
`POST /deals/{ref}/drafts/{type}/review` — already generic from slice 1 — is
the same guarded endpoint every draft type disposes through. A rejection
without a written reason is refused with 400 (unchanged contract, now proven
against the spread draft too). Accepting (or editing) the spread persists it
as structured `spread_line_items` rows with their `citations` rows — the act
of acceptance is what turns drafted figures into deal-of-record data — and
advances the deal `financial_spreading -> risk_grading`. Editing a spread
line item records a `human_override` citation (no document/location id, an
explicit "human-edited override" source reference) so the traceability chain
never silently loses its "who changed this and to what" trail; a hand-keyed
override is bounded and must be finite (`Infinity`/`NaN` and out-of-range
magnitudes are refused before storage) and — like a rejection — **requires a
written reason**, because replacing a cited figure with a typed one is what
makes the record differ from the documents. The `spread.persisted` audit row
names the figures that became deal-of-record, which of them a human keyed,
and which lines stayed unsupported — not just a count. Every agent
run still records model id, prompt version, inputs, raw output, latency and
token cost on `agent_runs`, exactly like triage.

The `persist_spread_line_items` workflow node handler is registered so the
`deal-underwriting` definition's own march through that node is idempotent —
it confirms the same rows the HTTP accept path already wrote rather than
double-inserting, whichever path reaches it first. Past that node the run
reaches `compute_ratios`, whose handler the ratios-and-grade slice registers;
until then the run stops there and the deal-of-record data written by the
accept path is unaffected.

Borrower documents are native text (GAP-056), so the Deal Intake screen's
Documents panel now also accepts a **pasted statement** beside the file
dropzone — the same staged document an upload produces, extracted into the
same citable locations the spreading agent reads. `spread_line_items` and
`citations` join the guarded-table list, so the scaffold's `/api/{table}`
catch-all can never forge a figure around citation validation, human
acceptance and the audit row.

Hardening applied after review: deal-scoped draft reads
(`GET /deals/{ref}/drafts`) are now deny-by-default and row-scoped exactly like
the cross-deal queue, and resolved document text (`evidence`) is attached only
on routes that have already resolved a known, role-checked actor — naming a
deal reference no longer walks around the queue's role gate. Re-accepting a
spread after a rejection supersedes the previous generation of
`spread_line_items` / `citations` (append-only: nothing is deleted, the old
rows are stamped and an `spread.superseded` audit row is written) so exactly
one spread stands as deal of record for slice 3's DSCR. And a workflow node
whose handler ships in a later slice now BLOCKS its run (still running, parked
on that node, `blocked_on` reported) instead of failing it — a failed run can
never be resumed, so the `deal-underwriting` run stays alive from spread
acceptance through to the slice that registers `compute_financial_ratios`.

- Screens delivered: `screen-review` (serves triage drafts from slice 1 too —
  that screen keeps working, now through the same generic queue); the intake
  and pipeline screens from slice 1 are unchanged apart from the additive
  paste-a-document control
- Endpoints: `POST /deals/{ref}/spread`, `GET /drafts`, `GET /drafts/{id}`
- Workflow handlers registered: `persist_spread_line_items`
- Addresses: REQ-005, 016, 020, 024, 030..032, 037..039, 046, 056
- Agent-run telemetry now records `tokens_in` / `tokens_out` alongside cost, so
  the design's Tokens column and "Tokens in/out" telemetry cell on
  `screen-review` show real numbers rather than being dropped from the shell.
- Post-review hardening (second pass):
  - **`NaN` can no longer become money.** `json.loads` parses a bare `NaN`
    literal into a float and *every* comparison against `NaN` is false, so the
    "is this the number the cited text actually says" check silently PASSED
    it. An agent figure now clears the same finite + bounded gate a
    human-keyed override always did.
  - **A figure binds only to the template line its label states.** A prefix
    test alone spread `Total Debt Service: 905,000` as `total_debt`; the label
    must now run straight into its number. And `_extract_amount` no longer
    takes the first number blindly — `Revenue 2024: 4,200,000` used to ground
    revenue to `2024`, a deterministic, cited, wrong figure on the record.
  - **Generic READS of the deal of record are deny-by-default.** Sealing only
    the write side of `/api/{table}` left the whole draft gate walkable from
    the other direction: `GET /api/agent_drafts` returned `draft_content` —
    every borrower's spread and citations — and `/export/{table}.csv` was the
    same rows by another door. Both now demand the named, active internal seat
    the guarded endpoints do (slice 1's scrubbing contract kept, its test
    tightened to match).
  - **A rejection no longer kills the deal's workflow run.** Failing the run
    on a rejected human node made the approved definition's own re-draft loops
    (`triage_accepted.on_false`, `spread_accepted.on_false`) unreachable and
    left a dead run that could only re-serve its stale reply, so a rejected
    spread was re-drafted byte-identical. A rejection is now a review outcome:
    the condition node routes back to the drafting node and the reviewer gets
    a fresh draft. The backward jump is a real rewind — resolving `on_false`
    by scanning forward would have marked `persist_spread`, `compute_ratios`
    and grading "skipped" and completed the run: a fully underwritten deal
    that underwrote nothing.
  - **`screen-review`'s advertised shortcuts work.** K/J walk the queue and
    A/E/R disposition, matching the labels the design prints on those buttons;
    the workspace also opens the newest draft awaiting acceptance instead of
    landing with empty panels until someone guesses to click a row.
  - Export columns restored on `spread_line_items`, `agent_drafts` and
    `agent_runs` (a column missing from `models.TABLES` is a column missing
    from the examiner's CSV), and the `persist_spread` node reports only the
    citations belonging to that spread, not every citation on the deal.
- Second review round closed these too:
  - The new read guard **failed open** — any import error in the entitlement
    check silently reopened the deal of record *and* skipped the refusal
    audit, so nothing would record that the control was off. It fails closed.
  - The generic reader is limited to the seats entitled to the whole book: it
    returns whole tables and cannot apply the row scoping `/deals` and
    `/drafts` apply, so a row-scoped relationship manager reads through the
    endpoints that scope them, not around them.
  - Governing `/export/*.csv` initially broke it — the guard's JSON scrub
    turned the examiner's CSV into `{"detail": "unreadable"}`. Non-JSON
    responses now pass through (the exporter drops credential and
    document-content columns at the source), and `deals` regained
    `deal_reference` so the exports can actually be joined.
  - `/intake/config` no longer hands the **staff roster** to anonymous
    callers: that directory is what turns "callers name themselves" into a
    one-request attack. The vocabulary the UI binds to stays public and the
    console now names its seat when fetching it.
  - `POST /workflows/{name}/start` and `/runs/{id}/tick` require a named
    actor and write an audit row. These are **mutations** — start reaches
    `create_deal_at_intake` with caller-supplied inputs — so the
    "un-identified reads still answer" contract never covered them.
  - Un-identified deal reads get the **board columns**, not the borrower
    file. Slice 1's acceptance fixes which *deals* come back, never which
    *columns*, so `borrower_address`, `borrower_tin_masked`, `purpose`,
    `collateral_description`, `submission_fingerprint` and the document
    inventory now need a named seat, while `GET /deals` still returns every
    deal with its stage exactly as slice 1 requires.
  - `GET /pipeline` was the third door onto the same rows — projecting
    `/deals` and `/deals/{ref}` but not the board would only have moved the
    disclosure. It projects too (every column the board renders is a public
    field, so the UI is untouched); `totals.live_exposure` deliberately stays,
    since `exposure_amount` is a public per-deal column and the aggregate is
    derivable anyway.
  - The CSV and JSON export doors now enforce **one** policy: the column
    allowlist filters only at the top level while the JSON reader recurses, so
    the moment a later slice nests source text inside `draft_content` or a
    memo citation, the CSV would have kept what the JSON stripped — silently,
    with no test failing. `ext_export` scrubs each row at the source now.
- **ACCEPTED RISK — open, needs a named owner (raised in slice 2, 2026-07-31).**
  Identity is caller-asserted: `acting_user` is taken on trust and
  `POST /auth/login` mints a bearer token for any username with no
  credential. The consequence is not an over-broad read — it is that an
  anonymous caller can accept a financial spread as `an.chen`, promote
  LLM-derived figures to the deal of record, pass the segregation-of-duties
  check, and **the audit trail will name `an.chen` and be wrong**. A
  forged-but-plausible audit trail is a different class of risk from a leak,
  and a regulated app needs a named risk owner and a review date against it —
  this entry is deliberately not a closed item.
  A fix that keeps both approved contracts intact exists and was NOT taken at
  slice level: require a credential and assert `acting_user` matches it,
  behind a deployment-mode flag (permissive in dev/test so the acceptance
  contract and the suite stay green, strict when deployed). Inventing that
  posture here would have shipped an unexercised strict branch that looks like
  a control, so it belongs to the auth/design owner, not to slice 2.
  *Owner: UNASSIGNED — assign at the next design review.*
- Note on identity: the slice plan fixes the actor model — HTTP callers name
  themselves with `submitted_by` / `acting_user` and the UI uses the signed-in
  identity — so a caller-asserted name is the approved contract here, not an
  oversight; `GET /deals` answering unauthenticated is likewise slice 1's
  acceptance contract. Everything above hardens what sits *behind* that model.
- Final hardening: the un-identified deal read (`GET /deals/{ref}` with no
  resolved actor) no longer carries the preflight *portfolio* facts —
  `existing_relationship`, `aggregate_exposure` and `duplicate_request` report
  what else this borrower already has with the bank, so they now ride the same
  entitlement gate as the drafted figures and the resolved evidence. The
  request-derived screens (`prohibited_industry`, `requested_ltv`,
  `approval_tier`) still answer, so slice 1's open deal-record contract holds.
