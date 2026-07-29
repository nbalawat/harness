// memo-policy-compliance slice: wires the Credit memo screen to the real
// credit memo agent and policy compliance agent (POST /deals/{id}/memo/run,
// POST /deals/{id}/memo/accept, POST /deals/{id}/policy-review/run, POST
// /deals/{id}/policy-review/accept, GET /policy-rules). Renders into the
// design's own memo-sec / cite-card / ledger / gate markup — never innerHTML
// with data, per the security-scan policy.
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

  var dealInput = document.getElementById("memo-deal-id");
  var runBtn = document.getElementById("memo-run-btn");
  var status = document.getElementById("memo-status");
  var contentBox = document.getElementById("memo-live-content");
  var acceptRow = document.getElementById("memo-accept-row");
  var acceptBtn = document.getElementById("memo-accept-btn");
  var acceptStatus = document.getElementById("memo-accept-status");

  var policyRunRow = document.getElementById("policy-run-row");
  var policyRunBtn = document.getElementById("policy-run-btn");
  var policyStatus = document.getElementById("policy-status");
  var exposureBox = document.getElementById("policy-live-exposure");
  var exceptionsLedger = document.getElementById("policy-live-exceptions");
  var policyAcceptRow = document.getElementById("policy-accept-row");
  var policyAcceptBtn = document.getElementById("policy-accept-btn");
  var policyAcceptStatus = document.getElementById("policy-accept-status");

  if (!runBtn) return; // screen not present in this design build

  function renderMemo(body) {
    contentBox.textContent = "";
    var h4 = el("h4");
    h4.appendChild(el("span", "pending-ribbon", "Agent draft · pending"));
    contentBox.appendChild(h4);
    contentBox.appendChild(el("p", null, body.content));
    var cites = el("p", "tiny muted");
    cites.textContent = "Cites " + body.cited_ratios.length + " ratio(s), " + body.cited_spread_items.length +
      " spread line(s), " + body.cited_policy_rules.length + " policy rule(s). Citations resolvable: " +
      (body.citations_resolvable ? "yes" : "no");
    contentBox.appendChild(cites);
    contentBox.style.display = "";
    acceptRow.style.display = "";
  }

  function renderExposure(exposureByDimension, dealExposure) {
    exposureBox.textContent = "";
    exposureBox.appendChild(document.createTextNode("This deal's exposure: " + money(dealExposure) + ". Portfolio exposure by industry: "));
    (((exposureByDimension || {}).industry) || []).forEach(function (row, i) {
      if (i > 0) exposureBox.appendChild(document.createTextNode(", "));
      exposureBox.appendChild(document.createTextNode(
        row.dimension_value + " " + money(row.exposure_amount) + " (" + row.pct_of_portfolio.toFixed(1) + "%)"
      ));
    });
  }

  function renderExceptions(exceptions) {
    exceptionsLedger.textContent = "";
    exceptions.forEach(function (exc) {
      var card = el("div", "cite-card pol");
      var ct = el("div", "ct");
      ct.appendChild(el("span", "cn", "P" + exc.policy_rule_id));
      ct.appendChild(el("b", null, "Exception #" + exc.id + " — " + exc.exception_status));
      card.appendChild(ct);
      card.appendChild(el("div", "cb", exc.violation_description));
      exceptionsLedger.appendChild(card);
    });
    policyAcceptRow.style.display = exceptions.some(function (e) { return e.exception_status === "open"; }) ? "" : "none";
    if (!exceptions.length) {
      exceptionsLedger.appendChild(el("div", "tiny muted", "No policy exceptions raised — the deal clears every evaluated rule."));
    }
  }

  runBtn.addEventListener("click", function () {
    var dealId = (dealInput.value || "").trim();
    if (!dealId) return;
    runBtn.disabled = true;
    status.textContent = "Running memo agent…";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/memo/run", { method: "POST" })
      .then(function (body) {
        renderMemo(body);
        status.textContent = "Draft ready — " + body.cited_ratios.length + " ratio citation(s).";
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
    acceptBtn.disabled = true;
    acceptStatus.textContent = "Accepting…";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/memo/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept", accepted_by_id: "user-analyst-1" }),
    })
      .then(function (body) {
        acceptStatus.textContent = "Accepted — stage now " + body.current_stage + ".";
        policyRunRow.style.display = "";
        return null;
      })
      .catch(function (err) {
        acceptStatus.textContent = "Accept: " + err.message;
      })
      .then(function () {
        acceptBtn.disabled = false;
      });
  });

  policyRunBtn.addEventListener("click", function () {
    var dealId = (dealInput.value || "").trim();
    if (!dealId) return;
    policyRunBtn.disabled = true;
    policyStatus.textContent = "Running policy compliance agent…";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/policy-review/run", { method: "POST" })
      .then(function (body) {
        renderExposure(body.exposure_by_dimension, body.deal_exposure_amount);
        renderExceptions(body.exceptions);
        policyStatus.textContent = body.open_exception_count + " open exception(s) against policy " + body.policy_version + ".";
      })
      .catch(function (err) {
        policyStatus.textContent = "Failed: " + err.message;
      })
      .then(function () {
        policyRunBtn.disabled = false;
      });
  });

  policyAcceptBtn.addEventListener("click", function () {
    var dealId = (dealInput.value || "").trim();
    if (!dealId) return;
    var dispositions = [];
    exceptionsLedger.querySelectorAll(".cite-card.pol").forEach(function (card) {
      var label = card.querySelector(".ct b");
      var match = label && /#(\d+)/.exec(label.textContent);
      if (match) {
        dispositions.push({ exception_id: parseInt(match[1], 10), disposition: "waived", waiver_reason: "Reviewed and waived by credit officer." });
      }
    });
    policyAcceptBtn.disabled = true;
    policyAcceptStatus.textContent = "Dispositioning…";
    fetchJSON("/deals/" + encodeURIComponent(dealId) + "/policy-review/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept", dispositioned_by_id: "user-officer-1", dispositions: dispositions }),
    })
      .then(function (body) {
        policyAcceptStatus.textContent = "Cleared — stage now " + body.current_stage + ".";
        policyAcceptRow.style.display = "none";
        return fetchJSON("/deals/" + encodeURIComponent(dealId) + "/policy-exceptions");
      })
      .then(function (exceptions) {
        renderExceptions(exceptions);
      })
      .catch(function (err) {
        policyAcceptStatus.textContent = "Failed: " + err.message;
      })
      .then(function () {
        policyAcceptBtn.disabled = false;
      });
  });
})();
