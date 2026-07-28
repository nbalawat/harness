# workflow-engine — agent guide

Business processes run through this engine, never as ad-hoc endpoint code.
The definitions live in workflows/workflows.json (designed at build time,
user-approved); slices IMPLEMENT them by registering handlers:
`workflow_engine.register_handler("validate_policy", fn)` where fn(context)
returns a dict (validated against the node's output_schema).

Rules:
- deterministic nodes = registered handlers; agent nodes = prompts rendered
  from context and answered via agent_runtime (never call models directly);
  human nodes park the run into approval-flow (the app's approval UI decides);
  condition nodes branch on prior outputs.
- Never mutate workflow state directly — start/tick/state are the only API;
  the event log in the store is append-only and feeds the audit trail.
- The frontend shows runs via GET /workflows/runs/{id}; human decisions go
  through the approval endpoints, then tick resumes the run.
