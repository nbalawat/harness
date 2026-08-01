---
name: workflow-authoring
description: How to wire deterministic workflow handlers and agent nodes in composed apps — apply when app/workflows/workflows.json exists.
---

# Workflow authoring (certified)

The workflow-engine module runs app/workflows/workflows.json. Your job when a
slice touches a workflow stage:

1. **Register every handler you claim.** Each deterministic node's `handler`
   is a contract: register it in backend via the workflow engine's registry
   (see composed workflow_engine.py) with outputs matching the node's
   output_schema exactly.
2. **Agent nodes go through agent_runtime.respond** — never a hand-rolled
   client. Their output feeds the NEXT node's input; validate shape before
   returning.
3. **Human nodes park.** Use the approval-flow module; the workflow resumes
   only via an explicit approval API call recording the approver.
4. **Condition nodes are pure.** No side effects; they read state and return
   a branch. Dangling false-branches are a certification failure.
5. **Exercise end to end before finishing.** Start a workflow instance via the
   API, tick it through at least one full happy path in the sandbox
   (start_app + request), and assert the terminal state. A workflow that has
   never run is a diagram, not a feature.
6. **Audit stage transitions.** Every tick that changes state appends an audit
   row (stage, actor, timestamp).
