# cost-meter — agent guide

Every model call records through costmeter (agent-runtime wires this).
Prices live in the module's table — update via config, never inline math in
endpoints. /admin/costs shows totals by model and day; token-budgeter enforces
caps, this module observes.
