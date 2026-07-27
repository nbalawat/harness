# audit-view — agent guide

History panels format entries via formatEntry — event name, actor if
present, humanized detail. Ordering is newest-first ALWAYS (the API already
returns that; don't re-sort into confusion). Render with textContent only.
