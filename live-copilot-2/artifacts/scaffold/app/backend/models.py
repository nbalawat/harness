"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    "conversations": ["id", "created_at", "updated_at", "subject"],
    "messages": ["id", "conversation_id", "sequence", "role", "analyst_question", "assistant_draft", "created_at"],
    "approvals": ["id", "message_id", "decision", "analyst_id", "edited_draft", "was_edited", "approved_at"],
    "citations": ["id", "message_id", "source_title", "source_passage", "source_url"],
}
