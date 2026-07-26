const { inputs, writeJson, simulateCost, fs, path } = require("./_lib.cjs");

const intake = inputs().intake.data;
fs.mkdirSync("corpus", { recursive: true });

const sources = [];
const claims = [];
let claimSeq = 1;

function harvest(sourceId, text) {
  // Claim heuristic: requirement-flavored sentences become provenance-tracked claims.
  for (const line of text.split(/\n+/)) {
    const clean = line.replace(/^[-*#>\s]+/, "").trim();
    if (clean.length > 20 && /\b(must|should|need|require|expect)\b/i.test(clean)) {
      claims.push({ id: `claim-${claimSeq++}`, text: clean, source: sourceId });
    }
  }
}

let dir = intake.documents_dir;
if (dir !== "none" && !path.isAbsolute(dir)) {
  dir = path.join(process.env.HARNESS_PROJECT_DIR, dir);
}
if (dir !== "none" && fs.existsSync(dir)) {
  for (const file of fs.readdirSync(dir).sort()) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    // Deterministic normalization: HTML tags stripped, everything else verbatim.
    const text = file.endsWith(".html") ? raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : raw;
    const id = `src-${sources.length + 1}`;
    const extracted = `corpus/${id}.md`;
    fs.writeFileSync(extracted, text);
    sources.push({ id, original: file, extracted, type: path.extname(file).slice(1) || "txt" });
    harvest(id, text);
  }
}
// The problem statement itself is always a source.
const psId = `src-${sources.length + 1}`;
fs.writeFileSync(`corpus/${psId}.md`, intake.problem_statement);
sources.push({ id: psId, original: "problem_statement", extracted: `corpus/${psId}.md`, type: "statement" });
harvest(psId, intake.problem_statement);

writeJson("corpus_index.json", { sources, claims });
simulateCost(0.9, 42000, 3100);
