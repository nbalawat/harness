// dashboard-cards module: declared KPI computation.
(function () {
  function compute(rows, spec) {
    if (spec.metric === "count") return rows.length;
    if (spec.metric === "sum" || spec.metric === "avg") {
      var values = rows.map(function (r) { return Number(r[spec.field]) || 0; });
      var total = values.reduce(function (a, b) { return a + b; }, 0);
      if (spec.metric === "sum") return total;
      return rows.length ? total / rows.length : 0;
    }
    if (spec.metric === "latest") {
      if (!rows.length) return null;
      return rows[rows.length - 1][spec.field];
    }
    throw new Error("unknown metric " + spec.metric);
  }
  function format(value, kind) {
    if (value == null) return "—";
    if (kind === "money") return "$" + Number(value).toFixed(2);
    if (kind === "int") return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return String(value);
  }
  if (typeof module !== "undefined") module.exports = { compute: compute, format: format };
  if (typeof window !== "undefined") window.HarnessCards = { compute: compute, format: format };
})();
