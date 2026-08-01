// `harness lessons <workspace>` — the improvement loop's capture step.
// Reads a run's remediation waves (journal + revisions/*.md) and emits
// classified promotion candidates: each lesson pre-sorted into the certified
// layer that best prevents its class (scan rule / skill / plan rule / module).
// See docs/IMPROVEMENT-LOOP.md.
import * as fs from "node:fs";
import * as path from "node:path";
import { Journal } from "@harness/runner";
import type { LedgerEvent } from "@harness/spec";

type PromotionTarget = "scan-rule" | "skill-convention" | "plan-requirement" | "module-fix" | "review-only";

interface Lesson {
  wave: number;
  source: string; // merge conflict / security scan / code audit / live verification / user review
  target_step: string;
  finding: string;
  suggested_promotion: PromotionTarget;
  rationale: string;
}

/** Classify feedback text into the layer that best prevents its recurrence. */
function classify(source: string, text: string): { target: PromotionTarget; rationale: string } {
  const t = text.toLowerCase();
  // Substrate: the finding names a composed module file or the generic table API.
  if (/persistence-core|\/api\/\{table\}|ext_audit|ext_workflow|ext_blobs|ext_uploads|ext_seed|composed module|module standard/.test(t)) {
    return { target: "module-fix", rationale: "names a certified substrate/module surface — fix once in the module, every app inherits" };
  }
  // Deterministically greppable security/structure patterns -> a scan rule.
  if (/opt-out|if acting_user_email|no identity|unauthenticated|default[- ]?deny|duplicate.*id|route.*shadow|hardcoded|eval\(/.test(t)) {
    return { target: "scan-rule", rationale: "a deterministically detectable pattern — a security-scan/verifier rule catches the whole class at build time for $0" };
  }
  // Planning/verification obligations.
  if (/acceptance check|negative|anonymous|grounding|prove|must (also )?include|coverage|traceab/.test(t)) {
    return { target: "plan-requirement", rationale: "a planning obligation — a prompt rule + check-* gate rejects it before build spend" };
  }
  // Merge/boundary discipline agents must follow.
  if (/merge conflict|rebase|append|pure append|disjoint|surface|prefix/.test(t)) {
    return { target: "skill-convention", rationale: "a build-discipline convention — a certified skill teaches it before the agent writes code" };
  }
  return { target: "review-only", rationale: "case-specific — capture for the central team; no obvious mechanical gate yet" };
}

const SOURCE_OF = (fb: string | null): string => {
  if (!fb) return "user review";
  if (/^merge conflict/i.test(fb)) return "merge conflict";
  if (/security scan/i.test(fb)) return "security scan";
  if (/audit finding|security audit|security remediation/i.test(fb)) return "code audit";
  if (/functional gap|grounding/i.test(fb)) return "live verification";
  return "user review";
};

export function extractLessons(workspace: string): { lessons: Lesson[]; summary: Record<PromotionTarget | "total", number> } {
  const events = new Journal(workspace).read();
  const feedbackFile = (nodeId: string): string | null => {
    for (const name of [`${nodeId}-consumed.md`, `${nodeId}.md`]) {
      const p = path.join(workspace, "revisions", name);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
    return null;
  };

  // Group user_revision reopens into waves (a batch filed with no engine
  // activity between them is one wave) — same rule the dashboard uses.
  const waves: Array<{ feedbacks: Array<{ nodeId: string; feedback: string | null }> }> = [];
  let engineMoved = true;
  for (const e of events as LedgerEvent[]) {
    if (e.type === "node.running") engineMoved = true;
    if (e.type === "node.reopened" && e.reason === "user_revision") {
      if (engineMoved || waves.length === 0) {
        waves.push({ feedbacks: [] });
        engineMoved = false;
      }
      const fb = (e.feedback as string | undefined) ?? feedbackFile(String(e.nodeId));
      waves[waves.length - 1].feedbacks.push({ nodeId: String(e.nodeId), feedback: fb });
    }
  }

  const lessons: Lesson[] = [];
  waves.forEach((w, i) => {
    for (const f of w.feedbacks) {
      const source = SOURCE_OF(f.feedback);
      const { target, rationale } = classify(source, f.feedback ?? "");
      lessons.push({
        wave: i + 1,
        source,
        target_step: f.nodeId,
        finding: (f.feedback ?? "").split("\n").find((l) => l.trim().length > 12)?.slice(0, 200) ?? "",
        suggested_promotion: target,
        rationale,
      });
    }
  });

  const summary = { total: lessons.length } as Record<PromotionTarget | "total", number>;
  for (const l of lessons) summary[l.suggested_promotion] = (summary[l.suggested_promotion] ?? 0) + 1;
  return { lessons, summary };
}
