import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import type { NodeDef, ProjectTypeDef } from "@harness/spec";

/** Load and structurally validate a project-type package (dag.yaml). */
export function loadProjectType(dir: string): ProjectTypeDef {
  const dagFile = path.join(dir, "dag.yaml");
  if (!fs.existsSync(dagFile)) {
    throw new Error(`Not a project-type package (missing dag.yaml): ${dir}`);
  }
  const def = parse(fs.readFileSync(dagFile, "utf8")) as ProjectTypeDef;
  validate(def);
  return def;
}

function validate(def: ProjectTypeDef): void {
  if (!def.name || !def.version) throw new Error("dag.yaml: name and version are required");
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    throw new Error("dag.yaml: nodes must be a non-empty array");
  }
  const ids = new Set<string>();
  for (const node of def.nodes) {
    if (!node.id) throw new Error("dag.yaml: every node needs an id");
    if (ids.has(node.id)) throw new Error(`dag.yaml: duplicate node id '${node.id}'`);
    ids.add(node.id);
    for (const dep of node.deps ?? []) {
      if (!def.nodes.some((n) => n.id === dep)) {
        throw new Error(`dag.yaml: node '${node.id}' depends on unknown node '${dep}'`);
      }
    }
    requireKindFields(node);
  }
  assertAcyclic(def);
}

function requireKindFields(node: NodeDef): void {
  const need = (cond: unknown, what: string) => {
    if (!cond) throw new Error(`dag.yaml: ${node.kind} node '${node.id}' requires ${what}`);
  };
  switch (node.kind) {
    case "agent":
      need(node.prompt, "a prompt file");
      break;
    case "deterministic":
    case "verifier":
      need(node.command, "a command");
      break;
    case "gate":
      need(
        (node.questions && node.questions.length > 0) || node.questionsFrom,
        "questions or questionsFrom",
      );
      need(node.outputs && node.outputs.length === 1, "exactly one output artifact");
      break;
    default:
      throw new Error(`dag.yaml: node '${node.id}' has unknown kind '${String(node.kind)}'`);
  }
}

function assertAcyclic(def: ProjectTypeDef): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const visit = (id: string): void => {
    if (inStack.has(id)) throw new Error(`dag.yaml: dependency cycle involving '${id}'`);
    if (visited.has(id)) return;
    inStack.add(id);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep);
    inStack.delete(id);
    visited.add(id);
  };
  for (const node of def.nodes) visit(node.id);
}
