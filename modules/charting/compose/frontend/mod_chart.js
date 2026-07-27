// charting module: honest scales + simple SVG builders.
(function () {
  function scale(values, height) {
    var max = Math.max.apply(null, values.concat([0]));
    var min = Math.min.apply(null, values.concat([0]));
    var span = max - min || 1;
    return {
      min: min,
      max: max,
      y: function (v) { return height - ((v - min) / span) * height; },
    };
  }
  function linePoints(values, width, height) {
    var s = scale(values, height);
    var step = values.length > 1 ? width / (values.length - 1) : 0;
    return values.map(function (v, i) { return [Math.round(i * step), Math.round(s.y(v))]; });
  }
  function ticks(maxValue, count) {
    var rough = maxValue / (count || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    var step = Math.ceil(rough / mag) * mag;
    var out = [];
    for (var t = 0; t <= maxValue; t += step) out.push(t);
    return out;
  }
  if (typeof module !== "undefined") module.exports = { scale: scale, linePoints: linePoints, ticks: ticks };
  if (typeof window !== "undefined") window.HarnessChart = { scale: scale, linePoints: linePoints, ticks: ticks };
})();
