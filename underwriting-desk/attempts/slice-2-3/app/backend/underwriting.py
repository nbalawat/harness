"""Underwriting domain core — shared by the HTTP surface and the workflow engine.

Slice 1 (deal intake, triage draft, pipeline board) owns this module.

Composition contract honoured here:
  * every read/write goes through ``db.store`` (tables from ``models.TABLES``)
  * every LLM call goes through ``agent_runtime.respond()`` (roster is the contract)
  * every state change appends an append-only ``audit_log`` row AND an
    ``ext_audit.record`` entry
  * money / tier / grading arithmetic is deterministic Python, never an LLM
  * agent output lands in a PENDING draft that a named human must action
"""
from __future__ import annotations

import datetime
import json
import math
import re
import time
import uuid

import agent_runtime
import approval_flow
import assignment
import os

import blob_store
import doc_extract
import costmeter
import pii
import prompts
import rbac
import rls
import row_history
import slog
import workflow_engine
from db import store
from ext_audit import record as audit_record

# --------------------------------------------------------------------------
# Canonical vocabulary (shared by every slice — do not fork these)
# --------------------------------------------------------------------------

STAGES = (
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "tiered_approval",
    "closing",
)

STAGE_LABELS = {
    "intake": "Intake",
    "document_extraction": "Document Extraction",
    "financial_spreading": "Financial Spreading",
    "risk_grading": "Risk Grading",
    "memo_drafting": "Memo Drafting",
    "policy_compliance": "Policy Compliance",
    "tiered_approval": "Tiered Approval",
    "closing": "Closing",
}

# REQ-043 / GAP-054: approval tier is derived from exposure, deterministically.
TIER_RULE_VERSION = "tier-rules@2026.1"
TIER_ANALYST_CEILING = 250_000
TIER_OFFICER_CEILING = 1_000_000

TIER_REQUIRED_ROLE = {
    "analyst": "credit_analyst",
    "officer": "credit_officer",
    "committee": "credit_committee_chair",
}

MAX_REQUESTED_AMOUNT = 500_000_000
# One cap for document text however it arrives — inline `text` is checked in
# validate_submission, and text pulled from a previously uploaded blob is
# truncated to the same limit before it can reach the store.
MAX_DOCUMENT_TEXT = 200_000
# Ceiling on any single hand-keyed spread figure. A financial-statement line is
# not unbounded input just because a human typed it — an unbounded (or
# non-finite) value would poison every ratio computed from the spread.
MAX_SPREAD_LINE_VALUE = 1_000_000_000_000

FACILITY_TYPES = {
    "term_loan": {
        "label": "Term loan",
        "ltv_cap": 0.80,
        "required_documents": [
            "financial_statements",
            "business_tax_return",
            "debt_schedule",
            "personal_financial_statement",
        ],
    },
    "line_of_credit": {
        "label": "Revolving line of credit",
        "ltv_cap": 0.70,
        "required_documents": [
            "financial_statements",
            "business_tax_return",
            "ar_aging",
            "debt_schedule",
        ],
    },
    "cre_mortgage": {
        "label": "CRE mortgage",
        "ltv_cap": 0.75,
        "required_documents": [
            "financial_statements",
            "business_tax_return",
            "appraisal",
            "rent_roll",
        ],
    },
    "sba_7a": {
        "label": "SBA 7(a)",
        "ltv_cap": 0.80,
        "required_documents": [
            "financial_statements",
            "business_tax_return",
            "personal_financial_statement",
            "debt_schedule",
        ],
    },
}

DOCUMENT_TYPES = (
    "financial_statements",
    "business_tax_return",
    "personal_tax_return",
    "personal_financial_statement",
    "debt_schedule",
    "ar_aging",
    "ap_aging",
    "interim_financials",
    "appraisal",
    "rent_roll",
    "equipment_quote",
    "business_plan",
    "entity_documents",
    "insurance_certificate",
    "bank_statements",
    "other",
)

DOCUMENT_TYPE_LABELS = {t: t.replace("_", " ").title() for t in DOCUMENT_TYPES}

# Analyst queues the triage agent may propose (REQ-033). The agent proposes;
# a named human accepts before anything is actually routed.
ANALYST_QUEUES = (
    {
        "queue_id": "queue-specialty-manufacturing",
        "label": "Med-tech & specialty manufacturing",
        "analyst_user_id": "an.chen",
        "industry_tags": ("manufactur", "surgical", "instrument", "device", "machin", "fabricat", "tool", "med-tech"),
    },
    {
        "queue_id": "queue-commercial-real-estate",
        "label": "Commercial real estate",
        "analyst_user_id": "an.chen",
        "industry_tags": ("real estate", "storage", "property", "rental", "hotel", "warehouse"),
    },
    {
        "queue_id": "queue-general-ci",
        "label": "General C&I",
        "analyst_user_id": "an.chen",
        "industry_tags": (),
    },
)

# Advisory intake screen only (REQ-034's versioned policy_rules table is owned
# by the policy-compliance slice; nothing here disposes of an exception).
PROHIBITED_INDUSTRY_TERMS = (
    "liquor",
    "gaming",
    "casino",
    "adult entertainment",
    "cannabis",
    "dispensary",
    "marijuana",
    "firearm",
    "gun ",
    "ammunition",
)
PROHIBITED_INDUSTRY_RULE_REFERENCE = "POL-IND-11"

# Seeded role accounts — actors are named, never invented (REQ-041/REQ-042).
SEED_USERS = (
    {"username": "rm.rivera", "display_name": "R. Rivera", "email": "rm.rivera@example-bank.test", "role": "relationship_manager"},
    {"username": "an.chen", "display_name": "A. Chen", "email": "an.chen@example-bank.test", "role": "credit_analyst"},
    {"username": "co.brennan", "display_name": "C. Brennan", "email": "co.brennan@example-bank.test", "role": "credit_officer"},
)

ROLE_LABELS = {
    "relationship_manager": "Relationship Manager",
    "credit_analyst": "Credit Analyst",
    "credit_officer": "Credit Officer",
    "credit_committee_chair": "Credit Committee Chair",
}

# Deny-by-default role gates (FSI hardening rule 4).
SUBMIT_ROLES = frozenset({"relationship_manager", "credit_officer"})
TRIAGE_ROLES = frozenset({"relationship_manager", "credit_analyst", "credit_officer"})
DRAFT_REVIEW_ROLES = frozenset({"credit_analyst", "credit_officer"})

DEAL_REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")

TRIAGE_PROMPT_NAME = "intake_triage"
TRIAGE_PROMPT_VERSION = 1
TRIAGE_AGENT_NAME = "Intake Triage Agent"

# Draft type -> (stage the deal must be in, stage acceptance moves it to).
DRAFT_STAGE_ADVANCE = {
    "triage": ("intake", "document_extraction"),
    "spread": ("financial_spreading", "risk_grading"),
}


class DomainError(Exception):
    """Validation / authorisation failure with an HTTP status attached."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def correlation_id() -> str:
    return "cid-" + uuid.uuid4().hex[:12]


def _log(event: str, **fields) -> None:
    """Structured log line — ids and event names only, never payload bodies."""
    try:
        slog.info(event, **fields)
    except Exception:  # logging must never break a request
        pass


def derive_approval_tier(exposure_amount: float) -> str:
    """REQ-043 / GAP-054 — deterministic, never agent-produced."""
    amount = float(exposure_amount)
    if amount <= TIER_ANALYST_CEILING:
        return "analyst"
    if amount <= TIER_OFFICER_CEILING:
        return "officer"
    return "committee"


def exposure_for(requested_amount: float) -> float:
    """Slice contract: exposure == the requested facility amount alone."""
    return round(float(requested_amount), 2)


def required_documents_for(facility_type: str) -> list[str]:
    return list(FACILITY_TYPES.get(facility_type, {}).get("required_documents", []))


def propose_queue(borrower_industry: str) -> dict:
    text = str(borrower_industry or "").lower()
    for queue in ANALYST_QUEUES:
        for tag in queue["industry_tags"]:
            if tag in text:
                return dict(queue)
    return dict(ANALYST_QUEUES[-1])


def queue_by_id(queue_id: str) -> dict | None:
    for queue in ANALYST_QUEUES:
        if queue["queue_id"] == queue_id:
            return dict(queue)
    return None


# --------------------------------------------------------------------------
# Users / identity
# --------------------------------------------------------------------------


def seed_users() -> None:
    existing = {row["username"] for row in store.list("users")}
    for spec in SEED_USERS:
        if spec["username"] in existing:
            continue
        store.insert(
            "users",
            {
                "username": spec["username"],
                "email": spec["email"],
                "password_hash": None,  # bearer-token identity (auth-basic); no secrets stored
                "role": spec["role"],
                "is_active": True,
                "created_at": now_iso(),
                "display_name": spec["display_name"],
            },
        )
    for spec in SEED_USERS:
        rbac.grant(spec["username"], spec["role"])


def get_user(username: str | None) -> dict | None:
    if not username:
        return None
    for row in store.list("users"):
        if row["username"] == username:
            return row
    return None


def resolve_actor(authenticated: str | None, body_actor: str | None, allowed_roles) -> dict:
    """Signed-in identity wins; HTTP callers name themselves in the body.

    Deny by default: unknown, inactive, or wrongly-roled actors never proceed.
    """
    named = (body_actor or "").strip()
    if authenticated and named and authenticated != named:
        raise DomainError(403, f"signed in as '{authenticated}' — you may not act as '{named}'")
    username = (authenticated or named).strip()
    if not username:
        raise DomainError(401, "an acting user is required (sign in or send acting_user)")
    user = get_user(username)
    if user is None or not user.get("is_active"):
        raise DomainError(403, f"unknown or inactive user '{username}'")
    # Deny by default, and ask the rbac module — the grant table is the
    # authority, not a column we happen to have read.
    if not any(rbac.has_role(username, role) for role in allowed_roles):
        raise DomainError(403, f"role '{user['role']}' may not perform this action")
    return user


# --------------------------------------------------------------------------
# Audit / stage transitions (append-only)
# --------------------------------------------------------------------------


def audit_event(
    *,
    event_type: str,
    action: str,
    actor_user_id: str,
    deal_id=None,
    deal_reference=None,
    entity_type=None,
    entity_id=None,
    old_values=None,
    new_values=None,
    details=None,
) -> dict:
    row = store.insert(
        "audit_log",
        {
            "deal_id": deal_id,
            "deal_reference": deal_reference,
            "event_type": event_type,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "actor_user_id": actor_user_id,
            "actor_role": (get_user(actor_user_id) or {}).get("role"),
            "action": action,
            "old_values": old_values,
            "new_values": new_values,
            "details": details or {},
            "created_at": now_iso(),
        },
    )
    audit_record(event_type, {"audit_log_id": row["id"], "deal_reference": deal_reference, "actor": actor_user_id, "action": action})
    _log("audit.appended", event_type=event_type, audit_log_id=row["id"], deal_reference=deal_reference)
    return row


def record_transition(deal: dict, to_stage: str, actor_user_id: str, reason: str | None = None) -> dict:
    if to_stage not in STAGES:
        raise DomainError(400, f"unknown stage '{to_stage}'")
    from_stage = deal.get("current_stage")
    transition = store.insert(
        "stage_transitions",
        {
            "deal_id": deal["id"],
            "deal_reference": deal.get("deal_reference"),
            "from_stage": from_stage,
            "to_stage": to_stage,
            "transitioned_by_user_id": actor_user_id,
            "transition_reason": reason,
            "transitioned_at": now_iso(),
        },
    )
    before = dict(deal)
    deal["current_stage"] = to_stage
    deal["last_activity_at"] = transition["transitioned_at"]
    save_row("deals", deal, actor_user_id=actor_user_id, before=before)
    audit_event(
        event_type="stage.transition",
        action=f"{from_stage or 'new'} -> {to_stage}",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal.get("deal_reference"),
        entity_type="stage_transitions",
        entity_id=transition["id"],
        old_values={"current_stage": from_stage},
        new_values={"current_stage": to_stage},
        details={"reason": reason} if reason else {},
    )
    return transition


def save_row(table: str, row: dict, *, actor_user_id: str | None = None, before: dict | None = None) -> dict:
    """Persist a changed row through db.store (never a bare in-place mutation)
    and keep the row-history trail for the fields that moved."""
    if before is not None:
        row_history.track(table, row["id"], before, row, actor=actor_user_id or "system")
    return store.save(table, row)


def touch_deal(deal: dict) -> None:
    deal["last_activity_at"] = now_iso()
    store.save("deals", deal)


# --------------------------------------------------------------------------
# Deals
# --------------------------------------------------------------------------


def all_deals() -> list[dict]:
    return store.list("deals")


#: Roles that see the whole book. A relationship manager sees only the deals
#: they submitted (REQ-019); analysts, officers and the committee chair need
#: the full portfolio to do their jobs.
PORTFOLIO_WIDE_ROLES = frozenset(
    {"credit_analyst", "credit_officer", "credit_committee_chair", "admin"}
)


def visible_deals(username: str | None) -> list[dict]:
    """Row-level scoping for every board read, via the composed rls module.

    An unauthenticated caller is not scoped: this build accepts a named actor
    in the request body (the documented HTTP contract for the slice), so there
    is no identity to scope by until a bearer token is presented.
    """
    rows = all_deals()
    user = get_user(username) if username else None
    if user is None or user.get("role") in PORTFOLIO_WIDE_ROLES:
        return rows
    return rls.scope(
        rows,
        user["username"],
        {"owner_field": "submitted_by_user_id", "bypass_roles": []},
    )


def find_deal(deal_reference: str) -> dict | None:
    for row in all_deals():
        if row.get("deal_reference") == deal_reference:
            return row
    return None


def require_deal(deal_reference: str) -> dict:
    deal = find_deal(deal_reference)
    if deal is None:
        raise DomainError(404, f"unknown deal '{deal_reference}'")
    return deal


def documents_for(deal_id) -> list[dict]:
    return [d for d in store.list("documents") if d.get("deal_id") == deal_id]


def locations_for(document_ids) -> list[dict]:
    ids = set(document_ids)
    return [loc for loc in store.list("document_locations") if loc.get("document_id") in ids]


def drafts_for(deal_id, draft_type: str | None = None) -> list[dict]:
    rows = [d for d in store.list("agent_drafts") if d.get("deal_id") == deal_id]
    if draft_type:
        rows = [d for d in rows if d.get("draft_type") == draft_type]
    return rows


def pending_draft(deal_id, draft_type: str) -> dict | None:
    rows = [d for d in drafts_for(deal_id, draft_type) if d.get("review_status") == "pending"]
    return rows[-1] if rows else None


def submission_fingerprint(payload: dict) -> str:
    """Stable digest of an intake submission — makes POST /deals replay-safe."""
    docs = [
        {
            "document_type": d.get("document_type"),
            "original_filename": d.get("original_filename"),
            "content_type": d.get("content_type"),
            "text": (d.get("text") or "")[:4000],
            "upload_name": d.get("upload_name"),
        }
        for d in payload.get("documents") or []
    ]
    canonical = {
        "deal_reference": payload.get("deal_reference"),
        "borrower_name": payload.get("borrower_name"),
        "borrower_industry": payload.get("borrower_industry"),
        "borrower_state": payload.get("borrower_state"),
        "facility_type": payload.get("facility_type"),
        "requested_amount": float(payload.get("requested_amount") or 0),
        "collateral_value": float(payload.get("collateral_value") or 0),
        "collateral_description": payload.get("collateral_description"),
        "borrower_dba": payload.get("borrower_dba"),
        "borrower_established": payload.get("borrower_established"),
        "borrower_address": payload.get("borrower_address"),
        "term_months": payload.get("term_months"),
        "purpose": payload.get("purpose"),
        "submitted_by": payload.get("submitted_by"),
        "documents": docs,
    }
    import hashlib

    return hashlib.sha256(json.dumps(canonical, sort_keys=True, default=str).encode()).hexdigest()


def validate_submission(payload: dict) -> dict:
    """Validate BEFORE anything touches storage (FSI hardening rule 1)."""
    errors: list[str] = []

    reference = str(payload.get("deal_reference") or "").strip()
    if not DEAL_REFERENCE_RE.match(reference):
        errors.append("deal_reference must be 3-64 characters of letters, digits, '.', '_' or '-'")

    borrower_name = str(payload.get("borrower_name") or "").strip()
    if not 2 <= len(borrower_name) <= 200:
        errors.append("borrower_name is required (2-200 characters)")

    # Both are stored on the deal of record, exported to CSV and interpolated
    # into the triage prompt, so they are bounded like every sibling field —
    # an unbounded string here is an unbounded span of an agent prompt.
    borrower_industry = str(payload.get("borrower_industry") or "").strip()
    if not 1 <= len(borrower_industry) <= 120:
        errors.append("borrower_industry is required (1-120 characters)")

    borrower_state = str(payload.get("borrower_state") or "").strip()
    if not 1 <= len(borrower_state) <= 60:
        errors.append("borrower_state is required (1-60 characters)")

    facility_type = str(payload.get("facility_type") or "").strip()
    if facility_type not in FACILITY_TYPES:
        errors.append(f"facility_type must be one of {sorted(FACILITY_TYPES)}")

    raw_amount = payload.get("requested_amount")
    if isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float)):
        errors.append("requested_amount must be a number")
        requested_amount = 0.0
    else:
        requested_amount = float(raw_amount)
        if not 0 < requested_amount <= MAX_REQUESTED_AMOUNT:
            errors.append(f"requested_amount must be greater than 0 and at most {MAX_REQUESTED_AMOUNT}")

    raw_collateral = payload.get("collateral_value") or 0
    if isinstance(raw_collateral, bool) or not isinstance(raw_collateral, (int, float)):
        errors.append("collateral_value must be a number")
        collateral_value = 0.0
    else:
        collateral_value = float(raw_collateral)
        if collateral_value < 0:
            errors.append("collateral_value may not be negative")

    documents = payload.get("documents")
    if documents is None:
        documents = []
    if not isinstance(documents, list):
        errors.append("documents must be a list")
        documents = []
    if len(documents) > 40:
        errors.append("at most 40 documents may be submitted at intake")
    clean_documents = []
    for index, raw in enumerate(documents):
        if not isinstance(raw, dict):
            errors.append(f"documents[{index}] must be an object")
            continue
        document_type = str(raw.get("document_type") or "").strip()
        if document_type not in DOCUMENT_TYPES:
            errors.append(f"documents[{index}].document_type must be one of {list(DOCUMENT_TYPES)}")
            continue
        filename = str(raw.get("original_filename") or "").strip()
        if not filename or len(filename) > 200:
            errors.append(f"documents[{index}].original_filename is required (max 200 characters)")
            continue
        text = raw.get("text")
        upload_name = raw.get("upload_name")
        if text is not None and not isinstance(text, str):
            errors.append(f"documents[{index}].text must be a string")
            continue
        if upload_name is not None and not isinstance(upload_name, str):
            errors.append(f"documents[{index}].upload_name must be a string")
            continue
        if len(text or "") > MAX_DOCUMENT_TEXT:
            errors.append(f"documents[{index}].text exceeds the 200,000 character intake limit")
            continue
        clean_documents.append(
            {
                "document_type": document_type,
                "original_filename": filename,
                "content_type": str(raw.get("content_type") or "application/octet-stream")[:100],
                "text": text or "",
                "upload_name": upload_name or None,
            }
        )

    if errors:
        raise DomainError(400, "; ".join(errors))

    raw_term = payload.get("term_months")
    term_months = None
    if raw_term not in (None, "", 0):
        try:
            term_months = int(raw_term)
        except (TypeError, ValueError):
            term_months = None
        if term_months is not None and not 1 <= term_months <= 480:
            errors.append("term_months must be between 1 and 480")

    if errors:
        raise DomainError(400, "; ".join(errors))

    return {
        "deal_reference": reference,
        "borrower_name": borrower_name,
        "borrower_industry": borrower_industry,
        "borrower_state": borrower_state,
        "borrower_dba": str(payload.get("borrower_dba") or "").strip()[:200],
        # TIN/EIN is sensitive: only the last four digits are ever stored. A
        # payload that has already been through the mask (the workflow engine
        # only ever sees that form) keeps its masked value.
        "borrower_tin_masked": mask_tin(payload.get("borrower_tin")) or payload.get("borrower_tin_masked"),
        "borrower_established": str(payload.get("borrower_established") or "").strip()[:20],
        "borrower_address": str(payload.get("borrower_address") or "").strip()[:300],
        "facility_type": facility_type,
        "requested_amount": round(requested_amount, 2),
        "collateral_value": round(collateral_value, 2),
        "collateral_description": str(payload.get("collateral_description") or "").strip()[:300],
        "term_months": term_months,
        "purpose": str(payload.get("purpose") or "").strip()[:500],
        "documents": clean_documents,
    }


#: Raw values that are accepted on a submission but must never be persisted or
#: forwarded into the durable workflow-run record. Only their masked form
#: survives validation.
SENSITIVE_SUBMISSION_FIELDS = frozenset({"borrower_tin"})


def mask_tin(raw) -> str | None:
    """Never store a full TIN/EIN — the record keeps the last four only."""
    text = str(raw or "")
    if "*" in text:
        return text  # already masked — masking is idempotent
    digits = re.sub(r"\D", "", text)
    if not digits:
        return None
    return "***-**" + digits[-4:] if len(digits) >= 4 else "***"


def intake_preflight(*, borrower_name: str, borrower_industry: str, borrower_state: str, facility_type: str, requested_amount: float, collateral_value: float, exclude_deal_reference: str | None = None) -> dict:
    """Deterministic advisory checks shown on the Deal Intake screen.

    Advisory only: nothing here approves, declines, or blocks a submission.
    The versioned lending-policy exception process is a later stage.
    """
    industry = str(borrower_industry or "").lower()
    hits = [term.strip() for term in PROHIBITED_INDUSTRY_TERMS if term in industry]
    existing = [
        d
        for d in all_deals()
        if d.get("borrower_name", "").strip().lower() == str(borrower_name).strip().lower()
        and d.get("deal_reference") != exclude_deal_reference
    ]
    existing_exposure = round(sum(float(d.get("exposure_amount") or 0) for d in existing), 2)
    exposure = exposure_for(requested_amount)
    ltv_cap = FACILITY_TYPES.get(facility_type, {}).get("ltv_cap")
    ltv = round(exposure / collateral_value, 4) if collateral_value else None
    return {
        "prohibited_industry": {
            "status": "flag" if hits else "pass",
            "rule_reference": PROHIBITED_INDUSTRY_RULE_REFERENCE,
            "matched_terms": hits,
            "detail": "advisory intake screen — a formal policy exception is raised at the compliance stage",
        },
        "existing_relationship": {
            "status": "info",
            "facility_count": len(existing),
            "outstanding_exposure": existing_exposure,
        },
        "aggregate_exposure": {
            "status": "flag" if existing_exposure + exposure > TIER_OFFICER_CEILING else "pass",
            "value": round(existing_exposure + exposure, 2),
        },
        "requested_ltv": {
            "status": "flag" if (ltv is not None and ltv_cap is not None and ltv > ltv_cap) else ("pass" if ltv is not None else "unknown"),
            "value": ltv,
            "cap": ltv_cap,
        },
        "duplicate_request": {
            "status": "flag" if existing else "none",
            "references": [d.get("deal_reference") for d in existing],
        },
        "approval_tier": {
            "value": derive_approval_tier(exposure),
            "exposure_amount": exposure,
            "tier_rule_version": TIER_RULE_VERSION,
        },
    }


# --------------------------------------------------------------------------
# Documents: blob storage + deterministic extraction to addressable locations
# --------------------------------------------------------------------------

_SECTION_RE = re.compile(r"^([A-Z][A-Za-z&/ ()-]{2,40}):\s*(.*)$")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.;])\s+")
_LOCATIONS_PER_PAGE = 6
# The shape _store_document_text() writes: "<deal_reference>-<NN>-<filename>.txt".
# Used to tell one deal's stored document text from another's.
_DOCUMENT_BLOB_RE = re.compile(r"^(?P<ref>[A-Za-z0-9._-]+?)-\d{2}-.*\.txt$")


def _store_document_text(deal_reference: str, index: int, filename: str, text: str) -> str | None:
    """Document bytes live in blob-store only — never an ad-hoc open()."""
    if not text:
        return None
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:80]
    try:
        return blob_store.save(f"{deal_reference}-{index:02d}-{safe}.txt", text.encode("utf-8"))
    except (ValueError, OSError):
        return None


def _read_upload(upload_name: str, deal_reference: str) -> str:
    """Read a previously uploaded blob for THIS deal.

    Two guards (FSI hardening rule 1): a submission may not name a blob this
    app stored for a *different* deal — intake document text is confidential to
    its borrower — and however large the blob is, only the intake character
    limit is ever admitted into the record.
    """
    owner = _DOCUMENT_BLOB_RE.match(upload_name or "")
    if owner and owner.group("ref") != re.sub(r"[^A-Za-z0-9._-]", "_", deal_reference):
        return ""
    try:
        raw = blob_store.get(upload_name)
    except (OSError, ValueError):
        return ""
    try:
        return raw.decode("utf-8")[:MAX_DOCUMENT_TEXT]
    except UnicodeDecodeError:
        pass
    # A PDF/DOCX upload is not utf-8 text. The intake screen asks for exactly
    # those formats, so the composed doc-extract module converts them rather
    # than the document silently landing with no extractable content.
    return _extract_upload(upload_name)


def _extract_upload(upload_name: str) -> str:
    """Convert a non-text upload through the composed doc-extract module.

    blob_store owns the bytes and the name sanitising; the path handed to
    doc_extract is rebuilt from the sanitised name it returns, so a
    request-derived path can never escape the blob directory.
    """
    try:
        blob_path = blob_store.path(upload_name)
    except ValueError:
        return ""
    if os.path.basename(blob_path) not in blob_store.list_blobs():
        return ""
    try:
        result = doc_extract.extract(blob_path)
    except Exception as exc:  # a malformed upload must not take the request down
        _log("document.extract_failed", blob=os.path.basename(blob_path), error=str(exc)[:120])
        return ""
    for warning in result.get("warnings") or []:
        _log("document.extract_warning", blob=os.path.basename(blob_path), warning=warning[:160])
    return (result.get("text") or "")[:MAX_DOCUMENT_TEXT]


def split_into_locations(text: str) -> list[dict]:
    """Deterministic parse into citable (page, section, text) locations.

    GAP-056 fixes documents as native-text, so extraction is mechanical — which
    is exactly what keeps citation offsets exact.
    """
    locations: list[dict] = []
    section = "body"
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _SECTION_RE.match(line)
        if match:
            section = match.group(1).strip()
            line = match.group(2).strip()
            if not line:
                continue
        for chunk in _SENTENCE_SPLIT_RE.split(line):
            piece = chunk.strip()
            if not piece:
                continue
            inner = _SECTION_RE.match(piece)
            if inner:
                section = inner.group(1).strip()
                piece = inner.group(2).strip()
                if not piece:
                    continue
            locations.append({"section": section, "extracted_text": piece})
    for index, location in enumerate(locations):
        location["page_number"] = 1 + index // _LOCATIONS_PER_PAGE
    return locations


def _page_count(document_rows: list[dict], locations: list[dict]) -> int:
    """Total extracted pages across a deal's documents — one definition, so a
    replayed node reports the same number as the first run."""
    total = 0
    for document in document_rows:
        pages = [loc["page_number"] for loc in locations if loc["document_id"] == document["id"]]
        total += max(pages) if pages else 0
    return total


def store_documents(deal: dict, documents: list[dict], actor_user_id: str) -> list[dict]:
    stored = []
    existing = len(documents_for(deal["id"]))
    for offset, spec in enumerate(documents):
        text = (spec.get("text") or "")[:MAX_DOCUMENT_TEXT]
        if not text and spec.get("upload_name"):
            text = _read_upload(spec["upload_name"], deal["deal_reference"])
        storage_path = _store_document_text(deal["deal_reference"], existing + offset + 1, spec["original_filename"], text)
        row = store.insert(
            "documents",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "original_filename": spec["original_filename"],
                "content_type": spec.get("content_type") or "application/octet-stream",
                "uploaded_by_user_id": actor_user_id,
                "uploaded_at": now_iso(),
                "storage_path": storage_path,
                "document_type": spec["document_type"],
                "character_count": len(text),
            },
        )
        stored.append(row)
        audit_event(
            event_type="document.stored",
            action="store document",
            actor_user_id=actor_user_id,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="documents",
            entity_id=row["id"],
            new_values={"document_type": row["document_type"], "original_filename": row["original_filename"]},
        )
    return stored


def extract_documents(deal: dict, document_rows: list[dict], actor_user_id: str) -> dict:
    location_ids: list[int] = []
    unextractable: list[int] = []
    for document in document_rows:
        text = _read_upload(document["storage_path"], deal["deal_reference"]) if document.get("storage_path") else ""
        parsed = split_into_locations(text)
        if not parsed:
            unextractable.append(document["id"])
            continue
        for location in parsed:
            row = store.insert(
                "document_locations",
                {
                    "document_id": document["id"],
                    "deal_id": deal["id"],
                    "page_number": location["page_number"],
                    "section": location["section"],
                    "extracted_text": location["extracted_text"],
                },
            )
            location_ids.append(row["id"])
    if location_ids or unextractable:
        audit_event(
            event_type="document.extracted",
            action="extract document locations",
            actor_user_id=actor_user_id,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="document_locations",
            entity_id=None,
            new_values={"document_location_count": len(location_ids), "unextractable_document_ids": unextractable},
        )
    return {
        "document_location_ids": location_ids,
        "extracted_page_count": _page_count(document_rows, locations_for([d["id"] for d in document_rows])),
        "unextractable_document_ids": unextractable,
    }


# --------------------------------------------------------------------------
# Intake triage agent (roster agent 1) — proposes, never routes
# --------------------------------------------------------------------------

TRIAGE_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name
Borrower industry: $borrower_industry
Borrower state: $borrower_state
Requested facility type (already recorded on the deal): $facility_type
Requested amount (USD): $requested_amount

Documents received for this deal:
$received_documents

Extracted, citable document locations:
$location_summary

Required-document checklist for this request type:
$required_documents

Analyst queues you may propose (use the queue_id exactly):
$queue_options

Permitted request classifications (use the slug exactly):
$allowed_classifications

Return ONLY a JSON object shaped exactly like this and nothing else:
{"classification": "<one permitted classification slug>",
 "missing_documents": ["<checklist document types that are absent or unextractable>"],
 "proposed_queue": "<one queue_id>",
 "rationale": "<one or two sentences of reasoning drawn only from the record>"}

Do not compute ratios, do not assign a risk grade, and do not express any view
on approval. If the record cannot establish a conclusion, use the exact phrase
"not supported by the record" in the rationale."""

prompts.register(TRIAGE_PROMPT_NAME, TRIAGE_PROMPT_TEXT, version=TRIAGE_PROMPT_VERSION)


def model_id() -> str:
    info = agent_runtime.mode()
    if info["mode"] == "stub":
        return "stub-deterministic-responder"
    import os

    return os.environ.get("APP_AGENT_MODEL", "claude-opus-5")


def prompt_version(name: str) -> str:
    return f"{name}@v{prompts.get(name)['version']}"


def _estimate_tokens(text) -> int:
    return max(1, len(str(text)) // 4)


def run_agent(*, agent_name: str, prompt: str, deal: dict, agent_type: str, run_stage: str, prompt_name: str, inputs: dict) -> dict:
    """Single funnel for every LLM call — records REQ-038 run telemetry."""
    started = time.perf_counter()
    try:
        reply = agent_runtime.respond(prompt, agent_name=agent_name)
        error = None
    except Exception as exc:  # never let a model hiccup corrupt deal state
        reply, error = "", str(exc)[:200]
    latency_ms = int((time.perf_counter() - started) * 1000)
    model = model_id()
    tokens_in, tokens_out = _estimate_tokens(prompt), _estimate_tokens(reply)
    cost_row = costmeter.record(model, tokens_in, tokens_out)
    run = store.insert(
        "agent_runs",
        {
            "deal_id": deal["id"],
            "deal_reference": deal.get("deal_reference"),
            "agent_type": agent_type,
            "agent_name": agent_name,
            "run_stage": run_stage,
            "model_id": model,
            "prompt_template_version": prompt_version(prompt_name),
            "inputs": inputs,
            "raw_output": pii.redact(reply)[:4000],
            "latency_ms": latency_ms,
            "token_cost": cost_row["usd"],
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "ran_at": now_iso(),
            "error": error,
        },
    )
    _log("agent.run", agent=agent_type, deal_reference=deal.get("deal_reference"), agent_run_id=run["id"], latency_ms=latency_ms)
    return {"run": run, "reply": reply}


def _json_candidates(text: str):
    depth = 0
    start = -1
    for index, char in enumerate(str(text)):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                yield text[start : index + 1]


def parse_triage_reply(reply: str, *, allowed_documents, allowed_queue_ids) -> dict | None:
    """Accept the agent's structured proposal only if it validates."""
    for blob in _json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        classification = parsed.get("classification")
        missing = parsed.get("missing_documents")
        queue = parsed.get("proposed_queue")
        if classification not in FACILITY_TYPES:
            continue
        if not isinstance(missing, list) or any(m not in allowed_documents for m in missing):
            continue
        if queue not in allowed_queue_ids:
            continue
        return {
            "classification": classification,
            "missing_documents": [str(m) for m in missing],
            "proposed_queue": queue,
            "rationale": str(parsed.get("rationale") or "")[:600],
        }
    return None


def derive_triage(deal: dict, document_rows: list[dict], unextractable_ids) -> dict:
    """Deterministic triage the app falls back to when the model output does
    not validate — the record, not a guess."""
    required = required_documents_for(deal["facility_type"])
    usable = {d["document_type"] for d in document_rows if d["id"] not in set(unextractable_ids or [])}
    missing = [doc for doc in required if doc not in usable]
    queue = propose_queue(deal["borrower_industry"])
    if document_rows:
        rationale = (
            f"{len(document_rows)} document(s) on file cover {sorted(usable) or 'no checklist line'}; "
            f"borrower industry '{deal['borrower_industry']}' matches queue {queue['queue_id']}."
        )
    else:
        rationale = (
            "No documents are on file, so the classification rests on the submitted facility type alone and the "
            "document position is not supported by the record."
        )
    return {
        "classification": deal["facility_type"],
        "missing_documents": missing,
        "proposed_queue": queue["queue_id"],
        "rationale": rationale,
    }


def triage_prompt_inputs(deal: dict) -> dict:
    """Everything the triage prompt and its run record are built from."""
    document_rows = documents_for(deal["id"])
    document_ids = [d["id"] for d in document_rows]
    locations = locations_for(document_ids)
    unextractable = [d["id"] for d in document_rows if not any(loc["document_id"] == d["id"] for loc in locations)]
    return {
        "document_rows": document_rows,
        "document_ids": document_ids,
        "locations": locations,
        "unextractable": unextractable,
    }


def build_triage_prompt(deal: dict, facts: dict) -> str:
    received = (
        "\n".join(f"- document {d['id']} · {d['document_type']} · {d['original_filename']}" for d in facts["document_rows"])
        or "- none on file"
    )
    location_summary = (
        "\n".join(
            f"- location {loc['id']} (document {loc['document_id']}, page {loc['page_number']}, section {loc['section']})"
            for loc in facts["locations"][:60]
        )
        or "- none extracted"
    )
    queue_options = "\n".join(f"- {q['queue_id']}: {q['label']} (analyst {q['analyst_user_id']})" for q in ANALYST_QUEUES)
    return prompts.render(
        TRIAGE_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        borrower_industry=deal["borrower_industry"],
        borrower_state=deal.get("borrower_state") or "not supported by the record",
        facility_type=deal["facility_type"],
        requested_amount=f"{deal['requested_amount']:,.2f}",
        received_documents=received,
        location_summary=location_summary,
        required_documents="\n".join(f"- {doc}" for doc in required_documents_for(deal["facility_type"])) or "- none",
        queue_options=queue_options,
        allowed_classifications="\n".join(f"- {slug}: {spec['label']}" for slug, spec in FACILITY_TYPES.items()),
    )


def triage_run_inputs(deal: dict, facts: dict) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": facts["document_ids"],
        "document_location_ids": [loc["id"] for loc in facts["locations"]],
        "required_documents": required_documents_for(deal["facility_type"]),
        "queue_ids": [q["queue_id"] for q in ANALYST_QUEUES],
    }


def _triage_content(deal: dict, reply: str, facts: dict) -> dict:
    """Accept the agent's structured proposal only if it validates against the
    configured vocabularies; otherwise fall back to the record itself."""
    proposal = parse_triage_reply(
        reply,
        allowed_documents=set(DOCUMENT_TYPES),
        allowed_queue_ids={q["queue_id"] for q in ANALYST_QUEUES},
    )
    source = "agent"
    if proposal is None:
        proposal = derive_triage(deal, facts["document_rows"], facts["unextractable"])
        source = "deterministic-fallback"
    queue = queue_by_id(proposal["proposed_queue"]) or propose_queue(deal["borrower_industry"])
    return {
        "classification": proposal["classification"],
        "classification_label": FACILITY_TYPES[proposal["classification"]]["label"],
        "missing_documents": proposal["missing_documents"],
        "missing_document_labels": [DOCUMENT_TYPE_LABELS.get(m, m) for m in proposal["missing_documents"]],
        "proposed_queue": queue["queue_id"],
        "proposed_queue_label": queue["label"],
        "proposed_analyst_user_id": queue["analyst_user_id"],
        "rationale": proposal["rationale"],
        "unextractable_document_ids": facts["unextractable"],
        "documents_on_file": len(facts["document_rows"]),
        "source": source,
    }


def _park_triage_draft(deal: dict, content: dict, agent_run_id, actor_user_id: str) -> dict:
    approval_item = _human_gate_for(deal, "triage", content)
    draft = store.insert(
        "agent_drafts",
        {
            "agent_run_id": agent_run_id,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "draft_type": "triage",
            "draft_content": content,
            "review_status": "pending",
            "reviewed_by_user_id": None,
            "review_action": None,
            "review_reason": None,
            "human_edits": None,
            "created_at": now_iso(),
            "reviewed_at": None,
            "approval_item_id": approval_item["id"],
        },
    )
    touch_deal(deal)
    audit_event(
        event_type="agent_draft.created",
        action="intake triage draft created (pending human acceptance)",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="agent_drafts",
        entity_id=draft["id"],
        new_values={"draft_type": "triage", "review_status": "pending", "agent_run_id": agent_run_id},
    )
    return draft


def adopt_workflow_triage(deal: dict, run_id: str | None, elapsed_ms: int, actor_user_id: str) -> dict | None:
    """Turn the workflow's OWN triage node output into the pending draft.

    The approved process already ran the intake triage agent inside the run;
    re-prompting it here would double the cost and — worse — mean the draft a
    human reviews is not the output the process produced. Instead the node's
    reply is adopted and recorded as the agent run (REQ-038).
    """
    if not run_id or pending_draft(deal["id"], "triage") is not None:
        return None
    try:
        context = workflow_engine.state(run_id).get("context") or {}
    except Exception:
        return None
    reply = (context.get("triage") or {}).get("reply")
    if not reply:
        return None

    facts = triage_prompt_inputs(deal)
    model = model_id()
    tokens_in, tokens_out = _estimate_tokens(build_triage_prompt(deal, facts)), _estimate_tokens(reply)
    cost_row = costmeter.record(model, tokens_in, tokens_out)
    run = store.insert(
        "agent_runs",
        {
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "agent_type": "intake_triage",
            "agent_name": TRIAGE_AGENT_NAME,
            "run_stage": "intake",
            "model_id": model,
            "prompt_template_version": prompt_version(TRIAGE_PROMPT_NAME),
            "inputs": triage_run_inputs(deal, facts) | {"workflow_run_id": run_id, "workflow_node": "triage"},
            "raw_output": pii.redact(reply)[:4000],
            # wall clock of the workflow run's intake phase, which this agent
            # node dominates — the engine does not expose a per-node timing.
            "latency_ms": int(elapsed_ms),
            "token_cost": cost_row["usd"],
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "ran_at": now_iso(),
            "error": None,
        },
    )
    _log("agent.run", agent="intake_triage", deal_reference=deal["deal_reference"], agent_run_id=run["id"], source="workflow")
    return _park_triage_draft(deal, _triage_content(deal, reply, facts), run["id"], actor_user_id)


def build_triage_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the intake triage agent directly and park the result as a PENDING
    draft. Used when there is no unconsumed workflow output to adopt — a
    re-triage after a rejection, say.

    The human gate is load-bearing: nothing here routes the deal or moves a stage.
    """
    facts = triage_prompt_inputs(deal)
    outcome = run_agent(
        agent_name=TRIAGE_AGENT_NAME,
        prompt=build_triage_prompt(deal, facts),
        deal=deal,
        agent_type="intake_triage",
        run_stage="intake",
        prompt_name=TRIAGE_PROMPT_NAME,
        inputs=triage_run_inputs(deal, facts),
    )
    return _park_triage_draft(deal, _triage_content(deal, outcome["reply"], facts), outcome["run"]["id"], actor_user_id)


# Which workflow human node reviews which draft type.
DRAFT_REVIEW_NODE = {"triage": "triage_review", "spread": "spread_review", "memo": "memo_review"}


def _human_gate_for(deal: dict, draft_type: str, content: dict) -> dict:
    """Reuse the workflow run's parked approval item when it is parked on THIS
    draft's review node, so the deal has exactly one human gate for it —
    otherwise open one."""
    run_id = deal.get("workflow_run_id")
    if run_id:
        try:
            state = workflow_engine.state(run_id)
        except Exception:
            state = {}
        approval_id = state.get("approval_id")
        if state.get("status") == "parked" and approval_id is not None:
            item = approval_flow._find(approval_id)
            parked_node = (item or {}).get("payload", {}).get("node")
            if item is not None and item["status"] == "pending" and parked_node == DRAFT_REVIEW_NODE.get(draft_type):
                return item
    return approval_flow.submit(
        f"agent_draft:{draft_type}",
        {"deal_reference": deal["deal_reference"], "draft_type": draft_type, "summary": content.get("rationale", "")[:200]},
        submitted_by=f"agent:{draft_type}",
    )


# --------------------------------------------------------------------------
# Financial spreading agent (roster agent 2) — fills the standard spread
# template with a citation on every single figure; never computes a ratio.
# --------------------------------------------------------------------------

# Standard spread template (slice contract): the exact line items the
# financial spreading agent fills, and the exact keys later ratio computation
# (DSCR, leverage, current ratio) reads back. "match" is the label prefix the
# deterministic fallback looks for at the start of an extracted document
# location's text — distinct prefixes, so first-match-wins is unambiguous.
SPREAD_TEMPLATE = (
    {"line_item_key": "revenue", "category": "income_statement", "label": "Revenue", "unit": "usd", "period": "annual", "match": ("revenue",)},
    {"line_item_key": "cogs", "category": "income_statement", "label": "Cost of Goods Sold", "unit": "usd", "period": "annual", "match": ("cost of goods sold",)},
    {"line_item_key": "operating_expenses", "category": "income_statement", "label": "Operating Expenses", "unit": "usd", "period": "annual", "match": ("operating expenses",)},
    {"line_item_key": "ebitda", "category": "income_statement", "label": "EBITDA", "unit": "usd", "period": "annual", "match": ("ebitda",)},
    {"line_item_key": "interest_expense", "category": "income_statement", "label": "Interest Expense", "unit": "usd", "period": "annual", "match": ("interest expense",)},
    {"line_item_key": "current_assets", "category": "balance_sheet", "label": "Current Assets", "unit": "usd", "period": "as_of", "match": ("current assets",)},
    {"line_item_key": "current_liabilities", "category": "balance_sheet", "label": "Current Liabilities", "unit": "usd", "period": "as_of", "match": ("current liabilities",)},
    {"line_item_key": "total_debt", "category": "balance_sheet", "label": "Total Debt", "unit": "usd", "period": "as_of", "match": ("total debt",)},
    {"line_item_key": "tangible_net_worth", "category": "balance_sheet", "label": "Tangible Net Worth", "unit": "usd", "period": "as_of", "match": ("tangible net worth",)},
    {"line_item_key": "annual_debt_service", "category": "debt_service", "label": "Annual Debt Service (Principal & Interest)", "unit": "usd", "period": "annual", "match": ("annual principal and interest", "total debt service", "annual debt service", "debt service")},
)
SPREAD_TEMPLATE_VERSION = "spread-template@2026.1"
SPREAD_TEMPLATE_KEYS = {spec["line_item_key"] for spec in SPREAD_TEMPLATE}

SPREAD_PROMPT_NAME = "financial_spread"
SPREAD_PROMPT_VERSION = 1
SPREAD_AGENT_NAME = "Financial Spreading Agent"

# Roles permitted to run the spreading agent and to review its draft — the
# same seat (credit analyst / credit officer) as every other draft review.
SPREAD_ROLES = DRAFT_REVIEW_ROLES

# The Draft Review workspace's cross-deal queue (REQ-046) is a materially
# bigger read surface than any single deal-scoped GET — it enumerates every
# agent draft, every deal's borrower details, and the extracted document text
# behind every citation, across the whole portfolio. Deny by default: any
# known, active, internal seat may read it, but an anonymous or unknown
# caller may not enumerate the firm's deal book this way.
DRAFT_QUEUE_ROLES = frozenset({"relationship_manager", "credit_analyst", "credit_officer", "credit_committee_chair"})

SPREAD_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name

Extracted, citable document locations for this deal — your ONLY permitted source:
$location_summary

Standard spread template lines you must fill (use the line_item_key exactly):
$template_lines

Return ONLY a JSON object shaped exactly like this and nothing else:
{"line_items": {"<line_item_key>": {"value": <number>, "document_id": <id>, "document_location_id": <id>} | "not supported by the record", ...}}

Every numeric value MUST carry a document_id and document_location_id drawn
only from the extracted locations above — an uncited figure is invalid
output. Never invent a line item outside the template, never carry a number
over from memory or another deal, and never compute DSCR, leverage, or the
current ratio — those are calculated by the system, not by you. Use the
exact phrase "not supported by the record" for any template line the
documents do not support."""

prompts.register(SPREAD_PROMPT_NAME, SPREAD_PROMPT_TEXT, version=SPREAD_PROMPT_VERSION)

_SPREAD_NUMBER_RE = re.compile(r"(-?\$?[\d][\d,]*(?:\.\d+)?)")


def _extract_amount(text: str) -> float | None:
    """The figure a document location states.

    Taking the FIRST number in the text is wrong the moment a statement line
    carries a period label — "Revenue 2024: 4,200,000" would ground revenue
    to 2024, and because that number is genuinely in the cited text it would
    be a deterministic, cited, wrong figure on the deal of record. Prefer a
    candidate that is written like money (thousands separator or decimals)
    and skip bare year-like integers when a real amount is present.
    """
    candidates = []
    for match in _SPREAD_NUMBER_RE.finditer(str(text or "")):
        token = match.group(1)
        raw = token.replace("$", "").replace(",", "")
        try:
            value = float(raw)
        except ValueError:
            continue
        money_shaped = ("," in token) or ("." in token) or ("$" in token)
        year_shaped = (
            not money_shaped
            and float(value).is_integer()
            and 1900 <= abs(value) <= 2100
            and len(raw.lstrip("-")) == 4
        )
        candidates.append((money_shaped, year_shaped, value))
    if not candidates:
        return None
    for money_shaped, _year, value in candidates:
        if money_shaped:
            return value
    for _money, year_shaped, value in candidates:
        if not year_shaped:
            return value
    # Every candidate looks like a year ("EBITDA 2024: 2023"): there is no
    # figure here to stand behind, and guessing one would put a period label
    # on the deal of record as money. Say so instead.
    return None


def _binds_to_spec(text: str, spec: dict) -> bool:
    """Does this document location actually state THIS template line?

    A prefix test alone is too loose: "Total Debt Service: 905,000" starts
    with "total debt", so the debt-service figure would be spread as total
    debt. Require the label to run straight into its number — any further
    word between the matched label and the first figure means the line is a
    different (longer) label than the one that matched.
    """
    body = str(text or "").strip().lower()
    for phrase in spec["match"]:
        if not body.startswith(phrase):
            continue
        remainder = body[len(phrase):]
        # Everything up to the first digit must be punctuation/whitespace.
        gap = re.split(r"\d", remainder, maxsplit=1)[0]
        if not re.search(r"[a-z]", gap):
            return True
    return False


def spread_prompt_inputs(deal: dict) -> dict:
    """Everything the spreading prompt and its run record are built from —
    the extracted document locations for THIS deal, and nothing else."""
    document_rows = documents_for(deal["id"])
    document_ids = [d["id"] for d in document_rows]
    locations = locations_for(document_ids)
    return {"document_rows": document_rows, "document_ids": document_ids, "locations": locations}


def build_spread_prompt(deal: dict, facts: dict) -> str:
    location_summary = (
        "\n".join(
            f"- location {loc['id']} (document {loc['document_id']}, page {loc['page_number']}, "
            f"section {loc['section']}): {loc['extracted_text']}"
            for loc in facts["locations"][:120]
        )
        or "- none extracted"
    )
    template_lines = "\n".join(f"- {spec['line_item_key']}: {spec['label']}" for spec in SPREAD_TEMPLATE)
    return prompts.render(
        SPREAD_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        location_summary=location_summary,
        template_lines=template_lines,
    )


def spread_run_inputs(deal: dict, facts: dict) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": facts["document_ids"],
        "document_location_ids": [loc["id"] for loc in facts["locations"]],
        "template_keys": sorted(SPREAD_TEMPLATE_KEYS),
    }


def derive_spread(locations: list[dict]) -> tuple[list[dict], list[dict]]:
    """Deterministic spread the app falls back to when the model output does
    not validate — the record, not a guess. Every figure it does find carries
    a citation; every line it cannot support says so explicitly."""
    line_items: list[dict] = []
    citations: list[dict] = []
    for spec in SPREAD_TEMPLATE:
        found = None
        for loc in locations:
            text = str(loc.get("extracted_text") or "").strip().lower()
            if _binds_to_spec(text, spec):
                amount = _extract_amount(loc["extracted_text"])
                if amount is not None:
                    found = (loc, amount)
                    break
        if found is None:
            line_items.append(
                {
                    "line_item_key": spec["line_item_key"],
                    "category": spec["category"],
                    "label": spec["label"],
                    "unit": spec["unit"],
                    "period": spec["period"],
                    "value": None,
                    "supported": False,
                    "citation": None,
                    "note": "not supported by the record",
                }
            )
            continue
        loc, amount = found
        citation = {
            "document_id": loc["document_id"],
            "document_location_id": loc["id"],
            "cited_value": amount,
            "source_reference": f"document {loc['document_id']}, location {loc['id']} ({loc.get('section')})",
        }
        line_items.append(
            {
                "line_item_key": spec["line_item_key"],
                "category": spec["category"],
                "label": spec["label"],
                "unit": spec["unit"],
                "period": spec["period"],
                "value": amount,
                "supported": True,
                "citation": citation,
                "note": None,
            }
        )
        citations.append(citation)
    return line_items, citations


def parse_spread_reply(reply: str, *, locations: list[dict]) -> dict | None:
    """Accept the agent's structured proposal only if every template line is
    present and every cited figure clears three independent checks — money is
    never taken on an LLM's word alone:

      1. the cited location is one THIS deal owns, on the document claimed;
      2. the cited text is actually about this template line (the same
         label binding the deterministic extraction uses), so a real citation
         to the wrong line — "Current Liabilities" offered as `total_debt` —
         is rejected rather than silently persisted as deal-of-record money;
      3. the asserted number is the number that cited text says.

    A reply that fails any of the three is discarded whole and the app falls
    back to the deterministic extraction rather than trusting the assertion.
    """
    loc_by_id = {loc["id"]: loc for loc in locations}
    for blob in _json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        items = parsed.get("line_items")
        if not isinstance(items, dict):
            continue
        result: dict = {}
        ok = True
        for spec in SPREAD_TEMPLATE:
            entry = items.get(spec["line_item_key"])
            if entry is None:
                ok = False
                break
            if isinstance(entry, str):
                if entry.strip().lower() != "not supported by the record":
                    ok = False
                    break
                result[spec["line_item_key"]] = None
                continue
            if not isinstance(entry, dict):
                ok = False
                break
            value = entry.get("value")
            document_id = entry.get("document_id")
            location_id = entry.get("document_location_id")
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                ok = False
                break
            # json.loads parses bare NaN/Infinity literals into floats, and
            # EVERY comparison against NaN is False — so `abs(nan - x) > 0.01`
            # below would silently PASS the grounding check and land NaN in
            # spread_line_items.value and citations.cited_value. An agent's
            # figure gets the same finite + bounded gate a human-keyed
            # override already gets; money is never taken on an LLM's word.
            if not math.isfinite(float(value)) or abs(float(value)) > MAX_SPREAD_LINE_VALUE:
                ok = False
                break
            loc = loc_by_id.get(location_id)
            if loc is None or loc.get("document_id") != document_id:
                ok = False
                break
            cited_text = str(loc.get("extracted_text") or "").strip().lower()
            if not _binds_to_spec(cited_text, spec):
                ok = False  # a real citation, but not to this template line
                break
            grounded_value = _extract_amount(loc.get("extracted_text"))
            if grounded_value is None or abs(float(value) - grounded_value) > 0.01:
                ok = False  # the cited text does not actually say this — reject, don't trust the assertion
                break
            result[spec["line_item_key"]] = {"value": float(value), "document_id": document_id, "document_location_id": location_id}
        if ok:
            return result
    return None


def _spread_content(reply: str, facts: dict) -> dict:
    """Accept the agent's structured proposal only if it validates against
    the extracted locations for this deal; otherwise fall back to the record
    itself. Either way, every figure emitted carries a citation."""
    locations = facts["locations"]
    loc_by_id = {loc["id"]: loc for loc in locations}
    parsed = parse_spread_reply(reply, locations=locations)
    if parsed is not None:
        line_items = []
        citations = []
        for spec in SPREAD_TEMPLATE:
            entry = parsed.get(spec["line_item_key"])
            if entry is None:
                line_items.append(
                    {
                        "line_item_key": spec["line_item_key"],
                        "category": spec["category"],
                        "label": spec["label"],
                        "unit": spec["unit"],
                        "period": spec["period"],
                        "value": None,
                        "supported": False,
                        "citation": None,
                        "note": "not supported by the record",
                    }
                )
                continue
            loc = loc_by_id.get(entry["document_location_id"])
            citation = {
                "document_id": entry["document_id"],
                "document_location_id": entry["document_location_id"],
                "cited_value": entry["value"],
                "source_reference": f"document {entry['document_id']}, location {entry['document_location_id']}"
                + (f" ({loc.get('section')})" if loc else ""),
            }
            line_items.append(
                {
                    "line_item_key": spec["line_item_key"],
                    "category": spec["category"],
                    "label": spec["label"],
                    "unit": spec["unit"],
                    "period": spec["period"],
                    "value": entry["value"],
                    "supported": True,
                    "citation": citation,
                    "note": None,
                }
            )
            citations.append(citation)
        source = "agent"
    else:
        line_items, citations = derive_spread(locations)
        source = "deterministic-fallback"
    unsupported = [li["line_item_key"] for li in line_items if not li["supported"]]
    if facts["document_rows"]:
        rationale = (
            f"Spread drawn from {len(facts['document_rows'])} document(s) on file; "
            f"{len(citations)} of {len(SPREAD_TEMPLATE)} template lines are supported by a cited figure."
        )
    else:
        rationale = "No documents are on file for this deal, so no template line is supported by the record."
    return {
        "spread_line_items": line_items,
        "citations": citations,
        "unsupported_line_items": unsupported,
        "rationale": rationale,
        "source": source,
        "template_version": SPREAD_TEMPLATE_VERSION,
    }


def _park_spread_draft(deal: dict, content: dict, agent_run_id, actor_user_id: str) -> dict:
    approval_item = _human_gate_for(deal, "spread", content)
    # The financial-spreading stage is a real stop on the canonical track: the
    # deal sits here while its spread is drafted and reviewed, then exits to
    # risk_grading only on acceptance (promote_draft / DRAFT_STAGE_ADVANCE).
    if deal.get("current_stage") == "document_extraction":
        record_transition(deal, "financial_spreading", actor_user_id, reason="financial spreading agent run")
    draft = store.insert(
        "agent_drafts",
        {
            "agent_run_id": agent_run_id,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "draft_type": "spread",
            "draft_content": content,
            "review_status": "pending",
            "reviewed_by_user_id": None,
            "review_action": None,
            "review_reason": None,
            "human_edits": None,
            "created_at": now_iso(),
            "reviewed_at": None,
            "approval_item_id": approval_item["id"],
        },
    )
    touch_deal(deal)
    audit_event(
        event_type="agent_draft.created",
        action="financial spread draft created (pending human acceptance)",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="agent_drafts",
        entity_id=draft["id"],
        new_values={"draft_type": "spread", "review_status": "pending", "agent_run_id": agent_run_id},
    )
    return draft


def adopt_workflow_spread(deal: dict, actor_user_id: str) -> dict | None:
    """Turn the workflow's OWN spread_financials node output into the pending
    draft — the same adoption pattern as the intake triage node, so the
    agent is never prompted twice for the same run."""
    run_id = deal.get("workflow_run_id")
    if not run_id or pending_draft(deal["id"], "spread") is not None:
        return None
    try:
        context = workflow_engine.state(run_id).get("context") or {}
    except Exception:
        return None
    reply = (context.get("spread_financials") or {}).get("reply")
    if not reply:
        return None

    facts = spread_prompt_inputs(deal)
    started = time.perf_counter()
    content = _spread_content(reply, facts)
    latency_ms = int((time.perf_counter() - started) * 1000)
    model = model_id()
    tokens_in, tokens_out = _estimate_tokens(build_spread_prompt(deal, facts)), _estimate_tokens(reply)
    cost_row = costmeter.record(model, tokens_in, tokens_out)
    run = store.insert(
        "agent_runs",
        {
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "agent_type": "financial_spreading",
            "agent_name": SPREAD_AGENT_NAME,
            "run_stage": "financial_spreading",
            "model_id": model,
            "prompt_template_version": prompt_version(SPREAD_PROMPT_NAME),
            "inputs": spread_run_inputs(deal, facts) | {"workflow_run_id": run_id, "workflow_node": "spread_financials"},
            "raw_output": pii.redact(reply)[:4000],
            "latency_ms": latency_ms,
            "token_cost": cost_row["usd"],
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "ran_at": now_iso(),
            "error": None,
        },
    )
    _log("agent.run", agent="financial_spreading", deal_reference=deal["deal_reference"], agent_run_id=run["id"], source="workflow")
    return _park_spread_draft(deal, content, run["id"], actor_user_id)


def build_spread_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the financial spreading agent directly and park the result as a
    PENDING draft. Used when there is no unconsumed workflow output to adopt
    — a re-spread after a rejection, say."""
    facts = spread_prompt_inputs(deal)
    outcome = run_agent(
        agent_name=SPREAD_AGENT_NAME,
        prompt=build_spread_prompt(deal, facts),
        deal=deal,
        agent_type="financial_spreading",
        run_stage="financial_spreading",
        prompt_name=SPREAD_PROMPT_NAME,
        inputs=spread_run_inputs(deal, facts),
    )
    return _park_spread_draft(deal, _spread_content(outcome["reply"], facts), outcome["run"]["id"], actor_user_id)


def spread_line_items_for(deal_id) -> list[dict]:
    """The deal's CURRENT spread of record.

    A rejected spread can be re-run and re-accepted, so more than one
    generation of rows can exist. Superseded rows are never deleted (the
    record is append-only and an examiner must still see them), but they are
    not deal-of-record any more and must never reach the ratio computation.
    """
    return [
        r
        for r in store.list("spread_line_items")
        if r.get("deal_id") == deal_id and not r.get("superseded_at")
    ]


def superseded_spread_line_items_for(deal_id) -> list[dict]:
    return [
        r for r in store.list("spread_line_items") if r.get("deal_id") == deal_id and r.get("superseded_at")
    ]


def citations_for(deal_id) -> list[dict]:
    return [r for r in store.list("citations") if r.get("deal_id") == deal_id and not r.get("superseded_at")]


def _persist_spread_rows(deal: dict, content: dict, actor_user_id: str) -> tuple[list, list, int]:
    """Human acceptance (or the workflow node confirming it) is the act that
    turns the drafted spread into structured deal-of-record line items with
    their citations — REQ-037."""
    line_item_ids = []
    citation_ids = []
    # A rejected spread can be re-drafted and accepted again. Mark the prior
    # generation superseded (never deleted — the trail stays append-only)
    # instead of leaving two sets of figures standing as deal of record.
    stale = spread_line_items_for(deal["id"])
    if stale:
        # ONLY the citations that hang off those spread line items. `citations`
        # is a shared table — a ratio's or a memo's footnote (ratio_id /
        # policy_rule_id) lives here too, and superseding a spread must never
        # silently retire someone else's traceability.
        stale_ids = {row["id"] for row in stale}
        stale_citations = [c for c in citations_for(deal["id"]) if c.get("spread_line_item_id") in stale_ids]
        stamp = now_iso()
        for row in stale:
            before = dict(row)
            row["superseded_at"] = stamp
            save_row("spread_line_items", row, actor_user_id=actor_user_id, before=before)
        for row in stale_citations:
            before = dict(row)
            row["superseded_at"] = stamp
            save_row("citations", row, actor_user_id=actor_user_id, before=before)
        audit_event(
            event_type="spread.superseded",
            action="previous spread of record superseded by a newly accepted spread",
            actor_user_id=actor_user_id,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            old_values={
                "line_item_count": len(stale),
                "citation_count": len(stale_citations),
                "spread_line_item_ids": sorted(stale_ids),
                "citation_ids": sorted(c["id"] for c in stale_citations),
                "superseded_at": stamp,
            },
        )
    for item in content.get("spread_line_items", []) or []:
        row = store.insert(
            "spread_line_items",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "line_item_key": item["line_item_key"],
                "category": item.get("category"),
                "label": item.get("label"),
                "value": item.get("value"),
                "unit": item.get("unit"),
                "period": item.get("period"),
            },
        )
        line_item_ids.append(row["id"])
        citation = item.get("citation")
        if citation:
            citation_row = store.insert(
                "citations",
                {
                    "deal_id": deal["id"],
                    "cited_value": citation.get("cited_value"),
                    "source_type": "document_location" if citation.get("document_location_id") else "human_override",
                    "source_reference": citation.get("source_reference"),
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                    "spread_line_item_id": row["id"],
                    "ratio_id": None,
                    "policy_rule_id": None,
                    "created_at": now_iso(),
                },
            )
            citation_ids.append(citation_row["id"])
    audit = audit_event(
        event_type="spread.persisted",
        action="financial spread persisted as deal-of-record data with citations",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="spread_line_items",
        # The examiner's question is "which numbers became the record, and
        # which of them did a human key rather than cite?" — a count cannot
        # answer it, so the values and their source land in the trail itself.
        new_values={
            "line_item_count": len(line_item_ids),
            "citation_count": len(citation_ids),
            "values": {
                item["line_item_key"]: item.get("value")
                for item in content.get("spread_line_items", []) or []
            },
            "human_overridden_line_items": sorted(
                item["line_item_key"]
                for item in content.get("spread_line_items", []) or []
                if (item.get("citation") or {}).get("document_location_id") is None and item.get("supported")
            ),
            "unsupported_line_items": list(content.get("unsupported_line_items") or []),
        },
    )
    return line_item_ids, citation_ids, audit["id"]


def handler_persist_spread_line_items(context: dict) -> dict:
    """deal-underwriting/persist_spread — the human accept endpoint already
    writes these rows (promote_draft); this node confirms the same
    deal-of-record data exists and is idempotent when the workflow reaches it
    on its own march."""
    deal = _wf_deal(context)
    existing = spread_line_items_for(deal["id"])
    accepted_draft = None
    for row in reversed(drafts_for(deal["id"], "spread")):
        if row.get("review_status") in ("accepted", "edited"):
            accepted_draft = row
            break
    if existing:
        reviewer = (accepted_draft or {}).get("reviewed_by_user_id") or deal.get("submitted_by_user_id")
        audit = audit_event(
            event_type="spread.persist_confirmed",
            action="spread line items already on file; workflow node confirms persistence",
            actor_user_id=reviewer,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            new_values={"line_item_count": len(existing)},
        )
        return {
            "deal_id": deal["deal_reference"],
            "spread_line_item_ids": [r["id"] for r in existing],
            # Only the citations hanging off THIS spread's line items: the
            # citations table is shared with ratio and memo footnotes from
            # slice 3 on, so reporting every citation on the deal would make
            # the node's contract grow silently under later slices.
            "citation_ids": [
                c["id"]
                for c in citations_for(deal["id"])
                if c.get("spread_line_item_id") in {r["id"] for r in existing}
            ],
            "reviewed_by_user_id": reviewer,
            "audit_log_id": audit["id"],
        }
    if accepted_draft is None:
        raise workflow_engine.WorkflowError("spread draft has not been accepted by a named human")
    reviewer = accepted_draft.get("reviewed_by_user_id")
    line_item_ids, citation_ids, audit_id = _persist_spread_rows(deal, accepted_draft["draft_content"], reviewer)
    return {
        "deal_id": deal["deal_reference"],
        "spread_line_item_ids": line_item_ids,
        "citation_ids": citation_ids,
        "reviewed_by_user_id": reviewer,
        "audit_log_id": audit_id,
    }


# --------------------------------------------------------------------------
# Draft Review workspace — cross-draft-type queue and evidence (REQ-046)
# --------------------------------------------------------------------------

ARTIFACT_LABELS = {
    "triage": "Triage classification",
    "spread": "Financial spread",
    "memo": "Credit memo",
    "compliance": "Policy exception set",
}

AGENT_STAGE_LABELS = {
    "triage": "1 · Intake triage",
    "spread": "2 · Financial spreading",
    "memo": "3 · Credit memo drafting",
    "compliance": "4 · Policy compliance",
}


def agent_run_row(run_id) -> dict | None:
    for row in store.list("agent_runs"):
        if row["id"] == run_id:
            return row
    return None


def all_drafts() -> list[dict]:
    return store.list("agent_drafts")


def draft_queue_view(draft: dict) -> dict:
    deal = find_deal(draft.get("deal_reference")) or {}
    run = agent_run_row(draft.get("agent_run_id")) or {}
    content = draft.get("draft_content") or {}
    draft_type = draft.get("draft_type")
    return {
        "id": draft["id"],
        "deal_reference": draft.get("deal_reference"),
        "borrower_name": deal.get("borrower_name"),
        "draft_type": draft_type,
        "artifact_label": ARTIFACT_LABELS.get(draft_type, str(draft_type or "").replace("_", " ").title()),
        "agent_label": AGENT_STAGE_LABELS.get(draft_type, str(draft_type or "")),
        "agent_name": run.get("agent_name"),
        "review_status": draft.get("review_status"),
        "model_id": run.get("model_id"),
        "prompt_template_version": run.get("prompt_template_version"),
        "latency_ms": run.get("latency_ms"),
        "token_cost": run.get("token_cost"),
        "tokens_in": run.get("tokens_in"),
        "tokens_out": run.get("tokens_out"),
        "total_tokens": (run.get("tokens_in") or 0) + (run.get("tokens_out") or 0) if run else None,
        "source": content.get("source"),
        "created_at": draft.get("created_at"),
        "age_business_days": business_days_idle(draft.get("created_at")),
        "reviewed_by_user_id": draft.get("reviewed_by_user_id"),
    }


def draft_evidence(deal_id, draft_type: str, content: dict) -> list[dict]:
    """The 'Cited Evidence' panel's data: every source the draft can point
    to, resolved back to the actual document + location text."""
    documents = {d["id"]: d for d in documents_for(deal_id)}
    locations = {loc["id"]: loc for loc in locations_for(documents.keys())}
    items: list[dict] = []
    if draft_type == "spread":
        for citation in content.get("citations", []) or []:
            loc = locations.get(citation.get("document_location_id"))
            doc = documents.get(citation.get("document_id"))
            filename = (doc or {}).get("original_filename") or f"document {citation.get('document_id')}"
            section = (loc or {}).get("section") or ""
            items.append(
                {
                    "source": f"{filename} · loc {citation.get('document_location_id')}" + (f" ({section})" if section else ""),
                    "detail": (loc or {}).get("extracted_text") or citation.get("source_reference") or "",
                    "cited_value": citation.get("cited_value"),
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                }
            )
        return items
    # triage (and any other draft_type without a dedicated citation list):
    # ground it in the deal's extracted document locations directly.
    for loc in list(locations.values())[:20]:
        doc = documents.get(loc["document_id"])
        filename = (doc or {}).get("original_filename") or f"document {loc['document_id']}"
        items.append(
            {
                "source": f"{filename} · loc {loc['id']}" + (f" ({loc.get('section')})" if loc.get("section") else ""),
                "detail": loc.get("extracted_text") or "",
                "cited_value": None,
                "document_id": loc["document_id"],
                "document_location_id": loc["id"],
            }
        )
    return items


# --------------------------------------------------------------------------
# Draft review — the human gate that promotes agent output to deal-of-record
# --------------------------------------------------------------------------

REVIEW_ACTIONS = ("accepted", "edited", "rejected")


def assign_to_queue(deal: dict, queue_id: str, actor_user_id: str) -> dict:
    queue = queue_by_id(queue_id)
    if queue is None:
        raise DomainError(400, f"unknown analyst queue '{queue_id}'")
    existing = [q for q in store.list("analyst_queues") if q.get("deal_id") == deal["id"] and q.get("queue_status") == "open"]
    if existing:
        return existing[-1]
    # assignment module owns fairness; a single-analyst queue resolves to that analyst
    analyst = assignment.least_loaded(
        [queue["analyst_user_id"]],
        lambda user: len([q for q in store.list("analyst_queues") if q.get("analyst_user_id") == user and q.get("queue_status") == "open"]),
    )
    row = store.insert(
        "analyst_queues",
        {
            "analyst_user_id": analyst,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "queue_id": queue["queue_id"],
            "queue_label": queue["label"],
            "queue_status": "open",
            "added_at": now_iso(),
        },
    )
    before = dict(deal)
    deal["assigned_analyst_id"] = analyst
    save_row("deals", deal, actor_user_id=actor_user_id, before=before)
    audit_event(
        event_type="deal.routed",
        action=f"assigned to analyst queue {queue['queue_id']}",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="analyst_queues",
        entity_id=row["id"],
        new_values={"assigned_analyst_id": analyst, "queue_id": queue["queue_id"]},
    )
    return row


def review_draft(*, deal: dict, draft_type: str, action: str, actor: dict, reason: str | None, edits: dict | None) -> dict:
    if action not in REVIEW_ACTIONS:
        raise DomainError(400, f"action must be one of {list(REVIEW_ACTIONS)}")
    reason_text = (reason or "").strip()
    if action == "rejected" and not reason_text:
        raise DomainError(400, "a written reason is required to reject an agent draft")
    # An edit to a spread REPLACES a cited figure with a hand-keyed number and
    # persists it as deal-of-record money. That is at least as consequential as
    # a rejection, so it carries the same written-reason obligation — the audit
    # trail must say why the record differs from the documents.
    if action == "edited" and draft_type == "spread" and not reason_text:
        raise DomainError(400, "a written reason is required to override a spread figure by hand")
    # Separation of duties (FSI hardening rule 3): the human gate on an agent
    # draft is not load-bearing if the person who originated the deal can also
    # be the one who accepts the draft on it. Roles alone do not prevent that —
    # a credit officer may both submit and review — so the submitter is barred
    # from dispositioning drafts on their own deal.
    if actor["username"] == deal.get("submitted_by_user_id"):
        raise DomainError(
            403,
            f"segregation of duties: {actor['username']} submitted deal "
            f"{deal['deal_reference']} and may not also review its agent drafts",
        )

    draft = pending_draft(deal["id"], draft_type)
    if draft is None:
        raise DomainError(409, f"no pending '{draft_type}' draft on deal {deal['deal_reference']}")

    content = dict(draft["draft_content"])
    applied_edits = None
    if action == "edited":
        applied_edits = _apply_edits(draft_type, content, edits or {})

    before = dict(draft)
    draft["review_status"] = action
    draft["review_action"] = action
    draft["reviewed_by_user_id"] = actor["username"]
    draft["review_reason"] = reason_text or None
    draft["human_edits"] = applied_edits
    draft["draft_content"] = content
    draft["reviewed_at"] = now_iso()
    save_row("agent_drafts", draft, actor_user_id=actor["username"], before=before)

    item_id = draft.get("approval_item_id")
    if item_id is not None:
        try:
            if action == "rejected":
                approval_flow.reject(item_id, actor["username"], reason_text)
            else:
                approval_flow.approve(item_id, actor["username"], reason_text or f"{draft_type} draft {action}")
        except (approval_flow.IllegalTransition, KeyError):
            pass  # already dispositioned; the draft row remains the record

    audit_event(
        event_type=f"agent_draft.{action}",
        action=f"{draft_type} draft {action} by named human",
        actor_user_id=actor["username"],
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="agent_drafts",
        entity_id=draft["id"],
        old_values={"review_status": "pending"},
        new_values={"review_status": action, "reviewed_by_user_id": actor["username"]},
        details={"reason": reason_text} if reason_text else {},
    )

    promoted: dict = {}
    if action in ("accepted", "edited"):
        promoted = promote_draft(deal, draft_type, content, actor)
    else:
        touch_deal(deal)

    # The human decision was recorded on the approval item above; now let the
    # approved process resume from its parked human node. tick() is
    # deterministic and re-entrant, and every handler it reaches is idempotent.
    promoted["workflow"] = resume_workflow(deal)
    return {"draft": draft, "promoted": promoted}


def resume_workflow(deal: dict) -> dict | None:
    run_id = deal.get("workflow_run_id")
    if not run_id:
        return None
    try:
        state = workflow_engine.tick(run_id)
    except Exception as exc:
        _log("workflow.tick_failed", deal_reference=deal.get("deal_reference"), error=str(exc)[:120])
        return {"run_id": run_id, "status": "error"}
    return {"run_id": run_id, "status": state.get("status"), "approval_id": state.get("approval_id")}


def _apply_edits(draft_type: str, content: dict, edits: dict) -> dict:
    applied = {}
    if draft_type == "triage":
        if "classification" in edits:
            value = str(edits["classification"])
            if value not in FACILITY_TYPES:
                raise DomainError(400, f"classification must be one of {sorted(FACILITY_TYPES)}")
            applied["classification"] = {"from": content.get("classification"), "to": value}
            content["classification"] = value
            content["classification_label"] = FACILITY_TYPES[value]["label"]
        if "proposed_queue" in edits:
            queue = queue_by_id(str(edits["proposed_queue"]))
            if queue is None:
                raise DomainError(400, "proposed_queue must be a known analyst queue id")
            applied["proposed_queue"] = {"from": content.get("proposed_queue"), "to": queue["queue_id"]}
            content["proposed_queue"] = queue["queue_id"]
            content["proposed_queue_label"] = queue["label"]
            content["proposed_analyst_user_id"] = queue["analyst_user_id"]
        if "missing_documents" in edits:
            values = edits["missing_documents"]
            if not isinstance(values, list) or any(v not in DOCUMENT_TYPES for v in values):
                raise DomainError(400, "missing_documents must be a list of known document types")
            applied["missing_documents"] = {"from": content.get("missing_documents"), "to": values}
            content["missing_documents"] = list(values)
            content["missing_document_labels"] = [DOCUMENT_TYPE_LABELS.get(v, v) for v in values]
    if draft_type == "spread":
        values = edits.get("line_item_values")
        if values is not None:
            if not isinstance(values, dict) or not values:
                raise DomainError(400, "spread edits must supply line_item_values as a mapping of line_item_key to a numeric value")
            items = {item["line_item_key"]: item for item in content.get("spread_line_items", [])}
            changed = {}
            for key, raw_value in values.items():
                if key not in items:
                    raise DomainError(400, f"unknown spread line item '{key}'")
                if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
                    raise DomainError(400, f"line item '{key}' value must be numeric")
                numeric = float(raw_value)
                # json.loads accepts NaN/Infinity literals — neither is a
                # figure that may reach the deal of record.
                if not math.isfinite(numeric):
                    raise DomainError(400, f"line item '{key}' value must be a finite number")
                if abs(numeric) > MAX_SPREAD_LINE_VALUE:
                    raise DomainError(400, f"line item '{key}' value exceeds the {MAX_SPREAD_LINE_VALUE:,} spread-figure limit")
                changed[key] = numeric
            applied["line_item_values"] = {}
            new_items = []
            for item in content.get("spread_line_items", []):
                item = dict(item)
                if item["line_item_key"] in changed:
                    new_value = changed[item["line_item_key"]]
                    applied["line_item_values"][item["line_item_key"]] = {"from": item.get("value"), "to": new_value}
                    item["value"] = new_value
                    item["supported"] = True
                    item["note"] = None
                    # A human override is still a citation — it names the person
                    # as the source instead of a document location, so the
                    # traceability chain never silently loses "who changed this".
                    item["citation"] = {
                        "document_id": None,
                        "document_location_id": None,
                        "cited_value": new_value,
                        "source_reference": "human-edited override by the reviewing analyst",
                    }
                new_items.append(item)
            content["spread_line_items"] = new_items
            content["citations"] = [item["citation"] for item in new_items if item.get("citation")]
            content["unsupported_line_items"] = [item["line_item_key"] for item in new_items if not item.get("supported")]
    if not applied:
        raise DomainError(400, "an edited review must supply at least one recognised edit")
    content["source"] = "human-edited"
    return applied


def promote_draft(deal: dict, draft_type: str, content: dict, actor: dict) -> dict:
    """Human acceptance is the act that turns a draft into deal-of-record data."""
    promoted: dict = {}
    if draft_type == "triage":
        queue_row = assign_to_queue(deal, content["proposed_queue"], actor["username"])
        promoted["analyst_queue_id"] = queue_row["id"]
        promoted["assigned_analyst_id"] = queue_row["analyst_user_id"]
    if draft_type == "spread":
        line_item_ids, citation_ids, audit_id = _persist_spread_rows(deal, content, actor["username"])
        promoted["spread_line_item_ids"] = line_item_ids
        promoted["citation_ids"] = citation_ids
        promoted["spread_audit_log_id"] = audit_id
    stages = DRAFT_STAGE_ADVANCE.get(draft_type)
    if stages and deal.get("current_stage") == stages[0]:
        transition = record_transition(deal, stages[1], actor["username"])
        promoted["stage_transition_id"] = transition["id"]
    promoted["current_stage"] = deal.get("current_stage")
    touch_deal(deal)
    return promoted


# --------------------------------------------------------------------------
# Read models
# --------------------------------------------------------------------------


def deal_view(deal: dict) -> dict:
    document_rows = documents_for(deal["id"])
    drafts = drafts_for(deal["id"])
    queue_rows = [q for q in store.list("analyst_queues") if q.get("deal_id") == deal["id"]]
    view = dict(deal)
    view["stage_index"] = STAGES.index(deal["current_stage"]) + 1 if deal.get("current_stage") in STAGES else None
    view["stage_label"] = STAGE_LABELS.get(deal.get("current_stage"), deal.get("current_stage"))
    view["document_count"] = len(document_rows)
    view["document_types"] = sorted({d["document_type"] for d in document_rows})
    view["pending_draft_types"] = sorted({d["draft_type"] for d in drafts if d.get("review_status") == "pending"})
    view["analyst_queue"] = queue_rows[-1]["queue_id"] if queue_rows else None
    view["analyst_queue_label"] = queue_rows[-1].get("queue_label") if queue_rows else None
    view["required_documents"] = required_documents_for(deal.get("facility_type", ""))
    view["facility_label"] = FACILITY_TYPES.get(deal.get("facility_type"), {}).get("label", deal.get("facility_type"))
    view["submitter_role"] = (get_user(deal.get("submitted_by_user_id")) or {}).get("role")
    return view


# The columns the Pipeline Board and the deal list actually render. An
# un-identified caller gets these and nothing else: slice 1's acceptance
# constrains which DEALS come back, never which columns, so borrower contact
# details, masked TIN, stated purpose, collateral description and the internal
# correlation/fingerprint fields have no reason to travel to a caller who has
# not named a seat.
PUBLIC_DEAL_FIELDS = (
    "id",
    "deal_reference",
    "borrower_name",
    "borrower_industry",
    "borrower_state",
    "facility_type",
    "facility_label",
    "requested_amount",
    "exposure_amount",
    "approval_tier",
    "tier_rule_version",
    "current_stage",
    "stage_index",
    "stage_label",
    "assigned_analyst_id",
    "submitted_by_user_id",
    "submitter_role",
    "analyst_queue",
    "analyst_queue_label",
    "document_count",
    "document_types",
    "pending_draft_types",
    "required_documents",
    "created_at",
    "last_activity_at",
    "closed_at",
    "is_closed",
    "business_days_idle",
)


def public_deal_view(view: dict) -> dict:
    """Board-column projection of a deal for an un-entitled caller."""
    return {k: v for k, v in view.items() if k in PUBLIC_DEAL_FIELDS}


def pipeline_board(username: str | None = None) -> dict:
    deals = [deal_view(d) for d in visible_deals(username)]
    active = [d for d in deals if not d.get("is_closed")]
    counts = {stage: 0 for stage in STAGES}
    for deal in active:
        if deal.get("current_stage") in counts:
            counts[deal["current_stage"]] += 1
    # Draft counts are scoped the same way, so the board's headline numbers can
    # never describe deals the caller is not entitled to see.
    visible_ids = {d.get("id") for d in deals}
    pending_drafts = [
        d
        for d in store.list("agent_drafts")
        if d.get("review_status") == "pending" and d.get("deal_id") in visible_ids
    ]
    return {
        "stages": [
            {"index": index + 1, "slug": slug, "label": STAGE_LABELS[slug], "count": counts[slug]}
            for index, slug in enumerate(STAGES)
        ],
        "deals": deals,
        "totals": {
            "active_deals": len(active),
            "live_exposure": round(sum(float(d.get("exposure_amount") or 0) for d in active), 2),
            "pending_drafts": len(pending_drafts),
            "approvals_due": counts["tiered_approval"],
            "tier_counts": {
                tier: len([d for d in active if d.get("approval_tier") == tier])
                for tier in ("analyst", "officer", "committee")
            },
        },
    }


def business_days_idle(last_activity_at: str | None, now: datetime.datetime | None = None) -> int:
    """Business-day idle time (Mon-Fri). Deterministic code, never an agent."""
    if not last_activity_at:
        return 0
    try:
        start = datetime.datetime.fromisoformat(str(last_activity_at).replace("Z", "+00:00"))
    except ValueError:
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    days = 0
    cursor = start.date()
    end = now.date()
    while cursor < end:
        cursor += datetime.timedelta(days=1)
        if cursor.weekday() < 5:
            days += 1
    return days


# --------------------------------------------------------------------------
# Workflow handlers — workflows/workflows.json node contracts (deal-underwriting)
# --------------------------------------------------------------------------


def _wf_deal(context: dict) -> dict:
    reference = (context.get("register_deal") or {}).get("deal_id")
    if not reference:
        raise workflow_engine.WorkflowError("register_deal has not run for this workflow run")
    deal = find_deal(reference)
    if deal is None:
        raise workflow_engine.WorkflowError(f"deal '{reference}' is not on file")
    return deal


def handler_create_deal_at_intake(context: dict) -> dict:
    payload = validate_submission(context.get("inputs") or {})
    actor = resolve_actor(None, (context.get("inputs") or {}).get("submitted_by"), SUBMIT_ROLES)
    existing = find_deal(payload["deal_reference"])
    if existing is not None:
        deal = existing
    else:
        exposure = exposure_for(payload["requested_amount"])
        deal = store.insert(
            "deals",
            {
                "deal_reference": payload["deal_reference"],
                "borrower_name": payload["borrower_name"],
                "borrower_industry": payload["borrower_industry"],
                "borrower_state": payload["borrower_state"],
                "borrower_dba": payload["borrower_dba"],
                "borrower_tin_masked": payload["borrower_tin_masked"],
                "borrower_established": payload["borrower_established"],
                "borrower_address": payload["borrower_address"],
                "facility_type": payload["facility_type"],
                "requested_amount": payload["requested_amount"],
                "collateral_value": payload["collateral_value"],
                "collateral_description": payload["collateral_description"],
                "term_months": payload["term_months"],
                "purpose": payload["purpose"],
                "exposure_amount": exposure,
                "approval_tier": derive_approval_tier(exposure),
                "tier_rule_version": TIER_RULE_VERSION,
                "current_stage": STAGES[0],
                "assigned_analyst_id": None,
                "submitted_by_user_id": actor["username"],
                "created_at": now_iso(),
                "last_activity_at": now_iso(),
                "closed_at": None,
                "is_closed": False,
                "submission_fingerprint": submission_fingerprint(context.get("inputs") or {}),
            },
        )
        audit_event(
            event_type="deal.created",
            action="deal submitted at intake",
            actor_user_id=actor["username"],
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="deals",
            entity_id=deal["id"],
            new_values={
                "current_stage": deal["current_stage"],
                "exposure_amount": deal["exposure_amount"],
                "approval_tier": deal["approval_tier"],
            },
        )
        record_transition(deal, STAGES[0], actor["username"], reason="deal submitted at intake")
    return {
        "deal_id": deal["deal_reference"],
        "deal_row_id": deal["id"],
        "borrower_name": deal["borrower_name"],
        "borrower_industry": deal["borrower_industry"],
        "facility_type": deal["facility_type"],
        "requested_amount": deal["requested_amount"],
        "exposure_amount": deal["exposure_amount"],
        "approval_tier": deal["approval_tier"],
        "submitted_by_user_id": deal["submitted_by_user_id"],
        "current_stage": deal["current_stage"],
        "last_activity_at": deal["last_activity_at"],
    }


def handler_store_borrower_documents(context: dict) -> dict:
    deal = _wf_deal(context)
    existing = documents_for(deal["id"])
    if existing:
        rows = existing
        audit_id = audit_event(
            event_type="deal.documents_already_on_file",
            action=f"{len(rows)} borrower document(s) already stored for this deal; nothing re-written",
            actor_user_id=deal["submitted_by_user_id"],
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="documents",
            new_values={"document_count": len(rows)},
        )["id"]
    else:
        payload = validate_submission(context.get("inputs") or {})
        rows = store_documents(deal, payload["documents"], deal["submitted_by_user_id"])
        audit_id = audit_event(
            event_type="deal.documents_stored",
            action=f"stored {len(rows)} borrower document(s) at intake",
            actor_user_id=deal["submitted_by_user_id"],
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="documents",
            new_values={"document_count": len(rows)},
        )["id"]
    return {
        "document_ids": [r["id"] for r in rows],
        "document_types": sorted({r["document_type"] for r in rows}),
        "document_count": len(rows),
        "audit_log_id": audit_id,
    }


def handler_extract_document_locations(context: dict) -> dict:
    deal = _wf_deal(context)
    document_rows = documents_for(deal["id"])
    already = locations_for([d["id"] for d in document_rows])
    if already:
        return {
            "document_location_ids": [loc["id"] for loc in already],
            "extracted_page_count": _page_count(document_rows, already),
            "unextractable_document_ids": [d["id"] for d in document_rows if not any(loc["document_id"] == d["id"] for loc in already)],
        }
    return extract_documents(deal, document_rows, deal["submitted_by_user_id"])


def handler_assign_deal_to_analyst_queue(context: dict) -> dict:
    deal = _wf_deal(context)
    draft = None
    for row in reversed(drafts_for(deal["id"], "triage")):
        if row.get("review_status") in ("accepted", "edited"):
            draft = row
            break
    if draft is None:
        raise workflow_engine.WorkflowError("triage draft has not been accepted by a named human")
    actor_username = draft.get("reviewed_by_user_id") or deal["submitted_by_user_id"]
    queue_row = assign_to_queue(deal, draft["draft_content"]["proposed_queue"], actor_username)
    to_stage = "document_extraction"
    if deal.get("current_stage") == "intake":
        transition_id = record_transition(deal, to_stage, actor_username)["id"]
    else:
        # already advanced (the review endpoint moved it) — name the transition
        # of record rather than returning a null the next node would render.
        prior = [t for t in store.list("stage_transitions") if t.get("deal_id") == deal["id"] and t.get("to_stage") == to_stage]
        transition_id = prior[-1]["id"] if prior else record_transition(deal, to_stage, actor_username)["id"]
    audit = audit_event(
        event_type="deal.queue_assigned",
        action="analyst queue assignment confirmed",
        actor_user_id=actor_username,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="analyst_queues",
        entity_id=queue_row["id"],
        new_values={"queue_id": queue_row["queue_id"], "to_stage": deal.get("current_stage")},
    )
    return {
        "deal_id": deal["deal_reference"],
        "assigned_analyst_id": queue_row["analyst_user_id"],
        "analyst_queue_id": queue_row["id"],
        "to_stage": deal.get("current_stage") or to_stage,
        "stage_transition_id": transition_id,
        "audit_log_id": audit["id"],
    }


def register_handlers() -> None:
    workflow_engine.register_handler("create_deal_at_intake", handler_create_deal_at_intake)
    workflow_engine.register_handler("store_borrower_documents", handler_store_borrower_documents)
    workflow_engine.register_handler("extract_document_locations", handler_extract_document_locations)
    workflow_engine.register_handler("assign_deal_to_analyst_queue", handler_assign_deal_to_analyst_queue)
    workflow_engine.register_handler("persist_spread_line_items", handler_persist_spread_line_items)


def start_intake_workflow(payload: dict) -> tuple[str | None, int]:
    """Run the approved `deal-underwriting` process for a submission.

    The engine performs the deterministic intake writes, runs the triage agent
    node, then parks on the `triage_review` human node — exactly where the
    process definition says a named human takes over. Returns the run id and
    the run's wall-clock duration in milliseconds.
    """
    started = time.perf_counter()
    payload = dict(payload)
    # A run's inputs are readable through the workflow-run endpoints, so the
    # full TIN never enters them. mask_tin is idempotent, so the create handler
    # still lands exactly the same borrower_tin_masked on the deal of record.
    if payload.get("borrower_tin"):
        payload["borrower_tin"] = mask_tin(payload["borrower_tin"])
    try:
        run_id = workflow_engine.start("deal-underwriting", dict(payload))
    except workflow_engine.WorkflowError as exc:
        _log("workflow.start_failed", workflow="deal-underwriting", error=str(exc)[:120])
        run_id = None
    return run_id, int((time.perf_counter() - started) * 1000)


seed_users()
register_handlers()
