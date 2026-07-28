"""Generated from the approved data model (data_model.json). Do not hand-edit."""

TABLES = {
    "cases": ["id", "case_reference", "client_reference", "cycle", "created_at", "status", "client_name", "client_name_normalized", "entity_type", "submitted_by", "case_ready_timestamp", "completeness_passed_at", "returned_at", "total_risk_score", "risk_band", "required_approver_role", "sla_start_timestamp", "sla_due_timestamp", "sla_hours", "sla_breached", "is_at_risk", "assigned_approver_id", "risk_matrix_version", "document_checklist_version", "onboarding_policy_version", "next_review_due_date"],
    # One row per submission cycle of a case: the policy versions, package and
    # outcome that applied at that cycle, so a later cycle never retroactively
    # rewrites an earlier one (REQ-070).
    "case_cycles": ["id", "case_id", "case_reference", "cycle", "opened_at", "submitted_by", "submitted_documents", "attributes", "risk_factors", "status", "missing_documents", "total_risk_score", "risk_band", "case_ready_timestamp", "returned_at", "decision", "decided_at", "decided_by_user_id", "decided_by_role", "document_checklist_version", "risk_matrix_version", "onboarding_policy_version"],
    "risk_scores": ["id", "case_id", "cycle", "jurisdiction_factor_score", "jurisdiction_raw_input", "entity_structure_factor_score", "entity_structure_raw_input", "industry_factor_score", "industry_raw_input", "sanctions_screening_factor_score", "sanctions_screening_raw_input", "expected_activity_factor_score", "expected_activity_raw_input", "total_risk_score", "risk_band", "sanctions_true_positive_override_applied", "computed_at"],
    "documents": ["id", "case_id", "cycle", "document_type", "required", "conditionally_required", "condition_trigger", "received", "received_at"],
    "missing_documents": ["id", "case_id", "cycle", "document_type", "recorded_at"],
    "assessment_memos": ["id", "case_id", "cycle", "version", "memo_text", "generated_at", "is_machine_drafted", "policy_citations", "approved_at", "approved_by_user_id", "approved_by_role", "is_approved"],
    "approvals": ["id", "case_id", "cycle", "decision_type", "decided_by_user_id", "decided_by_role", "decided_at", "required_role_tier", "reason", "memo_version_id"],
    "compliance_exceptions": ["id", "case_id", "exception_type", "granted_by_user_id", "granted_at", "reason", "affected_documents"],
    "audit_trail": ["id", "case_id", "action_type", "performed_by_user_id", "performed_by_role", "timestamp", "field_name", "old_value", "new_value", "details"],
    "escalations": ["id", "case_id", "escalation_level", "escalated_to_role", "escalated_to_user_id", "escalated_at", "reason"],
    "notifications": ["id", "case_id", "notification_type", "recipient_user_id", "sent_at", "message", "read_at"],
    "sla_tracking": ["id", "case_id", "cycle", "sla_start_timestamp", "sla_due_timestamp", "risk_band", "sla_hours", "flagged_at_risk_at", "breached_at", "breached"],
    "users": ["id", "username", "full_name", "role", "created_at", "is_active"],
    # chat-shell / seed-data module table (not part of the approved domain model)
    "conversations": ["id", "user", "created_at"],
}
