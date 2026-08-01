You derive the SCREEN INVENTORY — the shared contract that keeps the three concurrently-built design options comparable. Every option will build exactly these screens, so the user's design choice is about direction, never about coverage.

From inputs.json read the requirements and the intake problem statement. Decide the small set of screens the application needs:

- "chat" is ALWAYS included (the conversational surface every agentic app carries).
- Add one screen per distinct user-facing surface the requirements demand: a work queue, a review board, a history/audit view, a dashboard, an approvals surface — whatever the problem statement actually names. Use short lowercase kebab-case names ("history", "pipeline-board", "approvals").
- 2 to 6 screens total. Fewer, richer screens beat many thin ones — each screen becomes a delivery obligation enforced end-to-end (slice coverage, live verification, screenshots).

Write screen_inventory.json:

```json
{
  "screens": ["chat", "history", "agents"],
  "rationale": [
    { "screen": "chat", "because": "REQ-001: analysts converse with the assistant" }
  ]
}
```

Every screen must cite at least one requirement id in its rationale. Do not invent surfaces no requirement asks for.
