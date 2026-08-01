Attempt 1 failed validation. Fix the following and try again:

verification failed:
command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/verify-slice.cjs"
stdout:
acceptance passed: deal-intake-and-triage

stderr:
slice demo failed to execute: TimeoutError: page.fill: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('#intake-borrower-name')[22m
[2m    - locator resolved to <input type="text" required="" id="intake-borrower-name" placeholder="e.g. Harborline Freight"/>[22m
[2m    - fill("Harborline Freight")[22m
[2m  - — fix app/demo/slice-1.json (screen: screen-pipeline-board)
