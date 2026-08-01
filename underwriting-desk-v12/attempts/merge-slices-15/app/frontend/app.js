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
    return textOf("dossier-analyst-email");
  }

  function scoped(path) {
    const email = actor();
    return email ? path + (path.indexOf("?") === -1 ? "?" : "&") + "acting_user_email=" + encodeURIComponent(email) : path;
  }

  // ---------------- rendering ----------------

  function renderHead(deal) {
    say("dossier-borrower", deal.borrower_name || deal.deal_code);
    say(
      "dossier-sub",
      [
        deal.deal_code,
        deal.borrower_industry || "unclassified",
        "stage " + String(deal.current_stage || "intake").replace(/_/g, " "),
        "status " + String(deal.current_status || "open").replace(/_/g, " "),
        deal.risk_grade ? "risk grade " + deal.risk_grade : "ungraded",
      ].join(" · ")
    );
    say("dossier-exposure", money(deal.exposure_amount || deal.requested_amount));
    say("dossier-tier", deal.approval_tier || "");
  }

  function renderDocket(documents, missing) {
    const list = el("docket-list");
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
    const body = el("spread-rows");
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
    const list = el("spread-unextractable");
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
    const rail = el("citation-rail");
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
    const body = el("ratios-rows");
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
      "ratios-caption",
      any
        ? "Computed in deterministic code · half-up to two decimals · undefined when a denominator is zero"
        : "Ratios are computed only from an accepted spread"
    );
  }

  function renderGrade(grade) {
    const strip = el("rubric-strip");
    if (!strip) return;
    strip.replaceChildren();
    if (!grade) {
      say("grade-note", "Ungraded. The grade is assigned from the rubric the moment a spread is accepted.");
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
    say("grade-note", grade.rubric_version + " · " + grade.band_hit + ". " + (grade.reasoning || ""));
  }

  function renderMemo(memo) {
    const body = el("memo-body");
    if (!body) return;
    body.replaceChildren();
    if (!memo) {
      const p = document.createElement("p");
      p.className = "dropcap";
      p.textContent =
        "No memo drafted yet. The Credit Memo Agent writes from the accepted spread, the computed ratios and the assigned grade, citing the record behind every assertion.";
      body.appendChild(p);
      say("memo-stamp", "awaiting a run");
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
    say("memo-stamp", "drafted");
  }

  function renderExceptions(exceptions) {
    const list = el("exception-list");
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
        const rationale = textOf("decision-notes");
        if (!rationale) {
          say("policy-status", "A waiver needs a written rationale — type one in the decision notes below.");
          return;
        }
        stageCall(
          "policy-status",
          "POST",
          "/api/deals/{code}/policy-exceptions/" + encodeURIComponent(e.exception_id) + "/waive",
          { acting_user_email: actor(), rationale: rationale },
          () => say("policy-status", "Exception " + e.rule_reference + " waived, with your name on the record.")
        );
      });

      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn btn--sm btn--quiet";
      back.textContent = "Return to analyst";
      back.addEventListener("click", () => {
        stageCall(
          "policy-status",
          "POST",
          "/api/deals/{code}/return",
          {
            acting_user_email: actor(),
            reason: textOf("decision-notes") || "returned to the analyst over " + e.rule_reference,
          },
          () => say("policy-status", "Returned to the analyst over " + e.rule_reference + ".")
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
    const accept = el("spread-accept-btn");
    const edit = el("spread-edit-btn");
    const reject = el("spread-reject-btn");
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
      say("spread-caption", spread.template_version + " · accepted · every figure cited");
      say("spread-stamp", "accepted");
    } else if (draft) {
      const byKey = {};
      (draft.citations || []).forEach((c) => {
        byKey[c.line_item_key] = c;
      });
      renderSpreadRows(draft.rows || [], byKey, false);
      renderCitationRail([]);
      say("spread-caption", draft.template_version + " · agent draft, awaiting acceptance");
      say("spread-stamp", "drafted, not accepted");
    } else {
      renderSpreadRows([], {}, false);
      renderCitationRail([]);
      say("spread-caption", "Standard spread template · no draft yet");
      say("spread-stamp", "awaiting a run");
    }
    renderUnextractable(draft ? draft.unextractable : []);
    setSpreadButtons(!!draft, !!accepted.length && !!acceptedReview);
    renderRatios(d.ratios);
    renderGrade(d.risk_grade);
    renderMemo(d.memo);
    renderExceptions(d.policy_exceptions);
    const stamp = el("spread-desk");
    if (stamp) stamp.dataset.deal = d.deal ? d.deal.deal_code : "";
  }

  function loadDossier(code) {
    if (!code) {
      say("dossier-status", "Enter a deal id to open its dossier.");
      return Promise.resolve();
    }
    return api("GET", scoped("/api/deals/" + encodeURIComponent(code) + "/dossier")).then((res) => {
      if (!res.ok) {
        say("dossier-status", "Could not open " + code + ": " + detailOf(res));
        return;
      }
      dealCode = code;
      renderDossier(res.data);
      say("dossier-status", "Dossier " + code + " open, read live from the server.");
    });
  }

  function loadDealList() {
    return api("GET", "/api/pipeline").then((res) => {
      const list = el("dossier-deal-list");
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
      const list = el("decision-reason-list");
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

  const openForm = el("dossier-open-form");
  if (openForm) {
    openForm.addEventListener("submit", (event) => {
      event.preventDefault();
      loadDossier(textOf("dossier-deal-code"));
    });
  }

  const attachForm = el("document-attach-form");
  if (attachForm) {
    attachForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!dealCode) {
        say("document-status", "Open a dossier first.");
        return;
      }
      const figures = textOf("document-figures")
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
        document_type: textOf("document-type"),
        file_name: textOf("document-file-name"),
        figures: figures,
      }).then((res) => {
        if (!res.ok) {
          say("document-status", "Could not attach: " + detailOf(res));
          return;
        }
        say(
          "document-status",
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

  const runBtn = el("spread-run-btn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      const code = dealCode || textOf("dossier-deal-code");
      if (!code) {
        say("spread-status", "Open a dossier first.");
        return;
      }
      say("spread-status", "Transcribing from the attached documents…");
      api("POST", "/api/deals/" + encodeURIComponent(code) + "/agents/financial-spreading/run", {
        acting_user_email: actor(),
      }).then((res) => {
        if (!res.ok) {
          say("spread-status", "Spreading failed: " + detailOf(res));
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
        say("spread-caption", draft.template_version + " · agent draft, awaiting acceptance");
        say("spread-stamp", "drafted, not accepted");
        setSpreadButtons(true, false);
        say(
          "spread-status",
          (draft.rows || []).length +
            " line items transcribed, every one cited to a document and locator; " +
            (draft.unextractable || []).length +
            " left out as unreadable. An analyst must accept before anything is written to the template."
        );
      });
    });
  }

  const editBtn = el("spread-edit-btn");
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
      const accept = el("spread-accept-btn");
      if (accept) accept.textContent = editing ? "Accept edited spread" : "Accept draft";
      say(
        "spread-status",
        editing
          ? "Editing the draft. Only line items the agent cited may be accepted — an edited figure keeps its citation."
          : "Edit cancelled; the agent's transcription is restored."
      );
    });
  }

  function submitReview(action, body) {
    const code = dealCode || textOf("dossier-deal-code");
    if (!code) return;
    api("POST", "/api/deals/" + encodeURIComponent(code) + "/spread/accept", body).then((res) => {
      if (!res.ok) {
        say("spread-status", "Could not " + action + ": " + detailOf(res));
        return;
      }
      say("spread-status", res.data.message || "Recorded.");
      loadDossier(code);
    });
  }

  const acceptBtn = el("spread-accept-btn");
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

  const rejectBtn = el("spread-reject-btn");
  if (rejectBtn) {
    rejectBtn.addEventListener("click", () => {
      const reason = textOf("spread-reject-reason");
      if (!reason) {
        say("spread-status", "A rejected spread needs a written reason — type one beside these buttons.");
        return;
      }
      submitReview("reject", { acting_user_email: actor(), action: "reject", rejection_reason: reason });
    });
  }

  // ---- memo, policy and decision desks: later stages of the same dossier ----

  function stageCall(statusId, method, path, body, done) {
    const code = dealCode || textOf("dossier-deal-code");
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

  const memoRun = el("memo-run-btn");
  if (memoRun) {
    memoRun.addEventListener("click", () => {
      say("memo-status", "Drafting the memo from the accepted spread, ratios and grade…");
      stageCall("memo-status", "POST", "/api/deals/{code}/agents/credit-memo/run", { acting_user_email: actor() }, () =>
        say("memo-status", "Draft ready — it cites the ratios, spread lines and rules it relied on. Accept or reject it.")
      );
    });
  }

  const memoAccept = el("memo-accept-btn");
  if (memoAccept) {
    memoAccept.addEventListener("click", () => {
      stageCall(
        "memo-status",
        "POST",
        "/api/deals/{code}/memo/accept",
        { acting_user_email: actor(), action: "accept" },
        () => say("memo-status", "Memo accepted; your name and the time are on the record.")
      );
    });
  }

  const memoReject = el("memo-reject-btn");
  if (memoReject) {
    memoReject.addEventListener("click", () => {
      const reason = textOf("decision-notes") || "returned to the agent for redrafting";
      stageCall(
        "memo-status",
        "POST",
        "/api/deals/{code}/memo/accept",
        { acting_user_email: actor(), action: "reject", rejection_reason: reason },
        () => say("memo-status", "Memo rejected — nothing was recorded as accepted.")
      );
    });
  }

  const policyRun = el("policy-run-btn");
  if (policyRun) {
    policyRun.addEventListener("click", () => {
      say("policy-status", "Testing the deal against the active lending ruleset…");
      stageCall(
        "policy-status",
        "POST",
        "/api/deals/{code}/agents/policy-compliance/run",
        { acting_user_email: actor() },
        (data) =>
          say(
            "policy-status",
            (data.exceptions || []).length + " exception(s) written against policy " + (data.policy_version || "")
          )
      );
    });
  }

  const approveBtn = el("decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      stageCall(
        "decision-status",
        "POST",
        "/api/deals/{code}/approve",
        { acting_user_email: actor(), decision_notes: textOf("decision-notes") },
        (data) => say("decision-status", "Approved by " + (data.approved_by || actor()) + ".")
      );
    });
  }

  const declineBtn = el("decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const code = textOf("decision-reason-code");
      if (!code) {
        say("decision-status", "A decline needs a controlled adverse-action reason code.");
        return;
      }
      stageCall(
        "decision-status",
        "POST",
        "/api/deals/{code}/decline",
        { acting_user_email: actor(), reason_code: code, reason_detail: textOf("decision-notes") },
        () => say("decision-status", "Declined with adverse-action reason " + code + ".")
      );
    });
  }

  const returnBtn = el("decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      stageCall(
        "decision-status",
        "POST",
        "/api/deals/{code}/return",
        { acting_user_email: actor(), reason: textOf("decision-notes") || "returned for further work" },
        () => say("decision-status", "Returned to an earlier stage with your written reason.")
      );
    });
  }

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-deal-detail") {
      loadDealList();
      loadDeclineReasons();
      loadDossier(dealCode || textOf("dossier-deal-code"));
    }
  });

  loadDealList();
  loadDeclineReasons();
  loadDossier(textOf("dossier-deal-code"));
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

// ============================================================
// Decision desk + SLA idle register (slice: tiered-approval-and-sla)
//   - GET  /api/approvals/queue        deals sitting at the approval step
//   - GET  /api/deals/{id}/approval-tier   who may decide, and why
//   - POST /api/deals/{id}/approve|decline|return   the named human decision
//   - GET  /api/sla/idle               the business-day idle register
//   - POST /api/sla/escalate           runs the sla-idle-escalation workflow
// Authority is decided by the SERVER; these controls only report what it says.
// textContent everywhere — never innerHTML with data.
// ============================================================
(function () {
  const STAGE_LABELS = {
    intake: "Intake",
    document_extraction: "Document extraction",
    financial_spreading: "Financial spreading",
    risk_grading: "Risk grading",
    memo_drafting: "Memo drafting",
    policy_compliance: "Policy compliance",
    tiered_approval: "Tiered approval",
    closing: "Closing",
    closed: "Closed",
  };

  const el = (id) => document.getElementById(id);
  const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-US");
  const stageLabel = (s) => STAGE_LABELS[s] || s || "—";
  const emailOf = (id) => (el(id) ? String(el(id).value || "").trim() : "");

  function compactMoney(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return "$" + (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return "$" + Math.round(v / 1000) + "k";
    return money(v);
  }

  function shortDate(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "—";
    return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function setRows(list, entries) {
    if (!list) return;
    list.replaceChildren();
    entries.forEach(([label, value]) => {
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

  function jsonOf(response) {
    return response.json().then((data) => ({ ok: response.ok, data }));
  }

  // ---------------------------------------------------------------- register
  let selectedIdleDeal = null;

  function renderRegister(body) {
    const rows = body.deals || [];
    const breachedPlate = el("sla-plate-breached");
    if (breachedPlate) breachedPlate.textContent = String(body.breached_count || 0);
    const breachedCaption = el("sla-plate-breached-caption");
    if (breachedCaption) breachedCaption.textContent = "of " + (body.active_deal_count || 0) + " active deals";
    const exposurePlate = el("sla-plate-exposure");
    if (exposurePlate) exposurePlate.textContent = compactMoney(body.idle_exposure);
    const longestPlate = el("sla-plate-longest");
    const longestCaption = el("sla-plate-longest-caption");
    if (longestPlate) {
      longestPlate.textContent = body.longest_idle ? body.longest_idle.business_days_idle + "d" : "0d";
    }
    if (longestCaption) {
      longestCaption.textContent = body.longest_idle
        ? (body.longest_idle.borrower_name || body.longest_idle.deal_id) +
          ", " + stageLabel(body.longest_idle.current_stage).toLowerCase()
        : "nothing past the service line";
    }
    const approachingPlate = el("sla-plate-approaching");
    if (approachingPlate) approachingPlate.textContent = String(body.approaching_count || 0);

    const tbody = el("sla-register-body");
    if (tbody) {
      tbody.replaceChildren();
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 7;
        td.textContent = "No deal has crossed the service line. The register is clean.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      const longest = rows.length ? rows[0].business_days_idle || 1 : 1;
      rows.forEach((row) => {
        const tr = document.createElement("tr");

        const pick = document.createElement("td");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "sla-selected-deal";
        radio.value = row.deal_id;
        radio.setAttribute("aria-label", "Select " + row.deal_id);
        radio.id = "sla-pick-" + row.deal_id;
        if (selectedIdleDeal === row.deal_id) radio.checked = true;
        radio.addEventListener("change", () => {
          selectedIdleDeal = row.deal_id;
          const status = el("sla-escalation-status");
          if (status) {
            status.textContent =
              row.deal_id + " selected — " + (row.blocking_items || []).join("; ");
          }
        });
        pick.appendChild(radio);

        const deal = document.createElement("td");
        deal.className = "deal-cell";
        const name = document.createElement("b");
        name.textContent = row.borrower_name || row.deal_id;
        const code = document.createElement("small");
        code.textContent = row.deal_id;
        deal.appendChild(name);
        deal.appendChild(code);

        const stage = document.createElement("td");
        stage.textContent = stageLabel(row.current_stage);

        const owner = document.createElement("td");
        owner.textContent = row.owner_email || "Unassigned";

        const last = document.createElement("td");
        last.textContent = shortDate(row.last_activity_timestamp) + " · " + (row.blocking_items || ["idle"])[0];

        const exposure = document.createElement("td");
        exposure.className = "num";
        exposure.textContent = money(row.exposure_amount);

        const idle = document.createElement("td");
        idle.className = "num";
        const ageBar = document.createElement("span");
        ageBar.className = "age-bar";
        const bar = document.createElement("span");
        bar.className = "bar";
        bar.style.width = Math.max(8, Math.round((row.business_days_idle / longest) * 56)) + "px";
        ageBar.appendChild(bar);
        const days = document.createElement("span");
        days.textContent = row.business_days_idle + "d";
        ageBar.appendChild(days);
        idle.appendChild(ageBar);

        [pick, deal, stage, owner, last, exposure, idle].forEach((cell) => tr.appendChild(cell));
        tbody.appendChild(tr);
      });
    }

    setRows(
      el("sla-by-stage"),
      Object.entries(body.by_stage || {}).map(([k, v]) => [stageLabel(k), v])
    );
    setRows(el("sla-by-owner"), Object.entries(body.by_owner || {}));
    const calendarNote = el("sla-calendar-note");
    if (calendarNote) {
      const holidays = body.bank_holidays || [];
      calendarNote.textContent = holidays.length
        ? "Bank holidays configured: " + holidays.join(", ") + "."
        : "No bank holidays configured for this calendar year.";
    }
    const caption = el("sla-register-caption");
    if (caption) {
      caption.textContent =
        "Deals idle beyond " + (body.threshold_business_days || 5) + " business days · escalation owner " +
        (body.escalation_owner || "unassigned");
    }
  }

  function loadRegister() {
    const email = emailOf("sla-officer-email");
    const url = "/api/sla/idle" + (email ? "?acting_user_email=" + encodeURIComponent(email) : "");
    return fetch(url)
      .then((r) => (r.ok ? r.json() : { deals: [] }))
      .then(renderRegister)
      .catch(() => {});
  }

  function escalate(action, note) {
    const status = el("sla-escalation-status");
    if (!selectedIdleDeal) {
      if (status) status.textContent = "Select a deal on the register first.";
      return;
    }
    fetch("/api/sla/escalate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        acting_user_email: emailOf("sla-officer-email"),
        deal_code: selectedIdleDeal,
        action: action,
        note: note,
      }),
    })
      .then(jsonOf)
      .then((res) => {
        if (!res.ok) {
          if (status) status.textContent = "Escalation refused: " + (res.data.detail || "error");
          return;
        }
        if (status) {
          status.textContent =
            res.data.action_taken === "reassign"
              ? res.data.deal_id + " reassigned to " + (res.data.reassigned_to_email || "the queue") +
                " by " + res.data.decided_by_email + " — recorded in the audit trail."
              : res.data.deal_id + " acknowledged by " + res.data.decided_by_email +
                " after " + res.data.idle_business_days + " idle business days.";
        }
        loadRegister();
      })
      .catch((err) => {
        if (status) status.textContent = "Request failed: " + err.message;
      });
  }

  const reassignBtn = el("sla-reassign-btn");
  if (reassignBtn) {
    reassignBtn.addEventListener("click", () => {
      const note = el("sla-escalation-note");
      escalate("reassign", (note && note.value.trim()) || "Idle past the service line — reassigned by the credit officer");
    });
  }
  const nudgeBtn = el("sla-nudge-btn");
  if (nudgeBtn) {
    nudgeBtn.addEventListener("click", () => {
      const note = el("sla-escalation-note");
      escalate("acknowledge", (note && note.value.trim()) || "Owner nudged; deal acknowledged on the register");
    });
  }
  const officerEmail = el("sla-officer-email");
  if (officerEmail) officerEmail.addEventListener("change", loadRegister);

  // ----------------------------------------------------------- decision desk
  function renderTier(tier) {
    const list = el("decision-tier");
    if (!list) return;
    if (!tier) {
      list.replaceChildren();
      return;
    }
    setRows(list, [
      ["Exposure", money(tier.exposure_amount)],
      ["Required authority", tier.required_authority_level],
      ["Tier rule applied", tier.tier_rule_applied],
      ["You may approve this", tier.caller_may_approve ? "yes — " + (tier.caller_role || "") : "no"],
      ["Already decided", tier.already_decided || "not yet"],
    ]);
  }

  function loadTier() {
    const select = el("decision-deal");
    const code = select ? select.value : "";
    if (!code) {
      renderTier(null);
      return Promise.resolve();
    }
    const email = emailOf("decision-user-email");
    return fetch(
      "/api/deals/" + encodeURIComponent(code) + "/approval-tier" +
        (email ? "?acting_user_email=" + encodeURIComponent(email) : "")
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(renderTier)
      .catch(() => {});
  }

  function loadApprovalQueue() {
    const email = emailOf("decision-user-email");
    const url = "/api/approvals/queue" + (email ? "?acting_user_email=" + encodeURIComponent(email) : "");
    return fetch(url)
      .then((r) => (r.ok ? r.json() : { deals: [] }))
      .then((body) => {
        const select = el("decision-deal");
        if (!select) return;
        const previous = select.value;
        select.replaceChildren();
        (body.deals || []).forEach((d) => {
          const option = document.createElement("option");
          option.value = d.deal_id;
          option.textContent =
            d.deal_id + " · " + (d.borrower_name || "borrower withheld") + " · " +
            money(d.exposure_amount) + " · needs " + d.required_authority_level;
          select.appendChild(option);
        });
        if (!(body.deals || []).length) {
          const option = document.createElement("option");
          option.value = "";
          option.textContent = "No deal is awaiting a decision.";
          select.appendChild(option);
        }
        if (previous && Array.prototype.some.call(select.options, (o) => o.value === previous)) {
          select.value = previous;
        }
        return loadTier();
      })
      .catch(() => {});
  }

  function loadReasonCodes() {
    return fetch("/api/adverse_action_reasons")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const select = el("decision-reason-code");
        if (!select || !Array.isArray(rows)) return;
        select.replaceChildren();
        rows
          .filter((r) => r.is_active)
          .forEach((r) => {
            const option = document.createElement("option");
            option.value = r.reason_code;
            option.textContent = r.reason_code + " — " + r.reason_label;
            select.appendChild(option);
          });
      })
      .catch(() => {});
  }

  function decide(path, payload, describe) {
    const select = el("decision-deal");
    const status = el("decision-status");
    const code = select ? select.value : "";
    if (!code) {
      if (status) status.textContent = "Choose a deal awaiting a decision first.";
      return;
    }
    fetch("/api/deals/" + encodeURIComponent(code) + "/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ acting_user_email: emailOf("decision-user-email") }, payload)),
    })
      .then(jsonOf)
      .then((res) => {
        if (!res.ok) {
          if (status) status.textContent = "Refused by the server: " + (res.data.detail || "error");
          return;
        }
        if (status) status.textContent = describe(res.data);
        loadApprovalQueue();
        loadRegister();
      })
      .catch((err) => {
        if (status) status.textContent = "Request failed: " + err.message;
      });
  }

  const approveBtn = el("decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      const notes = el("decision-notes");
      decide(
        "approve",
        { decision_notes: (notes && notes.value.trim()) || "" },
        (d) =>
          d.deal_id + " APPROVED by " + d.approved_by_email + " (" + d.required_authority_level +
          " authority, exposure " + money(d.exposure_amount) + ") — now in " +
          stageLabel(d.final_stage) + "."
      );
    });
  }

  const declineBtn = el("decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const codeEl = el("decision-reason-code");
      const detailEl = el("decision-reason-detail");
      decide(
        "decline",
        {
          reason_code: codeEl ? codeEl.value : "",
          reason_detail: detailEl ? detailEl.value.trim() : "",
        },
        (d) =>
          d.deal_id + " DECLINED by " + d.declined_by_email + " — adverse action " +
          d.adverse_action_reason_code + ": " + d.adverse_action_detail
      );
    });
  }

  const returnBtn = el("decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      const stageEl = el("decision-return-stage");
      const notes = el("decision-notes");
      decide(
        "return",
        {
          returned_to_stage: stageEl ? stageEl.value : "",
          reason: (notes && notes.value.trim()) || "",
        },
        (d) =>
          d.deal_id + " RETURNED to " + stageLabel(d.returned_to_stage) + " by " +
          d.returned_by_email + " and reassigned to " + (d.reassigned_to_email || "the analyst queue") + "."
      );
    });
  }

  const dealSelect = el("decision-deal");
  if (dealSelect) dealSelect.addEventListener("change", loadTier);
  const decisionEmail = el("decision-user-email");
  if (decisionEmail) decisionEmail.addEventListener("change", loadApprovalQueue);

  function loadSlaScreen() {
    loadRegister();
    loadApprovalQueue();
  }

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-sla-dashboard") loadSlaScreen();
  });

  loadReasonCodes().then(loadSlaScreen);
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
