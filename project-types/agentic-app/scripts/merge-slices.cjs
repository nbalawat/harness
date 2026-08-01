// Deterministic union of the parallel slice wave. Every slice 2..N built on
// the SAME foundation (slice-1's app); this node folds their trees back into
// one app with a line-level three-way merge (git merge-file, base = the
// foundation). Same inputs -> same bytes, always. A genuine conflict — two
// slices changing the same lines differently — fails LOUDLY with repartition
// guidance; it is never resolved by a model.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const base = inputs.app.path; // the foundation: slice-1's committed app

// Per-branch noise that must never merge: verification rewrites these in each
// slice's own tree (acceptance_report.json) or tooling caches them (pytest,
// mypy, ruff — each branch's test run writes different cache contents).
const NOISE_DIRS = ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules"];
const EXCLUDE = (rel) =>
  rel === "acceptance_report.json" ||
  rel.endsWith(".pyc") ||
  rel.endsWith(".DS_Store") ||
  NOISE_DIRS.some((d) => rel.split(path.sep).includes(d));

function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(abs);
      else out.push(path.relative(root, abs));
    }
  };
  if (fs.existsSync(root)) rec(root);
  return out.filter((rel) => !EXCLUDE(rel));
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

// Collect each parallel slice's changeset relative to the foundation.
const baseFiles = new Set(walk(base));
const changes = new Map(); // rel -> [{ slice, content: Buffer|null }]
const merged = [];
for (let i = 2; i <= 6; i++) {
  const branch = inputs[`app_${i}`];
  if (!branch) continue;
  merged.push(i);
  const tree = branch.path;
  const treeFiles = new Set(walk(tree));
  for (const rel of new Set([...treeFiles, ...baseFiles])) {
    const inTree = treeFiles.has(rel);
    const inBase = baseFiles.has(rel);
    const treeContent = inTree ? fs.readFileSync(path.join(tree, rel)) : null;
    const baseContent = inBase ? fs.readFileSync(path.join(base, rel)) : null;
    if (inTree && inBase && treeContent.equals(baseContent)) continue; // untouched
    if (!inTree && !inBase) continue;
    if (!changes.has(rel)) changes.set(rel, []);
    changes.get(rel).push({ slice: i, content: treeContent }); // null = deleted
  }
}

fs.cpSync(base, "app", { recursive: true });

function conflict(rel, slices, detail) {
  console.error(
    `MERGE CONFLICT: ${rel} was changed by slices ${slices.join(" and ")} in overlapping ways${detail ? ` (${detail})` : ""}.\n` +
      "Parallel slices must own disjoint surfaces: repartition the slice plan's `covers`, " +
      "or move the shared change into the foundation slice. Conflicts are never auto-resolved.",
  );
  process.exit(1);
}

/** Fold one more slice's version in via three-way merge against the foundation. */
function merge3(rel, current, base3, theirs, slices) {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "merge3-"));
  const f = (name, content) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content ?? "");
    return p;
  };
  const result = spawnSync("git", ["merge-file", "-p", "-L", "merged", "-L", "foundation", "-L", "slice", f("cur", current), f("base", base3), f("theirs", theirs)], {
    encoding: "buffer",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  // git merge-file exits with the number of conflicts (negative on error).
  if (result.status !== 0) conflict(rel, slices, "overlapping line edits");
  return result.stdout;
}

const sorted = [...changes.keys()].sort();
for (const rel of sorted) {
  const variants = changes.get(rel);
  const dest = path.join("app", rel);
  const distinct = [];
  for (const v of variants) {
    if (!distinct.some((d) => (d.content === null && v.content === null) || (d.content && v.content && d.content.equals(v.content)))) {
      distinct.push(v);
    }
  }

  if (distinct.length === 1) {
    // One effective change — apply it (identical changes from several slices collapse here).
    if (distinct[0].content === null) fs.rmSync(dest, { force: true });
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, distinct[0].content);
    }
    continue;
  }

  const slices = variants.map((v) => `slice-${v.slice}`);
  const baseContent = baseFiles.has(rel) ? fs.readFileSync(path.join(base, rel)) : Buffer.alloc(0);

  if (distinct.some((v) => v.content === null)) conflict(rel, slices, "one slice deleted it, another changed it");
  if (!distinct.every((v) => isText(v.content)) || !isText(baseContent)) conflict(rel, slices, "binary file");

  const baseText = baseContent.toString();
  const ordered = [...variants].sort((a, b) => a.slice - b.slice);

  if (rel === "SLICES.md") {
    // Append-only ledger: every slice adds its entries under the foundation's.
    // Each variant must extend the base; suffixes concatenate in slice order.
    let out = baseText;
    for (const v of ordered) {
      const text = v.content.toString();
      if (!text.startsWith(baseText)) conflict(rel, slices, "a slice rewrote the ledger instead of appending");
      out += text.slice(baseText.length);
    }
    fs.writeFileSync(dest, out);
    continue;
  }

  // Append-extensions: when EVERY slice kept the base intact and only added
  // to the end (the common shape for shared wiring files like app.js — each
  // slice appends its own screen's behavior), the deterministic union is the
  // base plus each suffix in slice order. A three-way merge would call four
  // same-point insertions a conflict; concatenation is exactly the intended
  // result, and verify-merged still has to PROVE the union boots and passes.
  if (ordered.every((v) => v.content.toString().startsWith(baseText))) {
    let out = baseText;
    for (const v of ordered) out += v.content.toString().slice(baseText.length);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    continue;
  }

  // Line-level three-way merge, folded in slice order.
  let current = baseContent;
  for (const v of variants.sort((a, b) => a.slice - b.slice)) {
    current = merge3(rel, current, baseContent, v.content, slices);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, current);
}

console.log(
  merged.length
    ? `merged ${merged.length} parallel slice(s) [${merged.map((i) => `slice-${i}`).join(", ")}] onto the foundation: ${changes.size} changed file(s), 0 conflicts`
    : "single-slice plan: foundation app carried forward unchanged",
);
