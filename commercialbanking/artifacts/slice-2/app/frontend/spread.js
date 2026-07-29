// spread-ratios-grade slice: wires the Spread screen to the real financial
// spreading agent, ratio engine and risk-grade rubric (POST
// /deals/{id}/spread/run, POST /deals/{id}/spread/accept, GET
// /deals/{id}/ratios, GET /deals/{id}/risk-grade). Renders into the design's
// own ledger / ratio-card / grade-chip markup — never innerHTML with data,
// per the security-scan policy.
(function () {
  function fetchJSON(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.detail || ("HTTP " + r.status));
        return body;
      });
    });
  }

  function money(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var dealInput = document.getElementById("spread-deal-id");
  var runBtn = document.getElementById("spread-run-btn");
  var status = document.getElementById("spread-status");
  var head = document.getElementById("spread-live-head");
  var ledger = document.getElementById("spread-live-ledger");
  var acceptRow = document.getElementById("spread-accept-row");
  var acceptBtn = document.getElementById("spread-accept-btn");
  var acceptStatus = document.getElementById("spread-accept-status");
  var ratiosBox = document.getElementById("spread-live-ratios");
  var gradeBox = document.getElementById("spread-live-grade");
  if (!runBtn) return; // screen not present in this design build

  function renderLineItems(lineItems) {
    ledger.textContent = "";
    head.style.display = lineItems.length ? "" : "none";
    lineItems.forEach(function (li) {
      var line = el("div", "line");

      var nameCol = el("div");
      nameCol.appendChild(el("div", "li-name", li.line_item_label || li.line_item_key));
      nameCol.appendChild(el("div", "li-note", "Template key: " + li.line_item_key));
      line.appendChild(nameCol);

      line.appendChild(el("div", "num", money(li.extracted_value)));

      var srcBtn = el("button", "src");
      srcBtn.type = "button";
      srcBtn.appendChild(el("span", "pin", "●"));
      srcBtn.appendChild(el("span", "doc", "Artifact #" + li.source_document_id));
      srcBtn.appendChild(document.createTextNode(" " + li.source_location + " — “" + li.raw_extracted_text + "”"));
      var srcCol = el("div");
      srcCol.appendChild(srcBtn);
      line.appendChild(srcCol);

      var valueCol = el("div");
      var valueInput = document.createElement("input");
      valueInput.type = "number";
      valueInput.step = "any";
      valueInput.value = li.extracted_value;
      valueInput.dataset.lineItemId = li.id;
      valueInput.dataset.extracted = li.extracted_value;
      valueInput.style.width = "120px";
      valueCol.appendChild(valueInput);
      line.appendChild(valueCol);

      ledger.appendChild(line);
    });
    acceptRow.style.display = lineItems.length ? "" : "none";
  }

  function renderRatiosAndGrade(ratios, grade) {
    ratiosBox.textContent = "";
    ratiosBox.style.display = "";
    (ratios.ratios || []).forEach(function (r) {
      var card = el("div", "ratio-card");
      card.appendChild(el("div", "caps", String(r.ratio_type).replace(/_/g, " ")));
      card.appendChild(el("div", "ratio-val", r.computed_value != null ? Number(r.computed_value).toFixed(2) : "—"));
      var formula = el("div", "formula");
      formula.textContent = r.formula + " = " + JSON.stringify(r.inputs);
      card.appendChild(formula);
      ratiosBox.appendChild(card);
    });
    gradeBox.textContent = "";
    var chip = el("span", "grade g" + grade.grade, String(grade.grade));
    gradeBox.appendChild(document.createTextNode("Risk grade: "));
    gradeBox.appendChild(chip);
    gradeBox.appendChild(document.createTextNode(" — " + grade.rubric_rule_applied + " (rubric " + grade.rubric_version + ")"));
  }

  runBtn.addEventListener("click", function () {
    var dealId = (dealInput.value || "").trim();
    if (!dealId) return;
    runBtn.disabled = true;
    status.textContent = "Running spreading agent…";
    ratiosBox.style.display = "none";
    gradeBox.textContent = "";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/spread/run", { method: "POST" })
      .then(function (body) {
        var lineItems = body.line_items || [];
        renderLineItems(lineItems);
        var unextractable = body.unextractable_line_item_keys || [];
        status.textContent = lineItems.length + " line item(s) extracted" + (unextractable.length ? "; unextractable: " + unextractable.join(", ") : "") + ".";
      })
      .catch(function (err) {
        status.textContent = "Failed: " + err.message;
      })
      .then(function () {
        runBtn.disabled = false;
      });
  });

  acceptBtn.addEventListener("click", function () {
    var dealId = (dealInput.value || "").trim();
    if (!dealId) return;
    var edits = [];
    Array.prototype.forEach.call(ledger.querySelectorAll("input[data-line-item-id]"), function (input) {
      var current = parseFloat(input.value);
      var original = parseFloat(input.dataset.extracted);
      if (isFinite(current) && current !== original) {
        edits.push({ line_item_id: parseInt(input.dataset.lineItemId, 10), accepted_value: current });
      }
    });
    acceptBtn.disabled = true;
    acceptStatus.textContent = "Accepting…";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/spread/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept", accepted_by_id: "user-analyst-1", edits: edits }),
    })
      .then(function (body) {
        acceptStatus.textContent = "Accepted " + body.accepted_line_item_ids.length + " line item(s) — stage now " + body.current_stage + ".";
        if (body.ratios && body.risk_grade) renderRatiosAndGrade(body.ratios, body.risk_grade);
        return null;
      })
      .catch(function (err) {
        // The spread may already have been accepted earlier in this deal's
        // life (e.g. re-running this demo/workspace against a deal that has
        // moved on) — the ratios and grade computed at that time are still
        // on record, so fall back to showing them read-only.
        acceptStatus.textContent = "Accept: " + err.message + " — showing the deal's computed ratios and grade below.";
        return Promise.all([
          fetchJSON("/deals/" + encodeURIComponent(dealId) + "/ratios"),
          fetchJSON("/deals/" + encodeURIComponent(dealId) + "/risk-grade"),
        ]).then(function (pair) {
          renderRatiosAndGrade(pair[0], pair[1]);
        });
      })
      .catch(function () {
        // no ratios/grade on record yet either — leave the status message as-is
      })
      .then(function () {
        acceptBtn.disabled = false;
      });
  });
})();
