// portfolio-qa-sla-audit slice: wires the Audit trail screen's "Live audit
// history" panel to GET /deals/{id}/audit. Renders into the design's own
// timeline/tl-item/tl-card/delta markup — never innerHTML with data, per
// the security-scan policy.
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

  var dealInput = document.getElementById("audit-deal-id");
  var loadBtn = document.getElementById("audit-load-btn");
  var status = document.getElementById("audit-live-status");
  var countEl = document.getElementById("audit-live-count");
  var timeline = document.getElementById("audit-live-timeline");
  if (!loadBtn || !timeline) return; // screen not present in this design build

  function classify(entry) {
    var actorType = (entry.actor_type || "").toLowerCase();
    var event = (entry.event_type || "").toLowerCase();
    if (/declin|refus|reject/.test(event)) return "decl";
    if (actorType === "agent") return "agentev";
    if (actorType === "human") return "human";
    return "sysev";
  }

  function initials(name) {
    if (!name) return "SY";
    var parts = String(name).split(/[-_\s]+/).filter(Boolean);
    if (!parts.length) return "SY";
    return (parts[0][0] + (parts[1] ? parts[1][0] : parts[0][1] || "")).toUpperCase();
  }

  function fmtValue(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function render(entries) {
    timeline.textContent = "";
    if (!entries.length) {
      timeline.appendChild(el("div", "tiny muted", "No audit events recorded for this deal yet."));
      return;
    }
    entries.forEach(function (entry) {
      var kind = classify(entry);
      var item = el("div", "tl-item " + kind);
      var card = el("div", "tl-card");

      var head = el("div", "tl-head");
      head.appendChild(el("span", "avatar " + (kind === "agentev" ? "bot" : "a1"), initials(entry.actor_id)));
      head.appendChild(el("b", null, entry.actor_id || "system"));
      head.appendChild(el("span", "chip hollow", entry.actor_type || "system"));
      head.appendChild(el("span", "chip", "EVENT: " + entry.event_type));
      head.appendChild(el("span", "tl-when", entry.timestamp));
      card.appendChild(head);

      card.appendChild(el("div", "tl-what", entry.description || entry.event_type));

      if (entry.before_value != null || entry.after_value != null) {
        var delta = el("div", "delta");
        if (entry.before_value != null) delta.appendChild(el("span", "before", fmtValue(entry.before_value)));
        delta.appendChild(el("span", "arrow", "→"));
        if (entry.after_value != null) delta.appendChild(el("span", "after", fmtValue(entry.after_value)));
        card.appendChild(delta);
      }

      item.appendChild(card);
      timeline.appendChild(item);
    });
  }

  function load() {
    var id = (dealInput.value || "").trim();
    if (!id) return;
    loadBtn.disabled = true;
    status.textContent = "Loading…";
    fetchJSON("/deals/" + encodeURIComponent(id) + "/audit")
      .then(function (entries) {
        render(entries);
        status.textContent = "Loaded " + id + ".";
        if (countEl) countEl.textContent = entries.length + " event(s)";
      })
      .catch(function (err) {
        status.textContent = "Failed: " + err.message;
      })
      .then(function () {
        loadBtn.disabled = false;
      });
  }

  loadBtn.addEventListener("click", load);
  load();
})();
