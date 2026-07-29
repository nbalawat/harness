const { inputs, writeJson, simulateCost, fs } = require("./_lib.cjs");

const { intake, requirements } = inputs();
const appName = intake.data.project_name;
const uxReqs = requirements.data.requirements
  .filter((r) => ["ux", "functional"].includes(r.category) && r.confidence !== "unknown")
  .map((r) => r.id);
const SCREENS = ["chat", "history", "agents"];

// Each option is a BUILDABLE application shell (the chosen one ships as the
// app's frontend) with canonical mount points behavior binds to:
//   #agent-mode, #screen-chat > #messages + #composer > #input,
//   #screen-history > #history-list, #screen-agents > #agents-list
// The three layouts are structurally distinct on purpose — sidebar console,
// editorial column, terminal — so design-select is a real choice.
const CORE = (extraComposer = "") =>
  `<section id="screen-chat" class="screen">
    <ul id="messages" class="messages"></ul>
    <form id="composer" class="composer">
      <input id="input" type="text" placeholder="Ask ${appName}..." autocomplete="off" />
      ${extraComposer}<button type="submit">Send</button>
    </form>
  </section>
  <section id="screen-history" class="screen"><h2>History</h2><div id="history-list"></div></section>
  <section id="screen-agents" class="screen"><h2>Agents</h2><div id="agents-list"></div></section>`;

const THEMES = [
  {
    id: "option-1",
    name: "Calm Slate",
    tokens: { "--primary": "#3b5bdb", "--on-primary": "#ffffff", "--bg": "#f8f9fb", "--fg": "#1a1c1f", "--surface": "#eceef2", "--border": "#d5d9e0", "--font": "system-ui" },
    html: () =>
      `<div class="shell"><aside class="side"><h1>${appName}</h1><span id="agent-mode" class="agent-mode"></span><nav><a href="#screen-chat">Chat</a><a href="#screen-history">History</a><a href="#screen-agents">Agents</a></nav></aside><main class="main">${CORE()}</main></div>`,
    css: `.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}.side{background:var(--surface);border-right:1px solid var(--border);padding:1.25rem}.side nav{display:flex;flex-direction:column;gap:.5rem;margin-top:1rem}.side a{color:var(--fg);text-decoration:none;padding:.4rem .6rem;border-radius:.4rem}.side a:hover{background:var(--bg)}.main{padding:1.5rem;display:flex;flex-direction:column;gap:1rem}h1{font-size:1.1rem;color:var(--primary)}`,
  },
  {
    id: "option-2",
    name: "Forest",
    tokens: { "--primary": "#2b8a3e", "--on-primary": "#ffffff", "--bg": "#f6faf6", "--fg": "#14281a", "--surface": "#e6f0e8", "--border": "#cfdfd4", "--font": "Georgia, serif" },
    html: () =>
      `<header class="masthead"><h1>${appName}</h1><p class="dek">An editorial reading of every conversation.</p><span id="agent-mode" class="agent-mode"></span></header><main class="column">${CORE()}</main>`,
    css: `.masthead{border-bottom:3px double var(--border);padding:2rem 1rem 1rem;text-align:center}.masthead h1{font-size:2rem;letter-spacing:.02em}.dek{color:var(--primary);font-style:italic}.column{max-width:46rem;margin:0 auto;padding:1.5rem 1rem;display:flex;flex-direction:column;gap:1.25rem}`,
  },
  {
    id: "option-3",
    name: "Ink",
    tokens: { "--primary": "#111111", "--on-primary": "#ffffff", "--bg": "#ffffff", "--fg": "#111111", "--surface": "#f1f1f1", "--border": "#dddddd", "--font": "ui-monospace, monospace" },
    html: () =>
      `<header class="bar"><h1>${appName}</h1><span id="agent-mode" class="agent-mode"></span></header><main class="cols">${CORE()}</main>`,
    css: `.bar{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid var(--fg);padding:.75rem 1rem}.bar h1{font-size:1rem;text-transform:uppercase;letter-spacing:.12em}.cols{padding:1rem;display:grid;gap:1rem}`,
  },
];

const BASE_CSS = `body{margin:0;font-family:var(--font);background:var(--bg);color:var(--fg)}.screen{background:var(--surface);border:1px solid var(--border);border-radius:.5rem;padding:1rem}.messages{list-style:none;margin:0 0 1rem;padding:0;min-height:8rem;display:flex;flex-direction:column;gap:.5rem}.message{padding:.5rem .75rem;border-radius:.5rem;max-width:80%}.message.user{background:var(--primary);color:var(--on-primary);align-self:flex-end}.message.assistant{background:var(--bg);border:1px solid var(--border)}.composer{display:flex;gap:.5rem}.composer input{flex:1;padding:.6rem;border:1px solid var(--border);border-radius:.4rem;background:var(--bg);color:var(--fg)}.composer button{padding:.6rem 1.1rem;border:0;border-radius:.4rem;background:var(--primary);color:var(--on-primary);cursor:pointer}.agent-mode{font-size:.75rem;opacity:.8}.agent-card{border:1px solid var(--border);border-radius:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--bg)}`;

const options = [];
for (const theme of THEMES) {
  const dir = `designs/${theme.id}`;
  fs.mkdirSync(dir, { recursive: true });
  const css = ":root {\n" + Object.entries(theme.tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n") + "\n}\n";
  fs.writeFileSync(`${dir}/tokens.css`, css);
  fs.writeFileSync(
    `${dir}/index.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appName} — ${theme.name}</title><link rel="stylesheet" href="tokens.css"><style>${BASE_CSS}${theme.css}</style></head><body>\n${theme.html()}\n<script src="app.js" defer></script>\n</body></html>`,
  );
  options.push({ id: theme.id, name: theme.name, screens: SCREENS, addresses: uxReqs, tokens_file: `${dir}/tokens.css`, preview_file: `${dir}/index.html` });
}

writeJson("designs.json", { options });
simulateCost(2.1, 30000, 14000);
