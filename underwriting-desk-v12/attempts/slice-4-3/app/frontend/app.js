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
