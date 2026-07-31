// audit-view module: uniform history formatting.
(function () {
  function formatEntry(entry) {
    var d = entry.details || entry.detail || {};
    var who = entry.actor_user_id || d.by || d.user || d.actor || "";
    var what = String(entry.event_type || entry.event || "").replace(/[._]/g, " ");
    var extra = "";
    if (d.reason) extra = " — " + d.reason;
    var when = entry.created_at || entry.at || "";
    return (when ? when + "  " : "") + what + (who ? " by " + who : "") + extra;
  }
  function render(el, entries) {
    el.replaceChildren();
    entries.forEach(function (entry) {
      var line = document.createElement("div");
      line.className = "audit-line";
      line.textContent = formatEntry(entry);
      el.appendChild(line);
    });
  }
  if (typeof module !== "undefined") module.exports = { formatEntry: formatEntry };
  if (typeof window !== "undefined") window.HarnessAudit = { formatEntry: formatEntry, render: render };
})();
