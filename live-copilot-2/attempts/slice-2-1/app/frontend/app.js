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

// History panel (if the design ships one and persistence is composed).
fetch("/api/conversations")
  .then((r) => (r.ok ? r.json() : null))
  .then((rows) => {
    const list = document.getElementById("history-list");
    if (!list || !Array.isArray(rows)) return;
    for (const row of rows.slice(-20)) {
      const item = document.createElement("div");
      item.className = "history-item";
      item.textContent = typeof row === "string" ? row : JSON.stringify(row);
      list.appendChild(item);
    }
  })
  .catch(() => {});
