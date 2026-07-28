// Slice 1 — case intake and the deterministic completeness check.
// Behaviour only: it binds to the Dossier design's own markup and renders with
// textContent (never innerHTML), reusing HarnessTable/HarnessDetail for logic.
(function () {
  var checklist = null;
  var cases = [];

  function el(id) { return document.getElementById(id); }
  function text(value) { return value === null || value === undefined || value === "" ? "—" : String(value); }
  function titleise(value) { return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  var STATUS_MARK = {
    new: "mark mark--new",
    ready: "mark mark--pending",
    returned: "mark mark--returned",
    approved: "mark mark--approved",
    rejected: "mark mark--rejected"
  };
  var BAND_MARK = { low: "band band--low", medium: "band band--medium", high: "band band--high" };

  function span(value, className) {
    var node = document.createElement("span");
    node.className = className || "";
    node.textContent = text(value);
    return node;
  }

  function cell(row, className, child) {
    var td = document.createElement("td");
    if (className) td.className = className;
    if (child instanceof Node) td.appendChild(child); else td.textContent = text(child);
    row.appendChild(td);
    return td;
  }

  // ---- intake form -------------------------------------------------------
  function renderDocPicker() {
    var host = el("in-docs");
    if (!host || !checklist) return;
    host.replaceChildren();
    var items = checklist.required_for_every_corporate_case.concat(checklist.conditionally_required);
    items.forEach(function (item) {
      var label = document.createElement("label");
      label.className = "doc-pick";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = item.document_type;
      box.checked = !item.condition_trigger;
      var name = document.createElement("span");
      name.textContent = item.title;
      var note = document.createElement("em");
      note.textContent = item.condition_trigger ? "when " + item.condition_trigger : "always required";
      label.appendChild(box);
      label.appendChild(name);
      label.appendChild(note);
      host.appendChild(label);
    });
  }

  function submission() {
    var picked = [];
    Array.prototype.forEach.call(document.querySelectorAll("#in-docs input:checked"), function (box) {
      picked.push(box.value);
    });
    return {
      client_reference: el("in-ref").value.trim(),
      client_name: el("in-name").value.trim(),
      entity_type: "corporate",
      submitted_by: el("in-by").value,
      documents: picked,
      attributes: {
        ownership_chain_depth: Number(el("in-depth").value || 1),
        regulated_industry: el("in-reg").value === "true",
        cross_border_expected: el("in-xb").value === "true"
      },
      risk_factors: {
        jurisdiction: el("in-jur").value,
        entity_structure: el("in-struct").value,
        industry: el("in-ind").value,
        sanctions_screening: el("in-sanc").value,
        expected_activity: el("in-act").value
      }
    };
  }

  function onSubmit(event) {
    event.preventDefault();
    var status = el("intake-status");
    status.textContent = "Running the completeness check…";
    fetch("/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission())
    })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) {
          status.textContent = "Not taken in: " + text(result.body.detail);
          return;
        }
        var missing = result.body.missing_documents || [];
        status.textContent = result.body.status === "ready"
          ? "Case " + result.body.case_reference + " is READY — stamped " + text(result.body.case_ready_timestamp) + " against checklist v" + text(result.body.document_checklist_version) + "."
          : "Case " + result.body.case_reference + " RETURNED — outstanding: " + missing.map(titleise).join(", ") + ".";
        el("in-ref").value = "";
        el("in-name").value = "";
        return refresh(result.body.case_reference);
      })
      .catch(function (err) { status.textContent = "Submission failed: " + err.message; });
  }

  // ---- worklist ----------------------------------------------------------
  function renderWorklist() {
    var body = el("live-worklist-body");
    var empty = el("live-worklist-empty");
    var caption = el("live-worklist-caption");
    if (!body) return;
    var prepared = window.HarnessTable
      ? window.HarnessTable.prepare(cases, { sort: "case_reference", pageSize: 100 })
      : { rows: cases, total: cases.length };
    body.replaceChildren();
    prepared.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      cell(tr, "case-id", row.case_reference);
      cell(tr, "client", row.client_name);
      cell(tr, null, span(titleise(row.status), STATUS_MARK[row.status] || "mark"));
      cell(tr, null, span(row.risk_band ? titleise(row.risk_band) : "Not yet scored", BAND_MARK[row.risk_band] || "band"));
      cell(tr, "num", row.total_risk_score === null || row.total_risk_score === undefined ? "—" : row.total_risk_score);
      cell(tr, null, row.assigned_approver_id || "Unassigned");
      cell(tr, null, span((row.missing_documents || []).map(titleise).join(", ") || "None outstanding",
        (row.missing_documents || []).length ? "missing-list" : ""));
      body.appendChild(tr);
    });
    if (caption) caption.textContent = "Cases on the live register — " + prepared.total + " opened";
    if (empty) empty.style.display = prepared.total ? "none" : "";
  }

  // ---- case file ---------------------------------------------------------
  var DETAIL_COLUMNS = [
    "case_reference", "client_name", "entity_type", "status", "submitted_by", "created_at",
    "case_ready_timestamp", "completeness_passed_at", "returned_at",
    "document_checklist_version", "risk_matrix_version", "onboarding_policy_version"
  ];
  var DETAIL_LABELS = {
    case_reference: "Submission reference",
    client_name: "Legal name",
    entity_type: "Entity type",
    status: "Status",
    submitted_by: "Submitted by",
    created_at: "Opened",
    case_ready_timestamp: "Case-ready timestamp",
    completeness_passed_at: "Completeness passed",
    returned_at: "Returned to client",
    document_checklist_version: "Checklist version",
    risk_matrix_version: "Risk matrix version",
    onboarding_policy_version: "Onboarding policy version"
  };

  function renderCase(row) {
    var detail = el("live-case-detail");
    var list = el("live-case-checklist");
    var label = el("live-case-result-label");
    var note = el("live-case-result-text");
    var stamp = el("case-ready-stamp");
    if (!detail || !list) return;
    detail.replaceChildren();
    list.replaceChildren();
    if (!row) {
      if (note) note.textContent = "No case is open on this desk yet.";
      if (label) label.textContent = "Completeness result";
      if (stamp) stamp.value = "";
      return;
    }
    var fields = window.HarnessDetail
      ? window.HarnessDetail.fields(row, DETAIL_COLUMNS, DETAIL_LABELS)
      : DETAIL_COLUMNS.map(function (c) { return { label: DETAIL_LABELS[c] || c, value: text(row[c]) }; });
    fields.forEach(function (field) {
      var dt = document.createElement("dt");
      dt.textContent = field.label;
      var dd = document.createElement("dd");
      dd.textContent = field.value;
      detail.appendChild(dt);
      detail.appendChild(dd);
    });
    if (stamp) stamp.value = text(row.case_ready_timestamp);

    var missing = row.missing_documents || [];
    (row.documents || []).forEach(function (doc) {
      if (!doc.required) return;
      var li = document.createElement("li");
      var absent = missing.indexOf(doc.document_type) !== -1;
      if (absent) li.className = "is-missing";
      var tick = document.createElement("span");
      tick.className = "tick " + (absent ? "tick--no" : "tick--yes");
      tick.textContent = absent ? "✕" : "✓";
      var name = document.createElement("span");
      name.textContent = doc.title || titleise(doc.document_type);
      var state = document.createElement("span");
      state.className = "doc-ver";
      state.textContent = absent
        ? "Missing" + (doc.conditionally_required ? " · " + doc.condition_trigger : "")
        : (doc.conditionally_required ? "Received · conditional" : "Received");
      li.appendChild(tick);
      li.appendChild(name);
      li.appendChild(state);
      list.appendChild(li);
    });

    if (label) label.textContent = missing.length ? "Completeness result — RETURNED" : "Completeness result — PASS";
    if (note) {
      note.textContent = missing.length
        ? missing.length + " required artefact(s) outstanding: " + missing.map(titleise).join(", ") +
          ". Evaluated mechanically against document checklist v" + text(row.document_checklist_version) +
          ". No analyst may waive an item; a compliance officer policy exception is the only recorded route."
        : "All required artefacts present under document checklist v" + text(row.document_checklist_version) +
          ". Marked READY at " + text(row.case_ready_timestamp) + ". No item on this list is set by hand.";
    }
  }

  function renderPicker(preferred) {
    var picker = el("case-picker");
    if (!picker) return;
    var wanted = preferred || picker.value;
    picker.replaceChildren();
    cases.forEach(function (row) {
      var option = document.createElement("option");
      option.value = row.case_reference;
      option.textContent = row.case_reference + " — " + text(row.client_name);
      picker.appendChild(option);
    });
    if (wanted && cases.some(function (r) { return r.case_reference === wanted; })) picker.value = wanted;
    renderCase(cases.filter(function (r) { return r.case_reference === picker.value; })[0] || null);
  }

  function refresh(preferred) {
    return fetch("/cases")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        cases = Array.isArray(rows) ? rows : [];
        renderWorklist();
        renderPicker(preferred);
      })
      .catch(function () {});
  }

  function start() {
    var form = el("intake-form");
    if (form) form.addEventListener("submit", onSubmit);
    var picker = el("case-picker");
    if (picker) picker.addEventListener("change", function () {
      renderCase(cases.filter(function (r) { return r.case_reference === picker.value; })[0] || null);
    });
    fetch("/checklist")
      .then(function (r) { return r.json(); })
      .then(function (data) { checklist = data; renderDocPicker(); })
      .catch(function () {});
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
