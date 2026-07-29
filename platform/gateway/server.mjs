#!/usr/bin/env node
// llm-gateway — the single choke point for model traffic (DF-2 in
// docs/DEPLOYMENT-GCP.md). Cloud Run-ready, zero dependencies.
//
// Sits between every harness install and the model backend (Vertex AI in
// prod, any Anthropic-compatible endpoint via UPSTREAM_URL). Enforces, in
// order: identity -> model allow-list -> per-identity daily budget quota ->
// forward (streaming passthrough) -> meter usage into the usage log.
//
//   POST /v1/messages           Anthropic Messages API passthrough
//   GET  /v1/usage?identity=..  metered spend (reconciles against journals)
//   GET  /healthz
//
// Config (env):
//   UPSTREAM_URL       model backend base URL (required)
//   UPSTREAM_API_KEY   forwarded as x-api-key when set (Vertex uses SA auth)
//   MODEL_ALLOWLIST    csv of allowed model prefixes (default: claude-)
//   QUOTA_USD_DAILY    per-identity daily spend cap (default 50)
//   USAGE_LOG          JSONL usage log path (BigQuery-bound rows in prod)
//   REQUIRE_IDENTITY   default 1; identity from IAP header or x-firm-identity
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

if (!UPSTREAM_URL) {
  console.error("UPSTREAM_URL is required");
  process.exit(1);
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

      // Forward. Streaming responses pass through byte-for-byte while we scan
      // SSE frames for the usage totals; non-streaming we parse directly.
      let upstream;
      try {
        upstream = await fetch(new URL("/v1/messages", UPSTREAM_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
            ...(UPSTREAM_API_KEY ? { "x-api-key": UPSTREAM_API_KEY } : {}),
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
