// Ask Docs — polished chat behavior. textContent only (no innerHTML) for safety.
const thread = document.getElementById("thread");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const empty = document.getElementById("empty");
const historyEl = document.getElementById("history");

const SUGGESTIONS = [
  "How much PTO do I get?",
  "What's the 401k match?",
  "Can I work from another country?",
  "When do performance reviews happen?",
  "What's the home-office stipend?",
];

const chips = document.getElementById("chips");
SUGGESTIONS.forEach((s) => {
  const c = document.createElement("button");
  c.className = "chip";
  c.type = "button";
  c.textContent = s;
  c.onclick = () => { input.value = s; ask(); };
  chips.appendChild(c);
});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function addMessage(role, text) {
  if (empty) empty.remove();
  const msg = el("div", "msg " + role);
  const av = el("div", "avatar", role === "user" ? "You" : "ND");
  const wrap = el("div");
  const bubble = el("div", "bubble", text);
  wrap.appendChild(bubble);
  msg.appendChild(av);
  msg.appendChild(wrap);
  thread.appendChild(msg);
  thread.scrollTop = thread.scrollHeight;
  return { bubble, wrap };
}

function addTyping() {
  if (empty) empty.remove();
  const msg = el("div", "msg assistant");
  msg.appendChild(el("div", "avatar", "ND"));
  const t = el("div", "typing");
  t.appendChild(el("span")); t.appendChild(el("span")); t.appendChild(el("span"));
  const wrap = el("div"); wrap.appendChild(t);
  msg.appendChild(wrap);
  thread.appendChild(msg);
  thread.scrollTop = thread.scrollHeight;
  return msg;
}

function addSources(wrap, sources) {
  if (!sources || !sources.length) return;
  const box = el("div", "sources");
  box.appendChild(el("span", "src", "Sources:"));
  sources.forEach((s) => {
    const chip = el("span", "src");
    const b = el("b", null, s.section);
    chip.appendChild(b);
    box.appendChild(chip);
  });
  wrap.appendChild(box);
}

let busy = false;
async function ask() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true; send.disabled = true;
  addMessage("user", text);
  input.value = ""; input.style.height = "auto";
  const typing = addTyping();
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    typing.remove();
    const { wrap } = addMessage("assistant", data.reply || "(no answer)");
    addSources(wrap, data.sources);
    loadHistory();
  } catch (e) {
    typing.remove();
    addMessage("assistant", "Something went wrong reaching the assistant. Please try again.");
  } finally {
    busy = false; send.disabled = false; input.focus();
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); ask(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});

fetch("/agent/mode").then((r) => r.json()).then((m) => {
  document.getElementById("mode").textContent = m.detail || m.mode;
}).catch(() => { document.getElementById("mode").textContent = "offline"; });

async function loadHistory() {
  try {
    const rows = await (await fetch("/api/conversations")).json();
    if (!Array.isArray(rows) || !rows.length) return;
    historyEl.textContent = "";
    rows.slice(0, 20).forEach((r) => {
      const item = el("div", "hist");
      item.appendChild(el("div", "q", r.question));
      item.appendChild(el("div", "a", r.answer));
      item.onclick = () => { input.value = r.question; input.focus(); };
      historyEl.appendChild(item);
    });
  } catch { /* ignore */ }
}
loadHistory();
input.focus();
