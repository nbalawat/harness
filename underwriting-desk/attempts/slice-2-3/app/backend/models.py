"""Generated from the approved data model (data_model.json).

Hand-extended only where a slice adds a column the approved model implies:
`spread_line_items.superseded_at` / `citations.superseded_at` (slice 2 keeps
the record append-only by stamping a replaced spread instead of deleting it)
and `agent_runs.tokens_in` / `tokens_out` (REQ-030 run telemetry). Column
order matters: ext_export builds the examiner CSV from this list, so a column
missing here is a column missing from the examiner's copy.
"""

TABLES = {
    "deals": ["id", "borrower_name", "borrower_industry", "facility_type", "requested_amount", "exposure_amount", "current_stage", "assigned_analyst_id", "submitted_by_user_id", "created_at", "last_activity_at", "closed_at", "is_closed", "approval_tier"],
    "documents": ["id", "deal_id", "original_filename", "content_type", "uploaded_by_user_id", "uploaded_at", "storage_path", "document_type"],
    "document_locations": ["id", "document_id", "page_number", "section", "extracted_text"],
    "spread_line_items": ["id", "deal_id", "line_item_key", "category", "label", "value", "unit", "period", "superseded_at"],
    "citations": ["id", "deal_id", "cited_value", "source_type", "source_reference", "document_id", "document_location_id", "spread_line_item_id", "ratio_id", "policy_rule_id", "created_at", "superseded_at"],
    "ratios": ["id", "deal_id", "ratio_type", "value", "computed_at", "computed_by_version"],
    "risk_grades": ["id", "deal_id", "grade", "rubric_inputs", "computed_at", "computed_by_version"],
    "policy_rules": ["id", "rule_name", "rule_type", "description", "parameters", "version", "effective_date", "is_active"],
    "policy_exceptions": ["id", "deal_id", "policy_rule_id", "breached_value", "rule_threshold", "agent_rationale", "human_disposition", "disposition_by_user_id", "disposition_reason", "created_at", "disposition_at"],
    "memos": ["id", "deal_id", "content", "citations", "drafted_at"],
    "agent_runs": ["id", "deal_id", "agent_type", "run_stage", "model_id", "prompt_template_version", "inputs", "raw_output", "latency_ms", "token_cost", "tokens_in", "tokens_out", "ran_at"],
    "agent_drafts": ["id", "agent_run_id", "deal_id", "draft_type", "draft_content", "review_status", "reviewed_by_user_id", "review_action", "review_reason", "human_edits", "created_at", "reviewed_at"],
    "approvals": ["id", "deal_id", "approval_stage", "approval_tier", "approved_by_user_id", "decision", "reason", "approved_at"],
    "declines": ["id", "deal_id", "declined_by_user_id", "adverse_action_reason", "declined_at"],
    "stage_transitions": ["id", "deal_id", "from_stage", "to_stage", "transitioned_by_user_id", "transition_reason", "transitioned_at"],
    "audit_log": ["id", "deal_id", "event_type", "entity_type", "entity_id", "actor_user_id", "action", "old_values", "new_values", "details", "created_at"],
    "users": ["id", "username", "email", "password_hash", "role", "is_active", "created_at"],
    "analyst_queues": ["id", "analyst_user_id", "deal_id", "queue_status", "added_at"],
}
