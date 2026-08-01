// Triage board — textContent only (no innerHTML), for safety.
const boardEl = document.getElementById("board");
const statsEl = document.getElementById("stats");
const form = document.getElementById("newForm");
const titleEl = document.getElementById("t-title");
const bodyEl = document.getElementById("t-body");
const submit = document.getElementById("t-submit");

const NEXT = { "New": "In progress", "In progress": "Resolved", "Resolved": "New" };
const PREV = { "In progress": "New", "Resolved": "In progress" };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function card(t) {
  const c = el("div", "card");
  const top = el("div", "top");
  const pri = el("span", "badge pri-" + t.priority, t.priority);
  const cat = el("span", "cat", t.category);
  cat.dataset.c = t.category;
  top.appendChild(pri);
  top.appendChild(cat);
  c.appendChild(top);
  c.appendChild(el("h3", null, t.title));
  c.appendChild(el("div", "body", t.body));

  const ai = el("div", "ai");
  ai.appendChild(el("div", "lbl", "AI triage · " + (t.triaged_by || "auto")));
  if (t.summary) ai.appendChild(el("div", null, t.summary));
  if (t.suggested_reply) {
    const r = el("div", null, "Suggested reply: " + t.suggested_reply);
    r.style.color = "var(--muted)";
    r.style.marginTop = ".3rem";
    ai.appendChild(r);
  }
  c.appendChild(ai);

  const actions = el("div", "actions");
  if (PREV[t.status]) {
    const back = el("button", null, "← " + PREV[t.status]);
    back.onclick = () => move(t.id, PREV[t.status]);
    actions.appendChild(back);
  }
  if (t.status !== "Resolved") {
    const fwd = el("button", null, NEXT[t.status] + " →");
    fwd.onclick = () => move(t.id, NEXT[t.status]);
    actions.appendChild(fwd);
  }
  c.appendChild(actions);
  return c;
}

async function move(id, status) {
  await api(`/api/tickets/${id}/status`, "POST", { status });
  render();
}

async function render() {
  const data = await api("/api/board");
  statsEl.textContent = "";
  const stat = (n, label) => {
    const s = el("div", "stat");
    s.appendChild(el("b", null, String(n)));
    s.appendChild(el("span", null, label));
    return s;
  };
  statsEl.appendChild(stat(data.counts.open, "open"));
  statsEl.appendChild(stat(data.counts.urgent, "urgent"));
  statsEl.appendChild(stat(data.counts.total, "total"));

  boardEl.textContent = "";
  for (const col of data.columns) {
    const c = el("div", "col");
    const h = el("h2");
    h.appendChild(el("span", null, col.status));
    h.appendChild(el("span", null, String(col.tickets.length)));
    c.appendChild(h);
    if (!col.tickets.length) c.appendChild(el("div", "empty", "No tickets"));
    for (const t of col.tickets) c.appendChild(card(t));
    boardEl.appendChild(c);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleEl.value.trim(), body = bodyEl.value.trim();
  if (title.length < 3 || !body) return;
  submit.disabled = true;
  submit.textContent = "Triaging…";
  try {
    await api("/api/tickets", "POST", { title, body });
    titleEl.value = ""; bodyEl.value = "";
    await render();
  } finally {
    submit.disabled = false;
    submit.textContent = "Add & auto-triage";
  }
});

fetch("/agent/mode").then((r) => r.json()).then((m) => {
  document.getElementById("mode").textContent = m.detail || m.mode;
}).catch(() => {});

render();
