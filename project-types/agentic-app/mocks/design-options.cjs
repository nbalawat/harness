const { inputs, writeJson, simulateCost, fs } = require("./_lib.cjs");

const appName = inputs().intake.data.project_name;
const SCREENS = ["chat", "history", "settings"];
const THEMES = [
  { id: "option-1", name: "Calm Slate", tokens: { "--primary": "#3b5bdb", "--on-primary": "#ffffff", "--bg": "#f8f9fb", "--fg": "#1a1c1f", "--surface": "#eceef2", "--border": "#d5d9e0", "--font": "system-ui" } },
  { id: "option-2", name: "Forest", tokens: { "--primary": "#2b8a3e", "--on-primary": "#ffffff", "--bg": "#f6faf6", "--fg": "#14281a", "--surface": "#e6f0e8", "--border": "#cfdfd4", "--font": "Georgia, serif" } },
  { id: "option-3", name: "Ink", tokens: { "--primary": "#111111", "--on-primary": "#ffffff", "--bg": "#ffffff", "--fg": "#111111", "--surface": "#f1f1f1", "--border": "#dddddd", "--font": "ui-monospace, monospace" } },
];

const options = [];
for (const theme of THEMES) {
  const dir = `designs/${theme.id}`;
  fs.mkdirSync(dir, { recursive: true });
  const css = ":root {\n" + Object.entries(theme.tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n") + "\n}\n";
  fs.writeFileSync(`${dir}/tokens.css`, css);
  const sections = SCREENS.map((s) => `<section id="${s}"><h2>${s}</h2><p>${theme.name} rendering of the ${s} screen for ${appName}.</p></section>`).join("\n");
  fs.writeFileSync(
    `${dir}/index.html`,
    `<!doctype html><html><head><meta charset="utf-8"><title>${appName} — ${theme.name}</title><link rel="stylesheet" href="tokens.css"><style>body{font-family:var(--font);background:var(--bg);color:var(--fg);padding:2rem}section{background:var(--surface);border:1px solid var(--border);border-radius:.5rem;padding:1rem;margin-bottom:1rem}h2{color:var(--primary)}</style></head><body><h1>${appName} — ${theme.name}</h1>\n${sections}\n</body></html>`,
  );
  options.push({ id: theme.id, name: theme.name, screens: SCREENS, tokens_file: `${dir}/tokens.css`, preview_file: `${dir}/index.html` });
}

writeJson("designs.json", { options });
simulateCost(2.1, 30000, 14000);
