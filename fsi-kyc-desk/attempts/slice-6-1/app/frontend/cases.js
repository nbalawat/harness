// Slice 1 — case intake and the deterministic completeness check.
// Behaviour only; it binds to markup added INSIDE the chosen design's existing
// screen containers and reuses the design's own classes and tokens.
// textContent everywhere, never innerHTML (security-scan policy).
(function () {
  "use strict";

  var STATUS_MARK = {
    open: "mark--new",
    ready: "mark--pending",
    returned: "mark--returned",
    approved: "mark--approved",
    rejected: "mark--rejected",
  };
  var BAND_MARK = { low: "band--low", medium: "band--medium", high: "band--high" };

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

  function markCell(status) {
    var cell = el("td");
    cell.appendChild(el("span", "mark " + (STATUS_MARK[status] || "mark--new"), titleise(status)));
    return cell;
  }

  function bandCell(band) {
    var cell = el("td");
    if (!band) { cell.textContent = "—"; return cell; }
    cell.appendChild(el("span", "band " + (BAND_MARK[band] || "band--medium"), titleise(band)));
    return cell;
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

  // ---------------------------------------------------------------- checklist
  var docSelect = document.getElementById("in-docs");

  function loadChecklist() {
    return getJSON("/checklist").then(function (res) {
      if (!res.ok || !docSelect) return;
      docSelect.replaceChildren();
      (res.body.all_document_types || []).forEach(function (doc, index) {
        var option = el("option", null, titleise(doc));
        option.value = doc;
        if (index < 4) option.selected = true;
        docSelect.appendChild(option);
      });
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- worklist
  var worklistBody = document.getElementById("live-worklist-body");
  var worklistMeta = document.getElementById("live-worklist-meta");
  var worklistFigures = document.getElementById("live-worklist-figures");

  function renderWorklist(cases) {
    if (!worklistBody) return;
    worklistBody.replaceChildren();
    if (!cases.length) {
      var empty = el("tr");
      var cell = td(null, "No cases opened yet — submit a package above.");
      cell.colSpan = 7;
      empty.appendChild(cell);
      worklistBody.appendChild(empty);
    }
    cases.forEach(function (row) {
      var tr = el("tr");
      tr.appendChild(td("case-id", row.case_reference));
      tr.appendChild(td("client", row.client_name));
      tr.appendChild(markCell(row.status));
      tr.appendChild(bandCell(row.risk_band));
      tr.appendChild(td(null, row.missing_documents.length ? row.missing_documents.length + " outstanding" : "Complete"));
      tr.appendChild(td(null, row.missing_documents.map(titleise).join(", ")));
      tr.appendChild(td(null, row.case_ready_timestamp));
      tr.style.cursor = "pointer";
      tr.title = "Open this case file";
      tr.addEventListener("click", function () { openCase(row.case_reference, true); });
      worklistBody.appendChild(tr);
    });
    if (worklistMeta) {
      worklistMeta.textContent =
        cases.length + " case(s) on the register · " +
        cases.filter(function (c) { return c.status === "ready"; }).length + " ready · " +
        cases.filter(function (c) { return c.status === "returned"; }).length + " returned · " +
        "Checked mechanically against Document Checklist v" + (cases.length ? cases[0].document_checklist_version : "2.0");
    }
    figures(worklistFigures, [
      ["Opened", cases.length],
      ["Ready", cases.filter(function (c) { return c.status === "ready"; }).length],
      ["Returned", cases.filter(function (c) { return c.status === "returned"; }).length],
      ["Items outstanding", cases.reduce(function (n, c) { return n + c.missing_documents.length; }, 0)],
      ["Waivers granted", 0],
    ]);
  }

  function loadWorklist() {
    return getJSON("/cases").then(function (res) {
      if (res.ok) renderWorklist(res.body.cases || []);
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- intake
  var intakeForm = document.getElementById("intake-form");
  var intakeResult = document.getElementById("intake-result");

  function bool(id) {
    var node = document.getElementById(id);
    return node ? node.value === "true" : false;
  }

  function value(id) {
    var node = document.getElementById(id);
    return node ? node.value.trim() : "";
  }

  if (intakeForm) {
    intakeForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var chosen = [];
      if (docSelect) {
        Array.prototype.forEach.call(docSelect.selectedOptions || [], function (o) { chosen.push(o.value); });
      }
      var depth = parseInt(value("in-depth"), 10) || 1;
      var payload = {
        client_reference: value("in-ref"),
        client_name: value("in-name"),
        entity_type: value("in-entity") || "corporate",
        submitted_by: value("in-user") || "ana.analyst",
        documents: chosen,
        attributes: {
          ownership_chain_depth: depth,
          regulated_industry: bool("in-regulated"),
          cross_border_expected: bool("in-cross"),
        },
        risk_factors: {
          jurisdiction: "standard",
          entity_structure: depth > 2 ? "chain_depth_over_3" : "simple",
          industry: bool("in-regulated") ? "money_services" : "other",
          sanctions_screening: "clear",
          expected_activity: bool("in-cross") ? "cross_border_over_1m" : "domestic_only",
        },
      };
      if (intakeResult) intakeResult.textContent = "Submitting…";
      postJSON("/cases", payload).then(function (res) {
        if (!res.ok) {
          if (intakeResult) intakeResult.textContent = "Submission refused: " + JSON.stringify(res.body.detail || res.body);
          return;
        }
        var body = res.body;
        if (intakeResult) {
          intakeResult.textContent =
            body.status === "ready"
              ? "Case " + body.case_reference + " is READY — complete at " + body.case_ready_timestamp + "."
              : "Case " + body.case_reference + " was RETURNED — missing: " + body.missing_documents.map(titleise).join(", ") + ".";
        }
        loadWorklist();
        openCase(body.case_reference, false);
      });
    });
  }

  // ---------------------------------------------------------------- case file
  var particulars = document.getElementById("live-case-particulars");
  var caseChecklist = document.getElementById("live-case-checklist");
  var caseNoticeLabel = document.getElementById("live-case-notice-label");
  var caseNoticeBody = document.getElementById("live-case-notice-body");
  var caseByline = document.getElementById("live-case-byline");
  var caseFigures = document.getElementById("live-case-figures");
  var caseRefInput = document.getElementById("live-case-ref");
  var caseForm = document.getElementById("live-case-form");
  var waiveButton = document.getElementById("live-case-waive");
  var waiveNote = document.getElementById("live-case-waive-note");
  var loaded = null;

  function definition(dl, term, description) {
    dl.appendChild(el("dt", null, term));
    dl.appendChild(el("dd", null, description == null || description === "" ? "—" : description));
  }

  function renderCase(body) {
    loaded = body;
    if (caseRefInput) caseRefInput.value = body.case_reference;
    if (caseByline) {
      caseByline.textContent =
        body.case_reference + " · " + titleise(body.status) +
        " · Document Checklist v" + body.document_checklist_version +
        " · Submitted by " + (body.submitted_by || "unknown");
    }
    if (particulars) {
      particulars.replaceChildren();
      definition(particulars, "Legal name", body.client_name);
      definition(particulars, "Submission reference", body.case_reference);
      definition(particulars, "Entity type", titleise(body.entity_type));
      definition(particulars, "Status", titleise(body.status));
      definition(particulars, "Opened", body.created_at);
      definition(particulars, "Case ready", body.case_ready_timestamp);
      definition(particulars, "Returned", body.returned_at);
      definition(particulars, "Package as submitted", (body.submitted_documents || []).map(titleise).join(", "));
    }
    if (caseChecklist) {
      caseChecklist.replaceChildren();
      (body.checklist || []).forEach(function (item) {
        var li = el("li");
        var required = item.required;
        var received = item.received;
        li.appendChild(el("span", "tick " + (received ? "tick--yes" : required ? "tick--no" : "tick--na"), received ? "✓" : required ? "✕" : "○"));
        li.appendChild(el("span", null, titleise(item.document_type)));
        li.appendChild(el("span", "doc-ver", received ? "Received" : required ? "Missing" : "Not triggered"));
        if (required && !received) li.className = "is-missing";
        caseChecklist.appendChild(li);
      });
    }
    if (caseNoticeLabel && caseNoticeBody) {
      var missing = body.missing_documents || [];
      caseNoticeLabel.textContent = missing.length ? "Completeness result — RETURNED" : "Completeness result — PASS";
      caseNoticeBody.textContent = missing.length
        ? "Outstanding items: " + missing.map(titleise).join(", ") + ". Evaluated mechanically against Document Checklist v" + body.document_checklist_version + "; no item on this list may be set by hand."
        : "Every required artefact is present. Case ready at " + body.case_ready_timestamp + ", evaluated mechanically against Document Checklist v" + body.document_checklist_version + ".";
    }
    figures(caseFigures, [
      ["Case", body.case_reference],
      ["Status", titleise(body.status)],
      ["Opened", body.created_at],
      ["Checklist", "v" + body.document_checklist_version],
      ["Required items", (body.checklist || []).filter(function (c) { return c.required; }).length],
      ["Outstanding", (body.missing_documents || []).length],
    ]);
    if (waiveNote) waiveNote.textContent = "Required items are not waivable by any role; an attempt is refused and written to the register.";
  }

  function openCase(reference, focus) {
    if (!reference) return;
    getJSON("/cases/" + encodeURIComponent(reference)).then(function (res) {
      if (!res.ok) {
        if (caseByline) caseByline.textContent = "No case with reference " + reference + ".";
        return;
      }
      renderCase(res.body);
      if (focus) {
        var folio = document.getElementById("f-case");
        if (folio) folio.checked = true;
        var screen = document.getElementById("screen-case");
        if (screen && screen.scrollIntoView) screen.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }).catch(function () {});
  }

  if (caseForm) {
    caseForm.addEventListener("submit", function (event) {
      event.preventDefault();
      openCase(caseRefInput ? caseRefInput.value.trim() : "", false);
    });
  }

  if (waiveButton) {
    waiveButton.addEventListener("click", function () {
      if (!loaded) { if (waiveNote) waiveNote.textContent = "Load a case first."; return; }
      var target = (loaded.missing_documents || [])[0] || (loaded.checklist || []).map(function (c) { return c.document_type; })[0];
      postJSON("/cases/" + encodeURIComponent(loaded.case_reference) + "/waive-document", {
        document_type: target,
        acting_user: "ana.analyst",
      }).then(function (res) {
        if (waiveNote) {
          waiveNote.textContent = res.status === 403
            ? "Refused (403): " + res.body.detail
            : "Unexpected response " + res.status;
        }
        openCase(loaded.case_reference, false);
      });
    });
  }

  loadChecklist().then(loadWorklist);
})();
