const { inputs, simulateCost, copyApp, fs } = require("./_lib.cjs");

const { app, agent_roster } = inputs();
copyApp(app.path);

fs.mkdirSync("app/agents/evals", { recursive: true });
fs.writeFileSync("app/agents/roster.json", JSON.stringify(agent_roster.data, null, 2));

// Eval cases derived from the roster's own criteria.
const agent = agent_roster.data.agents[0];
const cases = [
  { id: "greeting", input: "hello there", expect_contains: ["help"] },
  { id: "identity", input: "who am I talking to?", expect_contains: [agent.name] },
];
fs.writeFileSync("app/agents/evals/cases.json", JSON.stringify({ cases }, null, 2));
simulateCost(2.4, 70000, 15000);
