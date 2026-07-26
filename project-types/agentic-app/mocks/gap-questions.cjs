const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const reqs = inputs().requirements.data.requirements;
const DEFAULTS = {
  security: { prompt: "Does the app need user authentication for the pilot?", default: "no", why: "Decides whether the auth module is composed now or deferred." },
  data: { prompt: "How long should conversation data be retained?", default: "90 days", why: "Sets the retention config in the data layer and governance report." },
};

const questions = reqs
  .filter((r) => r.confidence === "unknown")
  .map((r) => ({
    id: r.id.toLowerCase(),
    prompt: (DEFAULTS[r.category] || { prompt: `Clarify: ${r.text}` }).prompt,
    default: (DEFAULTS[r.category] || { default: "use your best judgment" }).default,
    why: (DEFAULTS[r.category] || { why: `Resolves ${r.id}, which downstream design depends on.` }).why,
  }));

writeJson("gaps.json", { questions });
simulateCost(0.3, 9000, 900);
