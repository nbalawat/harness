Attempt 1 failed validation. Fix the following and try again:

verification failed:
command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/verify-slice.cjs"
stdout:
acceptance passed: deal-intake-and-pipeline

stderr:
slice demo failed to execute: Error: page.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element
Call log:
[2m  - waiting for locator('#in-industry')[22m
[2m    - locator resolved to <select class="sel" id="in-industry">…</select>[22m
[2m    - fill("manufacturing")[22m
[2m  - attempting fill actio — fix app/demo/slice-1.json (screen: screen-pipeline)
