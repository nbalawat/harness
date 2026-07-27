// chat-shell module (v1): pure BEHAVIOR. The markup it binds to comes from the
// chosen design option (copied in verbatim at scaffold), via canonical ids:
//   #messages #composer #input #agent-mode #history-list #agents-list
// Uses textContent (never innerHTML) by policy — the security-scan node enforces this.
const messages = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");

function addMessage(role, text) {
  const li = document.createElement("li");
  li.className = "message " + role;
  li.textContent = text;
  messages.appendChild(li);
  messages.scrollTop = messages.scrollHeight;
}

// The conversation thread keeps its id across turns so follow-ups stay in
// context (REQ-002); the server mints one on the first turn if none is sent.
let conversationId = null;

function renderCitations(citations) {
  const list = document.getElementById("citations");
  if (!list || !Array.isArray(citations) || !citations.length) return;
  for (const citation of citations) {
    const item = document.createElement("p");
    const title = citation.source_title || "source";
    item.textContent = citation.source_passage ? `${title} — ${citation.source_passage}` : title;
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------
// Approval gate (REQ-009, REQ-012, REQ-013, REQ-018): every drafted turn
// waits here for an analyst's decision. Approve as written, amend the
// wording and approve, or reject — nothing leaves the application until
// that decision is recorded, and the approved text is only readable back
// out (via /conversations/{id}/approved-reply) once approved.
// ---------------------------------------------------------------------
const reviewQueue = document.getElementById("review-queue");
const approveBtn = document.getElementById("approve-btn");
const editBtn = document.getElementById("edit-btn");
const rejectBtn = document.getElementById("reject-btn");

// Every drafted turn, newest first; each carries its own decision state so
// the queue keeps a full record even after the decision bar moves on.
const drafts = [];
let selectedDraftId = null;

function getAnalystId() {
  const remembered = window.localStorage ? window.localStorage.getItem("analystId") : null;
  const answer = window.prompt("Analyst id (for the approval record):", remembered || "");
  if (!answer) return null;
  try {
    window.localStorage.setItem("analystId", answer);
  } catch (err) {
    /* localStorage unavailable — still usable for this decision */
  }
  return answer;
}

function renderReviewQueue() {
  if (!reviewQueue) return;
  reviewQueue.textContent = "";
  for (const draft of drafts) {
    const card = document.createElement("div");
    card.className = "draft-card" + (draft.messageId === selectedDraftId ? " selected" : "");
    card.dataset.messageId = String(draft.messageId);

    const question = document.createElement("p");
    question.className = "smallcaps";
    question.textContent = "Analyst asked — " + draft.conversationId;
    card.appendChild(question);

    const text = document.createElement("p");
    text.textContent = draft.question;
    card.appendChild(text);

    const draftText = document.createElement("p");
    draftText.textContent = draft.draft;
    card.appendChild(draftText);

    const status = document.createElement("p");
    status.className = "smallcaps";
    if (!draft.decision) {
      status.textContent = "Awaiting analyst decision — select and choose Approve, Amend & approve, or Reject.";
    } else if (draft.decision === "approve") {
      status.textContent =
        "Approved by " + draft.analystId + " at " + draft.approvedAt + (draft.wasEdited ? " (wording amended)" : "");
    } else {
      status.textContent = "Rejected by " + draft.analystId + " at " + draft.approvedAt;
    }
    card.appendChild(status);

    if (draft.decision === "approve" && draft.approvedReply) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn";
      copyBtn.textContent = "Copy approved reply";
      copyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(draft.approvedReply).catch(() => {});
        }
      });
      card.appendChild(copyBtn);
    }

    card.addEventListener("click", () => {
      selectedDraftId = draft.messageId;
      renderReviewQueue();
    });
    reviewQueue.appendChild(card);
  }
}

function findSelectedDraft() {
  return drafts.find((d) => d.messageId === selectedDraftId) || null;
}

async function decide(decision, editedDraft) {
  const draft = findSelectedDraft();
  if (!draft) {
    window.alert("Select a draft in the queue first.");
    return;
  }
  if (draft.decision) {
    window.alert("This draft already has a recorded decision.");
    return;
  }
  const analystId = getAnalystId();
  if (!analystId) return;
  try {
    const response = await fetch("/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: draft.conversationId,
        decision,
        analyst_id: analystId,
        edited_draft: editedDraft || undefined,
      }),
    });
    const data = await response.json();
    draft.decision = data.decision;
    draft.analystId = data.analyst_id;
    draft.wasEdited = data.was_edited;
    draft.approvedAt = data.approved_at;
    if (decision === "approve") {
      const approved = await fetch(`/conversations/${encodeURIComponent(draft.conversationId)}/approved-reply`);
      if (approved.ok) {
        draft.approvedReply = (await approved.json()).reply;
      }
    }
    renderReviewQueue();
    renderHistoryList();
  } catch (err) {
    window.alert("Decision failed: " + err.message);
  }
}

if (approveBtn) approveBtn.addEventListener("click", () => decide("approve"));
if (rejectBtn) rejectBtn.addEventListener("click", () => decide("reject"));
if (editBtn) {
  editBtn.addEventListener("click", () => {
    const draft = findSelectedDraft();
    if (!draft) {
      window.alert("Select a draft in the queue first.");
      return;
    }
    const edited = window.prompt("Amend the draft's wording before approving:", draft.draft);
    if (edited === null) return;
    decide("approve", edited);
  });
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
    conversationId = data.conversation_id || conversationId;
    addMessage("assistant", data.reply);
    renderCitations(data.citations);
    drafts.unshift({
      messageId: data.message_id,
      conversationId: data.conversation_id,
      question: text,
      draft: data.reply,
      decision: null,
      analystId: null,
      wasEdited: false,
      approvedAt: null,
      approvedReply: null,
    });
    selectedDraftId = data.message_id;
    renderReviewQueue();
    renderHistoryList();
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

// Agents panel: the app tells you which agents it runs, their roles, tools,
// and guardrails — no hidden machinery.
fetch("/agents")
  .then((r) => r.json())
  .then((roster) => {
    const list = document.getElementById("agents-list");
    if (!list || !Array.isArray(roster.agents)) return;
    for (const agent of roster.agents) {
      const card = document.createElement("div");
      card.className = "agent-card";
      const name = document.createElement("strong");
      name.textContent = agent.name;
      const role = document.createElement("p");
      role.textContent = agent.role || "";
      const tools = document.createElement("p");
      tools.className = "agent-tools";
      const allowed = (agent.tools || []).join(", ") || "none";
      const denied = (agent.denied_tools || []).join(", ");
      tools.textContent = "tools: " + allowed + (denied ? " · denied: " + denied : "");
      card.appendChild(name);
      card.appendChild(role);
      card.appendChild(tools);
      if (Array.isArray(agent.eval_criteria) && agent.eval_criteria.length) {
        const evals = document.createElement("p");
        evals.className = "agent-evals";
        evals.textContent = "held to: " + agent.eval_criteria.join("; ");
        card.appendChild(evals);
      }
      list.appendChild(card);
    }
  })
  .catch(() => {});

// ---------------------------------------------------------------------
// History (REQ-004, REQ-005, REQ-014, REQ-016, REQ-019): every conversation
// persists past the session and stays reviewable — the file lists all of
// them and opening one shows the full record: the analyst's question, the
// assistant's draft, the citations it used, and the approval decision with
// who decided, when, and whether the draft was edited. Nothing here is
// purged automatically (REQ-014); this single flat list is sized for one
// team on one local instance (REQ-016), and no per-analyst login gates it
// (REQ-019 leaves that unspecified for v1).
// ---------------------------------------------------------------------
const historyList = document.getElementById("history-list");

function formatDecision(approval) {
  if (!approval || !approval.decision) return "Awaiting analyst decision.";
  if (approval.decision === "approve") {
    return (
      "Approved by " +
      approval.analyst_id +
      " at " +
      approval.approved_at +
      (approval.was_edited ? " (wording amended)" : "")
    );
  }
  return "Rejected by " + approval.analyst_id + " at " + approval.approved_at;
}

async function renderHistoryDetail(container, conversationId) {
  container.textContent = "";
  try {
    const response = await fetch(`/conversations/${encodeURIComponent(conversationId)}`);
    if (!response.ok) {
      container.textContent = "Could not open this conversation.";
      return;
    }
    const record = await response.json();
    for (const message of record.messages || []) {
      const question = document.createElement("p");
      question.textContent = "Asked: " + message.analyst_question;
      container.appendChild(question);

      const draft = document.createElement("p");
      draft.textContent = message.assistant_draft;
      container.appendChild(draft);

      for (const citation of message.citations || []) {
        const source = document.createElement("p");
        source.className = "smallcaps";
        source.textContent = "Source — " + citation.source_title;
        container.appendChild(source);
      }
    }
    const decision = document.createElement("p");
    decision.className = "smallcaps";
    decision.textContent = formatDecision(record.approval);
    container.appendChild(decision);
  } catch (err) {
    container.textContent = "Could not open this conversation: " + err.message;
  }
}

async function renderHistoryList() {
  if (!historyList) return;
  let conversations;
  try {
    const response = await fetch("/conversations");
    if (!response.ok) return;
    conversations = await response.json();
  } catch (err) {
    return;
  }
  if (!Array.isArray(conversations)) return;
  historyList.textContent = "";
  for (const conversation of conversations) {
    const item = document.createElement("div");
    item.className = "history-item";

    const header = document.createElement("p");
    header.className = "smallcaps";
    header.style.cursor = "pointer";
    header.textContent = conversation.conversation_id + " — " + conversation.created_at;
    item.appendChild(header);

    const subject = document.createElement("p");
    subject.textContent = conversation.subject || "";
    item.appendChild(subject);

    const detail = document.createElement("div");
    detail.className = "history-detail";
    detail.style.display = "none";
    item.appendChild(detail);

    header.addEventListener("click", async () => {
      const isOpen = detail.style.display !== "none";
      detail.style.display = isOpen ? "none" : "block";
      if (!isOpen) await renderHistoryDetail(detail, conversation.conversation_id);
    });

    historyList.appendChild(item);
  }
}

renderHistoryList();

// ---------------------------------------------------------------------
// History search & reuse (REQ-006, REQ-011, REQ-013): find past *approved*
// conversations by keyword and reuse a good answer as the starting draft in
// the current thread, with a prompt to re-verify it is still accurate — an
// unapproved or rejected precedent can never be reused (the server 409s
// that attempt), so only genuine approved history is ever offered back.
// ---------------------------------------------------------------------
const historySearchInput = document.getElementById("history-search");
const historySearchBtn = document.getElementById("history-search-btn");
const searchResults = document.getElementById("search-results");

function renderSearchResults(data) {
  if (!searchResults) return;
  searchResults.textContent = "";
  if (!data.matches || !data.matches.length) {
    const empty = document.createElement("p");
    empty.className = "smallcaps";
    empty.textContent = data.message || "No matching prior conversation.";
    searchResults.appendChild(empty);
    return;
  }
  for (const match of data.matches) {
    const item = document.createElement("div");
    item.className = "history-item search-result";

    const header = document.createElement("p");
    header.className = "smallcaps";
    header.textContent =
      match.conversation_id +
      " — approved by " + match.analyst_id + " at " + match.approved_at +
      (match.was_edited ? " (wording amended)" : "");
    item.appendChild(header);

    if (match.subject) {
      const subject = document.createElement("p");
      subject.textContent = match.subject;
      item.appendChild(subject);
    }

    const reuseBtn = document.createElement("button");
    reuseBtn.type = "button";
    reuseBtn.className = "btn";
    reuseBtn.textContent = "Reuse as starting draft";
    reuseBtn.addEventListener("click", () => reusePrecedent(match.conversation_id));
    item.appendChild(reuseBtn);

    searchResults.appendChild(item);
  }
}

async function runHistorySearch() {
  if (!historySearchInput || !searchResults) return;
  const q = historySearchInput.value.trim();
  if (!q) {
    searchResults.textContent = "";
    return;
  }
  try {
    const response = await fetch(`/history/search?q=${encodeURIComponent(q)}`);
    const data = await response.json();
    renderSearchResults(data);
  } catch (err) {
    searchResults.textContent = "";
    const error = document.createElement("p");
    error.className = "smallcaps";
    error.textContent = "Search failed: " + err.message;
    searchResults.appendChild(error);
  }
}

async function reusePrecedent(sourceConversationId) {
  const targetConversationId = conversationId || `conv-${Math.random().toString(36).slice(2, 14)}`;
  try {
    const response = await fetch("/history/reuse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_conversation_id: sourceConversationId,
        conversation_id: targetConversationId,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      window.alert(data.detail || "Only approved conversations can be reused as a precedent.");
      return;
    }
    conversationId = data.conversation_id;
    window.location.hash = "#screen-chat";
    addMessage("assistant", data.reply);
    renderCitations(data.citations);
    drafts.unshift({
      messageId: data.message_id,
      conversationId: data.conversation_id,
      question: "Reused precedent from " + sourceConversationId,
      draft: data.reply,
      decision: null,
      analystId: null,
      wasEdited: false,
      approvedAt: null,
      approvedReply: null,
    });
    selectedDraftId = data.message_id;
    renderReviewQueue();
    renderHistoryList();
  } catch (err) {
    window.alert("Reuse failed: " + err.message);
  }
}

if (historySearchBtn) historySearchBtn.addEventListener("click", runHistorySearch);
if (historySearchInput) {
  historySearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runHistorySearch();
    }
  });
}
