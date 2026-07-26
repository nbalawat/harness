const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const { corpus_index, intake } = inputs();
const claims = corpus_index.data.claims;

function categorize(text) {
  if (/secur|auth|access|permission/i.test(text)) return "security";
  if (/data|record|history|store/i.test(text)) return "data";
  if (/agent|assistant|answer|chat/i.test(text)) return "agent";
  if (/ui|interface|screen|design/i.test(text)) return "ux";
  return "functional";
}

const requirements = claims.map((c, i) => ({
  id: `REQ-${String(i + 1).padStart(3, "0")}`,
  text: c.text,
  category: categorize(c.text),
  confidence: "stated",
  provenance: { source: c.source, claim: c.id },
}));

// Inferred from the evidence (provenance points at the corpus, confidence marked).
requirements.push({
  id: `REQ-${String(requirements.length + 1).padStart(3, "0")}`,
  text: "Conversations and messages must be persisted for later review.",
  category: "data",
  confidence: "inferred",
  provenance: { source: corpus_index.data.sources[0].id },
});

// Gaps the corpus did NOT answer -> confidence unknown; these become the ONLY questions.
const corpusText = claims.map((c) => c.text).join(" ").toLowerCase();
if (!/auth|login|sso/.test(corpusText)) {
  requirements.push({
    id: `REQ-${String(requirements.length + 1).padStart(3, "0")}`,
    text: "Authentication requirements are unspecified.",
    category: "security",
    confidence: "unknown",
  });
}
if (!/retention|delete|purge/.test(corpusText)) {
  requirements.push({
    id: `REQ-${String(requirements.length + 1).padStart(3, "0")}`,
    text: "Data retention policy is unspecified.",
    category: "data",
    confidence: "unknown",
  });
}

writeJson("requirements.json", { requirements });
simulateCost(1.4, 38000, 5200);
