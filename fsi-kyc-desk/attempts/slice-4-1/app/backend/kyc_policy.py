"""Versioned KYC policy corpus — the mechanical rules the desk is bound by.

This module holds the *content* of the approved policy artefacts (document
checklist, risk rating matrix, escalation/SLA policy, onboarding policy) plus
the pure functions that evaluate them. It performs no storage and no I/O:
persistence goes through db.store in ext_cases.py, per the app conventions.

Every artefact carries a version so a past case can be reproduced exactly.
"""
import calendar
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
        "condition_trigger": "ownership_chain_depth_over_1",
        "description": "Required when the ownership chain is deeper than one layer — structure chart down to natural persons.",
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


# The matrix's regulated set — a licence is required for all of these even when
# the submission does not set the `regulated_industry` attribute (REQ-010).
REGULATED_INDUSTRIES = ("money_services", "gambling", "defense")


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
        return depth > 1 or risk_factors.get("entity_structure") in ("chain_depth_over_3", "bearer_shares")
    if document_type == "operating_license":
        return _truthy(attributes.get("regulated_industry")) or risk_factors.get("industry") in REGULATED_INDUSTRIES
    if document_type == "expected_activity_questionnaire":
        return _truthy(attributes.get("cross_border_expected")) or risk_factors.get("expected_activity") == (
            "cross_border_over_1m"
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

# Weights and 0-100 factor scales transcribed verbatim from Client Risk Rating
# Matrix v2.1 (corpus: risk-rating-matrix.md), restated as REQ-018…REQ-022.
# Do not tune these to make a number come out: the matrix is the bank's.
FACTOR_WEIGHTS = {
    "jurisdiction": 0.3,
    "entity_structure": 0.25,
    "industry": 0.2,
    "sanctions_screening": 0.15,
    "expected_activity": 0.1,
}

# "otherwise" score for each factor — an unrecognised input scores as the
# matrix's own residual category rather than silently as zero.
FACTOR_DEFAULTS = {
    "jurisdiction": 10,
    "entity_structure": 15,
    "industry": 20,
    "sanctions_screening": 0,
    "expected_activity": 20,
}

FACTOR_SCALES = {
    # FATF high-risk list country involved = 90; enhanced-monitoring list = 60; otherwise = 10
    "jurisdiction": {
        "fatf_high_risk": 90,
        "enhanced_monitoring": 60,
        "standard": 10,
    },
    # Ownership chain depth > 3 or bearer shares = 85; nominee shareholders = 60; simple = 15
    "entity_structure": {
        "chain_depth_over_3": 85,
        "bearer_shares": 85,
        "nominee_shareholders": 60,
        "simple": 15,
    },
    # Money services, gambling, defense = 80; cash-intensive retail = 55; other = 20
    "industry": {
        "money_services": 80,
        "gambling": 80,
        "defense": 80,
        "cash_intensive_retail": 55,
        "other": 20,
    },
    # Any true-positive hit = 100 (auto high risk); unresolved possible hit = 70; clear = 0
    "sanctions_screening": {
        "true_positive": 100,
        "unresolved_possible": 70,
        "false_positive": 0,
        "clear": 0,
    },
    # Cross-border wires > $1M/month = 75; domestic only = 20
    "expected_activity": {
        "cross_border_over_1m": 75,
        "domestic_only": 20,
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
                "otherwise": FACTOR_DEFAULTS[name],
            }
            for name in RISK_FACTORS
        ],
        "weights": dict(FACTOR_WEIGHTS),
        # REQ-023/024/025: band range, approval authority and review cadence,
        # transcribed from the matrix so a reader never has to cross-reference
        # a second document to see what a band implies.
        "bands": [dict(entry, review_cadence_months=REVIEW_CADENCE_MONTHS.get(entry["band"])) for entry in RISK_BANDS],
        "sanctions_true_positive_override": {
            "factor": "sanctions_screening",
            "value": SANCTIONS_OVERRIDE_VALUE,
            "forces_band": "high",
        },
        "score_not_editable_by_any_role": True,
    }


def score_factors(factors):
    """Deterministic scoring — same inputs always yield the same output."""
    factors = factors or {}
    factor_inputs, factor_scores, factor_contributions, breakdown = {}, {}, {}, []
    total = 0.0
    for name in RISK_FACTORS:
        raw_input = factors.get(name)
        scale = FACTOR_SCALES[name]
        raw_score = scale.get(str(raw_input), FACTOR_DEFAULTS[name])
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
# Escalation and SLA Policy v1.4: assigned Compliance Officer -> Head of
# Financial Crime -> COO. Each step is recorded with who was notified and when.
ESCALATION_CHAIN = [
    {"level": 1, "role": "compliance_officer", "user_id": "cora.compliance"},
    {"level": 2, "role": "head_of_financial_crime", "user_id": "hoc.fincrime"},
    {"level": 3, "role": "coo", "user_id": "kim.coo"},
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


def add_months(dt, months):
    """Advance `dt` by whole calendar months — used for a case's next review due date.

    REQ-023/024/025 tie a review cadence (in months) to each risk band; a
    plain timedelta cannot express "6 months" correctly across variable month
    lengths, so this walks the calendar instead.
    """
    total = dt.month - 1 + int(months)
    year = dt.year + total // 12
    month = total % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


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
    {"role": "coo", "may_approve_up_to_score": 100, "approves_bands": ["low", "medium", "high"], "may_decide": True},
]

SEED_USERS = [
    {"username": "ana.analyst", "full_name": "Ana Oyelaran", "role": "kyc_analyst"},
    {"username": "sam.senior", "full_name": "Samir Adeyemi", "role": "senior_analyst"},
    {"username": "cora.compliance", "full_name": "Cora Vasquez", "role": "compliance_officer"},
    {"username": "aud.auditor", "full_name": "Aud Larsen", "role": "auditor"},
    {"username": "hoc.fincrime", "full_name": "Helena Okonjo", "role": "head_of_financial_crime"},
    {"username": "kim.coo", "full_name": "Kim Larsen", "role": "coo"},
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


# --------------------------------------------------------------------------
# Policy citations — resolvable provisions (slice 3, REQ-032)
# --------------------------------------------------------------------------
# Onboarding Policy v3.2 sections referenced elsewhere in the corpus (the
# design's own mock transcript quotes §4.2 and §7.1 verbatim) — transcribed
# here so the memo assistant's citations and GET /citations/resolve agree
# with the same source an auditor would open.
ONBOARDING_POLICY_SECTIONS = {
    "approval_routing": {
        "section": "4.2",
        "text": (
            "Approval authority is set by risk band: a Low-band case may be approved by a KYC Analyst, a "
            "Medium-band case by a Senior Analyst, and a High-band case only by a Compliance Officer, per the "
            "risk rating matrix's required_approver_role."
        ),
    },
    "sanctions_override": {
        "section": "7.1",
        "text": (
            "Where sanctions screening returns a confirmed true positive, the case is carried in the High band "
            "irrespective of the computed total, and may not be approved below Compliance Officer level."
        ),
    },
}


def resolve_citation(document, section):
    """Resolve a cited provision back to the exact source document and section.

    Every policy-based claim the memo assistant makes must trace back through
    this one function (REQ-032): the memo's own `policy_citations` field and
    GET /citations/resolve both call it, so a citation an auditor cannot
    resolve here is a defect, not a documentation gap.
    """
    doc = (document or "").strip().lower()
    sec = (section or "").strip().lower()
    if doc == "risk-rating-matrix":
        if sec in FACTOR_WEIGHTS:
            return {
                "document": "risk-rating-matrix",
                "version": RISK_MATRIX_VERSION,
                "section": sec,
                "weight": FACTOR_WEIGHTS[sec],
                "scale": FACTOR_SCALES[sec],
                "text": (
                    f"{sec.replace('_', ' ').title()} carries weight {FACTOR_WEIGHTS[sec]} of the weighted "
                    f"total (Risk Rating Matrix v{RISK_MATRIX_VERSION})."
                ),
                "resolved": True,
            }
        if sec in ("sanctions_override", "override", "sanctions_true_positive_override"):
            return {
                "document": "risk-rating-matrix",
                "version": RISK_MATRIX_VERSION,
                "section": sec,
                "provision": "sanctions_true_positive_override",
                "text": (
                    f"A sanctions_screening value of '{SANCTIONS_OVERRIDE_VALUE}' forces the High band "
                    "regardless of the weighted total."
                ),
                "resolved": True,
            }
        if sec in ("bands", "band"):
            return {
                "document": "risk-rating-matrix",
                "version": RISK_MATRIX_VERSION,
                "section": "bands",
                "bands": [dict(b) for b in RISK_BANDS],
                "text": "Low 0-39, Medium 40-69, High 70-100.",
                "resolved": True,
            }
        return {
            "document": "risk-rating-matrix",
            "version": RISK_MATRIX_VERSION,
            "section": sec,
            "text": "no such section in the risk rating matrix",
            "resolved": False,
        }
    if doc == "document-checklist":
        for item in list(BASE_REQUIRED_DOCUMENTS.get("corporate", [])) + list(
            BASE_REQUIRED_DOCUMENTS.get("individual", [])
        ):
            if item == sec:
                return {
                    "document": "document-checklist",
                    "version": DOCUMENT_CHECKLIST_VERSION,
                    "section": sec,
                    "required": True,
                    "text": f"'{sec.replace('_', ' ')}' is always required by the document checklist.",
                    "resolved": True,
                }
        for cond in CONDITIONAL_DOCUMENTS:
            if cond["document_type"] == sec:
                return {
                    "document": "document-checklist",
                    "version": DOCUMENT_CHECKLIST_VERSION,
                    "section": sec,
                    "required": "conditional",
                    "text": cond["description"],
                    "resolved": True,
                }
        return {
            "document": "document-checklist",
            "version": DOCUMENT_CHECKLIST_VERSION,
            "section": sec,
            "text": "no such document type on the checklist",
            "resolved": False,
        }
    if doc == "kyc-onboarding-policy":
        entry = ONBOARDING_POLICY_SECTIONS.get(sec)
        if entry is None:
            # also resolvable by the provision number itself (e.g. "4.2"), so an
            # auditor reading the memo's citation can look either up the same way
            entry = next((e for e in ONBOARDING_POLICY_SECTIONS.values() if e["section"] == sec), None)
        if entry:
            return {
                "document": "kyc-onboarding-policy",
                "version": ONBOARDING_POLICY_VERSION,
                "section": sec,
                "provision": entry["section"],
                "text": entry["text"],
                "resolved": True,
            }
        return {
            "document": "kyc-onboarding-policy",
            "version": ONBOARDING_POLICY_VERSION,
            "section": sec,
            "text": "no such section in the onboarding policy",
            "resolved": False,
        }
    if doc == "escalation-sla-policy":
        if sec in ("business_hours", "hours"):
            return {
                "document": "escalation-sla-policy",
                "version": SLA_POLICY_VERSION,
                "section": "business_hours",
                "business_hours": dict(BUSINESS_HOURS),
                "text": (
                    f"Business hours are {BUSINESS_HOURS['start']}-{BUSINESS_HOURS['end']} "
                    f"{BUSINESS_HOURS['timezone']}, Monday to Friday."
                ),
                "resolved": True,
            }
        if sec in SLA_HOURS_BY_BAND:
            return {
                "document": "escalation-sla-policy",
                "version": SLA_POLICY_VERSION,
                "section": sec,
                "sla_hours": SLA_HOURS_BY_BAND[sec],
                "text": f"The {sec} band carries an {SLA_HOURS_BY_BAND[sec]}-business-hour SLA.",
                "resolved": True,
            }
        if sec in ("escalation_chain", "chain"):
            return {
                "document": "escalation-sla-policy",
                "version": SLA_POLICY_VERSION,
                "section": "escalation_chain",
                "escalation_chain": [dict(e) for e in ESCALATION_CHAIN],
                "text": "Compliance Officer -> Head of Financial Crime -> COO.",
                "resolved": True,
            }
        return {
            "document": "escalation-sla-policy",
            "version": SLA_POLICY_VERSION,
            "section": sec,
            "text": "no such section in the escalation/SLA policy",
            "resolved": False,
        }
    return {"document": document, "version": None, "section": section, "text": "unknown policy document", "resolved": False}
