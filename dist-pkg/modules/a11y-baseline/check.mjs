// a11y-baseline checker: static HTML accessibility floor.
import * as fs from "node:fs";
import * as path from "node:path";

export function checkHtml(html) {
  const violations = [];
  if (/<html(?![^>]*lang=)/i.test(html)) violations.push("html element missing lang attribute");
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (/type="(hidden|submit)"/i.test(tag)) continue;
    if (!/placeholder=|aria-label=|aria-labelledby=/i.test(tag)) {
      const id = (tag.match(/id="([^"]+)"/i) || [])[1];
      const hasLabel = id && new RegExp('<label[^>]*for="' + id + '"', "i").test(html);
      if (!hasLabel) violations.push("input without label/placeholder/aria-label: " + tag.slice(0, 60));
    }
  }
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    if (!m[1].replace(/<[^>]+>/g, "").trim() && !/aria-label=/i.test(m[0])) {
      violations.push("button with no accessible text: " + m[0].slice(0, 60));
    }
  }
  return violations;
}

const dir = process.argv[2];
if (dir) {
  const allowMissing = process.argv.includes("--allow-missing-html");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".html")) : [];
  if (files.length === 0 && !allowMissing) {
    console.error("no html files found in " + dir);
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    for (const v of checkHtml(fs.readFileSync(path.join(dir, f), "utf8"))) {
      console.error(f + ": " + v);
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
}
