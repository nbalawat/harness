// case-intake-completeness slice: wires the Worklist and Case File screens to
// the real case register (GET /cases, GET /cases/{reference}). Renders into
// the design's own markup/classes (ledger table, dossier-dl, checklist) —
// never innerHTML with data, per the security-scan policy. Uses the
// data-table/record-detail modules' pure logic (HarnessTable.prepare,
// HarnessDetail.fields) where it doesn't fight the design's own table markup.
(function () {
  function fetchJSON(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function markInfo(status) {
    var map = {
      ready: { label: "Ready for review", cls: "mark--new" },
      returned: { label: "Returned", cls: "mark--returned" },
    };
    return map[status] || { label: status || "Unknown", cls: "mark--review" };
  }

  function renderWorklist(cases) {
    var tbody = document.getElementById("worklist-tbody");
    var summary = document.getElementById("worklist-live-summary");
    if (!tbody) return;
    var prepared = window.HarnessTable ? window.HarnessTable.prepare(cases, { sort: "-id" }) : { rows: cases };
    tbody.textContent = "";
    tbody.removeAttribute("data-illustrative");
    prepared.rows.forEach(function (row) {
      var tr = document.createElement("tr");

      var caseCell = document.createElement("td");
      caseCell.className = "case-id";
      caseCell.textContent = row.case_reference;
      tr.appendChild(caseCell);

      var clientCell = document.createElement("td");
      clientCell.className = "client";
      clientCell.textContent = row.client_name || "—";
      tr.appendChild(clientCell);

      var statusCell = document.createElement("td");
      var m = markInfo(row.status);
      var markSpan = document.createElement("span");
      markSpan.className = "mark " + m.cls;
      markSpan.textContent = m.label;
      statusCell.appendChild(markSpan);
      tr.appendChild(statusCell);

      var bandCell = document.createElement("td");
      bandCell.textContent = "Not yet scored";
      tr.appendChild(bandCell);

      var scoreCell = document.createElement("td");
      scoreCell.className = "num";
      scoreCell.textContent = "—";
      tr.appendChild(scoreCell);

      var approverCell = document.createElement("td");
      approverCell.textContent = row.assigned_approver_id || "Unassigned";
      tr.appendChild(approverCell);

      var slaCell = document.createElement("td");
      slaCell.className = "num";
      slaCell.textContent = "—";
      tr.appendChild(slaCell);

      var flagCell = document.createElement("td");
      var flagSpan = document.createElement("span");
      var missingCount = (row.missing_documents || []).length;
      flagSpan.className = "flag " + (missingCount ? "flag--risk" : "flag--quiet");
      flagSpan.textContent = missingCount ? missingCount + " missing" : "—";
      flagCell.appendChild(flagSpan);
      tr.appendChild(flagCell);

      tbody.appendChild(tr);
    });
    if (summary) {
      var readyCount = cases.filter(function (c) { return c.status === "ready"; }).length;
      var returnedCount = cases.filter(function (c) { return c.status === "returned"; }).length;
      summary.textContent = cases.length
        ? cases.length + " case(s) on the register — " + readyCount + " ready, " + returnedCount + " returned."
        : "No cases opened yet — submit a case via POST /cases.";
    }
  }

  function renderCaseChecklist(container, docCase) {
    var list = document.createElement("ul");
    list.className = "checklist";
    (docCase.documents || []).forEach(function (doc) {
      var li = document.createElement("li");
      if (!doc.received && doc.required) li.className = "is-missing";
      var tick = document.createElement("span");
      tick.className = "tick " + (doc.received ? "tick--yes" : doc.required ? "tick--no" : "tick--na");
      tick.textContent = doc.received ? "✓" : doc.required ? "✕" : "○";
      var label = document.createElement("span");
      label.textContent = String(doc.document_type).replace(/_/g, " ");
      var ver = document.createElement("span");
      ver.className = "doc-ver";
      ver.textContent = doc.received ? "Received" : doc.required ? "Missing" : doc.conditionally_required ? "Not triggered" : "";
      li.appendChild(tick);
      li.appendChild(label);
      li.appendChild(ver);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function renderCaseDetail(docCase) {
    var container = document.getElementById("case-live");
    if (!container) return;
    container.textContent = "";

    var dl = document.createElement("dl");
    dl.className = "dossier-dl";
    var columns = ["case_reference", "client_name", "entity_type", "status", "submitted_by", "document_checklist_version", "case_ready_timestamp"];
    var labels = {
      case_reference: "Case reference",
      client_name: "Client name",
      entity_type: "Entity type",
      status: "Status",
      submitted_by: "Submitted by",
      document_checklist_version: "Checklist version",
      case_ready_timestamp: "Case ready at",
    };
    var fields = window.HarnessDetail
      ? window.HarnessDetail.fields(docCase, columns, labels)
      : columns.map(function (c) {
          return { label: labels[c] || c, value: docCase[c] == null || docCase[c] === "" ? "—" : String(docCase[c]) };
        });
    fields.forEach(function (f) {
      var dt = document.createElement("dt");
      dt.textContent = f.label;
      var dd = document.createElement("dd");
      dd.textContent = f.value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    container.appendChild(dl);

    var heading = document.createElement("h4");
    heading.className = "head";
    heading.textContent = "Document completeness — checklist " + (docCase.document_checklist_version || "");
    container.appendChild(heading);
    renderCaseChecklist(container, docCase);

    var notice = document.createElement("div");
    notice.className = "notice";
    var label = document.createElement("span");
    label.className = "notice__label";
    label.textContent = docCase.status === "ready" ? "Completeness result — PASS" : "Completeness result — RETURNED";
    var p = document.createElement("p");
    p.textContent = (docCase.missing_documents || []).length
      ? "Missing: " + docCase.missing_documents.join(", ") +
        ". No analyst may waive a required item — only a documented compliance-officer exception can excuse one."
      : "All required Document Checklist items are on file. Evaluated mechanically; no item on this list is set by hand.";
    notice.appendChild(label);
    notice.appendChild(p);
    container.appendChild(notice);
  }

  function loadCase(reference) {
    if (!reference) return;
    fetchJSON("/cases/" + encodeURIComponent(reference))
      .then(renderCaseDetail)
      .catch(function () {});
  }

  function populateCaseSelect(cases) {
    var select = document.getElementById("case-select");
    if (!select) return;
    select.textContent = "";
    if (!cases.length) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No cases opened yet";
      select.appendChild(opt);
      return;
    }
    cases.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.case_reference;
      opt.textContent = c.case_reference + " — " + (c.client_name || "");
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      loadCase(select.value);
    });
    loadCase(cases[0].case_reference);
  }

  fetchJSON("/cases")
    .then(function (cases) {
      renderWorklist(cases);
      populateCaseSelect(cases);
    })
    .catch(function () {
      var summary = document.getElementById("worklist-live-summary");
      if (summary) summary.textContent = "Could not load the case register.";
    });
})();
