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

## Slice 3: Draft approval gate
Every assistant reply from `POST /chat` is now also written through `db.store` as a `drafts` row (the `drafts`
table from the approved data model: `message_id`, `conversation_id`, `content`, `sources` — the `doc-` ids
parsed out of the reply's `Sources:` line — `approval_state` starting `"pending"`, `approved_by`, `approved_at`,
`created_at`), and `POST /chat`'s response now also carries that `draft` object so the caller immediately sees
its `"pending"` state. Nothing counts as sent until an analyst acts on it: `GET /drafts?conversation_id=...`
(same seeded-analyst `?token=` gate as history) lists a conversation's drafts, and the new `POST /approvals`
records the decision on that same drafts row — `approval_state` (`approved`/`rejected`), `approved_by`, and
`approved_at` — optionally replacing the content with the analyst's edited text on approve, and its response
always reminds the analyst that delivery is still a manual copy into the existing ticketing tool (the agent
holds no send tool). `POST /approvals` requires the same seeded local-analyst session (token from the request
body or a `?token=` query param) and returns 401 without one. Both new endpoints live outside `/api/` so the
`/api/{table}` catch-all never shadows them. `persistence-core`'s `Store` gained an `update(table, row_id,
**changes)` method (alongside `insert`/`list`) so an approval decision mutates the existing drafts row in place
rather than appending a duplicate — the same in-place-update contract a future Postgres adapter would need to
honor. The frontend chat thread now renders each assistant message with an editable draft textarea plus
Approve/Reject buttons (still `textContent`-only); a shared analyst-token field (in the Chat header, reused by
the History tab's sign-in form) gates those actions the same way it gates history — approving or rejecting
without a token surfaces the sign-in prompt inline instead of calling `/approvals` unauthenticated.

## Slice 4: History keyword search and filter
`GET /conversations` gains two optional query params, both still gated by the same seeded-analyst `?token=`
session as every other history read (401 with no valid token, same as before): `q` does a case-insensitive
AND-of-terms keyword search across each conversation's `topic` plus every `messages` and `drafts` row content for
that conversation — the full retained history (REQ-022), not a rolling window — and `state` filters on the
conversation's latest draft `approval_state` (`pending`/`approved`/`rejected`). Neither filter is stored data:
each conversation row returned by `GET /conversations` is now enriched at read time with its latest draft's
`approval_state` (`null` if it has no draft yet) so the History screen can display and filter on it without
duplicating anything into the `conversations` table. When `q` and/or `state` are supplied and nothing matches,
the endpoint still returns `200` with an empty `conversations` list plus a plain `"No matching prior
conversation found for this search."` message instead of a silent empty array; with no filters the response is
unchanged from Slice 2 (no `message` key). The frontend History screen gained a keyword box and an approval-state
dropdown above the conversation list (still `textContent`-only) that re-run `GET /conversations` with `q`/`state`
on submit; each list item now also shows its draft approval state, and a no-match search renders the server's
message inline instead of an empty list.

## Slice 5: Precedent lookup and reuse
`agents/roster.json`'s second agent, `precedent_finder`, is now wired into `agent_runtime.respond()`: distinctive
precedent-lookup phrasing in a message (e.g. "past answer", "precedent", "logging in", "every conversation",
"hasn't been approved", "without checking") routes to its own persona/stub instead of `support_draft_agent`'s,
and its 7 `eval_cases` from the roster are appended to `agents/evals/cases.json` (14 total, all green via
`agents/run_evals.py`) — covering provenance on a match, "no matching prior conversation" when nothing matches,
the sign-in requirement, indefinite retention, the pre-reuse reverification reminder, the no-delivery-tool
guardrail, and that only approved conversations are ever surfaced. The actual precedent feature is structured
retrieval over real stored data, so — like `/conversations` and `/drafts` before it — it's implemented directly
against `db.store` rather than through `respond()`: `POST /precedents/search` (body `{"q": ..., "token": ...}`,
same seeded-analyst gate and 401 as every other history/draft read) searches every `approved` draft's content,
sources, and conversation topic for the full retained history and returns each match's `conversation_id`,
`content`, `sources`, `approved_by`, and `approved_at`, or `{"precedents": [], "message": "No matching prior
conversation found for this search."}` when nothing matches; pending and rejected drafts are never surfaced.
`POST /drafts/reuse` (body `{"conversation_id", "source_conversation_id", "token"}`) copies a source
conversation's latest *approved* draft's content and sources into a brand-new `drafts` row on the target
conversation — always `approval_state: "pending"`, never auto-approved — recording `source_conversation_id` for
provenance, alongside a system message reminding the analyst to verify it is still accurate; `GET
/drafts?conversation_id=...` (unchanged endpoint) then shows that provenance and pending state like any other
draft. Both new endpoints live outside `/api/` so the `/api/{table}` catch-all never shadows them. The History
screen gained a "Find a precedent" panel below the conversation detail (still `textContent`-only): a keyword
search box lists matching approved answers with their source conversation, approving analyst, and approval date,
each with a "Reuse in current conversation" button that calls `/drafts/reuse` against the Chat tab's active
`conversationId`, then switches to the Chat tab and renders the new pending draft with the same approve/edit/
reject controls as any other assistant reply.
