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

## Slice 2: Conversation history behind analyst sign-in
`POST /chat` now accepts an optional `conversation_id` and `analyst_id` alongside `message` (a bare
`{"message": ...}` still works and still returns `reply`). Every exchange is written through `db.store` into the
`conversations` and `messages` tables from the approved data model: a client-supplied `conversation_id` is
stable — the conversation row is created once and reused on subsequent turns — and each turn appends a `user`
message and an `assistant` message row (role, content, created_at). Reads of stored history live outside
`/api/` so the `/api/{table}` catch-all never shadows them: `GET /conversations` lists every stored conversation
and `GET /conversations/{conversation_id}` returns it message by message. Both require a signed-in local
analyst account passed as `?token=`; a seeded account (`token=analyst1` → `analyst-1`) is checked in
`ANALYST_TOKENS`, and a missing/invalid token gets a 401 asking the caller to sign in with an analyst account
rather than any stored data. Retention is indefinite — there is no purge, so history always returns everything
ever stored. The frontend chat-shell gained a History tab (still `textContent`-only, styled with the existing
`tokens.css` variables): sign in with a token, browse the conversation list, and open one to read its messages;
the Chat tab now sends a stable per-tab `conversation_id` on every turn so a session's exchanges land in one
conversation. `backend/tests/test_app.py::test_table_crud` was hardened to use `row.get("user")` instead of
`row["user"]` since the shared `conversations` table now also receives rows from `POST /chat` that have no
`user` key — the assertion's guarantee (a `user: "u1"` row exists) is unchanged.
