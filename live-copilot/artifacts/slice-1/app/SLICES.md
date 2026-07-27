# Support Copilot — slices

## Slice 1: Grounded draft chat
Walking-skeleton chat: chat-shell UI → `POST /chat` → `agent_runtime.respond()` → reply rendered in the thread.
Seeds `agents/corpus_index.json` with a small embedded product-knowledge corpus (password reset, account
security, billing email, getting-started docs, all with `doc-` ids). `support_draft_agent` (from
`agents/roster.json`) now grounds every answer in that corpus via keyword search, always prefixes replies with
"Automated draft — pending analyst approval.", cites the `doc-` ids it used after a `Sources:` line, states
plainly ("not covered by our product knowledge base") and hands off to the analyst when the corpus doesn't
cover the question, refuses to disclose credentials/API keys, refuses to claim it can send/deliver anything
(delivery stays a manual analyst copy), stays in scope for product questions only, and refuses to fall back to
its own general knowledge even when told to ignore the documents. This persona is shared by every
`agent_runtime` mode (stub/live-api/live-cli); `HARNESS_AGENT_MODE=stub` drives tests, acceptance and evals.
Replaced the scaffold placeholder `agents/evals/cases.json` with the roster's `support_draft_agent` eval_cases.
`POST /chat` still accepts a bare `{"message": ...}` and still returns a `reply` key.
