const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const reqs = inputs().requirements.data.requirements.filter((r) => r.confidence !== "unknown");
const byCat = (...cats) => {
  const ids = reqs.filter((r) => cats.includes(r.category)).map((r) => r.id);
  return ids.length > 0 ? ids : [reqs[0].id];
};

writeJson("slice_plan.json", {
  slices: [
    {
      id: "core-chat",
      covers: ["screen-chat"],
      name: "Core chat",
      story: "An analyst asks the assistant a question and gets an answer end to end.",
      addresses: byCat("agent", "functional"),
      acceptance: [
        { method: "GET", path: "/health", expect_contains: ["ok"] },
        { method: "POST", path: "/chat", body: { message: "hello" }, expect_contains: ["help"] },
      ],
    },
    {
      id: "conversation-history",
      covers: ["screen-history"],
      name: "Conversation history",
      story: "Conversations are stored and an analyst can review past ones.",
      addresses: byCat("data"),
      acceptance: [
        { method: "POST", path: "/api/conversations", body: { user: "analyst-1" }, expect_status: 200 },
        { method: "GET", path: "/api/conversations", expect_contains: ["analyst-1"] },
      ],
    },
    {
      id: "reply-approval",
      covers: ["screen-agents"],
      name: "Reply approval",
      story: "An analyst approves an assistant draft before it is used.",
      addresses: byCat("ux", "functional"),
      acceptance: [
        { method: "POST", path: "/approvals", body: { message: "draft reply" }, expect_contains: ["approved"] },
      ],
    },
  ],
});
simulateCost(0.7, 20000, 3000);
