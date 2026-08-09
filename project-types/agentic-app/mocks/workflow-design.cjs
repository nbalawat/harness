const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const { requirements } = inputs();
const reqs = requirements.data.requirements.filter((r) => r.confidence !== "unknown");
const byCat = (...cats) => {
  const ids = reqs.filter((r) => cats.includes(r.category)).map((r) => r.id);
  return ids.length > 0 ? ids : [reqs[0].id];
};

writeJson("workflows.json", {
  workflows: [
    {
      name: "reply-approval-process",
      description: "A question is validated, an agent drafts a grounded reply, an analyst approves it, and the decision is recorded.",
      addresses: byCat("agent", "functional", "ux"),
      nodes: [
        { id: "validate", kind: "deterministic", handler: "validate_question", output_schema: { required: ["ok", "topic"] } },
        { id: "worth_drafting", kind: "condition", path: "validate.ok", equals: true, on_false: "end" },
        { id: "draft", kind: "agent", prompt: "Draft a grounded reply about ${validate_topic}.",
          output_contract: ["answer", "sources_used"] },
        { id: "approve", kind: "human", question: "Approve this draft? ${draft.answer} (confidence: ${draft.confidence})" },
        { id: "record", kind: "deterministic", handler: "record_decision", output_schema: { required: ["stored"] } },
      ],
    },
  ],
});
simulateCost(0.9, 22000, 3500);
