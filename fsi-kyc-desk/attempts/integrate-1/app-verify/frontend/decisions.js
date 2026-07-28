// Slice 4 — role-based access and tiered human approval.
// Behaviour only; binds to markup added INSIDE the chosen design's existing
// #screen-case and #screen-audit containers and reuses the design's own
// classes and tokens. textContent everywhere, never innerHTML (security-scan
// policy).
(function () {
  "use strict";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function titleise(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
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

  function refreshOpenCase() {
    // Re-run the case-file screen's own lookup (cases.js) so a decision's
    // effect on status/band is reflected without duplicating its rendering.
    var form = document.getElementById("live-case-form");
    if (form && typeof form.dispatchEvent === "function") {
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  }

  function currentReference(inputId) {
    var node = document.getElementById(inputId);
    var value = node ? node.value.trim() : "";
    if (value) return value;
    var caseRef = document.getElementById("live-case-ref");
    return caseRef ? caseRef.value.trim() : "";
  }

  // -------------------------------------------------------------- users list
  function loadUsers() {
    return getJSON("/users").then(function (res) {
      if (!res.ok) return;
      var users = res.body.users || [];
      ["live-decision-user", "live-exception-user"].forEach(function (id) {
        var select = document.getElementById(id);
        if (!select) return;
        select.replaceChildren();
        users.forEach(function (u) {
          var option = el("option", null, u.username + " — " + titleise(u.role));
          option.value = u.username;
          select.appendChild(option);
        });
      });
    }).catch(function () {});
  }

  // --------------------------------------------------------------- decisions
  var decisionSubmit = document.getElementById("live-decision-submit");
  var decisionResult = document.getElementById("live-decision-note-result");

  if (decisionSubmit) {
    decisionSubmit.addEventListener("click", function () {
      var reference = currentReference("live-case-ref");
      if (!reference) {
        if (decisionResult) decisionResult.textContent = "Load a case above first.";
        return;
      }
      var actingUser = document.getElementById("live-decision-user");
      var choice = document.getElementById("live-decision-choice");
      var note = document.getElementById("live-decision-note");
      var decision = choice ? choice.value : "approve";
      var payload = {
        case_reference: reference,
        decision: decision,
        acting_user: actingUser ? actingUser.value : "",
        rationale: decision === "approve" && note ? note.value.trim() : "",
        reason: decision === "reject" && note ? note.value.trim() : "",
      };
      if (decisionResult) decisionResult.textContent = "Recording…";
      postJSON("/decisions", payload).then(function (res) {
        if (!res.ok) {
          if (decisionResult) decisionResult.textContent = "Refused (" + res.status + "): " + (res.body.detail || JSON.stringify(res.body));
          return;
        }
        var body = res.body;
        if (decisionResult) {
          decisionResult.textContent =
            "Case " + body.case_reference + " " + body.status.toUpperCase() +
            " by " + body.decided_by_user_id + " (" + titleise(body.decided_by_role) + ") at " + body.decided_at +
            (body.next_review_due_date ? " · next review due " + body.next_review_due_date : "");
        }
        refreshOpenCase();
      });
    });
  }

  // --------------------------------------------------------------- exceptions
  var exceptionSubmit = document.getElementById("live-exception-submit");
  var exceptionResult = document.getElementById("live-exception-result");

  if (exceptionSubmit) {
    exceptionSubmit.addEventListener("click", function () {
      var reference = currentReference("live-case-ref");
      if (!reference) {
        if (exceptionResult) exceptionResult.textContent = "Load a case above first.";
        return;
      }
      var actingUser = document.getElementById("live-exception-user");
      var docType = document.getElementById("live-exception-doc");
      var reason = document.getElementById("live-exception-reason");
      postJSON("/cases/" + encodeURIComponent(reference) + "/exceptions", {
        acting_user: actingUser ? actingUser.value : "",
        document_type: docType ? docType.value.trim() : "",
        reason: reason ? reason.value.trim() : "",
      }).then(function (res) {
        if (!res.ok) {
          if (exceptionResult) exceptionResult.textContent = "Refused (" + res.status + "): " + (res.body.detail || JSON.stringify(res.body));
          return;
        }
        var body = res.body;
        if (exceptionResult) {
          exceptionResult.textContent =
            "Exception granted on " + titleise(body.document_type) + " by " + body.granted_by_user_id + " at " + body.granted_at + ".";
        }
      });
    });
  }

  // -------------------------------------------------------------- live audit
  var auditForm = document.getElementById("live-audit-form");
  var auditRefInput = document.getElementById("live-audit-ref");
  var auditByline = document.getElementById("live-audit-byline");
  var auditRegister = document.getElementById("live-audit-register");
  var auditNotifications = document.getElementById("live-audit-notifications");
  var auditFigures = document.getElementById("live-audit-figures");

  function renderRegister(entries) {
    if (!auditRegister) return;
    auditRegister.replaceChildren();
    if (!entries.length) {
      auditRegister.appendChild(el("p", "label", "No register entries for this case yet."));
      return;
    }
    entries.slice().reverse().forEach(function (entry) {
      var row = el("div", "register__row");
      var stamp = el("div", "register__stamp");
      stamp.appendChild(el("span", "register__seq", "ENTRY " + String(entry.id).padStart(3, "0")));
      stamp.appendChild(el("span", "register__time", entry.timestamp || "—"));
      row.appendChild(stamp);
      var body = el("div");
      body.appendChild(el("span", "register__who", (entry.performed_by_user_id || "system") + " · " + titleise(entry.performed_by_role)));
      var act = el("p", "register__act");
      act.appendChild(el("b", null, titleise(entry.action_type)));
      body.appendChild(act);
      if (entry.field_name) {
        var delta = el("span", "delta");
        delta.appendChild(el("span", "before", entry.old_value == null ? "—" : String(entry.old_value)));
        delta.appendChild(el("span", "arrow", "→"));
        delta.appendChild(el("span", "after", entry.new_value == null ? "—" : String(entry.new_value)));
        body.appendChild(delta);
      }
      row.appendChild(body);
      auditRegister.appendChild(row);
    });
  }

  function renderNotifications(notifications) {
    if (!auditNotifications) return;
    auditNotifications.replaceChildren();
    if (!notifications.length) {
      var li = el("li");
      li.appendChild(el("span", null, "No notifications recorded for this case."));
      auditNotifications.appendChild(li);
      return;
    }
    notifications.forEach(function (n) {
      var li = el("li");
      li.appendChild(el("span", "tick tick--na", "✉"));
      li.appendChild(el("span", null, titleise(n.notification_type) + " → " + n.recipient_user_id));
      li.appendChild(el("span", "doc-ver", n.sent_at || "—"));
      auditNotifications.appendChild(li);
    });
  }

  function loadAudit(reference) {
    if (!reference) return;
    if (auditByline) auditByline.textContent = "Loading…";
    getJSON("/audit/cases/" + encodeURIComponent(reference)).then(function (res) {
      if (!res.ok) {
        if (auditByline) auditByline.textContent = "No case with reference " + reference + ".";
        return;
      }
      var body = res.body;
      renderRegister(body.entries || []);
      if (auditByline) {
        auditByline.textContent = body.case_reference + " · " + body.count + " register entries · append-only, no delete";
      }
      if (auditFigures) {
        auditFigures.replaceChildren();
        var li = el("li");
        li.appendChild(el("span", null, "Entries"));
        li.appendChild(el("b", null, body.count));
        auditFigures.appendChild(li);
      }
      return getJSON("/notifications?case_reference=" + encodeURIComponent(reference));
    }).then(function (res) {
      if (res && res.ok) renderNotifications(res.body.notifications || []);
    }).catch(function () {});
  }

  if (auditForm) {
    auditForm.addEventListener("submit", function (event) {
      event.preventDefault();
      loadAudit(auditRefInput ? auditRefInput.value.trim() : "");
    });
  }

  loadUsers();
})();
