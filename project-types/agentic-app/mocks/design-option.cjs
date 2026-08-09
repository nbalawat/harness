const { inputs, writeJson, simulateCost, fs } = require("./_lib.cjs");

// ONE design option per node — the three option nodes run CONCURRENTLY, each
// mocking a distinct direction. Shell layout matches the certified contract:
// canonical mount points + one container per inventory screen.
const input = inputs();
const option = input._params.data.option;
const appName = input.intake.data.project_name;
const SCREENS = input.screen_inventory.data.screens;
const uxReqs = input.requirements.data.requirements
  .filter((r) => ["ux", "functional"].includes(r.category) && r.confidence !== "unknown")
  .map((r) => r.id);

const CORE = () =>
  `<section id="screen-chat" class="screen">
    <ul id="messages" class="messages"></ul>
    <form id="composer" class="composer">
      <input id="input" type="text" placeholder="Ask ${appName}..." autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  </section>
  <section id="screen-history" class="screen"><h2>History</h2><div id="history-list"></div></section>
  <section id="screen-agents" class="screen"><h2>Agents</h2><div id="agents-list"></div></section>`;

// ONE enterprise theme — identical tokens for every layout. Neutral slate,
// system sans-serif, subtle borders + status chips: an operational console.
const ENTERPRISE_TOKENS = {
  "--primary": "#2f4a8a", "--on-primary": "#ffffff", "--bg": "#f5f7fa", "--fg": "#1a2230",
  "--surface": "#ffffff", "--surface-2": "#eef1f6", "--border": "#d7dde7", "--muted": "#5c6675",
  "--ok": "#2f9e6f", "--warn": "#c9820a", "--font": "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};
// Two LAYOUTS of that one theme — the choice is ergonomics, not restyling.
const THEMES = {
  // Layout A — left navigation rail + work canvas.
  1: {
    name: "Console — Left Rail",
    tokens: ENTERPRISE_TOKENS,
    html: () =>
      `<div class="shell"><aside class="rail"><div class="brand">${appName}</div><span id="agent-mode" class="agent-mode"></span><nav><a href="#screen-chat">Dashboard</a><a href="#screen-history">Work Queue</a><a href="#screen-agents">Agents</a></nav></aside><main class="canvas"><header class="topbar"><strong>Operations</strong><span class="chip">live</span></header>${CORE()}</main></div>`,
    css: `.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}.rail{background:var(--surface);border-right:1px solid var(--border);padding:1.1rem}.brand{font-weight:700;color:var(--primary);font-size:1.05rem}.rail nav{display:flex;flex-direction:column;gap:.25rem;margin-top:1.1rem}.rail a{color:var(--fg);text-decoration:none;padding:.5rem .7rem;border-radius:.45rem;font-size:.9rem}.rail a:hover{background:var(--surface-2)}.canvas{display:flex;flex-direction:column}.topbar{display:flex;align-items:center;gap:.6rem;padding:.8rem 1.5rem;border-bottom:1px solid var(--border);background:var(--surface)}.canvas>.screen{margin:1.25rem 1.5rem}`,
  },
  // Layout B — top bar + master/detail split.
  2: {
    name: "Console — Top Bar Split",
    tokens: ENTERPRISE_TOKENS,
    html: () =>
      `<header class="appbar"><div class="brand">${appName}</div><nav><a href="#screen-chat">Dashboard</a><a href="#screen-history">Work Queue</a><a href="#screen-agents">Agents</a></nav><span id="agent-mode" class="agent-mode"></span></header><main class="split"><section class="list"><h2>Instances</h2><div class="list-body"></div></section><section class="detail">${CORE()}</section></main>`,
    css: `.appbar{display:flex;align-items:center;gap:1.2rem;padding:.7rem 1.4rem;background:var(--surface);border-bottom:1px solid var(--border)}.appbar .brand{font-weight:700;color:var(--primary)}.appbar nav{display:flex;gap:.3rem}.appbar a{color:var(--fg);text-decoration:none;padding:.4rem .7rem;border-radius:.45rem;font-size:.9rem}.appbar a:hover{background:var(--surface-2)}.split{display:grid;grid-template-columns:300px 1fr;min-height:calc(100vh - 56px)}.list{border-right:1px solid var(--border);background:var(--surface);padding:1rem}.list h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.detail{padding:1.4rem;display:flex;flex-direction:column;gap:1rem}`,
  },
};

const BASE_CSS = `body{margin:0;font-family:var(--font);background:var(--bg);color:var(--fg)}.screen{background:var(--surface);border:1px solid var(--border);border-radius:.5rem;padding:1rem}.messages{list-style:none;margin:0 0 1rem;padding:0;min-height:8rem;display:flex;flex-direction:column;gap:.5rem}.message{padding:.5rem .75rem;border-radius:.5rem;max-width:80%}.message.user{background:var(--primary);color:var(--on-primary);align-self:flex-end}.message.assistant{background:var(--bg);border:1px solid var(--border)}.composer{display:flex;gap:.5rem}.composer input{flex:1;padding:.6rem;border:1px solid var(--border);border-radius:.4rem;background:var(--bg);color:var(--fg)}.composer button{padding:.6rem 1.1rem;border:0;border-radius:.4rem;background:var(--primary);color:var(--on-primary);cursor:pointer}.agent-mode{font-size:.75rem;opacity:.8}.agent-card{border:1px solid var(--border);border-radius:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--bg)}.chip{font-size:.68rem;font-weight:650;padding:.1rem .5rem;border-radius:999px;background:var(--surface-2);color:var(--muted)}`;

const theme = THEMES[option];
const dir = `designs/option-${option}`;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/tokens.css`, ":root {\n" + Object.entries(theme.tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n") + "\n}\n");
fs.writeFileSync(
  `${dir}/index.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appName} — ${theme.name}</title><link rel="stylesheet" href="tokens.css"><style>${BASE_CSS}${theme.css}</style></head><body>\n${theme.html()}\n<script src="app.js" defer></script>\n</body></html>`,
);
writeJson(`${dir}/option.json`, { name: theme.name, screens: SCREENS, addresses: uxReqs });
simulateCost(0.8, 12000, 5000);
