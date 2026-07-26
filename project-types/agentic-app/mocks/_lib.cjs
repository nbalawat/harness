// Shared helpers for mock payloads. Mocks are high fidelity: they derive
// outputs from real inputs and simulate spend so certification replays
// exercise budget enforcement.
const fs = require("node:fs");
const path = require("node:path");

function inputs() {
  return JSON.parse(fs.readFileSync("inputs.json", "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function simulateCost(costUsd, inputTokens, outputTokens) {
  writeJson("cost.json", { costUsd, inputTokens, outputTokens, model: "mock" });
}

function copyApp(appInputPath) {
  fs.cpSync(appInputPath, "app", { recursive: true });
}

module.exports = { inputs, writeJson, simulateCost, copyApp, fs, path };
