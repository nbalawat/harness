// Support Copilot — chat-shell module.
// Design: "Editorial Desk" (option-2). Backend: POST /chat, /api/{table}.
//
// SECURITY POLICY: every value that originates from the model or the API is
// written with textContent, or set as a form-control value. Markup-parsing
// sinks are never used anywhere in this file — the security-scan node
// enforces that, and the DOM is built exclusively with createElement.

const APP_NAME = "Support Copilot";
const ANALYST = "Support analyst (local)";
const DISCLOSURE_RE = /^\[Automated draft[^\]]*\]$/;
const NO_COVERAGE = "not covered by the product knowledge base";

const state = {
  records: [], // conversations, newest first
  drafts: [], // pending drafts awaiting a decision
  citations: [], // documents cited this session, by doc id
  gaps: [], // questions the corpus could not answer
};

// ---------------------------------------------------------------- utilities

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function byId(id) {
  return document.getElementById(id);
}

function shortDate(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function clockTime(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function titleFrom(question) {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 68 ? flat.slice(0, 65) + "…" : flat;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(path + " responded " + response.status);
  }
  return response.json();
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------ reply parsing

// The runtime returns one text blob: a disclosure line, body paragraphs, and
// an optional trailing block of "Sources: doc_id (title)" lines.
function parseReply(raw) {
  const blocks = String(raw == null ? "" : raw)
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  let disclosure = "";
  if (blocks.length && DISCLOSURE_RE.test(blocks[0])) {
    disclosure = blocks.shift();
  }

  const citations = [];
  if (blocks.length) {
    const lines = blocks[blocks.length - 1].split("\n").map((line) => line.trim());
    const allSources = lines.length > 0 && lines.every((line) => line.startsWith("Sources: "));
    if (allSources) {
      blocks.pop();
      lines.forEach((line) => {
        const rest = line.slice("Sources: ".length).trim();
        const match = /^(.+?)\s*\((.+)\)$/.exec(rest);
        citations.push(
          match ? { docId: match[1].trim(), title: match[2].trim() } : { docId: rest, title: "" }
        );
      });
    }
  }

  const covered = String(raw).indexOf(NO_COVERAGE) === -1;
  return {
    disclosure,
    paragraphs: blocks,
    citations,
    coverage: covered ? (citations.length ? "grounded" : "answered") : "uncovered",
    text: String(raw == null ? "" : raw),
  };
}

// ------------------------------------------------------------------ screens

function showScreen(id) {
  const screens = document.querySelectorAll(".screen");
  for (let i = 0; i < screens.length; i += 1) {
    screens[i].classList.toggle("active", screens[i].id === id);
  }
  const links = document.querySelectorAll("nav a");
  for (let i = 0; i < links.length; i += 1) {
    links[i].classList.toggle("is-on", links[i].dataset.screen === id);
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- the thread

function stamp(text, variant) {
  return el("span", variant ? "stamp " + variant : "stamp", text);
}

function citationList(citations) {
  const wrap = el("div", "cites");
  wrap.appendChild(el("b", null, citations.length === 1 ? "Source: " : "Sources: "));
  citations.forEach((cite, index) => {
    if (index > 0) wrap.appendChild(document.createTextNode(" · "));
    const label = cite.title ? cite.docId + " — " + cite.title : cite.docId;
    wrap.appendChild(document.createTextNode(label));
  });
  return wrap;
}

function addUserEntry(question, at) {
  const li = el("li", "entry user");
  const attrib = el("div", "attrib");
  attrib.appendChild(el("b", null, "Analyst"));
  attrib.appendChild(document.createTextNode(" · " + clockTime(at)));
  li.appendChild(attrib);
  li.appendChild(el("p", null, question));
  byId("thread").appendChild(li);
  return li;
}

function addAssistantEntry(reply, at) {
  const li = el("li", "entry assistant");

  const attrib = el("div", "attrib");
  attrib.appendChild(el("b", null, "Assistant"));
  attrib.appendChild(document.createTextNode(" · " + clockTime(at) + " "));
  attrib.appendChild(stamp("Automated draft"));
  if (reply.coverage === "uncovered") {
    attrib.appendChild(document.createTextNode(" "));
    attrib.appendChild(stamp("Outside the corpus", "warn"));
  }
  li.appendChild(attrib);

  const body = el("div", "body");
  if (reply.paragraphs.length === 0) {
    body.appendChild(el("p", null, reply.text));
  } else {
    reply.paragraphs.forEach((paragraph) => body.appendChild(el("p", null, paragraph)));
  }
  li.appendChild(body);

  if (reply.citations.length) li.appendChild(citationList(reply.citations));

  if (reply.disclosure) {
    const note = el("div", "cites");
    note.appendChild(document.createTextNode(reply.disclosure));
    li.appendChild(note);
  }

  const row = el("div", "row");
  const send = el("button", "btn-s", "Send to approvals");
  send.type = "button";
  send.addEventListener("click", () => {
    showScreen("draft-review");
  });
  row.appendChild(send);
  li.appendChild(row);

  byId("thread").appendChild(li);
  return li;
}

function addErrorEntry(message) {
  const li = el("li", "entry error");
  li.appendChild(el("div", "attrib", "Desk"));
  li.appendChild(el("p", null, message));
  byId("thread").appendChild(li);
}

// ------------------------------------------------------------- side margin

function renderCitedSources() {
  const host = byId("cited-sources");
  clear(host);
  if (!state.citations.length) {
    host.appendChild(el("div", "fnote empty", "No sources cited yet this session."));
    return;
  }
  state.citations.forEach((cite, index) => {
    const note = el("div", "fnote");
    note.appendChild(el("b", null, index + 1 + ". "));
    note.appendChild(document.createTextNode(cite.title ? cite.docId + " — " + cite.title : cite.docId));
    host.appendChild(note);
  });
}

function rememberCitations(citations) {
  citations.forEach((cite) => {
    const known = state.citations.some((existing) => existing.docId === cite.docId);
    if (!known) state.citations.push(cite);
  });
}

// -------------------------------------------------------------- approvals

function decisionVariant(decision) {
  if (!decision || decision === "pending") return "warn";
  if (decision === "rejected") return "dim";
  return "ok";
}

function decisionLabel(decision, wasEdited) {
  if (!decision || decision === "pending") return "Awaiting approval";
  if (decision === "rejected") return "Rejected";
  return wasEdited ? "Edited & approved" : "Approved";
}

function renderApprovals() {
  const host = byId("approval-list");
  clear(host);

  const pending = state.drafts.filter((draft) => draft.decision === "pending");
  byId("pending-count").textContent = "·" + pending.length;

  if (!state.drafts.length) {
    host.appendChild(
      el("p", "empty", "No drafts yet. Ask the assistant a question and its draft will arrive here for review.")
    );
    return;
  }

  state.drafts.forEach((draft) => host.appendChild(approvalSheet(draft)));
}

function approvalSheet(draft) {
  const sheet = el("div", "sheet");

  const head = el("div", "head");
  const heading = el("div");
  heading.appendChild(el("b", null, draft.title));
  if (draft.coverage === "uncovered") {
    heading.appendChild(el("span", "meta", " — no covering source"));
  }
  head.appendChild(heading);
  head.appendChild(stamp(decisionLabel(draft.decision, draft.wasEdited), decisionVariant(draft.decision)));
  sheet.appendChild(head);

  const textarea = el("textarea");
  textarea.value = draft.currentText; // form-control value: not parsed as markup
  textarea.setAttribute("aria-label", "Draft reply for " + draft.title);
  textarea.disabled = draft.decision !== "pending";
  sheet.appendChild(textarea);

  if (draft.citations.length) sheet.appendChild(citationList(draft.citations));

  if (draft.decision === "pending") {
    const actions = el("div", "actions");

    const approve = el("button", "btn-p", "Approve & send");
    approve.type = "button";
    approve.addEventListener("click", () => decide(draft, "approved", textarea.value));

    const saveEdit = el("button", "btn-s", "Save edit, then approve");
    saveEdit.type = "button";
    saveEdit.addEventListener("click", () => decide(draft, "approved", textarea.value, true));

    const reject = el("button", "btn-d", "Reject");
    reject.type = "button";
    reject.addEventListener("click", () => decide(draft, "rejected", textarea.value));

    actions.appendChild(approve);
    actions.appendChild(saveEdit);
    actions.appendChild(reject);
    sheet.appendChild(actions);
  }

  const ledger = el("div", "ledger");
  if (draft.decision === "pending") {
    ledger.appendChild(
      document.createTextNode(
        "No decision recorded yet. On approval the record keeps: approver, decision, timestamp, and whether you edited the text."
      )
    );
  } else {
    ledger.appendChild(document.createTextNode("Recorded — "));
    ledger.appendChild(el("b", null, decisionLabel(draft.decision, draft.wasEdited)));
    ledger.appendChild(
      document.createTextNode(
        " by " + draft.approver + ", " + new Date(draft.decidedAt).toLocaleString("en-GB") +
        ". Edited: " + (draft.wasEdited ? "yes" : "no") + "."
      )
    );
  }
  sheet.appendChild(ledger);

  return sheet;
}

async function decide(draft, decision, finalText, forceEdited) {
  const wasEdited = Boolean(forceEdited) || finalText.trim() !== draft.draftedText.trim();
  const decidedAt = new Date().toISOString();

  draft.decision = decision;
  draft.wasEdited = wasEdited;
  draft.currentText = finalText;
  draft.approver = ANALYST;
  draft.decidedAt = decidedAt;

  const record = state.records.find((item) => item.id === draft.conversationId);
  if (record) record.approval_status = decision;

  renderApprovals();
  renderRecords();

  try {
    await post("/api/approvals", {
      conversation_id: draft.conversationId,
      message_id: draft.messageId,
      decision: decision,
      approver: ANALYST,
      was_edited: wasEdited,
      drafted_text: draft.draftedText,
      final_text: finalText,
      note: draft.coverage === "uncovered" ? "Draft had no covering source." : "",
      decided_at: decidedAt,
    });
  } catch (err) {
    byId("record-note").textContent = "Decision shown locally but not persisted: " + err.message;
  }
}

// ----------------------------------------------------------------- record

function renderRecords() {
  const host = byId("record-list");
  clear(host);

  const query = byId("record-search").value.trim().toLowerCase();
  const visible = state.records.filter((record) => {
    if (!query) return true;
    return (
      String(record.title || "").toLowerCase().indexOf(query) !== -1 ||
      String(record.customer_question || "").toLowerCase().indexOf(query) !== -1
    );
  });

  if (!visible.length) {
    host.appendChild(
      el("p", "empty", state.records.length ? "No records match that search." : "The record is empty. Approved and rejected drafts are kept here.")
    );
    return;
  }

  visible.forEach((record) => {
    const draft = state.drafts.find((item) => item.conversationId === record.id);
    const row = el("div", "rec");
    row.appendChild(el("div", "date", shortDate(record.created_at)));

    const middle = el("div");
    middle.appendChild(el("h3", null, record.title));
    const citeCount = draft ? draft.citations.length : 0;
    middle.appendChild(
      el("p", null, citeCount === 1 ? "1 source cited" : citeCount + " sources cited")
    );
    middle.appendChild(el("p", null, record.customer_question));
    row.appendChild(middle);

    const end = el("div", "end");
    end.appendChild(
      stamp(
        decisionLabel(record.approval_status, draft && draft.wasEdited),
        decisionVariant(record.approval_status)
      )
    );

    if (record.approval_status === "pending") {
      const open = el("button", "btn-s", "Open");
      open.type = "button";
      open.addEventListener("click", () => showScreen("draft-review"));
      end.appendChild(open);
    } else if (draft && record.approval_status === "approved") {
      const reuse = el("button", "btn-s", "Reuse");
      reuse.type = "button";
      reuse.addEventListener("click", () => reuseDraft(draft));
      end.appendChild(reuse);
    }
    row.appendChild(end);

    host.appendChild(row);
  });
}

async function reuseDraft(source) {
  const createdAt = new Date().toISOString();
  const title = "Reuse — " + source.title;
  let conversation = { id: "local-" + state.records.length, created_at: createdAt };

  try {
    conversation = await post("/api/conversations", {
      title: title,
      customer_question: source.question,
      analyst: ANALYST,
      approval_status: "pending",
      created_at: createdAt,
      updated_at: createdAt,
    });
  } catch (err) {
    byId("record-note").textContent = "Fresh draft shown locally but not persisted: " + err.message;
  }

  const record = {
    id: conversation.id,
    title: title,
    customer_question: source.question,
    approval_status: "pending",
    created_at: createdAt,
  };
  state.records.unshift(record);

  state.drafts.unshift({
    conversationId: conversation.id,
    messageId: null,
    title: title,
    question: source.question,
    draftedText: source.currentText,
    currentText: source.currentText,
    citations: source.citations.slice(),
    coverage: source.coverage,
    decision: "pending",
    wasEdited: false,
    approver: null,
    decidedAt: null,
  });

  byId("record-note").textContent = "Copied. The approved wording is now waiting in Approvals as a fresh draft.";
  renderApprovals();
  renderRecords();
  showScreen("draft-review");
}

// -------------------------------------------------------------- knowledge

function renderSources(documents) {
  const host = byId("source-list");
  clear(host);

  const cards = documents && documents.length ? documents : null;
  if (cards) {
    cards.forEach((doc) => {
      const card = el("div", "card");
      card.appendChild(el("h3", null, doc.title || doc.source_path || "Untitled document"));
      const meta = [];
      if (doc.source_path) meta.push(doc.source_path);
      if (doc.ingested_at) meta.push("ingested " + shortDate(doc.ingested_at));
      card.appendChild(el("div", "meta", meta.join(" · ")));
      if (doc.content) card.appendChild(el("blockquote", null, doc.content));
      host.appendChild(card);
    });
  }

  if (state.citations.length) {
    const cited = el("div", "card");
    cited.appendChild(el("h3", null, "Cited this session"));
    cited.appendChild(
      el("div", "meta", state.citations.length + " document(s) the assistant drew on")
    );
    state.citations.forEach((cite) => {
      cited.appendChild(
        el("blockquote", null, cite.title ? cite.docId + " — " + cite.title : cite.docId)
      );
    });
    host.appendChild(cited);
  }

  if (!host.firstChild) {
    host.appendChild(
      el("p", "empty", "No documents ingested through the API yet. The assistant answers from the corpus bundled with the agent runtime; documents appear here as they are cited.")
    );
  }
}

function renderGaps() {
  const host = byId("gap-note");
  clear(host);
  if (!state.gaps.length) {
    host.appendChild(
      document.createTextNode("No gaps recorded yet. Questions with no covering passage are listed here as they occur.")
    );
    return;
  }
  state.gaps.forEach((question) => {
    const line = el("div", null, "— " + question);
    host.appendChild(line);
  });
}

// ------------------------------------------------------------------- ask

async function ask(question) {
  const askedAt = new Date().toISOString();
  addUserEntry(question, askedAt);

  const button = byId("ask");
  button.disabled = true;

  try {
    const data = await post("/chat", { message: question });
    const reply = parseReply(data.reply);
    const repliedAt = new Date().toISOString();

    addAssistantEntry(reply, repliedAt);
    rememberCitations(reply.citations);
    renderCitedSources();

    if (reply.coverage === "uncovered" && state.gaps.indexOf(question) === -1) {
      state.gaps.push(question);
      renderGaps();
    }

    await recordTurn(question, reply, askedAt, repliedAt);
  } catch (err) {
    addErrorEntry("Request failed: " + err.message);
  } finally {
    button.disabled = false;
  }
}

async function recordTurn(question, reply, askedAt, repliedAt) {
  const title = titleFrom(question);
  let conversation = { id: "local-" + state.records.length };
  let draftMessage = { id: null };

  try {
    conversation = await post("/api/conversations", {
      title: title,
      customer_question: question,
      analyst: ANALYST,
      approval_status: "pending",
      created_at: askedAt,
      updated_at: repliedAt,
    });

    await post("/api/messages", {
      conversation_id: conversation.id,
      role: "analyst",
      content: question,
      turn_index: 0,
      is_draft_reply: false,
      is_automated: false,
      coverage_status: "n/a",
      created_at: askedAt,
    });

    draftMessage = await post("/api/messages", {
      conversation_id: conversation.id,
      role: "assistant",
      content: reply.text,
      turn_index: 1,
      is_draft_reply: true,
      is_automated: true,
      coverage_status: reply.coverage,
      created_at: repliedAt,
    });

    for (const cite of reply.citations) {
      await post("/api/message_citations", {
        message_id: draftMessage.id,
        document_id: cite.docId,
        document_title: cite.title,
        locator: "",
        excerpt: "",
      });
    }
  } catch (err) {
    byId("record-note").textContent = "Draft shown locally but not persisted: " + err.message;
  }

  state.records.unshift({
    id: conversation.id,
    title: title,
    customer_question: question,
    approval_status: "pending",
    created_at: askedAt,
  });

  state.drafts.unshift({
    conversationId: conversation.id,
    messageId: draftMessage.id,
    title: title,
    question: question,
    draftedText: reply.text,
    currentText: reply.text,
    citations: reply.citations,
    coverage: reply.coverage,
    decision: "pending",
    wasEdited: false,
    approver: null,
    decidedAt: null,
  });

  renderApprovals();
  renderRecords();
}

// ------------------------------------------------------------------- boot

function wireEvents() {
  byId("nav").addEventListener("click", (event) => {
    const link = event.target.closest("[data-screen]");
    if (!link) return;
    event.preventDefault();
    showScreen(link.dataset.screen);
  });

  byId("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId("input");
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    ask(question);
  });

  byId("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      byId("composer").requestSubmit();
    }
  });

  byId("record-search").addEventListener("input", renderRecords);
}

async function loadExisting() {
  try {
    const conversations = await api("/api/conversations");
    state.records = conversations.slice().reverse();
  } catch (err) {
    state.records = [];
  }

  try {
    const approvals = await api("/api/approvals");
    approvals.forEach((approval) => {
      const record = state.records.find((item) => item.id === approval.conversation_id);
      if (record) record.approval_status = approval.decision;
    });
  } catch (err) {
    /* the record simply stays as loaded */
  }

  try {
    renderSources(await api("/api/knowledge_documents"));
  } catch (err) {
    renderSources([]);
  }
}

function boot() {
  document.title = APP_NAME;
  wireEvents();
  renderCitedSources();
  renderApprovals();
  renderRecords();
  renderGaps();
  loadExisting().then(renderRecords);
}

boot();
