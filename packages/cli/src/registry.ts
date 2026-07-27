// Registry v1 (locked decision): an internal git repo with version tags
// `<name>@<version>`. Install clones the tag, verifies the certification
// record against the package's recomputed digest (tamper-proof), and stores
// the full tree (project type + certified modules) locally. `harness run
// name@version` then resolves from the store — consumers never edit the DAG.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { packageDigest } from "./certify.js";

export function storeRoot(): string {
  return process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
}

function storeDir(tag: string): string {
  return path.join(storeRoot(), "store", tag);
}

function indexFile(): string {
  return path.join(storeRoot(), "store", "index.json");
}

function readIndex(): Record<string, { installedAt: string; packageDigest: string; registry: string }> {
  return fs.existsSync(indexFile()) ? JSON.parse(fs.readFileSync(indexFile(), "utf8")) : {};
}

/** Locate the package dir inside a registry checkout (monorepo or single-package layout). */
function packageDirIn(root: string, name: string): string | null {
  for (const candidate of [path.join(root, "project-types", name), root]) {
    if (fs.existsSync(path.join(candidate, "dag.yaml"))) return candidate;
  }
  return null;
}

export function installedPackageDir(spec: string): string | null {
  const dir = storeDir(spec);
  if (!fs.existsSync(dir)) return null;
  return packageDirIn(dir, spec.split("@")[0]);
}

export function install(spec: string, registry: string): { tag: string; dir: string; digest: string } {
  const m = spec.match(/^([a-z0-9-]+)@([0-9][\w.-]*)$/);
  if (!m) throw new Error(`invalid spec '${spec}' — expected <name>@<version>`);
  const [, name] = m;

  // Pull exactly the signed tag — nothing floating.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "harness-install-"));
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", spec, "--config", "advice.detachedHead=false", registry, checkout],
    { encoding: "utf8", timeout: 120000 },
  );
  if (clone.status !== 0) {
    throw new Error(`could not fetch '${spec}' from ${registry}:\n${(clone.stderr ?? "").slice(-400)}`);
  }

  const pkgDir = packageDirIn(checkout, name);
  if (!pkgDir) throw new Error(`tag '${spec}' does not contain project type '${name}' (no dag.yaml found)`);

  // Certification gate: no record, or a digest mismatch, means the tag's
  // content is not what was certified — refuse to install.
  const certFile = path.join(pkgDir, "certification.json");
  if (!fs.existsSync(certFile)) throw new Error(`'${spec}' is not certified (missing certification.json) — refusing to install`);
  const cert = JSON.parse(fs.readFileSync(certFile, "utf8")) as { name: string; version: string; ok: boolean; packageDigest: string };
  if (!cert.ok) throw new Error(`'${spec}' certification record is not green — refusing to install`);
  const actual = packageDigest(pkgDir);
  if (actual !== cert.packageDigest) {
    throw new Error(
      `'${spec}' TAMPER CHECK FAILED: package digest ${actual.slice(0, 12)} != certified ${cert.packageDigest.slice(0, 12)}`,
    );
  }

  // Store the full tree — certified modules travel with the project type.
  fs.rmSync(path.join(checkout, ".git"), { recursive: true, force: true });
  const dest = storeDir(spec);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(checkout, dest, { recursive: true });
  fs.rmSync(checkout, { recursive: true, force: true });

  const index = readIndex();
  index[spec] = { installedAt: new Date().toISOString(), packageDigest: actual, registry };
  fs.writeFileSync(indexFile(), JSON.stringify(index, null, 2));
  return { tag: spec, dir: installedPackageDir(spec)!, digest: actual };
}

export function listInstalled(): { tag: string; installedAt: string; packageDigest: string; registry: string }[] {
  return Object.entries(readIndex()).map(([tag, meta]) => ({ tag, ...meta }));
}
