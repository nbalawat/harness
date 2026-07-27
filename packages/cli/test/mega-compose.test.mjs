// The combination proof: EVERY app-kind module composed into one application,
// booted, and exercised across module boundaries. Per-module certification
// proves isolation; this proves coexistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULES = path.join(REPO_ROOT, "modules");
const BASE = path.join(REPO_ROOT, "project-types/agentic-app/templates/base");

test("mega-compose: all app modules coexist in one booted application", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mega-"));
  fs.cpSync(BASE, app, { recursive: true });

  const composed = [];
  for (const name of fs.readdirSync(MODULES).sort()) {
    const manifestPath = path.join(MODULES, name, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parse(fs.readFileSync(manifestPath, "utf8"));
    if ((manifest.kind ?? "app") !== "app") continue;
    const compose = path.join(MODULES, name, "compose");
    if (fs.existsSync(compose)) {
      fs.cpSync(compose, app, { recursive: true });
      composed.push(name);
    }
  }
  assert.ok(composed.length >= 55, `expected the full app catalog, composed ${composed.length}`);

  fs.writeFileSync(
    path.join(app, "backend", "models.py"),
    'TABLES = {\n    "conversations": ["id", "user"],\n    "messages": ["id", "conversation_id", "content"],\n    "approvals": ["id", "message", "approved"],\n}\n',
  );
  fs.mkdirSync(path.join(app, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "agents", "roster.json"),
    JSON.stringify({ agents: [{ name: "Mega Assistant", role: "Answers during the mega composition proof.", tools: [], eval_criteria: ["responds"], addresses: ["REQ-001"] }] }),
  );
  const mainPy = path.join(app, "backend", "main.py");
  fs.writeFileSync(mainPy, fs.readFileSync(mainPy, "utf8").replaceAll("__APP_NAME__", "Mega App"));

  // Cross-module journey: identity -> roles -> workflow -> audit -> ops surfaces.
  fs.mkdirSync(path.join(app, "backend", "mega_tests"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "backend", "mega_tests", "test_mega.py"),
    `import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
os.environ["APP_ALLOW_SEED"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_boot_and_base_endpoints_survive_full_composition():
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/agents").json()["agents"][0]["name"] == "Mega Assistant"
    assert client.post("/chat", json={"message": "hello"}).json()["reply"]


def test_cross_module_journey():
    import rbac

    # auth-basic -> rbac -> approval-flow -> audit-log, one flow.
    rbac.grant("root", "admin")
    token = client.post("/auth/login", json={"username": "root"}).json()["token"]
    granted = client.post("/admin/roles", json={"user": "ana", "role": "approver"}, headers={"Authorization": f"Bearer {token}"})
    assert granted.status_code == 200

    item = client.post("/workflow/submissions", json={"kind": "reply", "payload": {"text": "d"}, "by": "agent"}).json()
    assert client.post(f"/workflow/submissions/{item['id']}/approve", json={"actor": "ana"}).status_code == 200

    events = [e["event"] for e in client.get("/audit").json()]
    assert "workflow.approved" in events

    # blob-store + file-upload + export + search + seed coexist.
    assert client.put("/uploads/notes.txt", content=b"mega").status_code == 200
    assert client.get("/files/notes.txt").content == b"mega"
    assert client.post("/admin/seed").json()["seeded"] is True
    assert client.get("/export/conversations.csv").text.startswith("id,")


def test_ops_surfaces_from_observability_modules():
    body = client.get("/healthz").json()
    assert body["components"]["store"]["ok"] and body["components"]["agent_engine"]["ok"]
    metrics = client.get("/metrics").text
    assert "http_requests_total" in metrics
    headers = client.get("/health").headers
    assert headers["x-frame-options"] == "DENY", "csp-headers active alongside other middlewares"
`,
  );

  const pytest = spawnSync(
    "uv",
    ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "python", "-m", "pytest", "mega_tests", "-q"],
    { cwd: path.join(app, "backend"), encoding: "utf8", timeout: 300000, env: { ...process.env, HARNESS_AGENT_MODE: "stub" } },
  );
  assert.equal(pytest.status, 0, `mega app failed:\n${pytest.stdout}\n${pytest.stderr}`);
  fs.rmSync(app, { recursive: true, force: true });
});
