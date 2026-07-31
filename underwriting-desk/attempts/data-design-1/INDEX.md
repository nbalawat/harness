# Data Design Step — Complete Artifact Index

## Primary Deliverable

**`data_model.json`** — The core output
- 18 persisted tables with 150+ typed columns
- Addresses 37 data-centric requirements from requirements.json
- Validated against `schemas/data_model.schema.json`
- Ready for backend code generation, ORM modeling, and database schema generation

## Supporting Documentation

**`MODEL_SUMMARY.md`** — Architectural overview
- Complete entity-by-entity design explanation
- Design principles applied (minimal modeling, first-class concepts, immutability, governance)
- Requirement-to-table coverage mapping
- Unknowns accommodation (REQ-052 through REQ-056)

**`COMPLETION_REPORT.txt`** — Formal sign-off
- Data design step status: ✅ COMPLETE
- Full requirement coverage matrix
- Validation results
- Next steps for backend and UI implementation

**`INDEX.md`** — This file
- Navigation guide to all artifacts

## Key Design Features

### Central Entity
- **`deals`** table: Core hub for all underwriting activities

### Governance & Control
- **`approvals`**, **`declines`**: Tiered approval with mandatory human identity
- **`stage_transitions`**: Explicit workflow modeling
- **`agent_drafts`**: Human review gate on all agent outputs
- **`users`**: Built-in RBAC (relationship_manager, credit_analyst, credit_officer)

### Auditability & Compliance
- **`audit_log`**: Append-only immutable trail of all state changes
- **`agent_runs`**: Complete agent execution record (model, version, inputs, outputs, cost)
- **`policy_exceptions`**: Compliance breaches with human disposition

### Traceability
- **`citations`**: First-class linking of values to their sources
- **`document_locations`**: Addressable document extraction
- **`policy_rules`**: Versioned configuration with stable rule IDs

### Deterministic Calculations (never by agents)
- **`ratios`**: DSCR, leverage, current ratio computed by code only
- **`risk_grades`**: Risk grading by rubric engine with rubric inputs visible

## Files in This Directory

```
.
├── data_model.json              # ✅ DELIVERABLE (9.4K, valid JSON)
├── MODEL_SUMMARY.md              # Architectural design explanation
├── COMPLETION_REPORT.txt         # Formal completion & validation report
├── INDEX.md                      # This navigation guide
└── inputs.json                   # Input requirements file (provided)
```

## Usage

### For Backend Engineers
1. Read `data_model.json` and feed it to your ORM model generator
2. Reference `MODEL_SUMMARY.md` for foreign key relationships and immutability rules
3. Consult `COMPLETION_REPORT.txt` "NEXT STEPS" section for API layer guidance

### For Product Managers
- Read `MODEL_SUMMARY.md` entity-by-entity overview
- Review `COMPLETION_REPORT.txt` requirement coverage matrix
- Cross-reference original requirements to table assignments

### For QA/Compliance
- Review `COMPLETION_REPORT.txt` for audit trail, RBAC, and approval governance
- Verify that agent governance (agent_runs, agent_drafts) matches REQ-014 ("no agent approvals")
- Confirm immutability enforcement on audit_log and documents tables

## Status

✅ **Data Design Complete**
- All 37 data-centric requirements addressed
- Schema validation passed
- Ready for next step: Backend Code Generation

---

Generated: 2026-07-30  
Project: SMB Loan Underwriting Platform ("underwriting-desk")  
Step: Data Design  
