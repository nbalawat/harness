// intake-triage-pipeline slice: wires the Intake and Pipeline board screens
// to the real deal register (POST /deals/intake, GET /deals, POST
// /deals/{id}/triage/run, POST /deals/{id}/triage/accept). Renders into the
// design's own markup/classes (lane, card, pending-card, chip, hitl) — never
// innerHTML with data, per the security-scan policy.
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

  // ---------------------------------------------------------------- pipeline

  function renderPipelineLive(deals) {
    var body = document.getElementById("pipeline-live-body");
    var count = document.getElementById("pipeline-live-count");
    var sum = document.getElementById("pipeline-live-sum");
    if (!body) return;
    body.textContent = "";
    if (count) count.textContent = String(deals.length);
    if (sum) sum.textContent = money(deals.reduce(function (t, d) { return t + (Number(d.requested_amount) || 0); }, 0));
    if (!deals.length) {
      var empty = el("div", "lane-drop", "No deals submitted yet — use Intake to create one.");
      empty.id = "pipeline-live-empty";
      body.appendChild(empty);
      return;
    }
    deals.forEach(function (deal) {
      var card = el("article", "card");

      var top = el("div", "card-top");
      top.appendChild(el("div", "card-name", deal.borrower_name || "(unnamed)"));
      card.appendChild(top);

      card.appendChild(el("div", "card-id", deal.deal_id));
      card.appendChild(el("div", "card-amt", money(deal.requested_amount)));
      card.appendChild(el("div", "card-meta", (deal.industry || "unspecified") + " · LTV " + (deal.ltv_percentage != null ? deal.ltv_percentage + "%" : "—")));

      var row = el("div", "card-row");
      row.appendChild(el("span", "chip info", "Stage: " + (deal.current_stage || "unknown")));
      if (deal.status) row.appendChild(el("span", "chip hollow", deal.status));
      card.appendChild(row);

      var foot = el("div", "card-foot");
      foot.appendChild(document.createTextNode(deal.assigned_owner_id ? "Owner: " + deal.assigned_owner_id : "Unassigned"));
      var spacer = el("span", "spacer");
      foot.appendChild(spacer);
      foot.appendChild(document.createTextNode(deal.artifact_count + " artifact(s)"));
      card.appendChild(foot);

      body.appendChild(card);
    });
  }

  function loadDeals() {
    return fetchJSON("/deals")
      .then(renderPipelineLive)
      .catch(function () {});
  }

  // ------------------------------------------------------------------ intake

  function renderTriageCard(deal, triage) {
    var body = document.getElementById("intake-live-body");
    if (!body) return;
    var emptyPlaceholder = document.getElementById("intake-live-empty");
    if (emptyPlaceholder) emptyPlaceholder.remove();

    var card = el("article", "pending-card");
    card.appendChild(el("span", "pending-ribbon", "Triage draft · pending"));

    var top = el("div", "card-top");
    top.appendChild(el("div", "card-name", deal.borrower_name));
    card.appendChild(top);

    card.appendChild(el("div", "card-id", deal.deal_id));
    card.appendChild(el("div", "card-amt", money(deal.requested_amount)));
    card.appendChild(el("div", "card-meta", triage.request_type + " · " + triage.product_type));

    var row = el("div", "card-row");
    row.appendChild(el("span", "chip agent", "Suitable: " + (triage.underwriting_suitable ? "yes" : "no")));
    row.appendChild(el("span", "chip info", "Queue → " + triage.recommended_queue));
    card.appendChild(row);

    if ((triage.missing_documents || []).length) {
      var doclist = el("div", "doclist");
      triage.missing_documents.forEach(function (doc) {
        var docRow = el("div", "doc-row miss");
        docRow.appendChild(el("span", "tick", "!"));
        docRow.appendChild(document.createTextNode(" " + String(doc).replace(/_/g, " ") + " missing"));
        doclist.appendChild(docRow);
      });
      card.appendChild(doclist);
    }

    var note = el("div", "tiny muted");
    note.style.marginTop = "10px";
    note.textContent = triage.rationale;
    card.appendChild(note);

    var actions = el("div", "hitl");
    var acceptBtn = el("button", "btn accept", "Accept & route");
    acceptBtn.type = "button";
    var status = el("span", "tiny muted");
    actions.appendChild(acceptBtn);
    actions.appendChild(status);
    card.appendChild(actions);

    acceptBtn.addEventListener("click", function () {
      acceptBtn.disabled = true;
      status.textContent = "Routing…";
      fetchJSON("/deals/" + encodeURIComponent(deal.deal_id) + "/triage/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "accept",
          accepted_by_id: "user-analyst-1",
          accepted_queue: triage.recommended_queue,
        }),
      })
        .then(function (result) {
          card.classList.remove("pending-card");
          card.classList.add("card");
          var ribbon = card.querySelector(".pending-ribbon");
          if (ribbon) ribbon.remove();
          actions.textContent = "";
          var flag = el("span", "accepted-flag", "Accepted · routed to " + result.queue + " · stage " + result.current_stage);
          actions.appendChild(flag);
          loadDeals();
        })
        .catch(function (err) {
          status.textContent = "Failed: " + err.message;
          acceptBtn.disabled = false;
        });
    });

    body.appendChild(card);

    var count = document.getElementById("intake-live-count");
    var sum = document.getElementById("intake-live-sum");
    var cards = body.querySelectorAll(".pending-card, .card").length;
    if (count) count.textContent = String(cards);
    if (sum) {
      var current = Number((sum.textContent || "0").replace(/[^0-9.-]/g, "")) || 0;
      sum.textContent = money(current + (Number(deal.requested_amount) || 0));
    }
  }

  function submitIntake(event) {
    event.preventDefault();
    var statusEl = document.getElementById("intake-status");
    var submitBtn = document.getElementById("intake-submit-btn");
    var payload = {
      borrower_name: document.getElementById("in-borrower").value.trim(),
      industry: document.getElementById("in-industry").value.trim(),
      requested_amount: parseFloat(document.getElementById("in-amount").value) || 0,
      ltv_percentage: parseFloat(document.getElementById("in-ltv").value) || 0,
      collateral_description: document.getElementById("in-collateral").value.trim(),
      submitted_by_id: document.getElementById("in-submitter").value.trim(),
      artifacts: [
        {
          artifact_type: "email",
          file_name: "application.eml",
          content_type: "message/rfc822",
          content: document.getElementById("in-email").value,
        },
        {
          artifact_type: "spreadsheet",
          file_name: "financials.csv",
          content_type: "text/csv",
          content: document.getElementById("in-sheet").value,
        },
      ],
    };
    if (submitBtn) submitBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Submitting…";
    fetchJSON("/deals/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (deal) {
        if (statusEl) statusEl.textContent = "Deal " + deal.deal_id + " recorded — running triage…";
        loadDeals();
        return fetchJSON("/deals/" + encodeURIComponent(deal.deal_id) + "/triage/run", { method: "POST" }).then(function (triage) {
          renderTriageCard(deal, triage);
          if (statusEl) statusEl.textContent = "Deal " + deal.deal_id + " — triage proposal ready below.";
        });
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = "Failed: " + err.message;
      })
      .then(function () {
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  var form = document.getElementById("intake-form");
  if (form) form.addEventListener("submit", submitIntake);

  var newAppBtn = document.getElementById("intake-new-app-btn");
  if (newAppBtn) {
    newAppBtn.addEventListener("click", function () {
      var panel = document.getElementById("intake-form-panel");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      var first = document.getElementById("in-borrower");
      if (first) first.focus();
    });
  }

  loadDeals();
})();
