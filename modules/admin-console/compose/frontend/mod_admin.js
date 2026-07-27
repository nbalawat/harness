// admin-console module: composed admin surface.
(function () {
  var KNOWN = [
    { id: "roles", title: "Roles & access", endpoint: "/admin/roles" },
    { id: "errors", title: "Errors", endpoint: "/admin/errors" },
    { id: "usage", title: "Usage", endpoint: "/admin/usage" },
    { id: "costs", title: "LLM costs", endpoint: "/admin/costs" },
    { id: "prompts", title: "Prompts", endpoint: "/admin/prompts" },
  ];
  function sections(available) {
    return KNOWN.filter(function (s) { return available.indexOf(s.id) !== -1; });
  }
  if (typeof module !== "undefined") module.exports = { sections: sections, KNOWN: KNOWN };
  if (typeof window !== "undefined") window.HarnessAdmin = { sections: sections };
})();
