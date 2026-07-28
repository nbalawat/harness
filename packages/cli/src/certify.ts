// Certification: the proof that "every time I build it, things work" —
// executed before a project-type version is released. Static completeness,
// golden-scenario replays with artifact digests, cost-envelope enforcement,
// and a revision drill (feedback loop + cascade + memoization).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AjvNS from "ajv";
import { Journal, foldState, loadProjectType, reviseNode, runLoop, type RunContext } from "@harness/runner";

const Ajv: typeof AjvNS.default =
  (AjvNS as unknown as { default?: typeof AjvNS.default }).default ??
  (AjvNS as unknown as typeof AjvNS.default);

export interface ScenarioReport {
  scenario: string;
  status: string;
  totalCostUsd: number;
  nodeCount: number;
  digest: string;
  driftedFiles?: string[];
}

export interface CertifyReport {
  name: string;
  version: string;
  ok: boolean;
  problems: string[];
  scenarios: ScenarioReport[];
  revisionDrill: { node: string; status: string; cachedReuses: number } | null;
  packageDigest: string;
  certifiedAt: string;
}

/** Files whose bytes legitimately vary between environments (renderer output). */
const DIGEST_EXCLUDE = [".png", ".jpg", ".pyc"];

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(root)) rec(root);
  return out;
}

/** Per-file sha256 of the artifacts tree, with workspace paths normalized. */
export function artifactDigest(workspace: string): { files: Record<string, string>; digest: string } {
  const root = path.join(workspace, "artifacts");
  const files: Record<string, string> = {};
  for (const abs of walkFiles(root)) {
    const rel = path.relative(root, abs);
    if (DIGEST_EXCLUDE.some((ext) => rel.endsWith(ext))) continue;
    const raw = fs.readFileSync(abs);
    const text = raw.toString("utf8");
    const normalized = text.includes(workspace) ? Buffer.from(text.split(workspace).join("<WS>")) : raw;
    files[rel] = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }
  const overall = crypto.createHash("sha256");
  for (const [rel, h] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) overall.update(rel + h);
  return { files, digest: overall.digest("hex").slice(0, 16) };
}

/** sha256 over the package source tree (excluding the certification record itself). */
export function packageDigest(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const abs of walkFiles(dir)) {
    const rel = path.relative(dir, abs);
    if (rel === "certification.json") continue;
    h.update(rel);
    h.update(fs.readFileSync(abs));
  }
  return h.digest("hex");
}

function staticChecks(dir: string, problems: string[]): void {
  const def = loadProjectType(dir);
  const ajv = new Ajv({ allErrors: true });
  for (const node of def.nodes) {
    if (node.kind === "agent") {
      if (!node.mock) problems.push(`agent '${node.id}' has no mock — certification replay impossible`);
      if (node.prompt && !fs.existsSync(path.join(dir, node.prompt))) {
        problems.push(`agent '${node.id}' prompt missing: ${node.prompt}`);
      }
    }
    for (const out of node.outputs ?? []) {
      if (!out.schema) continue;
      const schemaPath = path.join(dir, out.schema);
      if (!fs.existsSync(schemaPath)) {
        problems.push(`node '${node.id}' schema missing: ${out.schema}`);
        continue;
      }
      try {
        ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
      } catch (e) {
        problems.push(`node '${node.id}' schema invalid (${out.schema}): ${String(e).slice(0, 120)}`);
      }
    }
    for (const skill of node.skills ?? []) {
      if (!fs.existsSync(path.join(dir, "skills", skill, "SKILL.md"))) {
        problems.push(`node '${node.id}' declares missing certified skill: skills/${skill}/SKILL.md`);
      }
    }
    // Every $HARNESS_PROJECT_DIR-relative script referenced by any command must exist.
    for (const cmd of [node.command, node.verify, node.mock].filter(Boolean) as string[]) {
      for (const m of cmd.matchAll(/\$HARNESS_PROJECT_DIR\/([^\s"']+)/g)) {
        if (!fs.existsSync(path.join(dir, m[1]))) problems.push(`node '${node.id}' references missing script: ${m[1]}`);
      }
    }
  }
}

function makeCtx(workspace: string, projectTypeDir: string, answersFile: string): RunContext {
  fs.mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    projectTypeDir,
    def: loadProjectType(projectTypeDir),
    journal: new Journal(workspace),
    answers: JSON.parse(fs.readFileSync(answersFile, "utf8")) as Record<string, Record<string, string>>,
    mockAgents: true,
    acceptDefaults: true,
    interactive: false,
  };
}

export async function certify(
  projectTypeDir: string,
  opts: { updateGolden?: boolean } = {},
): Promise<CertifyReport> {
  const dir = path.resolve(projectTypeDir);
  const def = loadProjectType(dir);
  const problems: string[] = [];
  staticChecks(dir, problems);

  const fixturesDir = path.join(dir, "fixtures");
  const scenarios = fs.existsSync(fixturesDir)
    ? fs.readdirSync(fixturesDir).filter((f) => /^answers.*\.json$/.test(f)).sort()
    : [];
  if (scenarios.length === 0) problems.push("no golden scenarios (fixtures/answers*.json) — nothing to replay");

  const goldensDir = path.join(dir, "goldens");
  const reports: ScenarioReport[] = [];
  let firstCtx: RunContext | null = null;

  for (const scenario of scenarios) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `harness-certify-`));
    const ctx = makeCtx(workspace, dir, path.join(fixturesDir, scenario));
    if (!firstCtx) firstCtx = ctx;
    let result;
    try {
      result = await runLoop(ctx);
    } catch (e) {
      problems.push(`scenario '${scenario}' crashed: ${String(e).slice(0, 200)}`);
      reports.push({ scenario, status: "crashed", totalCostUsd: 0, nodeCount: 0, digest: "" });
      continue;
    }
    const state = foldState(ctx.journal.read());
    const report: ScenarioReport = {
      scenario,
      status: result.status,
      totalCostUsd: state.totalCostUsd,
      nodeCount: state.committed.size + state.skipped.size,
      digest: "",
    };
    if (result.status !== "completed") {
      problems.push(`scenario '${scenario}' did not complete: ${result.status} (${result.failedNodeId ?? result.parkedNodeId})`);
      reports.push(report);
      continue;
    }
    // Cost envelope: the certified promise includes "and it costs what we said".
    const envelope = def.cost?.run_budget_usd;
    if (envelope !== undefined && state.totalCostUsd > envelope) {
      problems.push(`scenario '${scenario}' simulated spend $${state.totalCostUsd.toFixed(2)} exceeds envelope $${envelope}`);
    }
    // Artifact digests: deterministic replay must produce identical artifacts.
    const { files, digest } = artifactDigest(workspace);
    report.digest = digest;
    const goldenFile = path.join(goldensDir, scenario.replace(/\.json$/, ".digest.json"));
    if (opts.updateGolden) {
      fs.mkdirSync(goldensDir, { recursive: true });
      fs.writeFileSync(goldenFile, JSON.stringify({ digest, files }, null, 2));
    } else if (fs.existsSync(goldenFile)) {
      const golden = JSON.parse(fs.readFileSync(goldenFile, "utf8")) as { digest: string; files: Record<string, string> };
      if (golden.digest !== digest) {
        const drifted = [
          ...Object.keys(files).filter((f) => golden.files[f] !== files[f]),
          ...Object.keys(golden.files).filter((f) => !(f in files)),
        ];
        report.driftedFiles = drifted.slice(0, 20);
        problems.push(`scenario '${scenario}' artifact drift vs golden: ${drifted.length} file(s) — ${drifted.slice(0, 5).join(", ")}`);
      }
    } else {
      problems.push(`scenario '${scenario}' has no golden digest — run with --update-golden to record one`);
    }
    reports.push(report);
  }

  // Revision drill: certify the feedback loop itself.
  let revisionDrill: CertifyReport["revisionDrill"] = null;
  const drill = def.certification?.revision_drill;
  if (drill && firstCtx && reports[0]?.status === "completed") {
    reviseNode(firstCtx, drill.node, drill.feedback);
    const result = await runLoop(firstCtx);
    const cached = firstCtx.journal.read().filter((e) => e.type === "node.committed" && e.cached === true).length;
    revisionDrill = { node: drill.node, status: result.status, cachedReuses: cached };
    if (result.status !== "completed") problems.push(`revision drill on '${drill.node}' did not re-derive to green`);
  }

  const report: CertifyReport = {
    name: def.name,
    version: def.version,
    ok: problems.length === 0,
    problems,
    scenarios: reports,
    revisionDrill,
    packageDigest: packageDigest(dir),
    certifiedAt: new Date().toISOString(),
  };
  if (report.ok) {
    // The release record: registry installs verify the package against this.
    fs.writeFileSync(path.join(dir, "certification.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
