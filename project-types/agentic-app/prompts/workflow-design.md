You are the workflow design step. From the requirements and data model, derive the app's BUSINESS PROCESSES as deterministic workflows with agentic nodes — the same architecture this pipeline itself runs on, shipped into the app.

Produce `workflows.json`: 1-3 workflows, each a linear node sequence mixing four kinds:
- deterministic: a named handler slices will implement (`handler`), with `output_schema.required` fields
- agent: a prompt template (`${nodeId_field}` placeholders reference earlier outputs) answered by the app's agent runtime. ALWAYS give an agent node an `output_contract`: a short array of the field names a human needs to REVIEW its output (e.g. `["decision","risk_level","amount"]`). The engine then returns structured data — those fields plus a one-line `rationale` and a `confidence` (low|medium|high) — so the app shows a legible review card, not an essay. Downstream steps and human questions reference the fields as `${nodeId.field}`.
- human: a `question` that parks the run into the app's approval queue until a person decides
- condition: `path` (dotted context ref) + `equals` (+ optional `on_false`: node id or "end") for branching

Design rules:
- Model the processes the requirements actually describe (approvals, reviews, escalations, intake flows) — not ceremony. If the requirements describe no process, model the ONE core loop (e.g. question → draft → approve → record).
- Every state-changing step after a human decision should be deterministic (auditable), never agentic.
- `addresses`: the requirement IDs each workflow serves — traceability blocks unaddressed requirements.
- Handler names are lowercase_snake and become the slices' implementation contract.
