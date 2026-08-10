#!/usr/bin/env node
// llm-gateway — the single choke point for model traffic (DF-2 in
// docs/DEPLOYMENT-GCP.md). Cloud Run-ready, zero dependencies.
//
// Sits between every harness install and the model backend (Vertex AI in
// prod, any Anthropic-compatible endpoint via UPSTREAM_URL). Enforces, in
// order: identity -> BYO credential resolve -> model allow-list -> per-identity
// daily budget quota -> forward (streaming passthrough) -> meter usage.
//
// BYO credentials (the whole point of the hosted model): each user registers
// their OWN Claude key/subscription once; the gateway forwards THEIR credential
// upstream so builds bill to their account. Build pods never see the key — only
// the gateway URL. Keys are write-only over the API and NEVER logged.
//
//   POST /v1/keys               register the caller's own key (identity-gated)
//   POST /v1/messages           Anthropic Messages API passthrough (uses caller's key)
//   GET  /v1/usage?identity=..  metered spend (reconciles against journals)
//   GET  /healthz
//
// Config (env):
//   UPSTREAM_URL       model backend base URL (required)
//   UPSTREAM_API_KEY   fallback credential when a user has none registered (dev only)
//   KEYS_JSON          {"<identity>":{"apiKey"|"oauthToken":"..."}} seed map (tests/dev)
//   KEYS_STORE         path for POST /v1/keys registrations (default ./gateway-keys.json, 0600)
//   MODEL_ALLOWLIST    csv of allowed model prefixes (default: claude-)
//   QUOTA_USD_DAILY    per-identity daily spend cap (default 50)
//   USAGE_LOG          JSONL usage log path (BigQuery-bound rows in prod)
//   REQUIRE_IDENTITY   default 1; identity from IAP header or x-firm-identity
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8081);
const UPSTREAM_URL = process.env.UPSTREAM_URL;
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY;
const ALLOWLIST = (process.env.MODEL_ALLOWLIST ?? "claude-").split(",").map((s) => s.trim()).filter(Boolean);
const QUOTA_USD_DAILY = Number(process.env.QUOTA_USD_DAILY ?? 50);
const USAGE_LOG = process.env.USAGE_LOG ?? path.join(process.cwd(), "gateway-usage.jsonl");
const REQUIRE_IDENTITY = process.env.REQUIRE_IDENTITY !== "0";
const KEYS_STORE = process.env.KEYS_STORE ?? path.join(process.cwd(), "gateway-keys.json");

if (!UPSTREAM_URL) {
  console.error("UPSTREAM_URL is required");
  process.exit(1);
}

// --- BYO credential store -------------------------------------------------
// In-memory cache identity -> {apiKey|oauthToken}. Backed by AWS Secrets Manager
// when SECRETS_MANAGER=1 (one secret per identity: <SECRETS_PREFIX><identity>),
// else a local 0600 file (dev). Raw keys are write-only over the API and NEVER
// logged. The gateway forwards them upstream; build pods never see them.
const SECRETS_MANAGER = process.env.SECRETS_MANAGER === "1";
const SECRETS_PREFIX = process.env.SECRETS_PREFIX ?? "harness/keys/";
const SECRETS_REGION = process.env.SECRETS_REGION ?? process.env.AWS_REGION ?? "us-east-1";
// identity -> [teams], so a build can fall back to its team's pooled key.
const TEAMS = process.env.TEAMS_JSON ? JSON.parse(process.env.TEAMS_JSON) : {};
const teamsOf = (identity) => TEAMS[identity] ?? [];
// A credential is bound to a "ref": a user (the identity) OR a group ("team/<team>").
const userRef = (identity) => identity;
const teamRef = (team) => `team/${team}`;
const KEYS = new Map(); // ref -> {apiKey|oauthToken}

/** Write a credential to AWS Secrets Manager (create or overwrite). Never logs the value. */
function smPut(ref, cred) {
  const name = SECRETS_PREFIX + ref;
  const val = JSON.stringify(cred);
  const put = spawnSync("aws", ["secretsmanager", "put-secret-value", "--region", SECRETS_REGION, "--secret-id", name, "--secret-string", val], { encoding: "utf8" });
  if (put.status !== 0) {
    const create = spawnSync("aws", ["secretsmanager", "create-secret", "--region", SECRETS_REGION, "--name", name, "--secret-string", val], { encoding: "utf8" });
    if (create.status !== 0) throw new Error(`secrets-manager write failed: ${String(create.stderr).slice(0, 160)}`);
  }
}

/** Read a credential from AWS Secrets Manager. Returns null if none. */
function smGet(ref) {
  const r = spawnSync("aws", ["secretsmanager", "get-secret-value", "--region", SECRETS_REGION, "--secret-id", SECRETS_PREFIX + ref, "--query", "SecretString", "--output", "text"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

/** Get a credential bound to a ref (user or team), cache-then-vault. */
function getCred(ref) {
  let cred = KEYS.get(ref);
  if (!cred && SECRETS_MANAGER) {
    cred = smGet(ref);
    if (cred) KEYS.set(ref, cred);
  }
  return cred ?? null;
}
function loadKeys() {
  try {
    if (process.env.KEYS_JSON) for (const [id, cred] of Object.entries(JSON.parse(process.env.KEYS_JSON))) KEYS.set(id, cred);
  } catch (e) {
    console.error(`KEYS_JSON parse error: ${String(e).slice(0, 120)}`); // never print the value
  }
  try {
    if (fs.existsSync(KEYS_STORE)) for (const [id, cred] of Object.entries(JSON.parse(fs.readFileSync(KEYS_STORE, "utf8")))) KEYS.set(id, cred);
  } catch (e) {
    console.error(`KEYS_STORE read error: ${String(e).slice(0, 120)}`);
  }
}
loadKeys();

/** Store a credential bound to a ref (a user identity or a "team/<team>" group). */
function saveKey(ref, cred) {
  KEYS.set(ref, cred);
  if (SECRETS_MANAGER) {
    smPut(ref, cred); // vault-backed: the raw key lives only in Secrets Manager
    return;
  }
  const all = Object.fromEntries(KEYS);
  fs.writeFileSync(KEYS_STORE, JSON.stringify(all), { mode: 0o600 }); // 0600: owner-only
  try {
    fs.chmodSync(KEYS_STORE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

const asHeaders = (cred) => (cred?.apiKey ? { "x-api-key": cred.apiKey } : cred?.oauthToken ? { authorization: `Bearer ${cred.oauthToken}` } : null);

/**
 * Resolve the forward-auth credential for a caller, in precedence order:
 *   1. the user's OWN key (bound to their identity), then
 *   2. a POOLED key bound to any team the user belongs to, then
 *   3. the shared dev fallback.
 * So a build uses your key if you have one, else your team's, else none (402).
 */
function resolveAuthHeaders(identity) {
  if (identity) {
    const own = asHeaders(getCred(userRef(identity)));
    if (own) return own;
    for (const team of teamsOf(identity)) {
      const pooled = asHeaders(getCred(teamRef(team)));
      if (pooled) return pooled;
    }
  }
  if (UPSTREAM_API_KEY) return { "x-api-key": UPSTREAM_API_KEY }; // dev/shared fallback
  return null;
}

// $/MTok planning prices; override with PRICES_JSON='{"claude-sonnet-5":{"in":3,"out":15}}'
const PRICES = Object.assign(
  {
    "claude-haiku-4-5": { in: 1, out: 5 },
    "claude-sonnet-5": { in: 3, out: 15 },
    "claude-opus-5": { in: 15, out: 75 },
  },
  process.env.PRICES_JSON ? JSON.parse(process.env.PRICES_JSON) : {},
);

function priceFor(model) {
  for (const [prefix, p] of Object.entries(PRICES)) if (model.startsWith(prefix)) return p;
  return { in: 15, out: 75 }; // unknown model: price like the most expensive
}

function identityOf(req) {
  return req.headers["x-goog-authenticated-user-email"] ?? req.headers["x-firm-identity"] ?? null;
}

function usageRows() {
  if (!fs.existsSync(USAGE_LOG)) return [];
  return fs.readFileSync(USAGE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function spentTodayUsd(identity) {
  const today = new Date().toISOString().slice(0, 10);
  return usageRows()
    .filter((r) => r.identity === identity && r.ts.slice(0, 10) === today)
    .reduce((s, r) => s + r.costUsd, 0);
}

function meter(identity, req, model, usage) {
  const p = priceFor(model);
  const inputTokens = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  const outputTokens = usage?.output_tokens ?? 0;
  const costUsd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  const row = {
    ts: new Date().toISOString(),
    identity,
    runId: req.headers["x-harness-run-id"] ?? null,
    nodeId: req.headers["x-harness-node-id"] ?? null,
    model,
    inputTokens,
    outputTokens,
    costUsd: Number(costUsd.toFixed(6)),
  };
  fs.appendFileSync(USAGE_LOG, JSON.stringify(row) + "\n");
  return row;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" || url.pathname === "/health") return json(res, 200, { ok: true, upstream: UPSTREAM_URL });

  if (url.pathname === "/v1/usage" && req.method === "GET") {
    const identity = url.searchParams.get("identity");
    const rows = usageRows().filter((r) => !identity || r.identity === identity);
    const costUsd = Number(rows.reduce((s, r) => s + r.costUsd, 0).toFixed(6));
    return json(res, 200, { requests: rows.length, costUsd, quotaUsdDaily: QUOTA_USD_DAILY, rows: rows.slice(-100) });
  }

  // Register the CALLER'S OWN Claude credential. Identity comes from the trusted
  // SSO/IAP header — a user can never set anyone else's key. The value is
  // stored write-only (0600) and NEVER echoed or logged.
  if (url.pathname === "/v1/keys" && req.method === "POST") {
    const identity = identityOf(req);
    if (!identity) return json(res, 401, { error: "identity required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const apiKey = typeof p.apiKey === "string" && p.apiKey.trim() ? p.apiKey.trim() : null;
      const oauthToken = typeof p.oauthToken === "string" && p.oauthToken.trim() ? p.oauthToken.trim() : null;
      if (!apiKey && !oauthToken) return json(res, 400, { error: "provide apiKey or oauthToken" });
      // Bind the credential to a USER (default) or a GROUP. A team/group key is a
      // shared pool; you may only register one for a team you belong to.
      let ref = userRef(identity);
      let boundTo = identity;
      if (p.scope === "team") {
        if (!p.team) return json(res, 400, { error: "team required for scope 'team'" });
        if (!teamsOf(identity).includes(p.team)) return json(res, 403, { error: `not a member of team '${p.team}'` });
        ref = teamRef(p.team);
        boundTo = `team:${p.team}`;
      }
      saveKey(ref, apiKey ? { apiKey } : { oauthToken });
      // Confirm registration WITHOUT returning the secret (last 4 only).
      const tail = (apiKey ?? oauthToken).slice(-4);
      return json(res, 200, { ok: true, boundTo, scope: p.scope === "team" ? "team" : "user", credential: apiKey ? "api-key" : "oauth", endsWith: tail });
    });
    return;
  }

  if (url.pathname === "/v1/messages" && req.method === "POST") {
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !identity) return json(res, 401, { error: "identity required" });

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const model = String(parsed.model ?? "");
      if (!ALLOWLIST.some((prefix) => model.startsWith(prefix))) {
        return json(res, 403, { error: `model '${model}' is not on the firm allow-list` });
      }
      const spent = spentTodayUsd(identity);
      if (spent >= QUOTA_USD_DAILY) {
        return json(res, 429, {
          error: `daily quota exhausted ($${spent.toFixed(2)} of $${QUOTA_USD_DAILY}) — ask your manager to raise the team pool`,
        });
      }

      // BYO: forward the CALLER'S OWN registered credential. No key on file for
      // this identity (and no dev fallback) -> 402, never someone else's key.
      const authHeaders = resolveAuthHeaders(identity);
      if (!authHeaders) {
        return json(res, 402, { error: "no Claude credential registered — run `harness login` to add your key" });
      }

      // Forward. Streaming responses pass through byte-for-byte while we scan
      // SSE frames for the usage totals; non-streaming we parse directly.
      let upstream;
      try {
        upstream = await fetch(new URL("/v1/messages", UPSTREAM_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
            ...authHeaders,
          },
          body,
        });
      } catch (e) {
        return json(res, 502, { error: `upstream unreachable: ${String(e).slice(0, 200)}` });
      }

      const contentType = upstream.headers.get("content-type") ?? "application/json";
      if (contentType.includes("text/event-stream")) {
        res.writeHead(upstream.status, { "content-type": contentType });
        const usage = {};
        let buffer = "";
        for await (const chunk of upstream.body) {
          res.write(chunk);
          buffer += Buffer.from(chunk).toString("utf8");
          // scan complete SSE data lines for usage objects
          for (const line of buffer.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const frame = JSON.parse(line.slice(5));
              if (frame.message?.usage) Object.assign(usage, frame.message.usage);
              if (frame.usage) Object.assign(usage, frame.usage);
            } catch {
              /* partial frame */
            }
          }
          const lastNewline = buffer.lastIndexOf("\n");
          if (lastNewline >= 0) buffer = buffer.slice(lastNewline + 1);
        }
        res.end();
        meter(identity, req, model, usage);
      } else {
        const text = await upstream.text();
        res.writeHead(upstream.status, { "content-type": contentType });
        res.end(text);
        if (upstream.ok) {
          try {
            meter(identity, req, model, JSON.parse(text).usage);
          } catch {
            /* unmeterable response shape — still delivered */
          }
        }
      }
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`llm-gateway on :${PORT} -> ${UPSTREAM_URL} (quota $${QUOTA_USD_DAILY}/day)`));
