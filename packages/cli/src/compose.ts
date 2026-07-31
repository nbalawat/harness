// `harness compose` — dynamic DAG composition from the certified stage
// library. A spec (YAML) picks stages, parameterizes them, and chains them;
// the output is a normal project-type package: same engine, same envelope,
// same certification path. Composition is dynamic; execution stays
// deterministic — agentic layers run inside the same certified node contract
// as every hand-authored type.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";
import { loadProjectType } from "@harness/runner";
import type { NodeDef } from "@harness/spec";

interface StageUse {
  use: string;
  id: string;
  deps?: string[];
  outputs?: Array<{ name: string; file: string; dir?: boolean }>;
  [param: string]: unknown;
}

interface ComposeSpec {
  name: string;
  version: string;
  description?: string;
  run_budget_usd?: number;
  stages: StageUse[];
}

function fill(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
      if (params[key] === undefined) throw new Error(`missing stage param '${key}'`);
      return String(params[key]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, params)]));
  }
  return value;
}

export function composeType(specFile: string, outDir: string, libraryDir: string): { nodes: number; dir: string } {
  const spec = parse(fs.readFileSync(specFile, "utf8")) as ComposeSpec;
  if (!spec.name || !spec.version || !Array.isArray(spec.stages) || !spec.stages.length) {
    throw new Error("spec needs name, version, and at least one stage");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const sub of ["prompts", "mocks", "scripts", "schemas"]) fs.mkdirSync(path.join(outDir, sub), { recursive: true });

  const nodes: NodeDef[] = [];
  let prev: string | null = null;
  for (const stage of spec.stages) {
    const stageDir = path.join(libraryDir, stage.use);
    if (!fs.existsSync(path.join(stageDir, "stage.yaml"))) {
      throw new Error(`unknown stage '${stage.use}' (library: ${fs.readdirSync(libraryDir).join(", ")})`);
    }
    const template = parse(fs.readFileSync(path.join(stageDir, "stage.yaml"), "utf8")) as Record<string, unknown>;
    const params = { ...stage, output: stage.output ?? `${stage.id}.md` };
    const node = fill(template, params) as NodeDef;
    node.id = stage.id;
    node.deps = stage.deps ?? (prev ? [prev] : []);
    // Gate stages pass their questions straight through (typed questions included).
    if (node.kind === "gate" && stage.questions) node.questions = stage.questions as NodeDef["questions"];
    if (node.kind === "gate" && stage.window !== undefined) node.window = stage.window as number;
    node.outputs =
      stage.outputs ??
      (node.kind === "gate"
        ? [{ name: stage.id, file: `${stage.id}.json` }]
        : node.kind === "verifier"
          ? undefined
          : stage.use === "package"
            ? [{ name: "bundle", file: "out", dir: true }]
            : [{ name: stage.id, file: String(params.output) }]);

    // Instantiate the stage's aux files with the same substitutions.
    const auxMap: Record<string, string> = {
      "prompt.md": `prompts/${stage.id}.md`,
      "mock.cjs": `mocks/${stage.id}.cjs`,
      "check.cjs": `scripts/${stage.id}.cjs`,
      "package.cjs": `scripts/${stage.id}.cjs`,
    };
    for (const [srcName, destRel] of Object.entries(auxMap)) {
      const src = path.join(stageDir, srcName);
      if (fs.existsSync(src)) {
        fs.writeFileSync(path.join(outDir, destRel), fill(fs.readFileSync(src, "utf8"), params) as string);
      }
    }
    nodes.push(node);
    prev = stage.id;
  }

  const def = {
    name: spec.name,
    version: spec.version,
    description: spec.description ?? `Composed from the certified stage library: ${spec.stages.map((s) => s.use).join(" -> ")}.`,
    cost: { run_budget_usd: spec.run_budget_usd ?? 25 },
    nodes,
  };
  fs.writeFileSync(
    path.join(outDir, "dag.yaml"),
    `# Composed by \`harness compose\` from ${path.basename(specFile)} — certified stage library.\n` + stringify(def),
  );
  loadProjectType(outDir); // structural validation: a composed type is held to the same bar
  return { nodes: nodes.length, dir: outDir };
}
