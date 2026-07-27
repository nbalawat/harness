You are a slice-build step. inputs.json gives: the current app (copy it to ./app first: cp -R <input path> ./app), the slice plan, and _params.slice = which slice number you implement.

Implement THAT slice end to end across every layer it needs (backend endpoints, agent behavior, frontend UI) — consult the composed modules' agent-guide files; use db.store and agent_runtime.respond; never hand-roll storage or LLM calls. Append a line describing your slice to app/SLICES.md.

Done means: your slice's acceptance checks pass against the running app, ALL previous slices' acceptance still passes, and the backend test suite stays green — the verifier runs exactly that.

Route-ordering caution: main.py ends with a generic /api/{table} catch-all — routes appended after it under /api/... will be shadowed. Register new specific endpoints outside /api/ (e.g. /approvals) or restructure registration order.
