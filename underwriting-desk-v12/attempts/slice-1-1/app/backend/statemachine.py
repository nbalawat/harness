"""state-machine module: transitions as data. See agent-guide."""


class IllegalTransition(Exception):
    pass


class Machine:
    def __init__(self, transitions, initial):
        self.transitions = transitions
        self.initial = initial

    def advance(self, current, event):
        options = self.transitions.get(current, {})
        if event not in options:
            raise IllegalTransition(f"'{event}' not allowed from '{current}'")
        return options[event]

    def allowed(self, current):
        return sorted(self.transitions.get(current, {}))
