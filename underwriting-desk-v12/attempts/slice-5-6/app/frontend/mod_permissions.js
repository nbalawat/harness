// permissions-ui module: role admin panel. textContent-only by policy.
(function () {
  function rolesToRows(byUser) {
    return Object.keys(byUser).sort().map(function (u) { return { user: u, roles: byUser[u].join(", ") }; });
  }
  function render(el, byUser) {
    el.replaceChildren();
    rolesToRows(byUser).forEach(function (row) {
      var line = document.createElement("div");
      line.className = "perm-row";
      var name = document.createElement("strong");
      name.textContent = row.user;
      var roles = document.createElement("span");
      roles.textContent = " — " + (row.roles || "no roles");
      line.appendChild(name);
      line.appendChild(roles);
      el.appendChild(line);
    });
  }
  if (typeof module !== "undefined") module.exports = { rolesToRows: rolesToRows };
  if (typeof document !== "undefined") {
    var host = document.getElementById("admin-permissions");
    if (host) {
      fetch("/admin/roles").then(function (r) { return r.ok ? r.json() : {}; }).then(function (data) { render(host, data); }).catch(function () {});
    }
  }
})();
