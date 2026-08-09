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

// FRESH output every attempt: retry continuity carries the previous
// attempt's ./app forward, and cpSync overlays without deleting — a stale
// file from an earlier wave (e.g. a module a slice since renamed) would
// silently shadow the real one.
fs.rmSync("app", { recursive: true, force: true });
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

/** Split an HTML doc into ordered segments: shell chunks + top-level
 *  <section id="screen-*"> regions (balanced, so nested panels stay inside
 *  their screen). Returns [{type:'shell'|'screen', id?, text}] or null if the
 *  markup is unbalanced (caller falls back to line-merge). */
function splitScreens(text) {
  const segs = [];
  // match a screen <section> with id ANYWHERE in the opening tag (attribute
  // order varies by design — class-first or id-first are both valid).
  const open = /<section\b[^>]*\sid="(screen-[A-Za-z0-9_-]+)"/g;
  let pos = 0, m;
  while ((m = open.exec(text))) {
    const start = m.index;
    const tag = /<section\b|<\/section>/g;
    tag.lastIndex = start;
    let depth = 0, t, end = -1;
    while ((t = tag.exec(text))) {
      depth += t[0] === "</section>" ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    if (end < 0) return null;
    if (start > pos) segs.push({ type: "shell", text: text.slice(pos, start) });
    segs.push({ type: "screen", id: m[1], text: text.slice(start, end) });
    pos = end;
    open.lastIndex = end;
  }
  segs.push({ type: "shell", text: text.slice(pos) });
  return segs;
}

/** three-way merge of one chunk; returns {ok, text} instead of exiting. */
function merge3try(current, base3, theirs) {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "m3-"));
  const w = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c ?? ""); return p; };
  const r = spawnSync("git", ["merge-file", "-p", "-L", "merged", "-L", "foundation", "-L", "slice", w("cur", current), w("base", base3), w("theirs", theirs)], { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: r.status === 0, text: r.stdout };
}

/** UNION merge: three-way, but where both sides inserted at the same anchor
 *  (the classic "each slice added its own <script>/nav item") keep BOTH — the
 *  correct result for purely ADDITIVE changes. Only used once every change to
 *  the region is verified additive (base preserved as a subsequence). */
function unionMerge(current, base3, theirs) {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "um-"));
  const w = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c ?? ""); return p; };
  const r = spawnSync("git", ["merge-file", "-p", "-L", "m", "-L", "b", "-L", "s", w("cur", current), w("base", base3), w("theirs", theirs)], { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status === 0) return r.text ?? r.stdout;
  const out = []; const seen = new Set(); let inBlock = false;
  for (const l of (r.stdout || "").split("\n")) {
    if (l.startsWith("<<<<<<<")) { inBlock = true; seen.clear(); continue; }
    if (l.startsWith("=======")) continue;
    if (l.startsWith(">>>>>>>")) { inBlock = false; continue; }
    if (inBlock) { if (seen.has(l)) continue; seen.add(l); }
    out.push(l);
  }
  return out.join("\n");
}

/** True when `base` is preserved verbatim as a subsequence of `text` — i.e. the
 *  change only INSERTED lines and removed/altered nothing. */
function isAdditive(base, text) {
  const bl = base.split("\n"), tl = text.split("\n");
  let j = 0;
  for (const x of bl) { while (j < tl.length && tl[j] !== x) j++; if (j >= tl.length) return false; j++; }
  return true;
}

/** Section-aware HTML merge. Parallel slices each own a distinct screen, so
 *  merge BY REGION: a screen changed by exactly one slice is taken verbatim
 *  (disjoint screens auto-union even when their edits touch adjacent lines);
 *  shell chunks and any screen touched by 2+ slices are reconciled with a
 *  three-way merge, and only a genuine incompatible edit to the SAME region
 *  fails. Returns merged text, or null to fall back to line-merge. */
function mergeHtmlBySection(rel, baseText, ordered, slices) {
  const baseSegs = splitScreens(baseText);
  if (!baseSegs || !baseSegs.some((s) => s.type === "screen")) return null;
  const shape = (segs) => segs.map((s) => (s.type === "screen" ? s.id : "#")).join("|");
  const variants = [];
  for (const v of ordered) {
    const segs = splitScreens(v.content.toString());
    if (!segs || shape(segs) !== shape(baseSegs)) return null; // structure diverged
    variants.push(segs);
  }
  const out = [];
  for (let i = 0; i < baseSegs.length; i++) {
    const b = baseSegs[i].text;
    const changed = [...new Set(variants.filter((vs) => vs[i].text !== b).map((vs) => vs[i].text))];
    if (changed.length === 0) { out.push(b); continue; }        // untouched
    if (changed.length === 1) { out.push(changed[0]); continue; } // one owner
    // 2+ slices changed the same region. Clean three-way merge first.
    let cur = b, clean = true;
    for (const t of changed) { const r = merge3try(cur, b, t); if (!r.ok) { clean = false; break; } cur = r.text; }
    if (!clean) {
      // Only a same-anchor collision of PURELY ADDITIVE edits (each slice added
      // its own line, e.g. a <script> tag) is safely auto-resolvable by UNION.
      // Anything else is a genuine conflict and must fail loudly.
      if (changed.every((t) => isAdditive(b, t))) {
        cur = b;
        for (const t of changed) cur = unionMerge(cur, b, t);
      } else {
        conflict(rel, slices, `two slices changed ${baseSegs[i].type === "screen" ? `screen '${baseSegs[i].id}'` : "the shared shell"} incompatibly`);
      }
    }
    out.push(cur);
  }
  return out.join("");
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

  // HTML shell (index.html): parallel slices each own a distinct screen —
  // merge by SECTION so disjoint screens union even when their edits land on
  // adjacent lines. Only two slices editing the SAME screen/shell conflict.
  if (rel.endsWith(".html")) {
    const html = mergeHtmlBySection(rel, baseText, ordered, slices);
    if (html !== null) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, html);
      continue;
    }
  }

  // Line-level three-way merge, folded in slice order.
  let current = baseContent;
  for (const v of variants.sort((a, b) => a.slice - b.slice)) {
    current = merge3(rel, current, baseContent, v.content, slices);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, current);
}

// POST-MERGE SELF-CHECK: the auto-resolved union must be structurally sound
// before verify-merged (which then PROVES it boots + passes acceptance). Catch
// a bad merge HERE with a precise message instead of a confusing boot failure.
const selfCheck = [];
for (const rel of walk("app")) {
  if (!/\.(py|js|mjs|ts|html|css|json|md|txt)$/.test(rel)) continue;
  const txt = fs.readFileSync(path.join("app", rel), "utf8");
  if (/^(<{7}|={7}|>{7})/m.test(txt)) selfCheck.push(`${rel}: leftover merge conflict markers`);
}
const idxRel = "frontend/index.html";
if (fs.existsSync(path.join("app", idxRel)) && fs.existsSync(path.join(base, idxRel))) {
  const idx = fs.readFileSync(path.join("app", idxRel), "utf8");
  const opens = (idx.match(/<section\b/g) || []).length;
  const closes = (idx.match(/<\/section>/g) || []).length;
  if (opens !== closes) selfCheck.push(`${idxRel}: unbalanced <section> tags (${opens} open / ${closes} close)`);
  const baseIdx = fs.readFileSync(path.join(base, idxRel), "utf8");
  for (const m of baseIdx.matchAll(/<section\b[^>]*\sid="(screen-[A-Za-z0-9_-]+)"/g)) {
    if (!idx.includes(`id="${m[1]}"`)) selfCheck.push(`${idxRel}: screen '${m[1]}' dropped by the merge`);
  }
}
if (selfCheck.length) {
  console.error("MERGE SELF-CHECK FAILED (the union is not structurally sound):\n  " + selfCheck.join("\n  "));
  process.exit(1);
}
console.log("merge self-check OK: no conflict markers; index.html sections balanced and every screen present");

// The deterministic union succeeded with zero conflicts — record a clean
// healing report so the merge node's lessons channel always has an artifact.
// (On a genuine conflict this script exits BEFORE here, and the merge-healing
// agent writes remediation.json describing the conflict it resolved.)
fs.writeFileSync(
  "remediation.json",
  JSON.stringify({ step: "merge", healed: false, conflicts: 0, lessons: [] }, null, 2),
);

console.log(
  merged.length
    ? `merged ${merged.length} parallel slice(s) [${merged.map((i) => `slice-${i}`).join(", ")}] onto the foundation: ${changes.size} changed file(s), 0 conflicts`
    : "single-slice plan: foundation app carried forward unchanged",
);
