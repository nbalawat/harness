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
  return loadProjectTypeFile(dagFile);
}

/** Load a specific DAG file — used for per-run immutable snapshots. */
export function loadProjectTypeFile(file: string): ProjectTypeDef {
  const def = parse(fs.readFileSync(file, "utf8")) as ProjectTypeDef;
  expandTemplates(def);
  validate(def);
  return def;
}

/**
 * Expand `repeat` nodes into concrete copies BEFORE validation, so the rest of
 * the system (scheduler, snapshot, revise) never sees a template — it sees a
 * plain list of nodes, identical to hand-writing them. A bare `${var}` scalar
 * becomes a number (so `slice: ${n}` stays an int); an embedded token like
 * `slice-${n}` string-substitutes; `${n-1}`/`${n+1}` do integer arithmetic.
 */
export function expandTemplates(def: ProjectTypeDef): void {
  if (!Array.isArray(def.nodes)) return;
  const out: NodeDef[] = [];
  for (const node of def.nodes) {
    if (!node.repeat) {
      out.push(node);
      continue;
    }
    const { var: v, from, to } = node.repeat;
    if (typeof v !== "string" || typeof from !== "number" || typeof to !== "number") {
      throw new Error(`dag.yaml: node '${node.id}' has an invalid repeat clause (need {var, from, to})`);
    }
    const { repeat: _omit, ...template } = node;
    void _omit;
    for (let i = from; i <= to; i++) {
      out.push(substituteDeep(template, v, i) as NodeDef);
    }
  }
  def.nodes = out;
}

const TOKEN = /\$\{([A-Za-z][A-Za-z0-9]*)([+-]\d+)?\}/g;

function evalToken(base: number, offset: string | undefined): number {
  return offset ? base + Number(offset) : base;
}

function substituteScalar(val: string, name: string, i: number): string | number {
  // A scalar that is EXACTLY one token → a number (preserves int-typed params).
  const bare = val.match(/^\$\{([A-Za-z][A-Za-z0-9]*)([+-]\d+)?\}$/);
  if (bare && bare[1] === name) return evalToken(i, bare[2]);
  // Otherwise substitute every token inline, leaving unknown vars untouched.
  return val.replace(TOKEN, (m, v: string, off: string | undefined) => (v === name ? String(evalToken(i, off)) : m));
}

function substituteDeep(obj: unknown, name: string, i: number): unknown {
  if (typeof obj === "string") return substituteScalar(obj, name, i);
  if (Array.isArray(obj)) return obj.map((x) => substituteDeep(x, name, i));
  if (obj && typeof obj === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) o[k] = substituteDeep(val, name, i);
    return o;
  }
  return obj;
}

/** Certified fan-in reducers a merge node may declare. */
const KNOWN_REDUCERS = new Set(["union-slices"]);

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
    validateMcpAttachment(def, node);
    // A declared fan-in reducer must be a known, certified strategy — an unknown
    // one is a packaging bug, caught at load rather than at merge time.
    if (node.reducer && !KNOWN_REDUCERS.has(node.reducer)) {
      throw new Error(`dag.yaml: node '${node.id}' declares unknown reducer '${node.reducer}' (known: ${[...KNOWN_REDUCERS].join(", ")})`);
    }
  }
  // Dead MCP config is a packaging bug: every declared instance must be attached.
  for (const name of Object.keys(def.mcp ?? {})) {
    if (!def.nodes.some((n) => (n.mcp ?? []).includes(name))) {
      throw new Error(`dag.yaml: mcp instance '${name}' is declared but no node attaches it`);
    }
  }
  assertAcyclic(def);
}

function validateMcpAttachment(def: ProjectTypeDef, node: NodeDef): void {
  const declared = def.mcp ?? {};
  for (const name of node.mcp ?? []) {
    if (!declared[name]) {
      throw new Error(`dag.yaml: node '${node.id}' attaches unknown mcp instance '${name}'`);
    }
    if (!(node.allowedTools ?? []).some((t) => t.startsWith(`mcp__${name}__`))) {
      throw new Error(
        `dag.yaml: node '${node.id}' attaches mcp '${name}' but allowlists none of its tools (mcp__${name}__<tool>)`,
      );
    }
  }
  for (const tool of node.allowedTools ?? []) {
    const m = tool.match(/^mcp__([a-z0-9-]+)__/);
    if (m && !(node.mcp ?? []).includes(m[1])) {
      throw new Error(`dag.yaml: node '${node.id}' allowlists tool '${tool}' without attaching mcp instance '${m[1]}'`);
    }
  }
}

function requireKindFields(node: NodeDef): void {
  const need = (cond: unknown, what: string) => {
    if (!cond) throw new Error(`dag.yaml: ${node.kind} node '${node.id}' requires ${what}`);
  };
  switch (node.kind) {
    case "agent":
      need(node.prompt, "a prompt file");
      // Subagent teams: definitions are certified data. A team without the
      // Task tool is unreachable — that's a packaging bug, caught at load.
      if (node.agents) {
        for (const [name, def] of Object.entries(node.agents)) {
          const sub = def as { description?: unknown; prompt?: unknown };
          need(
            typeof sub?.description === "string" && typeof sub?.prompt === "string",
            `subagent '${name}' with description and prompt`,
          );
        }
        need(
          (node.allowedTools ?? []).includes("Task"),
          `allowedTools including "Task" (its subagent team is unreachable without it)`,
        );
      }
      if (node.skills && node.skills.length > 0) {
        need(
          (node.allowedTools ?? []).includes("Skill"),
          `allowedTools including "Skill" (its certified skills are unreachable without it)`,
        );
      }
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
