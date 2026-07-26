const { inputs, simulateCost, copyApp, fs } = require("./_lib.cjs");

const { app, intake } = inputs();
copyApp(app.path);

// Brand the shell with the real app name (scaffold left the placeholder).
const index = "app/frontend/index.html";
fs.writeFileSync(index, fs.readFileSync(index, "utf8").replaceAll("__APP_NAME__", intake.data.project_name));
simulateCost(1.8, 52000, 9000);
