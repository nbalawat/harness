Attempt 13 failed validation. Fix the following and try again:

verification failed:
command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/verify-merged.cjs"
stdout:
acceptance passed: deal-intake-and-triage
acceptance passed: spread-ratios-and-risk-grade
acceptance passed: memo-policy-and-audit-trail
acceptance passed: tiered-approval-and-sla
acceptance passed: grounded-portfolio-qa

stderr:
        answer = body["answer"]
        # nothing sits at tiered approval yet, so the desk says so honestly —
        # and still grounds that statement in the deals it actually read.
        assert "DEAL-" in answer
>       assert deal["deal_code"] in body["source_deal_ids"]
E       AssertionError: assert 'DEAL-1017' in ['DEAL-1004', 'DEAL-1006', 'DEAL-1007']

tests/test_grounded_portfolio_qa.py:126: AssertionError
=============================== warnings summary ===============================
../../../../../../../.cache/uv/archive-v0/L5EpI5UtEA6vsY4yzT7Np/lib/python3.13/site-packages/fastapi/testclient.py:1
  /Users/nbalawat/.cache/uv/archive-v0/L5EpI5UtEA6vsY4yzT7Np/lib/python3.13/site-packages/fastapi/testclient.py:1: StarletteDeprecationWarning: Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.
    from starlette.testclient import TestClient as TestClient  # noqa

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
FAILED tests/test_grounded_portfolio_qa.py::test_answer_is_grounded_in_live_deal_records
1 failed, 95 passed, 1 warning in 1.67s


