"""Versioned policy constants and pure policy functions for the KYC desk.

Everything in this module is data lifted verbatim from the ingested policy
corpus, plus the mechanical rules those documents specify. Nothing here reads
or writes state: it is the deterministic core the workflow handlers call.

Documents in force:
  Document Completeness Checklist            v2.0
  Client Risk Rating Matrix                  v2.1
  Corporate Client Onboarding — KYC Policy   v3.2
  Escalation and SLA Policy — KYC Operations v1.4
"""
import datetime
import re

DOCUMENT_CHECKLIST_VERSION = "2.0"
RISK_MATRIX_VERSION = "2.1"
ONBOARDING_POLICY_VERSION = "3.2"
SLA_POLICY_VERSION = "1.4"

POLICY_VERSIONS = {
    "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
    "risk_matrix_version": RISK_MATRIX_VERSION,
    "onboarding_policy_version": ONBOARDING_POLICY_VERSION,
    "sla_policy_version": SLA_POLICY_VERSION,
}

# --------------------------------------------------------------------------
# Document Completeness Checklist v2.0
# --------------------------------------------------------------------------
BASE_REQUIRED_DOCUMENTS = [
    {"document_type": "certificate_of_incorporation", "title": "Certificate of incorporation"},
    {"document_type": "register_of_directors", "title": "Register of directors"},
    {
        "document_type": "beneficial_ownership_declaration",
        "title": "Beneficial ownership declaration covering all owners of 25% or more",
    },
    {"document_type": "proof_of_registered_address", "title": "Proof of registered address (within 3 months)"},
]

CONDITIONAL_DOCUMENTS = [
    {
        "document_type": "structure_chart",
        "title": "Structure chart down to natural persons",
        "condition_trigger": "ownership_chain_depth > 1",
    },
    {
        "document_type": "operating_license",
        "title": "Copy of the operating license",
        "condition_trigger": "regulated_industry is true",
    },
    {
        "document_type": "expected_activity_questionnaire",
        "title": "Expected activity questionnaire",
        "condition_trigger": "cross_border_expected is true",
    },
]

# The single declared submission attribute each conditional item reads.
TRIGGER_ATTRIBUTE = {
    "structure_chart": "ownership_chain_depth",
    "operating_license": "regulated_industry",
    "expected_activity_questionnaire": "cross_border_expected",
}

CHECKLIST_RULES = (
    "A case failing completeness is RETURNED with the list of missing documents. "
    "Completeness is a mechanical check; analysts may not waive items. Exceptions require a "
    "Compliance Officer policy exception, which is itself recorded."
)


def normalize_document_type(value) -> str:
    """'Register of Directors' / 'register-of-directors' -> 'register_of_directors'."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower())).strip("_")


def checklist() -> dict:
    """The Document Checklist as served to clients of the API."""
    return {
        "version": DOCUMENT_CHECKLIST_VERSION,
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
        "required_for_every_corporate_case": [dict(d) for d in BASE_REQUIRED_DOCUMENTS],
        "conditionally_required": [
            dict(d, trigger_attribute=TRIGGER_ATTRIBUTE[d["document_type"]]) for d in CONDITIONAL_DOCUMENTS
        ],
        "waivable_by_analyst": False,
        "undeclared_attribute_behaviour": "fail closed — an undeclared trigger attribute requires the item",
        "rules": CHECKLIST_RULES,
    }


def _declared(attributes: dict, key: str) -> bool:
    attributes = attributes or {}
    return key in attributes and attributes[key] is not None


def conditional_triggers(attributes: dict) -> list:
    """Which conditional checklist items this submission switches on, and why.

    Triggers are a pure function of the checklist and the attributes the
    submitter DECLARED — nothing is inferred from the risk factors or anywhere
    else, so the itemised missing-document list is reproducible from the record.
    An undeclared attribute fails closed: the item is required and the case is
    returned asking for it, never quietly exempted.
    """
    attributes = attributes or {}
    triggered = []
    for item in CONDITIONAL_DOCUMENTS:
        doc, key = item["document_type"], TRIGGER_ATTRIBUTE[item["document_type"]]
        declared = _declared(attributes, key)
        if doc == "structure_chart":
            try:
                depth = int(attributes[key]) if declared else None
            except (TypeError, ValueError):
                depth, declared = None, False
            fired = depth > 1 if declared else True
            observed = {key: depth}
        else:
            fired = bool(attributes[key]) if declared else True
            observed = {key: bool(attributes[key]) if declared else None}
        if fired:
            triggered.append(
                {
                    "document_type": doc,
                    "condition_trigger": item["condition_trigger"],
                    "attribute_declared": declared,
                    "observed": observed,
                }
            )
    return triggered


def required_documents(attributes: dict) -> list:
    """Base checklist plus every conditionally-triggered item, in checklist order."""
    required = [
        {"document_type": d["document_type"], "title": d["title"], "conditionally_required": False, "condition_trigger": None}
        for d in BASE_REQUIRED_DOCUMENTS
    ]
    triggers = {t["document_type"]: t for t in conditional_triggers(attributes)}
    for item in CONDITIONAL_DOCUMENTS:
        if item["document_type"] in triggers:
            required.append(
                {
                    "document_type": item["document_type"],
                    "title": item["title"],
                    "conditionally_required": True,
                    "condition_trigger": item["condition_trigger"],
                }
            )
    return required


def completeness(documents, attributes: dict) -> dict:
    """The mechanical completeness check. No judgment, no waivers, no inference."""
    received = []
    for doc in documents or []:
        key = normalize_document_type(doc if not isinstance(doc, dict) else doc.get("document_type"))
        if key and key not in received:
            received.append(key)
    required = required_documents(attributes)
    required_types = [r["document_type"] for r in required]
    missing = [t for t in required_types if t not in received]
    return {
        "is_complete": not missing,
        "required_documents": required,
        "required_document_types": required_types,
        "received_document_types": received,
        "missing_documents": missing,
        "conditional_triggers_applied": conditional_triggers(attributes, risk_factors),
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
    }


# --------------------------------------------------------------------------
# Client Risk Rating Matrix v2.1
# --------------------------------------------------------------------------
RISK_FACTORS = [
    {
        "factor": "jurisdiction",
        "weight": 0.3,
        "rule": "FATF high-risk list country involved = 90; enhanced-monitoring list = 60; otherwise = 10",
        "scores": {"fatf_high_risk": 90, "enhanced_monitoring": 60, "standard": 10},
        "default_score": 10,
    },
    {
        "factor": "entity_structure",
        "weight": 0.25,
        "rule": "Ownership chain depth > 3 or bearer shares = 85; nominee shareholders = 60; simple structure = 15",
        "scores": {"chain_depth_over_3": 85, "bearer_shares": 85, "nominee_shareholders": 60, "simple": 15},
        "default_score": 15,
    },
    {
        "factor": "industry",
        "weight": 0.2,
        "rule": "Money services, gambling, defense = 80; cash-intensive retail = 55; other = 20",
        "scores": {"money_services": 80, "gambling": 80, "defense": 80, "cash_intensive_retail": 55, "other": 20},
        "default_score": 20,
    },
    {
        "factor": "sanctions_screening",
        "weight": 0.15,
        "rule": "Any true-positive hit = 100 (auto high risk); unresolved possible hit = 70; clear = 0",
        "scores": {"true_positive": 100, "unresolved_possible": 70, "clear": 0},
        "default_score": 0,
    },
    {
        "factor": "expected_activity",
        "weight": 0.1,
        "rule": "Cross-border wires > $1M/month = 75; domestic only = 20",
        "scores": {"cross_border_over_1m": 75, "domestic_only": 20},
        "default_score": 20,
    },
]

RISK_BANDS = [
    {"band": "low", "min_score": 0, "max_score": 39, "review_cadence": "3 years", "review_cadence_months": 36},
    {"band": "medium", "min_score": 40, "max_score": 69, "review_cadence": "Annual", "review_cadence_months": 12},
    {"band": "high", "min_score": 70, "max_score": 100, "review_cadence": "6 months", "review_cadence_months": 6},
]

SANCTIONS_OVERRIDE_RULE = "A sanctions true-positive forces the case to High regardless of the weighted total."


def _num(value):
    """Render 55.0 as 55 while keeping genuine fractions intact."""
    value = round(float(value), 2)
    return int(value) if value == int(value) else value


def band_for(score) -> str:
    for band in RISK_BANDS:
        if band["min_score"] <= score <= band["max_score"]:
            return band["band"]
    return "high" if score > 0 else "low"


def band_detail(band: str) -> dict:
    for entry in RISK_BANDS:
        if entry["band"] == band:
            return dict(entry)
    return dict(RISK_BANDS[0])


def risk_matrix() -> dict:
    return {
        "version": RISK_MATRIX_VERSION,
        "risk_matrix_version": RISK_MATRIX_VERSION,
        "factors": [dict(f) for f in RISK_FACTORS],
        "bands": [dict(b) for b in RISK_BANDS],
        "sanctions_override": SANCTIONS_OVERRIDE_RULE,
        "score_is_editable": False,
    }


def score(factors: dict) -> dict:
    """Weighted-sum scoring, exactly as the matrix specifies. Reproducible."""
    factors = factors or {}
    inputs, raw_scores, weights, contributions, breakdown = {}, {}, {}, {}, []
    total = 0.0
    for spec in RISK_FACTORS:
        name = spec["factor"]
        value = factors.get(name)
        raw = spec["scores"].get(value, spec["default_score"])
        contribution = round(raw * spec["weight"], 2)
        total += contribution
        inputs[name] = value
        raw_scores[name] = raw
        weights[name] = spec["weight"]
        contributions[name] = _num(contribution)
        breakdown.append(
            {
                "factor": name,
                "raw_input": value,
                "factor_score": raw,
                "weight": spec["weight"],
                "contribution": _num(contribution),
                "rule": spec["rule"],
            }
        )
    total = _num(total)
    override = factors.get("sanctions_screening") == "true_positive"
    computed_band = band_for(total)
    return {
        "factor_inputs": inputs,
        "factor_scores": raw_scores,
        "factor_weights": weights,
        "factor_contributions": contributions,
        "factor_breakdown": breakdown,
        "total_risk_score": total,
        "computed_risk_band": computed_band,
        "risk_band": "high" if override else computed_band,
        "sanctions_true_positive_override_applied": override,
        "risk_matrix_version": RISK_MATRIX_VERSION,
    }


# --------------------------------------------------------------------------
# Onboarding policy v3.2 — decision authority; roles
# --------------------------------------------------------------------------
ROLES = [
    {
        "role": "kyc_analyst",
        "title": "KYC Analyst",
        "may_approve_bands": ["low"],
        "max_approvable_score": 39,
        "description": "Opens cases, runs checks, approves low-risk cases (score < 40).",
    },
    {
        "role": "senior_analyst",
        "title": "Senior Analyst",
        "may_approve_bands": ["low", "medium"],
        "max_approvable_score": 69,
        "description": "Approves medium-risk cases (40-69).",
    },
    {
        "role": "compliance_officer",
        "title": "Compliance Officer",
        "may_approve_bands": ["low", "medium", "high"],
        "max_approvable_score": 100,
        "description": "Approves high-risk cases (>= 70) and all escalations; owns policy exceptions.",
    },
    {
        "role": "auditor",
        "title": "Auditor",
        "may_approve_bands": [],
        "max_approvable_score": None,
        "description": "Read-only access to everything, including the full decision trail. May never decide.",
    },
]

BAND_APPROVER_ROLE = {"low": "kyc_analyst", "medium": "senior_analyst", "high": "compliance_officer"}

USERS = [
    {"username": "ana.analyst", "full_name": "Ana Okonjo", "role": "kyc_analyst"},
    {"username": "sam.senior", "full_name": "Sam Adeyemi", "role": "senior_analyst"},
    {"username": "cora.compliance", "full_name": "Cora Vasquez", "role": "compliance_officer"},
    {"username": "aud.auditor", "full_name": "Aud Larsen", "role": "auditor"},
]

DEFAULT_APPROVER = {"low": "ana.analyst", "medium": "sam.senior", "high": "cora.compliance"}


def required_approver_role(band: str) -> str:
    return BAND_APPROVER_ROLE.get(band, "compliance_officer")


# --------------------------------------------------------------------------
# Escalation and SLA policy v1.4
# --------------------------------------------------------------------------
SLA_HOURS_BY_BAND = {"low": 48, "medium": 24, "high": 8}
AT_RISK_THRESHOLD_PERCENT = 80
BUSINESS_HOURS = {"start": "09:00", "end": "17:00", "days": ["mon", "tue", "wed", "thu", "fri"], "timezone": "UTC"}
ESCALATION_CHAIN = ["compliance_officer", "head_of_financial_crime", "coo"]


def sla_policy() -> dict:
    return {
        "version": SLA_POLICY_VERSION,
        "sla_policy_version": SLA_POLICY_VERSION,
        "sla_hours_by_band": dict(SLA_HOURS_BY_BAND),
        "at_risk_threshold_percent": AT_RISK_THRESHOLD_PERCENT,
        "business_hours": dict(BUSINESS_HOURS),
        "escalation_chain": list(ESCALATION_CHAIN),
        "measured_from": "case_ready_timestamp (completeness passed)",
        "note": "Nothing in this policy permits skipping an approval to meet an SLA.",
    }


def sla_hours_for(band: str) -> int:
    return SLA_HOURS_BY_BAND.get(band, SLA_HOURS_BY_BAND["high"])


def _parse(iso) -> datetime.datetime:
    return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))


def add_business_hours(start_iso, hours) -> str:
    """Add business hours (09:00-17:00, Mon-Fri) to an ISO timestamp."""
    open_h = int(BUSINESS_HOURS["start"].split(":")[0])
    close_h = int(BUSINESS_HOURS["end"].split(":")[0])
    moment = _parse(start_iso)
    remaining = float(hours)
    guard = 0
    while remaining > 0 and guard < 10000:
        guard += 1
        if moment.weekday() >= 5 or moment.hour >= close_h:
            moment = (moment + datetime.timedelta(days=1)).replace(hour=open_h, minute=0, second=0, microsecond=0)
            continue
        if moment.hour < open_h:
            moment = moment.replace(hour=open_h, minute=0, second=0, microsecond=0)
            continue
        close = moment.replace(hour=close_h, minute=0, second=0, microsecond=0)
        available = (close - moment).total_seconds() / 3600.0
        if remaining <= available:
            moment = moment + datetime.timedelta(hours=remaining)
            remaining = 0
        else:
            remaining -= available
            moment = close
    return moment.isoformat()
