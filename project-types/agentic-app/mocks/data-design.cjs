const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const dataReqs = inputs().requirements.data.requirements
  .filter((r) => r.category === "data" && r.confidence !== "unknown")
  .map((r) => r.id);
writeJson("data_model.json", {
  tables: [
    { name: "conversations", access: "open", addresses: dataReqs, columns: [{ name: "user", type: "str" }, { name: "created_at", type: "str" }] },
    { name: "messages", access: "open", addresses: dataReqs, columns: [{ name: "conversation_id", type: "int" }, { name: "role", type: "str" }, { name: "content", type: "str" }] },
    // Deliberately closed: proves the default-closed generic API (negative acceptance hits it).
    { name: "approvals_log", addresses: dataReqs, columns: [{ name: "message", type: "str" }, { name: "approved_by", type: "str" }] },
  ],
});
simulateCost(0.5, 15000, 1200);
