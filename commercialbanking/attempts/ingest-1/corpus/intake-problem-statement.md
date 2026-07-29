# Intake: Commercial Banking Underwriting

Source: `/Users/nbalawat/development/harness/commercialbanking/artifacts/intake/intake.json`
(field `problem_statement`, plus sibling intake fields `project_name`, `documents_dir`, `deploy_target`, `supervision`)

## Project name

Commercial Banking Underwriting

## Problem statement (verbatim)

Relationship managers at a commercial bank have no single system for underwriting loan requests from small and mid-size businesses. Applications arrive as emails and spreadsheets; financial spreading is manual; risk ratings are inconsistent between analysts; and approval routing depends on who is in the office.

The application should run the underwriting pipeline as an explicit multi-stage workflow: intake → document extraction → financial spreading → risk grading → memo drafting → policy compliance check → tiered approval → closing, with each stage's status visible on a pipeline board.

Several distinct AI agents work inside that workflow, each with a narrow mandate:

1. An intake triage agent that classifies incoming requests, flags missing documents, and routes them to the right analyst queue;
2. A financial spreading agent that extracts figures from borrower financial statements into the standard spread template, showing its source for every number;
3. A credit memo agent that drafts the underwriting memo citing the specific ratios, spread figures, and policy rules it relied on;
4. A policy compliance agent that reviews every drafted memo against lending policy (concentration limits, prohibited industries, loan-to-value caps) and raises written exceptions; and
5. A portfolio Q&A agent that lets credit officers ask questions across active deals ("show me all deals above $500k with DSCR under 1.2") with answers grounded in stored deal data.

Deterministic logic — never an agent — computes the credit ratios (DSCR, leverage, current ratio) and assigns the risk grade from a transparent rubric.

Approvals are tiered by exposure: credit analyst to $250k, senior credit officer to $1M, credit committee above that.

No agent may ever approve, decline, or advance a deal past an approval step — a named human decision is mandatory at each one, and every agent output (triage, spread, memo, compliance exceptions) requires human acceptance before the workflow proceeds.

Declined deals need a documented adverse-action reason.

Every state change, ratio calculation, agent draft, and human decision lands in an immutable audit trail, with role-based access separating relationship managers (submit, view own deals), credit analysts (spread, draft, recommend), and credit officers (approve, decline, return for rework).

Deals idle past 5 business days surface on an SLA dashboard.

## Other intake fields

- `documents_dir`: none (no supplied supporting documents — problem statement is the sole source)
- `deploy_target`: local
- `supervision`: gates-only
