# guardrails-io — agent guide

Run check_input on user text BEFORE it reaches an agent and
check_output on replies BEFORE they reach users. A non-ok result means block
and disclose ("this request was blocked: <flag>"), never silently rewrite.
Topic fences come from app config, not hardcoded lists.
