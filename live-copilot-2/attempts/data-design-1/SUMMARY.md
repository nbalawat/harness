# Data Model Design Summary

## Deliverable: `data_model.json`

The data model defines 4 tables that capture the core entities for a support-team assistant application:

### Tables

| Table | Purpose | Requirements |
|-------|---------|--------------|
| **conversations** | Thread-level grouping for analyst-assistant interactions | REQ-004, REQ-006 |
| **messages** | Individual turns in a conversation: analyst question + assistant draft | REQ-002, REQ-004, REQ-005 |
| **approvals** | Analyst decisions: approve/edit/reject with audit trail | REQ-009, REQ-012, REQ-013 |
| **citations** | Source passages that grounded each assistant draft | REQ-011 |

### Key Design Principles

1. **Immutable Draft Record**: Once a message is created, the `analyst_question` and `assistant_draft` are never modified. Analyst edits are stored separately in `approvals.edited_draft`, preserving a clear audit trail.

2. **Approval as Gate**: The `approvals` table enforces that no unapproved draft can leave the application. The presence/absence of an approval record determines whether a message is "ready to send."

3. **Multiple Citations**: A single message can have many citations (1:N), supporting answers synthesized from multiple knowledge sources.

4. **Optional Analyst ID**: The `analyst_id` field in `approvals` is nullable, supporting both authenticated (per-analyst audit trail) and unauthenticated (single-team, trust-based) deployments.

5. **Minimal Scope**: The model focuses on data that must be **stored and persisted**. It does not model:
   - The knowledge corpus ingestion mechanism (REQ-017 is unspecified)
   - External delivery mechanisms (REQ-018 is unspecified)
   - Retention policies (REQ-014 is governance, not structure)
   - Process workflows (REQ-001, REQ-008 are logic, not data)

### Requirement Coverage

| ID | Requirement | Addressed By |
|----|----|---|
| REQ-002 | Chat interface with turn-by-turn history | `messages` + `conversations` |
| REQ-004 | Conversation history persisted and reviewable | `conversations` + `messages` |
| REQ-005 | Capture question, draft, approval, timestamps | `messages` + `approvals` |
| REQ-006 | List, search, reopen past conversations | `conversations.subject`, `updated_at` |
| REQ-009 | Explicit approval required | `approvals` table enforces this |
| REQ-011 | Answers cite sources, citations stored | `citations` table |
| REQ-012 | Support approve-as-is, edit-then-approve, reject | `approvals.decision`, `was_edited` |
| REQ-013 | Approval audit trail | `approvals` (`analyst_id`, `approved_at`, `was_edited`) |

### Data Flow Example

```
1. Analyst asks a question
   → INSERT into messages (analyst_question, assistant_draft, created_at)

2. Assistant generates a draft
   → UPDATE messages.assistant_draft
   → INSERT into citations (source_passage, source_url) [1:N]

3. Analyst reviews and edits
   → No changes to messages (immutable)

4. Analyst approves
   → INSERT into approvals (decision='approved', edited_draft, was_edited, approved_at, analyst_id)

5. System checks before sending
   → Query: IF EXISTS (SELECT * FROM approvals WHERE message_id=X AND decision='approved')
           THEN send approved text
           ELSE error("unapproved")
```

### Validation Status

✓ Conforms to `schemas/data_model.schema.json`
✓ All tables have unique names and columns (snake_case)
✓ All tables have required keys: `name`, `columns`, `addresses`
✓ All columns have required keys: `name`, `type`
✓ Referential integrity via foreign keys
✓ Traces 8 stated requirements (REQ-002, REQ-004–006, REQ-009, REQ-011–013)

---

**Generated:** 2026-07-27  
**Status:** Ready for implementation (persistence-core will generate models.TABLES)
