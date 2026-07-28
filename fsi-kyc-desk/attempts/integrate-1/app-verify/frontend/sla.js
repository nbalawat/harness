// Slice 5 — SLA clocks, at-risk flags and the escalation chain.
// Behaviour only; binds to markup added INSIDE the chosen design's existing
// #screen-worklist container and reuses the design's own classes and tokens
// (ledger, band, flag, filters, margin-figures). textContent everywhere,
// never innerHTML (security-scan policy).
(function () {
  "use strict";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function td(className, text) {
    return el("td", className, text == null || text === "" ? "—" : text);
  }

  function titleise(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function figures(list, pairs) {
    if (!list) return;
    list.replaceChildren();
    pairs.forEach(function (pair) {
      var li = el("li");
      li.appendChild(el("span", null, pair[0]));
      li.appendChild(el("b", null, pair[1] == null || pair[1] === "" ? "—" : pair[1]));
      list.appendChild(li);
    });
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  function postJSON(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  var slaBody = document.getElementById("live-sla-body");
  var slaFigures = document.getElementById("live-sla-figures");
  var escalationsBody = document.getElementById("live-escalations-body");
  var evaluateForm = document.getElementById("sla-evaluate-form");
  var evaluateResult = document.getElementById("sla-evaluate-result");

  // Keyed by lowercase case_reference — the most recent /sla/evaluate result
  // for a case, merged onto the /cases-derived row so the "Consumed" column
  // reflects the last time the evaluator actually ran (the API never
  // computes a live percentage for the table on its own — REQ-058's clock
  // only advances when the recurring evaluator is run).
  var lastEvaluation = {};

  function flagFor(row, evaluated) {
    if (row.sla_breached) return { cls: "flag--breach", label: "Breached" };
    if (row.is_at_risk) return { cls: "flag--risk", label: "At risk" };
    if (evaluated && evaluated.sla_state === "at_risk") return { cls: "flag--risk", label: "At risk" };
    if (evaluated && evaluated.sla_state === "breached") return { cls: "flag--breach", label: "Breached" };
    return { cls: "flag--quiet", label: "—" };
  }

  function renderSlaTable(cases) {
    if (!slaBody) return;
    slaBody.replaceChildren();
    var open = cases.filter(function (c) { return c.status === "ready" && c.sla_due_timestamp; });
    if (!open.length) {
      var empty = el("tr");
      var cell = td(null, "No open clocks — no ready case is currently under an SLA window.");
      cell.colSpan = 6;
      empty.appendChild(cell);
      slaBody.appendChild(empty);
    }
    open.forEach(function (row) {
      var evaluated = lastEvaluation[String(row.case_reference).toLowerCase()];
      var tr = el("tr");
      tr.appendChild(td("case-id", row.case_reference));
      var bandCell = el("td");
      if (row.risk_band) bandCell.appendChild(el("span", "band band--" + row.risk_band, titleise(row.risk_band)));
      else bandCell.textContent = "—";
      tr.appendChild(bandCell);
      tr.appendChild(td(null, row.assigned_approver_id));
      tr.appendChild(td(null, row.sla_due_timestamp));
      tr.appendChild(td("num", evaluated && evaluated.percent_consumed != null ? evaluated.percent_consumed + "%" : "not yet evaluated"));
      var flag = flagFor(row, evaluated);
      var flagCell = el("td");
      flagCell.appendChild(el("span", "flag " + flag.cls, flag.label));
      tr.appendChild(flagCell);
      slaBody.appendChild(tr);
    });
    figures(slaFigures, [
      ["Open clocks", open.length],
      ["At risk", open.filter(function (c) { return c.is_at_risk; }).length],
      ["Breached (ever)", cases.filter(function (c) { return c.sla_breached; }).length],
    ]);
  }

  function renderEscalations(rows) {
    if (!escalationsBody) return;
    escalationsBody.replaceChildren();
    if (!rows.length) {
      var empty = el("tr");
      var cell = td(null, "No case has been escalated yet.");
      cell.colSpan = 5;
      empty.appendChild(cell);
      escalationsBody.appendChild(empty);
      return;
    }
    rows.slice().reverse().forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(td("case-id", e.case_reference));
      tr.appendChild(td("num", e.escalation_level));
      tr.appendChild(td(null, titleise(e.escalated_to_role) + " — " + e.escalated_to_user_id));
      tr.appendChild(td(null, e.escalated_at));
      tr.appendChild(td(null, e.reason));
      escalationsBody.appendChild(tr);
    });
  }

  function loadCases() {
    return getJSON("/cases").then(function (res) {
      if (res.ok) renderSlaTable(res.body.cases || []);
    }).catch(function () {});
  }

  function loadEscalations() {
    return getJSON("/escalations").then(function (res) {
      if (res.ok) renderEscalations(res.body.escalations || []);
    }).catch(function () {});
  }

  if (evaluateForm) {
    evaluateForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var input = document.getElementById("sla-hours-elapsed");
      var hours = input ? parseFloat(input.value) : NaN;
      if (evaluateResult) evaluateResult.textContent = "Evaluating…";
      postJSON("/sla/evaluate", { simulated_business_hours_elapsed: isNaN(hours) ? null : hours }).then(function (res) {
        if (!res.ok) {
          if (evaluateResult) evaluateResult.textContent = "Evaluator refused: " + JSON.stringify(res.body.detail || res.body);
          return;
        }
        var evaluated = res.body.evaluated || [];
        lastEvaluation = {};
        evaluated.forEach(function (e) {
          if (e.case_reference) lastEvaluation[String(e.case_reference).toLowerCase()] = e;
        });
        if (evaluateResult) {
          evaluateResult.textContent = !evaluated.length
            ? "No open, undecided clocks to evaluate."
            : evaluated.map(function (e) {
                var text = e.case_reference + " → " + String(e.sla_state || "ok").toUpperCase() +
                  " (" + e.percent_consumed + "% consumed)";
                if (e.escalation) text += " · escalated to " + titleise(e.escalation.escalated_to_role);
                return text;
              }).join(" · ");
        }
        loadCases();
        loadEscalations();
      });
    });
  }

  loadCases();
  loadEscalations();
})();
