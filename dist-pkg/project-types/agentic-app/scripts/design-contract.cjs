// The design contract: the chosen design IS a promise — this node turns it
// into an enforceable inventory. Every screen and interactive element in the
// approved index.html is extracted here; the slice plan must assign every
// screen to a slice, and design-coverage proves each one came alive.
// Deterministic (regex over the approved HTML — no LLM, no DOM).
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const chosen = inputs.design_choice.data.chosen_option; // e.g. "option-2"
const html = fs.readFileSync(path.join(inputs.designs_dir.path, chosen, "index.html"), "utf8");

// Screens: <section ... id="screen-x"> (the design's canonical surface unit).
const screens = [];
const screenRe = /<(section|div|main)\b[^>]*\bid="(screen-[a-z0-9-]+)"[^>]*>/g;
let m;
while ((m = screenRe.exec(html)) !== null) {
  const id = m[2];
  // The screen's body: from this tag to the next screen tag (or EOF). Crude
  // but deterministic — good enough to inventory interactive elements.
  const start = m.index;
  screenRe.lastIndex = m.index + m[0].length;
  const next = html.slice(start + m[0].length).search(/<(?:section|div|main)\b[^>]*\bid="screen-/);
  const body = next === -1 ? html.slice(start) : html.slice(start, start + m[0].length + next);

  const title =
    body.match(/<h[12][^>]*>([^<]{2,80})<\/h[12]>/)?.[1]?.trim() ??
    id.replace(/^screen-/, "").replace(/-/g, " ");

  const elements = [];
  const elRe = /<(button|input|select|textarea|form|a)\b([^>]*)>/g;
  let e;
  while ((e = elRe.exec(body)) !== null) {
    const attrs = e[2];
    if (/type="hidden"/.test(attrs)) continue;
    const elId = attrs.match(/\bid="([^"]+)"/)?.[1] ?? null;
    const label =
      attrs.match(/\b(?:placeholder|aria-label|name)="([^"]{1,60})"/)?.[1] ??
      (e[1] === "button" ? body.slice(e.index).match(/^<button[^>]*>([^<]{1,60})</)?.[1]?.trim() : null);
    elements.push({ tag: e[1], id: elId, label: label ?? null });
  }
  screens.push({ id, title, elements, element_count: elements.length });
}

if (!screens.length) {
  console.error("design contract: the chosen design has no screen-* sections — the design shell contract is broken");
  process.exit(1);
}

const contract = {
  chosen_option: chosen,
  screens,
  totals: {
    screens: screens.length,
    elements: screens.reduce((s, x) => s + x.element_count, 0),
  },
};
fs.writeFileSync("design_contract.json", JSON.stringify(contract, null, 2));
console.log(
  `design contract: ${contract.totals.screens} screen(s), ${contract.totals.elements} interactive element(s) — ` +
    screens.map((s) => s.id).join(", "),
);
