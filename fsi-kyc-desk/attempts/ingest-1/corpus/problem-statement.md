# Problem Statement — KYC Review Desk

(Source: intake.json — `problem_statement` field, verbatim)

Our compliance team onboards corporate clients through a manual KYC review
that is slow and hard to audit. We need an application where:

- Cases are created from a client submission.
- A DETERMINISTIC workflow runs the document completeness check and computes
  the risk score mechanically from our risk rating matrix.
- An AI agent drafts the risk assessment memo grounded ONLY in our policy
  documents and the case data, with citations and a clear machine-drafted
  label.
- Decision authority follows risk bands (analyst / senior analyst /
  compliance officer) with explicit human approval required before any
  status change.
- High-risk cases escalate with SLA tracking and at-risk warnings.
- Every action lands in an immutable audit trail satisfying our regulator
  requirements.
- Analysts can search past cases and export full case files as CSV.
- Access is role-based and auditors are read-only.
