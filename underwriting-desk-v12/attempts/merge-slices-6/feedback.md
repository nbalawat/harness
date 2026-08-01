Attempt 5 failed validation. Fix the following and try again:

command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/merge-slices.cjs"
stdout:

stderr:
MERGE CONFLICT: frontend/app.js was changed by slices slice-2 and slice-3 and slice-4 and slice-5 in overlapping ways (overlapping line edits).
Parallel slices must own disjoint surfaces: repartition the slice plan's `covers`, or move the shared change into the foundation slice. Conflicts are never auto-resolved.
