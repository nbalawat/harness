// Local mirror of scripts/design-check.cjs, run against the artifacts in cwd.
const fs = require("node:fs");
const path = require("node:path");

const { options } = JSON.parse(fs.readFileSync("designs.json", "utf8"));
const designsDir = path.resolve("designs");
let fail = 0;
const bad = (m) => { console.error("FAIL: " + m); fail++; };

if (options.length < 3 || options.length > 4) bad(`expected 3-4 options, got ${options.length}`);

const reference = JSON.stringify([...options[0].screens].sort());
for (const option of options) {
  if (JSON.stringify([...option.screens].sort()) !== reference) bad(`${option.id} covers different screens`);
  if (!/^option-[1-4]$/.test(option.id)) bad(`${option.id} bad id pattern`);
  for (const k of ["id", "name", "screens", "tokens_file", "preview_file", "addresses"]) {
    if (!(k in option)) bad(`${option.id} missing key ${k}`);
  }
  for (const key of ["tokens_file", "preview_file"]) {
    const abs = path.join(designsDir, option[key].replace(/^designs\//, ""));
    if (!fs.existsSync(abs)) bad(`${option.id} missing file: ${option[key]}`);
  }
  const htmlPath = path.join(designsDir, option.preview_file.replace(/^designs\//, ""));
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, "utf8");
  for (const id of ["agent-mode", "screen-chat", "messages", "composer", "input"]) {
    if (!html.includes('id="' + id + '"')) bad(`${option.id} missing id="${id}"`);
  }
  for (const screen of option.screens) {
    if (!html.includes('id="screen-' + screen + '"')) bad(`${option.id} missing id="screen-${screen}"`);
  }
  // extra binding contract used by chat-shell's app.js + our declared screens
  for (const id of ["history-list", "agents-list", "approval-queue"]) {
    if (!html.includes('id="' + id + '"')) bad(`${option.id} missing id="${id}"`);
  }
  if (!html.includes('href="tokens.css"')) bad(`${option.id} does not link tokens.css`);
  if (!html.includes("Support Copilot")) bad(`${option.id} missing app name in markup`);
  if (!html.includes("app.js")) bad(`${option.id} missing app.js script tag`);
  // JS-populated containers must ship empty
  for (const id of ["messages", "history-list", "agents-list"]) {
    const re = new RegExp('id="' + id + '"[^>]*>\\s*<\\/');
    if (!re.test(html)) bad(`${option.id} container #${id} is not empty in markup`);
  }
  const tokensPath = path.join(designsDir, option.tokens_file.replace(/^designs\//, ""));
  if (fs.existsSync(tokensPath)) {
    const css = fs.readFileSync(tokensPath, "utf8");
    for (const t of ["--primary", "--on-primary", "--bg", "--fg", "--surface", "--border", "--font"]) {
      if (!new RegExp("\\" + t + "\\s*:").test(css)) bad(`${option.id} tokens.css missing ${t}`);
    }
  }
  // classes app.js generates must be styled somewhere in the shell
  for (const cls of ["message", "agent-card", "agent-tools", "agent-evals", "history-item"]) {
    if (!html.includes("." + cls)) bad(`${option.id} does not style .${cls}`);
  }
}
if (fail) { console.error(`\n${fail} problem(s)`); process.exit(1); }
console.log(`${options.length} comparable, buildable design options verified`);
