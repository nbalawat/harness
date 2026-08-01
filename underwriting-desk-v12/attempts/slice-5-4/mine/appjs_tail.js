
// ============================================================
// screen-chat: The Portfolio Desk (slice: grounded-portfolio-qa)
//   - #composer submits to POST /api/qa/ask, grounded + permission-scoped
//   - "Standing Questions" shortcuts in the marginalia ask the same way
//   - the manuscript's #messages list renders real answers + their deal-id
//     sources, in the design's own from-user/from-agent markup
//   - the marginalia's "Book at a Glance" tallies read from live server data
// Appended after the foundation module above; nothing above this line is
// modified. Uses textContent (never innerHTML) by policy.
// ============================================================
(function () {
  const messagesList = document.getElementById("messages");
  const originalComposer = document.getElementById("composer");
  if (!messagesList || !originalComposer) return;

  // The scaffold's chat-shell above binds #composer to the generic /chat echo
  // route, which is not this desk's contract. Re-mount the composer node —
  // same markup, same canonical ids (#composer, #input) — so this desk owns
  // its submit handling without editing a byte of the foundation module.
  const composer = originalComposer.cloneNode(true);
  originalComposer.parentNode.replaceChild(composer, originalComposer);
  const questionInput = composer.querySelector("#input") || document.getElementById("input");
  if (!questionInput) return;

  // The masthead's byline ("Desk of M. Okonjo · Senior Credit Officer")
  // names the persona this edition is signed in as — the portfolio desk
  // asks on that officer's behalf.
  const ACTING_USER_EMAIL = "officer@bank.test";

  const pendingLi = messagesList.querySelector(".msg-pending");

  function slugTime() {
    const d = new Date();
    return d.toTimeString().slice(0, 5);
  }

  function appendMessage(kind, buildBody) {
    const li = document.createElement("li");
    li.className = kind === "user" ? "from-user" : "from-agent";
    const slug = document.createElement("span");
    slug.className = "msg-slug";
    const b = document.createElement("b");
    b.textContent = kind === "user" ? "You" : "Agent";
    slug.appendChild(b);
    slug.appendChild(document.createTextNode(slugTime()));
    const body = document.createElement("div");
    body.className = "msg-body";
    buildBody(body);
    li.appendChild(slug);
    li.appendChild(body);
    if (pendingLi) messagesList.insertBefore(li, pendingLi);
    else messagesList.appendChild(li);
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  function appendUserMessage(text) {
    appendMessage("user", (body) => {
      body.textContent = text;
    });
  }

  function appendAgentAnswer(text, sourceDealIds) {
    appendMessage("agent", (body) => {
      const p = document.createElement("p");
      p.textContent = text;
      body.appendChild(p);
      if (sourceDealIds && sourceDealIds.length) {
        const ul = document.createElement("ul");
        ul.className = "msg-sources";
        sourceDealIds.forEach((id) => {
          const li = document.createElement("li");
          li.textContent = id;
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
    });
  }

  function setPending(isPending) {
    if (pendingLi) pendingLi.style.display = isPending ? "" : "none";
  }

  function ask(question) {
    const text = (question || "").trim();
    if (!text) return;
    appendUserMessage(text);
    questionInput.value = "";
    setPending(true);
    fetch("/api/qa/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, acting_user_email: ACTING_USER_EMAIL }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then((res) => {
        setPending(false);
        if (!res.ok) {
          appendAgentAnswer("The desk could not answer that: " + (res.data.detail || "request failed"), []);
          return;
        }
        appendAgentAnswer(res.data.answer, res.data.source_deal_ids || []);
        refreshBookAtAGlance();
      })
      .catch((err) => {
        setPending(false);
        appendAgentAnswer("Request failed: " + err.message, []);
      });
  }

  setPending(false);

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(questionInput.value);
  });

  document.querySelectorAll(".suggested-queries button").forEach((button) => {
    button.addEventListener("click", () => ask(button.textContent));
  });

  // "Book at a Glance" — tallies drawn from the same permission-scoped
  // pipeline data the desk itself reads, refreshed after every answer.
  function setStat(label, value) {
    const notes = document.querySelectorAll(".margin-note h4");
    for (const h4 of notes) {
      if (h4.textContent.trim() !== "The Book at a Glance") continue;
      const items = h4.parentElement.querySelectorAll("li");
      items.forEach((li) => {
        const spans = li.querySelectorAll("span");
        if (spans[0] && spans[0].textContent.trim() === label && spans[1]) {
          spans[1].textContent = value;
        }
      });
    }
  }

  function refreshBookAtAGlance() {
    // Same permission-scoped, server-computed figures the answers are
    // grounded in — the desk never adds up money in the browser.
    fetch("/api/qa/book-summary?acting_user_email=" + encodeURIComponent(ACTING_USER_EMAIL))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setStat("Active deals", String(data.active_deals));
        setStat("Exposure in flight", "$" + Math.round((Number(data.total_exposure) || 0) / 1000).toLocaleString("en-US") + "k");
        setStat("Open exceptions", String(data.open_exception_count));
      })
      .catch(() => {});
  }

  refreshBookAtAGlance();
})();
