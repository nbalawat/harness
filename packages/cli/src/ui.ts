/**
 * Local web dashboard v2 — the human surface of a run.
 * Built for product users, not runner developers:
 * - every step explains itself (description, dependencies, live status)
 * - click a step to inspect it: agent transcript, attempts, cost + tokens
 * - Decisions panel: everything you answered/approved, with sources
 * - Documents panel: curated human-readable outputs (raw files tucked away)
 * - narrated activity; render-only-on-change; zero dependencies; localhost only
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Journal, downstreamClosure, foldState, loadProjectType, loadProjectTypeFile, reconcileInterrupted, reopenFailed, reviseNode, type RunContext } from "@harness/runner";
import type { GateQuestion, LedgerEvent, NodeDef, ProjectTypeDef } from "@harness/spec";

const IS_WIN = process.platform === "win32";

/**
 * Kill a spawned preview app AND its children (uvicorn workers), cross-platform.
 * POSIX signals the process group (needs the child spawned detached); Windows
 * has no such group signal, so taskkill /T walks the tree by PID.
 */
function killAppTree(pid: number): void {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

/** Expand $VAR / ${VAR} / %VAR% from env so a preview command works under any shell. */
function expandEnv(command: string, env: NodeJS.ProcessEnv): string {
  return command
    .replace(/\$\{(\w+)\}/g, (m, k) => (k in env ? String(env[k]) : m))
    .replace(/\$(\w+)/g, (m, k) => (k in env ? String(env[k]) : m))
    .replace(/%(\w+)%/g, (m, k) => (k in env ? String(env[k]) : m));
}

interface UiRunConfig {
  projectTypeDir: string;
  answersFile?: string;
  mockAgents: boolean;
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Curated, human-relevant documents (artifact name -> label + why you'd read it). */
const DOC_LABELS: Record<string, { label: string; blurb: string }> = {
  intake: { label: "Intake answers", blurb: "What you told the harness at kickoff" },
  corpus_index: { label: "Evidence index", blurb: "Sources and claims extracted from your documents" },
  requirements: { label: "Requirements", blurb: "Every requirement, with provenance and confidence" },
  gaps: { label: "Clarifying questions", blurb: "The questions the harness needed answered" },
  clarifications: { label: "Your clarifications", blurb: "Your answers, including accepted defaults" },
  architecture: { label: "Architecture & modules", blurb: "Chosen modules, deploy target, build budget plan" },
  designs: { label: "Design options index", blurb: "The generated design directions" },
  design_choice: { label: "Design choice", blurb: "The direction you approved" },
  data_model: { label: "Data model", blurb: "The tables backing your app" },
  agent_roster: { label: "Agent roster", blurb: "Your app's agents: roles, tools, policies, evals" },
  rtm: { label: "Traceability matrix", blurb: "Every requirement mapped to the design that addresses it" },
  design_review: { label: "Design approval", blurb: "Your pre-build confirmation" },
  slice_plan: { label: "Slice plan", blurb: "The feature-by-feature build plan with acceptance checks" },
  integration_report: { label: "Integration report", blurb: "Tests, agent evals, and container checks" },
  security_report: { label: "Security report", blurb: "Scan results and findings" },
  governance: { label: "Governance evidence pack", blurb: "Controls with proof, in one place" },
  uat: { label: "UAT sign-off", blurb: "Your final acceptance" },
};

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readArtifactJson(workspace: string, artifacts: Record<string, Record<string, string>>, name: string): Record<string, unknown> | null {
  for (const byNode of Object.values(artifacts)) {
    if (byNode[name]) return readJsonSafe(path.join(workspace, byNode[name]));
  }
  return null;
}

function readConfig(workspace: string): UiRunConfig {
  return JSON.parse(fs.readFileSync(path.join(workspace, "run.json"), "utf8")) as UiRunConfig;
}

function loadDef(workspace: string, projectTypeDir: string): ProjectTypeDef {
  const snapshot = path.join(workspace, "dag.snapshot.yaml");
  return fs.existsSync(snapshot) ? loadProjectTypeFile(snapshot) : loadProjectType(projectTypeDir);
}

function walk(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    // Forward slashes on every OS: these rels become artifact URLs and are
    // matched against '/'-based patterns — a Windows backslash breaks both.
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function resolveQuestions(
  workspace: string,
  node: NodeDef,
  artifacts: Record<string, Record<string, string>>,
): GateQuestion[] {
  if (node.questions) return node.questions;
  if (!node.questionsFrom) return [];
  for (const byNode of Object.values(artifacts)) {
    const rel = byNode[node.questionsFrom.artifact];
    if (!rel) continue;
    try {
      let value: unknown = JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));
      for (const seg of (node.questionsFrom.path ?? "questions").split(".")) {
        value = (value as Record<string, unknown>)?.[seg];
      }
      if (Array.isArray(value)) return value as GateQuestion[];
    } catch {
      /* partial write during live runs */
    }
  }
  return [];
}

/** Human sentence for an event — the Activity feed speaks product, not ledger. */
function narrate(e: LedgerEvent, costs: Map<string, { costUsd: number }>): string | null {
  const id = e.nodeId as string | undefined;
  switch (e.type) {
    case "run.created":
      return "Run started";
    case "run.completed":
      return "Run completed — everything green";
    case "run.parked":
      return `Waiting on you: ${id}`;
    case "run.failed":
      return `Run stopped${id ? ` at ${id}` : ""} — open the step for details`;
    case "node.running":
      return (e.attempt as number) > 1 ? `Retrying ${id} (attempt ${e.attempt})` : `Started ${id}`;
    case "node.committed": {
      if (e.cached === true) return `Re-used ${id} — inputs unchanged, previous result still valid`;
      const c = costs.get(`${id}`);
      const money = c && c.costUsd > 0 ? ` — $${c.costUsd.toFixed(2)}` : "";
      return `Finished ${id}${money}`;
    }
    case "node.attempt_failed":
      return `${id} attempt ${e.attempt} failed: ${String(e.error).split("\n")[0].slice(0, 110)}`;
    case "node.failed":
      return `${id} failed after all attempts`;
    case "node.skipped":
      return `Skipped ${id} (not needed for this run)`;
    case "node.reopened":
      if (e.reason === "user_revision") return `You requested changes to ${id} — it will re-run with your feedback`;
      if (e.reason === "upstream_revised") return `Reopened ${id} — it depends on ${e.revisionOf}, which you revised`;
      return `Reopened ${id} for another try`;
    case "gate.answered":
      return `You answered ${id} (${e.source})`;
    case "budget.exceeded":
      return e.scope === "questions"
        ? `${id} tried to over-ask and was blocked`
        : `Budget exceeded (${e.scope}${id ? `: ${id}` : ""})`;
    case "agent.question_denied":
      return `${id} tried to ask a mid-step question — denied; it proceeds on recorded assumptions`;
    default:
      return null; // cost.recorded + agent.message roll up elsewhere
  }
}

export function buildState(workspace: string): Record<string, unknown> {
  const config = readConfig(workspace);
  const def = loadDef(workspace, config.projectTypeDir);
  const events = new Journal(workspace).read();
  const state = foldState(events);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));

  const costs: Record<
    string,
    { costUsd: number; wallClockMs: number; tokensIn: number; tokensOut: number; model?: string }
  > = {};
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of events) {
    if (e.type !== "cost.recorded") continue;
    const c = e.cost as {
      costUsd: number;
      wallClockMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      model?: string;
    };
    const agg = (costs[e.nodeId as string] ??= { costUsd: 0, wallClockMs: 0, tokensIn: 0, tokensOut: 0 });
    agg.costUsd += c.costUsd;
    agg.wallClockMs += c.wallClockMs;
    agg.tokensIn += c.inputTokens + c.cacheReadTokens;
    agg.tokensOut += c.outputTokens;
    if (c.model) agg.model = c.model;
    tokensIn += c.inputTokens + c.cacheReadTokens;
    tokensOut += c.outputTokens;
  }

  const running = new Set<string>();
  // Retry counts are PER INCARNATION: a reopen (revision / remediation) starts
  // a fresh cycle. Lifetime attempt totals read as "retry ×10" on a step whose
  // failures were separate, explained remediation waves — pure alarm noise.
  const retries: Record<string, number> = {};
  // How many remediation waves touched each node — the pipeline rows wear this.
  const revisedCount: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "node.running") running.add(e.nodeId as string);
    if (e.type === "node.reopened") {
      retries[e.nodeId as string] = 0;
      revisedCount[e.nodeId as string] = (revisedCount[e.nodeId as string] ?? 0) + (e.reason === "user_revision" ? 1 : 0);
    }
    if (e.type === "node.attempt_failed") retries[e.nodeId as string] = (retries[e.nodeId as string] ?? 0) + 1;
  }

  // The engine lock is the authoritative liveness signal: while an engine
  // holds it, the run is RUNNING no matter what stale park/fail events sit in
  // the journal tail (a reopened gate's old park must never resurrect its
  // question form — answers submitted to a phantom form go nowhere).
  let engineAlive = false;
  try {
    const pid = Number(fs.readFileSync(path.join(workspace, "engine.lock"), "utf8"));
    if (pid) {
      process.kill(pid, 0);
      engineAlive = true;
    }
  } catch {
    /* no lock or dead holder */
  }
  const lastLifecycle = [...events]
    .reverse()
    .find(
      (e) =>
        e.type === "run.completed" ||
        e.type === "run.parked" ||
        e.type === "run.failed" ||
        e.type === "run.cancelled",
    );
  const runStatus = engineAlive
    ? "running"
    : lastLifecycle?.type === "run.completed"
      ? "completed"
      : lastLifecycle?.type === "run.parked"
        ? "parked"
        : lastLifecycle?.type === "run.failed"
          ? "failed"
          : lastLifecycle?.type === "run.cancelled"
            ? "cancelled"
            : "running";
  const parkedNodeId =
    runStatus === "parked" && lastLifecycle?.nodeId && !state.committed.has(String(lastLifecycle.nodeId))
      ? String(lastLifecycle.nodeId)
      : null;

  const dependents: Record<string, string[]> = {};
  for (const n of def.nodes) {
    for (const d of n.deps ?? []) (dependents[d] ??= []).push(n.id);
  }

  const nodes = def.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    phase: n.phase ?? "Steps",
    description: n.description ?? null,
    deps: n.deps ?? [],
    feeds: dependents[n.id] ?? [],
    model: costs[n.id]?.model ?? n.model ?? null,
    state: state.committed.has(n.id)
      ? "committed"
      : state.skipped.has(n.id)
        ? "skipped"
        : state.failed.has(n.id)
          ? "failed"
          : n.id === parkedNodeId
            ? "parked"
            : running.has(n.id)
              ? // A node still reading "running" while NO engine holds the lock was
                // interrupted (a stop, a crash, or an orchestrator budget kill). It
                // is not live work — surface it as failed so it stops hanging and
                // can be resumed/revised. A live engine keeps it as "started".
                engineAlive
                ? "started"
                : "failed"
              : "pending",
    cost: costs[n.id] ?? null,
    retries: retries[n.id] ?? 0,
    revised: revisedCount[n.id] ?? 0,
  }));

  // Decisions: every answer/approval you gave, with question text + sources.
  const decisions: unknown[] = [];
  for (const e of events.filter((e) => e.type === "gate.answered")) {
    const node = byId.get(e.nodeId as string);
    if (!node) continue;
    const questions = resolveQuestions(workspace, node, state.artifacts);
    const qById = new Map(questions.map((q) => [q.id, q]));
    decisions.push({
      gate: node.id,
      description: node.description ?? null,
      ts: e.ts,
      source: e.source,
      items: Object.entries(e.answers as Record<string, string>).map(([qid, answer]) => {
        const q = qById.get(qid);
        return {
          prompt: q?.prompt ?? qid,
          answer,
          why: q?.why ?? null,
          defaulted: q?.default !== undefined && answer === q.default,
        };
      }),
    });
  }
  let assumptions: unknown[] = [];
  for (const byNode of Object.values(state.artifacts)) {
    if (byNode?.rtm) {
      try {
        assumptions = (JSON.parse(fs.readFileSync(path.join(workspace, byNode.rtm), "utf8")) as { assumptions: unknown[] })
          .assumptions;
      } catch {
        /* live write */
      }
    }
  }

  // Documents: curated human-readable outputs; raw files tucked behind "advanced".
  const documents: { label: string; blurb: string; node: string; href: string; fetch: string }[] = [];
  for (const [nodeId, byName] of Object.entries(state.artifacts)) {
    for (const [name, rel] of Object.entries(byName)) {
      const meta = DOC_LABELS[name];
      if (meta && rel.endsWith(".json")) {
        // Normalize to forward slashes and strip the artifacts/ prefix — a
        // Windows-authored rel carries backslashes that would 404 in the URL.
        const clean = rel.replace(/\\/g, "/").replace(/^artifacts\//, "");
        // Every artifact URL must carry the workspace — in the multi-run
        // dashboard a bare /artifact/ path 404s (documents that "don't open").
        const wsq = `?ws=${encodeURIComponent(workspace)}`;
        documents.push({ ...meta, node: nodeId, href: `/view/${clean}${wsq}`, fetch: `/artifact/${clean}${wsq}` });
      }
    }
  }
  documents.sort(
    (a, b) => def.nodes.findIndex((n) => n.id === a.node) - def.nodes.findIndex((n) => n.id === b.node),
  );
  const docsWithPhase = documents.map((d) => ({ ...d, phase: byId.get(d.node)?.phase ?? "Steps" }));

  // Quality summary — the test/security/coverage results, front and center.
  const integration = readArtifactJson(workspace, state.artifacts, "integration_report");
  const security = readArtifactJson(workspace, state.artifacts, "security_report");
  const governance = readArtifactJson(workspace, state.artifacts, "governance");
  const rtmDoc = readArtifactJson(workspace, state.artifacts, "rtm");
  const slicePlanDoc = readArtifactJson(workspace, state.artifacts, "slice_plan");
  const quality = {
    backendTests: (integration?.backend_tests as { status?: string } | undefined)?.status ?? null,
    backendSummary: (integration?.backend_tests as { summary?: string } | undefined)?.summary ?? null,
    evals: (integration?.evals as { status?: string; passed?: number; total?: number } | undefined) ?? null,
    composeConfig: (integration?.compose_config as string | undefined) ?? null,
    composeSmoke: (integration?.compose_smoke as string | undefined) ?? null,
    securityHigh: (security?.high_count as number | undefined) ?? null,
    securityFindings: Array.isArray(security?.findings) ? (security!.findings as unknown[]).length : null,
    requirementsCovered:
      (governance?.requirements as { covered?: number; total?: number } | undefined) ??
      (rtmDoc ? { covered: rtmDoc.covered_count as number, total: rtmDoc.requirements_total as number } : null),
    assumptionCount: Array.isArray(rtmDoc?.assumptions) ? (rtmDoc!.assumptions as unknown[]).length : null,
    slicesPlanned: Array.isArray(slicePlanDoc?.slices) ? (slicePlanDoc!.slices as unknown[]).length : null,
    slicesDelivered: def.nodes.filter((n) => /^slice-[0-9]+$/.test(n.id) && state.committed.has(n.id)).length,
  };

  // ---- Remediation timeline: original -> finding -> feedback -> re-derive ----
  // The journal holds the whole story; the UI must narrate it. A WAVE is a
  // batch of feedback filed together (no engine activity between the
  // revisions) plus everything that re-derived because of it.
  const classifySource = (fb: string | null): string => {
    if (!fb) return "review feedback";
    if (/^merge conflict/i.test(fb)) return "merge conflict";
    if (/security scan/i.test(fb)) return "security scan";
    if (/audit finding|security audit/i.test(fb)) return "code audit";
    if (/^functional gap/i.test(fb)) return "live verification";
    return "user review";
  };
  // Feedback delivered through the file channel (revisions/<node>[-consumed].md)
  // never reaches the journal — read it from disk so the story stays complete.
  const feedbackFile = (nodeId: string): string | null => {
    for (const name of [`${nodeId}-consumed.md`, `${nodeId}.md`]) {
      const p = path.join(workspace, "revisions", name);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").slice(0, 2000);
    }
    return null;
  };
  interface Wave {
    startedAt: unknown;
    startIdx: number;
    endIdx: number;
    feedbacks: Array<{ nodeId: string; source: string; feedback: string | null }>;
    reopened: string[];
  }
  const waves: Wave[] = [];
  let engineMovedSinceLastRevision = true;
  events.forEach((e, i) => {
    if (e.type === "node.running") engineMovedSinceLastRevision = true;
    if (e.type !== "node.reopened") return;
    if (e.reason === "user_revision") {
      if (engineMovedSinceLastRevision || waves.length === 0) {
        waves.push({ startedAt: e.ts, startIdx: i, endIdx: i, feedbacks: [], reopened: [] });
        engineMovedSinceLastRevision = false;
      }
      const w = waves[waves.length - 1];
      const fb = (e.feedback as string | undefined) ?? feedbackFile(String(e.nodeId));
      w.feedbacks.push({ nodeId: String(e.nodeId), source: classifySource(fb), feedback: fb });
      w.endIdx = i;
    } else if (waves.length > 0) {
      // cascades + operator reopens ride the wave they follow
      waves[waves.length - 1].endIdx = i;
    }
    if (waves.length > 0) {
      const w = waves[waves.length - 1];
      if (!w.reopened.includes(String(e.nodeId))) w.reopened.push(String(e.nodeId));
    }
  });
  // Cascaded slices that got their feedback via the file channel: surface it.
  for (const w of waves) {
    for (const id of w.reopened) {
      if (w.feedbacks.some((f) => f.nodeId === id)) continue;
      const fb = feedbackFile(id);
      if (fb && classifySource(fb) !== "review feedback") {
        // only attach when it's clearly targeted feedback, not stale leftovers
        if (!waves.some((other) => other !== w && other.feedbacks.some((f) => f.nodeId === id && f.feedback === fb))) {
          w.feedbacks.push({ nodeId: id, source: classifySource(fb), feedback: fb });
        }
      }
    }
  }
  // Per wave: what actually happened to each reopened step (scan events after
  // the wave, capped at the next wave's start so actions attribute correctly).
  // A wave's verdict is IN-SPAN truth — what happened during THAT wave — never
  // the current state, or history retroactively turns green once later waves fix it.
  const pickErrorLine = (err: unknown): string => {
    const lines = String(err ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    return (lines.find((l) => /conflict|blocked|failed|error/i.test(l) && l.length > 12) ?? lines[0] ?? "").slice(0, 160);
  };
  const remediation = waves.slice(-8).map((w, wi, arr) => {
    const globalIdx = waves.indexOf(w);
    // Exact index boundaries (never timestamp equality — two events can share
    // a millisecond): a wave owns events (startIdx, nextWave.startIdx].
    const capIdx = globalIdx + 1 < waves.length ? waves[globalIdx + 1].startIdx : events.length;
    const startIdx = w.startIdx;
    // Trigger: the failure that provoked this wave (nearest failed event
    // before its first reopen; absent for pure user-initiated feedback).
    let trigger: { nodeId: string; summary: string } | null = null;
    for (let i = startIdx - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "node.running" || e.type === "node.committed") break; // engine activity precedes: no immediate failure trigger
      if (e.type === "node.attempt_failed" || e.type === "node.failed") {
        const err = events.slice(0, i + 1).reverse().find((x) => x.type === "node.attempt_failed" && x.nodeId === e.nodeId);
        trigger = { nodeId: String(e.nodeId), summary: pickErrorLine(err?.error) };
        break;
      }
    }
    // ROBUST per-wave state: fold the journal UP TO the wave boundary — the
    // exact same fold the engine uses. This is the ground-truth state at the
    // moment the wave's span ended, immune to messy spans that contain several
    // terminal events (multiple resumes, operator bumps, manual reopens). No
    // heuristic terminal-scanning, no current-state leakage.
    const atEnd = foldState(events.slice(0, capIdx));
    const stillRunning = (id: string) => {
      // A node whose last event before the boundary is node.running (no
      // matching commit/fail after) is mid-flight at the boundary.
      for (let i = capIdx - 1; i >= startIdx; i--) {
        const e = events[i];
        if (e.nodeId !== id) continue;
        return e.type === "node.running";
      }
      return false;
    };
    const nodeOutcome = (id: string): string =>
      atEnd.committed.has(id) ? "committed"
        : atEnd.failed.has(id) ? "failed"
          : atEnd.skipped.has(id) ? "skipped"
            : stillRunning(id) ? "re-running"
              : "pending";

    // Terminal verdict = the LAST run-lifecycle event WITHIN this wave's own
    // span (never the whole DAG's stale state). No terminal in span means the
    // wave never reached one — the user filed more feedback first (superseded),
    // or it's the live wave still running (active).
    let ended: { kind: string; nodeId?: string; summary?: string } = {
      kind: globalIdx + 1 < waves.length ? "superseded" : "active",
    };
    let lastTerminalIdx = -1;
    for (let i = startIdx + 1; i < capIdx; i++) {
      const e = events[i];
      if (e.type === "run.completed") { ended = { kind: "completed" }; lastTerminalIdx = i; }
      else if (e.type === "run.failed") {
        const failedId = String(e.nodeId ?? def.nodes.find((n) => atEnd.failed.has(n.id))?.id ?? "");
        const err = events.slice(0, i + 1).reverse().find((x) => x.type === "node.attempt_failed" && x.nodeId === failedId);
        ended = { kind: "failed", nodeId: failedId, summary: pickErrorLine(err?.error) };
        lastTerminalIdx = i;
      }
    }
    // Recovery: if the engine ran again AFTER the last terminal (e.g. a budget
    // bump + resume) with no new terminal since, a stale failed/completed must
    // not stand — the wave is live again.
    if (lastTerminalIdx >= 0 && ended.kind !== "completed") {
      for (let i = capIdx - 1; i > lastTerminalIdx; i--) {
        if (events[i].type === "node.running" || events[i].type === "node.committed") {
          ended = { kind: globalIdx + 1 < waves.length ? "superseded" : "active" };
          break;
        }
      }
    }

    const actions = w.reopened.map((id) => {
      let attempts = 0;
      let costUsd = 0;
      let cached = false;
      let firstRunIdx = Number.MAX_SAFE_INTEGER;
      for (let i = w.endIdx + 1; i < capIdx; i++) {
        const e = events[i];
        if (e.nodeId !== id) continue;
        if (e.type === "node.running") { attempts++; if (i < firstRunIdx) firstRunIdx = i; }
        if (e.type === "cost.recorded") costUsd += (e.cost as { costUsd?: number })?.costUsd ?? 0;
        if (e.type === "node.committed") { cached = e.cached === true; if (i < firstRunIdx) firstRunIdx = i; }
        if ((e.type === "node.skipped" || e.type === "node.failed") && i < firstRunIdx) firstRunIdx = i;
      }
      // Outcome is the BOUNDARY-FOLD truth, never the span-scan (a node re-run
      // in a LATER wave must not read as this wave's outcome).
      return { nodeId: id, outcome: nodeOutcome(id), cached, attempts, costUsd: Number(costUsd.toFixed(2)), firstRunIdx };
    });
    // The propagation chain reads in EXECUTION order (the order the engine
    // actually re-derived things), never reopen order — pending steps trail
    // in DAG declaration order so "what's next" reads naturally.
    const dagOrder = new Map(def.nodes.map((n, i) => [n.id, i]));
    actions.sort((a, b) =>
      a.firstRunIdx !== b.firstRunIdx
        ? a.firstRunIdx - b.firstRunIdx
        : (dagOrder.get(a.nodeId) ?? 0) - (dagOrder.get(b.nodeId) ?? 0),
    );
    // Remaining = not satisfied AT THE BOUNDARY (not current state — else a
    // later wave's fixes retroactively empty an earlier wave's remaining).
    const remaining = w.reopened.filter((id) => !atEnd.committed.has(id) && !atEnd.skipped.has(id));
    // EVERY node's state at the boundary — so a wave lens can render even the
    // steps this wave didn't reopen at their state WHEN THE WAVE RAN, not now.
    // (This is the fix for "superseded wave shows the whole pipeline green":
    // steps the wave never reached read pending, not their eventual commit.)
    const nodeStates: Record<string, string> = {};
    for (const n of def.nodes) {
      nodeStates[n.id] = atEnd.committed.has(n.id) ? "committed"
        : atEnd.failed.has(n.id) ? "failed"
          : atEnd.skipped.has(n.id) ? "skipped"
            : stillRunning(n.id) ? "re-running"
              : "pending";
    }
    // KIND: a wave that fixes a DEFECT is a remediation; a wave that adds/changes
    // a REQUIREMENT is an enhancement. The signal is the entry point — feedback
    // routed to the requirements node (the CR front door) is a change of intent,
    // not a fix of a broken build. "Remediation" on a healthy new-requirement
    // wave gives exactly the wrong impression.
    const reqNodeId = def.nodes.find((n) => (n.outputs ?? []).some((o) => o.name === "requirements"))?.id;
    const isChange = reqNodeId ? w.feedbacks.some((f) => f.nodeId === reqNodeId) : false;
    const kind = isChange ? "enhancement" : "remediation";
    return {
      wave: globalIdx + 1,
      at: w.startedAt,
      kind,
      feedbacks: w.feedbacks,
      reopened: w.reopened,
      remaining,
      actions,
      trigger,
      ended,
      nodeStates,
      // What THIS wave cost — the reconciliation the user asked for: every
      // remediation/enhancement cycle's spend, attributed and summable.
      costUsd: Number(actions.reduce((s, a) => s + (a.costUsd || 0), 0).toFixed(2)),
      // legacy fields the banner uses
      nodeId: w.feedbacks[0]?.nodeId ?? w.reopened[0],
      feedback: w.feedbacks[0]?.feedback ?? null,
    };
  });
  const firstCompleted = events.find((e) => e.type === "run.completed");
  const originalBuild = {
    completedAt: firstCompleted?.ts ?? null,
    costUsd: Number(
      events
        .filter((e) => e.type === "cost.recorded" && (!waves[0] || String(e.ts) <= String(waves[0].startedAt)))
        .reduce((s, e) => s + ((e.cost as { costUsd?: number })?.costUsd ?? 0), 0)
        .toFixed(2),
    ),
  };

  // Open review window: the run is WAITING (not parked) for a verdict.
  let windowGate: Record<string, unknown> | null = null;
  const lastWindow = [...events].reverse().find((e) => e.type === "gate.window_open");
  if (lastWindow) {
    const answered = events.some(
      (e) => (e.type === "gate.answered" || e.type === "node.committed") && e.nodeId === lastWindow.nodeId && Date.parse(String(e.ts)) >= Date.parse(String(lastWindow.ts)),
    );
    if (!answered && Number(lastWindow.deadlineMs) > Date.now()) {
      const node = byId.get(String(lastWindow.nodeId));
      windowGate = {
        nodeId: lastWindow.nodeId,
        deadlineMs: lastWindow.deadlineMs,
        description: node?.description ?? null,
        questions: node ? resolveQuestions(workspace, node, state.artifacts) : [],
      };
    }
  }

  // Design delivery: the promise (contract) vs the proof (coverage).
  const contractDoc = readArtifactJson(workspace, state.artifacts, "design_contract") as
    | { totals?: { screens: number; elements: number } }
    | null;
  const coverageDoc = readArtifactJson(workspace, state.artifacts, "design_coverage") as
    | { screens?: Array<Record<string, unknown>>; totals?: Record<string, number> }
    | null;
  const designDelivery = contractDoc
    ? {
        promised: contractDoc.totals ?? null,
        delivered: coverageDoc?.totals ?? null,
        screens: (coverageDoc?.screens ?? []).map((sc) => ({
          ...sc,
          shotHref: sc.shot ? `/artifact/design-coverage/${sc.shot}` : null,
        })),
      }
    : null;

  const intakeDoc = readArtifactJson(workspace, state.artifacts, "intake");
  const designChoiceDoc = readArtifactJson(workspace, state.artifacts, "design_choice");
  const rosterDoc = readArtifactJson(workspace, state.artifacts, "agent_roster");
  const workflowsDoc = readArtifactJson(workspace, state.artifacts, "workflows");
  const pendingQuestion = readJsonSafe(path.join(workspace, "pending-question.json"));

  // Slice progress screenshots (shipped inside the app artifact by verify-slice),
  // captioned with the slice's planned name and its demo declaration.
  const sliceShots: { slice: string; href: string; name?: string; caption?: string }[] = [];
  for (const rel of walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts"))) {
    const m = rel.match(new RegExp("^(slice-[0-9]+)/app/screenshots/(slice-[0-9]+)[.]png$"));
    if (m && m[1] === m[2].replace("slice-", "slice-")) {
      if (rel.startsWith(m[2].split(".")[0])) {
        const shot: { slice: string; href: string; name?: string; caption?: string } = { slice: m[2], href: "/artifact/" + rel + `?ws=${encodeURIComponent(workspace)}` };
        const idx = Number(m[2].split("-")[1]);
        const planned = (slicePlanDoc?.slices as { name: string }[] | undefined)?.[idx - 1];
        if (planned) shot.name = planned.name;
        const demo = readJsonSafe(path.join(workspace, "artifacts", m[1], "app", "demo", `${m[2]}.json`)) as { caption?: string } | null;
        if (demo?.caption) shot.caption = demo.caption;
        sliceShots.push(shot);
      }
    }
  }

  let designOptions: unknown = null;
  for (const byNode of Object.values(state.artifacts)) {
    if (byNode.designs) {
      try {
        designOptions = (JSON.parse(fs.readFileSync(path.join(workspace, byNode.designs), "utf8")) as { options: unknown })
          .options;
      } catch {
        /* live write */
      }
    }
  }

  // Slice nodes adopt their planned identity: "slice-2" becomes the actual
  // feature being built, from the committed slice plan.
  if (Array.isArray(slicePlanDoc?.slices)) {
    const planned = slicePlanDoc!.slices as { id: string; name: string; story: string }[];
    for (const n of nodes) {
      const m = n.id.match(/^slice-(\d+)$/);
      if (m && planned[Number(m[1]) - 1]) {
        const sl = planned[Number(m[1]) - 1];
        n.description = `${sl.name} — ${sl.story}`;
      }
    }
  }

  const costMap = new Map(Object.entries(costs).map(([k, v]) => [k, { costUsd: v.costUsd }]));
  const firstTs = events[0]?.ts;
  const lastTs = events[events.length - 1]?.ts;
  const activeMs = Object.values(costs).reduce((sum, c) => sum + c.wallClockMs, 0);

  return {
    projectType: `${def.name}@${def.version}`,
    projectDescription: def.description ?? null,
    runMode: config.mockAgents ? "replay" : "live",
    appName: (intakeDoc?.project_name as string | undefined) ?? null,
    problemStatement: (intakeDoc?.problem_statement as string | undefined) ?? null,
    quality,
    designChoice: (designChoiceDoc?.chosen_option as string | undefined) ?? null,
    windowGate,
    remediation,
    originalBuild,
    // Cost reconciliation across the whole run: what the first build cost vs
    // what remediation/enhancement cycles added — the money story, itemized.
    costBreakdown: {
      originalUsd: originalBuild.costUsd,
      remediationUsd: Number(remediation.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(2)),
      totalUsd: Number(state.totalCostUsd.toFixed(2)),
      waves: remediation.length,
    },
    remediationActive: remediation.some((r) => r.ended.kind === "active"),
    designDelivery,
    appAgents: Array.isArray(rosterDoc?.agents) ? rosterDoc!.agents : null,
    agentOpportunityMap: Array.isArray(rosterDoc?.opportunity_map) ? rosterDoc!.opportunity_map : null,
    appWorkflows: Array.isArray(workflowsDoc?.workflows) ? workflowsDoc!.workflows : null,
    pendingQuestion,
    sliceShots,
    workspace,
    totalCostUsd: state.totalCostUsd,
    runBudgetUsd: def.cost?.run_budget_usd ?? null,
    tokensIn,
    tokensOut,
    status: runStatus,
    engineAlive,
    nodes,
    parkedGate:
      parkedNodeId && byId.get(parkedNodeId)
        ? { nodeId: parkedNodeId, questions: resolveQuestions(workspace, byId.get(parkedNodeId)!, state.artifacts) }
        : null,
    decisions,
    assumptions,
    documents: docsWithPhase,
    designOptions,
    elapsedMs: firstTs && lastTs ? Date.parse(String(lastTs)) - Date.parse(String(firstTs)) : 0,
    activeMs,
    startedAt: firstTs ?? null,
    rawArtifacts: walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts")),
    // Every event carries WHICH run phase it belongs to — original build or
    // remediation wave N — so the activity log can group and label it.
    events: events
      .map((e, i) => ({
        ts: e.ts,
        type: e.type,
        nodeId: e.nodeId ?? null,
        phase: waves.length === 0 || (waves[0] && i < waves[0].startIdx)
          ? "build"
          : "wave-" + ((waves.filter((w) => w.startIdx <= i).pop()?.startIdx ?? -1) >= 0
              ? waves.indexOf(waves.filter((w) => w.startIdx <= i).pop()!) + 1
              : 0),
        text: narrate(e, costMap),
      }))
      .filter((e) => e.text !== null)
      .slice(-200),
    // Security findings surfaced directly (was only reachable as raw JSON).
    securityReport: security
      ? {
          high: (security.high_count as number | undefined) ?? 0,
          findings: Array.isArray(security.findings) ? (security.findings as Array<Record<string, unknown>>).slice(0, 200) : [],
          filesScanned: (security.files_scanned as number | undefined) ?? null,
        }
      : null,
    // Code-audit findings (the deeper opus review), likewise surfaced.
    auditReport: (() => {
      const a = readArtifactJson(workspace, state.artifacts, "audit") as Record<string, unknown> | null;
      return a && Array.isArray(a.findings)
        ? { status: a.status, findings: (a.findings as Array<Record<string, unknown>>).slice(0, 200), files: (a.checked as { files?: number })?.files ?? null }
        : null;
    })(),
  };
}

/** Step inspector: attempts, errors, cost/tokens, and the agent's transcript. */
export function buildNodeDetail(workspace: string, nodeId: string): Record<string, unknown> | null {
  const config = readConfig(workspace);
  const def = loadDef(workspace, config.projectTypeDir);
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const events = new Journal(workspace).read().filter((e) => e.nodeId === nodeId);

  const attempts: Record<number, { started?: string; error?: string; costUsd?: number; tokens?: number; wallClockMs?: number }> =
    {};
  for (const e of events) {
    const n = e.attempt as number | undefined;
    if (n === undefined) continue;
    const a = (attempts[n] ??= {});
    if (e.type === "node.running") a.started = e.ts;
    if (e.type === "node.attempt_failed") a.error = String(e.error).slice(0, 1200);
    if (e.type === "cost.recorded") {
      const c = e.cost as {
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        wallClockMs: number;
      };
      a.costUsd = c.costUsd;
      a.tokens = c.inputTokens + c.cacheReadTokens + c.outputTokens;
      a.wallClockMs = c.wallClockMs;
    }
  }

  const transcript = events
    .filter((e) => e.type === "agent.message")
    .slice(-120)
    .map((e) => ({ attempt: e.attempt, message: e.message }));

  const sessionInfoEvent = events.filter((e) => e.type === "agent.session_info").pop();
  const toolCounts: Record<string, number> = {};
  for (const t of transcript) {
    const parts = (t.message as { parts?: { kind: string; label?: string }[] } | undefined)?.parts ?? [];
    for (const p of parts) if (p.kind === "tool" && p.label) toolCounts[p.label] = (toolCounts[p.label] ?? 0) + 1;
  }
  const questions = events
    .filter((e) => e.type === "agent.question_asked" || e.type === "agent.question_answered" || e.type === "agent.question_denied")
    .map((e) => ({ type: e.type, ts: e.ts }));

  // What the step actually ran and what it produced — without this, verifier
  // and deterministic steps read as black boxes in the dashboard.
  const results: { name: string; file: string; href: string; entries: { k: string; v: string }[] }[] = [];
  for (const out of node.outputs ?? []) {
    if (!out.file || !out.file.endsWith(".json")) continue;
    const abs = path.join(workspace, "artifacts", nodeId, out.file);
    if (!fs.existsSync(abs)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
      if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
      const entries = Object.entries(data)
        .slice(0, 24)
        .map(([k, v]) => ({
          k,
          v:
            v === null
              ? "—"
              : Array.isArray(v)
                ? `${v.length} item${v.length === 1 ? "" : "s"}`
                : typeof v === "object"
                  ? JSON.stringify(v).slice(0, 160)
                  : String(v),
        }));
      results.push({ name: out.name, file: out.file, href: `/artifact/${nodeId}/${out.file}`, entries });
    } catch {
      /* live write */
    }
  }

  let plannedDesc: string | null = null;
  const planMatch = nodeId.match(/^slice-(\d+)$/);
  if (planMatch) {
    try {
      const planPath = path.join(workspace, "artifacts", "slice-plan", "slice_plan.json");
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { slices: { name: string; story: string; addresses?: string[] }[] };
      const sl = plan.slices[Number(planMatch[1]) - 1];
      if (sl) plannedDesc = `${sl.name} — ${sl.story}` + (sl.addresses?.length ? ` (covers ${sl.addresses.join(", ")})` : "");
    } catch {
      /* plan not committed yet */
    }
  }

  // Slice objectives ledger: the acceptance evidence recorded at verification.
  if (planMatch) {
    try {
      const rep = JSON.parse(
        fs.readFileSync(path.join(workspace, "artifacts", nodeId, "app", "acceptance_report.json"), "utf8"),
      ) as { slices: { slice: string; name: string; objective: string; checks: { method: string; path: string; ok: boolean }[] }[] };
      const mine = rep.slices[rep.slices.length - 1];
      if (mine) {
        results.unshift({
          name: `Objective proven: ${mine.name}`,
          file: "app/acceptance_report.json",
          href: `/artifact/${nodeId}/app/acceptance_report.json`,
          entries: [
            { k: "objective", v: mine.objective },
            ...mine.checks.map((c) => ({ k: `${c.method} ${c.path}`, v: c.ok ? "proven ✓" : "FAILED" })),
            { k: "plus", v: `all ${rep.slices.length - 1} previous slices re-proven + backend test suite` },
          ],
        });
      }
    } catch {
      /* not verified yet */
    }
  }

  // Findings belong to the step that PRODUCED them: security-scan (rules) and
  // slice-audit (semantic). Grouped by area for the drawer, so a wall of text
  // becomes a triage list where you drill down by category.
  let findings: { high: number; total: number; groups: { area: string; items: { severity: string; file: string; line?: number; text: string }[] }[] } | null = null;
  const findingSources: Array<{ name: string; sevKey?: string }> = [
    { name: "security_report" },
    { name: "audit" },
  ];
  const rawFindings: Array<{ severity: string; area: string; file: string; line?: number; text: string }> = [];
  for (const src of findingSources) {
    const doc = readArtifactJson(workspace, foldState(new Journal(workspace).read()).artifacts, src.name) as Record<string, unknown> | null;
    // only attach to the node that actually owns this artifact
    if (!node.outputs?.some((o) => o.name === src.name)) continue;
    const arr = (doc?.findings as Array<Record<string, unknown>>) ?? [];
    for (const f of arr) {
      rawFindings.push({
        severity: String(f.severity ?? "medium"),
        area: String(f.area ?? f.rule ?? "other"),
        file: String(f.file ?? ""),
        line: f.line as number | undefined,
        text: String(f.finding ?? f.detail ?? ""),
      });
    }
  }
  if (rawFindings.length) {
    const byArea = new Map<string, typeof rawFindings>();
    const sevRank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    for (const f of rawFindings) {
      if (!byArea.has(f.area)) byArea.set(f.area, []);
      byArea.get(f.area)!.push(f);
    }
    const groups = [...byArea.entries()]
      .map(([area, items]) => ({
        area,
        items: items.sort((a, b) => (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1)),
        _high: items.filter((i) => i.severity === "high").length,
      }))
      .sort((a, b) => b._high - a._high || b.items.length - a.items.length)
      .map(({ area, items }) => ({ area, items }));
    findings = { high: rawFindings.filter((f) => f.severity === "high").length, total: rawFindings.length, groups };
  }

  const describe = (id: string) => def.nodes.find((n) => n.id === id)?.description ?? null;
  let promptText: string | null = null;
  if (node.prompt) {
    try {
      promptText = fs.readFileSync(path.join(config.projectTypeDir, node.prompt), "utf8").slice(0, 6000);
    } catch {
      promptText = null;
    }
  }
  return {
    prompt: promptText,
    id: node.id,
    kind: node.kind,
    description: plannedDesc ?? node.description ?? null,
    deps: (node.deps ?? []).map((d) => ({ id: d, description: describe(d) })),
    feeds: def.nodes.filter((n) => (n.deps ?? []).includes(nodeId)).map((n) => ({ id: n.id, description: n.description ?? null })),
    model: node.model ?? null,
    escalateModel: node.escalateModel ?? null,
    hasVerify: Boolean(node.verify),
    command: node.command ?? null,
    verifyCommand: node.verify ?? null,
    results,
    findings,
    attempts: Object.entries(attempts).map(([n, a]) => ({ attempt: Number(n), ...a })),
    transcript,
    toolCounts,
    sessionInfo: sessionInfoEvent
      ? { tools: sessionInfoEvent.tools ?? [], agents: sessionInfoEvent.agents ?? [], model: sessionInfoEvent.model ?? null }
      : null,
    questions,
  };
}

function mergeAnswers(workspace: string, nodeId: string, answers: Record<string, string>): string {
  const file = path.join(workspace, "ui-answers.json");
  const config = readConfig(workspace);
  const existing: Record<string, Record<string, string>> = {};
  if (config.answersFile && fs.existsSync(config.answersFile)) {
    Object.assign(existing, JSON.parse(fs.readFileSync(config.answersFile, "utf8")));
  }
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
    for (const [k, v] of Object.entries(prev)) existing[k] = { ...existing[k], ...v };
  }
  existing[nodeId] = { ...existing[nodeId], ...answers };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  return file;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as net.AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.on("error", reject);
  });
}

interface AppPreview {
  status: "stopped" | "starting" | "running" | "failed";
  port: number | null;
  node: string | null;
  pid: number | null;
  error?: string;
}

/** Scan a directory for run workspaces — the storefront of built apps. */
/** The viewer whose apps to show. Absent (local single-user) => show everything. */
export interface Viewer {
  identity: string;
  teams?: string[];
}

export function scanRuns(root: string, viewer?: Viewer): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return runs;
  }
  const teams = new Set(viewer?.teams ?? []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, "run.json")) || !fs.existsSync(path.join(dir, "journal.jsonl"))) continue;
    // Multi-tenant scoping: a viewer sees only runs they own or that belong to a
    // team they're on. No viewer (local) => unfiltered, backward-compatible.
    let owner: string | undefined;
    let team: string | undefined;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as { owner?: string; team?: string };
      owner = cfg.owner;
      team = cfg.team;
    } catch {
      /* legacy run.json */
    }
    if (viewer && owner && owner !== viewer.identity && !(team && teams.has(team))) continue;
    try {
      const st = buildState(dir) as Record<string, any>;
      // newest slice screenshot = the card thumbnail
      let thumb: string | null = null;
      const shots = (st.sliceShots ?? []) as { slice: string; href: string }[];
      if (shots.length > 0) thumb = `/thumb/${encodeURIComponent(entry.name)}/${shots[shots.length - 1].slice}`;
      const nodes = (st.nodes ?? []) as { state: string }[];
      runs.push({
        dir,
        name: entry.name,
        owner,
        team,
        scope: team ? "team" : "individual",
        mine: viewer ? owner === viewer.identity : undefined,
        appName: st.appName ?? entry.name,
        projectType: st.projectType,
        status: st.status,
        runMode: st.runMode,
        costUsd: st.totalCostUsd,
        problem: String(st.problemStatement ?? "").slice(0, 160),
        thumb,
        progress: { done: nodes.filter((n) => n.state === "committed" || n.state === "skipped").length, total: nodes.length },
        needsYou: Boolean(st.parkedGate || st.pendingQuestion),
        updatedAt: fs.statSync(path.join(dir, "journal.jsonl")).mtime.toISOString(),
      });
    } catch {
      /* unreadable workspace — skip */
    }
  }
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return runs.slice(0, 50);
}

/** The CLI entry to spawn for resume — dist sibling in source layout, the bundle itself when bundled. */
function cliEntryPath(): string {
  try {
    const sibling = fileURLToPath(new URL("./index.js", import.meta.url));
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    /* bundled: import.meta.url is shimmed */
  }
  return process.argv[1];
}

export function startUiServer(target: string, port: number): Promise<http.Server> {
  const singleMode = fs.existsSync(path.join(target, "run.json"));
  const root = singleMode ? path.dirname(target) : target;
  let workspace: string | null = singleMode ? target : null;
  let resuming = false;
  const artifactsRoot = (ws?: string | null) => path.join(ws ?? workspace ?? target, "artifacts");

  /** Per-tab independence: ?ws=<dir> selects the run for THIS request only —
   * ten builds in ten tabs, none fighting over server-side selection. */
  /**
   * Route free-text feedback to its entry point. Deterministic scoring: a
   * strong, unambiguous match against ONE slice's story/screens/endpoints ->
   * targeted slice fix; explicit new-capability language or a weak/ambiguous
   * match -> the requirements front door (the cascade re-derives the plan and
   * delivers the change to the right slice with provenance either way).
   */
  function routeFeedback(ws: string, text: string): { mode: string; target: string | null; why: string } {
    const t = " " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    const newReq =
      /(new requirement|new feature|new screen|new report|new table|should also|also (want|need)|we (also )?need|must now|going forward|from now on|add support for|as well as)/.test(t);
    const plan = readJsonSafe(path.join(ws, "artifacts", "slice-plan", "slice_plan.json")) as
      | { slices?: Array<{ id: string; name?: string; story?: string; covers?: string[]; acceptance?: Array<{ path?: string }> }> }
      | null;
    const STOP = new Set(["this", "that", "with", "from", "have", "does", "screen", "slice", "should", "when", "user", "users", "into", "onto", "them", "then", "there", "deal", "deals", "will", "would"]);
    const scores = (plan?.slices ?? []).map((s, i) => {
      let score = 0;
      const hits: string[] = [];
      const weigh = (src: unknown, w: number) => {
        for (const word of String(src ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
          if (word.length < 4 || STOP.has(word) || hits.includes(word)) continue;
          if (t.includes(" " + word + " ") || t.includes(word)) {
            score += w;
            hits.push(word);
          }
        }
      };
      weigh(s.id, 1);
      weigh(s.name, 1);
      weigh(s.story, 1);
      for (const c of s.covers ?? []) weigh(c.replace(/^screen-/, ""), 3);
      for (const a of s.acceptance ?? []) weigh(a.path, 2);
      return { slice: `slice-${i + 1}`, id: s.id, score, hits };
    }).sort((a, b) => b.score - a.score);
    const [best, second] = scores;
    if (best && best.score >= 4 && (!second || best.score >= second.score * 1.6) && !newReq) {
      return { mode: "fix-slice", target: best.slice, why: `matched '${best.id}' (${best.hits.slice(0, 5).join(", ")})` };
    }
    return {
      mode: "new-requirement",
      target: null,
      why: newReq
        ? "reads as a new or changed requirement — entering through requirements keeps provenance and re-plans correctly"
        : best && best.score > 0
          ? `no single slice matched decisively (top: ${best.id} ${best.score} vs ${second?.id ?? "-"} ${second?.score ?? 0}) — the requirements front door re-derives the plan and routes it safely`
          : "no slice matched — the requirements front door re-derives the plan and routes it safely",
    };
  }

  function wsFrom(url: URL): string | null {
    const ws = url.searchParams.get("ws");
    if (!ws) return null;
    const abs = path.resolve(ws);
    if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(path.join(abs, "run.json"))) return null;
    return abs;
  }

  // One app preview per run, so tab A's launch doesn't kill tab B's.
  const apps = new Map<string, AppPreview>();
  const appFor = (ws: string): AppPreview => {
    if (!apps.has(ws)) apps.set(ws, { status: "stopped", port: null, node: null, pid: null });
    return apps.get(ws)!;
  };

  /** project-types/ dirs shipped with the harness itself (npm package or source
   * checkout) — found by walking up from this module/bundle's location. Users
   * run `harness ui` anywhere and still get the certified catalog. */
  function packagedProjectTypeRoots(): string[] {
    const roots: string[] = [];
    let base: string;
    try {
      base = path.dirname(fileURLToPath(import.meta.url));
    } catch {
      base = path.dirname(process.argv[1] ?? ".");
    }
    for (let i = 0; i < 5 && base !== path.dirname(base); i++) {
      const cand = path.join(base, "project-types");
      if (fs.existsSync(cand)) roots.push(cand);
      base = path.dirname(base);
    }
    const home = process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
    if (fs.existsSync(path.join(home, "store"))) roots.push(path.join(home, "store"));
    return roots;
  }

  /** Certified project types the storefront can start a new build from. */
  function availableProjectTypes(): { name: string; version: string; dir: string; description: string }[] {
    const out: { name: string; version: string; dir: string; description: string }[] = [];
    const seen = new Set<string>();
    for (const ptRoot of [path.join(root, "project-types"), ...packagedProjectTypeRoots()]) {
      if (!fs.existsSync(ptRoot)) continue;
      for (const entry of fs.readdirSync(ptRoot)) {
        const dir = path.join(ptRoot, entry);
        if (!fs.existsSync(path.join(dir, "dag.yaml"))) continue;
        try {
          const def = loadProjectType(dir);
          const key = `${def.name}@${def.version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name: def.name, version: def.version, dir, description: def.description ?? "" });
        } catch {
          /* uncertifiable package — not offered */
        }
      }
    }
    return out;
  }

  /** Minimal RunContext for revision bookkeeping (never dispatches nodes itself). */
  function revisionCtx(ws: string): RunContext {
    const config = readConfig(ws);
    return {
      workspace: ws,
      projectTypeDir: config.projectTypeDir,
      def: loadDef(ws, config.projectTypeDir),
      journal: new Journal(ws),
      answers: undefined,
      mockAgents: config.mockAgents,
      acceptDefaults: false,
      interactive: false,
    };
  }

  /** Continue the run in a child CLI process; ui-answers ride along when present. */
  function spawnResume(extraArgs: string[] = [], ws?: string): void {
    const w = ws ?? workspace!;
    const cliEntry = cliEntryPath();
    const uiAnswers = path.join(w, "ui-answers.json");
    const args =
      extraArgs.length > 0
        ? [cliEntry, "resume", w, ...extraArgs]
        : [cliEntry, "resume", w, ...(fs.existsSync(uiAnswers) ? ["--answers", uiAnswers] : [])];
    resuming = true;
    const child = spawn(process.execPath, args, { stdio: "ignore", detached: false });
    child.on("exit", () => (resuming = false));
  }

  function latestAppArtifact(ws?: string | null): { node: string; dir: string } | null {
    const w = ws ?? workspace;
    if (!w) return null;
    const config = readConfig(w);
    const def = loadDef(w, config.projectTypeDir);
    const artifactName = def.preview?.artifact ?? "app";
    const state = foldState(new Journal(w).read());
    let found: { node: string; dir: string } | null = null;
    for (const n of def.nodes) {
      const rel = state.artifacts[n.id]?.[artifactName];
      if (rel) found = { node: n.id, dir: path.join(w, rel) };
    }
    return found;
  }

  function stopApp(ws?: string | null): void {
    const targets = ws ? [appFor(ws)] : [...apps.values()];
    for (const app of targets) {
      if (app.pid) {
        killAppTree(app.pid);
      }
      app.status = "stopped";
      app.port = null;
      app.pid = null;
    }
  }

  async function startApp(ws?: string | null): Promise<void> {
    const w = ws ?? workspace;
    if (!w) return;
    stopApp(w);
    const app = appFor(w);
    const config = readConfig(w);
    const def = loadDef(w, config.projectTypeDir);
    const preview = def.preview;
    const latest = latestAppArtifact(w);
    if (!preview || !latest) {
      app.status = "failed";
      app.error = preview ? "no app artifact committed yet" : "project type declares no preview";
      return;
    }
    const runDir = path.join(w, "app-preview");
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.cpSync(latest.dir, runDir, { recursive: true });

    const appPort = await getFreePort();
    app.status = "starting";
    app.node = latest.node;
    app.error = undefined;
    const logFile = path.join(w, "app-preview.log");
    const log = fs.openSync(logFile, "w");
    const previewEnv = { ...process.env, PORT: String(appPort) };
    const child = spawn(expandEnv(preview.command, previewEnv), {
      shell: true,
      detached: !IS_WIN, // POSIX: group leader for group-kill; Windows: taskkill /T by PID
      cwd: path.join(runDir, preview.cwd ?? "."),
      env: previewEnv,
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    app.pid = child.pid ?? null;
    child.on("exit", () => {
      if (app.pid === child.pid && app.status !== "stopped") {
        app.status = app.status === "running" ? "stopped" : "failed";
        if (app.status === "failed") {
          let tail = "";
          try {
            tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-6).join(" | ");
          } catch {
            /* no log */
          }
          app.error = "app process exited during startup: " + tail.slice(-300);
        }
        app.pid = null;
        app.port = null;
      }
    });
    const healthUrl = "http://127.0.0.1:" + appPort + (preview.health ?? "/");
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (app.pid !== child.pid) return;
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          app.status = "running";
          app.port = appPort;
          return;
        }
      } catch {
        /* booting */
      }
    }
    app.status = "failed";
    app.error = "app did not become healthy within 60s";
  }

  // Optional access gate for hosted deployments. When HARNESS_UI_TOKEN is set,
  // every request must present it (via ?token=, an hui cookie, or a Bearer
  // header); otherwise a small unlock page is shown. Local runs leave it unset.
  // In production this sits BEHIND firm SSO (ALB-OIDC) as well — defence in depth.
  const UI_TOKEN = process.env.HARNESS_UI_TOKEN || "";
  const tokenOk = (provided: string): boolean => {
    if (!provided || provided.length !== UI_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(UI_TOKEN)); // constant-time
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (UI_TOKEN) {
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("hui="));
      const qtok = url.searchParams.get("token") || "";
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const provided = qtok || bearer || (cookie ? decodeURIComponent(cookie.slice(4)) : "");
      if (!tokenOk(provided)) {
        res.writeHead(401, { "content-type": "text/html" });
        res.end(
          `<!doctype html><meta charset=utf-8><title>Harness — sign in</title><body style="font:15px/1.5 system-ui;max-width:420px;margin:12vh auto;padding:0 1rem;color:#111"><h2 style="font-weight:650">Harness</h2><p>Enter your access token to continue.</p><form method=get><input name=token type=password autofocus placeholder="access token" style="width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;font-size:1rem"><button style="margin-top:.6rem;padding:.55rem 1rem;border:0;border-radius:8px;background:#2f4a8a;color:#fff;font-size:1rem;cursor:pointer">Enter</button></form></body>`,
        );
        return;
      }
      if (qtok) {
        // Valid token in the URL → set a cookie and strip it from the address bar.
        res.writeHead(302, { "set-cookie": `hui=${encodeURIComponent(UI_TOKEN)}; HttpOnly; Path=/; SameSite=Lax`, location: url.pathname });
        res.end();
        return;
      }
    }
    // Hosted, multi-tenant gallery: read runs from the shared run-index (scoped
    // to the caller by identity/team) instead of scanning the local disk. This is
    // what makes the UI stateless — any instance serves any user. Falls back to the
    // local scan on error. Set HARNESS_RUN_INDEX_URL to enable.
    if (url.pathname === "/api/runs" && process.env.HARNESS_RUN_INDEX_URL) {
      const ident = (req.headers["x-amzn-oidc-identity"] as string) || (req.headers["x-firm-identity"] as string) || process.env.HARNESS_IDENTITY || "";
      void (async () => {
        const base = { root, selected: workspace, viewer: ident || null, cloudBuild: Boolean(process.env.HARNESS_BUILDER_CODEBUILD), projectTypes: availableProjectTypes() };
        try {
          const u = new URL("/v1/runs", process.env.HARNESS_RUN_INDEX_URL);
          if (!ident) u.searchParams.set("all", "1");
          const r = await fetch(u, { headers: ident ? { "x-firm-identity": ident } : {} });
          const data = (await r.json()) as { runs?: unknown[]; teams?: string[] };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...base, runs: data.runs ?? [], teams: data.teams ?? [] }));
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...base, runs: scanRuns(root, ident ? { identity: ident } : undefined) }));
        }
      })();
      return;
    }
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      } else if (url.pathname === "/api/runs") {
        res.writeHead(200, { "content-type": "application/json" });
        // Scope the gallery to the caller when hosted: identity from SSO/IAP
        // headers (or HARNESS_IDENTITY). No identity (local) => everything.
        const ident = (req.headers["x-amzn-oidc-identity"] as string) || (req.headers["x-firm-identity"] as string) || process.env.HARNESS_IDENTITY || "";
        const teams = (process.env.HARNESS_TEAMS || "").split(",").map((t) => t.trim()).filter(Boolean);
        const viewer = ident ? { identity: ident, teams } : undefined;
        res.end(JSON.stringify({ root, runs: scanRuns(root, viewer), selected: workspace, viewer: ident || null, teams, cloudBuild: Boolean(process.env.HARNESS_BUILDER_CODEBUILD), projectTypes: availableProjectTypes() }));
      } else if (url.pathname === "/api/cloud-build" && req.method === "POST") {
        // Trigger a build+deploy in AWS via the certified CodeBuild pipeline:
        // the harness builds the app in-cloud, then the deploy module ships it to
        // App Runner. Enabled only when HARNESS_BUILDER_CODEBUILD names the project.
        const project = process.env.HARNESS_BUILDER_CODEBUILD;
        if (!project) {
          res.writeHead(400).end(JSON.stringify({ error: "cloud build not configured (set HARNESS_BUILDER_CODEBUILD)" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let p: { name?: string; target?: string; domain?: string };
          try {
            p = JSON.parse(body);
          } catch {
            res.writeHead(400).end(JSON.stringify({ error: "invalid JSON" }));
            return;
          }
          const name = String(p.name || "");
          if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
            res.writeHead(400).end(JSON.stringify({ error: "name must be lowercase letters/digits/hyphens" }));
            return;
          }
          const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
          const overrides = [
            `name=APP_NAME,value=${name}`,
            `name=TARGET,value=${p.target === "aws-ecs" ? "aws-ecs" : "aws-apprunner"}`,
            `name=AWS_DEFAULT_REGION,value=${region}`,
          ];
          if (p.domain) overrides.push(`name=DOMAIN,value=${String(p.domain)}`);
          // aws CLI is in the hosted image; the App Runner instance role grants StartBuild.
          const r = spawnSync("aws", ["codebuild", "start-build", "--project-name", project, "--region", region,
            "--environment-variables-override", ...overrides, "--query", "build.id", "--output", "text"], { encoding: "utf8" });
          if (r.status !== 0) {
            res.writeHead(502).end(JSON.stringify({ error: "could not start cloud build: " + String(r.stderr).slice(0, 200) }));
            return;
          }
          const buildId = r.stdout.trim();
          const console_ = `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${project}/build/${encodeURIComponent(buildId)}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, buildId, console: console_, appName: name }));
        });
      } else if (url.pathname === "/api/new-run" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const { name, projectTypeDir } = JSON.parse(body) as { name: string; projectTypeDir: string };
            if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
              res.writeHead(400).end(JSON.stringify({ error: "name must be lowercase letters/digits/hyphens" }));
              return;
            }
            const ptAbs = path.resolve(projectTypeDir);
            if (!availableProjectTypes().some((p) => path.resolve(p.dir) === ptAbs)) {
              res.writeHead(400).end(JSON.stringify({ error: "unknown project type" }));
              return;
            }
            const ws = path.join(root, name);
            if (fs.existsSync(ws)) {
              res.writeHead(400).end(JSON.stringify({ error: `'${name}' already exists — pick another name` }));
              return;
            }
            // Live agents, no recorded answers: the run parks at intake and the
            // dashboard walks the user through the whole Q&A from there.
            spawn(process.execPath, [cliEntryPath(), "run", ptAbs, "--workspace", ws], { stdio: "ignore", detached: false });
            for (let i = 0; i < 40 && !fs.existsSync(path.join(ws, "journal.jsonl")); i++) {
              await new Promise((r) => setTimeout(r, 250));
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, dir: ws }));
          } catch (e) {
            res.writeHead(500).end(JSON.stringify({ error: String(e) }));
          }
        });
      } else if (url.pathname === "/api/select" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { dir } = JSON.parse(body) as { dir: string };
          const abs = path.resolve(dir);
          if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(path.join(abs, "run.json"))) {
            res.writeHead(400).end("not a run workspace under the served root");
            return;
          }
          workspace = abs;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (url.pathname === "/api/deselect" && req.method === "POST") {
        workspace = null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (workspace === null && wsFrom(url) === null && url.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ selected: false }));
      } else if (url.pathname === "/api/state") {
        const ws = wsFrom(url) ?? workspace!;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            selected: true,
            ...buildState(ws),
            resuming,
            app: appFor(ws),
            appAvailable: latestAppArtifact(ws) !== null,
            appStageNode: latestAppArtifact(ws)?.node ?? null,
          }),
        );
      } else if (url.pathname === "/api/upload" && req.method === "POST") {
        // Intake documents, uploaded from the dashboard: stored under the
        // run's workspace so the ingest step (and provenance) can reach them.
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 60_000_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const { files } = JSON.parse(body) as { files: Array<{ name: string; data: string }> };
            const ws = wsFrom(url) ?? workspace!;
            const dir = path.join(ws, "inputs");
            fs.mkdirSync(dir, { recursive: true });
            const saved: string[] = [];
            for (const f of files ?? []) {
              const name = path.basename(String(f.name)).replace(/[^\w.\- ]/g, "_");
              if (!name || !f.data) continue;
              fs.writeFileSync(path.join(dir, name), Buffer.from(String(f.data), "base64"));
              saved.push(name);
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ dir, saved }));
          } catch (e) {
            res.writeHead(500).end(JSON.stringify({ error: String(e) }));
          }
        });
      } else if (url.pathname === "/api/agent-answer" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { id, answers } = JSON.parse(body) as { id: string; answers: Record<string, unknown> };
          fs.writeFileSync(path.join(workspace!, "pending-answer.json"), JSON.stringify({ id, answers }, null, 2));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (url.pathname.startsWith("/api/node/")) {
        const detail = buildNodeDetail(wsFrom(url) ?? workspace!, decodeURIComponent(url.pathname.slice("/api/node/".length)));
        if (!detail) {
          res.writeHead(404).end("unknown node");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(detail));
      } else if (url.pathname.startsWith("/view/")) {
        // Pretty document viewer for curated artifacts.
        const rel = decodeURIComponent(url.pathname.slice("/view/".length));
        const aroot = artifactsRoot(wsFrom(url));
        const abs = path.normalize(path.join(aroot, rel));
        if (!abs.startsWith(aroot + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        let body = fs.readFileSync(abs, "utf8");
        if (abs.endsWith(".json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            /* show as-is */
          }
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(VIEW_PAGE.replace("__TITLE__", rel).replace("__BODY__", body.replace(/&/g, "&amp;").replace(/</g, "&lt;")));
      } else if (url.pathname.startsWith("/thumb/")) {
        // /thumb/<runName>/<slice-N> — screenshot thumbnails for storefront cards.
        const [, , runName, slice] = url.pathname.split("/").map(decodeURIComponent);
        const runDir = path.join(root, path.basename(runName ?? ""));
        const shot = path.join(runDir, "artifacts", path.basename(slice ?? ""), "app", "screenshots", `${path.basename(slice ?? "")}.png`);
        if (!fs.existsSync(path.join(runDir, "run.json")) || !fs.existsSync(shot)) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=60" });
        res.end(fs.readFileSync(shot));
      } else if (url.pathname.startsWith("/artifact/")) {
        const rel = decodeURIComponent(url.pathname.slice("/artifact/".length));
        const aroot = artifactsRoot(wsFrom(url));
        const abs = path.normalize(path.join(aroot, rel));
        if (!abs.startsWith(aroot + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "text/plain; charset=utf-8" });
        res.end(fs.readFileSync(abs));
      } else if (url.pathname === "/api/answer" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { nodeId, answers } = JSON.parse(body) as { nodeId: string; answers: Record<string, string> };
          const ws = wsFrom(url) ?? workspace!;
          const answersFile = mergeAnswers(ws, nodeId, answers);
          const st = buildState(ws) as { status?: string; engineAlive?: boolean };
          // A live engine polls ui-answers itself (review windows / gates
          // in-process) — spawning a second runner would just die on the
          // engine lock. Tell the user WHAT happened either way.
          let applied: string;
          if (!st.engineAlive && (st.status === "parked" || st.status === "failed")) {
            spawnResume(["--answers", answersFile], ws);
            applied = "resuming";
          } else {
            applied = "recorded";
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, applied }));
        });
      } else if (url.pathname === "/api/revise" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { nodeId, feedback, dryRun } = JSON.parse(body) as { nodeId: string; feedback: string; dryRun?: boolean };
          const ctx = revisionCtx(wsFrom(url) ?? workspace!);
          if (dryRun) {
            const state = foldState(ctx.journal.read());
            const ran = (id: string) => state.committed.has(id) || state.failed.has(id) || state.skipped.has(id);
            const reopened = downstreamClosure(ctx.def, nodeId).filter(ran);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, reopened, dryRun: true }));
            return;
          }
          const { reopened } = reviseNode(ctx, nodeId, feedback);
          spawnResume([], ctx.workspace);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, reopened }));
        });
      } else if (url.pathname === "/api/feedback" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { kind: string; slice?: string; text: string };
          const { text } = parsed;
          let { kind, slice } = parsed;
          const ws = wsFrom(url) ?? workspace!;
          const ctx = revisionCtx(ws);
          // GENERIC feedback: the user describes the change; the router decides
          // the entry point. A strong match against one slice's story/screens/
          // endpoints -> targeted slice fix (cheap). Anything else -> the front
          // door (requirements change request) — always correct, because the
          // cascade re-derives the plan and carries the change to the right
          // slice with full traceability.
          let routed: { mode: string; target: string | null; why: string } | null = null;
          if (kind === "auto") {
            routed = routeFeedback(ws, text);
            kind = routed.mode;
            if (routed.target) slice = routed.target;
          }
          let target: string | undefined;
          let feedback: string;
          if (kind === "fix-slice") {
            // The build doesn't match what was agreed — requirements unchanged,
            // the slice re-runs with the user's correction.
            target = slice;
            feedback =
              "The user reviewed this slice in the running app and it does not match what was agreed. " +
              "Fix the implementation according to this feedback (requirements are unchanged):\n\n" + text;
          } else {
            // A new/changed requirement — it enters through the front door:
            // recorded as a change request, appended to requirements with
            // provenance, and re-derived through traceability and the plan.
            const crDir = path.join(workspace!, "change-requests");
            fs.mkdirSync(crDir, { recursive: true });
            const n = fs.readdirSync(crDir).filter((f) => f.endsWith(".json")).length + 1;
            const cr = { id: `CR-${n}`, text, ts: new Date().toISOString() };
            fs.writeFileSync(path.join(crDir, `cr-${n}.json`), JSON.stringify(cr, null, 2));
            target = ctx.def.nodes.find((nd) => (nd.outputs ?? []).some((o) => o.name === "requirements"))?.id;
            feedback =
              `User change request ${cr.id} (raised after reviewing the built app): ${text}\n\n` +
              "Add this as a NEW requirement: provenance source \"user-feedback\" referencing " + cr.id +
              ", confidence \"stated\", and an appropriate category. Keep every existing requirement " +
              "unchanged — same ids, same text, no renumbering.";
          }
          if (!target) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "no target step for this feedback" }));
            return;
          }
          const { reopened } = reviseNode(ctx, target, feedback);
          spawnResume([], ctx.workspace);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, target, reopened, routed }));
        });
      } else if (url.pathname === "/api/app/start" && req.method === "POST") {
        void startApp(wsFrom(url));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === "/api/app/stop" && req.method === "POST") {
        stopApp(wsFrom(url));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === "/api/cancel" && req.method === "POST") {
        // STOP/KILL: drop the cooperative-cancel sentinel the engine polls, and
        // SIGTERM the live engine so an in-flight agent stops burning tokens now.
        const ws = wsFrom(url) ?? workspace!;
        fs.writeFileSync(path.join(ws, "cancel.requested"), new Date().toISOString());
        let signalled = false;
        try {
          const pid = Number(fs.readFileSync(path.join(ws, "engine.lock"), "utf8"));
          if (pid) {
            process.kill(pid, "SIGTERM");
            signalled = true;
          }
        } catch {
          /* no live engine holding the lock */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, signalled }));
      } else if (url.pathname === "/api/resume" && req.method === "POST") {
        // RESUME FROM FAILURE: recover interrupted + failed steps, keep committed
        // work. Only meaningful when no engine is live (else it'd hit the lock).
        const ws = wsFrom(url) ?? workspace!;
        const st = buildState(ws) as { status?: string; engineAlive?: boolean };
        if (st.engineAlive) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "a run is already live" }));
          return;
        }
        const ctx = revisionCtx(ws);
        const interrupted = reconcileInterrupted(ctx);
        const reopened = reopenFailed(ctx);
        spawnResume([], ws);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, resuming: true, interrupted, reopened }));
      } else if (url.pathname === "/api/raise-budget" && req.method === "POST") {
        // Lift a cap a run hit (node or run-wide) WITHOUT editing the certified
        // DAG. Optionally revise+resume the named step so it re-runs alone.
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { nodeId, toUsd, runUsd, reviseAndResume } = JSON.parse(body) as {
            nodeId?: string;
            toUsd?: number;
            runUsd?: number;
            reviseAndResume?: boolean;
          };
          const ws = wsFrom(url) ?? workspace!;
          const file = path.join(ws, "budget-overrides.json");
          const overrides: { run_budget_usd?: number; nodes?: Record<string, number> } = (() => {
            try {
              return JSON.parse(fs.readFileSync(file, "utf8"));
            } catch {
              return {};
            }
          })();
          if (typeof runUsd === "number") overrides.run_budget_usd = runUsd;
          if (nodeId && typeof toUsd === "number") {
            overrides.nodes = overrides.nodes ?? {};
            overrides.nodes[nodeId] = toUsd;
          }
          fs.writeFileSync(file, JSON.stringify(overrides, null, 2));
          // Re-run just the raised step: reopen it (resets its per-cycle spend)
          // and resume — the higher cap now lets it converge. Only when idle.
          let resuming = false;
          const st = buildState(ws) as { engineAlive?: boolean };
          if (reviseAndResume && nodeId && !st.engineAlive) {
            const ctx = revisionCtx(ws);
            reconcileInterrupted(ctx);
            reviseNode(ctx, nodeId, `Budget raised to $${toUsd}. Re-run this step and converge within the new cap.`);
            spawnResume([], ws);
            resuming = true;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, overrides, resuming }));
        });
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });

  server.on("close", stopApp);
  return new Promise((resolve) => {
    // Local tool binds loopback by default (safe). Hosting sets HARNESS_UI_HOST=0.0.0.0
    // to be reachable behind a load balancer — pair it with HARNESS_UI_TOKEN / SSO.
    const host = process.env.HARNESS_UI_HOST || "127.0.0.1";
    server.listen(port, host, () => resolve(server));
  });
}

const VIEW_PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>__TITLE__</title>
<style>
body { font: 14px/1.6 system-ui, sans-serif; margin: 0; background: #f9f9f7; color: #0b0b0b; }
@media (prefers-color-scheme: dark) { body { background: #0d0d0d; color: #e6e6e6; } pre { background: #1a1a19 !important; border-color: rgba(255,255,255,.1) !important; } }
header { padding: 1rem 1.5rem; font-weight: 600; }
pre { margin: 0 1.5rem 1.5rem; padding: 1rem 1.2rem; background: #fcfcfb; border: 1px solid rgba(11,11,11,.1); border-radius: 10px; overflow: auto; font: 12.5px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
</style></head>
<body><header>__TITLE__</header><pre>__BODY__</pre></body></html>`;

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cpath d='M8 6 V30' stroke='%23333' stroke-width='5' stroke-linecap='round' fill='none'/%3E%3Cpath d='M28 6 V30' stroke='%23333' stroke-width='5' stroke-linecap='round' fill='none'/%3E%3Cpath d='M8 18 H28' stroke='%232a78d6' stroke-width='5' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='18' cy='18' r='8.6' fill='white'/%3E%3Ccircle cx='18' cy='18' r='6.2' fill='%237c4dff'/%3E%3Ccircle cx='18' cy='18' r='2.2' fill='white'/%3E%3C/svg%3E"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness</title>
<style>
:root {
  color-scheme: light;
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --border:rgba(11,11,11,.10); --accent:#2a78d6; --accent-ink:#ffffff;
  --good:#0ca30c; --warn:#fab219; --serious:#ec835a; --crit:#d03b3b;
  --shadow:0 1px 3px rgba(11,11,11,.06), 0 4px 16px rgba(11,11,11,.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,.10); --accent:#3987e5; --shadow:none;
  }
}
* { box-sizing:border-box; margin:0; }
body { font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--page); color:var(--ink); overflow-x:clip; }
.mono { font-family:ui-monospace,Menlo,monospace; }
.topbar { position:sticky; top:0; z-index:40; background:var(--page); border-bottom:1px solid var(--grid); }
.topbar-inner { max-width:1420px; margin:0 auto; padding:.8rem clamp(1rem,4vw,2.5rem); display:flex; align-items:center; gap:.9rem; flex-wrap:wrap; }
.topbar h1 { font-size:1.05rem; font-weight:650; cursor:pointer; }
.topbar .mini { color:var(--ink2); font-size:.82rem; }
.pill { display:inline-flex; align-items:center; gap:.45rem; padding:.28rem .8rem; border-radius:999px; border:1px solid var(--border); background:var(--surface); font-weight:550; font-size:.82rem; }
.pill .dot { width:8px; height:8px; border-radius:50%; }
.pill.live { border-color:var(--good); color:var(--good); }
.pill.replay { border-color:var(--warn); }
.tabs { display:flex; gap:.25rem; margin-left:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:.25rem; }
.tabs button { border:0; background:transparent; color:var(--ink2); font:inherit; font-weight:550; padding:.4rem .95rem; border-radius:7px; cursor:pointer; }
.tabs button.active { background:var(--accent); color:var(--accent-ink); }
.tabs button .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--warn); margin-left:.35rem; vertical-align:middle; }
.banner { display:none; align-items:center; gap:.7rem; max-width:1420px; margin:1rem auto 0; padding:.7rem 1rem; border:1px solid var(--warn); border-left-width:4px; background:var(--surface); border-radius:10px; }
.banner b { color:var(--warn); }
.banner button { margin-left:auto; }
.banner.remed { border-color:var(--accent, #3b5bdb); }
.banner.remed b { color:var(--accent, #3b5bdb); white-space:nowrap; }
.banner.remed span { line-height:1.45; }
.banner.remed .fb { opacity:.75; font-style:italic; }
.chip.remed { background:var(--accent, #3b5bdb); color:#fff; }
.remfb { padding:.25rem 0 .25rem .9rem; border-left:2px solid var(--border); margin:.2rem 0; font-size:.85rem; }
.remrow { display:flex; align-items:center; gap:.7rem; padding:.42rem .2rem; border-bottom:1px solid var(--border); font-size:.85rem; }
.remrow:last-child { border-bottom:0; }
.remrow[data-wave] { cursor:pointer; }
.remrow[data-wave]:hover { background:var(--surface); }
.remrecon { display:flex; align-items:center; gap:.6rem; padding:.5rem .1rem .7rem; font-size:.9rem; flex-wrap:wrap; border-bottom:2px solid var(--border); margin-bottom:.3rem; }
.phasedivider { font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; color:var(--ink2,#888); margin:.7rem 0 .3rem; padding-bottom:.15rem; border-bottom:1px solid var(--border); }
.phasedivider.rem { color:var(--accent,#3b5bdb); border-color:var(--accent,#3b5bdb); }
.findrow { display:flex; align-items:baseline; gap:.5rem; padding:.35rem .1rem; border-bottom:1px solid var(--border); font-size:.83rem; }
.findrow:last-child { border-bottom:0; }
.subtabs { display:flex; gap:.35rem; flex-wrap:wrap; margin:.4rem 0 .6rem; }
.subtabs button { font-size:.76rem; padding:.28rem .7rem; border:1px solid var(--border); background:var(--surface); border-radius:999px; cursor:pointer; color:inherit; }
.subtabs button.active { border-color:var(--accent,#3b5bdb); color:var(--accent,#3b5bdb); font-weight:600; }
#waveInfo { border:1px solid var(--accent,#3b5bdb); border-left-width:4px; border-radius:10px; padding:.55rem .8rem; margin-bottom:.6rem; font-size:.85rem; }
.prow.dim { opacity:.32; }
.prow.inwave { box-shadow: inset 3px 0 0 var(--accent, #3b5bdb); }
.prow.failhere { box-shadow: inset 3px 0 0 var(--bad,#c92a2a); background:color-mix(in srgb, var(--bad,#c92a2a) 7%, transparent); }
.prow .wavechip { margin-left:.4rem; }
/* Pipeline chips stay quiet: small, single-line, never stacked. */
.prow .chip { font-size:.62rem; padding:.06rem .45rem; vertical-align:middle; }
.prow .id { white-space:nowrap; }
main { padding:1.2rem clamp(1rem,4vw,2.5rem); max-width:1420px; margin:0 auto; }
.tabpane { display:none; }
.tabpane.active { display:block; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:.8rem; margin-bottom:1rem; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:.85rem 1rem; box-shadow:var(--shadow); }
.tile .k { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:.35rem; }
.tile .v { font-size:1.4rem; font-weight:650; letter-spacing:-.01em; }
.tile .sub { font-size:.78rem; color:var(--ink2); margin-top:.1rem; }
.meter { height:6px; border-radius:3px; background:var(--grid); margin-top:.55rem; overflow:hidden; }
.meter > div { height:100%; border-radius:3px; background:var(--accent); transition:width .6s ease; }
.meter > div.over { background:var(--crit); }
.grid2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:1rem; align-items:start; }
@media (max-width:980px){ .grid2 { grid-template-columns:1fr; } }
.card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; box-shadow:var(--shadow); margin-bottom:1rem; }
.card h2 { font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:.7rem; }
.hint { font-size:.78rem; color:var(--muted); text-transform:none; letter-spacing:0; }
.empty { color:var(--muted); font-size:.84rem; }
.chip { white-space:nowrap; font-size:.68rem; padding:.05rem .5rem; border-radius:999px; border:1px solid var(--border); color:var(--ink2); }
.chip.model { color:var(--accent); border-color:var(--accent); }
.chip.retry { color:var(--serious); border-color:var(--serious); }
.chip.default { color:var(--muted); }
.chip.ok { color:var(--good); border-color:var(--good); }
.chip.bad { color:var(--crit); border-color:var(--crit); }
button.primary { background:var(--accent); color:var(--accent-ink); border:0; border-radius:8px; padding:.55rem 1.1rem; font:inherit; font-weight:560; cursor:pointer; }
button.primary:hover { filter:brightness(1.08); }
button.ghost { background:transparent; border:1px solid var(--border); color:var(--ink2); border-radius:8px; padding:.5rem .9rem; font:inherit; cursor:pointer; }
/* storefront */
.store { max-width:1100px; margin:0 auto; }
.store .lead { margin:.4rem 0 1.2rem; color:var(--ink2); }
.storegrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem; }
.filterbar { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; margin:0 0 1rem; }
.filterbar .who { font-size:.78rem; color:var(--muted); margin-right:.3rem; }
.filterbar .fchip { font-size:.8rem; border:1px solid var(--border); background:var(--surface); color:inherit; border-radius:999px; padding:.3rem .8rem; cursor:pointer; }
.filterbar .fchip:hover { border-color:var(--accent); }
.filterbar .fchip.on { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
.runcard .scopechip { font-size:.68rem; border-radius:999px; padding:.05rem .5rem; border:1px solid var(--border); color:var(--muted); }
.runcard .scopechip.mine { border-color:var(--accent); color:var(--accent); }
.runcard .scopechip.team { border-color:var(--good); color:var(--good); }
.runcard { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1.1rem 1.2rem; cursor:pointer; box-shadow:var(--shadow); font:inherit; color:inherit; text-align:left; }
.runcard:hover { border-color:var(--accent); }
.runcard b { font-size:1.02rem; }
.runcard .meta { color:var(--muted); font-size:.78rem; margin-top:.4rem; display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
.newrun { border-style:dashed; }
.newrun code { display:block; background:var(--page); border:1px solid var(--grid); border-radius:8px; padding:.6rem .8rem; font-size:.74rem; margin-top:.6rem; overflow-x:auto; white-space:pre; }
/* about + quality */
.kv { display:grid; grid-template-columns:minmax(140px,190px) 1fr; gap:.25rem 1rem; font-size:.85rem; padding:.16rem 0; }
.kv .k { color:var(--muted); }
.qrow { display:flex; align-items:center; gap:.6rem; padding:.3rem 0; border-bottom:1px solid var(--grid); font-size:.86rem; }
.qrow:last-child { border-bottom:0; }
.qrow .stat { margin-left:auto; color:var(--ink2); font-size:.8rem; }
.qrow .mark { width:20px; text-align:center; }
.qrow .mark.ok { color:var(--good); } .qrow .mark.bad { color:var(--crit); } .qrow .mark.na { color:var(--muted); }
/* slice progress */
.shots { display:flex; gap:.8rem; overflow-x:auto; padding-bottom:.3rem; }
.shot { flex:none; width:260px; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); cursor:zoom-in; padding:0; font:inherit; color:inherit; }
.shot:hover { border-color:var(--accent); }
.shot img { width:100%; display:block; }
.shot .cap { padding:.4rem .6rem; font-size:.76rem; color:var(--ink2); }
/* pipeline */
.phase { margin-bottom:1.1rem; }
.phase .phead { display:flex; align-items:center; gap:.7rem; padding:.4rem 0; }
.phase .phead b { font-size:.95rem; }
.phase .phead .bar { flex:1; height:4px; border-radius:2px; background:var(--grid); overflow:hidden; }
.phase .phead .bar div { height:100%; background:var(--good); }
.phase .phead .stat { font-size:.75rem; color:var(--muted); white-space:nowrap; }
.prow { display:grid; grid-template-columns:26px minmax(150px,190px) 110px 1fr 76px 86px 64px; gap:.6rem; align-items:center; padding:.34rem .45rem; border-radius:8px; cursor:pointer; border:1px solid transparent; }
.prow:hover { background:var(--page); border-color:var(--border); }
.prow.header { cursor:default; border:0; padding-top:0; padding-bottom:.15rem; }
.prow.header:hover { background:transparent; }
.prow.header span { font-size:.66rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.prow .num { text-align:right; font-size:.74rem; color:var(--ink2); }
.prow .icon { width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.7rem; background:var(--surface); border:2px solid var(--grid); color:var(--muted); position:relative; }
.prow.committed .icon { border-color:var(--good); color:var(--good); }
.prow.failed .icon { border-color:var(--crit); background:var(--crit); color:#fff; }
.prow.parked .icon { border-color:var(--warn); color:var(--warn); }
.prow.started .icon { border-color:var(--accent); color:var(--accent); }
.prow.started .icon::after { content:""; position:absolute; inset:-6px; border-radius:50%; border:2px solid var(--accent); opacity:.5; animation:pulse 1.4s ease-out infinite; }
@keyframes pulse { from { transform:scale(.7); opacity:.6; } to { transform:scale(1.15); opacity:0; } }
.prow .id { font-weight:560; overflow:hidden; text-overflow:ellipsis; }
.prow.pending .id, .prow.skipped .id { color:var(--muted); font-weight:450; }
.prow .desc { font-size:.76rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* gate + agent question */
.gate { border-left:3px solid var(--warn); }
.gate .q { margin-bottom:.85rem; }
.gate label { display:block; font-weight:560; margin-bottom:.12rem; }
.gate .why { font-size:.78rem; color:var(--ink2); margin-bottom:.35rem; }
.gate input[type=text] { width:100%; background:var(--page); border:1px solid var(--grid); color:var(--ink); border-radius:8px; padding:.55rem .7rem; font:inherit; }
.gate input:focus { outline:2px solid var(--accent); outline-offset:1px; }
.opt { display:flex; gap:.6rem; align-items:flex-start; border:1px solid var(--grid); border-radius:8px; padding:.5rem .7rem; margin:.3rem 0; cursor:pointer; }
.opt:hover { border-color:var(--accent); }
.opt input { margin-top:.2rem; }
.opt .od { font-size:.76rem; color:var(--muted); }
/* designs */
.designs { display:grid; grid-template-columns:repeat(auto-fill,300px); gap:.9rem; }
.design { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); position:relative; }
.design.chosen { border-color:var(--good); box-shadow:0 0 0 2px var(--good); }
.design .sel { position:absolute; top:.5rem; right:.5rem; z-index:2; background:var(--good); color:#fff; font-size:.7rem; font-weight:600; padding:.15rem .6rem; border-radius:99px; }
.design .thumb { height:230px; overflow:hidden; background:#fff; position:relative; }
.design .thumb iframe { width:1200px; height:920px; border:0; transform:scale(0.25); transform-origin:0 0; pointer-events:none; }
.design .thumb a { position:absolute; inset:0; }
.design .bar { display:flex; align-items:center; gap:.45rem .5rem; padding:.5rem .7rem; border-top:1px solid var(--border); flex-wrap:wrap; }
.design .bar b { font-size:.85rem; flex:1 1 100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.design .bar .chip { margin-right:auto; }
.design .bar a { font-size:.78rem; color:var(--accent); text-decoration:none; }
.design .bar button { background:transparent; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:.2rem .7rem; font:inherit; font-size:.78rem; cursor:pointer; }
.design .bar button:disabled { opacity:.4; cursor:default; }
/* documents */
.docphase { margin-bottom:1rem; }
.docphase h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:.2rem 0 .3rem; }
.docrow { display:flex; align-items:baseline; gap:.8rem; width:100%; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--grid); padding:.55rem .2rem; cursor:pointer; font:inherit; color:inherit; }
.docrow:hover b { text-decoration:underline; }
.docrow b { color:var(--accent); font-size:.9rem; white-space:nowrap; }
.docrow .blurb { color:var(--ink2); font-size:.8rem; flex:1; }
.docrow .src { color:var(--muted); font-size:.72rem; }
/* decisions */
.dcard { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; margin-bottom:.9rem; box-shadow:var(--shadow); }
.dcard .dhead { display:flex; align-items:baseline; gap:.6rem; margin-bottom:.5rem; }
.dcard .dhead b { font-size:.95rem; }
.dcard .dhead .when { color:var(--muted); font-size:.74rem; margin-left:auto; }
.q textarea { width:100%; box-sizing:border-box; border:1px solid var(--grid); border-radius:8px; padding:.55rem .7rem; font:inherit; background:var(--page); color:inherit; resize:vertical; min-height:96px; }
.optgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:.5rem; margin:.35rem 0 .2rem; }
.optgrid.two { grid-template-columns:repeat(2, minmax(90px, 150px)); }
.optcard, .q .optcard { position:relative; border:1.5px solid var(--grid); border-radius:10px; padding:.6rem .85rem; cursor:pointer; display:flex; flex-direction:column; gap:.2rem; background:var(--page); margin:0; }
.optcard b { display:block; }
.optcard .hint { display:block; line-height:1.4; }
.optcard:hover { border-color:var(--accent); }
.optcard input { position:absolute; opacity:0; pointer-events:none; }
.optcard:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.optcard:has(input:checked) b { color:var(--accent); }
.optcard b { font-size:.86rem; }
.optcard .hint { font-size:.74rem; }
.dropzone { border:2px dashed var(--grid); border-radius:12px; padding:1rem; text-align:center; color:var(--ink2); cursor:pointer; margin-top:.45rem; display:flex; flex-direction:column; gap:.15rem; font-size:.86rem; }
.dropzone.drag, .dropzone:hover { border-color:var(--accent); color:var(--accent); background:var(--page); }
.qa { display:grid; grid-template-columns:minmax(220px,1.1fr) 1fr; gap:.4rem 1.2rem; padding:.45rem 0; border-top:1px solid var(--grid); align-items:baseline; }
.qa .q { color:var(--ink2); font-size:.84rem; }
.qa .a { font-weight:580; }
@media (max-width:720px){ .qa { grid-template-columns:1fr; } }
/* activity */
.egroup { border-bottom:1px solid var(--grid); }
.egroup summary { list-style:none; display:flex; gap:.6rem; align-items:baseline; padding:.4rem 0; cursor:pointer; font-size:.85rem; }
.egroup summary::-webkit-details-marker { display:none; }
.egroup summary .arrow { color:var(--muted); font-size:.7rem; width:12px; }
.egroup[open] summary .arrow { transform:rotate(90deg); display:inline-block; }
.egroup summary .t { color:var(--muted); font-size:.72rem; width:56px; flex:none; }
.egroup summary .outcome { margin-left:auto; }
.egroup .inner { padding:0 0 .5rem 4.4rem; }
.event { display:flex; gap:.6rem; align-items:baseline; padding:.14rem 0; color:var(--ink2); font-size:.8rem; }
.event .t { color:var(--muted); font-size:.7rem; flex:none; width:56px; }
.event.bad { color:var(--crit); }
.brand { display:flex; align-items:center; gap:.55rem; cursor:pointer; color:var(--ink); text-decoration:none; }
.brand .mark { width:26px; height:26px; display:block; }
.brand h1 { font-size:1.14rem; font-weight:800; letter-spacing:-.015em; margin:0; }
.brand:hover .mark { filter:drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 55%, transparent)); }
.heromark .mark.big { width:52px; height:52px; margin-bottom:.8rem; color:var(--ink2); }
.shot img { width:100%; height:170px; object-fit:cover; object-position:top; background:#fff; display:block; }
.shot .cap b { font-size:.78rem; }
.shot .capsub { font-size:.7rem; color:var(--muted); margin-top:.15rem; line-height:1.3; }
/* storefront hero + gallery */
.hero { display:grid; grid-template-columns: 1.4fr 1fr; gap:2rem; align-items:stretch; margin:1.2rem 0 2rem;
  background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--surface)), var(--surface) 55%);
  border:1px solid var(--border); border-radius:18px; padding:2rem 2.2rem; box-shadow:var(--shadow); }
@media (max-width:760px){ .hero { grid-template-columns:1fr; gap:1.3rem; padding:1.4rem 1.3rem; } .hero-copy h1 { font-size:1.7rem; } }
.hero-copy h1 { font-size:2.1rem; line-height:1.15; letter-spacing:-.02em; margin-bottom:.7rem; }
.hero-copy h1 em { color:var(--accent); font-style:normal; }
.hero-copy p { color:var(--ink2); font-size:1rem; max-width:34rem; line-height:1.55; }
.herostats { display:flex; gap:1.8rem; margin-top:1.4rem; flex-wrap:wrap; }
.herostats .hs b { display:block; font-size:1.5rem; letter-spacing:-.01em; }
.herostats .hs span { font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; }
.hero-form { background:var(--page); border:1px solid var(--border); border-radius:14px; padding:1.2rem 1.3rem; display:flex; flex-direction:column; gap:.6rem; justify-content:center; }
.hero-form .hf-title { font-weight:750; font-size:1.05rem; }
.hero-form input, .hero-form select { padding:.65rem .8rem; border:1px solid var(--grid); border-radius:9px; background:var(--surface); color:inherit; font:inherit; }
.hero-form button.big { padding:.7rem 1rem; font-size:.95rem; border-radius:9px; }
.hero-form .hf-foot { font-size:.7rem; color:var(--muted); }
#needsYouStrip .ny { display:flex; align-items:center; gap:.8rem; background:color-mix(in srgb, var(--warn) 12%, var(--surface)); border:1px solid var(--warn); border-radius:12px; padding:.7rem 1rem; margin-bottom:.6rem; cursor:pointer; }
#needsYouStrip .ny b { font-size:.92rem; }
#needsYouStrip .ny:hover { box-shadow:var(--shadow); }
.galhead { margin:1.6rem 0 .8rem; font-size:.95rem; }
.runcard { padding:0; overflow:hidden; display:flex; flex-direction:column; transition:transform .15s ease, box-shadow .15s ease; }
.runcard:hover { transform:translateY(-3px); box-shadow:0 8px 28px rgba(11,11,11,.12); }
.runcard .shotwrap { height:150px; background:var(--page); border-bottom:1px solid var(--grid); overflow:hidden; display:flex; align-items:flex-start; }
.runcard .shotwrap img { width:100%; object-fit:cover; object-position:top; }
.runcard .shotwrap .noshot { margin:auto; color:var(--muted); font-size:.75rem; }
.runcard .cbody { padding:.9rem 1rem 1rem; display:flex; flex-direction:column; gap:.45rem; flex:1; }
.runcard .prob { font-size:.74rem; color:var(--muted); line-height:1.4; max-height:2.9em; overflow:hidden; }
.runcard .pmeter { height:5px; background:var(--grid); border-radius:3px; overflow:hidden; }
.runcard .pmeter div { height:100%; background:var(--good); }
/* overview narrative sections */
.secwrap { margin-top:1.6rem; padding-top:1rem; border-top:1px solid var(--grid); }
.seclabel { font-size:.78rem; font-weight:750; text-transform:uppercase; letter-spacing:.09em; color:var(--ink2); margin-bottom:.7rem; }
.seclabel .hint { text-transform:none; letter-spacing:0; font-weight:500; }
/* app agents */
.agrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:.8rem; }
.agcard { border:1px solid var(--grid); border-radius:10px; padding:.8rem .9rem; background:var(--page); }
.agcard .agname { font-weight:700; font-size:.92rem; }
.agcard .agrole { color:var(--muted); font-size:.8rem; margin:.25rem 0 .45rem; }
.agcard .agrow { font-size:.76rem; margin:.25rem 0; display:flex; flex-wrap:wrap; gap:.25rem; align-items:center; }
.agcard .agrow .k { color:var(--muted); text-transform:uppercase; font-size:.64rem; letter-spacing:.06em; margin-right:.2rem; }
.agcard .badgechip.deny { border-color:var(--crit); color:var(--crit); }
.agcard .agevals { font-size:.74rem; color:var(--muted); margin-top:.4rem; border-top:1px dashed var(--grid); padding-top:.4rem; }
/* app workflows */
.wf { border:1px solid var(--grid); border-radius:12px; padding:.9rem 1rem; margin-bottom:.9rem; background:var(--page); }
.wf .wfname { font-weight:700; font-size:.95rem; }
.wf .wfdesc { color:var(--muted); font-size:.8rem; margin:.2rem 0 .6rem; }
.wfflow { display:flex; align-items:stretch; gap:0; overflow-x:auto; padding:.4rem 0; }
.wfnode { min-width:150px; max-width:190px; border-radius:10px; padding:.5rem .65rem; font-size:.74rem; border:1.5px solid var(--grid); background:var(--surface); flex-shrink:0; }
.wfnode .nk { font-size:.6rem; text-transform:uppercase; letter-spacing:.08em; font-weight:700; display:inline-block; padding:.1rem .4rem; border-radius:4px; margin-bottom:.3rem; }
.wfnode .nid { font-weight:650; margin-bottom:.15rem; }
.wfnode .nd { color:var(--muted); font-size:.68rem; line-height:1.35; max-height:3.6em; overflow:hidden; }
.wfnode.k-agent { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.wfnode.k-agent .nk { background:var(--accent); color:var(--accent-ink); }
.wfnode.k-human { border-color:var(--warn); }
.wfnode.k-human .nk { background:var(--warn); color:#3b2c00; }
.wfnode.k-deterministic .nk { background:var(--grid); color:var(--ink2); }
.wfnode.k-condition { border-style:dashed; }
.wfnode.k-condition .nk { background:var(--surface); border:1px solid var(--grid); color:var(--ink2); }
.wfarrow { align-self:center; padding:0 .35rem; color:var(--muted); flex-shrink:0; font-size:.9rem; }
.wflegend { display:flex; gap:.9rem; margin-top:.5rem; font-size:.68rem; color:var(--muted); flex-wrap:wrap; }
.wflegend b { font-weight:700; }
/* drawer + modal */
#drawer { position:fixed; top:0; right:-580px; width:min(560px,94vw); height:100vh; background:var(--surface); border-left:1px solid var(--border); box-shadow:-12px 0 40px rgba(0,0,0,.18); transition:right .25s ease; z-index:60; display:flex; flex-direction:column; }
#drawer.open { right:0; }
#drawer .head, #docModal .head { padding:1rem 1.2rem; border-bottom:1px solid var(--grid); display:flex; align-items:center; gap:.6rem; }
#drawer .head b, #docModal .head b { font-size:1rem; }
#drawer .body, #docModal .body { padding:1rem 1.2rem; overflow-y:auto; flex:1; }
#drawer h3, .docsec h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:.9rem 0 .4rem; }
#drawer .depitem { font-size:.82rem; padding:.2rem 0; }
#drawer .depitem .mono { color:var(--accent); }
#drawer .depitem .d { color:var(--muted); font-size:.76rem; }
#drawer .attempt { border:1px solid var(--grid); border-radius:8px; padding:.5rem .7rem; margin-bottom:.5rem; font-size:.8rem; }
#drawer .attempt .err { color:var(--crit); white-space:pre-wrap; font-size:.72rem; margin-top:.3rem; max-height:140px; overflow:auto; }
.tr { border-left:2px solid var(--grid); padding:.25rem 0 .25rem .7rem; margin-bottom:.35rem; font-size:.78rem; }
.tr.tool { border-color:var(--accent); }
.tr .lbl { color:var(--accent); font-weight:560; }
.tr .prev { color:var(--ink2); word-break:break-word; }
.tr.text .prev { color:var(--ink); }
#docModal { position:fixed; inset:0; z-index:70; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.45); }
#docModal.open { display:flex; }
#docModal .sheet { width:min(880px,94vw); max-height:88vh; background:var(--surface); border:1px solid var(--border); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; }
#docModal pre { background:var(--page); border:1px solid var(--grid); border-radius:8px; padding:.8rem 1rem; font:12px/1.5 ui-monospace,Menlo,monospace; overflow:auto; white-space:pre-wrap; }
.doctable { width:100%; border-collapse:collapse; font-size:.8rem; margin:.3rem 0 .6rem; }
.doctable th { text-align:left; color:var(--muted); font-weight:560; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; padding:.35rem .5rem; border-bottom:1px solid var(--grid); }
.doctable td { padding:.4rem .5rem; border-bottom:1px solid var(--grid); vertical-align:top; }
.badgechip { display:inline-block; font-size:.72rem; border:1px solid var(--border); border-radius:99px; padding:.02rem .5rem; margin:.06rem .15rem .06rem 0; color:var(--ink2); }
</style>
</head>
<body>
<div class="topbar"><div class="topbar-inner">
  <a class="brand" onclick="goHome()"><svg class="mark" viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="hgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a78d6"/><stop offset="1" stop-color="#8250df"/></linearGradient></defs><path d="M8 6 V30" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M28 6 V30" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M8 18 H28" stroke="url(#hgrad)" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="18" cy="18" r="8.6" fill="var(--surface, #fff)"/><circle cx="18" cy="18" r="6.2" fill="url(#hgrad)"/><circle cx="18" cy="18" r="2.2" fill="var(--surface, #fff)" opacity=".92"/></svg><h1 id="title">harness</h1></a>
  <span class="pill" id="statusPill" style="display:none"><span class="dot" id="statusDot"></span><span id="statusText"></span></span>
  <span class="pill" id="modePill" style="display:none"></span>
  <button class="ghost" id="stopRunBtn" style="display:none;border-color:var(--crit);color:var(--crit)" onclick="stopRun()" title="Stop this run — the current step halts, committed work is kept, and you can resume">■ Stop</button>
  <button class="primary" id="resumeRunBtn" style="display:none" onclick="resumeRun()" title="Resume from where it stopped — re-runs the failed/stopped step, keeps everything already built">Resume ▸</button>
  <span class="mini" id="miniStats"></span>
  <nav class="tabs" id="tabs" style="display:none">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="pipeline">Pipeline</button>
    <button data-tab="documents">Documents</button>
    <button data-tab="decisions">Decisions</button>
    <button data-tab="activity">Activity</button>
  </nav>
</div></div>
<div class="banner" id="banner"><b>Waiting on you</b><span id="bannerText"></span><button class="primary" onclick="showTab('overview');window.scrollTo({top:0,behavior:'smooth'})">Answer now</button></div>
<div class="banner remed" id="remBanner"><b id="remBannerTitle">In progress</b><span id="remText"></span></div>
<main>
<section id="storefront" style="display:none" class="store">
  <div class="hero">
    <div class="hero-copy">
      <div class="heromark"><svg class="mark big" viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="hgrad2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a78d6"/><stop offset="1" stop-color="#8250df"/></linearGradient></defs><path d="M8 6 V30" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M28 6 V30" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M8 18 H28" stroke="url(#hgrad2)" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="18" cy="18" r="8.6" fill="var(--surface, #fff)"/><circle cx="18" cy="18" r="6.2" fill="url(#hgrad2)"/><circle cx="18" cy="18" r="2.2" fill="var(--surface, #fff)" opacity=".92"/></svg></div>
      <h1>Describe it. Approve it. <em>Run it.</em></h1>
      <p>The factory turns a problem statement and your documents into a working, tested, audited AI application — with you making the calls that matter.</p>
      <div class="herostats" id="heroStats"></div>
    </div>
    <div class="hero-form">
      <div class="hf-title">Start building</div>
      <input id="newName" placeholder="name-your-app (lowercase, hyphens)">
      <select id="newType"></select>
      <button class="primary big" onclick="startNewApp()">Build my app →</button>
      <button class="primary big" id="cloudBuildBtn" style="display:none;margin-top:.5rem;background:var(--good)" onclick="cloudBuild()">Build &amp; deploy on AWS →</button>
      <div class="hint" id="newErr" style="min-height:1em"></div>
      <div class="hf-foot">Parks at intake — nothing runs or spends until you answer.</div>
    </div>
  </div>
  <div id="needsYouStrip"></div>
  <div class="galhead" id="galHead" style="display:none"><b>The gallery</b><span class="hint"> — every app built here, with its latest screenshot</span></div>
  <div id="filterBar" class="filterbar" style="display:none"></div>
  <div class="storegrid" id="storeGrid"></div>
</section>
<div id="runview" style="display:none">
<section class="tabpane active" id="tab-overview">
  <div class="card gate" id="agentQPanel" style="display:none"><h2>The agent needs your input</h2><form id="agentQForm"></form></div>
  <div class="card gate" id="windowPanel" style="display:none"><h2>Checkpoint — the build is pausing for you <span class="hint" id="windowCountdown"></span></h2><form id="windowForm"></form></div>
  <div class="card gate" id="gatePanel" style="display:none"><h2>Waiting on you — the run continues after you answer</h2><form id="gateForm"></form></div>
  <div class="tiles">
    <div class="tile"><div class="k">Progress</div><div class="v" id="progressV"></div><div class="meter"><div id="progressBar"></div></div><div class="sub" id="progressSub"></div></div>
    <div class="tile"><div class="k">Cost</div><div class="v" id="costV"></div><div class="meter"><div id="costBar"></div></div><div class="sub" id="costSub"></div></div>
    <div class="tile"><div class="k">Tokens</div><div class="v" id="tokV"></div><div class="sub" id="tokSub"></div></div>
    <div class="tile"><div class="k">Active time</div><div class="v" id="elapsedV"></div><div class="sub" id="elapsedSub"></div></div>
    <div class="tile"><div class="k">Your inputs</div><div class="v" id="attnV" style="font-size:1.02rem"></div><div class="sub" id="attnSub"></div></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>About this build</h2><div id="about"></div></div>
    <div class="card"><h2>Quality &amp; test results</h2><div id="quality"></div></div>
  </div>
  <div class="card" id="remedPanel" style="display:none"><h2>Remediations &amp; enhancements <span class="hint">— defects fixed and requirements changed after the first build; click any for the full story</span></h2><div id="remedList"></div></div>
  <div class="card" id="findingsPanel" style="display:none"><h2>Security posture</h2><div id="findingsList"></div></div>
  <div class="secwrap" id="sec-design" style="display:none">
    <div class="seclabel">The design <span class="hint">— what your app looks like</span></div>
    <div class="card" id="designPanel" style="display:none"><h2 id="designHead">Design options — pick one</h2><div class="designs" id="designs"></div></div>
    <div class="card" id="deliveryPanel" style="display:none"><h2>Design delivery — what you approved vs what's live <span class="hint" id="deliveryTotals"></span></h2><div id="deliveryGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.6rem"></div></div>
  </div>
  <div class="secwrap" id="sec-anatomy" style="display:none">
    <div class="seclabel">What&#39;s inside <span class="hint">— the processes and agents your app runs</span></div>
    <div class="card" id="workflowsPanel" style="display:none"><h2>Your app&#39;s processes <span class="hint">— the deterministic flow, with the agentic and human steps called out</span></h2><div id="appWorkflows"></div></div>
    <div class="card" id="agentsPanel" style="display:none"><h2>Your app&#39;s agents <span class="hint">— who does the work, with tools and guardrails</span></h2><div class="agrid" id="appAgents"></div></div>
  </div>
  <div class="secwrap" id="sec-running" style="display:none">
    <div class="seclabel">See it running <span class="hint">— the application itself, as it grows</span></div>
  <div class="card" id="shotsPanel" style="display:none"><h2>Watch it grow — one screenshot per slice</h2><div class="shots" id="shots"></div></div>
  <div class="card" id="feedbackPanel" style="display:none"><h2>Request a change <span class="hint">— describe it; the pipeline finds where it belongs and rebuilds only what it touches</span></h2>
      <form id="feedbackForm" style="margin-top:.4rem;max-width:640px">
        <label class="opt"><input type="radio" name="fbKind" value="auto" checked><span><b>Just describe it — the pipeline routes it</b><div class="od">A clear match to one delivered feature becomes a targeted fix of that slice; anything broader or new enters through requirements with provenance and re-plans. You&#39;ll be told which path it took.</div></span></label>
        <label class="opt"><input type="radio" name="fbKind" value="fix-slice"><span><b>Fix a specific slice</b><div class="od">The build doesn&#39;t match what was agreed — the slice re-runs with your correction; requirements stay unchanged.</div></span></label>
        <label class="opt"><input type="radio" name="fbKind" value="new-requirement"><span><b>New or changed requirement</b><div class="od">Recorded as a change request, added to requirements with provenance, then re-planned and rebuilt with full traceability.</div></span></label>
        <div id="fbSliceRow" style="margin:.5rem 0;display:none"><label class="hint">Which slice? </label><select id="fbSlice" style="padding:.35rem .5rem;border:1px solid var(--grid);border-radius:6px;background:var(--surface);color:inherit"></select></div>
        <textarea id="fbText" rows="3" style="width:100%;box-sizing:border-box;border:1px solid var(--grid);border-radius:8px;padding:.5rem .7rem;font:inherit;background:var(--page);color:inherit" placeholder="Describe the change you want…"></textarea>
        <button type="submit" class="primary" style="margin-top:.5rem">Send feedback &amp; rebuild</button>
      </form>
  </div>
  <div class="card" id="appPanel" style="display:none">
    <div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
      <h2 style="margin:0">Your application</h2>
      <span class="chip" id="appStage"></span>
      <span class="pill" style="padding:.2rem .7rem;font-size:.78rem"><span class="dot" id="appDot"></span><span id="appStatus"></span></span>
      <span style="margin-left:auto;display:flex;gap:.5rem;align-items:center">
        <a id="appLink" class="mono" target="_blank" style="color:var(--accent);text-decoration:none;display:none"></a>
        <button class="primary" id="appLaunch">Launch app</button>
        <button class="ghost" id="appStop" style="display:none">Stop</button>
      </span>
    </div>
    <div id="appFrameWrap" style="display:none;margin-top:.9rem;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#fff">
      <iframe id="appFrame" style="width:100%;height:520px;border:0;display:block"></iframe>
    </div>
  </div>
  </div>
</section>
<section class="tabpane" id="tab-pipeline">
  <div class="card"><h2>Pipeline <span class="hint">— grouped by phase; click any step to inspect it</span></h2>
    <div class="subtabs" id="waveTabs" style="display:none"></div>
    <div id="waveInfo" style="display:none"></div>
    <div id="nodes"></div></div>
</section>
<section class="tabpane" id="tab-documents">
  <div class="card"><h2>Documents <span class="hint">— what the run produced for you to read</span></h2>
    <div id="docs"></div>
    <details style="margin-top:.8rem"><summary class="hint" style="cursor:pointer">Advanced: all raw files</summary><div id="raw" style="margin-top:.4rem"></div></details>
  </div>
</section>
<section class="tabpane" id="tab-decisions">
  <div id="decisions"></div>
</section>
<section class="tabpane" id="tab-activity">
  <div class="card"><h2>Activity <span class="hint">— grouped by step; failures start open</span></h2><div id="events"></div></div>
</section>
</div>
</main>
<aside id="drawer">
  <div class="head"><b id="dTitle"></b><span class="chip" id="dKind"></span><span class="chip" id="dState"></span>
    <button class="ghost" style="margin-left:auto" onclick="closeDrawer()">Close</button></div>
  <div class="body" id="dBody"></div>
</aside>
<div id="docModal" onclick="if(event.target===this)closeDoc()">
  <div class="sheet">
    <div class="head"><b id="docTitle"></b><span class="hint" id="docBlurb"></span>
      <button class="ghost" id="docRawBtn" style="margin-left:auto;padding:.3rem .7rem;font-size:.76rem">View raw</button>
      <button class="ghost" onclick="closeDoc()">Close</button></div>
    <div class="body docsec" id="docBody"></div>
  </div>
</div>
<script>
const STATUS_COLOR = { completed:'var(--good)', running:'var(--accent)', parked:'var(--warn)', failed:'var(--crit)', cancelled:'var(--muted)', stopped:'var(--muted)', starting:'var(--warn)' };
const STATE_ICON = { committed:'✓', failed:'✕', parked:'⏸', started:'●', skipped:'↷', pending:'○' };
const REM_SRC_ICON = { 'merge conflict': '⛙', 'security scan': '🛡', 'code audit': '🔍', 'live verification': '⚡', 'user review': '👤', 'review feedback': '💬' };
let waveSel = 'all'; // pipeline sub-view: 'all' or a wave number
// A wave is either a REMEDIATION (fixing a defect) or an ENHANCEMENT (new /
// changed requirement) — never call the latter "remediation".
function waveNoun(r) { return r.kind === 'enhancement' ? 'Enhancement' : 'Remediation'; }
function waveIcon(r) { return r.kind === 'enhancement' ? '✦' : '⟳'; }
function waveVerbing(r) { return r.kind === 'enhancement' ? 'Adding' : 'Fixing'; }
function remHeadline(fb) {
  if (!fb) return 'review feedback';
  const head = fb.split(/[:.]/)[0].trim();
  return (head.length >= 8 && head.length <= 90 ? head : fb.slice(0, 90)).toLowerCase();
}
function waveVerdict(r) {
  // IN-SPAN verdict: what happened during THAT wave — a later wave's success
  // must never retroactively turn a failed wave green.
  if (r.ended && r.ended.kind === 'completed') return '<span class="chip" style="background:var(--ok,#2b8a3e);color:#fff">re-verified through completion ✓</span>';
  if (r.ended && r.ended.kind === 'failed') return '<span class="chip" style="border:1px solid var(--bad,#c92a2a);color:var(--bad,#c92a2a)">⛔ ended: ' + esc(r.ended.nodeId) + ' failed → wave ' + (r.wave + 1) + '</span>';
  if (r.ended && r.ended.kind === 'superseded') return '<span class="chip">superseded by wave ' + (r.wave + 1) + '</span>';
  return r.remaining.length === 0
    ? '<span class="chip" style="background:var(--ok,#2b8a3e);color:#fff">all steps re-verified ✓</span>'
    : '<span class="chip remed">re-deriving · ' + (r.reopened.length - r.remaining.length) + '/' + r.reopened.length + '</span>';
}
function remOutcomeChip(a) {
  return a.outcome === 'committed' ? (a.cached
      ? '<span class="chip" title="inputs unchanged — previous result re-used">unchanged · reused</span>'
      : '<span class="chip" style="background:var(--ok,#2b8a3e);color:#fff">rebuilt ✓' + (a.attempts > 1 ? ' (' + a.attempts + ' attempts)' : '') + (a.costUsd ? ' · $' + a.costUsd.toFixed(2) : '') + '</span>')
    : a.outcome === 're-running' ? '<span class="chip remed">re-building now…</span>'
    : a.outcome === 'failed' ? '<span class="chip" style="background:var(--bad,#c92a2a);color:#fff">✕ failed here — this is where the wave stopped</span>'
    : a.outcome === 'skipped' ? '<span class="chip">skipped</span>'
    : '<span class="chip">queued (wave stopped before reaching it)</span>';
}
// In a wave lens, a row must show its IN-SPAN state (what happened during
// that wave), never its current live state — else a step that failed in
// wave 2 shows a green ✓ because a later wave fixed it.
function waveRowState(outcome) {
  return outcome === 'committed' ? { cls: 'committed', icon: '✓' }
    : outcome === 'failed' ? { cls: 'failed', icon: '✕' }
    : outcome === 're-running' ? { cls: 'started', icon: '●' }
    : outcome === 'skipped' ? { cls: 'skipped', icon: '↷' }
    : { cls: 'pending', icon: '○' };
}
const prevHtml = {};
function setHTML(id, html) {
  if (prevHtml[id] === html) return false;
  prevHtml[id] = html;
  document.getElementById(id).innerHTML = html;
  return true;
}
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el.textContent !== txt) el.textContent = txt;
}
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function fmtDur(ms) {
  if (!ms) return '0s';
  if (ms < 950) return (ms/1000).toFixed(1) + 's';
  const s = Math.round(ms/1000);
  if (s < 90) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.round((s%3600)/60) + 'm';
}
function fmtTok(n) { return n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n/1e3) + 'k' : String(n); }
function shortModel(m) { return m ? m.replace('claude-','') : ''; }
function title(k) { return String(k).replace(/_/g,' ').replace(/^./, c => c.toUpperCase()); }

function showTab(name) {
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  location.hash = name;
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
if (location.hash) showTab(location.hash.slice(1));
let currentRun = new URLSearchParams(location.search).get('run') || null;
function q(extra) {
  const params = new URLSearchParams(extra || '');
  if (currentRun) params.set('ws', currentRun);
  const str = params.toString();
  return str ? '?' + str : '';
}
/** One question -> its form field. The type decides the control: choice cards
 * (the answer space made visible), yes/no toggles, long-form textarea, a
 * document drop zone, or plain text. */
function qField(qq) {
  const why = qq.why ? '<div class="why">' + esc(qq.why) + '</div>' : '';
  let control;
  let defHint = '';
  if (qq.type === 'choice' && Array.isArray(qq.options)) {
    control = '<div class="optgrid">' + qq.options.map(o =>
      '<label class="optcard"><input type="radio" name="' + esc(qq.id) + '" value="' + esc(o.value) + '"' + (qq.default === o.value ? ' checked' : '') + '>' +
      '<b>' + esc(o.label || o.value) + '</b>' +
      (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '') +
      '</label>').join('') + '</div>';
  } else if (qq.type === 'boolean') {
    control = '<div class="optgrid two">' + ['yes','no'].map(v =>
      '<label class="optcard"><input type="radio" name="' + esc(qq.id) + '" value="' + v + '"' + (qq.default === v ? ' checked' : '') + '><b>' + (v === 'yes' ? 'Yes' : 'No') + '</b></label>').join('') + '</div>';
  } else if (qq.type === 'long') {
    control = '<textarea name="' + esc(qq.id) + '" placeholder="' + esc(qq.placeholder ?? '') + '">' + esc(qq.default ?? '') + '</textarea>';
  } else if (qq.type === 'files' || qq.id === 'documents_dir') {
    control = '<input type="text" name="' + esc(qq.id) + '" value="' + esc(qq.default ?? '') + '">' +
      '<div class="dropzone" id="dropzone"><b>Drop your documents here</b><span class="hint">or click to browse — stored with this run; the path fills in automatically</span></div>' +
      '<input type="file" id="docUpload" multiple style="display:none">' +
      '<div class="hint" id="docUploadStatus"></div>';
  } else {
    control = '<input type="text" name="' + esc(qq.id) + '" value="' + esc(qq.default ?? '') + '" placeholder="' + esc(qq.placeholder ?? '') + '">';
    if (qq.default !== undefined) defHint = '<div class="hint">pre-filled with the default — edit or keep</div>';
  }
  return '<div class="q"><label>' + esc(qq.prompt) + '</label>' + why + control + defHint + '</div>';
}

/** Drag-and-drop + click-to-browse for the documents question. */
function wireUpload(form) {
  const up = form.querySelector('#docUpload');
  const dz = form.querySelector('#dropzone');
  if (!up || !dz) return;
  const send = async (picked) => {
    if (!picked.length) return;
    setText('docUploadStatus', 'uploading ' + picked.length + ' file(s)...');
    const files = await Promise.all(picked.map(f => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, data: String(r.result).split(',')[1] });
      r.onerror = reject;
      r.readAsDataURL(f);
    })));
    const resp = await fetch('/api/upload' + q(), { method: 'POST', body: JSON.stringify({ files }) });
    const out = await resp.json();
    if (out.dir) {
      const target = form.querySelector('input[name="documents_dir"]');
      if (target) target.value = out.dir;
      setText('docUploadStatus', out.saved.length + ' document(s) stored with the run: ' + out.saved.join(', '));
    } else setText('docUploadStatus', 'upload failed: ' + (out.error || 'unknown error'));
  };
  dz.onclick = () => up.click();
  dz.ondragover = (ev) => { ev.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = (ev) => { ev.preventDefault(); dz.classList.remove('drag'); send(Array.from(ev.dataTransfer.files)); };
  up.onchange = () => send(Array.from(up.files));
}

async function goHome() { currentRun = null; history.replaceState(null, '', location.pathname); await fetch('/api/deselect', { method: 'POST' }); tick(); }
async function startNewApp() {
  const name = document.getElementById('newName').value.trim();
  const projectTypeDir = document.getElementById('newType').value;
  if (!name) { setText('newErr', 'Give your app a name first.'); return; }
  if (!projectTypeDir) { setText('newErr', 'No certified project types available.'); return; }
  setText('newErr', 'starting the run...');
  const r = await fetch('/api/new-run', { method:'POST', body: JSON.stringify({ name, projectTypeDir }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { setText('newErr', data.error || 'could not start'); return; }
  setText('newErr', '');
  await openRun(data.dir); // lands on Overview with the intake form waiting
}
async function cloudBuild() {
  const name = document.getElementById('newName').value.trim();
  if (!name) { setText('newErr', 'Name your app first (lowercase, hyphens).'); return; }
  setText('newErr', 'starting a cloud build — the harness will build and deploy this app on AWS…');
  const r = await fetch('/api/cloud-build', { method:'POST', body: JSON.stringify({ name, target:'aws-apprunner' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { setText('newErr', d.error || 'could not start cloud build'); return; }
  setHTML('newErr', 'Building <b>' + name + '</b> on AWS (build ' + (d.buildId||'').slice(0,12) + '…). ' +
    'It builds in-cloud then deploys to App Runner — <a href="' + d.console + '" target="_blank">watch the build</a>. The live URL prints at the end of the deploy log.');
}
async function openRun(dir) {
  currentRun = dir;
  history.replaceState(null, '', location.pathname + '?run=' + encodeURIComponent(dir));
  await fetch('/api/select', { method:'POST', body: JSON.stringify({ dir }) }); // keeps single-tab flows working
  showTab('overview'); tick();
}

let openNode = null;
function closeDrawer() { openNode = null; document.getElementById('drawer').classList.remove('open'); }
async function openDrawer(id) {
  if (openNode === id) { closeDrawer(); return; } // same step toggles the panel
  openNode = id;
  document.getElementById('drawer').classList.add('open');
  await refreshDrawer();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeDoc(); } });
async function refreshDrawer() {
  if (!openNode) return;
  let d;
  try {
    d = await (await fetch('/api/node/' + encodeURIComponent(openNode) + q())).json();
  } catch (e) {
    setText('dTitle', openNode);
    setText('dKind', '');
    setText('dState', '');
    setHTML('dBody', '<div class="empty">Cannot reach the harness server — the drawer would show stale data. Restart it with: node packages/cli/dist/index.js ui .</div>');
    return;
  }
  setText('dTitle', d.id);
  setText('dKind', d.kind);
  const listNode = window.__nodes?.find(n => n.id === d.id);
  setText('dState', listNode ? listNode.state : '');
  const dep = (x) => '<div class="depitem"><span class="mono">' + esc(x.id) + '</span>' + (x.description ? ' — <span class="d">' + esc(x.description) + '</span>' : '') + '</div>';
  const attempts = d.attempts.map(a =>
    '<div class="attempt"><b>Attempt ' + a.attempt + '</b>' +
    (a.costUsd !== undefined ? ' · $' + a.costUsd.toFixed(2) : '') +
    (a.tokens ? ' · ' + fmtTok(a.tokens) + ' tokens' : '') +
    (a.wallClockMs ? ' · ' + fmtDur(a.wallClockMs) : '') +
    (a.error ? '<div class="err">' + esc(a.error) + '</div>' : '') + '</div>'
  ).join('') || '<div class="empty">Not started yet.</div>';
  const caps = d.sessionInfo ?
    '<h3>Session capabilities</h3>' +
    (d.sessionInfo.model ? '<div class="depitem">Model: <span class="mono">' + esc(d.sessionInfo.model) + '</span></div>' : '') +
    (Array.isArray(d.sessionInfo.tools) && d.sessionInfo.tools.length ? '<div class="depitem">Tools: ' + d.sessionInfo.tools.map(t => '<span class="badgechip">' + esc(t) + '</span>').join('') + '</div>' : '') +
    (Array.isArray(d.sessionInfo.agents) && d.sessionInfo.agents.length ? '<div class="depitem">Subagents: ' + d.sessionInfo.agents.map(t => '<span class="badgechip">' + esc(typeof t === 'string' ? t : t.name) + '</span>').join('') + '</div>' : '')
    : '';
  const toolUse = Object.keys(d.toolCounts || {}).length ?
    '<h3>Tool usage</h3><div class="depitem">' + Object.entries(d.toolCounts).map(([t, n]) => '<span class="badgechip">' + esc(t) + ' ×' + n + '</span>').join('') + '</div>' : '';
  const tr = d.transcript.map(t => {
    const m = t.message || {};
    if (m.parts) {
      return m.parts.map(p =>
        p.kind === 'tool'
          ? '<div class="tr tool"><span class="lbl">' + esc(p.label) + '</span> <span class="prev mono">' + esc(p.preview) + '</span></div>'
          : p.kind === 'text'
            ? '<div class="tr text"><span class="prev">' + esc(p.preview) + '</span></div>'
            : ''
      ).join('');
    }
    if (m.type === 'result') return '<div class="tr"><span class="lbl">result</span> <span class="prev">' + esc(m.preview) + '</span></div>';
    return '';
  }).join('');
  const cmdStyle = 'font-size:.72rem;white-space:pre-wrap;word-break:break-all';
  const ran =
    (d.command ? '<h3>' + (d.kind === 'verifier' ? 'The check this step runs' : 'What this step runs') + '</h3><div class="depitem mono" style="' + cmdStyle + '">' + esc(d.command) + '</div>' : '') +
    (d.verifyCommand ? '<h3>Exit criteria — verified by running, not assumed</h3><div class="depitem mono" style="' + cmdStyle + '">' + esc(d.verifyCommand) + '</div>' : '');
  const results = (d.results || []).map(r =>
    '<div class="attempt"><b>' + title(r.name) + '</b> · <a href="' + r.href + '" target="_blank" class="mono" style="color:var(--accent);font-size:.72rem">open ' + esc(r.file) + '</a>' +
    r.entries.map(e => '<div class="depitem"><span class="d">' + esc(title(e.k)) + ':</span> <span class="mono" style="font-size:.74rem">' + esc(e.v) + '</span></div>').join('') +
    '</div>').join('');
  // Findings live in the drawer of the step that produced them, grouped by
  // area and collapsible — the triage list, not a wall.
  const sevChip = v => '<span class="chip" style="' + (v === 'high' ? 'background:var(--bad,#c92a2a);color:#fff' : v === 'medium' ? 'border:1px solid var(--warn,#e08e0b);color:var(--warn,#e08e0b)' : 'border:1px solid var(--border)') + '">' + v + '</span>';
  const findingsHtml = d.findings ?
    '<h3>Findings <span class="hint">' + d.findings.high + ' high · ' + d.findings.total + ' total</span></h3>' +
    d.findings.groups.map(g => {
      const gh = g.items.filter(i => i.severity === 'high').length;
      return '<details class="egroup"' + (gh ? ' open' : '') + '><summary><span class="arrow">▶</span><b>' + esc(g.area) + '</b> <span class="hint">' + g.items.length + (gh ? ' · ' + gh + ' high' : '') + '</span></summary>' +
        '<div class="inner">' + g.items.map(i =>
          '<div class="findrow">' + sevChip(i.severity) +
          '<span class="mono hint" style="white-space:nowrap">' + esc((i.file||'') + (i.line ? ':' + i.line : '')) + '</span>' +
          '<span style="flex:1">' + esc(i.text) + '</span></div>').join('') + '</div></details>';
    }).join('') : '';
  setHTML('dBody',
    (d.description ? '<p style="font-size:.9rem">' + esc(d.description) + '</p>' : '') +
    findingsHtml +
    (d.model ? '<h3>Model</h3><div class="depitem mono">' + esc(d.model) + (d.escalateModel ? ' <span class="d">(retries escalate to ' + esc(d.escalateModel) + ')</span>' : '') + '</div>' : '') +
    ran + caps + toolUse +
    '<h3>Waits for</h3>' + (d.deps.map(dep).join('') || '<div class="empty">Nothing — a starting step.</div>') +
    '<h3>Feeds into</h3>' + (d.feeds.map(dep).join('') || '<div class="empty">Nothing — a final step.</div>') +
    (results ? '<h3>What it produced &amp; found</h3>' + results : '') +
    '<h3>Attempts</h3>' + attempts +
    (d.prompt ? '<details style="margin-top:.6rem"><summary class="hint" style="cursor:pointer">Prompt used for this step</summary><pre style="background:var(--page);border:1px solid var(--grid);border-radius:8px;padding:.7rem .9rem;font:11.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;margin-top:.4rem">' + esc(d.prompt) + '</pre></details>' : '') +
    (tr ? '<h3>What the agent did</h3>' + tr : '') +
    (listNode && listNode.state === 'failed'
      ? '<h3>This step failed — recover it</h3>' +
        '<div class="hint" style="margin-bottom:.4rem">If it ran out of budget, raise its cap and re-run just this step (the rest of the pipeline is untouched). Otherwise Resume from the header retries it.</div>' +
        '<button class="primary" style="background:var(--warn)" onclick="raiseBudgetUI()">Raise budget &amp; re-run this step</button>'
      : '') +
    (listNode && ['committed','failed','skipped'].includes(listNode.state)
      ? '<h3>Request changes</h3>' +
        '<textarea id="reviseText" rows="3" style="width:100%;box-sizing:border-box;border:1px solid var(--grid);border-radius:8px;padding:.5rem .7rem;font:inherit;background:var(--page);color:inherit" placeholder="What should be different about this step’s output?"></textarea>' +
        '<button class="primary" style="margin-top:.45rem" onclick="reviseNodeUI()">Revise this step</button>' +
        '<div class="hint" style="margin-top:.35rem">Everything downstream re-runs; steps whose inputs are unchanged re-use their previous result automatically.</div>'
      : '')
  );
}

async function stopRun() {
  if (!confirm('Stop this run?\\n\\nThe step in flight halts now (no more tokens spent). Everything already built is kept — you can Resume to pick up from the stopped step.')) return;
  setText('statusText', 'stopping…');
  await fetch('/api/cancel' + q(), { method:'POST' });
  setTimeout(tick, 800);
}

async function resumeRun() {
  setText('statusText', 'resuming…');
  const r = await (await fetch('/api/resume' + q(), { method:'POST' })).json();
  if (!r || !r.ok) { alert((r && r.error) || 'cannot resume right now'); tick(); return; }
  setTimeout(tick, 800);
}

async function raiseBudgetUI() {
  if (!openNode) return;
  const raw = prompt('New budget for step "' + openNode + '" (USD). The step re-runs alone under the higher cap; the rest of the pipeline is untouched.', '');
  if (raw === null) return;
  const toUsd = Number(raw);
  if (!(toUsd > 0)) { alert('Enter a dollar amount greater than 0.'); return; }
  const r = await (await fetch('/api/raise-budget' + q(), { method:'POST', body: JSON.stringify({ nodeId: openNode, toUsd, reviseAndResume: true }) })).json();
  if (!r || !r.ok) { alert('could not raise the budget'); return; }
  closeDrawer(); showTab('overview'); setText('statusText', r.resuming ? 'resuming…' : 'budget raised'); setTimeout(tick, 800);
}

async function reviseNodeUI() {
  const text = (document.getElementById('reviseText')?.value || '').trim();
  if (!text || !openNode) return;
  const preview = await (await fetch('/api/revise' + q(), { method:'POST', body: JSON.stringify({ nodeId: openNode, feedback: text, dryRun: true }) })).json();
  const NL = String.fromCharCode(10);
  const msg = 'Your feedback will reopen ' + preview.reopened.length + ' step(s):' + NL + NL + preview.reopened.join(', ') +
    NL + NL + 'Steps with unchanged inputs are re-used automatically (no cost). Continue?';
  if (!confirm(msg)) return;
  await fetch('/api/revise' + q(), { method:'POST', body: JSON.stringify({ nodeId: openNode, feedback: text }) });
  closeDrawer(); showTab('overview'); tick();
}

// document reader (formatted; raw toggles inside the same modal)
let docCache = null;
function renderCell(v) {
  if (v === null || v === undefined) return '<span class="hint">—</span>';
  if (Array.isArray(v)) {
    if (v.every(x => typeof x !== 'object')) return v.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('');
    return '<span class="hint">' + v.length + ' item' + (v.length === 1 ? '' : 's') + '</span>';
  }
  if (typeof v === 'object') return '<span class="hint mono">' + esc(JSON.stringify(v).slice(0, 60)) + '</span>';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return esc(String(v));
}
function renderTable(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const shown = cols.slice(0, 7);
  return '<table class="doctable"><thead><tr>' + shown.map(c => '<th>' + esc(title(c)) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + shown.map(c => '<td>' + renderCell(r[c]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
function renderDoc(data) {
  if (Array.isArray(data)) {
    return data.length && typeof data[0] === 'object' ? renderTable(data) : data.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('');
  }
  if (typeof data !== 'object' || data === null) return '<div class="kv"><span></span><span>' + esc(String(data)) + '</span></div>';
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object') continue;
    out += '<div class="kv"><span class="k">' + esc(title(k)) + '</span><span>' + renderCell(v) + '</span></div>';
  }
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v !== 'object') continue;
    out += '<h3>' + esc(title(k)) + '</h3>';
    if (Array.isArray(v)) out += v.length && typeof v[0] === 'object' ? renderTable(v) : (v.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('') || '<div class="empty">Empty.</div>');
    else out += renderDoc(v);
  }
  return out;
}
async function openDoc(label, blurb, fetchUrl) {
  setText('docTitle', label);
  setText('docBlurb', blurb);
  document.getElementById('docBody').innerHTML = '<div class="empty">Loading…</div>';
  document.getElementById('docModal').classList.add('open');
  const btn = document.getElementById('docRawBtn');
  btn.style.display = '';
  btn.textContent = 'View raw';
  try {
    docCache = await (await fetch(fetchUrl)).json();
    document.getElementById('docBody').innerHTML = renderDoc(docCache);
    btn.onclick = () => {
      const showingRaw = btn.textContent === 'View formatted';
      if (showingRaw) {
        document.getElementById('docBody').innerHTML = renderDoc(docCache);
        btn.textContent = 'View raw';
      } else {
        document.getElementById('docBody').innerHTML = '<pre>' + esc(JSON.stringify(docCache, null, 2)) + '</pre>';
        btn.textContent = 'View formatted';
      }
    };
  } catch (e) {
    document.getElementById('docBody').innerHTML = '<div class="empty">Could not load: ' + esc(e.message) + '</div>';
  }
}
function closeDoc() { document.getElementById('docModal').classList.remove('open'); }

function renderStorefront(data) {
  document.getElementById('storefront').style.display = '';
  document.getElementById('runview').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  document.getElementById('statusPill').style.display = 'none';
  document.getElementById('modePill').style.display = 'none';
  document.getElementById('banner').style.display = 'none';
  setText('title', 'harness');
  setText('miniStats', data.runs.length + ' app' + (data.runs.length === 1 ? '' : 's') + ' built');

  // hero: project types into the form + real numbers
  setHTML('newType', (data.projectTypes || []).map(p =>
    '<option value="' + esc(p.dir) + '">' + esc(p.name) + '@' + esc(p.version) + '</option>').join(''));
  document.getElementById('cloudBuildBtn').style.display = data.cloudBuild ? '' : 'none';
  const live = data.runs.filter(r => r.runMode === 'live').length;
  const building = data.runs.filter(r => r.status === 'running').length;
  const spend = data.runs.reduce((a, r) => a + (r.costUsd || 0), 0);
  setHTML('heroStats',
    '<div class="hs"><b>' + data.runs.length + '</b><span>apps built</span></div>' +
    '<div class="hs"><b>' + live + '</b><span>with live agents</span></div>' +
    '<div class="hs"><b>' + building + '</b><span>building now</span></div>' +
    '<div class="hs"><b>$' + spend.toFixed(0) + '</b><span>total invested</span></div>');

  // needs-you strip: parked runs and pending questions jump the queue
  const needy = data.runs.filter(r => r.needsYou);
  setHTML('needsYouStrip', needy.map(r =>
    '<div class="ny" onclick="openRun(' + esc(JSON.stringify(r.dir)) + ')">' +
    '<span class="chip">waiting on you</span><b>' + esc(r.appName) + '</b>' +
    '<span class="hint">has a question or approval waiting — click to answer</span></div>'
  ).join(''));

  document.getElementById('galHead').style.display = data.runs.length ? '' : 'none';
  // Keep the full list + who I am; the filter bar narrows it client-side.
  window.__allRuns = data.runs;
  window.__viewer = data.viewer || null;
  window.__teams = data.teams || [];
  renderFilterBar();
  renderGrid();
}

function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  const teams = window.__teams || [];
  const scoped = window.__viewer || teams.length; // only show when identity is known
  if (!scoped) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const f = window.__filter || { kind: 'all' };
  const chip = (label, active, onclick) =>
    '<button class="fchip' + (active ? ' on' : '') + '" onclick="' + onclick + '">' + esc(label) + '</button>';
  let html = '';
  if (window.__viewer) html += '<span class="who">You: ' + esc(window.__viewer) + (teams.length ? ' · on ' + teams.map(esc).join(', ') : ' · no teams') + '</span>';
  html += chip('All', f.kind === 'all', "setFilter({kind:'all'})");
  html += chip('Mine', f.kind === 'mine', "setFilter({kind:'mine'})");
  html += chip('Team projects', f.kind === 'team-all', "setFilter({kind:'team-all'})");
  for (const t of teams) html += chip('Team: ' + t, f.kind === 'team' && f.team === t, "setFilter({kind:'team',team:'" + t.replace(/'/g, "") + "'})");
  bar.innerHTML = html;
}

function setFilter(f) { window.__filter = f; renderFilterBar(); renderGrid(); }

function renderGrid() {
  const f = window.__filter || { kind: 'all' };
  let runs = window.__allRuns || [];
  if (f.kind === 'mine') runs = runs.filter(r => r.scope === 'individual' && (r.mine !== false));
  else if (f.kind === 'team-all') runs = runs.filter(r => r.scope === 'team');
  else if (f.kind === 'team') runs = runs.filter(r => r.team === f.team);
  setHTML('storeGrid', runs.map(r => {
    const pct = r.progress && r.progress.total ? Math.round(100 * r.progress.done / r.progress.total) : 0;
    const shot = r.thumb
      ? '<div class="shotwrap"><img src="' + esc(r.thumb) + '" loading="lazy" alt=""></div>'
      : '<div class="shotwrap"><span class="noshot">' + (r.status === 'running' ? 'building — screenshot coming' : 'no screenshot yet') + '</span></div>';
    const scopeChip = r.scope === 'team'
      ? '<span class="scopechip team">Team: ' + esc(r.team) + '</span>'
      : (r.mine === false ? '' : '<span class="scopechip mine">Mine</span>');
    return '<button class="runcard" onclick="openRun(' + esc(JSON.stringify(r.dir)) + ')">' + shot +
      '<div class="cbody"><b>' + esc(r.appName) + '</b>' +
      (r.prob || r.problem ? '<div class="prob">' + esc(r.problem || '') + '</div>' : '') +
      '<div class="pmeter"><div style="width:' + pct + '%"></div></div>' +
      '<div class="meta">' + scopeChip + '<span class="chip ' + (r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : '') + '">' + esc(r.status) + '</span>' +
      '<span class="chip ' + (r.runMode === 'live' ? 'ok' : '') + '">' + (r.runMode === 'live' ? 'live agents' : 'replay') + '</span>' +
      '<span>$' + Number(r.costUsd).toFixed(2) + '</span><span>' + esc(String(r.updatedAt).slice(0, 10)) + '</span></div></div></button>';
  }).join(''));
}

async function tick() {
  const runsData = await (await fetch('/api/runs')).json();
  if (!currentRun && !runsData.selected) { renderStorefront(runsData); return; }
  const s = await (await fetch('/api/state' + q())).json();
  if (!s.selected) { renderStorefront(runsData); return; }
  document.getElementById('storefront').style.display = 'none';
  document.getElementById('runview').style.display = '';
  document.getElementById('tabs').style.display = '';
  document.getElementById('statusPill').style.display = '';
  window.__nodes = s.nodes;
  setText('title', s.appName ? s.appName : s.projectType);
  setText('statusText', s.resuming ? 'resuming…' : s.status);
  document.getElementById('statusDot').style.background = STATUS_COLOR[s.resuming ? 'running' : s.status] || 'var(--muted)';
  // Stop is offered while an engine is live; Resume once it has stopped on a
  // failure or cancellation (parked runs resume by answering their gate).
  const live = s.engineAlive || s.status === 'running';
  document.getElementById('stopRunBtn').style.display = (live && !s.resuming) ? '' : 'none';
  document.getElementById('resumeRunBtn').style.display = (!live && !s.resuming && (s.status === 'failed' || s.status === 'cancelled')) ? '' : 'none';
  const modePill = document.getElementById('modePill');
  modePill.style.display = '';
  modePill.className = 'pill ' + (s.runMode === 'live' ? 'live' : 'replay');
  modePill.textContent = s.runMode === 'live' ? 'live agents' : 'replay (simulated agents)';
  modePill.title = s.runMode === 'live' ? 'Agent steps ran real Claude sessions' : 'This run replayed deterministic mocks — used for certification and testing. Run without --mock-agents for real agents.';
  const done = s.nodes.filter(n => n.state === 'committed' || n.state === 'skipped').length;
  setText('miniStats', done + '/' + s.nodes.length + ' steps · $' + s.totalCostUsd.toFixed(2) + ' · ' + fmtTok(s.tokensIn + s.tokensOut) + ' tokens');

  const banner = document.getElementById('banner');
  const needsHuman = (s.parkedGate || s.pendingQuestion) && !s.resuming;
  banner.style.display = needsHuman ? 'flex' : 'none';
  setText('attnV', needsHuman ? 'Action needed' : 'Nothing right now');
  setText('attnSub', needsHuman ? 'answer at the top of Overview' : 'questions appear at the top of Overview when the run needs you');
  const ovBtn = document.querySelector('#tabs button[data-tab=overview]');
  const wantBadge = needsHuman ? '<span class="dot"></span>' : '';
  if (ovBtn.innerHTML !== 'Overview' + wantBadge) ovBtn.innerHTML = 'Overview' + wantBadge;
  if (s.pendingQuestion) setText('bannerText', 'the ' + s.pendingQuestion.nodeId + ' agent asked you a question');
  else if (s.parkedGate) setText('bannerText', s.parkedGate.questions.length + ' question' + (s.parkedGate.questions.length===1?'':'s') + ' at ' + s.parkedGate.nodeId);

  // Remediation: re-running steps must never look like the build mysteriously
  // repeating itself. The banner carries the headline + live progress; the
  // timeline card below keeps the full history of every wave and its outcome.
  const remB = document.getElementById('remBanner');
  const activeRems = (s.remediation || []).filter(r => r.ended.kind === 'active');
  remB.style.display = activeRems.length ? 'flex' : 'none';
  if (activeRems.length) {
    const r = activeRems[activeRems.length - 1];
    const doneN = r.reopened.length - r.remaining.length;
    setText('remBannerTitle', waveNoun(r) + ' ' + r.wave + ' in progress');
    document.getElementById('remBanner').style.borderColor = r.kind === 'enhancement' ? 'var(--ok,#2b8a3e)' : 'var(--accent,#3b5bdb)';
    setHTML('remText', waveVerbing(r) + ' <b>' + esc(remHeadline(r.feedback)) + '</b> (feedback on <span class="mono">' + esc(r.nodeId) + '</span>) — ' +
      doneN + ' of ' + r.reopened.length + ' steps re-verified, now on <span class="mono">' + esc(r.remaining[0]) + '</span>. ' +
      '<span class="fb">Full story: Pipeline tab → wave ' + r.wave + '.</span>');
  }
  // Overview carries only a DIGEST — one line per wave, newest state visible
  // at a glance; the full story (feedback text + flow through the pipeline)
  // lives in the Pipeline tab's wave lenses, one click away.
  const remP = document.getElementById('remedPanel');
  if ((s.remediation || []).length) {
    remP.style.display = '';
    const cb = s.costBreakdown || {};
    // The money story, reconciled: original build vs what cycles ADDED.
    const recon = '<div class="remrecon">' +
      '<span>First build <b>$' + (cb.originalUsd||0).toFixed(2) + '</b></span>' +
      '<span class="hint">+</span>' +
      '<span>' + (cb.waves||0) + ' cycle(s) <b style="color:var(--warn,#e08e0b)">$' + (cb.remediationUsd||0).toFixed(2) + '</b></span>' +
      '<span class="hint">=</span>' +
      '<span>total <b>$' + (cb.totalUsd||0).toFixed(2) + '</b>' +
      (cb.originalUsd ? ' <span class="hint">(' + Math.round(100*(cb.remediationUsd||0)/(cb.totalUsd||1)) + '% spent on rework)</span>' : '') + '</span></div>';
    const origin = '<div class="remrow"><span style="min-width:8.5rem"><b>Original build</b></span><span class="hint">' +
      (s.originalBuild && s.originalBuild.completedAt
        ? 'completed ' + esc(String(s.originalBuild.completedAt).slice(11,19)) : 'first derivation') + '</span>' +
      '<span style="flex:1"></span><span class="mono" style="white-space:nowrap">$' + (cb.originalUsd||0).toFixed(2) + '</span></div>';
    setHTML('remedList', recon + origin + s.remediation.map((r, i) => {
      const state = waveVerdict(r);
      const f0 = r.feedbacks[0];
      return '<div class="remrow" data-wave="' + r.wave + '" role="button" tabindex="0">' +
        '<span style="min-width:8.5rem"><b>' + (waveIcon(r)) + ' ' + waveNoun(r) + ' ' + r.wave + '</b></span>' +
        '<span class="hint">' + esc(String(r.at||'').slice(11,19)) + '</span>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(remHeadline(f0?.feedback)) + ' <span class="hint">→ ' + esc(f0?.nodeId || '') + '</span></span>' +
        state + '<span class="mono" style="white-space:nowrap;min-width:3.5rem;text-align:right">$' + (r.costUsd||0).toFixed(2) + '</span>' +
        '<span class="hint" style="white-space:nowrap">details →</span></div>';
    }).join(''));
    remP.querySelectorAll('.remrow[data-wave]').forEach(el => el.onclick = () => {
      waveSel = el.dataset.wave; showTab('pipeline'); tick();
    });
  } else remP.style.display = 'none';

  setText('progressV', done + ' / ' + s.nodes.length);
  document.getElementById('progressBar').style.width = (100*done/s.nodes.length) + '%';
  setText('progressSub', 'steps complete');
  setText('costV', '$' + s.totalCostUsd.toFixed(2));
  const costBar = document.getElementById('costBar');
  if (s.runBudgetUsd) {
    costBar.style.width = Math.min(100, 100*s.totalCostUsd/s.runBudgetUsd) + '%';
    costBar.className = s.totalCostUsd > s.runBudgetUsd ? 'over' : '';
    setText('costSub', 'of $' + s.runBudgetUsd.toFixed(2) + ' budget');
  } else setText('costSub', 'no budget set');
  setText('tokV', fmtTok(s.tokensIn + s.tokensOut));
  setText('tokSub', fmtTok(s.tokensIn) + ' in · ' + fmtTok(s.tokensOut) + ' out');
  setText('elapsedV', fmtDur(s.activeMs));
  setText('elapsedSub', 'steps working; ' + fmtDur(s.elapsedMs) + ' start to finish');

  // about
  setHTML('about',
    '<div class="kv"><span class="k">Application</span><span><b>' + esc(s.appName ?? '—') + '</b></span></div>' +
    '<div class="kv"><span class="k">Project type</span><span class="mono">' + esc(s.projectType) + '</span></div>' +
    (s.projectDescription ? '<div class="kv"><span class="k">What it builds</span><span>' + esc(s.projectDescription) + '</span></div>' : '') +
    (s.problemStatement ? '<div class="kv"><span class="k">Problem</span><span>' + esc(s.problemStatement) + '</span></div>' : '') +
    '<div class="kv"><span class="k">Agents</span><span>' + (s.runMode === 'live' ? 'real Claude sessions' : 'simulated (certification replay) — run without --mock-agents for real agents') + '</span></div>' +
    (s.designChoice ? '<div class="kv"><span class="k">Design</span><span>' + esc(s.designChoice) + ' <span class="chip ok">locked</span></span></div>' : '') +
    (s.startedAt ? '<div class="kv"><span class="k">Started</span><span>' + esc(String(s.startedAt).slice(0,19).replace('T',' ')) + '</span></div>' : '') +
    '<div class="kv"><span class="k">Workspace</span><span class="mono" style="font-size:.76rem">' + esc(s.workspace) + '</span></div>'
  );

  // quality
  const qual = s.quality || {};
  const mark = (ok) => ok === null || ok === undefined ? '<span class="mark na">–</span>' : ok ? '<span class="mark ok">✓</span>' : '<span class="mark bad">✕</span>';
  setHTML('quality',
    '<div class="qrow">' + mark(qual.backendTests ? qual.backendTests === 'pass' : null) + '<span>Backend test suite</span><span class="stat">' + esc(qual.backendSummary ?? 'runs at integration') + '</span></div>' +
    '<div class="qrow">' + mark(qual.evals ? qual.evals.status === 'pass' : null) + '<span>Agent evals</span><span class="stat">' + (qual.evals ? esc(qual.evals.passed + '/' + qual.evals.total + ' passed') : 'runs at integration') + '</span></div>' +
    '<div class="qrow">' + mark(qual.securityHigh === null ? null : qual.securityHigh === 0) + '<span>Security scan</span><span class="stat">' + (qual.securityHigh === null ? 'runs after build' : qual.securityHigh + ' blocking · ' + (qual.securityFindings ?? 0) + ' total findings') + '</span></div>' +
    '<div class="qrow">' + mark(qual.composeSmoke === null ? null : qual.composeSmoke !== 'failed') + '<span>Container boot smoke</span><span class="stat">' + esc(qual.composeSmoke ?? '—') + '</span></div>' +
    '<div class="qrow">' + mark(qual.requirementsCovered ? qual.requirementsCovered.covered === qual.requirementsCovered.total : null) + '<span>Requirements covered</span><span class="stat">' + (qual.requirementsCovered ? qual.requirementsCovered.covered + '/' + qual.requirementsCovered.total : 'traceability pending') + '</span></div>' +
    '<div class="qrow">' + mark(qual.slicesPlanned ? qual.slicesDelivered >= qual.slicesPlanned : null) + '<span>Feature slices</span><span class="stat">' + (qual.slicesPlanned ? qual.slicesDelivered + ' delivered of ' + qual.slicesPlanned + ' planned' : '—') + '</span></div>'
  );

  // your app's agents — the roster the built application actually runs
  const agentsPanel = document.getElementById('agentsPanel');
  if (Array.isArray(s.appAgents) && s.appAgents.length) {
    agentsPanel.style.display = '';
    setHTML('appAgents', s.appAgents.map(a =>
      '<div class="agcard"><div class="agname">' + esc(a.name) + '</div>' +
      (a.role ? '<div class="agrole">' + esc(a.role) + '</div>' : '') +
      ((a.tools || []).length ? '<div class="agrow"><span class="k">tools</span>' + a.tools.map(t => '<span class="badgechip">' + esc(t) + '</span>').join('') + '</div>' : '') +
      ((a.denied_tools || []).length ? '<div class="agrow"><span class="k">never</span>' + a.denied_tools.map(t => '<span class="badgechip deny">' + esc(t) + '</span>').join('') + '</div>' : '') +
      ((a.addresses || []).length ? '<div class="agrow"><span class="k">covers</span>' + a.addresses.map(t => '<span class="badgechip">' + esc(t) + '</span>').join('') + '</div>' : '') +
      (a.system_prompt ? '<details><summary class="hint" style="cursor:pointer;font-size:.72rem">Instructions it runs under</summary><div class="agevals" style="border:0;padding-top:.2rem">' + esc(String(a.system_prompt).slice(0, 600)) + '</div></details>' : '') +
      ((a.eval_criteria || []).length ? '<div class="agevals">held to: ' + esc(a.eval_criteria.join('; ')) + '</div>' : '') +
      '</div>').join('') +
    (Array.isArray(s.agentOpportunityMap) && s.agentOpportunityMap.length ?
      '<details style="grid-column:1/-1;margin-top:.3rem"><summary style="cursor:pointer;font-size:.8rem;font-weight:650">Where agents were considered — every slot evaluated, ' + s.agentOpportunityMap.filter(o => o.decision === 'included').length + ' included, ' + s.agentOpportunityMap.filter(o => o.decision === 'excluded').length + ' excluded with reasons</summary>' +
      '<div style="margin-top:.5rem">' + s.agentOpportunityMap.map(o =>
        '<div class="depitem"><span class="chip ' + (o.decision === 'included' ? 'ok' : '') + '">' + esc(o.decision) + '</span> <span class="mono" style="font-size:.74rem">' + esc(o.slot) + '</span>' +
        (o.agent ? ' <span class="badgechip">' + esc(o.agent) + '</span>' : '') +
        ' — <span class="d">' + esc(o.rationale) + '</span></div>').join('') + '</div></details>' : ''));
  } else agentsPanel.style.display = 'none';

  // your app's processes — deterministic flow with agentic/human steps called out
  const wfPanel = document.getElementById('workflowsPanel');
  if (Array.isArray(s.appWorkflows) && s.appWorkflows.length) {
    wfPanel.style.display = '';
    const KIND_LABEL = { deterministic: 'code', agent: 'AI agent', human: 'human', condition: 'branch' };
    const nodeDetail = (n) => {
      if (n.kind === 'deterministic') return 'handler: ' + (n.handler || '');
      if (n.kind === 'agent') return String(n.prompt || '').slice(0, 90);
      if (n.kind === 'human') return String(n.question || '').slice(0, 90);
      if (n.kind === 'condition') return n.path + ' = ' + JSON.stringify(n.equals) + (n.on_false ? ' · else → ' + n.on_false : '');
      return '';
    };
    setHTML('appWorkflows', s.appWorkflows.map(wf =>
      '<div class="wf"><div class="wfname">' + esc(title(wf.name)) + '</div>' +
      '<div class="wfdesc">' + esc(wf.description || '') + '</div>' +
      '<div class="wfflow">' + wf.nodes.map((n, i) =>
        (i > 0 ? '<span class="wfarrow">→</span>' : '') +
        '<div class="wfnode k-' + esc(n.kind) + '"><span class="nk">' + (KIND_LABEL[n.kind] || esc(n.kind)) + '</span>' +
        '<div class="nid">' + esc(title(n.id)) + '</div>' +
        '<div class="nd">' + esc(nodeDetail(n)) + '</div></div>'
      ).join('') + '</div>' +
      ((wf.addresses || []).length ? '<div class="agrow" style="font-size:.72rem;margin-top:.4rem"><span class="k" style="color:var(--muted);text-transform:uppercase;font-size:.62rem;margin-right:.3rem">covers</span>' + wf.addresses.map(a => '<span class="badgechip">' + esc(a) + '</span>').join('') + '</div>' : '') +
      '</div>'
    ).join('') +
    '<div class="wflegend"><span><b style="color:var(--accent)">AI agent</b> — reasoning step (model)</span><span><b>code</b> — deterministic handler</span><span><b style="color:var(--warn)">human</b> — parks until a person decides</span><span><b>branch</b> — condition on earlier outputs</span></div>');
  } else wfPanel.style.display = 'none';

  // slice screenshots
  document.getElementById('shotsPanel').style.display = s.sliceShots.length ? '' : 'none';
  // Feedback is first-class: visible whenever there is a built app to react to.
  document.getElementById('feedbackPanel').style.display = (s.sliceShots.length || s.appAvailable) ? '' : 'none';
  const shotsChanged = setHTML('shots', s.sliceShots.map(x =>
    '<button class="shot" data-href="' + x.href + '" data-cap="' + esc(x.name || x.slice) + '" data-sub="' + esc(x.caption || '') + '"><img src="' + x.href + '" loading="lazy">' +
    '<div class="cap"><b>' + esc(x.name || x.slice) + '</b>' + (x.caption ? '<div class="capsub">' + esc(x.caption) + '</div>' : '') + '</div></button>').join(''));
  if (shotsChanged) document.querySelectorAll('.shot').forEach(b => b.onclick = () => {
    setText('docTitle', b.dataset.cap);
    setText('docBlurb', b.dataset.sub || 'the app as it looked after this slice');
    document.getElementById('docRawBtn').style.display = 'none';
    document.getElementById('docBody').innerHTML = '<img src="' + b.dataset.href + '" style="width:100%;border-radius:8px;border:1px solid var(--grid)">';
    document.getElementById('docModal').classList.add('open');
  });

  // app feedback form (fix a slice / new requirement)
  setHTML('fbSlice', s.sliceShots.map(x => '<option value="' + esc(x.slice) + '">' + esc(x.slice) + '</option>').join(''));
  const fbForm = document.getElementById('feedbackForm');
  if (fbForm && !fbForm.dataset.wired) {
    fbForm.dataset.wired = '1';
    fbForm.addEventListener('change', () => {
      const kind = new FormData(fbForm).get('fbKind');
      document.getElementById('fbSliceRow').style.display = kind === 'fix-slice' ? '' : 'none';
    });
    fbForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const kind = new FormData(fbForm).get('fbKind');
      const text = document.getElementById('fbText').value.trim();
      if (!text) return;
      const r = await (await fetch('/api/feedback' + q(), { method:'POST', body: JSON.stringify({ kind, slice: document.getElementById('fbSlice').value, text }) })).json();
      if (r.ok) {
        document.getElementById('fbText').value = '';
        const how = r.routed
          ? (r.routed.mode === 'fix-slice'
            ? 'Routed as a targeted fix of ' + r.target + ' — ' + r.routed.why
            : 'Routed through requirements (front door) — ' + r.routed.why)
          : 'Entered at ' + r.target;
        alert('Feedback accepted.' + NL + NL + how + '.' + NL + NL + r.reopened.length + ' step(s) re-derive; unchanged steps are re-used. Track it as a new wave in the Pipeline tab.');
      }
      tick();
    };
  }

  // open review window: countdown + approve-now
  const wg = document.getElementById('windowPanel');
  if (s.windowGate) {
    wg.style.display = '';
    const secs = Math.max(0, Math.round((s.windowGate.deadlineMs - Date.now()) / 1000));
    setText('windowCountdown', 'proceeding on the default in ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' — answer to decide now');
    const form = document.getElementById('windowForm');
    if (form.dataset.node !== s.windowGate.nodeId) {
      form.dataset.node = s.windowGate.nodeId;
      form.innerHTML = (s.windowGate.description ? '<div class="hint" style="margin-bottom:.5rem">' + esc(s.windowGate.description) + '</div>' : '') +
        s.windowGate.questions.map(qField).join('') +
        '<button type="submit" class="primary">Decide now</button>';
      wireUpload(form);
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Recording…';
        const answers = Object.fromEntries(new FormData(form).entries());
        const r = await (await fetch('/api/answer' + q(), { method:'POST', body: JSON.stringify({ nodeId: form.dataset.node, answers }) })).json().catch(() => ({}));
        btn.textContent = r.ok ? '✓ Recorded — the build applies it now' : 'Failed — try again';
        if (r.ok) setTimeout(() => { form.dataset.node = ''; tick(); }, 900);
        else btn.disabled = false;
      };
    }
  } else { wg.style.display = 'none'; }

  // design delivery
  const dp = document.getElementById('deliveryPanel');
  if (s.designDelivery && s.designDelivery.promised) {
    const dd = s.designDelivery;
    document.getElementById('sec-design').style.display = '';
    dp.style.display = '';
    if (dd.delivered) {
      setText('deliveryTotals', dd.delivered.screens_present + '/' + dd.promised.screens + ' screens live · ' + dd.delivered.elements_present + '/' + dd.promised.elements + ' elements present');
    } else {
      setText('deliveryTotals', dd.promised.screens + ' screens and ' + dd.promised.elements + ' elements promised — delivery proof runs after the build');
    }
    setHTML('deliveryGrid', (dd.screens.length ? dd.screens : []).map(sc =>
      '<div style="border:1px solid var(--grid);border-radius:10px;padding:.6rem .8rem">' +
      '<div style="display:flex;align-items:center;gap:.4rem"><span class="chip ' + (sc.present ? 'ok' : 'bad') + '">' + (sc.present ? 'live' : 'missing') + '</span><b style="font-size:.85rem">' + esc(sc.title || sc.id) + '</b></div>' +
      '<div class="hint" style="margin-top:.25rem">' + (sc.covered_by_slice ? 'delivered in slice ' + sc.covered_by_slice : 'unassigned') + ' · ' + sc.elements_present + '/' + sc.elements_declared + ' elements</div>' +
      (sc.shotHref ? '<a href="' + esc(sc.shotHref) + q() + '" target="_blank" class="hint" style="display:block;margin-top:.25rem">live screenshot →</a>' : '') +
      '</div>').join('') || '<div class="empty">screen-by-screen proof appears when design-coverage runs</div>');
  } else dp.style.display = 'none';

  // agent mid-step question
  const aq = document.getElementById('agentQPanel');
  if (s.pendingQuestion && !s.resuming) {
    aq.style.display = '';
    const form = document.getElementById('agentQForm');
    if (form.dataset.qid !== s.pendingQuestion.id) {
      form.dataset.qid = s.pendingQuestion.id;
      const qs = Array.isArray(s.pendingQuestion.questions) ? s.pendingQuestion.questions : [];
      form.innerHTML = '<div class="hint" style="margin-bottom:.5rem">Asked by the <b>' + esc(s.pendingQuestion.nodeId) + '</b> step while working.</div>' +
        qs.map((q, i) =>
          '<div class="q"><label>' + esc(q.question ?? q.prompt ?? 'Question') + '</label>' +
          (Array.isArray(q.options) ? q.options.map(o =>
            '<label class="opt"><input type="radio" name="q' + i + '" value="' + esc(o.label) + '"><span><b>' + esc(o.label) + '</b>' +
            (o.description ? '<div class="od">' + esc(o.description) + '</div>' : '') + '</span></label>').join('') : '') +
          '<input type="text" name="q' + i + '_other" placeholder="Or type your own answer">' +
          '</div>').join('') +
        '<button type="submit" class="primary">Send answer to the agent</button>';
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const answers = {};
        qs.forEach((q, i) => {
          const other = String(fd.get('q' + i + '_other') || '').trim();
          answers[q.question ?? ('q' + i)] = other || String(fd.get('q' + i) || '');
        });
        await fetch('/api/agent-answer' + q(), { method:'POST', body: JSON.stringify({ id: s.pendingQuestion.id, answers }) });
        form.dataset.qid = '';
      };
    }
  } else { aq.style.display = 'none'; }

  // narrative sections show only when they have visible content
  for (const sec of ['sec-design', 'sec-anatomy', 'sec-running']) {
    const el = document.getElementById(sec);
    if (el) {
      const anyVisible = [...el.querySelectorAll('.card')].some(c => c.style.display !== 'none');
      el.style.display = anyVisible ? '' : 'none';
    }
  }

  // pipeline
  const phases = [];
  const byPhase = {};
  for (const n of s.nodes) {
    if (!byPhase[n.phase]) { byPhase[n.phase] = []; phases.push(n.phase); }
    byPhase[n.phase].push(n);
  }
  const header = '<div class="prow header"><span></span><span>Step</span><span>Kind / model</span><span>What it does</span><span class="num">Cost</span><span class="num">Tokens</span><span class="num">Time</span></div>';
  // Wave sub-tabs: view the pipeline as the full build, or through the lens
  // of one remediation wave — its feedback up top, its steps highlighted with
  // outcomes, everything untouched dimmed. The flow becomes visible in place.
  const wt = document.getElementById('waveTabs');
  const wi = document.getElementById('waveInfo');
  const waves = s.remediation || [];
  if (waves.length) {
    wt.style.display = '';
    const tabHtml = '<button data-wave="all" class="' + (waveSel === 'all' ? 'active' : '') + '">Live (current state)</button>' +
      waves.map(r => '<button data-wave="' + r.wave + '" class="' + (String(waveSel) === String(r.wave) ? 'active' : '') + '">' +
        (REM_SRC_ICON[r.feedbacks[0]?.source] || '💬') + ' ' + waveNoun(r) + ' ' + r.wave +
        (r.remaining.length ? ' <span class="dot"></span>' : '') + '</button>').join('');
    if (wt.innerHTML !== tabHtml) {
      wt.innerHTML = tabHtml;
      wt.querySelectorAll('button').forEach(b => b.onclick = () => { waveSel = b.dataset.wave; tick(); });
    }
  } else { wt.style.display = 'none'; waveSel = 'all'; }
  const activeWave = waveSel === 'all' ? null : waves.find(r => String(r.wave) === String(waveSel));
  if (!activeWave && s.remediationActive) {
    // The live view during a wave: say WHY completed work looks in-flight
    // again, or "queued" steps read as the build going backwards.
    wi.style.display = '';
    const act = waves.filter(r => r.ended.kind === 'active').pop();
    setHTML('waveInfo', '⟳ <b>This is the LIVE pipeline (current state).</b> ' + (act ? waveNoun(act) + ' ' + act.wave : 'A wave') +
      ' is re-deriving previously completed steps — they re-verify from scratch, nothing is patched in place. ' +
      'Click the wave tab above to freeze the view to that wave AS IT RAN.');
  } else if (activeWave) {
    wi.style.display = '';
    setHTML('waveInfo',
      '<div style="margin-bottom:.3rem"><b>' + waveNoun(activeWave) + ' ' + activeWave.wave + '</b> <span class="hint">— shown AS IT RAN at ' + esc(String(activeWave.at||'').slice(11,19)) + ', not current state</span> ' + waveVerdict(activeWave) + '</div>' +
      (activeWave.trigger
        ? '<div class="remfb">⛔ <b>Triggered by</b> <span class="mono">' + esc(activeWave.trigger.nodeId) + '</span> failing: <span class="hint">' + esc(activeWave.trigger.summary) + '</span></div>'
        : '') +
      activeWave.feedbacks.map(f =>
        '<div class="remfb">' + (REM_SRC_ICON[f.source] || '💬') + ' <b>' + esc(f.source) + '</b> ' + (activeWave.kind === 'enhancement' ? 'requested' : 'found the problem') + ' → feedback delivered to <span class="mono">' + esc(f.nodeId) + '</span>' +
        (f.feedback ? '<details><summary class="hint">what it said</summary><div class="hint" style="white-space:pre-wrap;max-height:160px;overflow:auto">' + esc(f.feedback) + '</div></details>' : '') + '</div>').join('') +
      (activeWave.ended && activeWave.ended.kind === 'failed'
        ? '<div class="remfb">⛔ <b>How this wave ended:</b> <span class="mono">' + esc(activeWave.ended.nodeId) + '</span> failed — <span class="hint">' + esc(activeWave.ended.summary || '') + '</span> → remediation ' + (activeWave.wave + 1) + ' picks it up.</div>'
        : activeWave.ended && activeWave.ended.kind === 'completed'
          ? '<div class="remfb">✓ <b>How this wave ended:</b> the whole pipeline re-verified through to completion.</div>'
          : '') +
      '<div class="hint" style="margin-top:.25rem">Highlighted steps below are re-derived by this wave, in place in the pipeline; dimmed steps were untouched.</div>');
  } else wi.style.display = 'none';
  const waveAction = (id) => activeWave ? activeWave.actions.find(a => a.nodeId === id) : null;

  setHTML('nodes', phases.map(ph => {
    const list = byPhase[ph];
    // In a wave lens the phase bar counts only THIS wave's steps in this phase
    // (in-span re-verified), not the phase's lifetime completion.
    const inWave = activeWave ? list.filter(n => waveAction(n.id)) : list;
    const denom = inWave.length || list.length;
    const phDone = activeWave
      ? inWave.filter(n => { const a = waveAction(n.id); return a && a.outcome === 'committed'; }).length
      : list.filter(n => n.state === 'committed' || n.state === 'skipped').length;
    const phLabel = activeWave ? (inWave.length ? phDone + '/' + inWave.length + ' re-verified' : '—') : phDone + '/' + list.length;
    return '<div class="phase"><div class="phead"><b>' + esc(ph) + '</b><div class="bar"><div style="width:' + (100*phDone/denom) + '%"></div></div><span class="stat">' + phLabel + '</span></div>' + header +
      list.map(n =>
        // Wave lens shows BOUNDARY state for EVERY row (reopened or not) — a
        // step the wave never reached reads pending, not its eventual commit,
        // so a superseded wave can't look like the whole pipeline went green.
        // Live view shows current state.
        (() => {
          const wa = activeWave ? waveAction(n.id) : null;
          const bstate = activeWave ? (activeWave.nodeStates?.[n.id] ?? 'pending') : n.state;
          const disp = { cls: bstate, icon: STATE_ICON[bstate]||'' };
          return '<div class="prow ' + disp.cls + (activeWave ? (wa ? ' inwave' : ' dim') : '') + (wa && wa.outcome === 'failed' ? ' failhere' : '') + '" data-id="' + esc(n.id) + '"><span class="icon">' + disp.icon + '</span>';
        })() +
        '<span class="id mono">' + esc(n.id) + (n.retries ? ' <span class="chip retry">retry ×' + n.retries + '</span>' : '') +
        // Wave lens: membership = accent bar + in-span icon; a chip when there's
        // news (built/reused/failed/queued-because-wave-stopped).
        (activeWave && waveAction(n.id) && !['skipped'].includes(waveAction(n.id).outcome) ? ' <span class="wavechip">' + remOutcomeChip(waveAction(n.id)) + '</span>' : '') +
        // Full-build lens: the compact remediation markers live here instead.
        (!activeWave && n.revised ? ' <span class="chip" style="border:1px solid var(--accent,#3b5bdb);color:var(--accent,#3b5bdb)" title="remediation feedback was delivered to this step ' + n.revised + ' time(s) — see the wave tabs above">revised ×' + n.revised + '</span>' : '') +
        (!activeWave && (s.remediation || []).some(r => r.remaining.includes(n.id)) ? ' <span class="chip remed" title="re-deriving from remediation feedback">remediating</span>' : '') + '</span>' +
        (n.kind === 'agent' ? '<span class="chip model">' + esc(shortModel(n.model) || 'agent') + '</span>' : '<span class="chip">' + n.kind + '</span>') +
        '<span class="desc">' + esc(n.description ?? '') + '</span>' +
        '<span class="num">' + (n.cost && n.cost.costUsd ? '$' + n.cost.costUsd.toFixed(2) : '') + '</span>' +
        '<span class="num">' + (n.cost && (n.cost.tokensIn + n.cost.tokensOut) ? fmtTok(n.cost.tokensIn + n.cost.tokensOut) : '') + '</span>' +
        '<span class="num">' + (n.cost && n.cost.wallClockMs ? fmtDur(n.cost.wallClockMs) : '') + '</span></div>'
      ).join('') + '</div>';
  }).join(''));
  document.querySelectorAll('#nodes .prow[data-id]').forEach(el => el.onclick = () => openDrawer(el.dataset.id));

  // decisions
  setHTML('decisions',
    (s.decisions.length ? s.decisions.map(d =>
      '<div class="dcard"><div class="dhead"><b>' + esc(title(d.gate)) + '</b><span class="chip">' + esc(d.source) + '</span><span class="when">' + esc((d.ts||'').slice(0,19).replace('T',' ')) + '</span></div>' +
      (d.description ? '<div class="hint" style="margin-bottom:.4rem">' + esc(d.description) + '</div>' : '') +
      d.items.map(i =>
        '<div class="qa"><span class="q">' + esc(i.prompt) + '</span><span class="a">' + esc(i.answer) +
        (i.defaulted ? ' <span class="chip default">default</span>' : '') + '</span></div>').join('') + '</div>'
    ).join('') : '<div class="card"><div class="empty">No decisions yet — gates you answer will appear here.</div></div>') +
    (s.assumptions.length ? '<div class="dcard"><div class="dhead"><b>Assumptions the run proceeded on</b></div>' +
      s.assumptions.map(a => '<div class="qa"><span class="q">' + esc(a.question) + '</span><span class="a">' + esc(a.answer) + ' <span class="chip default">' + esc(a.source) + '</span></span></div>').join('') + '</div>' : '')
  );

  // documents grouped by phase
  const docPhases = [];
  const docsBy = {};
  for (const d of s.documents) {
    if (!docsBy[d.phase]) { docsBy[d.phase] = []; docPhases.push(d.phase); }
    docsBy[d.phase].push(d);
  }
  const docsChanged = setHTML('docs', s.documents.length ? docPhases.map(ph =>
    '<div class="docphase"><h3>' + esc(ph) + '</h3>' +
    docsBy[ph].map(d => '<button class="docrow" data-i="' + s.documents.indexOf(d) + '"><b>' + esc(d.label) + '</b><span class="blurb">' + esc(d.blurb) + '</span><span class="src mono">' + esc(d.node) + '</span></button>').join('') +
    '</div>').join('') : '<div class="empty">Documents appear as steps finish.</div>');
  window.__docs = s.documents;
  if (docsChanged) document.querySelectorAll('.docrow').forEach(b => b.onclick = () => {
    const d = window.__docs[Number(b.dataset.i)];
    openDoc(d.label, d.blurb, d.fetch);
  });
  setHTML('raw', s.rawArtifacts.map(a => '<a class="mono" style="display:block;color:var(--ink2);text-decoration:none;font-size:.74rem;padding:.06rem 0" href="/artifact/' + a + q() + '" target="_blank">' + esc(a) + '</a>').join(''));

  // activity: foldable groups per step
  const groups = [];
  for (const e of s.events) {
    const last = groups[groups.length - 1];
    if (e.nodeId && last && last.nodeId === e.nodeId) last.items.push(e);
    else groups.push({ nodeId: e.nodeId, items: [e] });
  }
  // Phase dividers: label each run phase in the activity stream so the user
  // sees "Remediation 3" begin, not an unexplained burst of re-runs.
  const phaseLabel = (p) => { if (p === 'build') return 'Original build'; const n = String(p).replace('wave-',''); const r = (s.remediation||[]).find(x => String(x.wave) === n); return (r ? waveNoun(r) : 'Remediation') + ' ' + n; };
  const groupHtml = (g) => {
    const bad = g.items.some(e => e.type.includes('failed') || e.type.includes('exceeded'));
    const lastE = g.items[g.items.length - 1];
    if (!g.nodeId || g.items.length === 1) {
      return '<div class="egroup"><summary style="cursor:default"><span class="arrow"></span><span class="t mono">' + (lastE.ts||'').slice(11,19) + '</span><span class="' + (bad?'event bad':'') + '">' + esc(lastE.text) + '</span></summary></div>';
    }
    return '<details class="egroup"' + (bad ? ' open' : '') + '><summary><span class="arrow">▶</span><span class="t mono">' + (g.items[0].ts||'').slice(11,19) + '</span><b class="mono">' + esc(g.nodeId) + '</b><span class="hint">' + g.items.length + ' events</span><span class="outcome ' + (bad ? 'chip bad' : 'chip') + '">' + esc(lastE.text.length > 60 ? lastE.text.slice(0,60) + '…' : lastE.text) + '</span></summary>' +
      '<div class="inner">' + g.items.map(e => '<div class="event' + (e.type.includes('failed')||e.type.includes('exceeded') ? ' bad' : '') + '"><span class="t mono">' + (e.ts||'').slice(11,19) + '</span><span>' + esc(e.text) + '</span></div>').join('') + '</div></details>';
  };
  const rows = [];
  let seenPhase = null;
  for (const g of groups.slice().reverse()) {
    const gp = (g.items[g.items.length - 1].phase) || 'build';
    if (gp !== seenPhase) {
      const isRem = gp !== 'build';
      rows.push('<div class="phasedivider' + (isRem ? ' rem' : '') + '">' + (isRem ? '⟳ ' : '▸ ') + esc(phaseLabel(gp)) + '</div>');
      seenPhase = gp;
    }
    rows.push(groupHtml(g));
  }
  setHTML('events', rows.join(''));

  // Security POSTURE on Overview = one honest line, not a wall. The findings
  // themselves live in the drawer of the step that produced them (click
  // security-scan or slice-audit in the Pipeline).
  const fp = document.getElementById('findingsPanel');
  const sec = s.securityReport, aud = s.auditReport;
  const highN = (sec?.findings || []).filter(f => (f.severity||'medium') === 'high').length
              + (aud?.findings || []).filter(f => (f.severity||'medium') === 'high').length;
  const totalN = (sec?.findings || []).length + (aud?.findings || []).length;
  if (totalN) {
    fp.style.display = '';
    const openAudit = aud ? 'slice-audit' : 'remediate';
    const verdict = highN > 0
      ? '<span class="chip" style="background:var(--bad,#c92a2a);color:#fff">⛔ ' + highN + ' high · not shippable</span>'
      : '<span class="chip" style="background:var(--ok,#2b8a3e);color:#fff">✓ 0 high</span>';
    setHTML('findingsList',
      '<div style="display:flex;align-items:center;gap:.7rem;flex-wrap:wrap">' + verdict +
      '<span class="hint">' + totalN + ' findings total' + (sec?.filesScanned ? ' · ' + sec.filesScanned + ' files scanned' : '') + '</span>' +
      '<button class="ghost" id="reviewFindingsBtn" data-node="' + openAudit + '" style="margin-left:auto">Review findings →</button></div>');
    const rfb = document.getElementById('reviewFindingsBtn');
    if (rfb) rfb.onclick = () => { showTab('pipeline'); openDrawer(rfb.dataset.node); };
  } else fp.style.display = 'none';

  // designs (locked once chosen)
  const meta = {};
  for (const o of (s.designOptions || [])) meta[o.id] = o;
  const previews = s.rawArtifacts.filter(a => (a.startsWith('design-assemble/') || a.startsWith('design-options/')) && a.endsWith('/index.html'));
  document.getElementById('designPanel').style.display = previews.length ? '' : 'none';
  setText('designHead', s.designChoice ? 'Design — ' + s.designChoice + ' chosen and locked' : 'Design options — pick one');
  const designsChanged = setHTML('designs', previews.map(p => {
    const id = p.split('/').slice(-2)[0];
    const name = meta[id] ? meta[id].name : id;
    const chosen = s.designChoice === id;
    return '<div class="design' + (chosen ? ' chosen' : '') + '">' + (chosen ? '<span class="sel">✓ Selected</span>' : '') +
      '<div class="thumb"><iframe src="/artifact/' + p + q() + '" loading="lazy" tabindex="-1"></iframe>' +
      '<a href="/artifact/' + p + q() + '" target="_blank" title="Open ' + esc(name) + ' full size"></a></div>' +
      '<div class="bar"><b>' + esc(name) + '</b><span class="chip mono">' + esc(id) + '</span>' +
      '<a href="/artifact/' + p + q() + '" target="_blank">open</a>' +
      '<button data-id="' + esc(id) + '"' + (s.designChoice ? ' disabled' : '') + '>' + (chosen ? 'Chosen' : 'Choose') + '</button></div></div>';
  }).join(''));
  if (designsChanged) document.querySelectorAll('.design button:not([disabled])').forEach(b => b.onclick = () => {
    const input = document.querySelector('#gateForm input[name="chosen_option"]');
    if (input) { input.value = b.dataset.id; input.scrollIntoView({behavior:'smooth'}); input.focus(); }
    else alert('The design-select gate is not waiting right now.');
  });

  // app panel
  const appPanel = document.getElementById('appPanel');
  // Only offer the app once real features exist (post-scaffold) or it's running.
  const appReady = s.appAvailable && (s.appStageNode !== 'scaffold' || s.app.status === 'running' || s.app.status === 'starting');
  appPanel.style.display = appReady ? '' : 'none';
  if (appReady) {
    const a = s.app;
    document.getElementById('appDot').style.background = STATUS_COLOR[a.status] || 'var(--muted)';
    setText('appStatus', a.status === 'failed' ? 'failed — ' + (a.error||'') : a.status);
    setText('appStage', a.node ? 'built at: ' + a.node : 'ready to launch');
    const launch = document.getElementById('appLaunch');
    const launchTxt = a.status === 'running' ? 'Relaunch latest' : a.status === 'starting' ? 'Starting…' : 'Launch app';
    if (launch.textContent !== launchTxt) launch.textContent = launchTxt;
    launch.disabled = a.status === 'starting';
    launch.onclick = () => fetch('/api/app/start', { method:'POST' });
    const stop = document.getElementById('appStop');
    stop.style.display = a.status === 'running' ? '' : 'none';
    stop.onclick = () => fetch('/api/app/stop', { method:'POST' });
    const link = document.getElementById('appLink');
    const wrap = document.getElementById('appFrameWrap');
    const frame = document.getElementById('appFrame');
    if (a.status === 'running' && a.port) {
      const appUrl = 'http://localhost:' + a.port;
      link.style.display = ''; link.href = appUrl; link.textContent = appUrl;
      wrap.style.display = '';
      if (frame.dataset.url !== appUrl) { frame.dataset.url = appUrl; frame.src = appUrl; }
    } else {
      link.style.display = 'none'; wrap.style.display = 'none'; frame.dataset.url = ''; frame.removeAttribute('src');
    }
  }

  // gate
  const panel = document.getElementById('gatePanel');
  if (s.parkedGate && !s.resuming) {
    panel.style.display = '';
    const form = document.getElementById('gateForm');
    if (form.dataset.node !== s.parkedGate.nodeId) {
      form.dataset.node = s.parkedGate.nodeId;
      form.innerHTML = s.parkedGate.questions.map(qField).join('') +
        '<button type="submit" class="primary">Answer &amp; resume run</button>';
      wireUpload(form);
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Recording…';
        const answers = Object.fromEntries(new FormData(form).entries());
        const r = await (await fetch('/api/answer' + q(), { method:'POST', body: JSON.stringify({ nodeId: form.dataset.node, answers }) })).json().catch(() => ({}));
        btn.textContent = !r.ok ? 'Failed — try again'
          : r.applied === 'resuming' ? '✓ Answer taken — resuming the run'
          : '✓ Answer recorded — it applies at the next checkpoint';
        if (r.ok) setTimeout(() => { form.dataset.node = ''; tick(); }, 1200);
        else btn.disabled = false;
      };
    }
  } else panel.style.display = 'none';

  if (openNode) refreshDrawer();
}
let offline = false;
async function safeTick() {
  try {
    await tick();
    if (offline) {
      // Back online: fully clear the outage pill (tick() repaints the rest).
      offline = false;
      setText('statusText', '');
      document.getElementById('statusDot').style.background = '';
      document.getElementById('statusPill').style.display = 'none';
    }
  } catch (e) {
    offline = true;
    setText('title', document.getElementById('title').textContent || 'harness');
    setText('statusText', 'server unreachable — it will reconnect by itself if restarted (harness ui)');
    document.getElementById('statusDot').style.background = 'var(--crit)';
    document.getElementById('statusPill').style.display = '';
  }
}
safeTick(); setInterval(safeTick, 2500);
</script>
</body>
</html>`;
