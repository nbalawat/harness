// record-detail module: uniform record field layout.
(function () {
  function labelFor(column, labels) {
    if (labels && labels[column]) return labels[column];
    return column.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function fields(row, columns, labels) {
    return columns.map(function (c) {
      var value = row[c];
      return { label: labelFor(c, labels), value: value == null || value === "" ? "—" : String(value) };
    });
  }
  function render(el, row, columns, labels) {
    el.replaceChildren();
    fields(row, columns, labels).forEach(function (f) {
      var line = document.createElement("div");
      var k = document.createElement("span");
      k.className = "rd-label";
      k.textContent = f.label;
      var v = document.createElement("span");
      v.className = "rd-value";
      v.textContent = f.value;
      line.appendChild(k);
      line.appendChild(v);
      el.appendChild(line);
    });
  }
  if (typeof module !== "undefined") module.exports = { fields: fields };
  if (typeof window !== "undefined") window.HarnessDetail = { fields: fields, render: render };
})();
