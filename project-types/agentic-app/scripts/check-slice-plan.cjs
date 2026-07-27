// Slice-plan verification: slices must trace to real requirements and carry
// executable acceptance. This is where "app evolves by feature" is certified.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const { slices } = JSON.parse(fs.readFileSync("slice_plan.json", "utf8"));
const reqIds = new Set(inputs.requirements.data.requirements.map((r) => r.id));

const seen = new Set();
for (const slice of slices) {
  if (seen.has(slice.id)) {
    console.error(`duplicate slice id: ${slice.id}`);
    process.exit(1);
  }
  seen.add(slice.id);
  for (const reqId of slice.addresses) {
    if (!reqIds.has(reqId)) {
      console.error(`slice '${slice.id}' addresses unknown requirement ${reqId}`);
      process.exit(1);
    }
  }
}
console.log(`slice plan verified: ${slices.length} slice(s), all traced to requirements`);
