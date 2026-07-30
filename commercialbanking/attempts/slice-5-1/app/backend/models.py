"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    # Generic chat-shell/seed-data table (used by ext_seed.py and the frontend's
    # history panel) — missing from the generated approved data model; restored
    # here so the scaffold's own baseline test (test_app.py::test_table_crud)
    # and seed-data module have somewhere to write.
    "conversations": ["id", "user", "created_at"],
    "deals": ["id", "borrower_name", "industry", "requested_amount", "collateral_description", "ltv_percentage", "current_stage", "assigned_owner_id", "created_at", "last_activity_at", "status"],
    "source_artifacts": ["id", "deal_id", "artifact_type", "file_name", "file_path", "content_type", "uploaded_at", "uploaded_by_id"],
    "triage_outputs": ["id", "deal_id", "request_type", "product_type", "underwriting_suitable", "missing_documents", "recommended_queue", "draft_status", "created_at", "accepted_at", "accepted_by_id"],
    "analyst_queues": ["id", "queue_name", "analyst_id", "created_at"],
    "spread_line_items": ["id", "deal_id", "line_item_key", "line_item_label", "extracted_value", "accepted_value", "source_document_id", "source_location", "raw_extracted_text", "created_at", "accepted_at", "accepted_by_id"],
    "credit_ratios": ["id", "deal_id", "ratio_type", "computed_value", "formula", "inputs", "computed_at"],
    "risk_grades": ["id", "deal_id", "grade", "rubric_rule_applied", "inputs", "computed_at"],
    "credit_memo_drafts": ["id", "deal_id", "content", "cited_ratios", "cited_spread_items", "cited_policy_rules", "draft_status", "created_at", "accepted_at", "accepted_by_id", "generated_by_agent_id"],
    "policy_rules": ["id", "rule_type", "rule_name", "description", "rule_definition", "version", "effective_date", "created_at"],
    "policy_exceptions": ["id", "deal_id", "policy_rule_id", "violation_description", "exception_status", "waived_by_id", "waived_at", "waiver_reason", "resolved_at", "created_at"],
    "portfolio_exposures": ["id", "deal_id", "exposure_dimension", "dimension_value", "exposure_amount", "computed_at"],
    "approvals": ["id", "deal_id", "approval_level", "required_authority_tier", "approved_by_id", "approval_status", "approved_at", "decision", "decision_notes"],
    "deal_decisions": ["id", "deal_id", "decision_type", "decision_status", "decided_by_id", "decided_at", "adverse_action_reason", "returned_to_stage", "rework_reason", "rework_assigned_to_id"],
    "audit_trail": ["id", "deal_id", "actor_id", "actor_type", "event_type", "timestamp", "before_value", "after_value", "description"],
    "users": ["id", "username", "email", "full_name", "role", "approval_authority_tier", "created_at", "last_login_at"],
    "user_deal_assignments": ["id", "user_id", "deal_id", "assignment_type", "created_at"],
    "sla_tracking": ["id", "deal_id", "stage_entered_at", "current_stage", "business_days_idle", "is_over_sla", "last_updated_at"],
}
