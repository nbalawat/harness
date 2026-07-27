# Support Copilot — slices

## Slice 1: Grounded draft reply in the chat thread
Walking-skeleton chat, now grounded: `POST /chat` accepts an optional `conversation_id` (a bare
`{"message": ...}` still works, minting a new `conv-<id>` when none is given) and every reply routes
through `agent_runtime.respond_with_citations()`, which searches the product documents loaded from the
local documents folder at startup (`agents/corpus_index.json`, seeded verbatim from the ingested
discovery brief, current-support-process doc, and problem statement — REQ-017) before composing an
answer, so retrieval always runs before generation (REQ-003). Every reply is prefixed with "Automated
draft — pending analyst approval." (REQ-007/REQ-008), covered questions are answered only from the
matched document(s) and end with a `Sources:` line naming the `doc-` ids used, uncovered questions get a
plain "not covered by our product knowledge base" hand-off to the analyst instead of a guess, credential
requests ("API key", "password", etc.) are refused ("cannot share ... credentials"), claims that the
assistant will send/deliver anything are refused (delivery stays a manual analyst copy), off-topic
requests are declined, and the assistant states plainly that it only answers from the loaded documents
even when told to ignore them and use general knowledge. New `GET /corpus` exposes the loaded document
list (id + title) plus a REQ-017 note, so an analyst can see what the assistant is grounded in.
`POST /chat` now persists a `messages` row per turn (conversation_id, sequence, analyst_question,
assistant_draft, created_at) and a `citations` row per source used (message_id, source_title,
source_passage, source_url) via `db.store` — the same tables slice 2's approvals and slice 3's history
screens build on — and returns `{reply, conversation_id, message_id, citations}`. `frontend/app.js` keeps
the conversation_id across turns in the composer (extending the existing chat-shell behavior, not
replacing it) and renders each turn's citations into the design's existing `#citations` apparatus panel
using `textContent` only. Replaced the scaffold placeholder `agents/evals/cases.json` with cases matching
the roster's `Reply Drafting Assistant` eval_criteria, adapted to probe the real ingested corpus content
rather than invented documents.
