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
      body: JSON.stringify({ message: text }),
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

// ============================================================================
// SESSION (auth-basic, extended for role-assigned accounts — REQ-001)
// Identity comes from POST /api/auth/login; every deal-scoped call below
// carries the resulting user_id explicitly rather than inventing its own
// token scheme. Session is cached in localStorage only for demo convenience.
// ============================================================================
const Session = {
  KEY: "ucc_session",
  get() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || "null");
    } catch (err) {
      return null;
    }
  },
  set(session) {
    localStorage.setItem(this.KEY, JSON.stringify(session));
  },
};

const ROLE_LABEL = {
  relationship_manager: "Relationship Manager",
  credit_analyst: "Credit Analyst",
  senior_credit_officer: "Sr. Credit Officer",
};

function roleLabel(role) {
  return ROLE_LABEL[role] || role || "";
}

function railMetric(labelText) {
  return Array.from(document.querySelectorAll(".rail-metric")).find((row) => {
    const label = row.querySelector("span");
    return label && label.textContent.trim() === labelText;
  });
}

function applySessionToChrome(session) {
  const uname = document.querySelector(".userchip .uname");
  const urole = document.getElementById("role-readout");
  const avatar = document.querySelector(".userchip .avatar");
  if (uname) uname.textContent = session.username;
  if (urole) urole.textContent = roleLabel(session.role);
  if (avatar) avatar.textContent = session.username.slice(0, 2).toUpperCase();
  const scopeRow = railMetric("Role scope");
  if (scopeRow) {
    const b = scopeRow.querySelector("b");
    if (b) b.textContent = session.role.toUpperCase();
  }
  const pfRow = document.getElementById("pf-submitted-by");
  if (pfRow) pfRow.textContent = session.username + " — " + roleLabel(session.role);
}

function showLoginOverlay(message) {
  const overlay = document.getElementById("login-overlay");
  if (overlay) overlay.classList.remove("hidden");
  const err = document.getElementById("login-error");
  if (err) {
    err.style.display = message ? "" : "none";
    err.textContent = message || "";
  }
}

function hideLoginOverlay() {
  const overlay = document.getElementById("login-overlay");
  if (overlay) overlay.classList.add("hidden");
}

async function login(username, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || "invalid username or password");
  return body;
}

function wireLoginForm() {
  const submit = document.getElementById("login-submit");
  const userInput = document.getElementById("login-username");
  const passInput = document.getElementById("login-password");
  if (!submit) return;
  const attempt = async () => {
    try {
      const session = await login(userInput.value.trim(), passInput.value);
      Session.set(session);
      applySessionToChrome(session);
      hideLoginOverlay();
      refreshPipeline();
    } catch (err) {
      showLoginOverlay(err.message);
    }
  };
  submit.addEventListener("click", attempt);
  [userInput, passInput].forEach((el) => {
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  });
}

function bootSession() {
  const session = Session.get();
  if (session && session.token) {
    applySessionToChrome(session);
    hideLoginOverlay();
  } else {
    showLoginOverlay();
  }
  wireLoginForm();
}

// ============================================================================
// PIPELINE BOARD (screen-pipeline) — GET /api/pipeline, GET /api/deals
// Deterministic board view, REQ-002: nothing here is agent-produced.
// ============================================================================
const PipelineState = { board: null, filter: "all" };

function money(amount) {
  if (amount == null || amount === "") return "—";
  return "$" + Math.round(Number(amount)).toLocaleString("en-US");
}

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

async function fetchPipeline() {
  const res = await fetch("/api/pipeline");
  return res.ok ? res.json() : null;
}

function allDealsFromBoard(board) {
  return board.stages.flatMap((s) => s.deals);
}

function applyPipelineFilter(deals, filter, session) {
  if (filter === "my" && session) {
    return deals.filter((d) => d.submitted_by_user_id === session.user_id || d.assigned_analyst_id === session.user_id);
  }
  if (filter === "over1m") return deals.filter((d) => Number(d.exposure_amount) > 1000000);
  if (filter === "blocked") return []; // nothing blocks a deal before a draft can even exist — honest empty state
  return deals;
}

function renderTrack(stageIndex) {
  const track = document.createElement("span");
  track.className = "track";
  for (let i = 0; i < 8; i++) {
    const seg = document.createElement("i");
    if (i < stageIndex) seg.className = "done";
    else if (i === stageIndex) seg.className = "here";
    track.appendChild(seg);
  }
  return track;
}

function textCell(text, opts) {
  const td = document.createElement("td");
  if (opts && opts.className) td.className = opts.className;
  td.textContent = text;
  return td;
}

function chipCell(text, chipClass) {
  const td = document.createElement("td");
  const chip = document.createElement("span");
  chip.className = "chip" + (chipClass ? " " + chipClass : "");
  chip.textContent = text;
  td.appendChild(chip);
  return td;
}

function buildDealRow(deal, stageIndexByKey) {
  const tr = document.createElement("tr");

  const idTd = document.createElement("td");
  idTd.className = "mono";
  const idSpan = document.createElement("span");
  idSpan.className = "tbl-id";
  idSpan.dataset.goto = "deal";
  idSpan.textContent = "D-" + String(deal.id).padStart(4, "0");
  idTd.appendChild(idSpan);
  tr.appendChild(idTd);

  const borrowerTd = document.createElement("td");
  borrowerTd.textContent = deal.borrower_name;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = deal.borrower_industry;
  borrowerTd.appendChild(sub);
  tr.appendChild(borrowerTd);

  tr.appendChild(textCell((deal.facility_type || "").replace(/_/g, " "), { className: "dim" }));
  tr.appendChild(textCell(money(deal.exposure_amount), { className: "num mono" }));
  tr.appendChild(chipCell((deal.approval_tier || "").replace(/_/g, " ")));

  const stageIndex = stageIndexByKey[deal.current_stage] ?? 0;
  tr.appendChild(chipCell(String(stageIndex + 1).padStart(2, "0") + " " + (deal.current_stage || "").replace(/_/g, " "), "pri"));

  const trackTd = document.createElement("td");
  trackTd.appendChild(renderTrack(stageIndex));
  tr.appendChild(trackTd);

  tr.appendChild(chipCell("—"));
  tr.appendChild(textCell("—", { className: "num mono dim" }));
  tr.appendChild(chipCell(deal.current_stage === "intake" ? "Awaiting triage" : "In progress"));
  tr.appendChild(textCell(deal.submitted_by_user_id || "Unassigned"));

  const idle = daysSince(deal.last_activity_at);
  tr.appendChild(textCell(idle == null ? "—" : idle + " d", { className: "num mono" }));

  return tr;
}

function renderStagerail(board) {
  const cells = document.querySelectorAll("#screen-pipeline .stagerail .stagecell");
  board.stages.forEach((stage, i) => {
    const cell = cells[i];
    if (!cell) return;
    const countEl = cell.querySelector(".s-count");
    if (countEl) countEl.textContent = String(stage.count);
  });
}

function renderDealTable(board) {
  const tbody = document.querySelector("#screen-pipeline table.tbl tbody");
  if (!tbody) return;
  const stageIndexByKey = Object.fromEntries(board.stages.map((s) => [s.key, s.index]));
  const all = allDealsFromBoard(board);
  const sorted = window.HarnessTable ? window.HarnessTable.prepare(all, { sort: "-last_activity_at", pageSize: 500 }).rows : all;
  const session = Session.get();
  const filtered = applyPipelineFilter(sorted, PipelineState.filter, session);

  tbody.replaceChildren();
  if (!filtered.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 12;
    td.className = "dim";
    td.style.textAlign = "center";
    td.style.padding = "24px";
    td.textContent = "No deals match this filter yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    filtered.forEach((deal) => tbody.appendChild(buildDealRow(deal, stageIndexByKey)));
  }

  const note = document.querySelector("#screen-pipeline .panel-hd .hd-note");
  if (note) note.textContent = filtered.length + " rows · sorted by last activity desc";
  const footNote = document.querySelector("#screen-pipeline .panel-ft .dim.txt-tiny");
  if (footNote) footNote.textContent = filtered.length + " of " + all.length + " shown";
}

function updatePipelineChrome(board) {
  const sub = document.querySelector("#screen-pipeline .scr-sub");
  if (sub) sub.textContent = board.stages.length + " stages · " + board.total_active + " active deals · live";
  const badge = document.querySelector('.navitem[data-screen="pipeline"] .nav-count');
  if (badge) badge.textContent = String(board.total_active);
  const inView = railMetric("Deals in view");
  if (inView) {
    const b = inView.querySelector("b");
    if (b) b.textContent = String(board.total_active);
  }
  // Status-strip counters this slice can honestly derive from real deal data.
  // Draft/SLA/approval counters stay at 0 until the slices that produce that
  // state (triage drafts, SLA timers, approval queue) land.
  const queueEl = document.getElementById("m-queue");
  if (queueEl) queueEl.textContent = String(board.total_active);
  const slaEl = document.getElementById("m-sla");
  if (slaEl) slaEl.textContent = "0";
  const pendingEl = document.getElementById("m-pending");
  if (pendingEl) pendingEl.textContent = "0";
  const approvalsEl = document.getElementById("m-approvals-due");
  if (approvalsEl) approvalsEl.textContent = "0";
  const exposureEl = document.getElementById("m-exposure");
  if (exposureEl) {
    const total = allDealsFromBoard(board).reduce((sum, d) => sum + (Number(d.exposure_amount) || 0), 0);
    exposureEl.textContent = money(total);
  }
}

async function refreshPipeline() {
  const board = await fetchPipeline();
  if (!board) return;
  PipelineState.board = board;
  renderStagerail(board);
  renderDealTable(board);
  updatePipelineChrome(board);
}

function wirePipelineControls() {
  const segButtons = document.querySelectorAll('#screen-pipeline .scr-hd .segbar button');
  const filterByIndex = ["all", "my", "blocked", "over1m"];
  segButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => {
      segButtons.forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      PipelineState.filter = filterByIndex[i] || "all";
      if (PipelineState.board) renderDealTable(PipelineState.board);
    });
  });

  const headerButtons = document.querySelectorAll("#screen-pipeline .scr-hd > button");
  headerButtons.forEach((btn) => {
    const label = btn.textContent.trim();
    if (label.startsWith("Export CSV")) {
      btn.addEventListener("click", () => window.open("/export/deals.csv", "_blank"));
    } else if (label.startsWith("Columns")) {
      let hidden = false;
      btn.addEventListener("click", () => {
        hidden = !hidden;
        document.querySelectorAll("#screen-pipeline table.tbl thead th:nth-child(3), #screen-pipeline table.tbl tbody td:nth-child(3)").forEach((el) => {
          el.style.display = hidden ? "none" : "";
        });
      });
    }
  });
}

// ============================================================================
// DEAL INTAKE (screen-intake) — POST /api/deals
// Walking skeleton: one form, one persisted Deal, one board (REQ-051).
// ============================================================================
function parseMoney(text) {
  const n = Number(String(text || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function showIntakeFeedback(kind, text) {
  const el = document.getElementById("intake-feedback");
  if (!el) return;
  el.style.display = "";
  el.className = "banner " + kind;
  el.textContent = text;
}

function updateTierGauge(exposure) {
  const chip = document.getElementById("in-tier-chip");
  const needle = document.getElementById("in-tier-needle");
  const hint = document.getElementById("in-tier-hint");
  if (!chip || !needle || !hint) return;
  let tierText, chipClass, pct, hintText;
  if (exposure <= 250000) {
    tierText = "Tier 1 · Credit Analyst";
    chipClass = "chip ok lg";
    pct = Math.min(20, (exposure / 250000) * 20);
    hintText = money(exposure) + " is within the $250,000 credit-analyst ceiling.";
  } else if (exposure <= 1000000) {
    tierText = "Tier 2 · Sr. Credit Officer";
    chipClass = "chip warn lg";
    pct = 20 + Math.min(22, ((exposure - 250000) / 750000) * 22);
    hintText = money(exposure) + " exceeds the $250,000 analyst ceiling → routes to senior credit officer authority.";
  } else {
    tierText = "Tier 3 · Credit Committee";
    chipClass = "chip crit lg";
    pct = 42 + Math.min(58, ((exposure - 1000000) / 2000000) * 58);
    hintText = money(exposure) + " exceeds the $1,000,000 senior-officer ceiling → routes to credit committee at Stage 07.";
  }
  chip.className = chipClass;
  chip.textContent = tierText;
  needle.style.left = Math.max(0, Math.min(100, pct)) + "%";
  hint.textContent = hintText;
}

function checkDuplicateRequest(borrowerName) {
  const el = document.getElementById("pf-duplicate");
  if (!el) return;
  el.replaceChildren();
  const chip = document.createElement("span");
  const deals = PipelineState.board ? allDealsFromBoard(PipelineState.board) : [];
  const dupe = borrowerName && deals.some((d) => d.borrower_name.trim().toLowerCase() === borrowerName.trim().toLowerCase());
  chip.className = "chip " + (dupe ? "warn" : "ok");
  chip.textContent = dupe ? "POSSIBLE DUPLICATE" : "NONE";
  el.appendChild(chip);
}

function wireIntakeForm() {
  const amtInput = document.getElementById("in-amt");
  const legalInput = document.getElementById("in-legal");
  if (amtInput) {
    updateTierGauge(parseMoney(amtInput.value));
    amtInput.addEventListener("input", () => updateTierGauge(parseMoney(amtInput.value)));
  }
  if (legalInput) {
    checkDuplicateRequest(legalInput.value);
    legalInput.addEventListener("input", () => checkDuplicateRequest(legalInput.value));
  }

  const saveDraftBtn = document.getElementById("in-save-draft");
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener("click", () => {
      const draft = {
        borrower_name: legalInput ? legalInput.value : "",
        industry: document.getElementById("in-industry") ? document.getElementById("in-industry").value : "",
        facility_type: document.getElementById("in-type") ? document.getElementById("in-type").value : "",
        exposure: amtInput ? amtInput.value : "",
      };
      localStorage.setItem("ucc_intake_draft", JSON.stringify(draft));
      showIntakeFeedback("info", "Draft saved locally on this device — it is not yet submitted to triage.");
    });
  }

  const submitBtn = document.getElementById("in-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const session = Session.get();
      if (!session) {
        showIntakeFeedback("crit", "Sign in before submitting a deal.");
        return;
      }
      if (session.role !== "relationship_manager") {
        showIntakeFeedback("crit", "Only a relationship manager may submit a deal (REQ-020).");
        return;
      }
      const borrowerName = (legalInput ? legalInput.value : "").trim();
      const industry = document.getElementById("in-industry") ? document.getElementById("in-industry").value : "";
      const facilityType = document.getElementById("in-type") ? document.getElementById("in-type").value : "";
      const exposure = parseMoney(amtInput ? amtInput.value : "0");
      if (!borrowerName) {
        showIntakeFeedback("crit", "Legal name is required.");
        return;
      }
      if (!exposure) {
        showIntakeFeedback("crit", "Exposure amount is required.");
        return;
      }
      submitBtn.disabled = true;
      try {
        const res = await fetch("/api/deals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            borrower_name: borrowerName,
            borrower_industry: industry,
            facility_type: facilityType,
            requested_amount: exposure,
            exposure_amount: exposure,
            submitted_by_user_id: session.user_id,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail = Array.isArray(body.detail) ? body.detail.join("; ") : body.detail || "submission failed";
          showIntakeFeedback("crit", detail);
          return;
        }
        showIntakeFeedback("ok", "Deal " + body.borrower_name + " created at stage " + body.current_stage + ". Opening the pipeline board…");
        await refreshPipeline();
        setTimeout(() => { location.hash = "screen-pipeline"; }, 700);
      } catch (err) {
        showIntakeFeedback("crit", "Request failed: " + err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}

// Re-sync the board every time it becomes the visible screen (not just at
// boot) so navigating back after an intake submission always shows current
// state regardless of exactly when the create-deal request settled.
window.addEventListener("hashchange", () => {
  if (location.hash === "#screen-pipeline") refreshPipeline();
});

// ============================================================================
// BOOT
// ============================================================================
bootSession();
wirePipelineControls();
wireIntakeForm();
refreshPipeline();
