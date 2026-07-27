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

## Slice 2: Analyst approval gate before a reply can leave the app
`POST /approvals` (registered outside `/api/` so it can never be shadowed by the `/api/{table}`
catch-all) is the only way a drafted reply gets a decision: given `{conversation_id, decision,
analyst_id, edited_draft?}` it resolves the conversation's most recent drafted turn, then
`db.store.insert()`s an `approvals` row recording `conversation_id`, `message_id`, `decision`
("approve"/"reject"), `analyst_id`, `edited_draft`, `was_edited` (true iff an edit was supplied —
REQ-013), and `approved_at` — no agent ever calls this path itself (the roster explicitly denies
`mark_approved`/`mark_rejected` tools), so approval is always a human decision (REQ-009, REQ-012).
New `GET /conversations/{conversation_id}/approved-reply` is the only place the approved text can be
read back out: it 404s on an unknown conversation, 409s ("not approved") when the latest decision for
that conversation is missing or is a rejection — so a rejected or still-pending draft can never leave
the app — and on an approval returns the analyst's edited wording if one was given (else the original
draft), plus `analyst_id`, `decision`, `was_edited`, and `approved_at`, so a later approval or rejection
always supersedes an earlier one for the same thread (REQ-018). `GET /api/approvals` (the existing
generic table endpoint, unchanged) already exposes the full approvals log for the audit trail.
`frontend/app.js` extends the existing chat-shell (no shell markup removed) so every drafted turn from
`POST /chat` is pushed into the design's `#review-queue` as a selectable `.draft-card`; the design's
existing `#approve-btn` / `#edit-btn` / `#reject-btn` decision bar now acts on whichever draft is
selected — Approve and Reject prompt once for an `analyst_id` (remembered in `localStorage` for the
session) and call `POST /approvals`, and "Amend & approve" first prompts for edited wording, then
approves with `edited_draft` set — after which the card shows who decided, when, whether it was edited,
and (once approved) a "Copy approved reply" button that reads `GET
.../approved-reply` and copies the analyst-approved text, never the raw draft, to the clipboard.
