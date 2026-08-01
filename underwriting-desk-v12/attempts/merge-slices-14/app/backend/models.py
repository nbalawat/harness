"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    "users": ["id", "email", "name", "role", "is_active", "created_at", "updated_at"],
    "deals": ["id", "borrower_name", "borrower_industry", "borrower_entity_id", "requested_amount", "exposure_amount", "current_stage", "current_status", "created_by_user_id", "assigned_to_user_id", "risk_grade", "decline_reason_code", "decline_reason_detail", "last_activity_timestamp", "created_at", "updated_at"],
    "documents": ["id", "deal_id", "document_type", "file_name", "file_size", "checksum", "storage_path", "uploaded_by_user_id", "uploaded_at", "created_at"],
    "financial_spread_template": ["id", "deal_id", "template_version", "line_item_key", "period", "value", "unit", "created_at"],
    "citations": ["id", "source_type", "source_id", "document_id", "page_number", "section", "cell_locator", "quoted_text", "created_at"],
    "financial_ratios": ["id", "deal_id", "ratio_type", "numerator", "denominator", "result", "rounding_method", "divide_by_zero_handling", "computed_at", "created_at"],
    "risk_grades": ["id", "deal_id", "grade", "rubric_version", "band_hit", "reasoning", "computed_at", "created_at"],
    "lending_policy": ["id", "version", "rule_type", "rule_key", "rule_value", "is_active", "created_at", "updated_at"],
    "policy_exceptions": ["id", "deal_id", "policy_rule_id", "rule_reference", "violation_detail", "rationale", "status", "raised_by_user_id", "resolved_by_user_id", "resolved_at", "created_at"],
    "agent_outputs": ["id", "deal_id", "agent_id", "stage", "model", "prompt_version", "input_data", "output_content", "token_usage", "latency_ms", "outcome", "generated_at", "created_at"],
    "human_reviews": ["id", "agent_output_id", "deal_id", "reviewed_by_user_id", "action", "original_content", "edited_content", "rejection_reason", "reviewed_at", "created_at"],
    "approvals": ["id", "deal_id", "stage", "approval_authority_level", "exposure_amount", "approved_by_user_id", "decision", "decision_notes", "decided_at", "created_at"],
    "deal_returns": ["id", "deal_id", "returned_from_stage", "returned_to_stage", "returned_by_user_id", "reason", "reassigned_to_user_id", "created_at"],
    "queue_assignments": ["id", "deal_id", "queue_name", "assigned_to_user_id", "claimed_by_user_id", "claimed_at", "status", "created_at", "updated_at"],
    "audit_log": ["id", "deal_id", "actor_user_id", "action", "resource_type", "resource_id", "before_payload", "after_payload", "timestamp", "created_at"],
    "business_calendar": ["id", "calendar_date", "is_business_day", "holiday_name", "created_at"],
    "portfolio_qa_sessions": ["id", "user_id", "question", "grounded_response", "source_deal_ids", "trace_data", "created_at"],
    "intake_triage_decisions": ["id", "deal_id", "classification", "missing_documents", "confidence_score", "created_at"],
    "adverse_action_reasons": ["id", "reason_code", "reason_label", "is_active", "created_at"],
}
