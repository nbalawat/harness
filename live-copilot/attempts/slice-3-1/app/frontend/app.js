// chat-shell module (v0), extended with a History screen (slice: conversation-history)
// and a draft approve/edit/reject gate in the chat thread itself (slice: draft-approval).
// Uses textContent (never innerHTML) by policy — the security-scan node enforces this.

// ---- Analyst session (shared by chat drafts and History) -------------------
// The same seeded local-account token gates both stored history and approvals.
let analystToken = window.localStorage.getItem("analystToken") || "";

function setAnalystToken(value) {
  analystToken = value;
  if (value) {
    window.localStorage.setItem("analystToken", value);
  } else {
    window.localStorage.removeItem("analystToken");
  }
}

const analystSessionForm = document.getElementById("analyst-session");
const analystTokenInput = document.getElementById("analyst-token-input");
const analystSessionStatus = document.getElementById("analyst-session-status");

function renderAnalystSessionStatus() {
  analystSessionStatus.textContent = analystToken
    ? "Analyst token set — you can approve or reject drafts."
    : "Sign in with an analyst token to approve or reject drafts.";
}
renderAnalystSessionStatus();

analystSessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = analystTokenInput.value.trim();
  if (!value) return;
  setAnalystToken(value);
  analystTokenInput.value = "";
  renderAnalystSessionStatus();
});

// ---- Chat ----------------------------------------------------------------
const messages = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");

// A stable per-tab conversation id, sent on every /chat call so replies land
// in the same conversation row (server also accepts a bare {"message": ...}).
const conversationId = "conv-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

function addMessage(role, text, draft) {
  const li = document.createElement("li");
  li.className = "message " + role;
  const bubble = document.createElement("div");
  bubble.className = "message-text";
  bubble.textContent = text;
  li.appendChild(bubble);
  if (draft) {
    li.appendChild(renderDraftControls(draft));
  }
  messages.appendChild(li);
  messages.scrollTop = messages.scrollHeight;
}

// Every assistant reply is a draft, never a delivered answer: nothing counts as sent
// until the analyst approves (optionally after editing) or rejects it here.
function renderDraftControls(draft) {
  const wrap = document.createElement("div");
  wrap.className = "draft-controls";

  const status = document.createElement("p");
  status.className = "draft-status";
  status.textContent = "Draft status: " + draft.approval_state + ". Nothing is sent until you decide.";
  wrap.appendChild(status);

  const textarea = document.createElement("textarea");
  textarea.className = "draft-edit";
  textarea.value = draft.content;
  wrap.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "draft-actions";
  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.textContent = "Approve";
  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.textContent = "Reject";
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  wrap.appendChild(actions);

  async function decide(decision) {
    if (!analystToken) {
      status.textContent = "Please sign in with a valid analyst account to approve or reject drafts.";
      return;
    }
    try {
      const response = await fetch("/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: draft.conversation_id,
          decision: decision,
          content: decision === "approve" ? textarea.value : undefined,
          token: analystToken,
        }),
      });
      if (response.status === 401) {
        status.textContent = "Please sign in with a valid analyst account to approve or reject drafts.";
        return;
      }
      const data = await response.json();
      status.textContent = data.message || "Draft " + (data.draft && data.draft.approval_state) + ".";
      textarea.disabled = true;
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
    } catch (err) {
      status.textContent = "Request failed: " + err.message;
    }
  }

  approveBtn.addEventListener("click", () => decide("approve"));
  rejectBtn.addEventListener("click", () => decide("reject"));

  return wrap;
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
    addMessage("assistant", data.reply, data.draft);
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

function setSignedIn(signedIn) {
  historyBody.hidden = !signedIn;
  signinStatus.textContent = signedIn ? "Signed in." : "";
}

signinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  setAnalystToken(value);
  renderAnalystSessionStatus();
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
