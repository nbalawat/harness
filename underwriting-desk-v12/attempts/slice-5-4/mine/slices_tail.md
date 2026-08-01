## Slice 5 — Grounded, permission-scoped portfolio Q&A desk (`grounded-portfolio-qa`)

A credit officer asks the portfolio desk a question in plain English (`POST
/api/qa/ask`) and gets back an answer drawn only from the deal records the
asking user's role is entitled to see. Retrieval scope is resolved
server-side from the caller's role before the Portfolio Q&A Agent ever sees a
row (`resolve_qa_permission_scope`, guarded by `identity.require_actor` with
the `portfolio.query` permission, so an unknown caller reads nothing):
relationship managers see only the deals they filed or hold, analysts and
officers see the active book. A deterministic router
(`_select_records`) narrows further to the deals that actually bear on the
question — no accepted spread, open policy exceptions, a named borrower, or
any of the eight pipeline stages in plain English ("which deals await tiered
approval") — reading each deal only through the roster's declared read tools
(`read_deal`, `read_spread`, `read_ratios`, `read_risk_grade`,
`read_policy_exceptions`, `search_deals_in_scope`, …) enforced through
`tools.invoke()`, so the agent's allow/deny list is structural rather than
documentation. The agent's narrative
(`agent_runtime.respond(..., agent_name="Portfolio Q&A Agent")`) is wrapped
through the citation-tracker module (`citations.attach`/`render`) so every
answer prints the deal ids it actually read; `verify_answer_grounding` then
mechanically checks that every cited id came from the resolved scope before
anything is trusted. Identity questions ("who are you") and any attempt to
get the agent to approve/decline/advance a deal are refused deterministically
before retrieval ever runs. Every exchange — question, grounded answer,
source deal ids, and the full scope/retrieve/groundcheck trace — is recorded
to the immutable `portfolio_qa_sessions` table (`GET /api/qa/sessions`) for
audit, implementing all four deterministic nodes of the `portfolio-qa`
workflow (`workflows/workflows.json`). Backend: new
`ext_grounded_portfolio_qa.py`. Frontend: the Portfolio Desk screen
(`screen-chat`) — previously wired to the scaffold's generic,
design-mismatched `/chat` endpoint — now submits through `/api/qa/ask` and
renders real answers and their deal-id sources in the design's own manuscript
markup (`from-user`/`from-agent`, `msg-sources`); the "Standing Questions"
shortcuts in the marginalia ask the same way, and the "Book at a Glance"
tallies read live from `GET /api/qa/book-summary`.

**Revision (slice 5) — the desk is now wired to live deal data.** The agent
previously refused portfolio questions such as "which deals await tiered
approval" because the records it was handed were not presented as its
knowledge, so it fell back on "not covered — hand off to a human". Fixed:
`retrieve_grounded_deal_context` now builds the agent's context at question
time from the STORED deal records — stage, status, requested and exposure
amounts, risk grade, whether a spread has been accepted, open policy
exceptions and their rule references, computed ratios, owner and idle days —
for exactly the deals the asker's role may see, and hands that record set to
`agent_runtime.respond()` as the question's provided knowledge together with
system-computed totals. Every figure the desk quotes is computed in
deterministic code (`_portfolio_facts`); no arithmetic is delegated to the
model. Safety is unchanged and enforced in code: answers stay framed as an
automated draft pending analyst approval, decision requests are still
refused, an asker with nothing in scope is still told there is nothing to
ground an answer in rather than being given invented figures, and a model
reply that ignores the records it was given is replaced by the deterministic
digest of those records (the raw reply is kept in the session trace for
audit). New `GET /api/qa/book-summary` serves the desk's tallies from the
same permission-scoped records. Every recorded acceptance check passes
exactly as written; `frontend/app.js` changes remain a pure append.
