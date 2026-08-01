You are a slice-build step. FIRST ACTION: invoke the app-conventions skill (Skill tool) — it is the certified law for this codebase; code written before reading it tends to fail verification.

You are a slice-build step. inputs.json gives: the current app (copy it to ./app first: cp -R <input path> ./app), the slice plan, and _params.slice = which slice number you implement.

Implement THAT slice end to end across every layer it needs (backend endpoints, agent behavior, frontend UI) — consult the composed modules' agent-guide files; use db.store and agent_runtime.respond; never hand-roll storage or LLM calls. Append a line describing your slice to app/SLICES.md.

PARALLEL BUILD DISCIPLINE (when _params.parallel is true): sibling slices are being built CONCURRENTLY on the same foundation app you received, and a deterministic line-level merge unions all the trees afterward — a conflict fails the whole wave. To merge cleanly:
- REBASE FIRST, EVERY ATTEMPT: the foundation may have advanced since your last attempt (revisions cascade). Before changing anything, re-sync every file you do NOT own from the CURRENT foundation input (copy the input app's version over yours for all shared/foundation files — including SLICES.md and app.js — then re-apply YOUR additions on top: your appended app.js block at the end, your SLICES.md section at the end). A tree based on a stale foundation cannot merge.
- Your backend logic goes in a NEW file: `backend/ext_<your-slice-id>.py` (registered from main.py with a single one-line import/include near the existing ext registrations). Never rewrite shared modules.
- Your frontend behavior goes inside YOUR covered screens' containers only (`id="screen-<name>"` sections). Do not restructure shared chrome, other screens, or shared CSS.
- SLICES.md is append-only: add your lines at the END; never edit or reorder existing entries.
- Tests go in a new file `backend/tests/test_<your-slice-id>.py`.
- Verification here proves the FOUNDATION plus YOUR slice; the merge step re-proves every slice against the unioned app.

USE THE SANDBOX, NOT RAW SHELL: the app-sandbox MCP tools (start_app, request, logs, run_tests, stop_app) boot and probe your app with structured results. Probe every acceptance path with `request` and run `run_tests` BEFORE finishing — a sandbox probe costs nothing; a failed verification costs a full boot cycle and a retry. Do not hand-roll uvicorn/curl in Bash.

Done means: your slice's acceptance checks pass against the running app, the foundation's (and, for the foundation slice itself, ALL previous slices') acceptance still passes, and the backend test suite stays green — the verifier runs exactly that. The verifier also executes your demo declaration and takes the screenshot itself — do NOT spend turns driving a browser.

Route-ordering caution: main.py ends with a generic /api/{table} catch-all — routes appended after it under /api/... will be shadowed. Register new specific endpoints outside /api/ (e.g. /approvals) or restructure registration order.

DESIGN FIDELITY (non-negotiable): app/frontend/index.html IS the design option the user chose and approved — its layout, structure, typography, and styling are locked. app/design.json records which option shipped. When your slice adds UI:
- Extend WITHIN the existing shell: add elements inside the design's screen containers (id="screen-<name>"), matching its visual language and using its tokens.css variables.
- NEVER rewrite or replace index.html's shell, remove its canonical mount points (id="agent-mode", "screen-chat", "messages", "composer", "input"), or drop the app.js script tag — the verifier fails the slice if you do.
- New styles go in the design's idiom (its existing <style> block or stylesheet), reusing var(--primary), var(--surface), etc.

REVISIONS: if ./feedback.md contains user revision feedback, the user reviewed the running app and wants THIS slice corrected. Apply exactly the requested change, keep every other behavior and all previous slices' acceptance intact, and note the revision in app/SLICES.md.

WORKFLOW HANDLERS: if app/workflows/workflows.json exists, every deterministic node's `handler` name is an implementation contract — register real handlers (see the app-conventions skill) for the handlers your slice's features need, with outputs satisfying each node's output_schema. The workflow endpoints must actually run end to end for processes your slice claims to deliver.

DELIVER YOUR COVERED SCREENS (non-negotiable): your slice's `covers` lists the
design screens YOU must bring fully to life this slice. For each one: every
button, form, and list on it must be wired to real backend behavior — a screen
that still looks like the mockup with dead controls is a FAILED slice. The
design-coverage verifier at the end of the build boots the app and fails if
any approved screen is missing or inert; screens covered by earlier slices
must keep working (never remove them).

DEMONSTRATE YOUR SLICE (contract, ENFORCED): write app/demo/slice-<N>.json showing YOUR feature in action:
{"screen": "screen-<name>", "caption": "<one sentence: what this slice delivered, as visible in the shot>", "steps": [{"action":"fill","selector":"#...","value":"..."},{"action":"click","selector":"#..."}]}
The verifier REQUIRES this file, executes your steps against the running app,
and screenshots THAT screen alone. "screen" must be one of your slice's covered
screens. A screenshot byte-identical to a previous slice's FAILS verification —
stage real data through your steps so the shot visibly shows what this slice
added. There is no fallback: a demo that cannot run is a failed slice.

SELF-CHECK BEFORE DONE: before finishing, sweep your own diff against the certified conventions — design-shell fidelity intact, no routes registered after the /api/{table} catch-all, storage via db.store, LLM calls via agent_runtime.respond, every mutation writing an audit row, server-side role checks on every route, no financial math delegated to an LLM. A dedicated audit agent reviews the merged app after the build; findings there land in the governance pack, so violations are caught — write it right the first time. The verifier boots the app after you; a sandbox probe now is how you avoid paying for a failed boot.
