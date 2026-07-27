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

## Slice 3: Persisted conversation records with history list and open
Two read-only endpoints turn the `conversations`/`messages`/`citations`/`approvals` rows that slices 1–2
already `db.store.insert()` into a reviewable file (REQ-004, REQ-005). `GET /conversations` lists every
conversation ever started, newest first — each row's `conversation_id` and `created_at` (plus
`updated_at`/`subject`) come straight from `store.list("conversations")`, so nothing here is purged
automatically; a conversation is retained until someone deletes it by hand at the persistence layer
(REQ-014) — this stays a single flat list sized for one team on one local instance (REQ-016), with no
per-analyst login gating it (REQ-019 leaves that unspecified for v1). `GET /conversations/{conversation_id}`
404s on an unknown id and otherwise returns the full record: the conversation row plus every `messages`
row for that thread (each carrying its `analyst_question`/`assistant_draft` and, nested, the `citations`
rows filed against it) plus the thread's most recent `approvals` row (`decision`, `analyst_id`,
`was_edited`, `approved_at`) if one exists — so a quality reviewer can see the question, the draft, what
it was grounded in, and who approved or rejected it and when, all from one lookup. `GET /api/messages`
and `GET /api/citations` (the existing generic `/api/{table}` endpoint, unchanged) already expose the raw
tables for anyone who needs them directly. `frontend/app.js` replaces the placeholder history fetch with a
real one: it populates the design's existing `#history-list` with one entry per conversation (id + created
timestamp + subject) via `GET /conversations`, and clicking an entry lazily opens an inline
`.history-detail` panel (new CSS added to index.html's own `<style>` block, reusing `var(--rule)` etc. —
no shell markup touched) that fetches `GET /conversations/{id}` and renders each turn's question, draft,
and cited sources plus the approval line ("Approved by … at …" / "Rejected by … at …" / "Awaiting analyst
decision."); the list refreshes after every chat turn and every approval decision so the file stays
current within a session.

## Slice 4: Search past approved conversations and reuse an answer
New `GET /history/search?q=...` (registered outside `/api/`, alongside `/approvals`, so it is never
shadowed by the `/api/{table}` catch-all) reads only through `db.store` — no hand-rolled storage. It
walks every conversation, keeps only the ones whose latest `approvals` row is a `decision == "approve"`
(REQ-006, REQ-009: a pending or rejected draft is never offered as precedent), and keyword-matches the
query (case-insensitively) against that conversation's subject, every turn's `analyst_question` and
`assistant_draft`, and its citations' `source_title`. Each match reports `conversation_id`, `analyst_id`,
`approved_at`, and `was_edited` straight off the approval row (REQ-011, REQ-013) so an analyst can judge
provenance before reuse; when nothing matches — because no approved conversation mentions the term at all,
or the only mention lives in a still-pending conversation — the response carries a plain "no matching
prior conversation" note instead of inventing one. New `POST /history/reuse` takes
`{source_conversation_id, conversation_id}`: it 409s with "only approved conversations can be reused as a
precedent" unless the source conversation's latest approval is an actual approval (mirroring
`/conversations/{id}/approved-reply`'s gate), otherwise it takes the analyst-approved wording (edited
version if there was one) and inserts it as a new `messages` row in the target conversation — prefixed
with the standing "Automated draft — pending analyst approval." disclosure plus a sentence naming the
source conversation and asking the analyst to "verify it is still accurate" before approving again — and
copies the source turn's `citations` rows onto the new message, so the reused draft still shows its
`Sources:` and still has to clear the approval gate itself; nothing is ever auto-approved just because it
was reused before. `frontend/app.js` wires the design's existing `#history-search` input and its
`Reuse`-labelled button (screen-history) to `GET /history/search`, rendering each match as a
`.search-result` card (new CSS added to index.html's own `<style>` block only, no shell markup touched)
with a "Reuse as starting draft" button; clicking it calls `POST /history/reuse` against the active chat
thread (minting one if none is open yet), switches to the Conversation screen, and drops the reused draft
into the existing `#messages`/citations/`#review-queue` machinery from slice 1–2 exactly like a normal
`/chat` turn, so it goes through the same approve/amend/reject gate rather than skipping it.
