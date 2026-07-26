const { inputs, writeJson, simulateCost, copyApp, fs } = require("./_lib.cjs");

const { app, data_model } = inputs();
copyApp(app.path);

// Fill the declared hole: backend/models.py generated from the approved data model.
const tables = data_model.data.tables;
const lines = [
  '"""Generated from the approved data model (data_model.json). Do not hand-edit."""',
  "",
  "TABLES = {",
  ...tables.map((t) => `    "${t.name}": [${t.columns.map((c) => `"${c.name}"`).join(", ")}],`),
  "}",
  "",
];
fs.writeFileSync("app/backend/models.py", lines.join("\n"));
simulateCost(3.2, 95000, 22000);
