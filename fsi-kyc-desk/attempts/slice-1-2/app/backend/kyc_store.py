"""State access for the KYC desk — every read and write goes through db.store.

Nothing in the app may keep case state anywhere else. Rows are looked up with
store.list() and written with store.insert(); in-place field changes go through
patch_case() so that row-history and the audit trail always see them.
"""
import datetime

import rbac
import row_history
import statemachine
from db import store
from ext_audit import record as audit_event
from ext_auth import current_user

import kyc_policy as policy

CASES = "cases"
DOCUMENTS = "documents"
MISSING_DOCUMENTS = "missing_documents"
AUDIT_TRAIL = "audit_trail"
NOTIFICATIONS = "notifications"
USERS = "users"


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def _persist(table: str, row: dict) -> dict:
    """Write a field change back through the store.

    persistence-core v0 hands callers the stored row object itself, so an
    in-place field change IS the store's update idiom — the composed modules use
    it the same way (approval_flow._decide, checklists.toggle). If an adapter
    that returns detached copies is composed later, it exposes update(); call it
    when present so no caller has to change.
    """
    update = getattr(store, "update", None)
    if callable(update):
        update(table, row)
    return row


# --------------------------------------------------------------------------
# Identity: the four named desk accounts from onboarding policy v3.2 §Roles
# --------------------------------------------------------------------------
def install_named_accounts() -> list:
    """The desk's four named individual accounts (onboarding policy v3.2, Roles).

    These are the app's identity roster, not demo fixtures — REQ-062 requires
    decisions to be attributable to a named individual — so they are installed
    unconditionally rather than through the APP_ALLOW_SEED-gated seed-data
    module, which exists for throwaway demo rows. Called from the ext module's
    install() hook, never as an import side effect.
    """
    existing = {u.get("username") for u in store.list(USERS)}
    for spec in policy.USERS:
        if spec["username"] not in existing:
            store.insert(USERS, {**spec, "created_at": now(), "is_active": True})
        rbac.grant(spec["username"], spec["role"])
    return store.list(USERS)


def users() -> list:
    return store.list(USERS)


def find_user(username):
    key = str(username or "").strip().lower()
    for user in store.list(USERS):
        if str(user.get("username", "")).lower() == key:
            return user
    return None


# Ascending decision authority; auditor is read-only and therefore lowest.
_ROLE_AUTHORITY = ["auditor", "kyc_analyst", "senior_analyst", "compliance_officer"]


def role_of(username) -> str:
    """The composed rbac module is the source of truth for a user's role; the
    users table is the fallback for accounts that hold no grant yet. Roles
    changed through rbac (ext_rbac POST /admin/roles) are therefore what the
    audit trail stamps as role-at-the-time."""
    granted = [r for r in rbac.roles_of(username or "") if r in _ROLE_AUTHORITY]
    if granted:
        return max(granted, key=_ROLE_AUTHORITY.index)
    user = find_user(username)
    return user["role"] if user else "unknown"


def resolve_actor(authorization=None, acting_user=None) -> str:
    """Prefer the authenticated caller (auth-basic); fall back to the stated user."""
    return current_user(authorization) or (str(acting_user).strip() if acting_user else "") or "system"


# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------
def reference(value) -> str:
    return str(value or "").strip().lower()


def find_case(case_reference):
    key = reference(case_reference)
    for row in store.list(CASES):
        if row.get("case_reference") == key:
            return row
    return None


def case_by_id(case_id):
    for row in store.list(CASES):
        if row["id"] == case_id:
            return row
    return None


def cases() -> list:
    return store.list(CASES)


def patch_case(case: dict, changes: dict, actor: str = "system") -> dict:
    """Apply field changes to a stored case row, tracked field by field."""
    before = {k: case.get(k) for k in changes}
    case.update(changes)
    _persist(CASES, case)
    row_history.track(CASES, case["id"], before, changes, actor)
    return case


# The legal status transitions of a case, as data (state-machine module).
# A case can only leave 'new' by the completeness check, and only leave 'ready'
# by a recorded human decision — no slice can invent a shortcut.
CASE_FLOW = statemachine.Machine(
    {
        "new": {"completeness_passed": "ready", "completeness_failed": "returned"},
        "returned": {"resubmitted": "new"},
        "ready": {"approved": "approved", "rejected": "rejected"},
        "approved": {},
        "rejected": {},
    },
    initial="new",
)


def next_status(current: str, event: str) -> str:
    """Raises statemachine.IllegalTransition if the move is not allowed."""
    return CASE_FLOW.advance(current, event)


# --------------------------------------------------------------------------
# Audit trail (append-only; never updated, never deleted)
# --------------------------------------------------------------------------
def record_audit(
    case_id,
    action_type,
    performed_by_user_id,
    field_name=None,
    old_value=None,
    new_value=None,
    details=None,
    performed_by_role=None,
):
    entry = store.insert(
        AUDIT_TRAIL,
        {
            "case_id": case_id,
            "action_type": action_type,
            "performed_by_user_id": performed_by_user_id,
            "performed_by_role": performed_by_role or role_of(performed_by_user_id),
            "timestamp": now(),
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "details": details or {},
        },
    )
    audit_event(
        f"case.{action_type}",
        {"case_id": case_id, "by": performed_by_user_id, "role": entry["performed_by_role"], "entry": entry["id"]},
    )
    return entry


def audit_for_case(case_id) -> list:
    return [e for e in store.list(AUDIT_TRAIL) if e.get("case_id") == case_id]


# --------------------------------------------------------------------------
# Notifications
# --------------------------------------------------------------------------
def notify(case_id, notification_type, recipient_user_id, message, extra=None):
    return store.insert(
        NOTIFICATIONS,
        {
            "case_id": case_id,
            "notification_type": notification_type,
            "recipient_user_id": recipient_user_id,
            "sent_at": now(),
            "message": message,
            "read_at": None,
            **(extra or {}),
        },
    )


def notifications() -> list:
    return store.list(NOTIFICATIONS)


# --------------------------------------------------------------------------
# Documents / missing documents
# --------------------------------------------------------------------------
def documents_for(case_id) -> list:
    return [d for d in store.list(DOCUMENTS) if d.get("case_id") == case_id]


def missing_for(case_id) -> list:
    return [m["document_type"] for m in store.list(MISSING_DOCUMENTS) if m.get("case_id") == case_id]


def replace_document_rows(case_id, required, received) -> None:
    """Record one row per checklist item for this case, plus any extra artefact
    supplied. Rows are written once per completeness run (append-only history)."""
    for item in required:
        store.insert(
            DOCUMENTS,
            {
                "case_id": case_id,
                "document_type": item["document_type"],
                "title": item["title"],
                "required": True,
                "conditionally_required": item["conditionally_required"],
                "condition_trigger": item["condition_trigger"],
                "received": item["document_type"] in received,
                "received_at": now() if item["document_type"] in received else None,
            },
        )
    required_types = {item["document_type"] for item in required}
    for extra in received:
        if extra not in required_types:
            store.insert(
                DOCUMENTS,
                {
                    "case_id": case_id,
                    "document_type": extra,
                    "title": extra.replace("_", " ").title(),
                    "required": False,
                    "conditionally_required": False,
                    "condition_trigger": None,
                    "received": True,
                    "received_at": now(),
                },
            )


def record_missing(case_id, missing) -> None:
    already = set(missing_for(case_id))
    for doc_type in missing:
        if doc_type not in already:
            store.insert(MISSING_DOCUMENTS, {"case_id": case_id, "document_type": doc_type, "recorded_at": now()})


seed_users()
