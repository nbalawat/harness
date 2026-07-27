You are a slice-build step. inputs.json gives: the current app (copy it to ./app first: cp -R <input path> ./app), the slice plan, and _params.slice = which slice number you implement.

Implement THAT slice end to end across every layer it needs (backend endpoints, agent behavior, frontend UI) — consult the composed modules' agent-guide files; use db.store and agent_runtime.respond; never hand-roll storage or LLM calls. Append a line describing your slice to app/SLICES.md.

Done means: your slice's acceptance checks pass against the running app, ALL previous slices' acceptance still passes, and the backend test suite stays green — the verifier runs exactly that.

Route-ordering caution: main.py ends with a generic /api/{table} catch-all — routes appended after it under /api/... will be shadowed. Register new specific endpoints outside /api/ (e.g. /approvals) or restructure registration order.

DESIGN FIDELITY (non-negotiable): app/frontend/index.html IS the design option the user chose and approved — its layout, structure, typography, and styling are locked. app/design.json records which option shipped. When your slice adds UI:
- Extend WITHIN the existing shell: add elements inside the design's screen containers (id="screen-<name>"), matching its visual language and using its tokens.css variables.
- NEVER rewrite or replace index.html's shell, remove its canonical mount points (id="agent-mode", "screen-chat", "messages", "composer", "input"), or drop the app.js script tag — the verifier fails the slice if you do.
- New styles go in the design's idiom (its existing <style> block or stylesheet), reusing var(--primary), var(--surface), etc.

REVISIONS: if ./feedback.md contains user revision feedback, the user reviewed the running app and wants THIS slice corrected. Apply exactly the requested change, keep every other behavior and all previous slices' acceptance intact, and note the revision in app/SLICES.md.
