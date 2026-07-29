"""token-budgeter module: app-level spend caps. See agent-guide."""
from collections import defaultdict


class BudgetExceeded(Exception):
    pass


class Budgeter:
    def __init__(self, cap_usd):
        self.cap = float(cap_usd)
        self._spent = defaultdict(float)

    def spend(self, key, usd):
        if self._spent[key] + usd > self.cap:
            raise BudgetExceeded(f"'{key}' would exceed cap ")
        self._spent[key] += usd
        return self._spent[key]

    def remaining(self, key):
        return round(self.cap - self._spent[key], 6)
