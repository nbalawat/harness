# Remediate the merged app — make it secure and usable, then move on

You are the remediation step. The parallel slices have been merged into one app.
Your job is to drive the app's own quality gates, **fix anything they flag, and
let the build proceed** — never to stall it. Every defect you fix here is a
defect that would otherwise ship dead or force an expensive rebuild.

**Read `$HARNESS_PROJECT_DIR/build-expertise.md` FIRST** — it names the exact
failure classes you are here to close, and the fixes that pass on the first try.

## Set up: work on a local copy of the merged app

Your inputs are in `./inputs.json`. Copy the merged app into the current
directory and work on the copy (all downstream steps consume YOUR output):

```
cp -R "$(node -e 'process.stdout.write(require("./inputs.json").app.path)')" ./app
```

## The gates you must drive to green

Run these against `./app` and fix every finding. They are the SAME scripts the
`verify` step will re-run to admit your work, so drive them green yourself first.

### A. Security — no unauthenticated mutation, no unsafe code
```
node "$HARNESS_PROJECT_DIR/scripts/security-scan.cjs"
```
Writes `security_report.json`. Any **high** finding fails. The dominant class is
a mutating route (`@app.post/put/delete`) whose handler carries no identity.
**Fix, do not suppress:** resolve `acting_user_email` server-side and fail
closed (401/403) when absent — exactly as expertise rule 6 shows. Only mark a
route `# public-endpoint: <reason>` when it is genuinely, intentionally public
(a webhook/trigger with its own verification). Re-run until 0 high findings.

### B. Usability — no dead controls, and an identity-gated app is operable
```
node "$HARNESS_PROJECT_DIR/scripts/check-ui-interactivity.cjs"
```
Writes `ui_interactivity.json`. It boots the seeded app and drives every screen.
A self-acting control (filter, search, pagination, export, saved view, a data
row) is **dead** if using it fires no network request and changes no data. Fix
each dead control so it does real work — wire the filter to actually filter the
list via the API, make each data row open its record's detail (expertise rule
7). If the app gates actions on identity, it MUST ship a persona picker plus
`GET /identities` so a human can assume a role without reading source (expertise
rule 8) — add it if missing. Re-run until it exits 0.

### C. Semantic hardening — the defects a regex cannot see
While you are in the code, apply the FSI hardening bar that the downstream audit
will independently check (so it passes without stalling): every mutation writes
an audit row with the actor; no human approval gate is bypassable; no financial
math is delegated to the model; role checks are default-deny, not opt-out. Fix
what you find; these are the class that once shipped a borrower-identity leak.

## Discipline: fix the real thing, keep everything else stable

- **Preserve behavior.** You are hardening a working app, not redesigning it.
  Touch only what a gate flags. Every slice's acceptance and the full test suite
  are re-proven downstream — do not break a passing slice to satisfy a gate.
- **Never weaken a gate to pass it.** Fix the app, not the check. Deleting a
  control, stubbing a route, or marking a real mutation public to dodge a
  finding is a failure, not a fix.
- **If a finding is genuinely a false positive**, say so precisely in
  `remediation.json` (which control, why it is not dead / not unauthenticated) —
  but the bar is high; the gates are tuned to real defects.

## Document what you learned (the factory learns from every build)

Write `./remediation.json` recording exactly what you healed and the durable
lesson — these are promoted into `build-expertise.md` so future builds ship
clean on the first attempt:

```json
{
  "step": "remediate",
  "healed": true,
  "security_fixes": [ "ext_incidents.py POST /incidents/{id}/assign now requires acting_user_email (was anonymous)" ],
  "usability_fixes": [ "severity filter on screen-queue now calls GET /incidents?severity=… (was a cosmetic class toggle); incident rows now open screen-detail" ],
  "hardening_fixes": [ "assignment now writes an audit row with the actor" ],
  "lessons": [ "Build the severity filter as a real query param from the start — the design listed it but the slice shipped it as a client-only highlight." ]
}
```
If every gate was already green, write `{ "step": "remediate", "healed": false, "lessons": [] }` and finish immediately — do not invent changes.

## Required outputs (in the current directory)

- `app/` — the hardened application (all downstream steps consume this).
- `remediation.json` — your healing record (above).
- `security_report.json` — from the security scan (0 high findings).
- `ui_interactivity.json` — from the usability drive (exit 0 / mock-skipped).

The `verify` step re-runs the security scan and the usability drive against your
`./app`. If anything is still red, you get it back as feedback — finish it. The
build does not proceed on a dead control or an unauthenticated mutation.
