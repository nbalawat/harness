const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

// The canonical three-screen inventory for the mock corpus: the chat surface,
// the reviewable history, and the agent roster — each citing a requirement.
const reqs = inputs().requirements.data.requirements;
const cite = (...cats) => reqs.find((r) => cats.includes(r.category) && r.confidence !== "unknown")?.id ?? reqs[0].id;

writeJson("screen_inventory.json", {
  screens: ["chat", "history", "agents"],
  rationale: [
    { screen: "chat", because: `${cite("agent", "functional")}: analysts converse with the assistant` },
    { screen: "history", because: `${cite("data")}: conversations are stored and reviewable` },
    { screen: "agents", because: `${cite("ux", "functional")}: drafts route through visible agent approval` },
  ],
});
simulateCost(0.1, 8000, 900);
