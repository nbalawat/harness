# Versioning, releases, and what a version number promises

## The core promise

A project-type version is an **immutable, certified artifact**. `agentic-app@0.4.0`
means: *this exact DAG, these prompts, these mocks, these schemas, these
scripts, these modules — proven by certification to complete its golden
scenarios byte-deterministically, inside its cost envelope, with its feedback
loop working.* Nothing about a released version ever changes; change means a new
version.

Three mechanisms enforce this:

1. **Registry tags** — a release is the git tag `<name>@<version>`. `harness
   install` clones exactly that tag and verifies the package's content digest
   against `certification.json`; any mismatch ("someone edited after
   certification") refuses to install.
2. **Run pinning** — every run copies the DAG into its workspace as
   `dag.snapshot.yaml` at start. Resumes, revisions, and the dashboard all read
   the snapshot, so a run keeps behaving as the version it started from even if
   the package evolves underneath it.
3. **CI re-certification** — every push re-runs `certify` for every project
   type against its recorded goldens. Accidental behavior drift turns CI red.

## Semver semantics for project types

| Bump | Meaning | Examples |
|---|---|---|
| **Patch** (0.4.0 → 0.4.1) | Same pipeline, same artifacts' shapes; fixes that keep golden digests valid or only require re-recording them for equivalent content | prompt clarification, budget recalibration, verifier bugfix |
| **Minor** (0.4 → 0.5) | Pipeline gains capability but existing consumers' expectations hold | new node, new gate, new artifact, new module composed |
| **Major** (0.x → 1.0, 1.x → 2.0) | The contract with consumers changes | different answers required at gates, artifact schema breaking change, generated-stack change |

Practical rules:

- **Golden digests are part of the version.** If certify shows drift you didn't
  intend, that's a bug. If the drift is intended, re-record goldens
  (`--update-golden`) *and bump the version* — a new digest is a new behavior.
- **Cost envelopes are certified claims.** Changing `run_budget_usd` or a node
  budget is at least a patch bump (we bumped design-options 4 → 12 when its
  scope grew to buildable shells).
- **Modules version with the repo tag.** A certified project-type version
  implicitly pins the module set it shipped with; a module interface break
  forces re-certification (and version bumps) of every project type composing it.
- **`certification.json` is generated, never edited.** It carries the version it
  certified and the package digest the registry checks. The harness CLI itself
  (`harness.cjs`) versions independently of project types — `self-update` moves
  the tool; installs move the content.

## Release checklist

1. `npm test` green.
2. `harness certify project-types/<name>` green (re-record goldens first if the
   change was intentional).
3. Bump `version:` in `dag.yaml` per the table above; certify again (the record
   must carry the new version).
4. Commit, tag `<name>@<version>`, push tag.
5. Announce the tag; consumers `harness install <name>@<version>`.
