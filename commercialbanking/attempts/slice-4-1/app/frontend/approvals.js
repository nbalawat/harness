// tiered-approval-decisions slice: wires the Approvals screen to the real
// approval-tier derivation and authority-gated decision endpoints
// (GET /deals/{id}/approval-tier, POST /approvals, POST /deals/{id}/decline,
// POST /deals/{id}/rework). Renders into the design's own panel / field /
// chip markup — never innerHTML with data, per the security-scan policy.
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

  var dealInput = document.getElementById("ap-deal-id");
  var tierBtn = document.getElementById("ap-tier-btn");
  var tierStatus = document.getElementById("ap-tier-status");
  var tierResult = document.getElementById("ap-tier-result");

  var deciderSelect = document.getElementById("ap-decider");
  var notesInput = document.getElementById("ap-notes");
  var approveBtn = document.getElementById("ap-approve-btn");
  var approveStatus = document.getElementById("ap-approve-status");

  var declineReasonInput = document.getElementById("ap-decline-reason");
  var declineBtn = document.getElementById("ap-decline-btn");
  var declineStatus = document.getElementById("ap-decline-status");

  var reworkReasonInput = document.getElementById("ap-rework-reason");
  var reworkAssigneeInput = document.getElementById("ap-rework-assignee");
  var reworkBtn = document.getElementById("ap-rework-btn");
  var reworkStatus = document.getElementById("ap-rework-status");

  if (!tierBtn) return; // screen not present in this design build

  function dealId() {
    return (dealInput.value || "").trim();
  }

  tierBtn.addEventListener("click", function () {
    var id = dealId();
    if (!id) return;
    tierBtn.disabled = true;
    tierStatus.textContent = "Deriving tier from exposure…";
    fetchJSON("/deals/" + encodeURIComponent(id) + "/approval-tier")
      .then(function (body) {
        tierResult.textContent = (
          "Exposure " + money(body.exposure_amount) + " requires " + body.required_authority_label +
          " authority. " + body.tier_rule_applied
        );
        tierStatus.textContent = "Required tier: " + body.required_authority_tier + ".";
      })
      .catch(function (err) {
        tierStatus.textContent = "Failed: " + err.message;
        tierResult.textContent = "";
      })
      .then(function () {
        tierBtn.disabled = false;
      });
  });

  approveBtn.addEventListener("click", function () {
    var id = dealId();
    if (!id) return;
    approveBtn.disabled = true;
    approveStatus.textContent = "Recording approval…";
    fetchJSON("/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deal_id: id,
        decision: "approve",
        decided_by_id: deciderSelect.value,
        decision_notes: notesInput.value || "",
      }),
    })
      .then(function (body) {
        approveStatus.textContent = (
          "Approved by " + body.decided_by_id + " — stage now " + body.current_stage +
          (body.waived_exception_ids && body.waived_exception_ids.length
            ? " (waived " + body.waived_exception_ids.length + " residual exception(s))."
            : ".")
        );
      })
      .catch(function (err) {
        approveStatus.textContent = "Refused: " + err.message;
      })
      .then(function () {
        approveBtn.disabled = false;
      });
  });

  declineBtn.addEventListener("click", function () {
    var id = dealId();
    var reason = (declineReasonInput.value || "").trim();
    if (!id || !reason) {
      declineStatus.textContent = "An adverse-action reason is required to decline.";
      return;
    }
    declineBtn.disabled = true;
    declineStatus.textContent = "Recording decline…";
    fetchJSON("/deals/" + encodeURIComponent(id) + "/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decided_by_id: deciderSelect.value, adverse_action_reason: reason }),
    })
      .then(function (body) {
        declineStatus.textContent = "Declined by " + body.decided_by_id + ". Adverse-action reason recorded.";
      })
      .catch(function (err) {
        declineStatus.textContent = "Failed: " + err.message;
      })
      .then(function () {
        declineBtn.disabled = false;
      });
  });

  reworkBtn.addEventListener("click", function () {
    var id = dealId();
    var reason = (reworkReasonInput.value || "").trim();
    var assignee = (reworkAssigneeInput.value || "").trim();
    if (!id || !reason || !assignee) {
      reworkStatus.textContent = "A rework reason and assignee are both required.";
      return;
    }
    reworkBtn.disabled = true;
    reworkStatus.textContent = "Returning for rework…";
    fetchJSON("/deals/" + encodeURIComponent(id) + "/rework", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decided_by_id: deciderSelect.value, rework_reason: reason, rework_assigned_to_id: assignee }),
    })
      .then(function (body) {
        reworkStatus.textContent = "Returned to '" + body.returned_to_stage + "', reassigned to " + body.rework_assigned_to_id + ".";
      })
      .catch(function (err) {
        reworkStatus.textContent = "Failed: " + err.message;
      })
      .then(function () {
        reworkBtn.disabled = false;
      });
  });
})();
