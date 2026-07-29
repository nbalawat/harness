const { inputs, simulateCost, copyApp, fs } = require("./_lib.cjs");

const input = inputs();
const sliceIndex = input._params.data.slice;
const slice = input.slice_plan.data.slices[sliceIndex - 1];
copyApp(input.app.path);

// High-fidelity per-slice implementation (the real agent does this with code).
if (slice.id === "conversation-history") {
  const index = "app/frontend/index.html";
  fs.writeFileSync(
    index,
    fs.readFileSync(index, "utf8").replace(
      "</main>",
      '  <footer class="history"><a href="/api/conversations" target="_blank">Conversation history</a></footer>\n  </main>',
    ),
  );
} else if (slice.id === "reply-approval") {
  fs.appendFileSync(
    "app/backend/main.py",
    [
      "",
      "",
      "class ApprovalRequest(BaseModel):",
      "    message: str",
      "",
      "",
      '@app.post("/approvals")',
      "def approve(req: ApprovalRequest):",
      '    row = store.insert("approvals", {"message": req.message, "approved": True})',
      '    return {"approved": True, "id": row["id"]}',
      "",
    ].join("\n"),
  );
}
// Revision feedback: the real agent fixes the implementation per the user's
// note; the mock applies a visible, testable correction marker.
if (fs.existsSync("feedback.md")) {
  const note = fs.readFileSync("feedback.md", "utf8").split("\n").filter(Boolean).pop() ?? "";
  const index = "app/frontend/index.html";
  fs.writeFileSync(
    index,
    fs.readFileSync(index, "utf8").replace("</body>", `<!-- revised per user feedback: ${note.slice(0, 120).replace(/-->/g, "")} -->\n</body>`),
  );
  fs.appendFileSync("app/SLICES.md", `- slice ${sliceIndex}: revised per user feedback\n`);
}
// The slice's demo declaration: which screen shows this increment, and how.
const DEMOS = {
  "core-chat": { screen: "screen-chat", caption: "Ask a question, get a grounded reply in the chat thread.", steps: [{ action: "fill", selector: "#input", value: "How do refunds work?" }, { action: "click", selector: "#composer button" }] },
  "conversation-history": { screen: "screen-history", caption: "Stored conversations appear in the reviewable history list.", steps: [] },
  "reply-approval": { screen: "screen-agents", caption: "Drafts route through approval; the roster shows who is held to what.", steps: [] },
};
fs.mkdirSync("app/demo", { recursive: true });
fs.writeFileSync(`app/demo/slice-${sliceIndex}.json`, JSON.stringify(DEMOS[slice.id] ?? { screen: "screen-chat", caption: slice.story, steps: [] }, null, 2));
fs.appendFileSync("app/SLICES.md", `- slice ${sliceIndex}: ${slice.name} — ${slice.story}\n`);
simulateCost(1.1, 60000, 12000);
