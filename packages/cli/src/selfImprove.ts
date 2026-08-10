// `harness self-improve` — the L3 weakness-mining loop, evaluator OUTSIDE the loop.
//
// The research frontier (Weng's Self-Harness, the awesome-harness-self-improvement
// list) is: mine recurring failure classes from real runs -> propose ONE bounded
// change -> validate against held-in AND held-out -> HUMAN reviews before merge.
// The hard-won safety rule is that the thing being improved never gets to grade
// itself. This command does the mine + propose + rank; it PRINTS proposals and
// changes nothing on disk. Applying a proposal is a human step, and any applied
// change must still pass `harness certify` (held-in + held-out) — the anchor the
// optimizer cannot argue with.
import * as fs from "node:fs";
import * as path from "node:path";
import { computeMetrics, type RunMetrics } from "./metrics.js";

interface Weakness {
  nodeId: string;
  runs: number; // runs where this node appeared
  retries: number;
  loopStrikes: number;
  reopens: number; // self-heal / revision cycles
  escalations: number; // times the node escalated model tier
  reworkRuns: number; // runs where this node was reopened (rework)
  auditRounds: number; // extra audit convergence waves (slice-audit)
}

function scanWorkspaces(root: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((d) => fs.existsSync(path.join(d, "run.json")) && fs.existsSync(path.join(d, "journal.jsonl")));
}

/** Weakness score: how much operator/agent effort this node repeatedly wastes. */
function score(w: Weakness): number {
  // Weighted toward signals that indicate a real, recurring harness gap:
  // doom-loops and escalations are dearer than a single retry.
  return w.loopStrikes * 5 + w.escalations * 3 + w.reopens * 2 + w.retries + w.auditRounds;
}

/** A bounded, class-specific proposal — never open-ended "rewrite the node". */
function proposeFix(w: Weakness): { class: string; change: string } {
  if (w.loopStrikes > 0) {
    return {
      class: "doom-loop",
      change:
        `Node '${w.nodeId}' hit the doom-loop guard ${w.loopStrikes}x. Tighten its verifier's feedback ` +
        `(more specific failure signature) or add a break-condition to its prompt; consider raising its escalateModel tier.`,
    };
  }
  if (w.escalations > w.runs / 2) {
    return {
      class: "under-powered-model",
      change:
        `Node '${w.nodeId}' escalated model tier in most runs — its base model is under-powered for the task. ` +
        `Raise its default 'model' one tier in dag.yaml so it succeeds first-attempt.`,
    };
  }
  if (w.reopens > 0 || w.reworkRuns > 0) {
    return {
      class: "high-rework",
      change:
        `Node '${w.nodeId}' is reopened/reworked repeatedly. Fold the recurring correction into build-expertise.md ` +
        `(a durable lesson) or tighten its acceptance so the first pass ships it right.`,
    };
  }
  if (w.auditRounds > w.runs) {
    return {
      class: "slow-convergence",
      change: `Node '${w.nodeId}' needs many audit rounds to converge. Add the recurring finding class to the audit checklist / build-expertise so slices avoid it.`,
    };
  }
  return {
    class: "retry-prone",
    change: `Node '${w.nodeId}' retries often. Clarify its prompt/contract or add an example to reduce first-attempt failures.`,
  };
}

export function selfImprove(root: string, opts: { top?: number; json?: boolean } = {}): number {
  const workspaces = scanWorkspaces(root);
  if (workspaces.length === 0) {
    console.error(`self-improve: no run workspaces under ${root} (need dirs with run.json + journal.jsonl)`);
    return 1;
  }
  const byNode = new Map<string, Weakness>();
  const get = (id: string): Weakness => {
    let w = byNode.get(id);
    if (!w) {
      w = { nodeId: id, runs: 0, retries: 0, loopStrikes: 0, reopens: 0, escalations: 0, reworkRuns: 0, auditRounds: 0 };
      byNode.set(id, w);
    }
    return w;
  };

  let scanned = 0;
  for (const ws of workspaces) {
    let m: RunMetrics;
    try {
      m = computeMetrics(ws);
    } catch {
      continue;
    }
    scanned++;
    const escById = new Map(m.escalations.map((e) => [e.nodeId, e]));
    const loopById = new Map<string, number>();
    for (const l of m.loopDetections) loopById.set(l.nodeId, (loopById.get(l.nodeId) ?? 0) + l.strikes);
    for (const n of m.nodes) {
      const w = get(n.nodeId);
      w.runs += 1;
      w.retries += n.retries;
      w.reopens += n.reopens;
      w.loopStrikes += loopById.get(n.nodeId) ?? 0;
      if (escById.has(n.nodeId)) w.escalations += 1;
      if (n.reopens > 0) w.reworkRuns += 1;
    }
    if (m.auditConvergence && m.auditConvergence.rounds > 1) {
      get("slice-audit").auditRounds += m.auditConvergence.rounds - 1;
    }
  }

  const ranked = [...byNode.values()]
    .filter((w) => score(w) > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, opts.top ?? 5)
    .map((w) => ({ ...w, score: score(w), proposal: proposeFix(w) }));

  if (opts.json) {
    console.log(JSON.stringify({ scanned, root, proposals: ranked }, null, 2));
    return 0;
  }

  console.log(`self-improve: mined ${scanned} run(s) under ${path.basename(root)} — top ${ranked.length} weakness class(es):\n`);
  if (ranked.length === 0) {
    console.log("  (no recurring weaknesses — the harness is converging cleanly across these runs)");
    return 0;
  }
  for (const w of ranked) {
    console.log(`  ● ${w.nodeId}  [${w.proposal.class}]  score ${w.score}  (in ${w.runs} run${w.runs === 1 ? "" : "s"})`);
    console.log(
      `      evidence: retries ${w.retries} · doom-loops ${w.loopStrikes} · escalations ${w.escalations} · reopens ${w.reopens}` +
        (w.auditRounds ? ` · extra-audit-rounds ${w.auditRounds}` : ""),
    );
    console.log(`      proposal: ${w.proposal.change}`);
    console.log("");
  }
  console.log(
    "These are PROPOSALS, not changes. Apply one, then it MUST re-certify (held-in + held-out) before merge —\n" +
      "the evaluator stays outside the loop, and a human reviews the consequential edit.",
  );
  return 0;
}
