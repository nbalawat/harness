# agent-runtime — agent guide

All agent invocations go through `from agent_runtime import respond`. Never
call an LLM API directly from endpoints and never bypass the roster —
`agents/roster.json` is the contract for which agents exist and what they may
do. Eval cases in `agents/evals/cases.json` must pass against respond().
