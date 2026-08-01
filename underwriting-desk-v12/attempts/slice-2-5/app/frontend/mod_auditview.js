// audit-view module: uniform history formatting.
(function () {
  function formatEntry(entry) {
    var who = (entry.detail && (entry.detail.by || entry.detail.user || entry.detail.actor)) || "";
    var what = entry.event.replace(/[._]/g, " ");
    var extra = "";
    if (entry.detail && entry.detail.reason) extra = " — " + entry.detail.reason;
    return (entry.at ? entry.at + "  " : "") + what + (who ? " by " + who : "") + extra;
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
