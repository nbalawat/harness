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
