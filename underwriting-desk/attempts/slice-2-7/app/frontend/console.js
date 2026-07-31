// Operations Console behaviour — slice 1: Deal Intake + Pipeline Board.
//
// The markup is the approved design (option-2, see app/design.json); this file
// only binds it to the real backend. DOM updates use textContent by policy —
// never innerHTML with data.
(function () {
  "use strict";

  // The console operator. Role gates are enforced server-side; this is only
  // the identity the UI sends when it acts on the signed-in user's behalf.
  var OPERATOR = "co.brennan";

  var state = {
    config: null,
    board: { stages: [], deals: [], totals: {} },
    filter: "all",
    compact: false,
    selectedRef: null,
    intakeRef: null,
    stagedDocs: [],
    triage: null,
  };

  // ---------------------------------------------------------------- helpers

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(id, text) {
    var node = $(id);
    if (node) node.textContent = String(text);
  }

  function money(value) {
    var n = Number(value) || 0;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function moneyShort(value) {
    var n = Number(value) || 0;
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + n;
  }

  function parseMoney(text) {
    var n = Number(String(text == null ? "" : text).replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }

  function titleize(slug) {
    return String(slug || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  async function api(path, options) {
    var response = await fetch(path, options);
    var body = null;
    var text = await response.text();
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!response.ok) {
      var detail = body && body.detail ? body.detail : "request failed (" + response.status + ")";
      var err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = response.status;
      throw err;
    }
    return body;
  }

  function postJson(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // ---------------------------------------------------------------- screens

  var SCREENS = ["pipeline", "intake", "deal", "review", "approvals", "sla", "audit", "chat"];

  function showScreen(name) {
    if (SCREENS.indexOf(name) === -1) name = "pipeline";
    qsa(".screen").forEach(function (section) {
      section.classList.toggle("active", section.id === "screen-" + name);
    });
    qsa(".navitem[data-screen]").forEach(function (button) {
      button.classList.toggle("active", button.getAttribute("data-screen") === name);
    });
    setText("crumb", "/ " + name);
    if (name === "pipeline") refreshBoard();
    if (name === "intake") refreshIntake();
  }

  // The design's five-agent switch shipped inert. Only the intake triage agent
  // runs in this release, so it is the one that can be selected; the rest are
  // marked unavailable rather than left as toggles that quietly do nothing.
  var SHIPPED_AGENTS = { triage: true };

  function wireAgentSwitch() {
    qsa("#agent-mode .agent-btn").forEach(function (button) {
      var slug = button.getAttribute("data-agent");
      var shipped = SHIPPED_AGENTS[slug] === true;
      button.disabled = !shipped;
      button.setAttribute("aria-pressed", shipped ? "true" : "false");
      button.title = shipped
        ? button.getAttribute("data-agent-name") + " — runs at intake"
        : button.getAttribute("data-agent-name") + " — not in this release";
      if (!shipped) return;
      button.addEventListener("click", function () {
        qsa("#agent-mode .agent-btn").forEach(function (other) {
          other.setAttribute("aria-pressed", other === button ? "true" : "false");
        });
        setText("rail-agent", (button.getAttribute("data-agent-name") || "").toUpperCase());
      });
    });
    setText("rail-agent", "INTAKE TRIAGE");
  }

  function startClock() {
    function tick() {
      var now = new Date();
      function pad(n) { return (n < 10 ? "0" : "") + n; }
      setText("clock", pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()));
    }
    tick();
    setInterval(tick, 1000);
  }

  // The design ships the intake form filled with an example borrower — a name,
  // an address and a TIN that belong to no one. Left standing they are not a
  // mockup any more, they are live input: pressing Submit would create a deal
  // of record for a borrower that does not exist. Every other panel on this
  // screen was cleared to an honest empty state; the form is too.
  var INTAKE_FIELDS = [
    "in-ref", "in-legal", "in-dba", "in-tin", "in-naics", "in-state", "in-est",
    "in-addr", "in-amt", "in-term", "in-purpose", "in-collat", "in-collat-val", "in-ltv",
  ];

  function clearIntakeForm() {
    INTAKE_FIELDS.forEach(function (id) {
      var field = $(id);
      if (field) field.value = "";
    });
  }

  // Screens this slice does not deliver still carry the design's example
  // figures. A live deal id on the board now navigates to them, so each one
  // says plainly that it is a design preview and not this deal's record.
  var UNDELIVERED_SCREENS = ["deal", "review", "approvals", "sla", "audit"];

  function markUndeliveredScreens() {
    UNDELIVERED_SCREENS.forEach(function (name) {
      var screen = $("screen-" + name);
      if (!screen || screen.querySelector(".preview-notice")) return;
      var note = el("div", "banner warn preview-notice");
      note.appendChild(el("span", "b-icon", "!"));
      note.appendChild(el("span", null, "DESIGN PREVIEW — this screen is not delivered in this release. The borrower, figures and findings shown below are the design's examples, not deal-of-record data."));
      note.style.margin = "12px";
      screen.insertBefore(note, screen.firstChild);
    });
  }

  function wireNavigation() {
    qsa(".navitem[data-screen]").forEach(function (button) {
      button.addEventListener("click", function () { showScreen(button.getAttribute("data-screen")); });
    });
    document.addEventListener("click", function (event) {
      var target = event.target.closest ? event.target.closest("[data-goto]") : null;
      if (!target) return;
      var ref = target.getAttribute("data-ref");
      if (ref) { state.selectedRef = ref; syncOpenButtons(); }
      showScreen(target.getAttribute("data-goto"));
    });
    document.addEventListener("keydown", function (event) {
      var tag = (event.target && event.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
      var index = "12345678".indexOf(event.key);
      if (index !== -1) { showScreen(SCREENS[index]); return; }
      var key = String(event.key || "").toLowerCase();
      if (!$("screen-intake").classList.contains("active") || !state.triage) return;
      // Accepting promotes an agent draft into deal-of-record data and moves
      // the deal a stage — too consequential for one unconfirmed keystroke.
      if (key === "a" && window.confirm("Accept the intake triage draft? This assigns the analyst queue and advances the deal to Document Extraction.")) {
        decideTriage("accepted");
      }
      if (key === "e") { toggleEditRow(true); }
      if (key === "r") { toggleRejectRow(true); }
    });
  }

  // ---------------------------------------------------------------- pipeline board

  var TIER_CHIP = { analyst: ["ok", "Analyst"], officer: ["warn", "Sr. Officer"], committee: ["crit", "Committee"] };
  var COMPACT_HIDDEN = [2, 6, 7, 8]; // Segment, Track, Grade, DSCR

  function stageChipClass(slug) {
    if (slug === "tiered_approval") return "chip info";
    if (slug === "policy_compliance") return "chip warn";
    if (slug === "closing") return "chip ok";
    if (slug === "intake") return "chip";
    return "chip pri";
  }

  function stageIndex(slug) {
    for (var i = 0; i < state.board.stages.length; i += 1) {
      if (state.board.stages[i].slug === slug) return state.board.stages[i].index;
    }
    return 1;
  }

  function trackCell(deal) {
    var wrap = el("span", "track");
    var here = stageIndex(deal.current_stage);
    var blocked = (deal.pending_draft_types || []).length > 0;
    for (var i = 1; i <= 8; i += 1) {
      var mark = el("i");
      if (i < here) mark.className = "done";
      else if (i === here) mark.className = blocked ? "blocked" : "here";
      wrap.appendChild(mark);
    }
    return wrap;
  }

  function agentStateCell(deal) {
    var pending = deal.pending_draft_types || [];
    if (pending.length) {
      var chip = el("span", "chip warn");
      chip.appendChild(el("span", "dot pulse"));
      chip.appendChild(document.createTextNode(titleize(pending[0]) + " pending"));
      return chip;
    }
    if (deal.assigned_analyst_id) return el("span", "chip ok", "Accepted · routed");
    return el("span", "chip", "Awaiting triage");
  }

  function buildRow(deal) {
    var tr = el("tr");
    var idle = Number(deal.business_days_idle || 0);
    if (idle > 5) tr.className = "rowcrit";
    else if (idle >= 4) tr.className = "rowwarn";

    var refCell = el("td", "mono");
    var refSpan = el("span", "tbl-id", deal.deal_reference);
    refSpan.setAttribute("data-goto", "deal");
    refSpan.setAttribute("data-ref", deal.deal_reference);
    refCell.appendChild(refSpan);
    tr.appendChild(refCell);

    var borrower = el("td");
    borrower.appendChild(document.createTextNode(deal.borrower_name || ""));
    borrower.appendChild(el("span", "sub", (deal.borrower_state || "") + " · " + (deal.facility_label || "")));
    tr.appendChild(borrower);

    tr.appendChild(el("td", "dim", deal.borrower_industry || "—"));

    tr.appendChild(el("td", "num mono", money(deal.exposure_amount)));

    var tier = TIER_CHIP[deal.approval_tier] || ["", deal.approval_tier || "—"];
    var tierCell = el("td");
    tierCell.appendChild(el("span", "chip " + tier[0], tier[1]));
    tr.appendChild(tierCell);

    var stageCell = el("td");
    var idx = stageIndex(deal.current_stage);
    stageCell.appendChild(el("span", stageChipClass(deal.current_stage), ("0" + idx).slice(-2) + " " + (deal.stage_label || "")));
    tr.appendChild(stageCell);

    var trackTd = el("td");
    trackTd.appendChild(trackCell(deal));
    tr.appendChild(trackTd);

    var gradeCell = el("td");
    gradeCell.appendChild(el("span", "chip", deal.risk_grade || "—"));
    tr.appendChild(gradeCell);

    tr.appendChild(el("td", "num mono dim", deal.dscr || "—"));

    var agentCell = el("td");
    agentCell.appendChild(agentStateCell(deal));
    tr.appendChild(agentCell);

    var owner = el("td");
    var ownerId = deal.assigned_analyst_id || deal.submitted_by_user_id || "—";
    owner.appendChild(document.createTextNode(ownerId));
    owner.appendChild(el("span", "sub", deal.assigned_analyst_id ? "Credit Analyst" : titleize(deal.submitter_role || "")));
    tr.appendChild(owner);

    var idleCell = el("td", "num mono" + (idle > 5 ? " crit-t" : idle >= 4 ? " warn-t" : ""), idle + " d");
    tr.appendChild(idleCell);
    return tr;
  }

  function applyFilter(deals) {
    if (state.filter === "mine") {
      return deals.filter(function (d) { return d.assigned_analyst_id === OPERATOR || d.submitted_by_user_id === OPERATOR || d.approval_tier === "officer"; });
    }
    if (state.filter === "blocked") {
      return deals.filter(function (d) { return (d.pending_draft_types || []).length > 0; });
    }
    if (state.filter === "large") {
      return deals.filter(function (d) { return Number(d.exposure_amount || 0) > 1000000; });
    }
    return deals;
  }

  function applyCompactColumns() {
    var table = $("pipeline-rows") ? $("pipeline-rows").closest("table") : null;
    if (!table) return;
    var heads = qsa("thead th", table);
    COMPACT_HIDDEN.forEach(function (index) {
      if (heads[index]) heads[index].style.display = state.compact ? "none" : "";
    });
    qsa("tbody tr", table).forEach(function (row) {
      var cells = qsa("td", row);
      COMPACT_HIDDEN.forEach(function (index) {
        if (cells[index]) cells[index].style.display = state.compact ? "none" : "";
      });
    });
  }

  function renderBoard() {
    var body = $("pipeline-rows");
    if (!body) return;
    var filtered = applyFilter(state.board.deals || []);
    // data-table module owns sorting/paging of the register
    var prepared = window.HarnessTable
      ? window.HarnessTable.prepare(filtered, { sort: "-business_days_idle", pageSize: 200, page: 1 })
      : { rows: filtered, total: filtered.length };

    body.replaceChildren();
    if (!prepared.rows.length) {
      var empty = el("tr");
      var cell = el("td", "dim", "No deals match this filter yet — submit one on the Deal Intake screen.");
      cell.setAttribute("colspan", "12");
      empty.appendChild(cell);
      body.appendChild(empty);
    } else {
      prepared.rows.forEach(function (deal) { body.appendChild(buildRow(deal)); });
    }
    applyCompactColumns();

    var total = (state.board.deals || []).length;
    setText("pipeline-rowcount", prepared.total + " rows · sorted by idle desc");
    setText("pipeline-footnote", prepared.total + " of " + total + " shown · RBAC filter: officer sees all deals in scope");
    setText("pipeline-sub", state.board.stages.length + " stages · " + (state.board.totals.active_deals || 0) + " active deals · auto-refresh 30s");

    (state.board.stages || []).forEach(function (stage) {
      var cell = document.querySelector('.stagecell[data-stage="' + stage.slug + '"]');
      if (!cell) return;
      var count = cell.querySelector(".s-count");
      if (count) {
        count.textContent = String(stage.count);
        count.className = "s-count" + (stage.count > 3 ? " warn" : "");
      }
      var inStage = (state.board.deals || []).filter(function (d) { return d.current_stage === stage.slug && !d.is_closed; });
      var idle = inStage.map(function (d) { return Number(d.business_days_idle || 0); });
      var avg = idle.length ? idle.reduce(function (a, b) { return a + b; }, 0) / idle.length : 0;
      var breached = idle.filter(function (days) { return days > 5; }).length;
      var pending = inStage.filter(function (d) { return (d.pending_draft_types || []).length; }).length;
      var foot = cell.querySelector(".s-foot");
      if (foot) {
        foot.replaceChildren();
        foot.appendChild(el("span", null, "avg " + avg.toFixed(1) + "d"));
        if (breached) foot.appendChild(el("span", "crit-t", breached + " IDLE"));
        else if (pending) foot.appendChild(el("span", "warn-t", pending + " PENDING"));
        else foot.appendChild(el("span", "ok-t", "OK"));
      }
      var meter = cell.querySelector(".meter i");
      if (meter) {
        var active = state.board.totals.active_deals || 1;
        meter.className = breached ? "crit" : pending ? "warn" : "ok";
        meter.style.width = Math.min(100, Math.round((stage.count / active) * 100)) + "%";
      }
      cell.classList.toggle("hot", breached > 0 || pending > 1);
    });

    renderStatusStrip();
  }

  // The three row-action buttons navigate to a deal-scoped screen, so they must
  // carry the deal actually selected on the board — with an empty data-ref the
  // click would land on whatever deal was last in view.
  function syncOpenButtons() {
    var deals = (state.board.deals || []).filter(function (d) { return !d.is_closed; });
    var ref = state.selectedRef || (deals.length ? deals[deals.length - 1].deal_reference : "");
    ["btn-open-deal", "btn-open-review", "btn-open-trail"].forEach(function (id) {
      var button = $(id);
      if (!button) return;
      button.setAttribute("data-ref", ref);
      button.disabled = !ref;
      button.title = ref ? "Open " + ref : "Select a deal on the board first";
    });
  }

  // The rail counts ship from the design with placeholder figures. They sit
  // beside live data, so they are driven from the board or blanked — never
  // left asserting a pipeline size the app does not have.
  function renderRail() {
    var deals = (state.board.deals || []).filter(function (d) { return !d.is_closed; });
    var totals = state.board.totals || {};
    function count(screen, text, cls) {
      var node = document.querySelector('.navitem[data-screen="' + screen + '"] .nav-count');
      if (!node) return;
      node.className = "nav-count" + (cls ? " " + cls : "");
      node.textContent = text;
    }
    var atIntake = deals.filter(function (d) { return d.current_stage === "intake"; }).length;
    var pendingDrafts = Number(totals.pending_drafts || 0);
    count("pipeline", String(deals.length));
    count("intake", String(atIntake), atIntake ? "warn" : "");
    count("review", String(pendingDrafts), pendingDrafts ? "warn" : "");
    // Screens later slices deliver: no real figure exists yet, so show none
    // rather than a number that would read as a real queue depth.
    count("deal", "—");
    count("approvals", "—");
    count("sla", "—");
    count("audit", "—");
    var scope = document.querySelector(".rail-foot .rail-metric:nth-child(2) b");
    if (scope) scope.textContent = (state.operatorRole || "—").toUpperCase();
    var inView = document.querySelector(".rail-foot .rail-metric:nth-child(3) b");
    if (inView) inView.textContent = String(visibleDeals().length);
  }

  // "Deals in view" must mean exactly the rows the register is showing, so it
  // reuses the same filter the table is built from (all | mine | blocked |
  // large) rather than a second, divergent interpretation.
  function visibleDeals() {
    return applyFilter(state.board.deals || []);
  }

  function renderStatusStrip() {
    var deals = state.board.deals || [];
    var totals = state.board.totals || {};
    var cards = window.HarnessCards;
    var exposure = cards ? cards.compute(deals.filter(function (d) { return !d.is_closed; }), { metric: "sum", field: "exposure_amount" }) : totals.live_exposure;
    setText("m-queue", totals.active_deals || 0);
    setText("m-sla", deals.filter(function (d) { return Number(d.business_days_idle || 0) > 5; }).length);
    setText("m-pending", totals.pending_drafts || 0);
    setText("m-approvals", totals.approvals_due || 0);
    setText("m-exposure", moneyShort(exposure));
    renderRail();
    syncOpenButtons();
  }

  async function refreshBoard() {
    try {
      state.board = await api("/pipeline");
      renderBoard();
    } catch (err) {
      setText("pipeline-footnote", "Pipeline unavailable: " + err.message);
    }
  }

  function wirePipeline() {
    qsa("#pipeline-filters button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.filter = button.getAttribute("data-filter");
        qsa("#pipeline-filters button").forEach(function (other) {
          other.setAttribute("aria-pressed", other === button ? "true" : "false");
        });
        renderBoard();
      });
    });
    var columns = $("btn-columns");
    if (columns) {
      columns.addEventListener("click", function () {
        state.compact = !state.compact;
        columns.setAttribute("aria-pressed", state.compact ? "true" : "false");
        columns.textContent = state.compact ? "All columns" : "Columns";
        applyCompactColumns();
      });
    }
    var exportBtn = $("btn-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () { window.location.href = "/deals/export.csv"; });
    }
    syncOpenButtons();
    setInterval(function () {
      if ($("screen-pipeline").classList.contains("active")) refreshBoard();
    }, 30000);
  }

  // ---------------------------------------------------------------- intake

  function tierFor(amount) {
    var tiers = (state.config && state.config.approval_tiers) || { analyst_ceiling: 250000, officer_ceiling: 1000000 };
    if (amount <= tiers.analyst_ceiling) return "analyst";
    if (amount <= tiers.officer_ceiling) return "officer";
    return "committee";
  }

  function gaugePercent(amount) {
    var tiers = (state.config && state.config.approval_tiers) || { analyst_ceiling: 250000, officer_ceiling: 1000000 };
    if (amount <= tiers.analyst_ceiling) return 20 * (amount / tiers.analyst_ceiling);
    if (amount <= tiers.officer_ceiling) return 20 + 22 * ((amount - tiers.analyst_ceiling) / (tiers.officer_ceiling - tiers.analyst_ceiling));
    return Math.min(99, 42 + 58 * Math.min(1, (amount - tiers.officer_ceiling) / 4000000));
  }

  var TIER_LABEL = {
    analyst: ["ok", "Tier 1 · Credit Analyst"],
    officer: ["warn", "Tier 2 · Sr. Credit Officer"],
    committee: ["crit", "Tier 3 · Credit Committee"],
  };

  // The server owns the tier vocabulary; never index TIER_LABEL blind — an
  // unrecognised or missing tier must degrade to a neutral chip, not throw and
  // take the whole render down with it.
  function tierLabel(tier) {
    return TIER_LABEL[tier] || ["", tier ? String(tier) : "Tier pending"];
  }

  function facilityType() {
    var select = $("in-type");
    return select ? select.value : "term_loan";
  }

  function requiredDocs(slug) {
    var types = (state.config && state.config.facility_types) || [];
    for (var i = 0; i < types.length; i += 1) if (types[i].slug === slug) return types[i].required_documents || [];
    return [];
  }

  function documentLabel(slug) {
    var types = (state.config && state.config.document_types) || [];
    for (var i = 0; i < types.length; i += 1) if (types[i].slug === slug) return types[i].label;
    return titleize(slug);
  }

  function renderTierGauge() {
    var amount = parseMoney($("in-amt") && $("in-amt").value);
    var collateral = parseMoney($("in-collat-val") && $("in-collat-val").value);
    var tier = tierFor(amount);
    var chip = $("tier-chip");
    if (chip) {
      chip.className = "chip " + tierLabel(tier)[0] + " lg";
      chip.textContent = tierLabel(tier)[1];
    }
    var needle = $("tier-needle");
    if (needle) needle.style.left = gaugePercent(amount).toFixed(1) + "%";
    var ceilings = (state.config && state.config.approval_tiers) || {};
    var hint = $("tier-hint");
    if (hint) {
      hint.replaceChildren();
      if (tier === "committee") {
        hint.appendChild(document.createTextNode(money(amount) + " exceeds the " + money(ceilings.officer_ceiling) + " senior-officer ceiling → routes to "));
        hint.appendChild(el("b", "crit-t", "credit committee"));
        hint.appendChild(document.createTextNode(" at Stage 07."));
      } else if (tier === "officer") {
        hint.appendChild(document.createTextNode(money(amount) + " sits above " + money(ceilings.analyst_ceiling) + " → requires "));
        hint.appendChild(el("b", "warn-t", "senior credit officer"));
        hint.appendChild(document.createTextNode(" authority at Stage 07."));
      } else {
        hint.appendChild(document.createTextNode(money(amount) + " is within the " + money(ceilings.analyst_ceiling) + " "));
        hint.appendChild(el("b", "ok-t", "analyst"));
        hint.appendChild(document.createTextNode(" authority ceiling."));
      }
    }
    var ltv = $("in-ltv");
    if (ltv) ltv.value = collateral > 0 ? ((amount / collateral) * 100).toFixed(1) + "%" : "n/a";
  }

  function renderDocumentPanel() {
    var list = $("intake-files");
    if (!list) return;
    var required = requiredDocs(facilityType());
    var staged = state.stagedDocs;
    var have = staged.map(function (d) { return d.document_type; });
    list.replaceChildren();
    staged.forEach(function (doc, index) {
      var row = el("div", "filerow");
      row.appendChild(el("span", "chip ok", "STAGED"));
      row.appendChild(el("span", "f-name", doc.original_filename));
      row.appendChild(el("span", "f-meta", documentLabel(doc.document_type)));
      var remove = el("button", "btn ghost sm", "Remove");
      remove.type = "button";
      remove.addEventListener("click", function () {
        state.stagedDocs.splice(index, 1);
        renderDocumentPanel();
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
    required.forEach(function (slug) {
      if (have.indexOf(slug) !== -1) return;
      var row = el("div", "filerow");
      row.appendChild(el("span", "chip crit", "MISSING"));
      row.appendChild(el("span", "f-name dim", documentLabel(slug)));
      row.appendChild(el("span", "f-meta", "required for " + titleize(facilityType())));
      list.appendChild(row);
    });
    var received = required.filter(function (slug) { return have.indexOf(slug) !== -1; }).length;
    setText("intake-doc-note", "REQ-004 · " + received + " of " + required.length + " required received");
    var missing = $("intake-doc-missing");
    if (missing) {
      var count = required.length - received;
      missing.className = "chip " + (count ? "warn" : "ok");
      missing.textContent = count ? count + " missing" : "checklist complete";
    }
  }

  function renderPreflight(preflight) {
    var list = $("intake-preflight");
    if (!list) return;
    list.replaceChildren();
    if (!preflight) {
      // Same rule as the triage panel: the design's example screening results
      // (watchlist hits, an existing-relationship figure, a submitter name) are
      // not this app's findings, so with no deal on file they are replaced by
      // an explicit "not run" rather than left on screen looking authoritative.
      list.appendChild(el("dt", null, "Deterministic screens"));
      list.appendChild(el("dd", "dim txt-tiny", "Not run — submit a deal to screen it for prohibited industry, duplicate requests, relationship exposure and LTV."));
      return;
    }

    function pair(term, build) {
      list.appendChild(el("dt", null, term));
      var dd = el("dd");
      build(dd);
      list.appendChild(dd);
    }

    pair("Prohibited industry", function (dd) {
      var flagged = preflight.prohibited_industry.status === "flag";
      dd.appendChild(el("span", "chip " + (flagged ? "crit" : "ok"), flagged ? "FLAG" : "PASS"));
      dd.appendChild(document.createTextNode(" "));
      dd.appendChild(el("span", "dim txt-tiny", preflight.prohibited_industry.rule_reference + (flagged ? " · " + preflight.prohibited_industry.matched_terms.join(", ") : " screen clear")));
    });
    pair("Existing relationship", function (dd) {
      dd.className = "mono";
      dd.textContent = preflight.existing_relationship.facility_count + " facilities · " + money(preflight.existing_relationship.outstanding_exposure) + " outstanding";
    });
    pair("Aggregate exposure", function (dd) {
      dd.className = "mono";
      dd.appendChild(document.createTextNode(money(preflight.aggregate_exposure.value) + " "));
      if (preflight.aggregate_exposure.status === "flag") dd.appendChild(el("span", "chip warn", "concentration check due"));
    });
    pair("Requested LTV", function (dd) {
      dd.className = "mono";
      var value = preflight.requested_ltv.value;
      dd.appendChild(document.createTextNode(value == null ? "n/a" : (value * 100).toFixed(1) + "% "));
      if (preflight.requested_ltv.cap != null) {
        dd.appendChild(el("span", "chip " + (preflight.requested_ltv.status === "flag" ? "crit" : "ok"), "cap " + (preflight.requested_ltv.cap * 100).toFixed(0) + "%"));
      }
    });
    // The approved design ships an OFAC / watchlist row. No sanctions list is
    // wired in this release, so the row is kept and told the truth rather than
    // deleted (which would silently drop an approved control from the screen)
    // or shown as CLEAR (which would assert a screen that never ran).
    pair("OFAC / watchlist", function (dd) {
      dd.appendChild(el("span", "chip", "NOT SCREENED"));
      dd.appendChild(document.createTextNode(" "));
      dd.appendChild(el("span", "dim txt-tiny", "no sanctions list is wired in this release"));
    });
    pair("Duplicate request", function (dd) {
      var dupes = preflight.duplicate_request.references || [];
      dd.appendChild(el("span", "chip " + (dupes.length ? "warn" : "ok"), dupes.length ? dupes.join(", ") : "NONE"));
    });
    pair("Approval tier", function (dd) {
      var tier = preflight.approval_tier.value;
      dd.appendChild(el("span", "chip " + tierLabel(tier)[0], tierLabel(tier)[1]));
      dd.appendChild(document.createTextNode(" "));
      dd.appendChild(el("span", "dim txt-tiny", preflight.approval_tier.tier_rule_version));
    });
  }

  function renderTriage(draft, dealRef) {
    state.triage = draft || null;
    setText("triage-decider", OPERATOR);
    var status = $("triage-status");
    var readout = $("triage-readout-text");

    if (!draft) {
      if (status) { status.className = "chip"; status.textContent = "No draft"; }
      setText("triage-runinfo", "no run yet");
      setText("triage-model", "—");
      setText("triage-prompt", "—");
      setText("triage-latency", "—");
      setText("triage-tokens", "—");
      setText("triage-class-hint", "Submit a deal to run the intake triage agent.");
      if (readout) readout.textContent = "No triage draft on file for this deal.";
      // The design ships this panel populated with example agent output. With
      // no run on file that content would read as a real classification, real
      // missing-document findings and real analyst loads — so it is cleared to
      // an explicit empty state rather than left standing as fake evidence.
      var banner = $("triage-banner");
      if (banner) {
        banner.className = "banner";
        banner.replaceChildren();
        banner.appendChild(el("span", "b-icon", "i"));
        banner.appendChild(el("span", null, "NOT YET RUN. The intake triage agent proposes a classification, missing documents and an analyst queue once a deal is submitted. Nothing below is a real agent finding until then. (REQ-033)"));
      }
      ["triage-class", "triage-queues"].forEach(function (id) {
        var node = $(id);
        if (node) node.replaceChildren();
      });
      var empty = $("triage-missing");
      if (empty) {
        empty.replaceChildren();
        var note = el("div", "banner");
        note.appendChild(el("span", "b-icon", "◌"));
        note.appendChild(el("span", null, "No agent run on file — no missing-document findings to show."));
        empty.appendChild(note);
      }
      ["triage-accept", "triage-edit", "triage-reject"].forEach(function (id) {
        var button = $(id);
        if (button) button.disabled = true;
      });
      return;
    }

    var pending = draft.review_status === "pending";
    // The banner is a statement about the gate, so it has to track the gate.
    // Left alone it would keep asserting "PENDING HUMAN ACCEPTANCE" after a
    // human had already accepted and the deal had advanced a stage.
    var gate = $("triage-banner");
    if (gate) {
      gate.replaceChildren();
      if (pending) {
        gate.className = "banner warn";
        gate.appendChild(el("span", "b-icon", "!"));
        gate.appendChild(el("span", null, "PENDING HUMAN ACCEPTANCE. This is an agent proposal, not deal-of-record data. Nothing advances to Stage 02 until a named human accepts, edits or rejects it. (REQ-033)"));
      } else if (draft.review_status === "rejected") {
        gate.className = "banner crit";
        gate.appendChild(el("span", "b-icon", "x"));
        gate.appendChild(el("span", null, "REJECTED by " + (draft.reviewed_by_user_id || "—") + " — " + (draft.review_reason || "no reason recorded") + ". The deal stays at Intake for further document collection."));
      } else {
        gate.className = "banner ok";
        gate.appendChild(el("span", "b-icon", "✓"));
        gate.appendChild(el("span", null, "ACCEPTED by " + (draft.reviewed_by_user_id || "—") + (draft.human_edits ? " with edits" : "") + ". The analyst queue is assigned and the deal has advanced to Document Extraction."));
      }
    }
    if (status) {
      status.replaceChildren();
      status.className = "chip " + (pending ? "warn" : draft.review_status === "rejected" ? "crit" : "ok");
      if (pending) status.appendChild(el("span", "dot pulse"));
      status.appendChild(document.createTextNode(pending ? "Pending" : titleize(draft.review_status)));
    }

    var run = draft.agent_run || {};
    setText("triage-runinfo", "run " + draft.agent_run_id + " · draft " + draft.id + " · " + (dealRef || draft.deal_reference));
    setText("triage-model", run.model_id || "—");
    setText("triage-prompt", run.prompt_template_version || "—");
    setText("triage-latency", run.latency_ms == null ? "—" : run.latency_ms + " ms");
    setText("triage-tokens", run.token_cost == null ? "—" : "$" + Number(run.token_cost).toFixed(4));

    var classes = $("triage-class");
    if (classes) {
      classes.replaceChildren();
      classes.appendChild(el("span", "chip info lg", draft.classification_label || draft.classification));
      classes.appendChild(el("span", "chip lg", (draft.draft_content && draft.draft_content.documents_on_file) + " documents on file"));
      var tier = (state.board.deals || []).filter(function (d) { return d.deal_reference === (dealRef || draft.deal_reference); })[0];
      if (tier) classes.appendChild(el("span", "chip " + tierLabel(tier.approval_tier)[0] + " lg", tierLabel(tier.approval_tier)[1]));
      classes.appendChild(el("span", "chip violet lg", "Source: " + ((draft.draft_content && draft.draft_content.source) || "agent")));
    }
    setText("triage-class-hint", (draft.draft_content && draft.draft_content.rationale) || "");

    var missing = $("triage-missing");
    if (missing) {
      missing.replaceChildren();
      var slugs = draft.missing_documents || [];
      if (!slugs.length) {
        var ok = el("div", "banner");
        ok.appendChild(el("span", "b-icon", "✓"));
        ok.appendChild(el("span", null, "No required document is missing for this request type."));
        missing.appendChild(ok);
      }
      slugs.forEach(function (slug, index) {
        var banner = el("div", "banner crit");
        banner.appendChild(el("span", "b-icon", "×"));
        var span = el("span");
        span.appendChild(el("b", null, (draft.missing_document_labels || [])[index] || documentLabel(slug)));
        span.appendChild(document.createTextNode(" absent — required for " + titleize(draft.classification) + " requests; the spread will be incomplete without it."));
        banner.appendChild(span);
        missing.appendChild(banner);
      });
    }

    var queues = $("triage-queues");
    if (queues) {
      queues.replaceChildren();
      ((state.config && state.config.analyst_queues) || []).forEach(function (queue, index) {
        var step = el("div", "ladder-step" + (queue.queue_id === draft.proposed_queue ? " on" : ""));
        step.appendChild(el("span", "l-idx", index + 1));
        var label = el("span");
        if (queue.queue_id === draft.proposed_queue) label.appendChild(el("b", null, queue.label));
        else label.appendChild(document.createTextNode(queue.label));
        label.appendChild(document.createTextNode(" — " + queue.analyst_user_id));
        step.appendChild(label);
        step.appendChild(el("span", "l-cap", queue.queue_id === draft.proposed_queue ? "proposed" : "available"));
        queues.appendChild(step);
      });
    }
    setText("triage-queue-hint", "Proposed queue " + draft.proposed_queue + " — a named human must accept before the deal is routed.");

    if (readout) {
      readout.replaceChildren();
      if (pending) {
        readout.appendChild(document.createTextNode("No disposition recorded. The draft stays "));
        readout.appendChild(el("b", "warn-t", "PENDING"));
        readout.appendChild(document.createTextNode(" and Stage 01 → 02 advancement is blocked."));
      } else {
        readout.appendChild(document.createTextNode("Draft " + draft.review_status + " by "));
        readout.appendChild(el("b", null, draft.reviewed_by_user_id || ""));
        readout.appendChild(document.createTextNode(" at " + (draft.reviewed_at || "") + (draft.review_reason ? " — " + draft.review_reason : "")));
      }
    }

    ["triage-accept", "triage-edit", "triage-reject"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = !pending;
    });
    if (!pending) { toggleEditRow(false); toggleRejectRow(false); }
  }

  function showIntakeError(message) {
    var box = $("intake-error");
    if (!box) return;
    if (!message) { box.hidden = true; box.textContent = ""; return; }
    box.hidden = false;
    box.textContent = message;
  }

  function value(id) {
    var node = $(id);
    return node ? (node.value || "").trim() : "";
  }

  function collectSubmission() {
    return {
      deal_reference: value("in-ref"),
      borrower_name: value("in-legal"),
      borrower_industry: value("in-naics"),
      borrower_state: value("in-state"),
      // Every editable field on this form reaches the record — a control the
      // user can type into that is silently dropped is a lie about what was
      // captured. The TIN is the sharpest case: it is marked required here and
      // the server stores only its masked last four (mask_tin).
      borrower_dba: value("in-dba"),
      borrower_tin: value("in-tin"),
      borrower_established: value("in-est"),
      borrower_address: value("in-addr"),
      // blank must travel as null, not "" — term_months is typed int|None
      term_months: value("in-term") ? Number(value("in-term").replace(/[^0-9]/g, "")) || null : null,
      collateral_description: value("in-collat"),
      facility_type: facilityType(),
      requested_amount: parseMoney($("in-amt").value),
      collateral_value: parseMoney($("in-collat-val").value),
      purpose: value("in-purpose"),
      submitted_by: $("in-submitter").value,
      documents: state.stagedDocs.map(function (doc) {
        return {
          document_type: doc.document_type,
          original_filename: doc.original_filename,
          content_type: doc.content_type,
          text: doc.text || null,
          upload_name: doc.upload_name || null,
        };
      }),
    };
  }

  // Read-only: loading a screen never runs an agent or writes a row. The
  // triage agent runs only when a person asks for it (submit / re-run).
  async function hydrateDeal(reference) {
    var detail = await api("/deals/" + encodeURIComponent(reference));
    state.intakeRef = reference;
    renderPreflight(detail.preflight);
    var triage = (detail.drafts || []).filter(function (d) { return d.draft_type === "triage"; }).slice(-1)[0] || null;
    renderTriage(triage, reference);
    return detail;
  }

  async function submitDeal() {
    showIntakeError("");
    var button = $("btn-intake-submit");
    if (button) button.disabled = true;
    try {
      var payload = collectSubmission();
      var created = await postJson("/deals", payload);
      state.intakeRef = created.deal_reference;
      renderPreflight(created.preflight);
      var draft = await postJson("/deals/" + encodeURIComponent(created.deal_reference) + "/triage", { acting_user: OPERATOR });
      await refreshBoard();
      renderTriage(draft, created.deal_reference);
      setText("intake-rbac", "Submitted " + created.deal_reference + " · tier " + created.approval_tier + " · stage " + created.current_stage);
    } catch (err) {
      showIntakeError(err.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function toggleEditRow(show) {
    var row = $("triage-edit-row");
    if (!row) return;
    row.hidden = !show;
    if (!show || !state.triage) return;
    var classSelect = $("triage-edit-class");
    var queueSelect = $("triage-edit-queue");
    classSelect.replaceChildren();
    ((state.config && state.config.facility_types) || []).forEach(function (type) {
      var option = el("option", null, type.label);
      option.value = type.slug;
      if (type.slug === state.triage.classification) option.selected = true;
      classSelect.appendChild(option);
    });
    queueSelect.replaceChildren();
    ((state.config && state.config.analyst_queues) || []).forEach(function (queue) {
      var option = el("option", null, queue.label);
      option.value = queue.queue_id;
      if (queue.queue_id === state.triage.proposed_queue) option.selected = true;
      queueSelect.appendChild(option);
    });
  }

  function toggleRejectRow(show) {
    var row = $("triage-reject-row");
    if (row) row.hidden = !show;
    var hint = $("triage-reason-hint");
    if (hint && !show) hint.hidden = true;
  }

  async function decideTriage(action, extra) {
    if (!state.intakeRef) return;
    var payload = Object.assign({ action: action, acting_user: OPERATOR }, extra || {});
    try {
      var result = await postJson("/deals/" + encodeURIComponent(state.intakeRef) + "/drafts/triage/review", payload);
      var refreshed = Object.assign({}, result.draft, { agent_run: result.draft.agent_run });
      renderTriage(refreshed, state.intakeRef);
      setText("intake-rbac", "Draft " + result.review_action + " by " + result.reviewed_by_user_id + " · stage now " + result.current_stage);
      toggleEditRow(false);
      toggleRejectRow(false);
      await refreshBoard();
      await hydrateDeal(state.intakeRef).catch(function () {});
    } catch (err) {
      if (action === "rejected") {
        var hint = $("triage-reason-hint");
        if (hint) { hint.hidden = false; hint.textContent = err.message; }
      }
      showIntakeError(err.message);
    }
  }

  async function uploadFiles(files) {
    var typeSelect = $("intake-doc-type");
    var documentType = typeSelect ? typeSelect.value : "other";
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      try {
        var stored = await api("/uploads/" + encodeURIComponent(file.name), { method: "PUT", body: file });
        state.stagedDocs.push({
          document_type: documentType,
          original_filename: file.name,
          content_type: file.type || "application/octet-stream",
          upload_name: stored.name,
        });
      } catch (err) {
        showIntakeError(file.name + ": " + err.message);
      }
    }
    renderDocumentPanel();
  }

  function wireIntake() {
    ["in-amt", "in-collat-val"].forEach(function (id) {
      var input = $(id);
      if (input) input.addEventListener("input", renderTierGauge);
    });
    var type = $("in-type");
    if (type) type.addEventListener("change", function () { renderTierGauge(); renderDocumentPanel(); });

    var submit = $("btn-intake-submit");
    if (submit) submit.addEventListener("click", submitDeal);

    var save = $("btn-intake-save");
    if (save) {
      save.addEventListener("click", async function () {
        showIntakeError("");
        try {
          var saved = await postJson("/intake/drafts", {
            deal_reference: ($("in-ref").value || "").trim(),
            acting_user: $("in-submitter").value,
            content: collectSubmission(),
          });
          setText("intake-rbac", "Intake draft saved for " + saved.deal_reference + " by " + saved.saved_by);
        } catch (err) {
          showIntakeError(err.message);
        }
      });
    }

    var dropzone = $("intake-dropzone");
    var fileInput = $("intake-file-input");
    if (dropzone && fileInput) {
      dropzone.addEventListener("click", function () { fileInput.click(); });
      dropzone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
      dropzone.addEventListener("dragover", function (e) { e.preventDefault(); });
      dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      });
      fileInput.addEventListener("change", function () { uploadFiles(fileInput.files); fileInput.value = ""; });
    }

    var accept = $("triage-accept");
    if (accept) accept.addEventListener("click", function () { decideTriage("accepted"); });
    var edit = $("triage-edit");
    if (edit) edit.addEventListener("click", function () { toggleEditRow($("triage-edit-row").hidden); });
    var editConfirm = $("triage-edit-confirm");
    if (editConfirm) {
      editConfirm.addEventListener("click", function () {
        decideTriage("edited", { edits: { classification: $("triage-edit-class").value, proposed_queue: $("triage-edit-queue").value } });
      });
    }
    var reject = $("triage-reject");
    if (reject) reject.addEventListener("click", function () { toggleRejectRow($("triage-reject-row").hidden); });
    var rejectConfirm = $("triage-reject-confirm");
    if (rejectConfirm) {
      rejectConfirm.addEventListener("click", function () {
        decideTriage("rejected", { reason: ($("triage-reason").value || "").trim() });
      });
    }
  }

  function refreshIntake() {
    renderTierGauge();
    renderDocumentPanel();
    if (state.intakeRef) hydrateDeal(state.intakeRef).catch(function () {});
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    wireNavigation();
    wirePipeline();
    wireIntake();
    wireAgentSwitch();
    startClock();
    clearIntakeForm();
    markUndeliveredScreens();

    // Route to the requested screen synchronously, before any awaited fetch.
    // Doing it after boot's network calls would silently revert a navigation
    // the operator made while the board was still loading.
    showScreen((location.hash || "#pipeline").replace(/^#(screen-)?/, ""));
    window.addEventListener("hashchange", function () {
      showScreen(location.hash.replace(/^#(screen-)?/, ""));
    });

    try {
      state.config = await api("/intake/config");
    } catch (err) {
      state.config = null;
    }

    if (state.config) {
      var typeSelect = $("intake-doc-type");
      if (typeSelect) {
        typeSelect.replaceChildren();
        state.config.document_types.forEach(function (doc) {
          var option = el("option", null, doc.label);
          option.value = doc.slug;
          typeSelect.appendChild(option);
        });
        typeSelect.value = "financial_statements";
      }
      var operator = state.config.users.filter(function (u) { return u.username === OPERATOR; })[0];
      if (operator) {
        state.operatorRole = operator.role_label || operator.role || "";
        setText("user-name", operator.display_name || operator.username);
        setText("role-readout", operator.role_label);
        setText("user-avatar", (operator.display_name || operator.username).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase());
      }
      var submitter = $("in-submitter");
      if (submitter) {
        submitter.replaceChildren();
        state.config.users
          .filter(function (u) { return u.role === "relationship_manager" || u.role === "credit_officer"; })
          .forEach(function (u) {
            var option = el("option", null, u.username + " — " + u.role_label);
            option.value = u.username;
            submitter.appendChild(option);
          });
      }
    }

    await refreshBoard();
    renderTierGauge();
    renderDocumentPanel();

    // If a deal is already sitting at intake, bring its triage draft up —
    // preferring one whose draft is still awaiting a human.
    var atIntake = (state.board.deals || []).filter(function (d) { return d.current_stage === "intake"; });
    var awaiting = atIntake.filter(function (d) { return (d.pending_draft_types || []).indexOf("triage") !== -1; });
    if (awaiting.length) atIntake = awaiting;
    if (atIntake.length) {
      var latest = atIntake[atIntake.length - 1];
      // Bring that deal's triage draft up for review. The intake form itself is
      // left blank: its reference field addresses a *new* deal, so writing an
      // existing reference into it would only produce a duplicate submission.
      hydrateDeal(latest.deal_reference).catch(function () {});
    } else {
      renderTriage(null, null);
      renderPreflight(null);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
