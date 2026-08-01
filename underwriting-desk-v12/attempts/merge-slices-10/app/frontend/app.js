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

// ============================================================
// Section index navigation (foundation): the design's header nav switches
// between the edition's sections (`[data-screen="x"]` -> `#screen-x`).
// Every screen the design ships is reachable from here.
// ============================================================
(function () {
  const buttons = Array.from(document.querySelectorAll("[data-screen]"));
  if (!buttons.length) return;

  function show(name) {
    document.querySelectorAll('[id^="screen-"]').forEach((section) => {
      section.classList.toggle("is-active", section.id === "screen-" + name);
    });
    buttons.forEach((b) => {
      if (b.dataset.screen === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    document.dispatchEvent(new CustomEvent("screen:shown", { detail: { screen: "screen-" + name } }));
  }

  buttons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      show(button.dataset.screen);
    });
  });
})();

// ============================================================
// Pipeline board (slice: deal-intake-and-triage)
//   - files a new deal (POST /api/deals)
//   - runs the Intake Triage Agent (POST /api/deals/{id}/agents/intake-triage/run)
//   - accepts its proposal, which routes the deal (POST /api/deals/{id}/triage/accept)
//   - renders the pipeline board from GET /api/pipeline
// ============================================================
(function () {
  const STAGES = [
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "tiered_approval",
    "closing",
  ];

  function money(n) {
    const num = Number(n) || 0;
    return "$" + num.toLocaleString("en-US");
  }

  let allDeals = [];

  function val(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function daysSince(iso) {
    const t = Date.parse(iso || "");
    if (!t) return null;
    return (Date.now() - t) / 86400000;
  }

  // The find-bar narrows the live server data — never a cosmetic control.
  function applyFilters(deals) {
    const q = val("board-filter-search").toLowerCase();
    const stage = val("board-filter-stage");
    const owner = val("board-filter-owner");
    const grade = val("board-filter-grade");
    const exposure = val("board-filter-exposure");
    const age = val("board-filter-age");

    return deals.filter((d) => {
      if (q) {
        const hay = [d.borrower_name, d.deal_code, d.borrower_industry].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (stage && d.current_stage !== stage) return false;
      if (owner === "assigned" && !d.assigned_to_user_id) return false;
      if (owner === "unassigned" && d.assigned_to_user_id) return false;
      if (grade) {
        const g = Number(d.risk_grade);
        if (grade === "ungraded" && d.risk_grade != null && d.risk_grade !== "") return false;
        if (grade === "1-3" && !(g >= 1 && g <= 3)) return false;
        if (grade === "4-6" && !(g >= 4 && g <= 6)) return false;
        if (grade === "7+" && !(g >= 7)) return false;
      }
      if (exposure) {
        const amount = Number(d.exposure_amount || d.requested_amount || 0);
        if (exposure === "to250" && amount > 250000) return false;
        if (exposure === "250to1m" && !(amount > 250000 && amount <= 1000000)) return false;
        if (exposure === "above1m" && amount <= 1000000) return false;
      }
      if (age) {
        const idle = daysSince(d.last_activity_timestamp || d.updated_at || d.created_at);
        const opened = daysSince(d.created_at);
        if (age === "idle5" && !(idle !== null && idle >= 5)) return false;
        if (age === "week" && !(opened !== null && opened <= 7)) return false;
      }
      return true;
    });
  }

  function renderBoard(deals) {
    STAGES.forEach((stage) => {
      const ul = document.getElementById("col-" + stage);
      const count = document.getElementById("count-" + stage);
      if (!ul) return;
      const atStage = deals.filter((d) => d.current_stage === stage);
      if (count) count.textContent = String(atStage.length);
      ul.replaceChildren();
      atStage.forEach((d) => {
        const li = document.createElement("li");

        const name = document.createElement("span");
        name.className = "deal-name";
        name.textContent = d.borrower_name || d.deal_code;

        const line = document.createElement("span");
        line.className = "deal-line";
        [d.deal_code, money(d.requested_amount), d.borrower_industry || ""].forEach((t) => {
          const sp = document.createElement("span");
          sp.textContent = t;
          line.appendChild(sp);
        });

        const tags = document.createElement("span");
        tags.className = "deal-tags";
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.textContent = d.current_status || "new";
        tags.appendChild(flag);

        li.appendChild(name);
        li.appendChild(line);
        li.appendChild(tags);
        ul.appendChild(li);
      });
    });
  }

  function refresh() {
    const shown = applyFilters(allDeals);
    renderBoard(shown);
    const status = document.getElementById("board-filter-status");
    if (status) {
      status.textContent =
        shown.length === allDeals.length
          ? "Showing all " + allDeals.length + " deals on the book."
          : "Showing " + shown.length + " of " + allDeals.length + " deals.";
    }
  }

  function loadPipeline() {
    return fetch("/api/pipeline")
      .then((r) => (r.ok ? r.json() : { deals: [] }))
      .then((data) => {
        allDeals = data.deals || [];
        refresh();
      })
      .catch(() => {});
  }

  const filterForm = document.getElementById("board-filter-form");
  if (filterForm) {
    filterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      refresh();
    });
    ["board-filter-stage", "board-filter-owner", "board-filter-grade", "board-filter-exposure", "board-filter-age"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", refresh);
    });
    const search = document.getElementById("board-filter-search");
    if (search) search.addEventListener("input", refresh);
  }

  // Re-read the book whenever the board is brought to the front.
  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-pipeline-board") loadPipeline();
  });

  let currentDealCode = null;

  const intakeForm = document.getElementById("intake-form");
  if (intakeForm) {
    intakeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const status = document.getElementById("intake-status");
      const body = {
        borrower_name: document.getElementById("intake-borrower-name").value.trim(),
        borrower_industry: document.getElementById("intake-industry").value.trim(),
        requested_amount: Number(document.getElementById("intake-requested").value),
        exposure_amount: Number(document.getElementById("intake-exposure").value),
        acting_user_email: document.getElementById("intake-rm-email").value.trim(),
      };
      fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (status) status.textContent = "Could not file deal: " + (res.data.detail || "error");
            return;
          }
          currentDealCode = res.data.deal_code;
          if (status) {
            status.textContent = "Filed " + res.data.deal_code + " for " + res.data.borrower_name + " — now in intake.";
          }
          const triageDesk = document.getElementById("triage-desk");
          if (triageDesk) triageDesk.style.display = "";
          const acceptBtn = document.getElementById("triage-accept-btn");
          if (acceptBtn) acceptBtn.disabled = true;
          const out = document.getElementById("triage-output");
          if (out) out.replaceChildren();
          const triageStatus = document.getElementById("triage-status");
          if (triageStatus) triageStatus.textContent = "";
          loadPipeline();
        })
        .catch((err) => {
          if (status) status.textContent = "Request failed: " + err.message;
        });
    });
  }

  const runBtn = document.getElementById("triage-run-btn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      const statusEl = document.getElementById("triage-status");
      if (!currentDealCode) {
        if (statusEl) statusEl.textContent = "File a deal above first.";
        return;
      }
      const email = document.getElementById("triage-analyst-email").value.trim();
      fetch("/api/deals/" + encodeURIComponent(currentDealCode) + "/agents/intake-triage/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: email }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Triage failed: " + (res.data.detail || "error");
            return;
          }
          const out = document.getElementById("triage-output");
          if (out) {
            out.replaceChildren();
            [
              ["Classification", res.data.classification],
              ["Missing documents", (res.data.missing_documents || []).join(", ") || "none"],
              ["Recommended queue", res.data.recommended_queue],
              ["Confidence score", res.data.confidence_score],
            ].forEach(([label, value]) => {
              const li = document.createElement("li");
              const k = document.createElement("span");
              k.textContent = label;
              const v = document.createElement("span");
              v.textContent = String(value);
              li.appendChild(k);
              li.appendChild(v);
              out.appendChild(li);
            });
          }
          const acceptBtn = document.getElementById("triage-accept-btn");
          if (acceptBtn) acceptBtn.disabled = false;
          if (statusEl) statusEl.textContent = "Proposal drafted — an analyst must accept it to route the deal.";
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  const acceptBtn = document.getElementById("triage-accept-btn");
  if (acceptBtn) {
    acceptBtn.addEventListener("click", () => {
      const statusEl = document.getElementById("triage-status");
      if (!currentDealCode) return;
      const email = document.getElementById("triage-analyst-email").value.trim();
      fetch("/api/deals/" + encodeURIComponent(currentDealCode) + "/triage/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: email }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Accept failed: " + (res.data.detail || "error");
            return;
          }
          if (statusEl) {
            statusEl.textContent = "Routed to " + res.data.queue_name + " — now in " + res.data.current_stage + ".";
          }
          acceptBtn.disabled = true;
          loadPipeline();
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  loadPipeline();
})();

// ============================================================
// Deal dossier (slice: spread-ratios-and-risk-grade)
//   - opens a deal by code (GET /api/deals/{code})
//   - runs the Financial Spreading Agent (POST .../agents/financial-spreading/run)
//   - accepts, edits, or rejects the draft (POST .../spread/accept)
//   - renders deterministic ratios (GET .../ratios) and risk grade (GET .../risk-grade)
// ============================================================
(function () {
  const screen = document.getElementById("screen-deal-detail");
  if (!screen) return;

  const RATIO_LABELS = {
    dscr: ["Debt service coverage", "EBITDA ÷ interest expense"],
    leverage: ["Leverage", "total debt ÷ EBITDA"],
    current_ratio: ["Current ratio", "current assets ÷ current liabilities"],
  };

  function money(n) {
    const num = Number(n) || 0;
    return "$" + num.toLocaleString("en-US");
  }

  function fmtx(n) {
    return n === null || n === undefined ? "—" : Number(n).toFixed(2) + "×";
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  let dealCode = null;
  let lastSpreadDraft = null;

  function resetSpreadPanel() {
    lastSpreadDraft = null;
    setText("spread-narrative", "Run the Financial Spreading Agent to draft the standard spread template from this deal's attached documents.");
    setText("spread-proof-meta", "Financial spreading agent");
    const body = document.getElementById("spread-rows-body");
    if (body) body.replaceChildren();
    const un = document.getElementById("spread-unextractable-list");
    if (un) un.replaceChildren();
    const citeList = document.getElementById("citation-rail-list");
    if (citeList) {
      citeList.replaceChildren();
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "cite-no";
      label.textContent = "—";
      li.appendChild(label);
      li.appendChild(document.createTextNode(" Run the Financial Spreading Agent to populate citations."));
      citeList.appendChild(li);
    }
    ["spread-accept-btn", "spread-edit-btn", "spread-reject-btn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    setText("spread-status", "");
  }

  function renderDocuments(docs) {
    const list = document.getElementById("docket-list");
    if (!list) return;
    list.replaceChildren();
    const REQUIRED = ["balance_sheet", "income_statement", "tax_return"];
    const attached = new Set(docs.map((d) => d.document_type));
    REQUIRED.forEach((t) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = t.replace(/_/g, " ");
      const state = document.createElement("span");
      const has = attached.has(t);
      state.textContent = has ? "attached" : "missing";
      if (!has) state.className = "missing";
      li.appendChild(label);
      li.appendChild(state);
      list.appendChild(li);
    });
  }

  function renderRatios(data) {
    const body = document.getElementById("ratios-table-body");
    if (!body) return;
    body.replaceChildren();
    if (!data || !Array.isArray(data.ratios) || !data.ratios.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 3;
      td.style.fontStyle = "italic";
      td.style.color = "var(--ink-faint)";
      td.textContent = "No ratios computed yet — accept a spread first.";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    data.ratios.forEach((r) => {
      const label = RATIO_LABELS[r.ratio_type] || [r.ratio_type, ""];
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.appendChild(document.createTextNode(label[0]));
      const formula = document.createElement("span");
      formula.className = "formula";
      formula.textContent = label[1];
      th.appendChild(formula);
      const inputs = document.createElement("td");
      inputs.textContent = (r.numerator ?? "—") + " ÷ " + (r.denominator ?? "—");
      const result = document.createElement("td");
      result.className = "num";
      result.textContent = fmtx(r.result);
      tr.appendChild(th);
      tr.appendChild(inputs);
      tr.appendChild(result);
      body.appendChild(tr);
    });
  }

  function renderGrade(data) {
    ["A", "B", "C", "D"].forEach((g) => {
      const el = document.getElementById("rubric-band-" + g);
      if (el) el.classList.toggle("hit", !!data && data.grade === g);
    });
    setText("risk-grade-reasoning", data ? (data.reasoning || data.band_hit || "") : "Not yet graded — accept a spread first.");
  }

  function loadRatiosAndGrade(code) {
    fetch("/api/deals/" + encodeURIComponent(code) + "/ratios")
      .then((r) => (r.ok ? r.json() : null))
      .then(renderRatios)
      .catch(() => renderRatios(null));
    fetch("/api/deals/" + encodeURIComponent(code) + "/risk-grade")
      .then((r) => (r.ok ? r.json() : null))
      .then(renderGrade)
      .catch(() => renderGrade(null));
  }

  function loadDeal(code) {
    const status = document.getElementById("dossier-load-status");
    if (!code) {
      if (status) status.textContent = "Enter a deal code (e.g. DEAL-1002).";
      return;
    }
    fetch("/api/deals/" + encodeURIComponent(code))
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((deal) => {
        dealCode = deal.deal_code;
        setText("dossier-borrower-name", deal.borrower_name || dealCode);
        setText(
          "dossier-sub",
          dealCode + " · " + (deal.borrower_industry || "—") + " · stage " + (deal.current_stage || "—")
        );
        setText("dossier-exposure-amount", money(deal.exposure_amount));
        setText(
          "dossier-tier",
          (deal.risk_grade ? "Risk grade " + deal.risk_grade + " · " : "") + "exposure " + money(deal.exposure_amount)
        );
        if (status) status.textContent = "Opened " + dealCode + ".";
        resetSpreadPanel();
        fetch("/api/deals/" + encodeURIComponent(dealCode) + "/documents")
          .then((r) => (r.ok ? r.json() : []))
          .then(renderDocuments)
          .catch(() => {});
        loadRatiosAndGrade(dealCode);
      })
      .catch(() => {
        dealCode = null;
        if (status) status.textContent = "No deal found for '" + code + "'.";
      });
  }

  function renderSpreadDraft(data) {
    lastSpreadDraft = data;
    setText("spread-narrative", data.narrative || "");
    setText("spread-proof-meta", "Financial spreading agent · " + (data.template_version || ""));

    const body = document.getElementById("spread-rows-body");
    if (body) {
      body.replaceChildren();
      (data.rows || []).forEach((row) => {
        const cite = (data.citations || []).find((c) => c.line_item_key === row.line_item_key) || {};
        const tr = document.createElement("tr");
        const cells = [
          row.line_item_key,
          row.period,
          cite.document_id ? "doc " + cite.document_id + " · " + (cite.cell_locator || cite.section || "") : "—",
          row.value + " " + (row.unit || ""),
        ];
        cells.forEach((val, idx) => {
          const td = document.createElement("td");
          if (idx === 3) td.className = "num";
          td.textContent = String(val);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }

    const un = document.getElementById("spread-unextractable-list");
    if (un) {
      un.replaceChildren();
      (data.unextractable || []).forEach((item) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = item.line_item_key || String(item);
        const reason = document.createElement("span");
        reason.className = "missing";
        reason.textContent = item.reason || "unextractable";
        li.appendChild(label);
        li.appendChild(reason);
        un.appendChild(li);
      });
    }

    const citeList = document.getElementById("citation-rail-list");
    if (citeList) {
      citeList.replaceChildren();
      (data.citations || []).forEach((c, i) => {
        const li = document.createElement("li");
        const no = document.createElement("span");
        no.className = "cite-no";
        no.textContent = "[" + (i + 1) + "]";
        li.appendChild(no);
        li.appendChild(document.createTextNode(" " + c.line_item_key));
        const src = document.createElement("span");
        src.className = "cite-src";
        src.textContent = "doc " + c.document_id + " · " + (c.cell_locator || c.section || "");
        li.appendChild(src);
        citeList.appendChild(li);
      });
    }

    ["spread-accept-btn", "spread-edit-btn", "spread-reject-btn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
  }

  const loadForm = document.getElementById("dossier-load-form");
  if (loadForm) {
    loadForm.addEventListener("submit", (event) => {
      event.preventDefault();
      loadDeal(document.getElementById("dossier-deal-code").value.trim());
    });
  }

  const spreadRunBtn = document.getElementById("spread-run-btn");
  if (spreadRunBtn) {
    spreadRunBtn.addEventListener("click", () => {
      const statusEl = document.getElementById("spread-status");
      if (!dealCode) {
        if (statusEl) statusEl.textContent = "Open a dossier above first.";
        return;
      }
      const email = document.getElementById("spread-analyst-email").value.trim();
      fetch("/api/deals/" + encodeURIComponent(dealCode) + "/agents/financial-spreading/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: email }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Spreading failed: " + (res.data.detail || "error");
            return;
          }
          renderSpreadDraft(res.data);
          if (statusEl) {
            statusEl.textContent = "Draft ready — " + (res.data.rows || []).length + " cited figures. Accept, edit, or reject.";
          }
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  function decide(action) {
    const statusEl = document.getElementById("spread-status");
    if (!dealCode || !lastSpreadDraft) {
      if (statusEl) statusEl.textContent = "Run the agent first.";
      return;
    }
    const email = document.getElementById("spread-analyst-email").value.trim();
    const note = document.getElementById("spread-decision-note").value.trim();
    fetch("/api/deals/" + encodeURIComponent(dealCode) + "/spread/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acting_user_email: email, action: action, note: note || null }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then((res) => {
        if (!res.ok) {
          if (statusEl) statusEl.textContent = action + " failed: " + (res.data.detail || "error");
          return;
        }
        if (statusEl) {
          statusEl.textContent = "Spread " + res.data.status + " by " + res.data.accepted_by + ". Stage now " + res.data.current_stage + ".";
        }
        ["spread-accept-btn", "spread-edit-btn", "spread-reject-btn"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.disabled = true;
        });
        loadRatiosAndGrade(dealCode);
      })
      .catch((err) => {
        if (statusEl) statusEl.textContent = "Request failed: " + err.message;
      });
  }

  const acceptBtn = document.getElementById("spread-accept-btn");
  if (acceptBtn) acceptBtn.addEventListener("click", () => decide("accept"));
  const editBtn = document.getElementById("spread-edit-btn");
  if (editBtn) editBtn.addEventListener("click", () => decide("edit"));
  const rejectBtn = document.getElementById("spread-reject-btn");
  if (rejectBtn) rejectBtn.addEventListener("click", () => decide("reject"));
})();

// ============================================================
// Credit memo, policy compliance & the Chronicle (slice: memo-policy-and-audit-trail)
//   - drafts the credit memo (POST /api/deals/{id}/agents/credit-memo/run)
//   - accepts the draft (POST /api/deals/{id}/memo/accept)
//   - runs the policy compliance check (POST /api/deals/{id}/agents/policy-compliance/run)
//   - reads the deal's full history in order (GET /api/deals/{id}/audit)
// ============================================================
(function () {
  const chronicleList = document.getElementById("chronicle-list");
  if (!chronicleList) return; // screen not present in this build

  const dealCodeInput = document.getElementById("chronicle-deal-code");
  const analystEmailInput = document.getElementById("chronicle-analyst-email");
  const statusEl = document.getElementById("chronicle-status");
  const chronicleMeta = document.getElementById("chronicle-meta");
  const memoOutput = document.getElementById("memo-output");
  const policyOutput = document.getElementById("policy-output");
  const memoAcceptBtn = document.getElementById("memo-accept-btn");

  function dealCode() {
    const v = dealCodeInput ? dealCodeInput.value.trim() : "";
    return v || "DEAL-1003";
  }

  function analystEmail() {
    const v = analystEmailInput ? analystEmailInput.value.trim() : "";
    return v || "analyst@bank.test";
  }

  // The audit endpoint resolves the acting user's display name server-side,
  // so the Chronicle never reads the users table itself.
  function actorLabel(entry) {
    if (entry.actor_name) return entry.actor_name;
    if (entry.actor_user_id === null || entry.actor_user_id === undefined) return "system";
    return "user #" + entry.actor_user_id;
  }

  function actionLabel(action) {
    return String(action || "")
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // A filled mark (human), an indigo mark (agent draft), or a dashed mark
  // (deterministic system logic) — see the design's own "Reading the Marks" note.
  function categorize(entry) {
    if (entry.resource_type === "agent_draft") return "agent";
    const a = String(entry.action || "");
    if (/accept|approve|declin|waive|reject|return/.test(a)) return "human";
    if (/comput|assign|record|raised|grade/.test(a)) return "calc";
    return "state";
  }

  function renderChronicle(code, entries) {
    chronicleList.replaceChildren();
    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "by-system";
      const body = document.createElement("div");
      body.className = "entry-body";
      const p = document.createElement("p");
      p.textContent = "No chronicle entries yet for " + code + ".";
      body.appendChild(p);
      li.appendChild(body);
      chronicleList.appendChild(li);
    } else {
      const ordered = entries.slice().reverse(); // newest first
      ordered.forEach((entry, i) => {
        const li = document.createElement("li");
        li.className = "by-" + categorize(entry);

        const when = document.createElement("div");
        when.className = "entry-when";
        const b = document.createElement("b");
        b.textContent = entry.timestamp ? entry.timestamp.slice(0, 10) : "";
        when.appendChild(b);
        when.appendChild(document.createTextNode(entry.timestamp ? " " + entry.timestamp.slice(11, 19) : ""));
        const seq = document.createElement("span");
        seq.className = "seq";
        seq.textContent = "Entry " + (entries.length - i);
        when.appendChild(seq);

        const spine = document.createElement("div");
        spine.className = "entry-spine";
        spine.setAttribute("aria-hidden", "true");

        const body = document.createElement("div");
        body.className = "entry-body";
        const h4 = document.createElement("h4");
        h4.textContent = actionLabel(entry.action);
        const actor = document.createElement("span");
        actor.className = "actor";
        actor.textContent = actorLabel(entry) + (entry.resource_type ? " · " + entry.resource_type : "");
        const p = document.createElement("p");
        p.textContent = entry.resource_id !== undefined && entry.resource_id !== null ? "Reference " + entry.resource_id : "—";
        const seal = document.createElement("span");
        seal.className = "seal";
        seal.textContent = "sealed";

        body.appendChild(h4);
        body.appendChild(actor);
        body.appendChild(p);
        body.appendChild(seal);

        li.appendChild(when);
        li.appendChild(spine);
        li.appendChild(body);
        chronicleList.appendChild(li);
      });
    }

    const counts = { all: entries.length, human: 0, agent: 0, calc: 0, state: 0 };
    entries.forEach((e) => {
      counts[categorize(e)] += 1;
    });
    ["all", "human", "agent", "calc", "state"].forEach((k) => {
      const el = document.getElementById("chronicle-count-" + k);
      if (el) el.textContent = String(counts[k]);
    });
    if (chronicleMeta) {
      chronicleMeta.textContent = code + " · " + entries.length + " entries · nothing amended, nothing removed";
    }
  }

  function loadChronicle() {
    const code = dealCode();
    return fetch("/api/deals/" + encodeURIComponent(code) + "/audit")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("deal not found"))))
      .then((data) => {
        renderChronicle(code, data.entries || []);
        if (statusEl) statusEl.textContent = "Loaded " + (data.entries || []).length + " chronicle entries for " + code + ".";
      })
      .catch((err) => {
        renderChronicle(code, []);
        if (statusEl) statusEl.textContent = "Could not load chronicle: " + err.message;
      });
  }

  const loadBtn = document.getElementById("chronicle-load-btn");
  if (loadBtn) loadBtn.addEventListener("click", loadChronicle);

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-audit-timeline") loadChronicle();
  });

  const memoRunBtn = document.getElementById("memo-run-btn");
  if (memoRunBtn) {
    memoRunBtn.addEventListener("click", () => {
      fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/agents/credit-memo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: analystEmail() }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Memo run failed: " + (res.data.detail || "error");
            return;
          }
          if (memoOutput) {
            memoOutput.replaceChildren();
            (res.data.sections || []).forEach((s) => {
              const li = document.createElement("li");
              const k = document.createElement("span");
              k.textContent = s.title;
              const v = document.createElement("span");
              v.textContent = s.content;
              li.appendChild(k);
              li.appendChild(v);
              memoOutput.appendChild(li);
            });
            const citeLi = document.createElement("li");
            const k = document.createElement("span");
            k.textContent = "Citations";
            const v = document.createElement("span");
            v.textContent = (res.data.citations || []).length + " sourced figures";
            citeLi.appendChild(k);
            citeLi.appendChild(v);
            memoOutput.appendChild(citeLi);
          }
          if (memoAcceptBtn) memoAcceptBtn.disabled = false;
          if (statusEl) statusEl.textContent = "Credit memo drafted for " + dealCode() + " — awaiting analyst acceptance.";
          loadChronicle();
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  if (memoAcceptBtn) {
    memoAcceptBtn.addEventListener("click", () => {
      fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/memo/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: analystEmail() }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Accept failed: " + (res.data.detail || "error");
            return;
          }
          memoAcceptBtn.disabled = true;
          if (statusEl) statusEl.textContent = "Memo accepted for " + dealCode() + " — routed to policy compliance.";
          loadChronicle();
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  const policyRunBtn = document.getElementById("policy-run-btn");
  if (policyRunBtn) {
    policyRunBtn.addEventListener("click", () => {
      fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/agents/policy-compliance/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acting_user_email: analystEmail() }),
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            if (statusEl) statusEl.textContent = "Policy run failed: " + (res.data.detail || "error");
            return;
          }
          if (policyOutput) {
            policyOutput.replaceChildren();
            const exceptions = res.data.exceptions || [];
            if (!exceptions.length) {
              const li = document.createElement("li");
              const p = document.createElement("p");
              p.textContent = "No open policy exceptions — " + (res.data.findings || []).length + " rule(s) tested.";
              li.appendChild(p);
              policyOutput.appendChild(li);
            }
            exceptions.forEach((exc) => {
              const li = document.createElement("li");
              const rule = document.createElement("span");
              rule.className = "ex-rule";
              rule.textContent = exc.rule_reference + " · policy " + res.data.policy_version + " · open";
              const p = document.createElement("p");
              p.textContent = exc.violation_detail + " " + exc.rationale;
              li.appendChild(rule);
              li.appendChild(p);
              policyOutput.appendChild(li);
            });
          }
          if (statusEl) {
            statusEl.textContent =
              "Policy compliance reviewed for " + dealCode() + " — " + (res.data.exceptions || []).length + " exception(s) raised.";
          }
          loadChronicle();
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Request failed: " + err.message;
        });
    });
  }

  const exportBtn = document.getElementById("chronicle-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/audit")
        .then((r) => (r.ok ? r.json() : { deal_id: dealCode(), entries: [] }))
        .then((data) => {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = data.deal_id + "-audit.json";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          if (statusEl) statusEl.textContent = "Exported " + (data.entries || []).length + " entries for " + data.deal_id + ".";
        })
        .catch((err) => {
          if (statusEl) statusEl.textContent = "Export failed: " + err.message;
        });
    });
  }

  // Load the default deal's chronicle once, on boot.
  loadChronicle();
})();

// --- begin slice tiered-approval-and-sla: SLA dashboard / idle register ---
//   - GET /api/sla/idle renders the idle register, its plates, and the
//     "Idle by Stage" / "Idle by Desk" sidebar tallies
//   - "Reassign selected" / "Nudge owners" call POST
//     /api/deals/{deal_code}/sla-escalate for each checked row
(function sliceTieredApprovalAndSlaModule() {
  const body = document.getElementById("idle-register-body");
  if (!body) return; // this design does not ship the SLA dashboard screen

  function money(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return "$" + (num / 1000000).toFixed(1) + "M";
    return "$" + num.toLocaleString("en-US");
  }

  function fmtDate(iso) {
    if (!iso) return "unknown";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  let lastLoaded = null;

  function selectedDealIds() {
    return Array.from(document.querySelectorAll(".idle-select:checked")).map((el) => el.value);
  }

  function actingEmail() {
    const el = document.getElementById("sla-acting-email");
    return el ? el.value.trim() : "";
  }

  function renderRegister(idleDeals) {
    body.replaceChildren();
    if (!idleDeals.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "No deal is past the five-business-day service line.";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    const longest = idleDeals[0] ? idleDeals[0].business_days_idle : 0;
    idleDeals.forEach((d) => {
      const tr = document.createElement("tr");

      const selTd = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "idle-select";
      cb.value = d.deal_id;
      selTd.appendChild(cb);
      tr.appendChild(selTd);

      const dealTd = document.createElement("td");
      dealTd.className = "deal-cell";
      const b = document.createElement("b");
      b.textContent = d.borrower_name || d.deal_id;
      const small = document.createElement("small");
      small.textContent = d.deal_id;
      dealTd.appendChild(b);
      dealTd.appendChild(small);
      tr.appendChild(dealTd);

      const stageTd = document.createElement("td");
      stageTd.textContent = (d.current_stage || "").replace(/_/g, " ") || "unknown";
      tr.appendChild(stageTd);

      const ownerTd = document.createElement("td");
      ownerTd.textContent = d.escalation_owner || "unassigned";
      tr.appendChild(ownerTd);

      const lastTd = document.createElement("td");
      lastTd.textContent = fmtDate(d.last_activity_timestamp);
      tr.appendChild(lastTd);

      const expTd = document.createElement("td");
      expTd.className = "num";
      expTd.textContent = money(d.exposure_amount);
      tr.appendChild(expTd);

      const idleTd = document.createElement("td");
      idleTd.className = "num";
      const ageBar = document.createElement("span");
      ageBar.className = "age-bar";
      const bar = document.createElement("span");
      bar.className = "bar" + (d.business_days_idle >= 10 ? " warn" : "");
      const px = Math.max(6, Math.min(56, (d.business_days_idle / (longest || 1)) * 56));
      bar.style.width = px + "px";
      ageBar.appendChild(bar);
      ageBar.appendChild(document.createTextNode(d.business_days_idle + "d"));
      idleTd.appendChild(ageBar);
      tr.appendChild(idleTd);

      body.appendChild(tr);
    });
  }

  function renderTally(listId, tally) {
    const ul = document.getElementById(listId);
    if (!ul) return;
    ul.replaceChildren();
    const entries = Object.entries(tally || {});
    if (!entries.length) {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.textContent = "None idle";
      li.appendChild(k);
      li.appendChild(document.createElement("span"));
      ul.appendChild(li);
      return;
    }
    entries.forEach(([key, count]) => {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.textContent = key.replace(/_/g, " ");
      const v = document.createElement("span");
      v.textContent = String(count);
      li.appendChild(k);
      li.appendChild(v);
      ul.appendChild(li);
    });
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function loadSla() {
    return fetch("/api/sla/idle")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        lastLoaded = data;
        renderRegister(data.idle_deals || []);
        renderTally("idle-by-stage-list", data.idle_by_stage);
        renderTally("idle-by-desk-list", data.idle_by_owner);
        const stats = data.stats || {};
        setText("plate-past-line", String(stats.past_service_line_count || 0));
        setText("plate-past-line-caption", "of " + (data.total_active_deals || 0) + " active deals");
        setText("plate-exposure-at-rest", money(stats.exposure_at_rest));
        setText("plate-longest-idle", (stats.longest_idle_business_days || 0) + "d");
        setText(
          "plate-longest-idle-caption",
          stats.longest_idle_deal_id ? stats.longest_idle_deal_id : "no deal past the line"
        );
        setText("plate-approaching-line", String(stats.approaching_service_line_count || 0));
      })
      .catch(() => {});
  }

  function runEscalation(action, note) {
    const status = document.getElementById("sla-action-status");
    const ids = selectedDealIds();
    if (!ids.length) {
      if (status) status.textContent = "Select at least one deal in the register first.";
      return;
    }
    const email = actingEmail();
    if (!email) {
      if (status) status.textContent = "Enter the acting credit officer's email first.";
      return;
    }
    if (status) status.textContent = "Working…";
    Promise.all(
      ids.map((dealId) =>
        fetch("/api/deals/" + encodeURIComponent(dealId) + "/sla-escalate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acting_user_email: email, action: action, note: note }),
        }).then((r) => r.json().then((d) => ({ ok: r.ok, dealId, d })))
      )
    ).then((results) => {
      const failed = results.filter((r) => !r.ok);
      if (status) {
        status.textContent = failed.length
          ? "Failed for " + failed.map((f) => f.dealId).join(", ") + ": " + (failed[0].d.detail || "error")
          : ids.length + " deal(s) " + (action === "reassign" ? "reassigned" : "acknowledged") + ".";
      }
      loadSla();
    });
  }

  const reassignBtn = document.getElementById("sla-reassign-btn");
  if (reassignBtn) {
    reassignBtn.addEventListener("click", () => runEscalation("reassign", "Reassigned from the SLA dashboard."));
  }
  const nudgeBtn = document.getElementById("sla-nudge-btn");
  if (nudgeBtn) {
    nudgeBtn.addEventListener("click", () => runEscalation("acknowledge", "Owner nudged from the SLA dashboard."));
  }

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-sla-dashboard") loadSla();
  });

  loadSla();
})(); // --- end slice tiered-approval-and-sla ---

// ============================================================
// screen-chat: The Portfolio Desk (slice: grounded-portfolio-qa)
//   - #composer submits to POST /api/qa/ask, grounded + permission-scoped
//   - "Standing Questions" shortcuts in the marginalia ask the same way
//   - the manuscript's #messages list renders real answers + their deal-id
//     sources, in the design's own from-user/from-agent markup
//   - the marginalia's "Book at a Glance" tallies read from live server data
// Appended after the foundation module above; nothing above this line is
// modified. Uses textContent (never innerHTML) by policy.
// ============================================================
(function () {
  const messagesList = document.getElementById("messages");
  const originalComposer = document.getElementById("composer");
  if (!messagesList || !originalComposer) return;

  // The scaffold's chat-shell above binds #composer to the generic /chat echo
  // route, which is not this desk's contract. Re-mount the composer node —
  // same markup, same canonical ids (#composer, #input) — so this desk owns
  // its submit handling without editing a byte of the foundation module.
  const composer = originalComposer.cloneNode(true);
  originalComposer.parentNode.replaceChild(composer, originalComposer);
  const questionInput = composer.querySelector("#input") || document.getElementById("input");
  if (!questionInput) return;

  // The masthead's byline ("Desk of M. Okonjo · Senior Credit Officer")
  // names the persona this edition is signed in as — the portfolio desk
  // asks on that officer's behalf.
  const ACTING_USER_EMAIL = "officer@bank.test";

  const pendingLi = messagesList.querySelector(".msg-pending");

  function slugTime() {
    const d = new Date();
    return d.toTimeString().slice(0, 5);
  }

  function appendMessage(kind, buildBody) {
    const li = document.createElement("li");
    li.className = kind === "user" ? "from-user" : "from-agent";
    const slug = document.createElement("span");
    slug.className = "msg-slug";
    const b = document.createElement("b");
    b.textContent = kind === "user" ? "You" : "Agent";
    slug.appendChild(b);
    slug.appendChild(document.createTextNode(slugTime()));
    const body = document.createElement("div");
    body.className = "msg-body";
    buildBody(body);
    li.appendChild(slug);
    li.appendChild(body);
    if (pendingLi) messagesList.insertBefore(li, pendingLi);
    else messagesList.appendChild(li);
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  function appendUserMessage(text) {
    appendMessage("user", (body) => {
      body.textContent = text;
    });
  }

  function appendAgentAnswer(text, sourceDealIds) {
    appendMessage("agent", (body) => {
      const p = document.createElement("p");
      p.textContent = text;
      body.appendChild(p);
      if (sourceDealIds && sourceDealIds.length) {
        const ul = document.createElement("ul");
        ul.className = "msg-sources";
        sourceDealIds.forEach((id) => {
          const li = document.createElement("li");
          li.textContent = id;
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
    });
  }

  function setPending(isPending) {
    if (pendingLi) pendingLi.style.display = isPending ? "" : "none";
  }

  function ask(question) {
    const text = (question || "").trim();
    if (!text) return;
    appendUserMessage(text);
    questionInput.value = "";
    setPending(true);
    fetch("/api/qa/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, acting_user_email: ACTING_USER_EMAIL }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then((res) => {
        setPending(false);
        if (!res.ok) {
          appendAgentAnswer("The desk could not answer that: " + (res.data.detail || "request failed"), []);
          return;
        }
        appendAgentAnswer(res.data.answer, res.data.source_deal_ids || []);
        refreshBookAtAGlance();
      })
      .catch((err) => {
        setPending(false);
        appendAgentAnswer("Request failed: " + err.message, []);
      });
  }

  setPending(false);

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(questionInput.value);
  });

  document.querySelectorAll(".suggested-queries button").forEach((button) => {
    button.addEventListener("click", () => ask(button.textContent));
  });

  // "Book at a Glance" — tallies drawn from the same permission-scoped
  // pipeline data the desk itself reads, refreshed after every answer.
  function setStat(label, value) {
    const notes = document.querySelectorAll(".margin-note h4");
    for (const h4 of notes) {
      if (h4.textContent.trim() !== "The Book at a Glance") continue;
      const items = h4.parentElement.querySelectorAll("li");
      items.forEach((li) => {
        const spans = li.querySelectorAll("span");
        if (spans[0] && spans[0].textContent.trim() === label && spans[1]) {
          spans[1].textContent = value;
        }
      });
    }
  }

  function refreshBookAtAGlance() {
    // Same permission-scoped, server-computed figures the answers are
    // grounded in — the desk never adds up money in the browser.
    fetch("/api/qa/book-summary?acting_user_email=" + encodeURIComponent(ACTING_USER_EMAIL))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setStat("Active deals", String(data.active_deals));
        setStat("Exposure in flight", "$" + Math.round((Number(data.total_exposure) || 0) / 1000).toLocaleString("en-US") + "k");
        setStat("Open exceptions", String(data.open_exception_count));
      })
      .catch(() => {});
  }

  refreshBookAtAGlance();
})();
