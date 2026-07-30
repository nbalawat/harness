// portfolio-qa-sla-audit slice: wires the Portfolio Q&A screen's canonical
// chat mount points (#messages #composer #input — same ids the chat-shell
// module and this design's own inline demo script bind to) to the real,
// grounded POST /portfolio/qa endpoint. Renders into the design's own
// bubble/result-strip/mini-card/ground markup — never innerHTML with data,
// per the security-scan policy.
(function () {
  function fetchJSON(path, opts) {
    return fetch(path, opts).then(function (r) {
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

  function stamp() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  var messages = document.getElementById("messages");
  var oldForm = document.getElementById("composer");
  var askerSelect = document.getElementById("qa-asker");
  var visibleCount = document.getElementById("qa-visible-count");
  var recentBody = document.getElementById("qa-recent-body");
  if (!messages || !oldForm) return; // screen not present in this design build

  // The named-asker directory is the real `users` table (same source
  // approvals.js reads), never a hard-coded cast, so the identity that
  // drives resolve_user_visibility_scope is exactly what the officer picks.
  fetchJSON("/api/users")
    .then(function (rows) {
      var named = (rows || []).filter(function (u) { return u.username; });
      if (!named.length || !askerSelect) return;
      askerSelect.textContent = "";
      named.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = u.username;
        opt.textContent = u.username + " — " + (u.full_name || u.username) + (u.role ? " (" + u.role + ")" : "");
        if (u.username === "user-officer-1") opt.selected = true;
        askerSelect.appendChild(opt);
      });
    })
    .catch(function () { /* keep the design's static option */ });

  function loadRecent() {
    if (!recentBody) return;
    fetchJSON("/portfolio/questions")
      .then(function (rows) {
        if (!rows || !rows.length) return; // keep the design's static examples until real ones exist
        recentBody.textContent = "";
        var wrap = el("div", "tiny muted");
        wrap.style.lineHeight = "1.7";
        rows.slice(0, 6).forEach(function (q) {
          var line = el(
            "div",
            null,
            "“" + q.question_text + "” — " + q.asking_user_id + (q.created_at ? ", " + q.created_at.slice(0, 10) : "")
          );
          wrap.appendChild(line);
        });
        recentBody.appendChild(wrap);
      })
      .catch(function () {});
  }
  loadRecent();

  // Take over the canonical composer/input mount points for the real
  // endpoint: cloning-and-replacing strips whatever submit listeners the
  // design's own inline demo script and the generic chat-shell module
  // (app.js) attached to the original nodes, so one submit produces one
  // real, grounded exchange instead of several competing fake/generic ones.
  // The mount point ids themselves (composer/input/messages) are untouched.
  var form = oldForm.cloneNode(true);
  oldForm.parentNode.replaceChild(form, oldForm);
  var input = form.querySelector("#input");

  function pushBubble(kind, avatarCls, initials, who, contentNode) {
    var li = el("li", kind);
    li.appendChild(el("span", "avatar " + avatarCls, initials));
    var bubble = el("div", "bubble");
    var whoLine = el("div", "who-line");
    whoLine.appendChild(el("span", null, who));
    whoLine.appendChild(el("span", "stamp", stamp()));
    bubble.appendChild(whoLine);
    bubble.appendChild(contentNode);
    li.appendChild(bubble);
    messages.appendChild(li);
    messages.scrollTop = messages.scrollHeight;
    return li;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var question = (input.value || "").trim();
    var askerId = (askerSelect && askerSelect.value) || "user-officer-1";
    if (!question) return;

    pushBubble("me", "a3", "ME", askerId, el("div", null, question));
    input.value = "";

    var loading = pushBubble(
      "bot", "bot", "QA", "Portfolio Q&A agent",
      el("div", null, "Querying stored deal data under your visibility scope…")
    );

    fetchJSON("/portfolio/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, asked_by_id: askerId }),
    })
      .then(function (body) {
        loading.remove();
        var content = el("div");
        content.appendChild(el("div", null, body.answer));
        if (body.supporting_deal_ids && body.supporting_deal_ids.length) {
          var strip = el("div", "result-strip");
          body.supporting_deal_ids.forEach(function (id) {
            var card = el("div", "mini-card");
            card.appendChild(el("div", "mn", id));
            strip.appendChild(card);
          });
          content.appendChild(strip);
        }
        var ground = el("div", "ground");
        ground.appendChild(
          document.createTextNode(
            "Grounded in " + body.row_count + " stored row(s) across your " + body.visible_deal_count +
            " visible deal(s). Read-only — this agent cannot change any deal."
          )
        );
        content.appendChild(ground);
        pushBubble("bot", "bot", "QA", "Portfolio Q&A agent", content);
        if (visibleCount) visibleCount.textContent = String(body.visible_deal_count);
        loadRecent();
      })
      .catch(function (err) {
        loading.remove();
        pushBubble("bot", "bot", "QA", "Portfolio Q&A agent", el("div", null, "Failed: " + err.message));
      });
  });

  document.querySelectorAll(".suggest button").forEach(function (b) {
    b.addEventListener("click", function () {
      input.value = b.textContent;
      input.focus();
    });
  });
})();
