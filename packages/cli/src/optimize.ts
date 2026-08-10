// `harness optimize` — L0 prompt optimization, certification-gated by design.
//
// The GEPA/DSPy family evolves prompts by reflecting on failures. The danger is
// overfitting to the eval — so this command NEVER accepts a candidate prompt on
// its score alone. A candidate is accepted only if, after swapping it in, the
// project type still `harness certify`s (held-in golden scenarios stay
// byte-identical AND the held-out scenario stays anchored). Certification is the
// external, reality-anchored evaluator the doc insists must sit outside the loop.
//
//   harness optimize <project-type> --node <id> --candidates <dir>
//
// <dir> holds candidate prompt files (e.g. slice.v2.md, slice.v3.md). For each,
// it backs up the node's current prompt, swaps the candidate in, runs certify,
// and records PASS/FAIL. It restores the original at the end and applies nothing —
// it prints which candidates are safe to adopt. A human makes the final swap.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjectType } from "@harness/runner";

interface Candidate {
  file: string;
  certifies: boolean;
  detail: string;
}

export async function optimize(
  ptDir: string,
  opts: { node?: string; candidates?: string; heldout?: boolean },
): Promise<number> {
  ptDir = path.resolve(ptDir);
  if (!opts.node || !opts.candidates) {
    console.error("usage: harness optimize <project-type> --node <id> --candidates <dir>");
    return 1;
  }
  const def = loadProjectType(ptDir);
  const node = def.nodes.find((n) => n.id === opts.node);
  if (!node || node.kind !== "agent" || !node.prompt) {
    console.error(`optimize: '${opts.node}' is not an agent node with a prompt in ${path.basename(ptDir)}`);
    return 1;
  }
  const promptPath = path.join(ptDir, node.prompt);
  if (!fs.existsSync(promptPath)) {
    console.error(`optimize: prompt file not found: ${promptPath}`);
    return 1;
  }
  const candDir = path.resolve(opts.candidates);
  const files = fs.existsSync(candDir) ? fs.readdirSync(candDir).filter((f) => f.endsWith(".md")).sort() : [];
  if (files.length === 0) {
    console.error(`optimize: no candidate .md prompts in ${candDir}`);
    return 1;
  }

  const original = fs.readFileSync(promptPath, "utf8");
  const cliEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), "index.js");
  const runCertify = (): { ok: boolean; detail: string } => {
    // Certify structurally (no --update) — held-in goldens must stay byte-identical.
    // The held-out anchor is checked in the same pass (certify reports HELD-OUT
    // REGRESSION separately); we surface either as a FAIL.
    const r = spawnSync("node", [cliEntry, "certify", ptDir], { encoding: "utf8", env: process.env, timeout: 600000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const ok = r.status === 0 && /CERTIFIED/.test(out) && !/NOT CERTIFIED/.test(out);
    const drift = out.match(/PROBLEM:[^\n]*/g);
    return { ok, detail: ok ? "certified (held-in + held-out anchored)" : (drift ? drift[0].slice(0, 160) : "did not certify") };
  };

  const results: Candidate[] = [];
  try {
    for (const f of files) {
      const candidate = fs.readFileSync(path.join(candDir, f), "utf8");
      fs.writeFileSync(promptPath, candidate); // swap the candidate in
      const { ok, detail } = runCertify();
      results.push({ file: f, certifies: ok, detail });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${f}  — ${detail}`);
    }
  } finally {
    fs.writeFileSync(promptPath, original); // always restore; apply nothing
  }

  const safe = results.filter((r) => r.certifies).map((r) => r.file);
  console.log("");
  if (safe.length === 0) {
    console.log(
      `optimize: 0 of ${results.length} candidate prompt(s) for '${opts.node}' pass certification — ` +
        "none are safe to adopt (each broke a golden or the held-out anchor). Original prompt restored, nothing changed.",
    );
  } else {
    console.log(
      `optimize: ${safe.length} of ${results.length} candidate(s) for '${opts.node}' CERTIFY (structure + held-out intact): ` +
        safe.join(", ") +
        `.\nThese are safe to adopt — a human makes the final swap, then re-runs the live eval to confirm the quality gain. ` +
        "The optimizer never grades itself; certification is the anchor.",
    );
  }
  return 0;
}
