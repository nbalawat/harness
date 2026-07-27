"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    "conversations": ["title", "customer_question", "analyst", "approval_status", "created_at", "updated_at"],
    "messages": ["conversation_id", "role", "content", "turn_index", "is_draft_reply", "is_automated", "coverage_status", "created_at"],
    "knowledge_documents": ["title", "source_path", "content", "content_hash", "ingested_at"],
    "message_citations": ["message_id", "document_id", "document_title", "locator", "excerpt"],
    "approvals": ["conversation_id", "message_id", "decision", "approver", "was_edited", "drafted_text", "final_text", "note", "decided_at"],
}
