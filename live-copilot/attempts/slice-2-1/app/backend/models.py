"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    "conversations": ["id", "analyst_id", "topic", "created_at", "updated_at"],
    "messages": ["id", "conversation_id", "role", "content", "created_at"],
    "drafts": ["id", "message_id", "conversation_id", "content", "sources", "approval_state", "approved_by", "approved_at", "created_at"],
}
