# The improvement loop — how the harness gets better every build

The factory's compounding advantage is not any single build. It is that **every
remediation on any of the 50k users' builds can become a certified gate that
prevents that entire class of problem on every future build.** The pipeline's
floor rises monotonically; a lesson is paid for once and inherited forever.

## The four promotion targets

When a build surfaces a problem (review, audit, scan, merge, or live UAT), the
fix lands in the workspace — but the *lesson* must be promoted into one of four
certified layers, chosen by how the class is best prevented:

| If the problem is… | Promote to… | Cost to catch next time | Example (from the underwriting build) |
|---|---|---|---|
| **Deterministically detectable** | a `security-scan` / verifier rule | $0, at build time | `if acting_user_email:` opt-out authz → `opt-out-authz` scan rule |
| **A convention agents should follow** | a certified **skill** | one prompt read | "identity is default-deny; unique DOM ids per surface" → fsi-hardening skill |
| **A planning/verification requirement** | a **prompt** rule + a `check-*` gate | rejected before build spend | "every mutating slice needs a negative + anonymous acceptance check" → slice-plan + check-slice-plan |
| **A substrate defect** | the **module** itself, re-certified | every app inherits the fix | unauthenticated `/api/{table}` → default-closed persistence-core |

The ranking is deliberate: prefer a **deterministic gate** (free, exhaustive, no
LLM) over a skill (guidance degrades under pressure) over a prompt requirement
over hoping. A lesson that can be made mechanical always should be.

## The loop, concretely

1. **Capture.** Every remediation wave already records, in the journal + the
   `revisions/*.md` channel, the finding source, the target step, the feedback,
   and the fix. `harness lessons <workspace>` reads these and emits
   `lessons.json` — one candidate per wave, pre-classified into a promotion
   target with a suggested change.
2. **Review & promote.** The central certifying team (small, per the vision)
   reviews candidates and applies the winning ones to the certified layer:
   a scan rule, a skill paragraph, a prompt line + verifier check, or a module
   fix.
3. **Re-certify.** `harness certify` replays the golden scenarios — the fix must
   not break determinism — and, for regression lessons, a fixture that *would
   have* triggered the old bug is added and asserted to now fail closed.
4. **Inherit.** The version bumps; every subsequent build of that project type
   starts with the higher floor. The problem class cannot recur silently.

## Why today's 7 waves become ~0 next time

The underwriting build's waves were, by lesson-class:

- **Merge-conflict from append discipline** (waves 1, 3) → prompt rule
  "REBASE FIRST" + merge script rebuilds output fresh. *Prevented.*
- **Opt-out / missing authorization** (waves 2, 6, 7) → `opt-out-authz` and
  `unauthenticated-mutation` scan rules + fsi-hardening default-deny rule +
  anonymous negative-acceptance requirement. *Caught at build, not merge.*
- **Unhardened module endpoints** (wave 4) → the modules themselves hardened and
  re-certified (audit-log actor, workflow identity, blob/upload identity).
  *Every app inherits.*
- **Agent grounding** (wave 5) → slice-plan rule "agent checks must prove
  grounding." *Rejected at plan time if missing.*

A fresh build of the same app on the resulting certified version surfaces the
`if acting_user_email:` pattern **at the deterministic scan on the first build**,
before any merge or human review — turning what was 7 live remediation waves
into a handful of build-time gate failures the slice agent fixes in its own
retry loop, at a fraction of the cost.

That is the mechanism: **remediation is not waste when its lesson is promoted —
it is how the factory pays tuition once on behalf of 50,000 users.**

## The non-repeat guarantee (regression lock)

Promotion alone is not enough — a gate can silently stop working. So every
promoted lesson gets an **adversarial fixture** in
`packages/runner/test/gate-regression.test.mjs`: a tiny app or plan that WOULD
trigger the bug, asserted to be caught by its gate. This is the mechanical
guarantee that the same class cannot recur:

- If a future change weakens a gate, the regression test fails **in CI, not in
  a $30 live wave.**
- The test names the class, the fixture, the gate, and the stage it fires at —
  so "we already learned this" is enforced, not remembered.

Adding a lesson without its regression fixture is incomplete promotion. The
suite currently locks: opt-out authorization, unauthenticated mutation, the
generic-table-write hole, oversized slices, missing negative acceptance,
merge same-line conflicts, and unwaived high audit findings — every class that
cost a wave on the underwriting build.

## Two failure modes remediation CANNOT fix (and what does)

1. **Architectural gaps, not defects.** The underwriting build took four waves
   trying to "add identity" and still had no real authentication, because the
   fix is a missing *capability* — real credentials → verified principal — not
   a patch to individual routes. No wave fixes a missing capability. The answer
   is a **certified substrate module** (e.g. `auth-session`) that slices
   compose, so identity is verified once, correctly, for every app. Routing the
   same "add identity" feedback a fifth time is the foolishness; adding the
   capability once is the fix.
2. **Semantic completeness a regex can't judge.** "Does this redaction leak a
   sensitive field?" is beyond deterministic scanning — that is the opus
   audit's job, and its HIGH findings now **gate** (`audit-check`) rather than
   sit advisory. The regex scan catches the cheap, syntactic 80%; the audit
   gate catches the expensive, semantic 20%; together nothing reaches UAT
   unexamined.

**Shift-left is the whole game.** A wave is a failure that escaped every earlier
gate. Push each class to the earliest gate it can be caught at — plan time
(free, no build spend) > build time (the agent's own retry loop, no wave) >
merge (deterministic) > audit (one agent pass) > human UAT (a wave). The
underwriting waves were all caught late (merge/audit); the promoted gates now
catch their classes early, so the next build of the same app starts correct.
