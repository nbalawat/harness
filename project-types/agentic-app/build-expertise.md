# Build Expertise — hard-won lessons every builder must apply

This file is the factory's accumulated wisdom: the specific mistakes that have
made real builds fail verification, escalate to a stronger model, collide at
merge, or break in integration. **Read it before you build.** Each rule below
exists because it already cost a real build a failed gate or a wasted retry.
Applying them is how you pass on the FIRST attempt.

Grouped by the failure they prevent. Newest lessons are appended over time — the
factory learns.

---

## 1. Own disjoint surfaces — never touch what you don't own
*(prevents: merge-slices conflicts that fail the whole build)*

Parallel slices are built independently and then merged. If two slices edit the
same lines, the merge fails and the build stops.

- You own **exactly your assigned screen(s)** (your `covers`). Edit only your
  own `<section id="screen-...">` region.
- **The foundation owns the shared shell** — the nav, the rail, the `<head>`,
  the top bar, and the shared wrappers. **Do NOT restructure or insert into
  shared shell markup.** Adding your screen's behavior file is fine (append your
  own `<script src="your-screen.js">`); rewriting shared regions is not.
- If your feature has **no screen of its own** (`covers: []`), you are
  backend-only: **do not edit `index.html` at all.** Surface via an API the
  owning screen's slice consumes.

## 2. Keep your data in your own namespace — never share seed rows/IDs
*(prevents: cross-slice seed conflicts — the merged app has the wrong demo state)*

- Seed your **own** demo fixtures under IDs **unique to your slice** (prefix or
  a distinct range). **Never reuse another slice's demo record ID**, and never
  edit another slice's seed rows.
- Put your seed data in **your own** seed file, not a shared one. Two slices
  writing the same shared seed file produce a merged state that matches
  neither's expectations.

## 3. Test only YOUR feature's contract — never assume another slice
*(prevents: cross-slice test brittleness — passes alone, fails after merge)*

- Your tests assert **your** endpoints, **your** seeded records, **your**
  behavior. **Never assume another slice's step names, event ordering, status
  values, or seed rows** — those change when your slice is merged with theirs.
- Drive your tests off data **you** create in the test, not another feature's
  demo fixtures.

## 4. Match the acceptance contract EXACTLY — build to green
*(prevents: the single biggest cause of first-attempt failure + opus escalation)*

- The acceptance checks specify the **exact** method, path, status code, and
  response strings (`expect_contains`). Return those **exact** field names and
  values — `awaiting_underwriter` means the response must literally contain
  `awaiting_underwriter`, not `queue`.
- **Run the acceptance checks against your running app and iterate to GREEN
  before you finish** — run `node "$HARNESS_PROJECT_DIR/scripts/check-acceptance.cjs"`,
  which runs the verifier's EXACT checks and prints ✓/✗ per check. Do not finish
  while any check is ✗. You have the same checks the grader does; a miss here
  costs a full boot-and-verify retry plus a model escalation.

## 5. Every interactive element must be actionable
*(prevents: headless-browser demo timeouts — click/fill on a present-but-unusable element)*

- Every button/input your demo (or a real user) touches must be **enabled,
  visible, and not covered** by another element. "Present in the DOM" is not
  enough — the verifier drives a real headless browser and will time out on an
  unclickable control.

## 6. Security is a deliverable, not a cleanup
*(prevents: security-scan BLOCKED — unauthenticated mutation)*

- **Every** mutating route and every scoped read carries identity
  (`acting_user_email`), resolved server-side, **fail-closed** on absent
  identity (401/403). No exceptions — a single unauthenticated mutation fails
  the security scan and forces a rebuild.
- No defaulted decisions, no financial math delegated to an LLM, every mutation
  writes an audit row with the actor.

## 7. Only build controls a requirement asks for — and wire every one
*(prevents: "facade" apps — dead controls that ship because a design invented them)*

- **Every interactive control must fulfill a requirement.** No search box unless
  a requirement wants search; no export/saved-views/pagination/sort as
  decorative "enterprise furniture." The design-contract step REJECTS ungrounded
  controls, and the UI-interactivity gate FAILS the build if any self-acting
  control (filter, search, pagination, export, saved view, a data row) does
  nothing when used. Fewer controls that all work beats a rich-looking cockpit
  of dead buttons.
- A **data row** in a list that represents a record MUST be clickable to open
  that record's detail. A list you can't drill into is a facade.

## 8. If you gate on identity, make the app OPERABLE — ship a persona picker
*(prevents: "I have no clue what the creds are" — an app you can't even test)*

- If any action requires `acting_user_email` / a role, the app MUST let a human
  **assume a persona without reading source code**: expose `GET /identities`
  returning the provisioned users (email + role), and render a **persona picker**
  in the shell (a select/datalist) that sets the acting identity. Seed at least
  one identity per role. The UI-interactivity gate fails an identity-gated app
  that has no personas endpoint or no picker.

## 9. Gates self-heal — but the cheapest fix is to never trigger them
*(prevents: wasted remediation spend + stalled builds)*

The Verification phase no longer stalls on a fixable defect. `merge-slices`
resolves a genuine conflict with an agent (both slices preserved); a single
`remediate` step drives the security scan and the usability drive against the
merged app and FIXES what they flag — unauthenticated mutations, dead controls, a
missing persona picker, FSI hardening gaps — then re-proves them green before the
build proceeds. This is a safety net, not a licence to ship sloppy slices: every
heal costs a remediation attempt (and an escalation if the first pass misses).

- **Build it right in the slice** so `remediate` finds nothing: apply rules 1–8
  and you sail through. A slice that ships a dead filter, an anonymous mutation,
  or an identity gate with no persona picker will be healed — but that is spend
  and latency you caused.
- **remediation records lessons.** When `remediate` (or the merge healer) fixes
  something, it writes the durable lesson into its `remediation.json`. Those
  lessons are the raw material for the next rule in THIS file — the factory folds
  approved ones back in so the failure class stops recurring. If you are adding a
  rule here from a real heal, cite the build and the exact fix.

## 10. The identity substrate — three holes that pass every regex scan
*(prevents: semantic authz findings that stall the audit — privilege escalation, human-gate bypass, PII leak)*

These are non-functional requirements that MUST be built into the slice, because
the deterministic security scan cannot see them — only the semantic audit can,
and by then it is a stall. A KYC build shipped all three; each is now a required
build obligation, provable with a negative acceptance check:

- **Never put the identity/personas/users/roles table in `OPEN_WRITE_TABLES`.**
  Every route trusts that table as the sole source of who a caller is and what
  role they hold — a world-writable identity table lets anyone
  `POST {"role":"Compliance Officer"}` and self-provision full authority. Provision
  personas via each slice's seed step; if runtime creation is truly required, it
  needs a privileged role + an audit row, never the generic open-table write.
  Prove: `POST /api/personas` (write) → 403; `GET /api/personas` (read for the
  picker) stays open.
- **A workflow/approval engine's human-gate endpoints are a full alternate path
  to every action they gate.** `POST /workflow/submissions/{id}/approve|reject`
  (and the engine's `start`/`tick`) must enforce the SAME `require_role` +
  segregation-of-duties as the matching REST endpoint — a non-empty
  `acting_user_email` string is NOT authorization. Resolve which (workflow, node)
  the item parks and apply that node's role; default-deny an unknown pair. Never
  let a defaulted actor (`"system"`) or an unauthenticated caller advance a gate.
  Prove: pushing a gate with no/!wrong identity → 401/403.
- **Every read that returns PII / compliance-sensitive content is identity-gated**
  — including "list pending" style endpoints that embed full case context.
  Prove: the sensitive read with no identity → 401.

## 11. Correctness invariants — an app that passes acceptance can still be unsound
*(prevents: the deep-audit class that fails audit-check — fail-open identity, defaulted decisions, fake persistence, untrustworthy audit)*

Happy-path acceptance going green does NOT mean the app is correct. A KYC build
passed every acceptance check yet defaulted decisions to "approved", fabricated
Compliance-Officer identities, and mutated state in memory that never persisted.
Build these invariants in from the start — the security scan and audit now
enforce each one:

- **Identity fails CLOSED, never fabricates.** Resolve callers with
  `identity.require_actor` / `require_role`. NEVER
  `identity.find(email) or {"role": "…"}` — inventing a persona hands authority
  to anyone. (security-scan rule `fail-open-identity` blocks this.)
- **Never default a decision or terminal state.** A missing/unrecognized
  decision, verdict, or rating is a 4xx, not a silent value. NEVER
  `inputs.get("decision", "approved")` or `... .get(x, x)` that lets an unknown
  string through as state. (security-scan rule `defaulted-decision` blocks this.)
- **Persist through `store.update(...)`.** To change a row, call
  `store.update(table, id, changes)` — do NOT mutate a row from
  `store.list()`/`store.get()` in place (it works in memory and vanishes through
  Postgres) and do NOT keep app state in a module-level list/dict.
- **Audit is trustworthy or it is not evidence.** Write an audit row via the
  audit module at each mutation, with the SERVER-RESOLVED actor (never the
  request body's), and ONLY when the mutation actually happened — never on a
  denied/skipped branch. Identity-gate audit read endpoints (they expose
  cross-case PII).
- **Don't trust model output for control flow or math.** Applicant text is not
  spliced raw into prompts (injection); each LLM call selects its intended
  roster agent, not always agent #0; money/eligibility/decision math is
  deterministic code, not the model.
- **Deprovisioning fails closed.** If a persona/user can be revoked or disabled,
  `require_actor` must REJECT the revoked row (role=="revoked"/disabled/
  soft-deleted) — resolving "any row that exists" makes revocation cosmetic.
- **A decision is explicit, never coerced.** `"approved" if x.get("approved")
  else "rejected"` silently turns a missing field into a terminal decision —
  validate the decision against its declared schema and 4xx on absent/ambiguous.

## 12. Authorize every path to an action, not just the happy one
*(prevents: the residual authz holes — export dumps, half-guarded dispositions, workflow-gate role bypass)*

An action is only as guarded as its LEAST-guarded path. Cover them all:

- **Exports/downloads are reads — gate them.** A `GET /export/{table}.csv` (or
  any bulk/download route) must honor the SAME identity + read allowlist as the
  API it mirrors; never let it dump a table the `/api` layer would refuse.
- **Every terminal disposition, not just the positive one.** If `approve`
  enforces role + segregation-of-duties, then `reject`, `insufficient_evidence`,
  `escalate` — every terminal action — enforce them too. Scoping the check to
  `action == "approve"` leaves the other outcomes wide open.
- **The workflow/approval engine gate needs the app's ROLE check.** The
  approval-flow module now resolves IDENTITY (fail-closed on absent/unknown
  persona), but it cannot know your roles. The slice that owns a human gate MUST
  enforce the required role + segregation-of-duties for the approve/reject path
  itself (guard before calling the engine, or register an authorizer) so the
  `/workflow/...` endpoints cannot be used to advance a gate the REST endpoint
  would refuse. Human-gate PARITY means the two paths enforce the SAME rule.

---

*How this file is used:* the slice-plan and slice-build steps load it as
required reading; the merge and remediation healers load it before fixing.
When a new failure class is discovered in a real build (a gate that had to
self-heal), add a rule here (with the failure it prevents) so no one hits it
twice — that is how the factory gets more reliable every build.

## Live-run tuning: slice-audit convergence budget (2026-08)
First live (non-mock) run of the full audit loop revealed slice-audit was under-budgeted:
attempt 1 hit maxTurns:80 mid-audit; attempt 2 spent $15.48 (the whole $16 node budget)
doing a real pass that the independent security scan then blocked (4 unauthenticated
mutation endpoints); attempt 3 got $0 and died budget-starved. The independent verifier +
anti-reward-hacking guard correctly FAILED CLOSED rather than shipping the insecure app —
the mechanism is right, the budget was too tight for live multi-finding healing.
Fix: maxTurns 80→150, retries 3→5, slice-audit budget $16→$40, run_budget $150→$200.
Mock runs converge on attempt 1 at $0, so none of these bind in certification (byte-identical).
Lesson for authors: budget self-healing nodes for the WORST realistic case (several distinct
authz findings + re-audit cycles), not the mock's clean first pass.
