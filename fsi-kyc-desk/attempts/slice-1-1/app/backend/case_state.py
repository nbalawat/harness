"""Case status transitions — the single source of truth (state-machine module).

Never set a case's ``status`` field directly; call ``machine.advance(current,
event)`` and let an IllegalTransition surface as a 409. Later slices (rbac
approval, SLA monitoring) extend TRANSITIONS with the states/events they add
(e.g. ready -> approved/rejected) rather than duplicating a second machine.
"""
from statemachine import Machine

TRANSITIONS = {
    "intake": {"complete": "ready", "incomplete": "returned"},
}

machine = Machine(TRANSITIONS, initial="intake")
