"""Deal stage transitions — the single source of truth (state-machine module).

Never set a deal's ``current_stage`` field directly; call
``machine.advance(current, event)`` and let an IllegalTransition surface as a
409. Later slices (spreading, memo, policy, approval) extend TRANSITIONS with
the states/events they add rather than duplicating a second machine.

tiered-approval-decisions slice adds two events to every active stage:
  * ``decline`` — a credit officer may decline a deal for cause at any point
    in underwriting, not only once it reaches ``approval_pending`` (REQ-040);
    it always lands on the terminal ``declined`` status.
  * ``approve`` is additionally allowed straight from
    ``policy_compliance_review`` (not only ``approval_pending``): an approval
    by a sufficiently authorized officer carries forward as the human
    disposition of any residual open policy exceptions (see
    ``advance_deal_to_closing`` in ext_approvals.py), so the deal need not
    have already run the separate /policy-review/accept step.
"""
from statemachine import Machine

TRANSITIONS = {
    "intake": {"accept_triage": "financial_spreading", "return_for_rework": "intake", "decline": "declined"},
    "financial_spreading": {"accept_spread": "credit_memo_review", "return_for_rework": "financial_spreading", "decline": "declined"},
    "credit_memo_review": {"accept_memo": "policy_compliance_review", "return_for_rework": "credit_memo_review", "decline": "declined"},
    "policy_compliance_review": {"clear_exceptions": "approval_pending", "return_for_rework": "policy_compliance_review", "decline": "declined", "approve": "closing"},
    "approval_pending": {"approve": "closing", "decline": "declined", "return_for_rework": "approval_pending"},
}

# Ordered stage list — the underwriting pipeline in order. Used to derive the
# explicit return-to-stage events below and to render the board.
STAGE_ORDER = ["intake", "financial_spreading", "credit_memo_review", "policy_compliance_review", "approval_pending", "closing"]

# REQ-041: a credit officer may return a deal to any genuinely earlier stage
# for rework. Those jumps are events on this machine like every other stage
# movement — `return_to_<stage>`, defined only from stages that come later
# than the target — so no caller ever has to set `current_stage` directly and
# this table stays the single source of truth for what movement is legal.
for _index, _stage in enumerate(STAGE_ORDER):
    if _stage not in TRANSITIONS:
        continue  # terminal stage: nothing leaves it
    for _target in STAGE_ORDER[: _index + 1]:
        TRANSITIONS[_stage][f"return_to_{_target}"] = _target

machine = Machine(TRANSITIONS, initial="intake")
