# eval-harness — agent guide

Eval cases live in agents/evals/cases.json; each may use
expect_contains, expect_not_contains, expect_regex (all optional, all must
pass). Run against agent_runtime.respond in stub mode for determinism. A
failing eval BLOCKS the build — do not weaken cases to pass; fix behavior.
