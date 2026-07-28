// Slice 3 — AI-drafted risk assessment memo with citations.
// Behaviour only; binds to markup added INSIDE the chosen design's existing
// #screen-memo container and reuses the design's own classes and tokens.
// textContent everywhere, never innerHTML (security-scan policy).
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

  // ------------------------------------------------------------ policy corpus
  var corpusNote = document.getElementById("live-memo-corpus");

  function loadCorpus() {
    return getJSON("/policy-corpus").then(function (res) {
      if (!res.ok || !corpusNote) return;
      var docs = res.body.documents || [];
      corpusNote.textContent = docs.map(function (d) { return d.title + " v" + d.version; }).join(" · ");
    }).catch(function () {});
  }

  // ------------------------------------------------------------- live drafting
  var refInput = document.getElementById("live-memo-ref");
  var userInput = document.getElementById("live-memo-user");
  var byline = document.getElementById("live-memo-byline");
  var title = document.getElementById("live-memo-title");
  var meta = document.getElementById("live-memo-meta");
  var textBox = document.getElementById("live-memo-text");
  var citationsList = document.getElementById("live-memo-citations");
  var versionsList = document.getElementById("live-memo-versions");
  var figuresList = document.getElementById("live-memo-figures");

  function renderCitations(citations) {
    if (!citationsList) return;
    citationsList.replaceChildren();
    (citations || []).forEach(function (c) {
      var li = el("li");
      var cite = el("cite", null, titleise(c.document) + ", version " + (c.version || "?"));
      li.appendChild(cite);
      li.appendChild(document.createTextNode(" — §" + c.section + " — " + c.text));
      citationsList.appendChild(li);
    });
  }

  function renderVersions(memos, currentVersion) {
    if (!versionsList) return;
    versionsList.replaceChildren();
    (memos || []).forEach(function (m) {
      var li = el("li");
      if (m.version === currentVersion) li.className = "is-current";
      li.appendChild(el("span", "v", "v" + m.version + (m.version === currentVersion ? " · current" : "")));
      li.appendChild(el("span", null, m.is_machine_drafted ? "Machine-drafted draft, cycle " + (m.cycle || 1) : "Draft"));
      li.appendChild(el("span", "when", m.generated_at || "—"));
      versionsList.appendChild(li);
    });
  }

  function loadVersions(reference, currentVersion) {
    return getJSON("/cases/" + encodeURIComponent(reference) + "/memos").then(function (res) {
      if (!res.ok) return;
      renderVersions(res.body.memos || [], currentVersion);
    }).catch(function () {});
  }

  var form = document.getElementById("live-memo-form");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var reference = refInput ? refInput.value.trim() : "";
      var requestedBy = userInput ? userInput.value.trim() : "";
      if (!reference) {
        if (byline) byline.textContent = "Name a submission reference first.";
        return;
      }
      if (byline) byline.textContent = "Drafting…";
      postJSON("/memos/draft", { case_reference: reference, requested_by: requestedBy }).then(function (res) {
        if (!res.ok) {
          if (byline) byline.textContent = "Refused: " + JSON.stringify(res.body.detail || res.body);
          return;
        }
        var body = res.body;
        if (title) title.textContent = "Risk Assessment Memorandum — " + body.case_reference;
        if (meta) {
          meta.textContent =
            body.case_reference + " · version " + body.version + " · drafted " + body.generated_at +
            " · " + (body.is_machine_drafted ? "machine-drafted" : "not machine-drafted") +
            " · citations resolved: " + (body.citations_resolved ? "yes" : "no");
        }
        if (textBox) textBox.textContent = body.memo_text;
        renderCitations(body.policy_citations);
        if (byline) {
          byline.textContent =
            body.case_reference + " — version " + body.version + " drafted for " + body.requested_by +
            "; not yet adopted by any officer.";
        }
        figures(figuresList, [
          ["Version", body.version],
          ["Citations", (body.policy_citations || []).length],
          ["Machine-drafted", body.is_machine_drafted ? "Yes" : "No"],
          ["Citations resolved", body.citations_resolved ? "Yes" : "No"],
          ["Workflow status", body.workflow_status],
        ]);
        loadVersions(body.case_reference, body.version);
      });
    });
  }

  loadCorpus();
})();
