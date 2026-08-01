// screen-router module: hash-based screen switching for design shells.
(function () {
  function resolve(hash, screens) {
    var want = String(hash || "").replace(/^#/, "");
    return screens.indexOf(want) !== -1 ? want : screens[0];
  }
  function activate(el, screens, current) {
    screens.forEach(function (id) {
      var section = el.querySelector("#" + id);
      if (section) section.style.display = id === current ? "" : "none";
    });
  }
  if (typeof module !== "undefined") module.exports = { resolve: resolve };
  if (typeof window !== "undefined") {
    window.HarnessRouter = { resolve: resolve, activate: activate };
    var screens = Array.prototype.map.call(document.querySelectorAll('[id^="screen-"]'), function (s) { return s.id; });
    if (screens.length > 1) {
      var apply = function () { activate(document, screens, resolve(location.hash, screens)); };
      window.addEventListener("hashchange", apply);
    }
  }
})();
