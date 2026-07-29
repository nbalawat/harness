You are the slice-planning step. Read the requirements, architecture, data model, and agent roster.

Produce `slice_plan.json`: an ORDERED list of 1-6 VERTICAL slices. Each slice is one user-visible capability delivered end to end (backend + agent + UI together) — never a horizontal layer. Slice 1 must be the smallest end-to-end path through the core value ("walking feature"). Later slices build on earlier ones.

Each slice: kebab-case `id`, human `name`, a user `story`, `addresses` (requirement IDs it delivers — every slice must trace), and `acceptance`: HTTP checks (method, path, optional body/expect_status/expect_contains) that OBJECTIVELY prove the capability works. Acceptance runs cumulatively — later slices must not break earlier ones.

SLICE SIZING (time is the scarce resource — plan for it):
- Slice 1 is a WALKING SKELETON: the single thinnest end-to-end happy path
  (one endpoint, one screen interaction, one workflow run if workflows exist)
  — NOT the foundation dump. Models, module wiring, and the test harness
  already exist from scaffold; do not re-plan them.
- 3-5 slices total, EFFORT-BALANCED: no slice should be more than ~2x the
  work of another. If one feature dominates, split it across slices.
- WORKFLOW-ALIGNED when workflows.json exists: prefer one slice per workflow
  ("the intake process runs end to end"), with a final slice for cross-cutting
  surfaces (search, export, admin). The workflow's own execution is the
  natural acceptance.
- Acceptance stays small: 2-4 checks per slice, each fast HTTP assertions —
  the cumulative suite re-runs every slice, so every check you add is paid on
  every later slice.
