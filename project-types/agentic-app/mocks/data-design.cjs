const { writeJson, simulateCost } = require("./_lib.cjs");

writeJson("data_model.json", {
  tables: [
    { name: "conversations", columns: [{ name: "user", type: "str" }, { name: "created_at", type: "str" }] },
    { name: "messages", columns: [{ name: "conversation_id", type: "int" }, { name: "role", type: "str" }, { name: "content", type: "str" }] },
  ],
});
simulateCost(0.5, 15000, 1200);
