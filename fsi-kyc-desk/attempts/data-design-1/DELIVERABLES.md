# Data Design Deliverables — FSI KYC Desk

## ✅ Primary Artifact

**`data_model.json`** — Complete data model (11 KB)
- **12 tables** modeling the FSI KYC desk workflow
- **107 columns** with typed definitions
- **81 requirement addresses** linking each table to the requirements it satisfies
- **Schema-validated** against `schemas/data_model.schema.json`

## 📋 Tables Defined

| # | Table | Purpose | Rows |
|---|-------|---------|------|
| 1 | `cases` | Primary case entity, status, lifecycle | — |
| 2 | `risk_scores` | Immutable factor scores and weighted total | 1 per case |
| 3 | `documents` | Document inventory with required/conditional flags | N per case |
| 4 | `missing_documents` | Itemized list of missing docs at rejection | N at rejection |
| 5 | `assessment_memos` | Versioned AI-drafted memos with approval | N per redraft |
| 6 | `approvals` | Decision records (approve/reject/escalate) | N per decision |
| 7 | `compliance_exceptions` | Policy exceptions granted by compliance | N per exception |
| 8 | `audit_trail` | Append-only immutable event log | M per case |
| 9 | `escalations` | Escalation chain for high-risk cases | N per escalation |
| 10 | `notifications` | At-risk / escalation / rejection notices | N per event |
| 11 | `sla_tracking` | SLA windows, at-risk flags, breaches | 1 per band tier |
| 12 | `users` | Role-based user registry | 1 per user |

## 🎯 Requirements Coverage

**Overall:** 81 / 98 requirements addressed (82.7%)

By category:
- **Agent (AI workflows):** 9/9 (100%) ✅
- **Data (storage/audit):** 12/12 (100%) ✅
- **Security (auth/authz):** 13/15 (87%) ✅
- **Functional (business logic):** 40/48 (83%) ✅
- **UX (presentation):** 5/8 (63%) 
- **Ops (deployment):** 2/6 (33%)

**Not in data model** (17 requirements): Primarily UI/UX (search, export, worklist views), operational (deployment, background tasks), and clarification questions (sanctions source, submission channel, document verification depth).

## 🔑 Key Design Decisions

### 1. Immutability by Design
- **Audit trail:** Append-only, no update/delete permitted
- **Assessment memos:** Versioned as new rows, prior versions immutable
- **Approvals:** Recorded once, never modified
- **Missing documents:** Recorded at rejection, permanent record

### 2. Reproducibility
- `risk_scores` table stores per-factor raw scores + final score
- `cases` stores policy artifact versions (risk matrix, checklist, onboarding policy)
- Re-running the scoring engine on same inputs yields same score (REQ-028)

### 3. Role-Based Approval Authority
- `approvals` table captures both `decided_by_role` (actual role) and `required_role_tier` (required tier)
- Enables audit visibility if a higher-privileged role approves below its tier (REQ-085)
- Compliance Officer decisions require stored `reason` field (REQ-043)

### 4. SLA Tracking
- `sla_tracking` stores SLA window per risk band
- Separate timestamps for: start, due, flagged-at-risk (80%), breach
- Breach is **permanent** — not cleared by later decision (REQ-058)
- Escalation chain recorded separately in `escalations` table (REQ-060-061)

### 5. Memo Adoption Pattern
- Approver "adopts" the AI-drafted memo by setting `is_approved=true` + `approved_by_user_id`
- No separate memo_approval table; approval is recorded on the memo row itself
- Prior versions retained in table for indefinite audit trail (REQ-039)

### 6. Document Completeness
- `documents` table models required and conditionally-required documents
- `missing_documents` captures itemized list if case fails completeness (REQ-012)
- Enables returning client with exact list of what to resubmit (REQ-089)

## 🏗️ Composition with Persistence-Core

Tables defined here become `models.TABLES` in persistence-core, providing:
- **Regulatory compliance:** Immutable audit trail satisfying all regulator requirements
- **Reproducible risk scoring:** All factor inputs + matrix version for audit verification
- **Role-based governance:** Approval authority enforcement by tier
- **SLA management:** Breach tracking and escalation chain
- **Memo versioning:** Complete history of assessment memo drafts and approvals

## 📌 Outstanding Clarifications

Three requirements are questions deferred to domain SME:
- **REQ-096:** Sanctions screening — external provider vs. internal verification?
- **REQ-097:** Client submission portal — web portal, API, file drop, or analyst upload?
- **REQ-098:** Completeness verification — presence-only vs. document content extraction?

These don't block the data model; they inform optional feature scope downstream.

## ✨ Next Steps

1. **App design:** Map data model to API endpoints and UI views
2. **Workflow specification:** Detail the agent prompts for memo drafting
3. **Policy configuration:** Model risk matrix, document checklist, escalation rules as versioned config
4. **Database schema:** Generate DDL from data_model.json

---
**Status:** ✅ Validation passed | Schema-compliant | Ready for app design
