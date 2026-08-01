// SLA dashboard + credit decision desk (slice: tiered-approval-and-sla)
//   - the idle register reads GET /api/sla/idle (business-day arithmetic
//     computed server-side; nothing here invents a number)
//   - approve / decline / return post to the tiered decision endpoints,
//     whose authority checks are enforced on the server
//   - reassign / acknowledge drive POST /api/sla/{deal}/escalate, which runs
//     the sla-idle-escalation workflow end to end
// Every write below reports exactly what the server answered — including a
// refusal — using textContent only.
// ============================================================
(function () {
  const register = document.getElementById("idle-register-body");
  const decisionDesk = document.getElementById("decision-desk");
  if (!register && !decisionDesk) return;

  let idleDeals = [];
  let pendingDecisions = [];

  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function titleCase(value) {
    return String(value || "")
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function shortDate(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "—";
    const d = new Date(t);
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  function textOf(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function valueOf(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function fillDatalist(id, values) {
    const list = document.getElementById(id);
    if (!list) return;
    list.replaceChildren();
    values.forEach((v) => {
      const option = document.createElement("option");
      option.value = v;
      list.appendChild(option);
    });
  }

  function fillCountList(id, counts) {
    const ul = document.getElementById(id);
    if (!ul) return;
    ul.replaceChildren();
    const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = "Nothing past the line";
      const n = document.createElement("span");
      n.textContent = "0";
      li.appendChild(label);
      li.appendChild(n);
      ul.appendChild(li);
      return;
    }
    entries.forEach(([key, count]) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = key.includes("@") ? key : titleCase(key);
      const n = document.createElement("span");
      n.textContent = String(count);
      li.appendChild(label);
      li.appendChild(n);
      ul.appendChild(li);
    });
  }

  function selectDeal(code) {
    const slaField = document.getElementById("sla-deal-code");
    if (slaField) slaField.value = code;
    const decisionField = document.getElementById("decision-deal-code");
    if (decisionField) decisionField.value = code;
    describeAuthority();
  }

  function renderRegister(data) {
    idleDeals = data.deals || [];
    if (register) {
      register.replaceChildren();
      if (!idleDeals.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.textContent = "Nothing is past the service line — every active deal has moved within five business days.";
        tr.appendChild(td);
        register.appendChild(tr);
      }
      const worst = idleDeals.length ? idleDeals[0].business_days_idle || 1 : 1;
      idleDeals.forEach((d) => {
        const tr = document.createElement("tr");
        tr.addEventListener("click", () => selectDeal(d.deal_code));

        const dealCell = document.createElement("td");
        dealCell.className = "deal-cell";
        const name = document.createElement("b");
        name.textContent = d.borrower_name || d.deal_code;
        const code = document.createElement("small");
        code.textContent = d.deal_code;
        dealCell.appendChild(name);
        dealCell.appendChild(code);

        const stage = document.createElement("td");
        stage.textContent = titleCase(d.current_stage);

        const owner = document.createElement("td");
        owner.textContent = d.owner_email || "Unassigned";

        const activity = document.createElement("td");
        activity.textContent = shortDate(d.last_activity_timestamp) + " · " + String(d.current_status || "").replace(/_/g, " ");

        const exposure = document.createElement("td");
        exposure.className = "num";
        exposure.textContent = money(d.exposure_amount);

        const age = document.createElement("td");
        age.className = "num";
        const ageBar = document.createElement("span");
        ageBar.className = "age-bar";
        const bar = document.createElement("span");
        bar.className = d.business_days_idle > 8 ? "bar warn" : "bar";
        bar.style.width = Math.max(12, Math.round((d.business_days_idle / worst) * 56)) + "px";
        ageBar.appendChild(bar);
        ageBar.appendChild(document.createTextNode(String(d.business_days_idle) + "d"));
        age.appendChild(ageBar);

        [dealCell, stage, owner, activity, exposure, age].forEach((td) => tr.appendChild(td));
        register.appendChild(tr);
      });
    }

    const counts = data.counts || {};
    textOf("plate-past-line", String(counts.past_service_line || 0));
    textOf("plate-past-line-caption", "of " + (counts.active_deals || 0) + " active deals");
    textOf("plate-idle-exposure", money(data.idle_exposure));
    textOf("plate-approaching", String(counts.approaching || 0));
    textOf(
      "plate-approaching-caption",
      "idle 3 – " + (data.sla_threshold_business_days || 5) + " business days"
    );
    if (data.longest_idle) {
      textOf("plate-longest", String(data.longest_idle.business_days_idle) + "d");
      textOf(
        "plate-longest-caption",
        data.longest_idle.borrower_name + ", " + titleCase(data.longest_idle.current_stage)
      );
    } else {
      textOf("plate-longest", "—");
      textOf("plate-longest-caption", "nothing past the line");
    }
    fillCountList("idle-by-stage", data.by_stage);
    fillCountList("idle-by-desk", data.by_owner);
    fillDatalist("sla-deal-codes", idleDeals.map((d) => d.deal_code));

    const slaField = document.getElementById("sla-deal-code");
    if (slaField && !slaField.value && idleDeals.length) slaField.value = idleDeals[0].deal_code;
  }

  function loadRegister() {
    return fetch("/api/sla/idle")
      .then((r) => (r.ok ? r.json() : { deals: [], counts: {} }))
      .then(renderRegister)
      .catch(() => {});
  }

  let authorityToken = 0;

  function describeAuthority() {
    const code = valueOf("decision-deal-code");
    if (!code) {
      textOf("decision-authority", "");
      return;
    }
    const deal = pendingDecisions.find((d) => d.deal_code === code);
    if (deal) {
      textOf(
        "decision-authority",
        deal.deal_code +
          " · " +
          deal.borrower_name +
          " · exposure " +
          money(deal.exposure_amount) +
          " · stage " +
          titleCase(deal.current_stage) +
          " · requires " +
          deal.required_authority_level +
          " authority"
      );
      return;
    }
    // Already settled (or filed elsewhere): read its decision record.
    const token = ++authorityToken;
    fetch("/api/deals/" + encodeURIComponent(code) + "/decisions")
      .then((r) => (r.ok ? r.json() : null))
      .then((rec) => {
        if (token !== authorityToken) return;
        if (!rec) {
          textOf("decision-authority", code + " — no such deal on the book.");
          return;
        }
        const settled = (rec.approvals || []).filter((a) => a.decision).slice(-1)[0];
        textOf(
          "decision-authority",
          rec.deal_id +
            " · " +
            rec.borrower_name +
            " · exposure " +
            money(rec.exposure_amount) +
            " · requires " +
            rec.required_authority_level +
            " authority · now at " +
            titleCase(rec.current_stage) +
            " · " +
            rec.current_status +
            (settled ? " (" + settled.decision + " by " + settled.decided_by + ")" : "")
        );
      })
      .catch(() => {});
  }

  function loadTiers() {
    return fetch("/api/approval-tiers")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        pendingDecisions = data.pending_decisions || [];
        fillDatalist("decision-deal-codes", pendingDecisions.map((d) => d.deal_code));
        fillDatalist("decision-reason-codes", (data.adverse_action_reasons || []).map((r) => r.reason_code));
        fillDatalist("decision-return-stages", data.returnable_stages || []);
        describeAuthority();
      })
      .catch(() => {});
  }

  function renderReceipt(rows) {
    const list = document.getElementById("decision-receipt");
    if (!list) return;
    list.replaceChildren();
    rows.forEach(([label, value]) => {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.textContent = label;
      const v = document.createElement("span");
      v.textContent = String(value);
      li.appendChild(k);
      li.appendChild(v);
      list.appendChild(li);
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((data) => ({ ok: r.ok, data })));
  }

  function afterDecision() {
    loadRegister();
    loadTiers();
  }

  const approveBtn = document.getElementById("decision-approve-btn");
  if (approveBtn) {
    approveBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      if (!code) {
        textOf("decision-status", "Name the deal you are deciding.");
        return;
      }
      post("/api/deals/" + encodeURIComponent(code) + "/approve", {
        acting_user_email: valueOf("decision-officer-email"),
        decision_notes: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", res.data.decision],
            ["Deal", res.data.deal_id + " — " + res.data.borrower_name],
            ["Exposure", money(res.data.exposure_amount)],
            ["Authority exercised", res.data.approval_authority_level],
            ["Decided by", res.data.decided_by + " (" + res.data.decided_by_role + ")"],
            ["Notes", res.data.decision_notes || "—"],
            ["Now at", titleCase(res.data.current_stage) + " · " + res.data.current_status],
            ["Idempotency key", res.data.idempotency_key],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id +
              " approved by " +
              res.data.decided_by +
              " under " +
              res.data.approval_authority_level +
              " authority."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const declineBtn = document.getElementById("decision-decline-btn");
  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/decline", {
        acting_user_email: valueOf("decision-officer-email"),
        reason_code: valueOf("decision-reason-code"),
        reason_detail: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", res.data.decision],
            ["Deal", res.data.deal_id + " — " + res.data.borrower_name],
            ["Adverse-action code", res.data.adverse_action_reason_code],
            ["Written detail", res.data.adverse_action_detail],
            ["Authority exercised", res.data.approval_authority_level],
            ["Decided by", res.data.decided_by],
            ["Now at", titleCase(res.data.current_stage) + " · " + res.data.current_status],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id + " declined — adverse action " + res.data.adverse_action_reason_code + " issued."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const returnBtn = document.getElementById("decision-return-btn");
  if (returnBtn) {
    returnBtn.addEventListener("click", () => {
      const code = valueOf("decision-deal-code");
      post("/api/deals/" + encodeURIComponent(code) + "/return", {
        acting_user_email: valueOf("decision-officer-email"),
        returned_to_stage: valueOf("decision-return-stage"),
        reason: valueOf("decision-notes"),
      })
        .then((res) => {
          if (!res.ok) {
            renderReceipt([["Refused", res.data.detail || "error"]]);
            textOf("decision-status", "Refused by the server: " + (res.data.detail || "error"));
            return;
          }
          renderReceipt([
            ["Decision", "returned"],
            ["Deal", res.data.deal_id],
            ["From", titleCase(res.data.returned_from_stage)],
            ["Back to", titleCase(res.data.returned_to_stage)],
            ["Written reason", res.data.reason],
            ["Returned by", res.data.returned_by],
          ]);
          textOf(
            "decision-status",
            res.data.deal_id + " returned to " + titleCase(res.data.returned_to_stage) + "."
          );
          afterDecision();
        })
        .catch((err) => textOf("decision-status", "Request failed: " + err.message));
    });
  }

  const dealField = document.getElementById("decision-deal-code");
  if (dealField) dealField.addEventListener("input", describeAuthority);

  function escalate(action) {
    const code = valueOf("sla-deal-code");
    if (!code) {
      textOf("sla-action-status", "Pick a deal from the register first.");
      return;
    }
    post("/api/sla/" + encodeURIComponent(code) + "/escalate", {
      acting_user_email: valueOf("sla-officer-email"),
      action: action,
      note: valueOf("sla-note"),
      reassign_to_email: valueOf("sla-reassign-email"),
    })
      .then((res) => {
        if (!res.ok) {
          textOf("sla-action-status", "Refused by the server: " + (res.data.detail || "error"));
          return;
        }
        const blockers = (res.data.blocking_items || []).join("; ");
        textOf(
          "sla-action-status",
          res.data.deal_id +
            " — " +
            res.data.business_days_idle +
            " business days idle · action " +
            res.data.action_taken +
            " · workflow " +
            res.data.status +
            (blockers ? " · blocking: " + blockers : "")
        );
        loadRegister();
      })
      .catch((err) => textOf("sla-action-status", "Request failed: " + err.message));
  }

  const reassignBtn = document.getElementById("sla-reassign-btn");
  if (reassignBtn) reassignBtn.addEventListener("click", () => escalate("reassign"));
  const ackBtn = document.getElementById("sla-acknowledge-btn");
  if (ackBtn) ackBtn.addEventListener("click", () => escalate("acknowledge"));

  document.addEventListener("screen:shown", (event) => {
    if (event.detail && event.detail.screen === "screen-sla-dashboard") {
      loadRegister();
      loadTiers();
    }
  });

  loadRegister();
  loadTiers();
})();
