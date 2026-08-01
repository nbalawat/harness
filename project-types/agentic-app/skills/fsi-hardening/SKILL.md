---
name: fsi-hardening
description: Security and audit conventions for regulated financial-services apps — apply when building any endpoint, mutation, or agent surface. Copy the canonical patterns; run the pre-finish checklist BEFORE you stop.
---

# FSI hardening (certified) — build it right the FIRST time

Every past build that skipped this paid for it in expensive rework. These rules
are enforced by gates (security-scan, audit-check) — but the gates are a safety
net, not the plan. Write it correctly from line one by copying the patterns
below and running the checklist before you finish.

## The seven laws

1. **Validate first.** Every endpoint validates its payload (a pydantic model
   with real constraints — enums, bounds, min/max length — not bare `str`/
   `float`) BEFORE touching storage. Reject with 4xx + reason; never store
   partial garbage.
2. **Audit every mutation.** Any state change appends an audit row via the
   audit module with the ACTOR: who, what, when, before/after. No silent writes.
3. **Human gates are load-bearing.** Agent output that feeds a decision (memo,
   score, recommendation) lands PENDING for a named human to advance. Never
   auto-advance a workflow stage from agent output. Every human action checks a
   precondition (right stage, not already decided, no open blockers).
4. **Authorize server-side, default-deny.** Resolve the actor and role on the
   server; deny by default. Never trust the frontend.
5. **No secrets or PII in logs.** Log ids and event names, not payload bodies.
6. **Adverse actions carry reasons.** Every decline/rejection stores a
   documented reason string. Regulators read these.
7. **Money and scores are deterministic.** Ratios, limits, gradings — plain
   code with unit tests, NEVER inside an LLM call, and never a defaulted
   outcome (`decision = body.get("decision") or "approved"` is catastrophic).

## Identity: VERIFIED, never self-asserted — the costliest lesson

`acting_user_email` in a request body is a CLAIM, not proof. A route that trusts
it lets anyone send `"acting_user_email": "officer@bank.test"` and act as an
officer. Resolve identity through the certified identity/auth layer that
verifies a credential (session/bearer token) — the claimed email must MATCH the
verified principal. If your app has roles and money, it needs real auth; compose
the auth module, do not hand-roll a role lookup on an unverified string.

**ABSENT identity is the attack.** `if acting_user_email: <check>` is opt-out
authorization — an anonymous caller skips it. Every scoped read AND every
mutation must FAIL CLOSED (401) when identity is absent, then enforce role.
Redacting for anonymous is NOT a substitute: a "redacted" board that still leaks
borrower names leaks confidential data.

## Copy this — canonical secure handlers

```python
# READ — fail-closed, scoped. Identity is resolved unconditionally.
@router.get("/api/deals/{deal_code}")
def get_deal(deal_code: str, acting_user_email: str | None = None,
             x_user_email: str | None = Header(default=None)):
    actor = identity.require_actor(acting_user_email or x_user_email, "deal.view")  # raises 401 if absent
    deal = _deal_or_404(deal_code)
    identity.ensure_can_view(actor, deal)                                           # raises 403 if out of scope
    return identity.project_for(actor, deal)                                        # role-scoped fields

# MUTATION — validated, authorized, precondition-checked, audited.
class ApproveRequest(BaseModel):
    acting_user_email: str
    decision: Literal["approved", "declined", "returned"]        # enum, never defaulted
    decision_notes: str = Field(min_length=1, max_length=2000)

@router.post("/api/deals/{deal_code}/approve")
def approve(deal_code: str, req: ApproveRequest):
    actor = identity.require_actor(req.acting_user_email, "deal.approve")   # 401 if absent
    deal = _deal_or_404(deal_code)
    _approval_preconditions_or_409(deal)                                    # right stage, no open exceptions, not already decided
    identity.require_tier(actor, deal["exposure_amount"])                   # analyst<=250k, officer<=1M, committee above
    row = decisions_repo.record(deal, req.decision, req.decision_notes, by=actor)
    audit.record("deal.decision", {"deal": deal_code, "decision": req.decision}, actor=actor["email"])
    return {"deal": deal_code, "decision": req.decision, "by": actor["email"]}
```

A deliberately public endpoint (no identity by design) needs an explicit marker
on its decorator line: `# public-endpoint: <reason>` — rare, and justified.

Never expose tables through the generic `/api/{table}` API: it serves only
tables the data model marks `access: open/read`. Audit trails, users, decisions,
and financial records go through explicit, identity-checked endpoints only.

## DOM ids are app-global

Every element id your slice adds must be unique across the WHOLE app — duplicate
ids double-bind event listeners after the merge. Prefix by your surface:
`deal-detail-approve-btn`, never `approve-btn`.

## Pre-finish checklist — run this BEFORE you stop (the gates will)

- [ ] Every mutating route resolves identity via `require_actor` (or has a
      `# public-endpoint:` marker). No `if acting_user_email:` anywhere.
- [ ] Every scoped read fails closed (401) with NO identity — not redact-and-200.
- [ ] No decision/outcome field is defaulted; every one is a validated enum.
- [ ] Every mutation writes an audit row carrying the actor.
- [ ] Every human gate checks stage + not-already-decided + no open blockers.
- [ ] Ratios/grades/limits computed in code with tests — no LLM math.
- [ ] Your acceptance checks include an ANONYMOUS negative (no identity → 401)
      for each scoped/mutating route you added.
- [ ] Every new DOM id is prefixed by your screen.

If you cannot check a box, fix it now — it is far cheaper than the gate
bouncing your slice, and immeasurably cheaper than a post-merge remediation wave.
