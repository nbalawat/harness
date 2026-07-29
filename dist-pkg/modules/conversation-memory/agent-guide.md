# conversation-memory — agent guide

Keep one Memory per conversation and feed memory.context() to the
agent, never a hand-built string. When the window overflows, the OLDEST turns
fold into a deterministic summary line — recent turns stay verbatim. Do not
tune max_chars per endpoint; it mirrors the model context budget.
