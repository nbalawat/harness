---
name: fsi-hardening
description: Security and audit conventions for regulated financial-services apps — apply when building any endpoint, mutation, or agent surface.
---

# FSI hardening conventions (certified)

Regulated apps are held to these on every slice; the security scan and
governance report check for violations.

1. **Validate first.** Every endpoint validates its payload (pydantic model or
   explicit checks) BEFORE touching storage. Reject with 4xx and a reason;
   never store partial garbage.
2. **Audit every mutation.** Any state change (insert/update/approve/decline)
   appends an audit row via the audit module: who, what, when, before/after
   reference. No silent writes.
3. **Human gates are load-bearing.** An agent output that feeds a decision
   (memo, score, recommendation) must land in a pending state a named human
   advances. Never auto-advance workflow stages from agent output.
4. **RBAC on every route.** Resolve the actor's role first; deny by default.
   Role checks live server-side, never only in the frontend.
5. **No secrets or PII in logs.** Log ids and event names, not payload bodies.
6. **Adverse actions carry reasons.** Any decline/rejection stores a
   documented reason string — regulators read these.
7. **Money and scores are deterministic.** Ratios, limits, and gradings are
   computed in plain code with unit tests — never inside an LLM call.
