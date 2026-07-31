// file-preview module: type-mapped inline previews.
(function () {
  var TEXT = ["txt", "md", "csv", "log", "json"];
  var IMAGE = ["png", "jpg", "jpeg", "gif", "svg"];
  function rendererFor(name) {
    var ext = String(name).toLowerCase().split(".").pop();
    if (TEXT.indexOf(ext) !== -1) return "text";
    if (IMAGE.indexOf(ext) !== -1) return "image";
    return "download";
  }
  function render(el, name, url) {
    el.replaceChildren();
    var kind = rendererFor(name);
    if (kind === "image") {
      var img = document.createElement("img");
      img.src = url;
      img.alt = name;
      img.style.maxWidth = "100%";
      el.appendChild(img);
    } else if (kind === "text") {
      var pre = document.createElement("pre");
      fetch(url).then(function (r) { return r.text(); }).then(function (t) { pre.textContent = t.slice(0, 20000); });
      el.appendChild(pre);
    } else {
      var a = document.createElement("a");
      a.href = url;
      a.textContent = "Download " + name + " to view";
      el.appendChild(a);
    }
  }
  if (typeof module !== "undefined") module.exports = { rendererFor: rendererFor };
  if (typeof window !== "undefined") window.HarnessPreview = { rendererFor: rendererFor, render: render };
})();
