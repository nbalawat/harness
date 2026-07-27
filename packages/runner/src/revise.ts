// User-initiated revision: reopen a node (and its downstream closure) with
// feedback, so a resume re-derives everything that depended on it. Feedback is
// never applied where the user noticed the problem — it enters at the artifact
// it belongs to, and the dependency closure keeps every downstream artifact
// consistent. The journal stays append-only; revisions are auditable history.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectTypeDef } from "@harness/spec";
import type { RunContext } from "./context.js";
import { foldState } from "./scheduler.js";

/** The node plus every transitive dependent, in DAG declaration order. */
export function downstreamClosure(def: ProjectTypeDef, rootId: string): string[] {
  const dependents = new Map<string, string[]>();
  for (const n of def.nodes) {
    for (const d of n.deps ?? []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(n.id);
    }
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of dependents.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return def.nodes.filter((n) => seen.has(n.id)).map((n) => n.id);
}

/**
 * Reopen `nodeId` with user feedback, cascading to every downstream node that
 * has already run. Returns the reopened ids (root first). The caller resumes
 * the run to re-derive; memoization re-uses any node whose inputs are
 * unchanged, so a revision only pays for what it actually invalidates.
 */
export function reviseNode(ctx: RunContext, nodeId: string, feedback: string): { reopened: string[] } {
  const node = ctx.def.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`unknown node '${nodeId}'`);
  const state = foldState(ctx.journal.read());
  const ran = (id: string) => state.committed.has(id) || state.failed.has(id) || state.skipped.has(id);
  if (!ran(nodeId)) throw new Error(`node '${nodeId}' has not run yet — nothing to revise`);

  const closure = downstreamClosure(ctx.def, nodeId).filter(ran);
  for (const id of closure) {
    ctx.journal.append({
      type: "node.reopened",
      nodeId: id,
      reason: id === nodeId ? "user_revision" : "upstream_revised",
      revisionOf: nodeId,
      ...(id === nodeId ? { feedback: feedback.slice(0, 2000) } : {}),
    });
  }

  // The feedback channel: consumed by the node envelope on its next attempt
  // (same feedback.md mechanism agents already use for verify failures).
  const revDir = path.join(ctx.workspace, "revisions");
  fs.mkdirSync(revDir, { recursive: true });
  fs.writeFileSync(path.join(revDir, `${nodeId}.md`), feedback);

  // A revised gate must genuinely re-ask — drop its recorded dashboard answer
  // so the run parks there again instead of silently replaying the old choice.
  if (node.kind === "gate") {
    const uiAnswers = path.join(ctx.workspace, "ui-answers.json");
    if (fs.existsSync(uiAnswers)) {
      const answers = JSON.parse(fs.readFileSync(uiAnswers, "utf8")) as Record<string, unknown>;
      delete answers[nodeId];
      fs.writeFileSync(uiAnswers, JSON.stringify(answers, null, 2));
    }
  }
  return { reopened: closure };
}
