// portfolio-qa-sla-audit slice: wires the SLA dashboard screen's "Live SLA
// sweep" panel to GET /sla/dashboard. Renders into the design's own
// sla-lane/sla-track/sla-card markup — never innerHTML with data, per the
// security-scan policy.
(function () {
  function fetchJSON(path) {
    return fetch(path).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.detail || ("HTTP " + r.status));
        return body;
      });
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function money(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  var asOfInput = document.getElementById("sla-as-of");
  var refreshBtn = document.getElementById("sla-refresh-btn");
  var status = document.getElementById("sla-live-status");
  var summary = document.getElementById("sla-live-summary");
  var scount = document.getElementById("sla-live-scount");
  var inner = document.getElementById("sla-live-inner");
  var briefing = document.getElementById("sla-live-briefing");
  if (!refreshBtn || !inner) return; // screen not present in this design build

  function cardClass(d) {
    if (d.is_over_sla) return "sla-card breach";
    if ((d.business_days_idle || 0) >= 3) return "sla-card watch";
    return "sla-card okz";
  }

  function render(body) {
    inner.textContent = "";
    if (!body.deals.length) {
      inner.appendChild(el("div", "tiny muted", "No deals on record yet."));
    }
    body.deals.forEach(function (d) {
      var card = el("div", cardClass(d));
      var top = el("div", "card-top");
      top.appendChild(el("div", "card-name", d.borrower_name || d.deal_id));
      card.appendChild(top);
      card.appendChild(el("div", "card-id", d.deal_id));
      card.appendChild(el("div", "card-amt", money(d.requested_amount)));
      card.appendChild(
        el(
          "div", "card-meta",
          "Idle " + d.business_days_idle + " business day(s) · stage " + d.current_stage +
          (d.assigned_owner_id ? " · " + d.assigned_owner_id : "")
        )
      );
      if (d.is_over_sla) {
        var row = el("div", "card-row");
        row.appendChild(el("span", "chip danger", "Breach · past " + body.threshold_business_days + " business days"));
        card.appendChild(row);
      }
      inner.appendChild(card);
    });
    scount.className = "chip " + (body.breach_count ? "danger" : "hollow") + " scount";
    scount.textContent = body.breach_count + " breached of " + body.evaluated_count;
    summary.textContent = body.evaluated_count + " deal(s) evaluated as of " + body.as_of;
    briefing.textContent = body.briefing || "";
  }

  function refresh() {
    var asOf = (asOfInput.value || "").trim();
    var path = "/sla/dashboard" + (asOf ? "?as_of=" + encodeURIComponent(asOf) : "");
    refreshBtn.disabled = true;
    status.textContent = "Computing idle time…";
    fetchJSON(path)
      .then(function (body) {
        render(body);
        status.textContent = "Updated.";
      })
      .catch(function (err) {
        status.textContent = "Failed: " + err.message;
      })
      .then(function () {
        refreshBtn.disabled = false;
      });
  }

  refreshBtn.addEventListener("click", refresh);
  refresh();
})();
