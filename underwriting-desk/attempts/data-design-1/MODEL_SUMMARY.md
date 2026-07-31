# SMB Loan Underwriting Data Model

## Overview
This data model supports an explicit multi-stage workflow for SMB loan underwriting with 18 persisted tables. The design prioritizes:
- **Traceability**: Every decision, calculation, and agent output is traceable to its source
- **Immutability**: Core entities (audit log, documents) are append-only
- **Governance**: Explicit workflow transitions, deterministic calculations, human-required approvals
- **Compliance**: Full audit trail, RBAC enforcement, mandatory decision capture

## Core Entity: Deal
**`deals`** (REQ-001, REQ-002, REQ-027, REQ-028, REQ-043, REQ-044, REQ-048)
- Central hub for all underwriting activities
- Tracks borrower info, facility details, exposure amount, current stage, assigned analyst
- Includes lifecycle timestamps (created, last_activity, closed)
- Stores approval_tier derived from exposure for tiered approval routing

## Document Management
**`documents`** (REQ-029, REQ-030)
- Immutable storage of uploaded borrower documents
- Captures original filename, content type, uploader identity, timestamp
- Each document has a unique ID for citation references

**`document_locations`** (REQ-030)
- Enables addressable references to specific locations within documents
- Supports page-level and section-level extracted text
- Allows citations to point to exact evidence

## Financial Analysis
**`spread_line_items`** (REQ-031)
- Standard spread template as structured line items (not free text)
- Organized by category, label, value, unit, period
- Serves as single source of truth for financial metrics

**`ratios`** (REQ-009)
- DSCR, leverage, current ratio computed by deterministic code only
- Records ratio type, value, computation timestamp, and code version
- Never produced by agents; agents may only read these values

**`risk_grades`** (REQ-010, REQ-045)
- Risk grade assigned by deterministic rubric engine
- Stores grade, rubric_inputs (JSON) showing what triggered the grade
- Includes computation timestamp and code version for reproducibility

## Citations & Traceability
**`citations`** (REQ-005, REQ-006, REQ-032)
- First-class data structure linking values to their sources
- Flexible source types: document+location, spread line item, ratio, policy rule
- Supports clickable traces in UI and analyst review

## Policy & Compliance
**`policy_rules`** (REQ-034, REQ-053)
- Versioned, structured configuration of lending policies
- Rule types: concentration limits, prohibited industries, LTV caps
- Queryable by rule ID; enables compliance agent and citation references

**`policy_exceptions`** (REQ-007, REQ-035)
- Records policy breaches identified during underwriting
- Captures agent's rationale, breached value, and rule threshold
- Human disposition required: accepted / waived-with-justification / blocking
- Timestamps: created_at (agent identified), disposition_at (human decided)

## Workflow & Transitions
**`stage_transitions`** (REQ-001, REQ-036)
- Explicit record of every workflow stage change
- Captures from_stage, to_stage, actor, reason, timestamp
- Supports returns to earlier stages with documented reason

## Agent Governance
**`agent_runs`** (REQ-037, REQ-038)
- Complete auditability of agent execution
- Records: model_id, prompt_template_version, inputs, raw_output
- Includes latency_ms and token_cost (JSON) for monitoring and reproducibility

**`agent_drafts`** (REQ-016, REQ-037, REQ-046)
- Pending outputs requiring explicit human review before workflow advancement
- Review states: pending / accepted / edited / rejected
- Captures human edits separately from original agent output
- Mandatory review_reason on rejection

## Approvals & Decisions
**`approvals`** (REQ-011, REQ-012, REQ-013, REQ-015, REQ-021, REQ-043)
- Records tiered approval decisions
- Approval tiers: analyst ($250K), senior officer ($1M), committee (>$1M)
- Captures approved_by_user_id (mandatory named decision), decision, reason
- Enforced server-side: no agent can approve

**`declines`** (REQ-017, REQ-021)
- Deal rejections with mandatory adverse_action_reason
- Cannot be recorded without documented reason
- Captures declined_by_user_id and timestamp

## User Management & Access Control
**`users`** (REQ-019, REQ-020, REQ-021, REQ-041)
- Built-in role-assigned accounts (no external SSO in v1)
- Roles: relationship_manager, credit_analyst, credit_officer
- Includes is_active flag for revocation
- Password hash stored (secrets never in logs/prompts)

**`analyst_queues`** (REQ-033)
- Maps deals to analyst work queues
- Tracks queue status and assignment timestamp
- Enables work routing and queue visibility

## Audit & Compliance
**`audit_log`** (REQ-018, REQ-047)
- Append-only immutable audit trail
- Records every state change, calculation, draft, and decision
- Captures: event_type, entity_type/id, actor, action, old/new values, details (JSON)
- Includes timestamp for temporal ordering
- Exportable for regulatory examination

**`memos`** (REQ-006, REQ-045)
- Credit underwriting memo drafted by agent
- Stores memo content and citations (JSON list)
- Includes drafted_at timestamp

## Requirement Coverage
The model addresses **37 data-related requirements**:
- Functional (workflow, operations, calculations): REQ-001, REQ-002, REQ-028, REQ-030, REQ-031, REQ-036, REQ-037, REQ-038, REQ-044, REQ-048
- Data structure (entities, persistence): REQ-027, REQ-029, REQ-031, REQ-032, REQ-034, REQ-035, REQ-037, REQ-053
- Agent governance: REQ-005, REQ-006, REQ-037, REQ-038, REQ-046
- Security & RBAC: REQ-015, REQ-019, REQ-020, REQ-021, REQ-041, REQ-043
- Audit & compliance: REQ-018, REQ-047
- Calculations (deterministic): REQ-009, REQ-010
- Policy: REQ-007, REQ-034, REQ-035, REQ-053
- Approvals: REQ-011, REQ-012, REQ-013, REQ-015, REQ-021, REQ-043
- Workflow: REQ-001, REQ-002, REQ-027, REQ-028, REQ-043, REQ-044, REQ-048
- Work routing: REQ-033

## Design Principles Applied
1. **Minimal modeling**: Only tables and columns required by stated requirements
2. **First-class concepts**: Citations, stage transitions, agent drafts are explicit entities, not implicit
3. **Immutability where mandated**: Audit log, documents are append-only by design
4. **Traceability**: Every value can be traced to its source via citations or audit trail
5. **Governance layers**: RBAC (users), approval tiers (approvals), policy rules (policy_rules)
6. **Deterministic separation**: Ratios and grades always computed by code, never by agents
7. **Human-required decisions**: Approvals, declines, draft reviews all require named human actor
8. **Versioning**: Agent runs, policy rules, and grade computations include version/timestamp metadata for reproducibility

## Unknowns Accommodated
- **REQ-052**: Grading rubric scale and thresholds → accommodated in risk_grades.rubric_inputs JSON
- **REQ-053**: Concrete policy parameters → accommodated in policy_rules.parameters JSON
- **REQ-054**: Exposure definition (facility vs. aggregate) → accommodation ready in deals.exposure_amount calculation logic
- **REQ-055**: Committee approval mechanics → approvals table can record individual or committee-level decisions
- **REQ-056**: Document input format (OCR vs. digital) → document_locations and extracted_text support both

