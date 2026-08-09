// Process Console — generic operator + domain UI over the workflow engine.
// textContent only (no innerHTML). Polls the selected running item so you
// watch each step execute.
let PROC = null, selected = null, poll = null;

const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const api = async (p, m, b) => (await fetch(p, { method: m || "GET", headers: b ? { "Content-Type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined })).json();

// The domain form is derived from the process's inputs; here we offer a couple
// of sensible fields (title + details) that map to any process's inputs.
function buildNewBox() {
  const box = document.getElementById("newbox");
  box.textContent = "";
  const title = el("input"); title.id = "f-title"; title.placeholder = "Work item — name / subject";
  const body = el("textarea"); body.id = "f-body"; body.placeholder = "Details the agents should work from…";
  const btn = el("button", null, "Start through the process"); btn.id = "f-start";
  btn.onclick = start;
  box.appendChild(title); box.appendChild(body); box.appendChild(btn);
}

async function start() {
  const title = document.getElementById("f-title").value.trim();
  const body = document.getElementById("f-body").value.trim();
  if (!title) return;
  const btn = document.getElementById("f-start");
  btn.disabled = true; btn.textContent = "Starting…";
  // pass generous input keys so any process's intake handler finds what it needs
  const inputs = { title, name: title, subject: title, details: body, description: body, body };
  const run = await api("/api/process/runs", "POST", { inputs });
  document.getElementById("f-title").value = ""; document.getElementById("f-body").value = "";
  btn.disabled = false; btn.textContent = "Start through the process";
  selected = run.run_id;
  await refresh();
  watch();
}

async function refresh() {
  const data = await api("/api/process/runs");
  const stats = document.getElementById("stats");
  stats.textContent = "";
  const s = (n, l) => { const d = el("div", "stat"); d.appendChild(el("b", null, String(n))); d.appendChild(el("span", null, l)); return d; };
  stats.appendChild(s(data.counts.running, "in flight"));
  stats.appendChild(s(data.counts.waiting, "need you"));
  stats.appendChild(s(data.counts.done, "completed"));

  const items = document.getElementById("items");
  items.textContent = "";
  if (!data.runs.length) { items.appendChild(el("div", "thinking", "No items yet — start one above.")); }
  for (const r of data.runs) {
    const it = el("div", "item" + (r.run_id === selected ? " sel" : ""));
    it.appendChild(el("div", "t", r.title));
    const meta = el("div", "meta");
    meta.appendChild(el("span", "pill " + r.status, r.status === "parked" ? "needs you" : r.status));
    const bar = el("div", "bar"); const i = el("i"); i.style.width = (100 * r.progress.done / r.progress.total) + "%"; bar.appendChild(i);
    meta.appendChild(bar);
    meta.appendChild(el("span", null, r.progress.done + "/" + r.progress.total));
    it.appendChild(meta);
    it.onclick = () => { selected = r.run_id; renderRun(); refresh(); watch(); };
    items.appendChild(it);
  }
  if (selected) renderRun();
}

async function renderRun() {
  const run = await api("/api/process/runs/" + encodeURIComponent(selected));
  const main = document.getElementById("main");
  main.textContent = "";

  const head = el("div", "runhead");
  head.appendChild(el("h2", null, run.title));
  head.appendChild(el("span", "pill " + run.status, run.status === "parked" ? "waiting on you" : run.status));
  main.appendChild(head);
  main.appendChild(el("div", "desc", PROC ? PROC.description : ""));

  const steps = el("div", "steps");
  for (const st of run.steps) {
    const s = el("div", "step " + st.state);
    const node = el("div", "node", st.state === "done" ? "✓" : st.state === "skipped" ? "–" : st.state === "waiting" ? "!" : "");
    s.appendChild(node);
    const top = el("div", "top");
    top.appendChild(el("span", "name", st.label));
    top.appendChild(el("span", "kind " + st.kind, st.kind_label));
    const stt = el("span", "status", st.state === "done" ? "done" : st.state === "waiting" ? "waiting for a decision" :
      st.state === "skipped" ? "skipped" : st.state === "pending" && run.status !== "completed" ? "queued" : "");
    top.appendChild(stt);
    s.appendChild(top);

    if (st.kind === "agent" && st.state === "pending" && (run.status === "running")) {
      const th = el("div", "out"); th.appendChild(el("div", "thinking", "agent working…")); s.appendChild(th);
    }
    if (st.state === "done" && (st.data || st.output)) {
      const out = el("div", "out");
      out.appendChild(el("div", "lbl", st.kind === "agent" ? "AI output — for review" : st.kind === "human" ? "Decision" : "Result"));
      if (st.data) {
        // structured REVIEW card: declared fields as rows, rationale + confidence surfaced
        const grid = el("div", "review");
        for (const [k, v] of Object.entries(st.data)) {
          if (k === "rationale" || k === "confidence") continue;
          const row = el("div", "field");
          row.appendChild(el("span", "fk", k.replace(/_/g, " ")));
          row.appendChild(el("span", "fv", typeof v === "object" ? JSON.stringify(v) : String(v)));
          grid.appendChild(row);
        }
        out.appendChild(grid);
        if (st.data.rationale) out.appendChild(el("div", "rationale", st.data.rationale));
        if (st.data.confidence) {
          const c = el("div", "confwrap");
          c.appendChild(el("span", "conf conf-" + st.data.confidence, "confidence: " + st.data.confidence));
          out.appendChild(c);
        }
      } else {
        out.appendChild(el("div", null, st.output));
      }
      s.appendChild(out);
    }
    if (st.state === "waiting" && st.question) {
      const dec = el("div", "decision");
      dec.appendChild(el("div", "q", st.question));
      const btns = el("div", "btns");
      const yes = el("button", "approve", "Approve"); yes.onclick = () => decide(true);
      const no = el("button", "decline", "Decline"); no.onclick = () => decide(false);
      btns.appendChild(yes); btns.appendChild(no);
      dec.appendChild(btns);
      s.appendChild(dec);
    }
    steps.appendChild(s);
  }
  main.appendChild(steps);
  if (run.status === "failed" && run.error) {
    const f = el("div", "out"); f.style.borderColor = "var(--fail)";
    f.appendChild(el("div", "lbl", "Process stopped")); f.appendChild(el("div", null, run.error));
    main.appendChild(f);
  }
}

async function decide(approve) {
  await api("/api/process/runs/" + encodeURIComponent(selected) + "/decide", "POST", { approve });
  await refresh(); watch();
}

// Poll while the selected item is still moving, so steps light up live.
function watch() {
  if (poll) clearInterval(poll);
  poll = setInterval(async () => {
    if (!selected) return;
    const run = await api("/api/process/runs/" + encodeURIComponent(selected));
    renderRun();
    if (run.status === "completed" || run.status === "failed") { clearInterval(poll); poll = null; refresh(); }
  }, 1500);
}

(async function init() {
  PROC = await api("/api/process");
  document.getElementById("procName").textContent = PROC.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  document.getElementById("procDesc").textContent = PROC.description;
  buildNewBox();
  await refresh();
  try { const m = await api("/agent/mode"); document.getElementById("mode").textContent = m.detail || m.mode; } catch {}
})();
