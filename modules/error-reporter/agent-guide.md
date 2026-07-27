# error-reporter — agent guide

Wrap risky integrations with try/except + errors.capture(e, context)
— re-raise unless you can genuinely recover. Groups are keyed by exception
type + location so 1000 identical failures are one row with a count. Context
must never include secrets or full payloads.
