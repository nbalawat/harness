// data-table module: table logic + textContent-only rendering.
(function () {
  function prepare(rows, opts) {
    opts = opts || {};
    var out = rows.slice();
    if (opts.filter) {
      var q = String(opts.filter).toLowerCase();
      out = out.filter(function (r) {
        return Object.values(r).some(function (v) { return String(v).toLowerCase().indexOf(q) !== -1; });
      });
    }
    if (opts.sort) {
      var desc = opts.sort.charAt(0) === "-";
      var key = desc ? opts.sort.slice(1) : opts.sort;
      out.sort(function (a, b) {
        var x = a[key], y = b[key];
        var cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return desc ? -cmp : cmp;
      });
    }
    var total = out.length;
    var pageSize = opts.pageSize || 25;
    var page = Math.max(1, opts.page || 1);
    out = out.slice((page - 1) * pageSize, page * pageSize);
    return { rows: out, total: total, page: page, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  function render(el, rows, columns) {
    el.replaceChildren();
    rows.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "dt-row";
      columns.forEach(function (c) {
        var cell = document.createElement("span");
        cell.className = "dt-cell";
        cell.textContent = String(row[c] == null ? "" : row[c]);
        line.appendChild(cell);
      });
      el.appendChild(line);
    });
  }
  if (typeof module !== "undefined") module.exports = { prepare: prepare, render: render };
  if (typeof window !== "undefined") window.HarnessTable = { prepare: prepare, render: render };
})();
