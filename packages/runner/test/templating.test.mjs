// Sub-graph templating: `repeat` expands into concrete nodes, byte-identical to
// hand-writing them. The parallel feature-slice blocks are the real use case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTemplates, loadProjectType } from "@harness/runner";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

test("repeat expands into one node per value, substituting ${var}", () => {
  const def = {
    nodes: [
      { id: "slice-1", kind: "agent" },
      {
        id: "slice-${n}",
        kind: "agent",
        repeat: { var: "n", from: 2, to: 4 },
        description: "Builds feature slice ${n}",
        params: { slice: "${n}", parallel: true },
        when: { artifact: "slice_plan", path: "slices.${n-1}", exists: true },
        deps: ["slice-1", "review-slice-1"],
        outputs: [{ name: "app_${n}", file: "app", dir: true }],
      },
    ],
  };
  expandTemplates(def);
  const ids = def.nodes.map((n) => n.id);
  assert.deepEqual(ids, ["slice-1", "slice-2", "slice-3", "slice-4"], "one node per n");

  const s3 = def.nodes.find((n) => n.id === "slice-3");
  assert.equal(s3.description, "Builds feature slice 3");
  assert.equal(s3.params.slice, 3, "a BARE ${n} scalar becomes a NUMBER, not a string");
  assert.equal(typeof s3.params.slice, "number");
  assert.equal(s3.params.parallel, true);
  assert.equal(s3.when.path, "slices.2", "${n-1} does integer arithmetic");
  assert.equal(s3.outputs[0].name, "app_3");
  assert.deepEqual(s3.deps, ["slice-1", "review-slice-1"], "fixed deps carry through unchanged");
});

test("repeat with ${var} in deps (review gates depend on their slice)", () => {
  const def = {
    nodes: [
      { id: "review-slice-${n}", kind: "gate", repeat: { var: "n", from: 2, to: 3 }, deps: ["slice-${n}"] },
    ],
  };
  expandTemplates(def);
  assert.deepEqual(def.nodes.find((n) => n.id === "review-slice-2").deps, ["slice-2"]);
  assert.deepEqual(def.nodes.find((n) => n.id === "review-slice-3").deps, ["slice-3"]);
});

test("nodes without repeat pass through untouched, order preserved", () => {
  const def = { nodes: [{ id: "a", kind: "deterministic" }, { id: "b-${n}", kind: "agent", repeat: { var: "n", from: 1, to: 2 } }, { id: "c", kind: "gate" }] };
  expandTemplates(def);
  assert.deepEqual(def.nodes.map((n) => n.id), ["a", "b-1", "b-2", "c"]);
  assert.equal(def.nodes[1].repeat, undefined, "the repeat field is stripped from expanded copies");
});

test("unknown variables are left untouched", () => {
  const def = { nodes: [{ id: "x-${n}", kind: "agent", repeat: { var: "n", from: 1, to: 1 }, note: "keep ${other} intact" }] };
  expandTemplates(def);
  assert.equal(def.nodes[0].note, "keep ${other} intact");
});

test("the flagship DAG: slice pool is 8 slots, merge declares its reducer", () => {
  const ptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..", "project-types", "agentic-app");
  const def = loadProjectType(ptDir);
  const slices = def.nodes.filter((n) => /^slice-[0-9]+$/.test(n.id)).map((n) => n.id);
  assert.deepEqual(slices, ["slice-1", "slice-2", "slice-3", "slice-4", "slice-5", "slice-6", "slice-7", "slice-8"], "pool lifted from 6 to 8");
  const merge = def.nodes.find((n) => n.id === "merge-slices");
  assert.equal(merge.reducer, "union-slices", "the fan-in reducer is declared");
  // slice-8 materializes only when the plan declares an 8th slice.
  assert.equal(def.nodes.find((n) => n.id === "slice-8").when.path, "slices.7");
});

test("an unknown reducer fails at load (auditable fan-in)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reducer-"));
  fs.writeFileSync(
    path.join(dir, "dag.yaml"),
    "name: t\nversion: 1.0.0\nnodes:\n  - id: a\n    kind: deterministic\n    command: 'true'\n  - id: m\n    kind: deterministic\n    command: 'true'\n    reducer: bogus-strategy\n    deps: [a]\n",
  );
  assert.throws(() => loadProjectType(dir), /unknown reducer 'bogus-strategy'/);
  fs.rmSync(dir, { recursive: true, force: true });
});
