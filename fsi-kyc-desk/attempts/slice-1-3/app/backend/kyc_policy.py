"""Versioned KYC policy corpus — the mechanical rules the desk is bound by.

This module holds the *content* of the approved policy artefacts (document
checklist, risk rating matrix, escalation/SLA policy, onboarding policy) plus
the pure functions that evaluate them. It performs no storage and no I/O:
persistence goes through db.store in ext_cases.py, per the app conventions.

Every artefact carries a version so a past case can be reproduced exactly.
"""
from datetime import datetime, time, timedelta, timezone

# --------------------------------------------------------------------------
# Versions of the approved policy artefacts
# --------------------------------------------------------------------------
DOCUMENT_CHECKLIST_VERSION = "2.0"
RISK_MATRIX_VERSION = "2.1"
ONBOARDING_POLICY_VERSION = "3.2"
SLA_POLICY_VERSION = "1.4"

# --------------------------------------------------------------------------
# Document Checklist v2.0
# --------------------------------------------------------------------------
BASE_REQUIRED_DOCUMENTS = {
    "corporate": [
        "certificate_of_incorporation",
        "register_of_directors",
        "beneficial_ownership_declaration",
        "proof_of_registered_address",
    ],
    "individual": [
        "government_photo_id",
        "proof_of_registered_address",
    ],
}

# Conditional items: (document_type, trigger id, human description, predicate)
CONDITIONAL_DOCUMENTS = [
    {
        "document_type": "structure_chart",
        "condition_trigger": "ownership_chain_depth_over_2",
        "description": "Required when the ownership chain is deeper than two layers.",
    },
    {
        "document_type": "operating_license",
        "condition_trigger": "regulated_industry",
        "description": "Required when the applicant operates in a regulated industry.",
    },
    {
        "document_type": "expected_activity_questionnaire",
        "condition_trigger": "cross_border_activity_expected",
        "description": "Required when cross-border activity is expected.",
    },
]


def _truthy(value):
    return value is True or str(value).strip().lower() in ("true", "yes", "1")


def _conditional_triggered(document_type, attributes, risk_factors):
    attributes = attributes or {}
    risk_factors = risk_factors or {}
    if document_type == "structure_chart":
        try:
            depth = int(attributes.get("ownership_chain_depth") or 0)
        except (TypeError, ValueError):
            depth = 0
        return depth > 2 or risk_factors.get("entity_structure") == "chain_depth_over_3"
    if document_type == "operating_license":
        return _truthy(attributes.get("regulated_industry")) or risk_factors.get("industry") == "money_services"
    if document_type == "expected_activity_questionnaire":
        return _truthy(attributes.get("cross_border_expected")) or risk_factors.get("expected_activity") in (
            "cross_border_over_1m",
            "high_volume_cash",
        )
    return False


def checklist_definition(entity_type="corporate"):
    """The published checklist — what /checklist serves and the case is judged against."""
    base = BASE_REQUIRED_DOCUMENTS.get((entity_type or "corporate").lower(), BASE_REQUIRED_DOCUMENTS["corporate"])
    return {
        "version": DOCUMENT_CHECKLIST_VERSION,
        "document": "document-checklist",
        "entity_type": (entity_type or "corporate").lower(),
        "waivable": False,
        "waiver_policy": (
            "No required or conditionally-required document may be waived by any role. "
            "Only a compliance_officer may record a documented policy exception."
        ),
        "always_required": [
            {"document_type": d, "required": True, "conditionally_required": False, "condition_trigger": None}
            for d in base
        ],
        "conditionally_required": [
            {
                "document_type": c["document_type"],
                "required": False,
                "conditionally_required": True,
                "condition_trigger": c["condition_trigger"],
                "description": c["description"],
            }
            for c in CONDITIONAL_DOCUMENTS
        ],
        "entity_types": {k: list(v) for k, v in BASE_REQUIRED_DOCUMENTS.items()},
    }


def evaluate_completeness(entity_type, documents, attributes, risk_factors):
    """Purely mechanical completeness check — no judgement, no waivers."""
    base = BASE_REQUIRED_DOCUMENTS.get((entity_type or "corporate").lower(), BASE_REQUIRED_DOCUMENTS["corporate"])
    received = [str(d).strip().lower() for d in (documents or []) if str(d).strip()]
    items = []
    triggers = []
    for doc in base:
        items.append(
            {
                "document_type": doc,
                "required": True,
                "conditionally_required": False,
                "condition_trigger": None,
                "received": doc in received,
            }
        )
    for cond in CONDITIONAL_DOCUMENTS:
        triggered = _conditional_triggered(cond["document_type"], attributes, risk_factors)
        if triggered:
            triggers.append(cond["condition_trigger"])
        items.append(
            {
                "document_type": cond["document_type"],
                "required": triggered,
                "conditionally_required": True,
                "condition_trigger": cond["condition_trigger"] if triggered else None,
                "received": cond["document_type"] in received,
            }
        )
    required_types = [i["document_type"] for i in items if i["required"]]
    missing = [i["document_type"] for i in items if i["required"] and not i["received"]]
    return {
        "is_complete": not missing,
        "items": items,
        "required_document_types": required_types,
        "received_document_types": received,
        "missing_documents": missing,
        "conditional_triggers_applied": triggers,
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
    }


# --------------------------------------------------------------------------
# Risk Rating Matrix v2.1 — five weighted factors, deterministic banding
# --------------------------------------------------------------------------
RISK_FACTORS = ["jurisdiction", "entity_structure", "industry", "sanctions_screening", "expected_activity"]

FACTOR_WEIGHTS = {
    "jurisdiction": 0.3,
    "entity_structure": 0.25,
    "industry": 0.15,
    "sanctions_screening": 0.2,
    "expected_activity": 0.1,
}

FACTOR_SCALES = {
    "jurisdiction": {
        "standard": 0,
        "eu_or_equivalent": 10,
        "elevated": 50,
        "fatf_high_risk": 100,
        "sanctioned_jurisdiction": 100,
    },
    "entity_structure": {
        "simple": 0,
        "holding_company": 40,
        "nominee_shareholders": 70,
        "chain_depth_over_3": 80,
        "opaque_trust": 90,
    },
    "industry": {
        "other": 0,
        "professional_services": 20,
        "cash_intensive_retail": 50,
        "real_estate": 60,
        "money_services": 90,
        "crypto_asset_services": 100,
    },
    "sanctions_screening": {
        "clear": 0,
        "false_positive": 0,
        "unresolved_possible": 50,
        "true_positive": 100,
    },
    "expected_activity": {
        "domestic_only": 0,
        "cross_border_standard": 25,
        "cross_border_over_1m": 50,
        "high_volume_cash": 80,
    },
}

RISK_BANDS = [
    {"band": "low", "min": 0, "max": 39, "required_approver_role": "kyc_analyst"},
    {"band": "medium", "min": 40, "max": 69, "required_approver_role": "senior_analyst"},
    {"band": "high", "min": 70, "max": 100, "required_approver_role": "compliance_officer"},
]

SANCTIONS_OVERRIDE_VALUE = "true_positive"


def _tidy(number):
    number = round(float(number), 2)
    return int(number) if number == int(number) else number


def band_for(total):
    for entry in RISK_BANDS:
        if entry["min"] <= total <= entry["max"]:
            return entry["band"]
    return "high"


def band_label(band):
    """Stored/served bands are lowercase; workflows.json gates on the label form.

    `sla-escalation-monitor`'s high_risk_escalation_gate compares
    `evaluate_sla.risk_band` to the literal "High", so any handler emitting a
    band into workflow context must emit band_label(band), never the raw value.
    """
    return {"low": "Low", "medium": "Medium", "high": "High"}.get(str(band).lower(), str(band).title())


def required_approver_role(band):
    for entry in RISK_BANDS:
        if entry["band"] == band:
            return entry["required_approver_role"]
    return "compliance_officer"


def risk_matrix_definition():
    return {
        "document": "risk-rating-matrix",
        "version": RISK_MATRIX_VERSION,
        "editable": False,
        "factors": [
            {
                "factor": name,
                "weight": FACTOR_WEIGHTS[name],
                "scale": FACTOR_SCALES[name],
            }
            for name in RISK_FACTORS
        ],
        "weights": dict(FACTOR_WEIGHTS),
        "bands": RISK_BANDS,
        "sanctions_true_positive_override": {
            "factor": "sanctions_screening",
            "value": SANCTIONS_OVERRIDE_VALUE,
            "forces_band": "high",
        },
    }


def score_factors(factors):
    """Deterministic scoring — same inputs always yield the same output."""
    factors = factors or {}
    factor_inputs, factor_scores, factor_contributions, breakdown = {}, {}, {}, []
    total = 0.0
    for name in RISK_FACTORS:
        raw_input = factors.get(name)
        scale = FACTOR_SCALES[name]
        raw_score = scale.get(str(raw_input), 0)
        weight = FACTOR_WEIGHTS[name]
        contribution = _tidy(raw_score * weight)
        total += raw_score * weight
        factor_inputs[name] = raw_input
        factor_scores[name] = raw_score
        factor_contributions[name] = contribution
        breakdown.append(
            {
                "factor": name,
                "raw_input": raw_input,
                "recognised": str(raw_input) in scale,
                "factor_score": raw_score,
                "weight": weight,
                "contribution": contribution,
            }
        )
    total = _tidy(total)
    override = str(factors.get("sanctions_screening")) == SANCTIONS_OVERRIDE_VALUE
    band = "high" if override else band_for(total)
    return {
        "factor_inputs": factor_inputs,
        "factor_scores": factor_scores,
        "factor_weights": dict(FACTOR_WEIGHTS),
        "factor_contributions": factor_contributions,
        "factor_breakdown": breakdown,
        "total_risk_score": total,
        "risk_band": band,
        "required_approver_role": required_approver_role(band),
        "sanctions_true_positive_override_applied": override,
        "risk_matrix_version": RISK_MATRIX_VERSION,
    }


# --------------------------------------------------------------------------
# Escalation / SLA policy v1.4
# --------------------------------------------------------------------------
BUSINESS_HOURS = {"start": "09:00", "end": "17:00", "days": ["mon", "tue", "wed", "thu", "fri"], "timezone": "UTC"}
SLA_HOURS_BY_BAND = {"low": 48, "medium": 24, "high": 8}
AT_RISK_PERCENT = 80
ESCALATION_CHAIN = [
    {"level": 1, "role": "compliance_officer", "user_id": "cora.compliance"},
    {"level": 2, "role": "head_of_financial_crime", "user_id": "hoc.fincrime"},
]
REVIEW_CADENCE_MONTHS = {"low": 36, "medium": 12, "high": 6}


def sla_policy_definition():
    return {
        "document": "escalation-sla-policy",
        "version": SLA_POLICY_VERSION,
        "sla_hours_by_band": dict(SLA_HOURS_BY_BAND),
        "at_risk_threshold_percent": AT_RISK_PERCENT,
        "business_hours": dict(BUSINESS_HOURS),
        "escalation_chain": [dict(e) for e in ESCALATION_CHAIN],
        "clock_pressure_never_relaxes_controls": True,
    }


def sla_hours_for(band):
    return SLA_HOURS_BY_BAND.get(band, 24)


def _parse_hhmm(value):
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def add_business_hours(start, hours):
    """Advance `start` by `hours` of business time (Mon-Fri, 09:00-17:00 UTC)."""
    open_t, close_t = _parse_hhmm(BUSINESS_HOURS["start"]), _parse_hhmm(BUSINESS_HOURS["end"])
    remaining = timedelta(hours=float(hours))
    cur = start
    for _ in range(2000):
        if remaining <= timedelta(0):
            return cur
        if cur.weekday() >= 5:
            cur = datetime.combine((cur + timedelta(days=1)).date(), open_t, tzinfo=cur.tzinfo)
            continue
        day_open = cur.replace(hour=open_t.hour, minute=open_t.minute, second=0, microsecond=0)
        day_close = cur.replace(hour=close_t.hour, minute=close_t.minute, second=0, microsecond=0)
        if cur < day_open:
            cur = day_open
        if cur >= day_close:
            cur = datetime.combine((cur + timedelta(days=1)).date(), open_t, tzinfo=cur.tzinfo)
            continue
        available = day_close - cur
        if available >= remaining:
            return cur + remaining
        remaining -= available
        cur = day_close
    return cur


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Roles and the named individual accounts that hold them
# --------------------------------------------------------------------------
ROLE_DEFINITIONS = [
    {"role": "kyc_analyst", "may_approve_up_to_score": 39, "approves_bands": ["low"], "may_decide": True},
    {"role": "senior_analyst", "may_approve_up_to_score": 69, "approves_bands": ["low", "medium"], "may_decide": True},
    {
        "role": "compliance_officer",
        "may_approve_up_to_score": 100,
        "approves_bands": ["low", "medium", "high"],
        "may_decide": True,
        "may_record_policy_exception": True,
    },
    {"role": "auditor", "may_approve_up_to_score": 0, "approves_bands": [], "may_decide": False, "read_only": True},
    {
        "role": "head_of_financial_crime",
        "may_approve_up_to_score": 100,
        "approves_bands": ["low", "medium", "high"],
        "may_decide": True,
    },
]

SEED_USERS = [
    {"username": "ana.analyst", "full_name": "Ana Oyelaran", "role": "kyc_analyst"},
    {"username": "sam.senior", "full_name": "Samir Adeyemi", "role": "senior_analyst"},
    {"username": "cora.compliance", "full_name": "Cora Vasquez", "role": "compliance_officer"},
    {"username": "aud.auditor", "full_name": "Aud Larsen", "role": "auditor"},
    {"username": "hoc.fincrime", "full_name": "Helena Okonjo", "role": "head_of_financial_crime"},
]

APPROVER_BY_BAND = {
    "low": "ana.analyst",
    "medium": "sam.senior",
    "high": "cora.compliance",
}

POLICY_CORPUS = [
    {"id": "kyc-onboarding-policy", "title": "KYC Onboarding Policy", "version": ONBOARDING_POLICY_VERSION},
    {"id": "document-checklist", "title": "Document Checklist", "version": DOCUMENT_CHECKLIST_VERSION},
    {"id": "escalation-sla-policy", "title": "Escalation and SLA Policy", "version": SLA_POLICY_VERSION},
    {"id": "risk-rating-matrix", "title": "Risk Rating Matrix", "version": RISK_MATRIX_VERSION},
]


def policy_versions():
    return {
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
        "risk_matrix_version": RISK_MATRIX_VERSION,
        "onboarding_policy_version": ONBOARDING_POLICY_VERSION,
        "escalation_sla_policy_version": SLA_POLICY_VERSION,
    }
