// `harness publish` — one command from a finished workspace to the firm
// gallery (DF-4). Assembles the evidence pack FROM the run's artifacts and
// journal (screenshots, acceptance ledger, governance, RTM, cost) and POSTs
// it to the app-registry, which derives the badges. Nothing self-reported.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Journal, foldState, loadProjectTypeFile } from "@harness/runner";

function readJsonIf(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Latest committed artifact dir that contains an app/ tree (slice-N, integrate...). */
function latestAppDir(workspace: string): string | null {
  const journal = new Journal(workspace);
  const state = foldState(journal.read());
  let found: string | null = null;
  for (const e of journal.read()) {
    if (e.type !== "node.committed" || !e.nodeId) continue;
    if (!state.committed.has(String(e.nodeId))) continue;
    const candidate = path.join(workspace, "artifacts", String(e.nodeId), "app");
    if (fs.existsSync(path.join(candidate, "frontend", "index.html"))) found = candidate;
  }
  return found;
}

export interface PublishOptions {
  registryUrl: string;
  owner?: string;
  team?: string;
  name?: string;
  /** Sharing scope: private (owner only) | team | firm (default). */
  visibility?: "private" | "team" | "firm";
}

export async function publishWorkspace(workspace: string, opts: PublishOptions): Promise<{ ok: boolean; message: string }> {
  const runConfig = readJsonIf(path.join(workspace, "run.json")) as { projectTypeDir?: string; owner?: string; team?: string } | null;
  if (!runConfig) return { ok: false, message: `${workspace} is not a run workspace (no run.json)` };
  const journal = new Journal(workspace);
  const events = journal.read();
  if (!events.length) return { ok: false, message: "empty journal — nothing to publish" };
  const state = foldState(events);

  const def = runConfig.projectTypeDir
    ? loadProjectTypeFile(fs.existsSync(path.join(workspace, "dag-snapshot.yaml")) ? path.join(workspace, "dag-snapshot.yaml") : path.join(runConfig.projectTypeDir, "dag.yaml"))
    : null;

  const intake = readJsonIf(path.join(workspace, "artifacts", "intake", "intake.json")) as Record<string, unknown> | null;
  const appDir = latestAppDir(workspace);
  const governance = readJsonIf(path.join(workspace, "artifacts", "governance-report", "governance.json")) as Record<string, any> | null;

  const files: Record<string, string> = {};
  const add = (rel: string, abs: string) => {
    if (fs.existsSync(abs)) files[rel] = fs.readFileSync(abs).toString("base64");
  };
  const attachments: Array<{ rel: string; abs: string }> = [];
  if (appDir) {
    add("acceptance_report.json", path.join(appDir, "acceptance_report.json"));
    const shots = path.join(appDir, "screenshots");
    if (fs.existsSync(shots)) {
      // Screenshots are large; they ship AFTER the core publish, one request
      // each (Cloud Run request bodies cap at 32MB).
      for (const f of fs.readdirSync(shots).filter((f) => f.endsWith(".png")).sort()) {
        attachments.push({ rel: `screenshots/${f}`, abs: path.join(shots, f) });
      }
    }
    add("SLICES.md", path.join(appDir, "SLICES.md"));
  }
  add("governance.json", path.join(workspace, "artifacts", "governance-report", "governance.json"));
  add("rtm.json", path.join(workspace, "artifacts", "traceability", "rtm.json"));

  // Journal-derived summary: the registry trusts this over publisher claims
  // only as far as it agrees with the evidence files.
  const status = events.some((e) => e.type === "run.completed") ? "completed" : events.at(-1)?.type ?? "unknown";
  const summary = {
    status,
    costUsd: Number(state.totalCostUsd.toFixed(2)),
    nodesCommitted: state.committed.size,
    startedAt: events[0]?.ts ?? null,
    finishedAt: events.at(-1)?.ts ?? null,
    gateDecisions: events.filter((e) => e.type === "gate.answered").length,
    revisions: events.filter((e) => e.type === "node.reopened").length,
    agents: governance?.agents?.count ?? null,
    securityHighFindings: governance?.security?.high_findings ?? null,
    requirementsCovered: governance?.requirements ? `${governance.requirements.covered}/${governance.requirements.total}` : null,
  };
  files["journal-summary.json"] = Buffer.from(JSON.stringify(summary, null, 2)).toString("base64");

  const payload = {
    name: opts.name ?? (intake?.project_name as string | undefined) ?? path.basename(workspace),
    // Default owner/team from the run itself (stamped at build time), so publish
    // inherits who built it and under which team.
    owner: opts.owner ?? runConfig.owner ?? `${os.userInfo().username}@firm.local`,
    team: opts.team ?? runConfig.team ?? null,
    visibility: opts.visibility ?? "firm",
    projectType: def?.name ?? "unknown",
    version: def?.version ?? "unknown",
    summary,
    files,
  };

  const res = await fetch(new URL("/v1/publish", opts.registryUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-firm-identity": payload.owner },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string; publishedVersion?: number; badges?: string[] };
  if (!res.ok) return { ok: false, message: `publish rejected: ${data.error ?? res.status}` };

  let attached = 0;
  for (const a of attachments) {
    const up = await fetch(
      new URL(`/v1/apps/${data.id}/${data.publishedVersion}/attach?path=${encodeURIComponent(a.rel)}`, opts.registryUrl),
      { method: "POST", headers: { "content-type": "application/octet-stream", "x-firm-identity": payload.owner }, body: fs.readFileSync(a.abs) },
    );
    if (up.ok) attached++;
    else console.error(`  attach failed for ${a.rel}: ${up.status}`);
  }
  return {
    ok: true,
    message:
      `published '${payload.name}' as ${data.id} v${data.publishedVersion}\n` +
      `  badges: ${(data.badges ?? []).join(", ") || "none"}\n` +
      `  gallery: ${new URL(`/v1/apps/${data.id}`, opts.registryUrl)}\n` +
      `  evidence files: ${Object.keys(files).length} inline + ${attached}/${attachments.length} attached`,
  };
}
