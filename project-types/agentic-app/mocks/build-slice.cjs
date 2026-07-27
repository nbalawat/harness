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
fs.appendFileSync("app/SLICES.md", `- slice ${sliceIndex}: ${slice.name} — ${slice.story}\n`);
simulateCost(1.1, 60000, 12000);
