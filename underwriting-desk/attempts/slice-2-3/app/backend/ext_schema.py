"""Additive column/table registrations for the composed app.

`models.py` is generated from the approved data model and is not hand-edited.
Where a slice must persist a field the generated baseline does not carry, it is
declared HERE so the registry still describes the data honestly instead of the
columns drifting silently into rows. Storage itself is unchanged: everything
still goes through db.store into models.TABLES tables.

Each addition below names the requirement that forces it.
"""
from models import TABLES

# The whole app addresses deals by their client-supplied deal_reference, and
# intake captures the borrower's state, collateral and purpose (needed by the
# concentration/LTV policy rules) — none of which the generated model carried.
ADDITIONS = {
    "deals": [
        "deal_reference",          # slice contract: deals are addressed by this
        "borrower_state",          # REQ-035 geographic concentration limit
        "borrower_dba",
        "borrower_tin_masked",     # stored masked — never the full TIN/EIN
        "borrower_established",
        "borrower_address",
        "collateral_value",        # REQ-035 LTV caps
        "collateral_description",
        "term_months",
        "purpose",
        "tier_rule_version",       # REQ-043 which tier rule produced the tier
        "submission_fingerprint",  # replay-safe intake
        "workflow_run_id",
        "correlation_id",          # REQ-051 structured logs carry this
    ],
    "documents": ["deal_reference", "character_count"],
    "document_locations": ["deal_id"],
    "agent_runs": ["deal_reference", "agent_name", "error"],
    "agent_drafts": ["deal_reference", "approval_item_id"],
    "analyst_queues": ["deal_reference", "queue_id", "queue_label"],
    "audit_log": ["deal_reference", "actor_role"],
    "stage_transitions": ["deal_reference"],
    "users": ["display_name"],
}

for _table, _columns in ADDITIONS.items():
    _existing = TABLES.setdefault(_table, ["id"])
    for _column in _columns:
        if _column not in _existing:
            _existing.append(_column)

# chat-shell keeps its conversation thread in the standard table registry so it
# uses db.store through the generic /api/{table} surface like everything else.
TABLES.setdefault("conversations", ["id", "user", "title", "created_at"])
