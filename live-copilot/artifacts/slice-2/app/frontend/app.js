// chat-shell module (v0), extended with a History screen (slice: conversation-history).
// Uses textContent (never innerHTML) by policy — the security-scan node enforces this.

// ---- Chat ----------------------------------------------------------------
const messages = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");

// A stable per-tab conversation id, sent on every /chat call so replies land
// in the same conversation row (server also accepts a bare {"message": ...}).
const conversationId = "conv-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

function addMessage(role, text) {
  const li = document.createElement("li");
  li.className = "message " + role;
  li.textContent = text;
  messages.appendChild(li);
  messages.scrollTop = messages.scrollHeight;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMessage("user", text);
  input.value = "";
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversation_id: conversationId }),
    });
    const data = await response.json();
    addMessage("assistant", data.reply);
  } catch (err) {
    addMessage("error", "Request failed: " + err.message);
  }
});

// Agent-mode badge: always show what is answering (live model vs offline demo).
fetch("/agent/mode")
  .then((r) => r.json())
  .then((m) => {
    const badge = document.getElementById("agent-mode");
    if (!badge) return;
    badge.textContent = m.mode === "stub" ? "offline demo responder" : "live agent — " + m.detail;
    badge.title = m.detail;
  })
  .catch(() => {});

// ---- Tabs ------------------------------------------------------------------
const tabChat = document.getElementById("tab-chat");
const tabHistory = document.getElementById("tab-history");
const viewChat = document.getElementById("view-chat");
const viewHistory = document.getElementById("view-history");

function showView(name) {
  const isChat = name === "chat";
  viewChat.hidden = !isChat;
  viewHistory.hidden = isChat;
  tabChat.setAttribute("aria-selected", String(isChat));
  tabHistory.setAttribute("aria-selected", String(!isChat));
  if (!isChat) refreshConversations();
}

tabChat.addEventListener("click", () => showView("chat"));
tabHistory.addEventListener("click", () => showView("history"));

// ---- History (behind analyst sign-in) --------------------------------------
const signinForm = document.getElementById("signin");
const tokenInput = document.getElementById("token-input");
const signinStatus = document.getElementById("signin-status");
const historyBody = document.getElementById("history-body");
const conversationList = document.getElementById("conversation-list");
const conversationDetail = document.getElementById("conversation-detail");

let analystToken = window.localStorage.getItem("analystToken") || "";

function setSignedIn(signedIn) {
  historyBody.hidden = !signedIn;
  signinStatus.textContent = signedIn ? "Signed in." : "";
}

signinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  analystToken = value;
  window.localStorage.setItem("analystToken", analystToken);
  tokenInput.value = "";
  refreshConversations();
});

async function refreshConversations() {
  if (!analystToken) {
    setSignedIn(false);
    signinStatus.textContent = "Please sign in with a valid analyst account to view history.";
    return;
  }
  try {
    const response = await fetch("/conversations?token=" + encodeURIComponent(analystToken));
    if (response.status === 401) {
      setSignedIn(false);
      signinStatus.textContent = "Please sign in with a valid analyst account to view history.";
      return;
    }
    const data = await response.json();
    setSignedIn(true);
    renderConversationList(data.conversations || []);
  } catch (err) {
    signinStatus.textContent = "Request failed: " + err.message;
  }
}

function renderConversationList(conversations) {
  conversationList.textContent = "";
  if (conversations.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "No conversations yet.";
    conversationList.appendChild(li);
    return;
  }
  for (const conv of conversations) {
    const li = document.createElement("li");
    li.className = "conversation-item";
    const title = document.createElement("div");
    title.className = "conversation-title";
    title.textContent = conv.topic || conv.conversation_id;
    const meta = document.createElement("div");
    meta.className = "conversation-meta";
    meta.textContent = (conv.analyst_id || "unassigned") + " · " + (conv.created_at || "");
    li.appendChild(title);
    li.appendChild(meta);
    li.addEventListener("click", () => openConversation(conv.conversation_id));
    conversationList.appendChild(li);
  }
}

async function openConversation(conversationId) {
  try {
    const response = await fetch(
      "/conversations/" + encodeURIComponent(conversationId) + "?token=" + encodeURIComponent(analystToken)
    );
    if (response.status === 401) {
      setSignedIn(false);
      signinStatus.textContent = "Please sign in with a valid analyst account to view history.";
      return;
    }
    const data = await response.json();
    renderConversationDetail(data.messages || []);
  } catch (err) {
    conversationDetail.textContent = "";
    const p = document.createElement("p");
    p.textContent = "Request failed: " + err.message;
    conversationDetail.appendChild(p);
  }
}

function renderConversationDetail(msgs) {
  conversationDetail.textContent = "";
  if (msgs.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No messages in this conversation.";
    conversationDetail.appendChild(p);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "messages";
  for (const msg of msgs) {
    const li = document.createElement("li");
    li.className = "message " + msg.role;
    li.textContent = msg.content;
    ul.appendChild(li);
  }
  conversationDetail.appendChild(ul);
}

if (analystToken) refreshConversations();
