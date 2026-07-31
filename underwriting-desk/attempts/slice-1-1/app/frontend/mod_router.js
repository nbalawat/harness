// screen-router module: hash-based screen switching for design shells.
// Design shells drive navigation with buttons (data-screen / data-goto)
// rather than in-page anchors, so this module translates those clicks into
// the canonical #screen-<name> hash and lets the hash be the single source
// of truth — back/forward and deep links keep working for free.
(function () {
  function resolve(hash, screens) {
    var want = String(hash || "").replace(/^#/, "");
    return screens.indexOf(want) !== -1 ? want : screens[0];
  }
  function activate(el, screens, current) {
    screens.forEach(function (id) {
      var section = el.querySelector("#" + id);
      if (section) section.classList.toggle("active", id === current);
    });
    var shortName = String(current || "").replace(/^screen-/, "");
    if (el.querySelectorAll) {
      el.querySelectorAll(".navitem[data-screen]").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-screen") === shortName);
      });
      var crumb = el.querySelector("#crumb");
      if (crumb) crumb.textContent = "/ " + shortName;
    }
  }
  if (typeof module !== "undefined") module.exports = { resolve: resolve, activate: activate };
  if (typeof window !== "undefined") {
    window.HarnessRouter = { resolve: resolve, activate: activate };
    var screens = Array.prototype.map.call(document.querySelectorAll('[id^="screen-"]'), function (s) { return s.id; });
    if (screens.length > 1) {
      var apply = function () { activate(document, screens, resolve(location.hash, screens)); };
      window.addEventListener("hashchange", apply);
      window.addEventListener("DOMContentLoaded", apply);
      apply();
      document.addEventListener("click", function (e) {
        var el = e.target.closest && e.target.closest("[data-screen],[data-goto]");
        if (!el) return;
        var name = el.getAttribute("data-screen") || el.getAttribute("data-goto");
        if (!name) return;
        var target = "screen-" + name;
        if (screens.indexOf(target) === -1) return;
        if (location.hash === "#" + target) apply();
        else location.hash = target;
      });
    }
  }
})();
