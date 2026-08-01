// notifications-ui module: deduped app notification queue.
(function () {
  function push(queue, msg) {
    var last = queue[queue.length - 1];
    if (last && last.text === msg.text && last.severity === msg.severity) {
      last.count = (last.count || 1) + 1;
      return queue;
    }
    queue.push({ text: msg.text, severity: msg.severity || "info", count: 1 });
    while (queue.length > 50) queue.shift();
    return queue;
  }
  function summarize(entry) {
    return entry.count > 1 ? entry.text + " (\u00d7" + entry.count + ")" : entry.text;
  }
  if (typeof module !== "undefined") module.exports = { push: push, summarize: summarize };
  if (typeof window !== "undefined") window.HarnessNotify = { push: push, summarize: summarize };
})();
