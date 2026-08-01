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

// ============================================================
// Deal dossier (slice: spread-ratios-and-risk-grade)
//   - opens a deal's dossier          (GET  /api/deals/{code}/dossier)
//   - attaches a document + its extract sheet
//                                     (POST /api/deals/{code}/documents)
//   - runs the Financial Spreading Agent
//        (POST /api/deals/{code}/agents/financial-spreading/run)
//   - accepts / edits / rejects the draft
//                                     (POST /api/deals/{code}/spread/accept)
//   - reads the deterministic ratios  (GET  /api/deals/{code}/ratios)
//   - reads the grade and its band    (GET  /api/deals/{code}/risk-grade)
// The memo, policy and decision desks on this screen drive the endpoints the
// later slices of this lifecycle own; each reports plainly when the step it
// needs has not been reached yet.
// ============================================================
(function () {
  const LINE_ITEM_LABELS = {
    revenue: "Revenue",
    adjusted_ebitda: "Adjusted EBITDA",
    interest_expense: "Interest expense",
    current_assets: "Current assets",
    current_liabilities: "Current liabilities",
    total_funded_debt: "Total funded debt",
    annual_debt_service: "Annual debt service",
  };

  let dealCode = null;
  let draft = null;
  let editing = false;

  function el(id) {
    return document.getElementById(id);
  }

  function textOf(id) {
    const node = el(id);
    return node ? String(node.value || "").trim() : "";
  }

  function say(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function money(n) {
    const num = Number(n);
    if (!isFinite(num)) return "—";
    return "$" + num.toLocaleString("en-US");
  }

  function times(n) {
    return n === null || n === undefined ? "not computable" : Number(n).toFixed(2) + "×";
  }

  function label(key) {
    return LINE_ITEM_LABELS[key] || String(key || "").replace(/_/g, " ");
  }

  function citationText(c) {
    if (!c) return "uncited";
    const bits = [c.document_file_name || ("document " + c.document_id)];
    if (c.page_number !== null && c.page_number !== undefined) bits.push("p." + c.page_number);
    if (c.section) bits.push(c.section);
    if (c.cell_locator) bits.push(c.cell_locator);
    return bits.join(" · ");
  }

  function cell(row, text, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text;
    row.appendChild(td);
    return td;
  }

  function api(method, path, body) {
    const options = { method: method, headers: { "Content-Type": "application/json" } };
    if (body) options.body = JSON.stringify(body);
    return fetch(path, options).then((r) =>
      r
        .json()
        .catch(() => ({}))
        .then((data) => ({ ok: r.ok, status: r.status, data: data }))
    );
  }

  function detailOf(res) {
    const d = res.data && res.data.detail;
    if (typeof d === "string") return d;
    if (d) return JSON.stringify(d);
    return "HTTP " + res.status;
  }

  function actor() {
    return textOf("dd-dossier-analyst-email");
  }

  function scoped(path) {
    const email = actor();
    return email ? path + (path.indexOf("?") === -1 ? "?" : "&") + "acting_user_email=" + encodeURIComponent(email) : path;
  }

  // ---------------- rendering ----------------

  function renderHead(deal) {
    say("dd-dossier-borrower", deal.borrower_name || deal.deal_code);
    say(
      "dd-dossier-sub",
      [
        deal.deal_code,
        deal.borrower_industry || "unclassified",
        "stage " + String(deal.current_stage || "intake").replace(/_/g, " "),
        "status " + String(deal.current_status || "open").replace(/_/g, " "),
        deal.risk_grade ? "risk grade " + deal.risk_grade : "ungraded",
      ].join(" · ")
    );
    say("dd-dossier-exposure", money(deal.exposure_amount || deal.requested_amount));
    say("dd-dossier-tier", deal.approval_tier || "");
  }

  function renderDocket(documents, missing) {
    const list = el("dd-docket-list");
    if (!list) return;
    list.replaceChildren();
    documents.forEach((d) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = d.file_name + " · " + String(d.document_type || "").replace(/_/g, " ");
      const state = document.createElement("span");
      state.textContent = (d.line_items || []).length + " line items";
      li.appendChild(name);
      li.appendChild(state);
      list.appendChild(li);
    });
    (missing || []).forEach((type) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = String(type).replace(/_/g, " ");
      const state = document.createElement("span");
      state.className = "missing";
      state.textContent = "missing";
      li.appendChild(name);
      li.appendChild(state);
      list.appendChild(li);
    });
    if (!list.childElementCount) {
      const li = document.createElement("li");
      li.textContent = "No documents attached yet.";
      list.appendChild(li);
    }
  }

  function renderSpreadRows(rows, citationsByKey, editable) {
    const body = el("dd-spread-rows");
    if (!body) return;
    body.replaceChildren();
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label(row.line_item_key);
      tr.appendChild(th);
      cell(tr, row.period || "");
      const valueCell = document.createElement("td");
      valueCell.className = "num";
      if (editable) {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.01";
        input.value = row.value === null || row.value === undefined ? "" : row.value;
        input.dataset.lineItem = row.line_item_key;
        input.dataset.period = row.period || "";
        input.dataset.unit = row.unit || "USD";
        input.className = "spread-edit-input";
        input.style.width = "9rem";
        input.style.textAlign = "right";
        valueCell.appendChild(input);
      } else {
        valueCell.textContent = money(row.value);
      }
      tr.appendChild(valueCell);
      const source = cell(tr, citationText(citationsByKey[row.line_item_key] || row.citation || null));
      source.style.paddingLeft = "1.25rem";
      body.appendChild(tr);
    });
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = "No spread drafted yet — run the Financial Spreading Agent.";
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  function renderUnextractable(items) {
    const list = el("dd-spread-unextractable");
    if (!list) return;
    list.replaceChildren();
    (items || []).forEach((u) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = label(u.line_item_key);
      const why = document.createElement("span");
      why.className = "missing";
      why.textContent = u.reason || "illegible";
      li.appendChild(name);
      li.appendChild(why);
      list.appendChild(li);
    });
    if (!list.childElementCount) {
      const li = document.createElement("li");
      li.textContent = "Nothing was left out.";
      list.appendChild(li);
    }
  }

  function renderCitationRail(rows) {
    const rail = el("dd-citation-rail");
    if (!rail) return;
    rail.replaceChildren();
    rows.forEach((row, index) => {
      const li = document.createElement("li");
      const no = document.createElement("span");
      no.className = "cite-no";
      no.textContent = "[" + (index + 1) + "]";
      const src = document.createElement("span");
      src.className = "cite-src";
      src.textContent = citationText({
        document_file_name: row.document_file_name,
        document_id: row.document_id,
        page_number: row.page_number,
        section: row.section,
        cell_locator: row.cell_locator,
      });
      li.appendChild(no);
      li.appendChild(document.createTextNode(" " + label(row.line_item_key) + " "));
      li.appendChild(src);
      rail.appendChild(li);
    });
    if (!rail.childElementCount) {
      const li = document.createElement("li");
      li.textContent = "Citations appear here once a spread is accepted.";
      rail.appendChild(li);
    }
  }

  function renderRatios(ratios) {
    const body = el("dd-ratios-rows");
    if (!body) return;
    body.replaceChildren();
    const keys = ["dscr", "leverage", "current_ratio"];
    let any = false;
    keys.forEach((key) => {
      const r = ratios && ratios[key];
      if (!r) return;
      any = true;
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = r.label + " ";
      const formula = document.createElement("span");
      formula.className = "formula";
      formula.textContent = r.formula;
      th.appendChild(formula);
      tr.appendChild(th);
      cell(tr, money(r.numerator) + " ÷ " + money(r.denominator));
      cell(tr, times(r.result), "num");
      cell(tr, r.threshold || "", "num");
      body.appendChild(tr);
    });
    if (!any) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = "No ratios yet — they are computed in code the moment a spread is accepted.";
      tr.appendChild(td);
      body.appendChild(tr);
    }
    say(
      "dd-ratios-caption",
      any
        ? "Computed in deterministic code · half-up to two decimals · undefined when a denominator is zero"
        : "Ratios are computed only from an accepted spread"
    );
  }

  function renderGrade(grade) {
    const strip = el("dd-rubric-strip");
    if (!strip) return;
    strip.replaceChildren();
    if (!grade) {
      say("dd-grade-note", "Ungraded. The grade is assigned from the rubric the moment a spread is accepted.");
      strip.setAttribute("aria-label", "No risk grade assigned yet");
      return;
    }
    (grade.rubric || []).forEach((band) => {
      const div = document.createElement("div");
      if (band.is_band_hit) div.className = "hit";
      const name = document.createElement("span");
      name.className = "band";
      name.textContent = band.label;
      div.appendChild(name);
      div.appendChild(document.createTextNode(String(band.grade)));
      strip.appendChild(div);
    });
    strip.setAttribute("aria-label", "Risk grade " + grade.grade + " of 8 on rubric " + grade.rubric_version);
    say("dd-grade-note", grade.rubric_version + " · " + grade.band_hit + ". " + (grade.reasoning || ""));
  }

  function renderMemo(memo) {
    const body = el("dd-memo-body");
    if (!body) return;
    body.replaceChildren();
    if (!memo) {
      const p = document.createElement("p");
      p.className = "dropcap";
      p.textContent =
        "No memo drafted yet. The Credit Memo Agent writes from the accepted spread, the computed ratios and the assigned grade, citing the record behind every assertion.";
      body.appendChild(p);
      say("dd-memo-stamp", "awaiting a run");
      return;
    }
    const sections = memo.sections || [];
    if (sections.length) {
      sections.forEach((section, index) => {
        const heading = document.createElement("p");
        const strong = document.createElement("strong");
        strong.textContent = section.title || section.heading || "Section " + (index + 1);
        heading.appendChild(strong);
        body.appendChild(heading);
        const p = document.createElement("p");
        if (index === 0) p.className = "dropcap";
        p.textContent = section.body || section.content || section.text || "";
        body.appendChild(p);
      });
    } else {
      const p = document.createElement("p");
      p.className = "dropcap";
      p.textContent = memo.memo_content || JSON.stringify(memo);
      body.appendChild(p);
    }
    say("dd-memo-stamp", "drafted");
  }

  function renderExceptions(exceptions) {
    const list = el("dd-exception-list");
    if (!list) return;
    list.replaceChildren();
    (exceptions || []).forEach((e) => {
      const li = document.createElement("li");
      const rule = document.createElement("span");
      rule.className = "ex-rule";
      rule.textContent = [e.rule_reference, e.status || "open"].filter(Boolean).join(" · ");
      const p = document.createElement("p");
      p.textContent = [e.violation_detail, e.rationale].filter(Boolean).join(" — ");
      li.appendChild(rule);
      li.appendChild(p);

      // The design's two exception controls. Only an authorised human may
      // waive; the server decides, never this button.
      const waive = document.createElement("button");
      waive.type = "button";
      waive.className = "btn btn--sm";
      waive.textContent = "Waive with rationale";
      waive.addEventListener("click", () => {
        const rationale = textOf("dd-decision-notes");
        if (!rationale) {
          say("dd-policy-status", "A waiver needs a written rationale — type one in the decision notes below.");
          return;
        }
        stageCall(
          "dd-policy-status",
          "POST",
          "/api/deals/{code}/policy-exceptions/" + encodeURIComponent(e.exception_id) + "/waive",
          { acting_user_email: actor(), rationale: rationale },
          () => say("dd-policy-status", "Exception " + e.rule_reference + " waived, with your name on the record.")
        );
      });

      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn btn--sm btn--quiet";
      back.textContent = "Return to analyst";
      back.addEventListener("click", () => {
        stageCall(
          "dd-policy-status",
          "POST",
          "/api/deals/{code}/return",
          {
            acting_user_email: actor(),
            reason: textOf("dd-decision-notes") || "returned to the analyst over " + e.rule_reference,
          },
          () => say("dd-policy-status", "Returned to the analyst over " + e.rule_reference + ".")
        );
      });

      li.appendChild(waive);
      li.appendChild(back);
      list.appendChild(li);
    });
    if (!list.childElementCount) {
      const li = document.createElement("li");
      const rule = document.createElement("span");
      rule.className = "ex-rule";
      rule.textContent = "no exceptions recorded";
      const p = document.createElement("p");
      p.textContent = "Run the Policy Compliance Agent to test this deal against the active lending ruleset.";
      li.appendChild(rule);
      li.appendChild(p);
      list.appendChild(li);
    }
  }

  function setSpreadButtons(hasDraft, accepted) {
    const accept = el("dd-spread-accept-btn");
    const edit = el("dd-spread-edit-btn");
    const reject = el("dd-spread-reject-btn");
    if (accept) accept.disabled = !hasDraft || accepted;
    if (edit) edit.disabled = !hasDraft || accepted;
    if (reject) reject.disabled = !hasDraft || accepted;
  }

  function renderDossier(d) {
    renderHead(d.deal || {});
    renderDocket(d.documents || [], d.missing_document_types || []);
    const spread = d.spread || {};
    const accepted = spread.accepted_rows || [];
    draft = spread.draft || null;
    editing = false;
    const acceptedReview = spread.review && spread.review.action !== "reject";
    if (accepted.length) {
      const acceptedCitations = {};
      accepted.forEach((row) => {
        acceptedCitations[row.line_item_key] = {
          document_file_name: row.document_file_name,
          page_number: row.page_number,
          section: row.section,
          cell_locator: row.cell_locator,
        };
      });
      renderSpreadRows(accepted, acceptedCitations, false);
      renderCitationRail(accepted);
      say("dd-spread-caption", spread.template_version + " · accepted · every figure cited");
      say("dd-spread-stamp", "accepted");
    } else if (draft) {
      const byKey = {};
      (draft.citations || []).forEach((c) => {
        byKey[c.line_item_key] = c;
      });
      renderSpreadRows(draft.rows || [], byKey, false);
      renderCitationRail([]);
      say("dd-spread-caption", draft.template_version + " · agent draft, awaiting acceptance");
      say("dd-spread-stamp", "drafted, not accepted");
    } else {
      renderSpreadRows([], {}, false);
      renderCitationRail([]);
      say("dd-spread-caption", "Standard spread template · no draft yet");
      say("dd-spread-stamp", "awaiting a run");
    }
    renderUnextractable(draft ? draft.unextractable : []);
    setSpreadButtons(!!draft, !!accepted.length && !!acceptedReview);
    renderRatios(d.ratios);
    renderGrade(d.risk_grade);
    renderMemo(d.memo);
    renderExceptions(d.policy_exceptions);
    const stamp = el("dd-spread-desk");
    if (stamp) stamp.dataset.deal = d.deal ? d.deal.deal_code : "";
  }

  function loadDossier(code) {
    if (!code) {
      say("dd-dossier-status", "Enter a deal id to open its dossier.");
      return Promise.resolve();
    }
    return api("GET", scoped("/api/deals/" + encodeURIComponent(code) + "/dossier")).then((res) => {
      if (!res.ok) {
        say("dd-dossier-status", "Could not open " + code + ": " + detailOf(res));
        return;
      }
      dealCode = code;
      renderDossier(res.data);
      say("dd-dossier-status", "Dossier " + code + " open, read live from the server.");
    });
  }

  function loadDealList() {
    return api("GET", "/api/pipeline").then((res) => {
      const list = el("dd-dossier-deal-list");
      if (!list || !res.ok) return;
      list.replaceChildren();
      (res.data.deals || []).forEach((d) => {
        const option = document.createElement("option");
        option.value = d.deal_code;
        option.textContent = d.borrower_name || "";
        list.appendChild(option);
      });
    });
  }

  function loadDeclineReasons() {
    return api("GET", "/api/adverse_action_reasons").then((res) => {
      const list = el("dd-decision-reason-list");
      if (!list || !res.ok || !Array.isArray(res.data)) return;
      list.replaceChildren();
      res.data.forEach((r) => {
        const option = document.createElement("option");
        option.value = r.reason_code;
        option.textContent = r.reason_label || "";
        list.appendChild(option);
      });
    });
  }

  // ---------------- actions ----------------

  const openForm = el("dd-dossier-open-form");
  if (openForm) {
    openForm.addEventListener("submit", (event) => {
      event.preventDefault();
      loadDossier(textOf("dd-dossier-deal-code"));
    });
  }

  const attachForm = el("dd-document-attach-form");
  if (attachForm) {
    attachForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!dealCode) {
        say("dd-document-status", "Open a dossier first.");
        return;
      }
      const figures = textOf("dd-document-figures")
        .split("\n")
        .map((line) => line.split("|").map((part) => part.trim()))
        .filter((parts) => parts.length && parts[0])
        .map((parts) => ({
          line_item_key: parts[0],
          period: parts[1] || "FY2025",
          value: parts[2] === undefined || parts[2] === "" ? null : Number(parts[2]),
          unit: parts[3] || "USD",
          page_number: parts[4] ? Number(parts[4]) : null,
          section: parts[5] || null,
          cell_locator: parts[6] || null,
          quoted_text: parts.slice(0, 3).join(" "),
        }));
      api("POST", "/api/deals/" + encodeURIComponent(dealCode) + "/documents", {
        acting_user_email: actor(),
        document_type: textOf("dd-document-type"),
        file_name: textOf("dd-document-file-name"),
        figures: figures,
      }).then((res) => {
        if (!res.ok) {
          say("dd-document-status", "Could not attach: " + detailOf(res));
          return;
        }
        say(
          "dd-document-status",
          "Attached " +
            res.data.document.file_name +
            (res.data.documents_complete
              ? " — the required pack is complete."
              : " — still missing: " + (res.data.missing_document_types || []).join(", "))
        );
        loadDossier(dealCode);
      });
    });
  }

  const runBtn = el("dd-spread-run-btn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      const code = dealCode || textOf("dd-dossier-deal-code");
      if (!code) {
        say("dd-spread-status", "Open a dossier first.");
        return;
      }
      say("dd-spread-status", "Transcribing from the attached documents…");
      api("POST", "/api/deals/" + encodeURIComponent(code) + "/agents/financial-spreading/run", {
        acting_user_email: actor(),
      }).then((res) => {
        if (!res.ok) {
          say("dd-spread-status", "Spreading failed: " + detailOf(res));
          return;
        }
        dealCode = code;
        draft = res.data;
        editing = false;
        const byKey = {};
        (draft.citations || []).forEach((c) => {
          byKey[c.line_item_key] = c;
        });
        renderSpreadRows(draft.rows || [], byKey, false);
        renderUnextractable(draft.unextractable);
        say("dd-spread-caption", draft.template_version + " · agent draft, awaiting acceptance");
        say("dd-spread-stamp", "drafted, not accepted");
        setSpreadButtons(true, false);
        say(
          "dd-spread-status",
          (draft.rows || []).length +
            " line items transcribed, every one cited to a document and locator; " +
            (draft.unextractable || []).length +
            " left out as unreadable. An analyst must accept before anything is written to the template."
        );
      });
    });
  }

  const editBtn = el("dd-spread-edit-btn");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      if (!draft) return;
      editing = !editing;
      const byKey = {};
      (draft.citations || []).forEach((c) => {
        byKey[c.line_item_key] = c;
      });
      renderSpreadRows(draft.rows || [], byKey, editing);
      editBtn.textContent = editing ? "Cancel edit" : "Edit before accepting";
      const accept = el("dd-spread-accept-btn");
      if (accept) accept.textContent = editing ? "Accept edited spread" : "Accept draft";
      say(
        "dd-spread-status",
        editing
          ? "Editing the draft. Only line items the agent cited may be accepted — an edited figure keeps its citation."
          : "Edit cancelled; the agent's transcription is restored."
      );
    });
  }

  function submitReview(action, body) {
    const code = dealCode || textOf("dd-dossier-deal-code");
    if (!code) return;
    api("POST", "/api/deals/" + encodeURIComponent(code) + "/spread/accept", body).then((res) => {
      if (!res.ok) {
        say("dd-spread-status", "Could not " + action + ": " + detailOf(res));
        return;
      }
      say("dd-spread-status", res.data.message || "Recorded.");
      loadDossier(code);
    });
  }

  const acceptBtn = el("dd-spread-accept-btn");
  if (acceptBtn) {
    acceptBtn.addEventListener("click", () => {
      if (!editing) {
        submitReview("accept", { acting_user_email: actor(), action: "accept" });
        return;
      }
      const edited = Array.from(document.querySelectorAll(".spread-edit-input")).map((input) => ({
        line_item_key: input.dataset.lineItem,
        period: input.dataset.period,
        value: input.value === "" ? null : Number(input.value),
        unit: input.dataset.unit || "USD",
      }));
      submitReview("accept the edit", { acting_user_email: actor(), action: "edit", edited_rows: edited });
    });
  }

  const rejectBtn = el("dd-spread-reject-btn");
  if (rejectBtn) {
    rejectBtn.addEventListener("click", () => {
      const reason = textOf("dd-spread-reject-reason");
      if (!reason) {
        say("dd-spread-status", "A rejected spread needs a written reason — type one beside these buttons.");
        return;
      }
      submitReview("reject", { acting_user_email: actor(), action: "reject", rejection_reason: reason });
    });
  }

  // ---- memo, policy and decision desks: later stages of the same dossier ----

  function stageCall(statusId, method, path, body, done) {
    const code = dealCode || textOf("dd-dossier-deal-code");
    if (!code) {
      say(statusId, "Open a dossier first.");
      return;
    }
    api(method, path.replace("{code}", encodeURIComponent(code)), body).then((res) => {
      if (!res.ok) {
        say(statusId, detailOf(res));
        return;
      }
      if (done) done(res.data);
      loadDossier(code);
    });
  }

  const memoRun = el("dd-memo-run-btn");
  if (memoRun) {
    memoRun.addEventListener("click", () => {
      say("dd-memo-status", "Drafting the memo from the accepted spread, ratios and grade…");
      stageCall("dd-memo-status", "POST", "/api/deals/{code}/agents/credit-memo/run", { acting_user_email: actor() }, () =>
        say("dd-memo-status", "Draft ready — it cites the ratios, spread lines and rules it relied on. Accept or reject it.")
      );
    });
  }

  const memoAccept = el("dd-memo-accept-btn");
  if (memoAccept) {
    memoAccept.addEventListener("click", () => {
      stageCall(
        "dd-memo-status",
        "POST",
        "/api/deals/{code}/memo/accept",
        { acting_user_email: actor(), action: "accept" },
        () => say("dd-memo-status", "Memo accepted; your name and the time are on the record.")
      );
    });
  }

  const memoReject = el("dd-memo-reject-btn");
  if (memoReject) {
    memoReject.addEventListener("click", () => {
      const reason = textOf("dd-decision-notes") || "returned to the agent for redrafting";
      stageCall(
        "dd-memo-status",
        "POST",
        "/api/deals/{code}/memo/accept",
        { acting_user_email: actor(), action: "reject", rejection_reason: reason },
        () => say("dd-memo-status", "Memo rejected — nothing was recorded as accepted.")
      );
    });
  }

  const policyRun = el("dd-policy-run-btn");
  if (policyRun) {
    policyRun.addEventListener("click", () => {
      say("dd-policy-status", "Testing the deal against the active lending ruleset…");
      stageCall(
        "dd-policy-status",
        "POST",
        "/api/deals/{code}/agents/policy-compliance/run",
        { acting_user_email: actor() },
        (data) =>
          say(
            "dd-policy-status",
            (data.exceptions || []).length + " exception(s) written against policy " + (data.policy_version || "")
          )
      );
    });
  }

  const approveBtn = el("dd-decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      stageCall(
        "dd-decision-status",
        "POST",
        "/api/deals/{code}/approve",
        { acting_user_email: actor(), decision_notes: textOf("dd-decision-notes") },
        (data) => say("dd-decision-status", "Approved by " + (data.approved_by || actor()) + ".")
      );
    });
  }

  const declineBtn = el("dd-decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const code = textOf("dd-decision-reason-code");
      if (!code) {
        say("dd-decision-status", "A decline needs a controlled adverse-action reason code.");
        return;
      }
      stageCall(
        "dd-decision-status",
        "POST",
        "/api/deals/{code}/decline",
        { acting_user_email: actor(), reason_code: code, reason_detail: textOf("dd-decision-notes") },
        () => say("dd-decision-status", "Declined with adverse-action reason " + code + ".")
      );
    });
  }

  const returnBtn = el("dd-decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      stageCall(
        "dd-decision-status",
        "POST",
        "/api/deals/{code}/return",
        { acting_user_email: actor(), reason: textOf("dd-decision-notes") || "returned for further work" },
        () => say("dd-decision-status", "Returned to an earlier stage with your written reason.")
      );
    });
  }

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-deal-detail") {
      loadDealList();
      loadDeclineReasons();
      loadDossier(dealCode || textOf("dd-dossier-deal-code"));
    }
  });

  loadDealList();
  loadDeclineReasons();
  loadDossier(textOf("dd-dossier-deal-code"));
})();
// The Chronicle — memo, policy and the per-deal audit timeline
// (slice: memo-policy-and-audit-trail)
//   - runs the Credit Memo Agent and accepts its draft
//     (POST /api/deals/{id}/agents/credit-memo/run, /memo/accept)
//   - runs the Policy Compliance Agent and records its exceptions
//     (POST /api/deals/{id}/agents/policy-compliance/run, /policy-review/accept)
//   - waives or upholds an exception with a written rationale
//     (POST /api/deals/{id}/policy-exceptions/resolve)
//   - renders the append-only chronicle (GET /api/deals/{id}/audit)
// Everything below writes with textContent, never innerHTML.
// ============================================================
(function () {
  const dealSelect = document.getElementById("chronicle-deal");
  const list = document.getElementById("chronicle-list");
  if (!dealSelect || !list) return;

  const FIXTURE_DEAL = "DEAL-1003";
  const KIND_LABEL = {
    human_decision: "Human decision",
    agent_draft: "Agent draft",
    calculation: "Deterministic calculation",
    state_change: "State change",
  };
  const KIND_CLASS = {
    human_decision: "by-human",
    agent_draft: "by-agent",
    calculation: "by-system",
    state_change: "by-system",
  };
  const ACTION_TITLE = {
    "deal.intake_submitted": "Deal filed at intake",
    "triage.agent_run": "Intake triage drafted",
    "deal.triage_accepted_and_routed": "Triage accepted — deal routed to a queue",
    "spread.accepted": "Financial spread accepted",
    "ratios.computed": "Ratios computed — deterministic",
    "grade.assigned": "Risk grade assigned — deterministic",
    "memo.agent_drafted": "Credit memo drafted",
    "memo.accepted": "Credit memo accepted",
    "memo.rejected": "Credit memo draft rejected",
    "policy.agent_reviewed": "Policy compliance review completed",
    "policy.exceptions_recorded": "Policy exceptions recorded",
    "policy.exceptions_resolved": "Policy exception dispositioned",
  };

  let entries = [];
  let activeKind = "all";
  // `ready` resolves once the deal picker has been filled from the server, so a
  // click that lands before the first load still acts on a real deal code.
  let ready = Promise.resolve();
  let pendingMemoRun = Promise.resolve();
  let pendingPolicyRun = Promise.resolve();

  function dealCode() {
    return dealSelect.value;
  }

  function analystEmail() {
    const el = document.getElementById("chronicle-analyst-email");
    return el ? el.value.trim() : "";
  }

  function officerEmail() {
    const el = document.getElementById("chronicle-officer-email");
    return el ? el.value.trim() : "";
  }

  function say(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function brief(payload, limit) {
    if (payload === null || payload === undefined) return "";
    let text;
    if (typeof payload === "object") {
      text = Object.keys(payload)
        .map((k) => k + ": " + (typeof payload[k] === "object" ? JSON.stringify(payload[k]) : String(payload[k])))
        .join(" · ");
    } else {
      text = String(payload);
    }
    const cap = limit || 220;
    return text.length > cap ? text.slice(0, cap) + "…" : text;
  }

  // A chronicle entry reads as a sentence, not as a payload dump. The server
  // never sends a raw audit payload body — `entry.before` / `entry.after` are
  // its derived, scalar-only summaries — so this only ever renders a summary.
  function summarise(entry) {
    const a = entry.after || {};
    const list = (v) => (Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v));
    switch (entry.action) {
      case "memo.agent_drafted":
        return (
          a.agent + " drafted " + a.section_count + " sections carrying " + a.citation_count +
          " citations in " + a.latency_ms + " ms — every figure copied from a stored record, none recomputed."
        );
      case "memo.accepted":
        return (
          "Memo accepted by " + (a.accepted_by || "a named analyst") + " and stored with " +
          (a.citation_count || 0) + " citations; the deal moved to " + a.current_stage + "."
        );
      case "memo.rejected":
        return (
          "Draft rejected by " + (a.rejected_by || "a named analyst") +
          " with a written reason held on the review record."
        );
      case "policy.agent_reviewed":
        return (
          a.agent + " tested " + ((a.rules_tested || []).length) + " rules of lending policy " + a.policy_version +
          " — breached: " + (list(a.breached) || "none") + "."
        );
      case "policy.exceptions_recorded":
        return (
          "Exceptions " + list(a.exception_refs) + " written up under policy " + a.policy_version +
          "; " + a.open_exception_count + " now open and blocking approval."
        );
      case "policy.exceptions_resolved":
        return (
          "Dispositioned by " + (a.resolved_by || "an officer") + ": " +
          (list(a.dispositions) || list(a.resolved_exception_refs)) +
          "; " + a.open_exception_count + " still open."
        );
      case "ratios.computed":
        return (
          "DSCR " + a.dscr + ", leverage " + a.leverage + ", current ratio " + a.current_ratio +
          " — " + a.rounding_method + ", computed in code with no model involved."
        );
      case "grade.assigned":
        return "Grade " + a.grade + " struck under rubric " + a.rubric_version + ", band " + a.band_hit + ".";
      case "spread.accepted":
        return a.line_items + " line items accepted on template " + a.template_version + ", each carrying a document locator.";
      default:
        return (
          entry.summary ||
          brief(entry.after) ||
          brief(entry.before) ||
          (entry.resource_type ? entry.resource_type + " " + entry.resource_id : "recorded")
        );
    }
  }

  function stamp(iso) {
    const d = new Date(iso || "");
    if (isNaN(d.getTime())) return { day: "—", time: "" };
    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    const time =
      String(d.getUTCHours()).padStart(2, "0") +
      ":" +
      String(d.getUTCMinutes()).padStart(2, "0") +
      ":" +
      String(d.getUTCSeconds()).padStart(2, "0");
    return { day: day + " " + month, time: time };
  }

  function renderChronicle() {
    const shown = entries.filter((e) => activeKind === "all" || e.entry_kind === activeKind);
    list.replaceChildren();
    shown
      .slice()
      .reverse()
      .forEach((entry) => {
        const li = document.createElement("li");
        li.className = KIND_CLASS[entry.entry_kind] || "by-system";

        const when = document.createElement("div");
        when.className = "entry-when";
        const day = document.createElement("b");
        const marks = stamp(entry.timestamp);
        day.textContent = marks.day;
        const seq = document.createElement("span");
        seq.className = "seq";
        seq.textContent = "Entry " + entry.seq;
        when.appendChild(day);
        when.appendChild(document.createTextNode(marks.time));
        when.appendChild(seq);

        const spine = document.createElement("div");
        spine.className = "entry-spine";
        spine.setAttribute("aria-hidden", "true");

        const body = document.createElement("div");
        body.className = "entry-body";

        const title = document.createElement("h4");
        title.textContent = ACTION_TITLE[entry.action] || entry.action.replace(/[._]/g, " ");
        body.appendChild(title);

        const actor = document.createElement("span");
        actor.className = "actor";
        const who = entry.agent_draft
          ? entry.agent_draft
          : (entry.actor_name || "System") + (entry.actor_role ? " · " + entry.actor_role.replace(/_/g, " ") : "");
        actor.textContent = who + " · " + (KIND_LABEL[entry.entry_kind] || entry.entry_kind);
        body.appendChild(actor);

        const detail = document.createElement("p");
        detail.textContent = summarise(entry);
        body.appendChild(detail);

        // The before/after delta is printed only where there is a real state
        // transition to show; otherwise the sentence above already says it.
        if (entry.before && Object.keys(entry.before).length) {
          const delta = document.createElement("span");
          delta.className = "delta";
          const was = document.createElement("span");
          was.className = "was";
          was.textContent = brief(entry.before, 80);
          delta.appendChild(was);
          delta.appendChild(document.createTextNode(" → "));
          const now = document.createElement("span");
          now.className = "now";
          now.textContent = brief(entry.after, 100) || "recorded";
          delta.appendChild(now);
          body.appendChild(delta);
        }

        const seal = document.createElement("span");
        seal.className = "seal";
        seal.textContent = "sealed";
        body.appendChild(seal);

        li.appendChild(when);
        li.appendChild(spine);
        li.appendChild(body);
        list.appendChild(li);
      });

    const empty = document.getElementById("chronicle-empty");
    if (empty) {
      empty.textContent = shown.length
        ? "Showing " + shown.length + " of " + entries.length + " entries — oldest at the foot."
        : "No entries of this kind on " + dealCode() + " yet.";
    }
  }

  function loadChronicle() {
    const code = dealCode();
    if (!code) return Promise.resolve();
    return fetch("/api/deals/" + encodeURIComponent(code) + "/audit?acting_user_email=" + encodeURIComponent(analystEmail()))
      .then((r) => (r.ok ? r.json() : { entries: [], counts: {} }))
      .then((data) => {
        entries = data.entries || [];
        const counts = data.counts || {};
        ["all", "human_decision", "agent_draft", "calculation", "state_change"].forEach((k) => {
          const el = document.getElementById("chr-count-" + k);
          if (el) el.textContent = String(counts[k] || 0);
        });
        say(
          "chronicle-meta",
          code + " · " + (counts.all || 0) + " entries · nothing amended, nothing removed"
        );
        renderChronicle();
      })
      .catch(() => {});
  }

  // ---------- credit memo ----------
  function renderMemo(memo) {
    const out = document.getElementById("memo-output");
    if (!out) return;
    out.replaceChildren();
    if (!memo || !memo.sections) return;
    memo.sections.forEach((section, index) => {
      const li = document.createElement("li");
      const no = document.createElement("span");
      no.className = "cite-no";
      no.textContent = "§" + (index + 1) + " " + section.heading;
      const text = document.createElement("span");
      text.textContent = " " + section.body;
      const src = document.createElement("span");
      src.className = "cite-src";
      src.textContent = "cites: " + (section.citations || []).join(", ");
      li.appendChild(no);
      li.appendChild(text);
      li.appendChild(src);
      out.appendChild(li);
    });
  }

  function loadMemo() {
    const code = dealCode();
    if (!code) return Promise.resolve();
    return fetch("/api/deals/" + encodeURIComponent(code) + "/memo?acting_user_email=" + encodeURIComponent(analystEmail()))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const memo = data.accepted || data.draft;
        renderMemo(memo);
        if (data.status === "accepted" || data.status === "accepted_with_edits") {
          say("memo-status", "Memo accepted by a named analyst and stored with its citations.");
        } else if (data.status === "proposed") {
          say("memo-status", "Draft standing — an analyst must accept it before it is stored.");
        } else {
          say("memo-status", "No memo drafted for this deal yet.");
        }
      })
      .catch(() => {});
  }

  const memoRunBtn = document.getElementById("memo-run-btn");
  if (memoRunBtn) {
    memoRunBtn.addEventListener("click", () => {
      say("memo-status", "Credit Memo Agent drafting from the accepted spread, ratios and grade…");
      pendingMemoRun = ready
        .then(() =>
          fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/agents/credit-memo/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ acting_user_email: analystEmail() }),
          })
        )
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            say("memo-status", "Memo draft refused: " + (res.data.detail || "error"));
            return;
          }
          renderMemo(res.data);
          say(
            "memo-status",
            "Draft in " +
              res.data.sections.length +
              " sections with " +
              res.data.citations.length +
              " citations — every figure copied from a stored record. An analyst must accept it."
          );
          return loadChronicle();
        })
        .catch((err) => say("memo-status", "Request failed: " + err.message));
    });
  }

  const memoAcceptBtn = document.getElementById("memo-accept-btn");
  if (memoAcceptBtn) {
    memoAcceptBtn.addEventListener("click", () => {
      pendingMemoRun = pendingMemoRun
        .then(() =>
          fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/memo/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ acting_user_email: analystEmail(), action: "accept" }),
          })
        )
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            say("memo-status", "Accept refused: " + (res.data.detail || "error"));
            return;
          }
          say(
            "memo-status",
            "Memo accepted by " + analystEmail() + " — stored with " + res.data.citation_ids.length + " citations; deal now in " + res.data.current_stage + "."
          );
          return Promise.all([loadMemo(), loadChronicle()]);
        })
        .catch((err) => say("memo-status", "Request failed: " + err.message));
    });
  }

  // ---------- policy compliance ----------
  function renderFindings(findings) {
    const out = document.getElementById("policy-output");
    if (!out) return;
    out.replaceChildren();
    (findings || []).forEach((finding) => {
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.textContent = finding.rule_reference + " — " + finding.detail;
      if (finding.status === "breached") left.className = "missing";
      const right = document.createElement("span");
      right.className = "flag " + (finding.status === "breached" ? "flag--idle" : finding.status === "passed" ? "flag--ok" : "flag--await");
      right.textContent = finding.status;
      li.appendChild(left);
      li.appendChild(right);
      out.appendChild(li);
    });
  }

  function renderExceptions(data) {
    const out = document.getElementById("exceptions-list");
    if (!out) return;
    out.replaceChildren();
    const rows = (data && data.exceptions) || [];
    if (!rows.length) {
      const li = document.createElement("li");
      li.textContent = "No policy exceptions on this deal.";
      out.appendChild(li);
      return;
    }
    rows.forEach((row) => {
      const li = document.createElement("li");
      li.style.flexDirection = "column";
      li.style.alignItems = "flex-start";

      const head = document.createElement("span");
      head.textContent = (row.exception_ref ? row.exception_ref + " · " : "") + row.rule_reference + " — " + row.violation_detail;
      if (row.status === "open" || row.status === "proposed") head.className = "missing";
      li.appendChild(head);

      const why = document.createElement("span");
      why.className = "cite-src";
      why.textContent = "rationale: " + (row.rationale || "—");
      li.appendChild(why);

      const tags = document.createElement("span");
      tags.className = "flag " + (row.status === "waived" ? "flag--ok" : row.status === "open" ? "flag--idle" : "flag--await");
      tags.textContent = row.status + " · " + row.origin;
      li.appendChild(tags);

      if (row.origin === "recorded" && row.status === "open") {
        const bar = document.createElement("span");
        bar.style.display = "flex";
        bar.style.gap = ".4rem";
        bar.style.marginTop = ".4rem";
        bar.style.flexWrap = "wrap";

        const rationale = document.createElement("input");
        rationale.type = "text";
        rationale.placeholder = "written rationale (required)";
        rationale.style.flex = "1 1 22rem";
        rationale.id = "waive-rationale-" + row.exception_ref;
        // Deliberately NOT pre-filled: the rationale must be the officer's own
        // words, and the server rejects a blank one.

        const waive = document.createElement("button");
        waive.type = "button";
        waive.className = "btn btn--sm btn--ink";
        waive.id = "waive-btn-" + row.exception_ref;
        waive.textContent = "Waive";
        waive.addEventListener("click", () => dispose(row.exception_ref, "waive", rationale.value));

        const uphold = document.createElement("button");
        uphold.type = "button";
        uphold.className = "btn btn--sm btn--quiet";
        uphold.id = "uphold-btn-" + row.exception_ref;
        uphold.textContent = "Uphold";
        uphold.addEventListener("click", () => dispose(row.exception_ref, "uphold", rationale.value));

        bar.appendChild(rationale);
        bar.appendChild(waive);
        bar.appendChild(uphold);
        li.appendChild(bar);
      }
      out.appendChild(li);
    });
  }

  function dispose(ref, disposition, rationale) {
    const code = dealCode();
    fetch("/api/deals/" + encodeURIComponent(code) + "/policy-exceptions/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        acting_user_email: officerEmail(),
        decisions: [{ exception_ref: ref, disposition: disposition, rationale: rationale }],
      }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then((res) => {
        if (!res.ok) {
          say("exceptions-status", "Refused: " + (res.data.detail || "error"));
          return;
        }
        say(
          "exceptions-status",
          ref + " " + (disposition === "waive" ? "waived" : "upheld") + " by " + officerEmail() + " — " + res.data.open_exception_count + " still open."
        );
        return Promise.all([loadExceptions(), loadChronicle()]);
      })
      .catch((err) => say("exceptions-status", "Request failed: " + err.message));
  }

  function loadExceptions() {
    const code = dealCode();
    if (!code) return Promise.resolve();
    return fetch("/api/deals/" + encodeURIComponent(code) + "/policy-exceptions?acting_user_email=" + encodeURIComponent(analystEmail()))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => renderExceptions(data))
      .catch(() => {});
  }

  const policyRunBtn = document.getElementById("policy-run-btn");
  if (policyRunBtn) {
    policyRunBtn.addEventListener("click", () => {
      say("policy-status", "Testing the deal against the active lending ruleset…");
      pendingPolicyRun = Promise.all([ready, pendingMemoRun])
        .then(() =>
          fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/agents/policy-compliance/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ acting_user_email: analystEmail() }),
          })
        )
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            say("policy-status", "Compliance review refused: " + (res.data.detail || "error"));
            return;
          }
          renderFindings(res.data.findings);
          say(
            "policy-status",
            "Policy " +
              res.data.policy_version +
              ": " +
              res.data.findings.length +
              " rules tested, " +
              res.data.exceptions.length +
              " breach(es) proposed — a human must record them."
          );
          return Promise.all([loadExceptions(), loadChronicle()]);
        })
        .catch((err) => say("policy-status", "Request failed: " + err.message));
    });
  }

  const policyAcceptBtn = document.getElementById("policy-accept-btn");
  if (policyAcceptBtn) {
    policyAcceptBtn.addEventListener("click", () => {
      pendingPolicyRun = pendingPolicyRun
        .then(() =>
          fetch("/api/deals/" + encodeURIComponent(dealCode()) + "/policy-review/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ acting_user_email: analystEmail() }),
          })
        )
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => {
          if (!res.ok) {
            say("policy-status", "Recording refused: " + (res.data.detail || "error"));
            return;
          }
          say(
            "policy-status",
            res.data.exception_ids.length +
              " exception(s) recorded on policy " +
              res.data.policy_version +
              " — " +
              res.data.open_exception_count +
              " open and blocking approval."
          );
          return Promise.all([loadExceptions(), loadChronicle()]);
        })
        .catch((err) => say("policy-status", "Request failed: " + err.message));
    });
  }

  // ---------- filters + export ----------
  Array.from(document.querySelectorAll("#chronicle-filters button")).forEach((button) => {
    button.addEventListener("click", () => {
      activeKind = button.dataset.kind;
      document.querySelectorAll("#chronicle-filters button").forEach((b) => {
        b.setAttribute("aria-pressed", b === button ? "true" : "false");
      });
      renderChronicle();
    });
  });

  const exportBtn = document.getElementById("chronicle-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const payload = JSON.stringify({ deal_id: dealCode(), append_only: true, entries: entries }, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = dealCode() + "-audit-trail.json";
      anchor.click();
      URL.revokeObjectURL(url);
      say("chronicle-meta", dealCode() + " · " + entries.length + " entries exported for audit");
    });
  }

  // ---------- deal picker ----------
  function refreshAll() {
    return Promise.all([loadMemo(), loadExceptions(), loadChronicle()]);
  }

  dealSelect.addEventListener("change", () => {
    say("memo-status", "No memo drafted for this deal yet.");
    say("policy-status", "No compliance review run for this deal yet.");
    say("exceptions-status", "");
    const out = document.getElementById("policy-output");
    if (out) out.replaceChildren();
    refreshAll();
  });

  function loadDeals() {
    return fetch("/api/pipeline")
      .then((r) => (r.ok ? r.json() : { deals: [] }))
      .then((data) => {
        const deals = data.deals || [];
        const previous = dealSelect.value;
        dealSelect.replaceChildren();
        deals.forEach((deal) => {
          const option = document.createElement("option");
          option.value = deal.deal_code;
          option.textContent = deal.deal_code + " · " + (deal.borrower_name || "");
          dealSelect.appendChild(option);
        });
        const preferred = deals.some((d) => d.deal_code === previous)
          ? previous
          : deals.some((d) => d.deal_code === FIXTURE_DEAL)
          ? FIXTURE_DEAL
          : deals.length
          ? deals[0].deal_code
          : "";
        dealSelect.value = preferred;
        return refreshAll();
      })
      .catch(() => {});
  }

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-audit-timeline") {
      ready = loadDeals();
    }
  });

  ready = loadDeals();
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
  const register = document.getElementById("sla-idle-register-body");
  const decisionDesk = document.getElementById("sla-decision-desk");
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
    const decisionField = document.getElementById("sla-decision-deal-code");
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
    textOf("sla-plate-past-line", String(counts.past_service_line || 0));
    textOf("sla-plate-past-line-caption", "of " + (counts.active_deals || 0) + " active deals");
    textOf("sla-plate-idle-exposure", money(data.idle_exposure));
    textOf("sla-plate-approaching", String(counts.approaching || 0));
    textOf(
      "sla-plate-approaching-caption",
      "idle 3 – " + (data.sla_threshold_business_days || 5) + " business days"
    );
    if (data.longest_idle) {
      textOf("sla-plate-longest", String(data.longest_idle.business_days_idle) + "d");
      textOf(
        "sla-plate-longest-caption",
        data.longest_idle.borrower_name + ", " + titleCase(data.longest_idle.current_stage)
      );
    } else {
      textOf("sla-plate-longest", "—");
      textOf("sla-plate-longest-caption", "nothing past the line");
    }
    fillCountList("sla-idle-by-stage", data.by_stage);
    fillCountList("sla-idle-by-desk", data.by_owner);
    fillDatalist("sla-deal-codes", idleDeals.map((d) => d.deal_code));

    const slaField = document.getElementById("sla-deal-code");
    if (slaField && !slaField.value && idleDeals.length) slaField.value = idleDeals[0].deal_code;
  }

  // Every read on this screen names the desk it is reading as. The backend
  // read guards are fail-closed: without an identity the idle register comes
  // back redacted (no exposures, no owning desks) and the decision record and
  // approval queue are refused outright. This is convenience, not
  // authorization — the server still resolves the email and refuses an unknown
  // or deactivated one.
  function asWho() {
    return valueOf("sla-officer-email") || valueOf("sla-decision-officer-email");
  }

  function scoped(path) {
    const email = asWho();
    if (!email) return path;
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "acting_user_email=" + encodeURIComponent(email);
  }

  function loadRegister() {
    return fetch(scoped("/api/sla/idle"))
      .then((r) => (r.ok ? r.json() : { deals: [], counts: {} }))
      .then(renderRegister)
      .catch(() => {});
  }

  let authorityToken = 0;

  function describeAuthority() {
    const code = valueOf("sla-decision-deal-code");
    if (!code) {
      textOf("sla-decision-authority", "");
      return;
    }
    const deal = pendingDecisions.find((d) => d.deal_code === code);
    if (deal) {
      textOf(
        "sla-decision-authority",
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
    fetch(scoped("/api/deals/" + encodeURIComponent(code) + "/decisions"))
      .then((r) => (r.ok ? r.json() : null))
      .then((rec) => {
        if (token !== authorityToken) return;
        if (!rec) {
          textOf("sla-decision-authority", code + " — no such deal on the book.");
          return;
        }
        const settled = (rec.approvals || []).filter((a) => a.decision).slice(-1)[0];
        textOf(
          "sla-decision-authority",
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
    return fetch(scoped("/api/approval-tiers"))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        pendingDecisions = data.pending_decisions || [];
        fillDatalist("sla-decision-deal-codes", pendingDecisions.map((d) => d.deal_code));
        fillDatalist("sla-decision-reason-codes", (data.adverse_action_reasons || []).map((r) => r.reason_code));
        fillDatalist("sla-decision-return-stages", data.returnable_stages || []);
        describeAuthority();
      })
      .catch(() => {});
  }

  function renderReceipt(rows) {
    const list = document.getElementById("sla-decision-receipt");
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

  const approveBtn = document.getElementById("sla-decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      const code = valueOf("sla-decision-deal-code");
      if (!code) {
        textOf("sla-decision-status", "Name the deal you are deciding.");
        return;
      }
      post("/api/deals/" + encodeURIComponent(code) + "/approve", {
        acting_user_email: valueOf("sla-decision-officer-email"),
        decision_notes: valueOf("sla-decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("sla-decision-status", "Refused by the server: " + (res.data.detail || "error"));
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
            "sla-decision-status",
            res.data.deal_id +
              " approved by " +
              res.data.decided_by +
              " under " +
              res.data.approval_authority_level +
              " authority."
          );
          afterDecision();
        })
        .catch((err) => textOf("sla-decision-status", "Request failed: " + err.message));
    });
  }

  const declineBtn = document.getElementById("sla-decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const code = valueOf("sla-decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/decline", {
        acting_user_email: valueOf("sla-decision-officer-email"),
        reason_code: valueOf("sla-decision-reason-code"),
        reason_detail: valueOf("sla-decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("sla-decision-status", "Refused by the server: " + (res.data.detail || "error"));
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
            "sla-decision-status",
            res.data.deal_id + " declined — adverse action " + res.data.adverse_action_reason_code + " issued."
          );
          afterDecision();
        })
        .catch((err) => textOf("sla-decision-status", "Request failed: " + err.message));
    });
  }

  const returnBtn = document.getElementById("sla-decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      const code = valueOf("sla-decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/return", {
        acting_user_email: valueOf("sla-decision-officer-email"),
        returned_to_stage: valueOf("sla-decision-return-stage"),
        reason: valueOf("sla-decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("sla-decision-status", "Refused by the server: " + (res.data.detail || "error"));
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
            "sla-decision-status",
            res.data.deal_id + " returned to " + titleCase(res.data.returned_to_stage) + "."
          );
          afterDecision();
        })
        .catch((err) => textOf("sla-decision-status", "Request failed: " + err.message));
    });
  }

  const dealField = document.getElementById("sla-decision-deal-code");
  if (dealField) dealField.addEventListener("input", describeAuthority);

  // The escalation is a TWO-STEP human gate on purpose. Step one opens the
  // sla-idle-escalation run, which measures the idle time, collects the
  // blocking work and then PARKS. Nothing has touched the deal yet. The
  // officer reads the measurement and the blockers, and only a second,
  // separate decision (confirm / refuse) releases the deterministic apply
  // handler. A request that signed off its own park point would not be a
  // human gate at all.
  let parkedRun = null;

  function showGate(visible) {
    const gate = document.getElementById("sla-escalation-gate");
    if (gate) gate.hidden = !visible;
  }

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
          parkedRun = null;
          showGate(false);
          textOf("sla-action-status", "Refused by the server: " + (res.data.detail || "error"));
          return;
        }
        const blockers = (res.data.blocking_items || []).join("; ");
        textOf(
          "sla-action-status",
          res.data.deal_id +
            " — " +
            res.data.business_days_idle +
            " business days idle · proposed " +
            (res.data.proposed_action || action) +
            " · run " +
            res.data.status +
            (blockers ? " · blocking: " + blockers : "")
        );
        if (res.data.awaiting_human_decision) {
          parkedRun = res.data.run_id;
          showGate(true);
          textOf(
            "sla-escalation-gate-status",
            "Run " + res.data.run_id + " is parked for you. Nothing has been applied to " +
              res.data.deal_id + " yet — confirm to apply the " + (res.data.proposed_action || action) +
              ", or refuse to close the run untouched."
          );
        } else {
          parkedRun = null;
          showGate(false);
          textOf("sla-escalation-gate-status", res.data.next_step || "");
        }
        loadRegister();
      })
      .catch((err) => textOf("sla-action-status", "Request failed: " + err.message));
  }

  function decideEscalation(confirm) {
    if (!parkedRun) {
      textOf("sla-escalation-gate-status", "No escalation is waiting on you.");
      return;
    }
    post("/api/sla/runs/" + encodeURIComponent(parkedRun) + "/decide", {
      acting_user_email: valueOf("sla-officer-email"),
      confirm: confirm,
      reason: valueOf("sla-note"),
    })
      .then((res) => {
        if (!res.ok) {
          textOf("sla-escalation-gate-status", "Refused by the server: " + (res.data.detail || "error"));
          return;
        }
        parkedRun = null;
        showGate(false);
        textOf(
          "sla-escalation-gate-status",
          confirm
            ? res.data.deal_id + " — " + res.data.action_taken + " applied by " + res.data.decided_by +
              " · workflow " + res.data.status
            : res.data.deal_id + " — escalation refused by " + res.data.decided_by +
              "; the deal was left untouched."
        );
        loadRegister();
      })
      .catch((err) => textOf("sla-escalation-gate-status", "Request failed: " + err.message));
  }

  const reassignBtn = document.getElementById("sla-reassign-btn");
  if (reassignBtn) reassignBtn.addEventListener("click", () => escalate("reassign"));
  const ackBtn = document.getElementById("sla-acknowledge-btn");
  if (ackBtn) ackBtn.addEventListener("click", () => escalate("acknowledge"));
  const confirmBtn = document.getElementById("sla-escalation-confirm-btn");
  if (confirmBtn) confirmBtn.addEventListener("click", () => decideEscalation(true));
  const refuseBtn = document.getElementById("sla-escalation-refuse-btn");
  if (refuseBtn) refuseBtn.addEventListener("click", () => decideEscalation(false));

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-sla-dashboard") {
      loadRegister();
      loadTiers();
    }
  });

  loadRegister();
  loadTiers();
})();

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
