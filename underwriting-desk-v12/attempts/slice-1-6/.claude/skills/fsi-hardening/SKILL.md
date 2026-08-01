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

## Mutations carry identity — mechanically enforced

Every POST/PUT/DELETE handler you write MUST resolve the caller server-side:
take `acting_user_email` (body) or the identity header, resolve it to a stored
user via the identity layer, and enforce the role the action demands
(default-deny unknown users). The deterministic security scan FAILS the build
on any mutating route in an `ext_*.py` file that carries no identity token.
A deliberately public endpoint needs an explicit marker on its decorator line:
`# public-endpoint: <reason>` — use it sparingly and justify it.

Never expose tables through the generic `/api/{table}` API: it serves only
tables the approved data model marks `access: open/read`. Sensitive data
(audit trails, users, decisions, financial records) goes through explicit,
identity-checked endpoints only.

## Identity is default-deny — ABSENT identity is the attack, not just wrong identity

`if acting_user_email: <check>` is OPT-OUT authorization and is a violation:
an anonymous caller skips the guard entirely. Scoped reads and all mutations
must FAIL CLOSED when identity is absent (401) and then enforce role/scoping
on the resolved user. Never default a decision field (`or "approved"` on a
credit outcome is catastrophic — absent decision = 422, never a default).
Negative acceptance must include the ANONYMOUS variant: the same request with
no identity at all -> 401/403.

## DOM ids are app-global

Every element id your slice adds must be unique across the WHOLE app —
duplicate ids double-bind event listeners after the merge. Prefix ids with
your surface (e.g. `deal-detail-approve-btn`, not `approve-btn`).
