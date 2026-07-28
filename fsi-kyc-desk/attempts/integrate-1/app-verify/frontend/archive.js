// Slice 6 — case search, audit trail view, CSV export and weekly report.
// Behaviour only; binds to markup added INSIDE the chosen design's existing
// #screen-search and #screen-reports containers and reuses the design's own
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

  function td(className, text) {
    return el("td", className, text == null || text === "" ? "—" : text);
  }

  function titleise(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function bandClass(band) {
    var b = String(band || "").toLowerCase();
    return b === "high" || b === "medium" || b === "low" ? "band band--" + b : "band";
  }

  function figures(list, pairs) {
    if (!list) return;
    list.replaceChildren();
    pairs.forEach(function (pair) {
      var li = el("li");
      li.appendChild(el("span", null, pair[0]));
      li.appendChild(el("b", null, pair[1] == null || pair[1] === "" ? "—" : pair[1]));
      list.appendChild(li);
    });
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  // -------------------------------------------------------------- search
  var searchForm = document.getElementById("live-search-form");
  var searchByline = document.getElementById("live-search-byline");
  var searchCaption = document.getElementById("live-search-caption");
  var searchBody = document.getElementById("live-search-body");
  var searchFigures = document.getElementById("live-search-figures");
  var exportRefInput = document.getElementById("live-export-ref");

  function renderResults(body) {
    if (searchCaption) searchCaption.textContent = "Results — " + body.count + " case" + (body.count === 1 ? "" : "s");
    if (searchByline) {
      var parts = [];
      if (body.query) parts.push('query "' + body.query + '"');
      if (body.risk_band) parts.push("band " + body.risk_band);
      searchByline.textContent = body.count + " case" + (body.count === 1 ? "" : "s") + " found" + (parts.length ? " for " + parts.join(", ") : "") + ".";
    }
    if (searchBody) {
      searchBody.replaceChildren();
      body.results.forEach(function (r) {
        var row = el("tr");
        row.appendChild(td("case-id", r.case_reference));
        row.appendChild(td("client", r.client_name));
        row.appendChild(td(null, titleise(r.status)));
        var bandCell = el("td");
        bandCell.appendChild(el("span", bandClass(r.risk_band), titleise(r.risk_band) || "—"));
        row.appendChild(bandCell);
        row.appendChild(td("num", r.total_risk_score == null ? "—" : r.total_risk_score));
        row.addEventListener("click", function () {
          if (exportRefInput) exportRefInput.value = r.case_reference;
        });
        searchBody.appendChild(row);
      });
    }
    figures(searchFigures, [
      ["Results", body.count],
      ["Query", body.query || "—"],
      ["Band filter", body.risk_band || "any"],
    ]);
    if (body.results.length && exportRefInput && !exportRefInput.value) {
      exportRefInput.value = body.results[0].case_reference;
    }
  }

  function runSearch(q, band) {
    if (searchByline) searchByline.textContent = "Searching…";
    var url = "/search/cases?q=" + encodeURIComponent(q || "");
    if (band) url += "&risk_band=" + encodeURIComponent(band);
    getJSON(url).then(function (res) {
      if (!res.ok) {
        if (searchByline) searchByline.textContent = "Search failed (" + res.status + ").";
        return;
      }
      renderResults(res.body);
    }).catch(function () {
      if (searchByline) searchByline.textContent = "Search failed.";
    });
  }

  if (searchForm) {
    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var q = document.getElementById("live-search-q");
      var band = document.getElementById("live-search-band");
      runSearch(q ? q.value.trim() : "", band ? band.value : "");
    });
  }

  // -------------------------------------------------------------- export
  var exportForm = document.getElementById("live-export-form");
  var exportResult = document.getElementById("live-export-result");

  function triggerDownload(filename, text) {
    var blob = new Blob([text], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  if (exportForm) {
    exportForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var reference = exportRefInput ? exportRefInput.value.trim() : "";
      if (!reference) {
        if (exportResult) exportResult.textContent = "Name a case reference above first.";
        return;
      }
      var includeSelect = document.getElementById("live-export-audit");
      var include = includeSelect ? includeSelect.value : "";
      var url = "/export/cases/" + encodeURIComponent(reference) + ".csv" + (include ? "?include=" + encodeURIComponent(include) : "");
      if (exportResult) exportResult.textContent = "Exporting…";
      fetch(url).then(function (r) {
        return r.text().then(function (text) { return { ok: r.ok, status: r.status, text: text }; });
      }).then(function (res) {
        if (!res.ok) {
          if (exportResult) exportResult.textContent = "Export refused (" + res.status + ").";
          return;
        }
        var rowCount = res.text.split("\n").filter(function (line) { return line.trim(); }).length - 1;
        triggerDownload(reference.toLowerCase() + ".csv", res.text);
        if (exportResult) {
          exportResult.textContent = "Exported " + reference.toUpperCase() + " — " + Math.max(rowCount, 0) + " record row(s)" + (include ? ", with audit trail" : "") + ". Logged to the case register.";
        }
      }).catch(function () {
        if (exportResult) exportResult.textContent = "Export failed.";
      });
    });
  }

  // -------------------------------------------------------------- reports
  var reportsForm = document.getElementById("live-reports-form");
  var reportsByline = document.getElementById("live-reports-byline");
  var reportsBody = document.getElementById("live-reports-body");
  var reportsFigures = document.getElementById("live-reports-figures");

  function renderReport(body) {
    if (reportsByline) {
      reportsByline.textContent =
        "Period " + body.period + " · " + body.breached_count + " breach" + (body.breached_count === 1 ? "" : "es") +
        " on file · " + body.cases_decided_count + " case(s) decided · generated " + body.generated_at + ".";
    }
    if (reportsBody) {
      reportsBody.replaceChildren();
      if (!body.breached_cases.length) {
        var row = el("tr");
        var cell = el("td", "label", "No breached cases on file for this period.");
        cell.colSpan = 5;
        row.appendChild(cell);
        reportsBody.appendChild(row);
      }
      body.breached_cases.forEach(function (c) {
        var row = el("tr");
        row.appendChild(td("case-id", c.case_reference));
        row.appendChild(td("client", c.client_name));
        var bandCell = el("td");
        bandCell.appendChild(el("span", bandClass(c.risk_band), titleise(c.risk_band) || "—"));
        row.appendChild(bandCell);
        row.appendChild(td(null, titleise(c.status)));
        row.appendChild(td("num", c.escalation_level));
        reportsBody.appendChild(row);
      });
    }
    figures(reportsFigures, [
      ["Period", body.period],
      ["Breaches", body.breached_count],
      ["Decided", body.cases_decided_count],
      ["Escalations", body.escalations_count],
    ]);
  }

  if (reportsForm) {
    reportsForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (reportsByline) reportsByline.textContent = "Generating…";
      getJSON("/reports/weekly-operations").then(function (res) {
        if (!res.ok) {
          if (reportsByline) reportsByline.textContent = "Report generation failed (" + res.status + ").";
          return;
        }
        renderReport(res.body);
      }).catch(function () {
        if (reportsByline) reportsByline.textContent = "Report generation failed.";
      });
    });
  }
})();
