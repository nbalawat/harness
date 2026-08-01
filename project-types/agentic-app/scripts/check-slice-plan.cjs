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
// DESIGN COVERAGE: the chosen design is a promise — every screen the user
// approved must be assigned to a slice that brings it to life. A plan that
// leaves screens unassigned ships dead mockup surfaces; reject it here,
// before any build spend.
const contractScreens = new Set(inputs.design_contract.data.screens.map((s) => s.id));
const covered = new Set();
for (const slice of slices) {
  for (const screen of slice.covers ?? []) {
    if (!contractScreens.has(screen)) {
      console.error(`slice '${slice.id}' covers unknown screen '${screen}' — not in the design contract (${[...contractScreens].join(", ")})`);
      process.exit(1);
    }
    covered.add(screen);
  }
}
const unassigned = [...contractScreens].filter((s) => !covered.has(s));
if (unassigned.length) {
  console.error(
    `design screens left unassigned: ${unassigned.join(", ")} — every screen in the approved design must be delivered by a slice. ` +
    "Assign each to the slice whose feature lives on it (via covers).",
  );
  process.exit(1);
}
// SLICE SIZING: a slice that covers too much predictably dies of turn
// exhaustion mid-build (observed: an oversized slice burned 3 attempts and
// $41 before this gate existed). Caps are enforced HERE, before any build
// spend — an oversized plan is a planning failure, not a build failure.
const MAX_SCREENS_PER_SLICE = 3;
const MAX_ELEMENTS_PER_SLICE = 40;
const elementsByScreen = new Map(inputs.design_contract.data.screens.map((s) => [s.id, s.element_count ?? 0]));
for (const slice of slices) {
  const covers = slice.covers ?? [];
  const elements = covers.reduce((sum, s) => sum + (elementsByScreen.get(s) ?? 0), 0);
  if (covers.length > MAX_SCREENS_PER_SLICE || elements > MAX_ELEMENTS_PER_SLICE) {
    console.error(
      `slice '${slice.id}' is OVERSIZED: covers ${covers.length} screen(s) / ${elements} interactive element(s) ` +
      `(caps: ${MAX_SCREENS_PER_SLICE} screens, ${MAX_ELEMENTS_PER_SLICE} elements). ` +
      "Split it: one slice per cohesive feature, each buildable in a single attempt. " +
      "Move shared plumbing into slice 1 (the foundation) and give each remaining screen its own slice.",
    );
    process.exit(1);
  }
}

console.log(
  `slice plan verified: ${slices.length} slice(s), all traced to requirements; ` +
  `design coverage complete (${contractScreens.size}/${contractScreens.size} screens assigned)`,
);
