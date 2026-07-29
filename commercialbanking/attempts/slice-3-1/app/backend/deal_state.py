"""Deal stage transitions — the single source of truth (state-machine module).

Never set a deal's ``current_stage`` field directly; call
``machine.advance(current, event)`` and let an IllegalTransition surface as a
409. Later slices (spreading, memo, policy, approval) extend TRANSITIONS with
the states/events they add rather than duplicating a second machine.
"""
from statemachine import Machine

TRANSITIONS = {
    "intake": {"accept_triage": "financial_spreading", "return_for_rework": "intake"},
    "financial_spreading": {"accept_spread": "credit_memo_review", "return_for_rework": "financial_spreading"},
    "credit_memo_review": {"accept_memo": "policy_compliance_review", "return_for_rework": "credit_memo_review"},
    "policy_compliance_review": {"clear_exceptions": "approval_pending", "return_for_rework": "policy_compliance_review"},
    "approval_pending": {"approve": "closing", "decline": "declined", "return_for_rework": "approval_pending"},
}

machine = Machine(TRANSITIONS, initial="intake")
