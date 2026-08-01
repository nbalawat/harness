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
// Desk identity on reads (foundation).
// The backend read guard is fail-closed: a read that carries no identity
// resolves to the least-privilege board viewer, and its rows come back
// redacted (stage, status and borrower name only — no amounts, owners, grades
// or decline reasons). So the desk UI states who it is on every same-origin
// API read, using the analyst/RM email the operator has entered on the board.
// This is convenience, not authorization: the server still resolves that email
// against stored users and refuses an unknown or deactivated one.
// ============================================================
(function () {
  function deskEmail() {
    for (const id of ["triage-analyst-email", "intake-rm-email"]) {
      const el = document.getElementById(id);
      const value = el ? String(el.value || "").trim() : "";
      if (value) return value;
    }
    return "";
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (resource, init) {
    const url = typeof resource === "string" ? resource : (resource && resource.url) || "";
    const method = String((init && init.method) || (resource && resource.method) || "GET").toUpperCase();
    const email = deskEmail();
    if (email && method === "GET" && url.indexOf("/api/") === 0) {
      const options = Object.assign({}, init);
      options.headers = Object.assign({}, (init && init.headers) || {}, { "X-User-Email": email });
      return nativeFetch(resource, options);
    }
    return nativeFetch(resource, init);
  };

  // The board's first load ran before this block was parsed, so it came back
  // redacted — re-read it now that reads identify the desk.
  document.dispatchEvent(new CustomEvent("screen:shown", { detail: { screen: "screen-pipeline-board" } }));
})();
// SLA dashboard + credit decision desk (slice: tiered-approval-and-sla)
//   - the idle register reads GET /api/sla/idle (business-day arithmetic
//     computed server-side; nothing here invents a number)
//   - approve / decline / return post to the tiered decision endpoints,
//     whose authority checks are enforced on the server
//   - reassign / acknowledge drive POST /api/sla/{deal}/escalate, which runs
//     the sla-idle-escalation workflow end to end
// Every write below reports exactly what the server answered — including a
// refusal — using textContent only.
// ============================================================
(function () {
  const register = document.getElementById("idle-register-body");
  const decisionDesk = document.getElementById("decision-desk");
  if (!register && !decisionDesk) return;

  let idleDeals = [];
  let pendingDecisions = [];

  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function titleCase(value) {
    return String(value || "")
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function shortDate(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "—";
    const d = new Date(t);
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  function textOf(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function valueOf(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function fillDatalist(id, values) {
    const list = document.getElementById(id);
    if (!list) return;
    list.replaceChildren();
    values.forEach((v) => {
      const option = document.createElement("option");
      option.value = v;
      list.appendChild(option);
    });
  }

  function fillCountList(id, counts) {
    const ul = document.getElementById(id);
    if (!ul) return;
    ul.replaceChildren();
    const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = "Nothing past the line";
      const n = document.createElement("span");
      n.textContent = "0";
      li.appendChild(label);
      li.appendChild(n);
      ul.appendChild(li);
      return;
    }
    entries.forEach(([key, count]) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = key.includes("@") ? key : titleCase(key);
      const n = document.createElement("span");
      n.textContent = String(count);
      li.appendChild(label);
      li.appendChild(n);
      ul.appendChild(li);
    });
  }

  function selectDeal(code) {
    const slaField = document.getElementById("sla-deal-code");
    if (slaField) slaField.value = code;
    const decisionField = document.getElementById("decision-deal-code");
    if (decisionField) decisionField.value = code;
    describeAuthority();
  }

  function renderRegister(data) {
    idleDeals = data.deals || [];
    if (register) {
      register.replaceChildren();
      if (!idleDeals.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.textContent = "Nothing is past the service line — every active deal has moved within five business days.";
        tr.appendChild(td);
        register.appendChild(tr);
      }
      const worst = idleDeals.length ? idleDeals[0].business_days_idle || 1 : 1;
      idleDeals.forEach((d) => {
        const tr = document.createElement("tr");
        tr.addEventListener("click", () => selectDeal(d.deal_code));

        const dealCell = document.createElement("td");
        dealCell.className = "deal-cell";
        const name = document.createElement("b");
        name.textContent = d.borrower_name || d.deal_code;
        const code = document.createElement("small");
        code.textContent = d.deal_code;
        dealCell.appendChild(name);
        dealCell.appendChild(code);

        const stage = document.createElement("td");
        stage.textContent = titleCase(d.current_stage);

        const owner = document.createElement("td");
        owner.textContent = d.owner_email || "Unassigned";

        const activity = document.createElement("td");
        activity.textContent = shortDate(d.last_activity_timestamp) + " · " + String(d.current_status || "").replace(/_/g, " ");

        const exposure = document.createElement("td");
        exposure.className = "num";
        exposure.textContent = money(d.exposure_amount);

        const age = document.createElement("td");
        age.className = "num";
        const ageBar = document.createElement("span");
        ageBar.className = "age-bar";
        const bar = document.createElement("span");
        bar.className = d.business_days_idle > 8 ? "bar warn" : "bar";
        bar.style.width = Math.max(12, Math.round((d.business_days_idle / worst) * 56)) + "px";
        ageBar.appendChild(bar);
        ageBar.appendChild(document.createTextNode(String(d.business_days_idle) + "d"));
        age.appendChild(ageBar);

        [dealCell, stage, owner, activity, exposure, age].forEach((td) => tr.appendChild(td));
        register.appendChild(tr);
      });
    }

    const counts = data.counts || {};
    textOf("plate-past-line", String(counts.past_service_line || 0));
    textOf("plate-past-line-caption", "of " + (counts.active_deals || 0) + " active deals");
    textOf("plate-idle-exposure", money(data.idle_exposure));
    textOf("plate-approaching", String(counts.approaching || 0));
    textOf(
      "plate-approaching-caption",
      "idle 3 – " + (data.sla_threshold_business_days || 5) + " business days"
    );
    if (data.longest_idle) {
      textOf("plate-longest", String(data.longest_idle.business_days_idle) + "d");
      textOf(
        "plate-longest-caption",
        data.longest_idle.borrower_name + ", " + titleCase(data.longest_idle.current_stage)
      );
    } else {
      textOf("plate-longest", "—");
      textOf("plate-longest-caption", "nothing past the line");
    }
    fillCountList("idle-by-stage", data.by_stage);
    fillCountList("idle-by-desk", data.by_owner);
    fillDatalist("sla-deal-codes", idleDeals.map((d) => d.deal_code));

    const slaField = document.getElementById("sla-deal-code");
    if (slaField && !slaField.value && idleDeals.length) slaField.value = idleDeals[0].deal_code;
  }

  function loadRegister() {
    return fetch("/api/sla/idle")
      .then((r) => (r.ok ? r.json() : { deals: [], counts: {} }))
      .then(renderRegister)
      .catch(() => {});
  }

  let authorityToken = 0;

  function describeAuthority() {
    const code = valueOf("decision-deal-code");
    if (!code) {
      textOf("decision-authority", "");
      return;
    }
    const deal = pendingDecisions.find((d) => d.deal_code === code);
    if (deal) {
      textOf(
        "decision-authority",
        deal.deal_code +
          " · " +
          deal.borrower_name +
          " · exposure " +
          money(deal.exposure_amount) +
          " · stage " +
          titleCase(deal.current_stage) +
          " · requires " +
          deal.required_authority_level +
          " authority"
      );
      return;
    }
    // Already settled (or filed elsewhere): read its decision record.
    const token = ++authorityToken;
    fetch("/api/deals/" + encodeURIComponent(code) + "/decisions")
      .then((r) => (r.ok ? r.json() : null))
      .then((rec) => {
        if (token !== authorityToken) return;
        if (!rec) {
          textOf("decision-authority", code + " — no such deal on the book.");
          return;
        }
        const settled = (rec.approvals || []).filter((a) => a.decision).slice(-1)[0];
        textOf(
          "decision-authority",
          rec.deal_id +
            " · " +
            rec.borrower_name +
            " · exposure " +
            money(rec.exposure_amount) +
            " · requires " +
            rec.required_authority_level +
            " authority · now at " +
            titleCase(rec.current_stage) +
            " · " +
            rec.current_status +
            (settled ? " (" + settled.decision + " by " + settled.decided_by + ")" : "")
        );
      })
      .catch(() => {});
  }

  function loadTiers() {
    return fetch("/api/approval-tiers")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        pendingDecisions = data.pending_decisions || [];
        fillDatalist("decision-deal-codes", pendingDecisions.map((d) => d.deal_code));
        fillDatalist("decision-reason-codes", (data.adverse_action_reasons || []).map((r) => r.reason_code));
        fillDatalist("decision-return-stages", data.returnable_stages || []);
        describeAuthority();
      })
      .catch(() => {});
  }

  function renderReceipt(rows) {
    const list = document.getElementById("decision-receipt");
    if (!list) return;
    list.replaceChildren();
    rows.forEach(([label, value]) => {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.textContent = label;
      const v = document.createElement("span");
      v.textContent = String(value);
      li.appendChild(k);
      li.appendChild(v);
      list.appendChild(li);
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((data) => ({ ok: r.ok, data })));
  }

  function afterDecision() {
    loadRegister();
    loadTiers();
  }

  const approveBtn = document.getElementById("decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      if (!code) {
        textOf("decision-status", "Name the deal you are deciding.");
        return;
      }
      post("/api/deals/" + encodeURIComponent(code) + "/approve", {
        acting_user_email: valueOf("decision-officer-email"),
        decision_notes: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", res.data.decision],
            ["Deal", res.data.deal_id + " — " + res.data.borrower_name],
            ["Exposure", money(res.data.exposure_amount)],
            ["Authority exercised", res.data.approval_authority_level],
            ["Decided by", res.data.decided_by + " (" + res.data.decided_by_role + ")"],
            ["Notes", res.data.decision_notes || "—"],
            ["Now at", titleCase(res.data.current_stage) + " · " + res.data.current_status],
            ["Idempotency key", res.data.idempotency_key],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id +
              " approved by " +
              res.data.decided_by +
              " under " +
              res.data.approval_authority_level +
              " authority."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const declineBtn = document.getElementById("decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/decline", {
        acting_user_email: valueOf("decision-officer-email"),
        reason_code: valueOf("decision-reason-code"),
        reason_detail: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", res.data.decision],
            ["Deal", res.data.deal_id + " — " + res.data.borrower_name],
            ["Adverse-action code", res.data.adverse_action_reason_code],
            ["Written detail", res.data.adverse_action_detail],
            ["Authority exercised", res.data.approval_authority_level],
            ["Decided by", res.data.decided_by],
            ["Now at", titleCase(res.data.current_stage) + " · " + res.data.current_status],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id + " declined — adverse action " + res.data.adverse_action_reason_code + " issued."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const returnBtn = document.getElementById("decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/return", {
        acting_user_email: valueOf("decision-officer-email"),
        returned_to_stage: valueOf("decision-return-stage"),
        reason: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", "returned"],
            ["Deal", res.data.deal_id],
            ["From", titleCase(res.data.returned_from_stage)],
            ["Back to", titleCase(res.data.returned_to_stage)],
            ["Written reason", res.data.reason],
            ["Returned by", res.data.returned_by],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id + " returned to " + titleCase(res.data.returned_to_stage) + "."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const dealField = document.getElementById("decision-deal-code");
  if (dealField) dealField.addEventListener("input", describeAuthority);

  function escalate(action) {
    const code = valueOf("sla-deal-code");
    if (!code) {
      textOf("sla-action-status", "Pick a deal from the register first.");
      return;
    }
    post("/api/sla/" + encodeURIComponent(code) + "/escalate", {
      acting_user_email: valueOf("sla-officer-email"),
      action: action,
      note: valueOf("sla-note"),
      reassign_to_email: valueOf("sla-reassign-email"),
    })
      .then((res) => {
        if (!res.ok) {
          textOf("sla-action-status", "Refused by the server: " + (res.data.detail || "error"));
          return;
        }
        const blockers = (res.data.blocking_items || []).join("; ");
        textOf(
          "sla-action-status",
          res.data.deal_id +
            " — " +
            res.data.business_days_idle +
            " business days idle · action " +
            res.data.action_taken +
            " · workflow " +
            res.data.status +
            (blockers ? " · blocking: " + blockers : "")
        );
        loadRegister();
      })
      .catch((err) => textOf("sla-action-status", "Request failed: " + err.message));
  }

  const reassignBtn = document.getElementById("sla-reassign-btn");
  if (reassignBtn) reassignBtn.addEventListener("click", () => escalate("reassign"));
  const ackBtn = document.getElementById("sla-acknowledge-btn");
  if (ackBtn) ackBtn.addEventListener("click", () => escalate("acknowledge"));

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-sla-dashboard") {
      loadRegister();
      loadTiers();
    }
  });

  loadRegister();
  loadTiers();
})();
