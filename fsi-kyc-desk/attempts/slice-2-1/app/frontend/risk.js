// Slice 2 — deterministic risk scoring and banding.
// Behaviour only; binds to markup added INSIDE the chosen design's existing
// #screen-score container and reuses the design's own classes and tokens.
// textContent everywhere, never innerHTML (security-scan policy).
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

  function postJSON(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  // ---------------------------------------------------------------- matrix
  var matrixNote = document.getElementById("live-matrix-note");

  function loadMatrix() {
    return getJSON("/risk-matrix").then(function (res) {
      if (!res.ok || !matrixNote) return;
      var body = res.body;
      matrixNote.textContent =
        "Risk rating matrix v" + body.version + " — " +
        body.factors.map(function (f) { return titleise(f.factor) + " " + f.weight; }).join(", ") +
        ". Bands: " + body.bands.map(function (b) { return titleise(b.band) + " " + b.min + "–" + b.max; }).join(", ") +
        ". A sanctions true-positive forces the High band regardless of the total.";
    }).catch(function () {});
  }

  // ------------------------------------------------------ breakdown rendering
  var scoreBody = document.getElementById("live-score-body");
  var scoreTotal = document.getElementById("live-score-total");
  var noticeLabel = document.getElementById("live-score-notice-label");
  var noticeBody = document.getElementById("live-score-notice-body");
  var scoreFigures = document.getElementById("live-score-figures");
  var byline = document.getElementById("live-score-byline");
  var refInput = document.getElementById("live-score-ref");
  var loadedRef = null;

  function renderBreakdown(prefix, body) {
    if (scoreBody) {
      scoreBody.replaceChildren();
      (body.factor_breakdown || []).forEach(function (row) {
        var tr = el("tr");
        tr.appendChild(td("client", titleise(row.factor)));
        tr.appendChild(td(null, row.raw_input));
        tr.appendChild(td("num", row.factor_score));
        tr.appendChild(td("num", row.weight));
        tr.appendChild(td("num", row.contribution));
        scoreBody.appendChild(tr);
      });
    }
    if (scoreTotal) scoreTotal.textContent = body.total_risk_score;
    if (noticeLabel) noticeLabel.textContent = "Band determination — " + titleise(body.risk_band);
    if (noticeBody) {
      noticeBody.textContent =
        prefix + "computed total " + body.total_risk_score + " of 100, matrix v" + body.risk_matrix_version + "." +
        (body.sanctions_true_positive_override_applied
          ? " Sanctions true-positive override applied — band forced to High irrespective of the total."
          : "") +
        " No item on this table may be set by hand.";
    }
    var pairs = (body.factor_breakdown || []).map(function (row) {
      return [titleise(row.factor), row.contribution];
    });
    pairs.push(["Total", body.total_risk_score]);
    figures(scoreFigures, pairs);
  }

  function openScore(reference) {
    if (!reference) return;
    getJSON("/cases/" + encodeURIComponent(reference) + "/score-breakdown").then(function (res) {
      if (!res.ok) {
        if (byline) byline.textContent = "No score for reference " + reference + ": " + (res.body.detail || res.status);
        return;
      }
      loadedRef = reference;
      var body = res.body;
      if (byline) {
        byline.textContent =
          body.case_reference + " · cycle " + body.cycle + " · computed " + (body.computed_at || "—") +
          " · matrix v" + body.risk_matrix_version;
      }
      if (refInput) refInput.value = body.case_reference;
      renderBreakdown(body.case_reference + " — ", body);
    }).catch(function () {});
  }

  var scoreForm = document.getElementById("live-score-form");
  if (scoreForm) {
    scoreForm.addEventListener("submit", function (event) {
      event.preventDefault();
      openScore(refInput ? refInput.value.trim() : "");
    });
  }

  // -------------------------------------------------------------- calculator
  var calcForm = document.getElementById("risk-calc-form");
  var calcResult = document.getElementById("risk-calc-result");

  function selected(id) {
    var node = document.getElementById(id);
    return node ? node.value : "";
  }

  if (calcForm) {
    calcForm.addEventListener("submit", function (event) {
      event.preventDefault();
      loadedRef = null;
      var factors = {
        jurisdiction: selected("calc-jurisdiction"),
        entity_structure: selected("calc-structure"),
        industry: selected("calc-industry"),
        sanctions_screening: selected("calc-sanctions"),
        expected_activity: selected("calc-activity"),
      };
      if (calcResult) calcResult.textContent = "Computing…";
      postJSON("/risk/score", { factors: factors }).then(function (res) {
        if (!res.ok) {
          if (calcResult) calcResult.textContent = "Refused: " + JSON.stringify(res.body.detail || res.body);
          return;
        }
        var body = res.body;
        if (calcResult) {
          calcResult.textContent =
            "Total " + body.total_risk_score + " of 100 — " + titleise(body.risk_band) + " band" +
            (body.sanctions_true_positive_override_applied ? " (sanctions override applied)" : "") +
            ". Matrix v" + body.risk_matrix_version + ".";
        }
        renderBreakdown("Ad-hoc calculation — ", body);
        if (byline) byline.textContent = "Ad-hoc calculation against raw factors — not tied to a case.";
      });
    });
  }

  // ---------------------------------------------------------- edit attempt
  var editButton = document.getElementById("live-score-edit-attempt");
  var editNote = document.getElementById("live-score-edit-note");

  if (editButton) {
    editButton.addEventListener("click", function () {
      var reference = loadedRef || (refInput ? refInput.value.trim() : "");
      if (!reference) {
        if (editNote) editNote.textContent = "Load a case's score breakdown first.";
        return;
      }
      postJSON("/cases/" + encodeURIComponent(reference) + "/score", {
        total_risk_score: 0,
        risk_band: "Low",
        acting_user: "cora.compliance",
      }).then(function (res) {
        if (editNote) {
          editNote.textContent = res.status === 403
            ? "Refused (403): " + res.body.detail
            : "Unexpected response " + res.status;
        }
      });
    });
  }

  loadMatrix();
})();
